// MCP-launch registry.
//
// Buildings declare `mcp-launch` steps in their install plans. Today the
// install runner just logs them — nothing actually picks the declarations up
// and exposes them to the host agent's MCP client. This module is that
// pickup point.
//
// API:
//   const registry = createMcpLaunchRegistry({ persistencePath });
//   registry.declare(buildingId, [{ command, args, env, label }]);
//   registry.list();                      // raw declarations
//   registry.list({ settings, resolved }); // ${settingKey} interpolated
//   registry.toMcpConfig({ settings });   // claude_desktop_config.json shape
//   registry.remove(buildingId);          // when a building is uninstalled
//
// `declare()` REPLACES the building's previous launches, so re-running an
// install plan after a token paste correctly re-installs the resolved env.
//
// When `persistencePath` is supplied, the registry is loaded from disk at
// construction (silently ignoring missing/corrupt files) and re-saved on
// every mutation. Writes are atomic (write to .tmp then rename) so a
// crash mid-write can't leave a partial file.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const TEMPLATE_PATTERN = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
const PERSISTENCE_VERSION = 1;

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function trimString(value) {
  return typeof value === "string" ? value : String(value ?? "");
}

// Resolve every `${settingKey}` token in `text` against `settings`. If a
// referenced key is missing/empty, the template is left as-is so the caller
// can tell something is unresolved.
export function resolveTemplate(text, settings) {
  if (typeof text !== "string" || !text.includes("${")) return text;
  const sourceSettings = settings && typeof settings === "object" ? settings : {};
  return text.replace(TEMPLATE_PATTERN, (match, key) => {
    const value = sourceSettings[key];
    if (value === undefined || value === null) return match;
    const stringValue = String(value);
    if (stringValue === "") return match;
    return stringValue;
  });
}

// `${X}` survival: returns true iff `text` still references some unresolved
// template. Useful for reporting to the UI.
export function hasUnresolvedTemplate(text) {
  if (typeof text !== "string") return false;
  TEMPLATE_PATTERN.lastIndex = 0;
  return TEMPLATE_PATTERN.test(text);
}

function normalizeLaunch(rawLaunch) {
  if (!rawLaunch || typeof rawLaunch !== "object" || Array.isArray(rawLaunch)) return null;
  const command = trimString(rawLaunch.command).trim();
  if (!command) return null;
  const args = Array.isArray(rawLaunch.args) ? rawLaunch.args.map(trimString) : [];
  const env = rawLaunch.env && typeof rawLaunch.env === "object" && !Array.isArray(rawLaunch.env)
    ? Object.fromEntries(Object.entries(rawLaunch.env).map(([k, v]) => [String(k), trimString(v)]))
    : {};
  const label = trimString(rawLaunch.label || "").trim();
  return { command, args, env, label };
}

function resolveLaunch(launch, settings) {
  return {
    command: resolveTemplate(launch.command, settings),
    args: launch.args.map((arg) => resolveTemplate(arg, settings)),
    env: Object.fromEntries(Object.entries(launch.env).map(([k, v]) => [k, resolveTemplate(v, settings)])),
    label: launch.label,
  };
}

function launchHasUnresolved(launch) {
  if (hasUnresolvedTemplate(launch.command)) return true;
  if (launch.args.some(hasUnresolvedTemplate)) return true;
  if (Object.values(launch.env).some(hasUnresolvedTemplate)) return true;
  return false;
}

function normalizeHandshakeRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ok = Boolean(value.ok);
  const status = trimString(value.status || "").trim() || "unknown";
  const at = Number.isFinite(value.at) ? value.at : null;
  const out = { ok, status };
  if (at !== null) out.at = at;
  if (Number.isFinite(value.toolCount)) out.toolCount = value.toolCount;
  if (typeof value.serverName === "string" && value.serverName) out.serverName = value.serverName;
  if (typeof value.serverVersion === "string" && value.serverVersion) out.serverVersion = value.serverVersion;
  if (typeof value.error === "string" && value.error) out.error = value.error;
  return out;
}

function normalizeInstallRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ok = Boolean(value.ok);
  const status = trimString(value.status || "").trim() || "unknown";
  const at = Number.isFinite(value.at) ? value.at : null;
  const out = { ok, status };
  if (at !== null) out.at = at;
  if (typeof value.jobId === "string" && value.jobId) out.jobId = value.jobId;
  if (typeof value.reason === "string" && value.reason) out.reason = value.reason;
  return out;
}

function loadFromDisk(persistencePath) {
  // Returns Map<buildingId, normalizedLaunch[]>. Missing/corrupt files
  // produce an empty map silently — the registry is best-effort durable,
  // not a source of truth, so a corrupt file just means the user re-runs
  // each building's install plan.
  const out = new Map();
  if (!persistencePath) return out;
  let raw;
  try {
    raw = readFileSync(persistencePath, "utf8");
  } catch {
    return out;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || !parsed.buildings || typeof parsed.buildings !== "object") {
    return out;
  }
  for (const [buildingId, launches] of Object.entries(parsed.buildings)) {
    if (!Array.isArray(launches)) continue;
    const normalized = launches
      .map((launch) => {
        const base = normalizeLaunch(launch);
        if (!base) return null;
        // Preserve a previously-recorded handshake across reload.
        const lastHandshake = normalizeHandshakeRecord(launch?.lastHandshake);
        if (lastHandshake) base.lastHandshake = lastHandshake;
        const lastInstall = normalizeInstallRecord(launch?.lastInstall);
        if (lastInstall) base.lastInstall = lastInstall;
        return base;
      })
      .filter(Boolean);
    if (normalized.length > 0) {
      out.set(String(buildingId), normalized);
    }
  }
  return out;
}

function saveToDisk(persistencePath, launchesByBuilding) {
  if (!persistencePath) return;
  const buildings = {};
  for (const [buildingId, launches] of launchesByBuilding.entries()) {
    buildings[buildingId] = launches;
  }
  const payload = { version: PERSISTENCE_VERSION, buildings };
  const dir = dirname(persistencePath);
  // Make sure the directory exists. mkdirSync is idempotent with recursive.
  try { mkdirSync(dir, { recursive: true }); } catch {}
  // Atomic write: tmp + rename. If anything throws we leak a tmp file at
  // worst — the original persistencePath stays unchanged.
  const tmpPath = `${persistencePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = openSync(tmpPath, "w");
    try {
      writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, persistencePath);
  } catch {
    try { unlinkSync(tmpPath); } catch {}
  }
}

export function createMcpLaunchRegistry({
  getSettings = () => ({}),
  persistencePath = null,
} = {}) {
  // Map<buildingId, normalizedLaunch[]>
  const launchesByBuilding = persistencePath
    ? loadFromDisk(persistencePath)
    : new Map();

  const persist = () => saveToDisk(persistencePath, launchesByBuilding);

  return {
    persistencePath,
    declare(buildingId, launches) {
      const id = String(buildingId || "").trim();
      if (!id) return [];
      const normalized = asArray(launches).map(normalizeLaunch).filter(Boolean);
      if (normalized.length === 0) {
        if (launchesByBuilding.delete(id)) persist();
        return [];
      }
      launchesByBuilding.set(id, normalized);
      persist();
      return normalized;
    },
    remove(buildingId) {
      const id = String(buildingId || "").trim();
      if (!id) return false;
      const removed = launchesByBuilding.delete(id);
      if (removed) persist();
      return removed;
    },
    has(buildingId) {
      return launchesByBuilding.has(String(buildingId || "").trim());
    },
    // Returns the set of settings keys referenced by any registered
    // launch's command/args/env templates. Used by the settings PATCH
    // route to decide whether a setting change should re-trigger an
    // auto-sync to the agent CLIs (paste a Github token → auto-sync
    // so claude mcp list immediately shows mcp-github with the
    // resolved value).
    referencedSettings() {
      const refs = new Set();
      const harvest = (text) => {
        if (typeof text !== "string") return;
        TEMPLATE_PATTERN.lastIndex = 0;
        let match;
        while ((match = TEMPLATE_PATTERN.exec(text)) !== null) {
          refs.add(match[1]);
        }
      };
      for (const launches of launchesByBuilding.values()) {
        for (const launch of launches) {
          harvest(launch.command);
          if (Array.isArray(launch.args)) {
            for (const arg of launch.args) harvest(arg);
          }
          if (launch.env && typeof launch.env === "object") {
            for (const value of Object.values(launch.env)) harvest(value);
          }
        }
      }
      return refs;
    },
    // Record the most-recent handshake outcome for a (buildingId, label)
    // pair so the UI can show "tools-listed (5 tools), 30s ago" inline.
    // Match-by-label so multi-launch buildings track each launch
    // separately. If the building doesn't have any launches, this is a
    // no-op (the launch was probably unregistered between handshake
    // start and finish).
    recordHandshake(buildingId, label, result) {
      const id = String(buildingId || "").trim();
      if (!id) return false;
      const launches = launchesByBuilding.get(id);
      if (!launches || launches.length === 0) return false;
      const targetLabel = String(label || "").trim();
      const target = targetLabel
        ? launches.find((entry) => entry.label === targetLabel) || launches[0]
        : launches[0];
      if (!target) return false;
      const normalized = normalizeHandshakeRecord({ ...result, at: Date.now() });
      if (!normalized) return false;
      target.lastHandshake = normalized;
      persist();
      return true;
    },
    // Record the most-recent install result. Unlike handshake, install
    // is per-building (it touches every launch the building declares
    // at once), so we write the same record to every launch entry.
    // The UI uses lastInstall + lastHandshake together to render
    // "installed 2 days ago, last handshake ok 30s ago" without an
    // extra round-trip.
    recordInstall(buildingId, result) {
      const id = String(buildingId || "").trim();
      if (!id) return false;
      const launches = launchesByBuilding.get(id);
      if (!launches || launches.length === 0) return false;
      const normalized = normalizeInstallRecord({ ...result, at: Date.now() });
      if (!normalized) return false;
      for (const launch of launches) {
        launch.lastInstall = normalized;
      }
      persist();
      return true;
    },
    list({ settings, resolved = false } = {}) {
      const effectiveSettings = settings || getSettings();
      const out = [];
      for (const [buildingId, launches] of launchesByBuilding.entries()) {
        for (const launch of launches) {
          const finalLaunch = resolved ? resolveLaunch(launch, effectiveSettings) : launch;
          const entry = {
            buildingId,
            command: finalLaunch.command,
            args: finalLaunch.args,
            env: finalLaunch.env,
            label: finalLaunch.label,
            unresolved: launchHasUnresolved(finalLaunch),
          };
          if (launch.lastHandshake) entry.lastHandshake = { ...launch.lastHandshake };
          if (launch.lastInstall) entry.lastInstall = { ...launch.lastInstall };
          out.push(entry);
        }
      }
      return out;
    },
    // Output shaped like a Claude Desktop / Cursor MCP config so a host can
    // either save it or import it directly. Multiple launches per building
    // get suffixed with -1, -2, … to keep keys unique.
    toMcpConfig({ settings } = {}) {
      const effectiveSettings = settings || getSettings();
      const mcpServers = {};
      for (const [buildingId, launches] of launchesByBuilding.entries()) {
        launches.forEach((launch, index) => {
          const resolved = resolveLaunch(launch, effectiveSettings);
          const key = launches.length === 1 ? buildingId : `${buildingId}-${index + 1}`;
          mcpServers[key] = {
            command: resolved.command,
            args: resolved.args,
            ...(Object.keys(resolved.env).length > 0 ? { env: resolved.env } : {}),
          };
        });
      }
      return { mcpServers };
    },
    size() {
      return launchesByBuilding.size;
    },
    clear() {
      const hadEntries = launchesByBuilding.size > 0;
      launchesByBuilding.clear();
      if (hadEntries) persist();
    },
  };
}
