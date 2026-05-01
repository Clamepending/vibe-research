import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  GpuOwnershipStore,
  extractGpuOwnershipObservations,
} from "../src/gpu-ownership-store.js";

async function freshStateDir() {
  return mkdtemp(path.join(os.tmpdir(), "vibe-research-gpu-ledger-"));
}

function alwaysAlive() {
  return true;
}

test("getRootsForKnownSessions returns empty when ledger is empty", async () => {
  const stateDir = await freshStateDir();
  try {
    const store = new GpuOwnershipStore({ stateDir, isPidOwned: alwaysAlive });
    await store.initialize();
    assert.deepEqual(store.getRootsForKnownSessions(["s1"]), []);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("recordObservations persists claims and reload returns them as roots", async () => {
  const stateDir = await freshStateDir();
  try {
    const store = new GpuOwnershipStore({ stateDir, isPidOwned: alwaysAlive });
    await store.initialize();
    await store.recordObservations([
      { pid: 12345, sessionId: "session-a", providerId: "claude" },
      { pid: 67890, sessionId: "session-b", providerId: "codex" },
    ]);

    const reopened = new GpuOwnershipStore({ stateDir, isPidOwned: alwaysAlive });
    await reopened.initialize();
    const roots = reopened.getRootsForKnownSessions(["session-a", "session-b"]);
    const byPid = new Map(roots.map((root) => [root.pid, root]));

    assert.deepEqual(byPid.get(12345), {
      pid: 12345,
      sessionId: "session-a",
      providerId: "claude",
      source: "ledger",
    });
    assert.deepEqual(byPid.get(67890), {
      pid: 67890,
      sessionId: "session-b",
      providerId: "codex",
      source: "ledger",
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("getRootsForKnownSessions filters out claims for unknown sessions", async () => {
  const stateDir = await freshStateDir();
  try {
    const store = new GpuOwnershipStore({ stateDir, isPidOwned: alwaysAlive });
    await store.initialize();
    await store.recordObservations([
      { pid: 1, sessionId: "alive", providerId: "claude" },
      { pid: 2, sessionId: "deleted", providerId: "claude" },
    ]);

    const roots = store.getRootsForKnownSessions(["alive"]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].pid, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("getRootsForKnownSessions skips pids that are no longer owned by us", async () => {
  const stateDir = await freshStateDir();
  try {
    const liveSet = new Set([100]);
    const store = new GpuOwnershipStore({
      stateDir,
      isPidOwned: (pid) => liveSet.has(pid),
    });
    await store.initialize();
    await store.recordObservations([
      { pid: 100, sessionId: "s1", providerId: "claude" },
      { pid: 200, sessionId: "s1", providerId: "claude" }, // recycled / dead
    ]);

    const roots = store.getRootsForKnownSessions(["s1"]);
    assert.deepEqual(
      roots.map((root) => root.pid),
      [100],
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("recordObservations replaces the ledger so dead pids drop off", async () => {
  const stateDir = await freshStateDir();
  try {
    const store = new GpuOwnershipStore({ stateDir, isPidOwned: alwaysAlive });
    await store.initialize();
    await store.recordObservations([
      { pid: 1, sessionId: "s1", providerId: "claude" },
      { pid: 2, sessionId: "s1", providerId: "claude" },
    ]);
    await store.recordObservations([
      { pid: 1, sessionId: "s1", providerId: "claude" },
    ]);

    assert.deepEqual(
      store.getClaimsSnapshot().map((claim) => claim.pid),
      [1],
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("recordObservations preserves firstSeen across re-confirmation", async () => {
  const stateDir = await freshStateDir();
  try {
    const timestamps = [
      "2026-04-01T00:00:00.000Z", // consumed by initialize()
      "2026-04-01T00:05:00.000Z", // first observation
      "2026-04-01T00:10:00.000Z", // re-confirmation
    ];
    let tick = 0;
    const store = new GpuOwnershipStore({
      stateDir,
      isPidOwned: alwaysAlive,
      now: () => timestamps[Math.min(tick++, timestamps.length - 1)],
    });
    await store.initialize();
    await store.recordObservations([
      { pid: 1, sessionId: "s1", providerId: "claude" },
    ]);
    await store.recordObservations([
      { pid: 1, sessionId: "s1", providerId: "claude" },
    ]);

    const [claim] = store.getClaimsSnapshot();
    assert.equal(claim.firstSeen, timestamps[1]);
    assert.equal(claim.lastConfirmed, timestamps[2]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("recordObservations skips disk write when nothing changed", async () => {
  const stateDir = await freshStateDir();
  try {
    const store = new GpuOwnershipStore({ stateDir, isPidOwned: alwaysAlive });
    await store.initialize();
    const wrote = await store.recordObservations([
      { pid: 1, sessionId: "s1", providerId: "claude" },
    ]);
    assert.equal(wrote, true);

    const filePath = path.join(stateDir, "gpu-ownership.json");
    const before = (await readFile(filePath, "utf8")).length;

    const wroteAgain = await store.recordObservations([
      { pid: 1, sessionId: "s1", providerId: "claude" },
    ]);
    assert.equal(wroteAgain, false);

    const after = (await readFile(filePath, "utf8")).length;
    assert.equal(after, before);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("recordObservations honours maxClaims", async () => {
  const stateDir = await freshStateDir();
  try {
    const store = new GpuOwnershipStore({
      stateDir,
      maxClaims: 2,
      isPidOwned: alwaysAlive,
    });
    await store.initialize();
    await store.recordObservations([
      { pid: 1, sessionId: "s1" },
      { pid: 2, sessionId: "s1" },
      { pid: 3, sessionId: "s1" },
      { pid: 4, sessionId: "s1" },
    ]);

    assert.equal(store.getClaimsSnapshot().length, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("initialize tolerates a missing or malformed file", async () => {
  const stateDir = await freshStateDir();
  try {
    const filePath = path.join(stateDir, "gpu-ownership.json");
    await writeFile(filePath, "not json", "utf8");

    const store = new GpuOwnershipStore({ stateDir, isPidOwned: alwaysAlive });
    await assert.rejects(store.initialize());

    await writeFile(filePath, JSON.stringify({ version: 999, claims: [{ pid: 1, sessionId: "s" }] }), "utf8");
    const store2 = new GpuOwnershipStore({ stateDir, isPidOwned: alwaysAlive });
    await store2.initialize();
    assert.deepEqual(store2.getClaimsSnapshot(), []);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("extractGpuOwnershipObservations pulls owned GPU processes from a system snapshot", () => {
  const observations = extractGpuOwnershipObservations({
    gpus: [
      {
        processes: [
          { pid: 100, ownedByUs: true, sessionId: "s1", providerId: "claude", ownerUser: "mark" },
          { pid: 200, ownedByUs: false, sessionId: "", providerId: "", ownerUser: "other" },
          { pid: 300, ownedByUs: true, sessionId: "", providerId: "claude" }, // sessionId missing → skipped
        ],
      },
      {
        processes: [
          { pid: 100, ownedByUs: true, sessionId: "s1", providerId: "claude" }, // duplicate pid → skipped
          { pid: 400, ownedByUs: true, sessionId: "s2", providerId: "codex", ownerUser: "mark" },
        ],
      },
    ],
  });

  assert.deepEqual(observations, [
    { pid: 100, sessionId: "s1", providerId: "claude", ownerUser: "mark" },
    { pid: 400, sessionId: "s2", providerId: "codex", ownerUser: "mark" },
  ]);
});

test("extractGpuOwnershipObservations returns [] for empty input", () => {
  assert.deepEqual(extractGpuOwnershipObservations(undefined), []);
  assert.deepEqual(extractGpuOwnershipObservations({ gpus: [] }), []);
  assert.deepEqual(extractGpuOwnershipObservations({ gpus: [{ processes: [] }] }), []);
});
