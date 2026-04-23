import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { VideoMemoryService } from "../src/videomemory-service.js";

function createFetch(responses = []) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const next = responses.shift() || { ok: true, status: 200, body: {} };
    return {
      ok: next.ok ?? true,
      status: next.status || 200,
      async json() {
        return next.body;
      },
      async text() {
        return JSON.stringify(next.body);
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function createSessionManager(initialSessions = []) {
  const sessions = new Map(initialSessions.map((session) => [session.id, { ...session }]));
  const createdSessions = [];
  const writes = [];

  return {
    createdSessions,
    sessions,
    writes,
    createSession(input) {
      const session = {
        id: `created-${createdSessions.length + 1}`,
        name: input.name,
        providerId: input.providerId,
        providerLabel: input.providerId,
        cwd: input.cwd || process.cwd(),
        status: "running",
      };
      sessions.set(session.id, session);
      createdSessions.push(session);
      return session;
    },
    getSession(sessionId) {
      return sessions.get(sessionId) || null;
    },
    write(sessionId, input) {
      if (!sessions.has(sessionId)) {
        return false;
      }
      writes.push({ sessionId, input });
      return true;
    },
  };
}

test("VideoMemory monitor creation posts a task and webhook wakes the caller session", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vr-videomemory-service-"));
  const fetchImpl = createFetch([{ body: { status: "success", task_id: "42", io_id: "net0" } }]);
  const sessionManager = createSessionManager([
    { id: "session-parent", providerId: "codex", status: "running", cwd: stateDir },
  ]);
  const service = new VideoMemoryService({
    defaultProviderId: "codex",
    fetchImpl,
    sessionManager,
    settings: {
      videoMemoryBaseUrl: "http://127.0.0.1:5050",
      videoMemoryEnabled: true,
      videoMemoryProviderId: "codex",
    },
    stateDir,
  });

  try {
    await service.initialize();
    service.setServerBaseUrl("http://127.0.0.1:4123");

    const monitor = await service.createMonitor({
      action: "Tell me what changed and decide whether to keep working.",
      callerSessionId: "session-parent",
      cwd: stateDir,
      includeFrame: true,
      includeVideo: true,
      ioId: "net0",
      providerId: "codex",
      trigger: "When a person enters the room",
    });

    assert.equal(monitor.taskId, "42");
    assert.equal(monitor.sessionId, "session-parent");
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:5050/api/tasks");
    assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), {
      bot_id: "vibe-research",
      io_id: "net0",
      save_note_frames: true,
      save_note_videos: true,
      task_description: "When a person enters the room",
    });

    const result = await service.handleWebhook({
      headers: { authorization: `Bearer ${service.webhookToken}` },
      body: {
        event_type: "task_update",
        idempotency_key: "evt-1",
        io_id: "net0",
        note: "A person in a blue jacket entered from the left.",
        note_frame_api_url: "http://127.0.0.1:5050/api/task-note-frame/7",
        task_id: "42",
      },
    });

    assert.equal(result.status, "delivered");
    assert.equal(result.sessionId, "session-parent");
    assert.equal(sessionManager.writes.length, 1);
    assert.equal(sessionManager.writes[0].sessionId, "session-parent");
    assert.match(sessionManager.writes[0].input, /VideoMemory monitor triggered/);
    assert.match(sessionManager.writes[0].input, /A person in a blue jacket/);
    assert.match(sessionManager.writes[0].input, /Tell me what changed/);
    assert.match(sessionManager.writes[0].input, /\r$/);

    const duplicate = await service.handleWebhook({
      headers: { authorization: `Bearer ${service.webhookToken}` },
      body: { idempotency_key: "evt-1", task_id: "42" },
    });
    assert.equal(duplicate.status, "suppressed");
    assert.equal(sessionManager.writes.length, 1);

    const [subagent] = service.listSubagentsForSession("session-parent");
    assert.equal(subagent.source, "videomemory");
    assert.equal(subagent.status, "working");
    assert.equal(subagent.videoMemoryMonitorId, monitor.id);

    const store = JSON.parse(await readFile(path.join(stateDir, "videomemory-monitors.json"), "utf8"));
    assert.equal(store.monitors[0].wakeCount, 1);

    const reloaded = new VideoMemoryService({
      defaultProviderId: "codex",
      fetchImpl,
      sessionManager,
      settings: {
        videoMemoryBaseUrl: "http://127.0.0.1:5050",
        videoMemoryEnabled: true,
        videoMemoryProviderId: "codex",
      },
      stateDir,
    });
    await reloaded.initialize();
    assert.equal(reloaded.listMonitors()[0].id, monitor.id);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("VideoMemory wakes Claude sessions with paste then submit", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vr-videomemory-claude-"));
  const fetchImpl = createFetch([{ body: { task_id: "7" } }]);
  const sessionManager = createSessionManager([
    { id: "claude-session", providerId: "claude", status: "running", cwd: stateDir },
  ]);
  const service = new VideoMemoryService({
    fetchImpl,
    promptDelayMs: 0,
    promptReadyIdleMs: 0,
    promptReadyTimeoutMs: 0,
    promptRetryMs: 0,
    promptSubmitDelayMs: 0,
    sessionManager,
    setTimeoutImpl(callback) {
      callback();
      return 1;
    },
    settings: {
      videoMemoryBaseUrl: "http://127.0.0.1:5050",
      videoMemoryEnabled: true,
    },
    stateDir,
  });

  try {
    await service.initialize();
    await service.createMonitor({
      callerSessionId: "claude-session",
      ioId: "0",
      providerId: "claude",
      trigger: "When the light turns green",
    });
    await service.handleWebhook({
      headers: { "x-videomemory-token": service.webhookToken },
      body: {
        event_id: "evt-claude",
        note: "The light is now green.",
        task_id: "7",
      },
    });

    assert.equal(sessionManager.writes.length, 2);
    assert.match(sessionManager.writes[0].input, /The light is now green/);
    assert.equal(sessionManager.writes[1].input, "\r");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("VideoMemory suppresses noisy monitor updates during wake cooldown", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vr-videomemory-cooldown-"));
  const fetchImpl = createFetch([{ body: { task_id: "77" } }]);
  const sessionManager = createSessionManager([
    { id: "session-parent", providerId: "codex", status: "running", cwd: stateDir },
  ]);
  let currentNow = Date.now();
  const service = new VideoMemoryService({
    defaultProviderId: "codex",
    fetchImpl,
    nowImpl: () => currentNow,
    sessionManager,
    settings: {
      videoMemoryBaseUrl: "http://127.0.0.1:5050",
      videoMemoryEnabled: true,
    },
    stateDir,
    wakeCooldownMs: 5_000,
  });

  try {
    await service.initialize();
    const monitor = await service.createMonitor({
      callerSessionId: "session-parent",
      ioId: "net0",
      providerId: "codex",
      trigger: "When the synthetic frame changes",
    });

    const first = await service.handleWebhook({
      headers: { authorization: `Bearer ${service.webhookToken}` },
      body: {
        event_id: "evt-cooldown-1",
        note: "First matching frame.",
        task_id: "77",
      },
    });
    assert.equal(first.status, "delivered");
    assert.equal(sessionManager.writes.length, 1);

    currentNow += 1000;
    const second = await service.handleWebhook({
      headers: { authorization: `Bearer ${service.webhookToken}` },
      body: {
        event_id: "evt-cooldown-2",
        note: "Another matching frame one second later.",
        task_id: "77",
      },
    });
    assert.equal(second.status, "suppressed");
    assert.equal(second.reason, "cooldown");
    assert.ok(second.retryAfterMs > 0);
    assert.equal(sessionManager.writes.length, 1);
    assert.equal(service.getMonitor(monitor.id).wakeCount, 1);

    currentNow += 5000;
    const third = await service.handleWebhook({
      headers: { authorization: `Bearer ${service.webhookToken}` },
      body: {
        event_id: "evt-cooldown-3",
        note: "The cooldown elapsed.",
        task_id: "77",
      },
    });
    assert.equal(third.status, "delivered");
    assert.equal(sessionManager.writes.length, 2);
    assert.match(sessionManager.writes[1].input, /The cooldown elapsed/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("VideoMemory surfaces camera permission webhook failures without waking the agent", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vr-videomemory-permission-webhook-"));
  const fetchImpl = createFetch([{ body: { task_id: "88" } }]);
  const sessionManager = createSessionManager([
    { id: "session-parent", providerId: "codex", status: "running", cwd: stateDir },
  ]);
  const service = new VideoMemoryService({
    defaultProviderId: "codex",
    fetchImpl,
    sessionManager,
    settings: {
      videoMemoryBaseUrl: "http://127.0.0.1:5050",
      videoMemoryEnabled: true,
    },
    stateDir,
  });

  try {
    await service.initialize();
    const monitor = await service.createMonitor({
      callerSessionId: "session-parent",
      ioId: "0",
      providerId: "codex",
      trigger: "When the camera sees a person",
    });

    const result = await service.handleWebhook({
      headers: { authorization: `Bearer ${service.webhookToken}` },
      body: {
        event_id: "evt-camera-permission",
        note: "Camera access denied. Please grant camera permissions in System Settings.",
        task_id: "88",
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "camera_permission");
    assert.equal(sessionManager.writes.length, 0);

    const [updated] = service.listMonitors().filter((entry) => entry.id === monitor.id);
    assert.equal(updated.needsCameraPermission, true);
    assert.equal(updated.lastIssueKind, "camera-permission");
    assert.match(updated.lastIssueMessage, /Camera access is blocked/);
    assert.match(service.getStatus().cameraPermissionMessage, /Privacy & Security > Camera/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("VideoMemory status polling surfaces camera permission task notes", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vr-videomemory-permission-refresh-"));
  const fetchImpl = createFetch([
    { body: { task_id: "89" } },
    {
      body: {
        status: "success",
        task: {
          task_id: "89",
          task_note: [
            {
              content: "Camera access denied. Please grant camera permissions in System Settings.",
              timestamp: "2026-04-22 03:00:00",
            },
          ],
        },
      },
    },
  ]);
  const sessionManager = createSessionManager([
    { id: "session-parent", providerId: "codex", status: "running", cwd: stateDir },
  ]);
  const service = new VideoMemoryService({
    defaultProviderId: "codex",
    fetchImpl,
    remoteRefreshIntervalMs: 0,
    sessionManager,
    settings: {
      videoMemoryBaseUrl: "http://127.0.0.1:5050",
      videoMemoryEnabled: true,
    },
    stateDir,
  });

  try {
    await service.initialize();
    await service.createMonitor({
      callerSessionId: "session-parent",
      ioId: "0",
      providerId: "codex",
      trigger: "When the camera sees a person",
    });

    await service.refreshRemoteMonitorStates({ force: true });
    const [monitor] = service.listMonitors();
    assert.equal(fetchImpl.calls[1].url, "http://127.0.0.1:5050/api/task/89");
    assert.equal(monitor.needsCameraPermission, true);
    assert.match(monitor.lastEventNote, /Camera access denied/);
    assert.equal(service.getStatus().cameraPermissionIssue, true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("VideoMemory refreshes device inventory for status", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vr-videomemory-devices-"));
  const fetchImpl = createFetch([
    {
      body: {
        devices: [
          { io_id: "net0", name: "Desk camera", status: "online" },
          { id: "net1", displayName: "Door camera", type: "camera" },
        ],
      },
    },
  ]);
  const service = new VideoMemoryService({
    fetchImpl,
    remoteDeviceRefreshIntervalMs: 0,
    sessionManager: createSessionManager(),
    settings: {
      videoMemoryBaseUrl: "http://127.0.0.1:5050",
      videoMemoryEnabled: true,
    },
    stateDir,
  });

  try {
    await service.initialize();
    await service.refreshRemoteDevices({ force: true });

    assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:5050/api/devices");
    const status = service.getStatus();
    assert.equal(status.deviceCount, 2);
    assert.equal(status.devicesKnown, true);
    assert.deepEqual(status.devices.map((device) => device.ioId), ["net0", "net1"]);
    assert.deepEqual(status.devices.map((device) => device.name), ["Desk camera", "Door camera"]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("VideoMemory waits for Claude readiness and confirms workspace trust", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "rv-videomemory-claude-ready-"));
  const fetchImpl = createFetch([{ body: { task_id: "8" } }]);
  const now = Date.now();
  const sessionManager = createSessionManager([
    {
      id: "claude-ready-session",
      providerId: "claude",
      status: "running",
      cwd: stateDir,
      buffer: "Quick safety check. Yes, I trust this folder.",
      createdAt: new Date(now - 1000).toISOString(),
      updatedAt: new Date(now - 1000).toISOString(),
      lastOutputAt: new Date(now - 1000).toISOString(),
    },
  ]);
  const scheduled = [];
  let currentNow = now;
  const service = new VideoMemoryService({
    fetchImpl,
    nowImpl: () => currentNow,
    promptDelayMs: 100,
    promptReadyIdleMs: 50,
    promptReadyTimeoutMs: 5000,
    promptRetryMs: 100,
    promptSubmitDelayMs: 0,
    sessionManager,
    setTimeoutImpl(callback, delay) {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    settings: {
      videoMemoryBaseUrl: "http://127.0.0.1:5050",
      videoMemoryEnabled: true,
    },
    stateDir,
  });

  try {
    await service.initialize();
    await service.createMonitor({
      callerSessionId: "claude-ready-session",
      ioId: "0",
      providerId: "claude",
      trigger: "When the camera changes",
    });
    const result = await service.handleWebhook({
      headers: { "x-videomemory-token": service.webhookToken },
      body: {
        event_id: "evt-claude-ready",
        note: "The camera changed.",
        task_id: "8",
      },
    });

    assert.equal(result.status, "delivered");
    assert.equal(sessionManager.writes.length, 0);

    scheduled.shift().callback();
    assert.equal(sessionManager.writes.length, 1);
    assert.equal(sessionManager.writes[0].input, "1\r");

    const session = sessionManager.sessions.get("claude-ready-session");
    session.buffer = "Claude Code v2.1.116 Welcome back ❯";
    session.lastOutputAt = new Date(now - 1000).toISOString();
    currentNow += 250;

    scheduled.shift().callback();
    assert.equal(sessionManager.writes.length, 2);
    assert.match(sessionManager.writes[1].input, /VideoMemory monitor triggered/);
    assert.match(sessionManager.writes[1].input, /The camera changed/);

    scheduled.shift().callback();
    assert.equal(sessionManager.writes.length, 3);
    assert.equal(sessionManager.writes[2].input, "\r");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("VideoMemory creates a new provider session when requested", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vr-videomemory-new-session-"));
  const fetchImpl = createFetch([{ body: { task_id: "99" } }]);
  const sessionManager = createSessionManager();
  const service = new VideoMemoryService({
    defaultProviderId: "gemini",
    fetchImpl,
    sessionManager,
    settings: {
      videoMemoryBaseUrl: "http://127.0.0.1:5050",
      videoMemoryEnabled: true,
      videoMemoryProviderId: "gemini",
    },
    stateDir,
  });

  try {
    await service.initialize();
    await service.createMonitor({
      action: "Open the related project and continue the investigation.",
      cwd: stateDir,
      ioId: "net1",
      providerId: "gemini",
      targetMode: "new-session",
      trigger: "When a package is delivered",
    });
    const result = await service.handleWebhook({
      headers: { authorization: `Bearer ${service.webhookToken}` },
      body: {
        event_id: "evt-new",
        note: "A package was placed by the door.",
        task_id: "99",
      },
    });

    assert.equal(result.status, "delivered");
    assert.equal(sessionManager.createdSessions.length, 1);
    assert.equal(sessionManager.createdSessions[0].providerId, "gemini");
    assert.equal(sessionManager.createdSessions[0].cwd, stateDir);
    assert.equal(sessionManager.writes[0].sessionId, "created-1");
    assert.match(sessionManager.writes[0].input, /A package was placed/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("VideoMemory rejects webhook events with the wrong token", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vr-videomemory-token-"));
  const service = new VideoMemoryService({
    fetchImpl: createFetch(),
    sessionManager: createSessionManager(),
    settings: { videoMemoryEnabled: true },
    stateDir,
  });

  try {
    await service.initialize();
    await assert.rejects(
      () => service.handleWebhook({
        headers: { authorization: "Bearer wrong" },
        body: { event_id: "evt", task_id: "1" },
      }),
      /Invalid VideoMemory webhook token/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
