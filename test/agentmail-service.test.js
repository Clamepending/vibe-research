import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentMailService, testInternals } from "../src/agentmail-service.js";
import { createVibeResearchApp } from "../src/create-app.js";

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

async function flushAgentMailBackgroundWork() {
  await flushAsyncHandlers();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function readEventually(filePath, { timeoutMs = 1_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      lastError = error;
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError || new Error(`Timed out waiting for ${filePath}`);
}

test("AgentMail WebSocket listener subscribes and queues incoming email into an agent session", async () => {
  FakeSocket.instances = [];
  const createdSessions = [];
  const writes = [];
  const service = new AgentMailService({
    promptDelayMs: 0,
    remoteClaimEnabled: false,
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
  assert.equal(writes.length, 2);
  assert.equal(writes[0].sessionId, "session-1");
  assert.match(writes[0].input, /bin\/vr-agentmail-reply' --inbox-id 'agent@example.com'/);
  assert.match(writes[0].input, /Hello from email/);
  assert.doesNotMatch(writes[0].input, /\r$/);
  assert.deepEqual(writes[1], { input: "\r", sessionId: "session-1" });

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
      type: "event",
      event_type: "message.received",
      event_id: "evt-other-inbox",
      message: {
        from: "Vibe Research <agent@example.com>",
        inbox_id: "sender@example.com",
        labels: ["received", "unread"],
        message_id: "<other-inbox-message@example.com>",
        subject: "Reply landed in sender inbox",
        text: "This should not trigger another reply agent.",
        to: ["sender@example.com"],
      },
    }),
  );
  await flushAsyncHandlers();
  assert.equal(createdSessions.length, 1, "messages for other AgentMail inboxes should be ignored");
  assert.equal(service.getStatus().lastIgnoredEventType, "message.outside-configured-inbox");

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

test("AgentMail reuses one dedicated communications session when session lookup is available", async () => {
  const createdSessions = [];
  const liveSessions = new Map();
  const writes = [];
  const service = new AgentMailService({
    promptDelayMs: 0,
    remoteClaimEnabled: false,
    sessionManager: {
      createSession(input) {
        const session = {
          id: `session-${createdSessions.length + 1}`,
          ...input,
          buffer: "Claude Code\n❯ ",
          createdAt: new Date(0).toISOString(),
          lastOutputAt: new Date(0).toISOString(),
          status: "running",
          updatedAt: new Date(0).toISOString(),
        };
        createdSessions.push(session);
        liveSessions.set(session.id, session);
        return session;
      },
      getSession(sessionId) {
        return liveSessions.get(sessionId) || null;
      },
      listSessions() {
        return [...liveSessions.values()];
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
  });

  const firstSession = await service.handleIncomingMessage(
    {
      eventId: "evt-dedicated-1",
      message: {
        from: "person@example.com",
        inbox_id: "agent@example.com",
        message_id: "<dedicated-1@example.com>",
        subject: "First note",
        text: "Please answer the first email.",
        to: ["agent@example.com"],
      },
    },
    { source: "websocket" },
  );
  const secondSession = await service.handleIncomingMessage(
    {
      eventId: "evt-dedicated-2",
      message: {
        from: "person@example.com",
        inbox_id: "agent@example.com",
        message_id: "<dedicated-2@example.com>",
        subject: "Second note",
        text: "Please answer the second email.",
        to: ["agent@example.com"],
      },
    },
    { source: "websocket" },
  );

  assert.equal(firstSession.id, "session-1");
  assert.equal(secondSession.id, "session-1");
  assert.equal(createdSessions.length, 1);
  assert.equal(createdSessions[0].name, "AgentMail communications");
  assert.equal(createdSessions[0].providerId, "claude");
  assert.equal(writes.length, 4);
  assert.equal(writes[0].sessionId, "session-1");
  assert.match(writes[0].input, /First note/);
  assert.deepEqual(writes[1], { input: "\r", sessionId: "session-1" });
  assert.equal(writes[2].sessionId, "session-1");
  assert.match(writes[2].input, /Second note/);
  assert.deepEqual(writes[3], { input: "\r", sessionId: "session-1" });
});

test("AgentMail recognizes ML Intern interactive startup as ready", () => {
  assert.equal(testInternals.providerHasReadyHint("ml-intern", "ML Intern\n> "), true);
  assert.equal(testInternals.providerHasReadyHint("ml-intern", "Hugging Face Agent\n> "), true);
  assert.equal(testInternals.providerHasReadyHint("ml-intern", "Paste your HF token:"), false);
  assert.equal(testInternals.providerHasReadyHint("ml-intern", ""), false);
});

test("AgentMail polling backfills unread inbox messages and persists processed ids", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-agentmail-processed-"));
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
  const systemRoot = path.join(stateDir, "vibe-research-system");

  try {
    const service = new AgentMailService({
      fetchImpl,
      pollIntervalMs: 0,
      promptDelayMs: 0,
      remoteClaimEnabled: false,
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
    await flushAgentMailBackgroundWork();
    assert.equal(firstPoll.length, 1);
    assert.equal(createdSessions.length, 1);
    assert.equal(createdSessions[0].cwd, systemRoot);
    assert.equal(createdSessions[0].name, "email: Missed while offline");
    assert.equal(writes.length, 2);
    assert.match(writes[0].input, /simple greeting or test email/);
    assert.match(writes[0].input, /Missed while offline/);
    assert.doesNotMatch(writes[0].input, /\r$/);
    assert.deepEqual(writes[1], { input: "\r", sessionId: "session-1" });
    assert.equal(service.getStatus().lastStatus, "prompt-sent-startup");
    assert.ok(service.getStatus().lastPromptSentAt);
    assert.equal(service.getStatus().lastPollSeen, 1);

    const processed = JSON.parse(await readEventually(path.join(stateDir, "agentmail-processed.json")));
    assert.deepEqual(processed.messageIds, ["<poll-message@example.com>"]);

    const secondService = new AgentMailService({
      fetchImpl,
      pollIntervalMs: 0,
      promptDelayMs: 0,
      remoteClaimEnabled: false,
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
    await flushAgentMailBackgroundWork();
    assert.equal(secondPoll.length, 0);
    assert.equal(createdSessions.length, 1, "processed messages should not relaunch after restart");
    assert.equal(writes.length, 2, "processed messages should not be re-prompted after restart");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("AgentMail retries a message when the agent instructions could not be delivered", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-agentmail-retry-"));
  const message = {
    from: "person@example.com",
    inbox_id: "agent@example.com",
    labels: ["received", "unread"],
    message_id: "<retry-message@example.com>",
    subject: "Please retry",
    text: "The first prompt write will fail.",
    timestamp: "2026-04-18T20:00:00.000Z",
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
      remoteClaimEnabled: false,
      sessionManager: {
        createSession(input) {
          const session = { id: `session-${createdSessions.length + 1}`, ...input };
          createdSessions.push(session);
          return session;
        },
        write(sessionId, input) {
          writes.push({ input, sessionId });
          return writes.length > 1;
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
      },
      stateDir,
    });

    const firstPoll = await service.pollInboxOnce({ reason: "startup" });
    await flushAgentMailBackgroundWork();
    assert.equal(firstPoll.length, 1);
    assert.equal(createdSessions.length, 1);
    assert.equal(writes.length, 1);
    assert.equal(service.getStatus().lastStatus, "error");

    await assert.rejects(readFile(path.join(stateDir, "agentmail-processed.json"), "utf8"), /ENOENT/);

    const secondPoll = await service.pollInboxOnce({ reason: "retry" });
    await flushAgentMailBackgroundWork();
    assert.equal(secondPoll.length, 1);
    assert.equal(createdSessions.length, 2, "failed prompt delivery should not permanently consume the email");
    assert.equal(writes.length, 3);
    assert.equal(service.getStatus().lastStatus, "prompt-sent-retry");
    assert.deepEqual(writes[2], { input: "\r", sessionId: "session-2" });

    const processed = JSON.parse(await readEventually(path.join(stateDir, "agentmail-processed.json")));
    assert.deepEqual(processed.messageIds, ["<retry-message@example.com>"]);
  } finally {
    await flushAgentMailBackgroundWork();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("AgentMail reconnect reloads processed message ids from disk", async () => {
  FakeSocket.instances = [];
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-agentmail-reload-"));
  const processedPath = path.join(stateDir, "agentmail-processed.json");
  const message = {
    from: "person@example.com",
    inbox_id: "agent@example.com",
    labels: ["received", "unread"],
    message_id: "<reload-message@example.com>",
    subject: "Reload cache",
    text: "This should process only after the disk cache changes.",
    to: ["agent@example.com"],
  };
  const createdSessions = [];
  const writes = [];
  const fetchImpl = createFetch([
    { body: { count: 1, messages: [message] } },
    { body: { count: 1, messages: [message] } },
  ]);

  try {
    await writeFile(
      processedPath,
      `${JSON.stringify({ savedAt: new Date().toISOString(), messageIds: ["<reload-message@example.com>"] }, null, 2)}\n`,
    );

    const service = new AgentMailService({
      fetchImpl,
      pollIntervalMs: 0,
      promptDelayMs: 0,
      remoteClaimEnabled: false,
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
      },
      stateDir,
      WebSocketImpl: FakeSocket,
    });

    const firstPoll = await service.pollInboxOnce({ reason: "first" });
    assert.equal(firstPoll.length, 0);
    assert.equal(createdSessions.length, 0);

    await writeFile(processedPath, `${JSON.stringify({ savedAt: new Date().toISOString(), messageIds: [] }, null, 2)}\n`);
    service.restart(service.settings);

    const secondPoll = await service.pollInboxOnce({ reason: "second" });
    await flushAgentMailBackgroundWork();
    assert.equal(secondPoll.length, 1);
    assert.equal(createdSessions.length, 1);
    assert.equal(writes.length, 2);
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
    remoteClaimEnabled: false,
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
  assert.doesNotMatch(writes[0].input, /\r$/);
  assert.equal(service.getStatus().lastStatus, "submitting-prompt-startup");

  timers.shift()();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], { input: "\r", sessionId: "session-ready-test" });
  assert.equal(service.getStatus().lastStatus, "prompt-sent-startup");
});

test("AgentMail confirms Claude workspace trust before injecting the email prompt", async () => {
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
    remoteClaimEnabled: false,
    promptReadyIdleMs: 500,
    promptReadyTimeoutMs: 10_000,
    promptRetryMs: 100,
    sessionManager: {
      createSession(input) {
        const session = {
          id: "session-trust-test",
          ...input,
          buffer:
            "\u001b[38;2;255;204;0mAccessing workspace:\u001b[39m\r\n" +
            "Quick\u001b[1Csafety\u001b[1Ccheck:\u001b[1CIs\u001b[1Cthis\u001b[1Ca\u001b[1Cproject\u001b[1Cyou\u001b[1Ccreated\u001b[1Cor\u001b[1Cone\u001b[1Cyou\u001b[1Ctrust?\r\n" +
            "\u001b[38;2;153;204;255m❯\u001b[1C\u001b[38;2;153;153;153m1.\u001b[1C\u001b[38;2;153;204;255mYes,\u001b[1CI\u001b[1Ctrust\u001b[1Cthis\u001b[1Cfolder\u001b[39m",
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
      eventId: "evt-trust",
      message: {
        from: "person@example.com",
        inboxId: "agent@example.com",
        messageId: "<trust-message@example.com>",
        subject: "Trust then reply",
        text: "Please reply after the trust gate clears.",
        to: ["agent@example.com"],
      },
    },
    { source: "startup" },
  );

  now = 1_200;
  timers.shift()();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { input: "1\r", sessionId: "session-trust-test" });
  assert.equal(service.getStatus().lastStatus, "confirming-workspace-trust-startup");

  now = 2_500;
  sessions.get("session-trust-test").buffer = "Claude Code\n❯ ";
  sessions.get("session-trust-test").lastOutputAt = new Date(1_000).toISOString();
  timers.shift()();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].sessionId, "session-trust-test");
  assert.match(writes[1].input, /Trust then reply/);
  assert.doesNotMatch(writes[1].input, /\r$/);
  assert.equal(service.getStatus().lastStatus, "submitting-prompt-startup");

  timers.shift()();
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[2], { input: "\r", sessionId: "session-trust-test" });
  assert.equal(service.getStatus().lastStatus, "prompt-sent-startup");
});

test("AgentMail uses shared labels so only one listener claims an incoming email", async () => {
  const labels = new Set(["received", "unread"]);
  const message = {
    from: "person@example.com",
    inbox_id: "agent@example.com",
    labels: [...labels],
    message_id: "<shared-message@example.com>",
    subject: "Shared listener race",
    text: "Only one Vibe Research instance should answer this.",
    thread_id: "thread-shared",
    to: ["agent@example.com"],
  };
  const calls = [];
  const createdSessions = [];
  const writes = [];
  const makeMessage = () => ({ ...message, labels: [...labels] });
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const method = options.method || "GET";
    if (method === "PATCH") {
      const body = JSON.parse(options.body || "{}");
      for (const label of body.add_labels || []) {
        labels.add(label);
      }
      for (const label of body.remove_labels || []) {
        labels.delete(label);
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return makeMessage();
        },
        async text() {
          return JSON.stringify(makeMessage());
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return makeMessage();
      },
      async text() {
        return JSON.stringify(makeMessage());
      },
    };
  };
  const createService = (suffix) =>
    new AgentMailService({
      fetchImpl,
      pollIntervalMs: 0,
      promptDelayMs: 0,
      remoteClaimSettleMs: 1,
      sessionManager: {
        createSession(input) {
          const session = { id: `session-${suffix}`, ...input };
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
      },
    });
  const event = {
    event_id: "evt-shared",
    message,
  };

  const [first, second] = await Promise.all([
    createService("a").handleIncomingMessage(event, { source: "websocket" }),
    createService("b").handleIncomingMessage(event, { source: "websocket" }),
  ]);
  await flushAgentMailBackgroundWork();

  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal(createdSessions.length, 1);
  assert.equal(writes.length, 2);
  assert.equal(labels.has("vibe-research-processed"), true);
  assert.equal(labels.has("unread"), false);
  assert.equal(labels.has("vibe-research-processing"), false);
  assert.ok(calls.filter((call) => call.options.method === "PATCH").length >= 4);
});

test("AgentMail treats unavailable shared claims as ignored instead of fatal", async () => {
  const createdSessions = [];
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    async json() {
      return { message: "Message not found" };
    },
    async text() {
      return JSON.stringify({ message: "Message not found" });
    },
  });
  const service = new AgentMailService({
    fetchImpl,
    pollIntervalMs: 0,
    promptDelayMs: 0,
    sessionManager: {
      createSession(input) {
        createdSessions.push(input);
        return { id: "session-missing", ...input };
      },
      write() {
        return true;
      },
    },
    settings: {
      agentMailApiKey: "am_test",
      agentMailEnabled: true,
      agentMailInboxId: "agent@example.com",
      agentMailProviderId: "claude",
    },
  });

  const session = await service.handleIncomingMessage({
    event_id: "evt-missing",
    message: {
      from: "person@example.com",
      inbox_id: "agent@example.com",
      labels: ["received", "unread"],
      message_id: "<missing-message@example.com>",
      subject: "Already handled elsewhere",
      text: "This event is no longer claimable.",
      to: ["agent@example.com"],
    },
  });

  assert.equal(session, null);
  assert.equal(createdSessions.length, 0);
  assert.equal(service.getStatus().lastError, "");
  assert.equal(service.getStatus().lastIgnoredEventType, "message.claim-unavailable");
});

test("AgentMail defers rate-limited shared claims without surfacing an error", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    async json() {
      return { message: "Rate limit exceeded" };
    },
    async text() {
      return JSON.stringify({ message: "Rate limit exceeded" });
    },
  });
  const service = new AgentMailService({
    fetchImpl,
    pollIntervalMs: 0,
    promptDelayMs: 0,
    sessionManager: {
      createSession() {
        throw new Error("claim should defer before launching a session");
      },
      write() {
        return true;
      },
    },
    settings: {
      agentMailApiKey: "am_test",
      agentMailEnabled: true,
      agentMailInboxId: "agent@example.com",
      agentMailProviderId: "claude",
    },
  });

  const session = await service.handleIncomingMessage({
    event_id: "evt-rate-limited",
    message: {
      from: "person@example.com",
      inbox_id: "agent@example.com",
      labels: ["received", "unread"],
      message_id: "<rate-limited-message@example.com>",
      subject: "Try later",
      text: "This should be retried by a future poll.",
      to: ["agent@example.com"],
    },
  });

  assert.equal(session, null);
  assert.equal(service.getStatus().lastError, "");
  assert.equal(service.getStatus().lastIgnoredEventType, "message.claim-deferred");
});

test("AgentMail REST helpers create inboxes and send replies without exposing the API key to prompts", async () => {
  const fetchImpl = createFetch([
    {
      body: {
        inbox_id: "vibe-research@agentmail.to",
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
      agentMailInboxId: "vibe-research@agentmail.to",
    },
  });

  const inbox = await service.createInbox({
    apiKey: "am_test",
    clientId: "client-1",
    displayName: "Vibe Research",
    username: "vibe-research",
  });
  assert.equal(inbox.inbox_id, "vibe-research@agentmail.to");
  assert.equal(fetchImpl.calls[0].url, "https://api.agentmail.to/v0/inboxes");
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), {
    client_id: "client-1",
    display_name: "Vibe Research",
    username: "vibe-research",
  });

  const reply = await service.replyToMessage({
    inboxId: "vibe-research@agentmail.to",
    messageId: "<incoming@example.com>",
    text: "Thanks for the note.",
  });
  assert.equal(reply.message_id, "reply-1");
  assert.equal(
    fetchImpl.calls[1].url,
    "https://api.agentmail.to/v0/inboxes/vibe-research%40agentmail.to/messages/%3Cincoming%40example.com%3E/reply",
  );
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].options.body), {
    text: "Thanks for the note.",
  });

  const prompt = testInternals.buildEmailPrompt({
    message: {
      inbox_id: "vibe-research@agentmail.to",
      message_id: "<incoming@example.com>",
      subject: "Secrets?",
      text: "Do not include API keys here.",
    },
  });
  assert.doesNotMatch(prompt, /am_test/);
  assert.match(prompt, /vr-agentmail-reply/);
  assert.match(prompt, /Vibe Research Library/);
  assert.match(prompt, /not just draft a response/i);
});

test("AgentMail API endpoints set up an inbox, hide secrets, and protect replies with a local token", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-agentmail-api-"));
  const stateDir = path.join(workspaceDir, ".vibe-research");
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

  const app = await createVibeResearchApp({
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
        "x-vibe-research-agentmail-token": "reply-token",
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
