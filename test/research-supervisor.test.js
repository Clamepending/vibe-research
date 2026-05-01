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
  });
  assert.equal(decision.action, "directive");
  assert.equal(decision.shouldSend, true);
  assert.match(decision.directive.text, /Synthesize the current research state/);
  assert.doesNotMatch(decision.directive.text, /Autopilot/i);
});

test("research supervisor emits immediate takeover directives and dedupes later idle checks", () => {
  const report = {
    recommendation: {
      action: "run-next",
      reason: "QUEUE row 1 is baseline; claim it and run the next cycle.",
      slug: "baseline",
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
  assert.match(first.directive.text, /Use the project objective as the north star: Improve concise prose style/);
  assert.match(first.directive.text, /representative project photos\/videos, samples, and heatmaps/);
  assert.match(first.directive.text, /idle GPUs or sibling runs/);

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
