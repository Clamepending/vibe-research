import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STORE_FILENAME = "ottoauth-tasks.json";
const STORE_VERSION = 1;
const DEFAULT_BASE_URL = "https://ottoauth.vercel.app";
const DEFAULT_SKILL_URL = `${DEFAULT_BASE_URL}/skill.md`;
const TERMINAL_STATUSES = new Set(["canceled", "cancelled", "completed", "failed"]);

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

function normalizeBaseUrl(value) {
  const rawValue = String(value || "").trim().replace(/\/+$/, "");
  if (!rawValue) {
    return DEFAULT_BASE_URL;
  }

  try {
    const url = new URL(rawValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return DEFAULT_BASE_URL;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function normalizeStatus(value, fallback = "queued") {
  const status = String(value || "").trim().toLowerCase();
  if (!status) {
    return fallback;
  }

  if (status === "cancelled") {
    return "canceled";
  }

  return status.replace(/[^a-z0-9_-]+/g, "_");
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(normalizeStatus(status));
}

function taskStatusToSubagentStatus(status) {
  const normalized = normalizeStatus(status);
  if (normalized === "completed") {
    return "completed";
  }
  if (normalized === "failed" || normalized === "canceled") {
    return "failed";
  }
  return "working";
}

function normalizeCents(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }

  return Math.round(parsed);
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

function deriveTaskName({ serviceId, title, prompt, url, itemUrl }) {
  const explicitTitle = truncateText(title, 64);
  if (explicitTitle) {
    return explicitTitle;
  }

  if (serviceId === "amazon" && itemUrl) {
    return truncateText(itemUrl, 64) || "Amazon order";
  }

  const promptTitle = truncateText(prompt, 64)
    .split(" ")
    .filter(Boolean)
    .slice(0, 7)
    .join(" ");
  if (promptTitle) {
    return promptTitle;
  }

  return truncateText(url, 64) || "OttoAuth task";
}

function buildTaskPrompt({ prompt, task, taskPrompt, url }) {
  const explicitPrompt = String(prompt || taskPrompt || task || "").trim();
  const targetUrl = String(url || "").trim();

  if (explicitPrompt) {
    return explicitPrompt;
  }

  if (targetUrl) {
    return `Open ${targetUrl} and complete the requested OttoAuth task.`;
  }

  return "";
}

function compactValue(value, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return truncateText(value, 1200);
  }

  if (Array.isArray(value)) {
    if (depth >= 4) {
      return `[${value.length} items]`;
    }
    return value.slice(0, 30).map((entry) => compactValue(entry, depth + 1));
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (depth >= 4) {
    return "[object omitted]";
  }

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([key, entry]) => [key, /private[_-]?key|password|secret|token/i.test(key) ? "[redacted]" : compactValue(entry, depth + 1)]),
  );
}

async function writeJsonFile(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function safeJsonParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function getDefaultOttoAuthBaseUrl() {
  return DEFAULT_BASE_URL;
}

export function getDefaultOttoAuthSkillUrl() {
  return DEFAULT_SKILL_URL;
}

export class OttoAuthService {
  constructor({
    env = process.env,
    fetchImpl = globalThis.fetch,
    settings = {},
    stateDir,
  }) {
    this.env = env && typeof env === "object" ? { ...env } : { ...process.env };
    this.fetchImpl = fetchImpl;
    this.settings = settings || {};
    this.stateDir = stateDir;
    this.storePath = path.join(stateDir, STORE_FILENAME);
    this.tasks = new Map();
    this.requestToken = randomUUID();
  }

  async initialize() {
    let payload = null;
    try {
      payload = safeJsonParse(await readFile(this.storePath, "utf8"), null);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[vibe-research] failed to load OttoAuth tasks", error);
      }
    }

    const tasks = payload?.version === STORE_VERSION && Array.isArray(payload.tasks) ? payload.tasks : [];
    for (const task of tasks) {
      if (task?.id) {
        this.tasks.set(task.id, task);
      }
    }
    await this.persist();
  }

  setSettings(settings = {}) {
    this.settings = settings || {};
  }

  restart(settings = {}) {
    this.setSettings(settings);
  }

  isEnabled() {
    return normalizeBoolean(this.settings.ottoAuthEnabled, false);
  }

  getBaseUrl() {
    return normalizeBaseUrl(this.settings.ottoAuthBaseUrl || this.env.OTTOAUTH_BASE_URL || "");
  }

  getUsername() {
    return String(this.settings.ottoAuthUsername || this.env.OTTOAUTH_USERNAME || "").trim();
  }

  getPrivateKey() {
    return String(this.settings.ottoAuthPrivateKey || this.env.OTTOAUTH_PRIVATE_KEY || "").trim();
  }

  getCallbackUrl() {
    return String(this.settings.ottoAuthCallbackUrl || this.env.OTTOAUTH_CALLBACK_URL || "").trim();
  }

  getDefaultMaxChargeCents() {
    return normalizeCents(this.settings.ottoAuthDefaultMaxChargeCents);
  }

  getSkillUrl() {
    return `${this.getBaseUrl()}/skill.md`;
  }

  getStatus() {
    const tasks = Array.from(this.tasks.values());
    const activeCount = tasks.filter((task) => !isTerminalStatus(task.status)).length;
    const usernameConfigured = Boolean(this.getUsername());
    const privateKeyConfigured = Boolean(this.getPrivateKey());
    let reason = "";

    if (!this.isEnabled()) {
      reason = "OttoAuth building is disabled.";
    } else if (!usernameConfigured || !privateKeyConfigured) {
      reason = "OttoAuth username and private key are required.";
    }

    return {
      activeCount,
      baseUrl: this.getBaseUrl(),
      callbackUrl: this.getCallbackUrl(),
      command: "vr-ottoauth",
      defaultMaxChargeCents: this.getDefaultMaxChargeCents(),
      enabled: this.isEnabled(),
      privateKeyConfigured,
      reason,
      skillUrl: this.getSkillUrl(),
      tasksCount: tasks.length,
      username: this.getUsername(),
      usernameConfigured,
    };
  }

  serializeTask(task) {
    if (!task) {
      return null;
    }

    return {
      id: task.id,
      serviceId: task.serviceId,
      hostedTaskId: task.hostedTaskId,
      runId: task.runId || "",
      name: task.name,
      taskPrompt: task.taskPrompt || "",
      url: task.url || "",
      itemUrl: task.itemUrl || "",
      shippingAddress: task.shippingAddress || "",
      maxChargeCents: task.maxChargeCents ?? null,
      callerSessionId: task.callerSessionId || "",
      cwd: task.cwd || "",
      status: normalizeStatus(task.status),
      billingStatus: task.billingStatus || "",
      payoutStatus: task.payoutStatus || "",
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt || null,
      orderUrl: task.orderUrl || "",
      paymentUrl: task.paymentUrl || "",
      latestUrl: task.paymentUrl || task.orderUrl || task.url || task.itemUrl || "",
      humanCreditBalance: task.humanCreditBalance ?? null,
      result: task.result ?? null,
      error: task.error || null,
    };
  }

  listTasks() {
    return Array.from(this.tasks.values())
      .map((task) => this.serializeTask(task))
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  }

  getTask(taskId) {
    const id = String(taskId || "").trim();
    const task =
      this.tasks.get(id) ||
      Array.from(this.tasks.values()).find((entry) => String(entry.hostedTaskId || "") === id);
    return this.serializeTask(task);
  }

  listSubagentsForSession(parentSessionId) {
    const normalizedSessionId = String(parentSessionId || "").trim();
    if (!normalizedSessionId) {
      return [];
    }

    return Array.from(this.tasks.values())
      .filter((task) => task.callerSessionId === normalizedSessionId && !isTerminalStatus(task.status))
      .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")))
      .slice(0, 12)
      .map((task) => ({
        id: `ottoauth:${task.id}`,
        agentId: task.id.slice(0, 8),
        agentType: "OttoAuth",
        commands: ["vr-ottoauth"],
        description: task.taskPrompt || task.itemUrl || "OttoAuth task",
        latestUrl: task.paymentUrl || task.orderUrl || task.url || task.itemUrl || "",
        messageCount: null,
        name: task.name || "OttoAuth task",
        ottoAuthSessionId: task.id,
        ottoAuthTaskId: task.hostedTaskId,
        paths: [],
        source: "ottoauth",
        status: taskStatusToSubagentStatus(task.status),
        toolUseCount: null,
        updatedAt: task.updatedAt || task.createdAt,
      }));
  }

  async persist() {
    await writeJsonFile(this.storePath, {
      version: STORE_VERSION,
      savedAt: new Date().toISOString(),
      tasks: Array.from(this.tasks.values()),
    });
  }

  validateCreateRequest(token) {
    return Boolean(token && token === this.requestToken);
  }

  ensureCanRun() {
    if (!this.isEnabled()) {
      throw new Error("OttoAuth building is disabled.");
    }
    if (!this.getUsername()) {
      throw new Error("Add an OttoAuth username before starting a task.");
    }
    if (!this.getPrivateKey()) {
      throw new Error("Add an OttoAuth private key before starting a task.");
    }
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Fetch is not available for OttoAuth requests.");
    }
  }

  async fetchJson(url, options = {}) {
    const response = await this.fetchImpl(url, options);
    const text = await response.text();
    const payload = safeJsonParse(text, {});
    if (!response.ok) {
      throw new Error(payload.error || payload.message || `OttoAuth request failed (${response.status}).`);
    }
    return payload;
  }

  async createTask({
    callbackUrl = "",
    callerSessionId = "",
    cwd = "",
    itemUrl = "",
    maxChargeCents,
    prompt = "",
    service = "",
    serviceId = "",
    shippingAddress = "",
    task = "",
    taskPrompt = "",
    title = "",
    url = "",
  } = {}) {
    this.ensureCanRun();

    const normalizedServiceId = String(serviceId || service || "computeruse").trim().toLowerCase();
    if (normalizedServiceId === "amazon") {
      return this.createAmazonTask({
        callbackUrl,
        callerSessionId,
        cwd,
        itemUrl: itemUrl || url,
        shippingAddress,
        title,
      });
    }

    if (normalizedServiceId && normalizedServiceId !== "computeruse") {
      throw new Error(`Unsupported OttoAuth service: ${normalizedServiceId}.`);
    }

    return this.createComputerUseTask({
      callbackUrl,
      callerSessionId,
      cwd,
      maxChargeCents,
      prompt,
      shippingAddress,
      task,
      taskPrompt,
      title,
      url,
    });
  }

  async createComputerUseTask({
    callbackUrl = "",
    callerSessionId = "",
    cwd = "",
    maxChargeCents,
    prompt = "",
    shippingAddress = "",
    task = "",
    taskPrompt = "",
    title = "",
    url = "",
  } = {}) {
    const normalizedPrompt = buildTaskPrompt({ prompt, task, taskPrompt, url });
    if (!normalizedPrompt) {
      throw new Error("OttoAuth task prompt is required.");
    }

    const baseUrl = this.getBaseUrl();
    const maxCharge = normalizeCents(maxChargeCents) ?? this.getDefaultMaxChargeCents();
    const requestBody = {
      username: this.getUsername(),
      private_key: this.getPrivateKey(),
      task_prompt: normalizedPrompt,
    };
    if (title) {
      requestBody.task_title = String(title || "").trim();
    }
    if (url) {
      requestBody.website_url = String(url || "").trim();
    }
    if (shippingAddress) {
      requestBody.shipping_address = String(shippingAddress || "").trim();
    }
    if (maxCharge != null) {
      requestBody.max_charge_cents = maxCharge;
    }
    const normalizedCallbackUrl = String(callbackUrl || this.getCallbackUrl() || "").trim();
    if (normalizedCallbackUrl) {
      requestBody.callback_url = normalizedCallbackUrl;
    }

    const payload = await this.fetchJson(`${baseUrl}/api/services/computeruse/submit-task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const hostedTask = payload.task && typeof payload.task === "object" ? payload.task : payload;
    const hostedTaskId = String(hostedTask.id ?? payload.task_id ?? payload.taskId ?? "").trim();
    if (!hostedTaskId) {
      throw new Error("OttoAuth did not return a task id.");
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const record = {
      id,
      serviceId: "computeruse",
      hostedTaskId,
      runId: String(payload.run_id || hostedTask.run_id || ""),
      name: deriveTaskName({ serviceId: "computeruse", title, prompt: normalizedPrompt, url }),
      taskPrompt: normalizedPrompt,
      url: String(url || "").trim(),
      itemUrl: "",
      shippingAddress: String(shippingAddress || "").trim(),
      maxChargeCents: maxCharge,
      callerSessionId: String(callerSessionId || "").trim(),
      cwd: String(cwd || "").trim(),
      status: normalizeStatus(hostedTask.status || payload.status || "queued"),
      billingStatus: hostedTask.billing_status || "",
      payoutStatus: hostedTask.payout_status || "",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      orderUrl: `${baseUrl}/orders/${hostedTaskId}`,
      paymentUrl: "",
      humanCreditBalance: payload.human_credit_balance ?? null,
      result: compactValue(hostedTask),
      error: hostedTask.error || payload.error || null,
    };

    this.tasks.set(id, record);
    await this.persist();
    return this.serializeTask(record);
  }

  async createAmazonTask({
    callbackUrl = "",
    callerSessionId = "",
    cwd = "",
    itemUrl = "",
    shippingAddress = "",
    title = "",
  } = {}) {
    const normalizedItemUrl = String(itemUrl || "").trim();
    if (!normalizedItemUrl) {
      throw new Error("Amazon OttoAuth tasks require an item URL.");
    }

    const baseUrl = this.getBaseUrl();
    const payload = await this.fetchJson(`${baseUrl}/api/services/amazon/buy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.getUsername(),
        private_key: this.getPrivateKey(),
        item_url: normalizedItemUrl,
        shipping_address: String(shippingAddress || "").trim(),
      }),
    });
    const order = payload.order && typeof payload.order === "object" ? payload.order : payload;
    const hostedTaskId = String(order.id ?? order.order_id ?? order.orderId ?? "").trim();
    if (!hostedTaskId) {
      throw new Error("OttoAuth did not return an Amazon order id.");
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const record = {
      id,
      serviceId: "amazon",
      hostedTaskId,
      runId: "",
      name: deriveTaskName({ serviceId: "amazon", title, itemUrl: normalizedItemUrl }),
      taskPrompt: `Buy Amazon item: ${normalizedItemUrl}`,
      url: "",
      itemUrl: normalizedItemUrl,
      shippingAddress: String(shippingAddress || "").trim(),
      maxChargeCents: null,
      callerSessionId: String(callerSessionId || "").trim(),
      cwd: String(cwd || "").trim(),
      status: normalizeStatus(order.status || payload.status || "queued"),
      billingStatus: "",
      payoutStatus: "",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      orderUrl: `${baseUrl}/api/services/amazon/orders/${hostedTaskId}`,
      paymentUrl: String(order.payment_url || order.paymentUrl || ""),
      humanCreditBalance: null,
      result: compactValue(order),
      error: order.error || payload.error || null,
    };

    this.tasks.set(id, record);
    await this.persist();
    return this.serializeTask(record);
  }

  async refreshTask(taskId) {
    this.ensureCanRun();

    const id = String(taskId || "").trim();
    const task =
      this.tasks.get(id) ||
      Array.from(this.tasks.values()).find((entry) => String(entry.hostedTaskId || "") === id);
    if (!task) {
      return null;
    }

    if (isTerminalStatus(task.status)) {
      return this.serializeTask(task);
    }

    if (task.serviceId === "amazon") {
      return this.refreshAmazonTask(task);
    }

    return this.refreshComputerUseTask(task);
  }

  async refreshComputerUseTask(task) {
    const baseUrl = this.getBaseUrl();
    const payload = await this.fetchJson(`${baseUrl}/api/services/computeruse/tasks/${encodeURIComponent(task.hostedTaskId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.getUsername(),
        private_key: this.getPrivateKey(),
      }),
    });
    const hostedTask = payload.task && typeof payload.task === "object" ? payload.task : payload;
    const now = new Date().toISOString();
    task.status = normalizeStatus(hostedTask.status || payload.status || task.status);
    task.billingStatus = hostedTask.billing_status || task.billingStatus || "";
    task.payoutStatus = hostedTask.payout_status || task.payoutStatus || "";
    task.updatedAt = now;
    task.completedAt = isTerminalStatus(task.status) ? (task.completedAt || now) : null;
    task.result = compactValue(hostedTask);
    task.error = hostedTask.error || payload.error || task.error || null;
    task.orderUrl = hostedTask.order_url || task.orderUrl || `${baseUrl}/orders/${task.hostedTaskId}`;
    await this.persist();
    return this.serializeTask(task);
  }

  async refreshAmazonTask(task) {
    const baseUrl = this.getBaseUrl();
    const order = await this.fetchJson(`${baseUrl}/api/services/amazon/orders/${encodeURIComponent(task.hostedTaskId)}`);
    const now = new Date().toISOString();
    task.status = normalizeStatus(order.status || task.status);
    task.updatedAt = now;
    task.completedAt = isTerminalStatus(task.status) ? (task.completedAt || now) : null;
    task.paymentUrl = String(order.payment_url || order.paymentUrl || task.paymentUrl || "");
    task.result = compactValue(order);
    task.error = order.error || task.error || null;
    await this.persist();
    return this.serializeTask(task);
  }
}

export const testInternals = {
  isTerminalStatus,
  normalizeBaseUrl,
  normalizeCents,
  normalizeStatus,
  taskStatusToSubagentStatus,
};
