import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { AgentRunStore } from "../src/agent-run-store.js";

test("agent run store records, persists, and summarizes duration buckets", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-agent-runs-"));
  const store = new AgentRunStore({ stateDir });
  const base = Date.now();

  try {
    await store.initialize();
    await store.recordRun({
      sessionId: "session-a",
      sessionName: "alpha",
      providerId: "codex",
      providerLabel: "Codex",
      startedAt: base,
      endedAt: base + 25_000,
      durationMs: 25_000,
      completionReason: "idle",
    });
    await store.recordRun({
      sessionId: "session-a",
      sessionName: "alpha",
      providerId: "codex",
      providerLabel: "Codex",
      startedAt: base + 60_000,
      endedAt: base + 11 * 60_000,
      durationMs: 10 * 60_000,
      completionReason: "idle",
    });
    await store.recordRun({
      sessionId: "session-b",
      sessionName: "beta",
      providerId: "claude",
      providerLabel: "Claude Code",
      startedAt: base + 12 * 60_000,
      endedAt: base + 2 * 60 * 60 * 1000 + 12 * 60_000,
      durationMs: 2 * 60 * 60 * 1000,
      completionReason: "session-exit",
    });

    const history = store.getHistory("7d", base + 3 * 60 * 60 * 1000);
    assert.equal(history.range, "7d");
    assert.equal(history.totalRuns, 3);
    assert.equal(history.sessionCount, 2);
    assert.equal(history.totalRunMs, 25_000 + 10 * 60_000 + 2 * 60 * 60 * 1000);
    assert.equal(history.maxRunMs, 2 * 60 * 60 * 1000);
    assert.equal(history.buckets.find((bucket) => bucket.key === "lt30s")?.count, 1);
    assert.equal(history.buckets.find((bucket) => bucket.key === "10m-30m")?.count, 1);
    assert.equal(history.buckets.find((bucket) => bucket.key === "2hPlus")?.count, 1);

    const reloaded = new AgentRunStore({ stateDir });
    await reloaded.initialize();
    const persisted = reloaded.getHistory("30d", base + 3 * 60 * 60 * 1000);
    assert.equal(persisted.totalRuns, 3);
    assert.equal(persisted.sessionCount, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("agent run store summarizes local provider usage windows", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-agent-usage-"));
  const store = new AgentRunStore({ stateDir });
  const now = Date.parse("2026-04-18T20:00:00.000Z");

  try {
    await store.initialize();
    await store.recordRun({
      sessionId: "codex-a",
      sessionName: "codex one",
      providerId: "codex",
      providerLabel: "Codex",
      startedAt: now - 90 * 60 * 1000,
      endedAt: now - 60 * 60 * 1000,
      durationMs: 30 * 60 * 1000,
      completionReason: "idle",
    });
    await store.recordRun({
      sessionId: "codex-b",
      sessionName: "codex two",
      providerId: "codex",
      providerLabel: "Codex",
      startedAt: now - 7 * 60 * 60 * 1000,
      endedAt: now - 6 * 60 * 60 * 1000,
      durationMs: 60 * 60 * 1000,
      completionReason: "idle",
    });

    const usage = store.getProviderUsage({
      now,
      providers: [
        { id: "claude", label: "Claude Code", available: true },
        { id: "codex", label: "Codex", available: true },
      ],
      sessions: [
        {
          id: "codex-a",
          providerId: "codex",
          providerLabel: "Codex",
          status: "running",
          activityStatus: "working",
          activityStartedAt: new Date(now - 10 * 60 * 1000).toISOString(),
        },
      ],
    });

    const codex = usage.providers.find((provider) => provider.id === "codex");
    assert.ok(codex);
    assert.equal(codex.runningSessionCount, 1);
    assert.equal(codex.workingSessionCount, 1);
    assert.equal(codex.quotaAvailable, false);
    assert.equal(codex.windows.find((window) => window.id === "5h")?.totalRunMs, 40 * 60 * 1000);
    assert.equal(codex.windows.find((window) => window.id === "5h")?.activeRunCount, 1);
    assert.equal(Math.round(codex.windows.find((window) => window.id === "5h")?.remainingPercent), 87);
    assert.equal(codex.windows.find((window) => window.id === "7d")?.totalRunMs, 100 * 60 * 1000);

    const claude = usage.providers.find((provider) => provider.id === "claude");
    assert.ok(claude);
    assert.equal(claude.windows.find((window) => window.id === "5h")?.remainingPercent, 100);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
