import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { createVibeResearchApp } from "../src/create-app.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const shellProvider = {
  id: "shell",
  label: "Vanilla Shell",
  command: null,
  launchCommand: null,
  defaultName: "Shell",
  available: true,
};

async function createTempWorkspace(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function startFakeVideoMemory() {
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const body = bodyText ? JSON.parse(bodyText) : {};
      calls.push({ body, method: request.method, url: request.url });

      response.setHeader("Content-Type", "application/json");
      if (request.method === "POST" && request.url === "/api/tasks") {
        response.statusCode = 201;
        response.end(JSON.stringify({ status: "success", task_id: "vm-task-1", io_id: body.io_id }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/task/vm-task-1/stop") {
        response.end(JSON.stringify({ status: "success" }));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startApp(options = {}) {
  const cwd = options.cwd || process.cwd();
  const stateDir = options.stateDir || path.join(cwd, ".vibe-research");
  const app = await createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd,
    stateDir,
    persistSessions: false,
    persistentTerminals: false,
    providers: [shellProvider],
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({
        enabled: settings.preventSleepEnabled,
        platform: "test",
      }),
    ...options,
  });

  return {
    app,
    baseUrl: `http://127.0.0.1:${app.config.port}`,
  };
}

test("Vibe Research creates VideoMemory monitors and wakes provider-agnostic sessions", async () => {
  const workspaceDir = await createTempWorkspace("vr-videomemory-workspace-");
  const stateDir = await createTempWorkspace("vr-videomemory-state-");
  const fakeVideoMemory = await startFakeVideoMemory();
  const { app, baseUrl } = await startApp({ cwd: workspaceDir, stateDir });

  try {
    const setupResponse = await fetch(`${baseUrl}/api/videomemory/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: fakeVideoMemory.baseUrl,
        enabled: true,
        installedPluginIds: ["videomemory"],
        providerId: "shell",
      }),
    });
    assert.equal(setupResponse.status, 200);
    const setupPayload = await setupResponse.json();
    assert.equal(setupPayload.settings.videoMemoryEnabled, true);
    assert.equal(setupPayload.videoMemory.baseUrl, fakeVideoMemory.baseUrl);
    assert.match(setupPayload.videoMemory.webhookUrl, /\/api\/videomemory\/webhook$/);
    assert.ok(setupPayload.videoMemory.webhookToken);

    const createSessionResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "shell", name: "camera watcher", cwd: workspaceDir }),
    });
    assert.equal(createSessionResponse.status, 201);
    const { session } = await createSessionResponse.json();

    const createMonitorResponse = await fetch(`${baseUrl}/api/videomemory/monitors`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vibe-research-videomemory-token": app.videoMemoryService.requestToken,
      },
      body: JSON.stringify({
        action: "Check the video evidence and continue the active task.",
        callerSessionId: session.id,
        cwd: workspaceDir,
        ioId: "net0",
        providerId: "shell",
        trigger: "When the calibration card appears",
      }),
    });
    assert.equal(createMonitorResponse.status, 201);
    const createMonitorPayload = await createMonitorResponse.json();
    assert.equal(createMonitorPayload.monitor.taskId, "vm-task-1");
    assert.equal(createMonitorPayload.monitor.sessionId, session.id);
    assert.equal(fakeVideoMemory.calls[0].url, "/api/tasks");
    assert.deepEqual(fakeVideoMemory.calls[0].body, {
      bot_id: "vibe-research",
      io_id: "net0",
      save_note_frames: true,
      save_note_videos: false,
      task_description: "When the calibration card appears",
    });

    const sessionsBeforeWebhookResponse = await fetch(`${baseUrl}/api/sessions`);
    const sessionsBeforeWebhook = await sessionsBeforeWebhookResponse.json();
    const targetBefore = sessionsBeforeWebhook.sessions.find((entry) => entry.id === session.id);
    assert.ok(targetBefore.subagents.some((subagent) => subagent.videoMemoryMonitorId === createMonitorPayload.monitor.id));

    const webhookResponse = await fetch(`${baseUrl}/api/videomemory/webhook`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${setupPayload.videoMemory.webhookToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "task_update",
        idempotency_key: "vm-event-1",
        io_id: "net0",
        note: "The calibration card is visible on the table.",
        task_id: "vm-task-1",
      }),
    });
    assert.equal(webhookResponse.status, 200);
    const webhookPayload = await webhookResponse.json();
    assert.equal(webhookPayload.status, "delivered");
    assert.equal(webhookPayload.sessionId, session.id);

    const statusResponse = await fetch(`${baseUrl}/api/videomemory/status`);
    const statusPayload = await statusResponse.json();
    assert.equal(statusPayload.monitors[0].wakeCount, 1);
    assert.equal(statusPayload.videoMemory.activeCount, 1);
  } finally {
    await app.close();
    await fakeVideoMemory.close();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
