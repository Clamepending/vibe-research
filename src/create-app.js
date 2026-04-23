import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import httpProxy from "http-proxy";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { WebSocketServer } from "ws";
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
import { publishTownShareToBuildingHub } from "./buildinghub-layout-publisher.js";
import { publishScaffoldRecipeToBuildingHub } from "./buildinghub-scaffold-publisher.js";
import { writeBuildingAgentGuides } from "./building-agent-guides.js";
import { BuildingHubService } from "./buildinghub-service.js";
import { BrowserUseService } from "./browser-use-service.js";
import { BUILDING_CATALOG } from "./client/building-registry.js";
import { createFolderEntry, listFolderEntries } from "./folder-browser.js";
import { OttoAuthService } from "./ottoauth-service.js";
import { PortAliasStore } from "./port-alias-store.js";
import { listListeningPorts } from "./ports.js";
import {
  buildScaffoldRecipe,
  createScaffoldRecipeApplyPlan,
  previewScaffoldRecipe,
  ScaffoldRecipeService,
} from "./scaffold-recipe-service.js";
import { buildAgentCredentialEnv, SettingsStore } from "./settings-store.js";
import { SessionManager } from "./session-manager.js";
import { SleepPreventionService } from "./sleep-prevention.js";
import { getVibeResearchStateDir, getVibeResearchSystemDir } from "./state-paths.js";
import { collectSystemMetrics } from "./system-metrics.js";
import { SystemMetricsHistoryStore } from "./system-metrics-history.js";
import { TailscaleServeManager } from "./tailscale-serve.js";
import { TelegramService } from "./telegram-service.js";
import { UpdateManager } from "./update-manager.js";
import { VideoMemoryService } from "./videomemory-service.js";
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
const PROVIDER_INSTALL_TIMEOUT_MS = Number(
  process.env.VIBE_RESEARCH_PROVIDER_INSTALL_TIMEOUT_MS || process.env.REMOTE_VIBES_PROVIDER_INSTALL_TIMEOUT_MS || 20 * 60 * 1000,
);
const PROVIDER_INSTALL_MAX_BUFFER = Number(
  process.env.VIBE_RESEARCH_PROVIDER_INSTALL_MAX_BUFFER || process.env.REMOTE_VIBES_PROVIDER_INSTALL_MAX_BUFFER || 2 * 1024 * 1024,
);
const WIKI_CLONE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const WIKI_CLONE_RATE_LIMIT_MAX = 5;
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

function getRequestOrigin(request) {
  const forwardedProto = String(request.get("x-forwarded-proto") || "").split(",")[0].trim();
  const protocol = forwardedProto || request.protocol || "http";
  const host = String(request.get("x-forwarded-host") || request.get("host") || "").split(",")[0].trim();
  if (host) {
    return `${protocol}://${host}`;
  }

  return "";
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

function renderTownSharePage(townShare, request) {
  const share = withTownShareUrls(townShare, request);
  const title = `${share.name} · BuildingHub`;
  const description = share.description || "A shared Agent Town base layout.";
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
  if (host !== "0.0.0.0") {
    return [{ label: "Direct", url: `http://${host}:${port}` }];
  }

  const seen = new Set();
  const urls = [{ label: "Local", url: `http://localhost:${port}` }];

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
      urls.push({ label, url: `http://${address.address}:${port}` });
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

export async function createVibeResearchApp({
  host = process.env.VIBE_RESEARCH_HOST || process.env.REMOTE_VIBES_HOST || "0.0.0.0",
  port = Number(process.env.VIBE_RESEARCH_PORT || process.env.REMOTE_VIBES_PORT || 4123),
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
  browserUseServiceFactory = null,
  ottoAuthServiceFactory = null,
  telegramServiceFactory = null,
  videoMemoryServiceFactory = null,
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
  let sessionDefaultCwd = await ensureDefaultSessionCwd(settingsStore.settings.agentSpawnPath || defaultSessionCwd, cwd);
  await mkdir(systemRootPath, { recursive: true });
  await systemMetricsHistoryStore.initialize();
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
        });
  videoMemoryService =
    typeof videoMemoryServiceFactory === "function"
      ? videoMemoryServiceFactory(settingsStore.settings, {
          cwd,
          defaultProviderId,
          sessionManager,
          stateDir,
          systemRootPath,
        })
      : new VideoMemoryService({
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
  await browserUseService.initialize();
  await ottoAuthService.initialize();
  await videoMemoryService.initialize();
  await agentCallbackService.initialize();
  await scaffoldRecipeService.initialize();
  await sessionManager.initialize();
  await agentPromptStore.initialize();
  sessionManager.setOccupationId(agentPromptStore.selectedPromptId);
  wikiBackupService.start();
  agentMailService.start();
  telegramService.start();
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
      buildingHubStatus: buildingHubService.getStatus(),
      browserUseStatus: browserUseService.getStatus(),
      ottoAuthStatus: ottoAuthService.getStatus(),
      sleepStatus: sleepPreventionService.getStatus(),
      telegramStatus: telegramService.getStatus(),
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

  async function buildCurrentScaffoldRecipe({ name = "Current Vibe Research scaffold", tags = [] } = {}) {
    await buildingHubService.refresh();
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
      name,
      providers,
      settings: settingsStore.settings,
      tags,
    });
  }

  function getAvailableBuildingIds() {
    return [
      ...BUILDING_CATALOG.map((building) => building.id),
      ...buildingHubService.listBuildings().map((building) => building.id),
    ];
  }

  function buildSessionManagerEnvironment() {
    const resolvedPort = exposedPort || port;
    return {
      ...buildAgentCredentialEnv(settingsStore.settings, serverEnv),
      REMOTE_VIBES_PORT: String(resolvedPort),
      REMOTE_VIBES_SERVER_URL: helperBaseUrl || "",
      REMOTE_VIBES_URL: preferredUrl || helperBaseUrl || "",
      REMOTE_VIBES_AGENT_CALLBACK_BASE_URL: agentCallbackService.getCallbackBaseUrl(),
      REMOTE_VIBES_SCAFFOLD_RECIPES_API: `${helperBaseUrl || `http://127.0.0.1:${resolvedPort}`}/api/scaffold-recipes`,
      VIBE_RESEARCH_PORT: String(resolvedPort),
      VIBE_RESEARCH_SERVER_URL: helperBaseUrl || "",
      VIBE_RESEARCH_URL: preferredUrl || helperBaseUrl || "",
      VIBE_RESEARCH_AGENT_CALLBACK_BASE_URL: agentCallbackService.getCallbackBaseUrl(),
      VIBE_RESEARCH_AGENT_TOWN_API: `${helperBaseUrl || `http://127.0.0.1:${resolvedPort}`}/api/agent-town`,
      VIBE_RESEARCH_SCAFFOLD_RECIPES_API: `${helperBaseUrl || `http://127.0.0.1:${resolvedPort}`}/api/scaffold-recipes`,
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
    videoMemoryService.restart(settingsStore.settings);
    agentMailService.restart(settingsStore.settings);
    sessionManager.setEnvironment(buildSessionManagerEnvironment());
    await syncBuildingAgentGuides();
    if (backupReason) {
      void wikiBackupService.runBackup({ reason: backupReason });
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

  app.get("/", (request, response, next) => {
    if (!isMasterplanHost(request)) {
      next();
      return;
    }

    response.setHeader("Cache-Control", "no-store");
    response.sendFile(masterplanIndexPath);
  });

  app.get("/api/state", async (_request, response) => {
    await buildingHubService.refresh();
    await syncBuildingAgentGuides();
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
      response.json({
        recipe,
        preview: previewScaffoldRecipe(recipe, {
          availableBuildingIds: getAvailableBuildingIds(),
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
      const preview = previewScaffoldRecipe(request.body?.recipe || request.body || {}, {
        availableBuildingIds: getAvailableBuildingIds(),
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
    return {
      agentPrompt: await agentPromptStore.getState(),
      agentTown: layoutPayload?.state || agentTownStore.getState(),
      plan,
      preview: previewScaffoldRecipe(plan.recipe, {
        availableBuildingIds: getAvailableBuildingIds(),
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
    response.json({
      ports: await listNamedPorts(),
    });
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
    const force = request.query.force === "1" || request.query.force === "true";
    const update = await updateManager.getStatus({ force });
    response.json({ update });
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
      });
      const payload = await agentTownStore.publishTownShare({
        ...localPayload.townShare,
        buildingHub,
      });
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

  app.get("/api/agent-town/action-items", (_request, response) => {
    response.json({
      actionItems: agentTownStore.getState().actionItems,
    });
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
        buildingHubCatalogPath: request.body?.buildingHubCatalogPath,
        buildingHubCatalogUrl: request.body?.buildingHubCatalogUrl,
        buildingHubEnabled: request.body?.buildingHubEnabled,
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

      response.json({
        settings: getSettingsState(),
        agentPrompt: await agentPromptStore.getState(),
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
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
    const status = await wikiBackupService.runBackup({ reason: "manual" });
    response.json({
      backup: status,
      settings: getSettingsState(),
    });
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
    await videoMemoryService.refreshRemoteMonitorStates();
    await videoMemoryService.refreshRemoteDevices();
    response.json({
      monitors: videoMemoryService.listMonitors(),
      videoMemory: videoMemoryService.getStatus(),
    });
  });

  app.post("/api/videomemory/setup", async (request, response) => {
    try {
      await settingsStore.update({
        installedPluginIds: request.body?.installedPluginIds,
        videoMemoryBaseUrl: request.body?.baseUrl ?? request.body?.videoMemoryBaseUrl,
        videoMemoryEnabled: request.body?.enabled ?? request.body?.videoMemoryEnabled,
        videoMemoryProviderId: request.body?.providerId ?? request.body?.videoMemoryProviderId,
      });
      await applyRuntimeSettings(settingsStore.settings, { backupReason: false });

      response.json({
        monitors: videoMemoryService.listMonitors(),
        settings: getSettingsState(),
        videoMemory: videoMemoryService.getStatus(),
      });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not set up VideoMemory plugin." });
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
    const session = await browserUseService.deleteSession(request.params.browserUseSessionId);
    if (!session) {
      response.status(404).json({ error: "Browser-use session not found." });
      return;
    }

    response.json({ ok: true, session });
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
    response.json(await agentPromptStore.getState());
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

  const server = await new Promise((resolve, reject) => {
    const nextServer = app.listen(port, host, () => resolve(nextServer));
    nextServer.on("error", reject);
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  const resolvedPort =
    typeof server.address() === "object" && server.address()
      ? server.address().port
      : port;
  exposedPort = resolvedPort;
  updateManager.setRuntime?.({ port: resolvedPort });
  urls = await accessUrlsProvider(host, resolvedPort);
  preferredUrl = pickPreferredUrl(urls)?.url ?? urls[0]?.url ?? null;
  helperBaseUrl = getHelperBaseUrl(host, resolvedPort);
  agentCallbackService.setServerBaseUrl(helperBaseUrl);
  sessionManager.setEnvironment(buildSessionManagerEnvironment());
  await syncBuildingAgentGuides({ refreshBuildingHub: true });
  browserUseService.setServerBaseUrl(helperBaseUrl);
  videoMemoryService.setServerBaseUrl(helperBaseUrl);
  await writeServerInfo(stateDir, {
    agentMailReplyToken: agentMailService.replyToken,
    agentCallbackBaseUrl: agentCallbackService.getCallbackBaseUrl(),
    browserUseToken: browserUseService.requestToken,
    ottoAuthToken: ottoAuthService.requestToken,
    telegramReplyToken: telegramService.replyToken,
    videoMemoryToken: videoMemoryService.requestToken,
    videoMemoryWebhookToken: videoMemoryService.webhookToken,
    videoMemoryWebhookUrl: videoMemoryService.getWebhookUrl(),
    pid: process.pid,
    host,
    port: resolvedPort,
    helperBaseUrl,
    preferredUrl,
  });
  if (systemMetricsSampleIntervalMs > 0) {
    systemMetricsTimer = setInterval(() => {
      void sampleSystemMetricsHistory();
    }, systemMetricsSampleIntervalMs);
    systemMetricsTimer.unref?.();
  }
  server.on("upgrade", (request, socket, head) => {
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
      await sessionManager.shutdown({ preserveSessions: persistSessions });
      await browserUseService.shutdown();
      await removeServerInfo(stateDir);
      agentMailService.stop();
      telegramService.stop();
      wikiBackupService.stop();
      sleepPreventionService.stop();
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

    terminatePromise = (async () => {
      await close();
      if (typeof onTerminate === "function") {
        await onTerminate({ relaunch });
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
      preferredUrl,
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
