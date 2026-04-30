// Tests for src/videomemory-server-update.js — the periodic git-pull
// helper that keeps ~/videomemory current with origin without auto-
// restarting the launched server.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  runVideoMemoryGitPull,
  startPeriodicVideoMemoryGitPull,
} from "../src/videomemory-server-update.js";

function fakeStat({ isDir = true, missing = false } = {}) {
  return async () => {
    if (missing) {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    return { isDirectory: () => isDir };
  };
}

function captureExec(returnValue = { stdout: "Already up to date.", stderr: "" }) {
  const calls = [];
  const impl = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (returnValue instanceof Error) throw returnValue;
    return returnValue;
  };
  return { impl, calls };
}

test("runVideoMemoryGitPull: returns not-installed when path is missing", async () => {
  const result = await runVideoMemoryGitPull({
    installRoot: "/tmp/does-not-exist",
    statImpl: fakeStat({ missing: true }),
    execFileImpl: async () => { throw new Error("should not be called"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-installed");
});

test("runVideoMemoryGitPull: returns not-installed when path exists but isn't a directory", async () => {
  const result = await runVideoMemoryGitPull({
    installRoot: "/tmp/file-not-dir",
    statImpl: fakeStat({ isDir: false }),
    execFileImpl: async () => { throw new Error("should not be called"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-installed");
});

test("runVideoMemoryGitPull: 'Already up to date' is reported as no-op", async () => {
  const exec = captureExec({ stdout: "Already up to date.\n", stderr: "" });
  const result = await runVideoMemoryGitPull({
    installRoot: "/tmp/fake-vm",
    statImpl: fakeStat(),
    execFileImpl: exec.impl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "no-op");
  assert.equal(exec.calls.length, 1);
  assert.deepEqual(exec.calls[0].args, ["-C", "/tmp/fake-vm", "pull", "--ff-only", "origin"]);
});

test("runVideoMemoryGitPull: empty stdout is also reported as no-op", async () => {
  const exec = captureExec({ stdout: "", stderr: "" });
  const result = await runVideoMemoryGitPull({
    installRoot: "/tmp/fake-vm",
    statImpl: fakeStat(),
    execFileImpl: exec.impl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "no-op");
});

test("runVideoMemoryGitPull: real fast-forward output is reported as pulled", async () => {
  const exec = captureExec({
    stdout: "From github.com:Clamepending/videomemory\n   abc123..def456  main -> origin/main\nFast-forward\n",
    stderr: "",
  });
  const result = await runVideoMemoryGitPull({
    installRoot: "/tmp/fake-vm",
    statImpl: fakeStat(),
    execFileImpl: exec.impl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "pulled");
  assert.match(result.stdout, /Fast-forward/);
});

test("runVideoMemoryGitPull: surfaces stderr from divergent-history failure", async () => {
  const err = new Error("Command failed");
  err.stderr = "fatal: Not possible to fast-forward, aborting.\n";
  const result = await runVideoMemoryGitPull({
    installRoot: "/tmp/fake-vm",
    statImpl: fakeStat(),
    execFileImpl: async () => { throw err; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.match(result.reason, /not possible to fast-forward/i);
});

test("runVideoMemoryGitPull: returns no-install-root when installRoot is empty", async () => {
  const result = await runVideoMemoryGitPull({ installRoot: "" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-install-root");
});

test("startPeriodicVideoMemoryGitPull: runs once immediately + arms an interval", async () => {
  const calls = [];
  let intervalCount = 0;
  let lastTimer = null;
  const fakeSetInterval = (fn, ms) => {
    intervalCount += 1;
    lastTimer = { fn, ms, unref: () => {} };
    return lastTimer;
  };
  const fakeClearInterval = (timer) => {
    if (timer === lastTimer) lastTimer = null;
  };
  const fakePull = async (opts) => {
    calls.push(opts);
    return { ok: true, status: "no-op" };
  };

  const stop = startPeriodicVideoMemoryGitPull({
    installRoot: "/tmp/fake-vm",
    intervalMs: 1000,
    setIntervalImpl: fakeSetInterval,
    clearIntervalImpl: fakeClearInterval,
    pullImpl: fakePull,
  });

  // Immediate tick is async — wait a tick.
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1, "first call must fire immediately on start");
  assert.equal(calls[0].installRoot, "/tmp/fake-vm");
  assert.equal(intervalCount, 1, "interval timer must be armed");
  assert.equal(lastTimer.ms, 1000);

  // Simulate the interval firing.
  await lastTimer.fn();
  assert.equal(calls.length, 2);

  stop();
  assert.equal(lastTimer, null, "stop() must clear the interval");

  // After stop, simulated interval ticks shouldn't fire pulls.
  // (The real timer is gone; if anyone holds a stale reference and ticks it,
  // our internal `cancelled` flag prevents the pull.)
});

test("startPeriodicVideoMemoryGitPull: skips immediately when runImmediately:false", async () => {
  const calls = [];
  let lastTimer = null;
  const stop = startPeriodicVideoMemoryGitPull({
    installRoot: "/tmp/fake-vm",
    intervalMs: 1000,
    runImmediately: false,
    setIntervalImpl: (fn, ms) => { lastTimer = { fn, ms, unref: () => {} }; return lastTimer; },
    clearIntervalImpl: () => { lastTimer = null; },
    pullImpl: async (opts) => { calls.push(opts); return { ok: true }; },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0, "no immediate call when runImmediately is false");
  await lastTimer.fn();
  assert.equal(calls.length, 1, "interval still fires");
  stop();
});

test("startPeriodicVideoMemoryGitPull: empty installRoot is a no-op", async () => {
  let armed = false;
  const stop = startPeriodicVideoMemoryGitPull({
    installRoot: "",
    intervalMs: 1000,
    setIntervalImpl: () => { armed = true; return null; },
    pullImpl: async () => { throw new Error("should not pull"); },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(armed, false);
  // stop() returns a function even on the no-op path (caller can always call it).
  assert.equal(typeof stop, "function");
  stop();
});

test("startPeriodicVideoMemoryGitPull: pull failures are routed through the log callback, not thrown", async () => {
  const logEvents = [];
  let lastTimer = null;
  const stop = startPeriodicVideoMemoryGitPull({
    installRoot: "/tmp/fake-vm",
    intervalMs: 1000,
    log: (entry) => logEvents.push(entry),
    setIntervalImpl: (fn, ms) => { lastTimer = { fn, ms, unref: () => {} }; return lastTimer; },
    clearIntervalImpl: () => {},
    pullImpl: async () => { throw new Error("boom"); },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(logEvents.length, 1);
  assert.equal(logEvents[0].event, "videomemory-git-pull");
  assert.equal(logEvents[0].result.ok, false);
  assert.match(logEvents[0].result.reason, /boom/);
  stop();
});

// One real-filesystem integration test: clone a tiny seeded local repo
// into a temp dir, run the pull, assert it returns ok. We don't need a
// remote service — a bare repo on disk is fine. This catches regressions
// in the actual git invocation that pure mocks would miss.
test("[integration] runs git pull --ff-only against a real local repo", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-vm-pull-"));
  try {
    let execSync;
    try {
      ({ execSync } = await import("node:child_process"));
      execSync("git --version", { stdio: "pipe" });
    } catch {
      t.skip("git not available on this host");
      return;
    }

    const upstream = path.join(tmp, "upstream.git");
    const checkout = path.join(tmp, "checkout");
    await mkdir(upstream, { recursive: true });
    execSync("git init --bare -b main", { cwd: upstream });

    const seed = path.join(tmp, "seed");
    await mkdir(seed, { recursive: true });
    execSync("git init -q -b main", { cwd: seed });
    execSync("git config user.email t@t.com", { cwd: seed });
    execSync("git config user.name t", { cwd: seed });
    execSync("git commit --allow-empty -q -m init", { cwd: seed });
    execSync(`git remote add origin ${upstream}`, { cwd: seed });
    execSync("git push -q origin main", { cwd: seed });

    execSync(`git clone -q ${upstream} ${checkout}`);
    // Defensive: ensure the cloned checkout tracks origin/main so
    // `git pull origin` knows what to merge. On hosts whose default
    // branch is 'master' the clone may not auto-set this.
    execSync("git branch --set-upstream-to=origin/main main || true", { cwd: checkout });

    const result = await runVideoMemoryGitPull({ installRoot: checkout });
    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    assert.ok(["no-op", "pulled"].includes(result.status), `unexpected status: ${result.status}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
