import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const HISTORY_FILENAME = "system-metrics-history.json";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RANGE_WINDOWS_MS = {
  "1h": HOUR_MS,
  "1d": DAY_MS,
  "1w": 7 * DAY_MS,
};
const DEFAULT_RETENTION_MS = RANGE_WINDOWS_MS["1w"];
const DEFAULT_MIN_SAMPLE_INTERVAL_MS = 10_000;
const DEFAULT_MAX_API_SAMPLES = 720;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finitePercent(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.min(100, Math.max(0, number));
}

function timestampMsFrom(value, fallback = Date.now()) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function normalizeRange(range) {
  return RANGE_WINDOWS_MS[range] ? range : "1h";
}

function compactStoragePrimary(primary) {
  if (!primary) {
    return null;
  }

  return {
    name: primary.name || "Disk",
    mountPoint: primary.mountPoint || "",
    totalBytes: finiteNumber(primary.totalBytes),
    usedBytes: finiteNumber(primary.usedBytes),
    availableBytes: finiteNumber(primary.availableBytes),
    usedPercent: finitePercent(primary.usedPercent ?? primary.capacityPercent),
  };
}

function compactWikiStorage(wikiStorage) {
  if (!wikiStorage) {
    return null;
  }

  return {
    path: wikiStorage.path || "",
    exists: wikiStorage.exists !== false,
    bytes: finiteNumber(wikiStorage.bytes),
  };
}

function compactProjectStorage(projectStorage) {
  if (!projectStorage) {
    return null;
  }

  return {
    exists: projectStorage.exists !== false,
    bytes: finiteNumber(projectStorage.bytes),
    rootCount: finiteNumber(projectStorage.rootCount),
    measuredRootCount: finiteNumber(projectStorage.measuredRootCount),
    totalRootCount: finiteNumber(projectStorage.totalRootCount),
    truncated: Boolean(projectStorage.truncated),
  };
}

function compactCpu(cpu) {
  return {
    utilizationPercent: finitePercent(cpu?.utilizationPercent),
    cores: (Array.isArray(cpu?.cores) ? cpu.cores : []).map((core, index) => ({
      id: String(core?.id ?? index),
      label: core?.label || `CPU ${index + 1}`,
      utilizationPercent: finitePercent(core?.utilizationPercent),
    })),
  };
}

function compactMemory(memory) {
  if (!memory) {
    return null;
  }

  return {
    totalBytes: finiteNumber(memory.totalBytes),
    usedBytes: finiteNumber(memory.usedBytes),
    freeBytes: finiteNumber(memory.freeBytes),
    usedPercent: finitePercent(memory.usedPercent),
  };
}

function compactGpu(gpu, index) {
  return {
    id: String(gpu?.id || `gpu-${index}`),
    name: gpu?.name || `GPU ${index + 1}`,
    utilizationPercent: finitePercent(gpu?.utilizationPercent),
    memoryUsedBytes: finiteNumber(gpu?.memoryUsedBytes),
    memoryTotalBytes: finiteNumber(gpu?.memoryTotalBytes),
    temperatureC: finiteNumber(gpu?.temperatureC),
    powerDrawWatts: finiteNumber(gpu?.powerDrawWatts),
  };
}

function compactAccelerator(accelerator, index) {
  return {
    id: String(accelerator?.id || `accelerator-${index}`),
    name: accelerator?.name || `Accelerator ${index + 1}`,
    utilizationPercent: finitePercent(accelerator?.utilizationPercent),
  };
}

export function createSystemMetricsHistorySample(system, { now = Date.now() } = {}) {
  if (!system) {
    return null;
  }

  const timestampMs = timestampMsFrom(system.checkedAt, now);
  const checkedAt = new Date(timestampMs).toISOString();

  return {
    checkedAt,
    timestampMs,
    storage: {
      primary: compactStoragePrimary(system.storage?.primary),
    },
    wikiStorage: compactWikiStorage(system.wikiStorage),
    projectStorage: compactProjectStorage(system.projectStorage),
    cpu: compactCpu(system.cpu),
    memory: compactMemory(system.memory),
    gpus: (Array.isArray(system.gpus) ? system.gpus : []).map((gpu, index) => compactGpu(gpu, index)),
    accelerators: (Array.isArray(system.accelerators) ? system.accelerators : []).map((accelerator, index) =>
      compactAccelerator(accelerator, index),
    ),
  };
}

function normalizeSample(sample) {
  const timestampMs = timestampMsFrom(sample?.checkedAt, finiteNumber(sample?.timestampMs) ?? Date.now());
  const checkedAt = new Date(timestampMs).toISOString();

  return {
    checkedAt,
    timestampMs,
    storage: {
      primary: compactStoragePrimary(sample?.storage?.primary),
    },
    wikiStorage: compactWikiStorage(sample?.wikiStorage),
    projectStorage: compactProjectStorage(sample?.projectStorage),
    cpu: compactCpu(sample?.cpu),
    memory: compactMemory(sample?.memory),
    gpus: (Array.isArray(sample?.gpus) ? sample.gpus : []).map((gpu, index) => compactGpu(gpu, index)),
    accelerators: (Array.isArray(sample?.accelerators) ? sample.accelerators : []).map((accelerator, index) =>
      compactAccelerator(accelerator, index),
    ),
  };
}

function downsampleSamples(samples, maxSamples) {
  if (!Number.isFinite(maxSamples) || maxSamples <= 0 || samples.length <= maxSamples) {
    return samples;
  }

  const firstTimestamp = samples[0]?.timestampMs ?? 0;
  const lastTimestamp = samples.at(-1)?.timestampMs ?? firstTimestamp;
  const spanMs = Math.max(1, lastTimestamp - firstTimestamp);
  const bucketMs = spanMs / maxSamples;
  const buckets = new Map();

  for (const sample of samples) {
    const bucketIndex = Math.min(maxSamples - 1, Math.floor((sample.timestampMs - firstTimestamp) / bucketMs));
    buckets.set(bucketIndex, sample);
  }

  return [...buckets.keys()]
    .sort((left, right) => left - right)
    .map((bucketIndex) => buckets.get(bucketIndex))
    .filter(Boolean);
}

export class SystemMetricsHistoryStore {
  constructor({
    maxApiSamples = DEFAULT_MAX_API_SAMPLES,
    minSampleIntervalMs = DEFAULT_MIN_SAMPLE_INTERVAL_MS,
    now = () => Date.now(),
    retentionMs = DEFAULT_RETENTION_MS,
    stateDir,
  } = {}) {
    if (!stateDir) {
      throw new Error("SystemMetricsHistoryStore requires stateDir.");
    }

    this.filePath = path.join(stateDir, HISTORY_FILENAME);
    this.maxApiSamples = maxApiSamples;
    this.minSampleIntervalMs = minSampleIntervalMs;
    this.now = now;
    this.retentionMs = retentionMs;
    this.samples = [];
  }

  async initialize() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      const samples = Array.isArray(parsed?.samples) ? parsed.samples : [];
      this.samples = samples
        .map((sample) => normalizeSample(sample))
        .filter((sample) => Number.isFinite(sample.timestampMs))
        .sort((left, right) => left.timestampMs - right.timestampMs);
      this.prune();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.samples = [];
      }
    }
  }

  prune(now = this.now()) {
    const cutoff = now - this.retentionMs;
    this.samples = this.samples.filter((sample) => sample.timestampMs >= cutoff);
  }

  async save() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(
      tempPath,
      `${JSON.stringify({ version: 1, savedAt: new Date(this.now()).toISOString(), samples: this.samples }, null, 2)}\n`,
      "utf8",
    );
    await rename(tempPath, this.filePath);
  }

  async record(system, { force = false, minIntervalMs = this.minSampleIntervalMs } = {}) {
    const sample = createSystemMetricsHistorySample(system, { now: this.now() });
    if (!sample) {
      return null;
    }

    const lastSample = this.samples.at(-1);
    const existingIndex = this.samples.findIndex((entry) => entry.timestampMs === sample.timestampMs);
    if (existingIndex >= 0) {
      this.samples[existingIndex] = sample;
      this.samples.sort((left, right) => left.timestampMs - right.timestampMs);
      this.prune();
      await this.save();
      return sample;
    }

    if (
      !force
      && lastSample
      && Number.isFinite(minIntervalMs)
      && minIntervalMs > 0
      && sample.timestampMs - lastSample.timestampMs < minIntervalMs
    ) {
      return lastSample;
    }

    this.samples.push(sample);
    this.samples.sort((left, right) => left.timestampMs - right.timestampMs);
    this.prune();
    await this.save();
    return sample;
  }

  getHistory(range = "1h", { maxSamples = this.maxApiSamples, now = this.now() } = {}) {
    const normalizedRange = normalizeRange(range);
    const windowMs = RANGE_WINDOWS_MS[normalizedRange];
    const fromMs = now - windowMs;
    const rawSamples = this.samples.filter((sample) => sample.timestampMs >= fromMs && sample.timestampMs <= now);
    const samples = downsampleSamples(rawSamples, maxSamples);

    return {
      range: normalizedRange,
      windowMs,
      from: new Date(fromMs).toISOString(),
      to: new Date(now).toISOString(),
      sampleCount: samples.length,
      rawSampleCount: rawSamples.length,
      maxSamples,
      minSampleIntervalMs: this.minSampleIntervalMs,
      samples,
    };
  }
}

export const testInternals = {
  downsampleSamples,
  normalizeRange,
};
