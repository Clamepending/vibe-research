import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STORE_FILENAME = "agent-callbacks.json";
const STORE_VERSION = 1;
const SECRET_BYTES = 32;
const TOKEN_LENGTH = 32;
const TEXT_LIMIT = 1200;
const PAYLOAD_LIMIT = 3600;
const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|token|secret|password|passcode|private[_-]?key|api[_-]?key|credential/i;

function buildHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeBaseUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) {
    return "";
  }

  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString().replace(/\/+$/, "")
      : "";
  } catch {
    return "";
  }
}

function normalizeText(value, limit = TEXT_LIMIT) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 3)).trim()}...`;
}

function getPayloadValue(payload, ...keys) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null) {
      return payload[key];
    }
  }

  return "";
}

function redactValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return normalizeText(value, 1000);
  }
  if (typeof value !== "object") {
    return value;
  }
  if (depth >= 5) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((entry) => redactValue(entry, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value).slice(0, 80).map(([key, entry]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : redactValue(entry, depth + 1),
    ]),
  );
}

function stringifyPayload(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  let text = "";
  try {
    text = JSON.stringify(redactValue(value), null, 2);
  } catch {
    text = normalizeText(value, PAYLOAD_LIMIT);
  }

  return text.length <= PAYLOAD_LIMIT
    ? text
    : `${text.slice(0, PAYLOAD_LIMIT - 15).trim()}\n... [truncated]`;
}

function extractBearerToken(value) {
  const match = /^bearer\s+(.+)$/i.exec(String(value || "").trim());
  return match ? match[1].trim() : "";
}

function extractToken(headers = {}, body = {}) {
  return String(
    headers["x-vibe-research-agent-callback-token"] ||
      headers["x-remote-vibes-agent-callback-token"] ||
      extractBearerToken(headers.authorization) ||
      body?.callbackToken ||
      body?.callback_token ||
      body?.token ||
      "",
  ).trim();
}

function compactContextValue(value) {
  return normalizeText(value, 160);
}

function extractCallbackEvent(body = {}) {
  const payload = body && typeof body === "object" ? body : {};
  return {
    buildingId: compactContextValue(getPayloadValue(payload, "buildingId", "building_id", "building")),
    event: compactContextValue(getPayloadValue(payload, "event", "eventType", "event_type", "type")) || "callback",
    eventId: compactContextValue(getPayloadValue(payload, "eventId", "event_id", "idempotencyKey", "idempotency_key", "id")),
    message: normalizeText(getPayloadValue(payload, "message", "text", "body", "note", "summary"), 1800),
    payload: getPayloadValue(payload, "payload", "data", "details", "metadata") || payload,
    replyUrl: compactContextValue(getPayloadValue(payload, "replyUrl", "reply_url", "responseUrl", "response_url")),
    serviceId: compactContextValue(getPayloadValue(payload, "serviceId", "service_id", "service")),
    source: compactContextValue(getPayloadValue(payload, "source", "sender", "from")),
    threadId: compactContextValue(getPayloadValue(payload, "threadId", "thread_id", "conversationId", "conversation_id")),
    title: normalizeText(getPayloadValue(payload, "title", "subject"), 220),
  };
}

function buildAgentCallbackPrompt(event) {
  const sourceLabel =
    [event.buildingId, event.serviceId].filter(Boolean).join(" / ") ||
    event.source ||
    "external service";
  const lines = [
    "",
    "[Vibe Research agent callback]",
    `A service callback was delivered to this agent from ${sourceLabel}.`,
  ];

  if (event.buildingId) lines.push(`Building: ${event.buildingId}`);
  if (event.serviceId) lines.push(`Service: ${event.serviceId}`);
  if (event.source && event.source !== sourceLabel) lines.push(`Source: ${event.source}`);
  if (event.event) lines.push(`Event: ${event.event}`);
  if (event.eventId) lines.push(`Event id: ${event.eventId}`);
  if (event.threadId) lines.push(`Conversation/thread: ${event.threadId}`);
  if (event.title) lines.push(`Title: ${event.title}`);
  if (event.message) lines.push("", event.message);
  if (event.replyUrl) lines.push("", `Reply URL: ${event.replyUrl}`);

  const payloadText = stringifyPayload(event.payload);
  if (payloadText) {
    lines.push("", "Payload:", "```json", payloadText, "```");
  }

  lines.push("", "Use the building/service context above when continuing the task.");
  return lines.join("\n");
}

async function writeJsonFile(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export class AgentCallbackService {
  constructor({ stateDir, sessionManager, serverBaseUrl = "", now = () => new Date().toISOString() } = {}) {
    this.stateDir = stateDir;
    this.sessionManager = sessionManager;
    this.serverBaseUrl = normalizeBaseUrl(serverBaseUrl);
    this.now = now;
    this.storePath = path.join(stateDir, STORE_FILENAME);
    this.secret = "";
  }

  async initialize() {
    let shouldPersist = false;
    try {
      const raw = await readFile(this.storePath, "utf8");
      const payload = JSON.parse(raw);
      if (payload?.version === STORE_VERSION && typeof payload.secret === "string") {
        this.secret = payload.secret.trim();
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        shouldPersist = true;
      }
    }

    if (!this.secret) {
      this.secret = randomBytes(SECRET_BYTES).toString("base64url");
      shouldPersist = true;
    }

    if (shouldPersist) {
      await this.persist();
    }
  }

  async persist() {
    await writeJsonFile(this.storePath, {
      version: STORE_VERSION,
      savedAt: this.now(),
      secret: this.secret,
    });
  }

  setServerBaseUrl(serverBaseUrl) {
    this.serverBaseUrl = normalizeBaseUrl(serverBaseUrl);
  }

  getCallbackBaseUrl() {
    return this.serverBaseUrl ? `${this.serverBaseUrl}/api/agent-callbacks` : "";
  }

  getToken(sessionId) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) {
      throw buildHttpError("Session id is required.", 400);
    }
    if (!this.secret) {
      this.secret = randomBytes(SECRET_BYTES).toString("base64url");
      void this.persist().catch((error) => {
        console.warn("[vibe-research] failed to persist agent callback secret", error);
      });
    }

    return createHmac("sha256", this.secret).update(normalizedSessionId).digest("base64url").slice(0, TOKEN_LENGTH);
  }

  getCallback(sessionId) {
    const normalizedSessionId = String(sessionId || "").trim();
    const token = this.getToken(normalizedSessionId);
    const baseUrl = this.getCallbackBaseUrl();
    return {
      sessionId: normalizedSessionId,
      token,
      url: baseUrl
        ? `${baseUrl}/${encodeURIComponent(normalizedSessionId)}/${encodeURIComponent(token)}`
        : "",
    };
  }

  getCallbackForSession(sessionId) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!this.sessionManager?.getSession?.(normalizedSessionId)) {
      throw buildHttpError("Session not found.", 404);
    }
    return this.getCallback(normalizedSessionId);
  }

  validateCallbackToken(sessionId, token) {
    const expected = this.getToken(sessionId);
    const supplied = String(token || "").trim();
    if (!supplied || supplied.length !== expected.length) {
      return false;
    }
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
  }

  async handleRequest({ sessionId, token = "", headers = {}, body = {} } = {}) {
    return this.deliverCallback({
      body,
      headers,
      sessionId,
      token: token || extractToken(headers, body),
    });
  }

  async deliverCallback({ sessionId, token = "", headers = {}, body = {} } = {}) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) {
      throw buildHttpError("Session id is required.", 400);
    }
    if (!this.validateCallbackToken(normalizedSessionId, token || extractToken(headers, body))) {
      throw buildHttpError("Invalid agent callback token.", 403);
    }
    if (!this.sessionManager?.getSession?.(normalizedSessionId)) {
      throw buildHttpError("Session not found.", 404);
    }

    const event = extractCallbackEvent(body);
    const sent = this.sessionManager.write(normalizedSessionId, `${buildAgentCallbackPrompt(event)}\r`);
    if (!sent) {
      throw buildHttpError("Target agent session is not accepting input.", 410);
    }

    return {
      status: "delivered",
      buildingId: event.buildingId,
      event: event.event,
      eventId: event.eventId,
      serviceId: event.serviceId,
      sessionId: normalizedSessionId,
    };
  }
}
