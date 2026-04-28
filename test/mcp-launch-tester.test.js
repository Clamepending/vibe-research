// Unit tests for src/mcp-launch-tester.js. Uses a stub spawn so we can
// drive the test through every code path without spawning real processes.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { testLaunch } from "../src/mcp-launch-tester.js";

// Tiny child_process.ChildProcess stand-in. Tests drive it via .emit().
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (signal) => { child.killed = signal; };
  return child;
}

test("testLaunch: rejects launch without a command", async () => {
  const result = await testLaunch({}, { spawnImpl: () => { throw new Error("should not spawn"); } });
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid-launch");
});

test("testLaunch: rejects null launch", async () => {
  const result = await testLaunch(null);
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid-launch");
});

test("testLaunch: refuses unresolved ${...} in command", async () => {
  const result = await testLaunch({ command: "${someBin}" });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unresolved-template");
});

test("testLaunch: refuses unresolved ${...} in args", async () => {
  const result = await testLaunch({ command: "node", args: ["server.js", "--token", "${tok}"] });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unresolved-template");
});

test("testLaunch: refuses unresolved ${...} in env values", async () => {
  const result = await testLaunch({ command: "node", env: { TOKEN: "${apiKey}" } });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unresolved-template");
});

test("testLaunch: alive — process stays running through warmup", async () => {
  const child = fakeChild();
  const result = await testLaunch(
    { command: "node", args: ["server.js"] },
    {
      spawnImpl: () => child,
      warmupMs: 60,
      killGraceMs: 20,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "alive");
  // Process should have been signalled to terminate after warmup.
  assert.equal(child.killed, "SIGTERM");
});

test("testLaunch: exited-fast — process exits inside warmup", async () => {
  const child = fakeChild();
  // Schedule an exit very early.
  setTimeout(() => child.emit("exit", 1, null), 10);
  const result = await testLaunch(
    { command: "broken-server" },
    {
      spawnImpl: () => child,
      warmupMs: 200,
      killGraceMs: 20,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "exited-fast");
  assert.equal(result.exitCode, 1);
});

test("testLaunch: captures stdout + stderr tails", async () => {
  const child = fakeChild();
  setTimeout(() => {
    child.stdout.emit("data", Buffer.from("listening on stdio\n"));
    child.stderr.emit("data", Buffer.from("warn: missing optional config\n"));
  }, 5);
  const result = await testLaunch(
    { command: "node" },
    { spawnImpl: () => child, warmupMs: 60, killGraceMs: 20 },
  );
  assert.equal(result.ok, true);
  assert.match(result.stdoutTail, /listening on stdio/);
  assert.match(result.stderrTail, /warn: missing optional config/);
});

test("testLaunch: spawn-failed — synchronous throw from spawnImpl", async () => {
  const result = await testLaunch(
    { command: "no-such-binary" },
    { spawnImpl: () => { throw new Error("ENOENT"); } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "spawn-failed");
  assert.match(result.error, /ENOENT/);
});

test("testLaunch: spawn-failed — async error event from child", async () => {
  const child = fakeChild();
  setTimeout(() => child.emit("error", new Error("EACCES")), 5);
  const result = await testLaunch(
    { command: "no-perm-binary" },
    { spawnImpl: () => child, warmupMs: 200, killGraceMs: 20 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "spawn-failed");
  assert.match(result.error, /EACCES/);
});

test("testLaunch: stdout/stderr tails are clamped to STDIO_TAIL_BYTES", async () => {
  const child = fakeChild();
  // Write 10KB of stdout — should be truncated to ~800 chars in the tail.
  setTimeout(() => {
    child.stdout.emit("data", Buffer.from("x".repeat(10_000)));
  }, 5);
  const result = await testLaunch(
    { command: "loud" },
    { spawnImpl: () => child, warmupMs: 60, killGraceMs: 20 },
  );
  assert.ok(result.stdoutTail.length <= 800);
});
