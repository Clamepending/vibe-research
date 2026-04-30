import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { getBriefPath, readResearchState, updateResearchState } from "./brief.js";
import { runDoctor } from "./doctor.js";
import { judgeMove } from "./judge.js";
import { loadProjectLog, parseProjectReadme } from "./project-readme.js";

function trimString(value) {
  return String(value || "").trim();
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function command(parts) {
  return parts.map(shellQuote).join(" ");
}

function firstDoctorError(doctor) {
  return (doctor.issues || []).find((item) => item.severity === "error") || null;
}

function latestLogResultSlug(logRows = []) {
  for (const row of logRows) {
    const slug = trimString(row.slug);
    const event = trimString(row.event).toLowerCase();
    if (!slug || !/^[A-Za-z0-9._-]+$/.test(slug)) continue;
    if (event.includes("resolved") || event.includes("falsified") || event.includes("abandoned")) {
      return slug;
    }
  }
  return "";
}

async function latestExistingResultSlug(projectDir, parsed, logRows) {
  const candidates = [
    latestLogResultSlug(logRows),
    ...(parsed.leaderboard || []).map((row) => row.slug),
    ...(parsed.active || []).map((row) => row.slug),
  ].filter(Boolean);

  for (const slug of candidates) {
    if (await pathExists(path.join(projectDir, "results", `${slug}.md`))) {
      return slug;
    }
  }
  return "";
}

function recommendation(action, reason, extra = {}) {
  return { action, reason, ...extra };
}

export async function tickResearchOrchestrator({
  projectDir,
  apply = false,
  askHuman = false,
  waitHuman = false,
  agentTownApi = "",
  timeoutMs = "",
  allowCrossVersion = false,
  checkPaper = true,
  codeCwd = "",
  commandText = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!projectDir) throw new TypeError("projectDir is required");
  const resolvedProjectDir = path.resolve(projectDir);
  const readmePath = path.join(resolvedProjectDir, "README.md");
  const readmeText = await readFile(readmePath, "utf8");
  const parsed = parseProjectReadme(readmeText);
  const logFile = await loadProjectLog(resolvedProjectDir);
  const state = await readResearchState({ projectDir: resolvedProjectDir });
  const doctor = await runDoctor(resolvedProjectDir, { readmeText });
  const projectName = path.basename(resolvedProjectDir);
  const doctorError = firstDoctorError(doctor);

  let rec;
  let judge = null;
  let phaseUpdate = null;
  let nextCommand = "";

  if (doctorError) {
    rec = recommendation(
      "fix-doctor",
      `${doctorError.code}: ${doctorError.message}`,
      { severity: "error" },
    );
    nextCommand = command(["vr-research-doctor", resolvedProjectDir]);
  } else if ((parsed.active || []).length) {
    const row = parsed.active[0];
    rec = recommendation(
      "continue-active",
      `ACTIVE has ${row.slug}; continue or finish that move before claiming another.`,
      { slug: row.slug },
    );
    nextCommand = command([
      "vr-research-runner",
      resolvedProjectDir,
      "cycle",
      "--slug",
      row.slug,
      "--command",
      commandText || "<experiment-command>",
    ]);
  } else if ((parsed.queue || []).length) {
    const row = parsed.queue[0];
    rec = recommendation(
      "run-next",
      `QUEUE row 1 is ${row.slug}; claim it and run the next cycle.`,
      { slug: row.slug },
    );
    const parts = [
      "vr-research-runner",
      resolvedProjectDir,
      "run",
      "--slug",
      row.slug,
    ];
    if (codeCwd) parts.push("--cwd", codeCwd);
    parts.push("--command", commandText || "<experiment-command>");
    nextCommand = command(parts);
  } else if (["review", "synthesis"].includes(state.phase)) {
    const latestSlug = await latestExistingResultSlug(resolvedProjectDir, parsed, logFile.rows);
    if (latestSlug) {
      judge = await judgeMove({
        projectDir: resolvedProjectDir,
        slug: latestSlug,
        allowCrossVersion,
        checkPaper,
        askHuman,
        waitHuman,
        agentTownApi,
        timeoutMs,
        fetchImpl,
      });
      rec = recommendation(
        `judge-${judge.recommendation.action}`,
        judge.recommendation.reason,
        { slug: latestSlug, evaluatorStrength: judge.evaluatorStrength || "" },
      );
      nextCommand = command([
        "vr-research-judge",
        resolvedProjectDir,
        "--slug",
        latestSlug,
        "--ask-human",
      ]);
    } else {
      rec = recommendation(
        "brainstorm",
        "review phase has no resolved result to judge; create a grounded brief.",
      );
      nextCommand = command([
        "vr-research-brief",
        resolvedProjectDir,
        "create",
        "--slug",
        "next-brief",
        "--question",
        parsed.goal || "<question>",
      ]);
    }
  } else if (["experiment", "hillclimb"].includes(state.phase)) {
    rec = recommendation(
      "enter-review",
      "experiment phase has no ACTIVE or QUEUE rows; switch to review before inventing more moves.",
    );
    nextCommand = command(["vr-research-brief", resolvedProjectDir, "phase", "--phase", "review", "--summary", "queue exhausted"]);
    if (apply) {
      phaseUpdate = await updateResearchState({
        projectDir: resolvedProjectDir,
        phase: "review",
        briefSlug: state.briefSlug,
        summary: "orchestrator: queue exhausted",
      });
    }
  } else {
    const existingBriefPath = state.briefSlug ? getBriefPath(resolvedProjectDir, state.briefSlug) : "";
    const hasExistingBrief = existingBriefPath ? await pathExists(existingBriefPath) : false;
    if (hasExistingBrief) {
      rec = recommendation(
        "review-brief",
        `${state.phase} phase already has brief ${state.briefSlug}; review or compile it before claiming experiments.`,
        { briefSlug: state.briefSlug },
      );
      nextCommand = command([
        "vr-research-brief",
        resolvedProjectDir,
        "compile",
        "--slug",
        state.briefSlug,
      ]);
    } else {
      rec = recommendation(
        "create-brief",
        `${state.phase} phase needs a research brief before experiments should start.`,
      );
      nextCommand = command([
        "vr-research-brief",
        resolvedProjectDir,
        "create",
        "--slug",
        state.briefSlug || "next-brief",
        "--question",
        parsed.goal || "<question>",
        "--ask-human",
      ]);
    }
  }

  return {
    projectDir: resolvedProjectDir,
    projectName,
    phase: state,
    phaseUpdate: phaseUpdate?.state || null,
    doctor: {
      summary: doctor.summary,
      issues: doctor.issues,
    },
    counts: {
      active: (parsed.active || []).length,
      queue: (parsed.queue || []).length,
      leaderboard: (parsed.leaderboard || []).length,
      log: (logFile.rows || []).length,
    },
    recommendation: rec,
    nextCommand,
    judge,
  };
}

export function formatOrchestratorReport(report) {
  const lines = [
    `vr-research-orchestrator: ${report.projectName}`,
    `phase: ${report.phase.phase}${report.phase.briefSlug ? ` (${report.phase.briefSlug})` : ""}`,
    `state: active=${report.counts.active} queue=${report.counts.queue} leaderboard=${report.counts.leaderboard} log=${report.counts.log}`,
    `recommendation: ${report.recommendation.action} - ${report.recommendation.reason}`,
  ];

  if (report.phaseUpdate) {
    lines.push(`phase update: ${report.phaseUpdate.phase} - ${report.phaseUpdate.summary}`);
  }
  if (report.judge?.summary) {
    lines.push(`judge: ${report.judge.summary}`);
  }
  if (report.recommendation.evaluatorStrength) {
    lines.push(`evaluator: ${report.recommendation.evaluatorStrength}`);
  }
  if (report.judge?.review?.actionItem?.id) {
    lines.push(`agent-inbox: ${report.judge.review.actionItem.id}`);
  }
  if (report.nextCommand) {
    lines.push(`next: ${report.nextCommand}`);
  }
  return lines.join("\n");
}
