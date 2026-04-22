import os from "node:os";
import path from "node:path";

export const VIBE_RESEARCH_STATE_DIR_ENV = "VIBE_RESEARCH_STATE_DIR";
export const VIBE_RESEARCH_ROOT_ENV = "VIBE_RESEARCH_ROOT";
export const REMOTE_VIBES_STATE_DIR_ENV = "REMOTE_VIBES_STATE_DIR";
export const REMOTE_VIBES_ROOT_ENV = "REMOTE_VIBES_ROOT";
export const DEFAULT_STATE_SUBDIR = ".vibe-research";
export const LEGACY_REMOTE_VIBES_STATE_SUBDIR = ".remote-vibes";
export const VIBE_RESEARCH_SYSTEM_SUBDIR = "vibe-research-system";
export const LEGACY_REMOTE_VIBES_SYSTEM_SUBDIR = "remote-vibes-system";

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

export function getVibeResearchStateDir({
  cwd = process.cwd(),
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const configuredStateDir =
    env[VIBE_RESEARCH_STATE_DIR_ENV] ||
    env[VIBE_RESEARCH_ROOT_ENV] ||
    env[REMOTE_VIBES_STATE_DIR_ENV] ||
    env[REMOTE_VIBES_ROOT_ENV];

  if (configuredStateDir) {
    return path.resolve(cwd, expandHomePath(configuredStateDir, homeDir));
  }

  return path.join(homeDir, DEFAULT_STATE_SUBDIR);
}

export function getLegacyWorkspaceStateDir(cwd = process.cwd()) {
  return path.join(cwd, ".vibe-research");
}

export function getLegacyRemoteVibesWorkspaceStateDir(cwd = process.cwd()) {
  return path.join(cwd, LEGACY_REMOTE_VIBES_STATE_SUBDIR);
}

export function getVibeResearchSystemDir({
  cwd = process.cwd(),
  env = process.env,
  homeDir = os.homedir(),
  stateDir = null,
} = {}) {
  const resolvedStateDir = stateDir || getVibeResearchStateDir({ cwd, env, homeDir });
  return path.join(resolvedStateDir, VIBE_RESEARCH_SYSTEM_SUBDIR);
}
