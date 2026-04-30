import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseRunsTsv } from "./sweep-runner.js";

const RUNS_FILE = "runs.tsv";
const RUNS_DIR = "runs";

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readTextOrNull(p) {
  try {
    return await readFile(p, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function emptyStatusCounts() {
  return { planned: 0, running: 0, done: 0, failed: 0, skipped: 0, other: 0 };
}

function sweepCellKey(name) {
  return String(name || "").replace(/-seed\d+$/i, "") || "(unnamed)";
}

export async function summarizeRunsFile(projectDir, relPath) {
  const text = await readTextOrNull(path.join(projectDir, relPath));
  if (!text) return null;
  const { headers, rows } = parseRunsTsv(text);
  if (!headers.length) return null;

  const statusCounts = emptyStatusCounts();
  const cells = new Set();
  let bestMean = null;
  let bestName = "";
  let newestStartedAt = "";
  for (const row of rows) {
    const status = String(row.status || "").trim() || "other";
    if (Object.hasOwn(statusCounts, status)) statusCounts[status] += 1;
    else statusCounts.other += 1;
    cells.add(sweepCellKey(row.name));
    const startedAt = String(row.started_at || "").trim();
    if (startedAt && (!newestStartedAt || startedAt > newestStartedAt)) newestStartedAt = startedAt;
    const mean = Number(row.mean_return);
    if (Number.isFinite(mean) && (bestMean === null || mean > bestMean)) {
      bestMean = mean;
      bestName = String(row.name || "");
    }
  }

  return {
    path: relPath,
    name: relPath === RUNS_FILE ? "top-level" : path.basename(relPath, ".tsv"),
    rows: rows.length,
    cells: cells.size,
    statusCounts,
    bestMean,
    bestName,
    newestStartedAt,
  };
}

export async function loadSweepSummaries(projectDir) {
  const targets = [];
  if (await pathExists(path.join(projectDir, RUNS_FILE))) {
    targets.push(RUNS_FILE);
  }
  const runsDir = path.join(projectDir, RUNS_DIR);
  if (await pathExists(runsDir)) {
    const entries = await readdir(runsDir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && entry.name.endsWith(".tsv")) {
        targets.push(path.join(RUNS_DIR, entry.name));
      }
    }
  }
  const summaries = await Promise.all(targets.map((relPath) => summarizeRunsFile(projectDir, relPath)));
  return summaries.filter(Boolean);
}

export function sweepHasRunnableRows(sweep) {
  const counts = sweep?.statusCounts || {};
  return Boolean((counts.planned || 0) + (counts.running || 0) + (counts.failed || 0));
}
