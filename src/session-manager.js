import os from "node:os";
import { statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pty from "node-pty";
import { SessionStore } from "./session-store.js";

const MAX_BUFFER_LENGTH = 200_000;
const STARTUP_DELAY_MS = 180;
const SESSION_META_THROTTLE_MS = 180;
const SESSION_PERSIST_THROTTLE_MS = 180;

function getShellArgs(shellPath) {
  const shellName = path.basename(shellPath);

  if (shellName === "fish") {
    return ["-i", "-l"];
  }

  return ["-i", "-l"];
}

function trimBuffer(buffer) {
  if (buffer.length <= MAX_BUFFER_LENGTH) {
    return buffer;
  }

  return buffer.slice(buffer.length - MAX_BUFFER_LENGTH);
}

function buildSessionEnv(sessionId, providerId) {
  return {
    ...process.env,
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    REMOTE_VIBES_PROVIDER: providerId,
    REMOTE_VIBES_SESSION_ID: sessionId,
    TERM: "xterm-256color",
  };
}

export function resolveCwd(inputCwd, fallbackCwd) {
  const nextCwd = path.resolve(inputCwd || fallbackCwd);
  const stats = statSync(nextCwd, { throwIfNoEntry: false });

  if (!stats || !stats.isDirectory()) {
    throw new Error(`Working directory does not exist: ${nextCwd}`);
  }

  return nextCwd;
}

function buildPersistedExitMessage(message) {
  return `\r\n\u001b[1;31m[remote-vibes]\u001b[0m ${message}\r\n`;
}

export class SessionManager {
  constructor({
    cwd,
    providers,
    persistSessions = true,
    stateDir = path.join(cwd, ".remote-vibes"),
  }) {
    this.cwd = cwd;
    this.providers = providers;
    this.persistSessions = persistSessions;
    this.sessionStore = new SessionStore({
      enabled: persistSessions,
      stateDir,
    });
    this.sessions = new Map();
    this.persistTimer = null;
    this.persistPromise = Promise.resolve();
    this.isShuttingDown = false;
  }

  async initialize() {
    const persistedSessions = await this.sessionStore.load();

    for (const snapshot of persistedSessions) {
      this.restoreSession(snapshot);
    }

    await this.flushPersistedSessions();
  }

  listSessions() {
    return Array.from(this.sessions.values())
      .map((session) => this.serializeSession(session))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }

  createSession({ providerId, name, cwd }) {
    const provider = this.getProvider(providerId);

    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    if (!provider.available) {
      throw new Error(`${provider.label} is not installed on this host.`);
    }

    const createdAt = new Date().toISOString();
    const session = this.buildSessionRecord({
      cwd: resolveCwd(cwd, this.cwd),
      name: name?.trim() || this.makeDefaultName(provider),
      providerId: provider.id,
      providerLabel: provider.label,
      createdAt,
      updatedAt: createdAt,
      restoreOnStartup: true,
    });

    this.sessions.set(session.id, session);

    try {
      this.startSession(session, provider);
    } catch (error) {
      this.sessions.delete(session.id);
      this.schedulePersist({ immediate: true });
      throw error;
    }

    this.schedulePersist({ immediate: true });
    return this.serializeSession(session);
  }

  deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return false;
    }

    for (const client of session.clients) {
      client.send(JSON.stringify({ type: "session-deleted", sessionId }));
      client.close();
    }

    session.skipExitHandling = true;
    session.restoreOnStartup = false;
    this.clearPendingMetaBroadcast(session);
    session.clients.clear();

    if (session.status !== "exited" && session.pty) {
      session.pty.kill();
    }

    this.sessions.delete(sessionId);
    this.schedulePersist({ immediate: true });
    return true;
  }

  attachClient(sessionId, socket) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      socket.send(JSON.stringify({ type: "error", message: "Session not found." }));
      socket.close();
      return null;
    }

    session.clients.add(socket);
    socket.send(
      JSON.stringify({
        type: "snapshot",
        session: this.serializeSession(session),
        data: session.buffer,
      }),
    );

    socket.on("close", () => {
      session.clients.delete(socket);
    });

    return session;
  }

  write(sessionId, input) {
    const session = this.sessions.get(sessionId);

    if (!session || session.status === "exited" || !session.pty) {
      return false;
    }

    session.pty.write(input);
    session.updatedAt = new Date().toISOString();
    this.schedulePersist();
    return true;
  }

  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);

    if (!session || session.status === "exited" || !session.pty) {
      return false;
    }

    session.cols = Math.max(20, cols);
    session.rows = Math.max(5, rows);
    session.pty.resize(session.cols, session.rows);
    session.updatedAt = new Date().toISOString();
    this.schedulePersist();
    return true;
  }

  closeAll() {
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.deleteSession(sessionId);
    }
  }

  async shutdown({ preserveSessions = this.persistSessions } = {}) {
    this.isShuttingDown = true;

    for (const session of this.sessions.values()) {
      this.clearPendingMetaBroadcast(session);

      for (const client of session.clients) {
        client.close();
      }

      session.clients.clear();

      if (preserveSessions) {
        session.restoreOnStartup = session.status !== "exited";
        session.skipExitHandling = true;
      }
    }

    if (preserveSessions) {
      await this.flushPersistedSessions();

      for (const session of this.sessions.values()) {
        if (session.status !== "exited" && session.pty) {
          session.pty.kill();
        }

        session.pty = null;
      }

      return;
    }

    this.closeAll();
    await this.flushPersistedSessions();
  }

  makeDefaultName(provider) {
    const existingCount = Array.from(this.sessions.values()).filter(
      (session) => session.providerId === provider.id,
    ).length;

    return `${provider.defaultName} ${existingCount + 1}`;
  }

  pushOutput(session, chunk) {
    session.buffer = trimBuffer(`${session.buffer}${chunk}`);

    for (const client of session.clients) {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({ type: "output", data: chunk }));
      }
    }

    this.schedulePersist();
  }

  clearPendingMetaBroadcast(session) {
    if (!session.metaBroadcastTimer) {
      return;
    }

    clearTimeout(session.metaBroadcastTimer);
    session.metaBroadcastTimer = null;
  }

  scheduleSessionMetaBroadcast(session, { immediate = false } = {}) {
    if (immediate) {
      this.clearPendingMetaBroadcast(session);
      this.broadcastSessionMeta(session);
      return;
    }

    if (session.metaBroadcastTimer) {
      return;
    }

    session.metaBroadcastTimer = setTimeout(() => {
      session.metaBroadcastTimer = null;
      this.broadcastSessionMeta(session);
    }, SESSION_META_THROTTLE_MS);
  }

  broadcastSessionMeta(session) {
    const payload = JSON.stringify({
      type: "session",
      session: this.serializeSession(session),
    });

    for (const client of session.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }

  serializeSession(session) {
    return {
      id: session.id,
      providerId: session.providerId,
      providerLabel: session.providerLabel,
      name: session.name,
      cwd: session.cwd,
      shell: session.shell,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastOutputAt: session.lastOutputAt,
      status: session.status,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      cols: session.cols,
      rows: session.rows,
      host: os.hostname(),
    };
  }

  buildSessionRecord({
    id = randomUUID(),
    providerId,
    providerLabel,
    name,
    shell = process.env.SHELL || "/bin/zsh",
    cwd,
    createdAt = new Date().toISOString(),
    updatedAt = createdAt,
    lastOutputAt = null,
    status = "starting",
    exitCode = null,
    exitSignal = null,
    cols = 120,
    rows = 34,
    buffer = "",
    restoreOnStartup = false,
  }) {
    return {
      id,
      providerId,
      providerLabel,
      name,
      shell,
      cwd,
      createdAt,
      updatedAt,
      lastOutputAt,
      status,
      exitCode,
      exitSignal,
      cols,
      rows,
      pty: null,
      buffer: trimBuffer(buffer || ""),
      clients: new Set(),
      metaBroadcastTimer: null,
      restoreOnStartup,
      skipExitHandling: false,
    };
  }

  startSession(session, provider, { restored = false } = {}) {
    const sessionCwd = resolveCwd(session.cwd, this.cwd);
    session.cwd = sessionCwd;

    const ptyProcess = pty.spawn(session.shell, getShellArgs(session.shell), {
      cwd: sessionCwd,
      env: buildSessionEnv(session.id, provider.id),
      name: "xterm-256color",
      cols: session.cols,
      rows: session.rows,
    });

    session.pty = ptyProcess;
    session.status = "running";
    session.exitCode = null;
    session.exitSignal = null;
    session.restoreOnStartup = true;
    session.updatedAt = new Date().toISOString();

    const bannerLines = restored
      ? [
          "",
          `\u001b[1;36m[remote-vibes]\u001b[0m session restored after restart`,
          `\u001b[1;36m[remote-vibes]\u001b[0m cwd: ${sessionCwd}`,
          provider.launchCommand
            ? `\u001b[1;36m[remote-vibes]\u001b[0m relaunching: ${provider.launchCommand}`
            : `\u001b[1;36m[remote-vibes]\u001b[0m vanilla shell restored`,
          "",
        ]
      : [
          `\u001b[1;36m[remote-vibes]\u001b[0m ${provider.label} session ready`,
          `\u001b[1;36m[remote-vibes]\u001b[0m cwd: ${sessionCwd}`,
          provider.launchCommand
            ? `\u001b[1;36m[remote-vibes]\u001b[0m launching: ${provider.launchCommand}`
            : `\u001b[1;36m[remote-vibes]\u001b[0m vanilla shell active`,
          "",
        ];

    this.pushOutput(session, bannerLines.join("\r\n"));

    ptyProcess.onData((chunk) => {
      session.updatedAt = new Date().toISOString();
      session.lastOutputAt = session.updatedAt;
      this.pushOutput(session, chunk);
      this.scheduleSessionMetaBroadcast(session);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.pty = null;

      if (session.skipExitHandling) {
        return;
      }

      session.status = "exited";
      session.exitCode = exitCode;
      session.exitSignal = signal ?? null;
      session.restoreOnStartup = false;
      session.updatedAt = new Date().toISOString();

      this.pushOutput(
        session,
        `\r\n\u001b[1;31m[remote-vibes]\u001b[0m session exited (code ${exitCode}${signal ? `, signal ${signal}` : ""})\r\n`,
      );
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
      this.schedulePersist({ immediate: true });
    });

    if (provider.launchCommand) {
      setTimeout(() => {
        if (session.status === "running" && session.pty === ptyProcess) {
          ptyProcess.write(`${provider.launchCommand}\r`);
        }
      }, STARTUP_DELAY_MS);
    }
  }

  restoreSession(snapshot) {
    const session = this.buildSessionRecord({
      id: snapshot.id || randomUUID(),
      providerId: snapshot.providerId,
      providerLabel: snapshot.providerLabel || snapshot.providerId || "Unknown Provider",
      name: snapshot.name?.trim() || snapshot.providerLabel || "Restored Session",
      shell: snapshot.shell || process.env.SHELL || "/bin/zsh",
      cwd: snapshot.cwd || this.cwd,
      createdAt: snapshot.createdAt || new Date().toISOString(),
      updatedAt: snapshot.updatedAt || snapshot.createdAt || new Date().toISOString(),
      lastOutputAt: snapshot.lastOutputAt || null,
      status: snapshot.status || "exited",
      exitCode: snapshot.exitCode ?? null,
      exitSignal: snapshot.exitSignal ?? null,
      cols: Number(snapshot.cols) > 0 ? Number(snapshot.cols) : 120,
      rows: Number(snapshot.rows) > 0 ? Number(snapshot.rows) : 34,
      buffer: snapshot.buffer || "",
      restoreOnStartup: Boolean(snapshot.restoreOnStartup),
    });

    this.sessions.set(session.id, session);

    if (!session.restoreOnStartup) {
      return;
    }

    const provider = this.getProvider(session.providerId);
    if (!provider) {
      this.markSessionRestoreFailure(
        session,
        `${session.providerLabel} is no longer configured on this host.`,
      );
      return;
    }

    if (!provider.available) {
      this.markSessionRestoreFailure(
        session,
        `${provider.label} is not available on this host, so this session could not be relaunched.`,
      );
      return;
    }

    try {
      this.startSession(session, provider, { restored: true });
    } catch (error) {
      this.markSessionRestoreFailure(
        session,
        `could not restore the session: ${error.message}`,
      );
    }
  }

  markSessionRestoreFailure(session, message) {
    session.status = "exited";
    session.exitCode = null;
    session.exitSignal = null;
    session.restoreOnStartup = false;
    session.updatedAt = new Date().toISOString();
    session.pty = null;
    this.pushOutput(session, buildPersistedExitMessage(message));
  }

  getProvider(providerId) {
    return this.providers.find((entry) => entry.id === providerId) ?? null;
  }

  serializePersistedSession(session) {
    return {
      ...this.serializeSession(session),
      buffer: session.buffer,
      restoreOnStartup: session.restoreOnStartup,
    };
  }

  schedulePersist({ immediate = false } = {}) {
    if (!this.persistSessions) {
      return;
    }

    if (immediate) {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }

      void this.persistNow();
      return;
    }

    if (this.persistTimer) {
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, SESSION_PERSIST_THROTTLE_MS);
  }

  async persistNow() {
    if (!this.persistSessions) {
      return;
    }

    const sessions = Array.from(this.sessions.values())
      .map((session) => this.serializePersistedSession(session))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    this.persistPromise = this.persistPromise
      .catch(() => {})
      .then(() => this.sessionStore.save(sessions))
      .catch((error) => {
        console.warn("[remote-vibes] failed to persist sessions", error);
      });

    await this.persistPromise;
  }

  async flushPersistedSessions() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    await this.persistNow();
  }
}
