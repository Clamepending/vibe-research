// Lightweight judge for completed or in-flight Vibe Research moves.
//
// The judge is intentionally conservative: it audits existing artifacts and
// recommends the next action, but it does not mutate project state. Durable
// changes still flow through runner/resolve/brief/review tooling.

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { runAdmit, formatVerdict } from "./admit.js";
import { runDoctor, formatIssue } from "./doctor.js";
import { lintPaper, formatPaperIssue } from "./paper-lint.js";
import { parseProjectReadme } from "./project-readme.js";
import { parseResultDoc } from "./result-doc.js";

const REVIEW_CHOICES = ["continue", "rerun", "synthesize", "brainstorm", "steer"];
const SEVERITY_RANK = { error: 3, warning: 2, info: 1 };

function splitLines(text) {
  return String(text || "").replace(/\r\n/g, "\n").split("\n");
}

function trimText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sectionBody(text, name) {
  const lines = splitLines(text);
  const header = `## ${name}`.toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().toLowerCase() === header) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function isPlaceholder(body) {
  const text = trimText(body)
    .toLowerCase()
    .replace(/^[-*_`]+|[-*_`]+$/g, "")
    .trim();
  if (!text) return true;
  return [
    "pending",
    "none",
    "none yet",
    "not filled yet",
    "runner will record one command per cycle.",
  ].includes(text) || text.includes("not filled yet");
}

function issue(severity, code, where, message, source = "judge") {
  return { severity, code, where, message, source };
}

function countBySeverity(issues) {
  const out = { error: 0, warning: 0, info: 0 };
  for (const item of issues) {
    out[item.severity] = (out[item.severity] || 0) + 1;
  }
  return out;
}

function sortIssues(issues) {
  return [...issues].sort((a, b) => {
    const severityDelta = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
    if (severityDelta) return severityDelta;
    return String(a.where || "").localeCompare(String(b.where || ""));
  });
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resultCompletenessIssues({ doc, text, slug, project }) {
  const issues = [];
  const active = doc.status === "active";
  const resolved = doc.status === "resolved";
  const abandoned = doc.status === "abandoned";

  if (!["active", "resolved", "abandoned"].includes(doc.status)) {
    issues.push(issue("error", "result_status_invalid", `results/${slug}.md`, "STATUS must be active, resolved, or abandoned"));
  }
  if (!doc.question) {
    issues.push(issue("warning", "result_question_missing", `results/${slug}.md#Question`, "Question is empty"));
  }
  if (!doc.hypothesis) {
    issues.push(issue("warning", "result_hypothesis_missing", `results/${slug}.md#Hypothesis`, "Hypothesis is empty"));
  }
  if (!doc.cycles.length && !abandoned) {
    issues.push(issue(active ? "info" : "warning", "result_cycles_missing", `results/${slug}.md#Cycles`, "No cycles are recorded yet"));
  }

  const resultsBody = sectionBody(text, "Results");
  const analysisBody = sectionBody(text, "Analysis");
  const reproBody = sectionBody(text, "Reproducibility");
  const verdictBody = sectionBody(text, "Leaderboard verdict");
  const rankingKind = project.rankingCriterion?.kind || "";

  if (resolved) {
    if (isPlaceholder(doc.takeaway)) {
      issues.push(issue("warning", "result_takeaway_missing", `results/${slug}.md#TAKEAWAY`, "Resolved result has no takeaway"));
    }
    if (isPlaceholder(resultsBody)) {
      issues.push(issue("warning", "result_results_missing", `results/${slug}.md#Results`, "Resolved result has no concrete Results section"));
    }
    if (isPlaceholder(analysisBody)) {
      issues.push(issue("warning", "result_analysis_missing", `results/${slug}.md#Analysis`, "Resolved result has no Analysis section"));
    }
    if (isPlaceholder(reproBody)) {
      issues.push(issue("warning", "result_repro_missing", `results/${slug}.md#Reproducibility`, "Resolved result has no reproducibility record"));
    }
    if (!/^decision\s*:/im.test(verdictBody)) {
      issues.push(issue("warning", "result_decision_missing", `results/${slug}.md#Leaderboard verdict`, "Resolved result has no Decision line"));
    }
    if (rankingKind === "quantitative" && !doc.frontmatter) {
      issues.push(issue("error", "result_quant_frontmatter_missing", `results/${slug}.md`, "Quantitative project result is missing mean/std YAML frontmatter"));
    }
  }

  return issues;
}

function normalizeExternalIssue(item, source, formatter) {
  return {
    severity: item.severity || "warning",
    code: item.code || `${source}_issue`,
    where: item.where || item.location || source,
    message: item.message || formatter?.(item) || String(item),
    source,
    raw: item,
  };
}

function recommendationFromReport({ doc, issues, admitReport }) {
  const hasError = issues.some((item) => item.severity === "error");
  const hasPaperError = issues.some((item) => item.source === "paper" && item.severity === "error");
  const hasDoctorError = issues.some((item) => item.source === "doctor" && item.severity === "error");
  const missingNoise = issues.some((item) => item.code === "result_quant_frontmatter_missing" || item.code === "admit_blocked");

  if (doc.status === "active") {
    if (!doc.cycles.length) {
      return {
        action: "continue",
        reason: "move is claimed but has no cycles yet",
      };
    }
    if (hasDoctorError || hasError) {
      return {
        action: "rerun",
        reason: "active move has blocking audit issues before it should be synthesized",
      };
    }
    return {
      action: "continue",
      reason: "active move has cycle evidence and no blocking audit issue",
    };
  }

  if (doc.status === "abandoned") {
    return {
      action: "brainstorm",
      reason: "move is abandoned; choose a replacement or revised question",
    };
  }

  if (missingNoise) {
    return {
      action: "rerun",
      reason: "admission is blocked by missing or incompatible quantitative evidence",
    };
  }
  if (hasPaperError || hasDoctorError || hasError) {
    return {
      action: "synthesize",
      reason: "fix ledger/paper/provenance issues before using the result",
    };
  }
  if (admitReport?.decision?.admit) {
    return {
      action: "synthesize",
      reason: "candidate beats the leaderboard and should be written into the narrative",
    };
  }
  if (admitReport?.decision?.bench) {
    return {
      action: "synthesize",
      reason: "benchmark change needs paper/ledger synthesis rather than leaderboard admission",
    };
  }
  return {
    action: "brainstorm",
    reason: "result is resolved but did not displace the leaderboard; plan the next move",
  };
}

function summarizeJudge({ slug, doc, issues, admitReport, paperReport, recommendation }) {
  const counts = countBySeverity(issues);
  const statusPart = doc.status ? `status=${doc.status}` : "status=unknown";
  const cyclePart = `${doc.cycles.length} cycle${doc.cycles.length === 1 ? "" : "s"}`;
  const admitPart = admitReport?.decision
    ? `admit=${admitReport.decision.admit ? "yes" : admitReport.decision.blocked ? "blocked" : "no"}`
    : "admit=skipped";
  const paperPart = paperReport
    ? `paper=${paperReport.summary.error}/${paperReport.summary.warning}/${paperReport.summary.info}`
    : "paper=skipped";
  return `${slug}: ${recommendation.action} (${recommendation.reason}); ${statusPart}, ${cyclePart}, ${admitPart}, ${paperPart}, issues=${counts.error}/${counts.warning}/${counts.info}`;
}

async function postJson(fetchImpl, url, body) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `${response.status} ${response.statusText}`.trim());
  }
  return payload;
}

async function createJudgeCard({
  api,
  projectDir,
  slug,
  resultPath,
  paperPath,
  summary,
  recommendation,
  issues,
  waitHuman = false,
  timeoutMs = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  const endpoint = String(api || "").trim().replace(/\/+$/, "");
  if (!endpoint) return { skipped: true, reason: "Agent Town API is not configured" };
  if (typeof fetchImpl !== "function") return { skipped: true, reason: "fetch is unavailable" };

  const topIssues = sortIssues(issues).slice(0, 4);
  const body = {
    id: `research-judge-${slug}`,
    kind: "review",
    priority: topIssues.some((item) => item.severity === "error") ? "high" : "normal",
    title: `Judge ${slug}: ${recommendation.action}`,
    detail: summary,
    recommendation: `Recommended next action: ${recommendation.action}. ${recommendation.reason}.`,
    consequence: "Your click steers the next research phase without changing the project ledger by itself.",
    source: "research-judge",
    href: "?view=agent-inbox",
    cta: "Review",
    target: {
      type: "file",
      id: resultPath,
      label: path.basename(resultPath),
      projectName: path.basename(path.resolve(projectDir)),
      action: "review-research-move",
    },
    evidence: [
      { label: "result doc", path: resultPath, kind: "result" },
      { label: "project README", path: path.join(projectDir, "README.md"), kind: "project" },
      ...(paperPath ? [{ label: "paper", path: paperPath, kind: "paper" }] : []),
      ...topIssues.map((item) => ({
        label: `${item.severity}: ${item.code}`,
        kind: "audit",
        text: `${item.where}: ${item.message}`,
      })),
    ],
    choices: REVIEW_CHOICES,
    capabilityIds: ["research-judge", "human-in-the-loop", "artifact-review"],
  };

  const created = await postJson(fetchImpl, `${endpoint}/action-items`, body);
  let wait = null;
  if (waitHuman) {
    wait = await postJson(fetchImpl, `${endpoint}/wait`, {
      predicate: "action_item_resolved",
      predicateParams: { actionItemId: created.actionItem?.id || body.id },
      timeoutMs,
    });
  }
  return { actionItem: created.actionItem || created, wait };
}

export async function judgeMove({
  projectDir,
  slug,
  resultPath = "",
  allowCrossVersion = false,
  checkPaper = true,
  askHuman = false,
  waitHuman = false,
  agentTownApi = "",
  timeoutMs = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!projectDir) throw new TypeError("projectDir is required");
  if (!slug && !resultPath) throw new TypeError("slug or resultPath is required");

  const resolvedProjectDir = path.resolve(projectDir);
  const resultRelativePath = resultPath
    ? (path.isAbsolute(resultPath) ? path.relative(resolvedProjectDir, resultPath) : resultPath)
    : `results/${slug}.md`;
  const resolvedResultPath = path.resolve(resolvedProjectDir, resultRelativePath);
  const inferredSlug = slug || path.basename(resolvedResultPath, path.extname(resolvedResultPath));
  const resultText = await readFile(resolvedResultPath, "utf8");
  const readmeText = await readFile(path.join(resolvedProjectDir, "README.md"), "utf8");
  const project = parseProjectReadme(readmeText);
  const doc = parseResultDoc(resultText);

  const issues = [];
  issues.push(...resultCompletenessIssues({
    doc,
    text: resultText,
    slug: inferredSlug,
    project,
  }));

  const doctorReport = await runDoctor(resolvedProjectDir, { readmeText });
  issues.push(...doctorReport.issues.map((item) => normalizeExternalIssue(item, "doctor", formatIssue)));

  let admitReport = null;
  let admitText = "";
  if (doc.status && doc.status !== "active") {
    try {
      admitReport = await runAdmit({
        projectDir: resolvedProjectDir,
        candidateResultPath: resultRelativePath,
        allowCrossVersion,
      });
      admitText = formatVerdict(admitReport);
      if (admitReport.decision?.blocked) {
        issues.push(issue("error", "admit_blocked", resultRelativePath, admitReport.decision.reason, "admit"));
      }
    } catch (error) {
      issues.push(issue("error", "admit_exception", resultRelativePath, error.message, "admit"));
    }
  }

  const paperPath = path.join(resolvedProjectDir, "paper.md");
  let paperReport = null;
  let paperSkippedReason = "";
  if (checkPaper) {
    if (await pathExists(paperPath)) {
      paperReport = await lintPaper(resolvedProjectDir);
      issues.push(...paperReport.issues.map((item) => normalizeExternalIssue(item, "paper", formatPaperIssue)));
    } else {
      paperSkippedReason = "paper.md not found";
    }
  } else {
    paperSkippedReason = "disabled";
  }

  const sortedIssues = sortIssues(issues);
  const recommendation = recommendationFromReport({ doc, issues, admitReport });
  const summary = summarizeJudge({
    slug: inferredSlug,
    doc,
    issues,
    admitReport,
    paperReport,
    recommendation,
  });

  const review = askHuman
    ? await createJudgeCard({
      api: agentTownApi || process.env.VIBE_RESEARCH_AGENT_TOWN_API || "",
      projectDir: resolvedProjectDir,
      slug: inferredSlug,
      resultPath: resolvedResultPath,
      paperPath: paperReport ? paperPath : "",
      summary,
      recommendation,
      issues: sortedIssues,
      waitHuman,
      timeoutMs,
      fetchImpl,
    })
    : null;

  return {
    projectDir: resolvedProjectDir,
    slug: inferredSlug,
    resultPath: resolvedResultPath,
    resultRelativePath,
    status: doc.status,
    cycles: doc.cycles,
    recommendation,
    summary,
    issues: sortedIssues,
    issueSummary: countBySeverity(issues),
    doctor: {
      summary: doctorReport.summary,
      issues: doctorReport.issues,
    },
    admit: admitReport
      ? {
        decision: admitReport.decision,
        criterionKind: admitReport.criterionKind,
        candidateQuant: admitReport.candidateQuant || null,
        candidateBenchVersion: admitReport.candidateBenchVersion || "",
        currentBenchVersion: admitReport.currentBenchVersion || "",
        text: admitText,
      }
      : null,
    paper: paperReport
      ? { summary: paperReport.summary, issues: paperReport.issues, path: paperPath }
      : { skipped: true, reason: paperSkippedReason },
    review: review?.skipped ? null : review,
    reviewSkippedReason: review?.skipped ? review.reason : "",
  };
}

export function formatJudgeReport(report) {
  const lines = [
    `vr-research-judge: ${report.slug}`,
    `recommendation: ${report.recommendation.action} - ${report.recommendation.reason}`,
    `summary: ${report.summary}`,
  ];

  if (report.admit?.text) {
    lines.push("", "admission:", ...report.admit.text.split("\n").map((line) => `  ${line}`));
  }

  if (report.issues.length) {
    lines.push("", "issues:");
    for (const item of report.issues.slice(0, 12)) {
      lines.push(`- [${item.severity}] ${item.source}:${item.code} ${item.where} - ${item.message}`);
    }
    if (report.issues.length > 12) {
      lines.push(`- ... ${report.issues.length - 12} more issues`);
    }
  } else {
    lines.push("", "issues: none");
  }

  if (report.review) {
    const item = report.review.actionItem || report.review;
    lines.push("", `agent-inbox: ${item.id || "created"}`);
  } else if (report.reviewSkippedReason) {
    lines.push("", `agent-inbox: skipped - ${report.reviewSkippedReason}`);
  }

  return lines.join("\n");
}

export const __internal = {
  REVIEW_CHOICES,
  resultCompletenessIssues,
  sectionBody,
  isPlaceholder,
  recommendationFromReport,
};
