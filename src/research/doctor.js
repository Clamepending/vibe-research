// vr-research doctor — validate the loop bookkeeping for a project.
//
// Walks the README's LEADERBOARD, ACTIVE, QUEUE, INSIGHTS, and LOG sections
// and verifies that:
//   - leaderboard rows point at result docs that exist and are STATUS:resolved
//   - active rows point at result docs that exist and are STATUS:active
//   - queue starting-point URLs are well-shaped (`<repo>/tree/<branch>` or
//     `<repo>/tree/<branch>@<sha>`)
//   - insights links resolve to insights/<slug>.md somewhere up the tree
//   - log rows whose link is a relative path resolve to a real file
//   - leaderboard branch URLs follow the `<repo>/tree/r/<slug>` convention
//   - leaderboard commit URLs follow the `<repo>/commit/<sha>` convention
//
// Each issue carries a severity (`error` | `warning` | `info`) and a one-line
// human-readable message anchored to a section + row when applicable.

import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseProjectReadme } from "./project-readme.js";
import { parseResultDoc } from "./result-doc.js";
import { parseRunsTsv } from "./sweep-runner.js";
import { readManifest, archivedPath } from "./vacuum.js";
import {
  loadBenchmark,
  validateBenchmark,
  benchmarkVersionString,
  benchmarkKnownVersions,
  benchmarkMetricNames,
} from "./benchmark.js";

const TREE_URL = /^(https?:\/\/[^\s]+?)\/tree\/([^@\s]+)(?:@([0-9a-f]+))?$/;
const COMMIT_URL = /^(https?:\/\/[^\s]+?)\/commit\/([0-9a-f]+)$/;
const RESULT_BRANCH_RE = /\/tree\/r\/(.+)$/;

function makeIssue(severity, code, where, message) {
  return { severity, code, where, message };
}

async function pathExists(absolutePath) {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function loadResultDoc(projectDir, relativePath) {
  if (!relativePath) return null;
  const resolved = path.resolve(projectDir, relativePath);
  try {
    const text = await readFile(resolved, "utf8");
    return { resolved, ...parseResultDoc(text) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function resultBenchmarkVersion(doc) {
  const v = doc?.frontmatter?.benchmark_version;
  if (v === null || v === undefined || v === "") return "";
  return String(v);
}

function resultMetric(doc) {
  const m = doc?.frontmatter?.metric;
  if (!m) return "";
  return String(m);
}

function checkResultBenchmarkVersion(where, doc, benchmark) {
  if (!benchmark) return [];
  const issues = [];
  const declared = resultBenchmarkVersion(doc);
  const current = benchmarkVersionString(benchmark);
  if (!declared) {
    issues.push(makeIssue(
      "error",
      "result_missing_benchmark_version",
      where,
      `result doc frontmatter is missing benchmark_version (project has benchmark.md)`,
    ));
  } else {
    const knownVersions = benchmarkKnownVersions(benchmark);
    if (!knownVersions.has(declared)) {
      issues.push(makeIssue(
        "warning",
        "result_unknown_benchmark_version",
        where,
        `result doc cites benchmark_version=${declared} but it is not the current version (${current}) and not in HISTORY`,
      ));
    } else if (current && declared !== current) {
      issues.push(makeIssue(
        "info",
        "result_stale_benchmark_version",
        where,
        `result doc cites benchmark_version=${declared}; current bench is ${current}`,
      ));
    }
    // A bench-move's whole purpose is to INSTALL the current bench version.
    // If the result doc has bench cycles but doesn't cite the current version,
    // the move didn't do its declared job.
    if (doc.isBenchMove && current && declared !== current) {
      issues.push(makeIssue(
        "error",
        "bench_move_version_mismatch",
        where,
        `result doc has bench cycles (kind: bench) but cites benchmark_version=${declared}, not the current ${current} — a bench move must install the current bench version`,
      ));
    }
  }

  const metricName = resultMetric(doc);
  const metricNames = benchmarkMetricNames(benchmark);
  if (metricNames.size) {
    if (!metricName) {
      issues.push(makeIssue(
        "warning",
        "result_missing_metric",
        where,
        "result doc frontmatter has no `metric` field; benchmark declares METRICS, so the result must name which one it scored against",
      ));
    } else if (!metricNames.has(metricName)) {
      issues.push(makeIssue(
        "error",
        "result_metric_unknown",
        where,
        `result doc cites metric="${metricName}" but benchmark METRICS only declares: ${[...metricNames].join(", ")}`,
      ));
    }
  }
  return issues;
}

async function checkLeaderboard(projectDir, leaderboard, benchmark) {
  const issues = [];
  for (const row of leaderboard) {
    const where = `LEADERBOARD rank ${row.rank} (${row.slug || "unnamed"})`;

    if (!row.slug) {
      issues.push(makeIssue("error", "leaderboard_missing_slug", where, "no slug in result column"));
      continue;
    }
    if (!row.resultPath) {
      issues.push(makeIssue("error", "leaderboard_missing_result_path", where, "result column has no link target"));
    }
    if (!row.branchUrl) {
      issues.push(makeIssue("warning", "leaderboard_missing_branch_url", where, "branch column has no link"));
    } else {
      const treeMatch = TREE_URL.exec(row.branchUrl);
      if (!treeMatch) {
        issues.push(makeIssue("warning", "leaderboard_branch_url_shape", where, `branch URL is not a github tree URL: ${row.branchUrl}`));
      } else {
        const branchSlugMatch = RESULT_BRANCH_RE.exec(row.branchUrl);
        if (!branchSlugMatch) {
          issues.push(makeIssue("info", "leaderboard_branch_prefix", where, `branch URL does not use the r/<slug> convention: ${row.branchUrl}`));
        } else if (branchSlugMatch[1] !== row.slug) {
          issues.push(makeIssue("warning", "leaderboard_branch_slug_mismatch", where, `branch slug r/${branchSlugMatch[1]} does not match leaderboard slug ${row.slug}`));
        }
      }
    }
    if (!row.commitUrl) {
      issues.push(makeIssue("warning", "leaderboard_missing_commit_url", where, "commit column has no link"));
    } else if (!COMMIT_URL.test(row.commitUrl)) {
      issues.push(makeIssue("warning", "leaderboard_commit_url_shape", where, `commit URL is not a github commit URL: ${row.commitUrl}`));
    }
    if (!row.score) {
      issues.push(makeIssue("warning", "leaderboard_missing_score", where, "score / verdict column is empty"));
    }

    const doc = await loadResultDoc(projectDir, row.resultPath);
    if (!doc) {
      issues.push(makeIssue("error", "leaderboard_result_missing", where, `result doc not found at ${row.resultPath}`));
      continue;
    }
    if (doc.status && doc.status !== "resolved") {
      issues.push(makeIssue("error", "leaderboard_result_status", where, `result doc STATUS is "${doc.status}" but leaderboard implies resolved`));
    }
    issues.push(...checkResultBenchmarkVersion(where, doc, benchmark));
  }
  return issues;
}

// CLAUDE.md: "If an agent's ACTIVE row has had no new cycle commit on its
// r/<slug> branch in the code repo for >7 days, treat it as abandoned by
// that collaborator." We can't easily inspect the code repo's git log
// from here without shelling out, but we CAN flag rows whose README-claimed
// `started` date is >7 days ago — that catches the same staleness pattern
// at the contract level (the row was claimed but never wrote a cycle
// commit recent enough to update the README's started field, OR the agent
// just forgot to clear ACTIVE after resolving).
const ACTIVE_STALE_DAYS = 7;

function checkActiveStaleness(active, { now = Date.now() } = {}) {
  const issues = [];
  for (const row of active) {
    const where = `ACTIVE row ${row.slug || "unnamed"}`;
    const started = String(row.started || "").trim();
    if (!started) continue; // empty `started` is its own minor bug, not surfaced here
    const t = Date.parse(started);
    if (!Number.isFinite(t)) continue; // unparseable dates ignored — different bug class
    const days = (now - t) / (1000 * 60 * 60 * 24);
    if (days > ACTIVE_STALE_DAYS) {
      issues.push(makeIssue(
        "warning",
        "active_stale_row",
        where,
        `started ${days.toFixed(1)} days ago (>${ACTIVE_STALE_DAYS} day threshold); per CLAUDE.md treat as abandoned and clear the ACTIVE row, file an "abandoned" LOG row`,
      ));
    }
  }
  return issues;
}

async function checkActive(projectDir, active, benchmark) {
  const issues = [];
  for (const row of active) {
    const where = `ACTIVE row ${row.slug || "unnamed"}`;

    if (!row.slug) {
      issues.push(makeIssue("error", "active_missing_slug", where, "active row has no move slug"));
      continue;
    }
    if (!row.resultPath) {
      issues.push(makeIssue("error", "active_missing_result_path", where, "active row has no result-doc link"));
    }
    if (row.agent !== "" && row.agent !== "0") {
      issues.push(makeIssue("warning", "active_agent_id", where, `agent column is "${row.agent}" but the schema currently hard-codes 0`));
    }

    const doc = await loadResultDoc(projectDir, row.resultPath);
    if (!doc) {
      issues.push(makeIssue("error", "active_result_missing", where, `result doc not found at ${row.resultPath}`));
      continue;
    }
    if (doc.status && doc.status !== "active") {
      issues.push(makeIssue("error", "active_result_status", where, `result doc STATUS is "${doc.status}" but row is ACTIVE`));
    }
    issues.push(...checkResultBenchmarkVersion(where, doc, benchmark));
  }
  issues.push(...checkActiveStaleness(active));
  return issues;
}

function checkBenchmarkPresence(criterion, benchmark) {
  const issues = [];
  const kind = criterion?.kind;
  if (!benchmark && (kind === "qualitative" || kind === "mix")) {
    issues.push(makeIssue(
      "error",
      "benchmark_required",
      "benchmark.md",
      `RANKING CRITERION is ${kind} but benchmark.md is missing — qualitative and mix projects must declare a benchmark spec`,
    ));
  }
  if (benchmark && criterion && kind && kind !== "unknown") {
    const description = String(criterion.description || "").trim().toLowerCase();
    const metricNames = benchmark.metrics.map((m) => m.name.toLowerCase()).filter(Boolean);
    // RANKING CRITERION should bind to a declared metric for ALL bench-having
    // projects, not just quant/mix — qualitative dimensions are operationalised
    // by exactly the rubric/judge metric we declared.
    if (metricNames.length && kind !== "unknown") {
      const referenced = metricNames.some((name) => description.includes(name));
      if (!referenced) {
        issues.push(makeIssue(
          "warning",
          "ranking_criterion_metric_unbound",
          "RANKING CRITERION",
          `RANKING CRITERION does not reference any metric declared in benchmark.md (${metricNames.join(", ")})`,
        ));
      }
    }
  }
  return issues;
}

function checkFrozenBenchmark(benchmark, active) {
  if (!benchmark) return [];
  const status = String(benchmark.frontmatter?.status || "").toLowerCase();
  if (status !== "frozen") return [];
  if (!active.length) return [];
  return [makeIssue(
    "error",
    "benchmark_frozen_with_active_moves",
    "benchmark.md",
    `benchmark.md status is "frozen" but ACTIVE has ${active.length} row(s); frozen benches reject new moves — bump to a new version (active) or unfreeze`,
  )];
}

function checkQueue(queue) {
  const issues = [];
  for (const row of queue) {
    const where = `QUEUE row ${row.slug || "unnamed"}`;
    if (!row.slug) {
      issues.push(makeIssue("warning", "queue_missing_slug", where, "queue row has no move slug"));
    }
    if (!row.startingPointUrl) {
      issues.push(makeIssue("warning", "queue_missing_starting_point", where, "queue row has no starting-point URL"));
      continue;
    }
    if (
      row.startingPointUrl !== "main"
      && !TREE_URL.test(row.startingPointUrl)
      && !/^https?:\/\//.test(row.startingPointUrl)
    ) {
      issues.push(makeIssue(
        "info",
        "queue_starting_point_shape",
        where,
        `starting-point "${row.startingPointUrl}" is not "main" or a github tree URL`,
      ));
    }
    if (!row.why) {
      issues.push(makeIssue("info", "queue_missing_why", where, "queue row has no `why` justification"));
    }
  }
  if (queue.length > 5) {
    issues.push(makeIssue("warning", "queue_overflow", "QUEUE", `queue has ${queue.length} rows (cap is 5 per CLAUDE.md)`));
  }
  return issues;
}

async function checkInsights(projectDir, insights) {
  const issues = [];
  for (const row of insights) {
    const where = `INSIGHTS row ${row.slug || "unnamed"}`;
    if (!row.slug) {
      issues.push(makeIssue("warning", "insights_missing_slug", where, "insight row has no slug"));
    }
    if (!row.path) {
      issues.push(makeIssue("warning", "insights_missing_path", where, "insight row has no link"));
      continue;
    }
    const resolved = path.resolve(projectDir, row.path);
    if (!(await pathExists(resolved))) {
      issues.push(makeIssue("error", "insights_path_missing", where, `insight file not found at ${row.path}`));
    }
  }
  return issues;
}

async function checkLog(projectDir, log) {
  const issues = [];
  for (const row of log) {
    const where = `LOG ${row.date || ""} ${row.event || ""}`.trim();
    if (!row.event) {
      issues.push(makeIssue("warning", "log_missing_event", where, "log row has no event tag"));
      continue;
    }
    if (row.linkUrl && !/^https?:\/\//.test(row.linkUrl)) {
      const resolved = path.resolve(projectDir, row.linkUrl);
      if (!(await pathExists(resolved))) {
        issues.push(makeIssue("warning", "log_link_missing", where, `log link does not resolve: ${row.linkUrl}`));
      }
    }
  }
  return issues;
}

function checkLeaderboardCap(leaderboard) {
  if (leaderboard.length > 5) {
    return [makeIssue("warning", "leaderboard_overflow", "LEADERBOARD", `leaderboard has ${leaderboard.length} rows (cap is 5)`)];
  }
  return [];
}

function checkRankingCriterion(criterion) {
  if (!criterion || criterion.kind === "unknown") {
    return [makeIssue("error", "ranking_criterion_unset", "RANKING CRITERION", "ranking criterion is missing or unparseable")];
  }
  if (!["quantitative", "qualitative", "mix"].includes(criterion.kind)) {
    return [makeIssue("error", "ranking_criterion_kind", "RANKING CRITERION", `ranking criterion kind "${criterion.kind}" is not one of quantitative/qualitative/mix`)];
  }
  return [];
}

// runs.tsv lives at the top of a project (the first move's sweep) and at
// projects/<name>/runs/<slug>.tsv (follow-up moves' sweeps). Both shapes
// are validated identically.
const STALE_RUNNING_HOURS = 24;
const RUNS_REQUIRED_COLUMNS = ["status", "started_at", "name", "config"];

async function findRunsTsvFiles(projectDir) {
  const found = [];
  const top = path.join(projectDir, "runs.tsv");
  if (await pathExists(top)) found.push(top);
  const runsDir = path.join(projectDir, "runs");
  if (await pathExists(runsDir)) {
    let entries = [];
    try { entries = await readdir(runsDir); } catch { entries = []; }
    for (const entry of entries) {
      if (entry.endsWith(".tsv")) found.push(path.join(runsDir, entry));
    }
  }
  return found;
}

async function checkRunsTsv(projectDir, active) {
  const issues = [];
  const files = await findRunsTsvFiles(projectDir);
  if (!files.length) return issues;

  const hasActive = active.length > 0;
  let anyRunning = false;

  for (const file of files) {
    const where = `runs.tsv (${path.relative(projectDir, file) || "runs.tsv"})`;
    let text;
    try { text = await readFile(file, "utf8"); }
    catch (err) {
      issues.push(makeIssue("warning", "runs_unreadable", where, `could not read: ${err.message}`));
      continue;
    }
    const { headers, rows } = parseRunsTsv(text);
    if (!headers.length) {
      issues.push(makeIssue("warning", "runs_empty", where, "TSV has no header row"));
      continue;
    }
    const missing = RUNS_REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
    if (missing.length) {
      issues.push(makeIssue(
        "error",
        "runs_missing_columns",
        where,
        `missing required columns: ${missing.join(", ")}`,
      ));
    }

    for (const row of rows) {
      const status = String(row.status || "").trim();
      const name = String(row.name || "").trim() || "(unnamed)";
      const rowWhere = `${where} row "${name}"`;

      if (status === "running") {
        anyRunning = true;
        const startedAt = String(row.started_at || "").trim();
        if (startedAt) {
          const t = Date.parse(startedAt);
          if (Number.isFinite(t)) {
            const hoursSince = (Date.now() - t) / (1000 * 60 * 60);
            if (hoursSince > STALE_RUNNING_HOURS) {
              issues.push(makeIssue(
                "warning",
                "runs_stale_running",
                rowWhere,
                `status is "running" but started_at was ${hoursSince.toFixed(1)}h ago — orphaned process? mark failed/skipped or rerun`,
              ));
            }
          }
        }
      }

      // The runner writes config as JSON; an unparseable cell means the
      // launcher will get garbage and silently fail.
      const config = row.config;
      if (typeof config === "string" && config.length > 0) {
        try { JSON.parse(config); }
        catch {
          issues.push(makeIssue(
            "error",
            "runs_config_unparseable",
            rowWhere,
            `config column is not valid JSON: ${config.slice(0, 80)}${config.length > 80 ? "..." : ""}`,
          ));
        }
      }

      const wandb = String(row.wandb_url || "").trim();
      if (wandb && !/wandb\.ai/.test(wandb)) {
        issues.push(makeIssue(
          "warning",
          "runs_bad_wandb_url",
          rowWhere,
          `wandb_url does not look like a wandb.ai URL: ${wandb}`,
        ));
      }
    }
  }

  // Cross-check with README ACTIVE: if a sweep has rows that are
  // currently running (not just stale) but the README has no ACTIVE row,
  // collaborators on a shared project can't see the move is in flight.
  if (anyRunning && !hasActive) {
    issues.push(makeIssue(
      "warning",
      "runs_running_without_active",
      "ACTIVE",
      "runs.tsv has at least one row with status \"running\" but README ACTIVE is empty — claim the move in README so collaborators see the lock",
    ));
  }

  return issues;
}

// kickoff.json carries the human-supplied goal + repo + budget for a
// project bootstrapped via vr-rl-tuner. The agent re-reads it on every
// loop entry, so a corrupt or missing kickoff means the loop runs blind.
// Doctor only flags a kickoff as required when the rl-sweep-tuner skill
// is installed under .claude/skills/ — a regular vr-research-init
// project doesn't write kickoff.json and shouldn't be expected to.
async function checkKickoffJson(projectDir) {
  const issues = [];
  const kickoffPath = path.join(projectDir, "kickoff.json");
  const skillPath = path.join(projectDir, ".claude", "skills", "rl-sweep-tuner", "SKILL.md");

  const [kickoffExists, skillExists] = await Promise.all([
    pathExists(kickoffPath),
    pathExists(skillPath),
  ]);

  // Project not bootstrapped via vr-rl-tuner: nothing to check.
  if (!kickoffExists && !skillExists) return issues;

  if (skillExists && !kickoffExists) {
    issues.push(makeIssue(
      "warning",
      "kickoff_missing",
      "kickoff.json",
      "rl-sweep-tuner skill is installed but kickoff.json is missing — the agent has no goal/repo on entry",
    ));
    return issues;
  }

  let raw;
  try { raw = await readFile(kickoffPath, "utf8"); }
  catch (err) {
    issues.push(makeIssue("error", "kickoff_unreadable", "kickoff.json", `cannot read: ${err.message}`));
    return issues;
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    issues.push(makeIssue("error", "kickoff_unparseable", "kickoff.json", `invalid JSON: ${err.message}`));
    return issues;
  }

  const goalOk = typeof parsed.goal === "string" && parsed.goal.trim().length > 0;
  if (!goalOk) {
    issues.push(makeIssue("error", "kickoff_missing_goal", "kickoff.json", "missing or empty required field: goal"));
  }
  const repoOk = typeof parsed.repo === "string" && parsed.repo.trim().length > 0;
  if (!repoOk) {
    issues.push(makeIssue("error", "kickoff_missing_repo", "kickoff.json", "missing or empty required field: repo"));
  } else if (!(await pathExists(parsed.repo))) {
    issues.push(makeIssue(
      "warning",
      "kickoff_repo_missing",
      "kickoff.json",
      `repo path does not exist on disk: ${parsed.repo} — was the machine moved or the repo deleted?`,
    ));
  }
  return issues;
}

// Walk projects/<name>/results/*.md and confirm each result-doc's slug
// is referenced by SOME README section (LEADERBOARD, ACTIVE, or LOG).
// A result doc that exists on disk but isn't mentioned in the README is
// an orphan: the agent finished a move but forgot to apply the README
// updates. Caught now instead of being discovered weeks later when the
// leaderboard is silently missing rows.
async function checkOrphanResultDocs(projectDir, parsed) {
  const issues = [];
  const resultsDir = path.join(projectDir, "results");
  if (!(await pathExists(resultsDir))) return issues;

  let entries = [];
  try { entries = await readdir(resultsDir); } catch { return issues; }
  const referencedSlugs = new Set();
  for (const row of parsed.leaderboard) if (row.slug) referencedSlugs.add(row.slug);
  for (const row of parsed.active) if (row.slug) referencedSlugs.add(row.slug);
  for (const row of parsed.log) if (row.slug) referencedSlugs.add(row.slug);

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const slug = entry.replace(/\.md$/, "");
    if (referencedSlugs.has(slug)) continue;

    // Read the doc to know whether it's still in-flight (active) — an
    // active doc with no ACTIVE row is a different bug class
    // (active_missing_result_path catches the inverse already; this
    // direction is "doc exists but README has no claim").
    let doc;
    try {
      const text = await readFile(path.join(resultsDir, entry), "utf8");
      doc = parseResultDoc(text);
    } catch { continue; }

    const status = String(doc?.status || "").trim().toLowerCase();
    const where = `results/${entry}`;
    if (status === "active") {
      issues.push(makeIssue(
        "warning",
        "result_doc_active_unclaimed",
        where,
        `result doc has STATUS:active but no ACTIVE row in README — claim the move so collaborators see it`,
      ));
    } else if (status === "resolved" || status === "abandoned") {
      issues.push(makeIssue(
        "warning",
        "result_doc_orphan",
        where,
        `STATUS:${status} but slug "${slug}" is not in LEADERBOARD/ACTIVE/LOG — README never recorded this move's outcome`,
      ));
    }
    // STATUS missing/unknown: leave alone — separate bug class.
  }
  return issues;
}

// Verify the vacuum manifest is internally consistent. The vacuum
// command writes one row per tiered file with its sha256 + size; this
// check catches drift between manifest claims and what's actually on
// disk in .archive/. Without it, the integrity guarantee is only
// "hashed once at tiering time"; with it, every doctor run reverifies.
//
// Errors (loud, since these mean reproducibility is broken):
//   vacuum_manifest_archive_missing — manifest claims a path; nothing there
//   vacuum_manifest_sha_mismatch    — file present but SHA doesn't match
//
// Warnings (recoverable):
//   vacuum_manifest_size_mismatch   — size disagrees but SHA still matches
//                                     (shouldn't be possible; defensive)
//   vacuum_manifest_unparseable_row — manifest row is missing required cols
//
// Only runs if the manifest exists; vanilla projects without a vacuum
// run pay zero cost.
async function checkVacuumManifest(projectDir, { hashFn = sha256OfFile } = {}) {
  const issues = [];
  const manifest = await readManifest(projectDir);
  if (!manifest.rows.length) return issues;
  for (const row of manifest.rows) {
    const where = `vacuum manifest row ${row.original_path || "(no path)"}`;
    if (!row.original_path || !row.sha256) {
      issues.push(makeIssue(
        "warning",
        "vacuum_manifest_unparseable_row",
        where,
        `manifest row missing original_path or sha256: ${JSON.stringify(row)}`,
      ));
      continue;
    }
    const archived = archivedPath(projectDir, row.original_path);
    if (!(await pathExists(archived))) {
      issues.push(makeIssue(
        "error",
        "vacuum_manifest_archive_missing",
        where,
        `manifest claims ${archived} but file is missing — restore from a backup or remove the manifest row`,
      ));
      continue;
    }
    const declared = String(row.sha256);
    const actual = await hashFn(archived);
    if (actual !== declared) {
      issues.push(makeIssue(
        "error",
        "vacuum_manifest_sha_mismatch",
        where,
        `archived file SHA (${actual.slice(0, 12)}…) does not match manifest (${declared.slice(0, 12)}…) — file was tampered with or corrupted`,
      ));
      continue;
    }
    const declaredSize = Number(row.original_size);
    if (Number.isFinite(declaredSize) && declaredSize >= 0) {
      let actualSize = -1;
      try { actualSize = (await stat(archived)).size; } catch {}
      if (actualSize >= 0 && actualSize !== declaredSize) {
        issues.push(makeIssue(
          "warning",
          "vacuum_manifest_size_mismatch",
          where,
          `archived file size (${actualSize}) disagrees with manifest (${declaredSize}) but SHA matches — defensive flag`,
        ));
      }
    }
  }
  return issues;
}

async function sha256OfFile(absPath) {
  const buf = await readFile(absPath);
  const h = createHash("sha256");
  h.update(buf);
  return h.digest("hex");
}

export async function runDoctor(projectDir, { readmeText } = {}) {
  const readmePath = path.join(projectDir, "README.md");
  let text = readmeText;
  if (text === undefined) {
    text = await readFile(readmePath, "utf8");
  }
  const parsed = parseProjectReadme(text);

  const benchmark = await loadBenchmark(projectDir);

  const issues = [];
  issues.push(...checkRankingCriterion(parsed.rankingCriterion));
  issues.push(...checkLeaderboardCap(parsed.leaderboard));
  issues.push(...checkBenchmarkPresence(parsed.rankingCriterion, benchmark));
  issues.push(...checkFrozenBenchmark(benchmark, parsed.active));
  if (benchmark) {
    issues.push(...await validateBenchmark(projectDir, benchmark));
  }
  issues.push(...await checkLeaderboard(projectDir, parsed.leaderboard, benchmark));
  issues.push(...await checkActive(projectDir, parsed.active, benchmark));
  issues.push(...checkQueue(parsed.queue));
  issues.push(...await checkInsights(projectDir, parsed.insights));
  issues.push(...await checkLog(projectDir, parsed.log));
  issues.push(...await checkRunsTsv(projectDir, parsed.active));
  issues.push(...await checkKickoffJson(projectDir));
  issues.push(...await checkOrphanResultDocs(projectDir, parsed));
  issues.push(...await checkVacuumManifest(projectDir));

  return {
    project: parsed,
    benchmark,
    issues,
    summary: summarize(issues),
  };
}

function summarize(issues) {
  const out = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) {
    out[issue.severity] = (out[issue.severity] || 0) + 1;
  }
  return out;
}

export function formatIssue(issue) {
  return `[${issue.severity.toUpperCase()}] ${issue.where} — ${issue.message} (${issue.code})`;
}
