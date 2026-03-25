import cookie from "cookie";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
import { WebSocketServer } from "ws";
import { SessionManager } from "./session-manager.js";
import { detectProviders, getDefaultProviderId } from "./providers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const execFileAsync = promisify(execFile);

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
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
  passcode = process.env.REMOTE_VIBES_PASSCODE || crypto.randomBytes(3).toString("hex"),
} = {}) {
  const providers = await detectProviders();
  const defaultProviderId = getDefaultProviderId(providers);
  const authCookieName = "remote_vibes_auth";
  const authCookieValue = crypto.randomUUID();
  const app = express();
  const sessionManager = new SessionManager({ cwd, providers });

  app.use(express.json());

  function isAuthenticated(request) {
    const parsed = cookie.parse(request.headers.cookie || "");
    return parsed[authCookieName] === authCookieValue;
  }

  function requireAuth(request, response, next) {
    if (!isAuthenticated(request)) {
      response.status(401).json({ error: "Authentication required." });
      return;
    }

    next();
  }

  app.get("/api/public-config", (_request, response) => {
    response.json({
      appName: "Remote Vibes",
      passcodeHint: passcode.slice(0, 2),
    });
  });

  app.post("/api/login", (request, response) => {
    const submitted = String(request.body?.passcode || "");

    if (!safeEqual(submitted, passcode)) {
      response.status(401).json({ error: "Wrong passcode." });
      return;
    }

    response.setHeader(
      "Set-Cookie",
      cookie.serialize(authCookieName, authCookieValue, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      }),
    );

    response.json({ ok: true });
  });

  app.post("/api/logout", requireAuth, (_request, response) => {
    response.setHeader(
      "Set-Cookie",
      cookie.serialize(authCookieName, "", {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      }),
    );
    response.json({ ok: true });
  });

  app.get("/api/state", requireAuth, (_request, response) => {
    response.json({
      appName: "Remote Vibes",
      cwd,
      defaultProviderId,
      providers,
      sessions: sessionManager.listSessions(),
    });
  });

  app.post("/api/sessions", requireAuth, (request, response) => {
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

  app.get("/api/sessions", requireAuth, (_request, response) => {
    response.json({ sessions: sessionManager.listSessions() });
  });

  app.delete("/api/sessions/:sessionId", requireAuth, (request, response) => {
    const deleted = sessionManager.deleteSession(request.params.sessionId);

    if (!deleted) {
      response.status(404).json({ error: "Session not found." });
      return;
    }

    response.json({ ok: true });
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
  const urls = await getAccessUrls(host, resolvedPort);

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (url.pathname !== "/ws" || !isAuthenticated(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
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
    sessionManager.closeAll();
    await new Promise((resolve) => websocketServer.close(resolve));
    await new Promise((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      }),
    );
  }

  return {
    app,
    close,
    config: {
      appName: "Remote Vibes",
      authCookieName,
      cwd,
      defaultProviderId,
      host,
      passcode,
      port: resolvedPort,
      providers,
      urls,
    },
    server,
    sessionManager,
  };
}
