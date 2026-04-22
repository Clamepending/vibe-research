import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STORE_FILENAME = "videomemory-monitors.json";
const STORE_VERSION = 1;
const RECENT_EVENT_LIMIT = 80;
const PROMPT_TEXT_LIMIT = 2200;
const PROMPT_DELAY_MS = 1200;
const PROMPT_READY_IDLE_MS = 350;
const PROMPT_READY_TIMEOUT_MS = 30_000;
const PROMPT_RETRY_MS = 500;
const PROMPT_SUBMIT_DELAY_MS = 320;
const WAKE_COOLDOWN_MS = 60_000;
const SUPPRESSED_EVENT_PERSIST_MS = 5_000;

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

function normalizeText(value, limit = 500) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, Math.max(1, limit - 3)).trim()}...`;
}

function normalizeTerminalText(value) {
  return String(value || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasClaudeWorkspaceTrustPrompt(buffer) {
  const text = normalizeTerminalText(buffer);
  return /Quick\s*safety\s*check|Yes,\s*I\s*trust\s*this\s*folder|Claude\s*Code'll\s*be\s*able\s*to\s*read/i.test(text);
}

function providerHasReadyHint(providerId, buffer) {
  const text = normalizeTerminalText(buffer);
  if (!text) {
    return false;
  }

  if (providerId === "claude") {
    if (hasClaudeWorkspaceTrustPrompt(text)) {
      return false;
    }
    return /Claude\s*Code\s*v|bypass\s*permissions|❯|Welcome back/i.test(text);
  }

  if (providerId === "codex") {
    return /Ask for follow-up changes|Full access|GPT-|❯|›/i.test(text);
  }

  if (providerId === "gemini") {
    return /Gemini|Type your message|❯|>/i.test(text);
  }

  if (providerId === "opencode") {
    return /OpenCode\s*v|opencode\s*v|❯|>/i.test(text);
  }

  if (providerId === "ml-intern") {
    return /ML\s*Intern|Hugging\s*Face\s*Agent|>\s*$/i.test(text);
  }

  return true;
}

function normalizeProviderId(value, fallback = "claude") {
  const providerId = String(value || fallback || "claude").trim().toLowerCase();
  return /^[a-z0-9_-]+$/.test(providerId) ? providerId : fallback;
}

function normalizeBaseUrl(value) {
  const baseUrl = String(value || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    return "";
  }

  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function extractHeader(headers, name) {
  if (!headers) {
    return "";
  }

  if (typeof headers.get === "function") {
    return String(headers.get(name) || "").trim();
  }

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lowerName) {
      return Array.isArray(value) ? String(value[0] || "").trim() : String(value || "").trim();
    }
  }

  return "";
}

function extractBearerToken(headers) {
  const authorization = extractHeader(headers, "authorization");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match) {
    return match[1].trim();
  }

  return (
    extractHeader(headers, "x-vibe-research-videomemory-token") ||
    extractHeader(headers, "x-vibe-research-videomemory-token") ||
    extractHeader(headers, "x-videomemory-token") ||
    extractHeader(headers, "x-videomemory-webhook-token")
  );
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function appendRecentEvent(existing, eventId) {
  const id = String(eventId || "").trim();
  if (!id) {
    return safeArray(existing).slice(-RECENT_EVENT_LIMIT);
  }

  const next = safeArray(existing).filter((entry) => entry !== id);
  next.push(id);
  return next.slice(-RECENT_EVENT_LIMIT);
}

function hasRecentEvent(existing, eventId) {
  const id = String(eventId || "").trim();
  return Boolean(id && safeArray(existing).includes(id));
}

function parseJsonPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  return payload;
}

function getPayloadValue(payload, ...keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }

  return "";
}

function buildHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function writeJsonFile(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function createMonitorId() {
  return `vm_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function buildTaskApiUrl(baseUrl, taskId) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedBaseUrl || !normalizedTaskId) {
    return "";
  }

  return `${normalizedBaseUrl}/api/task/${encodeURIComponent(normalizedTaskId)}`;
}

function extractTaskId(payload) {
  return String(
    getPayloadValue(payload, "task_id", "taskId", "id") ||
      payload?.task?.task_id ||
      payload?.task?.taskId ||
      payload?.task?.id ||
      "",
  ).trim();
}

function extractEvent(payload) {
  const body = parseJsonPayload(payload);
  const taskId = extractTaskId(body);
  const noteId = String(getPayloadValue(body, "note_id", "noteId") || "").trim();
  const noteTimestamp = String(getPayloadValue(body, "note_timestamp_iso", "noteTimestampIso", "note_timestamp", "noteTimestamp") || "").trim();
  const eventId = String(
    getPayloadValue(body, "idempotency_key", "idempotencyKey", "event_id", "eventId") ||
      ["videomemory", taskId, noteId, noteTimestamp].filter(Boolean).join(":"),
  ).trim();

  return {
    raw: body,
    botId: String(getPayloadValue(body, "bot_id", "botId") || "").trim(),
    clientRef: String(getPayloadValue(body, "client_ref", "clientRef", "route_ref", "routeRef", "monitor_id", "monitorId") || "").trim(),
    eventId,
    eventType: String(getPayloadValue(body, "event_type", "eventType") || "task_update").trim(),
    frameUrl: String(getPayloadValue(body, "note_frame_api_url", "noteFrameApiUrl", "frame_url", "frameUrl") || "").trim(),
    ioId: String(getPayloadValue(body, "io_id", "ioId") || "").trim(),
    note: normalizeText(getPayloadValue(body, "note", "task_note", "taskNote", "message", "summary"), PROMPT_TEXT_LIMIT),
    noteId,
    noteTimestamp,
    observedAt: String(getPayloadValue(body, "observed_at", "observedAt") || new Date().toISOString()).trim(),
    taskApiUrl: String(getPayloadValue(body, "task_api_url", "taskApiUrl") || "").trim(),
    taskDescription: normalizeText(getPayloadValue(body, "task_description", "taskDescription"), 700),
    taskDone: Boolean(body.task_done || body.taskDone),
    taskId,
    videoUrl: String(getPayloadValue(body, "note_video_api_url", "noteVideoApiUrl", "video_url", "videoUrl") || "").trim(),
    videomemoryBaseUrl: String(getPayloadValue(body, "videomemory_base_url", "videomemoryBaseUrl") || "").trim(),
  };
}

function buildWakePrompt(monitor, event) {
  const lines = [
    "VideoMemory monitor triggered.",
    "",
    `Monitor: ${monitor.name || monitor.trigger}`,
    `Condition: ${monitor.trigger}`,
    event.ioId || monitor.ioId ? `Camera/input: ${event.ioId || monitor.ioId}` : "",
    event.taskId || monitor.taskId ? `VideoMemory task: ${event.taskId || monitor.taskId}` : "",
    event.eventId ? `Event: ${event.eventId}` : "",
    event.observedAt ? `Observed at: ${event.observedAt}` : "",
    "",
    "Observation:",
    event.note || "VideoMemory emitted a matching task update without a note body.",
    event.frameUrl ? `\nEvidence frame: ${event.frameUrl}` : "",
    event.videoUrl ? `Evidence clip: ${event.videoUrl}` : "",
    event.taskApiUrl || monitor.taskApiUrl ? `Task API: ${event.taskApiUrl || monitor.taskApiUrl}` : "",
    "",
    "Requested action:",
    monitor.action || "Inspect the event and decide the next useful step.",
  ].filter((line) => line !== "");

  return `${lines.join("\n")}\n`;
}

export class VideoMemoryService {
  constructor({
    defaultProviderId = "claude",
    env = process.env,
    fetchImpl = globalThis.fetch,
    promptSubmitDelayMs = PROMPT_SUBMIT_DELAY_MS,
    promptDelayMs = PROMPT_DELAY_MS,
    promptReadyIdleMs = PROMPT_READY_IDLE_MS,
    promptReadyTimeoutMs = PROMPT_READY_TIMEOUT_MS,
    promptRetryMs = PROMPT_RETRY_MS,
    sessionManager = null,
    setTimeoutImpl = setTimeout,
    nowImpl = Date.now,
    suppressedEventPersistMs = SUPPRESSED_EVENT_PERSIST_MS,
    settings = {},
    stateDir,
    wakeCooldownMs = WAKE_COOLDOWN_MS,
  }) {
    this.defaultProviderId = defaultProviderId;
    this.env = env && typeof env === "object" ? { ...env } : { ...process.env };
    this.fetchImpl = fetchImpl;
    this.monitors = new Map();
    this.now = typeof nowImpl === "function" ? nowImpl : Date.now;
    this.promptDelayMs = promptDelayMs;
    this.promptReadyIdleMs = promptReadyIdleMs;
    this.promptReadyTimeoutMs = promptReadyTimeoutMs;
    this.promptRetryMs = promptRetryMs;
    this.promptSubmitDelayMs = promptSubmitDelayMs;
    this.sessionManager = sessionManager;
    this.setTimeout = setTimeoutImpl;
    this.suppressedEventPersistMs = suppressedEventPersistMs;
    this.settings = settings || {};
    this.stateDir = stateDir;
    this.storePath = path.join(stateDir, STORE_FILENAME);
    this.wakeCooldownMs = wakeCooldownMs;
    this.webhookToken = "";
    this.requestToken = randomUUID();
    this.serverBaseUrl = "";
  }

  async initialize() {
    let payload = null;
    try {
      payload = JSON.parse(await readFile(this.storePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[vibe-research] failed to load VideoMemory monitors", error);
      }
    }

    this.webhookToken =
      typeof payload?.webhookToken === "string" && payload.webhookToken.trim()
        ? payload.webhookToken.trim()
        : `vmwh_${randomUUID().replace(/-/g, "")}`;

    const monitors = payload?.version === STORE_VERSION && Array.isArray(payload.monitors)
      ? payload.monitors
      : [];

    for (const snapshot of monitors) {
      const monitor = this.normalizePersistedMonitor(snapshot);
      if (monitor) {
        this.monitors.set(monitor.id, monitor);
      }
    }

    await this.persist();
  }

  normalizePersistedMonitor(snapshot) {
    const id = String(snapshot?.id || "").trim();
    if (!id) {
      return null;
    }

    return {
      action: normalizeText(snapshot.action, 1200),
      createdAt: String(snapshot.createdAt || new Date().toISOString()),
      cwd: String(snapshot.cwd || ""),
      eventIds: safeArray(snapshot.eventIds).map((entry) => String(entry)).filter(Boolean).slice(-RECENT_EVENT_LIMIT),
      id,
      includeFrame: normalizeBoolean(snapshot.includeFrame, true),
      includeVideo: normalizeBoolean(snapshot.includeVideo, false),
      ioId: String(snapshot.ioId || snapshot.io_id || ""),
      lastError: String(snapshot.lastError || ""),
      lastEventAt: snapshot.lastEventAt || null,
      lastEventFrameUrl: String(snapshot.lastEventFrameUrl || ""),
      lastEventId: String(snapshot.lastEventId || ""),
      lastEventNote: normalizeText(snapshot.lastEventNote, 700),
      lastSessionId: String(snapshot.lastSessionId || snapshot.sessionId || ""),
      lastSuppressedAt: snapshot.lastSuppressedAt || null,
      lastSuppressedPersistAt: snapshot.lastSuppressedPersistAt || null,
      lastWakeAt: snapshot.lastWakeAt || snapshot.lastEventAt || null,
      name: normalizeText(snapshot.name, 80),
      providerId: normalizeProviderId(snapshot.providerId, this.getDefaultProviderId()),
      sessionId: String(snapshot.sessionId || ""),
      status: ["active", "paused", "deleted"].includes(snapshot.status) ? snapshot.status : "active",
      taskApiUrl: String(snapshot.taskApiUrl || ""),
      taskId: String(snapshot.taskId || snapshot.task_id || ""),
      targetMode: snapshot.targetMode === "new-session" ? "new-session" : "session",
      trigger: normalizeText(snapshot.trigger || snapshot.condition || snapshot.taskDescription, 1000),
      updatedAt: String(snapshot.updatedAt || snapshot.createdAt || new Date().toISOString()),
      wakeCount: Number.isFinite(Number(snapshot.wakeCount)) ? Number(snapshot.wakeCount) : 0,
    };
  }

  async persist() {
    await writeJsonFile(this.storePath, {
      version: STORE_VERSION,
      savedAt: new Date().toISOString(),
      webhookToken: this.webhookToken,
      monitors: Array.from(this.monitors.values()),
    });
  }

  restart(settings = {}) {
    this.settings = settings || {};
  }

  setSessionManager(sessionManager) {
    this.sessionManager = sessionManager;
  }

  setServerBaseUrl(baseUrl) {
    this.serverBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  }

  getDefaultProviderId() {
    return normalizeProviderId(this.settings.videoMemoryProviderId, this.defaultProviderId);
  }

  resolveBaseUrl() {
    return normalizeBaseUrl(
      this.settings.videoMemoryBaseUrl ||
        this.env.VIDEOMEMORY_BASE_URL ||
        this.env.VIDEOMEMORY_BASE ||
        "http://127.0.0.1:5050",
    );
  }

  isEnabled() {
    return Boolean(this.settings.videoMemoryEnabled);
  }

  getWebhookUrl() {
    return this.serverBaseUrl ? `${this.serverBaseUrl}/api/videomemory/webhook` : "";
  }

  getStatus() {
    const monitors = this.listMonitors();
    const activeCount = monitors.filter((monitor) => monitor.status === "active").length;
    const latestEventAt = monitors
      .map((monitor) => monitor.lastEventAt || monitor.updatedAt || "")
      .filter(Boolean)
      .sort()
      .at(-1) || null;

    return {
      activeCount,
      baseUrl: this.resolveBaseUrl(),
      command: "vr-videomemory",
      defaultProviderId: this.getDefaultProviderId(),
      enabled: this.isEnabled(),
      latestEventAt,
      monitorsCount: monitors.length,
      reason: this.isEnabled() ? "" : "VideoMemory plugin is disabled.",
      webhookToken: this.webhookToken,
      webhookUrl: this.getWebhookUrl(),
    };
  }

  serializeMonitor(monitor) {
    return {
      action: monitor.action,
      createdAt: monitor.createdAt,
      cwd: monitor.cwd,
      id: monitor.id,
      includeFrame: monitor.includeFrame,
      includeVideo: monitor.includeVideo,
      ioId: monitor.ioId,
      lastError: monitor.lastError,
      lastEventAt: monitor.lastEventAt,
      lastEventFrameUrl: monitor.lastEventFrameUrl,
      lastEventId: monitor.lastEventId,
      lastEventNote: monitor.lastEventNote,
      lastSessionId: monitor.lastSessionId,
      lastSuppressedAt: monitor.lastSuppressedAt,
      lastWakeAt: monitor.lastWakeAt,
      name: monitor.name,
      providerId: monitor.providerId,
      sessionId: monitor.sessionId,
      status: monitor.status,
      taskApiUrl: monitor.taskApiUrl,
      taskId: monitor.taskId,
      targetMode: monitor.targetMode,
      trigger: monitor.trigger,
      updatedAt: monitor.updatedAt,
      wakeCount: monitor.wakeCount,
    };
  }

  listMonitors() {
    return Array.from(this.monitors.values())
      .map((monitor) => this.serializeMonitor(monitor))
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  }

  getMonitor(monitorId) {
    const monitor = this.monitors.get(String(monitorId || "").trim());
    return monitor ? this.serializeMonitor(monitor) : null;
  }

  validateCreateRequest(token) {
    return Boolean(token && token === this.requestToken);
  }

  validateWebhookRequest(headers, body = {}) {
    const token = extractBearerToken(headers) || String(body?.token || "").trim();
    return Boolean(token && token === this.webhookToken);
  }

  async fetchVideoMemoryJson(pathname, options = {}) {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetch is not available in this Node.js runtime.");
    }

    const baseUrl = this.resolveBaseUrl();
    if (!baseUrl) {
      throw new Error("VideoMemory base URL is not configured.");
    }

    const response = await this.fetchImpl(`${baseUrl}${pathname}`, options);
    const payload = await response.json().catch(async () => {
      const text = typeof response.text === "function" ? await response.text().catch(() => "") : "";
      return text ? { text } : {};
    });

    if (!response.ok) {
      throw new Error(payload.error || payload.message || `VideoMemory request failed (${response.status})`);
    }

    return payload;
  }

  buildCreateTaskBody(monitor) {
    return {
      io_id: monitor.ioId,
      task_description: monitor.trigger,
      bot_id: "vibe-research",
      save_note_frames: monitor.includeFrame,
      save_note_videos: monitor.includeVideo,
    };
  }

  async createRemoteTask(monitor) {
    if (monitor.taskId) {
      return {
        taskId: monitor.taskId,
        taskApiUrl: monitor.taskApiUrl || buildTaskApiUrl(this.resolveBaseUrl(), monitor.taskId),
      };
    }

    const payload = await this.fetchVideoMemoryJson("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.buildCreateTaskBody(monitor)),
    });
    const taskId = extractTaskId(payload);
    if (!taskId) {
      throw new Error("VideoMemory did not return a task id.");
    }

    return {
      taskId,
      taskApiUrl: buildTaskApiUrl(this.resolveBaseUrl(), taskId),
    };
  }

  async createMonitor(options = {}) {
    if (!this.isEnabled()) {
      throw buildHttpError("VideoMemory plugin is disabled.", 409);
    }

    const trigger = normalizeText(options.trigger || options.condition || options.task || options.taskDescription, 1000);
    if (!trigger) {
      throw buildHttpError("VideoMemory monitor trigger is required.", 400);
    }

    const ioId = String(options.ioId || options.io_id || "").trim();
    if (!ioId) {
      throw buildHttpError("VideoMemory io_id is required.", 400);
    }

    const callerSessionId = String(options.callerSessionId || "").trim();
    const targetSessionId = String(options.targetSessionId || options.sessionId || callerSessionId || "").trim();
    const now = new Date().toISOString();
    const monitor = {
      action: normalizeText(options.action || options.then || "Inspect the VideoMemory event and take the requested next step.", 1200),
      createdAt: now,
      cwd: String(options.cwd || ""),
      eventIds: [],
      id: createMonitorId(),
      includeFrame: normalizeBoolean(options.includeFrame ?? options.saveNoteFrames, true),
      includeVideo: normalizeBoolean(options.includeVideo ?? options.saveNoteVideos, false),
      ioId,
      lastError: "",
      lastEventAt: null,
      lastEventFrameUrl: "",
      lastEventId: "",
      lastEventNote: "",
      lastSessionId: targetSessionId,
      lastSuppressedAt: null,
      lastSuppressedPersistAt: null,
      lastWakeAt: null,
      name: normalizeText(options.name || options.title || trigger, 80),
      providerId: normalizeProviderId(options.providerId || options.provider, this.getDefaultProviderId()),
      sessionId: targetSessionId,
      status: "active",
      taskApiUrl: buildTaskApiUrl(this.resolveBaseUrl(), options.taskId || options.task_id),
      taskId: String(options.taskId || options.task_id || "").trim(),
      targetMode: String(options.target || options.targetMode || "").trim() === "new-session" || !targetSessionId
        ? "new-session"
        : "session",
      trigger,
      updatedAt: now,
      wakeCount: 0,
    };

    const remoteTask = await this.createRemoteTask(monitor);
    monitor.taskId = remoteTask.taskId;
    monitor.taskApiUrl = remoteTask.taskApiUrl;
    monitor.updatedAt = new Date().toISOString();
    this.monitors.set(monitor.id, monitor);
    await this.persist();
    return this.serializeMonitor(monitor);
  }

  findMonitorForEvent(event) {
    const activeMonitors = Array.from(this.monitors.values()).filter((monitor) => monitor.status === "active");
    if (event.clientRef) {
      const byClientRef = activeMonitors.find((monitor) => monitor.id === event.clientRef);
      if (byClientRef) {
        return byClientRef;
      }
    }

    if (event.taskId) {
      const byTaskId = activeMonitors.find((monitor) => monitor.taskId === event.taskId);
      if (byTaskId) {
        return byTaskId;
      }
    }

    return null;
  }

  async resolveWakeSession(monitor) {
    const sessionId = monitor.targetMode === "session" ? String(monitor.sessionId || "").trim() : "";
    const existingSession = sessionId && this.sessionManager?.getSession?.(sessionId);

    if (existingSession && existingSession.status !== "exited") {
      return {
        providerId: existingSession.providerId || monitor.providerId,
        sessionId: existingSession.id,
      };
    }

    const session = this.sessionManager?.createSession?.({
      providerId: monitor.providerId || this.getDefaultProviderId(),
      name: `camera: ${monitor.name || monitor.ioId}`,
      cwd: monitor.cwd || undefined,
    });

    if (!session?.id) {
      throw new Error("Vibe Research could not create an agent session for this VideoMemory monitor.");
    }

    monitor.sessionId = session.id;
    monitor.lastSessionId = session.id;
    monitor.targetMode = "session";
    return {
      providerId: session.providerId || monitor.providerId,
      sessionId: session.id,
    };
  }

  sendPromptToSession({ providerId, prompt, sessionId }) {
    if (!this.sessionManager?.write) {
      return false;
    }

    if (providerId === "claude") {
      this.queueClaudePromptForSession(sessionId, prompt);
      return true;
    }

    return this.sessionManager.write(sessionId, `${prompt}\r`);
  }

  queueClaudePromptForSession(sessionId, prompt) {
    const startedAt = this.now();
    let answeredWorkspaceTrust = false;

    const writePrompt = () => {
      const pasted = this.sessionManager.write(sessionId, prompt);
      if (!pasted) {
        return;
      }

      this.setTimeout(() => {
        this.sessionManager.write(sessionId, "\r");
      }, this.promptSubmitDelayMs);
    };

    if (typeof this.sessionManager.getSession !== "function") {
      this.setTimeout(writePrompt, this.promptDelayMs);
      return;
    }

    const attempt = () => {
      const session = this.sessionManager.getSession(sessionId);
      if (!session || session.status === "exited") {
        return;
      }

      const now = this.now();
      const lastOutputAt = Date.parse(session.lastOutputAt || session.updatedAt || session.createdAt || "") || startedAt;
      const elapsedMs = now - startedAt;
      const idleMs = now - lastOutputAt;

      if (!answeredWorkspaceTrust && hasClaudeWorkspaceTrustPrompt(session.buffer)) {
        answeredWorkspaceTrust = true;
        const ok = this.sessionManager.write(sessionId, "1\r");
        if (!ok) {
          return;
        }
        this.setTimeout(attempt, this.promptRetryMs);
        return;
      }

      const isReady =
        elapsedMs >= this.promptDelayMs &&
        idleMs >= this.promptReadyIdleMs &&
        providerHasReadyHint("claude", session.buffer);

      if (isReady || elapsedMs >= this.promptReadyTimeoutMs) {
        writePrompt();
        return;
      }

      this.setTimeout(attempt, this.promptRetryMs);
    };

    this.setTimeout(attempt, Math.min(this.promptRetryMs, this.promptDelayMs));
  }

  getWakeCooldownRemainingMs(monitor, nowMs = this.now()) {
    const cooldownMs = Math.max(0, Number(this.settings.videoMemoryWakeCooldownMs ?? this.wakeCooldownMs) || 0);
    if (!cooldownMs) {
      return 0;
    }

    const lastWakeMs =
      Date.parse(monitor.wakeInFlightAt || "") ||
      Date.parse(monitor.lastWakeAt || "") ||
      0;
    if (!lastWakeMs) {
      return 0;
    }

    return Math.max(0, cooldownMs - (nowMs - lastWakeMs));
  }

  async suppressCooldownEvent(monitor, event, remainingMs, nowMs) {
    const nowIso = new Date(nowMs).toISOString();
    monitor.eventIds = appendRecentEvent(monitor.eventIds, event.eventId);
    monitor.lastError = "";
    monitor.lastEventAt = nowIso;
    monitor.lastEventFrameUrl = event.frameUrl || monitor.lastEventFrameUrl;
    monitor.lastEventId = event.eventId || monitor.lastEventId;
    monitor.lastEventNote = event.note || monitor.lastEventNote;
    monitor.lastSuppressedAt = nowIso;
    monitor.updatedAt = nowIso;

    const lastPersistMs = Date.parse(monitor.lastSuppressedPersistAt || "") || 0;
    if (!lastPersistMs || nowMs - lastPersistMs >= this.suppressedEventPersistMs) {
      monitor.lastSuppressedPersistAt = nowIso;
      await this.persist();
    }

    return {
      status: "suppressed",
      reason: "cooldown",
      eventId: event.eventId,
      monitor: this.serializeMonitor(monitor),
      retryAfterMs: remainingMs,
    };
  }

  async handleWebhook({ headers = {}, body = {} } = {}) {
    if (!this.validateWebhookRequest(headers, body)) {
      throw buildHttpError("Invalid VideoMemory webhook token.", 403);
    }

    const event = extractEvent(body);
    const monitor = this.findMonitorForEvent(event);
    if (!monitor) {
      return {
        status: "ignored",
        reason: "monitor_not_found",
        eventId: event.eventId,
        taskId: event.taskId,
      };
    }

    if (hasRecentEvent(monitor.eventIds, event.eventId)) {
      return {
        status: "suppressed",
        reason: "duplicate",
        eventId: event.eventId,
        monitor: this.serializeMonitor(monitor),
      };
    }

    const eventReceivedMs = this.now();
    const cooldownRemainingMs = this.getWakeCooldownRemainingMs(monitor, eventReceivedMs);
    if (cooldownRemainingMs > 0) {
      return this.suppressCooldownEvent(monitor, event, cooldownRemainingMs, eventReceivedMs);
    }

    monitor.wakeInFlightAt = new Date(eventReceivedMs).toISOString();

    try {
      const wakeSession = await this.resolveWakeSession(monitor);
      const prompt = buildWakePrompt(monitor, event);
      const sent = this.sendPromptToSession({
        providerId: wakeSession.providerId,
        prompt,
        sessionId: wakeSession.sessionId,
      });

      if (!sent) {
        throw new Error("Target agent session exited before Vibe Research could send the VideoMemory prompt.");
      }

      const now = new Date(eventReceivedMs).toISOString();
      monitor.eventIds = appendRecentEvent(monitor.eventIds, event.eventId);
      monitor.lastError = "";
      monitor.lastEventAt = now;
      monitor.lastEventFrameUrl = event.frameUrl;
      monitor.lastEventId = event.eventId;
      monitor.lastEventNote = event.note;
      monitor.lastSessionId = wakeSession.sessionId;
      monitor.lastWakeAt = now;
      monitor.updatedAt = now;
      monitor.wakeCount += 1;
      delete monitor.wakeInFlightAt;
      await this.persist();

      return {
        status: "delivered",
        eventId: event.eventId,
        monitor: this.serializeMonitor(monitor),
        sessionId: wakeSession.sessionId,
      };
    } catch (error) {
      delete monitor.wakeInFlightAt;
      monitor.lastError = error.message || "Could not wake agent for VideoMemory event.";
      monitor.updatedAt = new Date().toISOString();
      await this.persist();
      throw error;
    }
  }

  async deleteMonitor(monitorId, { stopRemoteTask = true } = {}) {
    const monitor = this.monitors.get(String(monitorId || "").trim());
    if (!monitor) {
      return null;
    }

    monitor.status = "deleted";
    monitor.updatedAt = new Date().toISOString();

    if (stopRemoteTask && monitor.taskId && this.resolveBaseUrl()) {
      try {
        await this.fetchVideoMemoryJson(`/api/task/${encodeURIComponent(monitor.taskId)}/stop`, {
          method: "POST",
        });
      } catch (error) {
        monitor.lastError = error.message || "Could not stop VideoMemory task.";
      }
    }

    await this.persist();
    return this.serializeMonitor(monitor);
  }

  listSubagentsForSession(sessionId) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) {
      return [];
    }

    return Array.from(this.monitors.values())
      .filter((monitor) => monitor.status === "active" && monitor.sessionId === normalizedSessionId)
      .map((monitor) => ({
        agentType: "VideoMemory monitor",
        commands: ["vr-videomemory"],
        description: monitor.trigger,
        latestUrl: monitor.lastEventFrameUrl || monitor.taskApiUrl || "",
        messageCount: monitor.wakeCount,
        name: monitor.name || `Camera ${monitor.ioId}`,
        paths: [],
        source: "videomemory",
        status: "working",
        toolUseCount: null,
        updatedAt: monitor.lastEventAt || monitor.updatedAt,
        videoMemoryMonitorId: monitor.id,
        videoMemoryTaskId: monitor.taskId,
        ioId: monitor.ioId,
      }));
  }
}

export const testInternals = {
  buildWakePrompt,
  extractEvent,
  hasClaudeWorkspaceTrustPrompt,
  normalizeBaseUrl,
  providerHasReadyHint,
};
