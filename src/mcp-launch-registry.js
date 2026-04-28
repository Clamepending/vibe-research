// MCP-launch registry.
//
// Buildings declare `mcp-launch` steps in their install plans. Today the
// install runner just logs them — nothing actually picks the declarations up
// and exposes them to the host agent's MCP client. This module is that
// pickup point.
//
// API:
//   const registry = createMcpLaunchRegistry();
//   registry.declare(buildingId, [{ command, args, env, label }]);
//   registry.list();                      // raw declarations
//   registry.list({ settings, resolved }); // ${settingKey} interpolated
//   registry.toMcpConfig({ settings });   // claude_desktop_config.json shape
//   registry.remove(buildingId);          // when a building is uninstalled
//
// `declare()` REPLACES the building's previous launches, so re-running an
// install plan after a token paste correctly re-installs the resolved env.

const TEMPLATE_PATTERN = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

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

export function createMcpLaunchRegistry({ getSettings = () => ({}) } = {}) {
  // Map<buildingId, normalizedLaunch[]>
  const launchesByBuilding = new Map();

  return {
    declare(buildingId, launches) {
      const id = String(buildingId || "").trim();
      if (!id) return [];
      const normalized = asArray(launches).map(normalizeLaunch).filter(Boolean);
      if (normalized.length === 0) {
        launchesByBuilding.delete(id);
        return [];
      }
      launchesByBuilding.set(id, normalized);
      return normalized;
    },
    remove(buildingId) {
      const id = String(buildingId || "").trim();
      if (!id) return false;
      return launchesByBuilding.delete(id);
    },
    has(buildingId) {
      return launchesByBuilding.has(String(buildingId || "").trim());
    },
    list({ settings, resolved = false } = {}) {
      const effectiveSettings = settings || getSettings();
      const out = [];
      for (const [buildingId, launches] of launchesByBuilding.entries()) {
        for (const launch of launches) {
          const finalLaunch = resolved ? resolveLaunch(launch, effectiveSettings) : launch;
          out.push({
            buildingId,
            command: finalLaunch.command,
            args: finalLaunch.args,
            env: finalLaunch.env,
            label: finalLaunch.label,
            unresolved: launchHasUnresolved(finalLaunch),
          });
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
      launchesByBuilding.clear();
    },
  };
}
