import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { AgentTownStore } from "../src/agent-town-store.js";

async function createTempStateDir() {
  return mkdtemp(path.join(os.tmpdir(), "vibe-research-agent-town-state-"));
}

async function removeTempStateDir(stateDir) {
  await rm(stateDir, { recursive: true, force: true });
}

test("AgentTownStore completes action items and releases waits from mirrored layout state", async () => {
  const stateDir = await createTempStateDir();
  const store = new AgentTownStore({ stateDir });

  try {
    await store.initialize();
    await store.createActionItem({
      id: "onboarding-first-building",
      kind: "setup",
      priority: "high",
      title: "Place your first building",
      href: "?view=swarm",
      cta: "Open Agent Town",
      predicate: "first_building_placed",
      source: "test",
      sourceSessionId: "session-1",
      target: {
        type: "building",
        id: "buildinghub",
        label: "BuildingHub",
      },
      capabilityIds: ["ui-guidance", "runs_shell", "ui-guidance"],
    });

    const waitPromise = store.waitForPredicate({
      predicate: "first_building_placed",
      timeoutMs: 5_000,
    });

    await store.updateMirror({
      layoutSummary: {
        cosmeticCount: 1,
        functionalCount: 0,
        functionalIds: [],
        pendingFunctionalIds: [],
        themeId: "default",
      },
    });

    const waitResult = await waitPromise;
    assert.equal(waitResult.satisfied, true);

    const state = store.getState();
    assert.equal(state.layoutSummary.cosmeticCount, 1);
    assert.equal(state.actionItems[0].kind, "setup");
    assert.equal(state.actionItems[0].priority, "high");
    assert.equal(state.actionItems[0].sourceSessionId, "session-1");
    assert.deepEqual(state.actionItems[0].target, {
      type: "building",
      id: "buildinghub",
      label: "BuildingHub",
      href: "",
    });
    assert.deepEqual(state.actionItems[0].capabilityIds, ["ui-guidance", "runs-shell"]);
    assert.equal(state.actionItems[0].status, "completed");
    assert.ok(state.actionItems[0].completedAt);
  } finally {
    await removeTempStateDir(stateDir);
  }
});

test("AgentTownStore persists signals and supports immediate predicate waits after reload", async () => {
  const stateDir = await createTempStateDir();

  try {
    const firstStore = new AgentTownStore({ stateDir });
    await firstStore.initialize();
    await firstStore.recordEvent({
      type: "agent_clicked",
      label: "Canvas Agent",
      metadata: { sessionId: "session-1" },
    });

    const secondStore = new AgentTownStore({ stateDir });
    await secondStore.initialize();
    assert.equal(secondStore.getState().signals.agentClickedCount, 1);

    const waitResult = await secondStore.waitForPredicate({
      predicate: "agent_clicked",
      timeoutMs: 50,
    });
    assert.equal(waitResult.satisfied, true);
    assert.equal(waitResult.state.events[0].label, "Canvas Agent");
  } finally {
    await removeTempStateDir(stateDir);
  }
});

test("AgentTownStore normalizes approval metadata while preserving backward-compatible action defaults", async () => {
  const stateDir = await createTempStateDir();
  const store = new AgentTownStore({ stateDir });

  try {
    await store.initialize();
    const { actionItem } = await store.createActionItem({
      id: "approval:send-email",
      kind: "approval",
      priority: "urgent",
      title: "Approve outbound email",
      detail: "Review the draft before the communications agent sends it.",
      cta: "Review",
      href: "?view=agent-inbox",
      source: "telegram",
      sourceAgentId: "agent-42",
      sourceSessionId: "session-42",
      target: {
        type: "library-note",
        id: "comms/drafts/email.md",
        label: "Draft email",
        href: "?view=knowledge-base",
      },
      capabilityIds: ["sends_messages", "Sends Messages", "", "uses-browser"],
      predicate: "action_item_completed",
      predicateParams: { actionItemId: "approval:send-email" },
    });

    assert.equal(actionItem.kind, "approval");
    assert.equal(actionItem.priority, "urgent");
    assert.equal(actionItem.source, "telegram");
    assert.equal(actionItem.sourceAgentId, "agent-42");
    assert.equal(actionItem.sourceSessionId, "session-42");
    assert.deepEqual(actionItem.target, {
      type: "library_note",
      id: "comms/drafts/email.md",
      label: "Draft email",
      href: "?view=knowledge-base",
    });
    assert.deepEqual(actionItem.capabilityIds, ["sends-messages", "uses-browser"]);
    assert.equal(actionItem.predicate, "action_item_completed");
    assert.equal(actionItem.id, "approval-send-email");
    assert.equal(actionItem.predicateParams.actionItemId, "approval-send-email");

    const { actionItem: fallbackAction } = await store.createActionItem({
      id: "plain",
      title: "Plain action",
    });
    assert.equal(fallbackAction.kind, "action");
    assert.equal(fallbackAction.priority, "normal");
    assert.equal(fallbackAction.target, null);
    assert.deepEqual(fallbackAction.capabilityIds, []);
  } finally {
    await removeTempStateDir(stateDir);
  }
});

test("AgentTownStore upserts and persists per-session canvases", async () => {
  const stateDir = await createTempStateDir();

  try {
    const firstStore = new AgentTownStore({ stateDir });
    await firstStore.initialize();
    const { canvas } = await firstStore.upsertCanvas({
      sourceSessionId: "session-1",
      sourceAgentId: "agent-1",
      title: "Learning curve",
      caption: "Validation accuracy by epoch.",
      imagePath: "results/curve.png",
      href: "?view=knowledge-base",
    });

    assert.equal(canvas.id, "session-1");
    assert.equal(canvas.sourceSessionId, "session-1");
    assert.equal(canvas.sourceAgentId, "agent-1");
    assert.equal(canvas.title, "Learning curve");
    assert.equal(canvas.caption, "Validation accuracy by epoch.");
    assert.equal(canvas.imagePath, "results/curve.png");

    await firstStore.upsertCanvas({
      sourceSessionId: "session-1",
      title: "Updated curve",
      imagePath: "",
      imageUrl: "https://example.test/updated.png",
    });

    const reloadedStore = new AgentTownStore({ stateDir });
    await reloadedStore.initialize();
    const state = reloadedStore.getState();
    assert.equal(state.canvases.length, 1);
    assert.equal(state.canvases[0].id, "session-1");
    assert.equal(state.canvases[0].title, "Updated curve");
    assert.equal(state.canvases[0].imagePath, "");
    assert.equal(state.canvases[0].imageUrl, "https://example.test/updated.png");

    await reloadedStore.deleteCanvas("session-1");
    assert.equal(reloadedStore.getState().canvases.length, 0);
  } finally {
    await removeTempStateDir(stateDir);
  }
});
