import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTailscaleServeStatus,
  TailscaleServeManager,
} from "../src/tailscale-serve.js";

test("exposes a port with a background Tailscale TCP forwarder", async () => {
  const calls = [];
  const manager = new TailscaleServeManager({
    execFile: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    },
  });

  const result = await manager.exposePort(7860);

  assert.deepEqual(calls, [
    {
      command: "tailscale",
      args: ["serve", "--bg", "--yes", "--tcp=7860", "tcp://localhost:7860"],
    },
  ]);
  assert.equal(result.enabled, true);
  assert.equal(result.port, 7860);
});

test("falls back when an older Tailscale CLI does not support --yes", async () => {
  const calls = [];
  const manager = new TailscaleServeManager({
    execFile: async (command, args) => {
      calls.push({ command, args });
      if (args.includes("--yes")) {
        const error = new Error("flag provided but not defined: -yes");
        error.stderr = "flag provided but not defined: -yes";
        throw error;
      }
      return { stdout: "", stderr: "" };
    },
  });

  await manager.exposePort(3000);

  assert.deepEqual(calls, [
    {
      command: "tailscale",
      args: ["serve", "--bg", "--yes", "--tcp=3000", "tcp://localhost:3000"],
    },
    {
      command: "tailscale",
      args: ["serve", "--bg", "--tcp=3000", "tcp://localhost:3000"],
    },
  ]);
});

test("parses nested Tailscale Serve status for a forwarded port", () => {
  const status = parseTailscaleServeStatus(
    {
      TCP: {
        7860: {
          handlers: {
            "/": "tcp://localhost:7860",
          },
        },
      },
    },
    7860,
  );

  assert.equal(status.available, true);
  assert.equal(status.enabled, true);
  assert.equal(status.port, 7860);
});

test("reports unavailable status when Tailscale status JSON cannot be parsed", async () => {
  const manager = new TailscaleServeManager({
    cacheTtlMs: 0,
    execFile: async () => ({ stdout: "{", stderr: "" }),
  });

  const status = await manager.getStatus();

  assert.equal(status.available, false);
  assert.equal(status.enabled, false);
  assert.match(status.reason, /Could not parse Tailscale Serve status/);
});
