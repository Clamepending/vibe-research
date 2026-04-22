import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  getDefaultBrowserUseProfileDir,
  getDefaultBrowserUseWorkerPath,
  normalizeBrowserUseMaxTurns,
} from "./browser-use-service.js";

const SETTINGS_FILE_VERSION = 1;
const SETTINGS_FILENAME = "settings.json";
const DEFAULT_WIKI_BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const LEGACY_WIKI_BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const execFileAsync = promisify(execFile);

function normalizeSecret(value) {
  return String(value || "").trim();
}

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
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
    return DEFAULT_WIKI_BACKUP_INTERVAL_MS;
  }

  const roundedIntervalMs = Math.round(intervalMs);
  return roundedIntervalMs === LEGACY_WIKI_BACKUP_INTERVAL_MS
    ? DEFAULT_WIKI_BACKUP_INTERVAL_MS
    : roundedIntervalMs;
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

function normalizeAgentMailMode(value) {
  return String(value || "websocket").trim() === "webhook" ? "webhook" : "websocket";
}

function normalizeAgentProviderId(value) {
  const providerId = String(value || "claude").trim().toLowerCase();
  return /^[a-z0-9_-]+$/.test(providerId) ? providerId : "claude";
}

function normalizePluginIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const pluginIds = new Set();
  value.forEach((entry) => {
    const pluginId = String(entry || "").trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9_-]*$/.test(pluginId)) {
      pluginIds.add(pluginId);
    }
  });

  return [...pluginIds].sort();
}

const AGENT_AUTOMATION_CADENCES = new Set(["hourly", "six-hours", "daily", "weekday", "weekly"]);
const AGENT_AUTOMATION_WEEKDAYS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

function normalizeAutomationTime(value) {
  const time = String(value || "").trim();
  return /^\d{2}:\d{2}$/.test(time) ? time : "09:00";
}

function normalizeAgentAutomations(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const prompt = String(entry?.prompt || "").trim();
      if (!prompt) {
        return null;
      }

      const id = String(entry?.id || "").trim().toLowerCase();
      const cadence = String(entry?.cadence || "").trim().toLowerCase();
      const weekday = String(entry?.weekday || "").trim().toLowerCase();
      const createdAt = String(entry?.createdAt || "").trim();

      return {
        cadence: AGENT_AUTOMATION_CADENCES.has(cadence) ? cadence : "daily",
        createdAt: Number.isNaN(Date.parse(createdAt)) ? new Date().toISOString() : createdAt,
        enabled: normalizeBoolean(entry?.enabled, true),
        id: /^[a-z0-9][a-z0-9_-]*$/.test(id) ? id : `automation-${randomUUID()}`,
        prompt,
        time: normalizeAutomationTime(entry?.time),
        weekday: AGENT_AUTOMATION_WEEKDAYS.has(weekday) ? weekday : "monday",
      };
    })
    .filter(Boolean);
}

function normalizeOptionalPath(value, homeDir = os.homedir()) {
  const rawValue = String(value || "").trim();
  return rawValue ? path.resolve(expandHomePath(rawValue, homeDir)) : "";
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
      agentAnthropicApiKey: "",
      agentHfToken: "",
      agentMailApiKey: String(this.env.AGENTMAIL_API_KEY || "").trim(),
      agentMailClientId: "",
      agentMailDisplayName: "Vibe Research",
      agentMailDomain: "",
      agentMailEnabled: false,
      agentMailInboxId: "",
      agentMailMode: "websocket",
      agentMailProviderId: "claude",
      agentMailUsername: "",
      agentOpenAiApiKey: "",
      browserUseAnthropicApiKey: String(this.env.ANTHROPIC_API_KEY || this.env.CLAUDE_API_KEY || "").trim(),
      browserUseBrowserPath: "",
      browserUseEnabled: false,
      browserUseHeadless: true,
      browserUseKeepTabs: false,
      browserUseMaxTurns: 50,
      browserUseModel: "",
      browserUseProfileDir: getDefaultBrowserUseProfileDir(this.homeDir),
      browserUseWorkerPath: getDefaultBrowserUseWorkerPath(this.homeDir),
      videoMemoryBaseUrl: String(
        this.env.VIDEOMEMORY_BASE_URL ||
          this.env.VIDEOMEMORY_BASE ||
          "http://127.0.0.1:5050",
      ).trim(),
      videoMemoryEnabled: false,
      videoMemoryProviderId: "claude",
      agentAutomations: [],
      installedPluginIds: [],
      preventSleepEnabled: true,
      wikiGitBackupEnabled: true,
      wikiGitRemoteBranch: "main",
      wikiGitRemoteEnabled: true,
      wikiGitRemoteName: "origin",
      wikiGitRemoteUrl: "",
      wikiBackupIntervalMs: this.defaultBackupIntervalMs,
      wikiPath: path.join(this.stateDir, "wiki"),
      wikiPathConfigured: false,
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
    const wikiPathConfigured =
      payload.wikiPathConfigured === true ||
      (payload.wikiPathConfigured === undefined && Boolean(String(payload.wikiPath || "").trim()));

    return {
      agentAnthropicApiKey:
        payload.agentAnthropicApiKey === undefined
          ? defaults.agentAnthropicApiKey
          : normalizeSecret(payload.agentAnthropicApiKey),
      agentHfToken:
        payload.agentHfToken === undefined
          ? defaults.agentHfToken
          : normalizeSecret(payload.agentHfToken),
      agentMailApiKey:
        payload.agentMailApiKey === undefined
          ? defaults.agentMailApiKey
          : String(payload.agentMailApiKey || "").trim(),
      agentMailClientId: String(payload.agentMailClientId || defaults.agentMailClientId || "").trim(),
      agentMailDisplayName: String(payload.agentMailDisplayName || defaults.agentMailDisplayName || "").trim(),
      agentMailDomain: String(payload.agentMailDomain || defaults.agentMailDomain || "").trim(),
      agentMailEnabled: normalizeBoolean(payload.agentMailEnabled, defaults.agentMailEnabled),
      agentMailInboxId: String(payload.agentMailInboxId || defaults.agentMailInboxId || "").trim(),
      agentMailMode: normalizeAgentMailMode(payload.agentMailMode || defaults.agentMailMode),
      agentMailProviderId: normalizeAgentProviderId(payload.agentMailProviderId || defaults.agentMailProviderId),
      agentMailUsername: String(payload.agentMailUsername || defaults.agentMailUsername || "").trim(),
      agentOpenAiApiKey:
        payload.agentOpenAiApiKey === undefined
          ? defaults.agentOpenAiApiKey
          : normalizeSecret(payload.agentOpenAiApiKey),
      browserUseAnthropicApiKey:
        payload.browserUseAnthropicApiKey === undefined
          ? defaults.browserUseAnthropicApiKey
          : String(payload.browserUseAnthropicApiKey || "").trim(),
      browserUseBrowserPath: normalizeOptionalPath(
        payload.browserUseBrowserPath || defaults.browserUseBrowserPath,
        this.homeDir,
      ),
      browserUseEnabled: normalizeBoolean(payload.browserUseEnabled, defaults.browserUseEnabled),
      browserUseHeadless: normalizeBoolean(payload.browserUseHeadless, defaults.browserUseHeadless),
      browserUseKeepTabs: normalizeBoolean(payload.browserUseKeepTabs, defaults.browserUseKeepTabs),
      browserUseMaxTurns: normalizeBrowserUseMaxTurns(payload.browserUseMaxTurns, defaults.browserUseMaxTurns),
      browserUseModel: String(payload.browserUseModel || defaults.browserUseModel || "").trim(),
      browserUseProfileDir: normalizeOptionalPath(
        payload.browserUseProfileDir || defaults.browserUseProfileDir,
        this.homeDir,
      ),
      browserUseWorkerPath: normalizeOptionalPath(
        payload.browserUseWorkerPath || defaults.browserUseWorkerPath,
        this.homeDir,
      ),
      videoMemoryBaseUrl: String(payload.videoMemoryBaseUrl || defaults.videoMemoryBaseUrl || "").trim(),
      videoMemoryEnabled: normalizeBoolean(payload.videoMemoryEnabled, defaults.videoMemoryEnabled),
      videoMemoryProviderId: normalizeAgentProviderId(payload.videoMemoryProviderId || defaults.videoMemoryProviderId),
      agentAutomations: normalizeAgentAutomations(payload.agentAutomations || defaults.agentAutomations),
      installedPluginIds: normalizePluginIds(payload.installedPluginIds || defaults.installedPluginIds),
      preventSleepEnabled: normalizeBoolean(
        payload.preventSleepEnabled,
        defaults.preventSleepEnabled,
      ),
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
      wikiPathConfigured,
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
        console.warn("[vibe-research] failed to load settings", error);
      }
    }

    this.settings = this.normalizeSettings(payload);
    await this.ensureWikiDirectory();
    await this.hydrateWikiGitRemoteFromRepository();
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

  async readWikiGitRemoteUrl() {
    try {
      const { stdout = "" } = await execFileAsync("git", [
        "-C",
        this.settings.wikiPath,
        "rev-parse",
        "--show-toplevel",
      ]);

      const wikiRealPath = await realpath(this.settings.wikiPath);
      if (path.resolve(stdout.trim()) !== path.resolve(wikiRealPath)) {
        return "";
      }
    } catch {
      return "";
    }

    const readRemoteUrl = async (remoteName) => {
      const { stdout = "" } = await execFileAsync("git", [
        "-C",
        this.settings.wikiPath,
        "remote",
        "get-url",
        remoteName,
      ]);
      return stdout.trim();
    };

    try {
      const remoteUrl = await readRemoteUrl(this.settings.wikiGitRemoteName || "origin");
      if (remoteUrl) {
        return remoteUrl;
      }
    } catch {
      // Missing remotes are normal for local-only wiki folders.
    }

    try {
      const { stdout = "" } = await execFileAsync("git", [
        "-C",
        this.settings.wikiPath,
        "remote",
      ]);
      const [firstRemoteName] = stdout
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);

      return firstRemoteName ? await readRemoteUrl(firstRemoteName) : "";
    } catch {
      return "";
    }
  }

  async hydrateWikiGitRemoteFromRepository() {
    if (this.settings.wikiGitRemoteUrl) {
      return false;
    }

    const remoteUrl = await this.readWikiGitRemoteUrl();
    if (!remoteUrl) {
      return false;
    }

    this.settings = {
      ...this.settings,
      wikiGitRemoteEnabled: true,
      wikiGitRemoteUrl: remoteUrl,
    };
    return true;
  }

  async update(nextSettings = {}) {
    const previousWikiPath = this.settings.wikiPath;
    const previousRemoteUrl = this.settings.wikiGitRemoteUrl;
    const mergedSettings = { ...this.settings };
    for (const [key, value] of Object.entries(nextSettings)) {
      if (value !== undefined) {
        mergedSettings[key] = value;
      }
    }

    if (nextSettings.wikiPath !== undefined && String(nextSettings.wikiPath || "").trim()) {
      mergedSettings.wikiPathConfigured = true;
    }

    this.settings = this.normalizeSettings(mergedSettings);
    await this.ensureWikiDirectory();
    const wikiPathChanged = path.resolve(previousWikiPath) !== path.resolve(this.settings.wikiPath);
    const nextRemoteUrl =
      nextSettings.wikiGitRemoteUrl === undefined
        ? undefined
        : String(nextSettings.wikiGitRemoteUrl || "").trim();
    const remoteUrlChanged = nextRemoteUrl !== undefined && nextRemoteUrl !== previousRemoteUrl;
    if (wikiPathChanged && !remoteUrlChanged) {
      this.settings.wikiGitRemoteUrl = "";
    }
    await this.hydrateWikiGitRemoteFromRepository();
    await this.save();
    return this.getState();
  }

  getState({
    agentMailStatus = null,
    backupStatus = null,
    browserUseStatus = null,
    sleepStatus = null,
    videoMemoryStatus = null,
  } = {}) {
    return {
      ...this.settings,
      agentAnthropicApiKey: "",
      agentAnthropicApiKeyConfigured: Boolean(
        this.settings.agentAnthropicApiKey ||
          this.env.ANTHROPIC_API_KEY ||
          this.env.CLAUDE_API_KEY,
      ),
      agentHfToken: "",
      agentHfTokenConfigured: Boolean(this.settings.agentHfToken || this.env.HF_TOKEN),
      agentMailApiKey: "",
      agentMailApiKeyConfigured: Boolean(this.settings.agentMailApiKey),
      agentMailStatus,
      agentOpenAiApiKey: "",
      agentOpenAiApiKeyConfigured: Boolean(this.settings.agentOpenAiApiKey || this.env.OPENAI_API_KEY),
      browserUseAnthropicApiKey: "",
      browserUseAnthropicApiKeyConfigured: Boolean(this.settings.browserUseAnthropicApiKey),
      browserUseStatus,
      videoMemoryStatus,
      wikiRelativePath: formatRelativePath(this.cwd, this.settings.wikiPath),
      wikiRelativeRoot: formatRelativePath(this.cwd, this.settings.wikiPath),
      wikiBackup: backupStatus,
      sleepPrevention: sleepStatus,
    };
  }
}

export function buildAgentCredentialEnv(settings = {}, env = process.env) {
  const nextEnv = { ...(env && typeof env === "object" ? env : process.env) };
  const anthropicApiKey = normalizeSecret(settings.agentAnthropicApiKey);
  const openAiApiKey = normalizeSecret(settings.agentOpenAiApiKey);
  const hfToken = normalizeSecret(settings.agentHfToken);

  if (anthropicApiKey) {
    nextEnv.ANTHROPIC_API_KEY = anthropicApiKey;
    if (!nextEnv.CLAUDE_API_KEY) {
      nextEnv.CLAUDE_API_KEY = anthropicApiKey;
    }
  }

  if (openAiApiKey) {
    nextEnv.OPENAI_API_KEY = openAiApiKey;
  }

  if (hfToken) {
    nextEnv.HF_TOKEN = hfToken;
  }

  return nextEnv;
}

export { DEFAULT_WIKI_BACKUP_INTERVAL_MS };
