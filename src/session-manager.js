import os from "node:os";
import { statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pty from "node-pty";

const MAX_BUFFER_LENGTH = 200_000;
const STARTUP_DELAY_MS = 180;
const SESSION_META_THROTTLE_MS = 180;

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
  const env = {
    ...process.env,
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    REMOTE_VIBES_PROVIDER: providerId,
    REMOTE_VIBES_SESSION_ID: sessionId,
    TERM: "xterm-256color",
  };

  return env;
}

function resolveCwd(inputCwd, fallbackCwd) {
  const nextCwd = path.resolve(inputCwd || fallbackCwd);
  const stats = statSync(nextCwd, { throwIfNoEntry: false });

  if (!stats || !stats.isDirectory()) {
    throw new Error(`Working directory does not exist: ${nextCwd}`);
  }

  return nextCwd;
}

export class SessionManager {
  constructor({ cwd, providers }) {
    this.cwd = cwd;
    this.providers = providers;
    this.sessions = new Map();
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
    const provider = this.providers.find((entry) => entry.id === providerId);

    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    if (!provider.available) {
      throw new Error(`${provider.label} is not installed on this host.`);
    }

    const shell = process.env.SHELL || "/bin/zsh";
    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();
    const sessionCwd = resolveCwd(cwd, this.cwd);
    const session = {
      id: sessionId,
      providerId: provider.id,
      providerLabel: provider.label,
      name: name?.trim() || this.makeDefaultName(provider),
      shell,
      cwd: sessionCwd,
      createdAt,
      updatedAt: createdAt,
      lastOutputAt: null,
      status: "starting",
      exitCode: null,
      exitSignal: null,
      cols: 120,
      rows: 34,
      pty: null,
      buffer: "",
      clients: new Set(),
      metaBroadcastTimer: null,
    };

    const ptyProcess = pty.spawn(shell, getShellArgs(shell), {
      cwd: sessionCwd,
      env: buildSessionEnv(sessionId, provider.id),
      name: "xterm-256color",
      cols: session.cols,
      rows: session.rows,
    });

    session.pty = ptyProcess;
    session.status = "running";
    this.sessions.set(sessionId, session);

    this.pushOutput(
      session,
      [
        `\u001b[1;36m[remote-vibes]\u001b[0m ${provider.label} session ready`,
        `\u001b[1;36m[remote-vibes]\u001b[0m cwd: ${sessionCwd}`,
        provider.launchCommand
          ? `\u001b[1;36m[remote-vibes]\u001b[0m launching: ${provider.launchCommand}`
          : `\u001b[1;36m[remote-vibes]\u001b[0m vanilla shell active`,
        "",
      ].join("\r\n"),
    );

    ptyProcess.onData((chunk) => {
      session.updatedAt = new Date().toISOString();
      session.lastOutputAt = session.updatedAt;
      this.pushOutput(session, chunk);
      this.scheduleSessionMetaBroadcast(session);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.status = "exited";
      session.exitCode = exitCode;
      session.exitSignal = signal ?? null;
      session.updatedAt = new Date().toISOString();

      this.pushOutput(
        session,
        `\r\n\u001b[1;31m[remote-vibes]\u001b[0m session exited (code ${exitCode}${signal ? `, signal ${signal}` : ""})\r\n`,
      );
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
    });

    if (provider.launchCommand) {
      setTimeout(() => {
        if (session.status === "running") {
          ptyProcess.write(`${provider.launchCommand}\r`);
        }
      }, STARTUP_DELAY_MS);
    }

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

    this.clearPendingMetaBroadcast(session);
    session.clients.clear();

    if (session.status !== "exited") {
      session.pty.kill();
    }

    this.sessions.delete(sessionId);
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

    if (!session || session.status === "exited") {
      return false;
    }

    session.pty.write(input);
    session.updatedAt = new Date().toISOString();
    return true;
  }

  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);

    if (!session || session.status === "exited") {
      return false;
    }

    session.cols = Math.max(20, cols);
    session.rows = Math.max(5, rows);
    session.pty.resize(session.cols, session.rows);
    session.updatedAt = new Date().toISOString();
    return true;
  }

  closeAll() {
    for (const sessionId of this.sessions.keys()) {
      this.deleteSession(sessionId);
    }
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
}
