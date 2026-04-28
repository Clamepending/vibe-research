// vr-research admit — apply the leaderboard admission rule mechanically.
//
// For quantitative or mix-quant criteria the rule needs `metric_mean` and
// `metric_std` from each result doc's YAML frontmatter. We refuse to declare
// a winner without them — an undeclared noise estimate makes the admission
// rule meaningless. Qualitative comparisons fall back to the result doc's
// `Decision:` line and per-rank verdicts inside `Leaderboard verdict`.
//
// Output: a structured admission verdict the CLI can print or pipe into a
// review pass.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseProjectReadme } from "./project-readme.js";
import { parseResultDoc } from "./result-doc.js";
import { loadBenchmark, benchmarkMetricNames } from "./benchmark.js";

const DEFAULT_NOISE_MULTIPLIER = 2;

function quantFromFrontmatter(frontmatter) {
  if (!frontmatter || typeof frontmatter !== "object") return null;
  const mean = Number(frontmatter.mean);
  const std = Number(frontmatter.std);
  if (!Number.isFinite(mean) || !Number.isFinite(std) || std < 0) return null;
  return {
    metric: String(frontmatter.metric || "metric"),
    higherIsBetter: frontmatter.metric_higher_is_better !== false,
    seeds: Array.isArray(frontmatter.seeds) ? frontmatter.seeds.slice() : [],
    mean,
    std,
    noiseMultiplier: Number(frontmatter.noise_multiplier) || DEFAULT_NOISE_MULTIPLIER,
  };
}

function compareQuant(candidate, incumbent) {
  if (!candidate || !incumbent) return "incomparable";
  const radius = incumbent.noiseMultiplier * incumbent.std;
  if (candidate.higherIsBetter) {
    if (candidate.mean - incumbent.mean > radius) return "better";
    if (incumbent.mean - candidate.mean > radius) return "worse";
    return "within-noise";
  }
  if (incumbent.mean - candidate.mean > radius) return "better";
  if (candidate.mean - incumbent.mean > radius) return "worse";
  return "within-noise";
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

async function loadLeaderboardWithDocs(projectDir, leaderboard) {
  const out = [];
  for (const row of leaderboard) {
    const doc = await loadResultDoc(projectDir, row.resultPath);
    out.push({ row, doc });
  }
  return out;
}

function benchmarkVersionFromDoc(doc) {
  return doc?.frontmatter?.benchmark_version
    ? String(doc.frontmatter.benchmark_version)
    : "";
}

function buildVerdictRows(criterionKind, candidateQuant, leaderboardWithDocs, options = {}) {
  const {
    candidateBenchVersion = "",
    currentBenchVersion = "",
    allowCrossVersion = false,
    benchmarkPresent = false,
  } = options;
  const rows = [];
  for (const { row, doc } of leaderboardWithDocs) {
    const incumbentBenchVersion = benchmarkVersionFromDoc(doc);

    // Legacy incumbent: project has a benchmark.md but this incumbent's result
    // doc has no `benchmark_version`. The comparison is meaningless because we
    // don't know which rubric/version the score was measured against. Treat
    // exactly like a cross-version block, NOT a silent same-version match.
    if (benchmarkPresent && !incumbentBenchVersion && !allowCrossVersion) {
      rows.push({
        rank: row.rank,
        slug: row.slug,
        comparison: "legacy-incumbent",
        detail: `vs rank ${row.rank} (${row.slug}): incumbent has no benchmark_version (legacy result doc); comparison is undefined — re-run the incumbent on ${currentBenchVersion || "the current bench"} or pass --allow-cross-version`,
      });
      continue;
    }

    if (
      currentBenchVersion
      && candidateBenchVersion
      && incumbentBenchVersion
      && candidateBenchVersion !== incumbentBenchVersion
      && !allowCrossVersion
    ) {
      rows.push({
        rank: row.rank,
        slug: row.slug,
        comparison: "cross-version",
        detail: `vs rank ${row.rank} (${row.slug}): cross-version comparison blocked (candidate=${candidateBenchVersion}, incumbent=${incumbentBenchVersion}); rerun on ${currentBenchVersion} or pass --allow-cross-version`,
      });
      continue;
    }
    if (criterionKind === "quantitative" && candidateQuant) {
      const incumbentQuant = quantFromFrontmatter(doc?.frontmatter);
      if (!incumbentQuant) {
        rows.push({
          rank: row.rank,
          slug: row.slug,
          comparison: "missing-frontmatter",
          detail: `rank ${row.rank} (${row.slug}) result doc has no quantitative frontmatter (mean/std)`,
        });
        continue;
      }
      const result = compareQuant(candidateQuant, incumbentQuant);
      rows.push({
        rank: row.rank,
        slug: row.slug,
        comparison: result,
        detail: `vs rank ${row.rank} (${row.slug}): ${result} on ${incumbentQuant.metric} (this: ${candidateQuant.mean}, rank: ${incumbentQuant.mean} ± ${incumbentQuant.noiseMultiplier}×${incumbentQuant.std})`,
      });
    } else {
      rows.push({
        rank: row.rank,
        slug: row.slug,
        comparison: "manual",
        detail: `vs rank ${row.rank} (${row.slug}): manual qualitative judgement required`,
      });
    }
  }
  return rows;
}

function decideAdmission(verdictRows) {
  for (const row of verdictRows) {
    if (row.comparison === "better") {
      return { admit: true, atRank: row.rank, reason: `beats rank ${row.rank} (${row.slug})` };
    }
    if (row.comparison === "missing-frontmatter") {
      return {
        admit: false,
        reason: row.detail,
        blocked: true,
      };
    }
    if (row.comparison === "cross-version") {
      return {
        admit: false,
        reason: row.detail,
        blocked: true,
      };
    }
    if (row.comparison === "legacy-incumbent") {
      return {
        admit: false,
        reason: row.detail,
        blocked: true,
      };
    }
  }
  return {
    admit: false,
    reason: "did not beat any current leaderboard row",
    blocked: false,
  };
}

export async function runAdmit({ projectDir, candidateResultPath, allowCrossVersion = false }) {
  const readmePath = path.join(projectDir, "README.md");
  const readmeText = await readFile(readmePath, "utf8");
  const project = parseProjectReadme(readmeText);

  const candidate = await loadResultDoc(projectDir, candidateResultPath);
  if (!candidate) {
    throw new Error(`candidate result doc not found at ${candidateResultPath}`);
  }
  const candidateQuant = quantFromFrontmatter(candidate.frontmatter);

  const criterionKind = project.rankingCriterion?.kind || "unknown";

  const benchmark = await loadBenchmark(projectDir);
  const candidateBenchVersion = benchmarkVersionFromDoc(candidate);
  const currentBenchVersion = benchmark?.frontmatter?.version
    ? String(benchmark.frontmatter.version)
    : "";
  const benchStatus = benchmark?.frontmatter?.status
    ? String(benchmark.frontmatter.status).toLowerCase()
    : "";

  // Bench-move carve-out: a result doc whose cycles are all/some `bench` kind
  // is installing a new benchmark version, not competing on the leaderboard.
  // Admission for a bench move is judged on coverage and rater agreement,
  // which the doctor / validateBenchmark cover — admit just acknowledges and
  // returns a clean non-admission verdict.
  if (candidate.isBenchMove) {
    return {
      candidate,
      project,
      benchmark,
      candidateBenchVersion,
      currentBenchVersion,
      verdictRows: [],
      decision: {
        admit: false,
        blocked: false,
        bench: true,
        reason: `bench-bump move (no leaderboard admission); coverage and rater agreement are checked by vr-research-doctor against benchmark.md, not by admit`,
      },
      criterionKind,
    };
  }

  if (benchmark && benchStatus === "frozen") {
    return {
      candidate,
      project,
      benchmark,
      candidateBenchVersion,
      currentBenchVersion,
      verdictRows: [],
      decision: {
        admit: false,
        blocked: true,
        reason: `benchmark.md status is "frozen" at ${currentBenchVersion || "(unknown version)"}; admission against a frozen bench is not allowed — bump to a new version (active) or unfreeze`,
      },
      criterionKind,
    };
  }

  if (benchmark && !candidateBenchVersion) {
    return {
      candidate,
      project,
      benchmark,
      candidateBenchVersion,
      currentBenchVersion,
      verdictRows: [],
      decision: {
        admit: false,
        blocked: true,
        reason: "project has benchmark.md but candidate result doc frontmatter is missing benchmark_version",
      },
      criterionKind,
    };
  }

  if (benchmark) {
    const benchMetrics = benchmarkMetricNames(benchmark);
    const candidateMetric = candidate.frontmatter?.metric ? String(candidate.frontmatter.metric) : "";
    if (benchMetrics.size && candidateMetric && !benchMetrics.has(candidateMetric)) {
      return {
        candidate,
        project,
        benchmark,
        candidateBenchVersion,
        currentBenchVersion,
        verdictRows: [],
        decision: {
          admit: false,
          blocked: true,
          reason: `candidate metric="${candidateMetric}" is not declared in benchmark.md METRICS (${[...benchMetrics].join(", ")})`,
        },
        criterionKind,
      };
    }
    if (benchMetrics.size && !candidateMetric) {
      return {
        candidate,
        project,
        benchmark,
        candidateBenchVersion,
        currentBenchVersion,
        verdictRows: [],
        decision: {
          admit: false,
          blocked: true,
          reason: "project has benchmark.md but candidate result doc frontmatter has no `metric` — must match a row in METRICS",
        },
        criterionKind,
      };
    }
  }

  if (
    benchmark
    && currentBenchVersion
    && candidateBenchVersion
    && candidateBenchVersion !== currentBenchVersion
    && !allowCrossVersion
  ) {
    return {
      candidate,
      project,
      benchmark,
      candidateBenchVersion,
      currentBenchVersion,
      verdictRows: [],
      decision: {
        admit: false,
        blocked: true,
        reason: `candidate cites benchmark_version=${candidateBenchVersion} but the current bench is ${currentBenchVersion}; rerun on the current bench or pass --allow-cross-version`,
      },
      criterionKind,
    };
  }

  if (criterionKind === "quantitative" && !candidateQuant) {
    return {
      candidate,
      project,
      benchmark,
      candidateBenchVersion,
      currentBenchVersion,
      verdictRows: [],
      decision: {
        admit: false,
        blocked: true,
        reason:
          "ranking criterion is quantitative but the candidate result doc has no YAML frontmatter with mean/std",
      },
      criterionKind,
    };
  }

  const leaderboardWithDocs = await loadLeaderboardWithDocs(projectDir, project.leaderboard);
  const verdictRows = buildVerdictRows(criterionKind, candidateQuant, leaderboardWithDocs, {
    candidateBenchVersion,
    currentBenchVersion,
    allowCrossVersion,
    benchmarkPresent: Boolean(benchmark),
  });
  const decision = decideAdmission(verdictRows);

  return {
    candidate,
    candidateQuant,
    candidateBenchVersion,
    currentBenchVersion,
    project,
    benchmark,
    verdictRows,
    decision,
    criterionKind,
  };
}

export function formatVerdict(report) {
  const lines = [];
  if (report.candidateQuant) {
    const cq = report.candidateQuant;
    lines.push(
      `candidate: ${cq.metric}=${cq.mean} ± ${cq.noiseMultiplier}×${cq.std} (${cq.higherIsBetter ? "higher is better" : "lower is better"}, ${cq.seeds.length} seeds)`,
    );
  } else {
    lines.push(`candidate: ${report.candidate?.title || ""} (criterion: ${report.criterionKind})`);
  }
  if (report.benchmark) {
    lines.push(
      `benchmark: ${report.currentBenchVersion || "?"}${
        report.candidateBenchVersion && report.candidateBenchVersion !== report.currentBenchVersion
          ? ` (candidate cites ${report.candidateBenchVersion})`
          : ""
      }`,
    );
  }
  for (const row of report.verdictRows) {
    lines.push(`  ${row.detail}`);
  }
  if (report.decision.admit) {
    lines.push(`Decision: admit at rank ${report.decision.atRank} — ${report.decision.reason}`);
  } else if (report.decision.bench) {
    lines.push(`Decision: bench-bump (no leaderboard admission) — ${report.decision.reason}`);
  } else if (report.decision.blocked) {
    lines.push(`Decision: BLOCKED — ${report.decision.reason}`);
  } else {
    lines.push(`Decision: do not admit — ${report.decision.reason}`);
  }
  return lines.join("\n");
}

export const __internal = {
  quantFromFrontmatter,
  compareQuant,
  buildVerdictRows,
  decideAdmission,
};
