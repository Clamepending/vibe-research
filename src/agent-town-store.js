import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const AGENT_TOWN_STATE_FILENAME = "agent-town-state.json";
const AGENT_TOWN_STATE_VERSION = 6;
const MAX_ACTION_ITEMS = 100;
const MAX_EVENTS = 200;
const MAX_CANVASES = 100;
const MAX_LAYOUT_HISTORY = 60;
const MAX_LAYOUT_SNAPSHOTS = 30;
const MAX_TOWN_SHARES = 60;
const MAX_LAYOUT_DECORATIONS = 180;
const MAX_LAYOUT_ENTRIES = 120;
const MAX_ALERTS = 12;
const MAX_PLUGIN_CONFIG_BYTES = 16 * 1024;
const MAX_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const MIN_HIGHLIGHT_DURATION_MS = 500;
const MAX_HIGHLIGHT_DURATION_MS = 120_000;
const DEFAULT_HIGHLIGHT_DURATION_MS = 8_000;
const DEFAULT_AGENT_TOWN_THEME_ID = "default";
const DEFAULT_AGENT_TOWN_DOG_NAME = "Dog";
const VALID_ACTION_ITEM_STATUSES = new Set(["open", "completed", "dismissed"]);
const VALID_ACTION_ITEM_KINDS = new Set(["action", "approval", "review", "setup"]);
const VALID_ACTION_ITEM_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const VALID_ACTION_ITEM_RESOLUTIONS = new Set([
  "",
  "approved",
  "completed",
  "dismissed",
  "paused",
  "rejected",
  "resumed",
  "steered",
  "timeout",
]);
const VALID_ACTION_ITEM_CHOICES = new Set([
  "approve",
  "complete",
  "dismiss",
  "open",
  "pause",
  "reject",
  "resume",
  "steer",
]);
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
  workspace_selected: "workspaceSelectedCount",
  onboarding_complete: "onboardingCompletedCount",
  onboarding_completed: "onboardingCompletedCount",
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
  "action_item_resolved",
  "action_item_approved",
  "action_item_rejected",
  "action_item_steered",
  "action_item_paused",
  "action_item_resumed",
  "onboarding_complete",
  "workspace_selected",
]);

const VALID_HIGHLIGHT_TARGET_TYPES = new Set([
  "building",
  "cosmetic",
  "decoration",
  "place",
  "road",
  "tile",
  "agent",
  "workspace",
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
    themeId: normalizeText(value.themeId || DEFAULT_AGENT_TOWN_THEME_ID, 48) || DEFAULT_AGENT_TOWN_THEME_ID,
  };
}

function normalizeLayoutOffset(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
  };
}

function normalizeLayoutOffsetMap(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([id, offset]) => [normalizeSlug(id, 96), normalizeLayoutOffset(offset)])
      .filter(([id, offset]) => id && offset)
      .slice(0, MAX_LAYOUT_ENTRIES),
  );
}

function normalizeRotation(value) {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(Math.round(number)) % 2 === 1 ? 1 : 0;
}

function normalizeDecoration(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const itemId = normalizeSlug(value.itemId || value.kind || value.id, 96);
  const x = Number(value.x);
  const y = Number(value.y);
  if (!itemId || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const rotation = normalizeRotation(value.rotation ?? value.rotated);
  const decoration = {
    id: normalizeId(value.id, "decor"),
    itemId,
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
  };
  if (rotation) {
    decoration.rotation = rotation;
  }
  return decoration;
}

function normalizeDecorations(value = []) {
  return Array.isArray(value)
    ? value.map(normalizeDecoration).filter(Boolean).slice(0, MAX_LAYOUT_DECORATIONS)
    : [];
}

function normalizePluginConfig(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  let cloned;
  try {
    cloned = JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
    return null;
  }
  const serialized = JSON.stringify(cloned);
  if (serialized === "{}") {
    return null;
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PLUGIN_CONFIG_BYTES) {
    return null;
  }
  return cloned;
}

function normalizeFunctionalPlacement(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const rotation = normalizeRotation(value.rotation ?? value.rotated);
  const placement = {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
  };
  if (rotation) {
    placement.rotation = rotation;
  }
  const config = normalizePluginConfig(value.config);
  if (config) {
    placement.config = config;
  }
  return placement;
}

function normalizeFunctionalPlacements(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([id, placement]) => [normalizeSlug(id, 96), normalizeFunctionalPlacement(placement)])
      .filter(([id, placement]) => id && placement)
      .slice(0, MAX_LAYOUT_ENTRIES),
  );
}

function normalizeLayout(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const themeId = normalizeSlug(source.themeId || source.theme || DEFAULT_AGENT_TOWN_THEME_ID, 48) || DEFAULT_AGENT_TOWN_THEME_ID;
  const dogName = normalizeText(source.dogName || source.companionName || DEFAULT_AGENT_TOWN_DOG_NAME, 24) || DEFAULT_AGENT_TOWN_DOG_NAME;
  return {
    places: normalizeLayoutOffsetMap(source.places),
    roads: normalizeLayoutOffsetMap(source.roads),
    decorations: normalizeDecorations(source.decorations),
    functional: normalizeFunctionalPlacements(source.functional),
    pendingFunctional: normalizeStringArray(source.pendingFunctional, MAX_LAYOUT_ENTRIES),
    themeId,
    dogName,
  };
}

function getLayoutSummary(layoutInput = {}) {
  const layout = normalizeLayout(layoutInput);
  const functionalIds = Object.keys(layout.functional).sort();
  return {
    cosmeticCount: layout.decorations.length,
    functionalCount: functionalIds.length,
    functionalIds,
    pendingFunctionalIds: [...layout.pendingFunctional].sort(),
    themeId: layout.themeId,
  };
}

function layoutsEqual(left, right) {
  return JSON.stringify(normalizeLayout(left)) === JSON.stringify(normalizeLayout(right));
}

function normalizeLayoutHistory(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    past: Array.isArray(source.past) ? source.past.map(normalizeLayout).slice(-MAX_LAYOUT_HISTORY) : [],
    future: Array.isArray(source.future) ? source.future.map(normalizeLayout).slice(0, MAX_LAYOUT_HISTORY) : [],
  };
}

function normalizeLayoutSnapshot(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const layout = normalizeLayout(value.layout || value);
  const id = normalizeId(value.id || value.name, "snapshot");
  const now = nowIso();
  return {
    id,
    name: normalizeText(value.name || "Town snapshot", 80) || "Town snapshot",
    layout,
    createdAt: normalizeText(value.createdAt, 64) || now,
    updatedAt: normalizeText(value.updatedAt, 64) || now,
  };
}

function normalizeLayoutSnapshots(value = []) {
  const seen = new Set();
  const snapshots = [];
  for (const snapshot of Array.isArray(value) ? value : []) {
    const normalized = normalizeLayoutSnapshot(snapshot);
    if (!normalized || seen.has(normalized.id)) {
      continue;
    }
    seen.add(normalized.id);
    snapshots.push(normalized);
  }
  return snapshots.slice(0, MAX_LAYOUT_SNAPSHOTS);
}

function normalizeTownShareVisibility(value) {
  return normalizeSlug(value, 32) === "unlisted" ? "unlisted" : "listed";
}

function normalizeTownShareBuildingHub(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const layoutId = normalizeSlug(value.layoutId || value.id, 96).replaceAll("_", "-");
  const layoutUrl = normalizeText(value.layoutUrl || value.url || value.homepageUrl, 2_000);
  const repositoryUrl = normalizeText(value.repositoryUrl || value.repoUrl, 2_000);
  const previewUrl = normalizeText(value.previewUrl || value.imageUrl, 2_000);
  const commit = normalizeText(value.commit || value.commitSha, 120);
  if (!layoutId && !layoutUrl && !repositoryUrl && !commit) {
    return null;
  }

  const publisher = normalizeTownShareBuildingHubPublisher(value.publisher);

  return {
    layoutId,
    layoutUrl,
    repositoryUrl,
    previewUrl,
    commit,
    commitUrl: normalizeText(value.commitUrl, 2_000),
    branch: normalizeText(value.branch, 160),
    ...(publisher ? { publisher } : {}),
    pushed: Boolean(value.pushed),
    publishedAt: normalizeText(value.publishedAt, 64) || nowIso(),
    status: normalizeText(value.status || "published", 48) || "published",
  };
}

function normalizeTownShareBuildingHubPublisher(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const provider = normalizeText(value.provider, 40).toLowerCase();
  const id = normalizeText(value.id, 120);
  const login = normalizeText(value.login || value.username, 120);
  const name = normalizeText(value.name || value.displayName, 160);
  const profileUrl = normalizeText(value.profileUrl || value.url || value.htmlUrl, 2_000);
  const avatarUrl = normalizeText(value.avatarUrl || value.avatar_url, 2_000);

  if (!provider && !id && !login && !name && !profileUrl) {
    return null;
  }

  return {
    provider,
    id,
    login,
    name,
    profileUrl,
    avatarUrl,
  };
}

function normalizeTownShare(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const layout = normalizeLayout(value.layout || value);
  const summary = normalizeLayoutSummary({
    ...getLayoutSummary(layout),
    ...(value.layoutSummary || value.summary || {}),
  });
  const id = normalizeId(value.id || value.shareId, "town");
  const now = nowIso();
  const imageByteLength = Math.max(0, Math.floor(Number(value.imageByteLength) || 0));
  return {
    id,
    name: normalizeText(value.name || value.title || "Agent Town", 80) || "Agent Town",
    description: normalizeText(value.description || value.caption || "A shared Agent Town base layout.", 280),
    layout,
    layoutSummary: summary,
    visibility: normalizeTownShareVisibility(value.visibility),
    imagePath: normalizeText(value.imagePath || value.thumbnailPath, 1_000),
    imageMimeType: normalizeText(value.imageMimeType || value.thumbnailMimeType, 96),
    imageByteLength,
    imageUpdatedAt: normalizeText(value.imageUpdatedAt || value.thumbnailUpdatedAt, 64),
    buildingHub: normalizeTownShareBuildingHub(value.buildingHub || value.buildinghub),
    createdAt: normalizeText(value.createdAt, 64) || now,
    updatedAt: normalizeText(value.updatedAt, 64) || now,
  };
}

function normalizeTownShares(value = []) {
  const seen = new Set();
  const shares = [];
  for (const share of Array.isArray(value) ? value : []) {
    const normalized = normalizeTownShare(share);
    if (!normalized || seen.has(normalized.id)) {
      continue;
    }
    seen.add(normalized.id);
    shares.push(normalized);
  }
  return shares.slice(0, MAX_TOWN_SHARES);
}

function validateLayout(layoutInput = {}) {
  const issues = [];
  const warnings = [];
  const layout = normalizeLayout(layoutInput);
  const decorationIds = new Set();

  for (const [id, offset] of Object.entries(layout.places)) {
    if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) {
      issues.push(`place ${id} has an invalid offset`);
    }
  }

  for (const [id, offset] of Object.entries(layout.roads)) {
    if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) {
      issues.push(`road ${id} has an invalid offset`);
    }
  }

  for (const decoration of layout.decorations) {
    if (decorationIds.has(decoration.id)) {
      issues.push(`duplicate decoration id ${decoration.id}`);
    }
    decorationIds.add(decoration.id);
    if (!decoration.itemId) {
      issues.push(`decoration ${decoration.id} is missing an item id`);
    }
    if (decoration.x < 0 || decoration.y < 0) {
      issues.push(`decoration ${decoration.id} is outside the town bounds`);
    }
  }

  for (const [pluginId, placement] of Object.entries(layout.functional)) {
    if (!pluginId) {
      issues.push("functional building is missing an id");
    }
    if (placement.x < 0 || placement.y < 0) {
      issues.push(`functional building ${pluginId} is outside the town bounds`);
    }
  }

  const functionalIds = new Set(Object.keys(layout.functional));
  for (const pendingId of layout.pendingFunctional) {
    if (functionalIds.has(pendingId)) {
      warnings.push(`${pendingId} is marked pending and placed`);
    }
  }

  if (layout.decorations.length >= MAX_LAYOUT_DECORATIONS) {
    warnings.push("town has reached the cosmetic placement limit");
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    layout,
    summary: getLayoutSummary(layout),
  };
}

function normalizeSignals(value = {}) {
  return {
    agentClickedCount: Math.max(0, Math.floor(Number(value.agentClickedCount) || 0)),
    automationCreatedCount: Math.max(0, Math.floor(Number(value.automationCreatedCount) || 0)),
    libraryNoteSavedCount: Math.max(0, Math.floor(Number(value.libraryNoteSavedCount) || 0)),
    workspaceSelectedCount: Math.max(0, Math.floor(Number(value.workspaceSelectedCount) || 0)),
    onboardingCompletedCount: Math.max(0, Math.floor(Number(value.onboardingCompletedCount) || 0)),
  };
}

function normalizeHighlightTargetType(value, fallback = "building") {
  const type = normalizeSlug(value, 32);
  if (VALID_HIGHLIGHT_TARGET_TYPES.has(type)) {
    return type;
  }
  return VALID_HIGHLIGHT_TARGET_TYPES.has(fallback) ? fallback : "building";
}

function normalizeHighlight(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const buildingId = normalizeSlug(value.buildingId || value.pluginId || value.id, 96);
  const itemId = normalizeSlug(value.itemId, 96);
  const coordSource = value.coordinates && typeof value.coordinates === "object" ? value.coordinates : value;
  const rawX = Number(coordSource.x);
  const rawY = Number(coordSource.y);
  const hasCoordinates = Number.isFinite(rawX) && Number.isFinite(rawY);

  if (!buildingId && !itemId && !hasCoordinates) {
    return null;
  }

  const now = Date.now();
  const requestedDuration = Math.floor(Number(value.durationMs));
  const durationMs = Number.isFinite(requestedDuration) && requestedDuration > 0
    ? Math.min(MAX_HIGHLIGHT_DURATION_MS, Math.max(MIN_HIGHLIGHT_DURATION_MS, requestedDuration))
    : DEFAULT_HIGHLIGHT_DURATION_MS;
  const createdAtText = normalizeText(value.createdAt, 64);
  const createdAtMs = Number.isFinite(Date.parse(createdAtText)) ? Date.parse(createdAtText) : now;
  const expiresAtText = normalizeText(value.expiresAt, 64);
  const expiresAtMs = Number.isFinite(Date.parse(expiresAtText))
    ? Date.parse(expiresAtText)
    : createdAtMs + durationMs;

  const highlight = {
    id: normalizeId(value.id || value.highlightId, "highlight"),
    targetType: normalizeHighlightTargetType(value.targetType || value.type, buildingId ? "building" : itemId ? "cosmetic" : "tile"),
    buildingId,
    itemId,
    coordinates: hasCoordinates
      ? { x: Math.round(rawX), y: Math.round(rawY) }
      : null,
    reason: normalizeText(value.reason || value.label, 200),
    sourceSessionId: normalizeText(value.sourceSessionId || value.sessionId, 96),
    sourceAgentId: normalizeText(value.sourceAgentId || value.agentId, 96),
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    durationMs,
  };

  return highlight;
}

function isHighlightActive(highlight, referenceTime = Date.now()) {
  if (!highlight) {
    return false;
  }
  const expires = Date.parse(highlight.expiresAt);
  return Number.isFinite(expires) && expires > referenceTime;
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
    itemId: normalizeSlug(value.itemId, 96),
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

function normalizeActionItemResolution(value, fallback = "") {
  const resolution = normalizeSlug(value, 32);
  if (VALID_ACTION_ITEM_RESOLUTIONS.has(resolution)) {
    return resolution;
  }
  return VALID_ACTION_ITEM_RESOLUTIONS.has(fallback) ? fallback : "";
}

function normalizeActionItemChoices(value, fallback = []) {
  const source = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : [];
  return Array.from(
    new Set(
      source
        .flatMap((entry) => String(entry || "").split(","))
        .map((entry) => normalizeSlug(entry, 32))
        .filter((entry) => VALID_ACTION_ITEM_CHOICES.has(entry)),
    ),
  ).slice(0, 8);
}

function normalizeActionItemEvidence(value, fallback = []) {
  const source = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : [];
  return source
    .map((entry) => {
      if (typeof entry === "string") {
        const text = normalizeText(entry, 300);
        if (!text) return null;
        return { label: text, href: "", path: "", kind: "reference" };
      }

      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }

      const href = normalizeText(entry.href || entry.url, 500);
      const evidencePath = normalizeText(entry.path || entry.filePath, 500);
      const label = normalizeText(
        entry.label || entry.title || href || evidencePath || entry.kind || "evidence",
        160,
      );
      if (!label && !href && !evidencePath) {
        return null;
      }

      return {
        label: label || "evidence",
        href,
        path: evidencePath,
        kind: normalizeSlug(entry.kind || entry.type || "reference", 48) || "reference",
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeActionTarget(value = {}, fallback = null) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const fallbackSource = fallback && typeof fallback === "object" && !Array.isArray(fallback) ? fallback : {};
  const type = normalizeVisualObjectType(source.type || source.kind, normalizeVisualObjectType(fallbackSource.type || fallbackSource.kind));
  const id = normalizeText(source.id || source.sessionId || source.pluginId || fallbackSource.id || fallbackSource.sessionId || fallbackSource.pluginId, 96);
  const label = normalizeText(source.label || source.title || fallbackSource.label || fallbackSource.title, 120);
  const href = normalizeText(source.href || fallbackSource.href, 240);
  const projectName = normalizeText(source.projectName || fallbackSource.projectName, 96)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const briefSlug = normalizeSlug(source.briefSlug || source.brief || fallbackSource.briefSlug || fallbackSource.brief, 96);
  const action = normalizeSlug(source.action || fallbackSource.action, 64);

  if (!type && !id && !label && !href && !projectName && !briefSlug && !action) {
    return null;
  }

  const target = {
    type: type || "task",
    id,
    label,
    href,
  };
  if (projectName) target.projectName = projectName;
  if (briefSlug) target.briefSlug = briefSlug;
  if (action) target.action = action;
  return target;
}

function normalizeActionItem(value = {}, fallback = {}) {
  const existingStatus = VALID_ACTION_ITEM_STATUSES.has(fallback.status) ? fallback.status : "open";
  const requestedStatus = normalizeText(value.status, 32).toLowerCase();
  const resolution = normalizeActionItemResolution(value.resolution || value.decision || value.verdict, fallback.resolution || "");
  const inferredStatus = ["approved", "completed", "resumed", "steered"].includes(resolution)
    ? "completed"
    : ["dismissed", "paused", "rejected", "timeout"].includes(resolution)
      ? "dismissed"
      : existingStatus;
  const status = VALID_ACTION_ITEM_STATUSES.has(requestedStatus) ? requestedStatus : inferredStatus;
  const fallbackKind = normalizeActionItemKind(fallback.kind || fallback.type);
  const fallbackPriority = normalizeActionItemPriority(fallback.priority);
  const createdAt = normalizeText(fallback.createdAt || value.createdAt, 64) || nowIso();
  const updatedAt = normalizeText(value.updatedAt, 64) || nowIso();
  const fallbackChoices = normalizeActionItemChoices(fallback.choices || fallback.actions);
  const fallbackEvidence = normalizeActionItemEvidence(fallback.evidence);
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
    recommendation: normalizeText(value.recommendation || value.recommend || fallback.recommendation || fallback.recommend, 800),
    consequence: normalizeText(value.consequence || value.impact || fallback.consequence || fallback.impact, 800),
    evidence: normalizeActionItemEvidence(value.evidence, fallbackEvidence),
    choices: normalizeActionItemChoices(value.choices || value.actions, fallbackChoices),
    resolution,
    resolutionNote: normalizeText(value.resolutionNote || value.decisionNote || value.note || fallback.resolutionNote || fallback.decisionNote || fallback.note, 1_000),
    tutorialId: normalizeSlug(value.tutorialId || fallback.tutorialId, 96),
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
  const layout = normalizeLayout(value.layout);
  const layoutSummary = value.layoutSummary
    ? normalizeLayoutSummary(value.layoutSummary)
    : getLayoutSummary(layout);
  const actionItems = Array.isArray(value.actionItems)
    ? value.actionItems.map((item) => normalizeActionItem(item)).slice(0, MAX_ACTION_ITEMS)
    : [];
  const events = Array.isArray(value.events)
    ? value.events.map(normalizeEvent).filter(Boolean).slice(0, MAX_EVENTS)
    : [];

  return {
    version: AGENT_TOWN_STATE_VERSION,
    updatedAt: normalizeText(value.updatedAt, 64) || nowIso(),
    layout,
    layoutSummary: normalizeLayoutSummary({ ...getLayoutSummary(layout), ...layoutSummary }),
    layoutHistory: normalizeLayoutHistory(value.layoutHistory || value.history),
    layoutSnapshots: normalizeLayoutSnapshots(value.layoutSnapshots || value.snapshots),
    townShares: normalizeTownShares(value.townShares || value.shares),
    signals: normalizeSignals(value.signals),
    canvases: normalizeCanvases(value.canvases),
    actionItems,
    events,
    highlight: normalizeHighlight(value.highlight),
    lastSessionId: normalizeText(value.lastSessionId, 96),
    seededTutorialIds: normalizeStringArray(value.seededTutorialIds, 50),
  };
}

function getOnboardingPhase(state) {
  const { layoutSummary, signals } = state;
  if (signals.onboardingCompletedCount > 0) {
    return "seasoned";
  }
  const hasFunctional = layoutSummary.functionalCount > 0;
  const hasCosmetic = layoutSummary.cosmeticCount > 0;
  const hasCanvas = Array.isArray(state.canvases) && state.canvases.length > 0;
  const hasLibraryNote = signals.libraryNoteSavedCount > 0;
  const hasAutomation = signals.automationCreatedCount > 0;
  const completedQuests = [hasFunctional, hasCanvas, hasLibraryNote, hasAutomation].filter(Boolean).length;
  if (hasFunctional && hasCanvas && hasLibraryNote && hasAutomation) {
    return "seasoned";
  }
  if (completedQuests >= 2 || hasFunctional) {
    return "active";
  }
  if (hasCosmetic || hasFunctional) {
    return "placing";
  }
  return "fresh";
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

const QUEST_DEFINITIONS = Object.freeze([
  {
    id: "place-first-building",
    title: "Place your first building",
    detail: "Put one cosmetic or functional building on the Agent Town map.",
    href: "?view=swarm",
    cta: "Start",
    predicate: "first_building_placed",
    priority: "high",
  },
  {
    id: "place-functional-building",
    title: "Place a functional building",
    detail: "Install or place one capability building so agents have a visible workstation.",
    href: "?view=swarm",
    cta: "Start",
    predicate: "functional_building_placed",
    priority: "normal",
  },
  {
    id: "publish-agent-canvas",
    title: "Publish an agent canvas",
    detail: "Have an agent attach one visual artifact so the town shows current work.",
    href: "?view=agent-inbox",
    cta: "Start",
    signal: "canvas",
    priority: "normal",
  },
  {
    id: "save-library-note",
    title: "Save one Library note",
    detail: "Capture a durable note so future agents can pick up context.",
    href: "?view=knowledge-base",
    cta: "Start",
    predicate: "library_note_saved",
    priority: "normal",
  },
  {
    id: "create-automation",
    title: "Create one automation",
    detail: "Add a recurring helper or scheduled task to keep the base alive.",
    href: "?view=automations",
    cta: "Start",
    predicate: "automation_created",
    priority: "low",
  },
]);

function getQuestCompleted(state, quest) {
  if (quest.signal === "canvas") {
    return state.canvases.length > 0;
  }

  if (quest.predicate === "first_building_placed" || quest.predicate === "building_placed") {
    return state.layoutSummary.cosmeticCount + state.layoutSummary.functionalCount >= 1;
  }

  if (quest.predicate === "functional_building_placed") {
    return state.layoutSummary.functionalCount >= 1;
  }

  if (quest.predicate === "library_note_saved") {
    return state.signals.libraryNoteSavedCount >= 1;
  }

  if (quest.predicate === "automation_created") {
    return state.signals.automationCreatedCount >= 1;
  }

  return false;
}

function getComputedQuests(state) {
  let activeAssigned = false;
  return QUEST_DEFINITIONS.map((quest) => {
    const completed = getQuestCompleted(state, quest);
    const status = completed
      ? "completed"
      : activeAssigned
        ? "locked"
        : "active";
    if (status === "active") {
      activeAssigned = true;
    }
    return {
      ...quest,
      status,
    };
  });
}

function getComputedAlerts(state) {
  const alerts = [];
  const openActionItems = state.actionItems.filter((item) => item.status === "open");
  const urgentAction = openActionItems.find((item) => item.priority === "urgent" || item.priority === "high");
  if (urgentAction) {
    alerts.push({
      id: `action-${urgentAction.id}`,
      severity: urgentAction.priority === "urgent" ? "urgent" : "warning",
      title: urgentAction.title,
      detail: urgentAction.detail || "Agent Town is waiting on a human action.",
      href: urgentAction.href || urgentAction.target?.href || "?view=agent-inbox",
      target: urgentAction.target || { type: "task", id: urgentAction.id, label: urgentAction.title },
      priority: urgentAction.priority,
    });
  }

  if (state.layoutSummary.pendingFunctionalIds.length) {
    const count = state.layoutSummary.pendingFunctionalIds.length;
    alerts.push({
      id: "pending-functional-buildings",
      severity: "warning",
      title: `${count} building${count === 1 ? "" : "s"} need placement`,
      detail: "Installed buildings are waiting for a spot on the town map.",
      href: "?view=swarm",
      target: { type: "building", id: "buildinghub", label: "BuildingHub" },
      priority: "high",
    });
  }

  const hasCustomLayout =
    state.layoutSummary.cosmeticCount > 0
    || state.layoutSummary.functionalCount > 0
    || Object.keys(state.layout.places || {}).length > 0
    || Object.keys(state.layout.roads || {}).length > 0;
  if (hasCustomLayout && !state.layoutSnapshots.length) {
    alerts.push({
      id: "no-layout-snapshot",
      severity: "info",
      title: "No town snapshot yet",
      detail: "Save a snapshot before big edits so this base can roll back cleanly.",
      href: "?view=swarm",
      target: { type: "workspace", id: "agent-town", label: "Agent Town" },
      priority: "normal",
    });
  }

  const activeQuest = getComputedQuests(state).find((quest) => quest.status === "active");
  if (activeQuest) {
    alerts.push({
      id: `quest-${activeQuest.id}`,
      severity: "quest",
      title: activeQuest.title,
      detail: activeQuest.detail,
      href: activeQuest.href,
      target: { type: "task", id: activeQuest.id, label: activeQuest.title },
      priority: activeQuest.priority,
    });
  }

  const severityRank = {
    urgent: 0,
    warning: 1,
    quest: 2,
    info: 3,
  };
  return alerts
    .sort((left, right) => (severityRank[left.severity] ?? 4) - (severityRank[right.severity] ?? 4))
    .slice(0, MAX_ALERTS);
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
    const state = clone(this.state);
    state.quests = getComputedQuests(this.state);
    state.alerts = getComputedAlerts(this.state);
    state.layoutValidation = validateLayout(this.state.layout);
    state.layoutHistory = {
      pastCount: this.state.layoutHistory.past.length,
      futureCount: this.state.layoutHistory.future.length,
      canUndo: this.state.layoutHistory.past.length > 0,
      canRedo: this.state.layoutHistory.future.length > 0,
    };
    state.snapshots = state.layoutSnapshots;
    state.onboardingPhase = getOnboardingPhase(this.state);
    state.isNewUser = state.onboardingPhase === "fresh";
    state.highlight = isHighlightActive(state.highlight) ? state.highlight : null;
    return state;
  }

  getCanvas(canvasId) {
    const id = normalizeId(canvasId, "canvas");
    const canvas = this.state.canvases.find((entry) => entry.id === id);
    return canvas ? clone(canvas) : null;
  }

  getTownShare(shareId) {
    const id = normalizeSlug(shareId, 96);
    if (!id) {
      return null;
    }

    const townShare = this.state.townShares.find((entry) => entry.id === id);
    return townShare ? clone(townShare) : null;
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
      if (params.itemId) {
        return (this.state.layout.decorations || []).some((entry) => entry.itemId === params.itemId);
      }
      return layoutSummary.cosmeticCount >= minCount;
    }

    if (predicate === "functional_building_placed") {
      if (params.pluginId) {
        return layoutSummary.functionalIds.includes(params.pluginId);
      }
      return layoutSummary.functionalCount >= minCount;
    }

    if (
      predicate === "action_item_completed" ||
      predicate === "action_item_dismissed" ||
      predicate === "action_item_resolved"
    ) {
      const targetStatus = predicate === "action_item_completed"
        ? "completed"
        : predicate === "action_item_dismissed"
          ? "dismissed"
          : "";
      return actionItems.some((item) => (
        (targetStatus ? item.status === targetStatus : item.status !== "open") &&
        (!params.actionItemId || item.id === params.actionItemId)
      ));
    }

    const actionItemResolutionPredicates = {
      action_item_approved: "approved",
      action_item_rejected: "rejected",
      action_item_steered: "steered",
      action_item_paused: "paused",
      action_item_resumed: "resumed",
    };
    if (actionItemResolutionPredicates[predicate]) {
      const targetResolution = actionItemResolutionPredicates[predicate];
      return actionItems.some((item) => (
        item.resolution === targetResolution &&
        (!params.actionItemId || item.id === params.actionItemId)
      ));
    }

    if (predicate === "workspace_selected") {
      return (this.state.signals.workspaceSelectedCount || 0) >= minCount;
    }

    if (predicate === "onboarding_complete") {
      return (this.state.signals.onboardingCompletedCount || 0) >= minCount
        || getOnboardingPhase(this.state) === "seasoned";
    }

    return getPredicateCount(this.state, predicate) >= minCount;
  }

  async setHighlight(input = {}) {
    const highlight = normalizeHighlight(input);
    if (!highlight) {
      const error = new Error("Highlight must include buildingId, itemId, or coordinates.");
      error.statusCode = 400;
      throw error;
    }
    this.state.highlight = highlight;
    this.state.events = [
      normalizeEvent({
        type: "highlight_set",
        label: highlight.buildingId || highlight.itemId || "tile",
        detail: highlight.reason,
        metadata: {
          targetType: highlight.targetType,
          buildingId: highlight.buildingId,
          itemId: highlight.itemId,
          coordinates: highlight.coordinates,
          sourceSessionId: highlight.sourceSessionId,
          durationMs: highlight.durationMs,
        },
      }),
      ...this.state.events,
    ].filter(Boolean).slice(0, MAX_EVENTS);
    if (highlight.sourceSessionId) {
      this.state.lastSessionId = highlight.sourceSessionId;
    }
    await this.afterStateChange();
    return { highlight, state: this.getState() };
  }

  async clearHighlight() {
    this.state.highlight = null;
    await this.afterStateChange();
    return { state: this.getState() };
  }

  getHighlight() {
    return isHighlightActive(this.state.highlight) ? clone(this.state.highlight) : null;
  }

  async updateMirror(payload = {}) {
    const nextLayoutSummary = payload.layoutSummary || payload.agentTown?.layoutSummary;
    const nextLayout = payload.layout || payload.agentTown?.layout;
    const nextSignals = payload.signals || payload.agentTown?.signals;
    const nextCanvases = payload.canvases || payload.agentTown?.canvases;
    const mirrorSessionId = normalizeText(
      payload.sourceSessionId || payload.sessionId || payload.agentTown?.sourceSessionId || payload.agentTown?.sessionId,
      96,
    );
    if (mirrorSessionId) {
      this.state.lastSessionId = mirrorSessionId;
    }

    if (nextLayout && typeof nextLayout === "object" && !Array.isArray(nextLayout)) {
      this.setLayout(nextLayout, { reason: payload.reason || payload.agentTown?.reason || "mirror" });
    }

    if (nextLayoutSummary && typeof nextLayoutSummary === "object") {
      this.state.layoutSummary = normalizeLayoutSummary({
        ...getLayoutSummary(this.state.layout),
        ...nextLayoutSummary,
      });
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

  setLayout(layoutInput = {}, { reason = "layout-update", recordHistory = true } = {}) {
    const nextLayout = normalizeLayout(layoutInput);
    if (layoutsEqual(this.state.layout, nextLayout)) {
      this.state.layoutSummary = getLayoutSummary(nextLayout);
      return false;
    }

    if (recordHistory) {
      this.state.layoutHistory.past = [
        ...this.state.layoutHistory.past,
        normalizeLayout(this.state.layout),
      ].slice(-MAX_LAYOUT_HISTORY);
      this.state.layoutHistory.future = [];
    }

    this.state.layout = nextLayout;
    this.state.layoutSummary = getLayoutSummary(nextLayout);
    this.state.events = [
      normalizeEvent({
        type: "layout_changed",
        label: reason,
        metadata: { summary: this.state.layoutSummary },
      }),
      ...this.state.events,
    ].filter(Boolean).slice(0, MAX_EVENTS);
    return true;
  }

  async validateLayout(input = {}) {
    return validateLayout(input.layout || input);
  }

  async createLayoutSnapshot(input = {}) {
    const snapshot = normalizeLayoutSnapshot({
      id: input.id,
      name: input.name || "Town snapshot",
      layout: input.layout || this.state.layout,
      createdAt: input.createdAt,
      updatedAt: nowIso(),
    });
    const existingIndex = this.state.layoutSnapshots.findIndex((entry) => entry.id === snapshot.id);
    if (existingIndex >= 0) {
      this.state.layoutSnapshots.splice(existingIndex, 1);
    }
    this.state.layoutSnapshots = [snapshot, ...this.state.layoutSnapshots].slice(0, MAX_LAYOUT_SNAPSHOTS);
    await this.afterStateChange();
    return { snapshot, state: this.getState() };
  }

  async restoreLayoutSnapshot(snapshotId) {
    const id = normalizeId(snapshotId, "snapshot");
    const snapshot = this.state.layoutSnapshots.find((entry) => entry.id === id);
    if (!snapshot) {
      const error = new Error("Agent Town snapshot not found.");
      error.statusCode = 404;
      throw error;
    }
    this.setLayout(snapshot.layout, { reason: `restore snapshot ${snapshot.name}` });
    await this.afterStateChange();
    return { snapshot, state: this.getState() };
  }

  async publishTownShare(input = {}) {
    const validation = validateLayout(input.layout || input);
    if (!validation.ok) {
      const error = new Error(`Invalid Agent Town layout: ${validation.issues.join("; ")}`);
      error.statusCode = 400;
      error.validation = validation;
      throw error;
    }

    const requestedShare = normalizeTownShare({
      ...input,
      layout: validation.layout,
      layoutSummary: validation.summary,
    });
    const existingIndex = this.state.townShares.findIndex((entry) => entry.id === requestedShare.id);
    const existing = existingIndex >= 0 ? this.state.townShares[existingIndex] : null;
    const townShare = normalizeTownShare({
      ...existing,
      ...input,
      id: requestedShare.id,
      name: input.name || existing?.name || requestedShare.name,
      description: input.description ?? existing?.description ?? requestedShare.description,
      layout: validation.layout,
      layoutSummary: validation.summary,
      visibility: input.visibility || existing?.visibility || requestedShare.visibility,
      imagePath: input.imagePath === undefined ? existing?.imagePath : input.imagePath,
      imageMimeType: input.imageMimeType === undefined ? existing?.imageMimeType : input.imageMimeType,
      imageByteLength: input.imageByteLength === undefined ? existing?.imageByteLength : input.imageByteLength,
      imageUpdatedAt: input.imageUpdatedAt === undefined ? existing?.imageUpdatedAt : input.imageUpdatedAt,
      buildingHub: input.buildingHub === undefined ? existing?.buildingHub : input.buildingHub,
      createdAt: existing?.createdAt || input.createdAt || requestedShare.createdAt,
      updatedAt: nowIso(),
    });

    if (existingIndex >= 0) {
      this.state.townShares.splice(existingIndex, 1);
    }
    this.state.townShares = [townShare, ...this.state.townShares].slice(0, MAX_TOWN_SHARES);
    this.state.events = [
      normalizeEvent({
        type: "town_share_published",
        label: townShare.name,
        metadata: { shareId: townShare.id, summary: townShare.layoutSummary },
      }),
      ...this.state.events,
    ].filter(Boolean).slice(0, MAX_EVENTS);
    await this.afterStateChange();
    return {
      townShare: this.getTownShare(townShare.id),
      validation,
      state: this.getState(),
    };
  }

  async importTownShare(shareId) {
    const townShare = this.getTownShare(shareId);
    if (!townShare) {
      const error = new Error("Agent Town share not found.");
      error.statusCode = 404;
      throw error;
    }

    const validation = validateLayout(townShare.layout);
    if (!validation.ok) {
      const error = new Error(`Invalid Agent Town share layout: ${validation.issues.join("; ")}`);
      error.statusCode = 400;
      error.validation = validation;
      throw error;
    }

    this.setLayout(validation.layout, {
      reason: `import town share ${townShare.name}`,
    });
    this.state.events = [
      normalizeEvent({
        type: "town_share_imported",
        label: townShare.name,
        metadata: { shareId: townShare.id, summary: townShare.layoutSummary },
      }),
      ...this.state.events,
    ].filter(Boolean).slice(0, MAX_EVENTS);
    await this.afterStateChange();
    return {
      townShare,
      validation,
      state: this.getState(),
    };
  }

  async importLayout(input = {}) {
    const validation = validateLayout(input.layout || input);
    if (!validation.ok) {
      const error = new Error(`Invalid Agent Town layout: ${validation.issues.join("; ")}`);
      error.statusCode = 400;
      error.validation = validation;
      throw error;
    }
    this.setLayout(validation.layout, { reason: input.reason || "import layout" });
    await this.afterStateChange();
    return { validation, state: this.getState() };
  }

  exportTownSection() {
    return {
      stateVersion: AGENT_TOWN_STATE_VERSION,
      layout: clone(this.state.layout),
      layoutSnapshots: clone(this.state.layoutSnapshots),
    };
  }

  async importTownSection(input = {}, { reason = "import bundle", replaceSnapshots = true } = {}) {
    const validation = validateLayout(input.layout || {});
    if (!validation.ok) {
      const error = new Error(`Invalid Agent Town layout: ${validation.issues.join("; ")}`);
      error.statusCode = 400;
      error.validation = validation;
      throw error;
    }

    this.setLayout(validation.layout, { reason });

    if (replaceSnapshots) {
      this.state.layoutSnapshots = normalizeLayoutSnapshots(input.layoutSnapshots || []);
    } else if (Array.isArray(input.layoutSnapshots) && input.layoutSnapshots.length > 0) {
      const merged = [
        ...normalizeLayoutSnapshots(input.layoutSnapshots),
        ...this.state.layoutSnapshots,
      ];
      const seen = new Set();
      this.state.layoutSnapshots = merged
        .filter((entry) => {
          if (seen.has(entry.id)) return false;
          seen.add(entry.id);
          return true;
        })
        .slice(0, MAX_LAYOUT_SNAPSHOTS);
    }

    await this.afterStateChange();
    return { validation, state: this.getState() };
  }

  async undoLayout() {
    const previous = this.state.layoutHistory.past.pop();
    if (!previous) {
      return { changed: false, state: this.getState() };
    }
    this.state.layoutHistory.future = [
      normalizeLayout(this.state.layout),
      ...this.state.layoutHistory.future,
    ].slice(0, MAX_LAYOUT_HISTORY);
    this.state.layout = normalizeLayout(previous);
    this.state.layoutSummary = getLayoutSummary(this.state.layout);
    await this.afterStateChange();
    return { changed: true, state: this.getState() };
  }

  async redoLayout() {
    const next = this.state.layoutHistory.future.shift();
    if (!next) {
      return { changed: false, state: this.getState() };
    }
    this.state.layoutHistory.past = [
      ...this.state.layoutHistory.past,
      normalizeLayout(this.state.layout),
    ].slice(-MAX_LAYOUT_HISTORY);
    this.state.layout = normalizeLayout(next);
    this.state.layoutSummary = getLayoutSummary(this.state.layout);
    await this.afterStateChange();
    return { changed: true, state: this.getState() };
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

    const metadataSessionId = event.metadata && typeof event.metadata === "object"
      ? normalizeText(event.metadata.sourceSessionId || event.metadata.sessionId, 96)
      : "";
    const eventSessionId = metadataSessionId || normalizeText(input.sourceSessionId || input.sessionId, 96);
    if (eventSessionId) {
      this.state.lastSessionId = eventSessionId;
    }

    this.state.events = [event, ...this.state.events].slice(0, MAX_EVENTS);
    await this.afterStateChange();
    return { event, state: this.getState() };
  }

  hasSeededTutorial(tutorialId) {
    const id = normalizeSlug(tutorialId, 96);
    if (!id) {
      return false;
    }
    return this.state.seededTutorialIds.includes(id);
  }

  async seedTutorialActionItem(input = {}) {
    const tutorialId = normalizeSlug(input.tutorialId, 96);
    if (!tutorialId) {
      const error = new Error("seedTutorialActionItem requires a tutorialId.");
      error.statusCode = 400;
      throw error;
    }

    if (this.state.seededTutorialIds.includes(tutorialId)) {
      const existing = this.state.actionItems.find((entry) => entry.tutorialId === tutorialId) || null;
      return { actionItem: existing ? clone(existing) : null, seeded: false, state: this.getState() };
    }

    const item = normalizeActionItem({ ...input, tutorialId }, {});
    const existingIndex = this.state.actionItems.findIndex((entry) => entry.id === item.id);
    if (existingIndex >= 0) {
      this.state.actionItems.splice(existingIndex, 1);
    }
    this.state.actionItems = [item, ...this.state.actionItems].slice(0, MAX_ACTION_ITEMS);
    this.state.seededTutorialIds = Array.from(new Set([...this.state.seededTutorialIds, tutorialId])).slice(0, 50);
    await this.afterStateChange();
    const stored = this.state.actionItems.find((entry) => entry.id === item.id) || item;
    return { actionItem: clone(stored), seeded: true, state: this.getState() };
  }

  async createActionItem(input = {}) {
    const item = normalizeActionItem(input, {});
    const existingIndex = this.state.actionItems.findIndex((entry) => entry.id === item.id);
    const existing = existingIndex >= 0 ? this.state.actionItems[existingIndex] : null;
    const nextItem = normalizeActionItem(
      {
        ...input,
        id: item.id,
      },
      existing || {},
    );

    if (existingIndex >= 0) {
      this.state.actionItems.splice(existingIndex, 1);
    }
    this.state.actionItems = [nextItem, ...this.state.actionItems].slice(0, MAX_ACTION_ITEMS);
    if (nextItem.sourceSessionId) {
      this.state.lastSessionId = nextItem.sourceSessionId;
    }
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
    const nextItem = normalizeActionItem({ ...input, id }, existing);
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
        sourceSessionId: this.state.lastSessionId || "",
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
          sourceSessionId: this.state.lastSessionId || "",
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
        resolution: item.resolution || "completed",
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
        sourceSessionId: this.state.lastSessionId || "",
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
