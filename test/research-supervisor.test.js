import assert from "node:assert/strict";
import test from "node:test";
import {
  decideResearchSupervisorIntervention,
  normalizeResearchSupervisorState,
  updateResearchSupervisorState,
} from "../src/research/supervisor.js";

function attachment(overrides = {}) {
  return {
    enabled: true,
    driver: "session",
    projectName: "prose-style",
    objective: "Improve concise prose style.",
    supervisor: normalizeResearchSupervisorState(),
    ...overrides,
  };
}

test("research supervisor keeps toggle, takeover, and human-message events context-neutral", () => {
  const toggle = decideResearchSupervisorIntervention({
    attachment: attachment(),
    event: { type: "toggle-on", source: "human" },
    orchestratorReport: {
      recommendation: { action: "run-next", reason: "QUEUE row 1 is ready", slug: "baseline" },
    },
  });
  assert.equal(toggle.action, "silent");
  assert.equal(toggle.shouldSend, false);

  const takeover = decideResearchSupervisorIntervention({
    attachment: attachment(),
    event: { type: "takeover", source: "session" },
    orchestratorReport: {
      recommendation: { action: "run-next", reason: "QUEUE row 1 is ready", slug: "baseline" },
    },
  });
  assert.equal(takeover.action, "silent");
  assert.equal(takeover.shouldSend, false);

  const humanMessage = decideResearchSupervisorIntervention({
    attachment: attachment(),
    event: { type: "human-message", source: "human" },
    orchestratorReport: {
      recommendation: { action: "run-next", reason: "QUEUE row 1 is ready", slug: "baseline" },
    },
  });
  assert.equal(humanMessage.action, "silent");
  assert.equal(humanMessage.shouldSend, false);
});

test("research supervisor emits opaque directives on manual actions", () => {
  const decision = decideResearchSupervisorIntervention({
    attachment: attachment(),
    event: { type: "manual-action", action: "synthesize", source: "human" },
    orchestratorReport: {
      recommendation: { action: "run-next", reason: "QUEUE row 1 is ready", slug: "baseline" },
      projectContext: {
        goal: "Find the prompt scaffold that produces the most readable short-form answers.",
        queueHead: "baseline; from main; why establish the first reproducible baseline",
      },
    },
  });
  assert.equal(decision.action, "directive");
  assert.equal(decision.shouldSend, true);
  assert.match(decision.directive.text, /Synthesize the current research state/);
  assert.match(decision.directive.text, /qualitative sample\/heatmap status/);
  assert.doesNotMatch(decision.directive.text, /\n/);
  assert.doesNotMatch(decision.directive.text, /^(State|Goal|Ranking|Success|Supervisor policy):/m);
  assert.equal(decision.card.mode, "review");
  assert.match(decision.card.integrity, /evaluator tampering/);
  assert.doesNotMatch(decision.directive.text, /Autopilot/i);
});

test("research supervisor routes manual continue through project recommendation", () => {
  const decision = decideResearchSupervisorIntervention({
    attachment: attachment(),
    event: { type: "manual-action", action: "continue", source: "human" },
    orchestratorReport: {
      recommendation: {
        action: "continue-active",
        reason: "ACTIVE has v070; continue or finish that move before claiming another.",
        slug: "v070",
      },
      projectContext: {
        goal: "Keep the active move bounded.",
        activeHead: "v070; result doc results/v070.md; branch r/v070",
      },
    },
  });
  assert.equal(decision.action, "directive");
  assert.equal(decision.shouldSend, true);
  assert.match(decision.reason, /manual continue requested/);
  assert.match(decision.directive.text, /Resume v070/);
  assert.match(decision.directive.text, /logs\/GPU\/artifacts/);
  assert.doesNotMatch(decision.directive.text, /\n/);
  assert.equal(decision.card.action, "continue active move");
});

test("research supervisor includes human-defined look-fors in worker directives", () => {
  const decision = decideResearchSupervisorIntervention({
    attachment: attachment({
      watchlist: [
        "- make sure the worker is fully parallelizing and utilizing safe idle GPUs",
        "- assess qualitative results of recent models",
        "- check for cheating / reward hacking",
        "- if results plateau, suggest literature review and code/experiment audit",
      ].join("\n"),
    }),
    event: {
      type: "agent-idle",
      source: "session",
      turnMarker: "watchlist-turn",
      message: "cycle 2 finished; score is flat against cycle 1",
    },
    orchestratorReport: {
      recommendation: {
        action: "continue-active",
        reason: "ACTIVE has v070; continue or finish that move before claiming another.",
        slug: "v070",
      },
      projectContext: {
        activeHead: "v070; result doc results/v070.md; branch r/v070",
      },
    },
  });
  assert.equal(decision.action, "directive");
  assert.equal(decision.shouldSend, true);
  assert.match(decision.directive.text, /Worker: cycle 2 finished/);
  assert.doesNotMatch(decision.directive.text, /Supervisor look-fors:/);
});

test("research supervisor only auto-directs at worker handoff unless explicitly told", () => {
  const report = {
    recommendation: {
      action: "continue-active",
      reason: "ACTIVE has v070; continue or finish that move before claiming another.",
      slug: "v070",
    },
  };

  const ordinaryTick = decideResearchSupervisorIntervention({
    attachment: attachment(),
    event: { type: "tick", source: "session" },
    orchestratorReport: report,
  });
  assert.equal(ordinaryTick.action, "silent");
  assert.equal(ordinaryTick.shouldSend, false);
  assert.match(ordinaryTick.reason, /worker handoff/);

  const stillRunning = decideResearchSupervisorIntervention({
    attachment: attachment({ runtime: { streamWorking: true } }),
    event: { type: "agent-idle", source: "session", turnMarker: "premature-idle" },
    orchestratorReport: report,
  });
  assert.equal(stillRunning.action, "silent");
  assert.equal(stillRunning.shouldSend, false);
  assert.match(stillRunning.reason, /worker is still running/);

  const explicitTellWorker = decideResearchSupervisorIntervention({
    attachment: attachment({ runtime: { streamWorking: true } }),
    event: { type: "manual-action", action: "continue", source: "human" },
    orchestratorReport: report,
  });
  assert.equal(explicitTellWorker.action, "directive");
  assert.equal(explicitTellWorker.shouldSend, true);
  assert.match(explicitTellWorker.directive.text, /Resume v070/);

  const handoff = decideResearchSupervisorIntervention({
    attachment: attachment({ runtime: { streamWorking: false } }),
    event: { type: "agent-idle", source: "session", turnMarker: "turn-complete" },
    orchestratorReport: report,
  });
  assert.equal(handoff.action, "directive");
  assert.equal(handoff.shouldSend, true);
});

test("research supervisor emits worker-idle directives and dedupes later idle checks", () => {
  const report = {
    recommendation: {
      action: "run-next",
      reason: "QUEUE row 1 is baseline; claim it and run the next cycle.",
      slug: "baseline",
    },
    projectContext: {
      goal: "Find the prompt scaffold that produces the most readable short-form answers.",
      rankingCriterion: "qualitative: readability (1-5 rubric, higher is better)",
      successCriteria: ["Readability score >= 4.0 mean.", "Judge agreement >= 0.6."],
      queueHead: "baseline; from main; why establish the first reproducible baseline",
      leaderboardHead: "rank 1; v2-scaffold; score 4.1 mean",
      latestLog: "2026-04-28; resolved+admitted; v2-scaffold; scaffold improved readability",
      benchmark: {
        exists: true,
        version: "v1",
        status: "active",
        metrics: ["readability"],
        datasets: ["golden", "dev"],
      },
    },
  };
  const first = decideResearchSupervisorIntervention({
    attachment: attachment(),
    event: { type: "agent-idle", source: "session", turnMarker: "turn-1" },
    orchestratorReport: report,
  });
  assert.equal(first.action, "directive");
  assert.equal(first.shouldSend, true);
  assert.match(first.directive.text, /Claim QUEUE row 1/);
  assert.match(first.directive.text, /result doc\/ACTIVE/);
  assert.match(first.directive.text, /safe idle GPUs/);
  assert.match(first.directive.text, /Set monitor\/wakeup/);
  assert.doesNotMatch(first.directive.text, /\n/);
  assert.doesNotMatch(first.directive.text, /^(State|Goal|Ranking|Success|Supervisor policy):/m);
  assert.ok(first.directive.text.length < 360, `directive was too long: ${first.directive.text.length}`);
  assert.equal(first.card.mode, "experiment");
  assert.match(first.card.evidence, /pre-flight/);
  assert.match(first.card.evidence, /validation\/qual review plan/);
  assert.match(first.card.compute, /safe idle GPUs saturated/);
  assert.match(first.card.continuity, /no active monitor\/wakeup is visible/);

  const supervisor = updateResearchSupervisorState(
    normalizeResearchSupervisorState(),
    first,
    { type: "agent-idle", source: "session", turnMarker: "turn-1" },
    { now: "2026-05-01T12:00:00.000Z" },
  );
  const duplicate = decideResearchSupervisorIntervention({
    attachment: attachment({ supervisor }),
    event: { type: "agent-idle", source: "session", turnMarker: "turn-1" },
    orchestratorReport: report,
  });
  assert.equal(duplicate.action, "silent");
  assert.equal(duplicate.shouldSend, false);
  assert.match(duplicate.reason, /already sent/);
  assert.equal(supervisor.interventionCount, 1);

  const recovered = decideResearchSupervisorIntervention({
    attachment: attachment({ supervisor }),
    event: { type: "recover-exited", source: "session" },
    orchestratorReport: report,
  });
  assert.equal(recovered.action, "directive");
  assert.equal(recovered.shouldSend, true);
  assert.match(recovered.directive.text, /Claim QUEUE row 1/);
});

test("research supervisor falls back to the project goal when no chat objective is set", () => {
  const decision = decideResearchSupervisorIntervention({
    attachment: attachment({ objective: "" }),
    event: { type: "agent-idle", source: "session" },
    orchestratorReport: {
      recommendation: {
        action: "run-next",
        reason: "QUEUE row 1 is ready.",
        slug: "baseline",
      },
      projectContext: {
        goal: "Use the wiki goal as the supervisor north star.",
        queueHead: "baseline; from main; why establish a baseline",
      },
    },
  });
  assert.equal(decision.action, "directive");
  assert.equal(decision.shouldSend, true);
  assert.match(decision.directive.text, /Claim QUEUE row 1 \(baseline\)/);
  assert.doesNotMatch(decision.directive.text, /Use the wiki goal as the supervisor north star/);
});

test("research supervisor compacts long objectives and keeps tactical priorities", () => {
  const longGoal = [
    "Updated 2026-04-25. Build a text-conditioned semantic patch-filter that replaces AutoGaze in the NVILA pipeline.",
    "The filter consumes question text and video frames, emits sparse top-K patch selection, and must verify iso-accuracy efficiency gain.",
    "Tier 1 checks feature-level fidelity, Tier 2 checks retention curves and question-conditioning diagnostics, and Tier 3 checks end-to-end VQA Pareto frontier.",
    "Pre-goal-change AutoGaze budget ladder rows are reference baselines with extensive comparison language that should stay in the README instead of being dumped into every supervisor message.",
    "TAIL_SENTINEL_SHOULD_NOT_APPEAR_IN_DIRECTIVE",
  ].join(" ");
  const decision = decideResearchSupervisorIntervention({
    attachment: attachment({ objective: longGoal, projectName: "semantic-autogaze" }),
    event: { type: "agent-idle", source: "session" },
    orchestratorReport: {
      recommendation: {
        action: "continue-active",
        reason: "ACTIVE has v070; continue or finish that move before claiming another.",
        slug: "v070-cocoonly-mlp-multiprompt-aggrAug",
      },
      projectContext: {
        goal: longGoal,
        activeHead: "v070-cocoonly-mlp-multiprompt-aggrAug; result doc results/v070.md; branch r/v070",
      },
    },
  });
  assert.equal(decision.action, "directive");
  assert.equal(decision.shouldSend, true);
  assert.match(decision.directive.text, /Resume v070-cocoonly/);
  assert.doesNotMatch(decision.directive.text, /TAIL_SENTINEL_SHOULD_NOT_APPEAR_IN_DIRECTIVE/);
  assert.doesNotMatch(decision.directive.text, /Build a text-conditioned semantic patch-filter/);
  assert.match(decision.directive.text, /logs\/GPU\/artifacts/);
  assert.match(decision.directive.text, /key qualitative artifacts/);
  assert.match(decision.directive.text, /Set monitor\/wakeup/);
  assert.doesNotMatch(decision.directive.text, /\n/);
  assert.equal(decision.card.mode, "continue");
  assert.ok(decision.directive.text.length < 320, `directive was too long: ${decision.directive.text.length}`);
});

test("research supervisor changes automatic directives only after new worker evidence", () => {
  const report = {
    recommendation: {
      action: "continue-active",
      reason: "ACTIVE has v070; continue or finish that move before claiming another.",
      slug: "v070",
    },
  };
  const first = decideResearchSupervisorIntervention({
    attachment: attachment(),
    event: { type: "agent-idle", source: "session", turnMarker: "turn-1" },
    orchestratorReport: report,
  });
  assert.equal(first.action, "directive");
  assert.equal(first.shouldSend, true);

  const supervisor = updateResearchSupervisorState(
    normalizeResearchSupervisorState(),
    first,
    { type: "agent-idle", source: "session", turnMarker: "turn-1" },
    { now: "2026-05-01T12:00:00.000Z" },
  );
  const duplicateSameTurn = decideResearchSupervisorIntervention({
    attachment: attachment({ supervisor }),
    event: { type: "agent-idle", source: "session", turnMarker: "turn-1" },
    orchestratorReport: report,
  });
  assert.equal(duplicateSameTurn.action, "silent");
  assert.equal(duplicateSameTurn.shouldSend, false);

  const nextTurn = decideResearchSupervisorIntervention({
    attachment: attachment({ supervisor }),
    event: { type: "agent-idle", source: "session", turnMarker: "turn-2" },
    orchestratorReport: report,
  });
  assert.equal(nextTurn.action, "silent");
  assert.equal(nextTurn.shouldSend, false);
  assert.match(nextTurn.reason, /already sent/);

  const newWorkerEvidence = decideResearchSupervisorIntervention({
    attachment: attachment({ supervisor }),
    event: {
      type: "agent-idle",
      source: "session",
      turnMarker: "turn-3",
      message: "cycle 1 finished with metric=0.42; validation heatmaps are missing",
    },
    orchestratorReport: report,
  });
  assert.equal(newWorkerEvidence.action, "directive");
  assert.equal(newWorkerEvidence.shouldSend, true);
  assert.notEqual(newWorkerEvidence.directive.text, first.directive.text);
  assert.match(newWorkerEvidence.directive.text, /Worker: cycle 1 finished with metric=0\.42/);
});

test("research supervisor gives active-move execution briefs", () => {
  const decision = decideResearchSupervisorIntervention({
    attachment: attachment(),
    event: { type: "agent-idle", source: "session" },
    orchestratorReport: {
      recommendation: {
        action: "continue-active",
        reason: "ACTIVE has v070; continue or finish that move before claiming another.",
        slug: "v070",
      },
      nextCommand: "vr-research-runner /tmp/project cycle --slug v070 --command <experiment-command>",
    },
  });
  assert.equal(decision.action, "directive");
  assert.equal(decision.shouldSend, true);
  assert.match(decision.directive.text, /Resume v070/);
  assert.match(decision.directive.text, /logs\/GPU\/artifacts/);
  assert.match(decision.directive.text, /run evals/);
  assert.doesNotMatch(decision.directive.text, /vr-research-runner/);
  assert.doesNotMatch(decision.directive.text, /Autopilot/i);
});

test("research supervisor notices monitor and wakeup continuity state", () => {
  const noMonitor = decideResearchSupervisorIntervention({
    attachment: attachment({
      runtime: {
        backgroundActivity: { active: true, activeCount: 2 },
        activeBackgroundTasks: 2,
        recentTraceHasMonitor: false,
        recentTraceHasWakeup: false,
      },
    }),
    event: { type: "agent-idle", source: "session" },
    orchestratorReport: {
      recommendation: {
        action: "continue-active",
        reason: "ACTIVE has v070; continue or finish that move before claiming another.",
        slug: "v070",
      },
    },
  });
  assert.equal(noMonitor.shouldSend, true);
  assert.match(noMonitor.directive.text, /2 background tasks visible; set monitor\/wakeup/);
  assert.match(noMonitor.card.continuity, /2 background tasks?/);

  const withMonitor = decideResearchSupervisorIntervention({
    attachment: attachment({
      runtime: {
        recentTraceHasMonitor: true,
        summary: "Monitor started for train.log",
      },
    }),
    event: { type: "agent-idle", source: "session" },
    orchestratorReport: {
      recommendation: {
        action: "continue-active",
        reason: "ACTIVE has v070; continue or finish that move before claiming another.",
        slug: "v070",
      },
    },
  });
  assert.equal(withMonitor.shouldSend, true);
  assert.doesNotMatch(withMonitor.directive.text, /Monitor\/wakeup is visible/);
  assert.doesNotMatch(withMonitor.directive.text, /no active monitor\/wakeup is visible/);
  assert.match(withMonitor.card.continuity, /Monitor started for train\.log/);
  assert.match(withMonitor.card.continuity, /monitor\/wakeup visible/);
});

test("research supervisor gates missing project instead of messaging worker", () => {
  const decision = decideResearchSupervisorIntervention({
    attachment: attachment({ projectName: "" }),
    event: { type: "agent-idle", source: "session" },
    orchestratorReport: {
      recommendation: { action: "run-next", reason: "QUEUE row 1 is ready", slug: "baseline" },
    },
  });
  assert.equal(decision.action, "human-gate");
  assert.equal(decision.shouldSend, false);
});

test("research supervisor does not override worker clarification prompts", () => {
  const decision = decideResearchSupervisorIntervention({
    attachment: attachment(),
    event: {
      type: "agent-idle",
      source: "session",
      message: "Pausing before I spend GPU. A: run the queued sweep. B: scope the architecture pivot. Which should I do?",
    },
    orchestratorReport: {
      recommendation: { action: "run-next", reason: "QUEUE row 1 is ready", slug: "baseline" },
    },
  });
  assert.equal(decision.action, "human-gate");
  assert.equal(decision.shouldSend, false);
  assert.equal(decision.directive, undefined);
  assert.match(decision.reason, /human research-direction decision/);
});
