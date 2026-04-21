import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import httpProxy from "http-proxy";
import { mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
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
import { AgentPromptStore } from "./agent-prompt-store.js";
import { AgentRunStore } from "./agent-run-store.js";
import { BrowserUseService } from "./browser-use-service.js";
import { createFolderEntry, listFolderEntries } from "./folder-browser.js";
import { PortAliasStore } from "./port-alias-store.js";
import { listListeningPorts } from "./ports.js";
import { SettingsStore } from "./settings-store.js";
import { SessionManager } from "./session-manager.js";
import { SleepPreventionService } from "./sleep-prevention.js";
import { getRemoteVibesStateDir, getRemoteVibesSystemDir } from "./state-paths.js";
import { collectSystemMetrics } from "./system-metrics.js";
import { SystemMetricsHistoryStore } from "./system-metrics-history.js";
import { TailscaleServeManager } from "./tailscale-serve.js";
import { UpdateManager } from "./update-manager.js";
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
const publicDir = path.resolve(__dirname, "..", "public");
const execFileAsync = promisify(execFile);
const SERVER_INFO_FILENAME = "server.json";
const TAILSCALE_HTTPS_SERVE_ENABLED = process.env.REMOTE_VIBES_TAILSCALE_HTTPS !== "0";
const JSON_BODY_LIMIT = "25mb";
const ATTACHMENTS_SUBDIR = "attachments";
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
  const rawName = cleaned.split(/[/:]/).filter(Boolean).at(-1) || "brain";
  const folderName = rawName
    .replace(/\.git$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return folderName || "brain";
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
    urls.push({ label: "Tailscale HTTPS", url: tailscaleHttpsUrl });
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
      return (await probeTailscaleHttpsUrl(configuredUrl)) ? configuredUrl : "";
    }

    if (hasTailscaleHttpsRootServe(serveStatus, dnsName)) {
      return "";
    }

    try {
      await runTailscaleCommand(["serve", "--bg", "--yes", String(port)]);
    } catch {
      try {
        await runTailscaleCommand(["serve", "--bg", String(port)]);
      } catch {
        return "";
      }
    }

    serveStatus = await readTailscaleServeStatusJson();
    const nextUrl = getTailscaleHttpsUrlFromServeStatus(serveStatus, port, dnsName);
    return nextUrl && (await probeTailscaleHttpsUrl(nextUrl)) ? nextUrl : "";
  } catch {
    return "";
  }
}

async function probeTailscaleHttpsUrl(baseUrl) {
  let probeUrl;
  try {
    probeUrl = new URL("/api/state", baseUrl);
  } catch {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(probeUrl, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
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

export async function createRemoteVibesApp({
  host = process.env.REMOTE_VIBES_HOST || "0.0.0.0",
  port = Number(process.env.REMOTE_VIBES_PORT || 4123),
  cwd = process.cwd(),
  stateDir = getRemoteVibesStateDir({ cwd }),
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
  browserUseServiceFactory = null,
  systemMetricsProvider = collectSystemMetrics,
  systemMetricsSampleIntervalMs = 60_000,
  updateManager = new UpdateManager({ cwd, stateDir, port }),
} = {}) {
  const providers = Array.isArray(providerOverrides) ? providerOverrides : await detectProviders();
  const defaultProviderId = getDefaultProviderId(providers);
  const app = express();
  const agentRunStore = new AgentRunStore({ stateDir });
  const systemRootPath = getRemoteVibesSystemDir({ cwd, stateDir });
  const settingsStore = new SettingsStore({ cwd, stateDir });
  const systemMetricsHistoryStore = new SystemMetricsHistoryStore({ stateDir });
  const portAliasStore = new PortAliasStore({ stateDir });
  await settingsStore.initialize();
  await mkdir(systemRootPath, { recursive: true });
  await systemMetricsHistoryStore.initialize();
  const browserUseService =
    typeof browserUseServiceFactory === "function"
      ? browserUseServiceFactory(settingsStore.settings, { cwd, stateDir, systemRootPath })
      : new BrowserUseService({
          settings: settingsStore.settings,
          stateDir,
          systemRootPath,
        });
  const wikiBackupService = new WikiBackupService({
    enabled: settingsStore.settings.wikiGitBackupEnabled,
    intervalMs: settingsStore.settings.wikiBackupIntervalMs,
    remoteBranch: settingsStore.settings.wikiGitRemoteBranch,
    remoteEnabled: settingsStore.settings.wikiGitRemoteEnabled,
    remoteName: settingsStore.settings.wikiGitRemoteName,
    remoteUrl: settingsStore.settings.wikiGitRemoteUrl,
    wikiPath: settingsStore.settings.wikiPath,
  });
  const sleepPreventionService = sleepPreventionFactory(settingsStore.settings);
  const sessionManager = new SessionManager({
    cwd,
    providers,
    persistSessions,
    persistentTerminals,
    stateDir,
    agentRunStore,
    wikiRootPath: settingsStore.settings.wikiPath,
    systemRootPath,
    extraSubagentsProvider: (session) => browserUseService.listSubagentsForSession(session.id),
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
  await agentRunStore.initialize();
  await portAliasStore.initialize();
  await browserUseService.initialize();
  await sessionManager.initialize();
  await agentPromptStore.initialize();
  wikiBackupService.start();
  agentMailService.start();
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
      browserUseStatus: browserUseService.getStatus(),
      sleepStatus: sleepPreventionService.getStatus(),
    });
  }

  async function applyRuntimeSettings(settings, { backupReason = "settings" } = {}) {
    const wikiRootChanged = settings.wikiPath !== agentPromptStore.wikiRootPath;
    agentPromptStore.setWikiRootPath(settings.wikiPath);
    sessionManager.setWikiRootPath(settings.wikiPath);
    if (wikiRootChanged) {
      await agentPromptStore.refreshBuiltInSections();
    } else {
      await agentPromptStore.save(agentPromptStore.prompt);
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
    agentMailService.restart(settingsStore.settings);
    if (backupReason) {
      void wikiBackupService.runBackup({ reason: backupReason });
    }
  }

  async function ensureBrainCloneTargetAvailable(targetPath) {
    await mkdir(path.dirname(targetPath), { recursive: true });

    try {
      const stats = await stat(targetPath);
      if (!stats.isDirectory()) {
        throw buildHttpError(`Brain path is not a directory: ${targetPath}`, 400);
      }

      const entries = await readdir(targetPath);
      const meaningfulEntries = entries.filter((entry) => entry !== ".DS_Store");
      if (meaningfulEntries.length > 0) {
        throw buildHttpError("Brain clone folder must be empty.", 409);
      }

      return { existed: true };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { existed: false };
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

  async function collectAndRecordSystemMetrics({ forceHistory = false } = {}) {
    const system = await systemMetricsProvider({
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
        console.error("[remote-vibes] system metrics history sample failed:", error);
      })
      .finally(() => {
        systemMetricsSamplePromise = null;
      });

    return systemMetricsSamplePromise;
  }

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use((request, response, next) => {
    if (request.path.startsWith("/api/") && request.get("X-Remote-Vibes-API") === "1") {
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

  app.get("/api/state", async (_request, response) => {
    response.json({
      appName: "Remote Vibes",
      agentPrompt: await agentPromptStore.getState(),
      cwd,
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
        response.status(400).json({ error: "No Tailscale address is available for this Remote Vibes instance." });
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

  app.get("/api/settings", (_request, response) => {
    response.json({
      settings: getSettingsState(),
    });
  });

  app.patch("/api/settings", async (request, response) => {
    try {
      const settings = await settingsStore.update({
        agentAutomations: request.body?.agentAutomations,
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
        browserUseAnthropicApiKey: request.body?.browserUseAnthropicApiKey,
        browserUseBrowserPath: request.body?.browserUseBrowserPath,
        browserUseEnabled: request.body?.browserUseEnabled,
        browserUseHeadless: request.body?.browserUseHeadless,
        browserUseKeepTabs: request.body?.browserUseKeepTabs,
        browserUseModel: request.body?.browserUseModel,
        browserUseProfileDir: request.body?.browserUseProfileDir,
        browserUseWorkerPath: request.body?.browserUseWorkerPath,
        installedPluginIds: request.body?.installedPluginIds,
        wikiGitBackupEnabled: request.body?.wikiGitBackupEnabled,
        wikiGitRemoteBranch: request.body?.wikiGitRemoteBranch,
        wikiGitRemoteEnabled: request.body?.wikiGitRemoteEnabled,
        wikiGitRemoteName: request.body?.wikiGitRemoteName,
        wikiGitRemoteUrl: request.body?.wikiGitRemoteUrl,
        wikiPath: request.body?.wikiPath,
        wikiPathConfigured: request.body?.wikiPathConfigured,
      });

      await applyRuntimeSettings(settings, { backupReason: "settings" });

      response.json({
        settings: getSettingsState(),
        agentPrompt: await agentPromptStore.getState(),
      });
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.post("/api/wiki/clone", async (request, response) => {
    let targetPath = "";
    let targetExisted = true;

    try {
      const remoteUrl = normalizeGitCloneRemoteUrl(request.body?.remoteUrl);
      const defaultFolder = path.join(path.dirname(stateDir), getGitRepoFolderName(remoteUrl));
      targetPath = settingsStore.normalizeWikiPath(request.body?.wikiPath || defaultFolder);
      const availability = await ensureBrainCloneTargetAvailable(targetPath);
      targetExisted = availability.existed;

      try {
        await execFileAsync("git", ["clone", remoteUrl, targetPath], {
          timeout: 120_000,
        });
      } catch (error) {
        if (!targetExisted && targetPath) {
          await rm(targetPath, { recursive: true, force: true }).catch(() => {});
        }

        const stderr = String(error?.stderr || error?.message || "").trim();
        throw buildHttpError(stderr || "Could not clone the brain git repo.", 400);
      }

      const wikiPath = await realpath(targetPath);
      const branch = await readBrainCloneBranch(wikiPath);
      const settings = await settingsStore.update({
        wikiGitBackupEnabled: true,
        wikiGitRemoteBranch: branch,
        wikiGitRemoteEnabled: true,
        wikiGitRemoteName: "origin",
        wikiGitRemoteUrl: remoteUrl,
        wikiPath,
      });

      await applyRuntimeSettings(settings, { backupReason: "clone" });

      response.json({
        settings: getSettingsState(),
        agentPrompt: await agentPromptStore.getState(),
        clone: {
          branch,
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
        `remote-vibes-${randomUUID()}`;
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

      const settings = await settingsStore.update({
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
      const token = String(request.headers["x-remote-vibes-agentmail-token"] || request.body?.token || "").trim();
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

  app.get("/api/browser-use/status", (_request, response) => {
    response.json({ browserUse: browserUseService.getStatus() });
  });

  app.post("/api/browser-use/setup", async (request, response) => {
    try {
      const apiKey = String(request.body?.anthropicApiKey || request.body?.browserUseAnthropicApiKey || "").trim();
      const settings = await settingsStore.update({
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
      await applyRuntimeSettings(settings, { backupReason: false });

      response.json({
        browserUse: browserUseService.getStatus(),
        settings: getSettingsState(),
      });
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not set up browser-use plugin." });
    }
  });

  app.get("/api/browser-use/sessions", (_request, response) => {
    response.json({ sessions: browserUseService.listSessions() });
  });

  app.post("/api/browser-use/sessions", async (request, response) => {
    try {
      const token = String(request.headers["x-remote-vibes-browser-use-token"] || request.body?.token || "").trim();
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
      });

      response.status(201).json({ session });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/sessions", (_request, response) => {
    response.json({ sessions: sessionManager.listSessions() });
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
      response.json(await agentPromptStore.save(request.body?.prompt));
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/agent-prompt/reload", async (_request, response) => {
    try {
      response.json(await agentPromptStore.reload());
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
  const helperBaseUrl = getHelperBaseUrl(host, resolvedPort);
  browserUseService.setServerBaseUrl(helperBaseUrl);
  await writeServerInfo(stateDir, {
    agentMailReplyToken: agentMailService.replyToken,
    browserUseToken: browserUseService.requestToken,
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
      appName: "Remote Vibes",
      agentPrompt: await agentPromptStore.getState(),
      cwd,
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
    relaunch: () => requestTerminate({ relaunch: true }),
    terminate: requestTerminate,
  };
}
