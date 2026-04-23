import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createVibeResearchApp } from "../src/create-app.js";
import { TwilioService, testInternals } from "../src/twilio-service.js";
import { WalletService } from "../src/wallet-service.js";

const execFileAsync = promisify(execFile);

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function createFetch(responses = []) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = responses.shift() || { body: {}, status: 200 };
    return jsonResponse(next.body, next.status || 200);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function flushAsyncHandlers() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("Twilio verification starts through Verify and marks approved phones verified", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-twilio-verify-"));
  const fetchImpl = createFetch([
    { body: { sid: "VE111", status: "pending" } },
    { body: { sid: "VE111", status: "approved" } },
  ]);
  const service = new TwilioService({
    fetchImpl,
    settings: {
      twilioAccountSid: "AC123",
      twilioAuthToken: "auth_secret",
      twilioEnabled: true,
      twilioFromNumber: "+15550001111",
      twilioVerifyServiceSid: "VA123",
    },
    stateDir,
  });

  try {
    await service.initialize();
    const started = await service.startVerification({ phoneNumber: "+15551234567" });
    assert.equal(started.status, "pending");
    assert.equal(fetchImpl.calls[0].url, "https://verify.twilio.com/v2/Services/VA123/Verifications");
    assert.equal(new URLSearchParams(fetchImpl.calls[0].options.body).get("Channel"), "sms");

    const checked = await service.checkVerification({ phoneNumber: "+15551234567", code: "123456" });
    assert.equal(checked.approved, true);
    assert.equal(await service.isPhoneVerified("+15551234567"), true);
    assert.equal(fetchImpl.calls[1].url, "https://verify.twilio.com/v2/Services/VA123/VerificationCheck");

    const stored = JSON.parse(await readFile(path.join(stateDir, "twilio-state.json"), "utf8"));
    assert.equal(stored.contacts[0].phoneNumber, "+15551234567");
    assert.equal(stored.contacts[0].verified, true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Twilio inbound SMS from a verified phone opens one dedicated SMS session", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-twilio-inbound-"));
  const createdSessions = [];
  const writes = [];
  const liveSessions = new Map();
  const service = new TwilioService({
    promptDelayMs: 0,
    promptReadyIdleMs: 0,
    promptSubmitDelayMs: 0,
    sessionManager: {
      createSession(input) {
        const session = {
          id: `session-${createdSessions.length + 1}`,
          ...input,
          buffer: "Claude Code > ",
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
      twilioAccountSid: "AC123",
      twilioAuthToken: "auth_secret",
      twilioEnabled: true,
      twilioFromNumber: "+15550001111",
      twilioProviderId: "claude",
      twilioVerifyServiceSid: "VA123",
      wikiPath: "/tmp/wiki",
    },
    stateDir,
  });

  try {
    await service.initialize();
    await service.markPhoneVerified("+15551234567");
    const result = await service.handleIncomingMessage({
      Body: "Can you check the latest build?",
      From: "+15551234567",
      MessageSid: "SMinbound1",
      To: "+15550001111",
    });
    await flushAsyncHandlers();

    assert.equal(result.ignored, false);
    assert.equal(createdSessions.length, 1);
    assert.equal(createdSessions[0].name, "Twilio SMS +15551234567");
    assert.equal(createdSessions[0].providerId, "claude");
    assert.match(writes[0].input, /vr-twilio-reply' --to '\+15551234567' --message-sid 'SMinbound1'/);
    assert.match(writes[0].input, /Can you check the latest build/);
    assert.deepEqual(writes[1], { input: "\r", sessionId: "session-1" });

    const second = await service.handleIncomingMessage({
      Body: "Second text",
      From: "+15551234567",
      MessageSid: "SMinbound2",
      To: "+15550001111",
    });
    assert.equal(second.session.id, "session-1");

    const ignored = await service.handleIncomingMessage({
      Body: "unverified",
      From: "+15557654321",
      MessageSid: "SMignored",
      To: "+15550001111",
    });
    assert.equal(ignored.ignored, true);
    assert.equal(service.getStatus().lastStatus, "ignored-unverified-phone");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Twilio replies reserve and capture wallet credits around the Messages API call", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-twilio-reply-"));
  const wallet = new WalletService({ stateDir });
  const fetchImpl = createFetch([
    { body: { sid: "SMoutbound1", status: "queued" } },
  ]);
  const service = new TwilioService({
    fetchImpl,
    settings: {
      twilioAccountSid: "AC123",
      twilioAuthToken: "auth_secret",
      twilioEnabled: true,
      twilioFromNumber: "+15550001111",
      twilioSmsEstimateCents: "3",
    },
    stateDir,
    walletService: wallet,
  });

  try {
    await wallet.initialize();
    await wallet.grantCredits({ amountCents: 20, description: "sms credits" });
    const reply = await service.replyToMessage({
      messageSid: "SMinbound",
      text: "Done.",
      to: "+15551234567",
    });

    assert.equal(reply.sid, "SMoutbound1");
    assert.equal(reply.wallet.capturedCents, 3);
    assert.equal(wallet.getStatus().spentCents, 3);
    assert.equal(wallet.getStatus().availableCents, 17);
    assert.equal(fetchImpl.calls[0].url, "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    const body = new URLSearchParams(fetchImpl.calls[0].options.body);
    assert.equal(body.get("To"), "+15551234567");
    assert.equal(body.get("From"), "+15550001111");
    assert.equal(body.get("Body"), "Done.");
    assert.equal(fetchImpl.calls[0].options.headers.Authorization, `Basic ${Buffer.from("AC123:auth_secret").toString("base64")}`);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Twilio webhook signatures validate request URL and form parameters", () => {
  const url = "https://example.com/api/twilio/sms?token=abc";
  const params = {
    Body: "hello",
    From: "+15551234567",
    MessageSid: "SM123",
  };
  const signed = `${url}${Object.keys(params).sort().map((key) => `${key}${params[key]}`).join("")}`;
  const signature = createHmac("sha1", "auth_secret").update(signed).digest("base64");

  assert.equal(testInternals.validateTwilioSignature({ authToken: "auth_secret", params, signature, url }), true);
  assert.equal(testInternals.validateTwilioSignature({ authToken: "wrong", params, signature, url }), false);
});

test("Twilio API endpoints hide secrets and protect reply helper access", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-twilio-api-"));
  let appContext = null;
  let restartedWith = null;
  const fakeService = {
    replyToken: "twilio-token",
    webhookToken: "webhook-token",
    getStatus() {
      return {
        accountSidConfigured: Boolean(restartedWith?.twilioAccountSid),
        authTokenConfigured: Boolean(restartedWith?.twilioAuthToken),
        enabled: Boolean(restartedWith?.twilioEnabled),
        fromNumber: restartedWith?.twilioFromNumber || "",
        providerId: restartedWith?.twilioProviderId || "claude",
        ready: Boolean(restartedWith?.twilioEnabled && restartedWith?.twilioAccountSid),
        verifyServiceSidConfigured: Boolean(restartedWith?.twilioVerifyServiceSid),
      };
    },
    async initialize() {},
    restart(settings) {
      restartedWith = settings;
    },
    start() {},
    stop() {},
    setServerBaseUrl() {},
    getWebhookUrl() {
      return "https://example.com/api/twilio/sms?token=webhook-token";
    },
    async startVerification(input) {
      return { sid: "VE111", status: "pending", ...input };
    },
    async checkVerification(input) {
      return { approved: true, sid: "VE111", status: "approved", ...input };
    },
    verifyWebhook() {
      return true;
    },
    async handleIncomingMessage(input) {
      return { ignored: false, message: input };
    },
    async replyToMessage(input) {
      return { sid: "SMreply", ...input };
    },
  };

  try {
    appContext = await createVibeResearchApp({
      cwd: workspaceDir,
      port: 0,
      persistSessions: false,
      persistentTerminals: false,
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
      systemMetricsSampleIntervalMs: 0,
      twilioServiceFactory(settings) {
        restartedWith = settings;
        return fakeService;
      },
    });
    const baseUrl = `http://127.0.0.1:${appContext.config.port}`;

    const missingResponse = await fetch(`${baseUrl}/api/twilio/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, providerId: "claude" }),
    });
    assert.equal(missingResponse.status, 400);

    const setupResponse = await fetch(`${baseUrl}/api/twilio/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountSid: "AC123",
        authToken: "auth_secret",
        enabled: true,
        fromNumber: "+15550001111",
        providerId: "claude",
        verifyServiceSid: "VA123",
      }),
    });
    assert.equal(setupResponse.status, 200);
    const setupPayload = await setupResponse.json();
    assert.equal(setupPayload.settings.twilioAccountSid, "");
    assert.equal(setupPayload.settings.twilioAccountSidConfigured, true);
    assert.equal(setupPayload.settings.twilioAuthToken, "");
    assert.equal(setupPayload.settings.twilioAuthTokenConfigured, true);
    assert.equal(setupPayload.settings.twilioVerifyServiceSid, "");
    assert.equal(setupPayload.settings.twilioVerifyServiceSidConfigured, true);
    assert.equal(restartedWith.twilioAuthToken, "auth_secret");

    const verifyStartResponse = await fetch(`${baseUrl}/api/twilio/verify/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumber: "+15551234567" }),
    });
    assert.equal(verifyStartResponse.status, 201);
    const verifyCheckResponse = await fetch(`${baseUrl}/api/twilio/verify/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456", phoneNumber: "+15551234567" }),
    });
    assert.equal(verifyCheckResponse.status, 200);

    const inboundResponse = await fetch(`${baseUrl}/api/twilio/sms?token=webhook-token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        Body: "hello",
        From: "+15551234567",
        MessageSid: "SMinbound",
        To: "+15550001111",
      }).toString(),
    });
    assert.equal(inboundResponse.status, 200);
    assert.match(await inboundResponse.text(), /<Response><\/Response>/);

    const rejectedReply = await fetch(`${baseUrl}/api/twilio/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi", to: "+15551234567" }),
    });
    assert.equal(rejectedReply.status, 403);

    const replyResponse = await fetch(`${baseUrl}/api/twilio/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vibe-research-twilio-token": "twilio-token",
      },
      body: JSON.stringify({ messageSid: "SMinbound", text: "hi", to: "+15551234567" }),
    });
    assert.equal(replyResponse.status, 200);
    const replyPayload = await replyResponse.json();
    assert.equal(replyPayload.reply.sid, "SMreply");
  } finally {
    await appContext?.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("vr-twilio-reply posts through the local server token", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-twilio-helper-"));
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
      response.end(JSON.stringify({ ok: true, reply: { sid: "SMhelper" } }));
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await writeFile(
      path.join(stateDir, "server.json"),
      `${JSON.stringify({
        helperBaseUrl: `http://127.0.0.1:${port}`,
        twilioReplyToken: "local-token",
      })}\n`,
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(process.cwd(), "bin", "vr-twilio-reply"),
        "--to",
        "+15551234567",
        "--message-sid",
        "SMinbound",
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

    assert.match(stdout, /Twilio SMS reply sent: SMhelper/);
    const [replyRequest] = requests.filter((request) => request.method === "POST" && request.url === "/api/twilio/reply");
    assert.ok(replyRequest, "expected helper to post a Twilio reply request");
    assert.equal(replyRequest.headers["x-vibe-research-twilio-token"], "local-token");
    assert.deepEqual(replyRequest.body, {
      messageSid: "SMinbound",
      text: "Sent from helper.",
      to: "+15551234567",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});
