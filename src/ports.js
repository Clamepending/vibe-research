import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PORT_PROBE_TIMEOUT_MS = 800;
const PORT_PROBE_CACHE_TTL_MS = Math.max(
  5_000,
  Number(process.env.VIBE_RESEARCH_PORT_PROBE_TTL_MS || process.env.REMOTE_VIBES_PORT_PROBE_TTL_MS || 60_000),
);
// Wall-clock budget for the listener-enumeration step (lsof / ss). On hosts
// with many open file descriptors lsof can take 30+ seconds; without a
// timeout, /api/state's listNamedPorts race fires its 1.5s fallback every
// page load and the sidebar shows an empty ports list. With this bound we
// fail fast and try the alternate tool.
const LISTENER_LIST_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.VIBE_RESEARCH_PORTS_LIST_TIMEOUT_MS || process.env.REMOTE_VIBES_PORTS_LIST_TIMEOUT_MS || 1_200),
);
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

// Parse `ss -tnlpH` output (Linux). ss is dramatically faster than lsof on
// hosts with many file descriptors because it reads /proc/net/tcp directly
// instead of rescanning every process. Format (one row per listener):
//
//   LISTEN 0 511 0.0.0.0:4826 0.0.0.0:* users:(("node",pid=4175126,fd=25))
//   LISTEN 0 4096 [::]:22 [::]:* users:(("sshd",pid=1234,fd=3))
//
// We parse the local-address column (4th whitespace-separated field, after
// State / Recv-Q / Send-Q) and the first (cmd,pid) tuple in the Process
// column when present. If `-H` was not honored, lines starting with "State"
// are skipped as headers.
export function parseSsOutput(output, excludePorts = []) {
  const excluded = new Set(excludePorts.map((port) => Number(port)));
  const ports = new Map();

  for (const rawLine of String(output || "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("State") || line.startsWith("Netid")) continue;
    // Tokens: State Recv-Q Send-Q LocalAddr PeerAddr [Process]
    const fields = line.split(/\s+/);
    if (fields.length < 4) continue;
    const state = fields[0];
    if (state.toUpperCase() !== "LISTEN") continue;
    const localAddr = fields[3];
    if (!localAddr) continue;

    // Local address can be "0.0.0.0:4826", "[::]:4826", "*:4826", or
    // "127.0.0.1:4826". Pull out the trailing :port.
    const portMatch = localAddr.match(/:(\d+)$/);
    if (!portMatch) continue;
    const port = parsePortNumber(portMatch[1]);
    if (!port || excluded.has(port)) continue;
    let host = localAddr.slice(0, localAddr.length - portMatch[0].length);
    if (!host || host === "*") host = "0.0.0.0";
    if (host === "[::]" || host === "::") host = "::";
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

    // Process column (everything after the 5th field) carries one or more
    // `users:(("cmd",pid=NNN,fd=NN))` tuples. Take the first cmd+pid we see.
    const processColumn = fields.slice(5).join(" ");
    const procMatch = processColumn.match(/\(\("([^"]+)",pid=(\d+)/);
    const command = procMatch ? procMatch[1] : "unknown";
    const pid = procMatch ? Number(procMatch[2]) || 0 : 0;

    const existing = ports.get(port) ?? {
      port,
      command,
      pid,
      hosts: new Set(),
      proxyPath: `/proxy/${port}/`,
    };
    existing.hosts.add(host);
    if (existing.command === "unknown" && command) existing.command = command;
    if (!existing.pid && pid) existing.pid = pid;
    ports.set(port, existing);
  }

  return Array.from(ports.values())
    .map((entry) => ({ ...entry, hosts: Array.from(entry.hosts).sort() }))
    .sort((left, right) => left.port - right.port);
}

async function execListenerCommand(command, args, timeoutMs) {
  // Wrap execFile with an AbortController-driven timeout. On miss we still
  // capture whatever stdout was produced so the parser can salvage partial
  // output (lsof on a busy host often emits most of its rows before SIGINT).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { stdout } = await execFileAsync(command, args, {
      signal: controller.signal,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, partial: false };
  } catch (error) {
    if (typeof error?.stdout === "string" && error.stdout.length > 0) {
      return { stdout: error.stdout, partial: true };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function tryRun(tool) {
  // Try each listener-enumeration tool in order. Return parsed ports + the
  // tool name on first success. The tool list is platform-aware: Linux
  // prefers ss (orders of magnitude faster); macOS doesn't ship ss so it
  // goes lsof-first.
  if (tool === "ss") {
    const { stdout, partial } = await execListenerCommand("ss", ["-tnlpH"], LISTENER_LIST_TIMEOUT_MS);
    return { tool: "ss", parser: parseSsOutput, stdout, partial };
  }
  const { stdout, partial } = await execListenerCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], LISTENER_LIST_TIMEOUT_MS);
  return { tool: "lsof", parser: parseLsofOutput, stdout, partial };
}

export async function listListeningPorts({ excludePorts = [] } = {}) {
  // Listener-tool fallback chain. On Linux, ss wins by ~100x on busy hosts
  // (ss reads /proc/net/tcp; lsof rescans every fd of every process). On
  // macOS, ss isn't installed so we try lsof first. Either way we ALSO try
  // the alternate tool if the first one times out or returns nothing — that
  // way a host with neither in $PATH still degrades gracefully (empty list)
  // rather than throwing. The whole step is bounded by LISTENER_LIST_TIMEOUT_MS.
  const order = process.platform === "linux" ? ["ss", "lsof"] : ["lsof", "ss"];
  let parsed = null;
  for (const tool of order) {
    try {
      const result = await tryRun(tool);
      const ports = result.parser(result.stdout, excludePorts);
      if (ports.length || !result.partial) {
        parsed = ports;
        break;
      }
      // partial output and zero ports parsed → try the alternate tool.
    } catch {
      // tool unavailable / aborted; try next.
    }
  }
  if (!parsed) return [];

  const probeResults = await Promise.all(
    parsed.map(async (entry) => ({
      entry,
      probe: await probePreviewablePort(entry.port),
    })),
  );
  return probeResults
    .filter(({ probe }) => probe.kind === "preview")
    .map(({ entry, probe }) => ({ ...entry, previewStatusCode: probe.statusCode }));
}

// Exposed for tests.
export const __internal = { parseLsofOutput, parseSsOutput };
