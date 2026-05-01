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

test("research supervisor keeps toggle and human-message events context-neutral", () => {
  const toggle = decideResearchSupervisorIntervention({
    attachment: attachment(),
    event: { type: "toggle-on", source: "human" },
    orchestratorReport: {
      recommendation: { action: "run-next", reason: "QUEUE row 1 is ready", slug: "baseline" },
    },
  });
  assert.equal(toggle.action, "silent");
  assert.equal(toggle.shouldSend, false);

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
  assert.match(decision.directive.text, /Project contract:/);
  assert.match(decision.directive.text, /Goal: Find the prompt scaffold/);
  assert.match(decision.directive.text, /Queue head: baseline/);
  assert.match(decision.directive.text, /qualitative sample\/heatmap status/);
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
  assert.match(decision.directive.text, /Resume the active research move v070/);
  assert.match(decision.directive.text, /Project contract:/);
  assert.match(decision.directive.text, /Active: v070/);
});

test("research supervisor emits immediate takeover directives and dedupes later idle checks", () => {
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
    event: { type: "takeover", source: "session" },
    orchestratorReport: report,
  });
  assert.equal(first.action, "directive");
  assert.equal(first.shouldSend, true);
  assert.match(first.directive.text, /Claim QUEUE row 1/);
  assert.match(first.directive.text, /First inspect the durable project state/);
  assert.match(first.directive.text, /Project contract:/);
  assert.match(first.directive.text, /Goal: Find the prompt scaffold/);
  assert.match(first.directive.text, /Ranking: qualitative: readability/);
  assert.match(first.directive.text, /Queue head: baseline/);
  assert.match(first.directive.text, /Latest log: 2026-04-28/);
  assert.match(first.directive.text, /Benchmark: version v1, status active/);
  assert.match(first.directive.text, /Use the project objective as the north star: Improve concise prose style/);
  assert.match(first.directive.text, /Supervisor priorities:/);
  assert.match(first.directive.text, /create or update heatmaps on validation photos\/videos/);
  assert.match(first.directive.text, /Parallelize independent experiments across idle GPUs/);
  assert.match(first.directive.text, /lightweight literature\/current-docs pass/);
  assert.match(first.directive.text, /ablations and small factorial studies/);

  const supervisor = updateResearchSupervisorState(
    normalizeResearchSupervisorState(),
    first,
    { type: "takeover", source: "session" },
    { now: "2026-05-01T12:00:00.000Z" },
  );
  const duplicate = decideResearchSupervisorIntervention({
    attachment: attachment({ supervisor }),
    event: { type: "agent-idle", source: "session" },
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
    event: { type: "takeover", source: "session" },
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
  assert.match(decision.directive.text, /Use the project objective as the north star: Use the wiki goal/);
  assert.match(decision.directive.text, /Goal: Use the wiki goal as the supervisor north star/);
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
  assert.match(decision.directive.text, /Resume the active research move v070-cocoonly/);
  assert.match(decision.directive.text, /full text is in README/);
  assert.match(decision.directive.text, /Build a text-conditioned semantic patch-filter/);
  assert.doesNotMatch(decision.directive.text, /TAIL_SENTINEL_SHOULD_NOT_APPEAR_IN_DIRECTIVE/);
  assert.match(decision.directive.text, /create or update heatmaps on validation photos\/videos/);
  assert.match(decision.directive.text, /Parallelize independent experiments across idle GPUs/);
  assert.match(decision.directive.text, /literature\/current-docs pass/);
  assert.match(decision.directive.text, /ablations and small factorial studies/);
  assert.ok(decision.directive.text.length < 2600, `directive was too long: ${decision.directive.text.length}`);
});

test("research supervisor dedupes automatic directives by completed turn marker", () => {
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
  assert.equal(nextTurn.action, "directive");
  assert.equal(nextTurn.shouldSend, true);
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
  assert.match(decision.directive.text, /Resume the active research move v070/);
  assert.match(decision.directive.text, /If a cycle is already running/);
  assert.match(decision.directive.text, /Useful command path: vr-research-runner/);
  assert.doesNotMatch(decision.directive.text, /Autopilot/i);
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
