import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentMailService, testInternals } from "../src/agentmail-service.js";
import { createRemoteVibesApp } from "../src/create-app.js";

class FakeSocket extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.closed = false;
    this.options = options;
    this.sent = [];
    this.url = url;
    FakeSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.emit("close");
  }

  send(payload) {
    this.sent.push(payload);
  }
}

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

function flushAsyncHandlers() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("AgentMail WebSocket listener subscribes and queues incoming email into an agent session", async () => {
  FakeSocket.instances = [];
  const createdSessions = [];
  const writes = [];
  const service = new AgentMailService({
    promptDelayMs: 0,
    sessionManager: {
      createSession(input) {
        const session = { id: `session-${createdSessions.length + 1}`, ...input };
        createdSessions.push(session);
        return session;
      },
      write(sessionId, input) {
        writes.push({ input, sessionId });
        return true;
      },
    },
    pollIntervalMs: 0,
    setTimeoutImpl(callback) {
      callback();
      return 1;
    },
    settings: {
      agentMailApiKey: "am_test",
      agentMailEnabled: true,
      agentMailInboxId: "agent@example.com",
      agentMailProviderId: "claude",
      wikiPath: "/tmp/wiki",
    },
    WebSocketImpl: FakeSocket,
  });

  service.start();
  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, "wss://ws.agentmail.to/v0?api_key=am_test");
  assert.equal(socket.options.headers.Authorization, "Bearer am_test");

  socket.emit("open");
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    type: "subscribe",
    inboxIds: ["agent@example.com"],
  });

  socket.emit(
    "message",
    JSON.stringify({
      type: "event",
      event_type: "message.received",
      event_id: "evt-1",
      message: {
        from: "person@example.com",
        inbox_id: "agent@example.com",
        message_id: "<message-1@example.com>",
        subject: "Can you help?",
        text: "Hello from email.",
        thread_id: "thread-1",
        to: ["agent@example.com"],
      },
    }),
  );
  await flushAsyncHandlers();

  assert.equal(createdSessions.length, 1);
  assert.equal(createdSessions[0].providerId, "claude");
  assert.equal(createdSessions[0].cwd, "/tmp/wiki");
  assert.match(createdSessions[0].name, /^email: Can you help/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sessionId, "session-1");
  assert.match(writes[0].input, /rv-agentmail-reply --inbox-id "agent@example.com"/);
  assert.match(writes[0].input, /Hello from email/);

  socket.emit(
    "message",
    JSON.stringify({
      type: "event",
      event_type: "message.received",
      event_id: "evt-1",
      message: {
        inbox_id: "agent@example.com",
        message_id: "<message-1@example.com>",
        subject: "Duplicate",
      },
    }),
  );
  await flushAsyncHandlers();
  assert.equal(createdSessions.length, 1, "duplicate event ids should be ignored");

  socket.emit(
    "message",
    JSON.stringify({
      type: "message_received",
      eventId: "evt-2",
      message: {
        from_: "docs-style@example.com",
        inboxId: "agent@example.com",
        messageId: "<message-2@example.com>",
        subject: "Docs style event",
        text: "This matches AgentMail's TypeScript guide shape.",
      },
    }),
  );
  await flushAsyncHandlers();
  assert.equal(createdSessions.length, 2, "SDK-style message_received events should be accepted too");

  socket.emit(
    "message",
    JSON.stringify({
      type: "message_received",
      eventId: "evt-3",
      message_received: {
        message: {
          from_: "api-reference@example.com",
          inboxId: "agent@example.com",
          messageId: "<message-3@example.com>",
          subject: "Nested event payload",
          text: "This matches the API reference wrapper shape.",
        },
      },
    }),
  );
  await flushAsyncHandlers();
  assert.equal(createdSessions.length, 3, "nested message_received payloads should be accepted");
});

test("AgentMail polling backfills unread inbox messages and persists processed ids", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-agentmail-processed-"));
  const message = {
    from: "person@example.com",
    inbox_id: "agent@example.com",
    labels: ["received", "unread"],
    message_id: "<poll-message@example.com>",
    subject: "Missed while offline",
    text: "Please reply when the listener comes back.",
    timestamp: "2026-04-18T19:38:39.000Z",
    to: ["agent@example.com"],
  };
  const createdSessions = [];
  const writes = [];
  const fetchImpl = createFetch([
    { body: { count: 1, messages: [message] } },
    { body: { count: 1, messages: [message] } },
  ]);

  try {
    const service = new AgentMailService({
      fetchImpl,
      pollIntervalMs: 0,
      promptDelayMs: 0,
      sessionManager: {
        createSession(input) {
          const session = { id: `session-${createdSessions.length + 1}`, ...input };
          createdSessions.push(session);
          return session;
        },
        write(sessionId, input) {
          writes.push({ input, sessionId });
          return true;
        },
      },
      setTimeoutImpl(callback) {
        callback();
        return 1;
      },
      settings: {
        agentMailApiKey: "am_test",
        agentMailEnabled: true,
        agentMailInboxId: "agent@example.com",
        agentMailProviderId: "claude",
        wikiPath: "/tmp/wiki",
      },
      stateDir,
    });

    const firstPoll = await service.pollInboxOnce({ reason: "startup" });
    assert.equal(firstPoll.length, 1);
    assert.equal(createdSessions.length, 1);
    assert.equal(createdSessions[0].cwd, "/tmp/wiki");
    assert.equal(createdSessions[0].name, "email: Missed while offline");
    assert.equal(writes.length, 1);
    assert.match(writes[0].input, /simple greeting or test email/);
    assert.match(writes[0].input, /Missed while offline/);
    assert.equal(service.getStatus().lastStatus, "prompt-sent-startup");
    assert.ok(service.getStatus().lastPromptSentAt);
    assert.equal(service.getStatus().lastPollSeen, 1);

    const processed = JSON.parse(await readFile(path.join(stateDir, "agentmail-processed.json"), "utf8"));
    assert.deepEqual(processed.messageIds, ["<poll-message@example.com>"]);

    const secondService = new AgentMailService({
      fetchImpl,
      pollIntervalMs: 0,
      promptDelayMs: 0,
      sessionManager: {
        createSession(input) {
          const session = { id: `session-${createdSessions.length + 1}`, ...input };
          createdSessions.push(session);
          return session;
        },
        write(sessionId, input) {
          writes.push({ input, sessionId });
          return true;
        },
      },
      settings: {
        agentMailApiKey: "am_test",
        agentMailEnabled: true,
        agentMailInboxId: "agent@example.com",
      },
      stateDir,
    });

    const secondPoll = await secondService.pollInboxOnce({ reason: "restart" });
    assert.equal(secondPoll.length, 0);
    assert.equal(createdSessions.length, 1, "processed messages should not relaunch after restart");
    assert.equal(writes.length, 1, "processed messages should not be re-prompted after restart");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("AgentMail waits for the agent UI to settle before injecting the email prompt", async () => {
  const timers = [];
  const writes = [];
  const sessions = new Map();
  let now = 0;

  const service = new AgentMailService({
    nowImpl() {
      return now;
    },
    pollIntervalMs: 0,
    promptDelayMs: 1_000,
    promptReadyIdleMs: 500,
    promptReadyTimeoutMs: 10_000,
    promptRetryMs: 100,
    sessionManager: {
      createSession(input) {
        const session = {
          id: "session-ready-test",
          ...input,
          buffer: "launching Claude",
          createdAt: new Date(0).toISOString(),
          lastOutputAt: new Date(900).toISOString(),
          status: "running",
          updatedAt: new Date(900).toISOString(),
        };
        sessions.set(session.id, session);
        return session;
      },
      getSession(sessionId) {
        return sessions.get(sessionId) || null;
      },
      write(sessionId, input) {
        writes.push({ input, sessionId });
        return true;
      },
    },
    setTimeoutImpl(callback) {
      timers.push(callback);
      return timers.length;
    },
    settings: {
      agentMailApiKey: "am_test",
      agentMailEnabled: true,
      agentMailInboxId: "agent@example.com",
      agentMailProviderId: "claude",
      wikiPath: "/tmp/wiki",
    },
  });

  await service.handleIncomingMessage(
    {
      eventId: "evt-ready",
      message: {
        from: "person@example.com",
        inboxId: "agent@example.com",
        messageId: "<ready-message@example.com>",
        subject: "Wait for Claude",
        text: "Please reply after Claude is ready.",
        to: ["agent@example.com"],
      },
    },
    { source: "startup" },
  );

  assert.equal(writes.length, 0);
  assert.equal(timers.length, 1);

  now = 1_200;
  sessions.get("session-ready-test").lastOutputAt = new Date(1_100).toISOString();
  timers.shift()();
  assert.equal(writes.length, 0, "prompt should wait while the agent is still producing output");
  assert.equal(timers.length, 1);

  now = 2_500;
  sessions.get("session-ready-test").buffer = "Claude Code\n❯ ";
  sessions.get("session-ready-test").lastOutputAt = new Date(1_000).toISOString();
  timers.shift()();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sessionId, "session-ready-test");
  assert.match(writes[0].input, /Wait for Claude/);
  assert.equal(service.getStatus().lastStatus, "prompt-sent-startup");
});

test("AgentMail REST helpers create inboxes and send replies without exposing the API key to prompts", async () => {
  const fetchImpl = createFetch([
    {
      body: {
        inbox_id: "remote-vibes@agentmail.to",
      },
    },
    {
      body: {
        message_id: "reply-1",
        thread_id: "thread-1",
      },
    },
  ]);
  const service = new AgentMailService({
    fetchImpl,
    sessionManager: {
      createSession() {},
      write() {},
    },
    settings: {
      agentMailApiKey: "am_test",
      agentMailEnabled: true,
      agentMailInboxId: "remote-vibes@agentmail.to",
    },
  });

  const inbox = await service.createInbox({
    apiKey: "am_test",
    clientId: "client-1",
    displayName: "Remote Vibes",
    username: "remote-vibes",
  });
  assert.equal(inbox.inbox_id, "remote-vibes@agentmail.to");
  assert.equal(fetchImpl.calls[0].url, "https://api.agentmail.to/v0/inboxes");
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), {
    client_id: "client-1",
    display_name: "Remote Vibes",
    username: "remote-vibes",
  });

  const reply = await service.replyToMessage({
    inboxId: "remote-vibes@agentmail.to",
    messageId: "<incoming@example.com>",
    text: "Thanks for the note.",
  });
  assert.equal(reply.message_id, "reply-1");
  assert.equal(
    fetchImpl.calls[1].url,
    "https://api.agentmail.to/v0/inboxes/remote-vibes%40agentmail.to/messages/%3Cincoming%40example.com%3E/reply",
  );
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].options.body), {
    text: "Thanks for the note.",
  });

  const prompt = testInternals.buildEmailPrompt({
    message: {
      inbox_id: "remote-vibes@agentmail.to",
      message_id: "<incoming@example.com>",
      subject: "Secrets?",
      text: "Do not include API keys here.",
    },
  });
  assert.doesNotMatch(prompt, /am_test/);
  assert.match(prompt, /rv-agentmail-reply/);
});

test("AgentMail API endpoints set up an inbox, hide secrets, and protect replies with a local token", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-agentmail-api-"));
  const stateDir = path.join(workspaceDir, ".remote-vibes");
  const fakeService = {
    replyToken: "reply-token",
    settings: null,
    startCalled: 0,
    stopped: false,
    restartedWith: null,
    async createInbox() {
      return { inbox_id: "api-agent@agentmail.to" };
    },
    getStatus() {
      return {
        apiKeyConfigured: Boolean(this.settings?.agentMailApiKey),
        enabled: Boolean(this.settings?.agentMailEnabled),
        inboxId: this.settings?.agentMailInboxId || "",
        lastStatus: "connected",
        mode: "websocket",
        ready: true,
      };
    },
    async replyToMessage(payload) {
      this.lastReply = payload;
      return { message_id: "reply-2" };
    },
    restart(settings) {
      this.settings = settings;
      this.restartedWith = settings;
    },
    start() {
      this.startCalled += 1;
    },
    stop() {
      this.stopped = true;
    },
  };

  const app = await createRemoteVibesApp({
    agentMailServiceFactory(settings) {
      fakeService.settings = settings;
      return fakeService;
    },
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "claude", label: "Claude Code", available: true, command: "true", defaultName: "Claude" }],
    stateDir,
    cwd: workspaceDir,
    persistSessions: false,
  });

  try {
    const baseUrl = `http://127.0.0.1:${app.config.port}`;
    const setupResponse = await fetch(`${baseUrl}/api/agentmail/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "am_secret", providerId: "claude" }),
    });
    assert.equal(setupResponse.status, 200);
    const setupPayload = await setupResponse.json();
    assert.equal(setupPayload.settings.agentMailApiKey, "");
    assert.equal(setupPayload.settings.agentMailApiKeyConfigured, true);
    assert.equal(setupPayload.settings.agentMailInboxId, "api-agent@agentmail.to");
    assert.equal(fakeService.restartedWith.agentMailApiKey, "am_secret");

    const rejectedReply = await fetch(`${baseUrl}/api/agentmail/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inboxId: "api-agent@agentmail.to", messageId: "msg", text: "hi" }),
    });
    assert.equal(rejectedReply.status, 403);

    const replyResponse = await fetch(`${baseUrl}/api/agentmail/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-remote-vibes-agentmail-token": "reply-token",
      },
      body: JSON.stringify({ inboxId: "api-agent@agentmail.to", messageId: "msg", text: "hi" }),
    });
    assert.equal(replyResponse.status, 200);
    assert.equal(fakeService.lastReply.text, "hi");
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
