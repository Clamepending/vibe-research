import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { compileBriefToQueue, getBriefPath, readResearchBrief, readResearchState, updateResearchState } from "./brief.js";
import { createBriefReviewCard, getActionItemFromWait, waitForBriefReview } from "./brief-review.js";
import { runDoctor } from "./doctor.js";
import { judgeMove } from "./judge.js";
import { loadProjectLog, parseProjectReadme } from "./project-readme.js";
import { loadSweepSummaries, sweepHasRunnableRows } from "./sweep-status.js";

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

function sweepNameForCommand(sweep) {
  return sweep?.path && sweep.path.startsWith("runs/")
    ? path.basename(sweep.path, ".tsv")
    : "";
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
  const libraryRoot = path.dirname(path.dirname(resolvedProjectDir));
  const doctorError = firstDoctorError(doctor);
  const sweeps = await loadSweepSummaries(resolvedProjectDir);

  let rec;
  let judge = null;
  let briefCompile = null;
  let briefReview = null;
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
  } else if (["experiment", "hillclimb"].includes(state.phase) && sweeps.some(sweepHasRunnableRows)) {
    const sweep = sweeps.find(sweepHasRunnableRows);
    const runnable = (sweep.statusCounts.planned || 0) + (sweep.statusCounts.running || 0) + (sweep.statusCounts.failed || 0);
    const sweepName = sweepNameForCommand(sweep);
    rec = recommendation(
      "run-sweep",
      `${sweep.name} has ${runnable} runnable row${runnable === 1 ? "" : "s"}; continue the sweep before entering review.`,
      { sweep: sweep.name, sweepPath: sweep.path, runnableRows: runnable },
    );
    const parts = [
      "vr-rl-sweep",
      "run",
      projectName,
      "--library",
      libraryRoot,
    ];
    if (sweepName) parts.push("--sweep-name", sweepName);
    if (codeCwd) parts.push("--cwd", codeCwd);
    if (commandText) parts.push("--launcher", commandText);
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
        {
          slug: latestSlug,
          evaluatorStrength: judge.evaluatorStrength || "",
          nextCandidates: (judge.queueUpdates || []).filter((item) => item.verb === "add").length,
        },
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
      if (askHuman) {
        const briefResult = await readResearchBrief({
          projectDir: resolvedProjectDir,
          slug: state.briefSlug,
        });
        const review = await createBriefReviewCard({
          agentTownApi,
          projectDir: resolvedProjectDir,
          brief: briefResult.brief,
          briefPath: briefResult.briefPath,
          fetchImpl,
        });
        let wait = null;
        let resolution = "";
        const actionItemId = review.actionItem?.id || `research-brief-${briefResult.brief.slug}`;
        if (waitHuman) {
          wait = await waitForBriefReview({
            agentTownApi,
            actionItemId,
            timeoutMs,
            fetchImpl,
          });
          resolution = getActionItemFromWait(wait, actionItemId)?.resolution || "";
        }
        briefReview = {
          actionItem: review.actionItem || null,
          wait,
          resolution,
        };
      }
      const humanGateAllowsCompile = !askHuman || !waitHuman || briefReview?.resolution === "approved";
      if (apply && humanGateAllowsCompile) {
        briefCompile = await compileBriefToQueue({
          projectDir: resolvedProjectDir,
          slug: state.briefSlug,
        });
        phaseUpdate = await updateResearchState({
          projectDir: resolvedProjectDir,
          phase: "experiment",
          briefSlug: briefCompile.brief.slug,
          summary: `orchestrator: compiled ${briefCompile.queueRows.length} move(s) from brief ${briefCompile.brief.slug}`,
        });
      }
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
    briefReview,
    briefCompile: briefCompile
      ? {
        briefSlug: briefCompile.brief.slug,
        queueRows: briefCompile.queueRows,
        compiled: briefCompile.compiled,
      }
      : null,
    doctor: {
      summary: doctor.summary,
      issues: doctor.issues,
    },
    counts: {
      active: (parsed.active || []).length,
      queue: (parsed.queue || []).length,
      leaderboard: (parsed.leaderboard || []).length,
      log: (logFile.rows || []).length,
      sweeps: sweeps.length,
    },
    sweeps,
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
  if (report.briefCompile) {
    lines.push(`brief compile: ${report.briefCompile.briefSlug} -> ${report.briefCompile.queueRows.length} queue row(s)`);
  }
  if (report.briefReview?.actionItem?.id) {
    lines.push(`brief review: ${report.briefReview.actionItem.id}`);
  }
  if (report.judge?.summary) {
    lines.push(`judge: ${report.judge.summary}`);
  }
  if (report.recommendation.evaluatorStrength) {
    lines.push(`evaluator: ${report.recommendation.evaluatorStrength}`);
  }
  if (report.recommendation.nextCandidates) {
    lines.push(`next candidates: ${report.recommendation.nextCandidates}`);
  }
  if (report.judge?.review?.actionItem?.id) {
    lines.push(`agent-inbox: ${report.judge.review.actionItem.id}`);
  }
  if (report.nextCommand) {
    lines.push(`next: ${report.nextCommand}`);
  }
  return lines.join("\n");
}
