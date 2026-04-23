import path from "node:path";
import { normalizeBuildingId } from "./client/building-sdk.js";

export const WORKSPACE_DATA_FOLDER_NAME = "vibe-research";
export const WORKSPACE_BUILDINGS_RELATIVE_PATH = path.join(WORKSPACE_DATA_FOLDER_NAME, "buildings");
export const WORKSPACE_LIBRARY_RELATIVE_PATH = path.join(WORKSPACE_BUILDINGS_RELATIVE_PATH, "library");
export const WORKSPACE_USER_RELATIVE_PATH = path.join(WORKSPACE_DATA_FOLDER_NAME, "user");

export function getBuildingWorkspaceFolderName(buildingId) {
  const normalized = normalizeBuildingId(buildingId);
  return normalized === "knowledge-base" ? "library" : normalized;
}

function resolveWorkspaceRoot({ settings, systemRootPath }) {
  const configuredWorkspaceRoot = String(settings?.workspaceRootPath || "").trim();
  if (configuredWorkspaceRoot) {
    return configuredWorkspaceRoot;
  }

  for (const configuredPath of [settings?.agentSpawnPath, settings?.wikiPath]) {
    const normalizedPath = String(configuredPath || "").trim();
    if (!normalizedPath) {
      continue;
    }

    const normalizedSegments = normalizedPath.split(/[\\/]+/);
    const dataFolderIndex = normalizedSegments.lastIndexOf(WORKSPACE_DATA_FOLDER_NAME);
    if (dataFolderIndex > 0) {
      return normalizedSegments.slice(0, dataFolderIndex).join(path.sep);
    }
  }

  return String(systemRootPath || "").trim();
}

export function getBuildingAgentWorkspacePath({
  buildingId,
  cwd = "",
  settings = {},
  systemRootPath = "",
} = {}) {
  const folderName = getBuildingWorkspaceFolderName(buildingId);
  if (!folderName) {
    return "";
  }

  const workspaceRoot = resolveWorkspaceRoot({ settings, systemRootPath });
  if (!workspaceRoot) {
    return "";
  }

  return path.join(workspaceRoot, WORKSPACE_BUILDINGS_RELATIVE_PATH, folderName);
}
