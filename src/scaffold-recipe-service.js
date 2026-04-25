import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const SCAFFOLD_RECIPE_SCHEMA = "vibe-research.scaffold.recipe.v1";

const STORE_FILENAME = "scaffold-recipes.json";
const STORE_VERSION = 1;
const MAX_TEXT_LENGTH = 2_000;
const MAX_RECIPES = 100;
const MAX_BUILDINGS = 240;
const MAX_BINDINGS = 160;
const MAX_SETTING_VALUE_LENGTH = 2_000;
const MAX_GROUP_INBOXES = 40;

const SECRET_SETTING_KEYS = new Set([
  "agentAnthropicApiKey",
  "agentHfToken",
  "agentMailApiKey",
  "agentOpenAiApiKey",
  "browserUseAnthropicApiKey",
  "ottoAuthPrivateKey",
  "telegramBotToken",
]);

const LOCAL_SETTING_KEYS = new Set([
  "agentSpawnPath",
  "browserUseBrowserPath",
  "browserUseProfileDir",
  "browserUseWorkerPath",
  "buildingHubCatalogPath",
  "ottoAuthCallbackUrl",
  "videoMemoryBaseUrl",
  "wikiPath",
  "workspaceRootPath",
]);

const PERSONAL_SETTING_KEYS = new Set([
  "agentMailClientId",
  "agentMailDisplayName",
  "agentMailDomain",
  "agentMailInboxId",
  "agentMailUsername",
  "telegramAllowedChatIds",
  "wikiGitRemoteUrl",
]);

const PORTABLE_SETTING_KEYS = new Set([
  "agentAutomations",
  "agentCommunicationCaptureMessageReads",
  "agentCommunicationCaptureMessages",
  "agentCommunicationDmBody",
  "agentCommunicationDmEnabled",
  "agentCommunicationDmVisibility",
  "agentCommunicationGroupInboxes",
  "agentCommunicationMaxThreadDepth",
  "agentCommunicationMaxUnrepliedPerAgent",
  "agentCommunicationRequireRelatedObject",
  "agentMailEnabled",
  "agentMailMode",
  "agentMailProviderId",
  "browserUseEnabled",
  "browserUseHeadless",
  "browserUseKeepTabs",
  "browserUseMaxTurns",
  "browserUseModel",
  "buildingHubCatalogUrl",
  "buildingHubEnabled",
  "installedPluginIds",
  "ottoAuthBaseUrl",
  "ottoAuthDefaultMaxChargeCents",
  "ottoAuthEnabled",
  "preventSleepEnabled",
  "telegramEnabled",
  "telegramProviderId",
  "videoMemoryEnabled",
  "videoMemoryProviderId",
  "wikiBackupIntervalMs",
  "wikiGitBackupEnabled",
  "wikiGitRemoteBranch",
  "wikiGitRemoteEnabled",
  "wikiGitRemoteName",
  "wikiPathConfigured",
]);

const SECRET_KEY_PATTERN =
  /authorization|cookie|token|secret|password|passcode|private[_-]?key|api[_-]?key|credential/i;

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, limit = MAX_TEXT_LENGTH) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 3)).trim()}...`;
}

function normalizeSlug(value, fallback = "", limit = 96) {
  const slug = String(value || fallback || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, limit);
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : "";
}

function normalizeSettingKey(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "")
    .slice(0, 96);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStringArray(value, limit = 80) {
  return Array.from(new Set(safeArray(value).map((entry) => normalizeText(entry, 160)).filter(Boolean))).slice(0, limit);
}

function sanitizeScalar(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return normalizeText(value, MAX_SETTING_VALUE_LENGTH);
  }
  return undefined;
}

function sanitizePortableValue(value, depth = 0) {
  const scalar = sanitizeScalar(value);
  if (scalar !== undefined) {
    return scalar;
  }
  if (depth >= 4) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((entry) => sanitizePortableValue(entry, depth + 1)).filter((entry) => entry !== undefined);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 80)
        .map(([key, entry]) => {
          const settingKey = normalizeSettingKey(key);
          return settingKey && !SECRET_KEY_PATTERN.test(settingKey)
            ? [settingKey, sanitizePortableValue(entry, depth + 1)]
            : null;
        })
        .filter(Boolean)
        .filter(([key, entry]) => key && entry !== undefined),
    );
  }
  return undefined;
}

export function getSettingSensitivity(key) {
  const settingKey = normalizeSettingKey(key);
  if (!settingKey) {
    return "unknown";
  }
  if (SECRET_SETTING_KEYS.has(settingKey) || SECRET_KEY_PATTERN.test(settingKey)) {
    return "secret";
  }
  if (LOCAL_SETTING_KEYS.has(settingKey)) {
    return "local";
  }
  if (PERSONAL_SETTING_KEYS.has(settingKey)) {
    return "personal";
  }
  if (PORTABLE_SETTING_KEYS.has(settingKey)) {
    return "portable";
  }
  return "unknown";
}

function normalizePortableSettings(value = {}) {
  if (!isPlainObject(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => {
        const settingKey = normalizeSettingKey(key);
        if (getSettingSensitivity(settingKey) !== "portable") {
          return null;
        }
        const sanitized = sanitizePortableValue(entry);
        return sanitized === undefined ? null : [settingKey, sanitized];
      })
      .filter(Boolean),
  );
}

function normalizeConfiguredBinding(value = {}, fallback = {}) {
  const key = normalizeSettingKey(value.key || value.setting || fallback.key || fallback.setting);
  const sensitivity = normalizeText(value.sensitivity || fallback.sensitivity || getSettingSensitivity(key), 32);
  if (!key) {
    return null;
  }
  return {
    key,
    label: normalizeText(value.label || fallback.label || key, 120) || key,
    sensitivity: ["local", "personal", "secret", "portable", "unknown"].includes(sensitivity) ? sensitivity : getSettingSensitivity(key),
    configured: Boolean(value.configured ?? fallback.configured),
    required: Boolean(value.required ?? fallback.required),
  };
}

function dedupeBindings(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const normalized = normalizeConfiguredBinding(entry);
    if (!normalized) {
      continue;
    }
    const existing = byKey.get(normalized.key);
    byKey.set(normalized.key, existing
      ? {
          ...existing,
          ...normalized,
          configured: existing.configured || normalized.configured,
          required: existing.required || normalized.required,
        }
      : normalized);
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key)).slice(0, MAX_BINDINGS);
}

function normalizeRecipeSettings(value = {}) {
  const source = isPlainObject(value) ? value : {};
  return {
    portable: normalizePortableSettings(source.portable || source.settings || {}),
    localBindingsRequired: dedupeBindings(safeArray(source.localBindingsRequired || source.local || source.bindings)),
    personal: dedupeBindings(safeArray(source.personal)).map((entry) => ({ ...entry, sensitivity: "personal" })),
    secrets: dedupeBindings(safeArray(source.secrets)).map((entry) => ({ ...entry, sensitivity: "secret" })),
  };
}

function normalizeBuildingSettings(value = {}) {
  return normalizePortableSettings(value);
}

function normalizeBuilding(value = {}) {
  if (!isPlainObject(value)) {
    return null;
  }
  const id = normalizeSlug(value.id || value.name);
  if (!id) {
    return null;
  }
  const source = normalizeText(value.source || "recipe", 80) || "recipe";
  return {
    id,
    name: normalizeText(value.name || id, 120) || id,
    category: normalizeText(value.category, 80),
    source,
    version: normalizeText(value.version, 80),
    status: normalizeText(value.status, 80),
    enabled: Boolean(value.enabled),
    required: value.required !== false,
    settingKey: normalizeSettingKey(value.settingKey || value.enabledSetting),
    settings: normalizeBuildingSettings(value.settings),
    localBindingsRequired: dedupeBindings(value.localBindingsRequired || value.bindings || []),
  };
}

function normalizeBuildings(value = []) {
  const byId = new Map();
  for (const entry of safeArray(value).slice(0, MAX_BUILDINGS)) {
    const building = normalizeBuilding(entry);
    if (building && !byId.has(building.id)) {
      byId.set(building.id, building);
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeLayout(value = {}) {
  if (!isPlainObject(value)) {
    return null;
  }
  const source = clone(value);
  if (!isPlainObject(source)) {
    return null;
  }
  return {
    places: isPlainObject(source.places) ? source.places : {},
    roads: isPlainObject(source.roads) ? source.roads : {},
    decorations: safeArray(source.decorations),
    functional: isPlainObject(source.functional) ? source.functional : {},
    pendingFunctional: normalizeStringArray(source.pendingFunctional, 120),
    themeId: normalizeSlug(source.themeId || source.theme || "default", "default", 48) || "default",
    dogName: normalizeText(source.dogName || source.companionName || "Dog", 48) || "Dog",
  };
}

function normalizeCommunication(value = {}) {
  const source = isPlainObject(value) ? value : {};
  const dm = isPlainObject(source.dm) ? source.dm : {};
  const logging = isPlainObject(source.logging) ? source.logging : {};
  const body = normalizeSlug(dm.body || "freeform", "freeform", 32);
  const visibility = normalizeSlug(dm.visibility || "workspace", "workspace", 32);
  const maxThreadDepth = Math.max(1, Math.min(50, Math.floor(Number(dm.maxThreadDepth) || 6)));
  const maxUnrepliedPerAgent = Math.max(0, Math.min(50, Math.floor(Number(dm.maxUnrepliedPerAgent) || 3)));
  return {
    dm: {
      enabled: Boolean(dm.enabled),
      body: ["freeform", "typed", "typed-envelope"].includes(body) ? body : "freeform",
      visibility: ["workspace", "private", "public"].includes(visibility) ? visibility : "workspace",
      requireRelatedObject: Boolean(dm.requireRelatedObject),
      maxThreadDepth,
      maxUnrepliedPerAgent,
    },
    groupInboxes: normalizeStringArray(source.groupInboxes || source.groups, MAX_GROUP_INBOXES)
      .map((entry) => normalizeSlug(entry))
      .filter(Boolean),
    logging: {
      captureMessages: logging.captureMessages !== false,
      captureMessageReads: logging.captureMessageReads !== false,
    },
  };
}

function normalizeAgents(value = {}) {
  const source = isPlainObject(value) ? value : {};
  return {
    defaultProvider: normalizeSlug(source.defaultProvider || source.defaultProviderId || "claude", "claude", 48) || "claude",
    allowedProviders: normalizeStringArray(source.allowedProviders || source.providers, 40)
      .map((entry) => normalizeSlug(entry, "", 48))
      .filter(Boolean),
    defaultOccupation: normalizeSlug(source.defaultOccupation || source.occupation || "researcher", "researcher", 80) || "researcher",
    canSpawnAgents: source.canSpawnAgents !== false,
    canCreateSubagents: source.canCreateSubagents !== false,
    maxConcurrentAgents: Math.max(1, Math.min(100, Math.floor(Number(source.maxConcurrentAgents) || 6))),
  };
}

function normalizeSandbox(value = {}) {
  const source = isPlainObject(value) ? value : {};
  const gpu = isPlainObject(source.gpu) ? source.gpu : {};
  return {
    provider: normalizeSlug(source.provider || source.id || "local", "local", 80) || "local",
    isolation: normalizeSlug(source.isolation || "workspace", "workspace", 80) || "workspace",
    network: normalizeSlug(source.network || "default", "default", 80) || "default",
    gpu: {
      enabled: Boolean(gpu.enabled),
      provider: normalizeText(gpu.provider || gpu.type, 80),
      count: Math.max(0, Math.min(64, Math.floor(Number(gpu.count) || 0))),
    },
    config: isPlainObject(source.config) ? sanitizePortableValue(source.config) || {} : {},
    localBindingsRequired: dedupeBindings(source.localBindingsRequired || source.bindings || []),
  };
}

function normalizePermissions(value = {}) {
  const source = isPlainObject(value) ? value : {};
  return {
    requireApproval: normalizeStringArray(source.requireApproval || source.approvalsRequired, 80)
      .map((entry) => normalizeSlug(entry, "", 80))
      .filter(Boolean),
    deny: normalizeStringArray(source.deny || source.denied, 80)
      .map((entry) => normalizeSlug(entry, "", 80))
      .filter(Boolean),
  };
}

function normalizeLibrary(value = {}) {
  const source = isPlainObject(value) ? value : {};
  return {
    mode: normalizeSlug(source.mode || "configured", "configured", 48) || "configured",
    snapshot: normalizeText(source.snapshot || source.snapshotId, 200),
    gitCommit: normalizeText(source.gitCommit || source.commit, 160),
    gitBranch: normalizeText(source.gitBranch || source.branch, 160),
    gitRemoteConfigured: Boolean(source.gitRemoteConfigured),
    backupEnabled: Boolean(source.backupEnabled),
    localBindingsRequired: dedupeBindings(source.localBindingsRequired || source.bindings || []),
  };
}

function normalizeOccupation(value = {}) {
  const source = isPlainObject(value) ? value : {};
  const selectedPromptId = normalizeSlug(source.selectedPromptId || source.id || "researcher", "researcher", 80) || "researcher";
  return {
    selectedPromptId,
    label: normalizeText(source.label || selectedPromptId, 120) || selectedPromptId,
    editable: Boolean(source.editable),
    promptSha256: normalizeText(source.promptSha256 || source.sha256, 128),
    customPrompt: source.includeCustomPrompt ? normalizeText(source.customPrompt, 60_000) : "",
  };
}

function normalizeCompatibility(value = {}) {
  const source = isPlainObject(value) ? value : {};
  const vibeResearch = isPlainObject(source.vibeResearch) ? source.vibeResearch : {};
  return {
    recipeSchema: normalizeText(source.recipeSchema || SCAFFOLD_RECIPE_SCHEMA, 120) || SCAFFOLD_RECIPE_SCHEMA,
    vibeResearch: {
      version: normalizeText(vibeResearch.version || source.vibeResearchVersion, 80),
      commit: normalizeText(vibeResearch.commit || source.vibeResearchCommit, 160),
      branch: normalizeText(vibeResearch.branch || source.vibeResearchBranch, 160),
      range: normalizeText(vibeResearch.range || source.vibeResearchRange, 120),
    },
  };
}

function normalizeRecipeSource(value = {}) {
  const source = isPlainObject(value) ? value : {};
  return {
    kind: normalizeText(source.kind || "local", 80) || "local",
    sourceId: normalizeText(source.sourceId || source.id, 120),
    repositoryUrl: normalizeText(source.repositoryUrl || source.repoUrl, 2_000),
    recipeUrl: normalizeText(source.recipeUrl || source.url || source.homepageUrl, 2_000),
    commit: normalizeText(source.commit || source.commitSha, 160),
    commitUrl: normalizeText(source.commitUrl, 2_000),
    publishedAt: normalizeText(source.publishedAt, 80),
    publisher: normalizeRecipePublisher(source.publisher),
  };
}

function normalizeRecipePublisher(value = {}) {
  const source = isPlainObject(value) ? value : {};
  const provider = normalizeText(source.provider, 40).toLowerCase();
  const id = normalizeText(source.id, 120);
  const login = normalizeText(source.login || source.username, 120);
  const name = normalizeText(source.name || source.displayName, 160);
  const profileUrl = normalizeText(source.profileUrl || source.url || source.htmlUrl, 2_000);
  const avatarUrl = normalizeText(source.avatarUrl || source.avatar_url, 2_000);

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

function computeRecipeDigest(recipe) {
  const payload = JSON.stringify({
    schema: recipe.schema,
    buildings: recipe.buildings,
    communication: recipe.communication,
    layout: recipe.layout,
    occupation: recipe.occupation,
    permissions: recipe.permissions,
    sandbox: recipe.sandbox,
    settings: recipe.settings,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function normalizeScaffoldRecipe(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const name = normalizeText(source.name || source.title || "Vibe Research scaffold", 120) || "Vibe Research scaffold";
  const id = normalizeSlug(source.id || source.recipeId || name, `recipe-${Date.now().toString(36)}`) || `recipe-${Date.now().toString(36)}`;
  const createdAt = normalizeText(source.createdAt, 80) || nowIso();
  const updatedAt = normalizeText(source.updatedAt, 80) || nowIso();
  const layout = normalizeLayout(source.layout);
  const settings = normalizeRecipeSettings(source.settings);
  const recipe = {
    schema: SCAFFOLD_RECIPE_SCHEMA,
    id,
    name,
    version: normalizeText(source.version || "0.1.0", 40) || "0.1.0",
    description: normalizeText(source.description || source.summary, 900),
    tags: normalizeStringArray(source.tags, 30).map((entry) => normalizeSlug(entry, "", 60)).filter(Boolean),
    compatibility: normalizeCompatibility(source.compatibility),
    buildings: normalizeBuildings(source.buildings),
    settings,
    communication: normalizeCommunication(source.communication),
    agents: normalizeAgents(source.agents),
    sandbox: normalizeSandbox(source.sandbox),
    permissions: normalizePermissions(source.permissions),
    library: normalizeLibrary(source.library),
    occupation: normalizeOccupation(source.occupation),
    localBindingsRequired: dedupeBindings([
      ...safeArray(source.localBindingsRequired || source.bindings),
      ...settings.localBindingsRequired,
      ...settings.personal,
      ...settings.secrets,
    ]),
    redactions: normalizeStringArray(source.redactions, 80),
    source: normalizeRecipeSource(source.source || source.buildingHub),
    createdAt,
    updatedAt,
  };
  if (layout) {
    recipe.layout = layout;
  }
  recipe.sha256 = normalizeText(source.sha256, 128) || computeRecipeDigest(recipe);
  return recipe;
}

function buildSettingsSnapshot(settings = {}) {
  const portable = {};
  const local = [];
  const personal = [];
  const secrets = [];
  for (const [key, value] of Object.entries(settings || {})) {
    const sensitivity = getSettingSensitivity(key);
    if (sensitivity === "portable") {
      const sanitized = sanitizePortableValue(value);
      if (sanitized !== undefined) {
        portable[key] = sanitized;
      }
    } else if (sensitivity === "local") {
      local.push({ key, label: key, sensitivity, configured: Boolean(value), required: false });
    } else if (sensitivity === "personal") {
      personal.push({ key, label: key, sensitivity, configured: Boolean(value), required: false });
    } else if (sensitivity === "secret") {
      secrets.push({ key, label: key, sensitivity, configured: Boolean(value), required: false });
    }
  }
  return {
    portable,
    localBindingsRequired: dedupeBindings(local),
    personal: dedupeBindings(personal),
    secrets: dedupeBindings(secrets),
  };
}

function parseGroupInboxes(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return String(value || "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildCommunicationSnapshot(settings = {}) {
  return normalizeCommunication({
    dm: {
      enabled: settings.agentCommunicationDmEnabled,
      body: settings.agentCommunicationDmBody,
      visibility: settings.agentCommunicationDmVisibility,
      requireRelatedObject: settings.agentCommunicationRequireRelatedObject,
      maxThreadDepth: settings.agentCommunicationMaxThreadDepth,
      maxUnrepliedPerAgent: settings.agentCommunicationMaxUnrepliedPerAgent,
    },
    groupInboxes: parseGroupInboxes(settings.agentCommunicationGroupInboxes),
    logging: {
      captureMessages: settings.agentCommunicationCaptureMessages,
      captureMessageReads: settings.agentCommunicationCaptureMessageReads,
    },
  });
}

function hashText(value) {
  const text = String(value || "");
  return text ? createHash("sha256").update(text).digest("hex") : "";
}

function getBuildingEnabled(building, settings = {}, layout = {}) {
  if (building?.install?.system) {
    return true;
  }
  const settingKey = building?.install?.enabledSetting;
  if (settingKey) {
    return Boolean(settings[settingKey]);
  }
  if (building?.source === "buildinghub") {
    const installed = Array.isArray(settings.installedPluginIds) ? settings.installedPluginIds : [];
    return installed.includes(building.id) || Boolean(layout?.functional?.[building.id]);
  }
  return Boolean(layout?.functional?.[building.id]);
}

function buildBuildingBindings(building, settings = {}) {
  const entries = [];
  for (const variable of safeArray(building?.onboarding?.variables)) {
    const setting = normalizeSettingKey(variable.setting);
    const configuredSetting = normalizeSettingKey(variable.configuredSetting);
    const sensitivity = variable.secret ? "secret" : getSettingSensitivity(setting);
    if (setting && sensitivity !== "portable") {
      entries.push({
        key: setting,
        label: variable.label || setting,
        sensitivity,
        configured: Boolean(settings[setting] || (configuredSetting && settings[configuredSetting])),
        required: Boolean(variable.required),
      });
    } else if (!setting && configuredSetting) {
      entries.push({
        key: configuredSetting,
        label: variable.label || configuredSetting,
        sensitivity: variable.secret ? "secret" : "local",
        configured: Boolean(settings[configuredSetting]),
        required: Boolean(variable.required),
      });
    }
  }
  return dedupeBindings(entries);
}

function buildBuildingSettings(building, settings = {}) {
  const portable = {};
  for (const variable of safeArray(building?.onboarding?.variables)) {
    const setting = normalizeSettingKey(variable.setting);
    if (!setting || getSettingSensitivity(setting) !== "portable") {
      continue;
    }
    const sanitized = sanitizePortableValue(settings[setting]);
    if (sanitized !== undefined) {
      portable[setting] = sanitized;
    }
  }
  const enabledSetting = normalizeSettingKey(building?.install?.enabledSetting);
  if (enabledSetting && getSettingSensitivity(enabledSetting) === "portable") {
    portable[enabledSetting] = Boolean(settings[enabledSetting]);
  }
  return portable;
}

function buildBuildingsSnapshot({ coreBuildings = [], buildingHubBuildings = [], settings = {}, layout = {} } = {}) {
  const manifests = [...safeArray(coreBuildings), ...safeArray(buildingHubBuildings)];
  return normalizeBuildings(
    manifests.map((building) => ({
      id: building.id,
      name: building.name,
      category: building.category,
      source: building.source,
      version: building.version || building.buildingHub?.version || "",
      status: building.status,
      enabled: getBuildingEnabled(building, settings, layout),
      required: Boolean(layout?.functional?.[building.id] || building?.install?.system),
      settingKey: building?.install?.enabledSetting || "",
      settings: buildBuildingSettings(building, settings),
      localBindingsRequired: buildBuildingBindings(building, settings),
    })),
  );
}

export function buildScaffoldRecipe({
  agentPrompt = {},
  app = {},
  buildingHub = {},
  coreBuildings = [],
  defaultProviderId = "claude",
  layout = null,
  library: libraryInput = {},
  name = "Current Vibe Research scaffold",
  providers = [],
  settings = {},
  tags = [],
} = {}) {
  const settingsSnapshot = buildSettingsSnapshot(settings);
  const communication = buildCommunicationSnapshot(settings);
  const selectedPromptId = agentPrompt.selectedPromptId || "researcher";
  const built = normalizeScaffoldRecipe({
    id: normalizeSlug(name, "current-scaffold") || "current-scaffold",
    name,
    version: "0.1.0",
    description: "Exported Vibe Research scaffold recipe.",
    tags,
    compatibility: {
      recipeSchema: SCAFFOLD_RECIPE_SCHEMA,
      vibeResearch: {
        version: app.version || "",
        commit: app.commit || "",
        branch: app.branch || "",
      },
    },
    buildings: buildBuildingsSnapshot({
      buildingHubBuildings: buildingHub.buildings || [],
      coreBuildings,
      layout,
      settings,
    }),
    settings: settingsSnapshot,
    communication,
    agents: {
      defaultProvider: defaultProviderId,
      allowedProviders: safeArray(providers).map((provider) => provider.id).filter(Boolean),
      defaultOccupation: selectedPromptId,
      canSpawnAgents: true,
      canCreateSubagents: true,
      maxConcurrentAgents: 6,
    },
    sandbox: {
      provider: settings.harborEnabled ? "harbor" : "local",
      isolation: "workspace",
      network: "default",
      gpu: { enabled: false, count: 0 },
    },
    permissions: {
      requireApproval: ["uses-credentials", "spends-money", "publishes-code", "sends-messages-external"],
      deny: ["writes-outside-workspace"],
    },
    library: {
      mode: "configured",
      gitCommit: libraryInput?.gitCommit || libraryInput?.commit || "",
      gitBranch: libraryInput?.gitBranch || libraryInput?.branch || "",
      gitRemoteConfigured: Boolean(settings.wikiGitRemoteUrl),
      backupEnabled: Boolean(settings.wikiGitBackupEnabled),
      localBindingsRequired: [
        { key: "wikiPath", label: "Library folder", sensitivity: "local", configured: Boolean(settings.wikiPath), required: true },
        { key: "wikiGitRemoteUrl", label: "Library git remote", sensitivity: "personal", configured: Boolean(settings.wikiGitRemoteUrl), required: false },
      ],
    },
    occupation: {
      selectedPromptId,
      label: selectedPromptId,
      editable: Boolean(agentPrompt.editable),
      promptSha256: hashText(agentPrompt.prompt),
      includeCustomPrompt: false,
    },
    layout,
    localBindingsRequired: [
      ...settingsSnapshot.localBindingsRequired,
      ...settingsSnapshot.personal,
      ...settingsSnapshot.secrets,
    ],
    redactions: [
      ...settingsSnapshot.secrets.filter((entry) => entry.configured).map((entry) => `${entry.key}: configured but not exported`),
      ...settingsSnapshot.personal.filter((entry) => entry.configured).map((entry) => `${entry.key}: personal value not exported`),
      ...settingsSnapshot.localBindingsRequired.filter((entry) => entry.configured).map((entry) => `${entry.key}: local path/value not exported`),
    ],
  });
  return {
    ...built,
    id: normalizeSlug(name, built.id) || built.id,
    updatedAt: nowIso(),
    sha256: computeRecipeDigest(built),
  };
}

function collectRecipeSettings(recipe) {
  const normalized = normalizeScaffoldRecipe(recipe);
  return {
    ...Object.fromEntries(
      normalized.buildings.flatMap((building) => Object.entries(building.settings || {})),
    ),
    ...normalized.settings.portable,
    agentCommunicationDmEnabled: normalized.communication.dm.enabled,
    agentCommunicationDmBody: normalized.communication.dm.body,
    agentCommunicationDmVisibility: normalized.communication.dm.visibility,
    agentCommunicationRequireRelatedObject: normalized.communication.dm.requireRelatedObject,
    agentCommunicationMaxThreadDepth: normalized.communication.dm.maxThreadDepth,
    agentCommunicationMaxUnrepliedPerAgent: normalized.communication.dm.maxUnrepliedPerAgent,
    agentCommunicationGroupInboxes: normalized.communication.groupInboxes.join(","),
    agentCommunicationCaptureMessages: normalized.communication.logging.captureMessages,
    agentCommunicationCaptureMessageReads: normalized.communication.logging.captureMessageReads,
  };
}

export function previewScaffoldRecipe(recipe, {
  availableBuildingIds = [],
  currentLibraryGitBranch = "",
  currentLibraryGitCommit = "",
  localBindings = {},
  settings = {},
} = {}) {
  const normalized = normalizeScaffoldRecipe(recipe);
  const available = new Set(availableBuildingIds.map((entry) => normalizeSlug(entry)).filter(Boolean));
  const settingsPatch = collectRecipeSettings(normalized);
  const settingChanges = Object.entries(settingsPatch)
    .filter(([key, value]) => JSON.stringify(settings?.[key]) !== JSON.stringify(value))
    .map(([key, value]) => ({
      key,
      currentConfigured: settings?.[key] !== undefined && settings?.[key] !== "",
      next: value,
      sensitivity: getSettingSensitivity(key),
    }));
  const missingBuildings = normalized.buildings
    .filter((building) => building.required && !available.has(building.id))
    .map((building) => ({ id: building.id, name: building.name, source: building.source }));
  const bindings = dedupeBindings([
    ...normalized.localBindingsRequired,
    ...normalized.buildings.flatMap((building) => building.localBindingsRequired || []),
    ...normalized.sandbox.localBindingsRequired,
    ...normalized.library.localBindingsRequired,
  ]).map((binding) => ({
    ...binding,
    provided: Object.prototype.hasOwnProperty.call(localBindings || {}, binding.key),
  }));
  const expectedCommit = normalized.library.gitCommit || "";
  const expectedBranch = normalized.library.gitBranch || "";
  const currentCommit = normalizeText(currentLibraryGitCommit, 160);
  const currentBranch = normalizeText(currentLibraryGitBranch, 160);
  const libraryGitState = {
    expectedCommit,
    expectedBranch,
    currentCommit,
    currentBranch,
    pinned: Boolean(expectedCommit),
    mismatch: Boolean(expectedCommit) && Boolean(currentCommit) && expectedCommit !== currentCommit,
    unknown: Boolean(expectedCommit) && !currentCommit,
  };
  return {
    ok: missingBuildings.length === 0,
    recipe: normalized,
    changes: {
      settings: settingChanges,
      layout: normalized.layout
        ? {
            functionalCount: Object.keys(normalized.layout.functional || {}).length,
            cosmeticCount: safeArray(normalized.layout.decorations).length,
            themeId: normalized.layout.themeId,
          }
        : null,
      occupation: normalized.occupation.selectedPromptId,
    },
    libraryGitState,
    missingBuildings,
    localBindingsRequired: bindings,
    redactions: normalized.redactions,
  };
}

export function createScaffoldRecipeApplyPlan(recipe, { localBindings = {} } = {}) {
  const normalized = normalizeScaffoldRecipe(recipe);
  const settingsPatch = collectRecipeSettings(normalized);
  for (const [key, value] of Object.entries(localBindings || {})) {
    const settingKey = normalizeSettingKey(key);
    const sensitivity = getSettingSensitivity(settingKey);
    if (["local", "personal", "secret"].includes(sensitivity)) {
      settingsPatch[settingKey] = sanitizePortableValue(value);
    }
  }
  return {
    recipe: normalized,
    settingsPatch: normalizePortableSettings(settingsPatch),
    localSettingsPatch: Object.fromEntries(
      Object.entries(settingsPatch).filter(([key]) => ["local", "personal", "secret"].includes(getSettingSensitivity(key))),
    ),
    layout: normalized.layout || null,
    occupation: normalized.occupation,
  };
}

async function writeJsonFile(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function normalizeStore(value = {}) {
  const recipes = safeArray(value.recipes)
    .map(normalizeScaffoldRecipe)
    .slice(0, MAX_RECIPES);
  return {
    version: STORE_VERSION,
    savedAt: normalizeText(value.savedAt, 80) || nowIso(),
    recipes,
  };
}

export class ScaffoldRecipeService {
  constructor({ stateDir, now = nowIso } = {}) {
    this.stateDir = stateDir;
    this.now = now;
    this.filePath = path.join(stateDir, STORE_FILENAME);
    this.store = normalizeStore();
  }

  async initialize() {
    try {
      const payload = JSON.parse(await readFile(this.filePath, "utf8"));
      this.store = normalizeStore(payload);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[vibe-research] scaffold recipe store load failed:", error);
      }
      this.store = normalizeStore();
      await this.persist();
    }
  }

  async persist() {
    this.store.savedAt = this.now();
    await writeJsonFile(this.filePath, this.store);
  }

  listRecipes() {
    return this.store.recipes.map((recipe) => clone(recipe));
  }

  getRecipe(recipeId) {
    const id = normalizeSlug(recipeId);
    if (!id) {
      return null;
    }
    const recipe = this.store.recipes.find((entry) => entry.id === id);
    return recipe ? clone(recipe) : null;
  }

  async saveRecipe(input = {}) {
    const recipe = normalizeScaffoldRecipe({
      ...input,
      id: input.id || input.recipeId || input.name || `recipe-${randomUUID()}`,
      updatedAt: this.now(),
    });
    const existingIndex = this.store.recipes.findIndex((entry) => entry.id === recipe.id);
    if (existingIndex >= 0) {
      this.store.recipes.splice(existingIndex, 1);
    }
    this.store.recipes = [recipe, ...this.store.recipes].slice(0, MAX_RECIPES);
    await this.persist();
    return clone(recipe);
  }

  async deleteRecipe(recipeId) {
    const id = normalizeSlug(recipeId);
    const existingIndex = this.store.recipes.findIndex((entry) => entry.id === id);
    if (existingIndex < 0) {
      const error = new Error("Scaffold recipe not found.");
      error.statusCode = 404;
      throw error;
    }
    const [recipe] = this.store.recipes.splice(existingIndex, 1);
    await this.persist();
    return clone(recipe);
  }
}

export const testInternals = {
  buildCommunicationSnapshot,
  buildSettingsSnapshot,
  collectRecipeSettings,
  computeRecipeDigest,
  normalizePortableSettings,
  normalizeScaffoldRecipe,
  normalizeSettingKey,
};
