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
import { getDefaultOttoAuthBaseUrl } from "./ottoauth-service.js";
import {
  WORKSPACE_LIBRARY_RELATIVE_PATH,
  WORKSPACE_USER_RELATIVE_PATH,
} from "./workspace-layout.js";

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

function normalizeNonNegativeCents(value, fallback = "2") {
  const rawValue = String(value ?? "").trim();
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return String(fallback);
  }
  return String(parsed);
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

function normalizeBuildingHubUrl(value) {
  const url = String(value || "").trim();
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

const AGENT_AUTOMATION_CADENCES = new Set(["hourly", "six-hours", "daily", "weekday", "weekly"]);
const AGENT_AUTOMATION_WEEKDAYS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const AGENT_AUTOMATION_TARGET_MODES = new Set(["new-agent", "existing-agent"]);

function normalizeAutomationTime(value) {
  const time = String(value || "").trim();
  return /^\d{2}:\d{2}$/.test(time) ? time : "09:00";
}

function normalizeAutomationTargetText(value, maxLength) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : "";
}

function normalizeAutomationTarget(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const rawMode = String(value.mode || "").trim().toLowerCase();
  const rawSessionId = normalizeAutomationTargetText(value.sessionId, 180);
  const mode = rawMode === "existing-agent" && rawSessionId ? "existing-agent" : "new-agent";
  const target = {
    mode: AGENT_AUTOMATION_TARGET_MODES.has(mode) ? mode : "new-agent",
  };
  const providerId = normalizeAutomationTargetText(value.providerId, 80);
  const providerLabel = normalizeAutomationTargetText(value.providerLabel, 120);
  const cwd = normalizeAutomationTargetText(value.cwd, 4096);
  const sessionName = normalizeAutomationTargetText(value.sessionName, 160);

  if (target.mode === "existing-agent") {
    target.sessionId = rawSessionId;
    if (sessionName) {
      target.sessionName = sessionName;
    }
  }
  if (providerId) {
    target.providerId = normalizeAgentProviderId(providerId);
  }
  if (providerLabel) {
    target.providerLabel = providerLabel;
  }
  if (cwd) {
    target.cwd = cwd;
  }

  return target;
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
      const target = normalizeAutomationTarget(entry?.target);

      const automation = {
        cadence: AGENT_AUTOMATION_CADENCES.has(cadence) ? cadence : "daily",
        createdAt: Number.isNaN(Date.parse(createdAt)) ? new Date().toISOString() : createdAt,
        enabled: normalizeBoolean(entry?.enabled, true),
        id: /^[a-z0-9][a-z0-9_-]*$/.test(id) ? id : `automation-${randomUUID()}`,
        prompt,
        time: normalizeAutomationTime(entry?.time),
        weekday: AGENT_AUTOMATION_WEEKDAYS.has(weekday) ? weekday : "monday",
      };
      if (target) {
        automation.target = target;
      }
      return automation;
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
    defaultAgentSpawnPath = "",
  }) {
    this.cwd = cwd;
    this.defaultBackupIntervalMs = defaultBackupIntervalMs;
    this.defaultAgentSpawnPath = defaultAgentSpawnPath;
    this.env = env;
    this.homeDir = homeDir;
    this.stateDir = stateDir;
    this.filePath = path.join(stateDir, SETTINGS_FILENAME);
    this.settings = this.buildDefaults();
  }

  buildDefaults() {
    const configuredWorkspaceRootPath = String(
      this.env.VIBE_RESEARCH_WORKSPACE_DIR || this.env.REMOTE_VIBES_WORKSPACE_DIR || "",
    ).trim();
    const configuredWikiPath = String(this.env.VIBE_RESEARCH_WIKI_DIR || this.env.REMOTE_VIBES_WIKI_DIR || "").trim();
    const configuredAgentSpawnPath = String(
      this.defaultAgentSpawnPath ||
        this.env.VIBE_RESEARCH_AGENT_SPAWN_DIR ||
        this.env.REMOTE_VIBES_AGENT_SPAWN_DIR ||
        this.env.VIBE_RESEARCH_DEFAULT_CWD ||
        this.env.REMOTE_VIBES_DEFAULT_CWD ||
        "",
    ).trim();
    const workspaceRootPath = this.normalizeWorkspaceRootPath(configuredWorkspaceRootPath || this.cwd);
    const workspacePaths = this.deriveWorkspacePaths(workspaceRootPath);

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
      buildingHubCatalogPath: String(this.env.VIBE_RESEARCH_BUILDINGHUB_PATH || "").trim(),
      buildingHubCatalogUrl: normalizeBuildingHubUrl(this.env.VIBE_RESEARCH_BUILDINGHUB_URL),
      buildingHubEnabled: false,
      ottoAuthBaseUrl: String(this.env.OTTOAUTH_BASE_URL || getDefaultOttoAuthBaseUrl()).trim(),
      ottoAuthCallbackUrl: String(this.env.OTTOAUTH_CALLBACK_URL || "").trim(),
      ottoAuthDefaultMaxChargeCents: "",
      ottoAuthEnabled: false,
      ottoAuthPrivateKey: String(this.env.OTTOAUTH_PRIVATE_KEY || "").trim(),
      ottoAuthUsername: String(this.env.OTTOAUTH_USERNAME || "").trim(),
      telegramAllowedChatIds: String(this.env.TELEGRAM_ALLOWED_CHAT_IDS || "").trim(),
      telegramBotToken: String(this.env.TELEGRAM_BOT_TOKEN || "").trim(),
      telegramEnabled: false,
      telegramProviderId: "claude",
      twilioAccountSid: String(this.env.TWILIO_ACCOUNT_SID || "").trim(),
      twilioAuthToken: String(this.env.TWILIO_AUTH_TOKEN || "").trim(),
      twilioEnabled: false,
      twilioFromNumber: String(this.env.TWILIO_FROM_NUMBER || this.env.TWILIO_PHONE_NUMBER || "").trim(),
      twilioProviderId: "claude",
      twilioSmsEstimateCents: normalizeNonNegativeCents(this.env.TWILIO_SMS_ESTIMATE_CENTS || "2", "2"),
      twilioVerifyServiceSid: String(this.env.TWILIO_VERIFY_SERVICE_SID || "").trim(),
      walletStripeSecretKey: String(
        this.env.VIBE_RESEARCH_WALLET_STRIPE_SECRET_KEY ||
          this.env.STRIPE_SECRET_KEY ||
          "",
      ).trim(),
      walletStripeWebhookSecret: String(
        this.env.VIBE_RESEARCH_WALLET_STRIPE_WEBHOOK_SECRET ||
          this.env.STRIPE_WEBHOOK_SECRET ||
          "",
      ).trim(),
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
      workspaceRootPath,
      agentSpawnPath: configuredAgentSpawnPath
        ? this.normalizeAgentSpawnPath(configuredAgentSpawnPath, workspacePaths.agentSpawnPath)
        : workspacePaths.agentSpawnPath,
      wikiPath: configuredWikiPath
        ? this.normalizeWikiPath(configuredWikiPath, workspacePaths.wikiPath)
        : workspacePaths.wikiPath,
      wikiPathConfigured: Boolean(configuredWikiPath),
    };
  }

  normalizePath(value, fallbackPath) {
    const rawValue = String(value || "").trim();
    const expanded = expandHomePath(rawValue, this.homeDir);
    return expanded ? path.resolve(this.cwd, expanded) : fallbackPath;
  }

  normalizeWorkspaceRootPath(value, fallbackPath = this.cwd) {
    return this.normalizePath(value, path.resolve(this.cwd, fallbackPath || this.cwd));
  }

  normalizeAgentSpawnPath(value, fallbackPath) {
    return this.normalizePath(value, fallbackPath);
  }

  normalizeWikiPath(value, fallbackPath = path.join(this.stateDir, "wiki")) {
    return this.normalizePath(value, fallbackPath);
  }

  deriveWorkspacePaths(workspaceRootPath) {
    const normalizedRoot = this.normalizeWorkspaceRootPath(workspaceRootPath);
    return {
      workspaceRootPath: normalizedRoot,
      agentSpawnPath: path.join(normalizedRoot, WORKSPACE_USER_RELATIVE_PATH),
      wikiPath: path.join(normalizedRoot, WORKSPACE_LIBRARY_RELATIVE_PATH),
    };
  }

  normalizeSettings(payload = {}) {
    const defaults = this.buildDefaults();
    const workspaceRootPath = this.normalizeWorkspaceRootPath(payload.workspaceRootPath || defaults.workspaceRootPath);
    const workspacePaths = this.deriveWorkspacePaths(workspaceRootPath);
    const wikiPathConfigured =
      payload.wikiPathConfigured === true ||
      (payload.wikiPathConfigured === undefined &&
        (defaults.wikiPathConfigured || Boolean(String(payload.wikiPath || payload.workspaceRootPath || "").trim())));

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
      buildingHubCatalogPath: normalizeOptionalPath(
        payload.buildingHubCatalogPath || defaults.buildingHubCatalogPath,
        this.homeDir,
      ),
      buildingHubCatalogUrl: normalizeBuildingHubUrl(payload.buildingHubCatalogUrl || defaults.buildingHubCatalogUrl),
      buildingHubEnabled: normalizeBoolean(payload.buildingHubEnabled, defaults.buildingHubEnabled),
      ottoAuthBaseUrl: String(payload.ottoAuthBaseUrl || defaults.ottoAuthBaseUrl || getDefaultOttoAuthBaseUrl()).trim(),
      ottoAuthCallbackUrl: String(payload.ottoAuthCallbackUrl || defaults.ottoAuthCallbackUrl || "").trim(),
      ottoAuthDefaultMaxChargeCents: String(
        payload.ottoAuthDefaultMaxChargeCents || defaults.ottoAuthDefaultMaxChargeCents || "",
      ).trim(),
      ottoAuthEnabled: normalizeBoolean(payload.ottoAuthEnabled, defaults.ottoAuthEnabled),
      ottoAuthPrivateKey:
        payload.ottoAuthPrivateKey === undefined
          ? defaults.ottoAuthPrivateKey
          : String(payload.ottoAuthPrivateKey || "").trim(),
      ottoAuthUsername: String(payload.ottoAuthUsername || defaults.ottoAuthUsername || "").trim(),
      telegramAllowedChatIds: String(payload.telegramAllowedChatIds || defaults.telegramAllowedChatIds || "").trim(),
      telegramBotToken:
        payload.telegramBotToken === undefined
          ? defaults.telegramBotToken
          : String(payload.telegramBotToken || "").trim(),
      telegramEnabled: normalizeBoolean(payload.telegramEnabled, defaults.telegramEnabled),
      telegramProviderId: normalizeAgentProviderId(payload.telegramProviderId || defaults.telegramProviderId),
      twilioAccountSid:
        payload.twilioAccountSid === undefined
          ? defaults.twilioAccountSid
          : String(payload.twilioAccountSid || "").trim(),
      twilioAuthToken:
        payload.twilioAuthToken === undefined
          ? defaults.twilioAuthToken
          : String(payload.twilioAuthToken || "").trim(),
      twilioEnabled: normalizeBoolean(payload.twilioEnabled, defaults.twilioEnabled),
      twilioFromNumber: String(payload.twilioFromNumber || defaults.twilioFromNumber || "").trim(),
      twilioProviderId: normalizeAgentProviderId(payload.twilioProviderId || defaults.twilioProviderId),
      twilioSmsEstimateCents: normalizeNonNegativeCents(
        payload.twilioSmsEstimateCents ?? defaults.twilioSmsEstimateCents,
        defaults.twilioSmsEstimateCents || "2",
      ),
      twilioVerifyServiceSid:
        payload.twilioVerifyServiceSid === undefined
          ? defaults.twilioVerifyServiceSid
          : String(payload.twilioVerifyServiceSid || "").trim(),
      walletStripeSecretKey:
        payload.walletStripeSecretKey === undefined
          ? defaults.walletStripeSecretKey
          : String(payload.walletStripeSecretKey || "").trim(),
      walletStripeWebhookSecret:
        payload.walletStripeWebhookSecret === undefined
          ? defaults.walletStripeWebhookSecret
          : String(payload.walletStripeWebhookSecret || "").trim(),
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
      workspaceRootPath,
      agentSpawnPath: this.normalizeAgentSpawnPath(
        payload.agentSpawnPath || defaults.agentSpawnPath,
        workspacePaths.agentSpawnPath,
      ),
      wikiPath: this.normalizeWikiPath(payload.wikiPath || defaults.wikiPath, workspacePaths.wikiPath),
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
    await this.ensureWorkspaceDirectories();
    await this.hydrateWikiGitRemoteFromRepository();
    await this.save();
  }

  async ensureWorkspaceDirectories() {
    await mkdir(this.settings.workspaceRootPath, { recursive: true });
    await mkdir(this.settings.wikiPath, { recursive: true });
    const stats = await stat(this.settings.wikiPath);
    if (!stats.isDirectory()) {
      throw new Error(`Library path is not a directory: ${this.settings.wikiPath}`);
    }

    await mkdir(this.settings.agentSpawnPath, { recursive: true });
    const agentStats = await stat(this.settings.agentSpawnPath);
    if (!agentStats.isDirectory()) {
      throw new Error(`New agent folder is not a directory: ${this.settings.agentSpawnPath}`);
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
      // Missing remotes are normal for local-only Library folders.
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

    if (nextSettings.workspaceRootPath !== undefined && String(nextSettings.workspaceRootPath || "").trim()) {
      const workspacePaths = this.deriveWorkspacePaths(nextSettings.workspaceRootPath);
      mergedSettings.workspaceRootPath = workspacePaths.workspaceRootPath;
      if (nextSettings.wikiPath === undefined) {
        mergedSettings.wikiPath = workspacePaths.wikiPath;
      }
      if (nextSettings.agentSpawnPath === undefined) {
        mergedSettings.agentSpawnPath = workspacePaths.agentSpawnPath;
      }
      mergedSettings.wikiPathConfigured = true;
    }

    if (nextSettings.wikiPath !== undefined && String(nextSettings.wikiPath || "").trim()) {
      mergedSettings.wikiPathConfigured = true;
    }

    this.settings = this.normalizeSettings(mergedSettings);
    await this.ensureWorkspaceDirectories();
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
    buildingHubStatus = null,
    ottoAuthStatus = null,
    sleepStatus = null,
    telegramStatus = null,
    twilioStatus = null,
    walletStatus = null,
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
      buildingHubStatus,
      ottoAuthPrivateKey: "",
      ottoAuthPrivateKeyConfigured: Boolean(this.settings.ottoAuthPrivateKey),
      ottoAuthStatus,
      telegramBotToken: "",
      telegramBotTokenConfigured: Boolean(this.settings.telegramBotToken),
      telegramStatus,
      twilioAccountSid: "",
      twilioAccountSidConfigured: Boolean(this.settings.twilioAccountSid),
      twilioAuthToken: "",
      twilioAuthTokenConfigured: Boolean(this.settings.twilioAuthToken),
      twilioStatus,
      twilioVerifyServiceSid: "",
      twilioVerifyServiceSidConfigured: Boolean(this.settings.twilioVerifyServiceSid),
      walletStripeSecretKey: "",
      walletStripeSecretKeyConfigured: Boolean(this.settings.walletStripeSecretKey),
      walletStripeWebhookSecret: "",
      walletStripeWebhookSecretConfigured: Boolean(this.settings.walletStripeWebhookSecret),
      walletStatus,
      videoMemoryStatus,
      wikiRelativePath: formatRelativePath(this.cwd, this.settings.wikiPath),
      wikiRelativeRoot: formatRelativePath(this.cwd, this.settings.wikiPath),
      workspaceRelativeRoot: formatRelativePath(this.cwd, this.settings.workspaceRootPath),
      agentSpawnRelativePath: formatRelativePath(this.cwd, this.settings.agentSpawnPath),
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
