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

function normalizeInstallContract(install) {
  if (!install || typeof install !== "object" || Array.isArray(install)) {
    return {};
  }

  return {
    ...install,
    enabledSetting: String(install.enabledSetting || "").trim(),
    system: Boolean(install.system),
    storedFallback: install.storedFallback === undefined ? true : Boolean(install.storedFallback),
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
