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

const SETTINGS_FILE_VERSION = 1;
const SETTINGS_FILENAME = "settings.json";
const DEFAULT_WIKI_BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const LEGACY_WIKI_BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const WORKSPACE_DATA_FOLDER_NAME = "vibe-research";
const WORKSPACE_LIBRARY_RELATIVE_PATH = path.join(WORKSPACE_DATA_FOLDER_NAME, "buildings", "library");
const WORKSPACE_USER_RELATIVE_PATH = path.join(WORKSPACE_DATA_FOLDER_NAME, "user");
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

function normalizeNonNegativeCents(value, fallback = "2") {
  const rawValue = String(value ?? "").trim();
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return String(fallback);
  }
  return String(parsed);
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

function normalizeCommunicationBody(value) {
  const body = String(value || "freeform").trim().toLowerCase();
  return ["freeform", "typed", "typed-envelope"].includes(body) ? body : "freeform";
}

function normalizeCommunicationVisibility(value) {
  const visibility = String(value || "workspace").trim().toLowerCase();
  return ["workspace", "private", "public"].includes(visibility) ? visibility : "workspace";
}

function normalizeCommunicationLimit(value, fallback, { min = 0, max = 50 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeGroupInboxes(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[,\n]/);
  return Array.from(
    new Set(
      source
        .map((entry) => String(entry || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, ""))
        .filter(Boolean),
    ),
  ).slice(0, 40).join(",");
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

function normalizeBuildingHubAuthProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return provider === "google" || provider === "github" ? provider : "";
}

function normalizeBooleanEnv(value, fallback = false) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
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
    const configuredBuildingHubAppUrl = normalizeBuildingHubUrl(
      this.env.VIBE_RESEARCH_BUILDINGHUB_APP_URL || this.env.REMOTE_VIBES_BUILDINGHUB_APP_URL || "",
    );
    const configuredBuildingHubCatalogUrl = normalizeBuildingHubUrl(
      this.env.VIBE_RESEARCH_BUILDINGHUB_URL || this.env.REMOTE_VIBES_BUILDINGHUB_URL || "",
    );
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
      agentCommunicationCaptureMessageReads: true,
      agentCommunicationCaptureMessages: true,
      agentCommunicationDmBody: "freeform",
      agentCommunicationDmEnabled: false,
      agentCommunicationDmVisibility: "workspace",
      agentCommunicationGroupInboxes: "resource-hall,reviews",
      agentCommunicationMaxThreadDepth: 6,
      agentCommunicationMaxUnrepliedPerAgent: 3,
      agentCommunicationRequireRelatedObject: false,
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
      buildingHubAppUrl: configuredBuildingHubAppUrl,
      buildingHubAuthProvider: normalizeBuildingHubAuthProvider(this.env.VIBE_RESEARCH_BUILDINGHUB_AUTH_PROVIDER || ""),
      buildingHubCatalogPath: String(this.env.VIBE_RESEARCH_BUILDINGHUB_PATH || "").trim(),
      buildingHubCatalogUrl: configuredBuildingHubCatalogUrl,
      buildingHubEnabled: normalizeBooleanEnv(
        this.env.VIBE_RESEARCH_BUILDINGHUB_ENABLED || this.env.REMOTE_VIBES_BUILDINGHUB_ENABLED || "",
        Boolean(configuredBuildingHubAppUrl || configuredBuildingHubCatalogUrl || this.env.VIBE_RESEARCH_BUILDINGHUB_PATH),
      ),
      buildingHubProfileUrl: normalizeBuildingHubUrl(this.env.VIBE_RESEARCH_BUILDINGHUB_PROFILE_URL || ""),
      githubOAuthClientId: String(
        this.env.VIBE_RESEARCH_GITHUB_OAUTH_CLIENT_ID ||
          this.env.REMOTE_VIBES_GITHUB_OAUTH_CLIENT_ID ||
          this.env.GITHUB_OAUTH_CLIENT_ID ||
          "",
      ).trim(),
      githubOAuthClientSecret: String(
        this.env.VIBE_RESEARCH_GITHUB_OAUTH_CLIENT_SECRET ||
          this.env.REMOTE_VIBES_GITHUB_OAUTH_CLIENT_SECRET ||
          this.env.GITHUB_OAUTH_CLIENT_SECRET ||
          "",
      ).trim(),
      googleOAuthClientId: String(
        this.env.VIBE_RESEARCH_GOOGLE_OAUTH_CLIENT_ID ||
          this.env.REMOTE_VIBES_GOOGLE_OAUTH_CLIENT_ID ||
          this.env.GOOGLE_OAUTH_CLIENT_ID ||
          "",
      ).trim(),
      googleOAuthClientSecret: String(
        this.env.VIBE_RESEARCH_GOOGLE_OAUTH_CLIENT_SECRET ||
          this.env.REMOTE_VIBES_GOOGLE_OAUTH_CLIENT_SECRET ||
          this.env.GOOGLE_OAUTH_CLIENT_SECRET ||
          "",
      ).trim(),
      modalEnabled: false,
      runpodEnabled: false,
      harborEnabled: false,
      // How often the background MCP health scheduler runs `checkAll`.
      // Clamped to [30, 3600] seconds at normalize time. Default 300s
      // (5 minutes). Setting is read by the scheduler on every tick so
      // a change takes effect on the next scheduled fire.
      mcpHealthCheckIntervalSec: 300,
      // Popular MCP-server buildings: each has an enabled flag + a secret/config setting.
      mcpFilesystemEnabled: false,
      mcpFilesystemRoots: String(this.env.MCP_FILESYSTEM_ROOTS || "").trim(),
      mcpGithubEnabled: false,
      mcpGithubToken: String(this.env.MCP_GITHUB_TOKEN || this.env.GITHUB_PERSONAL_ACCESS_TOKEN || "").trim(),
      mcpPostgresEnabled: false,
      mcpPostgresUrl: String(this.env.MCP_POSTGRES_URL || this.env.DATABASE_URL || "").trim(),
      mcpSqliteEnabled: false,
      mcpSqliteDbPath: String(this.env.MCP_SQLITE_DB_PATH || "").trim(),
      mcpBraveSearchEnabled: false,
      mcpBraveSearchApiKey: String(this.env.MCP_BRAVE_SEARCH_API_KEY || this.env.BRAVE_API_KEY || "").trim(),
      mcpSlackEnabled: false,
      mcpSlackBotToken: String(this.env.MCP_SLACK_BOT_TOKEN || this.env.SLACK_BOT_TOKEN || "").trim(),
      mcpSlackTeamId: String(this.env.MCP_SLACK_TEAM_ID || this.env.SLACK_TEAM_ID || "").trim(),
      mcpSentryEnabled: false,
      mcpSentryAuthToken: String(this.env.MCP_SENTRY_AUTH_TOKEN || this.env.SENTRY_AUTH_TOKEN || "").trim(),
      mcpNotionEnabled: false,
      mcpNotionToken: String(this.env.MCP_NOTION_TOKEN || this.env.NOTION_INTEGRATION_TOKEN || "").trim(),
      mcpLinearEnabled: false,
      mcpLinearApiKey: String(this.env.MCP_LINEAR_API_KEY || this.env.LINEAR_API_KEY || "").trim(),
      // Anthropic-maintained AWS Bedrock Knowledge Base retrieval MCP.
      // The launch reads AWS_REGION + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
      // from process.env (so set them in the user's shell or AWS profile);
      // KB ID comes from this setting.
      mcpAwsKbEnabled: false,
      mcpAwsKbId: String(this.env.MCP_AWS_KB_ID || this.env.KNOWLEDGE_BASE_ID || "").trim(),
      // Kubernetes MCP — uses kubectl config from ~/.kube/config; no
      // explicit token needed (relies on whichever auth method kubectl
      // is already set up for).
      mcpKubernetesEnabled: false,
      // Obsidian MCP — needs the Local REST API plugin's API key + the
      // vault path the agent should be allowed to read/write.
      mcpObsidianEnabled: false,
      mcpObsidianApiKey: String(this.env.MCP_OBSIDIAN_API_KEY || this.env.OBSIDIAN_API_KEY || "").trim(),
      mcpObsidianVaultPath: String(this.env.MCP_OBSIDIAN_VAULT_PATH || "").trim(),
      // CircleCI MCP — maintained by CircleCI engineers. Reads token
      // from CIRCLECI_TOKEN.
      mcpCircleciEnabled: false,
      mcpCircleciToken: String(this.env.MCP_CIRCLECI_TOKEN || this.env.CIRCLECI_TOKEN || "").trim(),
      // Airtable MCP — solo-maintained by domdomegg (also gmail-mcp).
      // Reads AIRTABLE_API_KEY (personal access token).
      mcpAirtableEnabled: false,
      mcpAirtableApiKey: String(this.env.MCP_AIRTABLE_API_KEY || this.env.AIRTABLE_API_KEY || "").trim(),
      // Datadog MCP — needs both API key + APP key.
      mcpDatadogEnabled: false,
      mcpDatadogApiKey: String(this.env.MCP_DATADOG_API_KEY || this.env.DD_API_KEY || "").trim(),
      mcpDatadogAppKey: String(this.env.MCP_DATADOG_APP_KEY || this.env.DD_APP_KEY || "").trim(),
      mcpDatadogSite: String(this.env.MCP_DATADOG_SITE || this.env.DD_SITE || "datadoghq.com").trim(),
      // Second wave of MCP-server buildings (auth-paste only; npm packages
      // verified against the live registry on 2026-04-28).
      mcpPuppeteerEnabled: false,
      mcpMemoryEnabled: false,
      mcpRedisEnabled: false,
      mcpRedisUrl: String(this.env.MCP_REDIS_URL || this.env.REDIS_URL || "").trim(),
      mcpGitlabEnabled: false,
      mcpGitlabToken: String(this.env.MCP_GITLAB_TOKEN || this.env.GITLAB_PERSONAL_ACCESS_TOKEN || "").trim(),
      mcpGitlabUrl: String(this.env.MCP_GITLAB_URL || this.env.GITLAB_API_URL || "https://gitlab.com/api/v4").trim(),
      mcpGoogleMapsEnabled: false,
      mcpGoogleMapsApiKey: String(this.env.MCP_GOOGLE_MAPS_API_KEY || this.env.GOOGLE_MAPS_API_KEY || "").trim(),
      mcpEverythingEnabled: false,
      mcpStripeEnabled: false,
      mcpStripeApiKey: String(this.env.MCP_STRIPE_API_KEY || this.env.STRIPE_SECRET_KEY || "").trim(),
      mcpMongodbEnabled: false,
      mcpMongodbUri: String(this.env.MCP_MONGODB_URI || this.env.MONGODB_URI || "").trim(),
      mcpCloudflareEnabled: false,
      mcpCloudflareApiToken: String(this.env.MCP_CLOUDFLARE_API_TOKEN || this.env.CLOUDFLARE_API_TOKEN || "").trim(),
      mcpTavilyEnabled: false,
      mcpTavilyApiKey: String(this.env.MCP_TAVILY_API_KEY || this.env.TAVILY_API_KEY || "").trim(),
      mcpExaEnabled: false,
      mcpExaApiKey: String(this.env.MCP_EXA_API_KEY || this.env.EXA_API_KEY || "").trim(),
      mcpFirecrawlEnabled: false,
      mcpFirecrawlApiKey: String(this.env.MCP_FIRECRAWL_API_KEY || this.env.FIRECRAWL_API_KEY || "").trim(),
      mcpHubspotEnabled: false,
      mcpHubspotPrivateAppToken: String(this.env.MCP_HUBSPOT_TOKEN || this.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim(),
      // Third wave (2026-04-28): Apify, Pinecone, Supabase, Twilio (alpha),
      // Confluence, E2B, Perplexity, Neon, Playwright. All npm packages
      // verified live before adding the manifest.
      mcpApifyEnabled: false,
      mcpApifyToken: String(this.env.MCP_APIFY_TOKEN || this.env.APIFY_TOKEN || "").trim(),
      mcpPineconeEnabled: false,
      mcpPineconeApiKey: String(this.env.MCP_PINECONE_API_KEY || this.env.PINECONE_API_KEY || "").trim(),
      mcpSupabaseEnabled: false,
      mcpSupabaseAccessToken: String(this.env.MCP_SUPABASE_ACCESS_TOKEN || this.env.SUPABASE_ACCESS_TOKEN || "").trim(),
      mcpTwilioEnabled: false,
      mcpTwilioAccountSid: String(this.env.MCP_TWILIO_ACCOUNT_SID || this.env.TWILIO_ACCOUNT_SID || "").trim(),
      mcpTwilioAuthToken: String(this.env.MCP_TWILIO_AUTH_TOKEN || this.env.TWILIO_AUTH_TOKEN || "").trim(),
      mcpConfluenceEnabled: false,
      mcpConfluenceUrl: String(this.env.MCP_CONFLUENCE_URL || this.env.CONFLUENCE_URL || "").trim(),
      mcpConfluenceUsername: String(this.env.MCP_CONFLUENCE_USERNAME || this.env.CONFLUENCE_USERNAME || "").trim(),
      mcpConfluenceApiToken: String(this.env.MCP_CONFLUENCE_API_TOKEN || this.env.CONFLUENCE_API_TOKEN || "").trim(),
      mcpE2bEnabled: false,
      mcpE2bApiKey: String(this.env.MCP_E2B_API_KEY || this.env.E2B_API_KEY || "").trim(),
      mcpPerplexityEnabled: false,
      mcpPerplexityApiKey: String(this.env.MCP_PERPLEXITY_API_KEY || this.env.PERPLEXITY_API_KEY || "").trim(),
      mcpNeonEnabled: false,
      mcpNeonApiKey: String(this.env.MCP_NEON_API_KEY || this.env.NEON_API_KEY || "").trim(),
      mcpPlaywrightEnabled: false,
      // Fourth wave (2026-04-28): Replicate, Vercel, Axiom, Upstash, Spotify.
      mcpReplicateEnabled: false,
      mcpReplicateApiToken: String(this.env.MCP_REPLICATE_API_TOKEN || this.env.REPLICATE_API_TOKEN || "").trim(),
      mcpVercelEnabled: false,
      mcpVercelApiToken: String(this.env.MCP_VERCEL_API_TOKEN || this.env.VERCEL_TOKEN || "").trim(),
      mcpAxiomEnabled: false,
      mcpAxiomToken: String(this.env.MCP_AXIOM_TOKEN || this.env.AXIOM_TOKEN || "").trim(),
      mcpAxiomOrgId: String(this.env.MCP_AXIOM_ORG_ID || this.env.AXIOM_ORG_ID || "").trim(),
      mcpUpstashEnabled: false,
      mcpUpstashEmail: String(this.env.MCP_UPSTASH_EMAIL || this.env.UPSTASH_EMAIL || "").trim(),
      mcpUpstashApiKey: String(this.env.MCP_UPSTASH_API_KEY || this.env.UPSTASH_API_KEY || "").trim(),
      mcpSpotifyEnabled: false,
      mcpSpotifyClientId: String(this.env.MCP_SPOTIFY_CLIENT_ID || this.env.SPOTIFY_CLIENT_ID || "").trim(),
      mcpSpotifyClientSecret: String(this.env.MCP_SPOTIFY_CLIENT_SECRET || this.env.SPOTIFY_CLIENT_SECRET || "").trim(),
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
      videoMemoryAnthropicApiKey: String(
        this.env.VIDEOMEMORY_ANTHROPIC_API_KEY ||
          this.env.ANTHROPIC_API_KEY ||
          this.env.CLAUDE_API_KEY ||
          "",
      ).trim(),
      videoMemoryBaseUrl: String(
        this.env.VIDEOMEMORY_BASE_URL ||
          this.env.VIDEOMEMORY_BASE ||
          "http://127.0.0.1:5050",
      ).trim(),
      videoMemoryEnabled: false,
      videoMemoryLaunchCommand: String(
        this.env.VIDEOMEMORY_LAUNCH_COMMAND ||
          "",
      ).trim(),
      videoMemoryLaunchCwd: String(
        this.env.VIDEOMEMORY_LAUNCH_CWD ||
          "",
      ).trim(),
      videoMemoryProviderId: "claude",
      agentAutomations: [],
      buildingAccessConfirmedIds: [],
      installedPluginIds: [],
      preventSleepEnabled: true,
      // The Library is just a folder of markdown notes by default. Beginners
      // don't need a git history of every change unless they explicitly opt
      // in via "Link GitHub" in the Library UI.
      wikiGitBackupEnabled: false,
      wikiGitRemoteBranch: "main",
      wikiGitRemoteEnabled: false,
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
      agentCommunicationCaptureMessageReads: normalizeBoolean(
        payload.agentCommunicationCaptureMessageReads,
        defaults.agentCommunicationCaptureMessageReads,
      ),
      agentCommunicationCaptureMessages: normalizeBoolean(
        payload.agentCommunicationCaptureMessages,
        defaults.agentCommunicationCaptureMessages,
      ),
      agentCommunicationDmBody: normalizeCommunicationBody(
        payload.agentCommunicationDmBody || defaults.agentCommunicationDmBody,
      ),
      agentCommunicationDmEnabled: normalizeBoolean(
        payload.agentCommunicationDmEnabled,
        defaults.agentCommunicationDmEnabled,
      ),
      agentCommunicationDmVisibility: normalizeCommunicationVisibility(
        payload.agentCommunicationDmVisibility || defaults.agentCommunicationDmVisibility,
      ),
      agentCommunicationGroupInboxes: normalizeGroupInboxes(
        payload.agentCommunicationGroupInboxes || defaults.agentCommunicationGroupInboxes,
      ),
      agentCommunicationMaxThreadDepth: normalizeCommunicationLimit(
        payload.agentCommunicationMaxThreadDepth,
        defaults.agentCommunicationMaxThreadDepth,
        { min: 1, max: 50 },
      ),
      agentCommunicationMaxUnrepliedPerAgent: normalizeCommunicationLimit(
        payload.agentCommunicationMaxUnrepliedPerAgent,
        defaults.agentCommunicationMaxUnrepliedPerAgent,
        { min: 0, max: 50 },
      ),
      agentCommunicationRequireRelatedObject: normalizeBoolean(
        payload.agentCommunicationRequireRelatedObject,
        defaults.agentCommunicationRequireRelatedObject,
      ),
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
      buildingHubAuthProvider:
        payload.buildingHubAuthProvider === undefined
          ? defaults.buildingHubAuthProvider
          : normalizeBuildingHubAuthProvider(payload.buildingHubAuthProvider),
      buildingHubAppUrl: normalizeBuildingHubUrl(
        payload.buildingHubAppUrl === undefined ? defaults.buildingHubAppUrl : payload.buildingHubAppUrl,
      ),
      buildingHubCatalogPath: normalizeOptionalPath(
        payload.buildingHubCatalogPath || defaults.buildingHubCatalogPath,
        this.homeDir,
      ),
      buildingHubCatalogUrl: normalizeBuildingHubUrl(payload.buildingHubCatalogUrl || defaults.buildingHubCatalogUrl),
      buildingHubEnabled: normalizeBoolean(payload.buildingHubEnabled, defaults.buildingHubEnabled),
      buildingHubProfileUrl:
        payload.buildingHubProfileUrl === undefined
          ? defaults.buildingHubProfileUrl
          : normalizeBuildingHubUrl(payload.buildingHubProfileUrl),
      githubOAuthClientId: String(payload.githubOAuthClientId || defaults.githubOAuthClientId || "").trim(),
      githubOAuthClientSecret:
        payload.githubOAuthClientSecret === undefined
          ? defaults.githubOAuthClientSecret
          : String(payload.githubOAuthClientSecret || "").trim(),
      googleOAuthClientId: String(payload.googleOAuthClientId || defaults.googleOAuthClientId || "").trim(),
      googleOAuthClientSecret:
        payload.googleOAuthClientSecret === undefined
          ? defaults.googleOAuthClientSecret
          : String(payload.googleOAuthClientSecret || "").trim(),
      ottoAuthBaseUrl: String(payload.ottoAuthBaseUrl || defaults.ottoAuthBaseUrl || getDefaultOttoAuthBaseUrl()).trim(),
      ottoAuthCallbackUrl: String(payload.ottoAuthCallbackUrl || defaults.ottoAuthCallbackUrl || "").trim(),
      ottoAuthDefaultMaxChargeCents: String(
        payload.ottoAuthDefaultMaxChargeCents || defaults.ottoAuthDefaultMaxChargeCents || "",
      ).trim(),
      modalEnabled: normalizeBoolean(payload.modalEnabled, defaults.modalEnabled),
      runpodEnabled: normalizeBoolean(payload.runpodEnabled, defaults.runpodEnabled),
      harborEnabled: normalizeBoolean(payload.harborEnabled, defaults.harborEnabled),
      mcpHealthCheckIntervalSec: (() => {
        const raw = payload.mcpHealthCheckIntervalSec ?? defaults.mcpHealthCheckIntervalSec;
        const numeric = Number(raw);
        if (!Number.isFinite(numeric)) return defaults.mcpHealthCheckIntervalSec || 300;
        // Clamp to a sane window: 30s lower bound (avoid hammering the
        // MCP servers), 1h upper bound (broken servers shouldn't sit
        // unnoticed for longer than that).
        if (numeric < 30) return 30;
        if (numeric > 3600) return 3600;
        return Math.round(numeric);
      })(),
      mcpFilesystemEnabled: normalizeBoolean(payload.mcpFilesystemEnabled, defaults.mcpFilesystemEnabled),
      mcpFilesystemRoots:
        payload.mcpFilesystemRoots === undefined
          ? defaults.mcpFilesystemRoots
          : String(payload.mcpFilesystemRoots || "").trim(),
      mcpGithubEnabled: normalizeBoolean(payload.mcpGithubEnabled, defaults.mcpGithubEnabled),
      mcpGithubToken:
        payload.mcpGithubToken === undefined
          ? defaults.mcpGithubToken
          : String(payload.mcpGithubToken || "").trim(),
      mcpPostgresEnabled: normalizeBoolean(payload.mcpPostgresEnabled, defaults.mcpPostgresEnabled),
      mcpPostgresUrl:
        payload.mcpPostgresUrl === undefined
          ? defaults.mcpPostgresUrl
          : String(payload.mcpPostgresUrl || "").trim(),
      mcpSqliteEnabled: normalizeBoolean(payload.mcpSqliteEnabled, defaults.mcpSqliteEnabled),
      mcpSqliteDbPath:
        payload.mcpSqliteDbPath === undefined
          ? defaults.mcpSqliteDbPath
          : String(payload.mcpSqliteDbPath || "").trim(),
      mcpBraveSearchEnabled: normalizeBoolean(payload.mcpBraveSearchEnabled, defaults.mcpBraveSearchEnabled),
      mcpBraveSearchApiKey:
        payload.mcpBraveSearchApiKey === undefined
          ? defaults.mcpBraveSearchApiKey
          : String(payload.mcpBraveSearchApiKey || "").trim(),
      mcpSlackEnabled: normalizeBoolean(payload.mcpSlackEnabled, defaults.mcpSlackEnabled),
      mcpSlackBotToken:
        payload.mcpSlackBotToken === undefined
          ? defaults.mcpSlackBotToken
          : String(payload.mcpSlackBotToken || "").trim(),
      mcpSlackTeamId:
        payload.mcpSlackTeamId === undefined
          ? defaults.mcpSlackTeamId
          : String(payload.mcpSlackTeamId || "").trim(),
      mcpSentryEnabled: normalizeBoolean(payload.mcpSentryEnabled, defaults.mcpSentryEnabled),
      mcpSentryAuthToken:
        payload.mcpSentryAuthToken === undefined
          ? defaults.mcpSentryAuthToken
          : String(payload.mcpSentryAuthToken || "").trim(),
      mcpNotionEnabled: normalizeBoolean(payload.mcpNotionEnabled, defaults.mcpNotionEnabled),
      mcpNotionToken:
        payload.mcpNotionToken === undefined
          ? defaults.mcpNotionToken
          : String(payload.mcpNotionToken || "").trim(),
      mcpLinearEnabled: normalizeBoolean(payload.mcpLinearEnabled, defaults.mcpLinearEnabled),
      mcpLinearApiKey:
        payload.mcpLinearApiKey === undefined
          ? defaults.mcpLinearApiKey
          : String(payload.mcpLinearApiKey || "").trim(),
      mcpAwsKbEnabled: normalizeBoolean(payload.mcpAwsKbEnabled, defaults.mcpAwsKbEnabled),
      mcpAwsKbId:
        payload.mcpAwsKbId === undefined
          ? defaults.mcpAwsKbId
          : String(payload.mcpAwsKbId || "").trim(),
      mcpKubernetesEnabled: normalizeBoolean(payload.mcpKubernetesEnabled, defaults.mcpKubernetesEnabled),
      mcpObsidianEnabled: normalizeBoolean(payload.mcpObsidianEnabled, defaults.mcpObsidianEnabled),
      mcpObsidianApiKey:
        payload.mcpObsidianApiKey === undefined
          ? defaults.mcpObsidianApiKey
          : String(payload.mcpObsidianApiKey || "").trim(),
      mcpObsidianVaultPath:
        payload.mcpObsidianVaultPath === undefined
          ? defaults.mcpObsidianVaultPath
          : String(payload.mcpObsidianVaultPath || "").trim(),
      mcpCircleciEnabled: normalizeBoolean(payload.mcpCircleciEnabled, defaults.mcpCircleciEnabled),
      mcpCircleciToken:
        payload.mcpCircleciToken === undefined
          ? defaults.mcpCircleciToken
          : String(payload.mcpCircleciToken || "").trim(),
      mcpAirtableEnabled: normalizeBoolean(payload.mcpAirtableEnabled, defaults.mcpAirtableEnabled),
      mcpAirtableApiKey:
        payload.mcpAirtableApiKey === undefined
          ? defaults.mcpAirtableApiKey
          : String(payload.mcpAirtableApiKey || "").trim(),
      mcpDatadogEnabled: normalizeBoolean(payload.mcpDatadogEnabled, defaults.mcpDatadogEnabled),
      mcpDatadogApiKey:
        payload.mcpDatadogApiKey === undefined
          ? defaults.mcpDatadogApiKey
          : String(payload.mcpDatadogApiKey || "").trim(),
      mcpDatadogAppKey:
        payload.mcpDatadogAppKey === undefined
          ? defaults.mcpDatadogAppKey
          : String(payload.mcpDatadogAppKey || "").trim(),
      mcpDatadogSite:
        payload.mcpDatadogSite === undefined
          ? defaults.mcpDatadogSite
          : String(payload.mcpDatadogSite || "").trim(),
      mcpPuppeteerEnabled: normalizeBoolean(payload.mcpPuppeteerEnabled, defaults.mcpPuppeteerEnabled),
      mcpMemoryEnabled: normalizeBoolean(payload.mcpMemoryEnabled, defaults.mcpMemoryEnabled),
      mcpRedisEnabled: normalizeBoolean(payload.mcpRedisEnabled, defaults.mcpRedisEnabled),
      mcpRedisUrl:
        payload.mcpRedisUrl === undefined
          ? defaults.mcpRedisUrl
          : String(payload.mcpRedisUrl || "").trim(),
      mcpGitlabEnabled: normalizeBoolean(payload.mcpGitlabEnabled, defaults.mcpGitlabEnabled),
      mcpGitlabToken:
        payload.mcpGitlabToken === undefined
          ? defaults.mcpGitlabToken
          : String(payload.mcpGitlabToken || "").trim(),
      mcpGitlabUrl:
        payload.mcpGitlabUrl === undefined
          ? defaults.mcpGitlabUrl
          : String(payload.mcpGitlabUrl || "").trim(),
      mcpGoogleMapsEnabled: normalizeBoolean(payload.mcpGoogleMapsEnabled, defaults.mcpGoogleMapsEnabled),
      mcpGoogleMapsApiKey:
        payload.mcpGoogleMapsApiKey === undefined
          ? defaults.mcpGoogleMapsApiKey
          : String(payload.mcpGoogleMapsApiKey || "").trim(),
      mcpEverythingEnabled: normalizeBoolean(payload.mcpEverythingEnabled, defaults.mcpEverythingEnabled),
      mcpStripeEnabled: normalizeBoolean(payload.mcpStripeEnabled, defaults.mcpStripeEnabled),
      mcpStripeApiKey:
        payload.mcpStripeApiKey === undefined
          ? defaults.mcpStripeApiKey
          : String(payload.mcpStripeApiKey || "").trim(),
      mcpMongodbEnabled: normalizeBoolean(payload.mcpMongodbEnabled, defaults.mcpMongodbEnabled),
      mcpMongodbUri:
        payload.mcpMongodbUri === undefined
          ? defaults.mcpMongodbUri
          : String(payload.mcpMongodbUri || "").trim(),
      mcpCloudflareEnabled: normalizeBoolean(payload.mcpCloudflareEnabled, defaults.mcpCloudflareEnabled),
      mcpCloudflareApiToken:
        payload.mcpCloudflareApiToken === undefined
          ? defaults.mcpCloudflareApiToken
          : String(payload.mcpCloudflareApiToken || "").trim(),
      mcpTavilyEnabled: normalizeBoolean(payload.mcpTavilyEnabled, defaults.mcpTavilyEnabled),
      mcpTavilyApiKey:
        payload.mcpTavilyApiKey === undefined
          ? defaults.mcpTavilyApiKey
          : String(payload.mcpTavilyApiKey || "").trim(),
      mcpExaEnabled: normalizeBoolean(payload.mcpExaEnabled, defaults.mcpExaEnabled),
      mcpExaApiKey:
        payload.mcpExaApiKey === undefined
          ? defaults.mcpExaApiKey
          : String(payload.mcpExaApiKey || "").trim(),
      mcpFirecrawlEnabled: normalizeBoolean(payload.mcpFirecrawlEnabled, defaults.mcpFirecrawlEnabled),
      mcpFirecrawlApiKey:
        payload.mcpFirecrawlApiKey === undefined
          ? defaults.mcpFirecrawlApiKey
          : String(payload.mcpFirecrawlApiKey || "").trim(),
      mcpHubspotEnabled: normalizeBoolean(payload.mcpHubspotEnabled, defaults.mcpHubspotEnabled),
      mcpHubspotPrivateAppToken:
        payload.mcpHubspotPrivateAppToken === undefined
          ? defaults.mcpHubspotPrivateAppToken
          : String(payload.mcpHubspotPrivateAppToken || "").trim(),
      mcpApifyEnabled: normalizeBoolean(payload.mcpApifyEnabled, defaults.mcpApifyEnabled),
      mcpApifyToken:
        payload.mcpApifyToken === undefined
          ? defaults.mcpApifyToken
          : String(payload.mcpApifyToken || "").trim(),
      mcpPineconeEnabled: normalizeBoolean(payload.mcpPineconeEnabled, defaults.mcpPineconeEnabled),
      mcpPineconeApiKey:
        payload.mcpPineconeApiKey === undefined
          ? defaults.mcpPineconeApiKey
          : String(payload.mcpPineconeApiKey || "").trim(),
      mcpSupabaseEnabled: normalizeBoolean(payload.mcpSupabaseEnabled, defaults.mcpSupabaseEnabled),
      mcpSupabaseAccessToken:
        payload.mcpSupabaseAccessToken === undefined
          ? defaults.mcpSupabaseAccessToken
          : String(payload.mcpSupabaseAccessToken || "").trim(),
      mcpTwilioEnabled: normalizeBoolean(payload.mcpTwilioEnabled, defaults.mcpTwilioEnabled),
      mcpTwilioAccountSid:
        payload.mcpTwilioAccountSid === undefined
          ? defaults.mcpTwilioAccountSid
          : String(payload.mcpTwilioAccountSid || "").trim(),
      mcpTwilioAuthToken:
        payload.mcpTwilioAuthToken === undefined
          ? defaults.mcpTwilioAuthToken
          : String(payload.mcpTwilioAuthToken || "").trim(),
      mcpConfluenceEnabled: normalizeBoolean(payload.mcpConfluenceEnabled, defaults.mcpConfluenceEnabled),
      mcpConfluenceUrl:
        payload.mcpConfluenceUrl === undefined
          ? defaults.mcpConfluenceUrl
          : String(payload.mcpConfluenceUrl || "").trim(),
      mcpConfluenceUsername:
        payload.mcpConfluenceUsername === undefined
          ? defaults.mcpConfluenceUsername
          : String(payload.mcpConfluenceUsername || "").trim(),
      mcpConfluenceApiToken:
        payload.mcpConfluenceApiToken === undefined
          ? defaults.mcpConfluenceApiToken
          : String(payload.mcpConfluenceApiToken || "").trim(),
      mcpE2bEnabled: normalizeBoolean(payload.mcpE2bEnabled, defaults.mcpE2bEnabled),
      mcpE2bApiKey:
        payload.mcpE2bApiKey === undefined
          ? defaults.mcpE2bApiKey
          : String(payload.mcpE2bApiKey || "").trim(),
      mcpPerplexityEnabled: normalizeBoolean(payload.mcpPerplexityEnabled, defaults.mcpPerplexityEnabled),
      mcpPerplexityApiKey:
        payload.mcpPerplexityApiKey === undefined
          ? defaults.mcpPerplexityApiKey
          : String(payload.mcpPerplexityApiKey || "").trim(),
      mcpNeonEnabled: normalizeBoolean(payload.mcpNeonEnabled, defaults.mcpNeonEnabled),
      mcpNeonApiKey:
        payload.mcpNeonApiKey === undefined
          ? defaults.mcpNeonApiKey
          : String(payload.mcpNeonApiKey || "").trim(),
      mcpPlaywrightEnabled: normalizeBoolean(payload.mcpPlaywrightEnabled, defaults.mcpPlaywrightEnabled),
      mcpReplicateEnabled: normalizeBoolean(payload.mcpReplicateEnabled, defaults.mcpReplicateEnabled),
      mcpReplicateApiToken:
        payload.mcpReplicateApiToken === undefined
          ? defaults.mcpReplicateApiToken
          : String(payload.mcpReplicateApiToken || "").trim(),
      mcpVercelEnabled: normalizeBoolean(payload.mcpVercelEnabled, defaults.mcpVercelEnabled),
      mcpVercelApiToken:
        payload.mcpVercelApiToken === undefined
          ? defaults.mcpVercelApiToken
          : String(payload.mcpVercelApiToken || "").trim(),
      mcpAxiomEnabled: normalizeBoolean(payload.mcpAxiomEnabled, defaults.mcpAxiomEnabled),
      mcpAxiomToken:
        payload.mcpAxiomToken === undefined
          ? defaults.mcpAxiomToken
          : String(payload.mcpAxiomToken || "").trim(),
      mcpAxiomOrgId:
        payload.mcpAxiomOrgId === undefined
          ? defaults.mcpAxiomOrgId
          : String(payload.mcpAxiomOrgId || "").trim(),
      mcpUpstashEnabled: normalizeBoolean(payload.mcpUpstashEnabled, defaults.mcpUpstashEnabled),
      mcpUpstashEmail:
        payload.mcpUpstashEmail === undefined
          ? defaults.mcpUpstashEmail
          : String(payload.mcpUpstashEmail || "").trim(),
      mcpUpstashApiKey:
        payload.mcpUpstashApiKey === undefined
          ? defaults.mcpUpstashApiKey
          : String(payload.mcpUpstashApiKey || "").trim(),
      mcpSpotifyEnabled: normalizeBoolean(payload.mcpSpotifyEnabled, defaults.mcpSpotifyEnabled),
      mcpSpotifyClientId:
        payload.mcpSpotifyClientId === undefined
          ? defaults.mcpSpotifyClientId
          : String(payload.mcpSpotifyClientId || "").trim(),
      mcpSpotifyClientSecret:
        payload.mcpSpotifyClientSecret === undefined
          ? defaults.mcpSpotifyClientSecret
          : String(payload.mcpSpotifyClientSecret || "").trim(),
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
      videoMemoryAnthropicApiKey:
        payload.videoMemoryAnthropicApiKey === undefined
          ? defaults.videoMemoryAnthropicApiKey
          : String(payload.videoMemoryAnthropicApiKey || "").trim(),
      videoMemoryBaseUrl: String(payload.videoMemoryBaseUrl || defaults.videoMemoryBaseUrl || "").trim(),
      videoMemoryEnabled: normalizeBoolean(payload.videoMemoryEnabled, defaults.videoMemoryEnabled),
      videoMemoryLaunchCommand:
        payload.videoMemoryLaunchCommand === undefined
          ? defaults.videoMemoryLaunchCommand
          : String(payload.videoMemoryLaunchCommand || "").trim(),
      videoMemoryLaunchCwd:
        payload.videoMemoryLaunchCwd === undefined
          ? defaults.videoMemoryLaunchCwd
          : String(payload.videoMemoryLaunchCwd || "").trim(),
      videoMemoryProviderId: normalizeAgentProviderId(payload.videoMemoryProviderId || defaults.videoMemoryProviderId),
      agentAutomations: normalizeAgentAutomations(payload.agentAutomations || defaults.agentAutomations),
      buildingAccessConfirmedIds: normalizePluginIds(
        payload.buildingAccessConfirmedIds || defaults.buildingAccessConfirmedIds,
      ),
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
    buildingHubAccountStatus = null,
    buildingHubStatus = null,
    githubOAuthStatus = null,
    googleOAuthStatus = null,
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
      buildingHubAccountStatus,
      buildingHubStatus,
      githubOAuthClientId: this.settings.githubOAuthClientId,
      githubOAuthClientSecret: "",
      githubOAuthClientSecretConfigured: Boolean(this.settings.githubOAuthClientSecret),
      githubOAuthStatus,
      googleOAuthClientSecret: "",
      googleOAuthClientSecretConfigured: Boolean(this.settings.googleOAuthClientSecret),
      googleOAuthStatus,
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
      videoMemoryAnthropicApiKey: "",
      videoMemoryAnthropicApiKeyConfigured: Boolean(this.settings.videoMemoryAnthropicApiKey),
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
