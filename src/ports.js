import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PORT_PROBE_TIMEOUT_MS = 800;
const PORT_PROBE_CACHE_TTL_MS = 5_000;
const portProbeCache = new Map();

function parsePortNumber(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

function parseLsofOutput(output, excludePorts = []) {
  const excluded = new Set(excludePorts.map((port) => Number(port)));
  const ports = new Map();

  for (const line of output.split("\n").slice(1)) {
    if (!line.includes(" TCP ") || !line.includes("(LISTEN)")) {
      continue;
    }

    const tcpIndex = line.indexOf(" TCP ");
    const prefix = line.slice(0, tcpIndex).trim();
    const suffix = line.slice(tcpIndex + 1).trim();
    const prefixParts = prefix.split(/\s+/);
    const command = prefixParts[0];
    const pid = Number(prefixParts[1] || 0);
    const match = suffix.match(/^TCP\s+(.+):(\d+)\s+\(LISTEN\)$/);

    if (!match) {
      continue;
    }

    const host = match[1] === "*" ? "0.0.0.0" : match[1];
    const port = parsePortNumber(match[2]);

    if (!port || excluded.has(port)) {
      continue;
    }

    const existing = ports.get(port) ?? {
      port,
      command,
      pid,
      hosts: new Set(),
      proxyPath: `/proxy/${port}/`,
    };

    existing.hosts.add(host);

    if (existing.command === "unknown" && command) {
      existing.command = command;
    }

    if (!existing.pid && pid) {
      existing.pid = pid;
    }

    ports.set(port, existing);
  }

  return Array.from(ports.values())
    .map((entry) => ({
      ...entry,
      hosts: Array.from(entry.hosts).sort(),
    }))
    .sort((left, right) => left.port - right.port);
}

function getCachedPortProbe(port) {
  const cached = portProbeCache.get(port);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.checkedAt > PORT_PROBE_CACHE_TTL_MS) {
    portProbeCache.delete(port);
    return null;
  }

  return cached.result;
}

function setCachedPortProbe(port, result) {
  portProbeCache.set(port, {
    checkedAt: Date.now(),
    result,
  });
}

async function probePreviewablePort(port) {
  const cached = getCachedPortProbe(port);
  if (cached) {
    return cached;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, PORT_PROBE_TIMEOUT_MS);

  let result;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
    });

    result = {
      kind: response.status === 401 || response.status === 403 ? "restricted" : "preview",
      statusCode: response.status,
    };
  } catch {
    result = {
      kind: "unavailable",
      statusCode: null,
    };
  } finally {
    clearTimeout(timeout);
  }

  setCachedPortProbe(port, result);
  return result;
}

export async function listListeningPorts({ excludePorts = [] } = {}) {
  try {
    const { stdout } = await execFileAsync(process.env.SHELL || "/bin/zsh", [
      "-lc",
      "lsof -nP -iTCP -sTCP:LISTEN",
    ]);
    const ports = parseLsofOutput(stdout, excludePorts);
    const probeResults = await Promise.all(
      ports.map(async (entry) => ({
        entry,
        probe: await probePreviewablePort(entry.port),
      })),
    );

    return probeResults
      .filter(({ probe }) => probe.kind === "preview")
      .map(({ entry, probe }) => ({
        ...entry,
        previewStatusCode: probe.statusCode,
      }));
  } catch (error) {
    if (typeof error.stdout === "string") {
      const ports = parseLsofOutput(error.stdout, excludePorts);
      const probeResults = await Promise.all(
        ports.map(async (entry) => ({
          entry,
          probe: await probePreviewablePort(entry.port),
        })),
      );

      return probeResults
        .filter(({ probe }) => probe.kind === "preview")
        .map(({ entry, probe }) => ({
          ...entry,
          previewStatusCode: probe.statusCode,
        }));
    }

    return [];
  }
}
