// Sync the MCP-launch registry into the agent CLIs' on-disk configs so
// Claude Code (~/.claude.json) and Codex (~/.codex/config.toml) actually
// see the MCP servers Vibe Research has installed.
//
// Without this, the registry is invisible to the agents — they only read
// their own config files. Every Vibe Research-managed entry carries a
// `_vibeResearchManaged: true` marker so subsequent syncs can replace
// our entries cleanly without clobbering hand-edited ones.
//
// API:
//
//   const result = syncToClaudeCode({
//     registry,
//     settings,
//     claudeJsonPath,        // default ~/.claude.json
//   });
//
//   const result = syncToCodex({
//     registry,
//     settings,
//     codexConfigPath,       // default ~/.codex/config.toml
//   });
//
// Both return `{ wrote: <number of entries>, managed: [<names>], path }`.
//
// Naming: each registry entry is keyed by `<buildingId>` (or
// `<buildingId>-N` when multi-launch). Codex section names need to match
// `[a-zA-Z_][a-zA-Z0-9_-]*`, so we sanitize to that.

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
import os from "node:os";
import path from "node:path";

const VIBE_RESEARCH_MANAGED_FLAG = "_vibeResearchManaged";

function homeDir() {
  return os.homedir();
}

function sanitizeCodexName(name) {
  // Codex section names must be TOML-safe: bare keys are letters, digits,
  // underscores, and hyphens.
  return String(name).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function buildLaunchKey(buildingId, totalLaunches, index) {
  return totalLaunches === 1 ? buildingId : `${buildingId}-${index + 1}`;
}

function buildManagedEntries(registry) {
  // Returns an array of [name, entry] pairs from the resolved registry,
  // each entry shaped for both JSON + TOML emit.
  const launches = registry.list({ resolved: true });
  // Group by building so we can name `-1, -2` only when there are multi
  // launches under one building.
  const byBuilding = new Map();
  for (const launch of launches) {
    if (launch.unresolved) continue;
    if (!byBuilding.has(launch.buildingId)) byBuilding.set(launch.buildingId, []);
    byBuilding.get(launch.buildingId).push(launch);
  }
  const out = [];
  for (const [buildingId, entries] of byBuilding.entries()) {
    entries.forEach((launch, index) => {
      const name = buildLaunchKey(buildingId, entries.length, index);
      out.push([name, {
        command: launch.command,
        args: Array.isArray(launch.args) ? launch.args : [],
        env: launch.env && typeof launch.env === "object" ? launch.env : {},
      }]);
    });
  }
  return out;
}

// ---- JSON (Claude Code) ----

export function syncToClaudeCode({ registry, claudeJsonPath, fs = { readFileSync, writeFileSync } } = {}) {
  if (!registry || typeof registry.list !== "function") {
    throw new TypeError("registry is required");
  }
  const filePath = claudeJsonPath || path.join(homeDir(), ".claude.json");

  let config = {};
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    config = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      config = {};
    }
  } catch {
    config = {};
  }

  const existingMcp = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
    ? config.mcpServers
    : {};

  // Strip out our previously-written managed entries; preserve everything
  // else (user-edited or written by other tools).
  const preserved = {};
  for (const [name, entry] of Object.entries(existingMcp)) {
    if (entry && typeof entry === "object" && entry[VIBE_RESEARCH_MANAGED_FLAG]) continue;
    preserved[name] = entry;
  }

  const managed = buildManagedEntries(registry);
  const merged = { ...preserved };
  for (const [name, entry] of managed) {
    merged[name] = {
      command: entry.command,
      args: entry.args,
      ...(Object.keys(entry.env).length > 0 ? { env: entry.env } : {}),
      [VIBE_RESEARCH_MANAGED_FLAG]: true,
    };
  }

  const nextConfig = { ...config, mcpServers: merged };
  atomicWriteJson(filePath, nextConfig, fs);
  return {
    path: filePath,
    wrote: managed.length,
    managed: managed.map(([name]) => name),
  };
}

function atomicWriteJson(filePath, value, fs) {
  const dir = dirname(filePath);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  if (fs.writeFileSync && fs !== globalThis) {
    // Test fs implementations may not support atomic rename; just write
    // directly and trust the test harness.
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = openSync(tmpPath, "w", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); } finally { closeSync(fd); }
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

// ---- TOML (Codex) ----

function tomlEscapeString(value) {
  // TOML basic-string escapes: \, ", control chars. Multi-line strings
  // would be nicer for long values but we keep it simple — single line
  // with escapes for safety.
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function tomlString(value) {
  return `"${tomlEscapeString(value)}"`;
}

function tomlArray(values) {
  return `[${values.map((v) => tomlString(v)).join(", ")}]`;
}

function tomlInlineTable(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    parts.push(`${k} = ${tomlString(v)}`);
  }
  return `{ ${parts.join(", ")} }`;
}

function buildCodexBlock(name, entry) {
  const safeName = sanitizeCodexName(name);
  const lines = [`[mcp_servers.${safeName}]`];
  // Vibe Research marker so subsequent syncs can identify our entries.
  lines.push(`${VIBE_RESEARCH_MANAGED_FLAG} = true`);
  lines.push(`command = ${tomlString(entry.command)}`);
  if (entry.args.length > 0) {
    lines.push(`args = ${tomlArray(entry.args)}`);
  }
  if (Object.keys(entry.env).length > 0) {
    lines.push(`env = ${tomlInlineTable(entry.env)}`);
  }
  return lines.join("\n");
}

// Tiny block-aware TOML scanner — just enough to identify & strip our
// managed sections. Blocks are demarcated by `[section]` headers; we
// keep lines until the next header or end of file.
function stripManagedCodexBlocks(rawText) {
  const lines = String(rawText || "").split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const headerMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (headerMatch) {
      if (current) blocks.push(current);
      current = { header: headerMatch[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      // Top-of-file lines before the first section.
      if (!blocks.length || blocks[0].header !== "__preamble__") {
        blocks.unshift({ header: "__preamble__", lines: [] });
      }
      blocks[0].lines.push(line);
    }
  }
  if (current) blocks.push(current);

  const preserved = blocks.filter((block) => {
    if (block.header === "__preamble__") return true;
    if (!block.header.startsWith("mcp_servers.")) return true;
    // It's a Codex MCP section. Drop only if it has our managed flag.
    const hasFlag = block.lines.some((line) => /_vibeResearchManaged\s*=\s*true/.test(line));
    return !hasFlag;
  });

  return preserved
    .map((b) => b.lines.join("\n"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function syncToCodex({ registry, codexConfigPath, fs = { readFileSync, writeFileSync } } = {}) {
  if (!registry || typeof registry.list !== "function") {
    throw new TypeError("registry is required");
  }
  const filePath = codexConfigPath || path.join(homeDir(), ".codex", "config.toml");

  let existing = "";
  try { existing = fs.readFileSync(filePath, "utf8"); } catch { existing = ""; }

  const preserved = stripManagedCodexBlocks(existing);
  const managed = buildManagedEntries(registry);
  const blocks = managed.map(([name, entry]) => buildCodexBlock(name, entry));

  let body = preserved.trimEnd();
  if (blocks.length > 0) {
    body = body ? `${body}\n\n${blocks.join("\n\n")}` : blocks.join("\n\n");
  }
  const out = `${body}\n`;

  const dir = dirname(filePath);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  if (fs.writeFileSync && fs !== globalThis) {
    fs.writeFileSync(filePath, out, { mode: 0o600 });
  } else {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const fd = openSync(tmpPath, "w", 0o600);
      try { writeFileSync(fd, out); } finally { closeSync(fd); }
      renameSync(tmpPath, filePath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch {}
      throw err;
    }
  }
  return {
    path: filePath,
    wrote: managed.length,
    managed: managed.map(([name]) => sanitizeCodexName(name)),
  };
}

export const __internal = {
  buildManagedEntries,
  buildCodexBlock,
  stripManagedCodexBlocks,
  sanitizeCodexName,
  VIBE_RESEARCH_MANAGED_FLAG,
};
