// Unit tests for src/mcp-launch-health.js. Uses an in-memory fake
// registry + stub runHandshake so we can drive every code path without
// spawning real processes.

import test from "node:test";
import assert from "node:assert/strict";

import { createMcpLaunchHealthMonitor } from "../src/mcp-launch-health.js";
import { createMcpLaunchRegistry } from "../src/mcp-launch-registry.js";

function makeRegistry(launches) {
  const r = createMcpLaunchRegistry();
  for (const [buildingId, entries] of Object.entries(launches)) {
    r.declare(buildingId, entries);
  }
  return r;
}

test("checkAll: empty registry returns empty results", async () => {
  const registry = makeRegistry({});
  const monitor = createMcpLaunchHealthMonitor({
    registry,
    runHandshake: async () => ({ ok: true, status: "tools-listed" }),
  });
  const result = await monitor.checkAll();
  assert.deepEqual(result.results, []);
  assert.equal(result.summary.total, 0);
  assert.equal(result.summary.ok, 0);
  assert.equal(result.summary.broken, 0);
  assert.deepEqual(result.summary.brokenBuildings, []);
});

test("checkAll: all-ok run", async () => {
  const registry = makeRegistry({
    "mcp-a": [{ command: "x" }],
    "mcp-b": [{ command: "y" }],
  });
  const monitor = createMcpLaunchHealthMonitor({
    registry,
    runHandshake: async () => ({ ok: true, status: "tools-listed", toolCount: 3, serverName: "demo", serverVersion: "1.0" }),
  });
  const result = await monitor.checkAll();
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.ok, 2);
  assert.equal(result.summary.broken, 0);
  assert.deepEqual(result.summary.brokenBuildings, []);
  for (const entry of result.results) {
    assert.equal(entry.toolCount, 3);
    assert.equal(entry.serverName, "demo");
  }
});

test("checkAll: mixed ok + broken — summary counts both, broken list has the right ids", async () => {
  const registry = makeRegistry({
    "mcp-good": [{ command: "g" }],
    "mcp-bad": [{ command: "b" }],
    "mcp-also-bad": [{ command: "ab" }],
  });
  const monitor = createMcpLaunchHealthMonitor({
    registry,
    runHandshake: async ({ command }) => {
      if (command === "g") return { ok: true, status: "tools-listed", toolCount: 1 };
      return { ok: false, status: "init-failed", error: "missing token" };
    },
  });
  const result = await monitor.checkAll();
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.ok, 1);
  assert.equal(result.summary.broken, 2);
  assert.deepEqual(result.summary.brokenBuildings.sort(), ["mcp-also-bad", "mcp-bad"]);
});

test("checkAll: cache hit within TTL returns the same generatedAt", async () => {
  const registry = makeRegistry({ "mcp-x": [{ command: "x" }] });
  let callCount = 0;
  const monitor = createMcpLaunchHealthMonitor({
    registry,
    runHandshake: async () => { callCount += 1; return { ok: true, status: "tools-listed" }; },
    cacheTtlMs: 60_000,
  });
  const a = await monitor.checkAll();
  const b = await monitor.checkAll();
  assert.equal(callCount, 1, "second call should hit cache");
  assert.equal(a.generatedAt, b.generatedAt);
});

test("checkAll: force=1 invalidates the cache", async () => {
  const registry = makeRegistry({ "mcp-x": [{ command: "x" }] });
  let callCount = 0;
  const monitor = createMcpLaunchHealthMonitor({
    registry,
    runHandshake: async () => { callCount += 1; return { ok: true, status: "tools-listed" }; },
    cacheTtlMs: 60_000,
  });
  await monitor.checkAll();
  await monitor.checkAll({ force: true });
  assert.equal(callCount, 2);
});

test("checkAll: explicit invalidate() forces re-check", async () => {
  const registry = makeRegistry({ "mcp-x": [{ command: "x" }] });
  let callCount = 0;
  const monitor = createMcpLaunchHealthMonitor({
    registry,
    runHandshake: async () => { callCount += 1; return { ok: true, status: "tools-listed" }; },
    cacheTtlMs: 60_000,
  });
  await monitor.checkAll();
  monitor.invalidate();
  await monitor.checkAll();
  assert.equal(callCount, 2);
});

test("checkAll: TTL expiry triggers re-check", async () => {
  const registry = makeRegistry({ "mcp-x": [{ command: "x" }] });
  let callCount = 0;
  let nowVal = 0;
  const monitor = createMcpLaunchHealthMonitor({
    registry,
    runHandshake: async () => { callCount += 1; return { ok: true, status: "tools-listed" }; },
    cacheTtlMs: 1000,
    now: () => nowVal,
  });
  await monitor.checkAll();
  nowVal += 500;
  await monitor.checkAll(); // cache hit (500ms < 1000ms TTL)
  assert.equal(callCount, 1);
  nowVal += 600;
  await monitor.checkAll(); // cache expired (1100ms total)
  assert.equal(callCount, 2);
});

test("checkAll: single-flight — concurrent calls share the in-flight promise", async () => {
  const registry = makeRegistry({ "mcp-x": [{ command: "x" }] });
  let callCount = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const monitor = createMcpLaunchHealthMonitor({
    registry,
    runHandshake: async () => {
      callCount += 1;
      await gate;
      return { ok: true, status: "tools-listed" };
    },
  });
  const a = monitor.checkAll();
  const b = monitor.checkAll();
  const c = monitor.checkAll();
  release();
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.equal(callCount, 1, "only one handshake should run for concurrent callers");
  assert.equal(ra.generatedAt, rb.generatedAt);
  assert.equal(ra.generatedAt, rc.generatedAt);
});

test("checkAll: handshake error response surfaces in result without crashing", async () => {
  const registry = makeRegistry({ "mcp-x": [{ command: "x" }] });
  const monitor = createMcpLaunchHealthMonitor({
    registry,
    runHandshake: async () => ({ ok: false, status: "init-failed", error: "401 Unauthorized" }),
  });
  const result = await monitor.checkAll();
  assert.equal(result.summary.broken, 1);
  assert.equal(result.results[0].error, "401 Unauthorized");
});

test("constructor: throws on missing registry / runHandshake", () => {
  assert.throws(() => createMcpLaunchHealthMonitor({}), /registry is required/);
  const r = makeRegistry({});
  assert.throws(() => createMcpLaunchHealthMonitor({ registry: r }), /runHandshake is required/);
});

test("lastResult / isCacheFresh expose the cache state", async () => {
  const registry = makeRegistry({ "mcp-x": [{ command: "x" }] });
  let nowVal = 0;
  const monitor = createMcpLaunchHealthMonitor({
    registry,
    runHandshake: async () => ({ ok: true, status: "tools-listed" }),
    cacheTtlMs: 1000,
    now: () => nowVal,
  });
  assert.equal(monitor.lastResult(), null);
  assert.equal(monitor.isCacheFresh(), false);
  await monitor.checkAll();
  assert.ok(monitor.lastResult());
  assert.equal(monitor.isCacheFresh(), true);
  nowVal += 1500;
  assert.equal(monitor.isCacheFresh(), false);
});
