import { execFile } from "node:child_process";
import httpProxy from "http-proxy";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
import { WebSocketServer } from "ws";
import { buildPortUrlFromBase, getTailscaleUrl, pickPreferredUrl } from "./access-url.js";
import { AgentPromptStore } from "./agent-prompt-store.js";
import { AgentRunStore } from "./agent-run-store.js";
import { createFolderEntry, listFolderEntries } from "./folder-browser.js";
import { PortAliasStore } from "./port-alias-store.js";
import { listListeningPorts } from "./ports.js";
import { SettingsStore } from "./settings-store.js";
import { SessionManager } from "./session-manager.js";
import { SleepPreventionService } from "./sleep-prevention.js";
import { getRemoteVibesStateDir } from "./state-paths.js";
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

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
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
      const label =
        name.toLowerCase().includes("tailscale") || address.address.startsWith("100.")
          ? "Tailscale"
          : name;
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

  return urls;
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
  tailscaleServeManager = new TailscaleServeManager(),
  sleepPreventionFactory = (settings) =>
    new SleepPreventionService({
      enabled: settings.preventSleepEnabled,
    }),
  onTerminate = null,
  updateManager = new UpdateManager({ cwd, stateDir, port }),
} = {}) {
  const providers = Array.isArray(providerOverrides) ? providerOverrides : await detectProviders();
  const defaultProviderId = getDefaultProviderId(providers);
  const app = express();
  const agentRunStore = new AgentRunStore({ stateDir });
  const settingsStore = new SettingsStore({ cwd, stateDir });
  const portAliasStore = new PortAliasStore({ stateDir });
  await settingsStore.initialize();
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
    stateDir,
    agentRunStore,
    wikiRootPath: settingsStore.settings.wikiPath,
  });
  const agentPromptStore = new AgentPromptStore({
    cwd,
    stateDir,
    wikiRootPath: settingsStore.settings.wikiPath,
  });
  await agentRunStore.initialize();
  await portAliasStore.initialize();
  await sessionManager.initialize();
  await agentPromptStore.initialize();
  wikiBackupService.start();
  if (settingsStore.settings.wikiGitRemoteEnabled && settingsStore.settings.wikiGitRemoteUrl) {
    void wikiBackupService.runBackup({ reason: "startup" });
  }
  sleepPreventionService.start();
  let exposedPort = null;
  let closePromise = null;
  let terminatePromise = null;
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
      backupStatus: wikiBackupService.getStatus(),
      sleepStatus: sleepPreventionService.getStatus(),
    });
  }

  app.use(express.json());

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
        preventSleepEnabled: request.body?.preventSleepEnabled,
        wikiGitBackupEnabled: request.body?.wikiGitBackupEnabled,
        wikiGitRemoteBranch: request.body?.wikiGitRemoteBranch,
        wikiGitRemoteEnabled: request.body?.wikiGitRemoteEnabled,
        wikiGitRemoteName: request.body?.wikiGitRemoteName,
        wikiGitRemoteUrl: request.body?.wikiGitRemoteUrl,
        wikiPath: request.body?.wikiPath,
      });

      agentPromptStore.setWikiRootPath(settings.wikiPath);
      sessionManager.setWikiRootPath(settings.wikiPath);
      await agentPromptStore.save(agentPromptStore.prompt);
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
      void wikiBackupService.runBackup({ reason: "settings" });

      response.json({
        settings: getSettingsState(),
        agentPrompt: await agentPromptStore.getState(),
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

  app.use(express.static(publicDir));

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
  await writeServerInfo(stateDir, {
    pid: process.pid,
    host,
    port: resolvedPort,
    helperBaseUrl: getHelperBaseUrl(host, resolvedPort),
    preferredUrl,
  });
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
      await removeServerInfo(stateDir);
      wikiBackupService.stop();
      sleepPreventionService.stop();
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
