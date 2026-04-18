import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { SystemMetricsHistoryStore } from "../src/system-metrics-history.js";

function createSystemSample(checkedAt, utilizationPercent) {
  return {
    checkedAt,
    storage: {
      primary: {
        name: "Test Disk",
        mountPoint: "/",
        totalBytes: 1000,
        usedBytes: 700,
        availableBytes: 300,
        usedPercent: 70,
      },
    },
    wikiStorage: {
      path: "/wiki",
      exists: true,
      bytes: 1234,
    },
    projectStorage: {
      exists: true,
      bytes: 4321,
      rootCount: 2,
      measuredRootCount: 2,
      totalRootCount: 2,
      truncated: false,
    },
    cpu: {
      utilizationPercent,
      cores: [{ id: 0, label: "CPU 1", utilizationPercent }],
    },
    memory: {
      totalBytes: 1000,
      usedBytes: utilizationPercent * 10,
      freeBytes: 1000 - utilizationPercent * 10,
      usedPercent: utilizationPercent,
    },
    gpus: [{ id: "gpu-0", name: "Test GPU", utilizationPercent }],
    accelerators: [],
  };
}

test("SystemMetricsHistoryStore records, persists, and filters hour/day/week ranges", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-system-history-"));
  const base = Date.parse("2026-04-18T00:00:00.000Z");
  let now = base + 2 * 60_000;
  const store = new SystemMetricsHistoryStore({
    minSampleIntervalMs: 60_000,
    now: () => now,
    stateDir,
  });

  try {
    await store.initialize();
    await store.record(createSystemSample("2026-04-17T23:59:00.000Z", 10));
    await store.record(createSystemSample("2026-04-17T23:59:30.000Z", 20));
    await store.record(createSystemSample("2026-04-18T00:00:30.000Z", 30));

    assert.equal(store.samples.length, 2);
    assert.equal(store.samples[0].cpu.cores[0].utilizationPercent, 10);
    assert.equal(store.samples[1].cpu.cores[0].utilizationPercent, 30);

    const reloaded = new SystemMetricsHistoryStore({
      minSampleIntervalMs: 60_000,
      now: () => now,
      stateDir,
    });
    await reloaded.initialize();

    now = Date.parse("2026-04-18T00:30:00.000Z");
    const hour = reloaded.getHistory("1h", { now });
    assert.equal(hour.range, "1h");
    assert.equal(hour.rawSampleCount, 2);
    assert.equal(hour.samples.at(-1).memory.usedPercent, 30);
    assert.equal(hour.samples.at(-1).projectStorage.bytes, 4321);

    now = Date.parse("2026-04-19T00:00:20.000Z");
    assert.equal(reloaded.getHistory("1h", { now }).rawSampleCount, 0);
    assert.equal(reloaded.getHistory("1d", { now }).rawSampleCount, 1);
    assert.equal(reloaded.getHistory("1w", { now }).rawSampleCount, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("SystemMetricsHistoryStore downsamples long ranges for the API", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-system-history-downsample-"));
  const base = Date.parse("2026-04-18T00:00:00.000Z");
  const store = new SystemMetricsHistoryStore({
    maxApiSamples: 5,
    minSampleIntervalMs: 0,
    now: () => base + 10 * 60_000,
    stateDir,
  });

  try {
    await store.initialize();
    for (let index = 0; index < 10; index += 1) {
      await store.record(createSystemSample(new Date(base + index * 60_000).toISOString(), index), { force: true });
    }

    const history = store.getHistory("1h", { now: base + 10 * 60_000 });
    assert.equal(history.rawSampleCount, 10);
    assert.ok(history.sampleCount <= 5);
    assert.equal(history.samples.at(-1).cpu.utilizationPercent, 9);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
