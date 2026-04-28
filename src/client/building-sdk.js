export const BUILDING_MANIFEST_VERSION = 1;

export function normalizeBuildingId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeOnboarding(onboarding) {
  if (!onboarding || typeof onboarding !== "object" || Array.isArray(onboarding)) {
    return null;
  }

  return {
    ...onboarding,
    steps: Array.isArray(onboarding.steps) ? onboarding.steps.filter(Boolean) : [],
    variables: Array.isArray(onboarding.variables) ? onboarding.variables.filter(Boolean) : [],
  };
}

const INSTALL_PLAN_STEP_KINDS = new Set([
  "command",
  "http",
  "auth-browser-cli",
  "auth-paste",
  "mcp-launch",
]);

function normalizeInstallPlanStep(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    return null;
  }

  const kind = String(step.kind || "").trim();
  if (!INSTALL_PLAN_STEP_KINDS.has(kind)) {
    return null;
  }

  const base = {
    kind,
    label: String(step.label || "").trim(),
    detail: String(step.detail || "").trim(),
  };

  if (kind === "command" || kind === "auth-browser-cli") {
    const command = String(step.command || "").trim();
    if (!command) return null;
    base.command = command;
    base.timeoutSec = Number.isFinite(step.timeoutSec) ? step.timeoutSec : 60;
    base.okExitCodes = Array.isArray(step.okExitCodes) && step.okExitCodes.length
      ? step.okExitCodes.map((value) => Number(value) | 0)
      : [0];
    base.shell = step.shell === false ? false : true;
    return base;
  }

  if (kind === "http") {
    const url = String(step.url || "").trim();
    if (!url) return null;
    base.url = url;
    base.method = String(step.method || "GET").trim().toUpperCase() || "GET";
    base.headers = step.headers && typeof step.headers === "object" ? { ...step.headers } : {};
    if (step.body !== undefined) base.body = step.body;
    base.timeoutSec = Number.isFinite(step.timeoutSec) ? step.timeoutSec : 30;
    base.captureSettings = step.captureSettings && typeof step.captureSettings === "object"
      ? { ...step.captureSettings }
      : {};
    base.okStatusCodes = Array.isArray(step.okStatusCodes) && step.okStatusCodes.length
      ? step.okStatusCodes.map((value) => Number(value) | 0)
      : [200, 201];
    return base;
  }

  if (kind === "auth-paste") {
    const setting = String(step.setting || "").trim();
    if (!setting) return null;
    base.setting = setting;
    base.setupUrl = String(step.setupUrl || "").trim();
    base.setupLabel = String(step.setupLabel || "").trim();
    return base;
  }

  if (kind === "mcp-launch") {
    const command = String(step.command || "").trim();
    if (!command) return null;
    base.command = command;
    base.args = Array.isArray(step.args) ? step.args.map((value) => String(value)) : [];
    base.env = step.env && typeof step.env === "object" ? { ...step.env } : {};
    return base;
  }

  return null;
}

function normalizeInstallPlanStepList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeInstallPlanStep).filter(Boolean);
}

function normalizeInstallPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return null;
  }

  const auth = normalizeInstallPlanStep(plan.auth);

  return {
    preflight: normalizeInstallPlanStepList(plan.preflight),
    install: normalizeInstallPlanStepList(plan.install),
    auth: auth || null,
    verify: normalizeInstallPlanStepList(plan.verify),
    mcp: normalizeInstallPlanStepList(plan.mcp),
  };
}

function normalizeInstallContract(install) {
  if (!install || typeof install !== "object" || Array.isArray(install)) {
    return {};
  }

  return {
    ...install,
    enabledSetting: String(install.enabledSetting || "").trim(),
    system: Boolean(install.system),
    storedFallback: install.storedFallback === undefined ? true : Boolean(install.storedFallback),
    plan: normalizeInstallPlan(install.plan),
  };
}

function normalizeVisualContract(visual) {
  if (!visual || typeof visual !== "object" || Array.isArray(visual)) {
    return { shape: "plugin" };
  }

  return {
    ...visual,
    logo: normalizeBuildingId(visual.logo || ""),
    shape: normalizeBuildingId(visual.shape || "plugin") || "plugin",
    specialTownPlace: Boolean(visual.specialTownPlace),
  };
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function normalizeAgentGuideCommand(command) {
  if (typeof command === "string") {
    const text = command.trim();
    return text ? { command: text, label: "", detail: "" } : null;
  }

  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return null;
  }

  const commandText = String(command.command || command.example || "").trim();
  const label = String(command.label || command.name || "").trim();
  const detail = String(command.detail || command.description || "").trim();
  if (!commandText && !label && !detail) {
    return null;
  }

  return {
    command: commandText,
    label,
    detail,
  };
}

function normalizeAgentGuideEnv(envVar) {
  if (typeof envVar === "string") {
    const name = envVar.trim();
    return name ? { name, detail: "", required: false } : null;
  }

  if (!envVar || typeof envVar !== "object" || Array.isArray(envVar)) {
    return null;
  }

  const name = String(envVar.name || envVar.key || "").trim();
  const detail = String(envVar.detail || envVar.description || "").trim();
  if (!name && !detail) {
    return null;
  }

  return {
    name,
    detail,
    required: Boolean(envVar.required),
  };
}

function normalizeAgentGuideDoc(doc) {
  if (typeof doc === "string") {
    const url = doc.trim();
    return url ? { label: "", url } : null;
  }

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return null;
  }

  const label = String(doc.label || doc.title || "").trim();
  const url = String(doc.url || doc.href || "").trim();
  if (!label && !url) {
    return null;
  }

  return { label, url };
}

function normalizeAgentGuideContract(agentGuide) {
  if (!agentGuide || typeof agentGuide !== "object" || Array.isArray(agentGuide)) {
    return {
      commands: [],
      docs: [],
      env: [],
      setup: [],
      summary: "",
      useCases: [],
    };
  }

  return {
    commands: Array.isArray(agentGuide.commands)
      ? agentGuide.commands.map(normalizeAgentGuideCommand).filter(Boolean)
      : [],
    docs: Array.isArray(agentGuide.docs)
      ? agentGuide.docs.map(normalizeAgentGuideDoc).filter(Boolean)
      : [],
    env: Array.isArray(agentGuide.env)
      ? agentGuide.env.map(normalizeAgentGuideEnv).filter(Boolean)
      : [],
    setup: normalizeStringList(agentGuide.setup),
    summary: String(agentGuide.summary || "").trim(),
    useCases: normalizeStringList(agentGuide.useCases),
  };
}

function normalizeUiContract(ui) {
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) {
    return { mode: "panel", entryView: "", workspaceView: "", sidebarTab: null };
  }

  const requestedMode = normalizeBuildingId(ui.mode || "panel");
  const mode = ["panel", "wide", "workspace"].includes(requestedMode) ? requestedMode : "panel";
  const sidebarTab = normalizeSidebarTabContract(ui.sidebarTab);

  return {
    ...ui,
    entryView: String(ui.entryView || "").trim(),
    mode,
    sidebarTab,
    workspaceView: normalizeBuildingId(ui.workspaceView || ""),
  };
}

function normalizeSidebarTabContract(sidebarTab) {
  if (sidebarTab === true) {
    return { enabled: true, label: "", meta: "" };
  }

  if (!sidebarTab || typeof sidebarTab !== "object" || Array.isArray(sidebarTab) || sidebarTab.enabled === false) {
    return null;
  }

  return {
    enabled: true,
    label: String(sidebarTab.label || "").trim(),
    meta: String(sidebarTab.meta || sidebarTab.description || "").trim(),
  };
}

export function defineBuilding(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("Building manifest must be an object.");
  }

  const id = normalizeBuildingId(manifest.id || manifest.name);
  if (!id) {
    throw new TypeError("Building manifest requires an id or name.");
  }

  const name = String(manifest.name || id).trim();
  const building = {
    manifestVersion: BUILDING_MANIFEST_VERSION,
    ...manifest,
    id,
    name,
    category: String(manifest.category || "Building").trim() || "Building",
    description: String(manifest.description || "").trim(),
    agentGuide: normalizeAgentGuideContract(manifest.agentGuide),
    install: normalizeInstallContract(manifest.install),
    onboarding: normalizeOnboarding(manifest.onboarding),
    source: String(manifest.source || "custom").trim() || "custom",
    status: String(manifest.status || "available").trim() || "available",
    ui: normalizeUiContract(manifest.ui),
    visual: normalizeVisualContract(manifest.visual),
  };

  return Object.freeze(building);
}

export function createBuildingRegistry(initialBuildings = []) {
  const buildings = new Map();

  function register(manifest) {
    const building = defineBuilding(manifest);
    buildings.set(building.id, building);
    return building;
  }

  for (const manifest of initialBuildings) {
    register(manifest);
  }

  return {
    get(id) {
      return buildings.get(normalizeBuildingId(id)) || null;
    },
    ids() {
      return [...buildings.keys()];
    },
    list() {
      return [...buildings.values()];
    },
    register,
    specialTownIds() {
      return new Set(
        [...buildings.values()]
          .filter((building) => building.visual?.specialTownPlace)
          .map((building) => building.id),
      );
    },
  };
}
