import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const SETTINGS_FILE_VERSION = 1;
const SETTINGS_FILENAME = "settings.json";
const DEFAULT_WIKI_BACKUP_INTERVAL_MS = 10 * 60 * 1000;

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

function normalizeBoolean(value, fallback) {
  if (value === true || value === false) {
    return value;
  }

  return fallback;
}

function normalizeIntervalMs(value) {
  const intervalMs = Number(value);
  return Number.isFinite(intervalMs) && intervalMs >= 1_000
    ? Math.round(intervalMs)
    : DEFAULT_WIKI_BACKUP_INTERVAL_MS;
}

function normalizeGitRemoteName(value) {
  const remoteName = String(value || "origin").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remoteName) ? remoteName : "origin";
}

function normalizeGitBranchName(value) {
  const branchName = String(value || "main").trim();
  if (
    !branchName ||
    branchName.startsWith("-") ||
    branchName.endsWith("/") ||
    branchName.includes("..") ||
    branchName.includes("@{") ||
    /[\s~^:?*[\]\\]/.test(branchName)
  ) {
    return "main";
  }

  return branchName;
}

async function writeAtomic(filePath, payload) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function formatRelativePath(basePath, targetPath) {
  const relativePath = path.relative(basePath, targetPath);

  if (!relativePath) {
    return ".";
  }

  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath || ".";
  }

  return targetPath;
}

export class SettingsStore {
  constructor({
    cwd = process.cwd(),
    stateDir,
    env = process.env,
    homeDir = os.homedir(),
    defaultBackupIntervalMs = DEFAULT_WIKI_BACKUP_INTERVAL_MS,
  }) {
    this.cwd = cwd;
    this.defaultBackupIntervalMs = defaultBackupIntervalMs;
    this.env = env;
    this.homeDir = homeDir;
    this.stateDir = stateDir;
    this.filePath = path.join(stateDir, SETTINGS_FILENAME);
    this.settings = this.buildDefaults();
  }

  buildDefaults() {
    return {
      wikiGitBackupEnabled: true,
      wikiGitRemoteBranch: "main",
      wikiGitRemoteEnabled: false,
      wikiGitRemoteName: "origin",
      wikiGitRemoteUrl: "",
      wikiBackupIntervalMs: this.defaultBackupIntervalMs,
      wikiPath: path.join(this.stateDir, "wiki"),
    };
  }

  normalizeWikiPath(value) {
    const rawValue = String(value || "").trim();
    const expanded = expandHomePath(rawValue, this.homeDir);
    const nextPath = expanded ? path.resolve(this.cwd, expanded) : path.join(this.stateDir, "wiki");
    return nextPath;
  }

  normalizeSettings(payload = {}) {
    const defaults = this.buildDefaults();

    return {
      wikiGitBackupEnabled: normalizeBoolean(
        payload.wikiGitBackupEnabled,
        defaults.wikiGitBackupEnabled,
      ),
      wikiGitRemoteBranch: normalizeGitBranchName(
        payload.wikiGitRemoteBranch ?? defaults.wikiGitRemoteBranch,
      ),
      wikiGitRemoteEnabled: normalizeBoolean(
        payload.wikiGitRemoteEnabled,
        defaults.wikiGitRemoteEnabled,
      ),
      wikiGitRemoteName: normalizeGitRemoteName(payload.wikiGitRemoteName ?? defaults.wikiGitRemoteName),
      wikiGitRemoteUrl: String(payload.wikiGitRemoteUrl || "").trim(),
      wikiBackupIntervalMs: normalizeIntervalMs(
        payload.wikiBackupIntervalMs ?? defaults.wikiBackupIntervalMs,
      ),
      wikiPath: this.normalizeWikiPath(payload.wikiPath || defaults.wikiPath),
    };
  }

  async initialize() {
    let payload = {};

    try {
      payload = JSON.parse(await readFile(this.filePath, "utf8"));
      if (payload?.version === SETTINGS_FILE_VERSION && payload.settings) {
        payload = payload.settings;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[remote-vibes] failed to load settings", error);
      }
    }

    this.settings = this.normalizeSettings(payload);
    await this.ensureWikiDirectory();
    await this.save();
  }

  async ensureWikiDirectory() {
    await mkdir(this.settings.wikiPath, { recursive: true });
    const stats = await stat(this.settings.wikiPath);
    if (!stats.isDirectory()) {
      throw new Error(`Wiki path is not a directory: ${this.settings.wikiPath}`);
    }
  }

  async save() {
    await writeAtomic(this.filePath, {
      version: SETTINGS_FILE_VERSION,
      savedAt: new Date().toISOString(),
      settings: this.settings,
    });
  }

  async update(nextSettings = {}) {
    const mergedSettings = { ...this.settings };
    for (const [key, value] of Object.entries(nextSettings)) {
      if (value !== undefined) {
        mergedSettings[key] = value;
      }
    }

    this.settings = this.normalizeSettings(mergedSettings);
    await this.ensureWikiDirectory();
    await this.save();
    return this.getState();
  }

  getState({ backupStatus = null } = {}) {
    return {
      ...this.settings,
      wikiRelativePath: formatRelativePath(this.cwd, this.settings.wikiPath),
      wikiRelativeRoot: formatRelativePath(this.cwd, this.settings.wikiPath),
      wikiBackup: backupStatus,
    };
  }
}

export { DEFAULT_WIKI_BACKUP_INTERVAL_MS };
