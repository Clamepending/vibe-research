import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import httpProxy from "http-proxy";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import {
  buildPortUrlFromBase,
  getTailscaleDnsNameFromStatus,
  getTailscaleHttpsUrlFromServeStatus,
  getTailscaleUrl,
  hasTailscaleHttpsRootServe,
  pickPreferredUrl,
} from "./access-url.js";
import { AgentMailService } from "./agentmail-service.js";
import { AgentCallbackService } from "./agent-callback-service.js";
import { AgentPromptStore } from "./agent-prompt-store.js";
import { AgentRunStore } from "./agent-run-store.js";
import { AgentTownStore } from "./agent-town-store.js";
import { BuildingHubAccountService } from "./buildinghub-account-service.js";
import { BuildingHubAccountTokenStore } from "./buildinghub-account-token-store.js";
import { publishTownShareToBuildingHub } from "./buildinghub-layout-publisher.js";
import { publishBundleToBuildingHub } from "./buildinghub-bundle-publisher.js";
import { publishScaffoldRecipeToBuildingHub } from "./buildinghub-scaffold-publisher.js";
import { writeBuildingAgentGuides } from "./building-agent-guides.js";
import { BuildingHubService } from "./buildinghub-service.js";
import { BrowserUseService } from "./browser-use-service.js";
import { BUILDING_CATALOG } from "./client/building-registry.js";
import { normalizeBuildingId } from "./client/building-sdk.js";
import { createInstallJobStore, startInstallJob } from "./install-runner.js";
import { createMcpLaunchRegistry } from "./mcp-launch-registry.js";
import { testLaunch as testMcpLaunch } from "./mcp-launch-tester.js";
import { handshakeWithLaunch as handshakeMcpLaunch } from "./mcp-protocol-handshake.js";
import { createMcpLaunchHealthMonitor } from "./mcp-launch-health.js";
import { createMcpLaunchHealthScheduler } from "./mcp-launch-health-scheduler.js";
import { syncToClaudeCode, syncToCodex } from "./mcp-config-sync.js";
import { createFolderEntry, listFolderEntries } from "./folder-browser.js";
import { GitHubOAuthTokenStore } from "./github-oauth-token-store.js";
import { GitHubService } from "./github-service.js";
import { GoogleOAuthTokenStore } from "./google-oauth-token-store.js";
import { GoogleService } from "./google-service.js";
import { OttoAuthService } from "./ottoauth-service.js";
import { PortAliasStore } from "./port-alias-store.js";
import { listListeningPorts } from "./ports.js";
import {
  buildScaffoldRecipe,
  createScaffoldRecipeApplyPlan,
  previewScaffoldRecipe,
  ScaffoldRecipeService,
} from "./scaffold-recipe-service.js";
import { TutorialRegistry } from "./tutorial-registry.js";
import { buildAgentCredentialEnv, SettingsStore } from "./settings-store.js";
import { SessionManager } from "./session-manager.js";
import { startLibraryActivityWatcher } from "./library-activity-watcher.js";
import { SleepPreventionService } from "./sleep-prevention.js";
import { getVibeResearchStateDir, getVibeResearchSystemDir } from "./state-paths.js";
import { collectSystemMetrics } from "./system-metrics.js";
import { SystemMetricsHistoryStore } from "./system-metrics-history.js";
import { TailscaleServeManager } from "./tailscale-serve.js";
import { PRODUCTION_TYPING_REFRESH_MS, TelegramService } from "./telegram-service.js";
import { TwilioService } from "./twilio-service.js";
import { UpdateManager } from "./update-manager.js";
import { loadVideoMemoryRuntime } from "./videomemory-service-loader.js";
import { WalletService } from "./wallet-service.js";
import { WikiBackupService } from "./wiki-backup.js";
import { detectProviders, getDefaultProviderId } from "./providers.js";
import { listKnowledgeBase, readKnowledgeBaseNote } from "./knowledge-base.js";
import {
  listWorkspaceEntries,
  readWorkspaceTextFile,
  resolveWorkspaceEntry,
  writeWorkspaceTextFile,
} from "./workspace-files.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRootDir = path.resolve(__dirname, "..");
const publicDir = path.resolve(__dirname, "..", "public");
const masterplanIndexPath = path.join(publicDir, "masterplan", "index.html");
const execFileAsync = promisify(execFile);
const SERVER_INFO_FILENAME = "server.json";
const MASTERPLAN_HOSTNAME = "masterplan.vibe-research.net";
const TAILSCALE_HTTPS_SERVE_ENABLED =
  (process.env.VIBE_RESEARCH_TAILSCALE_HTTPS ?? process.env.REMOTE_VIBES_TAILSCALE_HTTPS) !== "0";
const DEFAULT_TAILSCALE_HTTPS_SERVE_PORTS = [443, 8443, 10000];
const JSON_BODY_LIMIT = "25mb";
const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2026-02-25.clover";
const PROVIDER_INSTALL_TIMEOUT_MS = Number(
  process.env.VIBE_RESEARCH_PROVIDER_INSTALL_TIMEOUT_MS || process.env.REMOTE_VIBES_PROVIDER_INSTALL_TIMEOUT_MS || 20 * 60 * 1000,
);
const PROVIDER_INSTALL_MAX_BUFFER = Number(
  process.env.VIBE_RESEARCH_PROVIDER_INSTALL_MAX_BUFFER || process.env.REMOTE_VIBES_PROVIDER_INSTALL_MAX_BUFFER || 2 * 1024 * 1024,
);
const WIKI_CLONE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const WIKI_CLONE_RATE_LIMIT_MAX = 5;
const BUILDINGHUB_GITHUB_OAUTH_INTEGRATION_ID = "buildinghub";
const BUILDINGHUB_GITHUB_OAUTH_START_PATH = "/buildinghub/auth/github/start";
const BUILDINGHUB_GITHUB_OAUTH_CALLBACK_PATH = "/buildinghub/auth/github/callback";
const BUILDINGHUB_GITHUB_OAUTH_DISCONNECT_PATH = "/buildinghub/auth/github/disconnect";
const BUILDINGHUB_ACCOUNT_AUTH_COMPLETE_PATH = "/buildinghub/auth/complete";
const GITHUB_OAUTH_RESULT_MESSAGE_TYPE = "buildinghub-github-oauth-result";
const GITHUB_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GITHUB_OAUTH_SCOPES = Object.freeze(["read:user"]);
const GOOGLE_OAUTH_RESULT_MESSAGE_TYPE = "vibe-research-google-oauth-result";
const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_OAUTH_FLOWS = Object.freeze({
  "google-drive": Object.freeze({
    scopes: Object.freeze([
      "https://www.googleapis.com/auth/drive.readonly",
    ]),
    prompt: "consent",
  }),
  "google-calendar": Object.freeze({
    scopes: Object.freeze([
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.freebusy",
      "https://www.googleapis.com/auth/calendar.events",
    ]),
    prompt: "consent",
  }),
  gmail: Object.freeze({
    scopes: Object.freeze([
      "https://www.googleapis.com/auth/gmail.readonly",
    ]),
    prompt: "consent",
  }),
});
const LIBRARY_SYNC_SETTING_KEYS = new Set([
  "wikiGitBackupEnabled",
  "wikiGitRemoteBranch",
  "wikiGitRemoteEnabled",
  "wikiGitRemoteName",
  "wikiGitRemoteUrl",
  "wikiPath",
  "wikiPathConfigured",
  "workspaceRootPath",
]);

function getRequestHostname(request) {
  return String(request.get("x-forwarded-host") || request.hostname || request.get("host") || "")
    .split(":")[0]
    .toLowerCase();
}

function isMasterplanHost(request) {
  return getRequestHostname(request) === MASTERPLAN_HOSTNAME;
}

const ATTACHMENTS_SUBDIR = "attachments";
const TOWN_SHARES_SUBDIR = "agent-town/town-shares";
const MAX_ATTACHMENT_IMAGE_BYTES = 15 * 1024 * 1024;
const ATTACHMENT_IMAGE_EXTENSIONS_BY_MIME_TYPE = new Map([
  ["image/apng", ".apng"],
  ["image/avif", ".avif"],
  ["image/bmp", ".bmp"],
  ["image/gif", ".gif"],
  ["image/heic", ".heic"],
  ["image/heif", ".heif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/tiff", ".tiff"],
  ["image/webp", ".webp"],
]);
const AGENT_CANVAS_IMAGE_MIME_TYPES_BY_EXTENSION = new Map([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".webp", "image/webp"],
]);

function expandHomePath(input) {
  const value = String(input || "").trim();
  if (!value) {
    return "";
  }

  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }

  return value;
}

function resolveDefaultSessionCwd(input, fallbackCwd) {
  const expandedInput = expandHomePath(input);
  return expandedInput ? path.resolve(expandedInput) : fallbackCwd;
}

async function ensureDefaultSessionCwd(input, fallbackCwd) {
  const fallback = path.resolve(fallbackCwd);
  const target = resolveDefaultSessionCwd(input, fallback);

  try {
    await mkdir(target, { recursive: true });
    const targetStats = await stat(target);

    if (targetStats.isDirectory()) {
      return realpath(target);
    }
  } catch {
    // Fall back to the app workspace if the preferred agent folder is not usable.
  }

  return fallback;
}

function buildHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeStripeAmountCents(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100) {
    throw buildHttpError("Stripe checkout amount must be at least 100 cents.", 400);
  }
  return parsed;
}

function getStripeSignatureParts(headerValue) {
  const parts = {};
  String(headerValue || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const [key, ...rest] = entry.split("=");
      const value = rest.join("=");
      if (!key || !value) {
        return;
      }
      if (!parts[key]) {
        parts[key] = [];
      }
      parts[key].push(value);
    });
  return parts;
}

function verifyStripeWebhookSignature({ payload, signatureHeader, webhookSecret }) {
  const secret = String(webhookSecret || "").trim();
  const parts = getStripeSignatureParts(signatureHeader);
  const timestamp = parts.t?.[0] || "";
  const signatures = parts.v1 || [];
  if (!secret || !timestamp || !signatures.length) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return signatures.some((signature) => safeCompare(signature, expected));
}

async function requestStripe({ body, fetchImpl, secretKey, url }) {
  if (typeof fetchImpl !== "function") {
    throw buildHttpError("fetch is not available in this Node.js runtime.", 500);
  }

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION,
    },
    body: new URLSearchParams(body).toString(),
  });
  const raw = await response.text().catch(() => "");
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = raw ? { message: raw } : {};
  }

  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `Stripe request failed (${response.status})`;
    throw buildHttpError(message, response.status || 400);
  }

  return payload;
}

function getRequestOrigin(request) {
  const forwardedProto = String(request.get("x-forwarded-proto") || "").split(",")[0].trim();
  const forwardedHost = String(request.get("x-forwarded-host") || "").split(",")[0].trim();
  const protocol = forwardedProto || request.protocol || "http";
  const host = forwardedHost || String(request.get("host") || "").trim();
  return host ? `${protocol}://${host}` : "";
}

function renderGoogleOAuthPopupPage({
  status = "error",
  buildingId = "",
  message = "",
} = {}) {
  const normalizedBuildingId = normalizeBuildingId(buildingId);
  const normalizedStatus = status === "success" ? "success" : "error";
  const defaultMessage = normalizedStatus === "success"
    ? "Google access enabled. You can close this window."
    : "Google access was not completed.";
  const payload = {
    type: GOOGLE_OAUTH_RESULT_MESSAGE_TYPE,
    status: normalizedStatus,
    buildingId: normalizedBuildingId,
    message: String(message || defaultMessage).trim() || defaultMessage,
  };
  const title = normalizedStatus === "success" ? "Google Access Enabled" : "Google Access Not Completed";
  const bodyMessage = escapeHtml(payload.message);
  const statusClass = normalizedStatus === "success" ? "status-success" : "status-error";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { font-family: "SF Pro Text", "Segoe UI", sans-serif; color-scheme: light; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f8fc; color: #1f2937; }
    main { width: min(460px, calc(100% - 32px)); border: 1px solid #dce3ef; border-radius: 14px; padding: 20px; background: #ffffff; }
    h1 { margin: 0 0 10px; font-size: 1.05rem; }
    p { margin: 0; font-size: 0.95rem; line-height: 1.4; color: #374151; }
    .status-success { color: #0f5132; }
    .status-error { color: #991b1b; }
    .actions { margin-top: 14px; display: flex; gap: 10px; }
    a { color: #1d4ed8; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p class="${statusClass}" data-status>${bodyMessage}</p>
    <div class="actions">
      <a href="/">Return to Vibe Research</a>
    </div>
  </main>
  <script>
    (() => {
      const payload = ${JSON.stringify(payload)};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, window.location.origin);
        }
      } catch {
        // Ignore cross-window access failures in fallback browser modes.
      }
      if (payload.status === "success") {
        window.setTimeout(() => {
          window.close();
        }, 150);
      }
    })();
  </script>
</body>
</html>`;
}

function renderGitHubOAuthPopupPage({
  status = "error",
  message = "",
} = {}) {
  const normalizedStatus = status === "success" ? "success" : "error";
  const defaultMessage = normalizedStatus === "success"
    ? "GitHub account connected. You can close this window."
    : "GitHub sign-in was not completed.";
  const payload = {
    type: GITHUB_OAUTH_RESULT_MESSAGE_TYPE,
    status: normalizedStatus,
    message: String(message || defaultMessage).trim() || defaultMessage,
  };
  const title = normalizedStatus === "success" ? "GitHub Connected" : "GitHub Sign-in Not Completed";
  const bodyMessage = escapeHtml(payload.message);
  const statusClass = normalizedStatus === "success" ? "status-success" : "status-error";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { font-family: "SF Pro Text", "Segoe UI", sans-serif; color-scheme: light; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f8fc; color: #1f2937; }
    main { width: min(460px, calc(100% - 32px)); border: 1px solid #dce3ef; border-radius: 14px; padding: 20px; background: #ffffff; }
    h1 { margin: 0 0 10px; font-size: 1.05rem; }
    p { margin: 0; font-size: 0.95rem; line-height: 1.4; color: #374151; }
    .status-success { color: #0f5132; }
    .status-error { color: #991b1b; }
    .actions { margin-top: 14px; display: flex; gap: 10px; }
    a { color: #1d4ed8; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p class="${statusClass}" data-status>${bodyMessage}</p>
    <div class="actions">
      <a href="/">Return to Vibe Research</a>
    </div>
  </main>
  <script>
    (() => {
      const payload = ${JSON.stringify(payload)};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, window.location.origin);
        }
      } catch {
        // Ignore cross-window access failures in fallback browser modes.
      }
      if (payload.status === "success") {
        window.setTimeout(() => {
          window.close();
        }, 150);
      }
    })();
  </script>
</body>
</html>`;
}

function normalizeAttachmentSource(value) {
  return value === "drop" ? "drop" : "paste";
}

function sanitizeAttachmentStem(value) {
  const stem = path.basename(String(value || ""), path.extname(String(value || "")))
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);

  if (!stem || /^(?:image|screenshot|screen-shot|clipboard|paste)$/i.test(stem)) {
    return "";
  }

  return stem;
}

function getAttachmentDayFolder(createdAt) {
  return createdAt.slice(0, 10);
}

function getAttachmentTimestampToken(createdAt) {
  return createdAt.replace(/\D/g, "").slice(0, 14);
}

function decodeAttachmentDataUrl(dataUrl, fallbackMimeType) {
  const match = String(dataUrl || "").match(/^data:([^;,]*);base64,([A-Za-z0-9+/=\s]+)$/);

  if (!match) {
    throw buildHttpError("Image upload must be a base64 data URL.", 400);
  }

  const dataUrlMimeType = match[1].toLowerCase();
  const hintedMimeType = String(fallbackMimeType || "").toLowerCase();
  let mimeType = dataUrlMimeType;
  if (
    !ATTACHMENT_IMAGE_EXTENSIONS_BY_MIME_TYPE.has(mimeType) &&
    ATTACHMENT_IMAGE_EXTENSIONS_BY_MIME_TYPE.has(hintedMimeType)
  ) {
    mimeType = hintedMimeType;
  }

  const extension = ATTACHMENT_IMAGE_EXTENSIONS_BY_MIME_TYPE.get(mimeType);
  if (!extension) {
    throw buildHttpError(`Unsupported image type: ${mimeType || hintedMimeType || "unknown"}.`, 415);
  }

  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.byteLength) {
    throw buildHttpError("Image upload is empty.", 400);
  }

  if (buffer.byteLength > MAX_ATTACHMENT_IMAGE_BYTES) {
    throw buildHttpError(
      `Image upload is too large (max ${MAX_ATTACHMENT_IMAGE_BYTES} bytes).`,
      413,
    );
  }

  return { buffer, extension, mimeType };
}

async function saveImageAttachment({ stateDir, session, dataUrl, originalName, source, mimeType }) {
  const { buffer, extension, mimeType: decodedMimeType } = decodeAttachmentDataUrl(dataUrl, mimeType);
  const createdAt = new Date().toISOString();
  const id = `att_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const safeSource = normalizeAttachmentSource(source);
  const timestamp = getAttachmentTimestampToken(createdAt);
  const originalStem = sanitizeAttachmentStem(originalName);
  const stem = originalStem || `${safeSource}-${timestamp}`;
  const fileName = `${stem}-${id.slice(4)}${extension}`;
  const sessionId = String(session.id || "").trim();
  const directoryPath = path.join(
    stateDir,
    ATTACHMENTS_SUBDIR,
    "sessions",
    sessionId,
    getAttachmentDayFolder(createdAt),
  );
  const absolutePath = path.join(directoryPath, fileName);

  await mkdir(directoryPath, { recursive: true });
  await writeFile(absolutePath, buffer);

  return {
    id,
    kind: "image",
    mimeType: decodedMimeType,
    fileName,
    absolutePath,
    byteLength: buffer.byteLength,
    source: safeSource,
    sessionId,
    createdAt,
  };
}

function getAgentCanvasImageMimeType(filePath) {
  return AGENT_CANVAS_IMAGE_MIME_TYPES_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) || "";
}

async function resolveAgentCanvasImage({ canvas, session, fallbackCwd }) {
  const rawImagePath = String(canvas?.imagePath || "").trim();
  if (!rawImagePath) {
    throw buildHttpError("Agent canvas image path is not set.", 404);
  }

  const targetPath = path.resolve(session?.cwd || fallbackCwd, expandHomePath(rawImagePath));
  const mimeType = getAgentCanvasImageMimeType(targetPath);
  if (!mimeType) {
    throw buildHttpError("Agent canvas image type is not supported.", 415);
  }

  const stats = await stat(targetPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError("Agent canvas image not found.", 404);
    }

    throw error;
  });

  if (!stats.isFile()) {
    throw buildHttpError("Agent canvas image path is not a file.", 400);
  }

  return { targetPath, mimeType };
}

function normalizeTownShareId(value) {
  const id = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return id || `town-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function withTownShareUrls(townShare, request) {
  if (!townShare) {
    return null;
  }

  const origin = getRequestOrigin(request);
  const encodedId = encodeURIComponent(townShare.id);
  const sharePath = `/buildinghub/towns/${encodedId}`;
  const imagePath = `/api/agent-town/town-shares/${encodedId}/image`;
  const buildingHubUrl = String(
    townShare.buildingHub?.layoutUrl ||
      townShare.buildingHub?.homepageUrl ||
      townShare.buildingHub?.repositoryUrl ||
      "",
  ).trim();
  return {
    ...townShare,
    sharePath,
    buildingHubUrl,
    shareUrl: buildingHubUrl || (origin ? `${origin}${sharePath}` : sharePath),
    imageUrl: townShare.imagePath ? `${origin}${imagePath}` : "",
  };
}

async function saveTownShareImage({ stateDir, shareId, dataUrl, mimeType }) {
  const { buffer, extension, mimeType: decodedMimeType } = decodeAttachmentDataUrl(dataUrl, mimeType);
  const updatedAt = new Date().toISOString();
  const directoryPath = path.join(stateDir, TOWN_SHARES_SUBDIR, shareId);
  const fileName = `snapshot${extension}`;
  const absolutePath = path.join(directoryPath, fileName);

  await mkdir(directoryPath, { recursive: true });
  await writeFile(absolutePath, buffer);

  return {
    imagePath: path.relative(stateDir, absolutePath),
    imageMimeType: decodedMimeType,
    imageByteLength: buffer.byteLength,
    imageUpdatedAt: updatedAt,
  };
}

async function resolveTownShareImage({ townShare, stateDir }) {
  const rawImagePath = String(townShare?.imagePath || "").trim();
  if (!rawImagePath) {
    throw buildHttpError("Agent Town share image path is not set.", 404);
  }

  const targetPath = path.resolve(stateDir, rawImagePath);
  const relativePath = path.relative(stateDir, targetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw buildHttpError("Agent Town share image path is outside the state directory.", 400);
  }

  const storedMimeType = ATTACHMENT_IMAGE_EXTENSIONS_BY_MIME_TYPE.has(townShare.imageMimeType)
    ? townShare.imageMimeType
    : "";
  const mimeType = storedMimeType || getAgentCanvasImageMimeType(targetPath);
  if (!mimeType) {
    throw buildHttpError("Agent Town share image type is not supported.", 415);
  }

  const stats = await stat(targetPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError("Agent Town share image not found.", 404);
    }

    throw error;
  });

  if (!stats.isFile()) {
    throw buildHttpError("Agent Town share image path is not a file.", 400);
  }

  return { targetPath, mimeType };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeGitHubProfileUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  try {
    const url = new URL(rawValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    if (url.hostname.toLowerCase() !== "github.com") {
      return "";
    }

    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function getGitHubLoginFromProfileUrl(value) {
  const profileUrl = normalizeGitHubProfileUrl(value);
  if (!profileUrl) {
    return "";
  }

  try {
    const url = new URL(profileUrl);
    const [login = ""] = url.pathname
      .split("/")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return login;
  } catch {
    return "";
  }
}

function normalizeBuildingHubPublisher(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const provider = String(value.provider || "").trim().toLowerCase();
  const id = String(value.id || "").trim();
  const login = String(value.login || value.username || "").trim();
  const name = String(value.name || value.displayName || "").trim();
  const profileUrl = provider === "github"
    ? normalizeGitHubProfileUrl(value.profileUrl || value.url || value.htmlUrl)
    : String(value.profileUrl || value.url || value.htmlUrl || "").trim();
  const avatarUrl = String(value.avatarUrl || value.avatar_url || "").trim();

  if (!provider && !id && !login && !name && !profileUrl) {
    return null;
  }

  return {
    provider,
    id,
    login,
    name,
    profileUrl,
    avatarUrl,
  };
}

function getBuildingHubPublisherLabel(publisher) {
  const normalized = normalizeBuildingHubPublisher(publisher);
  if (!normalized) {
    return "";
  }

  if (normalized.login) {
    return `@${normalized.login}`;
  }

  return normalized.name || "";
}

function renderTownSharePage(townShare, request) {
  const share = withTownShareUrls(townShare, request);
  const title = `${share.name} · BuildingHub`;
  const description = share.description || "A shared Agent Town base layout.";
  const publisher = normalizeBuildingHubPublisher(share.buildingHub?.publisher);
  const publisherLabel = getBuildingHubPublisherLabel(publisher);
  const publisherHtml = publisherLabel
    ? (publisher?.profileUrl
        ? `<a href="${escapeHtml(publisher.profileUrl)}">${escapeHtml(publisherLabel)}</a>`
        : escapeHtml(publisherLabel))
    : "";
  const imageMeta = share.imageUrl
    ? `
    <meta property="og:image" content="${escapeHtml(share.imageUrl)}" />
    <meta name="twitter:image" content="${escapeHtml(share.imageUrl)}" />`
    : "";
  const image = share.imageUrl
    ? `<img class="town-image" src="${escapeHtml(share.imageUrl)}" alt="${escapeHtml(`${share.name} snapshot`)}" />`
    : `<div class="town-image town-image-empty">No snapshot yet</div>`;
  const summary = share.layoutSummary || {};
  const theme = summary.themeId || share.layout?.themeId || "default";
  const cosmetics = Number(summary.cosmeticCount) || 0;
  const functional = Number(summary.functionalCount) || 0;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />${imageMeta}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; background: #111316; color: #f4f0e8; }
    main { display: grid; gap: 18px; width: min(960px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0 40px; }
    .town-image { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; background: #1d2326; }
    .town-image-empty { display: grid; place-items: center; color: #a6aaa3; }
    h1 { margin: 0; font-size: clamp(2rem, 6vw, 4rem); line-height: .95; letter-spacing: 0; }
    p { margin: 0; max-width: 68ch; color: #c8ccc5; font-size: 1rem; line-height: 1.55; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; color: #d8ddcd; font-size: .82rem; }
    .meta span { padding: 7px 9px; border: 1px solid rgba(255,255,255,.12); border-radius: 999px; background: rgba(255,255,255,.05); }
    .publisher { color: #c8ccc5; font-size: .94rem; }
    .publisher a { color: inherit; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    button, a.button { appearance: none; display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: 0 14px; border: 1px solid rgba(255,255,255,.16); border-radius: 8px; background: #d7f36b; color: #12140f; font-weight: 750; text-decoration: none; cursor: pointer; }
    a.button.secondary { background: transparent; color: #f4f0e8; }
    .status { min-height: 20px; color: #c8ccc5; font-size: .86rem; }
  </style>
</head>
<body>
  <main>
    ${image}
    <div class="meta">
      <span>${escapeHtml(`${cosmetics} cosmetic`)}</span>
      <span>${escapeHtml(`${functional} functional`)}</span>
      <span>${escapeHtml(`theme ${theme}`)}</span>
    </div>
    <h1>${escapeHtml(share.name)}</h1>
    ${publisherHtml ? `<div class="publisher">Published by ${publisherHtml}</div>` : ""}
    <p>${escapeHtml(description)}</p>
    <div class="actions">
      <button type="button" data-import-town>Import town</button>
      <a class="button secondary" href="/">Open Vibe Research</a>
    </div>
    <div class="status" data-import-status></div>
  </main>
  <script>
    const shareId = ${JSON.stringify(share.id)};
    const button = document.querySelector("[data-import-town]");
    const status = document.querySelector("[data-import-status]");
    button?.addEventListener("click", async () => {
      button.disabled = true;
      status.textContent = "Importing town...";
      try {
        const response = await fetch("/api/agent-town/town-shares/" + encodeURIComponent(shareId) + "/import", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Vibe-Research-API": "1" },
          body: "{}"
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || "Import failed.");
        }
        const layout = payload.townShare?.layout || payload.agentTown?.layout || null;
        if (layout && typeof layout === "object") {
          const localLayout = {
            places: layout.places || {},
            roads: layout.roads || {},
            decorations: Array.isArray(layout.decorations) ? layout.decorations : [],
            functional: layout.functional || {},
            pendingFunctional: Array.isArray(layout.pendingFunctional) ? layout.pendingFunctional : []
          };
          window.localStorage.setItem("vibe-research-agent-town-layout-v1", JSON.stringify(localLayout));
          if (layout.themeId) {
            window.localStorage.setItem("vibe-research-agent-town-theme-v1", String(layout.themeId));
          }
          if (layout.dogName && layout.dogName !== "Dog") {
            window.localStorage.setItem("vibe-research-agent-town-dog-name-v1", String(layout.dogName));
          } else {
            window.localStorage.removeItem("vibe-research-agent-town-dog-name-v1");
          }
        }
        window.location.href = "/?view=swarm";
      } catch (error) {
        status.textContent = error.message || "Import failed.";
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

function normalizeGitCloneRemoteUrl(value) {
  const remoteUrl = String(value || "").trim();
  if (!remoteUrl) {
    throw buildHttpError("Git repo URL is required.", 400);
  }

  if (remoteUrl.startsWith("-") || remoteUrl.includes("\0")) {
    throw buildHttpError("Git repo URL is invalid.", 400);
  }

  return remoteUrl;
}

function getGitRepoFolderName(remoteUrl) {
  const cleaned = String(remoteUrl || "")
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  const rawName = cleaned.split(/[/:]/).filter(Boolean).at(-1) || "library";
  const folderName = rawName
    .replace(/\.git$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return folderName || "library";
}

function normalizeGitRemoteForCompare(value) {
  return String(value || "")
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

function createCloneBackupPath(targetPath) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "Z");
  return `${targetPath}.vibe-research-scaffold-${timestamp}`;
}

function getPortFromProxyPath(pathname) {
  const match = pathname.match(/^\/proxy\/(\d+)(?:\/|$)/);
  return normalizePort(match?.[1]);
}

function getPortFromReferrer(request) {
  const referrer = request.headers.referer;

  if (!referrer) {
    return null;
  }

  try {
    const url = new URL(referrer);
    return getPortFromProxyPath(url.pathname);
  } catch {
    return null;
  }
}

function rewriteProxyPath(originalUrl, port) {
  const prefix = `/proxy/${port}`;
  const nextPath = originalUrl.startsWith(prefix) ? originalUrl.slice(prefix.length) : originalUrl;
  return nextPath || "/";
}

function getServerInfoPath(stateDir) {
  return path.join(stateDir, SERVER_INFO_FILENAME);
}

function parseTailscaleHttpsServePorts(value) {
  const configured = String(value || "")
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0 && entry < 65_536);
  const ports = configured.length ? configured : DEFAULT_TAILSCALE_HTTPS_SERVE_PORTS;

  return [...new Set(ports)];
}

const TAILSCALE_HTTPS_SERVE_PORTS = parseTailscaleHttpsServePorts(
  process.env.VIBE_RESEARCH_TAILSCALE_HTTPS_PORTS ?? process.env.REMOTE_VIBES_TAILSCALE_HTTPS_PORTS,
);

function getHelperBaseUrl(host, port) {
  if (host === "0.0.0.0" || host === "::") {
    return `http://127.0.0.1:${port}`;
  }

  if (host.includes(":") && !host.startsWith("[")) {
    return `http://[${host}]:${port}`;
  }

  return `http://${host}:${port}`;
}

function normalizePublicBaseUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  try {
    const url = new URL(rawValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function getConfiguredPublicBaseUrl(env = process.env) {
  return normalizePublicBaseUrl(
    env.VIBE_RESEARCH_PUBLIC_BASE_URL ||
      env.REMOTE_VIBES_PUBLIC_BASE_URL ||
      env.RENDER_EXTERNAL_URL ||
      "",
  );
}

function getPublicBaseUrl(host, port, urls = [], env = process.env) {
  const configuredUrl = getConfiguredPublicBaseUrl(env);
  if (configuredUrl) {
    return configuredUrl;
  }

  return normalizePublicBaseUrl(pickPreferredUrl(urls)?.url || urls[0]?.url || "") || getHelperBaseUrl(host, port);
}

function getBuildingHubAuthCallbackBaseUrl(port, env = process.env) {
  const normalizedPort = normalizePort(port);
  if (!normalizedPort) {
    return "";
  }

  return getConfiguredPublicBaseUrl(env) || `http://127.0.0.1:${normalizedPort}`;
}

async function writeServerInfo(stateDir, payload) {
  const filePath = getServerInfoPath(stateDir);
  const tempPath = `${filePath}.tmp`;
  await mkdir(stateDir, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function removeServerInfo(stateDir) {
  await rm(getServerInfoPath(stateDir), { force: true });
}

function sendProxyError(response, proxyPort) {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.status(502).json({ error: `Port ${proxyPort} is unavailable.` });
}

function proxyHttpRequest(request, response, proxyServer, proxyPort, stripPrefix = false) {
  if (stripPrefix) {
    request.url = rewriteProxyPath(request.originalUrl, proxyPort);
  }

  proxyServer.web(
    request,
    response,
    {
      target: `http://127.0.0.1:${proxyPort}`,
    },
    () => sendProxyError(response, proxyPort),
  );
}

function proxyWebsocketRequest(request, socket, head, proxyServer, proxyPort, stripPrefix = false) {
  if (stripPrefix) {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    request.url = `${rewriteProxyPath(url.pathname, proxyPort)}${url.search}`;
  }

  proxyServer.ws(
    request,
    socket,
    head,
    {
      target: `http://127.0.0.1:${proxyPort}`,
    },
    () => socket.destroy(),
  );
}

async function getAccessUrls(host, port) {
  const seen = new Set();
  const urls = [];
  const configuredPublicUrl = getConfiguredPublicBaseUrl(process.env);
  if (configuredPublicUrl) {
    urls.push({
      label: process.env.RENDER_EXTERNAL_URL ? "Render" : "Public",
      url: configuredPublicUrl,
    });
    seen.add(configuredPublicUrl);
  }

  if (host !== "0.0.0.0" && host !== "::") {
    const directUrl = `http://${host}:${port}`;
    if (!seen.has(directUrl)) {
      urls.push({ label: "Direct", url: directUrl });
    }
    return urls;
  }

  const localUrl = `http://localhost:${port}`;
  if (!seen.has(localUrl)) {
    urls.push({ label: "Local", url: localUrl });
    seen.add(localUrl);
  }

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }

      const key = `${name}:${address.address}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      const label = name.toLowerCase().includes("tailscale") ? "Tailscale" : name;
      const directUrl = `http://${address.address}:${port}`;
      if (!seen.has(directUrl)) {
        urls.push({ label, url: directUrl });
        seen.add(directUrl);
      }
    }
  }

  try {
    const { stdout } = await execFileAsync(process.env.SHELL || "/bin/zsh", [
      "-lc",
      "command -v tailscale >/dev/null 2>&1 && tailscale ip -4",
    ]);
    for (const line of stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(line)) {
        continue;
      }

      const url = `http://${line}:${port}`;
      if (!urls.some((entry) => entry.url === url)) {
        urls.push({ label: "Tailscale", url });
      }
    }
  } catch {
    // Ignore missing Tailscale or lookup failures.
  }

  const tailscaleHttpsUrl = await getTailscaleHttpsServeUrl(port);
  if (tailscaleHttpsUrl && !urls.some((entry) => entry.url === tailscaleHttpsUrl)) {
    urls.splice(1, 0, { label: "Tailscale HTTPS", url: tailscaleHttpsUrl });
  }

  return urls;
}

async function runTailscaleCommand(args) {
  const { stdout } = await execFileAsync(process.env.SHELL || "/bin/zsh", [
    "-lc",
    "command -v tailscale >/dev/null 2>&1 || exit 127; exec tailscale \"$@\"",
    "tailscale",
    ...args,
  ]);
  return stdout;
}

async function readTailscaleStatusJson() {
  const stdout = await runTailscaleCommand(["status", "--json"]);
  return JSON.parse(stdout || "{}");
}

async function readTailscaleServeStatusJson() {
  const stdout = await runTailscaleCommand(["serve", "status", "--json"]);
  return JSON.parse(stdout || "{}");
}

async function getTailscaleHttpsServeUrl(port) {
  if (!TAILSCALE_HTTPS_SERVE_ENABLED) {
    return "";
  }

  try {
    const status = await readTailscaleStatusJson();
    const dnsName = getTailscaleDnsNameFromStatus(status);
    if (!dnsName) {
      return "";
    }

    let serveStatus = {};
    try {
      serveStatus = await readTailscaleServeStatusJson();
    } catch {
      serveStatus = {};
    }

    const configuredUrl = getTailscaleHttpsUrlFromServeStatus(serveStatus, port, dnsName);
    if (configuredUrl) {
      return configuredUrl;
    }

    for (const servePort of TAILSCALE_HTTPS_SERVE_PORTS) {
      if (hasTailscaleHttpsRootServe(serveStatus, dnsName, servePort)) {
        continue;
      }

      const serveArgs =
        servePort === 443
          ? ["serve", "--bg", "--yes", String(port)]
          : ["serve", "--bg", "--yes", `--https=${servePort}`, String(port)];

      try {
        await runTailscaleCommand(serveArgs);
      } catch {
        try {
          await runTailscaleCommand(serveArgs.filter((arg) => arg !== "--yes"));
        } catch {
          continue;
        }
      }

      serveStatus = await readTailscaleServeStatusJson();
      const nextUrl = getTailscaleHttpsUrlFromServeStatus(serveStatus, port, dnsName);
      if (nextUrl) {
        return nextUrl;
      }
    }

    return "";
  } catch {
    return "";
  }
}

function normalizeHost(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

function isLoopbackHost(value) {
  const host = normalizeHost(value);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isAllInterfacesHost(value) {
  const host = normalizeHost(value);
  return host === "0.0.0.0" || host === "::" || host === "*";
}

function isTailscaleHost(value) {
  const host = normalizeHost(value);
  const match = host.match(/^100\.(\d{1,3})\./);
  return Boolean(match && Number(match[1]) >= 64 && Number(match[1]) <= 127);
}

function getPortHosts(portEntry) {
  return Array.isArray(portEntry.hosts) ? portEntry.hosts : [];
}

function shouldSyncLibraryForSettingsPatch(body = {}) {
  const entries = Object.entries(body && typeof body === "object" ? body : {});
  return entries.some(([key, value]) => value !== undefined && LIBRARY_SYNC_SETTING_KEYS.has(key));
}

function isLocalOnlyPort(portEntry) {
  const hosts = getPortHosts(portEntry);
  return hosts.length > 0 && hosts.every((host) => isLoopbackHost(host));
}

function isDirectlyReachablePort(portEntry, tailscaleBaseUrl) {
  const hosts = getPortHosts(portEntry);
  let tailscaleHost = "";

  try {
    tailscaleHost = normalizeHost(new URL(tailscaleBaseUrl).hostname);
  } catch {
    tailscaleHost = "";
  }

  return hosts.some(
    (host) =>
      isAllInterfacesHost(host) ||
      isTailscaleHost(host) ||
      (tailscaleHost && normalizeHost(host) === tailscaleHost),
  );
}

function tutorialBuildingAlreadyConfigured({ tutorial, settings }) {
  const confirmed = Array.isArray(settings?.buildingAccessConfirmedIds)
    ? settings.buildingAccessConfirmedIds
    : [];
  if (tutorial.id === "connect-telegram") {
    if (String(settings?.telegramBotToken || "").trim()) {
      return true;
    }
    return confirmed.includes("telegram");
  }
  if (tutorial.id === "connect-stripe") {
    return Boolean(String(settings?.walletStripeSecretKey || "").trim());
  }
  if (tutorial.id === "connect-cameras") {
    return Boolean(settings?.videoMemoryEnabled || confirmed.includes("videomemory"));
  }
  return false;
}

async function seedTutorialActionItems({ tutorialRegistry, agentTownStore, settingsStore }) {
  if (!tutorialRegistry || !agentTownStore) {
    return;
  }
  const tutorials = tutorialRegistry.list();
  if (!tutorials.length) {
    return;
  }
  const settings = settingsStore?.settings || {};
  for (const tutorial of tutorials) {
    if (agentTownStore.hasSeededTutorial(tutorial.id)) {
      continue;
    }
    if (tutorialBuildingAlreadyConfigured({ tutorial, settings })) {
      continue;
    }
    try {
      await agentTownStore.seedTutorialActionItem({
        id: `tutorial-${tutorial.id}`,
        kind: "setup",
        priority: tutorial.priority || "normal",
        title: tutorial.title,
        detail: tutorial.summary,
        tutorialId: tutorial.id,
        source: "tutorials",
        capabilityIds: ["ui-guidance"],
      });
    } catch (error) {
      console.warn(`[vibe-research] failed to seed tutorial action item ${tutorial.id}:`, error);
    }
  }
}

export async function createVibeResearchApp({
  host = process.env.VIBE_RESEARCH_HOST || process.env.REMOTE_VIBES_HOST || "0.0.0.0",
  port = Number(process.env.PORT || process.env.VIBE_RESEARCH_PORT || process.env.REMOTE_VIBES_PORT || 4826),
  cwd = process.cwd(),
  stateDir = getVibeResearchStateDir({ cwd }),
  persistSessions = true,
  listPorts = listListeningPorts,
  accessUrlsProvider = getAccessUrls,
  providers: providerOverrides = null,
  persistentTerminals = true,
  tailscaleServeManager = new TailscaleServeManager(),
  sleepPreventionFactory = (settings) =>
    new SleepPreventionService({
      enabled: settings.preventSleepEnabled,
    }),
  onTerminate = null,
  agentMailServiceFactory = null,
  buildingHubServiceFactory = null,
  scaffoldRecipeServiceFactory = null,
  tutorialRegistryFactory = null,
  browserUseServiceFactory = null,
  ottoAuthServiceFactory = null,
  telegramServiceFactory = null,
  twilioServiceFactory = null,
  videoMemoryServiceFactory = null,
  walletServiceFactory = null,
  buildingHubFetchImpl = globalThis.fetch,
  buildingHubAccountTokenStoreFactory = null,
  buildingHubAccountServiceFactory = null,
  githubFetchImpl = globalThis.fetch,
  githubOAuthTokenStoreFactory = null,
  githubServiceFactory = null,
  stripeFetchImpl = globalThis.fetch,
  googleFetchImpl = globalThis.fetch,
  googleOAuthTokenStoreFactory = null,
  googleServiceFactory = null,
  wikiBackupServiceFactory = null,
  systemMetricsProvider = collectSystemMetrics,
  systemMetricsSampleIntervalMs = 60_000,
  updateManager = new UpdateManager({ cwd, stateDir, port }),
  defaultSessionCwd = process.env.VIBE_RESEARCH_DEFAULT_CWD || process.env.REMOTE_VIBES_DEFAULT_CWD || "",
} = {}) {
  let providers = Array.isArray(providerOverrides) ? providerOverrides : await detectProviders();
  let defaultProviderId = getDefaultProviderId(providers);
  const app = express();
  const wikiCloneRateLimit = rateLimit({
    windowMs: WIKI_CLONE_RATE_LIMIT_WINDOW_MS,
    limit: WIKI_CLONE_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many Library clone requests. Try again shortly." },
  });
  const serverEnv = { ...process.env };
  const agentRunStore = new AgentRunStore({ stateDir });
  const agentTownStore = new AgentTownStore({ stateDir });
  const systemRootPath = getVibeResearchSystemDir({ cwd, stateDir });
  const settingsStore = new SettingsStore({ cwd, stateDir, env: serverEnv, defaultAgentSpawnPath: defaultSessionCwd });
  const systemMetricsHistoryStore = new SystemMetricsHistoryStore({ stateDir });
  const portAliasStore = new PortAliasStore({ stateDir });
  await settingsStore.initialize();
  const buildingHubAccountTokenStore =
    typeof buildingHubAccountTokenStoreFactory === "function"
      ? buildingHubAccountTokenStoreFactory({ stateDir })
      : new BuildingHubAccountTokenStore({ stateDir });
  await buildingHubAccountTokenStore.load();
  const buildingHubAccountService =
    typeof buildingHubAccountServiceFactory === "function"
      ? buildingHubAccountServiceFactory({ tokenStore: buildingHubAccountTokenStore, settingsStore, fetchImpl: buildingHubFetchImpl })
      : new BuildingHubAccountService({
          tokenStore: buildingHubAccountTokenStore,
          fetchImpl: buildingHubFetchImpl,
        });
  const githubOAuthStates = new Map();
  const githubOAuthTokenStore =
    typeof githubOAuthTokenStoreFactory === "function"
      ? githubOAuthTokenStoreFactory({ stateDir })
      : new GitHubOAuthTokenStore({ stateDir });
  await githubOAuthTokenStore.load();
  const githubService =
    typeof githubServiceFactory === "function"
      ? githubServiceFactory({ tokenStore: githubOAuthTokenStore, settingsStore, fetchImpl: githubFetchImpl })
      : new GitHubService({
          tokenStore: githubOAuthTokenStore,
          settingsStore,
          fetchImpl: githubFetchImpl,
        });
  const googleOAuthStates = new Map();
  const googleOAuthTokenStore =
    typeof googleOAuthTokenStoreFactory === "function"
      ? googleOAuthTokenStoreFactory({ stateDir })
      : new GoogleOAuthTokenStore({ stateDir });
  await googleOAuthTokenStore.load();
  const googleService =
    typeof googleServiceFactory === "function"
      ? googleServiceFactory({ tokenStore: googleOAuthTokenStore, settingsStore, fetchImpl: googleFetchImpl })
      : new GoogleService({
          tokenStore: googleOAuthTokenStore,
          settingsStore,
          fetchImpl: googleFetchImpl,
        });
  let sessionDefaultCwd = await ensureDefaultSessionCwd(settingsStore.settings.agentSpawnPath || defaultSessionCwd, cwd);
  await mkdir(systemRootPath, { recursive: true });
  await systemMetricsHistoryStore.initialize();
  const walletService =
    typeof walletServiceFactory === "function"
      ? walletServiceFactory(settingsStore.settings, { cwd, stateDir, systemRootPath })
      : new WalletService({ stateDir });
  const buildingHubService =
    typeof buildingHubServiceFactory === "function"
      ? buildingHubServiceFactory(settingsStore.settings, { cwd, stateDir, systemRootPath })
      : new BuildingHubService({
          settings: settingsStore.settings,
        });
  const scaffoldRecipeService =
    typeof scaffoldRecipeServiceFactory === "function"
      ? scaffoldRecipeServiceFactory(settingsStore.settings, { cwd, stateDir, systemRootPath })
      : new ScaffoldRecipeService({ stateDir });
  const installJobStore = createInstallJobStore();
  const mcpLaunchRegistry = createMcpLaunchRegistry({
    getSettings: () => settingsStore.settings,
    // Durable across server restarts. Without this, every restart wipes
    // the registry and the user has to re-Install every MCP-server
    // building before the host agent can pick them up again.
    persistencePath: path.join(stateDir, "mcp-launch-registry.json"),
  });

  // Auto-sync the registry to Claude Code + Codex configs after every
  // install + uninstall so the user doesn't have to remember to call
  // POST /api/mcp/sync. Set VIBE_RESEARCH_MCP_AUTO_SYNC=off to disable
  // (used by tests + airgapped runs). Sync failures are logged but
  // don't fail the install — the manual /api/mcp/sync route is still
  // available as a fallback.
  const autoSyncEnabled = String(process.env.VIBE_RESEARCH_MCP_AUTO_SYNC || "").toLowerCase() !== "off";
  const runAutoSyncForAgents = autoSyncEnabled
    ? () => {
        const out = {};
        try { out.claude = syncToClaudeCode({ registry: mcpLaunchRegistry }); } catch (err) {
          out.claudeError = String(err?.message || err);
        }
        try { out.codex = syncToCodex({ registry: mcpLaunchRegistry }); } catch (err) {
          out.codexError = String(err?.message || err);
        }
        return out;
      }
    : null;
  const mcpLaunchHealthMonitor = createMcpLaunchHealthMonitor({
    registry: mcpLaunchRegistry,
    runHandshake: handshakeMcpLaunch,
  });
  const mcpLaunchHealthScheduler = createMcpLaunchHealthScheduler({
    monitor: mcpLaunchHealthMonitor,
    // Re-read the setting on every tick so a settings change takes
    // effect on the next scheduled fire — no stop/start needed.
    intervalMs: () => Number(settingsStore.settings.mcpHealthCheckIntervalSec || 300) * 1000,
  });
  // Start in production-ish runs; tests + ephemeral apps can override
  // VIBE_RESEARCH_MCP_HEALTH_SCHEDULE=off to skip the scheduler so they
  // don't get spurious handshakes during their teardown window.
  if (String(process.env.VIBE_RESEARCH_MCP_HEALTH_SCHEDULE || "").toLowerCase() !== "off") {
    mcpLaunchHealthScheduler.start();
  }
  const tutorialRegistry =
    typeof tutorialRegistryFactory === "function"
      ? tutorialRegistryFactory({ systemRootPath, cwd, stateDir })
      : new TutorialRegistry({ tutorialsDir: path.join(appRootDir, "tutorials") });
  const browserUseService =
    typeof browserUseServiceFactory === "function"
      ? browserUseServiceFactory(settingsStore.settings, { cwd, stateDir, systemRootPath })
      : new BrowserUseService({
          settings: settingsStore.settings,
          stateDir,
          systemRootPath,
        });
  const ottoAuthService =
    typeof ottoAuthServiceFactory === "function"
      ? ottoAuthServiceFactory(settingsStore.settings, { cwd, stateDir, systemRootPath })
      : new OttoAuthService({
          settings: settingsStore.settings,
          stateDir,
        });
  const wikiBackupConfig = {
    enabled: settingsStore.settings.wikiGitBackupEnabled,
    intervalMs: settingsStore.settings.wikiBackupIntervalMs,
    remoteBranch: settingsStore.settings.wikiGitRemoteBranch,
    remoteEnabled: settingsStore.settings.wikiGitRemoteEnabled,
    remoteName: settingsStore.settings.wikiGitRemoteName,
    remoteUrl: settingsStore.settings.wikiGitRemoteUrl,
    wikiPath: settingsStore.settings.wikiPath,
  };
  const wikiBackupService =
    typeof wikiBackupServiceFactory === "function"
      ? wikiBackupServiceFactory(wikiBackupConfig, { cwd, stateDir })
      : new WikiBackupService(wikiBackupConfig);
  const sleepPreventionService = sleepPreventionFactory(settingsStore.settings);
  let videoMemoryService = null;
  const sessionManager = new SessionManager({
    cwd: sessionDefaultCwd,
    providers,
    env: buildAgentCredentialEnv(settingsStore.settings, serverEnv),
    persistSessions,
    persistentTerminals,
    stateDir,
    agentRunStore,
    wikiRootPath: settingsStore.settings.wikiPath,
    systemRootPath,
    extraSubagentsProvider: (session) => [
      ...browserUseService.listSubagentsForSession(session.id),
      ...ottoAuthService.listSubagentsForSession(session.id),
      ...(videoMemoryService ? videoMemoryService.listSubagentsForSession(session.id) : []),
    ],
  });
  const agentPromptStore = new AgentPromptStore({
    cwd,
    stateDir,
    wikiRootPath: settingsStore.settings.wikiPath,
  });
  const agentMailService =
    typeof agentMailServiceFactory === "function"
      ? agentMailServiceFactory(settingsStore.settings, { cwd, sessionManager, stateDir, systemRootPath })
      : new AgentMailService({
          cwd,
          sessionManager,
          settings: settingsStore.settings,
          stateDir,
          systemRootPath,
        });
  const telegramService =
    typeof telegramServiceFactory === "function"
      ? telegramServiceFactory(settingsStore.settings, { cwd, sessionManager, stateDir, systemRootPath })
      : new TelegramService({
          cwd,
          sessionManager,
          settings: settingsStore.settings,
          stateDir,
          systemRootPath,
          typingRefreshMs: PRODUCTION_TYPING_REFRESH_MS,
        });
  const twilioService =
    typeof twilioServiceFactory === "function"
      ? twilioServiceFactory(settingsStore.settings, { cwd, sessionManager, stateDir, systemRootPath, walletService })
      : new TwilioService({
          cwd,
          sessionManager,
          settings: settingsStore.settings,
          stateDir,
          systemRootPath,
          walletService,
        });
  const videoMemoryRuntime =
    typeof videoMemoryServiceFactory === "function" ? null : await loadVideoMemoryRuntime({ env: serverEnv });
  videoMemoryService =
    typeof videoMemoryServiceFactory === "function"
      ? videoMemoryServiceFactory(settingsStore.settings, {
          cwd,
          defaultProviderId,
          sessionManager,
          stateDir,
          systemRootPath,
        })
      : new videoMemoryRuntime.VideoMemoryService({
          defaultProviderId,
          sessionManager,
          settings: settingsStore.settings,
          stateDir,
        });
  const agentCallbackService = new AgentCallbackService({
    serverBaseUrl: getHelperBaseUrl(host, port),
    sessionManager,
    stateDir,
  });
  sessionManager.setSessionEnvironmentProvider((session) => {
    const callback = agentCallbackService.getCallback(session.id);
    return {
      REMOTE_VIBES_AGENT_CALLBACK_HELP:
        "Pass this URL to buildings or services that need to notify this exact agent later. POST JSON with buildingId, serviceId, event, message, and payload.",
      REMOTE_VIBES_AGENT_CALLBACK_URL: callback.url,
      VIBE_RESEARCH_AGENT_CALLBACK_HELP:
        "Pass this URL to buildings or services that need to notify this exact agent later. POST JSON with buildingId, serviceId, event, message, and payload.",
      VIBE_RESEARCH_AGENT_CALLBACK_URL: callback.url,
    };
  });
  await agentRunStore.initialize();
  await agentTownStore.initialize();
  await portAliasStore.initialize();
  await walletService.initialize?.();
  await browserUseService.initialize();
  await ottoAuthService.initialize();
  await twilioService.initialize?.();
  await videoMemoryService.initialize();
  await agentCallbackService.initialize();
  await scaffoldRecipeService.initialize();
  await tutorialRegistry.load();
  await seedTutorialActionItems({
    tutorialRegistry,
    agentTownStore,
    settingsStore,
  });
  await sessionManager.initialize();
  await agentPromptStore.initialize();
  sessionManager.setOccupationId(agentPromptStore.selectedPromptId);
  wikiBackupService.start();
  agentMailService.start();
  telegramService.start();
  twilioService.start();
  if (settingsStore.settings.wikiGitRemoteEnabled && settingsStore.settings.wikiGitRemoteUrl) {
    void wikiBackupService.runBackup({ reason: "startup" });
  }
  sleepPreventionService.start();
  let exposedPort = null;
  let closePromise = null;
  let terminatePromise = null;
  let systemMetricsTimer = null;
  let urls = [];
  let preferredUrl = null;
  let helperBaseUrl = "";
  let publicBaseUrl = "";
  const proxyServer = httpProxy.createProxyServer({
    changeOrigin: true,
    ws: true,
    xfwd: true,
  });

  async function readTailscaleServeStatus({ refresh = false } = {}) {
    if (!tailscaleServeManager || typeof tailscaleServeManager.getStatus !== "function") {
      return {
        available: false,
        config: null,
        enabled: false,
        reason: "Tailscale Serve is not configured.",
      };
    }

    try {
      return await tailscaleServeManager.getStatus({ refresh });
    } catch (error) {
      return {
        available: false,
        config: null,
        enabled: false,
        reason: error.message || "Could not read Tailscale Serve status.",
      };
    }
  }

  async function getTailscalePortStatus(port, serveStatus) {
    if (!tailscaleServeManager || typeof tailscaleServeManager.getPortStatus !== "function") {
      return {
        available: false,
        enabled: false,
        port,
      };
    }

    try {
      return await tailscaleServeManager.getPortStatus(port, serveStatus);
    } catch (error) {
      return {
        available: false,
        enabled: false,
        port,
        reason: error.message || "Could not read Tailscale Serve port status.",
      };
    }
  }

  async function decoratePortForAccess(portEntry, serveStatus) {
    const tailscaleBaseUrl = getTailscaleUrl(urls);
    const tailscaleUrl = buildPortUrlFromBase(tailscaleBaseUrl, portEntry.port);
    const localOnly = isLocalOnlyPort(portEntry);
    const directReachable = Boolean(tailscaleUrl && isDirectlyReachablePort(portEntry, tailscaleBaseUrl));
    const tailscalePortStatus = await getTailscalePortStatus(portEntry.port, serveStatus);
    const exposedWithTailscale = Boolean(tailscaleUrl && tailscalePortStatus.enabled);
    const directUrl = directReachable ? tailscaleUrl : null;
    const preferredUrl = directUrl || (exposedWithTailscale ? tailscaleUrl : null);
    const preferredAccess = directUrl
      ? "direct"
      : exposedWithTailscale
        ? "tailscale-serve"
        : "proxy";

    return {
      ...portEntry,
      canExposeWithTailscale: Boolean(
        tailscaleUrl && localOnly && serveStatus.available && !directReachable && !exposedWithTailscale,
      ),
      directUrl,
      exposedWithTailscale,
      localOnly,
      preferredAccess,
      preferredUrl,
      tailscaleServeAvailable: Boolean(serveStatus.available),
      tailscaleServeReason: serveStatus.reason || tailscalePortStatus.reason || null,
      tailscaleUrl,
    };
  }

  async function listNamedPorts() {
    const ports = await listPorts({ excludePorts: exposedPort ? [exposedPort] : [] });
    const namedPorts = portAliasStore.apply(ports);
    const serveStatus = await readTailscaleServeStatus();

    return Promise.all(namedPorts.map((entry) => decoratePortForAccess(entry, serveStatus)));
  }

  function getSettingsState() {
    return settingsStore.getState({
      agentMailStatus: agentMailService.getStatus(),
      backupStatus: wikiBackupService.getStatus(),
      buildingHubAccountStatus: buildingHubAccountTokenStore.getStatus(),
      buildingHubStatus: buildingHubService.getStatus(),
      browserUseStatus: browserUseService.getStatus(),
      githubOAuthStatus: githubOAuthTokenStore.getStatus(BUILDINGHUB_GITHUB_OAUTH_INTEGRATION_ID),
      googleOAuthStatus: googleOAuthTokenStore.getStatus(),
      ottoAuthStatus: ottoAuthService.getStatus(),
      sleepStatus: sleepPreventionService.getStatus(),
      telegramStatus: telegramService.getStatus(),
      twilioStatus: twilioService.getStatus(),
      walletStatus: walletService.getSummary?.({ limit: 4 }) || walletService.getStatus?.() || null,
      videoMemoryStatus: videoMemoryService.getStatus(),
    });
  }

  async function getAppMetadata() {
    let version = "";
    try {
      const packageJson = JSON.parse(await readFile(path.join(appRootDir, "package.json"), "utf8"));
      version = String(packageJson.version || "").trim();
    } catch {
      version = "";
    }

    let commit = "";
    let branch = "";
    try {
      const { stdout = "" } = await execFileAsync("git", ["-C", appRootDir, "rev-parse", "HEAD"]);
      commit = stdout.trim();
    } catch {
      commit = "";
    }
    try {
      const { stdout = "" } = await execFileAsync("git", ["-C", appRootDir, "branch", "--show-current"]);
      branch = stdout.trim();
    } catch {
      branch = "";
    }

    return { version, commit, branch };
  }

  async function resolveGitState(dirPath) {
    if (!dirPath) {
      return { commit: "", branch: "" };
    }
    let commit = "";
    let branch = "";
    try {
      const { stdout = "" } = await execFileAsync("git", ["-C", dirPath, "rev-parse", "HEAD"]);
      commit = stdout.trim();
    } catch {
      commit = "";
    }
    try {
      const { stdout = "" } = await execFileAsync("git", ["-C", dirPath, "branch", "--show-current"]);
      branch = stdout.trim();
    } catch {
      branch = "";
    }
    return { commit, branch };
  }

  async function getCurrentLibraryGitState() {
    const wikiPath = settingsStore.settings?.wikiPath || "";
    return resolveGitState(wikiPath);
  }

  async function buildCurrentScaffoldRecipe({ name = "Current Vibe Research scaffold", tags = [] } = {}) {
    await buildingHubService.refresh();
    const libraryGit = await getCurrentLibraryGitState();
    return buildScaffoldRecipe({
      agentPrompt: await agentPromptStore.getState(),
      app: await getAppMetadata(),
      buildingHub: {
        buildings: buildingHubService.listBuildings(),
        layouts: buildingHubService.listLayouts(),
        recipes: buildingHubService.listRecipes ? buildingHubService.listRecipes() : [],
        status: buildingHubService.getStatus(),
      },
      coreBuildings: BUILDING_CATALOG,
      defaultProviderId,
      layout: agentTownStore.getState().layout,
      library: { gitCommit: libraryGit.commit, gitBranch: libraryGit.branch },
      name,
      providers,
      settings: settingsStore.settings,
      tags,
    });
  }

  const AGENT_TOWN_BUNDLE_VERSION = 1;
  const AGENT_TOWN_BUNDLE_MAX_BYTES = 4 * 1024 * 1024;
  const AGENT_TOWN_BUNDLE_STORE_DIR = path.join(stateDir, "agent-town-bundles");
  const AGENT_TOWN_BUNDLE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,95}$/;

  function canonicalJson(value) {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map(canonicalJson).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }

  function computeBundleChecksum(bundle) {
    const { integrity, ...rest } = bundle || {};
    const canonical = canonicalJson(rest);
    return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  }

  function normalizeBundleId(value) {
    const text = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
    return AGENT_TOWN_BUNDLE_ID_PATTERN.test(text) ? text : "";
  }

  async function fetchBundleFromUrl(urlText) {
    let url;
    try {
      url = new URL(urlText);
    } catch {
      const error = new Error("Bundle URL is invalid.");
      error.statusCode = 400;
      throw error;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      const error = new Error("Bundle URL must use http or https.");
      error.statusCode = 400;
      throw error;
    }
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      const error = new Error(`Could not fetch bundle: ${response.status} ${response.statusText}`.trim());
      error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
      throw error;
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > AGENT_TOWN_BUNDLE_MAX_BYTES) {
      const error = new Error("Bundle exceeds maximum allowed size.");
      error.statusCode = 413;
      throw error;
    }
    const text = await response.text();
    if (text.length > AGENT_TOWN_BUNDLE_MAX_BYTES) {
      const error = new Error("Bundle exceeds maximum allowed size.");
      error.statusCode = 413;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const error = new Error("Bundle response was not valid JSON.");
      error.statusCode = 400;
      throw error;
    }
    return parsed?.bundle || parsed;
  }

  function describePluginById(pluginId, { hubBuildings = null } = {}) {
    if (!pluginId) return null;
    const hub = hubBuildings || (buildingHubService?.listBuildings ? buildingHubService.listBuildings() : []);
    const hubEntry = hub.find((entry) => entry?.id === pluginId);
    if (hubEntry) {
      return {
        id: pluginId,
        source: hubEntry.source || "buildinghub",
        version: hubEntry.version || "",
        repositoryUrl: hubEntry.buildingHub?.repositoryUrl || hubEntry.repositoryUrl || "",
        sourceId: hubEntry.buildingHub?.sourceId || "",
      };
    }
    const coreEntry = BUILDING_CATALOG.find((entry) => entry?.id === pluginId);
    if (coreEntry) {
      return {
        id: pluginId,
        source: coreEntry.source || "vibe-research",
        version: "",
        repositoryUrl: "",
        sourceId: "",
      };
    }
    return { id: pluginId, source: "unknown", version: "", repositoryUrl: "", sourceId: "" };
  }

  async function composeAgentTownBundle() {
    const town = agentTownStore.exportTownSection();
    const promptState = await agentPromptStore.getState();
    const settings = settingsStore.settings || {};
    const app = await getAppMetadata();

    if (buildingHubService?.refresh) {
      try {
        await buildingHubService.refresh();
      } catch {}
    }
    const hubBuildings = buildingHubService?.listBuildings ? buildingHubService.listBuildings() : [];

    const installedIds = new Set(Array.isArray(settings.installedPluginIds) ? settings.installedPluginIds : []);
    const functionalIds = Object.keys(town.layout?.functional || {});
    for (const id of functionalIds) {
      if (id) installedIds.add(id);
    }
    const installedPlugins = [...installedIds]
      .map((id) => describePluginById(id, { hubBuildings }))
      .filter(Boolean);

    const envSet = new Set();
    for (const pluginId of functionalIds) {
      if (!pluginId) continue;
      for (const varName of collectPluginEnvNames(pluginId)) {
        if (varName) envSet.add(varName);
      }
    }

    const bundle = {
      bundleVersion: AGENT_TOWN_BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      producer: {
        app: "vibe-research",
        version: app.version || "",
        commit: app.commit || "",
      },
      town: {
        stateVersion: town.stateVersion,
        layout: town.layout,
        layoutSnapshots: town.layoutSnapshots,
      },
      prompts: {
        selectedPromptId: promptState.selectedPromptId || "",
        customPrompt: promptState.customPrompt || "",
      },
      automations: Array.isArray(settings.agentAutomations) ? settings.agentAutomations : [],
      plugins: {
        installed: installedPlugins,
      },
      env: {
        required: Array.from(envSet).sort(),
      },
    };
    bundle.integrity = computeBundleChecksum(bundle);
    return bundle;
  }

  async function listPublishedBundles() {
    try {
      await mkdir(AGENT_TOWN_BUNDLE_STORE_DIR, { recursive: true });
      const entries = await readdir(AGENT_TOWN_BUNDLE_STORE_DIR);
      const results = [];
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const id = name.replace(/\.json$/, "");
        if (!AGENT_TOWN_BUNDLE_ID_PATTERN.test(id)) continue;
        try {
          const filePath = path.join(AGENT_TOWN_BUNDLE_STORE_DIR, name);
          const raw = await readFile(filePath, "utf8");
          const parsed = JSON.parse(raw);
          const fileStat = await stat(filePath);
          results.push({
            id,
            exportedAt: parsed?.exportedAt || null,
            integrity: parsed?.integrity || null,
            bundleVersion: parsed?.bundleVersion || null,
            byteLength: fileStat.size,
            updatedAt: fileStat.mtime.toISOString(),
          });
        } catch {
          // ignore unreadable entries
        }
      }
      return results.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async function readPublishedBundle(idInput) {
    const id = normalizeBundleId(idInput);
    if (!id) {
      const error = new Error("Invalid bundle id.");
      error.statusCode = 400;
      throw error;
    }
    const filePath = path.join(AGENT_TOWN_BUNDLE_STORE_DIR, `${id}.json`);
    try {
      const raw = await readFile(filePath, "utf8");
      return { id, bundle: JSON.parse(raw) };
    } catch (error) {
      if (error?.code === "ENOENT") {
        const notFound = new Error(`Bundle ${id} not found.`);
        notFound.statusCode = 404;
        throw notFound;
      }
      throw error;
    }
  }

  async function storePublishedBundle({ idInput, bundle }) {
    const requestedId = normalizeBundleId(idInput);
    const id = requestedId || normalizeBundleId(`bundle-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`) || "bundle";
    await mkdir(AGENT_TOWN_BUNDLE_STORE_DIR, { recursive: true });
    const filePath = path.join(AGENT_TOWN_BUNDLE_STORE_DIR, `${id}.json`);
    const withIntegrity = { ...bundle };
    withIntegrity.integrity = computeBundleChecksum(withIntegrity);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(withIntegrity, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
    return { id, bundle: withIntegrity };
  }

  async function deletePublishedBundle(idInput) {
    const id = normalizeBundleId(idInput);
    if (!id) {
      const error = new Error("Invalid bundle id.");
      error.statusCode = 400;
      throw error;
    }
    const filePath = path.join(AGENT_TOWN_BUNDLE_STORE_DIR, `${id}.json`);
    try {
      await rm(filePath, { force: false });
      return { id };
    } catch (error) {
      if (error?.code === "ENOENT") {
        const notFound = new Error(`Bundle ${id} not found.`);
        notFound.statusCode = 404;
        throw notFound;
      }
      throw error;
    }
  }

  function collectPluginEnvNames(pluginId) {
    const building = BUILDING_CATALOG.find((entry) => entry?.id === pluginId);
    if (!building) return [];
    const names = new Set();
    const sources = [
      building.requiredEnv,
      building.env,
      building.setup?.env,
      building.setup?.requiredEnv,
    ];
    for (const source of sources) {
      if (!source) continue;
      if (Array.isArray(source)) {
        for (const entry of source) {
          const name = typeof entry === "string" ? entry : entry?.name || entry?.key || "";
          if (name) names.add(String(name).trim());
        }
      } else if (typeof source === "object") {
        for (const key of Object.keys(source)) {
          names.add(String(key).trim());
        }
      }
    }
    return [...names].filter(Boolean);
  }

  async function applyAgentTownBundle(bundle, { dryRun = false } = {}) {
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
      const error = new Error("Bundle payload is missing or malformed.");
      error.statusCode = 400;
      throw error;
    }
    if (Number(bundle.bundleVersion) !== AGENT_TOWN_BUNDLE_VERSION) {
      const error = new Error(`Unsupported bundle version ${bundle.bundleVersion}. Expected ${AGENT_TOWN_BUNDLE_VERSION}.`);
      error.statusCode = 400;
      throw error;
    }

    let integrityStatus = null;
    if (bundle.integrity) {
      const expected = String(bundle.integrity);
      const actual = computeBundleChecksum(bundle);
      integrityStatus = expected === actual ? "match" : "mismatch";
      if (integrityStatus === "mismatch") {
        const error = new Error(`Bundle integrity check failed. Expected ${expected}, got ${actual}.`);
        error.statusCode = 400;
        throw error;
      }
    }

    const townSection = bundle.town || {};
    const validation = await agentTownStore.validateLayout({ layout: townSection.layout || {} });

    if (buildingHubService?.refresh) {
      try {
        await buildingHubService.refresh();
      } catch {}
    }
    const hubBuildings = buildingHubService?.listBuildings ? buildingHubService.listBuildings() : [];
    const hubIds = new Set(hubBuildings.map((entry) => entry?.id).filter(Boolean));
    const coreIds = new Set(BUILDING_CATALOG.map((entry) => entry?.id).filter(Boolean));

    const bundlePlugins = Array.isArray(bundle.plugins?.installed)
      ? bundle.plugins.installed.map((entry) => (typeof entry === "string" ? { id: entry } : entry || {}))
      : [];
    const layoutFunctionalIds = Object.keys((townSection.layout || {}).functional || {});
    for (const pluginId of layoutFunctionalIds) {
      if (!pluginId) continue;
      if (!bundlePlugins.some((entry) => entry.id === pluginId)) {
        bundlePlugins.push({ id: pluginId });
      }
    }

    const enrichedPlugins = bundlePlugins
      .filter((entry) => entry && entry.id)
      .map((entry) => ({
        ...entry,
        available: hubIds.has(entry.id) || coreIds.has(entry.id),
      }));

    const unavailablePlugins = enrichedPlugins.filter((entry) => !entry.available);

    const requiredEnv = Array.isArray(bundle.env?.required) ? bundle.env.required : [];
    const missingEnv = requiredEnv.filter((name) => {
      const trimmed = String(name || "").trim();
      return trimmed && !serverEnv[trimmed] && !process.env[trimmed];
    });

    const bundleSnapshots = Array.isArray(townSection.layoutSnapshots) ? townSection.layoutSnapshots : [];
    const automations = Array.isArray(bundle.automations) ? bundle.automations : [];

    const report = {
      validation,
      integrity: integrityStatus,
      counts: {
        functional: layoutFunctionalIds.length,
        decorations: Array.isArray((townSection.layout || {}).decorations)
          ? (townSection.layout || {}).decorations.length
          : 0,
        layoutSnapshots: bundleSnapshots.length,
        automations: automations.length,
        installedPlugins: enrichedPlugins.length,
      },
      plugins: enrichedPlugins,
      unavailablePlugins,
      missingPlugins: unavailablePlugins,
      missingEnv,
      warnings: [],
    };

    if (!validation.ok) {
      report.warnings.push("Layout validation failed; no changes were applied.");
      return { applied: false, dryRun, report };
    }

    if (dryRun) {
      return { applied: false, dryRun: true, report };
    }

    const rollbackName = `Pre-import ${new Date().toISOString()}`;
    try {
      await agentTownStore.createLayoutSnapshot({
        name: rollbackName,
        layout: agentTownStore.getState().layout,
      });
      report.rollbackSnapshotName = rollbackName;
    } catch (error) {
      report.warnings.push(`Pre-import snapshot skipped: ${error.message || error}`);
    }

    await agentTownStore.importTownSection(
      { layout: townSection.layout, layoutSnapshots: bundleSnapshots },
      { reason: "import bundle", replaceSnapshots: true },
    );

    if (bundle.prompts && typeof bundle.prompts === "object") {
      const { selectedPromptId, customPrompt } = bundle.prompts;
      const saveInput = {};
      if (typeof customPrompt === "string" && customPrompt.trim()) {
        saveInput.customPrompt = customPrompt;
      }
      if (typeof selectedPromptId === "string" && selectedPromptId.trim()) {
        saveInput.selectedPromptId = selectedPromptId;
      }
      if (Object.keys(saveInput).length > 0) {
        try {
          await agentPromptStore.save(saveInput);
        } catch (error) {
          report.warnings.push(`Prompt import skipped: ${error.message || error}`);
        }
      }
    }

    const settingsPatch = {};
    if (Array.isArray(bundle.automations)) {
      settingsPatch.agentAutomations = bundle.automations;
    }
    const installablePluginIds = enrichedPlugins
      .filter((entry) => entry.available)
      .map((entry) => entry.id);
    if (installablePluginIds.length > 0 || Array.isArray(bundle.plugins?.installed)) {
      settingsPatch.installedPluginIds = installablePluginIds;
    }
    if (Object.keys(settingsPatch).length > 0) {
      try {
        await settingsStore.update(settingsPatch);
      } catch (error) {
        report.warnings.push(`Settings import partial: ${error.message || error}`);
      }
    }

    return {
      applied: true,
      dryRun: false,
      report,
      agentTown: agentTownStore.getState(),
    };
  }

  function getAvailableBuildingIds() {
    return [
      ...BUILDING_CATALOG.map((building) => building.id),
      ...buildingHubService.listBuildings().map((building) => building.id),
    ];
  }

  function buildSessionManagerEnvironment() {
    const resolvedPort = exposedPort || port;
    const serverBaseUrl = publicBaseUrl || helperBaseUrl || `http://127.0.0.1:${resolvedPort}`;
    return {
      ...buildAgentCredentialEnv(settingsStore.settings, serverEnv),
      REMOTE_VIBES_PORT: String(resolvedPort),
      REMOTE_VIBES_SERVER_URL: serverBaseUrl,
      REMOTE_VIBES_URL: publicBaseUrl || serverBaseUrl,
      REMOTE_VIBES_AGENT_CALLBACK_BASE_URL: agentCallbackService.getCallbackBaseUrl(),
      REMOTE_VIBES_SCAFFOLD_RECIPES_API: `${serverBaseUrl}/api/scaffold-recipes`,
      REMOTE_VIBES_WALLET_API: `${serverBaseUrl}/api/wallet`,
      VIBE_RESEARCH_PORT: String(resolvedPort),
      VIBE_RESEARCH_SERVER_URL: serverBaseUrl,
      VIBE_RESEARCH_URL: publicBaseUrl || serverBaseUrl,
      VIBE_RESEARCH_AGENT_CALLBACK_BASE_URL: agentCallbackService.getCallbackBaseUrl(),
      VIBE_RESEARCH_AGENT_TOWN_API: `${serverBaseUrl}/api/agent-town`,
      VIBE_RESEARCH_SCAFFOLD_RECIPES_API: `${serverBaseUrl}/api/scaffold-recipes`,
      VIBE_RESEARCH_WALLET_API: `${serverBaseUrl}/api/wallet`,
    };
  }

  async function syncBuildingAgentGuides({ refreshBuildingHub = false } = {}) {
    if (refreshBuildingHub) {
      await buildingHubService.refresh();
    }

    try {
      return await writeBuildingAgentGuides({
        buildings: [...BUILDING_CATALOG, ...buildingHubService.listBuildings()],
        systemRootPath,
      });
    } catch (error) {
      console.error("[vibe-research] building guide sync failed:", error);
      return null;
    }
  }

  async function applyRuntimeSettings(settings, { backupReason = "settings" } = {}) {
    sessionDefaultCwd = await ensureDefaultSessionCwd(settings.agentSpawnPath, cwd);
    sessionManager.setDefaultCwd(sessionDefaultCwd);
    const wikiRootChanged = settings.wikiPath !== agentPromptStore.wikiRootPath;
    agentPromptStore.setWikiRootPath(settings.wikiPath);
    sessionManager.setWikiRootPath(settings.wikiPath);
    if (wikiRootChanged) {
      await agentPromptStore.refreshBuiltInSections();
    } else {
      await agentPromptStore.save({ selectedPromptId: agentPromptStore.selectedPromptId });
    }
    wikiBackupService.setConfig({
      enabled: settings.wikiGitBackupEnabled,
      intervalMs: settings.wikiBackupIntervalMs,
      remoteBranch: settings.wikiGitRemoteBranch,
      remoteEnabled: settings.wikiGitRemoteEnabled,
      remoteName: settings.wikiGitRemoteName,
      remoteUrl: settings.wikiGitRemoteUrl,
      wikiPath: settings.wikiPath,
    });
    wikiBackupService.start();
    sleepPreventionService.setConfig({
      enabled: settings.preventSleepEnabled,
    });
    browserUseService.restart(settingsStore.settings);
    buildingHubService.restart(settingsStore.settings);
    ottoAuthService.restart(settingsStore.settings);
    telegramService.restart(settingsStore.settings);
    twilioService.restart(settingsStore.settings);
    videoMemoryService.restart(settingsStore.settings);
    agentMailService.restart(settingsStore.settings);
    sessionManager.setEnvironment(buildSessionManagerEnvironment());
    await syncBuildingAgentGuides();
    if (backupReason) {
      void wikiBackupService.runBackup({ reason: backupReason });
    }
  }

  function pruneGoogleOAuthStates(now = Date.now()) {
    for (const [stateToken, entry] of googleOAuthStates.entries()) {
      if (!entry || now - Number(entry.createdAt || 0) > GOOGLE_OAUTH_STATE_TTL_MS) {
        googleOAuthStates.delete(stateToken);
      }
    }
  }

  function pruneGitHubOAuthStates(now = Date.now()) {
    for (const [stateToken, entry] of githubOAuthStates.entries()) {
      if (!entry || now - Number(entry.createdAt || 0) > GITHUB_OAUTH_STATE_TTL_MS) {
        githubOAuthStates.delete(stateToken);
      }
    }
  }

  function getBuildingHubPublisherFromGitHub() {
    const status = githubOAuthTokenStore.getStatus(BUILDINGHUB_GITHUB_OAUTH_INTEGRATION_ID);
    const user = normalizeBuildingHubPublisher(status?.user);
    if (!user) {
      return null;
    }

    return {
      provider: "github",
      id: user.id,
      login: user.login,
      name: user.name,
      profileUrl: user.profileUrl,
      avatarUrl: user.avatarUrl,
    };
  }

  function getBuildingHubAppBaseUrl() {
    return buildingHubAccountService.getAppBaseUrl(settingsStore.settings);
  }

  function getBuildingHubPublisherFromAccount() {
    const status = buildingHubAccountTokenStore.getStatus();
    const account = normalizeBuildingHubPublisher(status?.account);
    if (!account) {
      return null;
    }

    return {
      provider: "buildinghub",
      id: account.id,
      login: account.login,
      name: account.name,
      profileUrl: account.profileUrl,
      avatarUrl: account.avatarUrl,
    };
  }

  function getBuildingHubAccountAccessToken() {
    return String(buildingHubAccountTokenStore.getRecord()?.accessToken || "").trim();
  }

  function getBuildingHubPublisherFromSettings() {
    if (String(settingsStore.settings.buildingHubAuthProvider || "").trim().toLowerCase() !== "github") {
      return null;
    }

    const profileUrl = normalizeGitHubProfileUrl(settingsStore.settings.buildingHubProfileUrl);
    const login = getGitHubLoginFromProfileUrl(profileUrl);
    if (!profileUrl && !login) {
      return null;
    }

    return {
      provider: "github",
      id: "",
      login,
      name: "",
      profileUrl,
      avatarUrl: "",
    };
  }

  function getBuildingHubPublisher() {
    return getBuildingHubPublisherFromAccount() || getBuildingHubPublisherFromGitHub() || getBuildingHubPublisherFromSettings();
  }

  function getBuildingHubGitHubOAuthRedirectUri(callbackPort) {
    const callbackBaseUrl = getBuildingHubAuthCallbackBaseUrl(callbackPort, serverEnv);
    return callbackBaseUrl ? `${callbackBaseUrl}${BUILDINGHUB_GITHUB_OAUTH_CALLBACK_PATH}` : "";
  }

  function getBuildingHubAccountCompletionUrl(callbackPort) {
    const callbackBaseUrl = getBuildingHubAuthCallbackBaseUrl(callbackPort, serverEnv);
    return callbackBaseUrl ? `${callbackBaseUrl}${BUILDINGHUB_ACCOUNT_AUTH_COMPLETE_PATH}` : "";
  }

  async function syncBuildingHubPublication(publication) {
    const publisher = getBuildingHubPublisherFromAccount();
    if (!publisher || !publication) {
      return null;
    }

    try {
      return await buildingHubAccountService.recordPublication({
        settings: settingsStore.settings,
        publication,
      });
    } catch (error) {
      console.warn("[vibe-research] could not sync BuildingHub publication", error);
      return null;
    }
  }

  async function readGitOriginRemote(targetPath) {
    try {
      const { stdout = "" } = await execFileAsync("git", ["-C", targetPath, "remote", "get-url", "origin"]);
      return stdout.trim();
    } catch {
      return "";
    }
  }

  async function isInstallerBrainScaffold(targetPath, entries) {
    const allowedEntries = new Set([".git", ".gitignore", "README.md"]);
    const meaningfulEntries = entries.filter((entry) => entry !== ".DS_Store");
    if (
      meaningfulEntries.length === 0 ||
      meaningfulEntries.some((entry) => !allowedEntries.has(entry)) ||
      !meaningfulEntries.includes("README.md")
    ) {
      return false;
    }

    const originRemote = await readGitOriginRemote(targetPath);
    if (originRemote) {
      return false;
    }

    try {
      const readme = await readFile(path.join(targetPath, "README.md"), "utf8");
      return readme.includes("# mac-brain") && readme.includes("Vibe Research settings live in:");
    } catch {
      return false;
    }
  }

  async function directoryHasOnlyEntries(directoryPath, allowedEntries) {
    const entries = await readdir(directoryPath).catch(() => []);
    return entries
      .filter((entry) => entry !== ".DS_Store")
      .every((entry) => allowedEntries.has(entry));
  }

  async function isManagedLibraryScaffold(targetPath, entries) {
    const allowedEntries = new Set(["experiments", "index.md", "log.md", "raw", "topics"]);
    const meaningfulEntries = entries.filter((entry) => entry !== ".DS_Store");
    if (
      meaningfulEntries.length === 0 ||
      meaningfulEntries.some((entry) => !allowedEntries.has(entry)) ||
      !meaningfulEntries.includes("index.md") ||
      !meaningfulEntries.includes("log.md")
    ) {
      return false;
    }

    try {
      const indexContent = await readFile(path.join(targetPath, "index.md"), "utf8");
      const logContent = await readFile(path.join(targetPath, "log.md"), "utf8");
      if (
        !indexContent.includes("# Library Index") ||
        !indexContent.includes("Add experiment pages under `experiments/`") ||
        !logContent.includes("# Library Log")
      ) {
        return false;
      }

      return (
        await directoryHasOnlyEntries(path.join(targetPath, "experiments"), new Set([".gitkeep"])) &&
        await directoryHasOnlyEntries(path.join(targetPath, "topics"), new Set([".gitkeep"])) &&
        await directoryHasOnlyEntries(path.join(targetPath, "raw"), new Set(["sources"])) &&
        await directoryHasOnlyEntries(path.join(targetPath, "raw", "sources"), new Set([".gitkeep"]))
      );
    } catch {
      return false;
    }
  }

  async function prepareBrainCloneTarget(targetPath, remoteUrl) {
    await mkdir(path.dirname(targetPath), { recursive: true });

    try {
      const stats = await stat(targetPath);
      if (!stats.isDirectory()) {
        throw buildHttpError(`Library path is not a directory: ${targetPath}`, 400);
      }

      const entries = await readdir(targetPath);
      const meaningfulEntries = entries.filter((entry) => entry !== ".DS_Store");
      if (meaningfulEntries.length === 0) {
        return { action: "clone", existed: true };
      }

      const originRemote = await readGitOriginRemote(targetPath);
      if (
        originRemote &&
        normalizeGitRemoteForCompare(originRemote) === normalizeGitRemoteForCompare(remoteUrl)
      ) {
        return { action: "adopt", existed: true };
      }

      if (await isInstallerBrainScaffold(targetPath, entries)) {
        const backupPath = createCloneBackupPath(targetPath);
        await rename(targetPath, backupPath);
        return { action: "clone", backupPath, existed: false };
      }

      if (await isManagedLibraryScaffold(targetPath, entries)) {
        const backupPath = createCloneBackupPath(targetPath);
        await rename(targetPath, backupPath);
        return { action: "clone", backupPath, existed: false };
      }

      throw buildHttpError(
        `Library clone folder already has files: ${targetPath}. Choose an empty folder or move the existing folder first.`,
        409,
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { action: "clone", existed: false };
      }

      throw error;
    }
  }

  async function readBrainCloneBranch(targetPath) {
    try {
      const { stdout = "" } = await execFileAsync("git", [
        "-C",
        targetPath,
        "branch",
        "--show-current",
      ]);
      const branchName = stdout.trim();
      return branchName || "main";
    } catch {
      return "main";
    }
  }

  async function refreshProviders() {
    providers = Array.isArray(providerOverrides)
      ? await detectProviders(providerOverrides)
      : await detectProviders();
    defaultProviderId = getDefaultProviderId(providers);
    sessionManager.providers = providers;
    return { providers, defaultProviderId };
  }

  function getProviderInstallOutput(error) {
    const output = `${error?.stdout || ""}${error?.stderr || ""}`.trim();
    if (!output) {
      return "";
    }

    return output.length > 4000 ? output.slice(output.length - 4000) : output;
  }

  async function runProviderInstall(provider) {
    const installCommand = String(provider?.installCommand || "").trim();
    if (!installCommand) {
      throw buildHttpError(`${provider?.label || "That agent"} does not have an automatic install command yet.`, 400);
    }

    try {
      const shell = process.env.VIBE_RESEARCH_INSTALL_SHELL || process.env.REMOTE_VIBES_INSTALL_SHELL || "/bin/bash";
      const env = buildAgentCredentialEnv(settingsStore.settings, serverEnv);
      const { stdout = "", stderr = "" } = await execFileAsync(shell, ["-lc", installCommand], {
        cwd: sessionDefaultCwd || cwd,
        env,
        timeout: PROVIDER_INSTALL_TIMEOUT_MS,
        maxBuffer: PROVIDER_INSTALL_MAX_BUFFER,
      });

      return { stdout, stderr };
    } catch (error) {
      const detail = getProviderInstallOutput(error);
      const timedOut = error?.signal === "SIGTERM" || error?.killed;
      const message = timedOut
        ? `${provider.label} install timed out.`
        : `${provider.label} install failed.`;
      throw buildHttpError(detail ? `${message}\n${detail}` : message, 500);
    }
  }

  async function collectAndRecordSystemMetrics({ forceHistory = false } = {}) {
    const system = await systemMetricsProvider({
      agentProcessRoots: sessionManager.listAgentProcessRoots(),
      cwd,
      projectPaths: sessionManager.listProjectPaths(),
      wikiPath: settingsStore.settings.wikiPath,
    });
    system.agentUsage = agentRunStore.getProviderUsage({
      providers,
      sessions: sessionManager.listUsageSessions(),
    });
    await systemMetricsHistoryStore.record(system, { force: forceHistory });
    return system;
  }

  let systemMetricsSamplePromise = null;
  function sampleSystemMetricsHistory() {
    if (systemMetricsSamplePromise) {
      return systemMetricsSamplePromise;
    }

    systemMetricsSamplePromise = collectAndRecordSystemMetrics()
      .catch((error) => {
        console.error("[vibe-research] system metrics history sample failed:", error);
      })
      .finally(() => {
        systemMetricsSamplePromise = null;
      });

    return systemMetricsSamplePromise;
  }

  app.post("/api/wallet/stripe/webhook", express.raw({ type: "application/json", limit: JSON_BODY_LIMIT }), async (request, response) => {
    try {
      const webhookSecret = String(settingsStore.settings.walletStripeWebhookSecret || "").trim();
      if (!webhookSecret) {
        throw buildHttpError("Stripe webhook secret is not configured.", 400);
      }

      const rawBody = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : String(request.body || "");
      const signatureHeader = request.get("stripe-signature") || "";
      if (!verifyStripeWebhookSignature({ payload: rawBody, signatureHeader, webhookSecret })) {
        throw buildHttpError("Invalid Stripe webhook signature.", 400);
      }

      const event = JSON.parse(rawBody || "{}");
      if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
        const session = event.data?.object || {};
        if (!["paid", "no_payment_required"].includes(String(session.payment_status || ""))) {
          response.json({ received: true, skipped: "payment-not-complete" });
          return;
        }

        const amountCents = normalizeStripeAmountCents(
          session.metadata?.walletCreditCents || session.amount_total || session.amount_subtotal,
        );
        await walletService.grantCredits({
          actor: "stripe",
          amountCents,
          description: `Stripe deposit ${session.id || event.id || ""}`.trim(),
          idempotencyKey: `stripe:${event.id || session.id}`,
          metadata: {
            checkoutSessionId: session.id || "",
            customer: session.customer || "",
            paymentIntent: session.payment_intent || "",
          },
          source: "stripe_checkout",
        });
      }

      response.json({ received: true });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not process Stripe webhook." });
    }
  });

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use((request, response, next) => {
    if (request.path.startsWith("/api/") && request.get("X-Vibe-Research-API") === "1") {
      next();
      return;
    }

    const proxiedPort = getPortFromReferrer(request);

    if (!proxiedPort || getPortFromProxyPath(request.path)) {
      next();
      return;
    }

    proxyHttpRequest(request, response, proxyServer, proxiedPort, false);
  });

  app.post("/api/providers/refresh", async (_request, response) => {
    try {
      response.json(await refreshProviders());
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  app.post("/api/providers/:providerId/install", async (request, response) => {
    const providerId = String(request.params.providerId || "");
    const provider = providers.find((entry) => entry.id === providerId);

    if (!provider || provider.id === "shell") {
      response.status(404).json({ error: "Provider not found." });
      return;
    }

    try {
      const install = await runProviderInstall(provider);
      const providerState = await refreshProviders();
      response.json({
        ...providerState,
        install: {
          stdout: install.stdout,
          stderr: install.stderr,
        },
      });
    } catch (error) {
      try {
        await refreshProviders();
      } catch (refreshError) {
        console.error("[vibe-research] provider refresh after failed install failed:", refreshError);
      }
      response.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  // Explicit uninstall: removes the building from installedPluginIds
  // AND clears its MCP launches from the registry in one atomic step.
  // Symmetric to POST /install. The PATCH /api/settings handler also
  // does the registry cleanup when installedPluginIds shrinks (see
  // PR #24), so this route is mostly UX sugar — but it gives the
  // client a clean "uninstall" verb without needing to fetch+modify
  // the full installedPluginIds array.
  app.post("/api/buildings/:buildingId/uninstall", async (request, response) => {
    const buildingId = normalizeBuildingId(String(request.params.buildingId || ""));
    const building = BUILDING_CATALOG.find((entry) => entry.id === buildingId);
    if (!building) {
      response.status(404).json({ error: "Building not found." });
      return;
    }
    try {
      const previous = Array.isArray(settingsStore.settings.installedPluginIds)
        ? settingsStore.settings.installedPluginIds
        : [];
      if (previous.includes(buildingId)) {
        await settingsStore.update({
          installedPluginIds: previous.filter((id) => id !== buildingId),
        });
      }
      // Always clear the registry, even if the building wasn't in
      // installedPluginIds — handles edge cases where install.plan ran
      // but the user never confirmed the install via the legacy flow.
      const removed = mcpLaunchRegistry.remove(buildingId);
      // Auto-sync so Claude Code + Codex drop the entry from their
      // on-disk configs immediately. Best-effort — sync errors are
      // surfaced but don't fail the uninstall.
      let autoSync;
      let autoSyncError;
      if (runAutoSyncForAgents) {
        try { autoSync = runAutoSyncForAgents(); } catch (err) {
          autoSyncError = String(err?.message || err);
        }
      }
      response.json({
        buildingId,
        removedFromInstalledPluginIds: previous.includes(buildingId),
        removedFromRegistry: removed,
        installedPluginIds: settingsStore.settings.installedPluginIds,
        autoSync: autoSync ?? null,
        ...(autoSyncError ? { autoSyncError } : {}),
      });
    } catch (error) {
      response.status(500).json({ error: error?.message || "uninstall failed" });
    }
  });

  app.post("/api/buildings/:buildingId/install", async (request, response) => {
    const buildingId = normalizeBuildingId(String(request.params.buildingId || ""));
    const building = BUILDING_CATALOG.find((entry) => entry.id === buildingId);
    if (!building) {
      response.status(404).json({ error: "Building not found." });
      return;
    }
    if (!building.install?.plan) {
      response.status(400).json({ error: "Building has no install plan." });
      return;
    }
    try {
      const job = startInstallJob({
        jobStore: installJobStore,
        building,
        settingsStore,
        mcpRegistry: mcpLaunchRegistry,
        runHandshake: handshakeMcpLaunch,
        runAutoSync: runAutoSyncForAgents,
      });
      response.json({
        jobId: job.id,
        status: job.status,
        buildingId: building.id,
      });
    } catch (error) {
      response.status(500).json({ error: error?.message || "install start failed" });
    }
  });

  // Convenience: the most recent install job for a building, with full
  // log. Saves the UI from chaining /jobs?limit=1 → /jobs/:jobId.
  // 404 when nothing has run yet.
  app.get("/api/buildings/:buildingId/install/last", (request, response) => {
    const buildingId = normalizeBuildingId(String(request.params.buildingId || ""));
    const [job] = installJobStore.byBuilding(buildingId, { limit: 1 });
    if (!job) {
      response.status(404).json({ error: "No install jobs for this building." });
      return;
    }
    response.json({
      id: job.id,
      buildingId: job.buildingId,
      status: job.status,
      log: job.log,
      result: job.result,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  });

  // List recent install jobs for a building (newest first). Useful for
  // "show me the last 5 attempts so I can see when this last worked"
  // and for diffing log output across runs. Default limit keeps the
  // response small; ?limit=N can request more.
  app.get("/api/buildings/:buildingId/install/jobs", (request, response) => {
    const buildingId = normalizeBuildingId(String(request.params.buildingId || ""));
    const limit = Math.max(1, Math.min(50, Number(request.query.limit) || 10));
    const jobs = installJobStore.byBuilding(buildingId, { limit });
    // Strip the verbose log array from the listing — clients hit
    // /jobs/:jobId for the full log.
    response.json({
      buildingId,
      jobs: jobs.map((job) => ({
        id: job.id,
        status: job.status,
        result: job.result,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })),
    });
  });

  app.get("/api/buildings/:buildingId/install/jobs/:jobId", (request, response) => {
    const buildingId = normalizeBuildingId(String(request.params.buildingId || ""));
    const jobId = String(request.params.jobId || "");
    const job = installJobStore.get(jobId);
    if (!job || job.buildingId !== buildingId) {
      response.status(404).json({ error: "Install job not found." });
      return;
    }
    response.json({
      id: job.id,
      buildingId: job.buildingId,
      status: job.status,
      log: job.log,
      result: job.result,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  });

  // Lists every MCP launch declared by a building's install plan so the
  // host agent / Claude Desktop / Cursor can pull the spawn config. The
  // ?resolved=1 query param interpolates ${settingKey} templates against
  // the live settings store; without it the raw declaration is returned.
  app.get("/api/mcp/launches", (request, response) => {
    const resolved = String(request.query.resolved || "") === "1";
    response.json({
      launches: mcpLaunchRegistry.list({ resolved }),
    });
  });

  // Same data shaped like a Claude Desktop / Cursor MCP config. Always
  // returns resolved values so the consumer can write it straight to disk
  // or pipe it into a host that expects the standard shape.
  app.get("/api/mcp/config", (_request, response) => {
    response.json(mcpLaunchRegistry.toMcpConfig());
  });

  // Dry-run a building's resolved MCP launch: spawn it, watch for ~1.5s,
  // kill it, report alive / exited-fast / spawn-failed. The natural
  // completion of "did clicking Install actually produce a usable MCP
  // server?" — beyond just the npm-view package check at install time.
  app.post("/api/mcp/launches/:buildingId/test", async (request, response) => {
    const buildingId = normalizeBuildingId(String(request.params.buildingId || ""));
    if (!buildingId) {
      response.status(400).json({ error: "buildingId is required" });
      return;
    }
    if (!mcpLaunchRegistry.has(buildingId)) {
      response.status(404).json({ error: `no mcp launches declared for ${buildingId}` });
      return;
    }
    const launches = mcpLaunchRegistry
      .list({ resolved: true })
      .filter((entry) => entry.buildingId === buildingId);
    if (launches.length === 0) {
      response.status(404).json({ error: `no mcp launches declared for ${buildingId}` });
      return;
    }
    const results = [];
    for (const launch of launches) {
      const result = await testMcpLaunch({
        command: launch.command,
        args: launch.args,
        env: launch.env,
      });
      results.push({ label: launch.label || "", ...result });
    }
    response.json({
      buildingId,
      results,
      ok: results.every((entry) => entry.ok),
    });
  });

  // Deeper version of /test: actually speak MCP stdio protocol against
  // the spawned server (initialize → notifications/initialized → tools/list)
  // and report tool count. Catches more failure modes than /test —
  // e.g. server that boots but immediately rejects bad tokens during
  // initialize.
  app.post("/api/mcp/launches/:buildingId/handshake", async (request, response) => {
    const buildingId = normalizeBuildingId(String(request.params.buildingId || ""));
    if (!buildingId) {
      response.status(400).json({ error: "buildingId is required" });
      return;
    }
    if (!mcpLaunchRegistry.has(buildingId)) {
      response.status(404).json({ error: `no mcp launches declared for ${buildingId}` });
      return;
    }
    const launches = mcpLaunchRegistry
      .list({ resolved: true })
      .filter((entry) => entry.buildingId === buildingId);
    if (launches.length === 0) {
      response.status(404).json({ error: `no mcp launches declared for ${buildingId}` });
      return;
    }
    const results = [];
    for (const launch of launches) {
      const result = await handshakeMcpLaunch({
        command: launch.command,
        args: launch.args,
        env: launch.env,
      });
      results.push({ label: launch.label || "", ...result });
    }
    response.json({
      buildingId,
      results,
      ok: results.every((entry) => entry.ok),
    });
  });

  // Aggregate health: handshakes every declared launch in parallel batches
  // (one at a time today; trivially upgradeable). 30s response cache so
  // repeated UI polls don't stampede the spawner. Pass ?force=1 to skip
  // the cache.
  app.post("/api/mcp/launches/health", async (request, response) => {
    const force = String(request.query.force || "") === "1";
    try {
      const result = await mcpLaunchHealthMonitor.checkAll({ force });
      response.json(result);
    } catch (error) {
      response.status(500).json({ error: error?.message || "health check failed" });
    }
  });

  // Sync the MCP-launch registry into Claude Code (~/.claude.json) and
  // Codex (~/.codex/config.toml) so those agent CLIs actually see the
  // MCP servers Vibe Research has installed. Each managed entry carries
  // a _vibeResearchManaged: true marker so subsequent syncs replace
  // ours cleanly without clobbering hand-edited entries.
  app.post("/api/mcp/sync", async (request, response) => {
    const targets = String(request.query.target || request.body?.target || "all").toLowerCase();
    try {
      const out = {};
      if (targets === "all" || targets === "claude") {
        out.claude = syncToClaudeCode({ registry: mcpLaunchRegistry });
      }
      if (targets === "all" || targets === "codex") {
        out.codex = syncToCodex({ registry: mcpLaunchRegistry });
      }
      response.json(out);
    } catch (error) {
      response.status(500).json({ error: error?.message || "sync failed" });
    }
  });

  // Same payload as /api/mcp/config but served with a download disposition
  // so a "Sync with Claude Desktop" button in the UI can produce the file
  // the user drops at ~/Library/Application Support/Claude/claude_desktop_config.json
  // (or the equivalent path on Windows/Linux). Pretty-printed for legibility.
  app.get("/api/mcp/config/download", (_request, response) => {
    const config = mcpLaunchRegistry.toMcpConfig();
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Disposition", "attachment; filename=\"claude_desktop_config.json\"");
    response.setHeader("Cache-Control", "no-store");
    response.send(`${JSON.stringify(config, null, 2)}\n`);
  });

  app.get("/", (request, response, next) => {
    if (!isMasterplanHost(request)) {
      next();
      return;
    }

    response.setHeader("Cache-Control", "no-store");
    response.sendFile(masterplanIndexPath);
  });

  app.get("/api/state", async (_request, response) => {
    // /api/state is the first thing the browser hits on page load. If anything
    // here throws (network blip refreshing the BuildingHub catalog, transient
    // file error syncing agent guides, port-scan hiccup), an unhandled async
    // rejection leaves the response hanging and the user sees a blank page.
    // Catch and emit a 500 with the message so the UI can show something.
    try {
      await buildingHubService.refresh();
      await syncBuildingAgentGuides();
      // Compact summary of the MCP-launch registry so the UI can show
      // "N MCP servers wired up, K still need a token" without an extra
      // round-trip. Detail lives at GET /api/mcp/launches.
      const mcpLaunches = mcpLaunchRegistry.list({ resolved: true });
      // Last health result (if any) — only surface what's cached. We
      // never trigger a handshake from /api/state because that would
      // spawn real processes on every page load. The UI calls POST
      // /api/mcp/launches/health explicitly when the user clicks
      // refresh.
      const lastHealth = mcpLaunchHealthMonitor.lastResult();
      response.json({
        appName: "Vibe Research",
        agentPrompt: await agentPromptStore.getState(),
        agentTown: agentTownStore.getState(),
        buildingHub: {
          buildings: buildingHubService.listBuildings(),
          layouts: buildingHubService.listLayouts(),
          recipes: buildingHubService.listRecipes ? buildingHubService.listRecipes() : [],
          status: buildingHubService.getStatus(),
        },
        cwd,
        defaultSessionCwd: sessionDefaultCwd,
        defaultProviderId,
        providers,
        sessions: sessionManager.listSessions(),
        settings: getSettingsState(),
        stateDir,
        urls,
        preferredUrl,
        ports: await listNamedPorts(),
        mcp: {
          totalLaunches: mcpLaunches.length,
          unresolvedLaunches: mcpLaunches.filter((entry) => entry.unresolved).length,
          buildings: [...new Set(mcpLaunches.map((entry) => entry.buildingId))].sort(),
          lastHealth: lastHealth
            ? {
                generatedAt: lastHealth.generatedAt,
                summary: lastHealth.summary,
              }
            : null,
        },
      });
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not load Vibe Research state." });
    }
  });

  app.get("/healthz", (_request, response) => {
    response.json({
      ok: true,
      service: "vibe-research",
      publicBaseUrl,
      stateDir,
    });
  });

  app.get("/api/buildinghub/catalog", async (request, response) => {
    try {
      await buildingHubService.refresh({ force: request.query.force === "1" || request.query.force === "true" });
      await syncBuildingAgentGuides();
      response.json({
        buildings: buildingHubService.listBuildings(),
        layouts: buildingHubService.listLayouts(),
        recipes: buildingHubService.listRecipes ? buildingHubService.listRecipes() : [],
        buildingHub: buildingHubService.getStatus(),
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not load BuildingHub catalog." });
    }
  });

  app.get("/api/scaffold-recipes/current", async (request, response) => {
    try {
      const tags = String(request.query.tags || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      const recipe = await buildCurrentScaffoldRecipe({
        name: request.query.name || "Current Vibe Research scaffold",
        tags,
      });
      const libraryGit = await getCurrentLibraryGitState();
      response.json({
        recipe,
        preview: previewScaffoldRecipe(recipe, {
          availableBuildingIds: getAvailableBuildingIds(),
          currentLibraryGitCommit: libraryGit.commit,
          currentLibraryGitBranch: libraryGit.branch,
          settings: settingsStore.settings,
        }),
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not export scaffold recipe." });
    }
  });

  app.get("/api/scaffold-recipes", (_request, response) => {
    response.json({
      recipes: scaffoldRecipeService.listRecipes(),
    });
  });

  app.post("/api/scaffold-recipes", async (request, response) => {
    try {
      const recipe = await scaffoldRecipeService.saveRecipe(request.body?.recipe || request.body || {});
      response.status(201).json({ recipe });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not save scaffold recipe." });
    }
  });

  app.post("/api/scaffold-recipes/current", async (request, response) => {
    try {
      const recipe = await buildCurrentScaffoldRecipe({
        name: request.body?.name || "Current Vibe Research scaffold",
        tags: request.body?.tags || [],
      });
      const saved = await scaffoldRecipeService.saveRecipe({
        ...recipe,
        id: request.body?.id || recipe.id,
        name: request.body?.name || recipe.name,
        description: request.body?.description || recipe.description,
      });
      response.status(201).json({ recipe: saved });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not save current scaffold recipe." });
    }
  });

  app.get("/api/scaffold-recipes/:recipeId", (request, response) => {
    const recipe = scaffoldRecipeService.getRecipe(request.params.recipeId);
    if (!recipe) {
      response.status(404).json({ error: "Scaffold recipe not found." });
      return;
    }
    response.json({ recipe });
  });

  app.delete("/api/scaffold-recipes/:recipeId", async (request, response) => {
    try {
      const recipe = await scaffoldRecipeService.deleteRecipe(request.params.recipeId);
      response.json({ recipe });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not delete scaffold recipe." });
    }
  });

  app.post("/api/scaffold-recipes/preview", async (request, response) => {
    try {
      await buildingHubService.refresh();
      const libraryGit = await getCurrentLibraryGitState();
      const preview = previewScaffoldRecipe(request.body?.recipe || request.body || {}, {
        availableBuildingIds: getAvailableBuildingIds(),
        currentLibraryGitCommit: libraryGit.commit,
        currentLibraryGitBranch: libraryGit.branch,
        localBindings: request.body?.localBindings || {},
        settings: settingsStore.settings,
      });
      response.json({ preview, recipe: preview.recipe });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not preview scaffold recipe." });
    }
  });

  async function applyScaffoldRecipeInput(input = {}) {
    const plan = createScaffoldRecipeApplyPlan(input.recipe || input, {
      localBindings: input.localBindings || {},
    });
    await settingsStore.update({
      ...plan.settingsPatch,
      ...plan.localSettingsPatch,
    });
    await applyRuntimeSettings(settingsStore.settings, {
      backupReason: shouldSyncLibraryForSettingsPatch(plan.localSettingsPatch) ? "scaffold-recipe" : false,
    });
    let layoutPayload = null;
    if (plan.layout) {
      layoutPayload = await agentTownStore.importLayout({
        layout: plan.layout,
        reason: `apply scaffold recipe ${plan.recipe.name}`,
      });
    }
    if (input.applyOccupation && plan.occupation?.selectedPromptId) {
      await agentPromptStore.save({
        selectedPromptId: plan.occupation.selectedPromptId,
      });
      sessionManager.setOccupationId(agentPromptStore.selectedPromptId);
    }
    await syncBuildingAgentGuides({ refreshBuildingHub: true });
    const libraryGit = await getCurrentLibraryGitState();
    return {
      agentPrompt: await agentPromptStore.getState(),
      agentTown: layoutPayload?.state || agentTownStore.getState(),
      plan,
      preview: previewScaffoldRecipe(plan.recipe, {
        availableBuildingIds: getAvailableBuildingIds(),
        currentLibraryGitCommit: libraryGit.commit,
        currentLibraryGitBranch: libraryGit.branch,
        localBindings: input.localBindings || {},
        settings: settingsStore.settings,
      }),
      recipe: plan.recipe,
      settings: getSettingsState(),
    };
  }

  app.post("/api/scaffold-recipes/apply", async (request, response) => {
    try {
      response.json(await applyScaffoldRecipeInput(request.body || {}));
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not apply scaffold recipe." });
    }
  });

  app.post("/api/scaffold-recipes/:recipeId/apply", async (request, response) => {
    try {
      const recipe = scaffoldRecipeService.getRecipe(request.params.recipeId);
      if (!recipe) {
        response.status(404).json({ error: "Scaffold recipe not found." });
        return;
      }
      response.json(await applyScaffoldRecipeInput({
        ...request.body,
        recipe,
      }));
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not apply scaffold recipe." });
    }
  });

  app.post("/api/scaffold-recipes/:recipeId/publish", async (request, response) => {
    try {
      const recipe = request.params.recipeId === "current"
        ? await buildCurrentScaffoldRecipe({
            name: request.body?.name || "Current Vibe Research scaffold",
            tags: request.body?.tags || [],
          })
        : scaffoldRecipeService.getRecipe(request.params.recipeId);
      if (!recipe) {
        response.status(404).json({ error: "Scaffold recipe not found." });
        return;
      }
      const buildingHub = await publishScaffoldRecipeToBuildingHub({
        recipe: {
          ...recipe,
          name: request.body?.name || recipe.name,
          description: request.body?.description || recipe.description,
        },
        settings: settingsStore.settings,
        cwd,
        env: serverEnv,
        publisher: getBuildingHubPublisher(),
        accessToken: getBuildingHubAccountAccessToken(),
      });
      const saved = await scaffoldRecipeService.saveRecipe({
        ...recipe,
        source: {
          ...recipe.source,
          kind: "buildinghub",
          sourceId: "local",
          ...buildingHub,
        },
      });
      if (!buildingHub.recordedByBuildingHub) {
        await syncBuildingHubPublication({
          kind: "recipe",
          id: buildingHub.recipeId,
          name: saved.name || recipe.name,
          url: buildingHub.recipeUrl,
          sourceUrl: buildingHub.repositoryUrl,
          commitUrl: buildingHub.commitUrl,
        });
      }
      await buildingHubService.refresh({ force: true });
      await syncBuildingAgentGuides();
      response.status(201).json({
        recipe: saved,
        buildingHub,
        buildingHubStatus: buildingHubService.getStatus(),
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not publish scaffold recipe." });
    }
  });

  app.get("/", (request, response, next) => {
    if (!isMasterplanHost(request)) {
      next();
      return;
    }

    response.setHeader("Cache-Control", "no-store");
    response.sendFile(masterplanIndexPath);
  });

  app.get("/api/ports", async (_request, response) => {
    try {
      response.json({ ports: await listNamedPorts() });
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not list named ports." });
    }
  });

  app.get("/api/system", async (_request, response) => {
    try {
      response.json({
        system: await collectAndRecordSystemMetrics(),
      });
    } catch (error) {
      response.status(500).json({ error: error.message || "Could not read system metrics." });
    }
  });

  app.get("/api/system/history", (request, response) => {
    response.json({
      history: systemMetricsHistoryStore.getHistory(String(request.query.range || "1h")),
    });
  });

  app.patch("/api/ports/:port", async (request, response) => {
    try {
      const port = normalizePort(request.params.port);

      if (!port) {
        response.status(400).json({ error: "Invalid port." });
        return;
      }

      const ports = await listNamedPorts();
      const currentPort = ports.find((entry) => entry.port === port);

      if (!currentPort) {
        response.status(404).json({ error: "Port not found." });
        return;
      }

      const name = typeof request.body?.name === "string" ? request.body.name : request.body?.name;
      const nextName = await portAliasStore.rename(port, name);
      const refreshedPorts = await listNamedPorts();
      const renamedPort =
        refreshedPorts.find((entry) => entry.port === port) ??
        {
          ...currentPort,
          name: nextName || String(port),
          customName: Boolean(nextName),
        };

      response.json({ port: renamedPort });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/ports/:port/tailscale", async (request, response) => {
    try {
      const port = normalizePort(request.params.port);

      if (!port) {
        response.status(400).json({ error: "Invalid port." });
        return;
      }

      const ports = await listNamedPorts();
      const currentPort = ports.find((entry) => entry.port === port);

      if (!currentPort) {
        response.status(404).json({ error: "Port not found." });
        return;
      }

      if (!currentPort.tailscaleUrl) {
        response.status(400).json({ error: "No Tailscale address is available for this Vibe Research instance." });
        return;
      }

      if (currentPort.directUrl || currentPort.exposedWithTailscale) {
        response.json({
          ok: true,
          port: currentPort,
          tailscale: {
            available: true,
            enabled: true,
            port,
          },
        });
        return;
      }

      if (!currentPort.canExposeWithTailscale) {
        response.status(400).json({
          error:
            currentPort.tailscaleServeReason ||
            "This port is not eligible for Tailscale Serve exposure.",
        });
        return;
      }

      if (!tailscaleServeManager || typeof tailscaleServeManager.exposePort !== "function") {
        response.status(400).json({ error: "Tailscale Serve is not configured." });
        return;
      }

      const tailscale = await tailscaleServeManager.exposePort(port);
      const refreshedPorts = await listNamedPorts();

      response.json({
        ok: true,
        port: refreshedPorts.find((entry) => entry.port === port) ?? currentPort,
        tailscale,
      });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not expose port with Tailscale Serve." });
    }
  });

  app.get("/api/update/status", async (request, response) => {
    try {
      const force = request.query.force === "1" || request.query.force === "true";
      const update = await updateManager.getStatus({ force });
      response.json({ update });
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not check update status." });
    }
  });

  // Diagnostic: open a WebSocket from the server back to its OWN /ws endpoint
  // and report what happened. Lets us isolate "WS is broken everywhere" from
  // "WS is broken when going through Tailscale serve". Pass ?sessionId=...
  // to also exercise sessionManager.attachClient. No auth required because
  // the same loopback endpoint is reachable to anyone who can hit /api.
  app.get("/api/debug/ws-selftest", async (request, response) => {
    const sessionId = String(request.query.sessionId || "selftest-no-session");
    const targetPort = exposedPort || port;
    const targetUrl = `ws://127.0.0.1:${targetPort}/ws?sessionId=${encodeURIComponent(sessionId)}`;
    const startedAt = Date.now();
    const events = [];
    let ws;
    try {
      ws = new NodeWebSocket(targetUrl);
    } catch (error) {
      response.json({ targetUrl, ctorError: error.message, events });
      return;
    }
    const finish = (verdict) => {
      try { ws.terminate?.(); } catch {}
      response.json({
        targetUrl,
        verdict,
        elapsedMs: Date.now() - startedAt,
        clientsConnected: websocketServer.clients.size,
        upgradeListeners: server.listenerCount("upgrade"),
        events,
      });
    };
    ws.on("open", () => events.push({ at: Date.now() - startedAt, ev: "open" }));
    ws.on("message", (data) => {
      events.push({ at: Date.now() - startedAt, ev: "message", size: Buffer.isBuffer(data) ? data.length : String(data).length });
      if (events.filter((e) => e.ev === "message").length >= 1) finish("ok-got-message");
    });
    ws.on("error", (error) => events.push({ at: Date.now() - startedAt, ev: "error", message: error?.message }));
    ws.on("close", (code, reason) => {
      events.push({ at: Date.now() - startedAt, ev: "close", code, reason: reason?.toString?.() });
      if (!events.some((e) => e.ev === "message")) finish("closed-without-message");
    });
    setTimeout(() => {
      if (ws.readyState !== NodeWebSocket.CLOSED) finish("timeout-7s");
    }, 7000);
  });

  app.post("/api/update/apply", async (_request, response) => {
    try {
      const result = await updateManager.scheduleUpdateAndRestart();
      response.json(result);
    } catch (error) {
      response.status(error.statusCode || 500).json({
        error: error.message || "Could not schedule update.",
        update: error.update,
      });
    }
  });

  app.get("/api/tutorials", (_request, response) => {
    response.json({ tutorials: tutorialRegistry.list() });
  });

  app.get("/api/tutorials/:id", (request, response) => {
    const tutorial = tutorialRegistry.get(String(request.params?.id || ""));
    if (!tutorial) {
      response.status(404).json({ error: "Tutorial not found." });
      return;
    }
    response.json({ tutorial });
  });

  app.get("/api/agent-town/state", (_request, response) => {
    response.json({
      agentTown: agentTownStore.getState(),
    });
  });

  app.put("/api/agent-town/state", async (request, response) => {
    try {
      const agentTown = await agentTownStore.updateMirror(request.body || {});
      response.json({ agentTown });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not update Agent Town state." });
    }
  });

  app.post("/api/agent-town/layout/validate", async (request, response) => {
    try {
      const validation = await agentTownStore.validateLayout(request.body || {});
      response.json({ validation });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not validate Agent Town layout." });
    }
  });

  app.put("/api/agent-town/layout", async (request, response) => {
    try {
      const payload = await agentTownStore.importLayout(request.body || {});
      response.json({
        validation: payload.validation,
        agentTown: payload.state,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({
        error: error.message || "Could not import Agent Town layout.",
        validation: error.validation,
      });
    }
  });

  app.post("/api/agent-town/layout/snapshots", async (request, response) => {
    try {
      const payload = await agentTownStore.createLayoutSnapshot(request.body || {});
      response.status(201).json({
        snapshot: payload.snapshot,
        agentTown: payload.state,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not save Agent Town snapshot." });
    }
  });

  app.post("/api/agent-town/layout/snapshots/:snapshotId/restore", async (request, response) => {
    try {
      const payload = await agentTownStore.restoreLayoutSnapshot(request.params.snapshotId);
      response.json({
        snapshot: payload.snapshot,
        agentTown: payload.state,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not restore Agent Town snapshot." });
    }
  });

  app.get("/api/agent-town/bundle", async (_request, response) => {
    try {
      const bundle = await composeAgentTownBundle();
      response.setHeader("Cache-Control", "no-store");
      response.json({ bundle });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message || "Could not export Agent Town bundle." });
    }
  });

  app.post("/api/agent-town/bundle/import", async (request, response) => {
    try {
      const body = request.body || {};
      const dryRun = body.dryRun === true;
      let bundle = body.bundle;
      if (!bundle && typeof body.bundleId === "string" && body.bundleId.trim()) {
        const id = body.bundleId.trim();
        try {
          const entry = await readPublishedBundle(id);
          bundle = entry.bundle;
        } catch (error) {
          if (error?.statusCode === 404) {
            await buildingHubService.refresh();
            const hubEntry = buildingHubService.getBundle(id);
            if (hubEntry?.bundle) {
              bundle = hubEntry.bundle;
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
      }
      if (!bundle && typeof body.url === "string" && body.url.trim()) {
        bundle = await fetchBundleFromUrl(body.url.trim());
      }
      if (!bundle) {
        bundle = body;
      }
      const result = await applyAgentTownBundle(bundle, { dryRun });
      response.status(result.applied || dryRun ? 200 : 400).json(result);
    } catch (error) {
      response.status(error.statusCode || 400).json({
        error: error.message || "Could not import Agent Town bundle.",
        validation: error.validation,
      });
    }
  });

  app.get("/api/agent-town/bundles", async (_request, response) => {
    try {
      const bundles = await listPublishedBundles();
      response.json({ bundles });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message || "Could not list bundles." });
    }
  });

  app.post("/api/agent-town/bundles", async (request, response) => {
    try {
      const body = request.body || {};
      const sourceBundle = body.bundle || (await composeAgentTownBundle());
      const stored = await storePublishedBundle({ idInput: body.id, bundle: sourceBundle });
      const baseUrl = String(body.baseUrl || "").trim().replace(/\/+$/, "");
      const relativeUrl = `/api/agent-town/bundles/${encodeURIComponent(stored.id)}`;
      response.status(201).json({
        id: stored.id,
        integrity: stored.bundle.integrity,
        url: baseUrl ? `${baseUrl}${relativeUrl}` : relativeUrl,
        bundle: stored.bundle,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not publish bundle." });
    }
  });

  app.get("/api/agent-town/bundles/:bundleId", async (request, response) => {
    try {
      const entry = await readPublishedBundle(request.params.bundleId);
      response.setHeader("Cache-Control", "no-store");
      response.json({ id: entry.id, bundle: entry.bundle });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message || "Could not read bundle." });
    }
  });

  app.delete("/api/agent-town/bundles/:bundleId", async (request, response) => {
    try {
      const result = await deletePublishedBundle(request.params.bundleId);
      response.json({ id: result.id, deleted: true });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message || "Could not delete bundle." });
    }
  });

  app.post("/api/agent-town/bundles/:bundleId/publish-to-hub", async (request, response) => {
    try {
      const entry = await readPublishedBundle(request.params.bundleId);
      const result = await publishBundleToBuildingHub({
        bundle: entry.bundle,
        bundleId: entry.id,
        settings: settingsStore.settings,
        cwd,
        env: serverEnv,
        accessToken: getBuildingHubAccountAccessToken(),
      });
      if (!result.recordedByBuildingHub) {
        await syncBuildingHubPublication({
          kind: "bundle",
          id: result.bundleId,
          name: entry.bundle?.producer?.app
            ? `${entry.bundle.producer.app} ${entry.id}`
            : entry.id,
          url: result.bundleUrl,
          sourceUrl: result.repositoryUrl,
          commitUrl: result.commitUrl,
        });
      }
      await buildingHubService.refresh({ force: true });
      response.status(201).json({ ...result, id: result.bundleId });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not publish bundle to BuildingHub." });
    }
  });

  app.get("/api/agent-town/bundle-hub", async (_request, response) => {
    try {
      await buildingHubService.refresh();
      response.json({
        bundles: buildingHubService.listBundles(),
        status: buildingHubService.getStatus(),
      });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message || "Could not list BuildingHub bundles." });
    }
  });

  app.get("/api/agent-town/bundle-hub/:bundleId", async (request, response) => {
    try {
      await buildingHubService.refresh();
      const entry = buildingHubService.getBundle(request.params.bundleId);
      if (!entry) {
        response.status(404).json({ error: "Bundle not found in BuildingHub." });
        return;
      }
      response.json({ id: entry.id, bundle: entry.bundle, metadata: entry });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message || "Could not read BuildingHub bundle." });
    }
  });

  app.post("/api/agent-town/bundle-hub/:bundleId/import", async (request, response) => {
    try {
      const body = request.body || {};
      const dryRun = body.dryRun === true;
      await buildingHubService.refresh();
      const entry = buildingHubService.getBundle(request.params.bundleId);
      if (!entry || !entry.bundle) {
        response.status(404).json({ error: "Bundle not found in BuildingHub." });
        return;
      }
      const result = await applyAgentTownBundle(entry.bundle, { dryRun });
      response.status(result.applied || dryRun ? 200 : 400).json({ source: "buildinghub", id: entry.id, ...result });
    } catch (error) {
      response.status(error.statusCode || 400).json({
        error: error.message || "Could not import BuildingHub bundle.",
        validation: error.validation,
      });
    }
  });

  app.get("/api/agent-town/town-shares", (request, response) => {
    const state = agentTownStore.getState();
    response.json({
      townShares: state.townShares.map((townShare) => withTownShareUrls(townShare, request)),
    });
  });

  app.post("/api/agent-town/town-shares", async (request, response) => {
    try {
      const body = request.body || {};
      const shareId = normalizeTownShareId(body.id);
      const image = body.imageDataUrl
        ? await saveTownShareImage({
            stateDir,
            shareId,
            dataUrl: body.imageDataUrl,
            mimeType: body.imageMimeType,
          })
        : {};
      const localPayload = await agentTownStore.publishTownShare({
        ...body,
        id: shareId,
        imagePath: image.imagePath,
        imageMimeType: image.imageMimeType,
        imageByteLength: image.imageByteLength,
        imageUpdatedAt: image.imageUpdatedAt,
      });
      const buildingHub = await publishTownShareToBuildingHub({
        townShare: localPayload.townShare,
        stateDir,
        settings: settingsStore.settings,
        cwd,
        env: serverEnv,
        publisher: getBuildingHubPublisher(),
        accessToken: getBuildingHubAccountAccessToken(),
      });
      const payload = await agentTownStore.publishTownShare({
        ...localPayload.townShare,
        buildingHub,
      });
      if (!buildingHub.recordedByBuildingHub) {
        await syncBuildingHubPublication({
          kind: "layout",
          id: buildingHub.layoutId,
          name: payload.townShare?.name || localPayload.townShare?.name || "Agent Town share",
          url: buildingHub.layoutUrl,
          sourceUrl: buildingHub.repositoryUrl,
          commitUrl: buildingHub.commitUrl,
        });
      }
      await buildingHubService.refresh({ force: true });
      await syncBuildingAgentGuides();
      response.status(201).json({
        townShare: withTownShareUrls(payload.townShare, request),
        validation: payload.validation,
        agentTown: payload.state,
        buildingHub,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({
        error: error.message || "Could not publish Agent Town share.",
        validation: error.validation,
      });
    }
  });

  app.get("/api/agent-town/town-shares/:shareId", (request, response) => {
    const townShare = agentTownStore.getTownShare(request.params.shareId);
    if (!townShare) {
      response.status(404).json({ error: "Agent Town share not found." });
      return;
    }

    response.json({
      townShare: withTownShareUrls(townShare, request),
    });
  });

  app.get("/api/agent-town/town-shares/:shareId/image", async (request, response) => {
    try {
      const townShare = agentTownStore.getTownShare(request.params.shareId);
      if (!townShare) {
        response.status(404).json({ error: "Agent Town share not found." });
        return;
      }

      const image = await resolveTownShareImage({ townShare, stateDir });
      response.setHeader("Cache-Control", "public, max-age=300");
      response.setHeader("Content-Type", image.mimeType);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.sendFile(image.targetPath, { dotfiles: "allow" }, (error) => {
        if (!error) {
          return;
        }

        if (response.headersSent) {
          response.destroy(error);
          return;
        }

        response.status(error.statusCode || 500).json({ error: error.message });
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not read Agent Town share image." });
    }
  });

  app.post("/api/agent-town/town-shares/:shareId/import", async (request, response) => {
    try {
      const payload = await agentTownStore.importTownShare(request.params.shareId);
      response.json({
        townShare: withTownShareUrls(payload.townShare, request),
        validation: payload.validation,
        agentTown: payload.state,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({
        error: error.message || "Could not import Agent Town share.",
        validation: error.validation,
      });
    }
  });

  app.get("/buildinghub/towns/:shareId", (request, response) => {
    const townShare = agentTownStore.getTownShare(request.params.shareId);
    if (!townShare) {
      response.status(404).send("Agent Town share not found.");
      return;
    }

    response.setHeader("Cache-Control", "no-store");
    response.type("html").send(renderTownSharePage(townShare, request));
  });

  app.post("/api/agent-town/layout/undo", async (_request, response) => {
    try {
      const payload = await agentTownStore.undoLayout();
      response.json({
        changed: payload.changed,
        agentTown: payload.state,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not undo Agent Town layout." });
    }
  });

  app.post("/api/agent-town/layout/redo", async (_request, response) => {
    try {
      const payload = await agentTownStore.redoLayout();
      response.json({
        changed: payload.changed,
        agentTown: payload.state,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not redo Agent Town layout." });
    }
  });

  app.post("/api/agent-town/events", async (request, response) => {
    try {
      const payload = await agentTownStore.recordEvent(request.body || {});
      response.status(201).json({
        event: payload.event,
        agentTown: payload.state,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not record Agent Town event." });
    }
  });

  app.get("/api/agent-town/highlight", (_request, response) => {
    response.json({
      highlight: agentTownStore.getHighlight(),
    });
  });

  app.post("/api/agent-town/highlight", async (request, response) => {
    try {
      const payload = await agentTownStore.setHighlight(request.body || {});
      response.status(201).json({
        highlight: payload.highlight,
        agentTown: payload.state,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not set Agent Town highlight." });
    }
  });

  app.delete("/api/agent-town/highlight", async (_request, response) => {
    try {
      const payload = await agentTownStore.clearHighlight();
      response.json({
        highlight: null,
        agentTown: payload.state,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not clear Agent Town highlight." });
    }
  });

  app.get("/api/agent-town/action-items", (_request, response) => {
    response.json({
      actionItems: agentTownStore.getState().actionItems,
    });
  });

  app.get("/api/tutorials", (_request, response) => {
    response.json({ tutorials: tutorialRegistry.list() });
  });

  app.get("/api/tutorials/:id", (request, response) => {
    const tutorial = tutorialRegistry.get(request.params.id);
    if (!tutorial) {
      response.status(404).json({ error: "Tutorial not found." });
      return;
    }
    response.json({ tutorial });
  });

  app.get("/api/agent-town/canvases", (_request, response) => {
    response.json({
      canvases: agentTownStore.getState().canvases,
    });
  });

  app.post("/api/agent-town/canvases", async (request, response) => {
    try {
      const payload = await agentTownStore.upsertCanvas(request.body || {});
      response.status(201).json({
        canvas: payload.canvas,
        agentTown: payload.state,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not update Agent Town canvas." });
    }
  });

  app.delete("/api/agent-town/canvases/:canvasId", async (request, response) => {
    try {
      const payload = await agentTownStore.deleteCanvas(request.params.canvasId);
      response.json({
        canvas: payload.canvas,
        agentTown: payload.state,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not clear Agent Town canvas." });
    }
  });

  app.get("/api/agent-town/canvases/:canvasId/image", async (request, response) => {
    try {
      const canvas = agentTownStore.getCanvas(request.params.canvasId);
      if (!canvas) {
        response.status(404).json({ error: "Agent canvas not found." });
        return;
      }

      const session = canvas.sourceSessionId ? sessionManager.getSession(canvas.sourceSessionId) : null;
      const image = await resolveAgentCanvasImage({ canvas, session, fallbackCwd: cwd });
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", image.mimeType);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.sendFile(image.targetPath, { dotfiles: "allow" }, (error) => {
        if (!error) {
          return;
        }

        if (response.headersSent) {
          response.destroy(error);
          return;
        }

        response.status(error.statusCode || 500).json({ error: error.message });
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not read Agent Town canvas image." });
    }
  });

  app.post("/api/agent-town/action-items", async (request, response) => {
    try {
      const payload = await agentTownStore.createActionItem(request.body || {});
      response.status(201).json({
        actionItem: payload.actionItem,
        agentTown: payload.state,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not create Agent Town action item." });
    }
  });

  app.patch("/api/agent-town/action-items/:actionItemId", async (request, response) => {
    try {
      const payload = await agentTownStore.updateActionItem(request.params.actionItemId, request.body || {});
      response.json({
        actionItem: payload.actionItem,
        agentTown: payload.state,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not update Agent Town action item." });
    }
  });

  app.get("/api/agent-town/wait", async (request, response) => {
    try {
      const payload = await agentTownStore.waitForPredicate({
        predicate: request.query.predicate,
        predicateParams: {
          actionItemId: request.query.actionItemId,
          pluginId: request.query.pluginId,
          itemId: request.query.itemId,
          minCount: request.query.minCount,
        },
        timeoutMs: request.query.timeoutMs,
      });
      response.json(payload);
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not wait for Agent Town predicate." });
    }
  });

  app.post("/api/agent-town/wait", async (request, response) => {
    try {
      response.json(await agentTownStore.waitForPredicate(request.body || {}));
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not wait for Agent Town predicate." });
    }
  });

  app.get("/api/settings", (_request, response) => {
    response.json({
      settings: getSettingsState(),
    });
  });

  app.patch("/api/settings", async (request, response) => {
    try {
      // Snapshot the previously-installed building set BEFORE the update so
      // we can detect uninstalls and clean up MCP-launch declarations. The
      // alternative — leaving stale launches in the registry after a
      // building gets uninstalled — would surprise the host agent: it would
      // keep launching MCP servers for buildings the user thought they
      // turned off.
      const previousInstalled = new Set(
        Array.isArray(settingsStore.settings.installedPluginIds)
          ? settingsStore.settings.installedPluginIds
          : [],
      );
      await settingsStore.update({
        agentAutomations: request.body?.agentAutomations,
        agentAnthropicApiKey: request.body?.agentAnthropicApiKey,
        agentHfToken: request.body?.agentHfToken,
        preventSleepEnabled: request.body?.preventSleepEnabled,
        agentMailApiKey: request.body?.agentMailApiKey,
        agentMailClientId: request.body?.agentMailClientId,
        agentMailDisplayName: request.body?.agentMailDisplayName,
        agentMailDomain: request.body?.agentMailDomain,
        agentMailEnabled: request.body?.agentMailEnabled,
        agentMailInboxId: request.body?.agentMailInboxId,
        agentMailMode: request.body?.agentMailMode,
        agentMailProviderId: request.body?.agentMailProviderId,
        agentMailUsername: request.body?.agentMailUsername,
        agentCommunicationCaptureMessageReads: request.body?.agentCommunicationCaptureMessageReads,
        agentCommunicationCaptureMessages: request.body?.agentCommunicationCaptureMessages,
        agentCommunicationDmBody: request.body?.agentCommunicationDmBody,
        agentCommunicationDmEnabled: request.body?.agentCommunicationDmEnabled,
        agentCommunicationDmVisibility: request.body?.agentCommunicationDmVisibility,
        agentCommunicationGroupInboxes: request.body?.agentCommunicationGroupInboxes,
        agentCommunicationMaxThreadDepth: request.body?.agentCommunicationMaxThreadDepth,
        agentCommunicationMaxUnrepliedPerAgent: request.body?.agentCommunicationMaxUnrepliedPerAgent,
        agentCommunicationRequireRelatedObject: request.body?.agentCommunicationRequireRelatedObject,
        agentOpenAiApiKey: request.body?.agentOpenAiApiKey,
        browserUseAnthropicApiKey: request.body?.browserUseAnthropicApiKey,
        browserUseBrowserPath: request.body?.browserUseBrowserPath,
        browserUseEnabled: request.body?.browserUseEnabled,
        browserUseHeadless: request.body?.browserUseHeadless,
        browserUseKeepTabs: request.body?.browserUseKeepTabs,
        browserUseModel: request.body?.browserUseModel,
        browserUseProfileDir: request.body?.browserUseProfileDir,
        browserUseWorkerPath: request.body?.browserUseWorkerPath,
        buildingAccessConfirmedIds: request.body?.buildingAccessConfirmedIds,
        buildingHubAppUrl: request.body?.buildingHubAppUrl,
        buildingHubAuthProvider: request.body?.buildingHubAuthProvider,
        buildingHubCatalogPath: request.body?.buildingHubCatalogPath,
        buildingHubCatalogUrl: request.body?.buildingHubCatalogUrl,
        buildingHubEnabled: request.body?.buildingHubEnabled,
        buildingHubProfileUrl: request.body?.buildingHubProfileUrl,
        githubOAuthClientId: request.body?.githubOAuthClientId,
        githubOAuthClientSecret: request.body?.githubOAuthClientSecret,
        googleOAuthClientId: request.body?.googleOAuthClientId,
        googleOAuthClientSecret: request.body?.googleOAuthClientSecret,
        modalEnabled: request.body?.modalEnabled,
        runpodEnabled: request.body?.runpodEnabled,
        harborEnabled: request.body?.harborEnabled,
        mcpHealthCheckIntervalSec: request.body?.mcpHealthCheckIntervalSec,
        mcpFilesystemEnabled: request.body?.mcpFilesystemEnabled,
        mcpFilesystemRoots: request.body?.mcpFilesystemRoots,
        mcpGithubEnabled: request.body?.mcpGithubEnabled,
        mcpGithubToken: request.body?.mcpGithubToken,
        mcpPostgresEnabled: request.body?.mcpPostgresEnabled,
        mcpPostgresUrl: request.body?.mcpPostgresUrl,
        mcpSqliteEnabled: request.body?.mcpSqliteEnabled,
        mcpSqliteDbPath: request.body?.mcpSqliteDbPath,
        mcpBraveSearchEnabled: request.body?.mcpBraveSearchEnabled,
        mcpBraveSearchApiKey: request.body?.mcpBraveSearchApiKey,
        mcpSlackEnabled: request.body?.mcpSlackEnabled,
        mcpSlackBotToken: request.body?.mcpSlackBotToken,
        mcpSlackTeamId: request.body?.mcpSlackTeamId,
        mcpSentryEnabled: request.body?.mcpSentryEnabled,
        mcpSentryAuthToken: request.body?.mcpSentryAuthToken,
        mcpNotionEnabled: request.body?.mcpNotionEnabled,
        mcpNotionToken: request.body?.mcpNotionToken,
        mcpLinearEnabled: request.body?.mcpLinearEnabled,
        mcpLinearApiKey: request.body?.mcpLinearApiKey,
        mcpAwsKbEnabled: request.body?.mcpAwsKbEnabled,
        mcpAwsKbId: request.body?.mcpAwsKbId,
        mcpKubernetesEnabled: request.body?.mcpKubernetesEnabled,
        mcpObsidianEnabled: request.body?.mcpObsidianEnabled,
        mcpObsidianApiKey: request.body?.mcpObsidianApiKey,
        mcpObsidianVaultPath: request.body?.mcpObsidianVaultPath,
        ottoAuthBaseUrl: request.body?.ottoAuthBaseUrl,
        ottoAuthCallbackUrl: request.body?.ottoAuthCallbackUrl,
        ottoAuthDefaultMaxChargeCents: request.body?.ottoAuthDefaultMaxChargeCents,
        ottoAuthEnabled: request.body?.ottoAuthEnabled,
        ottoAuthPrivateKey: request.body?.ottoAuthPrivateKey,
        ottoAuthUsername: request.body?.ottoAuthUsername,
        telegramAllowedChatIds: request.body?.telegramAllowedChatIds,
        telegramBotToken: request.body?.telegramBotToken,
        telegramEnabled: request.body?.telegramEnabled,
        telegramProviderId: request.body?.telegramProviderId,
        twilioAccountSid: request.body?.twilioAccountSid,
        twilioAuthToken: request.body?.twilioAuthToken,
        twilioEnabled: request.body?.twilioEnabled,
        twilioFromNumber: request.body?.twilioFromNumber,
        twilioProviderId: request.body?.twilioProviderId,
        twilioSmsEstimateCents: request.body?.twilioSmsEstimateCents,
        twilioVerifyServiceSid: request.body?.twilioVerifyServiceSid,
        walletStripeSecretKey: request.body?.walletStripeSecretKey,
        walletStripeWebhookSecret: request.body?.walletStripeWebhookSecret,
        videoMemoryBaseUrl: request.body?.videoMemoryBaseUrl,
        videoMemoryEnabled: request.body?.videoMemoryEnabled,
        videoMemoryProviderId: request.body?.videoMemoryProviderId,
        installedPluginIds: request.body?.installedPluginIds,
        workspaceRootPath: request.body?.workspaceRootPath,
        agentSpawnPath: request.body?.agentSpawnPath,
        wikiGitBackupEnabled: request.body?.wikiGitBackupEnabled,
        wikiGitRemoteBranch: request.body?.wikiGitRemoteBranch,
        wikiGitRemoteEnabled: request.body?.wikiGitRemoteEnabled,
        wikiGitRemoteName: request.body?.wikiGitRemoteName,
        wikiGitRemoteUrl: request.body?.wikiGitRemoteUrl,
        wikiPath: request.body?.wikiPath,
        wikiPathConfigured: request.body?.wikiPathConfigured,
      });

      await applyRuntimeSettings(settingsStore.settings, {
        backupReason: shouldSyncLibraryForSettingsPatch(request.body) ? "settings" : false,
      });

      // Reconcile the MCP-launch registry against the post-update install
      // set. Buildings that were uninstalled in this PATCH lose their
      // declared launches so the next /api/mcp/launches read won't include
      // them. Re-installing the same building re-runs the install plan,
      // which re-declares the launches. (Buildings that stay installed
      // are untouched here.)
      const currentInstalled = new Set(
        Array.isArray(settingsStore.settings.installedPluginIds)
          ? settingsStore.settings.installedPluginIds
          : [],
      );
      let removedAny = false;
      for (const buildingId of previousInstalled) {
        if (!currentInstalled.has(buildingId) && mcpLaunchRegistry.has(buildingId)) {
          mcpLaunchRegistry.remove(buildingId);
          removedAny = true;
        }
      }
      // If we just dropped a building, push the change into Claude Code
      // + Codex configs so they don't keep launching the now-unregistered
      // server. Best-effort — sync errors are swallowed to keep the
      // PATCH /api/settings response shape stable.
      if (removedAny && runAutoSyncForAgents) {
        try { runAutoSyncForAgents(); } catch {}
      }

      response.json({
        settings: getSettingsState(),
        agentPrompt: await agentPromptStore.getState(),
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  const handleBuildingHubGitHubOAuthStart = (request, response) => {
    const buildingHubAppBaseUrl = getBuildingHubAppBaseUrl();
    if (buildingHubAppBaseUrl) {
      const callbackPort = exposedPort || port;
      const completionUrl = getBuildingHubAccountCompletionUrl(callbackPort);
      if (!completionUrl) {
        response.status(500).send(renderGitHubOAuthPopupPage({
          message: "Could not determine callback URL for BuildingHub account login.",
        }));
        return;
      }

      const authUrl = new URL("/auth/github/start", buildingHubAppBaseUrl);
      authUrl.searchParams.set("return_to", completionUrl);
      authUrl.searchParams.set("token_label", "Vibe Research");
      response.redirect(authUrl.toString());
      return;
    }

    const clientId = String(settingsStore.settings.githubOAuthClientId || "").trim();
    if (!clientId) {
      response.status(400).send(renderGitHubOAuthPopupPage({
        message: "BuildingHub login is not configured yet. Set a hosted BuildingHub registry URL or local GitHub OAuth credentials.",
      }));
      return;
    }

    const callbackPort = exposedPort || port;
    const redirectUri = getBuildingHubGitHubOAuthRedirectUri(callbackPort);
    if (!redirectUri) {
      response.status(500).send(renderGitHubOAuthPopupPage({
        message: "Could not determine callback URL for GitHub OAuth.",
      }));
      return;
    }

    pruneGitHubOAuthStates();
    const stateToken = randomUUID();
    githubOAuthStates.set(stateToken, {
      createdAt: Date.now(),
      redirectUri,
    });

    const authUrl = new URL("https://github.com/login/oauth/authorize");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", GITHUB_OAUTH_SCOPES.join(" "));
    authUrl.searchParams.set("state", stateToken);
    authUrl.searchParams.set("allow_signup", "true");

    response.redirect(authUrl.toString());
  };

  const handleBuildingHubGitHubOAuthCallback = async (request, response) => {
    const stateToken = String(request.query?.state || "").trim();
    const oauthError = String(request.query?.error || "").trim();
    const authCode = String(request.query?.code || "").trim();

    pruneGitHubOAuthStates();
    const stateEntry = stateToken ? githubOAuthStates.get(stateToken) : null;
    if (stateToken) {
      githubOAuthStates.delete(stateToken);
    }

    if (!stateEntry) {
      response.status(400).send(renderGitHubOAuthPopupPage({
        message: "GitHub sign-in session expired. Start again from the BuildingHub login button.",
      }));
      return;
    }

    if (oauthError) {
      response.status(400).send(renderGitHubOAuthPopupPage({
        message: `GitHub denied access: ${oauthError}.`,
      }));
      return;
    }

    if (!authCode) {
      response.status(400).send(renderGitHubOAuthPopupPage({
        message: "GitHub did not return an authorization code.",
      }));
      return;
    }

    try {
      const redirectUri = String(stateEntry.redirectUri || "").trim();
      if (!redirectUri) {
        throw buildHttpError("GitHub redirect URI missing from OAuth state.", 400);
      }

      const tokens = await githubService.exchangeAuthCode({
        code: authCode,
        redirectUri,
        integrationId: BUILDINGHUB_GITHUB_OAUTH_INTEGRATION_ID,
      });
      const publisher = normalizeBuildingHubPublisher(tokens?.profile);
      const confirmedIds = new Set(
        Array.isArray(settingsStore.settings.buildingAccessConfirmedIds)
          ? settingsStore.settings.buildingAccessConfirmedIds.map(normalizeBuildingId).filter(Boolean)
          : [],
      );
      confirmedIds.add("buildinghub");
      await settingsStore.update({
        buildingAccessConfirmedIds: [...confirmedIds].sort(),
        buildingHubAuthProvider: "github",
        buildingHubProfileUrl: publisher?.profileUrl || settingsStore.settings.buildingHubProfileUrl,
      });

      response.setHeader("Cache-Control", "no-store");
      response.send(renderGitHubOAuthPopupPage({
        status: "success",
        message: publisher?.login
          ? `GitHub account @${publisher.login} connected. Returning to Vibe Research.`
          : "GitHub account connected. Returning to Vibe Research.",
      }));
    } catch (error) {
      response.status(Number(error?.statusCode) || 500).send(renderGitHubOAuthPopupPage({
        message: error?.message || "Could not complete GitHub sign-in.",
      }));
    }
  };

  app.get(BUILDINGHUB_GITHUB_OAUTH_START_PATH, handleBuildingHubGitHubOAuthStart);
  app.get("/api/github/oauth/start", handleBuildingHubGitHubOAuthStart);

  app.get(BUILDINGHUB_ACCOUNT_AUTH_COMPLETE_PATH, async (request, response) => {
    const grant = String(request.query?.buildinghub_grant || request.query?.grant || "").trim();
    const callbackPort = exposedPort || port;
    const completionUrl = getBuildingHubAccountCompletionUrl(callbackPort);
    if (!grant || !completionUrl) {
      response.status(400).send(renderGitHubOAuthPopupPage({
        message: "BuildingHub did not return a usable account grant.",
      }));
      return;
    }

    try {
      const record = await buildingHubAccountService.exchangeGrant({
        grant,
        redirectUri: completionUrl,
        settings: settingsStore.settings,
      });
      const account = normalizeBuildingHubPublisher(record?.account);
      const confirmedIds = new Set(
        Array.isArray(settingsStore.settings.buildingAccessConfirmedIds)
          ? settingsStore.settings.buildingAccessConfirmedIds.map(normalizeBuildingId).filter(Boolean)
          : [],
      );
      confirmedIds.add("buildinghub");
      await settingsStore.update({
        buildingAccessConfirmedIds: [...confirmedIds].sort(),
        buildingHubAuthProvider: "github",
        buildingHubProfileUrl: account?.profileUrl || settingsStore.settings.buildingHubProfileUrl,
      });

      response.setHeader("Cache-Control", "no-store");
      response.send(renderGitHubOAuthPopupPage({
        status: "success",
        message: account?.login
          ? `BuildingHub account @${account.login} connected. Returning to Vibe Research.`
          : "BuildingHub account connected. Returning to Vibe Research.",
      }));
    } catch (error) {
      response.status(Number(error?.statusCode) || 500).send(renderGitHubOAuthPopupPage({
        message: error?.message || "Could not complete BuildingHub account login.",
      }));
    }
  });

  app.get(BUILDINGHUB_GITHUB_OAUTH_CALLBACK_PATH, handleBuildingHubGitHubOAuthCallback);
  app.get("/api/github/oauth/callback", handleBuildingHubGitHubOAuthCallback);

  app.get("/api/google/oauth/start", (request, response) => {
    const buildingId = normalizeBuildingId(request.query?.buildingId || "");
    const flow = GOOGLE_OAUTH_FLOWS[buildingId];
    if (!flow) {
      response.status(404).send(renderGoogleOAuthPopupPage({
        buildingId,
        message: "Google OAuth is only available for supported Google buildings.",
      }));
      return;
    }

    const clientId = String(settingsStore.settings.googleOAuthClientId || "").trim();
    if (!clientId) {
      response.status(400).send(renderGoogleOAuthPopupPage({
        buildingId,
        message: "Google OAuth client ID is not configured yet.",
      }));
      return;
    }

    const callbackPort = exposedPort || port;
    if (!callbackPort) {
      response.status(500).send(renderGoogleOAuthPopupPage({
        buildingId,
        message: "Could not determine callback URL for Google OAuth.",
      }));
      return;
    }
    const redirectUri = `http://127.0.0.1:${callbackPort}/api/google/oauth/callback`;

    pruneGoogleOAuthStates();
    const stateToken = randomUUID();
    googleOAuthStates.set(stateToken, {
      buildingId,
      createdAt: Date.now(),
      redirectUri,
    });

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", flow.scopes.join(" "));
    authUrl.searchParams.set("state", stateToken);
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("access_type", "offline");
    if (flow.prompt) {
      authUrl.searchParams.set("prompt", flow.prompt);
    }

    response.redirect(authUrl.toString());
  });

  app.get("/api/google/oauth/callback", async (request, response) => {
    const stateToken = String(request.query?.state || "").trim();
    const oauthError = String(request.query?.error || "").trim();
    const authCode = String(request.query?.code || "").trim();

    pruneGoogleOAuthStates();
    const stateEntry = stateToken ? googleOAuthStates.get(stateToken) : null;
    if (stateToken) {
      googleOAuthStates.delete(stateToken);
    }

    if (!stateEntry) {
      response.status(400).send(renderGoogleOAuthPopupPage({
        message: "Google setup session expired. Start again from the building setup button.",
      }));
      return;
    }

    if (oauthError) {
      response.status(400).send(renderGoogleOAuthPopupPage({
        buildingId: stateEntry.buildingId,
        message: `Google declined access: ${oauthError}.`,
      }));
      return;
    }

    if (!authCode) {
      response.status(400).send(renderGoogleOAuthPopupPage({
        buildingId: stateEntry.buildingId,
        message: "Google did not return an authorization code.",
      }));
      return;
    }

    try {
      const redirectUri = String(stateEntry.redirectUri || "").trim();
      if (!redirectUri) {
        throw buildHttpError("Google redirect URI missing from OAuth state.", 400);
      }
      await googleService.exchangeAuthCode({
        buildingId: stateEntry.buildingId,
        code: authCode,
        redirectUri,
      });

      const confirmedIds = new Set(
        Array.isArray(settingsStore.settings.buildingAccessConfirmedIds)
          ? settingsStore.settings.buildingAccessConfirmedIds.map(normalizeBuildingId).filter(Boolean)
          : [],
      );
      confirmedIds.add(stateEntry.buildingId);
      await settingsStore.update({
        buildingAccessConfirmedIds: [...confirmedIds].sort(),
      });
      response.setHeader("Cache-Control", "no-store");
      response.send(renderGoogleOAuthPopupPage({
        status: "success",
        buildingId: stateEntry.buildingId,
        message: "Google access enabled. Returning to Vibe Research.",
      }));
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      response.status(statusCode).send(renderGoogleOAuthPopupPage({
        buildingId: stateEntry.buildingId,
        message: error?.message || "Could not save Google OAuth state.",
      }));
    }
  });

  app.post("/api/wiki/clone", wikiCloneRateLimit, async (request, response) => {
    let targetPath = "";
    let cloneTarget = null;

    try {
      const remoteUrl = normalizeGitCloneRemoteUrl(request.body?.remoteUrl);
      const legacyDefaultFolder = path.join(path.dirname(stateDir), getGitRepoFolderName(remoteUrl));
      let defaultFolder = settingsStore.settings.wikiPath || legacyDefaultFolder;
      if (!String(request.body?.wikiPath || "").trim()) {
        try {
          const entries = await readdir(legacyDefaultFolder);
          if (await isInstallerBrainScaffold(legacyDefaultFolder, entries)) {
            defaultFolder = legacyDefaultFolder;
          }
        } catch {
          // Use the workspace-relative Library by default unless an old installer scaffold exists.
        }
      }
      targetPath = settingsStore.normalizeWikiPath(request.body?.wikiPath || defaultFolder);
      cloneTarget = await prepareBrainCloneTarget(targetPath, remoteUrl);

      if (cloneTarget.action === "clone") {
        try {
          await execFileAsync("git", ["clone", remoteUrl, targetPath], {
            timeout: 120_000,
          });
        } catch (error) {
          if (!cloneTarget.existed && targetPath) {
            await rm(targetPath, { recursive: true, force: true }).catch(() => {});
          }
          if (cloneTarget.backupPath && targetPath) {
            await rename(cloneTarget.backupPath, targetPath).catch(() => {});
          }

          const stderr = String(error?.stderr || error?.message || "").trim();
          throw buildHttpError(stderr || "Could not clone the Library git repo.", 400);
        }
      }

      const wikiPath = await realpath(targetPath);
      const branch = await readBrainCloneBranch(wikiPath);
      await settingsStore.update({
        wikiGitBackupEnabled: true,
        wikiGitRemoteBranch: branch,
        wikiGitRemoteEnabled: true,
        wikiGitRemoteName: "origin",
        wikiGitRemoteUrl: remoteUrl,
        wikiPath,
      });

      await applyRuntimeSettings(settingsStore.settings, { backupReason: "clone" });

      response.json({
        settings: getSettingsState(),
        agentPrompt: await agentPromptStore.getState(),
        clone: {
          branch,
          backupPath: cloneTarget.backupPath || "",
          action: cloneTarget.action,
          remoteUrl,
          wikiPath,
        },
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.post("/api/wiki/backup", async (_request, response) => {
    try {
      const status = await wikiBackupService.runBackup({ reason: "manual" });
      response.json({
        backup: status,
        settings: getSettingsState(),
      });
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Library backup failed." });
    }
  });

  app.get("/api/agentmail/status", (_request, response) => {
    response.json({ agentMail: agentMailService.getStatus() });
  });

  app.post("/api/agentmail/setup", async (request, response) => {
    try {
      const apiKey = String(request.body?.apiKey || settingsStore.settings.agentMailApiKey || "").trim();
      const clientId =
        String(request.body?.clientId || settingsStore.settings.agentMailClientId || "").trim() ||
        `vibe-research-${randomUUID()}`;
      let inboxId = String(request.body?.inboxId || settingsStore.settings.agentMailInboxId || "").trim();
      const displayName = String(
        request.body?.displayName || request.body?.agentMailDisplayName || settingsStore.settings.agentMailDisplayName || "",
      ).trim();
      const domain = String(
        request.body?.domain || request.body?.agentMailDomain || settingsStore.settings.agentMailDomain || "",
      ).trim();
      const username = String(
        request.body?.username || request.body?.agentMailUsername || settingsStore.settings.agentMailUsername || "",
      ).trim();

      if (!apiKey) {
        throw new Error("AgentMail API key is required.");
      }

      let inbox = null;
      if (!inboxId) {
        inbox = await agentMailService.createInbox({
          apiKey,
          clientId,
          displayName,
          domain,
          username,
        });
        inboxId = inbox.inbox_id || inbox.inboxId || inbox.email || "";
      }

      if (!inboxId) {
        throw new Error("AgentMail did not return an inbox id.");
      }

      await settingsStore.update({
        agentMailApiKey: request.body?.apiKey === undefined ? undefined : apiKey,
        agentMailClientId: clientId,
        agentMailDisplayName: displayName || settingsStore.settings.agentMailDisplayName,
        agentMailDomain: domain,
        agentMailEnabled: true,
        agentMailInboxId: inboxId,
        agentMailMode: "websocket",
        agentMailProviderId: request.body?.agentMailProviderId || request.body?.providerId,
        agentMailUsername: username,
        installedPluginIds: request.body?.installedPluginIds,
      });
      agentMailService.restart(settingsStore.settings);

      response.json({
        agentMail: agentMailService.getStatus(),
        inbox,
        settings: getSettingsState(),
      });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not set up AgentMail." });
    }
  });

  app.post("/api/agentmail/reply", async (request, response) => {
    try {
      const token = String(request.headers["x-vibe-research-agentmail-token"] || request.body?.token || "").trim();
      if (!token || token !== agentMailService.replyToken) {
        response.status(403).json({ error: "Invalid AgentMail reply token." });
        return;
      }

      const reply = await agentMailService.replyToMessage({
        html: request.body?.html,
        inboxId: request.body?.inboxId,
        messageId: request.body?.messageId,
        text: request.body?.text,
      });
      response.json({ ok: true, reply });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not send AgentMail reply." });
    }
  });

  app.get("/api/telegram/status", (_request, response) => {
    response.json({ telegram: telegramService.getStatus() });
  });

  app.post("/api/telegram/setup", async (request, response) => {
    try {
      const botToken = String(request.body?.botToken || request.body?.telegramBotToken || "").trim();
      const enabled = request.body?.enabled ?? request.body?.telegramEnabled;
      const enabledBoolean = enabled === true || enabled === "true" || enabled === "on";
      const nextSettings = {
        installedPluginIds: request.body?.installedPluginIds,
        telegramAllowedChatIds: request.body?.allowedChatIds ?? request.body?.telegramAllowedChatIds,
        telegramBotToken: botToken || undefined,
        telegramEnabled: enabledBoolean,
        telegramProviderId: request.body?.telegramProviderId || request.body?.providerId,
      };

      if (enabledBoolean && !botToken && !settingsStore.settings.telegramBotToken) {
        throw new Error("Telegram bot token is required.");
      }

      await settingsStore.update(nextSettings);
      telegramService.restart(settingsStore.settings);

      response.json({
        settings: getSettingsState(),
        telegram: telegramService.getStatus(),
      });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not set up Telegram." });
    }
  });

  app.post("/api/telegram/reply", async (request, response) => {
    try {
      const token = String(request.headers["x-vibe-research-telegram-token"] || request.body?.token || "").trim();
      if (!token || token !== telegramService.replyToken) {
        response.status(403).json({ error: "Invalid Telegram reply token." });
        return;
      }

      const reply = await telegramService.replyToMessage({
        chatId: request.body?.chatId,
        messageId: request.body?.messageId,
        text: request.body?.text,
      });
      response.json({ ok: true, reply });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not send Telegram reply." });
    }
  });

  function getExternalRequestUrl(request) {
    const protocol = String(request.get("x-forwarded-proto") || request.protocol || "http")
      .split(",")[0]
      .trim();
    const host = String(request.get("x-forwarded-host") || request.get("host") || "").split(",")[0].trim();
    return new URL(request.originalUrl || request.url || "/", `${protocol}://${host || "127.0.0.1"}`).toString();
  }

  app.get("/api/wallet/status", (_request, response) => {
    response.json({ wallet: walletService.getStatus?.() || null });
  });

  app.get("/api/wallet/summary", (request, response) => {
    response.json({
      wallet: walletService.getSummary?.({ limit: request.query.limit }) || null,
    });
  });

  app.post("/api/wallet/setup", async (request, response) => {
    try {
      const stripeSecretKey = String(request.body?.stripeSecretKey || request.body?.walletStripeSecretKey || "").trim();
      const stripeWebhookSecret = String(
        request.body?.stripeWebhookSecret || request.body?.walletStripeWebhookSecret || "",
      ).trim();
      await settingsStore.update({
        walletStripeSecretKey: stripeSecretKey || undefined,
        walletStripeWebhookSecret: stripeWebhookSecret || undefined,
      });
      response.json({ ok: true, settings: getSettingsState() });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not set up wallet payments." });
    }
  });

  app.post("/api/wallet/checkout-sessions", async (request, response) => {
    try {
      const secretKey = String(settingsStore.settings.walletStripeSecretKey || "").trim();
      if (!secretKey) {
        throw buildHttpError("Stripe secret key is required before creating checkout sessions.", 400);
      }

      const amountCents = normalizeStripeAmountCents(request.body?.amountCents);
      const baseUrl = String(preferredUrl || helperBaseUrl || `${request.protocol}://${request.get("host") || ""}`)
        .trim()
        .replace(/\/+$/, "");
      const session = await requestStripe({
        fetchImpl: stripeFetchImpl,
        secretKey,
        url: `${STRIPE_API_BASE_URL}/checkout/sessions`,
        body: {
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][product_data][name]": "Vibe Research credits",
          "line_items[0][price_data][unit_amount]": String(amountCents),
          "line_items[0][quantity]": "1",
          mode: "payment",
          "metadata[walletCreditCents]": String(amountCents),
          "metadata[source]": "vibe_research_wallet",
          success_url: String(request.body?.successUrl || `${baseUrl}/?view=settings&wallet=success`),
          cancel_url: String(request.body?.cancelUrl || `${baseUrl}/?view=settings&wallet=cancel`),
        },
      });
      response.status(201).json({ checkoutSession: session, ok: true });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not create checkout session." });
    }
  });

  app.post("/api/wallet/credits/grant", async (request, response) => {
    try {
      const result = await walletService.grantCredits({
        actor: request.body?.actor,
        amountCents: request.body?.amountCents,
        description: request.body?.description,
        idempotencyKey: request.body?.idempotencyKey,
        metadata: request.body?.metadata,
        source: request.body?.source,
      });
      response.status(201).json({ ok: true, ...result, settings: getSettingsState() });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not add wallet credits." });
    }
  });

  app.post("/api/wallet/spend/holds", async (request, response) => {
    try {
      const result = await walletService.createSpendHold({
        action: request.body?.action,
        amountCents: request.body?.amountCents,
        buildingId: request.body?.buildingId,
        description: request.body?.description,
        idempotencyKey: request.body?.idempotencyKey,
        metadata: request.body?.metadata,
      });
      response.status(201).json({ ok: true, ...result, settings: getSettingsState() });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not reserve wallet credits." });
    }
  });

  app.post("/api/wallet/spend/holds/:holdId/capture", async (request, response) => {
    try {
      const result = await walletService.captureSpend({
        amountCents: request.body?.amountCents,
        description: request.body?.description,
        holdId: request.params.holdId,
        metadata: request.body?.metadata,
      });
      response.json({ ok: true, ...result, settings: getSettingsState() });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not capture wallet spend." });
    }
  });

  app.post("/api/wallet/spend/holds/:holdId/release", async (request, response) => {
    try {
      const result = await walletService.releaseSpend({
        holdId: request.params.holdId,
        metadata: request.body?.metadata,
        reason: request.body?.reason,
      });
      response.json({ ok: true, ...result, settings: getSettingsState() });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not release wallet hold." });
    }
  });

  app.get("/api/twilio/status", (_request, response) => {
    response.json({ twilio: twilioService.getStatus() });
  });

  app.post("/api/twilio/setup", async (request, response) => {
    try {
      const accountSid = String(request.body?.accountSid || request.body?.twilioAccountSid || "").trim();
      const authToken = String(request.body?.authToken || request.body?.twilioAuthToken || "").trim();
      const enabled = request.body?.enabled ?? request.body?.twilioEnabled;
      const enabledBoolean = enabled === true || enabled === "true" || enabled === "on";
      const fromNumber = String(request.body?.fromNumber || request.body?.twilioFromNumber || "").trim();
      const verifyServiceSid = String(request.body?.verifyServiceSid || request.body?.twilioVerifyServiceSid || "").trim();

      if (enabledBoolean) {
        if (!accountSid && !settingsStore.settings.twilioAccountSid) {
          throw new Error("Twilio account SID is required.");
        }
        if (!authToken && !settingsStore.settings.twilioAuthToken) {
          throw new Error("Twilio auth token is required.");
        }
        if (!fromNumber && !settingsStore.settings.twilioFromNumber) {
          throw new Error("Twilio sender number is required.");
        }
      }

      await settingsStore.update({
        installedPluginIds: request.body?.installedPluginIds,
        twilioAccountSid: accountSid || undefined,
        twilioAuthToken: authToken || undefined,
        twilioEnabled: enabledBoolean,
        twilioFromNumber: fromNumber || settingsStore.settings.twilioFromNumber,
        twilioProviderId: request.body?.twilioProviderId || request.body?.providerId,
        twilioSmsEstimateCents: request.body?.twilioSmsEstimateCents ?? request.body?.smsEstimateCents,
        twilioVerifyServiceSid: verifyServiceSid || undefined,
      });
      twilioService.restart(settingsStore.settings);

      response.json({
        settings: getSettingsState(),
        twilio: twilioService.getStatus(),
      });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not set up Twilio." });
    }
  });

  app.post("/api/twilio/verify/start", async (request, response) => {
    try {
      const verification = await twilioService.startVerification({
        phoneNumber: request.body?.phoneNumber,
      });
      response.status(201).json({
        ok: true,
        settings: getSettingsState(),
        verification,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not start phone verification." });
    }
  });

  app.post("/api/twilio/verify/check", async (request, response) => {
    try {
      const verification = await twilioService.checkVerification({
        code: request.body?.code,
        phoneNumber: request.body?.phoneNumber,
      });
      response.json({
        ok: true,
        settings: getSettingsState(),
        verification,
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not check phone verification." });
    }
  });

  app.post("/api/twilio/sms", async (request, response) => {
    try {
      const requestUrl = getExternalRequestUrl(request);
      if (!twilioService.verifyWebhook({ body: request.body || {}, headers: request.headers || {}, url: requestUrl })) {
        response.status(403).type("text/plain").send("Invalid Twilio webhook signature.");
        return;
      }

      await twilioService.handleIncomingMessage(request.body || {}, { source: "webhook" });
      response.type("text/xml").send("<Response></Response>");
    } catch (error) {
      response.status(error.statusCode || 400).type("text/plain").send(error.message || "Could not process Twilio webhook.");
    }
  });

  app.post("/api/twilio/reply", async (request, response) => {
    try {
      const token = String(request.headers["x-vibe-research-twilio-token"] || request.body?.token || "").trim();
      if (!token || token !== twilioService.replyToken) {
        response.status(403).json({ error: "Invalid Twilio reply token." });
        return;
      }

      const reply = await twilioService.replyToMessage({
        messageSid: request.body?.messageSid,
        text: request.body?.text,
        to: request.body?.to,
      });
      response.json({ ok: true, reply, settings: getSettingsState() });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not send Twilio reply." });
    }
  });

  app.get("/api/google/calendar/events", async (request, response) => {
    try {
      const result = await googleService.listCalendarEvents({
        calendarId: request.query?.calendarId ? String(request.query.calendarId) : undefined,
        timeMin: request.query?.timeMin ? String(request.query.timeMin) : undefined,
        timeMax: request.query?.timeMax ? String(request.query.timeMax) : undefined,
        maxResults: request.query?.maxResults ? Number(request.query.maxResults) : undefined,
        q: request.query?.q ? String(request.query.q) : undefined,
      });
      response.json(result);
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not list Google Calendar events." });
    }
  });

  app.post("/api/google/calendar/freebusy", async (request, response) => {
    try {
      const result = await googleService.queryFreeBusy({
        timeMin: request.body?.timeMin,
        timeMax: request.body?.timeMax,
        calendars: request.body?.calendars,
      });
      response.json(result);
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not query Google Calendar freeBusy." });
    }
  });

  app.post("/api/google/calendar/events", async (request, response) => {
    try {
      const result = await googleService.createCalendarEvent({
        calendarId: request.body?.calendarId,
        event: request.body?.event,
      });
      response.json(result);
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not create Google Calendar event." });
    }
  });

  app.get("/api/google/gmail/threads", async (request, response) => {
    try {
      const result = await googleService.searchGmailThreads({
        q: request.query?.q ? String(request.query.q) : undefined,
        maxResults: request.query?.maxResults ? Number(request.query.maxResults) : undefined,
        pageToken: request.query?.pageToken ? String(request.query.pageToken) : undefined,
      });
      response.json(result);
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not search Gmail threads." });
    }
  });

  app.get("/api/google/gmail/threads/:threadId", async (request, response) => {
    try {
      const result = await googleService.getGmailThread({
        threadId: request.params?.threadId,
        format: request.query?.format ? String(request.query.format) : undefined,
      });
      response.json(result);
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not load Gmail thread." });
    }
  });

  app.get("/api/google/drive/files", async (request, response) => {
    try {
      const result = await googleService.searchDriveFiles({
        q: request.query?.q ? String(request.query.q) : undefined,
        pageSize: request.query?.pageSize ? Number(request.query.pageSize) : undefined,
        pageToken: request.query?.pageToken ? String(request.query.pageToken) : undefined,
        orderBy: request.query?.orderBy ? String(request.query.orderBy) : undefined,
        fields: request.query?.fields ? String(request.query.fields) : undefined,
        spaces: request.query?.spaces ? String(request.query.spaces) : undefined,
        corpora: request.query?.corpora ? String(request.query.corpora) : undefined,
        includeItemsFromAllDrives: request.query?.includeItemsFromAllDrives
          ? String(request.query.includeItemsFromAllDrives)
          : undefined,
        supportsAllDrives: request.query?.supportsAllDrives
          ? String(request.query.supportsAllDrives)
          : undefined,
        driveId: request.query?.driveId ? String(request.query.driveId) : undefined,
      });
      response.json(result);
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not search Google Drive files." });
    }
  });

  app.get("/api/google/drive/files/:fileId", async (request, response) => {
    try {
      const result = await googleService.getDriveFile({
        fileId: request.params?.fileId,
        fields: request.query?.fields ? String(request.query.fields) : undefined,
        supportsAllDrives: request.query?.supportsAllDrives
          ? String(request.query.supportsAllDrives)
          : undefined,
      });
      response.json(result);
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not load Google Drive file metadata." });
    }
  });

  app.get("/api/google/drive/files/:fileId/export", async (request, response) => {
    try {
      const mimeType = request.query?.mimeType ? String(request.query.mimeType) : "text/plain";
      const result = await googleService.exportDriveFile({
        fileId: request.params?.fileId,
        mimeType,
      });
      response.set("Content-Type", result.contentType || mimeType);
      response.send(result.body || "");
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not export Google Drive file." });
    }
  });

  const handleBuildingHubGitHubOAuthDisconnect = async (_request, response) => {
    try {
      await buildingHubAccountService.disconnect({ settings: settingsStore.settings });
      await githubOAuthTokenStore.clearTokens(BUILDINGHUB_GITHUB_OAUTH_INTEGRATION_ID);
      const confirmedIds = new Set(
        Array.isArray(settingsStore.settings.buildingAccessConfirmedIds)
          ? settingsStore.settings.buildingAccessConfirmedIds.map(normalizeBuildingId).filter(Boolean)
          : [],
      );
      confirmedIds.delete("buildinghub");
      await settingsStore.update({
        buildingAccessConfirmedIds: [...confirmedIds].sort(),
        buildingHubAuthProvider: "",
        buildingHubProfileUrl: "",
      });
      response.json({ ok: true, settings: getSettingsState() });
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not disconnect GitHub account." });
    }
  };

  app.post(BUILDINGHUB_GITHUB_OAUTH_DISCONNECT_PATH, handleBuildingHubGitHubOAuthDisconnect);
  app.post("/api/github/oauth/disconnect", handleBuildingHubGitHubOAuthDisconnect);

  app.post("/api/google/oauth/:buildingId/disconnect", async (request, response) => {
    try {
      const buildingId = normalizeBuildingId(request.params?.buildingId || "");
      if (!buildingId || !GOOGLE_OAUTH_FLOWS[buildingId]) {
        throw buildHttpError("Google OAuth is only available for supported Google buildings.", 404);
      }
      await googleOAuthTokenStore.clearTokens(buildingId);
      const confirmedIds = new Set(
        Array.isArray(settingsStore.settings.buildingAccessConfirmedIds)
          ? settingsStore.settings.buildingAccessConfirmedIds.map(normalizeBuildingId).filter(Boolean)
          : [],
      );
      if (confirmedIds.delete(buildingId)) {
        await settingsStore.update({
          buildingAccessConfirmedIds: [...confirmedIds].sort(),
        });
      }
      response.json({ ok: true, settings: getSettingsState() });
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not disconnect Google building." });
    }
  });

  app.get("/api/browser-use/status", (_request, response) => {
    response.json({ browserUse: browserUseService.getStatus() });
  });

  app.post("/api/browser-use/setup", async (request, response) => {
    try {
      const apiKey = String(request.body?.anthropicApiKey || request.body?.browserUseAnthropicApiKey || "").trim();
      await settingsStore.update({
        browserUseAnthropicApiKey: apiKey || undefined,
        browserUseBrowserPath: request.body?.browserPath ?? request.body?.browserUseBrowserPath,
        browserUseEnabled: request.body?.enabled ?? request.body?.browserUseEnabled,
        browserUseHeadless: request.body?.headless ?? request.body?.browserUseHeadless,
        browserUseKeepTabs: request.body?.keepTabs ?? request.body?.browserUseKeepTabs,
        browserUseMaxTurns: request.body?.maxTurns ?? request.body?.maxSteps ?? request.body?.browserUseMaxTurns,
        browserUseModel: request.body?.model ?? request.body?.browserUseModel,
        browserUseProfileDir: request.body?.profileDir ?? request.body?.browserUseProfileDir,
        browserUseWorkerPath: request.body?.workerPath ?? request.body?.browserUseWorkerPath,
        installedPluginIds: request.body?.installedPluginIds,
      });
      await applyRuntimeSettings(settingsStore.settings, { backupReason: false });

      response.json({
        browserUse: browserUseService.getStatus(),
        settings: getSettingsState(),
      });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not set up browser-use plugin." });
    }
  });

  app.get("/api/ottoauth/status", (_request, response) => {
    response.json({ ottoAuth: ottoAuthService.getStatus() });
  });

  app.post("/api/ottoauth/setup", async (request, response) => {
    try {
      const privateKey = String(request.body?.privateKey || request.body?.ottoAuthPrivateKey || "").trim();
      await settingsStore.update({
        installedPluginIds: request.body?.installedPluginIds,
        ottoAuthBaseUrl: request.body?.baseUrl ?? request.body?.ottoAuthBaseUrl,
        ottoAuthCallbackUrl: request.body?.callbackUrl ?? request.body?.ottoAuthCallbackUrl,
        ottoAuthDefaultMaxChargeCents:
          request.body?.defaultMaxChargeCents ?? request.body?.ottoAuthDefaultMaxChargeCents,
        ottoAuthEnabled: request.body?.enabled ?? request.body?.ottoAuthEnabled,
        ottoAuthPrivateKey: privateKey || undefined,
        ottoAuthUsername: request.body?.username ?? request.body?.ottoAuthUsername,
      });
      await applyRuntimeSettings(settingsStore.settings, { backupReason: false });

      response.json({
        ottoAuth: ottoAuthService.getStatus(),
        settings: getSettingsState(),
      });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not set up OttoAuth." });
    }
  });

  app.get("/api/videomemory/status", async (_request, response) => {
    try {
      await videoMemoryService.refreshRemoteMonitorStates();
      await videoMemoryService.refreshRemoteDevices();
      response.json({
        monitors: videoMemoryService.listMonitors(),
        videoMemory: videoMemoryService.getStatus(),
      });
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not load video memory status." });
    }
  });

  app.get("/api/videomemory/devices", async (_request, response) => {
    try {
      await videoMemoryService.refreshRemoteDevices({ force: true });
      response.json({
        devices: videoMemoryService.listDevices(),
        updatedAt: videoMemoryService.lastRemoteDeviceRefreshSucceededAt
          ? new Date(videoMemoryService.lastRemoteDeviceRefreshSucceededAt).toISOString()
          : null,
        error: videoMemoryService.lastRemoteDeviceRefreshError || "",
      });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not list VideoMemory devices." });
    }
  });

  app.post("/api/videomemory/setup", async (request, response) => {
    try {
      const rawApiKey =
        request.body?.anthropicApiKey ?? request.body?.videoMemoryAnthropicApiKey;
      const trimmedApiKey = typeof rawApiKey === "string" ? rawApiKey.trim() : rawApiKey;
      await settingsStore.update({
        installedPluginIds: request.body?.installedPluginIds,
        videoMemoryAnthropicApiKey: trimmedApiKey === undefined || trimmedApiKey === "" ? undefined : trimmedApiKey,
        videoMemoryBaseUrl: request.body?.baseUrl ?? request.body?.videoMemoryBaseUrl,
        videoMemoryEnabled: request.body?.enabled ?? request.body?.videoMemoryEnabled,
        videoMemoryLaunchCommand:
          request.body?.launchCommand ?? request.body?.videoMemoryLaunchCommand,
        videoMemoryLaunchCwd:
          request.body?.launchCwd ?? request.body?.videoMemoryLaunchCwd,
        videoMemoryProviderId: request.body?.providerId ?? request.body?.videoMemoryProviderId,
      });
      await applyRuntimeSettings(settingsStore.settings, { backupReason: false });
      await videoMemoryService.refreshRemoteDevices({ force: true });

      response.json({
        monitors: videoMemoryService.listMonitors(),
        settings: getSettingsState(),
        videoMemory: videoMemoryService.getStatus(),
      });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not set up VideoMemory plugin." });
    }
  });

  // One-click install for the standalone VideoMemory server. Without this the
  // user has to clone github.com/Clamepending/videomemory and configure the
  // launch command manually before `Open VideoMemory` can reach 127.0.0.1:5050.
  // We also ensure `uv` is installed because start.sh runs `uv run flask_app/app.py`.
  app.post("/api/videomemory/install-server", async (request, response) => {
    const installRoot = String(
      request.body?.installPath || path.join(homedir(), "videomemory"),
    ).trim();
    const repoUrl = "https://github.com/Clamepending/videomemory.git";
    const localBinDir = path.join(homedir(), ".local", "bin");
    const localUvPath = path.join(localBinDir, "uv");

    async function detectUvOnPath() {
      try {
        await execFileAsync("uv", ["--version"]);
        return true;
      } catch {
        return false;
      }
    }
    async function detectUvAtLocalBin() {
      try {
        await execFileAsync(localUvPath, ["--version"]);
        return true;
      } catch {
        return false;
      }
    }
    async function detectGitOnPath() {
      try {
        await execFileAsync("git", ["--version"]);
        return true;
      } catch {
        return false;
      }
    }

    try {
      // We need git to clone the repo and to run uv (uv resolves the project's
      // git deps). On macOS the canonical install is via the Xcode Command
      // Line Tools, which `xcode-select --install` triggers as a system
      // dialog. We can't fully suppress the dialog, but we can fire it and
      // poll for completion so the rest of the flow stays automatic.
      let gitInstalled = false;
      if (!(await detectGitOnPath())) {
        if (process.platform === "darwin") {
          try {
            await execFileAsync("xcode-select", ["--install"], { timeout: 10_000 });
          } catch {
            // xcode-select --install exits non-zero if CLT is already installed
            // or the dialog is already open — both fine; the poll below is the
            // real check.
          }
          const deadline = Date.now() + 10 * 60 * 1000;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            if (await detectGitOnPath()) {
              gitInstalled = true;
              break;
            }
          }
          if (!gitInstalled) {
            throw new Error(
              "git is not installed. The Xcode Command Line Tools installer was opened — finish that dialog and click install again.",
            );
          }
        } else {
          throw new Error(
            "git is not installed. Install it with your package manager (e.g. `sudo apt-get install git` or `sudo dnf install git`), then click install again.",
          );
        }
      }

      const startScript = path.join(installRoot, "start.sh");
      let cloned = false;
      try {
        await stat(startScript);
      } catch {
        // No start.sh — either the directory is empty/missing or the repo
        // wasn't cloned. Try to clone (git refuses if the dir exists and is
        // non-empty, which surfaces as a clear error).
        await execFileAsync("git", ["clone", repoUrl, installRoot], {
          maxBuffer: 16 * 1024 * 1024,
          timeout: 5 * 60 * 1000,
        });
        cloned = true;
        await stat(startScript);
      }

      // start.sh runs `uv run flask_app/app.py`. Install uv via the official
      // installer if it isn't already on PATH or at ~/.local/bin/uv (the
      // installer's default destination). Done as a curl|sh pipeline because
      // that's the documented one-liner; trusted-vendor + first-party install.
      let uvInstalled = false;
      let uvAlready = (await detectUvOnPath()) || (await detectUvAtLocalBin());
      if (!uvAlready) {
        const installShell = process.env.SHELL || "/bin/sh";
        await execFileAsync(
          installShell,
          ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
          {
            maxBuffer: 16 * 1024 * 1024,
            timeout: 5 * 60 * 1000,
            env: { ...process.env, UV_NO_MODIFY_PATH: "1" },
          },
        );
        if (!(await detectUvAtLocalBin()) && !(await detectUvOnPath())) {
          throw new Error("uv installer ran but `uv` was not found afterward.");
        }
        uvInstalled = true;
        uvAlready = true;
      }

      // The detached child inherits process.env at spawn time and PATH is not
      // re-evaluated from ~/.zshrc, so prepend ~/.local/bin so freshly
      // installed `uv` is reachable from inside start.sh.
      const launchCommand = `PATH=${JSON.stringify(`${localBinDir}:`)}"$PATH" bash ${JSON.stringify(startScript)}`;
      await settingsStore.update({
        videoMemoryEnabled: true,
        videoMemoryLaunchCommand: launchCommand,
        videoMemoryLaunchCwd: installRoot,
      });
      await applyRuntimeSettings(settingsStore.settings, { backupReason: false });
      // Give the spawned flask server a moment to bind to 5050 before the
      // client refresh asks for devices, otherwise the panel still flashes
      // "not reachable" on the first response. uv may also need to resolve a
      // virtualenv on first run, so bias toward longer.
      await new Promise((resolve) => setTimeout(resolve, uvInstalled ? 2500 : 1200));
      await videoMemoryService.refreshRemoteDevices({ force: true });

      response.json({
        installPath: installRoot,
        cloned,
        uvInstalled,
        gitInstalled,
        repoUrl,
        settings: getSettingsState(),
        videoMemory: videoMemoryService.getStatus(),
      });
    } catch (error) {
      response.status(400).json({
        error: error.message || "Could not install the VideoMemory server.",
        installPath: installRoot,
        repoUrl,
      });
    }
  });

  app.get("/api/videomemory/monitors", (_request, response) => {
    response.json({ monitors: videoMemoryService.listMonitors() });
  });

  app.post("/api/videomemory/monitors", async (request, response) => {
    try {
      const token = String(
        request.headers["x-vibe-research-videomemory-token"] ||
          request.headers["x-vibe-research-videomemory-token"] ||
          request.body?.token ||
          "",
      ).trim();
      if (!videoMemoryService.validateCreateRequest(token)) {
        response.status(403).json({ error: "Invalid VideoMemory token." });
        return;
      }

      const monitor = await videoMemoryService.createMonitor(request.body);
      response.status(201).json({
        monitor,
        monitors: videoMemoryService.listMonitors(),
        videoMemory: videoMemoryService.getStatus(),
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not create VideoMemory monitor." });
    }
  });

  app.delete("/api/videomemory/monitors/:monitorId", async (request, response) => {
    try {
      const token = String(
        request.headers["x-vibe-research-videomemory-token"] ||
          request.headers["x-vibe-research-videomemory-token"] ||
          request.body?.token ||
          "",
      ).trim();
      if (!videoMemoryService.validateCreateRequest(token)) {
        response.status(403).json({ error: "Invalid VideoMemory token." });
        return;
      }

      const monitor = await videoMemoryService.deleteMonitor(request.params.monitorId, {
        stopRemoteTask: request.query.stop !== "0",
      });
      if (!monitor) {
        response.status(404).json({ error: "VideoMemory monitor not found." });
        return;
      }

      response.json({
        monitor,
        monitors: videoMemoryService.listMonitors(),
        videoMemory: videoMemoryService.getStatus(),
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not delete VideoMemory monitor." });
    }
  });

  app.post("/api/videomemory/webhook", async (request, response) => {
    try {
      const result = await videoMemoryService.handleWebhook({
        body: request.body,
        headers: request.headers,
      });
      response.json(result);
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not handle VideoMemory webhook." });
    }
  });

  async function handleAgentCallback(request, response) {
    try {
      const result = await agentCallbackService.handleRequest({
        body: request.body,
        headers: request.headers,
        sessionId: request.params.sessionId,
        token: request.params.token,
      });
      response.json(result);
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not deliver agent callback." });
    }
  }

  app.post("/api/agent-callbacks/:sessionId/:token", handleAgentCallback);
  app.post("/api/agent-callbacks/:sessionId", handleAgentCallback);

  app.get("/api/browser-use/sessions", (_request, response) => {
    response.json({ sessions: browserUseService.listSessions() });
  });

  app.post("/api/browser-use/sessions", async (request, response) => {
    try {
      const token = String(request.headers["x-vibe-research-browser-use-token"] || request.body?.token || "").trim();
      if (!browserUseService.validateCreateRequest(token)) {
        response.status(403).json({ error: "Invalid browser-use token." });
        return;
      }

      const session = await browserUseService.createSession({
        callerSessionId: request.body?.callerSessionId || request.body?.parentSessionId,
        cwd: request.body?.cwd,
        maxSteps: request.body?.maxSteps,
        maxTurns: request.body?.maxTurns,
        prompt: request.body?.prompt,
        task: request.body?.task,
        taskPrompt: request.body?.taskPrompt,
        title: request.body?.title || request.body?.name,
        url: request.body?.url,
      });

      response.status(201).json({ session });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not start browser-use session." });
    }
  });

  app.get("/api/browser-use/sessions/:browserUseSessionId", (request, response) => {
    const session = browserUseService.getSession(request.params.browserUseSessionId, { includeSnapshot: true });
    if (!session) {
      response.status(404).json({ error: "Browser-use session not found." });
      return;
    }

    response.json({ session });
  });

  app.delete("/api/browser-use/sessions/:browserUseSessionId", async (request, response) => {
    try {
      const session = await browserUseService.deleteSession(request.params.browserUseSessionId);
      if (!session) {
        response.status(404).json({ error: "Browser-use session not found." });
        return;
      }

      response.json({ ok: true, session });
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not delete browser-use session." });
    }
  });

  app.get("/api/ottoauth/tasks", (_request, response) => {
    response.json({ tasks: ottoAuthService.listTasks() });
  });

  app.post("/api/ottoauth/tasks", async (request, response) => {
    try {
      const token = String(request.headers["x-vibe-research-ottoauth-token"] || request.body?.token || "").trim();
      if (!ottoAuthService.validateCreateRequest(token)) {
        response.status(403).json({ error: "Invalid OttoAuth token." });
        return;
      }

      const callerSessionId = String(request.body?.callerSessionId || request.body?.parentSessionId || "").trim();
      const callbackUrl = String(request.body?.callbackUrl || request.body?.callback_url || "").trim()
        || (callerSessionId && sessionManager.getSession(callerSessionId)
          ? agentCallbackService.getCallback(callerSessionId).url
          : "");

      const task = await ottoAuthService.createTask({
        callbackUrl,
        callerSessionId,
        cwd: request.body?.cwd,
        itemUrl: request.body?.itemUrl || request.body?.item_url,
        maxChargeCents: request.body?.maxChargeCents || request.body?.max_charge_cents,
        prompt: request.body?.prompt,
        service: request.body?.service,
        serviceId: request.body?.serviceId,
        shippingAddress: request.body?.shippingAddress || request.body?.shipping_address,
        task: request.body?.task,
        taskPrompt: request.body?.taskPrompt || request.body?.task_prompt,
        title: request.body?.title || request.body?.name,
        url: request.body?.url || request.body?.websiteUrl || request.body?.website_url,
      });

      response.status(201).json({ task });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not start OttoAuth task." });
    }
  });

  app.get("/api/ottoauth/tasks/:ottoAuthTaskId", async (request, response) => {
    const refresh = request.query.refresh === "1" || request.query.refresh === "true";
    let task = null;
    try {
      task = refresh
        ? await ottoAuthService.refreshTask(request.params.ottoAuthTaskId)
        : ottoAuthService.getTask(request.params.ottoAuthTaskId);
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not refresh OttoAuth task." });
      return;
    }

    if (!task) {
      response.status(404).json({ error: "OttoAuth task not found." });
      return;
    }

    response.json({ task });
  });

  app.post("/api/ottoauth/tasks/:ottoAuthTaskId/refresh", async (request, response) => {
    try {
      const task = await ottoAuthService.refreshTask(request.params.ottoAuthTaskId);
      if (!task) {
        response.status(404).json({ error: "OttoAuth task not found." });
        return;
      }

      response.json({ task });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not refresh OttoAuth task." });
    }
  });

  app.get("/api/computeruse/device/wait-task", async (request, response) => {
    try {
      if (!browserUseService.validateDeviceRequest(request)) {
        response.status(403).json({ error: "Invalid browser-use device token." });
        return;
      }

      const task = await browserUseService.claimNextTask({
        deviceId: String(request.get("x-ottoauth-mock-device") || "").trim(),
      });

      if (!task) {
        response.status(204).end();
        return;
      }

      response.json(task);
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not claim browser-use task." });
    }
  });

  app.post("/api/computeruse/device/tasks/:browserUseSessionId/snapshot", async (request, response) => {
    try {
      if (!browserUseService.validateDeviceRequest(request)) {
        response.status(403).json({ error: "Invalid browser-use device token." });
        return;
      }

      const session = await browserUseService.recordSnapshot(request.params.browserUseSessionId, request.body);
      if (!session) {
        response.status(404).json({ error: "Browser-use session not found." });
        return;
      }

      response.json({ ok: true });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not record browser-use snapshot." });
    }
  });

  app.post("/api/computeruse/device/tasks/:browserUseSessionId/events", async (request, response) => {
    try {
      if (!browserUseService.validateDeviceRequest(request)) {
        response.status(403).json({ error: "Invalid browser-use device token." });
        return;
      }

      const session = await browserUseService.recordActivity(request.params.browserUseSessionId, request.body);
      if (!session) {
        response.status(404).json({ error: "Browser-use session not found." });
        return;
      }

      response.json({ ok: true });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not record browser-use event." });
    }
  });

  app.post("/api/computeruse/device/tasks/:browserUseSessionId/local-agent-complete", async (request, response) => {
    try {
      if (!browserUseService.validateDeviceRequest(request)) {
        response.status(403).json({ error: "Invalid browser-use device token." });
        return;
      }

      const session = await browserUseService.completeTask(request.params.browserUseSessionId, request.body);
      if (!session) {
        response.status(404).json({ error: "Browser-use session not found." });
        return;
      }

      response.json({ ok: true, session });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not complete browser-use task." });
    }
  });

  app.get("/api/computeruse/device/tasks/:browserUseSessionId/messages", (request, response) => {
    if (!browserUseService.validateDeviceRequest(request)) {
      response.status(403).json({ error: "Invalid browser-use device token." });
      return;
    }

    response.json({ messages: browserUseService.getTaskMessages(request.params.browserUseSessionId) });
  });

  app.post("/api/computeruse/device/tasks/:browserUseSessionId/messages", async (request, response) => {
    try {
      if (!browserUseService.validateDeviceRequest(request)) {
        response.status(403).json({ error: "Invalid browser-use device token." });
        return;
      }

      const message = await browserUseService.addTaskMessage(
        request.params.browserUseSessionId,
        request.body?.message,
      );
      response.json({ message });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not record browser-use message." });
    }
  });

  app.get("/api/folders", async (request, response) => {
    try {
      response.json(
        await listFolderEntries({
          root: typeof request.query.root === "string" ? request.query.root : cwd,
          relativePath: typeof request.query.path === "string" ? request.query.path : "",
          fallbackCwd: cwd,
        }),
      );
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.post("/api/folders", async (request, response) => {
    try {
      const payload = await createFolderEntry({
        root: typeof request.body?.root === "string" ? request.body.root : cwd,
        relativePath: typeof request.body?.path === "string" ? request.body.path : "",
        name: request.body?.name,
        fallbackCwd: cwd,
      });

      response.status(201).json(payload);
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.get("/api/files", async (request, response) => {
    try {
      const payload = await listWorkspaceEntries({
        root: typeof request.query.root === "string" ? request.query.root : cwd,
        relativePath: typeof request.query.path === "string" ? request.query.path : "",
        fallbackCwd: cwd,
      });

      response.json(payload);
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.get("/api/files/content", async (request, response) => {
    try {
      const entry = await resolveWorkspaceEntry({
        root: typeof request.query.root === "string" ? request.query.root : cwd,
        relativePath: typeof request.query.path === "string" ? request.query.path : "",
        fallbackCwd: cwd,
      });

      if (!entry.stats.isFile()) {
        response.status(400).json({ error: "Requested path is not a file." });
        return;
      }

      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.sendFile(entry.targetPath, { dotfiles: "allow" }, (error) => {
        if (!error) {
          return;
        }

        if (response.headersSent) {
          response.destroy(error);
          return;
        }

        response.status(error.statusCode || error.status || 500).json({
          error: error.message || "Unable to read requested file.",
        });
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.get("/api/knowledge-base", async (_request, response) => {
    try {
      response.json(
        await listKnowledgeBase({
          relativeRoot: settingsStore.getState().wikiRelativeRoot,
          rootPath: settingsStore.settings.wikiPath,
        }),
      );
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.get("/api/knowledge-base/note", async (request, response) => {
    try {
      response.json(
        await readKnowledgeBaseNote({
          relativeRoot: settingsStore.getState().wikiRelativeRoot,
          rootPath: settingsStore.settings.wikiPath,
          relativePath: typeof request.query.path === "string" ? request.query.path : "",
        }),
      );
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.get("/api/files/text", async (request, response) => {
    try {
      const file = await readWorkspaceTextFile({
        root: typeof request.query.root === "string" ? request.query.root : cwd,
        relativePath: typeof request.query.path === "string" ? request.query.path : "",
        fallbackCwd: cwd,
      });

      response.json({ file });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.put("/api/files/text", async (request, response) => {
    try {
      const file = await writeWorkspaceTextFile({
        root: typeof request.body?.root === "string" ? request.body.root : cwd,
        relativePath: typeof request.body?.path === "string" ? request.body.path : "",
        fallbackCwd: cwd,
        content: request.body?.content,
      });

      response.json({ file });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.post("/api/attachments/images", async (request, response) => {
    try {
      const sessionId = String(request.body?.sessionId || "").trim();
      const session = sessionId ? sessionManager.getSession(sessionId) : null;

      if (!session) {
        response.status(404).json({ error: "Session not found." });
        return;
      }

      const attachment = await saveImageAttachment({
        stateDir,
        session,
        dataUrl: request.body?.dataUrl,
        originalName: request.body?.name,
        mimeType: request.body?.mimeType,
        source: request.body?.source,
      });

      response.status(201).json({ attachment });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.post("/api/sessions", (request, response) => {
    try {
      const session = sessionManager.createSession({
        providerId: String(request.body?.providerId || defaultProviderId),
        name: request.body?.name,
        cwd: request.body?.cwd,
        occupationId: agentPromptStore.selectedPromptId,
        initialPrompt: request.body?.initialPrompt,
        initialPromptDelayMs: request.body?.initialPromptDelayMs,
      });

      response.status(201).json({ session });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/sessions", (_request, response) => {
    response.json({ sessions: sessionManager.listSessions() });
  });

  app.get("/api/sessions/:sessionId/narrative", async (request, response) => {
    try {
      const narrative = await sessionManager.getSessionNarrative(request.params.sessionId);

      if (!narrative) {
        response.status(404).json({ error: "Session not found." });
        return;
      }

      response.json({ narrative });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not read session narrative." });
    }
  });

  app.get("/api/sessions/:sessionId/callback", (request, response) => {
    try {
      const callback = agentCallbackService.getCallbackForSession(request.params.sessionId);
      response.json({
        callback: {
          sessionId: callback.sessionId,
          url: callback.url,
        },
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || "Could not read agent callback." });
    }
  });

  const handleSessionRename = (request, response) => {
    try {
      const session = sessionManager.renameSession(request.params.sessionId, request.body?.name);

      if (!session) {
        response.status(404).json({ error: "Session not found." });
        return;
      }

      response.json({ session });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  };

  app.put("/api/sessions/:sessionId", handleSessionRename);
  app.patch("/api/sessions/:sessionId", handleSessionRename);

  app.get("/api/agent-prompt", async (_request, response) => {
    try {
      response.json(await agentPromptStore.getState());
    } catch (error) {
      response
        .status(error.statusCode || 500)
        .json({ error: error.message || "Could not load agent prompt." });
    }
  });

  app.put("/api/agent-prompt", async (request, response) => {
    try {
      const payload = await agentPromptStore.save(request.body);
      sessionManager.setOccupationId(payload.selectedPromptId);
      response.json(payload);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/agent-prompt/reload", async (_request, response) => {
    try {
      const payload = await agentPromptStore.reload();
      sessionManager.setOccupationId(payload.selectedPromptId);
      response.json(payload);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/sessions/:sessionId/fork", (request, response) => {
    try {
      const session = sessionManager.forkSession(request.params.sessionId);

      if (!session) {
        response.status(404).json({ error: "Session not found." });
        return;
      }

      response.status(201).json({ session });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/sessions/:sessionId/swarm", async (request, response) => {
    try {
      const graph = await sessionManager.getSessionSwarmGraph(request.params.sessionId);

      if (!graph) {
        response.status(404).json({ error: "Session not found." });
        return;
      }

      response.json({ graph });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/projects/swarm", async (request, response) => {
    try {
      const cwd = String(request.query.cwd || "");

      if (!cwd) {
        response.status(400).json({ error: "Project folder is required." });
        return;
      }

      const graph = await sessionManager.getProjectSwarmGraph(cwd);
      response.json({ graph });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/sessions/:sessionId", (request, response) => {
    const deleted = sessionManager.deleteSession(request.params.sessionId);

    if (!deleted) {
      response.status(404).json({ error: "Session not found." });
      return;
    }

    response.json({ ok: true });
  });

  function scheduleTerminateAfterResponse(response, options) {
    let requested = false;

    const requestOnce = () => {
      if (requested) {
        return;
      }

      requested = true;
      void requestTerminate(options);
    };

    response.once("finish", requestOnce);
    response.once("close", requestOnce);
  }

  app.post("/api/terminate", (_request, response) => {
    scheduleTerminateAfterResponse(response, { relaunch: false });
    response.json({ ok: true, shuttingDown: true });
  });

  app.post("/api/relaunch", (_request, response) => {
    scheduleTerminateAfterResponse(response, { relaunch: true });
    response.json({ ok: true, relaunching: true });
  });

  app.use("/proxy/:port", (request, response) => {
    const proxyPort = normalizePort(request.params.port);

    if (!proxyPort) {
      response.status(400).json({ error: "Invalid port." });
      return;
    }

    proxyHttpRequest(request, response, proxyServer, proxyPort, true);
  });

  app.use(
    express.static(publicDir, {
      setHeaders(response, filePath) {
        const basename = path.basename(filePath);
        if (["index.html", "app.js", "styles.css"].includes(basename)) {
          response.setHeader("Cache-Control", "no-store");
        }
      },
    }),
  );

  // Last-resort error handler. Express does not auto-translate async route
  // rejections into 500s, so any handler that forgets a try/catch ends with a
  // hung response. Each `/api/*` route is supposed to handle its own errors,
  // but if one slips through we still want the browser to see *something*
  // rather than spin forever waiting for a response.
  app.use((error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    // The Express `send` library (used by sendFile) attaches `error.status`,
    // not `error.statusCode`, on a missing-file 404 — accept either so we
    // don't turn legitimate 404s into 500s.
    const candidate = Number.isInteger(error?.statusCode)
      ? error.statusCode
      : Number.isInteger(error?.status)
      ? error.status
      : null;
    const status = candidate && candidate >= 400 && candidate < 600 ? candidate : 500;
    const message = error?.message || "Internal server error.";
    if (status >= 500) {
      try {
        console.error("[vibe-research] unhandled route error:", error);
      } catch {
        // ignore logging failures
      }
    }
    response.status(status).json({ error: message });
  });

  const server = await new Promise((resolve, reject) => {
    const nextServer = app.listen(port, host, () => resolve(nextServer));
    nextServer.on("error", reject);
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  const globalWebsocketClients = new Set();

  function broadcastToAllClients(payload) {
    const message = JSON.stringify(payload);
    for (const client of globalWebsocketClients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(message);
        } catch {
          // Silently drop; socket will be cleaned up on close.
        }
      }
    }
  }

  sessionManager.setBroadcast(broadcastToAllClients);

  function resolveSessionForPath(absolutePath) {
    let best = null;
    let bestLength = -1;
    for (const session of sessionManager.listSessions()) {
      const cwd = session.cwd || "";
      if (!cwd) continue;
      if (absolutePath === cwd || absolutePath.startsWith(cwd + path.sep)) {
        if (cwd.length > bestLength) {
          best = session;
          bestLength = cwd.length;
        }
      }
    }
    if (best) return best.id;

    const sessions = sessionManager.listSessions();
    if (!sessions.length) return "";
    return sessions.reduce((latest, session) => {
      const latestTs = Date.parse(latest.updatedAt || latest.createdAt || 0) || 0;
      const candidateTs = Date.parse(session.updatedAt || session.createdAt || 0) || 0;
      return candidateTs > latestTs ? session : latest;
    }).id;
  }

  const AGENT_POINTER_DEFAULT_MS = 15000;
  const AGENT_POINTER_MAX_MS = 120000;
  let activeAgentPointer = null;
  let agentPointerClearTimer = null;

  function clearAgentPointerTimer() {
    if (agentPointerClearTimer) {
      clearTimeout(agentPointerClearTimer);
      agentPointerClearTimer = null;
    }
  }

  function setAgentPointer(payload = {}) {
    const rawTarget = payload.target;
    const target = typeof rawTarget === "string"
      ? rawTarget.trim()
      : rawTarget && typeof rawTarget === "object"
        ? rawTarget
        : "";
    if (!target) {
      const error = new Error("pointer target is required (string token or {x,y} coords).");
      error.statusCode = 400;
      throw error;
    }

    const durationMs = Math.min(
      AGENT_POINTER_MAX_MS,
      Math.max(500, Number(payload.durationMs) || AGENT_POINTER_DEFAULT_MS),
    );
    const now = Date.now();
    const pointer = {
      id: randomUUID(),
      target,
      reason: typeof payload.reason === "string" ? payload.reason.trim().slice(0, 500) : "",
      sourceSessionId: typeof payload.sourceSessionId === "string" ? payload.sourceSessionId : "",
      createdAt: now,
      expiresAt: now + durationMs,
    };
    activeAgentPointer = pointer;

    clearAgentPointerTimer();
    agentPointerClearTimer = setTimeout(() => {
      if (activeAgentPointer?.id === pointer.id) {
        activeAgentPointer = null;
        broadcastToAllClients({ type: "agent-pointer", pointer: null });
      }
    }, durationMs);

    broadcastToAllClients({ type: "agent-pointer", pointer });
    return pointer;
  }

  function clearAgentPointer() {
    clearAgentPointerTimer();
    const hadPointer = Boolean(activeAgentPointer);
    activeAgentPointer = null;
    if (hadPointer) {
      broadcastToAllClients({ type: "agent-pointer", pointer: null });
    }
  }

  app.get("/api/agent-town/pointer", (_request, response) => {
    response.json({ pointer: activeAgentPointer });
  });

  app.post("/api/agent-town/pointer", (request, response) => {
    try {
      const pointer = setAgentPointer(request.body || {});
      response.status(201).json({ pointer });
    } catch (error) {
      response.status(error.statusCode || 400).json({
        error: error.message || "Could not set agent pointer.",
      });
    }
  });

  app.delete("/api/agent-town/pointer", (_request, response) => {
    clearAgentPointer();
    response.json({ pointer: null });
  });

  const stopLibraryActivityWatcher = startLibraryActivityWatcher({
    wikiPath: settingsStore.settings.wikiPath,
    resolveSessionForPath,
    broadcast: broadcastToAllClients,
    log: (message) => console.log(message),
  });
  const resolvedPort =
    typeof server.address() === "object" && server.address()
      ? server.address().port
      : port;
  exposedPort = resolvedPort;
  updateManager.setRuntime?.({ port: resolvedPort });
  urls = await accessUrlsProvider(host, resolvedPort);
  preferredUrl = pickPreferredUrl(urls)?.url ?? urls[0]?.url ?? null;
  helperBaseUrl = getHelperBaseUrl(host, resolvedPort);
  publicBaseUrl = getPublicBaseUrl(host, resolvedPort, urls, serverEnv);
  agentCallbackService.setServerBaseUrl(publicBaseUrl || helperBaseUrl);
  sessionManager.setEnvironment(buildSessionManagerEnvironment());
  await syncBuildingAgentGuides({ refreshBuildingHub: true });
  browserUseService.setServerBaseUrl(publicBaseUrl || helperBaseUrl);
  twilioService.setServerBaseUrl?.(publicBaseUrl || preferredUrl || helperBaseUrl);
  videoMemoryService.setServerBaseUrl(publicBaseUrl || helperBaseUrl);
  await writeServerInfo(stateDir, {
    agentMailReplyToken: agentMailService.replyToken,
    agentCallbackBaseUrl: agentCallbackService.getCallbackBaseUrl(),
    browserUseToken: browserUseService.requestToken,
    ottoAuthToken: ottoAuthService.requestToken,
    telegramReplyToken: telegramService.replyToken,
    twilioReplyToken: twilioService.replyToken,
    twilioWebhookUrl: twilioService.getWebhookUrl?.() || "",
    videoMemoryToken: videoMemoryService.requestToken,
    videoMemoryWebhookToken: videoMemoryService.webhookToken,
    videoMemoryWebhookUrl: videoMemoryService.getWebhookUrl(),
    pid: process.pid,
    host,
    port: resolvedPort,
    helperBaseUrl,
    preferredUrl: publicBaseUrl || preferredUrl,
  });
  if (systemMetricsSampleIntervalMs > 0) {
    systemMetricsTimer = setInterval(() => {
      void sampleSystemMetricsHistory();
    }, systemMetricsSampleIntervalMs);
    systemMetricsTimer.unref?.();
  }
  server.on("upgrade", (request, socket, head) => {
    // Wrap the whole upgrade dispatch in try/catch so a throw in any branch
    // (e.g., bad URL, getPortFromReferrer surprise, handleUpgrade synchronous
    // throw) closes the socket promptly with a logged reason instead of
    // leaving the client to time out at ~5s with WS code 1006.
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host}`);

      if (url.pathname.startsWith("/proxy/")) {
        const proxyPort = getPortFromProxyPath(url.pathname);

        if (!proxyPort) {
          socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
          socket.destroy();
          return;
        }

        proxyWebsocketRequest(request, socket, head, proxyServer, proxyPort, true);
        return;
      }

      const proxiedPort = getPortFromReferrer(request);
      if (proxiedPort) {
        proxyWebsocketRequest(request, socket, head, proxyServer, proxiedPort, false);
        return;
      }

      if (url.pathname !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request, url);
      });
    } catch (error) {
      console.error("[vibe-research] websocket upgrade failed", {
        url: request.url,
        message: error?.message,
        stack: error?.stack,
      });
      try {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      } catch {}
      try {
        socket.destroy();
      } catch {}
    }
  });

  websocketServer.on("connection", (websocket, _request, url) => {
    const sessionId = url.searchParams.get("sessionId");

    if (!sessionId) {
      websocket.send(JSON.stringify({ type: "error", message: "Missing sessionId." }));
      websocket.close();
      return;
    }

    const session = sessionManager.attachClient(sessionId, websocket);
    if (!session) {
      return;
    }

    globalWebsocketClients.add(websocket);
    websocket.on("close", () => {
      globalWebsocketClients.delete(websocket);
    });

    websocket.on("message", (payload) => {
      try {
        const message = JSON.parse(String(payload));

        if (message.type === "input" && typeof message.data === "string") {
          sessionManager.write(session.id, message.data);
          return;
        }

        if (message.type === "resize") {
          sessionManager.resize(
            session.id,
            Number(message.cols || session.cols),
            Number(message.rows || session.rows),
          );
        }
      } catch {
        websocket.send(JSON.stringify({ type: "error", message: "Malformed websocket payload." }));
      }
    });
  });

  async function close() {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      stopLibraryActivityWatcher();
      await sessionManager.shutdown({ preserveSessions: persistSessions });
      await browserUseService.shutdown();
      await removeServerInfo(stateDir);
      agentMailService.stop();
      telegramService.stop();
      twilioService.stop();
      try {
        videoMemoryService?.stopLaunchedProcess?.();
      } catch { /* best effort */ }
      wikiBackupService.stop();
      sleepPreventionService.stop();
      mcpLaunchHealthScheduler.stop();
      if (systemMetricsTimer) {
        clearInterval(systemMetricsTimer);
        systemMetricsTimer = null;
      }
      proxyServer.close();
      await new Promise((resolve) => websocketServer.close(resolve));
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }

          resolve();
        });

        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      });
    })();

    return closePromise;
  }

  async function requestTerminate({ relaunch = false } = {}) {
    if (terminatePromise) {
      return terminatePromise;
    }

    // Hard cap on how long graceful shutdown can take. websocketServer.close
    // and server.close wait for clients to drain; with a frontend that
    // reconnects on failure, "drain" can take forever. The previous behavior
    // was: terminatePromise gets stuck, every subsequent /api/relaunch and
    // /api/terminate hits the `if (terminatePromise) return` short-circuit
    // and silently does nothing. The deploy script's auto-restart then
    // becomes a no-op while the user is locked out of the terminal.
    const FORCE_EXIT_AFTER_MS = 8000;
    const forceExitTimer = setTimeout(() => {
      console.error(
        `[vibe-research] graceful shutdown exceeded ${FORCE_EXIT_AFTER_MS}ms; forcing process exit`,
      );
      try {
        if (relaunch && typeof onTerminate === "function") {
          // Best-effort: still spawn the relaunch child before we hard-exit
          // so the wrapper sees a successor. onTerminate calls process.exit
          // synchronously after the spawn, so we just call it directly.
          Promise.resolve(onTerminate({ relaunch })).catch(() => {
            process.exit(1);
          });
          // Safety net: if onTerminate itself hangs, exit anyway.
          setTimeout(() => process.exit(1), 1000).unref?.();
        } else {
          process.exit(1);
        }
      } catch {
        process.exit(1);
      }
    }, FORCE_EXIT_AFTER_MS);
    forceExitTimer.unref?.();

    terminatePromise = (async () => {
      try {
        await close();
        if (typeof onTerminate === "function") {
          await onTerminate({ relaunch });
        }
      } finally {
        clearTimeout(forceExitTimer);
      }
    })();

    return terminatePromise;
  }

  return {
    app,
    close,
    config: {
      appName: "Vibe Research",
      agentPrompt: await agentPromptStore.getState(),
      cwd,
      defaultSessionCwd: sessionDefaultCwd,
      defaultProviderId,
      host,
      port: resolvedPort,
      providers,
      preferredUrl: publicBaseUrl || preferredUrl,
      settings: getSettingsState(),
      stateDir,
      urls,
    },
    server,
    sessionManager,
    ottoAuthService,
    videoMemoryService,
    relaunch: () => requestTerminate({ relaunch: true }),
    terminate: requestTerminate,
  };
}
