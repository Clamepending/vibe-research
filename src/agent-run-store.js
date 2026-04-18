import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const AGENT_RUN_FILE_VERSION = 1;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RANGE_MS = {
  "1d": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};
const PROVIDER_USAGE_WINDOWS = [
  {
    id: "5h",
    label: "5 hour local usage",
    windowMs: 5 * HOUR_MS,
    targetRunMs: 5 * HOUR_MS,
  },
  {
    id: "7d",
    label: "Weekly local usage",
    windowMs: 7 * DAY_MS,
    targetRunMs: 40 * HOUR_MS,
  },
];
const PROVIDER_USAGE_ORDER = ["claude", "codex", "gemini", "opencode"];
const RUN_BUCKETS = [
  { key: "lt30s", label: "<30s", minMs: 0, maxMs: 30 * 1000 },
  { key: "30s-2m", label: "30s-2m", minMs: 30 * 1000, maxMs: 2 * 60 * 1000 },
  { key: "2m-10m", label: "2m-10m", minMs: 2 * 60 * 1000, maxMs: 10 * 60 * 1000 },
  { key: "10m-30m", label: "10m-30m", minMs: 10 * 60 * 1000, maxMs: 30 * 60 * 1000 },
  { key: "30m-1h", label: "30m-1h", minMs: 30 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  { key: "1h-2h", label: "1h-2h", minMs: 60 * 60 * 1000, maxMs: 2 * 60 * 60 * 1000 },
  { key: "2hPlus", label: "2h+", minMs: 2 * 60 * 60 * 1000, maxMs: null },
];

function normalizeRun(entry) {
  const startedAt = Number(entry?.startedAt);
  const endedAt = Number(entry?.endedAt);
  const durationMs = Math.max(0, Number(entry?.durationMs) || endedAt - startedAt);

  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt || durationMs <= 0) {
    return null;
  }

  return {
    id: String(entry?.id || randomUUID()),
    sessionId: String(entry?.sessionId || "").trim(),
    sessionName: String(entry?.sessionName || "").trim(),
    providerId: String(entry?.providerId || "").trim(),
    providerLabel: String(entry?.providerLabel || "").trim(),
    startedAt,
    endedAt,
    durationMs,
    completionReason: String(entry?.completionReason || "idle").trim() || "idle",
  };
}

function buildPayload(runs) {
  return {
    version: AGENT_RUN_FILE_VERSION,
    savedAt: new Date().toISOString(),
    runs,
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeAtomicJson(filePath, payload) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) {
    return 0;
  }

  const index = (sortedValues.length - 1) * percentileValue;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);

  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex];
  }

  const weight = index - lowerIndex;
  return Math.round(
    sortedValues[lowerIndex] + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * weight,
  );
}

function buildBuckets(runs) {
  return RUN_BUCKETS.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    count: runs.filter(
      (run) => run.durationMs >= bucket.minMs && (bucket.maxMs === null || run.durationMs < bucket.maxMs),
    ).length,
  }));
}

function clampPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) {
    return 0;
  }

  return Math.min(100, Math.max(0, percent));
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeRuns(runs) {
  const sortedRuns = runs.slice().sort((left, right) => left.endedAt - right.endedAt);
  const durations = sortedRuns
    .map((run) => run.durationMs)
    .filter((durationMs) => Number.isFinite(durationMs) && durationMs > 0)
    .sort((left, right) => left - right);

  return {
    totalRuns: sortedRuns.length,
    totalRunMs: durations.reduce((sum, durationMs) => sum + durationMs, 0),
    sessionCount: new Set(sortedRuns.map((run) => run.sessionId).filter(Boolean)).size,
    medianRunMs: percentile(durations, 0.5),
    p90RunMs: percentile(durations, 0.9),
    maxRunMs: durations[durations.length - 1] || 0,
    latestEndedAt: sortedRuns[sortedRuns.length - 1]?.endedAt ?? null,
    buckets: buildBuckets(sortedRuns),
  };
}

function summarizeProviderWindow(runs, window, now) {
  const threshold = now - window.windowMs;
  const windowRuns = [];
  let totalRunMs = 0;

  for (const run of runs) {
    const runEndedAt = parseTimestamp(run.endedAt) ?? now;
    const endedAt = Math.min(now, runEndedAt);
    const durationMs = Math.max(0, Number(run.durationMs) || 0);
    const startedAt = parseTimestamp(run.startedAt) ?? endedAt - durationMs;
    const overlapMs = Math.max(0, endedAt - Math.max(startedAt, threshold));

    if (overlapMs <= 0) {
      continue;
    }

    windowRuns.push(run);
    totalRunMs += overlapMs;
  }

  const usedPercent = window.targetRunMs > 0 ? clampPercent((totalRunMs / window.targetRunMs) * 100) : 0;

  return {
    id: window.id,
    label: window.label,
    windowMs: window.windowMs,
    targetRunMs: window.targetRunMs,
    totalRunMs,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    runCount: windowRuns.length,
    activeRunCount: windowRuns.filter((run) => run.active).length,
    sessionCount: new Set(windowRuns.map((run) => run.sessionId).filter(Boolean)).size,
    latestEndedAt: windowRuns
      .map((run) => parseTimestamp(run.endedAt))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)
      .at(-1) ?? null,
  };
}

function buildActiveSessionRun(session, now) {
  if (session?.status !== "running" || session?.activityStatus !== "working") {
    return null;
  }

  const startedAt = parseTimestamp(session.activityStartedAt)
    ?? parseTimestamp(session.lastPromptAt)
    ?? parseTimestamp(session.updatedAt)
    ?? now;

  if (startedAt > now) {
    return null;
  }

  return {
    sessionId: session.id,
    sessionName: session.name,
    providerId: session.providerId,
    providerLabel: session.providerLabel,
    startedAt,
    endedAt: now,
    durationMs: Math.max(0, now - startedAt),
    completionReason: "active",
    active: true,
  };
}

export class AgentRunStore {
  constructor({
    stateDir,
    retentionMs = DEFAULT_RETENTION_MS,
  }) {
    this.stateDir = stateDir;
    this.filePath = path.join(stateDir, "agent-runs.json");
    this.retentionMs = retentionMs;
    this.runs = [];
  }

  async initialize() {
    const payload = await readJsonIfExists(this.filePath);
    const runs =
      payload?.version === AGENT_RUN_FILE_VERSION && Array.isArray(payload?.runs)
        ? payload.runs
        : [];

    this.runs = runs
      .map((entry) => normalizeRun(entry))
      .filter(Boolean)
      .sort((left, right) => left.endedAt - right.endedAt);
    this.prune(Date.now());
  }

  prune(now = Date.now()) {
    const threshold = now - this.retentionMs;
    this.runs = this.runs.filter((run) => run.endedAt >= threshold);
  }

  async recordRun(run) {
    const normalizedRun = normalizeRun(run);
    if (!normalizedRun) {
      return false;
    }

    this.runs.push(normalizedRun);
    this.runs.sort((left, right) => left.endedAt - right.endedAt);
    this.prune(normalizedRun.endedAt);
    await writeAtomicJson(this.filePath, buildPayload(this.runs));
    return true;
  }

  getHistory(range = "1d", now = Date.now()) {
    const rangeKey = RANGE_MS[range] ? range : "1d";
    const threshold = now - RANGE_MS[rangeKey];
    const runs = this.runs.filter((run) => run.endedAt >= threshold);

    return {
      range: rangeKey,
      rangeMs: RANGE_MS[rangeKey],
      ...summarizeRuns(runs),
    };
  }

  getProviderUsage({ providers = [], sessions = [], now = Date.now() } = {}) {
    const providerMap = new Map();

    const ensureProvider = ({ id, label = "", available = null } = {}) => {
      const providerId = String(id || "").trim();
      if (!providerId || providerId === "shell") {
        return null;
      }

      const current = providerMap.get(providerId) || {
        id: providerId,
        label: label || providerId,
        available,
      };

      if (label && (!current.label || current.label === current.id)) {
        current.label = label;
      }
      if (available !== null) {
        current.available = Boolean(available);
      }

      providerMap.set(providerId, current);
      return current;
    };

    for (const provider of Array.isArray(providers) ? providers : []) {
      ensureProvider({
        id: provider?.id,
        label: provider?.label,
        available: provider?.available,
      });
    }

    for (const run of this.runs) {
      ensureProvider({
        id: run.providerId,
        label: run.providerLabel,
      });
    }

    for (const session of Array.isArray(sessions) ? sessions : []) {
      ensureProvider({
        id: session?.providerId,
        label: session?.providerLabel,
      });
    }

    const providerSessions = new Map();
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!session?.providerId || session.providerId === "shell") {
        continue;
      }

      const entries = providerSessions.get(session.providerId) || [];
      entries.push(session);
      providerSessions.set(session.providerId, entries);
    }

    const entries = [...providerMap.values()]
      .filter((provider) => provider.available !== false || this.runs.some((run) => run.providerId === provider.id))
      .sort((left, right) => {
        const leftIndex = PROVIDER_USAGE_ORDER.indexOf(left.id);
        const rightIndex = PROVIDER_USAGE_ORDER.indexOf(right.id);
        if (leftIndex !== -1 || rightIndex !== -1) {
          return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
            - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
        }
        return left.label.localeCompare(right.label);
      })
      .map((provider) => {
        const runs = this.runs
          .filter((run) => run.providerId === provider.id)
          .sort((left, right) => left.endedAt - right.endedAt);
        const sessionsForProvider = providerSessions.get(provider.id) || [];
        const activeRuns = sessionsForProvider
          .map((session) => buildActiveSessionRun(session, now))
          .filter(Boolean);
        const visibleRuns = runs.concat(activeRuns);

        return {
          id: provider.id,
          label: provider.label,
          available: provider.available !== false,
          quotaAvailable: false,
          quotaReason: "Provider quota is not exposed by the installed CLI; bars show Remote Vibes local activity.",
          sessionCount: sessionsForProvider.length,
          runningSessionCount: sessionsForProvider.filter((session) => session.status === "running").length,
          workingSessionCount: sessionsForProvider.filter((session) => session.activityStatus === "working").length,
          windows: PROVIDER_USAGE_WINDOWS.map((window) => summarizeProviderWindow(visibleRuns, window, now)),
        };
      });

    return {
      checkedAt: new Date(now).toISOString(),
      source: "remote-vibes-local",
      sourceLabel: "Remote Vibes local activity",
      quotaAvailable: false,
      quotaReason: "Claude Code and Codex do not expose remaining plan usage through their local CLIs.",
      providers: entries,
    };
  }
}
