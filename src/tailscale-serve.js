import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STATUS_CACHE_TTL_MS = 2_000;

export function normalizeTailscaleServePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

function getErrorMessage(error) {
  return String(error?.stderr || error?.stdout || error?.message || error || "Unknown error").trim();
}

function parseStatusConfig(payload) {
  if (!payload) {
    return {};
  }

  if (typeof payload === "string") {
    return JSON.parse(payload || "{}");
  }

  if (typeof payload === "object") {
    return payload;
  }

  return {};
}

function mentionsPort(value, port) {
  const text = String(value);
  const portPattern = new RegExp(`(^|[^0-9])${port}([^0-9]|$)`);

  return portPattern.test(text);
}

function containsServePort(value, port, seen = new Set()) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "number") {
    return value === port;
  }

  if (typeof value === "string") {
    return mentionsPort(value, port);
  }

  if (typeof value !== "object") {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((entry) => containsServePort(entry, port, seen));
  }

  return Object.entries(value).some(
    ([key, entry]) => mentionsPort(key, port) || containsServePort(entry, port, seen),
  );
}

export function parseTailscaleServeStatus(payload, port) {
  const normalizedPort = normalizeTailscaleServePort(port);

  try {
    const config = parseStatusConfig(payload);

    return {
      available: true,
      config,
      enabled: normalizedPort ? containsServePort(config, normalizedPort) : false,
      port: normalizedPort,
    };
  } catch (error) {
    return {
      available: false,
      config: null,
      enabled: false,
      port: normalizedPort,
      reason: `Could not parse Tailscale Serve status: ${error.message}`,
    };
  }
}

function isUnknownYesFlagError(error) {
  return /flag provided but not defined: -yes|unknown flag: --yes/i.test(getErrorMessage(error));
}

export class TailscaleServeManager {
  constructor({
    command = "tailscale",
    execFile: execFileRunner = execFileAsync,
    cacheTtlMs = STATUS_CACHE_TTL_MS,
  } = {}) {
    this.cacheTtlMs = cacheTtlMs;
    this.command = command;
    this.execFile = execFileRunner;
    this.statusCache = null;
  }

  async getStatus({ refresh = false } = {}) {
    if (
      !refresh &&
      this.statusCache &&
      Date.now() - this.statusCache.checkedAt < this.cacheTtlMs
    ) {
      return this.statusCache.status;
    }

    let status;

    try {
      const { stdout = "" } = await this.execFile(this.command, ["serve", "status", "--json"]);
      status = parseTailscaleServeStatus(stdout);
    } catch (error) {
      status = {
        available: false,
        config: null,
        enabled: false,
        reason: getErrorMessage(error),
      };
    }

    this.statusCache = {
      checkedAt: Date.now(),
      status,
    };

    return status;
  }

  async getPortStatus(port, status = null) {
    const normalizedPort = normalizeTailscaleServePort(port);

    if (!normalizedPort) {
      return {
        available: false,
        config: null,
        enabled: false,
        port: null,
        reason: "Invalid port.",
      };
    }

    const serveStatus = status ?? (await this.getStatus());
    if (!serveStatus.available) {
      return {
        ...serveStatus,
        enabled: false,
        port: normalizedPort,
      };
    }

    return {
      ...serveStatus,
      ...parseTailscaleServeStatus(serveStatus.config, normalizedPort),
      port: normalizedPort,
    };
  }

  async exposePort(port) {
    const normalizedPort = normalizeTailscaleServePort(port);

    if (!normalizedPort) {
      throw new Error("Invalid port.");
    }

    const args = [
      "serve",
      "--bg",
      "--yes",
      `--tcp=${normalizedPort}`,
      `tcp://localhost:${normalizedPort}`,
    ];

    try {
      await this.execFile(this.command, args);
    } catch (error) {
      if (!isUnknownYesFlagError(error)) {
        throw new Error(
          `Could not expose port ${normalizedPort} with Tailscale Serve: ${getErrorMessage(error)}`,
        );
      }

      const fallbackArgs = args.filter((arg) => arg !== "--yes");
      try {
        await this.execFile(this.command, fallbackArgs);
      } catch (fallbackError) {
        throw new Error(
          `Could not expose port ${normalizedPort} with Tailscale Serve: ${getErrorMessage(
            fallbackError,
          )}`,
        );
      }
    }

    this.statusCache = null;

    return {
      available: true,
      enabled: true,
      port: normalizedPort,
    };
  }
}
