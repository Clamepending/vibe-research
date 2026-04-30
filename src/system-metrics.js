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
// Storage measurements run `du` over Library + project paths, which traverses
// every directory entry. On NFS-backed home dirs that's hundreds of ms even
// warm and seconds cold. The system tab polls every 30s; a 60s background
// sampler refills the cache. Cache TTL must comfortably exceed the sampler
// interval so UI polls always hit the cache instead of triggering a fresh du.
const DEFAULT_WIKI_STORAGE_CACHE_MS = 5 * 60_000;
const DEFAULT_WIKI_STORAGE_MAX_ENTRIES = 75_000;
const DEFAULT_PROJECT_STORAGE_CACHE_MS = 5 * 60_000;
const DEFAULT_PROJECT_STORAGE_MAX_ROOTS = 32;
const BYTES_PER_KIB = 1024;
const MAX_VISIBLE_VOLUMES = 8;
const LINUX_DRM_GPU_VENDORS = new Set(["0x10de", "0x1002", "0x8086"]);
const LINUX_DRM_IGNORED_GPU_VENDORS = new Set(["0x1a03", "0x1234", "0x1b36"]);
const wikiStorageCache = new Map();
const projectStorageCache = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeNumber(value) {
  const normalized = String(value ?? "").replace(/[^\d.-]/g, "");
  if (!normalized) {
    return null;
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizePid(value) {
  const pid = normalizeNumber(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
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
      const columns = line.split(",").map((value) => value.trim());
      const hasUuidColumn = /^GPU-/i.test(columns[1] || "");
      const [
        index,
        uuid,
        name,
        gpuUtilization,
        memoryUtilization,
        memoryUsedMb,
        memoryTotalMb,
        temperatureC,
        powerDrawW,
        powerLimitW,
      ] = hasUuidColumn
        ? columns
        : [columns[0], "", columns[1], ...columns.slice(2)];
      const gpuIndex = normalizeNumber(index);
      const stableId = uuid || String(index || "").trim();
      const memoryUsed = normalizeNumber(memoryUsedMb);
      const memoryTotal = normalizeNumber(memoryTotalMb);

      return {
        id: `nvidia-${stableId || name || "gpu"}`,
        index: gpuIndex,
        uuid: uuid || "",
        kind: "gpu",
        name: name || `NVIDIA GPU ${index}`,
        source: "nvidia-smi",
        utilizationPercent: normalizeNumber(gpuUtilization),
        memoryUtilizationPercent: normalizeNumber(memoryUtilization),
        memoryUsedBytes: memoryUsed === null ? null : memoryUsed * 1024 * 1024,
        memoryTotalBytes: memoryTotal === null ? null : memoryTotal * 1024 * 1024,
        temperatureC: normalizeNumber(temperatureC),
        powerW: normalizeNumber(powerDrawW),
        powerLimitW: normalizeNumber(powerLimitW),
      };
    });
}

function parseNvidiaComputeAppsCsv(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^no running processes/i.test(line))
    .map((line) => {
      const [gpuUuid, pidValue, processName, usedMemoryMb] = line.split(",").map((value) => value.trim());
      const pid = normalizePid(pidValue);
      const memoryUsed = normalizeNumber(usedMemoryMb);

      if (!pid) {
        return null;
      }

      return {
        gpuUuid: gpuUuid || "",
        pid,
        processName: processName || "",
        usedMemoryBytes: memoryUsed === null ? null : memoryUsed * 1024 * 1024,
      };
    })
    .filter(Boolean);
}

async function readNvidiaComputeApps({ execFile, timeoutMs }) {
  try {
    const { stdout } = await runCommand(
      execFile,
      "nvidia-smi",
      [
        "--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory",
        "--format=csv,noheader,nounits",
      ],
      { timeoutMs },
    );

    return parseNvidiaComputeAppsCsv(stdout);
  } catch {
    return [];
  }
}

function parseProcessTable(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => {
      // pid ppid user comm — user has no whitespace; comm captures the rest
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) {
        return null;
      }

      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        user: match[3],
        command: match[4].trim(),
      };
    })
    .filter(Boolean);
}

async function readProcessTable({ execFile, timeoutMs }) {
  try {
    const { stdout } = await runCommand(execFile, "ps", ["-eo", "pid=,ppid=,user=,comm="], { timeoutMs });
    return parseProcessTable(stdout);
  } catch {
    return [];
  }
}

function normalizeAgentProcessRoots(agentProcessRoots) {
  return (Array.isArray(agentProcessRoots) ? agentProcessRoots : [])
    .map((root) => {
      const pid = normalizePid(root?.pid);
      if (!pid) {
        return null;
      }

      return {
        pid,
        providerId: root?.providerId || "",
        sessionId: root?.sessionId || "",
        source: root?.source || "session",
      };
    })
    .filter(Boolean);
}

function createProcessOwnerResolver(processTable, agentProcessRoots) {
  const roots = normalizeAgentProcessRoots(agentProcessRoots);
  const rootByPid = new Map(roots.map((root) => [root.pid, root]));
  const parentByPid = new Map(
    (Array.isArray(processTable) ? processTable : [])
      .filter((entry) => normalizePid(entry?.pid) && normalizePid(entry?.ppid))
      .map((entry) => [Number(entry.pid), Number(entry.ppid)]),
  );

  return (pidValue) => {
    let pid = normalizePid(pidValue);
    const seen = new Set();

    while (pid && !seen.has(pid)) {
      const root = rootByPid.get(pid);
      if (root) {
        return root;
      }

      seen.add(pid);
      pid = parentByPid.get(pid);
    }

    return null;
  };
}

function annotateNvidiaGpuProcesses({
  agentProcessRoots = [],
  computeApps = [],
  nvidiaGpus = [],
  processTable = [],
  selfUsername = "",
}) {
  if (!nvidiaGpus.length) {
    return [];
  }

  const resolveOwner = createProcessOwnerResolver(processTable, agentProcessRoots);
  const userByPid = new Map(
    (Array.isArray(processTable) ? processTable : [])
      .map((entry) => {
        const pid = normalizePid(entry?.pid);
        if (!pid || !entry?.user) return null;
        return [pid, String(entry.user)];
      })
      .filter(Boolean),
  );
  const processesByGpuUuid = new Map();

  for (const app of computeApps) {
    if (!app.gpuUuid) {
      continue;
    }

    const owner = resolveOwner(app.pid);
    const ownerUser = userByPid.get(Number(app.pid)) || "";
    // "Foreign" = a different OS user. We trust UID-level ownership: if the
    // process owner != the server's user, it's not us — even if vibe-research
    // never spawned it. Empty selfUsername disables the check (used by tests
    // that don't care about cross-user policy).
    const ownedByOtherUser =
      Boolean(selfUsername) && Boolean(ownerUser) && ownerUser !== selfUsername;
    const process = {
      ...app,
      ownedByUs: Boolean(owner),
      ownerUser,
      ownedByOtherUser,
      providerId: owner?.providerId || "",
      sessionId: owner?.sessionId || "",
    };
    const entries = processesByGpuUuid.get(app.gpuUuid) || [];
    entries.push(process);
    processesByGpuUuid.set(app.gpuUuid, entries);
  }

  return nvidiaGpus.map((gpu) => {
    const processes = gpu.uuid ? processesByGpuUuid.get(gpu.uuid) || [] : [];
    const ownedProcessCount = processes.filter((process) => process.ownedByUs).length;
    const otherUsers = [
      ...new Set(
        processes
          .filter((process) => process.ownedByOtherUser)
          .map((process) => process.ownerUser),
      ),
    ];

    return {
      ...gpu,
      activeProcessCount: processes.length,
      ownedProcessCount,
      processes: processes.slice(0, 8),
      usedByUs: ownedProcessCount > 0,
      usedByOtherUser: otherUsers.length > 0,
      otherUsers,
    };
  });
}

async function readNvidiaGpus({ agentProcessRoots = [], execFile, selfUsername = "", timeoutMs }) {
  try {
    const { stdout } = await runCommand(
      execFile,
      "nvidia-smi",
      [
        "--query-gpu=index,uuid,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
        "--format=csv,noheader,nounits",
      ],
      { timeoutMs },
    );

    const nvidiaGpus = parseNvidiaCsv(stdout);
    const computeApps = await readNvidiaComputeApps({ execFile, timeoutMs });
    // We need the process table whenever there are compute apps so we can map
    // each pid to its owning user (for usedByOtherUser). Previously this only
    // ran when vibe-research had session-spawned process roots to credit.
    const processTable = computeApps.length
      ? await readProcessTable({ execFile, timeoutMs })
      : [];

    return annotateNvidiaGpuProcesses({
      agentProcessRoots,
      computeApps,
      nvidiaGpus,
      processTable,
      selfUsername,
    });
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

function normalizeLinuxVendorId(vendor) {
  const normalized = String(vendor || "").trim().toLowerCase();
  return normalized.startsWith("0x") ? normalized : "";
}

function parseLinuxDeviceUevent(uevent) {
  return {
    driver: String(uevent || "").match(/^DRIVER=(.+)$/m)?.[1] || "",
    pciId: String(uevent || "").match(/^PCI_ID=(.+)$/m)?.[1] || "",
  };
}

function isUsefulLinuxDrmGpu({ busy, uevent, vendor }) {
  const normalizedVendor = normalizeLinuxVendorId(vendor);
  if (LINUX_DRM_IGNORED_GPU_VENDORS.has(normalizedVendor)) {
    return false;
  }

  if (LINUX_DRM_GPU_VENDORS.has(normalizedVendor)) {
    return true;
  }

  if (normalizedVendor) {
    return false;
  }

  return busy !== null && /^DRIVER=(amdgpu|i915|xe|nouveau|nvidia)$/im.test(String(uevent || ""));
}

function isNvidiaLinuxDrmGpu(device) {
  return (
    normalizeLinuxVendorId(device?.vendor) === "0x10de" ||
    /^10de:/i.test(String(device?.pciId || "")) ||
    /\b10de:/i.test(String(device?.name || ""))
  );
}

function mergeGpuDevices({ nvidiaGpus = [], linuxDrmGpus = [], macGpus = [] }) {
  const hasNvidiaSmi = nvidiaGpus.length > 0;
  const seenGpuIds = new Set();
  const devices = [
    ...nvidiaGpus,
    ...linuxDrmGpus.filter((device) => !(hasNvidiaSmi && isNvidiaLinuxDrmGpu(device))),
    ...macGpus,
  ];

  return devices.filter((device) => {
    const key = `${device.source}:${device.id}`;
    if (seenGpuIds.has(key)) {
      return false;
    }
    seenGpuIds.add(key);
    return true;
  });
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
    const deviceInfo = parseLinuxDeviceUevent(uevent);

    if (busy === null && !vendor && !uevent) {
      continue;
    }

    if (!isUsefulLinuxDrmGpu({ busy, uevent, vendor })) {
      continue;
    }

    devices.push({
      id: `drm-${card}`,
      kind: "gpu",
      name: parseLinuxDeviceName({ card, vendor, uevent }),
      source: "linux-drm-sysfs",
      utilizationPercent: busy,
      driver: deviceInfo.driver,
      pciId: deviceInfo.pciId,
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

async function readDevices({ agentProcessRoots, execFile, platform, readFile, readdir, selfUsername, timeoutMs }) {
  const [nvidiaGpus, linuxDrmGpus, macGpus, macAccelerators, linuxAccelerators] = await Promise.all([
    readNvidiaGpus({ agentProcessRoots, execFile, selfUsername, timeoutMs }),
    platform === "linux" ? readLinuxDrmGpus({ readFile, readdir }) : [],
    platform === "darwin" ? readMacGpus({ execFile, timeoutMs }) : [],
    platform === "darwin" ? readMacAccelerators({ execFile, timeoutMs }) : [],
    platform === "linux" ? readLinuxAccelerators({ readFile, readdir }) : [],
  ]);

  return {
    accelerators: [...macAccelerators, ...linuxAccelerators],
    gpus: mergeGpuDevices({ nvidiaGpus, linuxDrmGpus, macGpus }),
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
          error: error.message || "Could not read library folder.",
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

async function computeWikiStorageOnce({ execFile, lstat, maxEntries, readdir, rootPath, timeoutMs }) {
  let value;
  try {
    const { stdout } = await runCommand(execFile, "du", ["-sk", rootPath], { timeoutMs });
    const bytes = parseDuOutput(stdout);
    if (bytes === null) {
      throw new Error("du did not return a byte count");
    }
    value = {
      path: rootPath,
      exists: true,
      bytes,
      source: "du",
    };
  } catch (duError) {
    value = await readWikiStorageByWalking({ lstat, maxEntries, readdir, rootPath });
    if (value.exists && duError?.message) {
      value.warning = `du unavailable; used file walk (${duError.message})`;
    }
  }

  value.checkedAt = new Date().toISOString();
  return value;
}

async function computeProjectRootStorageOnce({ execFile, rootPath, timeoutMs }) {
  let value;
  try {
    const { stdout } = await runCommand(execFile, "du", ["-sk", rootPath], { timeoutMs });
    const bytes = parseDuOutput(stdout);
    if (bytes === null) {
      throw new Error("du did not return a byte count");
    }
    value = {
      path: rootPath,
      exists: true,
      bytes,
      source: "du",
    };
  } catch (error) {
    value = {
      path: rootPath,
      exists: false,
      bytes: 0,
      source: "du",
      error: error.message || "Could not measure project folder.",
    };
  }

  value.checkedAt = new Date().toISOString();
  return value;
}

// Stale-while-revalidate: serve the cached value (even if past the freshness
// window) and trigger a background refresh, deduping concurrent refreshes via
// the entry's `refreshing` promise. If no value has ever been computed for
// this key, return `pendingValue` and let the next poll surface the result.
function swrServe({ cache, key, cacheMs, computeOnce, pendingValue, now = Date.now() }) {
  const cached = cache?.get(key);

  if (cached?.value && now - cached.cachedAt < cacheMs) {
    return {
      ...cached.value,
      cacheAgeMs: now - cached.cachedAt,
    };
  }

  if (cache && !cached?.refreshing) {
    const refreshing = (async () => {
      try {
        const value = await computeOnce();
        cache.set(key, { cachedAt: Date.now(), value });
      } catch (error) {
        const entry = cache.get(key);
        if (entry) {
          cache.set(key, { ...entry, lastError: error?.message || String(error) });
        }
      } finally {
        const entry = cache.get(key);
        if (entry && entry.refreshing === refreshing) {
          cache.set(key, { ...entry, refreshing: undefined });
        }
      }
    })();
    cache.set(key, { ...(cached || { cachedAt: 0 }), refreshing });
  }

  if (cached?.value) {
    return {
      ...cached.value,
      cacheAgeMs: now - cached.cachedAt,
      refreshing: true,
    };
  }

  return pendingValue;
}

async function readWikiStorage({
  cache = wikiStorageCache,
  cacheMs = DEFAULT_WIKI_STORAGE_CACHE_MS,
  execFile,
  lstat,
  maxEntries = DEFAULT_WIKI_STORAGE_MAX_ENTRIES,
  readdir,
  rootPath,
  staleWhileRevalidate = false,
  timeoutMs,
}) {
  if (!rootPath) {
    return null;
  }

  const resolvedPath = path.resolve(rootPath);
  const computeArgs = { execFile, lstat, maxEntries, readdir, rootPath: resolvedPath, timeoutMs };

  if (staleWhileRevalidate) {
    return swrServe({
      cache,
      key: resolvedPath,
      cacheMs,
      computeOnce: () => computeWikiStorageOnce(computeArgs),
      pendingValue: {
        path: resolvedPath,
        exists: false,
        bytes: null,
        source: "computing",
        pending: true,
      },
    });
  }

  const now = Date.now();
  const cached = cache?.get(resolvedPath);
  if (cached?.value && now - cached.cachedAt < cacheMs) {
    return {
      ...cached.value,
      cacheAgeMs: now - cached.cachedAt,
    };
  }

  const value = await computeWikiStorageOnce(computeArgs);
  cache?.set(resolvedPath, { cachedAt: now, value });
  return value;
}

async function readProjectRootStorage({
  cache = projectStorageCache,
  cacheMs = DEFAULT_PROJECT_STORAGE_CACHE_MS,
  execFile,
  rootPath,
  staleWhileRevalidate = false,
  timeoutMs,
}) {
  const resolvedPath = normalizeStorageRootPath(rootPath);
  if (!resolvedPath) {
    return null;
  }

  const computeArgs = { execFile, rootPath: resolvedPath, timeoutMs };

  if (staleWhileRevalidate) {
    return swrServe({
      cache,
      key: resolvedPath,
      cacheMs,
      computeOnce: () => computeProjectRootStorageOnce(computeArgs),
      pendingValue: {
        path: resolvedPath,
        exists: false,
        bytes: null,
        source: "computing",
        pending: true,
      },
    });
  }

  const now = Date.now();
  const cached = cache?.get(resolvedPath);
  if (cached?.value && now - cached.cachedAt < cacheMs) {
    return {
      ...cached.value,
      cacheAgeMs: now - cached.cachedAt,
    };
  }

  const value = await computeProjectRootStorageOnce(computeArgs);
  cache?.set(resolvedPath, { cachedAt: now, value });
  return value;
}

async function readProjectStorage({
  cache = projectStorageCache,
  cacheMs = DEFAULT_PROJECT_STORAGE_CACHE_MS,
  execFile,
  maxRoots = DEFAULT_PROJECT_STORAGE_MAX_ROOTS,
  rootPaths = [],
  staleWhileRevalidate = false,
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
          staleWhileRevalidate,
          timeoutMs,
        }),
      ),
    )
  ).filter(Boolean);
  const existingEntries = entries.filter((entry) => entry.exists);
  const pendingEntries = entries.filter((entry) => entry.pending);
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
    source: pendingEntries.length === entries.length ? "computing" : "du",
    pending: pendingEntries.length > 0,
    pendingRootCount: pendingEntries.length,
    roots: entries,
    warnings,
  };
}

export async function collectSystemMetrics({
  agentProcessRoots = [],
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
  selfUsername = (() => {
    try {
      return os.userInfo().username || "";
    } catch {
      return "";
    }
  })(),
  staleWhileRevalidate = false,
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
    readDevices({ agentProcessRoots, execFile, platform, readFile, readdir, selfUsername, timeoutMs }),
    readWikiStorage({
      cache: wikiStorageCacheOverride,
      cacheMs: wikiStorageCacheMs,
      execFile,
      lstat,
      maxEntries: wikiStorageMaxEntries,
      readdir,
      rootPath: wikiPath,
      staleWhileRevalidate,
      timeoutMs,
    }),
    readProjectStorage({
      cache: projectStorageCacheOverride,
      cacheMs: projectStorageCacheMs,
      execFile,
      maxRoots: projectStorageMaxRoots,
      rootPaths: projectPaths,
      staleWhileRevalidate,
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
  parseNvidiaComputeAppsCsv,
  parseProcessTable,
  mergeGpuDevices,
  readLinuxDrmGpus,
};
