// Executor for the runs.tsv that `vr-rl-sweep init` writes.
//
// The autonomous RL-sweep-tuner agent (templates/rl-sweep-tuner.md) calls
// this to walk the planned rows, spawn each one's launcher, capture the
// metric from stdout, and update the row in-place.
//
// Design intent for v1:
//   - Local-only execution (Modal/RunPod is a follow-up).
//   - One row at a time, sequential. Parallelism is a follow-up; a tight
//     sequential v1 is easier to debug + reason about for the human
//     reviewing paper.md the next morning.
//   - Atomic-rename TSV writes after every row, so a Ctrl-C mid-loop
//     leaves runs.tsv in a consistent state.
//   - Spawn is dependency-injected so tests never hit a real process.
//
// API:
//
//   const result = await runPlannedRows({
//     runsTsvPath,             // absolute path
//     launcherTemplate,        // shell command template, see expandLauncher
//     metricPattern,           // RegExp; first capture group → mean_return
//     timeoutSec,              // per-row hard kill (default 1800)
//     maxRows,                 // optional cap for partial runs
//     spawnImpl,               // dependency-injected ({ command }) => Promise
//     onRowChange,             // optional callback (row, index, action)
//   });
//   // → { ran, ok, failed, skipped, rows }

import { readFile, writeFile, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_TIMEOUT_SEC = 30 * 60;
const DEFAULT_METRIC_PATTERN = /(?:final_return|mean_return)\s*[:=]\s*([+-]?[0-9]*\.?[0-9]+(?:[eE][+-]?\d+)?)/;
// Match the standard wandb run URL the wandb client prints to stdout
// during init, plus a few common surrounding-emoji decorations and the
// JSON-payload form a custom client might emit. Capture group 0 = full
// match (we use the whole match as the url, no group needed).
//
//   wandb: 🚀 View run at https://wandb.ai/<entity>/<project>/runs/<id>
//   wandb: View project at https://wandb.ai/<entity>/<project>
//   wandb_url: https://wandb.ai/...
//   "url": "https://wandb.ai/..."
//
// The runner stores the FIRST run URL it sees per row (project URLs are
// less specific and skipped if a run URL is also present).
const WANDB_RUN_URL_PATTERN = /https?:\/\/(?:[\w.-]+\.)?wandb\.ai\/[^\s"'<>)]+\/runs\/[A-Za-z0-9_-]+/;
const WANDB_ANY_URL_PATTERN = /https?:\/\/(?:[\w.-]+\.)?wandb\.ai\/[^\s"'<>)]+/;

// ---- TSV parser / serializer ----

export function parseRunsTsv(text) {
  const lines = String(text || "").split("\n");
  // Find first non-empty line for headers.
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].length > 0) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return { headers: [], rows: [] };
  const headers = lines[headerIdx].split("\t");
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (lines[i].length === 0) continue;
    const cells = lines[i].split("\t");
    const row = {};
    for (let h = 0; h < headers.length; h += 1) {
      row[headers[h]] = cells[h] ?? "";
    }
    rows.push(row);
  }
  return { headers, rows };
}

export function serializeRunsTsv({ headers, rows }) {
  const out = [headers.join("\t")];
  for (const row of rows) {
    out.push(headers.map((h) => sanitizeTsvCell(row[h])).join("\t"));
  }
  return `${out.join("\n")}\n`;
}

function sanitizeTsvCell(value) {
  return String(value ?? "").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
}

// Atomic write: tmp file + rename so a Ctrl-C between writes doesn't
// leave a half-written runs.tsv on disk.
async function atomicWriteTsv(filePath, body) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, body, "utf8");
  await rename(tmpPath, filePath);
}

// ---- launcher template expansion ----

// Expand ${key} placeholders in a shell command template against the
// row's resolved config (parsed from the row's `config` JSON column).
// Unresolved templates are left as ${key} so the launcher errors loudly
// rather than silently substituting empty strings.
export function expandLauncher(template, configMap) {
  if (typeof template !== "string") return "";
  return template.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, key) => {
    const value = configMap?.[key];
    if (value === undefined || value === null || value === "") return match;
    return String(value);
  });
}

// Default launcher: `python train.py --<key>=<value> ... --seed <S>`.
// Uses `seed<N>` parsing of the row's name to extract the seed.
function defaultLauncher(row, configMap) {
  const seedMatch = String(row.name || "").match(/seed(\d+)$/);
  const seed = seedMatch ? seedMatch[1] : "0";
  const flags = Object.entries(configMap || {})
    .map(([k, v]) => `--${k}=${shellQuote(String(v))}`)
    .join(" ");
  return `python train.py ${flags} --seed=${seed}`.trim();
}

function shellQuote(value) {
  // Single-quote and escape any embedded single quotes.
  if (/^[A-Za-z0-9_.+\-/=]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// ---- metric extraction ----

export function extractMetric(stdout, pattern = DEFAULT_METRIC_PATTERN) {
  if (typeof stdout !== "string" || !stdout) return null;
  const match = pattern.exec(stdout);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

// Best-effort wandb URL extraction. Prefer a /runs/<id> URL (specific to
// the actual run); fall back to any wandb.ai URL (project-level link).
// Returns "" if no wandb URL was printed — the field stays empty in
// runs.tsv so a downstream agent can tell "didn't run wandb" from
// "ran but URL missing".
export function extractWandbUrl(stdout) {
  if (typeof stdout !== "string" || !stdout) return "";
  const runMatch = WANDB_RUN_URL_PATTERN.exec(stdout);
  if (runMatch) return stripTrailingPunctuation(runMatch[0]);
  const anyMatch = WANDB_ANY_URL_PATTERN.exec(stdout);
  if (anyMatch) return stripTrailingPunctuation(anyMatch[0]);
  return "";
}

function stripTrailingPunctuation(url) {
  // wandb often prints URLs followed by punctuation in console messages
  // ("View run at <url>."). Trim trailing dots / commas / closing
  // brackets so we don't pollute the wandb_url cell.
  return url.replace(/[.,;:!?)\]>]+$/, "");
}

// ---- spawn helper (dependency-injectable for tests) ----

function defaultSpawnRun({ command, env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      env,
      cwd,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      resolve(payload);
    };
    const timer = setTimeout(() => {
      settle({ exitCode: null, stdout, stderr: stderr + `\n[sweep-runner] timeout after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs);
    child.stdout?.on?.("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on?.("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      settle({ exitCode: -1, stdout, stderr: stderr + `\n[sweep-runner] spawn error: ${err.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({ exitCode: code, stdout, stderr, timedOut: false });
    });
  });
}

// ---- the run loop ----

export async function runPlannedRows({
  runsTsvPath,
  launcherTemplate = null,
  metricPattern = DEFAULT_METRIC_PATTERN,
  timeoutSec = DEFAULT_TIMEOUT_SEC,
  maxRows,
  spawnImpl = defaultSpawnRun,
  onRowChange = () => {},
  cwd,
  env = process.env,
} = {}) {
  if (!runsTsvPath) throw new TypeError("runsTsvPath is required");
  const text = await readFile(runsTsvPath, "utf8");
  const { headers, rows } = parseRunsTsv(text);
  if (headers.length === 0) {
    throw new Error(`runs.tsv at ${runsTsvPath} is empty / has no header`);
  }

  let ran = 0;
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  const timeoutMs = Math.max(1000, Number(timeoutSec) * 1000);

  for (let i = 0; i < rows.length; i += 1) {
    if (typeof maxRows === "number" && ran >= maxRows) break;
    const row = rows[i];
    const status = String(row.status || "").trim();
    if (status === "done" || status === "skipped") { skipped += 1; continue; }
    // Anything else (planned, running, failed) → re-attempt.

    let configMap = {};
    if (typeof row.config === "string" && row.config.length > 0) {
      try { configMap = JSON.parse(row.config); } catch {}
    }
    const command = launcherTemplate
      ? expandLauncher(launcherTemplate, configMap)
      : defaultLauncher(row, configMap);

    // Mark running BEFORE spawning so a crash doesn't leave the row in
    // "planned" indefinitely (the next runner attempt sees "running"
    // and re-attempts).
    row.status = "running";
    row.started_at = new Date().toISOString();
    await atomicWriteTsv(runsTsvPath, serializeRunsTsv({ headers, rows }));
    onRowChange(row, i, "running");
    ran += 1;

    const result = await spawnImpl({
      command,
      env: { ...env },
      cwd,
      timeoutMs,
    });
    const metric = extractMetric(result.stdout, metricPattern);
    const wandbUrl = extractWandbUrl(result.stdout);
    if (wandbUrl) row.wandb_url = wandbUrl;
    if (result.exitCode === 0 && metric !== null) {
      row.status = "done";
      row.mean_return = String(metric);
      // std_return is per-cell aggregate, computed below after every cell finishes.
      ok += 1;
    } else {
      row.status = "failed";
      row.mean_return = metric !== null ? String(metric) : "";
      failed += 1;
    }
    await atomicWriteTsv(runsTsvPath, serializeRunsTsv({ headers, rows }));
    onRowChange(row, i, row.status);
  }

  // Per-cell std_return: group rows by name-without-trailing-seedN, compute
  // mean+std across the seeds of each cell, write std into every member row.
  const groups = new Map();
  for (const row of rows) {
    const cellName = String(row.name || "").replace(/-seed\d+$/, "");
    if (!groups.has(cellName)) groups.set(cellName, []);
    groups.get(cellName).push(row);
  }
  for (const [, members] of groups.entries()) {
    const numerics = members
      .map((r) => Number(r.mean_return))
      .filter((v) => Number.isFinite(v));
    if (numerics.length < 2) continue;
    const mean = numerics.reduce((a, b) => a + b, 0) / numerics.length;
    const variance = numerics.reduce((a, b) => a + (b - mean) ** 2, 0) / numerics.length;
    const std = Math.sqrt(variance);
    for (const m of members) m.std_return = String(roundTo(std, 6));
  }
  await atomicWriteTsv(runsTsvPath, serializeRunsTsv({ headers, rows }));

  return { ran, ok, failed, skipped, rows };
}

function roundTo(value, decimals) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export const __internal = {
  defaultLauncher,
  shellQuote,
  DEFAULT_METRIC_PATTERN,
};
