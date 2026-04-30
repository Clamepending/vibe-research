import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { compileBriefToQueue, createResearchBrief, getBriefPath, readResearchBrief, readResearchState, updateResearchState } from "./brief.js";
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

function normalizeSlug(value, fallback = "next") {
  return trimString(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
}

function uniqueSlug(base, used = new Set()) {
  const root = normalizeSlug(base);
  let slug = root;
  let index = 2;
  while (used.has(slug)) {
    slug = `${root}-${index}`;
    index += 1;
  }
  used.add(slug);
  return slug;
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

function defaultStartingPoint(parsed) {
  const topBranch = trimString(parsed?.leaderboard?.[0]?.branchUrl || "");
  if (topBranch) return topBranch;
  const codeRepo = trimString(parsed?.codeRepo?.url || "").replace(/\.git$/i, "").replace(/\/+$/g, "");
  return codeRepo ? `${codeRepo}/tree/main` : "main";
}

function usedMoveSlugs(parsed, logRows = []) {
  return new Set([
    ...(parsed?.queue || []).map((row) => row.slug),
    ...(parsed?.active || []).map((row) => row.slug),
    ...(parsed?.leaderboard || []).map((row) => row.slug),
    ...logRows.map((row) => row.slug),
  ].filter(Boolean).map((slug) => normalizeSlug(slug)));
}

function buildPlannerBriefDraft({ parsed, logRows = [], projectName, state, briefSlug = "" } = {}) {
  const used = usedMoveSlugs(parsed, logRows);
  const ranking = trimString(parsed?.rankingCriterion?.raw || parsed?.rankingCriterion?.description || "");
  const isQuantitative = /^(quantitative|mix)$/i.test(parsed?.rankingCriterion?.kind || "");
  const hasPriorResult = Boolean(
    (parsed?.leaderboard || []).length
      || logRows.some((row) => /resolved|falsified|abandoned/i.test(row.event || "")),
  );
  const latestResult = logRows.find((row) => row.slug && /resolved|falsified|abandoned/i.test(row.event || ""));
  const moveBase = hasPriorResult
    ? (isQuantitative ? "noise-rerun" : "artifact-audit")
    : "baseline-characterization";
  const moveSlug = uniqueSlug(moveBase, used);
  const slug = normalizeSlug(briefSlug || state?.briefSlug || "next-brief", "next-brief");
  const startingPoint = defaultStartingPoint(parsed);
  const success = (parsed?.successCriteria || []).slice(0, 3);
  const grounding = [
    parsed?.goal ? `Project goal: ${parsed.goal}` : "",
    ranking ? `Ranking criterion: ${ranking}` : "",
    ...success.map((line) => `Success criterion: ${line}`),
    latestResult?.slug
      ? `Latest logged result: ${latestResult.slug} (${latestResult.event}) - ${latestResult.summary || "no summary"}`
      : "",
  ].filter(Boolean);

  return {
    slug,
    phase: "move-design",
    title: `${projectName} next move`,
    question: hasPriorResult
      ? `What follow-up should test whether the current ${projectName} result is stable enough to guide the next hillclimb?`
      : `What first experiment should establish a trustworthy baseline for ${projectName}?`,
    currentTheory: hasPriorResult
      ? "The project has at least one logged result, so the next move should tighten evaluator confidence or inspect the most important failure mode before widening the search."
      : "The project needs a small reproducible baseline with durable artifacts before autonomous hillclimbing can make reliable comparisons.",
    grounding: grounding.length ? grounding : ["No prior project evidence found; keep the first move conservative and cheap."],
    candidateMoves: [
      {
        move: moveSlug,
        startingPoint,
        why: hasPriorResult
          ? (isQuantitative
              ? "Estimate variance and stability before promoting a new direction."
              : "Audit representative artifacts against the ranking criterion before changing the method.")
          : "Create the first reproducible baseline, artifact, and provenance record.",
        hypothesis: hasPriorResult
          ? "A focused confidence check will make the next autonomous step safer than adding another blind variant."
          : "A minimal baseline will expose the metric scale, artifact shape, and obvious failure modes.",
      },
    ],
    recommendedMove: moveSlug,
    budget: "cheap pre-flight only until the human approves the brief",
    returnTriggers: [
      "doctor or paper lint fails",
      "no durable artifact is produced",
      "the evaluator cannot distinguish candidate outputs",
    ],
    sourceText: "Auto-drafted by vr-research-orchestrator from README, LOG, leaderboard, and research-state. Human review should refine the move before expensive work.",
  };
}

async function allocateBriefSlug(projectDir, preferredSlug) {
  const used = new Set();
  let slug = normalizeSlug(preferredSlug || "next-brief", "next-brief");
  while (used.size < 100) {
    if (!(await pathExists(getBriefPath(projectDir, slug)))) {
      return slug;
    }
    used.add(slug);
    slug = uniqueSlug(slug.replace(/-\d+$/u, ""), used);
  }
  throw new Error("could not allocate a unique brief slug");
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
  let briefDraft = null;
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
      const draft = buildPlannerBriefDraft({
        parsed,
        logRows: logFile.rows,
        projectName,
        state,
      });
      rec = recommendation(
        "create-brief",
        `${state.phase} phase needs a research brief before experiments should start.`,
        { briefSlug: draft.slug, recommendedMove: draft.recommendedMove },
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
      if (apply) {
        const briefSlug = await allocateBriefSlug(resolvedProjectDir, draft.slug);
        const created = await createResearchBrief({
          projectDir: resolvedProjectDir,
          ...draft,
          slug: briefSlug,
        });
        briefDraft = {
          briefSlug: created.brief.slug,
          briefPath: created.briefPath,
          candidateMoves: created.brief.candidateMoves,
          recommendedMove: created.brief.recommendedMove,
          wrote: created.wrote,
        };
        phaseUpdate = await updateResearchState({
          projectDir: resolvedProjectDir,
          phase: "move-design",
          briefSlug: created.brief.slug,
          summary: `orchestrator: drafted brief ${created.brief.slug}`,
        });

        if (askHuman) {
          const review = await createBriefReviewCard({
            agentTownApi,
            projectDir: resolvedProjectDir,
            brief: created.brief,
            briefPath: created.briefPath,
            fetchImpl,
          });
          let wait = null;
          let resolution = "";
          const actionItemId = review.actionItem?.id || `research-brief-${created.brief.slug}`;
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

          if (waitHuman && resolution === "approved") {
            briefCompile = await compileBriefToQueue({
              projectDir: resolvedProjectDir,
              slug: created.brief.slug,
            });
            phaseUpdate = await updateResearchState({
              projectDir: resolvedProjectDir,
              phase: "experiment",
              briefSlug: briefCompile.brief.slug,
              summary: `orchestrator: compiled ${briefCompile.queueRows.length} move(s) from brief ${briefCompile.brief.slug}`,
            });
          }
        }
      }
    }
  }

  return {
    projectDir: resolvedProjectDir,
    projectName,
    phase: state,
    phaseUpdate: phaseUpdate?.state || null,
    briefDraft,
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
  if (report.briefDraft?.briefSlug) {
    lines.push(`brief draft: ${report.briefDraft.briefSlug} -> ${report.briefDraft.recommendedMove || "no recommendation"}`);
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
