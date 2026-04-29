// Tests for src/ports.js: parseLsofOutput (existing) + parseSsOutput (new).
// listListeningPorts itself is exercised end-to-end by the higher-level
// /api/state and /api/ports tests; here we cover just the pure parsers so
// regressions in either format are caught fast.

import assert from "node:assert/strict";
import test from "node:test";
import { __internal } from "../src/ports.js";

const { parseLsofOutput, parseSsOutput } = __internal;

test("parseLsofOutput: parses lsof -nP -iTCP -sTCP:LISTEN rows", () => {
  const stdout = [
    "COMMAND     PID  USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME",
    "node     475451 ogata   25u  IPv4 1234567      0t0  TCP *:4826 (LISTEN)",
    "node     475451 ogata   26u  IPv6 1234568      0t0  TCP [::]:4826 (LISTEN)",
    "sshd       1234  root    3u  IPv4 9876543      0t0  TCP *:22 (LISTEN)",
    "ollama   888888 ogata    9u  IPv4 1111111      0t0  TCP 127.0.0.1:11434 (LISTEN)",
  ].join("\n");
  const ports = parseLsofOutput(stdout);
  // Deduped on port.
  assert.equal(ports.length, 3);
  const byPort = new Map(ports.map((p) => [p.port, p]));
  assert.equal(byPort.get(4826).command, "node");
  assert.equal(byPort.get(4826).pid, 475451);
  // lsof emits "[::]" verbatim; the parser preserves it. parseSsOutput
  // normalizes the IPv6 wildcard to "::" — they differ on purpose; both are
  // unambiguously "any-IPv6" in their respective contexts and the UI
  // doesn't render brackets specially.
  assert.deepEqual(byPort.get(4826).hosts.sort(), ["0.0.0.0", "[::]"]);
  assert.equal(byPort.get(22).command, "sshd");
  assert.equal(byPort.get(11434).hosts[0], "127.0.0.1");
  assert.equal(byPort.get(11434).proxyPath, "/proxy/11434/");
});

test("parseLsofOutput: respects excludePorts", () => {
  const stdout = [
    "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME",
    "node 1 ogata 25u IPv4 1 0 TCP *:4826 (LISTEN)",
    "node 1 ogata 26u IPv4 1 0 TCP *:4828 (LISTEN)",
  ].join("\n");
  const ports = parseLsofOutput(stdout, [4826]);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].port, 4828);
});

test("parseSsOutput: parses ss -tnlpH rows (Linux)", () => {
  // Sample copied from a real ss -tnlpH run; mixed IPv4 and IPv6 listeners,
  // multiple lines per process possible.
  const stdout = [
    "LISTEN 0 511 0.0.0.0:4826 0.0.0.0:* users:((\"node\",pid=4175126,fd=25))",
    "LISTEN 0 511 [::]:4826 [::]:* users:((\"node\",pid=4175126,fd=26))",
    "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=1234,fd=3))",
    "LISTEN 0 511 127.0.0.1:11434 0.0.0.0:* users:((\"ollama\",pid=888888,fd=9))",
  ].join("\n");
  const ports = parseSsOutput(stdout);
  assert.equal(ports.length, 3, `got ${ports.length}`);
  const byPort = new Map(ports.map((p) => [p.port, p]));

  const node = byPort.get(4826);
  assert.equal(node.command, "node");
  assert.equal(node.pid, 4175126);
  assert.deepEqual(node.hosts.sort(), ["0.0.0.0", "::"]);
  assert.equal(node.proxyPath, "/proxy/4826/");

  const sshd = byPort.get(22);
  assert.equal(sshd.command, "sshd");
  assert.equal(sshd.pid, 1234);
  assert.deepEqual(sshd.hosts, ["0.0.0.0"]);

  const ollama = byPort.get(11434);
  assert.equal(ollama.command, "ollama");
  assert.deepEqual(ollama.hosts, ["127.0.0.1"]);
});

test("parseSsOutput: skips header rows (in case -H is not honored)", () => {
  const stdout = [
    "State    Recv-Q   Send-Q   Local Address:Port   Peer Address:Port   Process",
    "Netid State Recv-Q Send-Q LocalAddress:Port PeerAddress:Port Process",
    "LISTEN 0 511 0.0.0.0:4826 0.0.0.0:* users:((\"node\",pid=1,fd=2))",
  ].join("\n");
  const ports = parseSsOutput(stdout);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].port, 4826);
});

test("parseSsOutput: respects excludePorts", () => {
  const stdout = [
    "LISTEN 0 511 0.0.0.0:4826 0.0.0.0:* users:((\"a\",pid=1,fd=2))",
    "LISTEN 0 511 0.0.0.0:4828 0.0.0.0:* users:((\"b\",pid=2,fd=3))",
  ].join("\n");
  const ports = parseSsOutput(stdout, [4826]);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].port, 4828);
});

test("parseSsOutput: handles rows with no Process column (ss without -p)", () => {
  const stdout = [
    "LISTEN 0 511 0.0.0.0:4826 0.0.0.0:*",
  ].join("\n");
  const ports = parseSsOutput(stdout);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].port, 4826);
  assert.equal(ports[0].command, "unknown");
  assert.equal(ports[0].pid, 0);
});

test("parseSsOutput: tolerates wildcard host '*'", () => {
  // Some ss versions render "0.0.0.0" as "*"
  const stdout = "LISTEN 0 511 *:9999 *:* users:((\"x\",pid=42,fd=3))";
  const ports = parseSsOutput(stdout);
  assert.equal(ports.length, 1);
  assert.deepEqual(ports[0].hosts, ["0.0.0.0"]);
});

test("parseSsOutput: ignores non-LISTEN states", () => {
  const stdout = [
    "ESTAB 0 0 192.168.1.1:443 1.2.3.4:54321",
    "LISTEN 0 511 0.0.0.0:4826 0.0.0.0:* users:((\"node\",pid=1,fd=2))",
    "TIME-WAIT 0 0 192.168.1.1:443 1.2.3.4:54322",
  ].join("\n");
  const ports = parseSsOutput(stdout);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].port, 4826);
});

test("parseSsOutput: returns empty for empty/garbage input", () => {
  assert.deepEqual(parseSsOutput(""), []);
  assert.deepEqual(parseSsOutput(null), []);
  assert.deepEqual(parseSsOutput(undefined), []);
  assert.deepEqual(parseSsOutput("totally not ss output"), []);
});
