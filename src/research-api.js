// research-api.js — wraps the research/* parsers + doctor in JSON-shaped
// helpers for the web dashboard. Side-effect-free; takes a library root and
// optional project name and returns plain objects suitable for `response.json`.
//
// Why a separate module: the parsers in src/research/* are the source of truth
// for structure, but they return shapes optimized for CLIs (cycles as objects,
// frontmatter as a Map, etc). The dashboard wants a flat JSON shape with
// summary counts so the client can render at a glance without re-walking trees.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseProjectReadme, loadProjectLog } from "./research/project-readme.js";
import { parseResultDoc } from "./research/result-doc.js";
import { loadBenchmark } from "./research/benchmark.js";
import { runDoctor } from "./research/doctor.js";
import { loadSweepSummaries } from "./research/sweep-status.js";

const PROJECT_README = "README.md";
const BENCHMARK_FILE = "benchmark.md";
const PAPER_FILE = "paper.md";
const RESULTS_DIR = "results";
const FIGURES_DIR = "figures";

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

function severityCounts(issues) {
  const out = { error: 0, warning: 0, info: 0 };
  for (const issue of issues || []) {
    if (issue.severity in out) out[issue.severity] += 1;
  }
  return out;
}

function doctorBucket(counts) {
  if (counts.error > 0) return "error";
  if (counts.warning > 0) return "warning";
  return "ok";
}

function projectExistsBucket(parsed, benchmark) {
  // Quick at-a-glance summary that the dashboard can render as one chip.
  return {
    leaderboardSize: parsed.leaderboard?.length || 0,
    activeCount: parsed.active?.length || 0,
    queueSize: parsed.queue?.length || 0,
    insightsCount: parsed.insights?.length || 0,
    logSize: parsed.log?.length || 0,
    criterionKind: parsed.rankingCriterion?.kind || "unknown",
    benchmarkVersion: benchmark?.frontmatter?.version
      ? String(benchmark.frontmatter.version)
      : "",
    benchmarkStatus: benchmark?.frontmatter?.status
      ? String(benchmark.frontmatter.status)
      : "",
    hasBenchmark: Boolean(benchmark),
  };
}

async function summarizeProject(projectsDir, name) {
  const projectDir = path.join(projectsDir, name);
  const readmePath = path.join(projectDir, PROJECT_README);
  const readmeText = await readTextOrNull(readmePath);
  if (!readmeText) return null;

  let parsed;
  try {
    parsed = parseProjectReadme(readmeText);
  } catch {
    return null;
  }

  // The LOG lives in LOG.md; merge its rows into parsed.log so existing
  // call sites (logSize, latestLogDate) keep working.
  try {
    const logFile = await loadProjectLog(projectDir);
    parsed.log = logFile.rows;
  } catch {
    parsed.log = [];
  }

  let benchmark = null;
  try {
    benchmark = await loadBenchmark(projectDir);
  } catch {
    // Per-project endpoint will surface parse errors; the list endpoint
    // tolerates them so one bad bench doesn't 500 the whole dashboard.
  }

  const [hasPaper, hasResults] = await Promise.all([
    pathExists(path.join(projectDir, PAPER_FILE)),
    pathExists(path.join(projectDir, RESULTS_DIR)),
  ]);

  return {
    name,
    path: projectDir,
    goal: parsed.goal || "",
    ...projectExistsBucket(parsed, benchmark),
    hasPaper,
    hasResults,
    // Used for sorting: most-recent LOG date if any. Falls back to "" so
    // alpha sort kicks in for projects without a LOG.
    latestLogDate: parsed.log?.[0]?.date || "",
  };
}

export async function listProjects(libraryRoot) {
  const projectsDir = path.join(libraryRoot, "projects");
  const exists = await pathExists(projectsDir);
  if (!exists) return [];

  const entries = await readdir(projectsDir, { withFileTypes: true });
  const candidateNames = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);

  // Parallelize per-project I/O — at 50+ projects the sequential version
  // hits ~1s of latency that's pure stat/read serialization.
  const summaries = await Promise.all(
    candidateNames.map((name) => summarizeProject(projectsDir, name)),
  );
  const projects = summaries.filter(Boolean);

  // Sort: active moves first (most actionable), then most-recent LOG date,
  // then leaderboard size as a tiebreaker, then alphabetical.
  projects.sort((a, b) => {
    if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
    if (a.latestLogDate !== b.latestLogDate) {
      // ISO-ish dates sort lexicographically; empties go last.
      if (!a.latestLogDate) return 1;
      if (!b.latestLogDate) return -1;
      return b.latestLogDate.localeCompare(a.latestLogDate);
    }
    if (a.leaderboardSize !== b.leaderboardSize) return b.leaderboardSize - a.leaderboardSize;
    return a.name.localeCompare(b.name);
  });

  return projects;
}

function resultSlugFromPath(relPath) {
  return path.basename(String(relPath || ""), ".md");
}

function isSafeResultRelPath(relPath) {
  const normalized = String(relPath || "").replaceAll("\\", "/");
  return Boolean(
    normalized
      && !path.isAbsolute(normalized)
      && normalized.startsWith(`${RESULTS_DIR}/`)
      && normalized.endsWith(".md")
      && !normalized.includes("../"),
  );
}

async function loadResultDocs(projectDir, leaderboard, active, logRows = []) {
  // Gather a slim view of every result doc the dashboard may need: admitted
  // rows, active rows, LOG-linked resolved/falsified moves, and any remaining
  // result docs on disk. This keeps negative/non-admitted findings visible.
  const seen = new Set();
  const targets = [];
  const addTarget = (slug, relPath) => {
    const normalized = String(relPath || "").replaceAll("\\", "/");
    if (!isSafeResultRelPath(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    targets.push({ slug: slug || resultSlugFromPath(normalized), relPath: normalized });
  };

  for (const row of [...(leaderboard || []), ...(active || [])]) {
    addTarget(row.slug, row.resultPath);
  }
  for (const row of logRows || []) {
    if (!row.slug || !/^[A-Za-z0-9._-]+$/.test(row.slug)) continue;
    addTarget(row.slug, `${RESULTS_DIR}/${row.slug}.md`);
  }

  try {
    const entries = await readdir(path.join(projectDir, RESULTS_DIR), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      addTarget(resultSlugFromPath(entry.name), `${RESULTS_DIR}/${entry.name}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // Parallelized — at 5+ leaderboard rows + active rows the sequential version
  // added measurable latency to the per-project endpoint.
  const docs = await Promise.all(
    targets.map(async ({ slug, relPath }) => {
      const text = await readTextOrNull(path.join(projectDir, relPath));
      if (!text) return null;
      try {
        const doc = parseResultDoc(text);
        return {
          slug: slug || doc.title,
          path: relPath,
          title: doc.title,
          status: doc.status,
          takeaway: doc.takeaway,
          // Hypothesis is the pre-registered prior + falsifier. The dashboard
          // surfaces this for active moves so a glance shows what we'd be
          // disproving, not just what's been admitted.
          hypothesis: doc.hypothesis || "",
          question: doc.question || "",
          cycles: (doc.cycles || []).map((c) => ({
            index: c.index,
            sha: c.sha,
            kind: c.kind || "change",
            descriptor: c.descriptor || "",
          })),
          isBenchMove: Boolean(doc.isBenchMove),
          decision: doc.decision || "",
          frontmatter: doc.frontmatter || null,
        };
      } catch {
        return null;
      }
    }),
  );
  return docs.filter(Boolean);
}

function annotateLeaderboardWithBench(leaderboard, resultDocs, currentBenchVersion) {
  // For each leaderboard row, look up its result doc to find which bench
  // version it scored against, then mark stale if it differs from current.
  // The frontier-lab persona's most-load-bearing trust signal.
  return (leaderboard || []).map((row) => {
    const doc = resultDocs.find((d) => d.slug === row.slug);
    const cited = doc?.frontmatter?.benchmark_version
      ? String(doc.frontmatter.benchmark_version)
      : "";
    const fmMean = doc?.frontmatter?.mean;
    const fmStd = doc?.frontmatter?.std;
    let benchStaleness = "n/a";
    if (currentBenchVersion) {
      if (!cited) benchStaleness = "missing";
      else if (cited !== currentBenchVersion) benchStaleness = "stale";
      else benchStaleness = "current";
    }
    return {
      ...row,
      benchmarkVersionCited: cited,
      benchStaleness,
      mean: typeof fmMean === "number" ? fmMean : null,
      std: typeof fmStd === "number" ? fmStd : null,
    };
  });
}

export async function getProjectDetail(libraryRoot, projectName) {
  if (!/^[A-Za-z0-9._-]+$/.test(projectName)) {
    throw new Error(`invalid project name: ${projectName}`);
  }
  const projectDir = path.join(libraryRoot, "projects", projectName);
  if (!(await pathExists(projectDir))) {
    return null;
  }
  const readmeText = await readTextOrNull(path.join(projectDir, PROJECT_README));
  if (!readmeText) return null;

  const parsed = parseProjectReadme(readmeText);
  try {
    const logFile = await loadProjectLog(projectDir);
    parsed.log = logFile.rows;
  } catch {
    parsed.log = [];
  }
  const benchmark = await loadBenchmark(projectDir);
  const docs = await loadResultDocs(projectDir, parsed.leaderboard, parsed.active, parsed.log);

  let doctor = null;
  try {
    const report = await runDoctor(projectDir, { readmeText });
    const counts = severityCounts(report.issues);
    doctor = {
      bucket: doctorBucket(counts),
      counts,
      issues: report.issues,
    };
  } catch (error) {
    doctor = {
      bucket: "error",
      counts: { error: 1, warning: 0, info: 0 },
      issues: [{ severity: "error", code: "doctor_failed", where: "doctor", message: error.message }],
    };
  }

  const currentBenchVersion = benchmark?.frontmatter?.version
    ? String(benchmark.frontmatter.version)
    : "";
  const sweeps = await loadSweepSummaries(projectDir);
  const annotatedLeaderboard = annotateLeaderboardWithBench(
    parsed.leaderboard,
    docs,
    currentBenchVersion,
  );

  return {
    name: projectName,
    path: projectDir,
    goal: parsed.goal || "",
    codeRepo: parsed.codeRepo || null,
    rankingCriterion: parsed.rankingCriterion || null,
    successCriteria: parsed.successCriteria || [],
    leaderboard: annotatedLeaderboard,
    active: parsed.active || [],
    queue: parsed.queue || [],
    log: parsed.log || [],
    insights: parsed.insights || [],
    sweeps,
    benchmark: benchmark
      ? {
          version: benchmark.frontmatter?.version
            ? String(benchmark.frontmatter.version)
            : "",
          lastUpdated: benchmark.frontmatter?.last_updated || "",
          status: benchmark.frontmatter?.status || "",
          purpose: benchmark.purpose || "",
          metrics: benchmark.metrics || [],
          datasets: benchmark.datasets || [],
          rubrics: benchmark.rubrics || [],
          calibration: benchmark.calibration || [],
          contaminationChecks: benchmark.contaminationChecks || [],
          history: benchmark.history || [],
        }
      : null,
    resultDocs: docs,
    doctor,
    paths: {
      readme: PROJECT_README,
      paper: (await pathExists(path.join(projectDir, PAPER_FILE))) ? PAPER_FILE : null,
      benchmark: (await pathExists(path.join(projectDir, BENCHMARK_FILE))) ? BENCHMARK_FILE : null,
      figures: (await pathExists(path.join(projectDir, FIGURES_DIR))) ? FIGURES_DIR : null,
    },
  };
}

export const __internal = {
  severityCounts,
  doctorBucket,
  projectExistsBucket,
};
