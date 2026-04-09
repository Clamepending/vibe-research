import { execFile } from "node:child_process";
import httpProxy from "http-proxy";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
import { WebSocketServer } from "ws";
import { pickPreferredUrl } from "./access-url.js";
import { listListeningPorts } from "./ports.js";
import { SessionManager } from "./session-manager.js";
import { detectProviders, getDefaultProviderId } from "./providers.js";
import { listWorkspaceEntries, resolveWorkspaceEntry } from "./workspace-files.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const execFileAsync = promisify(execFile);

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

export async function createRemoteVibesApp({
  host = process.env.REMOTE_VIBES_HOST || "0.0.0.0",
  port = Number(process.env.REMOTE_VIBES_PORT || 4123),
  cwd = process.cwd(),
  persistSessions = true,
  onTerminate = null,
} = {}) {
  const providers = await detectProviders();
  const defaultProviderId = getDefaultProviderId(providers);
  const app = express();
  const sessionManager = new SessionManager({ cwd, providers, persistSessions });
  await sessionManager.initialize();
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

  app.use(express.json());

  app.use((request, response, next) => {
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
      cwd,
      defaultProviderId,
      providers,
      sessions: sessionManager.listSessions(),
      urls,
      preferredUrl,
      ports: await listListeningPorts({ excludePorts: exposedPort ? [exposedPort] : [] }),
    });
  });

  app.get("/api/ports", async (_request, response) => {
    response.json({
      ports: await listListeningPorts({ excludePorts: exposedPort ? [exposedPort] : [] }),
    });
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
      response.sendFile(entry.targetPath);
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

  app.delete("/api/sessions/:sessionId", (request, response) => {
    const deleted = sessionManager.deleteSession(request.params.sessionId);

    if (!deleted) {
      response.status(404).json({ error: "Session not found." });
      return;
    }

    response.json({ ok: true });
  });

  app.post("/api/terminate", (_request, response) => {
    response.once("finish", () => {
      void requestTerminate();
    });
    response.json({ ok: true, shuttingDown: true });
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
  urls = await getAccessUrls(host, resolvedPort);
  preferredUrl = pickPreferredUrl(urls)?.url ?? urls[0]?.url ?? null;

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
      proxyServer.close();
      await new Promise((resolve) => websocketServer.close(resolve));
      await new Promise((resolve, reject) =>
        server.close((error) => {
          if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }

          resolve();
        }),
      );
    })();

    return closePromise;
  }

  async function requestTerminate() {
    if (terminatePromise) {
      return terminatePromise;
    }

    terminatePromise = (async () => {
      await close();
      if (typeof onTerminate === "function") {
        await onTerminate();
      }
    })();

    return terminatePromise;
  }

  return {
    app,
    close,
    config: {
      appName: "Remote Vibes",
      cwd,
      defaultProviderId,
      host,
      port: resolvedPort,
      providers,
      preferredUrl,
      urls,
    },
    server,
    sessionManager,
    terminate: requestTerminate,
  };
}
