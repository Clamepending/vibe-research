import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STORE_FILENAME = "browser-use-sessions.json";
const STORE_VERSION = 1;
const OUTPUT_TAIL_LIMIT = 40_000;
const ACTIVITY_EVENT_LIMIT = 250;
const ACTIVITY_VALUE_TEXT_LIMIT = 1200;
const TRANSCRIPT_MESSAGE_LIMIT = 80;
const TRANSCRIPT_TEXT_LIMIT = 6000;
const DEFAULT_BROWSER_USE_MAX_TURNS = 50;
const MAX_BROWSER_USE_MAX_TURNS = 200;
const DEFAULT_WORKER_RELATIVE_PATH = ".local/share/ottoauth/autoauth/headless-worker";
const DEFAULT_PROFILE_RELATIVE_PATH = ".ottoauth-headless-worker/profile";
const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);

function expandHomePath(value, homeDir = os.homedir()) {
  const rawValue = String(value || "").trim();

  if (!rawValue) {
    return "";
  }

  if (rawValue === "~") {
    return homeDir;
  }

  if (rawValue.startsWith("~/")) {
    return path.join(homeDir, rawValue.slice(2));
  }

  return rawValue;
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

export function normalizeBrowserUseMaxTurns(value, fallback = DEFAULT_BROWSER_USE_MAX_TURNS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.trunc(parsed);
  if (rounded < 1) {
    return fallback;
  }

  return Math.min(rounded, MAX_BROWSER_USE_MAX_TURNS);
}

function truncateText(value, limit = 160) {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, Math.max(1, limit - 3)).trim()}...`;
}

function deriveSessionName({ title, prompt, url }) {
  const explicitTitle = truncateText(title, 64);
  if (explicitTitle) {
    return explicitTitle;
  }

  const promptTitle = truncateText(prompt, 64)
    .split(" ")
    .filter(Boolean)
    .slice(0, 7)
    .join(" ");
  if (promptTitle) {
    return promptTitle;
  }

  const urlTitle = truncateText(url, 64);
  return urlTitle || "Browser task";
}

function appendTail(existing, chunk, limit = OUTPUT_TAIL_LIMIT) {
  const next = `${existing || ""}${String(chunk || "")}`;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function truncateLongText(value, limit = ACTIVITY_VALUE_TEXT_LIMIT) {
  const text = String(value ?? "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(1, limit - 3)).trimEnd()}...`;
}

function shouldRedactKey(key) {
  const normalized = String(key || "").toLowerCase();
  if (normalized.endsWith("_tokens") || normalized === "tokens") {
    return false;
  }

  return /(authorization|api[_-]?key|(^|[_-])token($|[_-])|secret|password|passcode|otp|verification|credit|card|cvv|cvc|ssn)/i.test(
    normalized,
  );
}

function shouldOmitLargeVisualKey(key) {
  return /(base64|image|screenshot|bitmap|png|jpeg|jpg)/i.test(String(key || ""));
}

function compactValue(value, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    if (/^data:image\//i.test(value) || value.length > 20_000) {
      return "[large text omitted]";
    }
    return truncateLongText(value);
  }

  if (Array.isArray(value)) {
    if (depth >= 4) {
      return `[${value.length} items]`;
    }
    return value.slice(0, 20).map((entry) => compactValue(entry, depth + 1));
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (depth >= 4) {
    return "[object omitted]";
  }

  const output = {};
  for (const [key, entry] of Object.entries(value).slice(0, 40)) {
    if (shouldRedactKey(key)) {
      output[key] = "[redacted]";
    } else if (shouldOmitLargeVisualKey(key)) {
      output[key] = "[image omitted]";
    } else {
      output[key] = compactValue(entry, depth + 1);
    }
  }
  return output;
}

function compactTranscriptBlock(block) {
  if (typeof block === "string") {
    return { type: "text", text: truncateLongText(block, TRANSCRIPT_TEXT_LIMIT) };
  }

  if (!block || typeof block !== "object") {
    return { type: "text", text: truncateLongText(block ?? "", TRANSCRIPT_TEXT_LIMIT) };
  }

  if (block.type === "text") {
    return {
      type: "text",
      text: truncateLongText(block.text || "", TRANSCRIPT_TEXT_LIMIT),
    };
  }

  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: String(block.id || ""),
      name: String(block.name || ""),
      input: compactValue(block.input || {}),
    };
  }

  if (block.type === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: String(block.tool_use_id || block.toolUseId || ""),
      content: Array.isArray(block.content)
        ? block.content.map((entry) => compactTranscriptBlock(entry)).slice(0, 12)
        : compactTranscriptBlock(block.content || ""),
    };
  }

  if (block.type === "image") {
    return { type: "image", text: "[image omitted]" };
  }

  return {
    type: String(block.type || "object"),
    value: compactValue(block),
  };
}

function compactTranscript(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.slice(-TRANSCRIPT_MESSAGE_LIMIT).map((message) => ({
    role: String(message?.role || "message"),
    content: Array.isArray(message?.content)
      ? message.content.map((block) => compactTranscriptBlock(block)).slice(0, 24)
      : [compactTranscriptBlock(message?.content ?? "")],
  }));
}

function normalizeActivityEvent(payload = {}) {
  const now = new Date().toISOString();
  const type = truncateText(payload.type || payload.event || "event", 80) || "event";
  return {
    id: randomUUID(),
    type,
    createdAt: typeof payload.createdAt === "string" && payload.createdAt ? payload.createdAt : now,
    payload: compactValue(payload.payload ?? payload.data ?? payload),
  };
}

function normalizeStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["queued", "running", "completed", "failed", "canceled"].includes(status)) {
    return status;
  }
  return "failed";
}

function browserUseStatusToSubagentStatus(status) {
  return status === "queued" || status === "running" ? "working" : normalizeStatus(status);
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(normalizeStatus(status));
}

function safeJsonParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function getDefaultBrowserUseWorkerPath(homeDir = os.homedir()) {
  return path.join(homeDir, DEFAULT_WORKER_RELATIVE_PATH);
}

export function getDefaultBrowserUseProfileDir(homeDir = os.homedir()) {
  return path.join(homeDir, DEFAULT_PROFILE_RELATIVE_PATH);
}

export class BrowserUseService {
  constructor({
    env = process.env,
    homeDir = os.homedir(),
    settings = {},
    stateDir,
    systemRootPath,
    workerSpawner = spawn,
  }) {
    this.env = env && typeof env === "object" ? { ...env } : { ...process.env };
    this.homeDir = homeDir;
    this.settings = settings || {};
    this.stateDir = stateDir;
    this.systemRootPath = systemRootPath || path.join(stateDir, "vibe-research-system");
    this.workerSpawner = workerSpawner;
    this.sessions = new Map();
    this.storePath = path.join(stateDir, STORE_FILENAME);
    this.requestToken = randomUUID();
    this.deviceToken = randomUUID();
    this.serverBaseUrl = "";
  }

  async initialize() {
    let payload = null;
    try {
      payload = safeJsonParse(await readFile(this.storePath, "utf8"), null);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[vibe-research] failed to load browser-use sessions", error);
      }
    }

    const sessions = payload?.version === STORE_VERSION && Array.isArray(payload.sessions)
      ? payload.sessions
      : [];

    for (const snapshot of sessions) {
      const session = {
        ...snapshot,
        child: null,
      };
      session.activity = Array.isArray(session.activity) ? session.activity : [];
      session.transcript = Array.isArray(session.transcript) ? session.transcript : [];
      session.messages = Array.isArray(session.messages) ? session.messages : [];
      if (!isTerminalStatus(session.status)) {
        session.status = "failed";
        session.error = session.error || "Vibe Research restarted before this browser-use task finished.";
        session.completedAt = session.completedAt || new Date().toISOString();
        session.updatedAt = session.completedAt;
      }
      this.sessions.set(session.id, session);
    }

    await this.persist();
  }

  setSettings(settings = {}) {
    this.settings = settings || {};
  }

  restart(settings = {}) {
    this.setSettings(settings);
  }

  setServerBaseUrl(baseUrl) {
    this.serverBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  }

  resolveWorkerPath() {
    const configured = String(
      this.settings.browserUseWorkerPath ||
      this.env.VIBE_RESEARCH_BROWSER_USE_WORKER_PATH ||
      this.env.REMOTE_VIBES_BROWSER_USE_WORKER_PATH ||
      "",
    ).trim();
    return path.resolve(expandHomePath(configured || getDefaultBrowserUseWorkerPath(this.homeDir), this.homeDir));
  }

  resolveProfileDir() {
    const configured = String(
      this.settings.browserUseProfileDir ||
      this.env.VIBE_RESEARCH_BROWSER_USE_PROFILE_DIR ||
      this.env.REMOTE_VIBES_BROWSER_USE_PROFILE_DIR ||
      "",
    ).trim();
    return path.resolve(expandHomePath(configured || getDefaultBrowserUseProfileDir(this.homeDir), this.homeDir));
  }

  resolveBrowserPath() {
    const configured = String(
      this.settings.browserUseBrowserPath ||
      this.env.OTTOAUTH_BROWSER_PATH ||
      "",
    ).trim();
    return configured ? path.resolve(expandHomePath(configured, this.homeDir)) : "";
  }

  getAnthropicApiKey() {
    return String(
      this.settings.browserUseAnthropicApiKey ||
      this.env.ANTHROPIC_API_KEY ||
      this.env.CLAUDE_API_KEY ||
      "",
    ).trim();
  }

  getModel() {
    return String(this.settings.browserUseModel || "").trim();
  }

  getMaxTurns() {
    return normalizeBrowserUseMaxTurns(this.settings.browserUseMaxTurns, DEFAULT_BROWSER_USE_MAX_TURNS);
  }

  isEnabled() {
    return Boolean(this.settings.browserUseEnabled);
  }

  workerCliPath() {
    return path.join(this.resolveWorkerPath(), "src", "cli.mjs");
  }

  isWorkerAvailable() {
    return existsSync(this.workerCliPath());
  }

  getStatus() {
    const workerPath = this.resolveWorkerPath();
    const apiKeyConfigured = Boolean(this.getAnthropicApiKey());
    const workerAvailable = this.isWorkerAvailable();
    const enabled = this.isEnabled();
    const sessions = Array.from(this.sessions.values());
    const activeCount = sessions.filter((session) => !isTerminalStatus(session.status)).length;
    let reason = "";

    if (!enabled) {
      reason = "Browser-use plugin is disabled.";
    } else if (!apiKeyConfigured) {
      reason = "Anthropic API key is required.";
    } else if (!workerAvailable) {
      reason = "OttoAuth headless worker was not found.";
    }

    return {
      activeCount,
      apiKeyConfigured,
      command: "vr-browser-use",
      enabled,
      headless: normalizeBoolean(this.settings.browserUseHeadless, true),
      keepTabs: normalizeBoolean(this.settings.browserUseKeepTabs, false),
      latestSessionAt: sessions
        .map((session) => session.updatedAt || session.createdAt || "")
        .sort()
        .at(-1) || null,
      maxTurns: this.getMaxTurns(),
      model: this.getModel(),
      profileDir: this.resolveProfileDir(),
      reason,
      sessionsCount: sessions.length,
      workerAvailable,
      workerPath,
    };
  }

  serializeSession(session, { includeSnapshot = false } = {}) {
    const latestSnapshot = session.latestSnapshot
      ? {
          capturedAt: session.latestSnapshot.capturedAt,
          height: session.latestSnapshot.height,
          tabs: session.latestSnapshot.tabs || [],
          width: session.latestSnapshot.width,
          ...(includeSnapshot ? { imageBase64: session.latestSnapshot.imageBase64 || "" } : {}),
        }
      : null;

    return {
      id: session.id,
      name: session.name,
      taskPrompt: session.taskPrompt,
      url: session.url,
      callerSessionId: session.callerSessionId,
      cwd: session.cwd,
      status: normalizeStatus(session.status),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      startedAt: session.startedAt || null,
      completedAt: session.completedAt || null,
      workerPid: session.workerPid || null,
      workerExitCode: session.workerExitCode ?? null,
      workerExitSignal: session.workerExitSignal ?? null,
      workerPath: session.workerPath,
      profileDir: session.profileDir,
      model: session.model || "",
      maxTurns: normalizeBrowserUseMaxTurns(session.maxTurns, this.getMaxTurns()),
      headless: session.headless,
      keepTabs: session.keepTabs,
      latestSnapshot,
      latestUrl: latestSnapshot?.tabs?.find((tab) => tab.active)?.url || latestSnapshot?.tabs?.[0]?.url || "",
      result: session.result ?? null,
      error: session.error || null,
      usages: Array.isArray(session.usages) ? session.usages : [],
      activity: includeSnapshot ? (Array.isArray(session.activity) ? session.activity : []) : [],
      transcript: includeSnapshot ? (Array.isArray(session.transcript) ? session.transcript : []) : [],
      stdout: includeSnapshot ? session.stdout || "" : "",
      stderr: includeSnapshot ? session.stderr || "" : "",
    };
  }

  listSessions({ includeSnapshot = false } = {}) {
    return Array.from(this.sessions.values())
      .map((session) => this.serializeSession(session, { includeSnapshot }))
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  }

  getSession(sessionId, { includeSnapshot = false } = {}) {
    const session = this.sessions.get(sessionId);
    return session ? this.serializeSession(session, { includeSnapshot }) : null;
  }

  listSubagentsForSession(parentSessionId) {
    return Array.from(this.sessions.values())
      .filter((session) =>
        session.callerSessionId &&
        session.callerSessionId === parentSessionId &&
        !isTerminalStatus(session.status)
      )
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
      .slice(0, 12)
      .map((session) => ({
        id: `browser-use:${session.id}`,
        agentId: session.id.slice(0, 8),
        browserUseSessionId: session.id,
        name: session.name || "Browser task",
        description: session.taskPrompt,
        agentType: "browser-use",
        status: browserUseStatusToSubagentStatus(session.status),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: null,
        toolUseCount: null,
        latestUrl: session.latestSnapshot?.tabs?.find((tab) => tab.active)?.url || "",
        source: "browser-use",
      }));
  }

  async persist() {
    const sessions = Array.from(this.sessions.values()).map((session) => {
      const {
        child: _child,
        ...snapshot
      } = session;
      return snapshot;
    });

    await writeJsonFile(this.storePath, {
      version: STORE_VERSION,
      savedAt: new Date().toISOString(),
      sessions,
    });
  }

  validateCreateRequest(token) {
    return Boolean(token && token === this.requestToken);
  }

  validateDeviceRequest(request) {
    const authHeader = String(request.headers?.authorization || request.get?.("authorization") || "").trim();
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    return Boolean(token && token === this.deviceToken);
  }

  async ensureCanRun() {
    if (!this.isEnabled()) {
      throw new Error("Browser-use plugin is disabled.");
    }
    if (!this.getAnthropicApiKey()) {
      throw new Error("Add an Anthropic API key before starting a browser-use task.");
    }
    await access(this.workerCliPath(), fsConstants.R_OK);
  }

  buildTaskPrompt({ prompt, taskPrompt, task, url }) {
    const explicitPrompt = String(prompt || taskPrompt || task || "").trim();
    const targetUrl = String(url || "").trim();

    if (explicitPrompt) {
      return explicitPrompt;
    }

    if (targetUrl) {
      return `Open ${targetUrl} and complete the requested browser task.`;
    }

    return "";
  }

  async createSession({
    callerSessionId = "",
    cwd = "",
    maxSteps,
    maxTurns,
    prompt = "",
    task = "",
    taskPrompt = "",
    title = "",
    url = "",
  } = {}) {
    await this.ensureCanRun();

    const normalizedPrompt = this.buildTaskPrompt({ prompt, task, taskPrompt, url });
    if (!normalizedPrompt) {
      throw new Error("Browser-use task prompt is required.");
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const workerPath = this.resolveWorkerPath();
    const workerHome = path.join(this.systemRootPath, "browser-use", id);
    const profileDir = this.resolveProfileDir();
    const browserPath = this.resolveBrowserPath();
    const model = this.getModel();
    const normalizedMaxTurns = normalizeBrowserUseMaxTurns(maxTurns ?? maxSteps, this.getMaxTurns());
    const headless = normalizeBoolean(this.settings.browserUseHeadless, true);
    const keepTabs = normalizeBoolean(this.settings.browserUseKeepTabs, false);
    const session = {
      id,
      name: deriveSessionName({ title, prompt: normalizedPrompt, url }),
      taskPrompt: normalizedPrompt,
      url: String(url || "").trim(),
      callerSessionId: String(callerSessionId || "").trim(),
      cwd: String(cwd || "").trim(),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      workerPid: null,
      workerExitCode: null,
      workerExitSignal: null,
      workerHome,
      workerPath,
      profileDir,
      browserPath,
      model,
      maxTurns: normalizedMaxTurns,
      headless,
      keepTabs,
      deviceId: `vibe-research-browser-use-${id}`,
      latestSnapshot: null,
      result: null,
      error: null,
      usages: [],
      activity: [],
      transcript: [],
      stdout: "",
      stderr: "",
      messages: [],
      child: null,
    };

    this.sessions.set(id, session);
    await this.persist();
    await this.startWorkerForSession(session);

    return this.serializeSession(session, { includeSnapshot: true });
  }

  async startWorkerForSession(session) {
    if (!this.serverBaseUrl) {
      await this.markFailed(session, "Vibe Research server URL is not ready yet.");
      return;
    }

    await mkdir(session.workerHome, { recursive: true });
    await mkdir(session.profileDir, { recursive: true });
    await writeJsonFile(path.join(session.workerHome, "config.json"), {
      serverUrl: this.serverBaseUrl,
      deviceId: session.deviceId,
      deviceLabel: `Vibe Research browser-use ${session.id.slice(0, 8)}`,
      authToken: this.deviceToken,
      browserPath: session.browserPath || null,
      pairedAt: new Date().toISOString(),
    });

    const args = [
      path.join(session.workerPath, "src", "cli.mjs"),
      "once",
      "--wait-ms",
      "1000",
      session.headless ? "--headless" : "--headful",
    ];
    if (session.keepTabs) {
      args.push("--keep-tabs");
    }
    if (session.model) {
      args.push("--model", session.model);
    }
    if (session.maxTurns) {
      args.push("--max-turns", String(session.maxTurns));
    }

    const env = {
      ...this.env,
      ANTHROPIC_API_KEY: this.getAnthropicApiKey(),
      OTTOAUTH_MAX_TURNS: String(session.maxTurns || DEFAULT_BROWSER_USE_MAX_TURNS),
      OTTOAUTH_PROFILE_DIR: session.profileDir,
      OTTOAUTH_WORKER_HOME: session.workerHome,
      VIBE_RESEARCH_BROWSER_USE_SESSION_ID: session.id,
      REMOTE_VIBES_BROWSER_USE_SESSION_ID: session.id,
    };

    let child = null;
    try {
      child = this.workerSpawner(process.execPath, args, {
        cwd: session.workerPath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      await this.markFailed(session, error.message || "Could not start OttoAuth headless worker.");
      return;
    }

    session.child = child;
    session.workerPid = child.pid || null;
    session.updatedAt = new Date().toISOString();
    await this.persist();

    child.stdout?.on?.("data", (chunk) => {
      session.stdout = appendTail(session.stdout, chunk);
      session.updatedAt = new Date().toISOString();
      void this.persist();
    });

    child.stderr?.on?.("data", (chunk) => {
      session.stderr = appendTail(session.stderr, chunk);
      session.updatedAt = new Date().toISOString();
      void this.persist();
    });

    child.on?.("error", (error) => {
      void this.markFailed(session, error.message || "Browser-use worker failed to start.");
    });

    child.on?.("close", (code, signal) => {
      session.child = null;
      session.workerExitCode = code ?? null;
      session.workerExitSignal = signal ?? null;
      session.updatedAt = new Date().toISOString();
      if (!isTerminalStatus(session.status)) {
        const stderr = truncateText(session.stderr, 500);
        const stdout = truncateText(session.stdout, 500);
        session.status = "failed";
        session.error =
          stderr ||
          stdout ||
          `Browser-use worker exited before completing the task${code == null ? "" : ` (code ${code})`}.`;
        session.completedAt = session.updatedAt;
      }
      void this.persist();
    });
  }

  async markFailed(session, error) {
    session.status = "failed";
    session.error = String(error || "Browser-use task failed.");
    session.completedAt = new Date().toISOString();
    session.updatedAt = session.completedAt;
    await this.persist();
  }

  async claimNextTask({ deviceId = "" } = {}) {
    const session = Array.from(this.sessions.values()).find(
      (entry) => entry.status === "queued" && (!deviceId || entry.deviceId === deviceId),
    );

    if (!session) {
      return null;
    }

    session.status = "running";
    session.startedAt = session.startedAt || new Date().toISOString();
    session.updatedAt = session.startedAt;
    await this.persist();

    return {
      id: session.id,
      type: "start_local_agent_goal",
      goal: session.taskPrompt,
      taskPrompt: session.taskPrompt,
      url: session.url || "",
      createdAt: session.createdAt,
      deviceId: session.deviceId,
    };
  }

  async recordSnapshot(taskId, payload = {}) {
    const session = this.sessions.get(taskId);
    if (!session) {
      return null;
    }

    session.latestSnapshot = {
      capturedAt: new Date().toISOString(),
      height: Number(payload.height) || null,
      imageBase64: String(payload.image_base64 || payload.imageBase64 || ""),
      tabs: Array.isArray(payload.tabs) ? payload.tabs : [],
      width: Number(payload.width) || null,
    };
    session.updatedAt = session.latestSnapshot.capturedAt;
    await this.persist();
    return this.serializeSession(session);
  }

  async recordActivity(taskId, payload = {}) {
    const session = this.sessions.get(taskId);
    if (!session) {
      return null;
    }

    const event = normalizeActivityEvent(payload);
    session.activity = [...(Array.isArray(session.activity) ? session.activity : []), event].slice(
      -ACTIVITY_EVENT_LIMIT,
    );
    session.updatedAt = event.createdAt;
    await this.persist();
    return this.serializeSession(session, { includeSnapshot: true });
  }

  async completeTask(taskId, payload = {}) {
    const session = this.sessions.get(taskId);
    if (!session) {
      return null;
    }

    const status = normalizeStatus(payload.status);
    session.status = status === "completed" ? "completed" : "failed";
    session.result = payload.result ?? null;
    session.error = payload.error || session.result?.error || null;
    session.usages = Array.isArray(payload.usages) ? payload.usages : [];
    session.transcript = compactTranscript(payload.messages);
    session.completedAt = new Date().toISOString();
    session.updatedAt = session.completedAt;
    session.activity = [
      ...(Array.isArray(session.activity) ? session.activity : []),
      normalizeActivityEvent({
        type: session.status === "completed" ? "task_completed" : "task_failed",
        payload: {
          status: session.status,
          error: session.error || "",
        },
        createdAt: session.completedAt,
      }),
    ].slice(-ACTIVITY_EVENT_LIMIT);
    await this.persist();
    return this.serializeSession(session, { includeSnapshot: true });
  }

  async deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    if (!isTerminalStatus(session.status)) {
      const now = new Date().toISOString();
      session.status = "canceled";
      session.error = session.error || "Browser-use task was terminated.";
      session.completedAt = session.completedAt || now;
      session.updatedAt = now;
    }

    const child = session.child;
    session.child = null;
    if (child) {
      try {
        child.kill?.("SIGTERM");
      } catch {
        // Best-effort: the session record is still removed below.
      }
    }

    const serialized = this.serializeSession(session, { includeSnapshot: true });
    this.sessions.delete(sessionId);
    await this.persist();
    return serialized;
  }

  getTaskMessages(taskId) {
    return this.sessions.get(taskId)?.messages || [];
  }

  async addTaskMessage(taskId, message) {
    const session = this.sessions.get(taskId);
    if (!session) {
      return null;
    }

    const entry = {
      id: randomUUID(),
      role: "user",
      message: String(message || "").trim(),
      createdAt: new Date().toISOString(),
    };
    if (!entry.message) {
      return null;
    }

    session.messages = [...(session.messages || []), entry];
    session.updatedAt = entry.createdAt;
    await this.persist();
    return entry;
  }

  async shutdown() {
    for (const session of this.sessions.values()) {
      if (session.child && !isTerminalStatus(session.status)) {
        session.child.kill?.("SIGTERM");
        session.child = null;
      }
    }
    await this.persist();
  }
}
