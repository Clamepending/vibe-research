import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getVibeResearchSystemDir } from "./state-paths.js";
import { getBuildingAgentWorkspacePath } from "./workspace-layout.js";

const TWILIO_BUILDING_ID = "twilio";
const TWILIO_API_BASE_URL = "https://api.twilio.com/2010-04-01";
const TWILIO_VERIFY_BASE_URL = "https://verify.twilio.com/v2";
const STORE_FILENAME = "twilio-state.json";
const STORE_VERSION = 1;
const DEFAULT_PROMPT_DELAY_MS = 1_500;
const DEFAULT_PROMPT_READY_IDLE_MS = 1_000;
const DEFAULT_PROMPT_READY_TIMEOUT_MS = 45_000;
const DEFAULT_PROMPT_RETRY_MS = 500;
const DEFAULT_PROMPT_SUBMIT_DELAY_MS = 350;
const TWILIO_TEXT_LIMIT = 4_000;

function buildHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizeCents(value, fallback = 2) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function normalizePhoneNumber(value) {
  return String(value || "").trim();
}

function normalizeSid(value) {
  return String(value || "").trim();
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function truncateText(value, limit = TWILIO_TEXT_LIMIT) {
  const text = String(value || "").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit).trim()}\n\n[Vibe Research truncated this SMS message at ${limit} characters.]`;
}

function maskPhoneNumber(value) {
  const phoneNumber = normalizePhoneNumber(value);
  if (phoneNumber.length <= 6) {
    return phoneNumber;
  }
  return `${phoneNumber.slice(0, 3)}...${phoneNumber.slice(-4)}`;
}

function normalizeTerminalText(value) {
  return String(value || "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, " ")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/\x1B[@-Z\\-_]/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSessionTimestamp(value, fallback) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isClaudeProviderId(providerId) {
  return ["claude", "claude-ollama"].includes(String(providerId || "").trim().toLowerCase());
}

function hasClaudeWorkspaceTrustPrompt(buffer) {
  const text = normalizeTerminalText(buffer);
  return /Quick\s*safety\s*check|Yes,\s*I\s*trust\s*this\s*folder|Claude\s*Code'll\s*be\s*able\s*to\s*read/i.test(text);
}

function providerHasReadyHint(providerId, buffer) {
  const text = normalizeTerminalText(buffer);
  if (!text.trim()) {
    return false;
  }

  if (isClaudeProviderId(providerId)) {
    if (hasClaudeWorkspaceTrustPrompt(text)) {
      return false;
    }
    return /Claude\s*Code\s*v|bypass\s*permissions|Welcome back|>/i.test(text);
  }

  if (providerId === "codex") {
    return /Ask for follow-up changes|Full access|GPT-|>/i.test(text);
  }

  if (providerId === "gemini") {
    return /Gemini|Type your message|>/i.test(text);
  }

  if (providerId === "opencode") {
    return /OpenCode\s*v|opencode\s*v|>/i.test(text);
  }

  return true;
}

function safeJsonParse(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function flattenParamValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "")).join("");
  }
  return String(value ?? "");
}

function validateTwilioSignature({ authToken, params = {}, signature = "", url = "" } = {}) {
  const token = String(authToken || "");
  const requestUrl = String(url || "");
  const headerSignature = String(signature || "");
  if (!token || !requestUrl || !headerSignature) {
    return false;
  }

  const body = Object.keys(params || {})
    .sort()
    .map((key) => `${key}${flattenParamValue(params[key])}`)
    .join("");
  const expected = createHmac("sha1", token).update(`${requestUrl}${body}`).digest("base64");
  return safeCompare(headerSignature, expected);
}

function normalizeState(payload) {
  const state = payload && typeof payload === "object" ? payload : {};
  return {
    version: STORE_VERSION,
    contacts: Array.isArray(state.contacts) ? state.contacts.filter((contact) => contact?.phoneNumber) : [],
    pendingVerifications: Array.isArray(state.pendingVerifications)
      ? state.pendingVerifications.filter((entry) => entry?.phoneNumber)
      : [],
  };
}

function buildTwilioPrompt({ message, replyCommand = "vr-twilio-reply" }) {
  const replyCommandWord = shellQuote(replyCommand);
  const from = normalizePhoneNumber(message.from);
  const to = normalizePhoneNumber(message.to);
  const messageSid = normalizeSid(message.messageSid);
  const text = truncateText(message.text || "");

  return [
    "You are the Vibe Research SMS agent. A verified human sent a text message to the Twilio building.",
    "Your job is to fulfill the request when it is safe and useful, then send exactly one concise SMS reply when a reply is appropriate.",
    "",
    "Reply command template:",
    "```sh",
    `${replyCommandWord} --to ${shellQuote(from)} --message-sid ${shellQuote(messageSid)} <<'VIBE_RESEARCH_SMS_REPLY'`,
    "Your reply text here.",
    "VIBE_RESEARCH_SMS_REPLY",
    "```",
    "",
    "Operating rules:",
    "- Prefer short plain text replies. SMS replies consume wallet credits through the Twilio building.",
    "- Use the configured Vibe Research Library before answering questions about Mark, current projects, prior decisions, or local project knowledge.",
    "- Do not reveal secrets, tokens, local paths with sensitive content, private credentials, or raw billing data.",
    "- Do not click links, create accounts, spend money, publish, delete, or perform sensitive account actions from SMS alone; ask for human review in this session.",
    "- If the message looks like spam, automated noise, or an unsafe request, do not send SMS; briefly note the reason here.",
    "",
    "SMS metadata:",
    `- From: ${from}`,
    `- To: ${to}`,
    `- Message SID: ${messageSid}`,
    `- Received at: ${message.receivedAt || ""}`,
    "",
    "SMS body:",
    "```text",
    text || "(empty SMS body)",
    "```",
  ].join("\n");
}

export class TwilioService {
  constructor({
    clearTimeoutImpl = clearTimeout,
    cwd = process.cwd(),
    fetchImpl = globalThis.fetch,
    nowImpl = () => new Date().toISOString(),
    promptDelayMs = DEFAULT_PROMPT_DELAY_MS,
    promptReadyIdleMs = DEFAULT_PROMPT_READY_IDLE_MS,
    promptReadyTimeoutMs = DEFAULT_PROMPT_READY_TIMEOUT_MS,
    promptRetryMs = DEFAULT_PROMPT_RETRY_MS,
    promptSubmitDelayMs = DEFAULT_PROMPT_SUBMIT_DELAY_MS,
    sessionManager,
    setTimeoutImpl = setTimeout,
    settings = {},
    stateDir = "",
    systemRootPath = stateDir ? getVibeResearchSystemDir({ cwd, stateDir }) : "",
    walletService = null,
  } = {}) {
    this.clearTimeout = clearTimeoutImpl;
    this.cwd = cwd;
    this.fetch = fetchImpl;
    this.now = nowImpl;
    this.promptDelayMs = promptDelayMs;
    this.promptReadyIdleMs = promptReadyIdleMs;
    this.promptReadyTimeoutMs = promptReadyTimeoutMs;
    this.promptRetryMs = promptRetryMs;
    this.promptSubmitDelayMs = promptSubmitDelayMs;
    this.replyToken = randomUUID();
    this.serverBaseUrl = "";
    this.sessionManager = sessionManager;
    this.setTimeout = setTimeoutImpl;
    this.settings = settings || {};
    this.stateDir = stateDir;
    this.systemRootPath = systemRootPath ? path.resolve(cwd, systemRootPath) : "";
    this.stateFilePath = stateDir ? path.join(stateDir, STORE_FILENAME) : "";
    this.walletService = walletService;
    this.webhookToken = randomUUID();
    this.contacts = new Map();
    this.pendingVerifications = new Map();
    this.stateLoaded = false;
    this.stateLoadPromise = null;
    this.status = {
      connected: false,
      ignoredCount: 0,
      lastError: "",
      lastEventAt: "",
      lastFrom: "",
      lastMessageSid: "",
      lastPromptSentAt: "",
      lastSessionId: "",
      lastStatus: "idle",
      processedCount: 0,
      verifiedContactCount: 0,
    };
  }

  setSettings(settings = {}) {
    this.settings = settings || {};
  }

  setServerBaseUrl(serverBaseUrl = "") {
    this.serverBaseUrl = String(serverBaseUrl || "").trim().replace(/\/+$/, "");
  }

  getConfig() {
    return {
      accountSid: String(this.settings.twilioAccountSid || "").trim(),
      authToken: String(this.settings.twilioAuthToken || "").trim(),
      enabled: normalizeBoolean(this.settings.twilioEnabled, false),
      fromNumber: normalizePhoneNumber(this.settings.twilioFromNumber || ""),
      providerId: String(this.settings.twilioProviderId || "claude").trim() || "claude",
      smsEstimateCents: normalizeCents(this.settings.twilioSmsEstimateCents, 2),
      verifyServiceSid: String(this.settings.twilioVerifyServiceSid || "").trim(),
    };
  }

  getWebhookUrl() {
    if (!this.serverBaseUrl) {
      return "";
    }
    return `${this.serverBaseUrl}/api/twilio/sms?token=${encodeURIComponent(this.webhookToken)}`;
  }

  getStatus() {
    const config = this.getConfig();
    const verifyReady = Boolean(config.accountSid && config.authToken && config.verifyServiceSid);
    const ready = Boolean(config.enabled && config.accountSid && config.authToken && config.fromNumber);
    return {
      ...this.status,
      accountSidConfigured: Boolean(config.accountSid),
      authTokenConfigured: Boolean(config.authToken),
      enabled: config.enabled,
      fromNumber: config.fromNumber,
      pendingVerificationCount: this.pendingVerifications.size,
      providerId: config.providerId,
      ready,
      replyHelper: "vr-twilio-reply",
      smsEstimateCents: config.smsEstimateCents,
      verifyReady,
      verifyServiceSidConfigured: Boolean(config.verifyServiceSid),
      verifiedContactCount: this.contacts.size,
      webhookUrl: this.getWebhookUrl(),
    };
  }

  async initialize() {
    await this.loadState();
  }

  start() {
    const config = this.getConfig();
    if (!config.enabled) {
      this.status.connected = false;
      this.status.lastStatus = "disabled";
      return;
    }

    if (!config.accountSid || !config.authToken || !config.fromNumber) {
      this.status.connected = false;
      this.status.lastStatus = "needs-setup";
      this.status.lastError = "Twilio account SID, auth token, and sender number are required.";
      return;
    }

    this.status.connected = true;
    this.status.lastError = "";
    this.status.lastStatus = "ready";
  }

  stop() {
    this.status.connected = false;
    if (this.status.lastStatus !== "disabled") {
      this.status.lastStatus = "stopped";
    }
  }

  restart(settings = this.settings) {
    this.stop();
    this.setSettings(settings);
    this.start();
  }

  async loadState() {
    if (this.stateLoaded) {
      return;
    }

    if (this.stateLoadPromise) {
      await this.stateLoadPromise;
      return;
    }

    this.stateLoadPromise = (async () => {
      try {
        if (this.stateFilePath) {
          const raw = await readFile(this.stateFilePath, "utf8");
          const payload = normalizeState(safeJsonParse(raw, {}));
          this.contacts = new Map(payload.contacts.map((contact) => [normalizePhoneNumber(contact.phoneNumber), contact]));
          this.pendingVerifications = new Map(
            payload.pendingVerifications.map((entry) => [normalizePhoneNumber(entry.phoneNumber), entry]),
          );
          this.status.verifiedContactCount = this.contacts.size;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          this.status.lastError = error.message || "Could not load Twilio state.";
        }
      } finally {
        this.stateLoaded = true;
        this.stateLoadPromise = null;
      }
    })();

    await this.stateLoadPromise;
  }

  async saveState() {
    if (!this.stateFilePath) {
      return;
    }

    await mkdir(path.dirname(this.stateFilePath), { recursive: true });
    const payload = {
      version: STORE_VERSION,
      savedAt: this.now(),
      contacts: [...this.contacts.values()],
      pendingVerifications: [...this.pendingVerifications.values()],
    };
    const tempPath = `${this.stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tempPath, this.stateFilePath);
  }

  async markPhoneVerified(phoneNumber, metadata = {}) {
    await this.loadState();
    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
    if (!normalizedPhoneNumber) {
      throw buildHttpError("Phone number is required.", 400);
    }

    const existing = this.contacts.get(normalizedPhoneNumber) || {};
    const contact = {
      ...existing,
      phoneNumber: normalizedPhoneNumber,
      verified: true,
      verifiedAt: this.now(),
      metadata: {
        ...(existing.metadata || {}),
        ...metadata,
      },
    };
    this.contacts.set(normalizedPhoneNumber, contact);
    this.pendingVerifications.delete(normalizedPhoneNumber);
    this.status.verifiedContactCount = this.contacts.size;
    await this.saveState();
    return contact;
  }

  async isPhoneVerified(phoneNumber) {
    await this.loadState();
    const contact = this.contacts.get(normalizePhoneNumber(phoneNumber));
    return Boolean(contact?.verified);
  }

  verifyWebhook({ body = {}, headers = {}, url = "" } = {}) {
    const config = this.getConfig();
    let token = "";
    try {
      token = new URL(String(url || "")).searchParams.get("token") || "";
    } catch {
      token = "";
    }

    if (token && safeCompare(token, this.webhookToken)) {
      return true;
    }

    return validateTwilioSignature({
      authToken: config.authToken,
      params: body,
      signature: headers["x-twilio-signature"] || headers["X-Twilio-Signature"] || "",
      url,
    });
  }

  async startVerification({ phoneNumber } = {}) {
    const config = this.getConfig();
    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
    if (!normalizedPhoneNumber) {
      throw buildHttpError("Phone number is required.", 400);
    }
    if (!config.accountSid || !config.authToken || !config.verifyServiceSid) {
      throw buildHttpError("Twilio Verify needs an account SID, auth token, and Verify Service SID.", 400);
    }

    const verification = await this.requestVerify({
      body: {
        Channel: "sms",
        To: normalizedPhoneNumber,
      },
      config,
      resourcePath: "Verifications",
    });
    await this.loadState();
    this.pendingVerifications.set(normalizedPhoneNumber, {
      phoneNumber: normalizedPhoneNumber,
      sid: verification.sid || "",
      startedAt: this.now(),
      status: verification.status || "pending",
    });
    await this.saveState();
    this.status.lastError = "";
    this.status.lastStatus = "verification-started";
    return {
      phoneNumber: normalizedPhoneNumber,
      sid: verification.sid || "",
      status: verification.status || "pending",
    };
  }

  async checkVerification({ code, phoneNumber } = {}) {
    const config = this.getConfig();
    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
    const normalizedCode = String(code || "").trim();
    if (!normalizedPhoneNumber) {
      throw buildHttpError("Phone number is required.", 400);
    }
    if (!normalizedCode) {
      throw buildHttpError("Verification code is required.", 400);
    }
    if (!config.accountSid || !config.authToken || !config.verifyServiceSid) {
      throw buildHttpError("Twilio Verify needs an account SID, auth token, and Verify Service SID.", 400);
    }

    const verification = await this.requestVerify({
      body: {
        Code: normalizedCode,
        To: normalizedPhoneNumber,
      },
      config,
      resourcePath: "VerificationCheck",
    });
    const approved = verification.status === "approved";
    let contact = null;
    if (approved) {
      contact = await this.markPhoneVerified(normalizedPhoneNumber, {
        verificationSid: verification.sid || "",
      });
    }
    this.status.lastError = "";
    this.status.lastStatus = approved ? "verification-approved" : "verification-pending";
    return {
      approved,
      contact,
      phoneNumber: normalizedPhoneNumber,
      sid: verification.sid || "",
      status: verification.status || "",
    };
  }

  async handleIncomingMessage(params = {}, { source = "webhook" } = {}) {
    const config = this.getConfig();
    if (!config.enabled) {
      throw buildHttpError("Twilio building is disabled.", 503);
    }

    const from = normalizePhoneNumber(params.From || params.from);
    const to = normalizePhoneNumber(params.To || params.to);
    const text = String(params.Body || params.body || "");
    const messageSid = normalizeSid(params.MessageSid || params.SmsMessageSid || params.messageSid);
    if (!from) {
      throw buildHttpError("Twilio webhook did not include a sender.", 400);
    }

    await this.loadState();
    if (!(await this.isPhoneVerified(from))) {
      this.status.ignoredCount += 1;
      this.status.lastError = "";
      this.status.lastEventAt = this.now();
      this.status.lastFrom = from;
      this.status.lastMessageSid = messageSid;
      this.status.lastStatus = "ignored-unverified-phone";
      return {
        ignored: true,
        reason: "phone-not-verified",
      };
    }

    const buildingSessionCwd = this.getBuildingSessionCwd();
    const sessionCwd = buildingSessionCwd || this.systemRootPath || this.settings.wikiPath || this.cwd;
    try {
      if (buildingSessionCwd || this.systemRootPath) {
        await mkdir(sessionCwd, { recursive: true });
      }

      const session = this.getOrCreateCommunicationSession({
        config,
        cwd: sessionCwd,
        phoneNumber: from,
      });
      const contact = this.contacts.get(from) || { phoneNumber: from, verified: true };
      contact.lastMessageSid = messageSid;
      contact.lastMessageAt = this.now();
      contact.lastSessionId = session.id;
      this.contacts.set(from, contact);
      await this.saveState();

      this.status.lastError = "";
      this.status.lastEventAt = this.now();
      this.status.lastFrom = from;
      this.status.lastMessageSid = messageSid;
      this.status.lastSessionId = session.id;
      this.status.lastStatus = `queued-${source}`;
      const prompt = buildTwilioPrompt({
        message: {
          from,
          messageSid,
          receivedAt: this.status.lastEventAt,
          text,
          to,
        },
        replyCommand: this.getReplyCommand(),
      });
      this.queuePromptForSession(session.id, prompt, {
        onPromptSent: () => {
          this.status.processedCount += 1;
        },
        providerId: config.providerId,
        source,
      });
      return {
        ignored: false,
        message: { from, messageSid, text, to },
        session,
      };
    } catch (error) {
      this.status.lastError = error.message || "Could not launch SMS agent session.";
      this.status.lastStatus = "error";
      throw error;
    }
  }

  getOrCreateCommunicationSession({ config, cwd, phoneNumber }) {
    const sessionName = `Twilio SMS ${normalizePhoneNumber(phoneNumber)}`;
    const contact = this.contacts.get(normalizePhoneNumber(phoneNumber));
    const existingByContact = contact?.lastSessionId && this.sessionManager?.getSession?.(contact.lastSessionId);
    if (
      existingByContact &&
      existingByContact.status !== "exited" &&
      existingByContact.providerId === config.providerId
    ) {
      return existingByContact;
    }

    const existing = this.sessionManager?.listSessions?.()
      ?.find((session) =>
        session?.name === sessionName &&
        session?.providerId === config.providerId &&
        session?.status !== "exited");
    if (existing) {
      return this.sessionManager?.getSession?.(existing.id) || existing;
    }

    return this.sessionManager.createSession({
      providerId: config.providerId,
      name: sessionName,
      cwd,
      sourceBuildingId: TWILIO_BUILDING_ID,
    });
  }

  getBuildingSessionCwd() {
    return getBuildingAgentWorkspacePath({
      buildingId: TWILIO_BUILDING_ID,
      cwd: this.cwd,
      settings: this.settings,
      systemRootPath: this.systemRootPath,
    });
  }

  getReplyCommand() {
    return path.join(this.cwd, "bin", "vr-twilio-reply");
  }

  queuePromptForSession(sessionId, prompt, {
    onPromptSent = null,
    providerId = "",
    source = "webhook",
  } = {}) {
    const startedAt = Date.now();
    let answeredWorkspaceTrust = false;
    const failPromptDelivery = (message) => {
      this.status.lastError = message;
      this.status.lastStatus = "error";
      return false;
    };
    const markPromptSent = () => {
      this.status.lastError = "";
      this.status.lastPromptSentAt = this.now();
      this.status.lastStatus = `prompt-sent-${source}`;
      void Promise.resolve(onPromptSent?.()).catch((error) => {
        this.status.lastError = error.message || "Could not record SMS processing.";
        this.status.lastStatus = "error";
      });
      return true;
    };
    const writePrompt = () => {
      if (isClaudeProviderId(providerId)) {
        const pasted = this.sessionManager.write(sessionId, prompt);
        if (!pasted) {
          return failPromptDelivery("SMS agent session exited before Vibe Research could send the prompt.");
        }

        this.status.lastError = "";
        this.status.lastStatus = `submitting-prompt-${source}`;
        this.setTimeout(() => {
          const submitted = this.sessionManager.write(sessionId, "\r");
          if (!submitted) {
            failPromptDelivery("SMS agent session exited before Vibe Research could submit the prompt.");
            return;
          }
          markPromptSent();
        }, this.promptSubmitDelayMs);
        return true;
      }

      const ok = this.sessionManager.write(sessionId, `${prompt}\r`);
      if (!ok) {
        return failPromptDelivery("SMS agent session exited before Vibe Research could send the prompt.");
      }

      return markPromptSent();
    };

    if (typeof this.sessionManager?.getSession !== "function") {
      this.setTimeout(writePrompt, this.promptDelayMs);
      return;
    }

    const attempt = () => {
      const session = this.sessionManager.getSession(sessionId);
      if (!session || session.status === "exited") {
        failPromptDelivery("SMS agent session exited before Vibe Research could send the prompt.");
        return;
      }

      const now = Date.now();
      const lastOutputAt = parseSessionTimestamp(session.lastOutputAt || session.updatedAt || session.createdAt, startedAt);
      const elapsedMs = now - startedAt;
      const idleMs = now - lastOutputAt;

      if (isClaudeProviderId(providerId) && !answeredWorkspaceTrust && hasClaudeWorkspaceTrustPrompt(session.buffer)) {
        answeredWorkspaceTrust = true;
        const ok = this.sessionManager.write(sessionId, "1\r");
        if (!ok) {
          failPromptDelivery("SMS agent session exited before Vibe Research could confirm Claude workspace trust.");
          return;
        }

        this.status.lastError = "";
        this.status.lastStatus = `confirming-workspace-trust-${source}`;
        this.setTimeout(attempt, this.promptRetryMs);
        return;
      }

      const isReady =
        elapsedMs >= this.promptDelayMs &&
        idleMs >= this.promptReadyIdleMs &&
        providerHasReadyHint(providerId, session.buffer);

      if (isReady || elapsedMs >= this.promptReadyTimeoutMs) {
        writePrompt();
        return;
      }

      this.setTimeout(attempt, this.promptRetryMs);
    };

    this.setTimeout(attempt, Math.min(this.promptRetryMs, this.promptDelayMs));
  }

  async replyToMessage({ messageSid = "", text, to } = {}) {
    const config = this.getConfig();
    const toNumber = normalizePhoneNumber(to);
    const replyText = String(text || "").trim();
    if (!config.accountSid || !config.authToken || !config.fromNumber) {
      throw buildHttpError("Twilio account SID, auth token, and sender number are required.", 400);
    }
    if (!toNumber) {
      throw buildHttpError("SMS recipient is required.", 400);
    }
    if (!replyText) {
      throw buildHttpError("SMS reply text cannot be empty.", 400);
    }

    let hold = null;
    let walletSummary = null;
    const estimateCents = config.smsEstimateCents;
    if (estimateCents > 0) {
      if (!this.walletService || typeof this.walletService.createSpendHold !== "function") {
        throw buildHttpError("Wallet service is required before sending paid SMS.", 402);
      }
      const idempotencyHash = createHash("sha256")
        .update(`${toNumber}\n${messageSid}\n${replyText}`)
        .digest("hex")
        .slice(0, 32);
      const holdResult = await this.walletService.createSpendHold({
        action: "send-sms",
        amountCents: estimateCents,
        buildingId: "twilio",
        description: `Twilio SMS reply to ${maskPhoneNumber(toNumber)}`,
        idempotencyKey: `twilio-sms:${idempotencyHash}`,
        metadata: {
          messageSid,
          to: maskPhoneNumber(toNumber),
        },
      });
      hold = holdResult.hold;
      walletSummary = holdResult.summary;
    }

    try {
      const reply = await this.requestTwilio({
        body: {
          Body: replyText,
          From: config.fromNumber,
          To: toNumber,
        },
        config,
        url: `${TWILIO_API_BASE_URL}/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
      });

      if (hold) {
        const captured = await this.walletService.captureSpend({
          amountCents: estimateCents,
          description: `Twilio message ${reply.sid || "sent"}`,
          holdId: hold.id,
          metadata: {
            messageSid,
            twilioMessageSid: reply.sid || "",
          },
        });
        walletSummary = captured.summary;
      }

      this.status.lastError = "";
      this.status.lastStatus = "replied";
      return {
        ...reply,
        wallet: hold
          ? {
              capturedCents: estimateCents,
              holdId: hold.id,
              summary: walletSummary,
            }
          : null,
      };
    } catch (error) {
      if (hold) {
        await this.walletService.releaseSpend({
          holdId: hold.id,
          reason: error.message || "Twilio send failed.",
        }).catch(() => {});
      }
      this.status.lastError = error.message || "Could not send SMS.";
      this.status.lastStatus = "error";
      throw error;
    }
  }

  async requestVerify({ body = {}, config = this.getConfig(), resourcePath }) {
    const serviceSid = encodeURIComponent(config.verifyServiceSid);
    return this.requestTwilio({
      body,
      config,
      url: `${TWILIO_VERIFY_BASE_URL}/Services/${serviceSid}/${resourcePath}`,
    });
  }

  async requestTwilio({ body = {}, config = this.getConfig(), url }) {
    if (typeof this.fetch !== "function") {
      throw buildHttpError("fetch is not available in this Node.js runtime.", 500);
    }

    const response = await this.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    });
    const raw = await response.text().catch(() => "");
    const payload = safeJsonParse(raw, raw ? { message: raw } : {});

    if (!response.ok) {
      const message = payload?.message || payload?.error_message || payload?.error || `Twilio request failed (${response.status})`;
      const error = buildHttpError(message, response.status || 400);
      error.payload = payload;
      throw error;
    }

    return payload;
  }
}

export const testInternals = {
  buildTwilioPrompt,
  maskPhoneNumber,
  validateTwilioSignature,
};
