import { execFile } from "node:child_process";
import os from "node:os";
import { closeSync, openSync, readSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import pty from "node-pty";
import { AgentRunTracker } from "./agent-run-tracker.js";
import { SessionStore } from "./session-store.js";

const MAX_BUFFER_LENGTH = 200_000;
const STARTUP_DELAY_MS = 180;
const SESSION_META_THROTTLE_MS = 180;
const SESSION_PERSIST_THROTTLE_MS = 180;
const SESSION_NAME_MAX_LENGTH = 64;
const PROVIDER_SESSION_CAPTURE_ATTEMPTS = 16;
const PROVIDER_SESSION_CAPTURE_INTERVAL_MS = 250;
const PROVIDER_SESSION_LOOKBACK_MS = 4_000;
const OPENCODE_SESSION_LIST_LIMIT = 50;
const CODEX_SESSION_SCAN_LIMIT = 80;
const CODEX_SESSION_HEADER_READ_BYTES = 24_576;
const execFileAsync = promisify(execFile);

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

function prependPath(pathEntries) {
  return pathEntries.filter(Boolean).join(path.delimiter);
}

function normalizeSessionName(value) {
  const trimmed = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!trimmed) {
    return "";
  }

  if (trimmed.length <= SESSION_NAME_MAX_LENGTH) {
    return trimmed;
  }

  return trimmed.slice(0, SESSION_NAME_MAX_LENGTH).trim();
}

export function buildSessionEnv(sessionId, providerId, workspaceRoot, baseEnv = process.env) {
  const stateDir = path.join(workspaceRoot, ".remote-vibes");
  const agentDir = path.join(stateDir, "wiki", "comms", "agents", sessionId);
  const env = baseEnv && typeof baseEnv === "object" ? baseEnv : process.env;

  return {
    ...env,
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: prependPath([path.join(workspaceRoot, "bin"), env.PATH]),
    REMOTE_VIBES_PROVIDER: providerId,
    REMOTE_VIBES_ROOT: stateDir,
    REMOTE_VIBES_SESSION_ID: sessionId,
    REMOTE_VIBES_WIKI_DIR: path.join(stateDir, "wiki"),
    REMOTE_VIBES_COMMS_DIR: path.join(stateDir, "wiki", "comms"),
    REMOTE_VIBES_AGENT_DIR: agentDir,
    REMOTE_VIBES_AGENT_INBOX: path.join(agentDir, "inbox"),
    REMOTE_VIBES_AGENT_PROCESSED_DIR: path.join(agentDir, "processed"),
    REMOTE_VIBES_MAIL_WATCHER: "rv-mailwatch",
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

function shellQuote(value) {
  const text = String(value ?? "");

  if (!text) {
    return "''";
  }

  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function buildShellCommand(command, args = []) {
  return [command, ...args].map((part) => shellQuote(part)).join(" ");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSessionPath(targetPath) {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    return null;
  }

  return path.resolve(targetPath);
}

function readFileHeader(filePath, maxBytes = CODEX_SESSION_HEADER_READ_BYTES) {
  let fd = null;

  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures for short-lived session scans.
      }
    }
  }
}

function decodeJsonString(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

function getHomeDirectory(env = process.env) {
  return String(env?.HOME || os.homedir() || "").trim() || os.homedir();
}

function sortSessionsByUpdated(sessions) {
  return sessions.sort((left, right) => Number(right?.updated || 0) - Number(left?.updated || 0));
}

function matchSessionsByPath(sessions, cwd, key) {
  const normalizedCwd = normalizeSessionPath(cwd);

  return sortSessionsByUpdated(
    sessions.filter((entry) => normalizeSessionPath(entry?.[key]) === normalizedCwd),
  );
}

function matchOpenCodeSessionsByCwd(sessions, cwd) {
  return matchSessionsByPath(sessions, cwd, "directory");
}

function matchCodexSessionsByCwd(sessions, cwd) {
  return matchSessionsByPath(sessions, cwd, "cwd");
}

function pickTrackedSession(sessions, baselineSessionIds, launchedAt) {
  const freshSession = sessions.find((entry) => !baselineSessionIds.has(entry.id));

  if (freshSession) {
    return freshSession;
  }

  return (
    sessions.find((entry) => Number(entry?.updated || 0) >= launchedAt - PROVIDER_SESSION_LOOKBACK_MS)
    ?? null
  );
}

async function listOpenCodeSessions(command, cwd, env = process.env) {
  if (!command) {
    return [];
  }

  try {
    const { stdout } = await execFileAsync(
      command,
      ["session", "list", "--format", "json", "-n", String(OPENCODE_SESSION_LIST_LIMIT)],
      {
        cwd,
        env,
        maxBuffer: 1024 * 1024,
      },
    );
    const payload = JSON.parse(stdout);

    return Array.isArray(payload) ? payload.filter((entry) => typeof entry?.id === "string") : [];
  } catch {
    return [];
  }
}

function normalizeClaudeProjectDirName(cwd) {
  const normalizedCwd = normalizeSessionPath(cwd);
  return normalizedCwd ? normalizedCwd.replaceAll(path.sep, "-") : null;
}

function listClaudeSessionsForCwd(cwd, env = process.env) {
  const projectDirName = normalizeClaudeProjectDirName(cwd);

  if (!projectDirName) {
    return [];
  }

  const projectDir = path.join(getHomeDirectory(env), ".claude", "projects", projectDirName);

  try {
    const entries = readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => {
        const filePath = path.join(projectDir, entry.name);
        const sessionId = entry.name.slice(0, -".jsonl".length);

        return {
          id: sessionId,
          updated: statSync(filePath).mtimeMs,
        };
      });

    return sortSessionsByUpdated(entries);
  } catch {
    return [];
  }
}

function parseCodexSessionHeader(filePath) {
  const header = readFileHeader(filePath);

  if (!header) {
    return null;
  }

  const idMatch = header.match(/"id":"([^"]+)"/);
  const cwdMatch = header.match(/"cwd":"((?:\\.|[^"])*)"/);
  const timestampMatch = header.match(/"timestamp":"([^"]+)"/);

  if (!idMatch?.[1] || !cwdMatch?.[1]) {
    return null;
  }

  const timestamp = timestampMatch?.[1] ? Date.parse(timestampMatch[1]) : NaN;

  return {
    id: idMatch[1],
    cwd: decodeJsonString(cwdMatch[1]),
    updated: Number.isFinite(timestamp) ? timestamp : statSync(filePath).mtimeMs,
  };
}

function listRecentCodexSessionFiles(rootDir, limit = CODEX_SESSION_SCAN_LIMIT) {
  const files = [];

  try {
    const years = readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const year of years) {
      const yearDir = path.join(rootDir, year);
      const months = readdirSync(yearDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();

      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        const days = readdirSync(monthDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
          .reverse();

        for (const day of days) {
          const dayDir = path.join(monthDir, day);
          const dayFiles = readdirSync(dayDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
            .map((entry) => path.join(dayDir, entry.name))
            .sort()
            .reverse();

          files.push(...dayFiles);
          if (files.length >= limit) {
            return files.slice(0, limit);
          }
        }
      }
    }
  } catch {
    return [];
  }

  return files;
}

function listCodexSessions(env = process.env) {
  const sessionsRoot = path.join(getHomeDirectory(env), ".codex", "sessions");
  const files = listRecentCodexSessionFiles(sessionsRoot);

  return sortSessionsByUpdated(
    files
      .map((filePath) => parseCodexSessionHeader(filePath))
      .filter((entry) => entry?.id && entry?.cwd),
  );
}

export class SessionManager {
  constructor({
    cwd,
    providers,
    persistSessions = true,
    stateDir = path.join(cwd, ".remote-vibes"),
    agentRunStore = null,
    runIdleTimeoutMs = Number(process.env.REMOTE_VIBES_RUN_IDLE_MS || 15_000),
    env = process.env,
  }) {
    this.cwd = cwd;
    this.providers = providers;
    this.persistSessions = persistSessions;
    this.stateDir = stateDir;
    this.env = env && typeof env === "object" ? { ...env } : { ...process.env };
    this.sessionStore = new SessionStore({
      enabled: persistSessions,
      stateDir,
    });
    this.sessions = new Map();
    this.persistTimer = null;
    this.persistPromise = Promise.resolve();
    this.isShuttingDown = false;
    this.agentRunTracker = agentRunStore
      ? new AgentRunTracker({
          store: agentRunStore,
          idleTimeoutMs: runIdleTimeoutMs,
        })
      : null;
  }

  async initialize() {
    const persistedSessions = await this.sessionStore.load();

    for (const snapshot of persistedSessions) {
      this.restoreSession(snapshot);
    }

    await this.flushPersistedSessions();
  }

  listSessions() {
    this.consumePendingRenameRequests();
    return Array.from(this.sessions.values())
      .map((session) => this.serializeSession(session))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getSession(sessionId) {
    this.consumePendingRenameRequests();
    return this.sessions.get(sessionId) ?? null;
  }

  listAgentProcessRoots() {
    return Array.from(this.sessions.values())
      .filter((session) => session.status === "running" && session.pty?.pid)
      .map((session) => ({
        sessionId: session.id,
        providerId: session.providerId,
        pid: Number(session.pty.pid),
      }));
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
      name: normalizeSessionName(name) || this.makeDefaultName(provider),
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

  renameSession(sessionId, name) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return null;
    }

    const nextName = normalizeSessionName(name);
    if (!nextName) {
      throw new Error("Session name cannot be empty.");
    }

    if (session.name === nextName) {
      return this.serializeSession(session);
    }

    session.name = nextName;
    session.updatedAt = new Date().toISOString();
    this.scheduleSessionMetaBroadcast(session, { immediate: true });
    this.schedulePersist({ immediate: true });
    return this.serializeSession(session);
  }

  consumePendingRenameRequests() {
    const requestDir = path.join(this.stateDir, "session-name-requests");
    let entries = [];

    try {
      entries = readdirSync(requestDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const requestPath = path.join(requestDir, entry.name);

      try {
        const payload = JSON.parse(readFileSync(requestPath, "utf8"));
        if (payload?.sessionId && payload?.name) {
          this.renameSession(payload.sessionId, payload.name);
        }
      } catch {
        // Ignore malformed rename requests.
      } finally {
        rmSync(requestPath, { force: true });
      }
    }
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
    this.queueAgentRunTracking(this.agentRunTracker?.handleSessionDelete(session));

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

    this.queueAgentRunTracking(this.agentRunTracker?.handleInput(session, input));
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
      this.agentRunTracker?.reset();

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
    this.agentRunTracker?.reset();
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

  queueAgentRunTracking(task) {
    if (!task || typeof task.catch !== "function") {
      return;
    }

    task.catch((error) => {
      console.warn("[remote-vibes] failed to record agent run", error);
    });
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
    providerState = null,
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
      providerState:
        providerState && typeof providerState === "object" ? { ...providerState } : null,
      skipExitHandling: false,
    };
  }

  updateProviderState(session, nextProviderState) {
    const normalizedState =
      nextProviderState && typeof nextProviderState === "object"
        ? { ...(session.providerState || {}), ...nextProviderState }
        : null;

    const currentStateJson = JSON.stringify(session.providerState || null);
    const nextStateJson = JSON.stringify(normalizedState || null);

    if (currentStateJson === nextStateJson) {
      return;
    }

    session.providerState = normalizedState;
    session.updatedAt = new Date().toISOString();
    this.schedulePersist({ immediate: true });
  }

  async prepareProviderLaunch(session, provider, { restored = false } = {}) {
    if (!provider.launchCommand) {
      return {
        commandString: null,
        afterLaunch: null,
      };
    }

    if (provider.id === "claude") {
      return this.prepareClaudeLaunch(session, provider, { restored });
    }

    if (provider.id === "codex") {
      return this.prepareCodexLaunch(session, provider, { restored });
    }

    if (provider.id !== "opencode") {
      return {
        commandString: buildShellCommand(provider.launchCommand),
        afterLaunch: null,
      };
    }

    const knownSessions = matchOpenCodeSessionsByCwd(
      await listOpenCodeSessions(
        provider.launchCommand,
        session.cwd,
        buildSessionEnv(session.id, provider.id, this.cwd),
      ),
      session.cwd,
    );

    if (restored) {
      const restoreSessionId = session.providerState?.sessionId || knownSessions[0]?.id || null;

      if (restoreSessionId) {
        this.updateProviderState(session, { sessionId: restoreSessionId });
        return {
          commandString: buildShellCommand(provider.launchCommand, ["--session", restoreSessionId]),
          afterLaunch: null,
        };
      }
    }

    const baselineSessionIds = new Set(knownSessions.map((entry) => entry.id));

    return {
      commandString: buildShellCommand(provider.launchCommand),
      afterLaunch: async (ptyProcess, launchedAt) => {
        await this.captureOpenCodeSessionId(session, provider, ptyProcess, baselineSessionIds, launchedAt);
      },
    };
  }

  async launchProvider(session, provider, ptyProcess, launchContextPromise) {
    let launchContext = null;

    try {
      launchContext = await launchContextPromise;
    } catch {
      launchContext = null;
    }

    if (session.status !== "running" || session.pty !== ptyProcess) {
      return;
    }

    const commandString = launchContext?.commandString || buildShellCommand(provider.launchCommand);

    if (!commandString) {
      return;
    }

    const launchedAt = Date.now();
    ptyProcess.write(`${commandString}\r`);

    if (typeof launchContext?.afterLaunch === "function") {
      void launchContext.afterLaunch(ptyProcess, launchedAt);
    }
  }

  async captureOpenCodeSessionId(session, provider, ptyProcess, baselineSessionIds, launchedAt) {
    for (let attempt = 0; attempt < PROVIDER_SESSION_CAPTURE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await delay(PROVIDER_SESSION_CAPTURE_INTERVAL_MS);
      }

      if (session.status !== "running" || session.pty !== ptyProcess) {
        return;
      }

      const matchingSessions = matchOpenCodeSessionsByCwd(
        await listOpenCodeSessions(
          provider.launchCommand,
          session.cwd,
          buildSessionEnv(session.id, provider.id, this.cwd, this.env),
        ),
        session.cwd,
      );
      const candidate = pickTrackedSession(matchingSessions, baselineSessionIds, launchedAt);

      if (!candidate?.id) {
        continue;
      }

      this.updateProviderState(session, { sessionId: candidate.id });
      return;
    }
  }

  async prepareClaudeLaunch(session, provider, { restored = false } = {}) {
    const fallbackSessionId = restored
      ? listClaudeSessionsForCwd(session.cwd, this.env)[0]?.id || null
      : null;
    const sessionId = session.providerState?.sessionId || fallbackSessionId || (!restored ? session.id : null);

    if (sessionId) {
      this.updateProviderState(session, { sessionId });
    }

    if (restored && sessionId) {
      return {
        commandString: buildShellCommand(provider.launchCommand, ["--resume", sessionId]),
        afterLaunch: null,
      };
    }

    if (!restored && sessionId) {
      return {
        commandString: buildShellCommand(provider.launchCommand, ["--session-id", sessionId]),
        afterLaunch: null,
      };
    }

    return {
      commandString: buildShellCommand(provider.launchCommand),
      afterLaunch: null,
    };
  }

  async prepareCodexLaunch(session, provider, { restored = false } = {}) {
    const knownSessions = matchCodexSessionsByCwd(listCodexSessions(this.env), session.cwd);

    if (restored) {
      const restoreSessionId = session.providerState?.sessionId || knownSessions[0]?.id || null;

      if (restoreSessionId) {
        this.updateProviderState(session, { sessionId: restoreSessionId });
        return {
          commandString: buildShellCommand(provider.launchCommand, ["resume", restoreSessionId]),
          afterLaunch: null,
        };
      }
    }

    const baselineSessionIds = new Set(knownSessions.map((entry) => entry.id));

    return {
      commandString: buildShellCommand(provider.launchCommand),
      afterLaunch: async (ptyProcess, launchedAt) => {
        await this.captureCodexSessionId(session, ptyProcess, baselineSessionIds, launchedAt);
      },
    };
  }

  async captureCodexSessionId(session, ptyProcess, baselineSessionIds, launchedAt) {
    for (let attempt = 0; attempt < PROVIDER_SESSION_CAPTURE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await delay(PROVIDER_SESSION_CAPTURE_INTERVAL_MS);
      }

      if (session.status !== "running" || session.pty !== ptyProcess) {
        return;
      }

      const matchingSessions = matchCodexSessionsByCwd(listCodexSessions(this.env), session.cwd);
      const candidate = pickTrackedSession(matchingSessions, baselineSessionIds, launchedAt);

      if (!candidate?.id) {
        continue;
      }

      this.updateProviderState(session, { sessionId: candidate.id });
      return;
    }
  }

  startSession(session, provider, { restored = false } = {}) {
    const sessionCwd = resolveCwd(session.cwd, this.cwd);
    session.cwd = sessionCwd;

    const ptyProcess = pty.spawn(session.shell, getShellArgs(session.shell), {
      cwd: sessionCwd,
      env: buildSessionEnv(session.id, provider.id, this.cwd, this.env),
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
    const launchContextPromise = this.prepareProviderLaunch(session, provider, { restored });

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
      this.agentRunTracker?.handleOutput(session, chunk);
      this.pushOutput(session, chunk);
      this.scheduleSessionMetaBroadcast(session);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.pty = null;

      if (session.skipExitHandling) {
        this.agentRunTracker?.forgetSession(session.id);
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
      this.queueAgentRunTracking(this.agentRunTracker?.handleSessionExit(session));
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
      this.schedulePersist({ immediate: true });
    });

    if (provider.launchCommand) {
      setTimeout(() => {
        if (session.status === "running" && session.pty === ptyProcess) {
          void this.launchProvider(session, provider, ptyProcess, launchContextPromise);
        }
      }, STARTUP_DELAY_MS);
    }
  }

  restoreSession(snapshot) {
    const session = this.buildSessionRecord({
      id: snapshot.id || randomUUID(),
      providerId: snapshot.providerId,
      providerLabel: snapshot.providerLabel || snapshot.providerId || "Unknown Provider",
      name: normalizeSessionName(snapshot.name) || snapshot.providerLabel || "Restored Session",
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
      providerState: snapshot.providerState || null,
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
      providerState: session.providerState,
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
