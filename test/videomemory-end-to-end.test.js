import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { VideoMemoryService } from "../src/videomemory-service.js";

async function startFakeVideoMemoryServer(handlers) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? safeParseJson(rawBody) : null;
    const call = {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]),
      ),
      body,
      rawBody,
    };
    calls.push(call);

    const handler = handlers[`${request.method} ${request.url}`] || handlers.default;
    if (!handler) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not-found" }));
      return;
    }

    const result = await handler(call);
    response.statusCode = result.status || 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result.body || {}));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    calls,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function createSessionManager(initialSessions = []) {
  const sessions = new Map(initialSessions.map((session) => [session.id, { ...session }]));
  const writes = [];
  return {
    sessions,
    writes,
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
    createSession(input) {
      const session = {
        id: `created-${sessions.size + 1}`,
        name: input.name,
        providerId: input.providerId,
        providerLabel: input.providerId,
        cwd: input.cwd || process.cwd(),
        status: "running",
      };
      sessions.set(session.id, session);
      return session;
    },
  };
}

test("devices endpoint returns cameras the external VideoMemory server reports", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vr-videomemory-devices-"));
  const fake = await startFakeVideoMemoryServer({
    "GET /api/devices": async () => ({
      body: {
        devices: [
          { io_id: "facetime", name: "FaceTime HD Camera", kind: "camera" },
          { io_id: "net0", name: "Front door camera", kind: "camera" },
        ],
      },
    }),
  });

  try {
    const service = new VideoMemoryService({
      defaultProviderId: "claude",
      sessionManager: createSessionManager(),
      settings: {
        videoMemoryAnthropicApiKey: "sk-ant-test-123",
        videoMemoryBaseUrl: fake.baseUrl,
        videoMemoryEnabled: true,
        videoMemoryProviderId: "claude",
      },
      stateDir,
    });
    await service.initialize();
    await service.refreshRemoteDevices({ force: true });

    const devices = service.listDevices();
    const faceTime = devices.find((device) => device.ioId === "facetime");
    assert.ok(faceTime, "FaceTime device should be surfaced");
    assert.equal(faceTime.name, "FaceTime HD Camera");
    assert.equal(faceTime.kind, "camera");

    const call = fake.calls[0];
    assert.equal(call.url, "/api/devices");
    assert.equal(
      call.headers.authorization,
      "Bearer sk-ant-test-123",
      "should forward the Anthropic API key as a bearer token",
    );
    assert.equal(call.headers["x-anthropic-api-key"], "sk-ant-test-123");
  } finally {
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("end-to-end: create monitor, fire webhook, caller session wakes with rich prompt", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vr-videomemory-e2e-"));
  const fake = await startFakeVideoMemoryServer({
    "POST /api/tasks": async () => ({
      body: { status: "success", task_id: "task-black-dog", io_id: "facetime" },
    }),
  });

  const sessionManager = createSessionManager([
    { id: "session-agent", providerId: "codex", status: "running", cwd: stateDir },
  ]);

  try {
    const service = new VideoMemoryService({
      defaultProviderId: "codex",
      sessionManager,
      settings: {
        videoMemoryAnthropicApiKey: "sk-ant-test-key",
        videoMemoryBaseUrl: fake.baseUrl,
        videoMemoryEnabled: true,
        videoMemoryProviderId: "codex",
      },
      stateDir,
    });
    await service.initialize();
    service.setServerBaseUrl("http://127.0.0.1:4123");

    const monitor = await service.createMonitor({
      action: "Open a new note in the wiki and describe what the dog is doing.",
      callerSessionId: "session-agent",
      cwd: stateDir,
      includeFrame: true,
      includeVideo: false,
      ioId: "facetime",
      name: "Watch FaceTime for a black dog",
      providerId: "codex",
      trigger: "A black dog is visible in the frame",
    });

    assert.equal(monitor.sessionId, "session-agent", "caller session is the wake target");
    assert.equal(monitor.taskId, "task-black-dog");

    const createTaskCall = fake.calls.find((call) => call.url === "/api/tasks");
    assert.ok(createTaskCall, "service should have created a task on the external server");
    assert.equal(createTaskCall.headers.authorization, "Bearer sk-ant-test-key");
    assert.equal(createTaskCall.body.anthropic_api_key, "sk-ant-test-key");
    assert.equal(createTaskCall.body.api_key, "sk-ant-test-key");
    assert.equal(createTaskCall.body.task_description, "A black dog is visible in the frame");

    const result = await service.handleWebhook({
      headers: { authorization: `Bearer ${service.webhookToken}` },
      body: {
        event_type: "task_update",
        idempotency_key: "evt-black-dog-1",
        io_id: "facetime",
        note: "A black Labrador walked into view near the couch.",
        note_frame_api_url: `${fake.baseUrl}/api/task-note-frame/9`,
        task_id: "task-black-dog",
      },
    });

    assert.equal(result.status, "delivered");
    assert.equal(result.sessionId, "session-agent");
    assert.equal(sessionManager.writes.length, 1);
    const prompt = sessionManager.writes[0].input;
    assert.match(prompt, /VideoMemory monitor triggered/);
    assert.match(prompt, /black Labrador/);
    assert.match(prompt, /Open a new note in the wiki/);
    assert.match(prompt, /facetime/);
  } finally {
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
