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

function buildVerdictRows(criterionKind, candidateQuant, leaderboardWithDocs) {
  const rows = [];
  for (const { row, doc } of leaderboardWithDocs) {
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
  }
  return {
    admit: false,
    reason: "did not beat any current leaderboard row",
    blocked: false,
  };
}

export async function runAdmit({ projectDir, candidateResultPath }) {
  const readmePath = path.join(projectDir, "README.md");
  const readmeText = await readFile(readmePath, "utf8");
  const project = parseProjectReadme(readmeText);

  const candidate = await loadResultDoc(projectDir, candidateResultPath);
  if (!candidate) {
    throw new Error(`candidate result doc not found at ${candidateResultPath}`);
  }
  const candidateQuant = quantFromFrontmatter(candidate.frontmatter);

  const criterionKind = project.rankingCriterion?.kind || "unknown";

  if (criterionKind === "quantitative" && !candidateQuant) {
    return {
      candidate,
      project,
      verdictRows: [],
      decision: {
        admit: false,
        blocked: true,
        reason:
          "ranking criterion is quantitative but the candidate result doc has no YAML frontmatter with mean/std",
      },
    };
  }

  const leaderboardWithDocs = await loadLeaderboardWithDocs(projectDir, project.leaderboard);
  const verdictRows = buildVerdictRows(criterionKind, candidateQuant, leaderboardWithDocs);
  const decision = decideAdmission(verdictRows);

  return {
    candidate,
    candidateQuant,
    project,
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
  for (const row of report.verdictRows) {
    lines.push(`  ${row.detail}`);
  }
  if (report.decision.admit) {
    lines.push(`Decision: admit at rank ${report.decision.atRank} — ${report.decision.reason}`);
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
