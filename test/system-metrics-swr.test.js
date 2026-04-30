import assert from "node:assert/strict";
import test from "node:test";
import { collectSystemMetrics } from "../src/system-metrics.js";

const DF_OUTPUT = `Filesystem    1024-blocks      Used Available Capacity Mounted on
/dev/disk1       1000000    900000    100000     90% /
`;

const NVIDIA_CSV = ""; // no GPUs in these tests

function createCpuSequence() {
  const snapshots = [
    [{ times: { user: 0, nice: 0, sys: 0, idle: 100, irq: 0 } }],
    [{ times: { user: 50, nice: 0, sys: 0, idle: 100, irq: 0 } }],
  ];
  let index = 0;
  return () => snapshots[Math.min(index++, snapshots.length - 1)];
}

// Tracks how many times `du` was actually invoked, with a stub that resolves
// only when its corresponding `release` is called. Lets us assert dedup and
// pending semantics without timing flake.
function makeManualDu({ initialBytes = 100 }) {
  const inFlight = [];
  const calls = [];
  let bytes = initialBytes;

  function setBytes(next) {
    bytes = next;
  }

  async function execFile(command, args) {
    if (command === "df") {
      return { stdout: DF_OUTPUT, stderr: "" };
    }
    if (command === "nvidia-smi") {
      return { stdout: NVIDIA_CSV, stderr: "" };
    }
    if (command === "du") {
      calls.push(args.join(" "));
      return new Promise((resolve) => {
        inFlight.push(() => {
          resolve({ stdout: `${bytes}\t${args[1]}\n`, stderr: "" });
        });
      });
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  }

  function releaseAll() {
    while (inFlight.length) {
      inFlight.shift()();
    }
  }

  return { execFile, calls, releaseAll, setBytes };
}

const COMMON_OPTIONS = {
  cwd: "/workspace/project",
  platform: "linux",
  sampleMs: 1,
  cpus: createCpuSequence(),
  totalmem: () => 16_000,
  freemem: () => 4_000,
  async readdir() {
    return [];
  },
  async readFile() {
    throw new Error("not found");
  },
};

async function flushMicrotasks(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

test("SWR mode returns a pending placeholder for storage on a cold cache", async () => {
  const { execFile, calls } = makeManualDu({ initialBytes: 200 });
  const wikiCache = new Map();
  const projectCache = new Map();

  const system = await collectSystemMetrics({
    ...COMMON_OPTIONS,
    cpus: createCpuSequence(),
    execFile,
    projectPaths: ["/workspace/project"],
    projectStorageCache: projectCache,
    staleWhileRevalidate: true,
    wikiPath: "/workspace/wiki",
    wikiStorageCache: wikiCache,
  });

  assert.equal(system.wikiStorage.pending, true);
  assert.equal(system.wikiStorage.bytes, null);
  assert.equal(system.wikiStorage.source, "computing");
  assert.equal(system.projectStorage.pending, true);
  assert.equal(system.projectStorage.exists, false);
  // The compute is in-flight, so `du` should have been kicked off but not
  // awaited by the caller.
  assert.ok(calls.includes("-sk /workspace/wiki"));
  assert.ok(calls.includes("-sk /workspace/project"));
});

test("SWR mode dedupes concurrent in-flight refreshes per path", async () => {
  const { execFile, calls } = makeManualDu({ initialBytes: 300 });
  const wikiCache = new Map();
  const projectCache = new Map();

  // Three back-to-back SWR calls before any du resolves. Only the FIRST should
  // trigger a `du` for each path; subsequent calls should see refreshing in
  // flight and not start another compute.
  const calls0 = calls.length;
  await collectSystemMetrics({
    ...COMMON_OPTIONS,
    cpus: createCpuSequence(),
    execFile,
    projectPaths: ["/workspace/project"],
    projectStorageCache: projectCache,
    staleWhileRevalidate: true,
    wikiPath: "/workspace/wiki",
    wikiStorageCache: wikiCache,
  });
  await collectSystemMetrics({
    ...COMMON_OPTIONS,
    cpus: createCpuSequence(),
    execFile,
    projectPaths: ["/workspace/project"],
    projectStorageCache: projectCache,
    staleWhileRevalidate: true,
    wikiPath: "/workspace/wiki",
    wikiStorageCache: wikiCache,
  });
  await collectSystemMetrics({
    ...COMMON_OPTIONS,
    cpus: createCpuSequence(),
    execFile,
    projectPaths: ["/workspace/project"],
    projectStorageCache: projectCache,
    staleWhileRevalidate: true,
    wikiPath: "/workspace/wiki",
    wikiStorageCache: wikiCache,
  });

  const duCalls = calls.slice(calls0).filter((command) => command.startsWith("-sk "));
  assert.equal(duCalls.length, 2, `expected 2 du calls (1 wiki + 1 project), got ${duCalls.length}: ${duCalls}`);
});

test("SWR mode populates the cache once the in-flight refresh resolves", async () => {
  const { execFile, calls, releaseAll } = makeManualDu({ initialBytes: 400 });
  const wikiCache = new Map();
  const projectCache = new Map();

  // First call: cold cache → pending placeholder, refresh starts.
  const first = await collectSystemMetrics({
    ...COMMON_OPTIONS,
    cpus: createCpuSequence(),
    execFile,
    projectPaths: ["/workspace/project"],
    projectStorageCache: projectCache,
    staleWhileRevalidate: true,
    wikiPath: "/workspace/wiki",
    wikiStorageCache: wikiCache,
  });
  assert.equal(first.wikiStorage.pending, true);

  // Resolve the in-flight `du`.
  releaseAll();
  await flushMicrotasks();

  // Second call: cache now has the fresh value, served instantly.
  const second = await collectSystemMetrics({
    ...COMMON_OPTIONS,
    cpus: createCpuSequence(),
    execFile,
    projectPaths: ["/workspace/project"],
    projectStorageCache: projectCache,
    staleWhileRevalidate: true,
    wikiPath: "/workspace/wiki",
    wikiStorageCache: wikiCache,
  });
  assert.equal(second.wikiStorage.pending, undefined);
  assert.equal(second.wikiStorage.bytes, 400 * 1024);
  assert.equal(second.wikiStorage.source, "du");
  assert.equal(second.projectStorage.bytes, 400 * 1024);
  // No new `du` for the second call because the cached values are within TTL.
  const duCallsAfterRelease = calls.filter((command) => command.startsWith("-sk "));
  assert.equal(duCallsAfterRelease.length, 2);
});

test("SWR mode serves stale cached values while refreshing in the background", async () => {
  const { execFile, calls, releaseAll, setBytes } = makeManualDu({ initialBytes: 100 });
  const wikiCache = new Map();
  const projectCache = new Map();

  // Seed the cache with a value, then expire it (cacheMs = 0 forces stale).
  await collectSystemMetrics({
    ...COMMON_OPTIONS,
    cpus: createCpuSequence(),
    execFile,
    projectPaths: ["/workspace/project"],
    projectStorageCache: projectCache,
    staleWhileRevalidate: true,
    wikiPath: "/workspace/wiki",
    wikiStorageCache: wikiCache,
  });
  releaseAll();
  await flushMicrotasks();

  // Bump bytes to differentiate the next refresh, and call again with cacheMs=0
  // so the seeded entry is treated as stale.
  setBytes(700);
  const callsBeforeStale = calls.length;
  const stale = await collectSystemMetrics({
    ...COMMON_OPTIONS,
    cpus: createCpuSequence(),
    execFile,
    projectPaths: ["/workspace/project"],
    projectStorageCache: projectCache,
    projectStorageCacheMs: 0,
    staleWhileRevalidate: true,
    wikiPath: "/workspace/wiki",
    wikiStorageCache: wikiCache,
    wikiStorageCacheMs: 0,
  });

  // Stale value served immediately (the original 100 KiB), with refreshing flag.
  assert.equal(stale.wikiStorage.bytes, 100 * 1024);
  assert.equal(stale.wikiStorage.refreshing, true);
  assert.equal(stale.projectStorage.exists, true);
  assert.equal(stale.projectStorage.bytes, 100 * 1024);
  // A new `du` was kicked off for both paths.
  const duCallsDuringStale = calls.slice(callsBeforeStale).filter((command) => command.startsWith("-sk "));
  assert.equal(duCallsDuringStale.length, 2);

  // After the refresh resolves, a third call sees the new value.
  releaseAll();
  await flushMicrotasks();
  const fresh = await collectSystemMetrics({
    ...COMMON_OPTIONS,
    cpus: createCpuSequence(),
    execFile,
    projectPaths: ["/workspace/project"],
    projectStorageCache: projectCache,
    staleWhileRevalidate: true,
    wikiPath: "/workspace/wiki",
    wikiStorageCache: wikiCache,
  });
  assert.equal(fresh.wikiStorage.bytes, 700 * 1024);
});

test("blocking mode still computes synchronously and writes to cache (no regression)", async () => {
  const { execFile, releaseAll } = makeManualDu({ initialBytes: 50 });
  const wikiCache = new Map();
  const projectCache = new Map();

  // In blocking mode the call should not return until `du` resolves.
  let resolved = false;
  const collectPromise = collectSystemMetrics({
    ...COMMON_OPTIONS,
    cpus: createCpuSequence(),
    execFile,
    projectPaths: ["/workspace/project"],
    projectStorageCache: projectCache,
    wikiPath: "/workspace/wiki",
    wikiStorageCache: wikiCache,
  }).then((result) => {
    resolved = true;
    return result;
  });

  await flushMicrotasks();
  assert.equal(resolved, false, "blocking mode must wait for du");

  releaseAll();
  const system = await collectPromise;
  assert.equal(system.wikiStorage.bytes, 50 * 1024);
  assert.equal(system.wikiStorage.pending, undefined);
});
