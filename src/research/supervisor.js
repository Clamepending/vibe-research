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

function projectContractLines(context = {}, { objective = "" } = {}) {
  const lines = [];
  const goal = trimString(context.goal);
  const objectiveText = trimString(objective);
  if (goal && !(goal === objectiveText && goal.length > 220)) {
    lines.push(`Goal: ${compactDirectiveText(goal, 280)}`);
  }
  if (context.rankingCriterion) lines.push(`Ranking: ${context.rankingCriterion}`);
  if (Array.isArray(context.successCriteria) && context.successCriteria.length) {
    lines.push(`Success criteria: ${compactDirectiveText(context.successCriteria.join(" | "), 320)}`);
  }
  if (context.activeHead) lines.push(`Active: ${context.activeHead}`);
  if (context.queueHead) lines.push(`Queue head: ${context.queueHead}`);
  if (context.leaderboardHead) lines.push(`Leaderboard head: ${context.leaderboardHead}`);
  if (context.latestLog) lines.push(`Latest log: ${context.latestLog}`);
  const bench = benchmarkLine(context.benchmark);
  if (bench) lines.push(bench);
  return lines;
}

function supervisorDecisionChecklistBlock() {
  return [
    "Supervisor decision checklist:",
    "- First decide whether the qualitative evidence is current. If samples, failure cases, or heatmaps are missing/stale, ask the agent to generate and inspect them before choosing more compute.",
    "- If qualitative results expose a failure mode, ask for targeted experiments or ablations; use idle GPUs for independent sibling runs only when provenance stays clean.",
    "- If the recipe, architecture, data, or benchmark direction is uncertain, step back and request a lightweight literature/current-docs pass before expensive work.",
    "- If several recipe pieces are entangled, prefer ablation or small factorial studies to learn which parts are truly needed.",
    "- Send one concrete next instruction, not a bundle of every possible good idea; preserve branches, commands, artifacts, and result-doc state.",
  ].join("\n");
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
  const lines = [
    headline,
    [
      "First inspect the durable project state:",
      "README, ACTIVE, QUEUE, LOG, current result doc, recent commits, and recent artifacts.",
      objectiveSentence(objective),
    ].join(" "),
  ];
  const contract = projectContractLines(context, { objective });
  if (contract.length) {
    lines.push(["Project contract:", ...contract.map((line) => `- ${line}`)].join("\n"));
  }
  if (reason) {
    lines.push(`Current routing signal${projectPhraseFor(project)}: ${reason}`);
  }
  if (focus) {
    lines.push(focus);
  }
  lines.push(supervisorDecisionChecklistBlock());
  if (command) {
    lines.push(`Useful command path: ${command}`);
  }
  lines.push(
    [
      "Execution discipline:",
      "run one bounded step at a time; keep branch, commit, command, seed/config, artifact paths, and metrics attached;",
      "when the evidence suggests a broader search, queue sibling recipes or ablations explicitly instead of burying them in one undocumented run;",
      "do not corrupt the active move's provenance.",
    ].join(" "),
  );
  lines.push(finish || "After the step, update the result doc and paper/canvas if relevant, run the project doctor, commit/push durable state, and stop only for a true human gate.");
  return lines.join("\n\n");
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
      const signature = directiveSignature({
        event: normalizedEvent,
        action: `manual-${normalizedEvent.action}`,
        reason: manual.reason,
      });
      return {
        action: "directive",
        shouldSend: true,
        reason: manual.reason,
        event: normalizedEvent,
        signature,
        directive: {
          source: "supervisor",
          text: manual.text,
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

  return {
    action: "directive",
    shouldSend: true,
    reason: automatic.reason,
    event: normalizedEvent,
    signature,
    directive: {
      source: "supervisor",
      text: automatic.text,
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
    interventionCount: state.interventionCount + (shouldSend ? 1 : 0),
    audit: [...state.audit, auditEntry].slice(-MAX_AUDIT_EVENTS),
  };
}

export const __internal = {
  manualDirective,
  automaticDirective,
  operatingBrief,
  supervisorDecisionChecklistBlock,
  normalizeSupervisorEvent,
  directiveSignature,
  automaticDirectiveSignature,
};
