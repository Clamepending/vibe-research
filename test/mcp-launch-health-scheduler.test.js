// Unit tests for src/mcp-launch-health-scheduler.js. Drives the timer
// deterministically by injecting setTimeoutImpl + clearTimeoutImpl
// stubs that capture the scheduled callback so tests can fire it
// manually.

import test from "node:test";
import assert from "node:assert/strict";

import { createMcpLaunchHealthScheduler } from "../src/mcp-launch-health-scheduler.js";

// Manual timer driver. setTimeoutImpl returns an opaque token; tests
// invoke driver.fire() to run the scheduled callback synchronously.
function makeManualTimer() {
  const driver = {
    queue: [],
    setTimeoutImpl: (cb, delay) => {
      const token = { cb, delay, cancelled: false };
      driver.queue.push(token);
      return token;
    },
    clearTimeoutImpl: (token) => {
      if (token) token.cancelled = true;
    },
    async fire() {
      // Fire the most-recent live token.
      while (driver.queue.length) {
        const token = driver.queue.pop();
        if (!token.cancelled) {
          await token.cb();
          return token;
        }
      }
      return null;
    },
    pending() {
      return driver.queue.filter((t) => !t.cancelled).length;
    },
  };
  return driver;
}

function makeMonitor({ behavior = async () => ({ summary: { total: 0 } }) } = {}) {
  const calls = [];
  return {
    calls,
    async checkAll(opts) {
      calls.push(opts);
      return await behavior(calls.length);
    },
  };
}

test("scheduler: throws if monitor missing", () => {
  assert.throws(() => createMcpLaunchHealthScheduler({}), /monitor with checkAll/);
});

test("scheduler: start() schedules the first tick after initialDelayMs, not intervalMs", () => {
  const timer = makeManualTimer();
  const monitor = makeMonitor();
  const scheduler = createMcpLaunchHealthScheduler({
    monitor,
    intervalMs: 60_000,
    initialDelayMs: 100,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
  });
  scheduler.start();
  assert.equal(timer.queue.length, 1);
  assert.equal(timer.queue[0].delay, 100, "first tick uses initialDelayMs");
});

test("scheduler: each tick runs checkAll then re-schedules with intervalMs", async () => {
  const timer = makeManualTimer();
  const monitor = makeMonitor();
  const scheduler = createMcpLaunchHealthScheduler({
    monitor,
    intervalMs: 5000,
    initialDelayMs: 1,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
  });
  scheduler.start();
  // Drive the first scheduled callback.
  await timer.fire();
  assert.equal(monitor.calls.length, 1);
  // After the tick a new timer with intervalMs is scheduled.
  assert.equal(timer.queue.length, 1);
  assert.equal(timer.queue[0].delay, 5000);
  // Drive again.
  await timer.fire();
  assert.equal(monitor.calls.length, 2);
  scheduler.stop();
});

test("scheduler: stop() cancels the next scheduled tick", async () => {
  const timer = makeManualTimer();
  const monitor = makeMonitor();
  const scheduler = createMcpLaunchHealthScheduler({
    monitor,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
  });
  scheduler.start();
  scheduler.stop();
  // The pending token should be cancelled now.
  assert.equal(timer.pending(), 0);
  // Firing the cancelled timer is a no-op.
  await timer.fire();
  assert.equal(monitor.calls.length, 0);
});

test("scheduler: checkAll error is caught and the next tick is still scheduled", async () => {
  const timer = makeManualTimer();
  const monitor = {
    calls: 0,
    async checkAll() { this.calls += 1; throw new Error("boom"); },
  };
  const errors = [];
  const scheduler = createMcpLaunchHealthScheduler({
    monitor,
    intervalMs: 1000,
    initialDelayMs: 1,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    onError: (err) => errors.push(err),
  });
  scheduler.start();
  await timer.fire();
  assert.equal(monitor.calls, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /boom/);
  // Next tick should still be queued.
  assert.equal(timer.queue.length, 1);
  scheduler.stop();
});

test("scheduler: runOnce() runs checkAll out-of-band without affecting timer queue", async () => {
  const timer = makeManualTimer();
  const monitor = makeMonitor();
  const scheduler = createMcpLaunchHealthScheduler({
    monitor,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
  });
  scheduler.start();
  // Pending tick from start().
  assert.equal(timer.pending(), 1);
  await scheduler.runOnce();
  assert.equal(monitor.calls.length, 1);
  // runOnce() does NOT clear or replace the next scheduled tick.
  assert.equal(timer.pending(), 1);
});

test("scheduler: start() is idempotent", () => {
  const timer = makeManualTimer();
  const monitor = makeMonitor();
  const scheduler = createMcpLaunchHealthScheduler({
    monitor,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
  });
  scheduler.start();
  scheduler.start();
  scheduler.start();
  assert.equal(timer.queue.length, 1, "calling start multiple times schedules only once");
  scheduler.stop();
});

test("scheduler: a long-running tick does not overlap with the next tick", async () => {
  // Verify the setTimeout-recursion model: the next tick is scheduled
  // ONLY after the current one's checkAll() resolves, never before.
  const timer = makeManualTimer();
  let resolveTick;
  const tickGate = new Promise((r) => { resolveTick = r; });
  const monitor = {
    calls: 0,
    async checkAll() { this.calls += 1; await tickGate; },
  };
  const scheduler = createMcpLaunchHealthScheduler({
    monitor,
    intervalMs: 100,
    initialDelayMs: 1,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
  });
  scheduler.start();
  const firingPromise = timer.fire();
  // While the tick is still in flight, no new timer should be queued.
  // Allow microtasks to run.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timer.pending(), 0, "next tick must not be scheduled while current tick is in flight");
  resolveTick();
  await firingPromise;
  // After the in-flight check resolves, the next timer should appear.
  // .finally() runs in a microtask, so wait for it.
  await Promise.resolve();
  assert.equal(timer.queue.length, 1);
  scheduler.stop();
});

test("scheduler: tickCount increments per fired tick + per runOnce", async () => {
  const timer = makeManualTimer();
  const monitor = makeMonitor();
  const scheduler = createMcpLaunchHealthScheduler({
    monitor,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
  });
  scheduler.start();
  await timer.fire();
  await scheduler.runOnce();
  await timer.fire();
  assert.equal(scheduler.tickCount(), 3);
  scheduler.stop();
});

test("scheduler: callable intervalMs is re-read on every tick", async () => {
  const timer = makeManualTimer();
  const monitor = makeMonitor();
  let configuredInterval = 5000;
  const scheduler = createMcpLaunchHealthScheduler({
    monitor,
    intervalMs: () => configuredInterval,
    initialDelayMs: 1,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
  });
  scheduler.start();
  await timer.fire();
  // Now scheduled with current intervalMs.
  assert.equal(timer.queue[0].delay, 5000);
  // Change the setting between ticks.
  configuredInterval = 12345;
  await timer.fire();
  // Next scheduled tick should use the NEW interval.
  assert.equal(timer.queue[0].delay, 12345);
  scheduler.stop();
});

test("scheduler: callable intervalMs returning bad value falls back to default", async () => {
  const timer = makeManualTimer();
  const monitor = makeMonitor();
  const scheduler = createMcpLaunchHealthScheduler({
    monitor,
    intervalMs: () => "not a number",
    initialDelayMs: 1,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
  });
  scheduler.start();
  await timer.fire();
  // Default is 5 minutes.
  assert.equal(timer.queue[0].delay, 5 * 60_000);
  scheduler.stop();
});

test("scheduler: isRunning reflects start/stop state", () => {
  const timer = makeManualTimer();
  const scheduler = createMcpLaunchHealthScheduler({
    monitor: makeMonitor(),
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
  });
  assert.equal(scheduler.isRunning(), false);
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  scheduler.stop();
  assert.equal(scheduler.isRunning(), false);
});
