import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { defineBuilding, normalizeBuildingId } from "./client/building-sdk.js";
import { SCAFFOLD_RECIPE_SCHEMA, normalizeScaffoldRecipe } from "./scaffold-recipe-service.js";

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
const MAX_BUILDINGS_PER_SOURCE = 200;
const MAX_LAYOUTS_PER_SOURCE = 200;
const MAX_RECIPES_PER_SOURCE = 200;
const MAX_TEXT_LENGTH = 2_000;
const CATALOG_FILENAMES = ["registry.json", "buildinghub.json", "catalog.json"];

function normalizeText(value, limit = MAX_TEXT_LENGTH) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 3)).trim()}...` : text;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  try {
    const url = new URL(rawValue);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function normalizeOptionalUrl(value) {
  return normalizeUrl(value) || "";
}

function normalizeCapabilities(value) {
  return safeArray(value)
    .map((capability) => {
      if (!isPlainObject(capability)) {
        return null;
      }

      const type = normalizeBuildingId(capability.type);
      const name = normalizeText(capability.name || capability.command || capability.setting || capability.env || type, 120);
      if (!type || !name) {
        return null;
      }

      return {
        type,
        name,
        command: normalizeText(capability.command, 180),
        detail: normalizeText(capability.detail || capability.description, 500),
        required: capability.required !== false,
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeOnboardingVariable(variable) {
  if (!isPlainObject(variable)) {
    return null;
  }

  const label = normalizeText(variable.label || variable.setting || variable.value, 120);
  if (!label) {
    return null;
  }

  return {
    label,
    value: normalizeText(variable.value, 500),
    setting: normalizeText(variable.setting, 120),
    configuredSetting: normalizeText(variable.configuredSetting, 120),
    required: Boolean(variable.required),
    secret: Boolean(variable.secret),
    suffix: normalizeText(variable.suffix, 40),
    setupUrl: normalizeOptionalUrl(variable.setupUrl || variable.helpUrl || variable.url),
    setupLabel: normalizeText(variable.setupLabel || variable.helpLabel, 80),
    setupHint: normalizeText(variable.setupHint || variable.help, 220),
  };
}

function normalizeCompleteWhen(completeWhen) {
  if (!isPlainObject(completeWhen)) {
    return null;
  }

  if (completeWhen.buildingAccessConfirmed) {
    return { buildingAccessConfirmed: true };
  }

  if (completeWhen.type === "installed") {
    return { type: "installed" };
  }

  if (completeWhen.setting) {
    return { setting: normalizeText(completeWhen.setting, 120) };
  }

  if (completeWhen.configuredSetting) {
    return { configuredSetting: normalizeText(completeWhen.configuredSetting, 120) };
  }

  if (Array.isArray(completeWhen.allConfigured)) {
    return {
      allConfigured: completeWhen.allConfigured
        .map((entry) => normalizeText(entry, 120))
        .filter(Boolean)
        .slice(0, 12),
    };
  }

  if (Array.isArray(completeWhen.anyConfigured)) {
    return {
      anyConfigured: completeWhen.anyConfigured
        .map((entry) => normalizeText(entry, 120))
        .filter(Boolean)
        .slice(0, 12),
    };
  }

  return null;
}

function normalizeOnboardingStep(step, index) {
  if (!isPlainObject(step)) {
    return null;
  }

  const title = normalizeText(step.title || `Step ${index + 1}`, 160);
  const detail = normalizeText(step.detail || step.description, 700);
  const setupUrl = normalizeOptionalUrl(step.setupUrl || step.helpUrl || step.url);
  const setupLabel = normalizeText(step.setupLabel || step.actionLabel || step.helpLabel, 80);
  if (!title && !detail) {
    return null;
  }

  const completeWhen = normalizeCompleteWhen(step.completeWhen);
  return {
    title,
    detail,
    ...(setupUrl ? { setupUrl } : {}),
    ...(setupLabel ? { setupLabel } : {}),
    ...(completeWhen ? { completeWhen } : {}),
  };
}

function normalizeOnboarding(onboarding) {
  if (!isPlainObject(onboarding)) {
    return {
      variables: [],
      steps: [],
    };
  }

  return {
    setupSelector: "",
    variables: safeArray(onboarding.variables).map(normalizeOnboardingVariable).filter(Boolean).slice(0, 20),
    steps: safeArray(onboarding.steps).map(normalizeOnboardingStep).filter(Boolean).slice(0, 20),
  };
}

function normalizeAccess(access) {
  if (!isPlainObject(access)) {
    return null;
  }

  const label = normalizeText(access.label || "Access", 120);
  const detail = normalizeText(access.detail || access.description, 900);
  return label || detail ? { label, detail } : null;
}

function normalizeAgentGuideCommand(command) {
  if (typeof command === "string") {
    const commandText = normalizeText(command, 220);
    return commandText ? { command: commandText, label: "", detail: "" } : null;
  }

  if (!isPlainObject(command)) {
    return null;
  }

  const commandText = normalizeText(command.command || command.example, 220);
  const label = normalizeText(command.label || command.name, 120);
  const detail = normalizeText(command.detail || command.description, 500);
  return commandText || label || detail
    ? { command: commandText, label, detail }
    : null;
}

function normalizeAgentGuideEnv(envVar) {
  if (typeof envVar === "string") {
    const name = normalizeText(envVar, 120);
    return name ? { name, detail: "", required: false } : null;
  }

  if (!isPlainObject(envVar)) {
    return null;
  }

  const name = normalizeText(envVar.name || envVar.key, 120);
  const detail = normalizeText(envVar.detail || envVar.description, 500);
  return name || detail
    ? { name, detail, required: Boolean(envVar.required) }
    : null;
}

function normalizeAgentGuideDoc(doc) {
  if (typeof doc === "string") {
    const url = normalizeOptionalUrl(doc);
    return url ? { label: "", url } : null;
  }

  if (!isPlainObject(doc)) {
    return null;
  }

  const label = normalizeText(doc.label || doc.title, 120);
  const url = normalizeOptionalUrl(doc.url || doc.href);
  return label || url ? { label, url } : null;
}

function normalizeAgentGuide(agentGuide) {
  if (!isPlainObject(agentGuide)) {
    return null;
  }

  return {
    commands: safeArray(agentGuide.commands).map(normalizeAgentGuideCommand).filter(Boolean).slice(0, 20),
    docs: safeArray(agentGuide.docs).map(normalizeAgentGuideDoc).filter(Boolean).slice(0, 12),
    env: safeArray(agentGuide.env).map(normalizeAgentGuideEnv).filter(Boolean).slice(0, 24),
    setup: safeArray(agentGuide.setup).map((entry) => normalizeText(entry, 700)).filter(Boolean).slice(0, 20),
    summary: normalizeText(agentGuide.summary, 900),
    useCases: safeArray(agentGuide.useCases).map((entry) => normalizeText(entry, 500)).filter(Boolean).slice(0, 20),
  };
}

function normalizeInstall(install) {
  const source = isPlainObject(install) ? install : {};
  return {
    enabledSetting: "",
    system: false,
    storedFallback: source.storedFallback === undefined ? true : Boolean(source.storedFallback),
  };
}

function normalizeVisual(visual) {
  const source = isPlainObject(visual) ? visual : {};
  return {
    shape: normalizeBuildingId(source.shape || "plugin") || "plugin",
    specialTownPlace: false,
  };
}

function normalizeUi(ui) {
  const source = isPlainObject(ui) ? ui : {};
  const mode = normalizeBuildingId(source.mode || "panel");
  return {
    entryView: "",
    mode: ["panel", "wide"].includes(mode) ? mode : "panel",
    sidebarTab: normalizeSidebarTab(source.sidebarTab),
    workspaceView: "",
  };
}

function normalizeSidebarTab(sidebarTab) {
  if (sidebarTab === true) {
    return { enabled: true, label: "", meta: "" };
  }

  if (!isPlainObject(sidebarTab) || sidebarTab.enabled === false) {
    return null;
  }

  return {
    enabled: true,
    label: normalizeText(sidebarTab.label, 80),
    meta: normalizeText(sidebarTab.meta || sidebarTab.description, 140),
  };
}

export function normalizeBuildingHubManifest(manifest, { sourceId = "buildinghub" } = {}) {
  if (!isPlainObject(manifest)) {
    return null;
  }

  const id = normalizeBuildingId(manifest.id || manifest.name);
  const name = normalizeText(manifest.name || id, 120);
  if (!id || !name) {
    return null;
  }

  const access = normalizeAccess(manifest.access);
  const agentGuide = normalizeAgentGuide(manifest.agentGuide);
  const building = defineBuilding({
    id,
    name,
    category: normalizeText(manifest.category || "Community", 80) || "Community",
    description: normalizeText(manifest.description, 900),
    ...(agentGuide ? { agentGuide } : {}),
    install: normalizeInstall(manifest.install),
    onboarding: normalizeOnboarding(manifest.onboarding),
    source: "buildinghub",
    status: normalizeText(manifest.status || "community", 80) || "community",
    ui: normalizeUi(manifest.ui),
    visual: normalizeVisual(manifest.visual),
    ...(access ? { access } : {}),
  });

  return {
    ...building,
    buildingHub: {
      sourceId,
      capabilities: normalizeCapabilities(manifest.capabilities),
      docsUrl: normalizeOptionalUrl(manifest.docsUrl || manifest.documentationUrl || manifest.homepage),
      iconName: normalizeBuildingId(manifest.iconName || manifest.icon),
      repositoryUrl: normalizeOptionalUrl(manifest.repositoryUrl || manifest.repoUrl || manifest.repository),
      trust: normalizeText(manifest.trust || "manifest-only", 80) || "manifest-only",
    },
    iconName: normalizeBuildingId(manifest.iconName || manifest.icon),
  };
}

function extractCatalogBuildings(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!isPlainObject(payload)) {
    return [];
  }

  if (Array.isArray(payload.buildings)) {
    return payload.buildings;
  }

  if (Array.isArray(payload.manifests)) {
    return payload.manifests;
  }

  if (Array.isArray(payload.registry?.buildings)) {
    return payload.registry.buildings;
  }

  return [];
}

function extractCatalogLayouts(payload) {
  if (!isPlainObject(payload)) {
    return [];
  }

  if (Array.isArray(payload.layouts)) {
    return payload.layouts;
  }

  if (Array.isArray(payload.blueprints)) {
    return payload.blueprints;
  }

  if (Array.isArray(payload.registry?.layouts)) {
    return payload.registry.layouts;
  }

  return [];
}

function extractCatalogRecipes(payload) {
  if (!isPlainObject(payload)) {
    return [];
  }

  if (Array.isArray(payload.recipes)) {
    return payload.recipes;
  }

  if (Array.isArray(payload.scaffolds)) {
    return payload.scaffolds;
  }

  if (Array.isArray(payload.registry?.recipes)) {
    return payload.registry.recipes;
  }

  if (Array.isArray(payload.registry?.scaffolds)) {
    return payload.registry.scaffolds;
  }

  return [];
}

function isScaffoldRecipePayload(payload) {
  return isPlainObject(payload) && (
    payload.schema === SCAFFOLD_RECIPE_SCHEMA ||
    payload.recipeSchema === SCAFFOLD_RECIPE_SCHEMA ||
    (Array.isArray(payload.buildings) && isPlainObject(payload.communication) && isPlainObject(payload.settings))
  );
}

function normalizeLayoutTags(value) {
  return [...new Set(safeArray(value).map((entry) => normalizeText(entry, 60)).filter(Boolean))].slice(0, 20);
}

function normalizeLayoutRotation(value) {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(Math.round(number)) % 2 === 1 ? 1 : 0;
}

function normalizeLayoutCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(2_000, Math.round(number))) : null;
}

function normalizeLayoutDecoration(decoration, index) {
  if (!isPlainObject(decoration)) {
    return null;
  }

  const itemId = normalizeBuildingId(decoration.itemId || decoration.kind || decoration.type);
  const x = normalizeLayoutCoordinate(decoration.x);
  const y = normalizeLayoutCoordinate(decoration.y);
  if (!itemId || x === null || y === null) {
    return null;
  }

  const normalized = {
    id: normalizeText(decoration.id || `${itemId}-${index + 1}`, 120) || `${itemId}-${index + 1}`,
    itemId,
    x,
    y,
  };
  const rotation = normalizeLayoutRotation(decoration.rotation ?? decoration.rotated);
  if (rotation) {
    normalized.rotation = rotation;
  }
  return normalized;
}

function normalizeLayoutFunctionalPlacements(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([id, placement]) => {
        const buildingId = normalizeBuildingId(id);
        if (!buildingId || !isPlainObject(placement)) {
          return null;
        }
        const x = normalizeLayoutCoordinate(placement.x);
        const y = normalizeLayoutCoordinate(placement.y);
        if (x === null || y === null) {
          return null;
        }
        const normalized = { x, y };
        const rotation = normalizeLayoutRotation(placement.rotation ?? placement.rotated);
        if (rotation) {
          normalized.rotation = rotation;
        }
        return [buildingId, normalized];
      })
      .filter(Boolean),
  );
}

function normalizeLayoutOffsetMap(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([id, offset]) => {
        const normalizedId = normalizeBuildingId(id);
        if (!normalizedId || !isPlainObject(offset)) {
          return null;
        }
        const x = normalizeLayoutCoordinate(offset.x);
        const y = normalizeLayoutCoordinate(offset.y);
        return x === null || y === null ? null : [normalizedId, { x, y }];
      })
      .filter(Boolean),
  );
}

function normalizeBuildingHubLayout(layout, { sourceId = "buildinghub" } = {}) {
  if (!isPlainObject(layout)) {
    return null;
  }

  const id = normalizeBuildingId(layout.id || layout.name);
  const name = normalizeText(layout.name || id, 120);
  const blueprint = isPlainObject(layout.layout) ? layout.layout : isPlainObject(layout.blueprint) ? layout.blueprint : {};
  const decorations = safeArray(blueprint.decorations)
    .map(normalizeLayoutDecoration)
    .filter(Boolean)
    .slice(0, 200);
  if (!id || !name || !decorations.length) {
    return null;
  }

  const normalizedLayout = {
    places: normalizeLayoutOffsetMap(blueprint.places),
    roads: normalizeLayoutOffsetMap(blueprint.roads),
    decorations,
    functional: normalizeLayoutFunctionalPlacements(blueprint.functional),
  };
  const themeId = normalizeBuildingId(blueprint.themeId || layout.themeId || "");
  if (themeId) {
    normalizedLayout.themeId = themeId;
  }
  const dogName = normalizeText(blueprint.dogName || layout.dogName, 48);
  if (dogName) {
    normalizedLayout.dogName = dogName;
  }
  const pendingFunctional = safeArray(blueprint.pendingFunctional)
    .map(normalizeBuildingId)
    .filter(Boolean)
    .slice(0, 80);
  if (pendingFunctional.length) {
    normalizedLayout.pendingFunctional = pendingFunctional;
  }

  const requiredBuildings = [...new Set(safeArray(layout.requiredBuildings)
    .map(normalizeBuildingId)
    .filter(Boolean))].slice(0, 80);

  return {
    id,
    name,
    category: normalizeText(layout.category || "Layout", 80) || "Layout",
    description: normalizeText(layout.description, 900),
    source: "buildinghub",
    status: normalizeText(layout.status || "community", 80) || "community",
    tags: normalizeLayoutTags(layout.tags || layout.keywords),
    version: normalizeText(layout.version || "0.1.0", 40) || "0.1.0",
    requiredBuildings,
    previewUrl: normalizeOptionalUrl(layout.previewUrl || layout.imageUrl || layout.screenshotUrl),
    repositoryUrl: normalizeOptionalUrl(layout.repositoryUrl || layout.repoUrl || layout.repository),
    layout: normalizedLayout,
    buildingHub: {
      sourceId,
      layoutSha256: normalizeText(layout.layoutSha256 || layout.sha256, 120),
      trust: normalizeText(layout.trust || "layout-blueprint", 80) || "layout-blueprint",
    },
  };
}

function normalizeBuildingHubRecipe(recipe, { sourceId = "buildinghub" } = {}) {
  if (!isPlainObject(recipe)) {
    return null;
  }

  const id = normalizeBuildingId(recipe.id || recipe.recipeId || recipe.name);
  const name = normalizeText(recipe.name || recipe.title || id, 120);
  if (!id || !name) {
    return null;
  }

  const normalized = normalizeScaffoldRecipe({
    ...recipe,
    id,
    name,
    source: {
      ...(isPlainObject(recipe.source) ? recipe.source : {}),
      kind: "buildinghub",
      sourceId,
      repositoryUrl: recipe.repositoryUrl || recipe.repoUrl || recipe.repository || recipe.source?.repositoryUrl,
      recipeUrl: recipe.recipeUrl || recipe.homepageUrl || recipe.url || recipe.source?.recipeUrl,
      commit: recipe.commit || recipe.source?.commit,
      commitUrl: recipe.commitUrl || recipe.source?.commitUrl,
      publishedAt: recipe.publishedAt || recipe.source?.publishedAt,
    },
  });

  return {
    ...normalized,
    source: {
      ...normalized.source,
      kind: "buildinghub",
      sourceId,
    },
  };
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function listBuildingManifestFiles(rootPath) {
  const files = [];
  const buildingsPath = path.join(rootPath, "buildings");
  let entries = [];
  try {
    entries = await readdir(buildingsPath, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const filePath = path.join(buildingsPath, entry.name, "building.json");
    try {
      const stats = await stat(filePath);
      if (stats.isFile()) {
        files.push(filePath);
      }
    } catch {
      // Missing building.json files are ignored so drafts do not break the whole catalog.
    }
  }

  return files.sort();
}

async function listLayoutManifestFiles(rootPath) {
  const files = [];
  const layoutsPath = path.join(rootPath, "layouts");
  let entries = [];
  try {
    entries = await readdir(layoutsPath, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const filePath = path.join(layoutsPath, entry.name, "layout.json");
    try {
      const stats = await stat(filePath);
      if (stats.isFile()) {
        files.push(filePath);
      }
    } catch {
      // Missing layout.json files are ignored so drafts do not break the whole catalog.
    }
  }

  return files.sort();
}

async function listRecipeManifestFiles(rootPath) {
  const files = [];
  const recipesPath = path.join(rootPath, "recipes");
  let entries = [];
  try {
    entries = await readdir(recipesPath, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const filePath = path.join(recipesPath, entry.name, "recipe.json");
    try {
      const stats = await stat(filePath);
      if (stats.isFile()) {
        files.push(filePath);
      }
    } catch {
      // Missing recipe.json files are ignored so drafts do not break the whole catalog.
    }
  }

  return files.sort();
}

async function readLocalCatalogPayloads(sourcePath) {
  const resolvedPath = path.resolve(String(sourcePath || ""));
  const stats = await stat(resolvedPath);
  if (stats.isFile()) {
    return [{ payload: await readJsonFile(resolvedPath), path: resolvedPath }];
  }

  if (!stats.isDirectory()) {
    throw new Error(`BuildingHub source is not a file or directory: ${resolvedPath}`);
  }

  const payloads = [];
  for (const filename of CATALOG_FILENAMES) {
    const filePath = path.join(resolvedPath, filename);
    try {
      const fileStats = await stat(filePath);
      if (fileStats.isFile()) {
        payloads.push({ payload: await readJsonFile(filePath), path: filePath });
        break;
      }
    } catch {
      // Try the next conventional catalog filename.
    }
  }

  for (const filePath of await listBuildingManifestFiles(resolvedPath)) {
    payloads.push({ payload: await readJsonFile(filePath), path: filePath });
  }

  for (const filePath of await listLayoutManifestFiles(resolvedPath)) {
    payloads.push({ payload: await readJsonFile(filePath), path: filePath });
  }

  for (const filePath of await listRecipeManifestFiles(resolvedPath)) {
    payloads.push({ payload: await readJsonFile(filePath), path: filePath });
  }

  if (!payloads.length) {
    throw new Error(`No BuildingHub catalog files found in ${resolvedPath}`);
  }

  return payloads;
}

function dedupeBuildings(buildings) {
  const byId = new Map();
  for (const building of buildings) {
    if (!building?.id || byId.has(building.id)) {
      continue;
    }
    byId.set(building.id, building);
  }
  return [...byId.values()].sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function dedupeLayouts(layouts) {
  const byId = new Map();
  for (const layout of layouts) {
    if (!layout?.id || byId.has(layout.id)) {
      continue;
    }
    byId.set(layout.id, layout);
  }
  return [...byId.values()].sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function dedupeRecipes(recipes) {
  const byId = new Map();
  for (const recipe of recipes) {
    if (!recipe?.id || byId.has(recipe.id)) {
      continue;
    }
    byId.set(recipe.id, recipe);
  }
  return [...byId.values()].sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

export class BuildingHubService {
  constructor({
    fetchImpl = globalThis.fetch,
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    settings = {},
  } = {}) {
    this.buildings = [];
    this.layouts = [];
    this.recipes = [];
    this.fetchImpl = fetchImpl;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.lastRefreshAt = 0;
    this.lastRefreshError = "";
    this.refreshIntervalMs = refreshIntervalMs;
    this.settings = settings || {};
    this.sources = [];
  }

  restart(settings = {}) {
    this.settings = settings || {};
    this.lastRefreshAt = 0;
  }

  isEnabled() {
    return Boolean(this.settings.buildingHubEnabled);
  }

  getConfiguredSources() {
    if (!this.isEnabled()) {
      return [];
    }

    const sources = [];
    const localPath = String(this.settings.buildingHubCatalogPath || "").trim();
    const remoteUrl = normalizeUrl(this.settings.buildingHubCatalogUrl);
    if (localPath) {
      sources.push({ id: "local", kind: "local", label: "Local BuildingHub", path: localPath });
    }
    if (remoteUrl) {
      sources.push({ id: "remote", kind: "remote", label: "Remote BuildingHub", url: remoteUrl });
    }
    return sources;
  }

  async fetchRemoteCatalog(url) {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetch is not available in this Node.js runtime.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || payload?.message || `BuildingHub request failed (${response.status})`);
      }
      return [{ payload, path: url }];
    } finally {
      clearTimeout(timeout);
    }
  }

  async readSource(source) {
    const payloads = source.kind === "remote"
      ? await this.fetchRemoteCatalog(source.url)
      : await readLocalCatalogPayloads(source.path);
    const buildings = [];
    const layouts = [];
    const recipes = [];
    for (const { payload } of payloads) {
      const recipeCandidates = extractCatalogRecipes(payload);
      const recipeList = recipeCandidates.length
        ? recipeCandidates
        : isScaffoldRecipePayload(payload) ? [payload] : [];
      for (const recipeCandidate of recipeList.slice(0, MAX_RECIPES_PER_SOURCE)) {
        const recipe = normalizeBuildingHubRecipe(recipeCandidate, { sourceId: source.id });
        if (recipe) {
          recipes.push(recipe);
        }
      }

      const candidates = extractCatalogBuildings(payload);
      const manifestList = candidates.length
        ? candidates
        : payload?.layout && payload?.id || isScaffoldRecipePayload(payload) ? [] : [payload];
      for (const manifest of manifestList.slice(0, MAX_BUILDINGS_PER_SOURCE)) {
        const building = normalizeBuildingHubManifest(manifest, { sourceId: source.id });
        if (building) {
          buildings.push(building);
        }
      }
      const layoutCandidates = extractCatalogLayouts(payload);
      const layoutList = layoutCandidates.length
        ? layoutCandidates
        : payload?.layout && payload?.id && !isScaffoldRecipePayload(payload) ? [payload] : [];
      for (const layoutCandidate of layoutList.slice(0, MAX_LAYOUTS_PER_SOURCE)) {
        const layout = normalizeBuildingHubLayout(layoutCandidate, { sourceId: source.id });
        if (layout) {
          layouts.push(layout);
        }
      }
    }
    return {
      buildings: dedupeBuildings(buildings),
      layouts: dedupeLayouts(layouts),
      recipes: dedupeRecipes(recipes),
    };
  }

  async refresh({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.refreshIntervalMs > 0 && now - this.lastRefreshAt < this.refreshIntervalMs) {
      return;
    }

    this.lastRefreshAt = now;
    const configuredSources = this.getConfiguredSources();
    const nextSources = [];
    const nextBuildings = [];
    const nextLayouts = [];
    const nextRecipes = [];
    const errors = [];

    for (const source of configuredSources) {
      try {
        const { buildings, layouts, recipes } = await this.readSource(source);
        nextSources.push({
          ...source,
          count: buildings.length,
          layoutCount: layouts.length,
          recipeCount: recipes.length,
          status: "ok",
        });
        nextBuildings.push(...buildings);
        nextLayouts.push(...layouts);
        nextRecipes.push(...recipes);
      } catch (error) {
        const message = error.message || "Could not load BuildingHub source.";
        errors.push(`${source.label}: ${message}`);
        nextSources.push({
          ...source,
          count: 0,
          layoutCount: 0,
          recipeCount: 0,
          error: message,
          status: "error",
        });
      }
    }

    this.sources = nextSources;
    this.buildings = dedupeBuildings(nextBuildings);
    this.layouts = dedupeLayouts(nextLayouts);
    this.recipes = dedupeRecipes(nextRecipes);
    this.lastRefreshError = errors.join(" ");
  }

  listBuildings() {
    return this.buildings.map((building) => ({ ...building }));
  }

  listLayouts() {
    return this.layouts.map((layout) => ({
      ...layout,
      layout: {
        ...layout.layout,
        places: Object.fromEntries(
          Object.entries(isPlainObject(layout.layout?.places) ? layout.layout.places : {})
            .map(([id, offset]) => [id, { ...offset }]),
        ),
        roads: Object.fromEntries(
          Object.entries(isPlainObject(layout.layout?.roads) ? layout.layout.roads : {})
            .map(([id, offset]) => [id, { ...offset }]),
        ),
        decorations: safeArray(layout.layout?.decorations).map((decoration) => ({ ...decoration })),
        functional: Object.fromEntries(
          Object.entries(isPlainObject(layout.layout?.functional) ? layout.layout.functional : {})
            .map(([id, placement]) => [id, { ...placement }]),
        ),
        pendingFunctional: safeArray(layout.layout?.pendingFunctional),
      },
      tags: [...layout.tags],
      requiredBuildings: [...layout.requiredBuildings],
      buildingHub: { ...layout.buildingHub },
    }));
  }

  listRecipes() {
    return this.recipes.map((recipe) => JSON.parse(JSON.stringify(recipe)));
  }

  getStatus() {
    return {
      buildingCount: this.buildings.length,
      enabled: this.isEnabled(),
      lastRefreshAt: this.lastRefreshAt ? new Date(this.lastRefreshAt).toISOString() : null,
      lastRefreshError: this.lastRefreshError,
      layoutCount: this.layouts.length,
      recipeCount: this.recipes.length,
      sources: this.sources.map((source) => ({ ...source })),
    };
  }
}

export const testInternals = {
  extractCatalogBuildings,
  extractCatalogLayouts,
  extractCatalogRecipes,
  normalizeBuildingHubRecipe,
  normalizeBuildingHubLayout,
  normalizeBuildingHubManifest,
};
