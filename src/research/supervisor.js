const MAX_AUDIT_EVENTS = 80;
const MAX_THREAD_EVENTS = 160;

function trimString(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isoNow(now = new Date()) {
  if (typeof now === "string" && now) return now;
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.toISOString();
  return new Date().toISOString();
}

function boundedText(value, limit) {
  const text = trimString(value);
  return text.length > limit ? text.slice(0, limit) : text;
}

function compactDirectiveText(value, limit = 320) {
  const text = trimString(value);
  if (!text || text.length <= limit) return text;
  const slice = text.slice(0, Math.max(0, limit - 3));
  const breakAt = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("; "),
    slice.lastIndexOf(" | "),
    slice.lastIndexOf(" "),
  );
  const clipped = breakAt > limit * 0.55 ? slice.slice(0, breakAt).trim() : slice.trim();
  return `${clipped}...`;
}

function normalizeSupervisorCard(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    label: boundedText(input.label || "Evidence-first supervisor", 80),
    mode: boundedText(input.mode, 40),
    action: boundedText(input.action, 80),
    reason: boundedText(input.reason, 240),
    evidence: boundedText(input.evidence, 180),
    integrity: boundedText(input.integrity, 180),
    compute: boundedText(input.compute, 180),
    continuity: boundedText(input.continuity, 220),
    stop: boundedText(input.stop, 180),
    preview: boundedText(input.preview, 240),
  };
}

function normalizeSupervisorThreadEntry(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const role = boundedText(input.role, 40) || "state";
  const kind = boundedText(input.kind, 60) || "event";
  const text = boundedText(input.text, 2_000);
  const title = boundedText(input.title, 120);
  const at = typeof input.at === "string" ? input.at : "";
  if (!text && !title) return null;
  return {
    id: boundedText(input.id, 100),
    at,
    role,
    kind,
    title,
    text,
    source: boundedText(input.source, 80),
  };
}

function supervisorThreadEntry({
  at = "",
  role = "state",
  kind = "event",
  title = "",
  text = "",
  source = "",
} = {}) {
  const normalized = normalizeSupervisorThreadEntry({
    id: `sup-${Math.random().toString(36).slice(2, 10)}`,
    at,
    role,
    kind,
    title,
    text,
    source,
  });
  return normalized;
}

export function normalizeResearchSupervisorState(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const audit = Array.isArray(input.audit)
    ? input.audit
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        return {
          at: typeof entry.at === "string" ? entry.at : "",
          event: boundedText(entry.event, 80),
          action: boundedText(entry.action, 80),
          reason: boundedText(entry.reason, 500),
          signature: boundedText(entry.signature, 300),
        };
      })
      .filter(Boolean)
      .slice(-MAX_AUDIT_EVENTS)
    : [];
  const thread = Array.isArray(input.thread)
    ? input.thread
      .map(normalizeSupervisorThreadEntry)
      .filter(Boolean)
      .slice(-MAX_THREAD_EVENTS)
    : [];
  return {
    version: 1,
    enabledAt: typeof input.enabledAt === "string" ? input.enabledAt : "",
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : "",
    lastObservedAt: typeof input.lastObservedAt === "string" ? input.lastObservedAt : "",
    lastObservedEvent: boundedText(input.lastObservedEvent, 80),
    lastDirectiveAt: typeof input.lastDirectiveAt === "string" ? input.lastDirectiveAt : "",
    lastDirectiveSignature: boundedText(input.lastDirectiveSignature, 300),
    lastDirectiveReason: boundedText(input.lastDirectiveReason, 500),
    lastDirectivePreview: boundedText(input.lastDirectivePreview, 240),
    lastDirectiveCard: normalizeSupervisorCard(input.lastDirectiveCard),
    interventionCount: Math.max(0, Math.floor(Number(input.interventionCount) || 0)),
    audit,
    thread,
  };
}

function normalizeSupervisorEvent(event = {}) {
  if (typeof event === "string") {
    return { type: trimString(event) || "tick", action: "", source: "" };
  }
  const input = event && typeof event === "object" && !Array.isArray(event) ? event : {};
  return {
    type: trimString(input.type || input.event || "tick").toLowerCase() || "tick",
    action: trimString(input.action).toLowerCase(),
    source: trimString(input.source || "chat").toLowerCase(),
    turnMarker: boundedText(input.turnMarker || input.turnId || input.observedTurn || "", 120),
    subagentName: boundedText(input.subagentName || input.agentName || input.workerName || "", 120),
    message: boundedText(input.message || input.observedMessage || input.text || "", 2_000),
  };
}

function projectSlugFromRecommendation(recommendation = {}) {
  return trimString(recommendation.slug || recommendation.briefSlug || recommendation.recommendedMove || "");
}

function recommendationAction(report = {}) {
  return trimString(report?.recommendation?.action).toLowerCase();
}

function recommendationReason(report = {}) {
  return trimString(report?.recommendation?.reason);
}

function normalizeSupervisorRuntime(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const background = input.backgroundActivity && typeof input.backgroundActivity === "object" && !Array.isArray(input.backgroundActivity)
    ? input.backgroundActivity
    : {};
  const activeBackgroundTasks = Math.max(
    0,
    Math.floor(Number(input.activeBackgroundTasks ?? background.activeCount) || 0),
  );
  const activeSubagents = Math.max(0, Math.floor(Number(input.activeSubagents) || 0));
  const recentTraceHasMonitor = Boolean(input.recentTraceHasMonitor || input.monitorArmed || input.hasMonitor);
  const recentTraceHasWakeup = Boolean(input.recentTraceHasWakeup || input.wakeupArmed || input.hasWakeup);
  const hasContinuity = Boolean(input.hasContinuity || recentTraceHasMonitor || recentTraceHasWakeup);
  const streamWorking = Boolean(input.streamWorking || input.workerWorking);
  const summaryParts = [
    hasContinuity
      ? [
          recentTraceHasMonitor ? "monitor visible" : "",
          recentTraceHasWakeup ? "wakeup visible" : "",
        ].filter(Boolean).join(" and ") || "monitor/wakeup visible"
      : "",
    activeBackgroundTasks ? `${activeBackgroundTasks} background task${activeBackgroundTasks === 1 ? "" : "s"}` : "",
    activeSubagents ? `${activeSubagents} active subagent${activeSubagents === 1 ? "" : "s"}` : "",
    input.summary || input.monitorSummary || input.wakeupSummary || "",
  ].filter(Boolean);
  return {
    sessionStatus: boundedText(input.sessionStatus || input.status, 80),
    activityStatus: boundedText(input.activityStatus, 80),
    streamWorking,
    activeBackgroundTasks,
    activeSubagents,
    recentTraceHasMonitor,
    recentTraceHasWakeup,
    hasContinuity,
    summary: compactDirectiveText(summaryParts.join("; "), 220),
  };
}

function observedAttachmentRuntime(attachment = {}) {
  return attachment?.runtime || attachment?.sessionRuntime || {};
}

function automaticEventAllowsDirective(event = {}) {
  const type = normalizeSupervisorEvent(event).type;
  return type === "agent-idle"
    || type === "worker-idle"
    || type === "turn-complete"
    || type === "recover-exited";
}

function automaticEventIsRecovery(event = {}) {
  return normalizeSupervisorEvent(event).type === "recover-exited";
}

function actionNeedsContinuityReminder(action = "") {
  const text = trimString(action).toLowerCase();
  if (!text) return false;
  if (/synth|review|brainstorm|brief|plan|fix|doctor|repair|enter-review/u.test(text)) return false;
  return /continue|active|resume|run-next|run-sweep|sweep|experiment|hillclimb|rerun/u.test(text);
}

function continuityInstructionLine({ action = "", runtime = {} } = {}) {
  const status = normalizeSupervisorRuntime(runtime);
  if (status.hasContinuity) {
    return `Continuity: monitor/wakeup visible${status.summary ? ` (${status.summary})` : ""}; keep the completion signal attached to any long-running work.`;
  }
  if (!actionNeedsContinuityReminder(action)) return "";
  const backgroundCount = status.activeBackgroundTasks + status.activeSubagents;
  const background = backgroundCount
    ? ` ${status.summary} ${backgroundCount === 1 ? "is" : "are"} visible, but no monitor/wakeup is.`
    : "";
  return `Continuity: no active monitor/wakeup is visible.${background} Before leaving a long-running run, set a monitor, scheduled wakeup, or log watcher with a clear completion signal.`;
}

function directiveSignature({ event, action, report, reason }) {
  const rec = report?.recommendation || {};
  return [
    action,
    event.type,
    event.action,
    event.turnMarker,
    trimString(rec.action).toLowerCase(),
    projectSlugFromRecommendation(rec),
    reason,
  ].filter(Boolean).join("|").slice(0, 300);
}

function automaticDirectiveSignature({ event, action, report, reason }) {
  const normalizedEvent = normalizeSupervisorEvent(event);
  return directiveSignature({
    event: {
      ...normalizedEvent,
      type: "automatic",
      action: "",
    },
    action,
    report,
    reason,
  });
}

export function appendResearchSupervisorThread(previous = {}, entries = [], { now = new Date() } = {}) {
  const at = isoNow(now);
  const state = normalizeResearchSupervisorState(previous);
  const normalizedEntries = (Array.isArray(entries) ? entries : [entries])
    .map((entry) => normalizeSupervisorThreadEntry({
      ...entry,
      at: typeof entry?.at === "string" && entry.at ? entry.at : at,
      id: entry?.id || `sup-${Date.parse(at) || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }))
    .filter(Boolean);
  if (!normalizedEntries.length) {
    return state;
  }
  return {
    ...state,
    updatedAt: at,
    thread: [...state.thread, ...normalizedEntries].slice(-MAX_THREAD_EVENTS),
  };
}

function manualDirective(action, { attachment = {}, report = null } = {}) {
  const project = trimString(attachment?.projectName);
  const context = report?.projectContext || {};
  const objective = trimString(attachment?.objective) || trimString(context.goal);
  const runtime = observedAttachmentRuntime(attachment);
  const projectPhrase = projectPhraseFor(project);
  const nextCommand = trimString(report?.nextCommand);
  const reason = recommendationReason(report);

  if (action === "continue") {
    const automatic = automaticDirective({
      action: recommendationAction(report),
      report,
      attachment,
    });
    if (automatic) {
      return {
        ...automatic,
        reason: `manual continue requested; ${automatic.reason}`,
      };
    }
    return {
      text: operatingBrief({
        headline: `Continue the research loop${projectPhrase} from the current project state.`,
        project,
        objective,
        context,
        reason,
        command: nextCommand,
        action: "manual-continue",
        runtime,
        focus: "Choose the smallest safe next step from ACTIVE or QUEUE, and do not start broad exploration until the durable state is inspected.",
      }),
      reason: "manual continue requested",
    };
  }
  if (action === "synthesize") {
    return {
      text: operatingBrief({
        headline: `Synthesize the current research state${projectPhrase} for review.`,
        project,
        objective,
        context,
        reason,
        command: nextCommand,
        action: "manual-synthesize",
        runtime,
        focus: "Produce a tight checkpoint: what changed since the last update, which evidence is complete or incomplete, current risks, qualitative sample/heatmap status, and the next recommended move.",
        finish: "Do not launch new experiments during the checkpoint; end with the recommendation, durable links, and any true human gate.",
      }),
      reason: "manual checkpoint requested",
    };
  }
  if (action === "brainstorm") {
    return {
      text: operatingBrief({
        headline: `Replan from the current research state${projectPhrase}.`,
        project,
        objective,
        context,
        reason,
        command: nextCommand,
        action: "manual-brainstorm",
        runtime,
        focus: "Brainstorm candidate directions from the latest positive and negative evidence, then select the smallest evidence-backed move whose result would change a decision.",
        finish: "Write or update the plan/brief with falsifiers, expected artifacts, and cost; ask for review before expensive execution if the choice is ambiguous.",
      }),
      reason: "manual replan requested",
    };
  }
  return null;
}

function projectPhraseFor(project) {
  return project ? ` for ${project}` : "";
}

function objectiveSentence(objective) {
  const text = trimString(objective);
  return text ? "Use the README/project goal as the north star." : "Infer the objective from the project README before acting.";
}

function supervisorDecisionChecklistBlock() {
  return [
    "Supervisor policy:",
    "- Evidence: require current metrics plus first-hand inspection of validation samples, heatmaps, or failure cases before spending more compute.",
    "- Integrity: audit the recent trace for evaluator edits, leakage, cherry-picking, stale artifacts, and unverifiable numbers.",
    "- Compute: keep safe idle GPUs saturated with independent seeds, ablations, or sweeps that preserve provenance.",
    "- Priority: when stuck or changing recipe, do a lightweight literature/current-docs pass before more GPU spend; otherwise choose the current bottleneck.",
    "- Communication: send one concrete next instruction with the artifact and stop condition.",
  ].join("\n");
}

function compactRowLabel(value = "") {
  const text = trimString(value);
  if (!text) return "";
  return compactDirectiveText(text.split(";")[0] || text, 90);
}

function conciseStateHint(context = {}) {
  const pieces = [
    context.activeHead ? `ACTIVE ${compactRowLabel(context.activeHead)}` : "",
    !context.activeHead && context.queueHead ? `QUEUE ${compactRowLabel(context.queueHead)}` : "",
    context.latestLog ? `latest LOG ${compactRowLabel(context.latestLog)}` : "",
    context.benchmark?.version ? `bench ${context.benchmark.version}` : "",
  ].filter(Boolean);
  return pieces.length ? pieces.join(", ") : "README/ACTIVE/QUEUE/LOG";
}

function conciseContinuityLine({ action = "", runtime = {} } = {}) {
  const status = normalizeSupervisorRuntime(runtime);
  if (status.hasContinuity) {
    return `Monitor/wakeup is visible; keep the completion signal attached.`;
  }
  if (!actionNeedsContinuityReminder(action)) return "";
  if (status.activeBackgroundTasks || status.activeSubagents) {
    const backgroundCount = status.activeBackgroundTasks + status.activeSubagents;
    return `${status.summary} ${backgroundCount === 1 ? "is" : "are"} visible, but I do not see a monitor/wakeup; set one before leaving long-running work.`;
  }
  return "If any long run is active or launched, set a monitor/wakeup/log watcher with a clear completion signal.";
}

function conciseCommandHint(command = "") {
  const text = trimString(command);
  if (!text) return "";
  const tool = text.match(/\bvr-research-[a-z-]+\b/u)?.[0] || "";
  if (tool) return `${tool} ...`;
  return compactDirectiveText(text, 120);
}

function operatingBrief({
  headline,
  project = "",
  objective = "",
  context = {},
  reason = "",
  command = "",
  focus = "",
  finish = "",
  action = "",
  runtime = {},
} = {}) {
  const continuityLine = conciseContinuityLine({ action, runtime });
  const stateHint = conciseStateHint(context);
  const commandHint = conciseCommandHint(command);
  const lines = [
    headline,
    `Check ${stateHint}, the result doc, recent commits, GPU/process state, metrics, and validation/qualitative artifacts first.`,
    objectiveSentence(objective),
  ];
  if (reason) {
    lines.push(`Why: ${reason}`);
  }
  lines.push("Keep it evidence-first: inspect validation samples/heatmaps/failure cases yourself; audit stale or cherry-picked artifacts; preserve provenance.");
  lines.push("Keep safe idle GPUs saturated with independent seeds/ablations/sweeps; if stuck or changing recipe, do lightweight literature/current-docs before more GPU spend.");
  if (continuityLine) lines.push(continuityLine);
  if (commandHint) lines.push(`Command if useful: ${commandHint}.`);
  if (focus) lines.push(compactDirectiveText(focus, 220));
  lines.push(compactDirectiveText(finish || "Update durable state after the bounded step and stop only for a true human gate.", 150));
  return compactDirectiveText(lines.join(" "), 1_040);
}

function supervisorModeForAction(action = "") {
  const text = trimString(action).toLowerCase();
  if (/fix|doctor|repair/u.test(text)) return "repair";
  if (/synth|review|judge|checkpoint|enter-review/u.test(text)) return "review";
  if (/brainstorm|brief|plan/u.test(text)) return "plan";
  if (/sweep|run-next|experiment|hillclimb/u.test(text)) return "experiment";
  if (/continue|active|resume/u.test(text)) return "continue";
  return "route";
}

function supervisorActionLabel(action = "") {
  const mode = supervisorModeForAction(action);
  if (mode === "repair") return "repair integrity";
  if (mode === "review") return "synthesize evidence";
  if (mode === "plan") return "choose next move";
  if (mode === "experiment") return /sweep/u.test(action) ? "run clean sweep" : "run bounded cycle";
  if (mode === "continue") return "continue active move";
  return "route next step";
}

function supervisorEvidenceLine(action = "") {
  const mode = supervisorModeForAction(action);
  if (mode === "review") return "Inspect validation samples/heatmaps/failure cases yourself alongside metrics before changing direction.";
  if (mode === "plan") return "If artifacts are stale, inspect or request validation samples/heatmaps before proposing more compute.";
  if (mode === "experiment") return "Confirm pre-flight, falsifier, expected artifacts, and validation/qual review plan before launch.";
  if (mode === "continue") return "Inspect current validation artifacts yourself and check whether the cycle has enough metrics or qualitative evidence.";
  return "Require current quantitative evidence plus first-hand validation/qual review before steering.";
}

function supervisorComputeLine(action = "") {
  const mode = supervisorModeForAction(action);
  if (mode === "review" || mode === "repair") return "Avoid new GPU work until the state or verdict is clean; then refill idle GPUs with independent follow-ups.";
  if (mode === "plan") return "Queue parallel GPU work only after the bottleneck and grounding check are explicit.";
  if (/sweep/u.test(action)) return "Use all safe idle GPUs for separate sweep rows with separate artifacts and provenance.";
  return "Keep safe idle GPUs saturated with independent seeds, ablations, or sweeps; do not overlap conflicting cycles.";
}

function supervisorContinuityLine(action = "", runtime = {}) {
  const line = continuityInstructionLine({ action, runtime });
  if (line) return line.replace(/^Continuity:\s*/u, "");
  const status = normalizeSupervisorRuntime(runtime);
  return status.hasContinuity
    ? `monitor/wakeup visible${status.summary ? ` (${status.summary})` : ""}`
    : "No monitor/wakeup state required for this supervisory step.";
}

function supervisorCardFromDirective({ action = "", reason = "", directiveText = "", runtime = {} } = {}) {
  return normalizeSupervisorCard({
    label: "Evidence-first supervisor",
    mode: supervisorModeForAction(action),
    action: supervisorActionLabel(action),
    reason,
    evidence: supervisorEvidenceLine(action),
    integrity: "Audit trace/diffs for evaluator tampering, leakage, cherry-picking, stale artifacts, and unverified claims.",
    compute: supervisorComputeLine(action),
    continuity: supervisorContinuityLine(action, runtime),
    stop: "Stop only for a true human gate, blocked state, or completed evidence-backed verdict.",
    preview: compactDirectiveText(directiveText, 220),
  });
}

function continuitySignaturePart(action = "", runtime = {}) {
  const status = normalizeSupervisorRuntime(runtime);
  if (status.hasContinuity) return "continuity-visible";
  return actionNeedsContinuityReminder(action) ? "continuity-missing" : "";
}

function automaticDirective({ action, report, attachment }) {
  const rec = report?.recommendation || {};
  const reason = recommendationReason(report);
  const slug = projectSlugFromRecommendation(rec);
  const project = trimString(attachment?.projectName);
  const context = report?.projectContext || {};
  const objective = trimString(attachment?.objective) || trimString(context.goal);
  const runtime = observedAttachmentRuntime(attachment);
  const projectPhrase = projectPhraseFor(project);
  const nextCommand = trimString(report?.nextCommand);

  if (action === "fix-doctor" || action === "orchestrator-fix-doctor") {
    return {
      text: operatingBrief({
        headline: `Before doing new research${projectPhrase}, fix the blocking project-integrity issue.`,
        project,
        objective,
        context,
        reason,
        command: nextCommand || `vr-research-doctor <project-dir>`,
        action,
        runtime,
        focus: "Do not start experiments while the project contract is corrupt; repair the README/LOG/result-doc shape first.",
        finish: "Re-run the doctor, commit/push the repair, then continue from the durable README/LOG state.",
      }),
      reason: reason || "doctor reported a blocking issue",
    };
  }

  if (action === "continue-active" || action === "orchestrator-continue-active") {
    return {
      text: operatingBrief({
        headline: `Resume the active research move${slug ? ` ${slug}` : ""}${projectPhrase}.`,
        project,
        objective,
        context,
        reason,
        command: nextCommand,
        action,
        runtime,
        focus: "If a cycle is running, verify process/GPU/artifact state and monitor it. If GPUs are idle, launch only independent seeds/ablations/sweeps with separate artifacts; inspect validation samples before claiming progress. If stuck, do a lightweight literature/current-docs pass before changing recipe.",
      }),
      reason: reason || "active move needs the next supervised step",
    };
  }

  if (action === "run-next" || action === "orchestrator-run-next") {
    return {
      text: operatingBrief({
        headline: `Claim QUEUE row 1${slug ? ` (${slug})` : ""}${projectPhrase} and run one bounded research cycle.`,
        project,
        objective,
        context,
        reason,
        command: nextCommand,
        action,
        runtime,
        focus: "Create or resume the result doc before expensive work, move the row into ACTIVE, make the pre-flight/falsifier explicit, and plan validation artifacts plus safe GPU saturation up front.",
      }),
      reason: reason || "queued move is ready to run",
    };
  }

  if (action === "run-sweep" || action === "orchestrator-run-sweep") {
    return {
      text: operatingBrief({
        headline: `Continue the planned sweep${projectPhrase}.`,
        project,
        objective,
        context,
        reason,
        command: nextCommand,
        action,
        runtime,
        focus: "Run the next runnable sweep rows across all safe idle GPUs, preserve per-row artifacts and metrics, and do not collapse distinct recipes into one undocumented comparison.",
      }),
      reason: reason || "planned sweep has runnable rows",
    };
  }

  if (action === "enter-review" || action === "orchestrator-enter-review") {
    return {
      text: operatingBrief({
        headline: `The experiment queue is exhausted${projectPhrase}; enter review mode before launching new work.`,
        project,
        objective,
        context,
        reason,
        command: nextCommand,
        action,
        runtime,
        focus: "Judge the latest result, distill what changed, identify failure modes and qualitative evidence, then propose the next move with a falsifier.",
        finish: "Write the review/brief update, surface the recommendation for approval if needed, and only then compile new QUEUE rows.",
      }),
      reason: reason || "project should transition into review",
    };
  }

  if (action === "create-brief" || action === "orchestrator-create-brief") {
    return {
      text: operatingBrief({
        headline: `Create a grounded research brief${projectPhrase}.`,
        project,
        objective,
        context,
        reason,
        command: nextCommand,
        action,
        runtime,
        focus: "Use the README, LOG, leaderboard, prior result docs, current artifacts, and lightweight literature/current-docs grounding to propose one small next move with a falsifier before running it.",
        finish: "Save the brief, ask for review if the choice is material, and do not start experiments until the brief is fit to queue.",
      }),
      reason: reason || "project needs a brief before experiments",
    };
  }

  if (action === "brainstorm" || action === "orchestrator-brainstorm") {
    return {
      text: operatingBrief({
        headline: `Brainstorm the next research directions${projectPhrase}.`,
        project,
        objective,
        context,
        reason,
        command: nextCommand,
        action,
        runtime,
        focus: "Use latest positive/negative evidence plus a lightweight literature/current-docs pass when stuck to propose candidate moves, then pick the smallest one that would change a decision.",
        finish: "Save the plan or brief, include falsifiers and expected artifacts, and ask for review before expensive execution if the choice is ambiguous.",
      }),
      reason: reason || "project needs planning before experiments",
    };
  }

  if (action === "review-brief" || action === "orchestrator-review-brief") {
    return {
      text: operatingBrief({
        headline: `Review the existing brief${slug ? ` ${slug}` : ""}${projectPhrase}.`,
        project,
        objective,
        context,
        reason,
        command: nextCommand,
        action,
        runtime,
        focus: "If it is already fit to run, compile it into QUEUE; otherwise tighten the question, literature/current-docs grounding, validation artifacts, and falsifier first.",
      }),
      reason: reason || "brief needs review before queueing",
    };
  }

  if (action.startsWith("judge-")) {
    const judgeAction = action.replace(/^orchestrator-judge-/u, "").replace(/^judge-/u, "");
    if (judgeAction === "rerun") {
      return {
        text: operatingBrief({
          headline: `The latest result needs a rerun or noise check${projectPhrase}.`,
          project,
          objective,
          context,
          reason,
          command: nextCommand,
          action,
          runtime,
          focus: "Inspect the judge issues and validation artifacts yourself, run the narrowest confirming cycle, and keep the leaderboard unchanged until evidence is strong.",
        }),
        reason: reason || "judge recommends rerun",
      };
    }
    if (judgeAction === "synthesize") {
      return {
        text: operatingBrief({
          headline: `Synthesize the latest judged result${projectPhrase}.`,
          project,
          objective,
          context,
          reason,
          command: nextCommand,
          action,
          runtime,
          focus: "Update the narrative, limitations, and durable project state according to the judge evidence before choosing new work.",
        }),
        reason: reason || "judge recommends synthesis",
      };
    }
    if (judgeAction === "brainstorm") {
      return {
        text: operatingBrief({
          headline: `Plan the next research move${projectPhrase}.`,
          project,
          objective,
          context,
          reason,
          command: nextCommand,
          action,
          runtime,
          focus: "Use judge output, negative results, leaderboard state, qualitative artifact review, and literature/current-docs grounding if stuck to propose the smallest useful follow-up.",
        }),
        reason: reason || "judge recommends brainstorming",
      };
    }
    if (judgeAction === "continue") {
      return {
        text: operatingBrief({
          headline: `Continue the active research thread${projectPhrase}.`,
          project,
          objective,
          context,
          reason,
          command: nextCommand,
          action,
          runtime,
          focus: "Use the judge evidence to choose the next safe cycle and keep the result doc current.",
        }),
        reason: reason || "judge recommends continuing",
      };
    }
  }

  return null;
}

export function decideResearchSupervisorIntervention({
  attachment = {},
  event = {},
  orchestratorReport = null,
  supervisorState = attachment?.supervisor,
} = {}) {
  const normalizedEvent = normalizeSupervisorEvent(event);
  const state = normalizeResearchSupervisorState(supervisorState);
  const driver = trimString(attachment.driver || "session").toLowerCase() || "session";

  if (!attachment.enabled || driver !== "session") {
    return {
      action: "silent",
      shouldSend: false,
      reason: "supervisor is not enabled for this same-chat session",
      event: normalizedEvent,
      signature: directiveSignature({ event: normalizedEvent, action: "silent", reason: "disabled" }),
    };
  }

  if (
    normalizedEvent.type === "toggle-on"
    || normalizedEvent.type === "toggle-off"
    || normalizedEvent.type === "takeover"
    || normalizedEvent.type === "human-message"
  ) {
    return {
      action: "silent",
      shouldSend: false,
      reason: "event updates supervisor state without changing agent context",
      event: normalizedEvent,
      signature: directiveSignature({ event: normalizedEvent, action: "silent", reason: "context-neutral" }),
    };
  }

  if (normalizedEvent.type === "manual-action") {
    const manual = manualDirective(normalizedEvent.action, {
      attachment,
      report: orchestratorReport,
    });
    if (manual) {
      const action = `manual-${normalizedEvent.action}`;
      const signature = directiveSignature({
        event: normalizedEvent,
        action,
        reason: manual.reason,
      });
      const card = supervisorCardFromDirective({
        action,
        reason: manual.reason,
        directiveText: manual.text,
        runtime: observedAttachmentRuntime(attachment),
      });
      return {
        action: "directive",
        shouldSend: true,
        reason: manual.reason,
        event: normalizedEvent,
        signature,
        card,
        directive: {
          source: "supervisor",
          text: manual.text,
          card,
        },
      };
    }
  }

  const runtime = observedAttachmentRuntime(attachment);
  const runtimeStatus = normalizeSupervisorRuntime(runtime);
  if (!automaticEventAllowsDirective(normalizedEvent)) {
    return {
      action: "silent",
      shouldSend: false,
      reason: "automatic supervisor directives only fire on worker handoff, recovery, or explicit Tell worker/manual actions",
      event: normalizedEvent,
      signature: directiveSignature({ event: normalizedEvent, action: "silent", reason: "not-handoff-event" }),
    };
  }

  if (!automaticEventIsRecovery(normalizedEvent) && runtimeStatus.streamWorking) {
    return {
      action: "silent",
      shouldSend: false,
      reason: "worker is still running; wait for the next handoff before sending a supervisor directive",
      event: normalizedEvent,
      signature: directiveSignature({ event: normalizedEvent, action: "silent", reason: "worker-running" }),
    };
  }

  if (!trimString(attachment.projectName)) {
    return {
      action: "human-gate",
      shouldSend: false,
      reason: "choose a research project before the supervisor can route work",
      event: normalizedEvent,
      signature: directiveSignature({ event: normalizedEvent, action: "human-gate", reason: "missing-project" }),
    };
  }

  if (!orchestratorReport?.recommendation) {
    return {
      action: "silent",
      shouldSend: false,
      reason: "no project recommendation available",
      event: normalizedEvent,
      signature: directiveSignature({ event: normalizedEvent, action: "silent", reason: "no-recommendation" }),
    };
  }

  const recAction = recommendationAction(orchestratorReport);
  const automatic = automaticDirective({ action: recAction, report: orchestratorReport, attachment });
  if (!automatic) {
    return {
      action: "silent",
      shouldSend: false,
      reason: `recommendation ${recAction || "unknown"} does not require a chat directive`,
      event: normalizedEvent,
      signature: directiveSignature({ event: normalizedEvent, action: "silent", report: orchestratorReport, reason: recAction }),
    };
  }

  const signature = automaticDirectiveSignature({
    event: normalizedEvent,
    action: recAction,
    report: orchestratorReport,
    reason: [automatic.reason, continuitySignaturePart(recAction, observedAttachmentRuntime(attachment))]
      .filter(Boolean)
      .join("|"),
  });
  const allowRepeat = normalizedEvent.type === "recover-exited";
  if (!allowRepeat && signature && signature === state.lastDirectiveSignature) {
    return {
      action: "silent",
      shouldSend: false,
      reason: "same supervisor directive was already sent for this project state",
      event: normalizedEvent,
      signature,
    };
  }

  const card = supervisorCardFromDirective({
    action: recAction,
    reason: automatic.reason,
    directiveText: automatic.text,
    runtime: observedAttachmentRuntime(attachment),
  });

  return {
    action: "directive",
    shouldSend: true,
    reason: automatic.reason,
    event: normalizedEvent,
    signature,
    card,
    directive: {
      source: "supervisor",
      text: automatic.text,
      card,
    },
  };
}

export function updateResearchSupervisorState(previous = {}, decision = {}, event = {}, { now = new Date() } = {}) {
  const at = isoNow(now);
  const normalizedEvent = normalizeSupervisorEvent(event || decision.event);
  const state = normalizeResearchSupervisorState(previous);
  const shouldSend = Boolean(decision.shouldSend && decision.directive?.text);
  const auditEntry = {
    at,
    event: normalizedEvent.type,
    action: decision.action || "silent",
    reason: boundedText(decision.reason, 500),
    signature: boundedText(decision.signature, 300),
  };
  const threadEntries = [];
  if (normalizedEvent.type && !["toggle-on", "toggle-off", "supervisor-chat"].includes(normalizedEvent.type)) {
    const isHuman = normalizedEvent.source === "human";
    const isSubagent = normalizedEvent.source === "subagent";
    const subagentTitle = normalizedEvent.subagentName
      ? `Subagent observed · ${normalizedEvent.subagentName}`
      : "Subagent observed";
    threadEntries.push(supervisorThreadEntry({
      at,
      role: isHuman ? "human" : "worker",
      kind: normalizedEvent.type,
      title: isHuman ? "Human action" : isSubagent ? subagentTitle : "Worker observed",
      text: normalizedEvent.message || decision.reason || normalizedEvent.action || normalizedEvent.type,
      source: normalizedEvent.source,
    }));
  }
  if (decision.action === "human-gate" && decision.reason) {
    threadEntries.push(supervisorThreadEntry({
      at,
      role: "supervisor",
      kind: "gate",
      title: "Supervisor gate",
      text: decision.reason,
      source: "supervisor",
    }));
  }
  if (shouldSend) {
    threadEntries.push(supervisorThreadEntry({
      at,
      role: "directive",
      kind: "directive_sent",
      title: decision.card?.action || decision.directive?.card?.action || "Directive sent",
      text: decision.directive.text,
      source: "supervisor",
    }));
  }
  return {
    ...state,
    enabledAt: state.enabledAt || at,
    updatedAt: at,
    lastObservedAt: at,
    lastObservedEvent: normalizedEvent.type,
    lastDirectiveAt: shouldSend ? at : state.lastDirectiveAt,
    lastDirectiveSignature: shouldSend ? boundedText(decision.signature, 300) : state.lastDirectiveSignature,
    lastDirectiveReason: shouldSend ? boundedText(decision.reason, 500) : state.lastDirectiveReason,
    lastDirectivePreview: shouldSend ? compactDirectiveText(decision.directive?.text, 220) : state.lastDirectivePreview,
    lastDirectiveCard: shouldSend ? normalizeSupervisorCard(decision.card || decision.directive?.card) : state.lastDirectiveCard,
    interventionCount: state.interventionCount + (shouldSend ? 1 : 0),
    audit: [...state.audit, auditEntry].slice(-MAX_AUDIT_EVENTS),
    thread: [...state.thread, ...threadEntries.filter(Boolean)].slice(-MAX_THREAD_EVENTS),
  };
}

export const __internal = {
  manualDirective,
  automaticDirective,
  operatingBrief,
  supervisorDecisionChecklistBlock,
  supervisorCardFromDirective,
  supervisorModeForAction,
  normalizeSupervisorEvent,
  directiveSignature,
  automaticDirectiveSignature,
};
