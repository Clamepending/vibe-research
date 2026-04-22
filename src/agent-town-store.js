import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const AGENT_TOWN_STATE_FILENAME = "agent-town-state.json";
const AGENT_TOWN_STATE_VERSION = 3;
const MAX_ACTION_ITEMS = 100;
const MAX_EVENTS = 200;
const MAX_CANVASES = 100;
const MAX_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const VALID_ACTION_ITEM_STATUSES = new Set(["open", "completed", "dismissed"]);
const VALID_ACTION_ITEM_KINDS = new Set(["action", "approval", "review", "setup"]);
const VALID_ACTION_ITEM_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const VALID_VISUAL_OBJECT_TYPES = new Set([
  "agent",
  "approval",
  "automation",
  "building",
  "file",
  "library_note",
  "local_app",
  "session",
  "settings",
  "task",
  "workspace",
]);
const EVENT_SIGNAL_FIELDS = {
  agent_clicked: "agentClickedCount",
  automation_created: "automationCreatedCount",
  library_note_saved: "libraryNoteSavedCount",
};
const SUPPORTED_PREDICATES = new Set([
  "agent_clicked",
  "automation_created",
  "building_placed",
  "cosmetic_building_placed",
  "first_building_placed",
  "functional_building_placed",
  "library_note_saved",
  "action_item_completed",
  "action_item_dismissed",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeId(value, fallbackPrefix) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return text || `${fallbackPrefix}-${randomUUID()}`;
}

function normalizeText(value, maxLength = 240) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeStringArray(value, maxItems = 50) {
  const source = Array.isArray(value) ? value : [];
  return Array.from(
    new Set(
      source
        .map((entry) => normalizeText(entry, 96))
        .filter(Boolean),
    ),
  ).slice(0, maxItems);
}

function normalizeSlug(value, maxLength = 96) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

function normalizeLayoutSummary(value = {}) {
  const functionalIds = normalizeStringArray(value.functionalIds);
  const pendingFunctionalIds = normalizeStringArray(value.pendingFunctionalIds);
  const cosmeticCount = Math.max(0, Math.floor(Number(value.cosmeticCount) || 0));
  const functionalCount = Math.max(0, Math.floor(Number(value.functionalCount) || functionalIds.length || 0));
  return {
    cosmeticCount,
    functionalCount,
    functionalIds,
    pendingFunctionalIds,
    themeId: normalizeText(value.themeId || "default", 48) || "default",
  };
}

function normalizeSignals(value = {}) {
  return {
    agentClickedCount: Math.max(0, Math.floor(Number(value.agentClickedCount) || 0)),
    automationCreatedCount: Math.max(0, Math.floor(Number(value.automationCreatedCount) || 0)),
    libraryNoteSavedCount: Math.max(0, Math.floor(Number(value.libraryNoteSavedCount) || 0)),
  };
}

function normalizePredicate(value) {
  const predicate = normalizeText(value, 96).toLowerCase();
  return SUPPORTED_PREDICATES.has(predicate) ? predicate : "";
}

function normalizePredicateParams(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return {
    actionItemId: normalizeSlug(value.actionItemId || value.id, 96),
    pluginId: normalizeSlug(value.pluginId, 96),
    minCount: Math.max(1, Math.floor(Number(value.minCount) || 1)),
  };
}

function normalizeActionItemKind(value, fallback = "action") {
  const kind = normalizeSlug(value, 32);
  if (VALID_ACTION_ITEM_KINDS.has(kind)) {
    return kind;
  }
  return VALID_ACTION_ITEM_KINDS.has(fallback) ? fallback : "action";
}

function normalizeActionItemPriority(value, fallback = "normal") {
  const priority = normalizeSlug(value, 32);
  if (VALID_ACTION_ITEM_PRIORITIES.has(priority)) {
    return priority;
  }
  return VALID_ACTION_ITEM_PRIORITIES.has(fallback) ? fallback : "normal";
}

function normalizeVisualObjectType(value, fallback = "") {
  const objectType = normalizeSlug(value, 48).replaceAll("-", "_");
  if (VALID_VISUAL_OBJECT_TYPES.has(objectType)) {
    return objectType;
  }
  return VALID_VISUAL_OBJECT_TYPES.has(fallback) ? fallback : "";
}

function normalizeCapabilityIds(value) {
  const source = Array.isArray(value) ? value : [];
  return Array.from(
    new Set(
      source
        .map((entry) => normalizeSlug(entry, 64).replaceAll("_", "-"))
        .filter(Boolean),
    ),
  ).slice(0, 24);
}

function normalizeActionTarget(value = {}, fallback = null) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const fallbackSource = fallback && typeof fallback === "object" && !Array.isArray(fallback) ? fallback : {};
  const type = normalizeVisualObjectType(source.type || source.kind, normalizeVisualObjectType(fallbackSource.type || fallbackSource.kind));
  const id = normalizeText(source.id || source.sessionId || source.pluginId || fallbackSource.id || fallbackSource.sessionId || fallbackSource.pluginId, 96);
  const label = normalizeText(source.label || source.title || fallbackSource.label || fallbackSource.title, 120);
  const href = normalizeText(source.href || fallbackSource.href, 240);

  if (!type && !id && !label && !href) {
    return null;
  }

  return {
    type: type || "task",
    id,
    label,
    href,
  };
}

function normalizeActionItem(value = {}, fallback = {}) {
  const existingStatus = VALID_ACTION_ITEM_STATUSES.has(fallback.status) ? fallback.status : "open";
  const requestedStatus = normalizeText(value.status, 32).toLowerCase();
  const status = VALID_ACTION_ITEM_STATUSES.has(requestedStatus) ? requestedStatus : existingStatus;
  const fallbackKind = normalizeActionItemKind(fallback.kind || fallback.type);
  const fallbackPriority = normalizeActionItemPriority(fallback.priority);
  const createdAt = normalizeText(fallback.createdAt || value.createdAt, 64) || nowIso();
  const updatedAt = normalizeText(value.updatedAt, 64) || nowIso();
  const completedAt =
    status === "completed"
      ? normalizeText(value.completedAt || fallback.completedAt, 64) || updatedAt
      : normalizeText(value.completedAt || fallback.completedAt, 64);
  const dismissedAt =
    status === "dismissed"
      ? normalizeText(value.dismissedAt || fallback.dismissedAt, 64) || updatedAt
      : normalizeText(value.dismissedAt || fallback.dismissedAt, 64);

  return {
    id: normalizeId(value.id || fallback.id, "action"),
    kind: normalizeActionItemKind(value.kind || value.type, fallbackKind),
    priority: normalizeActionItemPriority(value.priority, fallbackPriority),
    title: normalizeText(value.title || fallback.title || "Action item", 120) || "Action item",
    detail: normalizeText(value.detail || fallback.detail, 600),
    href: normalizeText(value.href || fallback.href, 240),
    cta: normalizeText(value.cta || fallback.cta || "Open", 80) || "Open",
    source: normalizeText(value.source || fallback.source || "agent", 80) || "agent",
    sourceAgentId: normalizeText(value.sourceAgentId || fallback.sourceAgentId, 96),
    sourceSessionId: normalizeText(value.sourceSessionId || value.sessionId || fallback.sourceSessionId || fallback.sessionId, 96),
    target: normalizeActionTarget(value.target, fallback.target),
    capabilityIds: normalizeCapabilityIds(value.capabilityIds || value.capabilities || fallback.capabilityIds || fallback.capabilities),
    predicate: normalizePredicate(value.predicate || fallback.predicate),
    predicateParams: normalizePredicateParams(value.predicateParams || fallback.predicateParams),
    status,
    createdAt,
    updatedAt,
    completedAt,
    dismissedAt,
  };
}

function normalizeEvent(value = {}) {
  const type = normalizeText(value.type || value.eventType, 80).toLowerCase();
  if (!type) {
    return null;
  }

  return {
    id: normalizeId(value.id, "event"),
    type,
    label: normalizeText(value.label, 160),
    detail: normalizeText(value.detail, 600),
    metadata: value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? clone(value.metadata)
      : {},
    createdAt: normalizeText(value.createdAt, 64) || nowIso(),
  };
}

function pickField(source, keys) {
  const entry = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  for (const key of keys) {
    if (Object.hasOwn(entry, key)) {
      return entry[key];
    }
  }
  return undefined;
}

function pickCanvasField(value, keys, fallback = {}, defaultValue = "") {
  const directValue = pickField(value, keys);
  if (directValue !== undefined) {
    return directValue;
  }

  const fallbackValue = pickField(fallback, keys);
  return fallbackValue === undefined ? defaultValue : fallbackValue;
}

function normalizeCanvas(value = {}, fallback = {}) {
  const sourceSessionId = normalizeText(
    pickCanvasField(value, ["sourceSessionId", "sessionId"], fallback),
    96,
  );
  const sourceAgentId = normalizeText(pickCanvasField(value, ["sourceAgentId", "agentId"], fallback), 96);
  const id = normalizeId(pickCanvasField(value, ["id", "canvasId"], fallback) || sourceSessionId || sourceAgentId, "canvas");
  const title = normalizeText(pickCanvasField(value, ["title"], fallback, "Agent canvas"), 120) || "Agent canvas";
  const createdAt = normalizeText(pickCanvasField(fallback, ["createdAt"], value), 64) || nowIso();

  return {
    id,
    sourceSessionId,
    sourceAgentId,
    title,
    caption: normalizeText(pickCanvasField(value, ["caption", "detail"], fallback), 1_000),
    alt: normalizeText(pickCanvasField(value, ["alt"], fallback, title), 200) || title,
    imagePath: normalizeText(pickCanvasField(value, ["imagePath", "path"], fallback), 1_000),
    imageUrl: normalizeText(pickCanvasField(value, ["imageUrl", "url"], fallback), 2_000),
    href: normalizeText(pickCanvasField(value, ["href"], fallback), 2_000),
    createdAt,
    updatedAt: normalizeText(pickCanvasField(value, ["updatedAt"]), 64) || nowIso(),
  };
}

function normalizeCanvases(value) {
  return Array.isArray(value)
    ? value.map((entry) => normalizeCanvas(entry)).slice(0, MAX_CANVASES)
    : [];
}

function normalizeState(value = {}) {
  const actionItems = Array.isArray(value.actionItems)
    ? value.actionItems.map((item) => normalizeActionItem(item)).slice(0, MAX_ACTION_ITEMS)
    : [];
  const events = Array.isArray(value.events)
    ? value.events.map(normalizeEvent).filter(Boolean).slice(0, MAX_EVENTS)
    : [];

  return {
    version: AGENT_TOWN_STATE_VERSION,
    updatedAt: normalizeText(value.updatedAt, 64) || nowIso(),
    layoutSummary: normalizeLayoutSummary(value.layoutSummary),
    signals: normalizeSignals(value.signals),
    canvases: normalizeCanvases(value.canvases),
    actionItems,
    events,
  };
}

function getPredicateCount(state, predicate) {
  if (predicate === "agent_clicked") {
    return state.signals.agentClickedCount;
  }
  if (predicate === "automation_created") {
    return state.signals.automationCreatedCount;
  }
  if (predicate === "library_note_saved") {
    return state.signals.libraryNoteSavedCount;
  }
  return 0;
}

export class AgentTownStore {
  constructor({ stateDir }) {
    this.stateDir = stateDir;
    this.filePath = path.join(stateDir, AGENT_TOWN_STATE_FILENAME);
    this.state = normalizeState();
    this.waiters = new Set();
    this.writePromise = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.stateDir, { recursive: true });

    try {
      const text = await readFile(this.filePath, "utf8");
      this.state = normalizeState(JSON.parse(text));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[vibe-research] agent town state load failed:", error);
      }
      this.state = normalizeState();
      await this.persist();
    }
  }

  getState() {
    return clone(this.state);
  }

  getCanvas(canvasId) {
    const id = normalizeId(canvasId, "canvas");
    const canvas = this.state.canvases.find((entry) => entry.id === id);
    return canvas ? clone(canvas) : null;
  }

  evaluatePredicate(predicateInput, paramsInput = {}) {
    const predicate = normalizePredicate(predicateInput);
    const params = normalizePredicateParams(paramsInput);
    const { layoutSummary, actionItems } = this.state;
    const minCount = params.minCount || 1;

    if (!predicate) {
      return false;
    }

    if (predicate === "first_building_placed" || predicate === "building_placed") {
      return layoutSummary.cosmeticCount + layoutSummary.functionalCount >= minCount;
    }

    if (predicate === "cosmetic_building_placed") {
      return layoutSummary.cosmeticCount >= minCount;
    }

    if (predicate === "functional_building_placed") {
      if (params.pluginId) {
        return layoutSummary.functionalIds.includes(params.pluginId);
      }
      return layoutSummary.functionalCount >= minCount;
    }

    if (predicate === "action_item_completed" || predicate === "action_item_dismissed") {
      const targetStatus = predicate === "action_item_completed" ? "completed" : "dismissed";
      return actionItems.some((item) => (
        item.status === targetStatus &&
        (!params.actionItemId || item.id === params.actionItemId)
      ));
    }

    return getPredicateCount(this.state, predicate) >= minCount;
  }

  async updateMirror(payload = {}) {
    const nextLayoutSummary = payload.layoutSummary || payload.agentTown?.layoutSummary;
    const nextSignals = payload.signals || payload.agentTown?.signals;
    const nextCanvases = payload.canvases || payload.agentTown?.canvases;

    if (nextLayoutSummary && typeof nextLayoutSummary === "object") {
      this.state.layoutSummary = normalizeLayoutSummary(nextLayoutSummary);
    }

    if (nextSignals && typeof nextSignals === "object") {
      this.state.signals = normalizeSignals({
        ...this.state.signals,
        ...nextSignals,
      });
    }

    if (Array.isArray(nextCanvases)) {
      this.state.canvases = normalizeCanvases(nextCanvases);
    }

    await this.afterStateChange();
    return this.getState();
  }

  async recordEvent(input = {}) {
    const event = normalizeEvent(input);
    if (!event) {
      throw new Error("Agent Town event type is required.");
    }

    const signalField = EVENT_SIGNAL_FIELDS[event.type];
    if (signalField) {
      this.state.signals[signalField] = (this.state.signals[signalField] || 0) + 1;
    }

    this.state.events = [event, ...this.state.events].slice(0, MAX_EVENTS);
    await this.afterStateChange();
    return { event, state: this.getState() };
  }

  async createActionItem(input = {}) {
    const item = normalizeActionItem(input, {});
    const existingIndex = this.state.actionItems.findIndex((entry) => entry.id === item.id);
    const existing = existingIndex >= 0 ? this.state.actionItems[existingIndex] : null;
    const nextItem = normalizeActionItem(
      {
        ...existing,
        ...input,
        id: item.id,
        status: input.status || existing?.status || "open",
      },
      existing || {},
    );

    if (existingIndex >= 0) {
      this.state.actionItems.splice(existingIndex, 1);
    }
    this.state.actionItems = [nextItem, ...this.state.actionItems].slice(0, MAX_ACTION_ITEMS);
    await this.afterStateChange();
    return { actionItem: this.state.actionItems.find((entry) => entry.id === nextItem.id), state: this.getState() };
  }

  async updateActionItem(actionItemId, input = {}) {
    const id = normalizeId(actionItemId, "action");
    const existingIndex = this.state.actionItems.findIndex((entry) => entry.id === id);
    if (existingIndex < 0) {
      const error = new Error("Action item not found.");
      error.statusCode = 404;
      throw error;
    }

    const existing = this.state.actionItems[existingIndex];
    const nextItem = normalizeActionItem({ ...existing, ...input, id }, existing);
    this.state.actionItems[existingIndex] = nextItem;
    await this.afterStateChange();
    return {
      actionItem: this.state.actionItems.find((entry) => entry.id === id) || nextItem,
      state: this.getState(),
    };
  }

  async upsertCanvas(input = {}) {
    const canvas = normalizeCanvas(input, {});
    const existingIndex = this.state.canvases.findIndex((entry) => entry.id === canvas.id);
    const existing = existingIndex >= 0 ? this.state.canvases[existingIndex] : null;
    const nextCanvas = normalizeCanvas(
      {
        ...existing,
        ...input,
        id: canvas.id,
        updatedAt: input.updatedAt || nowIso(),
      },
      existing || {},
    );

    if (existingIndex >= 0) {
      this.state.canvases.splice(existingIndex, 1);
    }
    this.state.canvases = [nextCanvas, ...this.state.canvases].slice(0, MAX_CANVASES);
    await this.afterStateChange();
    return { canvas: this.state.canvases.find((entry) => entry.id === nextCanvas.id), state: this.getState() };
  }

  async deleteCanvas(canvasId) {
    const id = normalizeId(canvasId, "canvas");
    const existingIndex = this.state.canvases.findIndex((entry) => entry.id === id);
    if (existingIndex < 0) {
      const error = new Error("Agent canvas not found.");
      error.statusCode = 404;
      throw error;
    }

    const [canvas] = this.state.canvases.splice(existingIndex, 1);
    await this.afterStateChange();
    return { canvas, state: this.getState() };
  }

  async waitForPredicate(input = {}) {
    const predicate = normalizePredicate(input.predicate);
    if (!predicate) {
      const error = new Error("Unsupported Agent Town predicate.");
      error.statusCode = 400;
      throw error;
    }

    const params = normalizePredicateParams(input.predicateParams || input.params);
    if (this.evaluatePredicate(predicate, params)) {
      return {
        predicate,
        predicateParams: params,
        satisfied: true,
        state: this.getState(),
      };
    }

    const timeoutMs = Math.max(
      0,
      Math.min(MAX_WAIT_TIMEOUT_MS, Math.floor(Number(input.timeoutMs) || DEFAULT_WAIT_TIMEOUT_MS)),
    );

    return new Promise((resolve) => {
      const waiter = {
        predicate,
        params,
        resolve,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve({
          predicate,
          predicateParams: params,
          satisfied: false,
          state: this.getState(),
        });
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  completeSatisfiedActionItems() {
    let changed = false;
    const updatedAt = nowIso();
    this.state.actionItems = this.state.actionItems.map((item) => {
      if (item.status !== "open" || !item.predicate || !this.evaluatePredicate(item.predicate, item.predicateParams)) {
        return item;
      }

      changed = true;
      return {
        ...item,
        status: "completed",
        updatedAt,
        completedAt: updatedAt,
      };
    });
    return changed;
  }

  notifyWaiters() {
    for (const waiter of Array.from(this.waiters)) {
      if (!this.evaluatePredicate(waiter.predicate, waiter.params)) {
        continue;
      }

      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve({
        predicate: waiter.predicate,
        predicateParams: waiter.params,
        satisfied: true,
        state: this.getState(),
      });
    }
  }

  async afterStateChange() {
    this.completeSatisfiedActionItems();
    this.state.updatedAt = nowIso();
    await this.persist();
    this.notifyWaiters();
  }

  async persist() {
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writePromise = this.writePromise.catch(() => {}).then(async () => {
      await mkdir(this.stateDir, { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, payload, "utf8");
      await rename(tempPath, this.filePath);
    });
    await this.writePromise;
  }
}
