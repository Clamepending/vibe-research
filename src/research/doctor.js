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

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseProjectReadme } from "./project-readme.js";
import { parseResultDoc } from "./result-doc.js";

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

async function checkLeaderboard(projectDir, leaderboard) {
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
  }
  return issues;
}

async function checkActive(projectDir, active) {
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
  }
  return issues;
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

export async function runDoctor(projectDir, { readmeText } = {}) {
  const readmePath = path.join(projectDir, "README.md");
  let text = readmeText;
  if (text === undefined) {
    text = await readFile(readmePath, "utf8");
  }
  const parsed = parseProjectReadme(text);

  const issues = [];
  issues.push(...checkRankingCriterion(parsed.rankingCriterion));
  issues.push(...checkLeaderboardCap(parsed.leaderboard));
  issues.push(...await checkLeaderboard(projectDir, parsed.leaderboard));
  issues.push(...await checkActive(projectDir, parsed.active));
  issues.push(...checkQueue(parsed.queue));
  issues.push(...await checkInsights(projectDir, parsed.insights));
  issues.push(...await checkLog(projectDir, parsed.log));

  return {
    project: parsed,
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
