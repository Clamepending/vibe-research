import { execFile as execFileCallback } from "node:child_process";
import {
  lstat as lstatCallback,
  readdir as readdirCallback,
  readFile as readFileCallback,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_CPU_SAMPLE_MS = 140;
const DEFAULT_WIKI_STORAGE_CACHE_MS = 30_000;
const DEFAULT_WIKI_STORAGE_MAX_ENTRIES = 75_000;
const DEFAULT_PROJECT_STORAGE_CACHE_MS = 60_000;
const DEFAULT_PROJECT_STORAGE_MAX_ROOTS = 32;
const BYTES_PER_KIB = 1024;
const MAX_VISIBLE_VOLUMES = 8;
const wikiStorageCache = new Map();
const projectStorageCache = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeNumber(value) {
  const number = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runCommand(execFile, command, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return execFile(command, args, {
    maxBuffer: 1024 * 1024 * 8,
    timeout: timeoutMs,
  });
}

function parseDfOutput(stdout, platform = process.platform) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const match = line.match(/^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
      if (!match) {
        return null;
      }

      const totalBytes = Number(match[2]) * BYTES_PER_KIB;
      const reportedUsedBytes = Number(match[3]) * BYTES_PER_KIB;
      const availableBytes = Number(match[4]) * BYTES_PER_KIB;
      const usedBytes = Math.max(0, totalBytes - availableBytes);
      const usedPercent = totalBytes > 0 ? clamp((usedBytes / totalBytes) * 100, 0, 100) : 0;
      const capacityPercent = Number(match[5]);
      const mountPoint = match[6].trim();

      return {
        filesystem: match[1].trim(),
        mountPoint,
        name: getVolumeName(mountPoint, platform),
        totalBytes,
        usedBytes,
        reportedUsedBytes,
        availableBytes,
        usedPercent,
        capacityPercent,
      };
    })
    .filter(Boolean);
}

function getVolumeName(mountPoint, platform = process.platform) {
  if (platform === "darwin") {
    if (mountPoint === "/" || mountPoint === "/System/Volumes/Data") {
      return "Macintosh HD";
    }

    if (mountPoint.startsWith("/Volumes/")) {
      return path.basename(mountPoint);
    }
  }

  if (mountPoint === "/") {
    return platform === "darwin" ? "Macintosh HD" : "Root";
  }

  return path.basename(mountPoint) || mountPoint;
}

function isVisibleVolume(volume, primaryMountPoint) {
  if (!volume?.mountPoint) {
    return false;
  }

  return (
    volume.mountPoint === primaryMountPoint ||
    volume.mountPoint === "/" ||
    volume.mountPoint.startsWith("/Volumes/") ||
    volume.mountPoint.startsWith("/mnt/") ||
    volume.mountPoint.startsWith("/media/")
  );
}

function mergeVolumes(volumes) {
  const byMount = new Map();
  for (const volume of volumes) {
    if (!volume?.mountPoint) {
      continue;
    }
    byMount.set(volume.mountPoint, {
      ...byMount.get(volume.mountPoint),
      ...volume,
    });
  }
  return [...byMount.values()];
}

async function readStorage({ cwd, execFile, platform, timeoutMs }) {
  const warnings = [];
  let volumes = [];
  let primaryVolumes = [];

  try {
    const { stdout } = await runCommand(execFile, "df", ["-kP", "-l"], { timeoutMs });
    volumes = parseDfOutput(stdout, platform);
  } catch (error) {
    warnings.push(`Could not list local volumes: ${error.message || "df failed"}`);
    try {
      const { stdout } = await runCommand(execFile, "df", ["-kP"], { timeoutMs });
      volumes = parseDfOutput(stdout, platform);
    } catch (fallbackError) {
      warnings.push(`Could not list filesystems: ${fallbackError.message || "df failed"}`);
    }
  }

  try {
    const { stdout } = await runCommand(execFile, "df", ["-kP", cwd], { timeoutMs });
    primaryVolumes = parseDfOutput(stdout, platform);
  } catch (error) {
    warnings.push(`Could not read workspace volume: ${error.message || "df failed"}`);
  }

  const primary = primaryVolumes[0] || volumes.find((volume) => volume.mountPoint === "/") || volumes[0] || null;
  const mergedVolumes = mergeVolumes([...primaryVolumes, ...volumes])
    .filter((volume) => isVisibleVolume(volume, primary?.mountPoint))
    .sort((left, right) => {
      if (left.mountPoint === primary?.mountPoint) {
        return -1;
      }
      if (right.mountPoint === primary?.mountPoint) {
        return 1;
      }
      return left.mountPoint.localeCompare(right.mountPoint);
    })
    .slice(0, MAX_VISIBLE_VOLUMES);

  return {
    primary,
    volumes: mergedVolumes,
    warnings,
  };
}

function snapshotCpu(cpus) {
  return cpus.map((cpu, index) => {
    const times = cpu.times || {};
    const idle = Number(times.idle || 0);
    const total = Object.values(times).reduce((sum, value) => sum + Number(value || 0), 0);

    return {
      id: index,
      model: cpu.model || `CPU ${index + 1}`,
      speedMhz: Number(cpu.speed || 0),
      idle,
      total,
    };
  });
}

function calculateCpuUsage(before, after) {
  const cores = after.map((current, index) => {
    const previous = before[index] || current;
    const totalDelta = Math.max(0, current.total - previous.total);
    const idleDelta = Math.max(0, current.idle - previous.idle);
    const utilizationPercent = totalDelta > 0 ? clamp(((totalDelta - idleDelta) / totalDelta) * 100, 0, 100) : 0;

    return {
      id: current.id,
      label: `CPU ${current.id + 1}`,
      model: current.model,
      speedMhz: current.speedMhz,
      utilizationPercent,
    };
  });

  const totalDelta = after.reduce((sum, current, index) => {
    const previous = before[index] || current;
    return sum + Math.max(0, current.total - previous.total);
  }, 0);
  const idleDelta = after.reduce((sum, current, index) => {
    const previous = before[index] || current;
    return sum + Math.max(0, current.idle - previous.idle);
  }, 0);

  return {
    cores,
    utilizationPercent: totalDelta > 0 ? clamp(((totalDelta - idleDelta) / totalDelta) * 100, 0, 100) : 0,
  };
}

async function readCpu({ cpus, sampleMs }) {
  const first = snapshotCpu(cpus());
  await sleep(sampleMs);
  const second = snapshotCpu(cpus());
  const usage = calculateCpuUsage(first, second);
  const model = second.find((cpu) => cpu.model)?.model || "CPU";

  return {
    model,
    coreCount: second.length,
    loadAverage: os.loadavg(),
    utilizationPercent: usage.utilizationPercent,
    cores: usage.cores,
  };
}

function readMemory({ totalmem, freemem }) {
  const totalBytes = Number(totalmem() || 0);
  const freeBytes = Number(freemem() || 0);
  const usedBytes = Math.max(0, totalBytes - freeBytes);

  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: totalBytes > 0 ? clamp((usedBytes / totalBytes) * 100, 0, 100) : 0,
  };
}

function parseNvidiaCsv(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [
        index,
        name,
        gpuUtilization,
        memoryUtilization,
        memoryUsedMb,
        memoryTotalMb,
        temperatureC,
        powerDrawW,
        powerLimitW,
      ] = line.split(",").map((value) => value.trim());

      return {
        id: `nvidia-${index}`,
        kind: "gpu",
        name: name || `NVIDIA GPU ${index}`,
        source: "nvidia-smi",
        utilizationPercent: normalizeNumber(gpuUtilization),
        memoryUtilizationPercent: normalizeNumber(memoryUtilization),
        memoryUsedBytes:
          normalizeNumber(memoryUsedMb) === null ? null : normalizeNumber(memoryUsedMb) * 1024 * 1024,
        memoryTotalBytes:
          normalizeNumber(memoryTotalMb) === null ? null : normalizeNumber(memoryTotalMb) * 1024 * 1024,
        temperatureC: normalizeNumber(temperatureC),
        powerW: normalizeNumber(powerDrawW),
        powerLimitW: normalizeNumber(powerLimitW),
      };
    });
}

async function readNvidiaGpus({ execFile, timeoutMs }) {
  try {
    const { stdout } = await runCommand(
      execFile,
      "nvidia-smi",
      [
        "--query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
        "--format=csv,noheader,nounits",
      ],
      { timeoutMs },
    );

    return parseNvidiaCsv(stdout);
  } catch {
    return [];
  }
}

async function readTextFile(readFile, filePath) {
  try {
    return String(await readFile(filePath, "utf8")).trim();
  } catch {
    return "";
  }
}

function parseLinuxDeviceName({ card, vendor, uevent }) {
  const driver = uevent.match(/^DRIVER=(.+)$/m)?.[1];
  const pciId = uevent.match(/^PCI_ID=(.+)$/m)?.[1];
  const vendorName =
    vendor === "0x10de" ? "NVIDIA" : vendor === "0x1002" ? "AMD" : vendor === "0x8086" ? "Intel" : "";

  return [vendorName, driver, card, pciId].filter(Boolean).join(" ") || card;
}

async function readLinuxDrmGpus({ readFile, readdir }) {
  let cards = [];
  try {
    cards = await readdir("/sys/class/drm");
  } catch {
    return [];
  }

  const devices = [];
  for (const card of cards.filter((entry) => /^card\d+$/.test(entry))) {
    const deviceRoot = `/sys/class/drm/${card}/device`;
    const busy = normalizeNumber(await readTextFile(readFile, `${deviceRoot}/gpu_busy_percent`));
    const vendor = await readTextFile(readFile, `${deviceRoot}/vendor`);
    const uevent = await readTextFile(readFile, `${deviceRoot}/uevent`);

    if (busy === null && !vendor && !uevent) {
      continue;
    }

    devices.push({
      id: `drm-${card}`,
      kind: "gpu",
      name: parseLinuxDeviceName({ card, vendor, uevent }),
      source: "linux-drm-sysfs",
      utilizationPercent: busy,
      vendor: vendor || "",
    });
  }

  return devices;
}

function parseQuotedProperty(section, name) {
  return section.match(new RegExp(`"${name}"\\s*=\\s*"([^"]+)"`))?.[1] || "";
}

function parseNumberProperty(section, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return normalizeNumber(section.match(new RegExp(`"${escapedName}"\\s*=\\s*([\\d.]+)`))?.[1]);
}

function parseMacGpuIoreg(stdout) {
  return String(stdout ?? "")
    .split(/\n(?=\+-o )/)
    .filter((section) => section.includes("PerformanceStatistics"))
    .map((section, index) => {
      const name = parseQuotedProperty(section, "model") || parseQuotedProperty(section, "IONameMatched") || "Apple GPU";

      return {
        id: `apple-gpu-${index}`,
        kind: "gpu",
        name,
        source: "ioreg",
        utilizationPercent: parseNumberProperty(section, "Device Utilization %"),
        rendererUtilizationPercent: parseNumberProperty(section, "Renderer Utilization %"),
        tilerUtilizationPercent: parseNumberProperty(section, "Tiler Utilization %"),
        memoryUsedBytes: parseNumberProperty(section, "In use system memory"),
        memoryTotalBytes: parseNumberProperty(section, "Alloc system memory"),
        cores: parseNumberProperty(section, "gpu-core-count"),
      };
    });
}

async function readMacGpus({ execFile, timeoutMs }) {
  try {
    const { stdout } = await runCommand(execFile, "ioreg", ["-r", "-c", "AGXAccelerator", "-d", "1"], {
      timeoutMs,
    });
    const gpus = parseMacGpuIoreg(stdout);
    if (gpus.length) {
      return gpus;
    }
  } catch {
    // Fall through to system_profiler discovery below.
  }

  try {
    const { stdout } = await runCommand(execFile, "system_profiler", ["SPDisplaysDataType", "-json"], {
      timeoutMs,
    });
    const payload = JSON.parse(stdout);
    return (payload.SPDisplaysDataType || []).map((entry, index) => ({
      id: `apple-display-gpu-${index}`,
      kind: "gpu",
      name: entry.sppci_model || entry._name || "Apple GPU",
      source: "system_profiler",
      utilizationPercent: null,
      cores: normalizeNumber(entry.sppci_cores),
    }));
  } catch {
    return [];
  }
}

function parseMacAneIoreg(stdout) {
  return String(stdout ?? "")
    .split(/\n(?=\+-o )/)
    .filter((section) => section.includes("H11ANE") || section.includes("ANEHAL"))
    .map((section, index) => ({
      id: `apple-ane-${index}`,
      kind: "accelerator",
      name: "Apple Neural Engine",
      source: "ioreg",
      utilizationPercent: null,
      cores: parseNumberProperty(section, "ANEDevicePropertyNumANECores"),
      architecture: parseQuotedProperty(section, "ANEDevicePropertyTypeANEArchitectureTypeStr"),
      details: "utilization not exposed without privileged powermetrics",
    }));
}

async function readMacAccelerators({ execFile, timeoutMs }) {
  try {
    const { stdout } = await runCommand(execFile, "ioreg", ["-r", "-c", "H11ANEIn", "-d", "1"], {
      timeoutMs,
    });
    return parseMacAneIoreg(stdout);
  } catch {
    return [];
  }
}

async function readLinuxAccelerators({ readFile, readdir }) {
  let entries = [];
  try {
    entries = await readdir("/sys/class/accel");
  } catch {
    return [];
  }

  return Promise.all(
    entries.map(async (entry) => {
      const deviceRoot = `/sys/class/accel/${entry}/device`;
      const vendor = await readTextFile(readFile, `${deviceRoot}/vendor`);
      const uevent = await readTextFile(readFile, `${deviceRoot}/uevent`);
      const driver = uevent.match(/^DRIVER=(.+)$/m)?.[1] || "";

      return {
        id: `accel-${entry}`,
        kind: "accelerator",
        name: [driver, entry].filter(Boolean).join(" ") || entry,
        source: "linux-accel-sysfs",
        utilizationPercent: null,
        vendor,
      };
    }),
  );
}

async function readDevices({ execFile, platform, readFile, readdir, timeoutMs }) {
  const [nvidiaGpus, linuxDrmGpus, macGpus, macAccelerators, linuxAccelerators] = await Promise.all([
    readNvidiaGpus({ execFile, timeoutMs }),
    platform === "linux" ? readLinuxDrmGpus({ readFile, readdir }) : [],
    platform === "darwin" ? readMacGpus({ execFile, timeoutMs }) : [],
    platform === "darwin" ? readMacAccelerators({ execFile, timeoutMs }) : [],
    platform === "linux" ? readLinuxAccelerators({ readFile, readdir }) : [],
  ]);

  const seenGpuIds = new Set();
  const gpus = [...nvidiaGpus, ...linuxDrmGpus, ...macGpus].filter((device) => {
    const key = `${device.source}:${device.id}`;
    if (seenGpuIds.has(key)) {
      return false;
    }
    seenGpuIds.add(key);
    return true;
  });

  return {
    accelerators: [...macAccelerators, ...linuxAccelerators],
    gpus,
  };
}

function parseDuOutput(stdout) {
  const firstColumn = String(stdout ?? "").trim().split(/\s+/)[0];
  if (!/\d/.test(firstColumn || "")) {
    return null;
  }
  const kib = normalizeNumber(firstColumn);
  return kib === null ? null : kib * BYTES_PER_KIB;
}

function getDirentName(entry) {
  return typeof entry === "string" ? entry : entry?.name;
}

function normalizeStorageRootPath(rootPath) {
  const rawPath = String(rootPath || "").trim();
  if (!rawPath) {
    return "";
  }

  const resolvedPath = path.resolve(rawPath);
  const root = path.parse(resolvedPath).root;
  const trimmed = resolvedPath.replace(/[\\/]+$/, "");
  return trimmed || root;
}

function isSameOrNestedStoragePath(candidatePath, rootPath) {
  const candidate = normalizeStorageRootPath(candidatePath);
  const root = normalizeStorageRootPath(rootPath);

  if (!candidate || !root) {
    return false;
  }

  if (candidate === root) {
    return true;
  }

  const rootPrefix = path.parse(root).root;
  return root === rootPrefix ? candidate.startsWith(root) : candidate.startsWith(`${root}${path.sep}`);
}

function dedupeNestedStorageRoots(rootPaths) {
  const roots = Array.from(
    new Set((Array.isArray(rootPaths) ? rootPaths : []).map(normalizeStorageRootPath).filter(Boolean)),
  ).sort((left, right) => left.length - right.length || left.localeCompare(right));

  const deduped = [];
  for (const root of roots) {
    if (!deduped.some((parent) => isSameOrNestedStoragePath(root, parent))) {
      deduped.push(root);
    }
  }

  return deduped;
}

async function readWikiStorageByWalking({
  lstat,
  maxEntries = DEFAULT_WIKI_STORAGE_MAX_ENTRIES,
  readdir,
  rootPath,
}) {
  const stack = [rootPath];
  let bytes = 0;
  let directoryCount = 0;
  let entryCount = 0;
  let fileCount = 0;
  let skippedEntries = 0;
  let truncated = false;

  while (stack.length) {
    if (entryCount >= maxEntries) {
      truncated = true;
      break;
    }

    const currentPath = stack.pop();
    let stats;
    try {
      stats = await lstat(currentPath);
    } catch (error) {
      if (currentPath === rootPath) {
        return {
          path: rootPath,
          exists: false,
          bytes: 0,
          fileCount: 0,
          directoryCount: 0,
          entryCount: 0,
          skippedEntries: 0,
          truncated: false,
          source: "walk",
          error: error.message || "Could not read knowledge base folder.",
        };
      }
      skippedEntries += 1;
      continue;
    }

    entryCount += 1;
    bytes += Math.max(0, Number(stats.size || 0));

    if (typeof stats.isDirectory === "function" && stats.isDirectory()) {
      directoryCount += 1;
      let entries = [];
      try {
        entries = await readdir(currentPath, { withFileTypes: true });
      } catch {
        skippedEntries += 1;
        continue;
      }

      for (const entry of entries) {
        const name = getDirentName(entry);
        if (!name) {
          continue;
        }
        stack.push(path.join(currentPath, name));
      }
    } else {
      fileCount += 1;
    }
  }

  return {
    path: rootPath,
    exists: true,
    bytes,
    fileCount,
    directoryCount,
    entryCount,
    skippedEntries,
    truncated,
    source: "walk",
  };
}

async function readWikiStorage({
  cache = wikiStorageCache,
  cacheMs = DEFAULT_WIKI_STORAGE_CACHE_MS,
  execFile,
  lstat,
  maxEntries = DEFAULT_WIKI_STORAGE_MAX_ENTRIES,
  readdir,
  rootPath,
  timeoutMs,
}) {
  if (!rootPath) {
    return null;
  }

  const resolvedPath = path.resolve(rootPath);
  const now = Date.now();
  const cached = cache?.get(resolvedPath);
  if (cached && now - cached.cachedAt < cacheMs) {
    return {
      ...cached.value,
      cacheAgeMs: now - cached.cachedAt,
    };
  }

  let value;
  try {
    const { stdout } = await runCommand(execFile, "du", ["-sk", resolvedPath], { timeoutMs });
    const bytes = parseDuOutput(stdout);
    if (bytes === null) {
      throw new Error("du did not return a byte count");
    }
    value = {
      path: resolvedPath,
      exists: true,
      bytes,
      source: "du",
    };
  } catch (duError) {
    value = await readWikiStorageByWalking({ lstat, maxEntries, readdir, rootPath: resolvedPath });
    if (value.exists && duError?.message) {
      value.warning = `du unavailable; used file walk (${duError.message})`;
    }
  }

  value.checkedAt = new Date(now).toISOString();
  cache?.set(resolvedPath, {
    cachedAt: now,
    value,
  });

  return value;
}

async function readProjectRootStorage({
  cache = projectStorageCache,
  cacheMs = DEFAULT_PROJECT_STORAGE_CACHE_MS,
  execFile,
  rootPath,
  timeoutMs,
}) {
  const resolvedPath = normalizeStorageRootPath(rootPath);
  if (!resolvedPath) {
    return null;
  }

  const now = Date.now();
  const cached = cache?.get(resolvedPath);
  if (cached && now - cached.cachedAt < cacheMs) {
    return {
      ...cached.value,
      cacheAgeMs: now - cached.cachedAt,
    };
  }

  let value;
  try {
    const { stdout } = await runCommand(execFile, "du", ["-sk", resolvedPath], { timeoutMs });
    const bytes = parseDuOutput(stdout);
    if (bytes === null) {
      throw new Error("du did not return a byte count");
    }
    value = {
      path: resolvedPath,
      exists: true,
      bytes,
      source: "du",
    };
  } catch (error) {
    value = {
      path: resolvedPath,
      exists: false,
      bytes: 0,
      source: "du",
      error: error.message || "Could not measure project folder.",
    };
  }

  value.checkedAt = new Date(now).toISOString();
  cache?.set(resolvedPath, {
    cachedAt: now,
    value,
  });

  return value;
}

async function readProjectStorage({
  cache = projectStorageCache,
  cacheMs = DEFAULT_PROJECT_STORAGE_CACHE_MS,
  execFile,
  maxRoots = DEFAULT_PROJECT_STORAGE_MAX_ROOTS,
  rootPaths = [],
  timeoutMs,
}) {
  const roots = dedupeNestedStorageRoots(rootPaths);
  if (!roots.length) {
    return null;
  }

  const measuredRoots = roots.slice(0, Math.max(1, Number(maxRoots) || DEFAULT_PROJECT_STORAGE_MAX_ROOTS));
  const entries = (
    await Promise.all(
      measuredRoots.map((rootPath) =>
        readProjectRootStorage({
          cache,
          cacheMs,
          execFile,
          rootPath,
          timeoutMs,
        }),
      ),
    )
  ).filter(Boolean);
  const existingEntries = entries.filter((entry) => entry.exists);
  const warnings = entries
    .filter((entry) => entry.error)
    .map((entry) => `${entry.path}: ${entry.error}`)
    .slice(0, 4);

  return {
    exists: existingEntries.length > 0,
    bytes: existingEntries.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0),
    paths: existingEntries.map((entry) => entry.path),
    rootCount: existingEntries.length,
    measuredRootCount: measuredRoots.length,
    totalRootCount: roots.length,
    truncated: roots.length > measuredRoots.length,
    source: "du",
    roots: entries,
    warnings,
  };
}

export async function collectSystemMetrics({
  cwd = process.cwd(),
  cpus = os.cpus,
  execFile = execFileAsync,
  freemem = os.freemem,
  lstat = lstatCallback,
  platform = process.platform,
  readFile = readFileCallback,
  readdir = readdirCallback,
  sampleMs = DEFAULT_CPU_SAMPLE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  totalmem = os.totalmem,
  projectPaths = [],
  projectStorageCache: projectStorageCacheOverride = projectStorageCache,
  projectStorageCacheMs = DEFAULT_PROJECT_STORAGE_CACHE_MS,
  projectStorageMaxRoots = DEFAULT_PROJECT_STORAGE_MAX_ROOTS,
  wikiPath = "",
  wikiStorageCache: wikiStorageCacheOverride = wikiStorageCache,
  wikiStorageCacheMs = DEFAULT_WIKI_STORAGE_CACHE_MS,
  wikiStorageMaxEntries = DEFAULT_WIKI_STORAGE_MAX_ENTRIES,
} = {}) {
  const checkedAt = new Date().toISOString();
  const [storage, cpu, memory, devices, wikiStorage, projectStorage] = await Promise.all([
    readStorage({ cwd, execFile, platform, timeoutMs }),
    readCpu({ cpus, sampleMs }),
    Promise.resolve(readMemory({ totalmem, freemem })),
    readDevices({ execFile, platform, readFile, readdir, timeoutMs }),
    readWikiStorage({
      cache: wikiStorageCacheOverride,
      cacheMs: wikiStorageCacheMs,
      execFile,
      lstat,
      maxEntries: wikiStorageMaxEntries,
      readdir,
      rootPath: wikiPath,
      timeoutMs,
    }),
    readProjectStorage({
      cache: projectStorageCacheOverride,
      cacheMs: projectStorageCacheMs,
      execFile,
      maxRoots: projectStorageMaxRoots,
      rootPaths: projectPaths,
      timeoutMs,
    }),
  ]);

  return {
    checkedAt,
    hostname: os.hostname(),
    platform,
    uptimeSeconds: os.uptime(),
    storage,
    wikiStorage,
    projectStorage,
    cpu,
    memory,
    gpus: devices.gpus,
    accelerators: devices.accelerators,
    warnings: [
      ...storage.warnings,
      ...(projectStorage?.warnings || []).map((warning) => `Project storage: ${warning}`),
    ],
  };
}

export const testInternals = {
  parseDfOutput,
  dedupeNestedStorageRoots,
  parseMacAneIoreg,
  parseMacGpuIoreg,
  parseNvidiaCsv,
};
