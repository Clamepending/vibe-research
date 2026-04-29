import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeBuildingId } from "./client/building-sdk.js";

export const BUILDING_AGENT_GUIDES_DIRNAME = "building-guides";
export const BUILDING_AGENT_GUIDE_INDEX_FILENAME = "README.md";

function text(value) {
  return String(value ?? "").trim();
}

function oneLine(value) {
  return text(value).replace(/\s+/g, " ");
}

function sentence(value, fallback = "") {
  return oneLine(value) || fallback;
}

function bulletLines(items, renderItem) {
  const lines = items.map(renderItem).filter(Boolean);
  return lines.length ? lines : ["- None declared."];
}

function formatOptionalMeta(parts) {
  return parts.filter(Boolean).join("; ");
}

function renderSetupVariable(variable) {
  const label = sentence(variable?.label || variable?.setting || variable?.configuredSetting || variable?.value, "Variable");
  const meta = formatOptionalMeta([
    variable?.required ? "required" : "optional",
    variable?.secret ? "secret; never print its value" : "",
    variable?.setting ? `setting: ${variable.setting}` : "",
    variable?.configuredSetting ? `configured flag: ${variable.configuredSetting}` : "",
    variable?.value ? `source: ${oneLine(variable.value)}` : "",
  ]);

  return `- ${label}${meta ? ` (${meta})` : ""}`;
}

function renderSetupStep(step, index) {
  const title = sentence(step?.title, `Step ${index + 1}`);
  const detail = oneLine(step?.detail);
  const check = renderCompleteWhen(step?.completeWhen);
  return `- ${title}${detail ? `: ${detail}` : ""}${check ? ` (${check})` : ""}`;
}

function renderCompleteWhen(completeWhen) {
  if (!completeWhen || typeof completeWhen !== "object" || Array.isArray(completeWhen)) {
    return "";
  }
  if (completeWhen.type) {
    return `check: ${completeWhen.type}`;
  }
  if (completeWhen.setting) {
    return `check setting: ${completeWhen.setting}`;
  }
  if (completeWhen.configuredSetting) {
    return `check configured flag: ${completeWhen.configuredSetting}`;
  }
  if (Array.isArray(completeWhen.allConfigured) && completeWhen.allConfigured.length) {
    return `check all configured: ${completeWhen.allConfigured.join(", ")}`;
  }
  if (Array.isArray(completeWhen.anyConfigured) && completeWhen.anyConfigured.length) {
    return `check any configured: ${completeWhen.anyConfigured.join(", ")}`;
  }
  return "";
}

function renderCommand(command) {
  const label = oneLine(command?.label || command?.name);
  const commandText = oneLine(command?.command);
  const detail = oneLine(command?.detail || command?.description);
  if (!label && !commandText && !detail) {
    return "";
  }

  const head = label || commandText || "Command";
  const commandPart = commandText ? `: \`${commandText}\`` : "";
  const detailPart = detail ? ` - ${detail}` : "";
  return `- ${head}${commandPart}${detailPart}`;
}

function renderEnvVar(envVar) {
  const name = oneLine(envVar?.name || envVar?.key);
  const detail = oneLine(envVar?.detail || envVar?.description);
  if (!name && !detail) {
    return "";
  }

  return `- ${name ? `\`${name}\`` : "Environment value"}${envVar?.required ? " (required)" : ""}${detail ? ` - ${detail}` : ""}`;
}

function renderDoc(doc) {
  const label = oneLine(doc?.label || doc?.title);
  const url = oneLine(doc?.url || doc?.href);
  if (label && url) {
    return `- [${label}](${url})`;
  }
  if (url) {
    return `- ${url}`;
  }
  return label ? `- ${label}` : "";
}

function getGuide(building) {
  return building?.agentGuide && typeof building.agentGuide === "object" && !Array.isArray(building.agentGuide)
    ? building.agentGuide
    : {};
}

function getGuideSummary(building) {
  const guide = getGuide(building);
  return sentence(guide.summary || building?.description, "No summary declared.");
}

function getCapabilityCommands(building) {
  const capabilities = Array.isArray(building?.buildingHub?.capabilities) ? building.buildingHub.capabilities : [];
  return capabilities
    .filter((capability) => oneLine(capability?.command))
    .map((capability) => ({
      command: capability.command,
      detail: capability.detail,
      label: capability.name || capability.type,
    }));
}

function getGuideCommands(building) {
  const guide = getGuide(building);
  return [
    ...(Array.isArray(guide.commands) ? guide.commands : []),
    ...getCapabilityCommands(building),
  ];
}

function getGuideDocs(building) {
  const guide = getGuide(building);
  const docs = Array.isArray(guide.docs) ? [...guide.docs] : [];
  if (building?.buildingHub?.docsUrl) {
    docs.push({ label: "BuildingHub docs", url: building.buildingHub.docsUrl });
  }
  if (building?.buildingHub?.repositoryUrl) {
    docs.push({ label: "Repository", url: building.buildingHub.repositoryUrl });
  }
  return docs;
}

function getGuidePathForBuilding(building) {
  return `${normalizeBuildingId(building?.id)}.md`;
}

function sortBuildings(buildings) {
  const seenIds = new Set();
  const dedupedBuildings = [];

  for (const building of buildings) {
    const id = normalizeBuildingId(building?.id);
    if (!id || seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    dedupedBuildings.push(building);
  }

  return dedupedBuildings.sort((left, right) =>
    String(left.name || left.id).localeCompare(String(right.name || right.id)));
}

export function getBuildingAgentGuidesDir(systemRootPath) {
  return path.join(systemRootPath, BUILDING_AGENT_GUIDES_DIRNAME);
}

export function getBuildingAgentGuideIndexPath(systemRootPath) {
  return path.join(getBuildingAgentGuidesDir(systemRootPath), BUILDING_AGENT_GUIDE_INDEX_FILENAME);
}

export function getBuildingAgentGuidePath(systemRootPath, buildingId) {
  return path.join(getBuildingAgentGuidesDir(systemRootPath), `${normalizeBuildingId(buildingId)}.md`);
}

export function renderBuildingAgentGuide(building) {
  const guide = getGuide(building);
  const variables = Array.isArray(building?.onboarding?.variables) ? building.onboarding.variables : [];
  const steps = Array.isArray(building?.onboarding?.steps) ? building.onboarding.steps : [];
  const setup = Array.isArray(guide.setup) ? guide.setup : [];
  const useCases = Array.isArray(guide.useCases) ? guide.useCases : [];
  const commands = getGuideCommands(building);
  const envVars = Array.isArray(guide.env) ? guide.env : [];
  const docs = getGuideDocs(building);
  const access = building?.access && typeof building.access === "object" ? building.access : null;

  return [
    `# ${sentence(building?.name || building?.id, "Building")} Building Guide`,
    "",
    "Generated by Vibe Research. Do not put secrets in this file.",
    "",
    "## Identity",
    "",
    `- id: \`${normalizeBuildingId(building?.id)}\``,
    `- category: ${sentence(building?.category, "Building")}`,
    `- status: ${sentence(building?.status, "available")}`,
    `- source: ${sentence(building?.source, "custom")}`,
    "",
    "## Summary",
    "",
    getGuideSummary(building),
    "",
    "## When Agents Should Use It",
    "",
    ...bulletLines(useCases, (entry) => `- ${oneLine(entry)}`),
    "",
    "## Access Model",
    "",
    access
      ? `- ${sentence(access.label, "Access")}${access.detail ? `: ${oneLine(access.detail)}` : ""}`
      : "- No explicit access model declared. Inspect the setup checklist before assuming credentials or tools exist.",
    "",
    "## Setup Variables",
    "",
    ...bulletLines(variables, renderSetupVariable),
    "",
    "## Setup Steps",
    "",
    ...bulletLines([
      ...setup.map((entry) => ({ detail: entry, title: "" })),
      ...steps,
    ], renderSetupStep),
    "",
    "## Commands Agents Can Try",
    "",
    ...bulletLines(commands, renderCommand),
    "",
    "## Environment Variables",
    "",
    ...bulletLines(envVars, renderEnvVar),
    "",
    "## Docs",
    "",
    ...bulletLines(docs, renderDoc),
    "",
    "## Agent Rules",
    "",
    "- Read this guide before using the building.",
    "- Prefer the listed helper commands and environment variables over guessing.",
    "- Never write secrets, tokens, passwords, or private keys into the Library, result docs, logs, or screenshots.",
    "- If a required variable is missing, ask the human for the credential or setup decision instead of inventing it.",
    "",
  ].join("\n");
}

export function renderBuildingAgentGuideIndex(buildings, { generatedAt = new Date().toISOString() } = {}) {
  const sortedBuildings = sortBuildings(buildings);
  return [
    "# Vibe Research Building Guides",
    "",
    `Generated: ${generatedAt}`,
    "",
    "These are agent-readable manuals for the Buildings catalog. Codex, Claude Code, and shell agents receive this directory through environment variables.",
    "",
    "## Agent Entry Points",
    "",
    "- Directory: `$VIBE_RESEARCH_BUILDING_GUIDES_DIR`",
    "- Index: `$VIBE_RESEARCH_BUILDING_GUIDES_INDEX`",
    "- Open a guide with `sed -n '1,220p' \"$VIBE_RESEARCH_BUILDING_GUIDES_DIR/<building-id>.md\"`.",
    "",
    "## Programmatic install (recursive self-improvement)",
    "",
    "The `vr-mcp` CLI lets a running agent install / inspect / sync MCP buildings without escaping to a UI. Use this when an agent realizes mid-loop it needs a new tool:",
    "",
    "```",
    "vr-mcp list --json                    # what's available",
    "vr-mcp install <building-id> --json   # one-click install with progress",
    "vr-mcp status [<building-id>] --json  # current registry + handshake state",
    "vr-mcp handshake <building-id> --json # speak MCP, count tools",
    "vr-mcp tools <building-id> --json     # server name + tool count",
    "vr-mcp sync --json                    # push to ~/.claude.json + ~/.codex/config.toml",
    "vr-mcp health --json                  # bulk handshake all installed",
    "```",
    "",
    "The CLI reads `VIBE_RESEARCH_URL` (or falls back to `127.0.0.1:$VIBE_RESEARCH_PORT`). Auth-paste buildings will pause install at `auth-required` — fill the token by PATCH-ing the named setting (e.g. `mcpGithubToken`) and re-run install OR rely on the agent-config auto-sync to pick up the new value.",
    "",
    "## How To Use",
    "",
    "- Before using or setting up a building, read its guide.",
    "- Use the guide's setup variables to identify required credentials without printing secret values.",
    "- Use the guide's commands when present; otherwise treat the building as descriptive until a helper exists.",
    "- For community BuildingHub entries, trust only manifest-declared docs, capabilities, and helper commands.",
    "- For MCP-server buildings, prefer `vr-mcp install <id>` over describing install steps to the human.",
    "",
    "## Buildings",
    "",
    ...bulletLines(sortedBuildings, (building) => {
      const guidePath = getGuidePathForBuilding(building);
      return `- [${sentence(building.name || building.id, "Building")}](./${guidePath}) - ${sentence(building.category, "Building")} - ${sentence(building.status, "available")}. ${getGuideSummary(building)}`;
    }),
    "",
  ].join("\n");
}

export async function writeBuildingAgentGuides({
  buildings = [],
  generatedAt = new Date().toISOString(),
  systemRootPath,
} = {}) {
  const guidesDir = getBuildingAgentGuidesDir(systemRootPath);
  const sortedBuildings = sortBuildings(buildings);
  const expectedFiles = new Set([
    BUILDING_AGENT_GUIDE_INDEX_FILENAME,
    ...sortedBuildings.map(getGuidePathForBuilding),
  ]);

  await mkdir(guidesDir, { recursive: true });

  let existingEntries = [];
  try {
    existingEntries = await readdir(guidesDir, { withFileTypes: true });
  } catch {
    existingEntries = [];
  }

  await Promise.all(
    existingEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !expectedFiles.has(entry.name))
      .map((entry) => rm(path.join(guidesDir, entry.name), { force: true })),
  );

  await writeFile(
    path.join(guidesDir, BUILDING_AGENT_GUIDE_INDEX_FILENAME),
    renderBuildingAgentGuideIndex(sortedBuildings, { generatedAt }),
    "utf8",
  );

  const guidePaths = [];
  for (const building of sortedBuildings) {
    const filePath = path.join(guidesDir, getGuidePathForBuilding(building));
    await writeFile(filePath, renderBuildingAgentGuide(building), "utf8");
    guidePaths.push(filePath);
  }

  return {
    count: sortedBuildings.length,
    dir: guidesDir,
    guidePaths,
    indexPath: path.join(guidesDir, BUILDING_AGENT_GUIDE_INDEX_FILENAME),
  };
}
