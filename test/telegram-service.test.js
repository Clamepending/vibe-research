import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { TelegramService, testInternals } from "../src/telegram-service.js";
import { createVibeResearchApp } from "../src/create-app.js";

const execFileAsync = promisify(execFile);

function createFetch(responses = []) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const next = responses.shift() || { ok: true, status: 200, body: { ok: true, result: [] } };
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

async function flushAsyncHandlers() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("Telegram polling queues allowed messages into one dedicated communications session", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-telegram-"));
  const update = {
    update_id: 44,
    message: {
      message_id: 7,
      date: 1_777_000_000,
      chat: { id: 12345, first_name: "Mark", type: "private" },
      from: { id: 12345, first_name: "Mark", username: "mark" },
      text: "Can you check the latest run?",
    },
  };
  const fetchImpl = createFetch([
    { body: { ok: true, result: [update] } },
  ]);
  const createdSessions = [];
  const writes = [];
  const liveSessions = new Map();
  const service = new TelegramService({
    fetchImpl,
    pollIntervalMs: 0,
    promptDelayMs: 0,
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
      telegramAllowedChatIds: "12345",
      telegramBotToken: "bot_secret",
      telegramEnabled: true,
      telegramProviderId: "claude",
      wikiPath: "/tmp/wiki",
    },
    stateDir,
  });

  try {
    const sessions = await service.pollUpdatesOnce({ reason: "startup" });
    await flushAsyncHandlers();

    assert.equal(sessions.length, 1);
    assert.equal(createdSessions.length, 1);
    assert.equal(createdSessions[0].name, "Telegram communications");
    assert.equal(createdSessions[0].providerId, "claude");
    assert.match(writes[0].input, /vr-telegram-reply' --chat-id '12345' --message-id '7'/);
    assert.match(writes[0].input, /Can you check the latest run/);
    assert.deepEqual(writes[1], { input: "\r", sessionId: "session-1" });

    const request = fetchImpl.calls[0];
    assert.equal(request.url, "https://api.telegram.org/botbot_secret/getUpdates");
    assert.deepEqual(JSON.parse(request.options.body).allowed_updates, ["message", "edited_message", "channel_post", "edited_channel_post"]);

    const state = JSON.parse(await readFile(path.join(stateDir, "telegram-state.json"), "utf8"));
    assert.equal(state.updateOffset, 45);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Telegram polling ignores disallowed chats but still advances the update offset", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-telegram-ignore-"));
  const fetchImpl = createFetch([
    {
      body: {
        ok: true,
        result: [
          {
            update_id: 9,
            message: {
              message_id: 1,
              chat: { id: 999 },
              from: { id: 999, first_name: "Other" },
              text: "hello",
            },
          },
        ],
      },
    },
  ]);
  const service = new TelegramService({
    fetchImpl,
    pollIntervalMs: 0,
    sessionManager: {
      createSession() {
        throw new Error("disallowed chat should not create a session");
      },
    },
    settings: {
      telegramAllowedChatIds: "12345",
      telegramBotToken: "bot_secret",
      telegramEnabled: true,
      telegramProviderId: "claude",
    },
    stateDir,
  });

  try {
    const sessions = await service.pollUpdatesOnce({ reason: "startup" });
    assert.equal(sessions.length, 0);
    assert.equal(service.getStatus().lastIgnoredEventType, "message.chat-not-allowed");
    const state = JSON.parse(await readFile(path.join(stateDir, "telegram-state.json"), "utf8"));
    assert.equal(state.updateOffset, 10);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Telegram polling ignores unsupported updates and bot senders while advancing offsets", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-telegram-bot-ignore-"));
  const fetchImpl = createFetch([
    {
      body: {
        ok: true,
        result: [
          { update_id: 1, my_chat_member: { chat: { id: 12345 } } },
          {
            update_id: 2,
            message: {
              message_id: 3,
              chat: { id: 12345 },
              from: { id: 22, is_bot: true, first_name: "NoiseBot" },
              text: "automated ping",
            },
          },
        ],
      },
    },
  ]);
  const service = new TelegramService({
    fetchImpl,
    pollIntervalMs: 0,
    sessionManager: {
      createSession() {
        throw new Error("ignored Telegram updates should not create a session");
      },
    },
    settings: {
      telegramBotToken: "bot_secret",
      telegramEnabled: true,
      telegramProviderId: "claude",
    },
    stateDir,
  });

  try {
    const sessions = await service.pollUpdatesOnce({ reason: "startup" });
    assert.equal(sessions.length, 0);
    assert.equal(service.getStatus().ignoredCount, 2);
    assert.equal(service.getStatus().lastIgnoredEventType, "message.from-bot");
    const state = JSON.parse(await readFile(path.join(stateDir, "telegram-state.json"), "utf8"));
    assert.equal(state.updateOffset, 3);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Telegram reuses live communications sessions and replaces exited or provider-mismatched sessions", async () => {
  const createdSessions = [];
  const liveSessions = new Map();
  const writes = [];
  const service = new TelegramService({
    promptDelayMs: 0,
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
      telegramBotToken: "bot_secret",
      telegramEnabled: true,
      telegramProviderId: "claude",
      wikiPath: "/tmp/wiki",
    },
  });
  const buildUpdate = (messageId, text) => ({
    update_id: messageId,
    message: {
      message_id: messageId,
      chat: { id: 12345 },
      from: { id: 12345, first_name: "Mark" },
      text,
    },
  });

  const firstSession = await service.handleIncomingUpdate(buildUpdate(1, "first"), { source: "poll" });
  const secondSession = await service.handleIncomingUpdate(buildUpdate(2, "second"), { source: "poll" });
  liveSessions.get("session-1").status = "exited";
  const thirdSession = await service.handleIncomingUpdate(buildUpdate(3, "third"), { source: "poll" });
  service.setSettings({
    telegramBotToken: "bot_secret",
    telegramEnabled: true,
    telegramProviderId: "codex",
    wikiPath: "/tmp/wiki",
  });
  const fourthSession = await service.handleIncomingUpdate(buildUpdate(4, "fourth"), { source: "poll" });
  await flushAsyncHandlers();

  assert.equal(firstSession.id, "session-1");
  assert.equal(secondSession.id, "session-1");
  assert.equal(thirdSession.id, "session-2");
  assert.equal(fourthSession.id, "session-3");
  assert.equal(createdSessions.length, 3);
  assert.equal(createdSessions[0].name, "Telegram communications");
  assert.equal(createdSessions[2].providerId, "codex");
  assert.match(writes.map((write) => write.input).join("\n"), /first/);
  assert.match(writes.map((write) => write.input).join("\n"), /fourth/);
});

test("Telegram confirms Claude workspace trust and waits for a ready prompt before injecting", async () => {
  const timers = [];
  const writes = [];
  const sessions = new Map();
  let now = 0;
  const service = new TelegramService({
    nowImpl() {
      return now;
    },
    promptDelayMs: 1_000,
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
      telegramBotToken: "bot_secret",
      telegramEnabled: true,
      telegramProviderId: "claude",
      wikiPath: "/tmp/wiki",
    },
  });

  await service.handleIncomingUpdate(
    {
      update_id: 10,
      message: {
        message_id: 10,
        chat: { id: 12345 },
        from: { id: 12345, first_name: "Mark" },
        text: "Please reply after Claude is ready.",
      },
    },
    { source: "startup" },
  );

  assert.equal(writes.length, 0);
  now = 1_200;
  timers.shift()();
  assert.deepEqual(writes[0], { input: "1\r", sessionId: "session-trust-test" });
  assert.equal(service.getStatus().lastStatus, "confirming-workspace-trust-startup");

  now = 2_500;
  sessions.get("session-trust-test").buffer = "Claude Code\n❯ ";
  sessions.get("session-trust-test").lastOutputAt = new Date(1_000).toISOString();
  timers.shift()();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].sessionId, "session-trust-test");
  assert.match(writes[1].input, /Please reply after Claude is ready/);
  assert.doesNotMatch(writes[1].input, /\r$/);
  assert.equal(service.getStatus().lastStatus, "submitting-prompt-startup");

  timers.shift()();
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[2], { input: "\r", sessionId: "session-trust-test" });
  assert.equal(service.getStatus().lastStatus, "prompt-sent-startup");
});

test("Telegram reply helper sends text without exposing the bot token to prompts", async () => {
  const fetchImpl = createFetch([
    { body: { ok: true, result: { message_id: 8 } } },
  ]);
  const service = new TelegramService({
    fetchImpl,
    settings: {
      telegramBotToken: "bot_secret",
      telegramEnabled: true,
    },
  });

  const reply = await service.replyToMessage({
    chatId: "12345",
    messageId: "7",
    text: "On it.",
  });

  assert.equal(reply.message_id, 8);
  assert.equal(fetchImpl.calls[0].url, "https://api.telegram.org/botbot_secret/sendMessage");
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), {
    chat_id: "12345",
    reply_parameters: { message_id: 7 },
    text: "On it.",
  });

  const prompt = testInternals.buildTelegramPrompt({
    message: {
      message_id: 7,
      chat: { id: 12345 },
      from: { first_name: "Mark" },
      text: "Hello",
    },
  });
  assert.match(prompt, /vr-telegram-reply/);
  assert.doesNotMatch(prompt, /bot_secret/);
});

test("Telegram reply validation and API errors are explicit", async () => {
  const noTokenService = new TelegramService({
    settings: {
      telegramEnabled: true,
    },
  });
  await assert.rejects(
    noTokenService.replyToMessage({ chatId: "12345", text: "hello" }),
    /bot token is not configured/i,
  );

  const fetchImpl = createFetch([
    { ok: false, status: 401, body: { ok: false, description: "Unauthorized" } },
  ]);
  const service = new TelegramService({
    fetchImpl,
    settings: {
      telegramBotToken: "bot_secret",
      telegramEnabled: true,
    },
  });

  await assert.rejects(
    service.replyToMessage({ chatId: "", text: "hello" }),
    /chat ID is required/i,
  );
  await assert.rejects(
    service.replyToMessage({ chatId: "12345", text: "" }),
    /reply text cannot be empty/i,
  );
  await assert.rejects(
    service.replyToMessage({ chatId: "12345", text: "hello" }),
    /Unauthorized/,
  );
});

test("Telegram polling recovers connected status after a transient API failure", async () => {
  const fetchImpl = createFetch([
    { ok: false, status: 502, body: { ok: false, description: "Bad gateway" } },
    { body: { ok: true, result: [] } },
  ]);
  const service = new TelegramService({
    fetchImpl,
    pollIntervalMs: 0,
    settings: {
      telegramBotToken: "bot_secret",
      telegramEnabled: true,
      telegramProviderId: "claude",
    },
  });

  const failedSessions = await service.pollUpdatesOnce({ reason: "manual" });
  assert.equal(failedSessions.length, 0);
  assert.equal(service.getStatus().connected, false);
  assert.equal(service.getStatus().lastStatus, "error");
  assert.match(service.getStatus().lastError, /Bad gateway/);

  const recoveredSessions = await service.pollUpdatesOnce({ reason: "manual" });
  assert.equal(recoveredSessions.length, 0);
  assert.equal(service.getStatus().connected, true);
  assert.equal(service.getStatus().lastStatus, "polling");
  assert.equal(service.getStatus().lastError, "");
});

test("Telegram prompts normalize allowed chat IDs and truncate oversized messages", () => {
  assert.deepEqual(testInternals.normalizeAllowedChatIds([" 123 ", "", "-456"]), ["123", "-456"]);
  assert.deepEqual(testInternals.normalizeAllowedChatIds("123, -456\n789"), ["123", "-456", "789"]);

  const prompt = testInternals.buildTelegramPrompt({
    message: {
      message_id: 12,
      chat: { id: -456, title: "Project room" },
      caption: `${"a".repeat(12_050)}`,
      sender_chat: { title: "Project channel" },
    },
    replyCommand: "vr-telegram-reply",
  });
  assert.match(prompt, /Chat ID: -456/);
  assert.match(prompt, /Project room/);
  assert.match(prompt, /Project channel/);
  assert.match(prompt, /truncated this Telegram message at 12000 characters/);
  const truncated = testInternals.truncateText("a".repeat(12_050));
  assert.ok(truncated.length < 12_100);
  assert.match(truncated, /truncated this Telegram message at 12000 characters/);
});

test("Telegram API endpoints hide secrets and protect replies with a local token", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-telegram-api-"));
  let appContext = null;
  let restartedWith = null;
  const previousTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const fakeService = {
    replyToken: "telegram-token",
    getStatus() {
      return {
        botTokenConfigured: Boolean(restartedWith?.telegramBotToken),
        enabled: Boolean(restartedWith?.telegramEnabled),
        providerId: restartedWith?.telegramProviderId || "claude",
      };
    },
    restart(settings) {
      restartedWith = settings;
    },
    start() {},
    stop() {},
    async replyToMessage(input) {
      return { message_id: 77, ...input };
    },
  };

  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    appContext = await createVibeResearchApp({
      cwd: workspaceDir,
      port: 0,
      persistSessions: false,
      stateDir: path.join(workspaceDir, ".vibe-research"),
      providers: [
        {
          id: "claude",
          label: "Claude Code",
          available: true,
          defaultName: "Claude",
          command: "node",
          args: ["-e", "setInterval(() => {}, 1000)"],
        },
      ],
      telegramServiceFactory(settings) {
        restartedWith = settings;
        return fakeService;
      },
    });
    const baseUrl = `http://127.0.0.1:${appContext.config.port}`;

    const missingTokenResponse = await fetch(`${baseUrl}/api/telegram/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, providerId: "claude" }),
    });
    assert.equal(missingTokenResponse.status, 400);
    const missingTokenPayload = await missingTokenResponse.json();
    assert.match(missingTokenPayload.error, /bot token is required/i);

    const setupResponse = await fetch(`${baseUrl}/api/telegram/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: "bot_secret", enabled: true, providerId: "claude" }),
    });
    const setupPayload = await setupResponse.json();
    assert.equal(setupResponse.status, 200);
    assert.equal(setupPayload.settings.telegramBotToken, "");
    assert.equal(setupPayload.settings.telegramBotTokenConfigured, true);
    assert.equal(restartedWith.telegramBotToken, "bot_secret");

    const reuseSavedTokenResponse = await fetch(`${baseUrl}/api/telegram/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedChatIds: "12345", enabled: true, providerId: "claude" }),
    });
    const reuseSavedTokenPayload = await reuseSavedTokenResponse.json();
    assert.equal(reuseSavedTokenResponse.status, 200);
    assert.equal(reuseSavedTokenPayload.settings.telegramBotToken, "");
    assert.equal(reuseSavedTokenPayload.settings.telegramBotTokenConfigured, true);
    assert.equal(restartedWith.telegramBotToken, "bot_secret");
    assert.equal(restartedWith.telegramAllowedChatIds, "12345");

    const rejectedReply = await fetch(`${baseUrl}/api/telegram/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "12345", text: "hi" }),
    });
    assert.equal(rejectedReply.status, 403);

    const replyResponse = await fetch(`${baseUrl}/api/telegram/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vibe-research-telegram-token": "telegram-token",
      },
      body: JSON.stringify({ chatId: "12345", messageId: "7", text: "hi" }),
    });
    const replyPayload = await replyResponse.json();
    assert.equal(replyResponse.status, 200);
    assert.equal(replyPayload.reply.message_id, 77);
    assert.equal(replyPayload.reply.chatId, "12345");
  } finally {
    await appContext?.close();
    if (previousTelegramBotToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = previousTelegramBotToken;
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("vr-telegram-reply posts through the local server token", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-telegram-helper-"));
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        body: JSON.parse(body || "{}"),
        headers: request.headers,
        method: request.method,
        url: request.url,
      });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, reply: { message_id: 99 } }));
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await writeFile(
      path.join(stateDir, "server.json"),
      `${JSON.stringify({
        helperBaseUrl: `http://127.0.0.1:${port}`,
        telegramReplyToken: "local-token",
      })}\n`,
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(process.cwd(), "bin", "vr-telegram-reply"),
        "--chat-id",
        "12345",
        "--message-id",
        "7",
        "--text",
        "Sent from helper.",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          VIBE_RESEARCH_ROOT: stateDir,
        },
      },
    );

    assert.match(stdout, /Telegram reply sent: 99/);
    const [replyRequest] = requests.filter((request) => request.method === "POST" && request.url === "/api/telegram/reply");
    assert.ok(replyRequest, "expected helper to post a Telegram reply request");
    assert.equal(replyRequest.headers["x-vibe-research-telegram-token"], "local-token");
    assert.deepEqual(replyRequest.body, {
      chatId: "12345",
      messageId: "7",
      text: "Sent from helper.",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});
