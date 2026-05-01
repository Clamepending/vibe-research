const MAX_AUDIT_EVENTS = 80;

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
    stop: boundedText(input.stop, 180),
    preview: boundedText(input.preview, 240),
  };
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

function manualDirective(action, { attachment = {}, report = null } = {}) {
  const project = trimString(attachment?.projectName);
  const context = report?.projectContext || {};
  const objective = trimString(attachment?.objective) || trimString(context.goal);
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
  if (!text) return "Infer the objective from the project README before acting.";
  if (text.length <= 220) {
    return `Use the project objective as the north star: ${text}`;
  }
  return `Use the project objective as the north star (full text is in README): ${compactDirectiveText(text, 260)}`;
}

function benchmarkLine(benchmark) {
  if (!benchmark?.exists) return "";
  const head = [
    benchmark.version ? `version ${benchmark.version}` : "",
    benchmark.status ? `status ${benchmark.status}` : "",
  ].filter(Boolean).join(", ");
  const metrics = Array.isArray(benchmark.metrics) && benchmark.metrics.length
    ? `metrics ${benchmark.metrics.join(", ")}`
    : "";
  const datasets = Array.isArray(benchmark.datasets) && benchmark.datasets.length
    ? `datasets ${benchmark.datasets.join(", ")}`
    : "";
  return [`Benchmark: ${head || "declared"}`, metrics, datasets].filter(Boolean).join("; ");
}

function supervisorDecisionChecklistBlock() {
  return [
    "Supervisor policy:",
    "- Evidence: require current metrics plus qualitative samples, heatmaps, or failure cases before spending more compute.",
    "- Integrity: audit the recent trace for evaluator edits, leakage, cherry-picking, stale artifacts, and unverifiable numbers.",
    "- Compute: keep idle GPUs busy only with independent seeds, ablations, or sweeps that preserve provenance.",
    "- Priority: choose the current bottleneck: monitor, diagnose, ablate, sweep, literature review, synthesize, or human gate.",
    "- Communication: send one concrete next instruction with the artifact and stop condition.",
  ].join("\n");
}

function compactProjectStateLine(context = {}) {
  const pieces = [
    context.activeHead ? `Active: ${context.activeHead}` : "",
    context.queueHead ? `Queue: ${context.queueHead}` : "",
    context.latestLog ? `Latest: ${context.latestLog}` : "",
    context.benchmark?.exists
      ? `Benchmark: ${[
          context.benchmark.version ? `version ${context.benchmark.version}` : "",
          context.benchmark.status ? `status ${context.benchmark.status}` : "",
        ].filter(Boolean).join(", ") || "declared"}`
      : "",
  ].filter(Boolean);
  return compactDirectiveText(pieces.join(" | "), 520);
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
} = {}) {
  const stateLine = compactProjectStateLine(context);
  const goal = trimString(context.goal);
  const objectiveText = trimString(objective);
  const goalLine = goal && goal !== objectiveText
    ? `Goal: ${compactDirectiveText(goal, 260)}`
    : "";
  const rankingLine = context.rankingCriterion
    ? `Ranking: ${compactDirectiveText(context.rankingCriterion, 220)}`
    : "";
  const successLine = Array.isArray(context.successCriteria) && context.successCriteria.length
    ? `Success: ${compactDirectiveText(context.successCriteria.join(" | "), 240)}`
    : "";
  const lines = [
    headline,
    `First inspect the durable project state and recent trace/artifacts: README, ACTIVE, QUEUE, LOG, result doc, commits, metrics, and qualitative outputs. ${objectiveSentence(objective)}`,
  ];
  if (goalLine) lines.push(goalLine);
  if (stateLine) lines.push(`State: ${stateLine}`);
  if (rankingLine || successLine) lines.push([rankingLine, successLine].filter(Boolean).join("\n"));
  if (reason) {
    lines.push(`Current routing signal${projectPhraseFor(project)}: ${reason}`);
  }
  lines.push(supervisorDecisionChecklistBlock());
  if (focus) {
    lines.push(`Next instruction: ${focus}`);
  }
  if (command) lines.push(`Useful command path: ${compactDirectiveText(command, 340)}`);
  lines.push(`Stop condition: ${finish || "Update durable state after the bounded step, run the project doctor when state changed, commit/push if relevant, and stop only for a true human gate."}`);
  return lines.join("\n\n");
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
  if (mode === "review") return "Compare current metrics with qualitative artifacts before changing direction.";
  if (mode === "plan") return "If artifacts are stale, ask for samples or heatmaps before proposing more compute.";
  if (mode === "experiment") return "Confirm pre-flight, falsifier, and expected artifacts before launch.";
  if (mode === "continue") return "Check whether the running cycle already has enough metrics or qualitative evidence.";
  return "Require current quantitative and qualitative evidence before steering.";
}

function supervisorComputeLine(action = "") {
  const mode = supervisorModeForAction(action);
  if (mode === "review" || mode === "repair") return "Avoid new GPU work until the state or verdict is clean.";
  if (mode === "plan") return "Queue parallel work only after the bottleneck is explicit.";
  if (/sweep/u.test(action)) return "Use parallel rows only when each has separate artifacts and provenance.";
  return "Use idle GPUs for independent seeds, ablations, or sweeps; do not overlap conflicting cycles.";
}

function supervisorCardFromDirective({ action = "", reason = "", directiveText = "" } = {}) {
  return normalizeSupervisorCard({
    label: "Evidence-first supervisor",
    mode: supervisorModeForAction(action),
    action: supervisorActionLabel(action),
    reason,
    evidence: supervisorEvidenceLine(action),
    integrity: "Audit trace/diffs for evaluator tampering, leakage, cherry-picking, stale artifacts, and unverified claims.",
    compute: supervisorComputeLine(action),
    stop: "Stop only for a true human gate, blocked state, or completed evidence-backed verdict.",
    preview: compactDirectiveText(directiveText, 220),
  });
}

function automaticDirective({ action, report, attachment }) {
  const rec = report?.recommendation || {};
  const reason = recommendationReason(report);
  const slug = projectSlugFromRecommendation(rec);
  const project = trimString(attachment?.projectName);
  const context = report?.projectContext || {};
  const objective = trimString(attachment?.objective) || trimString(context.goal);
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
        focus: "If a cycle is already running, verify process/GPU/artifact state and wait or monitor rather than launching a conflicting cycle. If evidence is complete, finish the move with the registered verdict instead of drifting into new work.",
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
        focus: "Create or resume the result doc before expensive work, move the row into ACTIVE, and make the pre-flight/falsifier explicit.",
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
        focus: "Run the next runnable sweep row, preserve per-row artifacts and metrics, and do not collapse distinct recipes into one undocumented comparison.",
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
        focus: "Use the README, LOG, leaderboard, prior result docs, and current artifacts to propose one small next move with a falsifier before running it.",
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
        focus: "Use the latest negative and positive evidence to propose a few candidate moves, then pick the smallest one that would change a decision.",
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
        focus: "If it is already fit to run, compile it into QUEUE; otherwise tighten the question, grounding, expected artifact, and falsifier first.",
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
          focus: "Inspect the judge issues, run the narrowest confirming cycle, and keep the leaderboard unchanged until evidence is strong.",
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
          focus: "Use judge output, negative results, leaderboard state, and qualitative artifact review to propose the smallest useful follow-up.",
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

  if (normalizedEvent.type === "toggle-on" || normalizedEvent.type === "toggle-off" || normalizedEvent.type === "human-message") {
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
    reason: automatic.reason,
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
