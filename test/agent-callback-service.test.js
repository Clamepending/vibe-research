import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { AgentCallbackService } from "../src/agent-callback-service.js";
import { createVibeResearchApp } from "../src/create-app.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

function createFakeSessionManager(writes) {
  const sessions = new Map([
    ["session-1", { id: "session-1", status: "running" }],
  ]);

  return {
    getSession(sessionId) {
      return sessions.get(sessionId) || null;
    },
    write(sessionId, input) {
      writes.push({ input, sessionId });
      return true;
    },
  };
}

test("AgentCallbackService generates per-session callback URLs and routes contextual messages", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-agent-callback-"));
  const writes = [];
  const service = new AgentCallbackService({
    serverBaseUrl: "http://127.0.0.1:4123",
    sessionManager: createFakeSessionManager(writes),
    stateDir,
  });

  try {
    await service.initialize();
    const callback = service.getCallback("session-1");

    assert.match(callback.url, /^http:\/\/127\.0\.0\.1:4123\/api\/agent-callbacks\/session-1\//);
    assert.equal(callback.token.length, 32);

    const result = await service.deliverCallback({
      body: {
        buildingId: "ottoauth",
        event: "chat.message",
        message: "Snackpass needs a pickup time before it can continue.",
        payload: {
          apiKey: "hidden-key",
          orderId: "order-123",
        },
        serviceId: "snackpass",
        threadId: "thread-42",
      },
      sessionId: "session-1",
      token: callback.token,
    });

    assert.equal(result.status, "delivered");
    assert.equal(result.buildingId, "ottoauth");
    assert.equal(result.serviceId, "snackpass");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].sessionId, "session-1");
    assert.match(writes[0].input, /Building: ottoauth/);
    assert.match(writes[0].input, /Service: snackpass/);
    assert.match(writes[0].input, /Snackpass needs a pickup time/);
    assert.match(writes[0].input, /"orderId": "order-123"/);
    assert.match(writes[0].input, /"apiKey": "\[redacted\]"/);
    assert.doesNotMatch(writes[0].input, /hidden-key/);
    assert.match(writes[0].input, /\r$/);

    await assert.rejects(
      service.deliverCallback({
        body: { message: "nope" },
        sessionId: "session-1",
        token: "wrong-token",
      }),
      /Invalid agent callback token/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("agent callback API exposes a session URL and delivers posted events", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-agent-callback-app-"));
  const stateDir = path.join(workspaceDir, ".vibe-research");
  const app = await createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd: workspaceDir,
    stateDir,
    persistSessions: false,
    persistentTerminals: false,
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({
        enabled: settings.preventSleepEnabled,
        platform: "test",
      }),
    systemMetricsSampleIntervalMs: 0,
  });
  const baseUrl = `http://127.0.0.1:${app.config.port}`;

  try {
    const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "shell", name: "Callback receiver" }),
    });
    assert.equal(sessionResponse.status, 201);
    const { session } = await sessionResponse.json();

    const callbackResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/callback`);
    assert.equal(callbackResponse.status, 200);
    const { callback } = await callbackResponse.json();
    assert.match(callback.url, new RegExp(`/api/agent-callbacks/${encodeURIComponent(session.id)}/`));

    const deliverResponse = await fetch(callback.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buildingId: "ottoauth",
        event: "chat.message",
        message: "The service needs a delivery window.",
        serviceId: "instacart",
      }),
    });
    assert.equal(deliverResponse.status, 200);
    const delivered = await deliverResponse.json();
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.sessionId, session.id);
    assert.equal(delivered.buildingId, "ottoauth");
    assert.equal(delivered.serviceId, "instacart");
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
