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

test("research supervisor emits and dedupes automatic idle directives", () => {
  const report = {
    recommendation: {
      action: "run-next",
      reason: "QUEUE row 1 is baseline; claim it and run the next cycle.",
      slug: "baseline",
    },
  };
  const first = decideResearchSupervisorIntervention({
    attachment: attachment(),
    event: { type: "agent-idle", source: "session" },
    orchestratorReport: report,
  });
  assert.equal(first.action, "directive");
  assert.equal(first.shouldSend, true);
  assert.match(first.directive.text, /Claim QUEUE row 1/);

  const supervisor = updateResearchSupervisorState(
    normalizeResearchSupervisorState(),
    first,
    { type: "agent-idle", source: "session" },
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
