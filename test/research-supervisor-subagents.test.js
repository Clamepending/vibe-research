import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createVibeResearchApp } from "../src/create-app.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_LIBRARY = path.join(HERE, "fixtures", "research", "library");
const WORKSPACE_LIBRARY_RELATIVE = path.join("vibe-research", "buildings", "library");

async function copyDir(src, dest) {
  const fs = await import("node:fs");
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await copyFile(from, to);
  }
}

async function writeClaudeSubagent(homeDir, cwd, sessionId, {
  agentId = "a1234567890abcdef",
  description = "Research helper",
  agentType = "general-purpose",
  timestamps = null,
  complete = false,
} = {}) {
  const resolvedTimestamps = Array.isArray(timestamps) && timestamps.length >= 2
    ? timestamps
    : [new Date(Date.now() - 1_000).toISOString(), new Date().toISOString()];
  const projectDir = path.join(homeDir, ".claude", "projects", path.resolve(cwd).replaceAll(path.sep, "-"));
  const subagentsDir = path.join(projectDir, sessionId, "subagents");
  const fileBase = `agent-${agentId}`;
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(
    path.join(subagentsDir, `${fileBase}.meta.json`),
    `${JSON.stringify({ agentType, description })}\n`,
    "utf8",
  );
  const lines = [
    {
      type: "user",
      isSidechain: true,
      agentId,
      promptId: "prompt-1",
      timestamp: resolvedTimestamps[0],
      message: { role: "user", content: "Inspect validation failures in parallel." },
    },
    {
      type: "assistant",
      isSidechain: true,
      agentId,
      timestamp: resolvedTimestamps[1],
      message: {
        role: "assistant",
        stop_reason: complete ? "end_turn" : "tool_use",
        content: complete
          ? [{ type: "text", text: "Finished." }]
          : [{ type: "tool_use", name: "Read", input: { file_path: "figures/failure-grid.png" } }],
      },
    },
  ];
  await writeFile(
    path.join(subagentsDir, `${fileBase}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
}

async function rmTreeWithRetry(target) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  if (lastError) throw lastError;
}

async function withLibraryServer(fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-supervisor-subagents-"));
  const libraryRoot = path.join(tmp, WORKSPACE_LIBRARY_RELATIVE);
  await copyDir(FIXTURE_LIBRARY, libraryRoot);

  const previousWorkspace = process.env.VIBE_RESEARCH_WORKSPACE_DIR;
  const previousHome = process.env.HOME;
  process.env.VIBE_RESEARCH_WORKSPACE_DIR = tmp;
  process.env.HOME = tmp;
  let app = null;
  try {
    app = await createVibeResearchApp({
      host: "127.0.0.1",
      port: 0,
      cwd: tmp,
      stateDir: path.join(tmp, ".vibe-research"),
      persistSessions: false,
      persistentTerminals: false,
      sleepPreventionFactory: (settings) =>
        new SleepPreventionService({ enabled: settings.preventSleepEnabled, platform: "test" }),
    });
    await fn({ app, baseUrl: `http://127.0.0.1:${app.config.port}`, workspaceDir: tmp, homeDir: tmp });
  } finally {
    if (app) await app.close();
    if (previousWorkspace === undefined) delete process.env.VIBE_RESEARCH_WORKSPACE_DIR;
    else process.env.VIBE_RESEARCH_WORKSPACE_DIR = previousWorkspace;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rmTreeWithRetry(tmp);
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("supervisor runtime counts real Claude sidechain subagent transcripts", async () => {
  await withLibraryServer(async ({ app, baseUrl, workspaceDir, homeDir }) => {
    const claudeSessionId = "22222222-3333-4444-8555-666666666666";
    await writeClaudeSubagent(homeDir, workspaceDir, claudeSessionId, {
      description: "Validation artifact scout",
      agentType: "explorer",
      complete: false,
    });

    const session = app.sessionManager.buildSessionRecord({
      id: "claude-parent-with-sidechain",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Claude parent with sidechain",
      cwd: workspaceDir,
      status: "running",
      streamMode: true,
      providerState: {
        sessionId: claudeSessionId,
      },
    });
    session.streamWorking = false;
    app.sessionManager.sessions.set(session.id, session);

    const saved = await putJson(`${baseUrl}/api/sessions/${session.id}/research-autopilot`, {
      enabled: true,
      projectName: "prose-style",
      objective: "make prose more concise while preserving evidence",
      driver: "session",
      mode: "auto",
    });
    assert.equal(saved.response.status, 200);

    const tick = await postJson(`${baseUrl}/api/sessions/${session.id}/research-autopilot/supervisor/tick`, {
      event: { type: "agent-idle", source: "session", turnMarker: "claude-sidechain-visible" },
    });
    assert.equal(tick.response.status, 200);
    assert.equal(tick.body.runtime.activeSubagents, 1);
    assert.match(tick.body.runtime.summary, /1 active subagent/);
    assert.equal(tick.body.decision.shouldSend, true);
    assert.match(tick.body.directive.text, /1 active subagent visible; set monitor\/wakeup/);
    assert.match(tick.body.decision.card.continuity, /1 active subagent/);
  });
});

test("supervisor side history treats human chat as steering and worker/subagent activity as observations", async () => {
  await withLibraryServer(async ({ app, baseUrl }) => {
    const created = await postJson(`${baseUrl}/api/sessions`, {
      providerId: "claude",
      name: "Supervisor side-chat actor model",
    });
    assert.equal(created.response.status, 201);
    const session = created.body.session;
    const serverSession = app.sessionManager.getSession(session.id);
    assert.ok(serverSession);
    serverSession.streamMode = true;
    serverSession.streamWorking = false;

    app.sessionManager.setExtraSubagentsProvider((candidate) => {
      if (candidate.id !== session.id) return [];
      return [
        {
          id: "subagent-heatmap-review",
          name: "Heatmap review",
          source: "codex",
          status: "working",
          updatedAt: "2026-05-01T12:10:00.000Z",
          messageCount: 3,
          toolUseCount: 1,
        },
      ];
    });

    app.sessionManager.pushNativeNarrativeEntry(serverSession, {
      kind: "assistant",
      label: "Claude Code",
      text: "I launched the ablation sweep and the heatmap review subagent is still inspecting failures.",
      timestamp: "2026-05-01T12:10:00.000Z",
      meta: "completed",
    });

    const saved = await putJson(`${baseUrl}/api/sessions/${session.id}/research-autopilot`, {
      enabled: true,
      projectName: "prose-style",
      objective: "make prose more concise while preserving evidence",
      driver: "session",
      mode: "auto",
    });
    assert.equal(saved.response.status, 200);

    const humanMessageText = "Should the supervisor ask for lit review or ablations next?";
    const humanTick = await postJson(`${baseUrl}/api/sessions/${session.id}/research-autopilot/supervisor/tick`, {
      event: { type: "human-message", source: "human" },
      observedMessage: humanMessageText,
    });
    assert.equal(humanTick.response.status, 200);
    assert.equal(humanTick.body.decision.action, "silent");
    assert.equal(humanTick.body.decision.shouldSend, false);
    assert.equal(humanTick.body.directive, null);
    assert.equal(humanTick.body.runtime.activeSubagents, 1);
    assert.equal(humanTick.body.attachment.lastMessage, humanMessageText);
    assert.equal(humanTick.body.attachment.supervisor.interventionCount, 0);
    assert.equal(humanTick.body.attachment.supervisor.lastObservedEvent, "human-message");
    assert.deepEqual(
      humanTick.body.attachment.supervisor.audit.slice(-1).map((entry) => [entry.event, entry.action]),
      [["human-message", "silent"]],
    );
    assert.deepEqual(
      humanTick.body.attachment.supervisor.thread.slice(-1).map((entry) => [entry.role, entry.kind, entry.text]),
      [["human", "human-message", humanMessageText]],
    );

    const subagentObservation = await postJson(`${baseUrl}/api/sessions/${session.id}/research-autopilot/supervisor/tick`, {
      event: {
        type: "agent-idle",
        source: "subagent",
        subagentName: "Heatmap review",
        turnMarker: "heatmap-review-paused",
      },
    });
    assert.equal(subagentObservation.response.status, 200);
    assert.equal(subagentObservation.body.runtime.activeSubagents, 1);
    assert.equal(subagentObservation.body.runtime.hasContinuity, false);
    assert.equal(subagentObservation.body.decision.action, "directive");
    assert.equal(subagentObservation.body.decision.shouldSend, true);
    assert.match(subagentObservation.body.directive.text, /Resume |Claim QUEUE row 1/);
    assert.match(subagentObservation.body.directive.text, /safe idle GPUs|logs\/GPU\/artifacts/);
    assert.match(subagentObservation.body.directive.text, /1 active subagent visible; set monitor\/wakeup/);
    assert.doesNotMatch(subagentObservation.body.directive.text, /\n/);
    assert.equal(subagentObservation.body.attachment.supervisor.interventionCount, 1);
    assert.deepEqual(
      subagentObservation.body.attachment.supervisor.audit.slice(-2).map((entry) => [entry.event, entry.action]),
      [
        ["human-message", "silent"],
        ["agent-idle", "directive"],
      ],
    );
    const subagentThreadTail = subagentObservation.body.attachment.supervisor.thread.slice(-2);
    assert.deepEqual(
      subagentThreadTail.map((entry) => [entry.role, entry.kind]),
      [
        ["worker", "agent-idle"],
        ["directive", "directive_sent"],
      ],
    );
    assert.equal(subagentThreadTail[0].title, "Subagent observed · Heatmap review");
    assert.match(subagentThreadTail[1].title, /run bounded cycle|continue active move/);

    app.sessionManager.pushNativeNarrativeEntry(serverSession, {
      kind: "assistant",
      label: "Claude Code",
      text: "Monitor started for heatmap-review: tail -F /tmp/heatmap-review.log. Completion signal is HEATMAP_REVIEW_DONE.",
      timestamp: "2026-05-01T12:12:00.000Z",
      meta: "completed",
    });

    const monitoredObservation = await postJson(`${baseUrl}/api/sessions/${session.id}/research-autopilot/supervisor/tick`, {
      event: { type: "agent-idle", source: "session", turnMarker: "worker-armed-monitor" },
    });
    assert.equal(monitoredObservation.response.status, 200);
    assert.equal(monitoredObservation.body.runtime.activeSubagents, 1);
    assert.equal(monitoredObservation.body.runtime.hasContinuity, true);
    assert.equal(monitoredObservation.body.runtime.recentTraceHasMonitor, true);
    assert.match(monitoredObservation.body.decision.card.continuity, /monitor\/wakeup visible/);
    assert.doesNotMatch(monitoredObservation.body.decision.card.continuity, /do not see a monitor\/wakeup/);

    const projectSupervisor = await fetch(`${baseUrl}/api/research/projects/prose-style/supervisor`);
    assert.equal(projectSupervisor.status, 200);
    const projectBody = await projectSupervisor.json();
    assert.equal(projectBody.supervisor.primarySessionId, session.id);
    assert.deepEqual(projectBody.supervisor.sessionIds, [session.id]);
    assert.equal(projectBody.supervisor.supervisor.interventionCount, 2);
    assert.deepEqual(
      projectBody.supervisor.supervisor.audit.map((entry) => [entry.event, entry.action]),
      [
        ["human-message", "silent"],
        ["agent-idle", "directive"],
        ["agent-idle", "directive"],
      ],
    );
  });
});
