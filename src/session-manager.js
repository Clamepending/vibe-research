import { execFile } from "node:child_process";
import os from "node:os";
import { readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pty from "node-pty";
import { AGENT_PROMPT_FILENAME } from "./agent-prompt-store.js";
import { AgentRunTracker } from "./agent-run-tracker.js";
import { SessionStore } from "./session-store.js";
import { getLegacyWorkspaceStateDir, getRemoteVibesStateDir } from "./state-paths.js";

const MAX_BUFFER_LENGTH = 2_000_000;
const STARTUP_DELAY_MS = 180;
const SESSION_META_THROTTLE_MS = 180;
const SESSION_PERSIST_THROTTLE_MS = 180;
const SESSION_NAME_MAX_LENGTH = 64;
const SESSION_AUTO_NAME_MAX_WORDS = 6;
const SESSION_AUTO_NAME_BUFFER_LIMIT = 240;
const SESSION_ACTIVITY_IDLE_MS = Number(process.env.REMOTE_VIBES_SESSION_ACTIVITY_IDLE_MS || 15_000);
const PROVIDER_SESSION_LIST_LIMIT = 50;
const PROVIDER_SESSION_CAPTURE_ATTEMPTS = 16;
const PROVIDER_SESSION_CAPTURE_INTERVAL_MS = 250;
const PROVIDER_SESSION_LOOKBACK_MS = 4_000;
const PROVIDER_SESSION_CAPTURE_RETRY_INTERVAL_MS = 5_000;
const PROVIDER_SESSION_CAPTURE_RETRY_WINDOW_MS = 90_000;
const CODEX_SESSION_INDEX_LIMIT = 100;
const CODEX_SESSION_META_READ_LIMIT = 8192;
const CLAUDE_SUBAGENT_TRANSCRIPT_READ_LIMIT = 1_000_000;
const CLAUDE_SKIP_PERMISSIONS_ARG = "--dangerously-skip-permissions";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRootDir = path.resolve(__dirname, "..");
const helperBinDir = path.join(appRootDir, "bin");
const preferredCliBinDirs = [helperBinDir, "/opt/homebrew/bin", "/usr/local/bin"];
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

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGenericSessionName(name, provider) {
  const normalizedName = normalizeSessionName(name).toLowerCase();
  const defaultName = normalizeSessionName(provider?.defaultName || "").toLowerCase();
  const providerLabel = normalizeSessionName(provider?.label || "").toLowerCase();

  if (!normalizedName) {
    return true;
  }

  if (providerLabel && normalizedName === providerLabel) {
    return true;
  }

  if (!defaultName) {
    return false;
  }

  const defaultPattern = new RegExp(`^${escapeRegex(defaultName)}(?: \\d+)?(?: fork(?: \\d+)?)?$`, "i");
  return defaultPattern.test(normalizedName);
}

function shouldAutoRenameFromPrompt(provider, name, enabled = true) {
  return Boolean(enabled && provider?.id && provider.id !== "shell" && isGenericSessionName(name, provider));
}

function deriveSessionNameFromPromptLine(line) {
  let nextName = String(line ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!nextName) {
    return "";
  }

  nextName = nextName.replace(/^(?:hey|hi|hello)[,!: ]+/i, "");
  nextName = nextName.replace(/^(?:codex|claude|assistant)[,:-]?\s+/i, "");
  nextName = nextName.replace(/^(?:please|pls)\s+/i, "");
  nextName = nextName.replace(/^(?:can|could|would)\s+you\s+/i, "");
  nextName = nextName.replace(/^["'`]+|["'`]+$/g, "");
  nextName = nextName.split(/[.!?](?:\s|$)/, 1)[0]?.trim() || nextName;
  nextName = nextName
    .split(" ")
    .filter(Boolean)
    .slice(0, SESSION_AUTO_NAME_MAX_WORDS)
    .join(" ");
  nextName = nextName.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");

  return normalizeSessionName(nextName);
}

function consumePromptInput(buffer, input) {
  const completedLines = [];
  let nextBuffer = String(buffer ?? "");
  let escapeSequenceLength = 0;
  let interrupted = false;

  for (const character of String(input ?? "").replace(/\r\n/g, "\r")) {
    if (escapeSequenceLength > 0) {
      escapeSequenceLength += 1;
      if ((character >= "@" && character <= "~") || escapeSequenceLength >= 12) {
        escapeSequenceLength = 0;
      }
      continue;
    }

    if (character === "\u001b") {
      escapeSequenceLength = 1;
      continue;
    }

    if (character === "\u0003") {
      interrupted = true;
      nextBuffer = "";
      continue;
    }

    if (character === "\r" || character === "\n") {
      const completedLine = nextBuffer.trim();
      if (completedLine) {
        completedLines.push(completedLine);
      }
      nextBuffer = "";
      continue;
    }

    if (character === "\u0008" || character === "\u007f") {
      nextBuffer = nextBuffer.slice(0, -1);
      continue;
    }

    if (character < " " && character !== "\t") {
      continue;
    }

    nextBuffer += character === "\t" ? " " : character;
    if (nextBuffer.length > SESSION_AUTO_NAME_BUFFER_LIMIT) {
      nextBuffer = nextBuffer.slice(0, SESSION_AUTO_NAME_BUFFER_LIMIT);
    }
  }

  return {
    completedLines,
    buffer: nextBuffer,
    interrupted,
  };
}

function isAgentActivitySession(session) {
  return Boolean(session?.id && session?.providerId && session.providerId !== "shell");
}

function normalizeActivityStatus(value) {
  return value === "working" || value === "done" ? value : "idle";
}

export function prependPathEntries(existingPath, entries) {
  const currentEntries = String(existingPath || "")
    .split(path.delimiter)
    .filter(Boolean);

  const nextEntries = Array.isArray(entries) ? entries : [entries];
  const uniqueEntries = nextEntries.filter(
    (entry, index) => entry && nextEntries.indexOf(entry) === index,
  );

  return [...uniqueEntries, ...currentEntries.filter((candidate) => !uniqueEntries.includes(candidate))].join(
    path.delimiter,
  );
}

function getResolvedProviderCommand(providers, providerId) {
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider?.available) {
    return null;
  }

  return provider.launchCommand || provider.command || null;
}

function getManagedProviderLaunchCommand(provider) {
  if (!provider) {
    return null;
  }

  if (provider.id === "claude" || provider.id === "codex") {
    return path.join(helperBinDir, provider.command || provider.id);
  }

  return provider.launchCommand || provider.command || null;
}

export function buildSessionEnv(
  sessionId,
  providerId,
  providersOrWorkspaceRoot = [],
  workspaceRoot = appRootDir,
  stateDir = null,
  baseEnv = process.env,
  wikiRootPath = null,
) {
  const providers = Array.isArray(providersOrWorkspaceRoot) ? providersOrWorkspaceRoot : [];
  const resolvedWorkspaceRoot = Array.isArray(providersOrWorkspaceRoot)
    ? workspaceRoot
    : providersOrWorkspaceRoot || workspaceRoot;
  const env = baseEnv && typeof baseEnv === "object" ? baseEnv : process.env;
  const resolvedStateDir =
    stateDir ||
    (Array.isArray(providersOrWorkspaceRoot)
      ? getRemoteVibesStateDir({ cwd: resolvedWorkspaceRoot, env })
      : getLegacyWorkspaceStateDir(resolvedWorkspaceRoot));
  const resolvedWikiRootPath = wikiRootPath || path.join(resolvedStateDir, "wiki");
  const agentDir = path.join(resolvedWikiRootPath, "comms", "agents", sessionId);
  const { NO_COLOR: _noColor, ...colorCapableEnv } = env;

  return {
    ...colorCapableEnv,
    CLICOLOR: "1",
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: prependPathEntries(env.PATH, preferredCliBinDirs),
    PWCLI: "rv-playwright",
    REMOTE_VIBES_APP_ROOT: appRootDir,
    REMOTE_VIBES_BROWSER_COMMAND: "rv-playwright",
    REMOTE_VIBES_BROWSER_FALLBACK_COMMAND: "rv-browser",
    REMOTE_VIBES_BROWSER_DESCRIBE:
      "rv-browser describe 4173 --prompt \"What visual issues stand out in the rendered UI?\"",
    REMOTE_VIBES_BROWSER_HELP: "rv-playwright open http://127.0.0.1:4173 && rv-playwright snapshot",
    REMOTE_VIBES_BROWSER_RUN_HELP:
      "rv-playwright open http://127.0.0.1:4173 && rv-playwright snapshot && rv-playwright click eX",
    REMOTE_VIBES_BROWSER_IMAGE_HELP:
      "rv-browser describe-file results/chart.png --prompt \"What does this output show and what should improve?\"",
    REMOTE_VIBES_PLAYWRIGHT_COMMAND: "rv-playwright",
    REMOTE_VIBES_PLAYWRIGHT_SKILL: path.join(appRootDir, "skills", "playwright", "SKILL.md"),
    REMOTE_VIBES_REAL_CLAUDE_COMMAND: getResolvedProviderCommand(providers, "claude") || "",
    REMOTE_VIBES_REAL_CODEX_COMMAND: getResolvedProviderCommand(providers, "codex") || "",
    REMOTE_VIBES_ROOT: resolvedStateDir,
    REMOTE_VIBES_AGENT_PROMPT_PATH: path.join(resolvedStateDir, AGENT_PROMPT_FILENAME),
    REMOTE_VIBES_PROVIDER: providerId,
    REMOTE_VIBES_SESSION_ID: sessionId,
    REMOTE_VIBES_WIKI_DIR: resolvedWikiRootPath,
    REMOTE_VIBES_COMMS_DIR: path.join(resolvedWikiRootPath, "comms"),
    REMOTE_VIBES_AGENT_DIR: agentDir,
    REMOTE_VIBES_AGENT_INBOX: path.join(agentDir, "inbox"),
    REMOTE_VIBES_AGENT_PROCESSED_DIR: path.join(agentDir, "processed"),
    REMOTE_VIBES_AGENTMAIL_REPLY_COMMAND: "rv-agentmail-reply",
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

  const resolvedPath = path.resolve(targetPath);

  try {
    return realpathSync(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function buildFallbackCommand(commandStrings) {
  return commandStrings.filter(Boolean).join(" || ");
}

function shouldTrackProviderSession(providerId) {
  return providerId === "codex" || providerId === "gemini" || providerId === "opencode";
}

function matchOpenCodeSessionsByCwd(sessions, cwd) {
  const normalizedCwd = normalizeSessionPath(cwd);

  return sessions
    .filter((entry) => normalizeSessionPath(entry?.directory) === normalizedCwd)
    .sort((left, right) => Number(right?.updated || 0) - Number(left?.updated || 0));
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
      ["session", "list", "--format", "json", "-n", String(PROVIDER_SESSION_LIST_LIMIT)],
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

function getProviderHomeDir(homeDir = os.homedir()) {
  return homeDir || os.homedir() || process.env.HOME || "";
}

function getHomeDirectory(env = process.env) {
  return String(env?.HOME || os.homedir() || "").trim() || os.homedir();
}

function getClaudeHomeDir(homeDirOrEnv = process.env) {
  return typeof homeDirOrEnv === "string"
    ? getProviderHomeDir(homeDirOrEnv)
    : getHomeDirectory(homeDirOrEnv);
}

function getCodexRootDir(homeDir = os.homedir()) {
  return path.join(getProviderHomeDir(homeDir), ".codex");
}

function getGeminiRootDir(homeDir = os.homedir()) {
  return path.join(getProviderHomeDir(homeDir), ".gemini");
}

function sortSessionsByUpdated(sessions) {
  return sessions.sort((left, right) => Number(right?.updated || 0) - Number(left?.updated || 0));
}

function normalizeClaudeProjectDirName(cwd) {
  const normalizedCwd = typeof cwd === "string" && cwd.trim() ? path.resolve(cwd) : null;
  return normalizedCwd ? normalizedCwd.replaceAll(path.sep, "-") : null;
}

function getClaudeProjectDirForCwd(cwd, homeDirOrEnv = process.env) {
  const projectDirName = normalizeClaudeProjectDirName(cwd);
  return projectDirName ? path.join(getClaudeHomeDir(homeDirOrEnv), ".claude", "projects", projectDirName) : null;
}

function listClaudeSessionsForCwd(cwd, homeDirOrEnv = process.env) {
  const projectDir = getClaudeProjectDirForCwd(cwd, homeDirOrEnv);
  if (!projectDir) {
    return [];
  }

  try {
    return sortSessionsByUpdated(
      readdirSync(projectDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => {
          const filePath = path.join(projectDir, entry.name);
          return {
            id: entry.name.slice(0, -".jsonl".length),
            updated: statSync(filePath).mtimeMs,
          };
        }),
    );
  } catch {
    return [];
  }
}

function parseClaudeSubagentJsonLine(line) {
  try {
    const payload = JSON.parse(line);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function readClaudeSubagentMeta(filePath) {
  try {
    const payload = JSON.parse(readFileSync(filePath, "utf8"));
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function summarizeClaudeSubagentTranscript(filePath, fallbackAgentId) {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return null;
  }

  if (stats.size > CLAUDE_SUBAGENT_TRANSCRIPT_READ_LIMIT) {
    return {
      agentId: fallbackAgentId,
      createdAt: new Date(stats.birthtimeMs || stats.mtimeMs).toISOString(),
      updatedAt: new Date(stats.mtimeMs).toISOString(),
      status: Date.now() - stats.mtimeMs <= SESSION_ACTIVITY_IDLE_MS * 2 ? "working" : "done",
      messageCount: null,
      toolUseCount: null,
      promptId: null,
    };
  }

  let lines;
  try {
    lines = readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }

  let firstTimestamp = null;
  let lastTimestamp = null;
  let lastPayload = null;
  let agentId = fallbackAgentId;
  let promptId = null;
  let toolUseCount = 0;

  for (const line of lines) {
    const payload = parseClaudeSubagentJsonLine(line);
    if (!payload) {
      continue;
    }

    if (typeof payload.agentId === "string" && payload.agentId.trim()) {
      agentId = payload.agentId.trim();
    }
    if (typeof payload.promptId === "string" && payload.promptId.trim()) {
      promptId = payload.promptId.trim();
    }
    if (typeof payload.timestamp === "string" && payload.timestamp.trim()) {
      firstTimestamp ||= payload.timestamp;
      lastTimestamp = payload.timestamp;
    }

    const content = payload.message?.content;
    if (Array.isArray(content)) {
      toolUseCount += content.filter((entry) => entry?.type === "tool_use").length;
    }

    lastPayload = payload;
  }

  const lastStopReason = lastPayload?.message?.stop_reason;
  const completed = lastPayload?.type === "assistant" && lastStopReason === "end_turn";
  const updatedMs = lastTimestamp ? Date.parse(lastTimestamp) : stats.mtimeMs;
  const status = completed || Date.now() - updatedMs > SESSION_ACTIVITY_IDLE_MS * 2 ? "done" : "working";

  return {
    agentId,
    createdAt: firstTimestamp || new Date(stats.birthtimeMs || stats.mtimeMs).toISOString(),
    updatedAt: lastTimestamp || new Date(stats.mtimeMs).toISOString(),
    status,
    messageCount: lines.length,
    toolUseCount,
    promptId,
  };
}

function listClaudeSubagentsForSession(session, homeDirOrEnv = process.env) {
  if (session?.providerId !== "claude") {
    return [];
  }

  const projectDir = getClaudeProjectDirForCwd(session.cwd, homeDirOrEnv);
  if (!projectDir) {
    return [];
  }

  const claudeSessionIds = Array.from(
    new Set(
      [session.providerState?.sessionId, session.id]
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  );

  const subagents = [];

  for (const claudeSessionId of claudeSessionIds) {
    const subagentsDir = path.join(projectDir, claudeSessionId, "subagents");
    let entries;
    try {
      entries = readdirSync(subagentsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const transcriptEntries = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => {
        const transcriptPath = path.join(subagentsDir, entry.name);
        try {
          return {
            entry,
            transcriptPath,
            updated: statSync(transcriptPath).mtimeMs,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => Number(right.updated || 0) - Number(left.updated || 0))
      .slice(0, 12);

    for (const { entry, transcriptPath } of transcriptEntries) {
      const fileBase = entry.name.slice(0, -".jsonl".length);
      const fallbackAgentId = fileBase.replace(/^agent-/, "") || fileBase;
      const summary = summarizeClaudeSubagentTranscript(transcriptPath, fallbackAgentId);
      if (!summary) {
        continue;
      }

      const meta = readClaudeSubagentMeta(path.join(subagentsDir, `${fileBase}.meta.json`));
      const description = typeof meta.description === "string" ? meta.description.trim() : "";
      const agentType = typeof meta.agentType === "string" && meta.agentType.trim()
        ? meta.agentType.trim()
        : "subagent";
      const displayId = summary.agentId || fallbackAgentId;

      subagents.push({
        id: `${claudeSessionId}:${fileBase}`,
        agentId: displayId,
        parentProviderSessionId: claudeSessionId,
        name: normalizeSessionName(description) || `Subagent ${displayId.slice(0, 6)}`,
        description,
        agentType,
        status: summary.status,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        promptId: summary.promptId,
        messageCount: summary.messageCount,
        toolUseCount: summary.toolUseCount,
      });
    }
  }

  return subagents
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
    .slice(0, 12);
}

async function readFirstLine(filePath, byteLimit = CODEX_SESSION_META_READ_LIMIT) {
  let handle;

  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.alloc(byteLimit);
    const { bytesRead } = await handle.read(buffer, 0, byteLimit, 0);
    return buffer.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0] || "";
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readCodexSessionMetaFile(filePath) {
  const firstLine = await readFirstLine(filePath);
  if (!firstLine) {
    return null;
  }

  try {
    const payload = JSON.parse(firstLine);
    const sessionMeta = payload?.type === "session_meta" ? payload.payload : null;
    if (typeof sessionMeta?.id !== "string") {
      return null;
    }

    return {
      id: sessionMeta.id,
      cwd: normalizeSessionPath(sessionMeta.cwd),
      updated: Date.parse(payload.timestamp || sessionMeta.timestamp || 0) || 0,
    };
  } catch {
    return null;
  }
}

function getRecentDatePrefixes(referenceTime = Date.now()) {
  const prefixes = new Set();

  for (const offset of [-1, 0, 1]) {
    const candidateDate = new Date(referenceTime + offset * 24 * 60 * 60 * 1000);
    const year = String(candidateDate.getFullYear()).padStart(4, "0");
    const month = String(candidateDate.getMonth() + 1).padStart(2, "0");
    const day = String(candidateDate.getDate()).padStart(2, "0");
    prefixes.add(path.join(year, month, day));
  }

  return Array.from(prefixes);
}

async function findCodexSessionMeta(codexRootDir, sessionId, referenceTime = Date.now()) {
  const sessionsDir = path.join(codexRootDir, "sessions");

  for (const prefix of getRecentDatePrefixes(referenceTime)) {
    const dayDir = path.join(sessionsDir, prefix);
    let files;

    try {
      files = await readdir(dayDir);
    } catch {
      continue;
    }

    const matchingFile = files.find((entry) => entry.endsWith(`-${sessionId}.jsonl`));
    if (!matchingFile) {
      continue;
    }

    const sessionMeta = await readCodexSessionMetaFile(path.join(dayDir, matchingFile));
    if (sessionMeta) {
      return sessionMeta;
    }
  }

  const archivedDir = path.join(codexRootDir, "archived_sessions");
  let archivedFiles;

  try {
    archivedFiles = await readdir(archivedDir);
  } catch {
    return null;
  }

  const archivedFile = archivedFiles.find((entry) => entry.endsWith(`-${sessionId}.jsonl`));
  if (!archivedFile) {
    return null;
  }

  return readCodexSessionMetaFile(path.join(archivedDir, archivedFile));
}

async function listCodexSessionIndex(homeDir = os.homedir()) {
  const indexPath = path.join(getCodexRootDir(homeDir), "session_index.jsonl");

  try {
    const contents = await readFile(indexPath, "utf8");
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const entry = JSON.parse(line);
          return {
            id: typeof entry?.id === "string" ? entry.id : null,
            updated: Date.parse(entry?.updated_at || 0) || 0,
          };
        } catch {
          return null;
        }
      })
      .filter((entry) => typeof entry?.id === "string")
      .sort((left, right) => Number(right.updated || 0) - Number(left.updated || 0))
      .slice(0, CODEX_SESSION_INDEX_LIMIT);
  } catch {
    return [];
  }
}

async function listCodexPromptHistory(homeDir = os.homedir()) {
  const historyPath = path.join(getCodexRootDir(homeDir), "history.jsonl");

  try {
    const contents = await readFile(historyPath, "utf8");
    const mergedEntries = new Map();

    for (const line of contents.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.session_id !== "string" || !entry.session_id) {
          continue;
        }

        let updated = Number(entry?.ts || 0);
        if (!Number.isFinite(updated) || updated <= 0) {
          updated = 0;
        } else if (updated < 1_000_000_000_000) {
          updated *= 1000;
        }

        const existingUpdated = mergedEntries.get(entry.session_id) || 0;
        if (updated >= existingUpdated) {
          mergedEntries.set(entry.session_id, updated);
        }
      } catch {
        // Ignore malformed history entries.
      }
    }

    return Array.from(mergedEntries.entries())
      .map(([id, updated]) => ({ id, updated }))
      .sort((left, right) => Number(right.updated || 0) - Number(left.updated || 0))
      .slice(0, CODEX_SESSION_INDEX_LIMIT);
  } catch {
    return [];
  }
}

function listRecentCodexSessionFiles(rootDir, limit = CODEX_SESSION_INDEX_LIMIT) {
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

async function listCodexTranscriptSessions(homeDir = os.homedir()) {
  const sessionsRoot = path.join(getCodexRootDir(homeDir), "sessions");
  const entries = await Promise.all(
    listRecentCodexSessionFiles(sessionsRoot).map((filePath) => readCodexSessionMetaFile(filePath)),
  );

  return entries
    .filter((entry) => typeof entry?.id === "string")
    .sort((left, right) => Number(right.updated || 0) - Number(left.updated || 0))
    .slice(0, CODEX_SESSION_INDEX_LIMIT);
}

async function listCodexTrackedSessions(homeDir = os.homedir()) {
  const mergedEntries = new Map();

  for (const sourceEntries of await Promise.all([
    listCodexSessionIndex(homeDir),
    listCodexPromptHistory(homeDir),
    listCodexTranscriptSessions(homeDir),
  ])) {
    for (const entry of sourceEntries) {
      if (typeof entry?.id !== "string" || !entry.id) {
        continue;
      }

      const existingEntry = mergedEntries.get(entry.id) || null;
      const existingUpdated = Number(existingEntry?.updated || 0);
      const nextUpdated = Number(entry.updated || 0);
      if (nextUpdated >= existingUpdated) {
        mergedEntries.set(entry.id, {
          id: entry.id,
          updated: nextUpdated,
          cwd: entry.cwd || existingEntry?.cwd || null,
        });
      }
    }
  }

  return Array.from(mergedEntries.values())
    .sort((left, right) => Number(right.updated || 0) - Number(left.updated || 0))
    .slice(0, CODEX_SESSION_INDEX_LIMIT);
}

function matchCodexSessionsByCwd(sessions, cwd) {
  const normalizedCwd = normalizeSessionPath(cwd);

  if (!normalizedCwd) {
    return [];
  }

  return sessions
    .filter((entry) => entry?.cwd && normalizeSessionPath(entry.cwd) === normalizedCwd)
    .sort((left, right) => Number(right.updated || 0) - Number(left.updated || 0));
}

function normalizeGeminiProjectPath(projectPath) {
  const normalizedPath = normalizeSessionPath(projectPath) || path.resolve(projectPath);
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

function hasGeminiConversationMessages(messages) {
  return Array.isArray(messages) && messages.some((message) => message?.type === "user" || message?.type === "assistant");
}

async function listGeminiSessions(cwd, homeDir = os.homedir()) {
  const normalizedCwd = normalizeSessionPath(cwd);
  if (!normalizedCwd) {
    return [];
  }

  const geminiRootDir = getGeminiRootDir(homeDir);
  const projectsPath = path.join(geminiRootDir, "projects.json");
  let registry = null;

  try {
    registry = JSON.parse(await readFile(projectsPath, "utf8"));
  } catch {
    return [];
  }

  const normalizedProjectPath = normalizeGeminiProjectPath(normalizedCwd);
  const projectId = Object.entries(registry?.projects || {}).find(([projectPath]) => (
    normalizeGeminiProjectPath(projectPath) === normalizedProjectPath
  ))?.[1];
  if (typeof projectId !== "string" || !projectId.trim()) {
    return [];
  }

  const chatsDir = path.join(geminiRootDir, "tmp", projectId, "chats");
  let files = [];

  try {
    files = await readdir(chatsDir);
  } catch {
    return [];
  }

  const sessions = [];

  for (const fileName of files) {
    if (!fileName.startsWith("session-") || !fileName.endsWith(".json")) {
      continue;
    }

    try {
      const payload = JSON.parse(await readFile(path.join(chatsDir, fileName), "utf8"));
      if (
        typeof payload?.sessionId !== "string"
        || !payload.sessionId
        || !hasGeminiConversationMessages(payload.messages)
      ) {
        continue;
      }

      sessions.push({
        id: payload.sessionId,
        updated: Date.parse(payload.lastUpdated || payload.startTime || 0) || 0,
      });
    } catch {
      // Ignore malformed Gemini session files.
    }
  }

  return sessions
    .sort((left, right) => Number(right.updated || 0) - Number(left.updated || 0))
    .slice(0, PROVIDER_SESSION_LIST_LIMIT);
}

export class SessionManager {
  constructor({
    cwd,
    providers,
    persistSessions = true,
    stateDir = getRemoteVibesStateDir({ cwd }),
    wikiRootPath = path.join(stateDir, "wiki"),
    agentRunStore = null,
    runIdleTimeoutMs = Number(process.env.REMOTE_VIBES_RUN_IDLE_MS || 15_000),
    sessionActivityIdleMs = SESSION_ACTIVITY_IDLE_MS,
    env = process.env,
    userHomeDir = env?.HOME || os.homedir(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    this.cwd = cwd;
    this.providers = providers;
    this.persistSessions = persistSessions;
    this.stateDir = stateDir;
    this.wikiRootPath = wikiRootPath;
    this.env = env && typeof env === "object" ? { ...env } : { ...process.env };
    this.userHomeDir = getProviderHomeDir(userHomeDir);
    this.sessionActivityIdleMs = Math.max(500, Number(sessionActivityIdleMs) || SESSION_ACTIVITY_IDLE_MS);
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
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
          setTimeoutFn,
          clearTimeoutFn,
        })
      : null;
  }

  setWikiRootPath(wikiRootPath) {
    this.wikiRootPath = wikiRootPath;
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

    const normalizedName = normalizeSessionName(name);
    const createdAt = new Date().toISOString();
    const session = this.buildSessionRecord({
      cwd: resolveCwd(cwd, this.cwd),
      name: normalizedName || this.makeDefaultName(provider),
      providerId: provider.id,
      providerLabel: provider.label,
      createdAt,
      updatedAt: createdAt,
      restoreOnStartup: true,
      autoRenameEnabled: shouldAutoRenameFromPrompt(provider, normalizedName || provider.defaultName, !normalizedName),
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

    if (nextName === session.name) {
      return this.serializeSession(session);
    }

    session.name = nextName;
    session.autoRenameEnabled = false;
    session.autoRenameBuffer = "";
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

  forkSession(sessionId) {
    const sourceSession = this.sessions.get(sessionId);

    if (!sourceSession) {
      return null;
    }

    const provider = this.getProvider(sourceSession.providerId);

    if (!provider) {
      throw new Error(`${sourceSession.providerLabel} is no longer configured on this host.`);
    }

    if (!provider.available) {
      throw new Error(`${provider.label} is not installed on this host.`);
    }

    const createdAt = new Date().toISOString();
    const forkProviderState = this.getForkProviderState(sourceSession);
    const sharesProviderMemory = Boolean(forkProviderState?.sessionId);
    const forkSession = this.buildSessionRecord({
      cwd: sourceSession.cwd,
      name: this.makeForkName(sourceSession.name),
      providerId: sourceSession.providerId,
      providerLabel: sourceSession.providerLabel,
      createdAt,
      updatedAt: createdAt,
      cols: sourceSession.cols,
      rows: sourceSession.rows,
      providerState: forkProviderState,
      restoreOnStartup: true,
      buffer: [
        `\u001b[1;36m[remote-vibes]\u001b[0m forked from: ${sourceSession.name}`,
        sharesProviderMemory
          ? `\u001b[1;36m[remote-vibes]\u001b[0m resuming the source agent memory in the same cwd`
          : `\u001b[1;36m[remote-vibes]\u001b[0m started in the same cwd; no provider memory id was available to resume`,
        "",
      ].join("\r\n"),
      autoRenameEnabled: sourceSession.providerId !== "shell",
    });

    this.sessions.set(forkSession.id, forkSession);

    try {
      this.startSession(forkSession, provider);
    } catch (error) {
      this.sessions.delete(forkSession.id);
      this.schedulePersist({ immediate: true });
      throw error;
    }

    this.schedulePersist({ immediate: true });
    return this.serializeSession(forkSession);
  }

  getForkProviderState(sourceSession) {
    if (!sourceSession) {
      return null;
    }

    const sourceProviderSessionId =
      sourceSession.providerState?.sessionId ||
      (sourceSession.providerId === "claude" ? sourceSession.id : null);

    if (!sourceProviderSessionId) {
      return sourceSession.providerState
        ? { ...sourceSession.providerState, forkedFromSessionId: sourceSession.id }
        : null;
    }

    return {
      ...(sourceSession.providerState || {}),
      sessionId: sourceProviderSessionId,
      forkedFromSessionId: sourceSession.id,
    };
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
    this.clearPendingProviderCaptureRetry(session);
    this.clearSessionActivityTimer(session);
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
    this.trackSessionInputActivity(session, input);
    this.maybeAutoRenameSessionFromInput(session, input);
    this.maybeRetryPendingProviderCaptureFromInput(session, input);
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
      this.clearPendingProviderCaptureRetry(session);
      this.clearSessionActivityTimer(session);

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

  makeForkName(baseName) {
    const rootName = `${baseName} fork`;
    let suffix = 1;
    let nextName = rootName;

    const existingNames = new Set(Array.from(this.sessions.values()).map((session) => session.name));

    while (existingNames.has(nextName)) {
      suffix += 1;
      nextName = `${rootName} ${suffix}`;
    }

    return nextName;
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

  clearSessionActivityTimer(session) {
    if (!session?.activityIdleTimer) {
      return;
    }

    this.clearTimeoutFn(session.activityIdleTimer);
    session.activityIdleTimer = null;
  }

  scheduleSessionActivityCompletion(session) {
    if (!isAgentActivitySession(session) || session.activityStatus !== "working") {
      this.clearSessionActivityTimer(session);
      return;
    }

    this.clearSessionActivityTimer(session);
    session.activityIdleTimer = this.setTimeoutFn(() => {
      session.activityIdleTimer = null;
      this.markSessionActivityDone(session);
    }, this.sessionActivityIdleMs);
  }

  markSessionActivityWorking(session) {
    if (!isAgentActivitySession(session)) {
      return false;
    }

    const timestamp = new Date().toISOString();
    session.activityStatus = "working";
    session.lastPromptAt = timestamp;
    session.activityStartedAt = timestamp;
    session.activityCompletedAt = null;
    session.updatedAt = timestamp;
    this.scheduleSessionActivityCompletion(session);
    this.scheduleSessionMetaBroadcast(session, { immediate: true });
    this.schedulePersist();
    return true;
  }

  markSessionActivityDone(session) {
    if (!isAgentActivitySession(session) || session.activityStatus !== "working") {
      return false;
    }

    this.clearSessionActivityTimer(session);
    const timestamp = new Date().toISOString();
    session.activityStatus = "done";
    session.activityCompletedAt = timestamp;
    session.updatedAt = timestamp;
    this.scheduleSessionMetaBroadcast(session, { immediate: true });
    this.schedulePersist();
    return true;
  }

  trackSessionInputActivity(session, input) {
    if (!isAgentActivitySession(session)) {
      return;
    }

    const parsed = consumePromptInput(session.activityInputBuffer || "", input);
    session.activityInputBuffer = parsed.buffer;

    if (parsed.interrupted) {
      this.markSessionActivityDone(session);
    }

    if (parsed.completedLines.length > 0) {
      this.markSessionActivityWorking(session);
    }
  }

  trackSessionOutputActivity(session) {
    if (!isAgentActivitySession(session) || session.activityStatus !== "working") {
      return;
    }

    this.scheduleSessionActivityCompletion(session);
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
      lastPromptAt: session.lastPromptAt,
      activityStatus: session.activityStatus,
      activityStartedAt: session.activityStartedAt,
      activityCompletedAt: session.activityCompletedAt,
      subagents: listClaudeSubagentsForSession(session, this.userHomeDir),
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
    lastPromptAt = null,
    activityStatus = "idle",
    activityStartedAt = null,
    activityCompletedAt = null,
    status = "starting",
    exitCode = null,
    exitSignal = null,
    cols = 120,
    rows = 34,
    buffer = "",
    restoreOnStartup = false,
    providerState = null,
    autoRenameEnabled = false,
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
      lastPromptAt,
      activityStatus: normalizeActivityStatus(activityStatus),
      activityStartedAt,
      activityCompletedAt,
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
      autoRenameEnabled: Boolean(autoRenameEnabled),
      autoRenameBuffer: "",
      activityInputBuffer: "",
      activityIdleTimer: null,
      pendingProviderCapture: null,
      providerCapturePromise: null,
      providerCaptureRetryTimer: null,
      skipExitHandling: false,
    };
  }

  clearPendingProviderCaptureRetry(session) {
    if (session?.providerCaptureRetryTimer) {
      clearTimeout(session.providerCaptureRetryTimer);
      session.providerCaptureRetryTimer = null;
    }
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
    if (normalizedState?.sessionId) {
      this.clearPendingProviderCaptureRetry(session);
      session.pendingProviderCapture = null;
      session.providerCapturePromise = null;
    }
    session.updatedAt = new Date().toISOString();
    this.schedulePersist({ immediate: true });
  }

  maybeAutoRenameSessionFromInput(session, input) {
    const provider = this.getProvider(session.providerId);
    if (!shouldAutoRenameFromPrompt(provider, session.name, session.autoRenameEnabled)) {
      session.autoRenameBuffer = "";
      return;
    }

    const { completedLines, buffer } = consumePromptInput(session.autoRenameBuffer, input);
    session.autoRenameBuffer = buffer;

    for (const line of completedLines) {
      const nextName = deriveSessionNameFromPromptLine(line);
      if (!nextName) {
        continue;
      }

      this.renameSession(session.id, nextName);
      return;
    }
  }

  setPendingProviderCapture(session, providerId, baselineSessionIds = [], launchedAt = null, launchCommand = null) {
    if (!shouldTrackProviderSession(providerId)) {
      this.clearPendingProviderCaptureRetry(session);
      session.pendingProviderCapture = null;
      session.providerCapturePromise = null;
      return;
    }

    this.clearPendingProviderCaptureRetry(session);
    session.pendingProviderCapture = {
      providerId,
      baselineSessionIds: Array.from(baselineSessionIds),
      launchedAt: launchedAt ? Number(launchedAt) : null,
      launchCommand: launchCommand || null,
      retryUntil: launchedAt ? Number(launchedAt) + PROVIDER_SESSION_CAPTURE_RETRY_WINDOW_MS : null,
    };
    session.providerCapturePromise = null;
  }

  schedulePendingProviderCaptureRetry(session, delayMs = PROVIDER_SESSION_CAPTURE_RETRY_INTERVAL_MS) {
    if (!session?.pendingProviderCapture || session.providerState?.sessionId || !session.pty) {
      this.clearPendingProviderCaptureRetry(session);
      return;
    }

    const launchedAt = Number(session.pendingProviderCapture.launchedAt || 0);
    if (!launchedAt) {
      return;
    }

    const retryUntil =
      Number(session.pendingProviderCapture.retryUntil || 0)
      || launchedAt + PROVIDER_SESSION_CAPTURE_RETRY_WINDOW_MS;

    session.pendingProviderCapture.retryUntil = retryUntil;

    if (Date.now() >= retryUntil || session.providerCaptureRetryTimer) {
      return;
    }

    session.providerCaptureRetryTimer = setTimeout(() => {
      session.providerCaptureRetryTimer = null;

      if (!session.pendingProviderCapture || session.providerState?.sessionId || session.status !== "running" || !session.pty) {
        return;
      }

      void this.beginPendingProviderCapture(session);
    }, delayMs);
  }

  async beginPendingProviderCapture(session) {
    if (!session?.pendingProviderCapture || session.providerState?.sessionId || !session.pty) {
      return;
    }

    if (session.providerCapturePromise) {
      return session.providerCapturePromise;
    }

    const { providerId, baselineSessionIds, launchedAt, launchCommand } = session.pendingProviderCapture;
    if (!shouldTrackProviderSession(providerId) || !launchedAt) {
      return;
    }

    const provider = this.getProvider(providerId);
    const ptyProcess = session.pty;
    const baselineSet = new Set(baselineSessionIds || []);
    const capturePromise = (async () => {
      if (providerId === "codex") {
        await this.captureCodexSessionId(session, ptyProcess, baselineSet, launchedAt);
      } else if (providerId === "gemini") {
        await this.captureGeminiSessionId(session, ptyProcess, baselineSet, launchedAt);
      } else if (providerId === "opencode" && provider) {
        await this.captureOpenCodeSessionId(
          session,
          { ...provider, launchCommand: launchCommand || provider.launchCommand },
          ptyProcess,
          baselineSet,
          launchedAt,
        );
      }
    })().finally(() => {
      if (session.providerCapturePromise === capturePromise) {
        session.providerCapturePromise = null;
      }

      if (!session.providerState?.sessionId) {
        this.schedulePendingProviderCaptureRetry(session);
      }
    });

    session.providerCapturePromise = capturePromise;
    return capturePromise;
  }

  maybeRetryPendingProviderCaptureFromInput(session, input) {
    if (!session?.pendingProviderCapture || session.providerState?.sessionId) {
      return;
    }

    if (!/[\r\n]/.test(String(input ?? ""))) {
      return;
    }

    this.clearPendingProviderCaptureRetry(session);
    void this.beginPendingProviderCapture(session);
  }

  async prepareProviderLaunch(session, provider, { restored = false } = {}) {
    if (!provider.launchCommand) {
      this.setPendingProviderCapture(session, null);
      return {
        commandString: null,
        afterLaunch: null,
      };
    }

    if (provider.id === "claude") {
      const launchCommand = getManagedProviderLaunchCommand(provider);
      this.setPendingProviderCapture(session, null);
      const fallbackSessionId = restored
        ? listClaudeSessionsForCwd(session.cwd, this.userHomeDir)[0]?.id || null
        : null;
      const sessionId = session.providerState?.sessionId || fallbackSessionId || (!restored ? session.id : null);

      if (sessionId) {
        this.updateProviderState(session, { sessionId });
      }

      const createCommand = buildShellCommand(launchCommand, [
        CLAUDE_SKIP_PERMISSIONS_ARG,
        "--session-id",
        sessionId || session.id,
      ]);
      const resumeCommand = sessionId
        ? buildShellCommand(launchCommand, [CLAUDE_SKIP_PERMISSIONS_ARG, "--resume", sessionId])
        : null;
      return {
        commandString: (restored || session.providerState?.forkedFromSessionId) && sessionId
          ? buildFallbackCommand([resumeCommand, createCommand])
          : createCommand,
        afterLaunch: null,
      };
    }

    if (provider.id === "codex") {
      const launchCommand = getManagedProviderLaunchCommand(provider);
      const resumeLastCommand = buildShellCommand(launchCommand, ["resume", "--last"]);
      const createCommand = buildShellCommand(launchCommand);
      const knownSessions = matchCodexSessionsByCwd(
        await listCodexTrackedSessions(this.userHomeDir),
        session.cwd,
      );
      const existingSessionId = session.providerState?.sessionId || null;

      if (!restored && existingSessionId) {
        this.setPendingProviderCapture(session, null);
        return {
          commandString: buildFallbackCommand([
            buildShellCommand(launchCommand, ["resume", existingSessionId]),
            createCommand,
          ]),
          afterLaunch: null,
        };
      }

      if (restored) {
        this.setPendingProviderCapture(session, null);
        const restoreSessionId = session.providerState?.sessionId || knownSessions[0]?.id || null;

        if (restoreSessionId) {
          this.updateProviderState(session, { sessionId: restoreSessionId });
        }

        const resumeCommand = restoreSessionId
          ? buildShellCommand(launchCommand, ["resume", restoreSessionId])
          : null;

        return {
          commandString: buildFallbackCommand([resumeCommand, resumeLastCommand, createCommand]),
          afterLaunch: null,
        };
      }

      const baselineSessionIds = new Set((await listCodexTrackedSessions(this.userHomeDir)).map((entry) => entry.id));
      this.setPendingProviderCapture(session, provider.id, baselineSessionIds, null, provider.launchCommand);

      return {
        commandString: createCommand,
        afterLaunch: async (ptyProcess, launchedAt) => {
          if (session.pendingProviderCapture) {
            session.pendingProviderCapture.launchedAt = launchedAt;
            session.pendingProviderCapture.retryUntil = launchedAt + PROVIDER_SESSION_CAPTURE_RETRY_WINDOW_MS;
          }
          await this.beginPendingProviderCapture(session);
        },
      };
    }

    if (provider.id === "gemini") {
      const knownSessions = await listGeminiSessions(session.cwd, this.userHomeDir);
      const createCommand = buildShellCommand(provider.launchCommand);
      const existingSessionId = session.providerState?.sessionId || null;

      if (!restored && existingSessionId) {
        this.setPendingProviderCapture(session, null);
        return {
          commandString: buildFallbackCommand([
            buildShellCommand(provider.launchCommand, ["--resume", existingSessionId]),
            buildShellCommand(provider.launchCommand, ["--resume", "latest"]),
            createCommand,
          ]),
          afterLaunch: null,
        };
      }

      if (restored) {
        this.setPendingProviderCapture(session, null);
        const restoreSessionId = session.providerState?.sessionId || knownSessions[0]?.id || null;
        if (restoreSessionId) {
          this.updateProviderState(session, { sessionId: restoreSessionId });
        }

        return {
          commandString: buildFallbackCommand([
            restoreSessionId ? buildShellCommand(provider.launchCommand, ["--resume", restoreSessionId]) : null,
            buildShellCommand(provider.launchCommand, ["--resume", "latest"]),
            createCommand,
          ]),
          afterLaunch: null,
        };
      }

      const baselineSessionIds = new Set(knownSessions.map((entry) => entry.id));
      this.setPendingProviderCapture(session, provider.id, baselineSessionIds, null, provider.launchCommand);

      return {
        commandString: createCommand,
        afterLaunch: async (ptyProcess, launchedAt) => {
          if (session.pendingProviderCapture) {
            session.pendingProviderCapture.launchedAt = launchedAt;
            session.pendingProviderCapture.retryUntil = launchedAt + PROVIDER_SESSION_CAPTURE_RETRY_WINDOW_MS;
          }
          await this.beginPendingProviderCapture(session);
        },
      };
    }

    if (provider.id !== "opencode") {
      this.setPendingProviderCapture(session, null);
      return {
        commandString: buildShellCommand(provider.launchCommand),
        afterLaunch: null,
      };
    }

    const existingSessionId = session.providerState?.sessionId || null;

    if (!restored && existingSessionId) {
      this.setPendingProviderCapture(session, null);
      return {
        commandString: buildShellCommand(provider.launchCommand, ["--session", existingSessionId]),
        afterLaunch: null,
      };
    }

    const knownSessions = matchOpenCodeSessionsByCwd(
      await listOpenCodeSessions(
        provider.launchCommand,
        session.cwd,
        buildSessionEnv(
          session.id,
          provider.id,
          this.providers,
          this.cwd,
          this.stateDir,
          this.env,
          this.wikiRootPath,
        ),
      ),
      session.cwd,
    );

    if (restored) {
      this.setPendingProviderCapture(session, null);
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
    this.setPendingProviderCapture(session, provider.id, baselineSessionIds, null, provider.launchCommand);

    return {
      commandString: buildShellCommand(provider.launchCommand),
      afterLaunch: async (ptyProcess, launchedAt) => {
        if (session.pendingProviderCapture) {
          session.pendingProviderCapture.launchedAt = launchedAt;
          session.pendingProviderCapture.retryUntil = launchedAt + PROVIDER_SESSION_CAPTURE_RETRY_WINDOW_MS;
        }
        await this.beginPendingProviderCapture(session);
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
          buildSessionEnv(
            session.id,
            provider.id,
            this.providers,
            this.cwd,
            this.stateDir,
            this.env,
            this.wikiRootPath,
          ),
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

  async captureCodexSessionId(session, ptyProcess, baselineSessionIds, launchedAt) {
    const codexRootDir = getCodexRootDir(this.userHomeDir);

    for (let attempt = 0; attempt < PROVIDER_SESSION_CAPTURE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await delay(PROVIDER_SESSION_CAPTURE_INTERVAL_MS);
      }

      if (session.status !== "running" || session.pty !== ptyProcess) {
        return;
      }

      const indexedSessions = await listCodexTrackedSessions(this.userHomeDir);
      const freshCandidates = indexedSessions.filter((entry) => !baselineSessionIds.has(entry.id));
      const fallbackCandidates = indexedSessions.filter(
        (entry) => Number(entry?.updated || 0) >= launchedAt - PROVIDER_SESSION_LOOKBACK_MS,
      );
      const candidateEntries = freshCandidates.length > 0 ? freshCandidates : fallbackCandidates;

      if (candidateEntries.length === 0) {
        continue;
      }

      for (const candidate of candidateEntries) {
        if (candidate.cwd && normalizeSessionPath(candidate.cwd) === normalizeSessionPath(session.cwd)) {
          this.updateProviderState(session, { sessionId: candidate.id });
          return;
        }

        const sessionMeta = await findCodexSessionMeta(codexRootDir, candidate.id, candidate.updated || launchedAt);
        if (!sessionMeta?.id || sessionMeta.cwd !== normalizeSessionPath(session.cwd)) {
          continue;
        }

        this.updateProviderState(session, { sessionId: sessionMeta.id });
        return;
      }

      // Codex can write the prompt history entry before its session transcript lands on disk.
      // When exactly one brand-new session id appeared after launch, treat it as the active thread.
      if (freshCandidates.length === 1 && candidateEntries.length === 1) {
        this.updateProviderState(session, { sessionId: freshCandidates[0].id });
        return;
      }
    }
  }

  async captureGeminiSessionId(session, ptyProcess, baselineSessionIds, launchedAt) {
    for (let attempt = 0; attempt < PROVIDER_SESSION_CAPTURE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await delay(PROVIDER_SESSION_CAPTURE_INTERVAL_MS);
      }

      if (session.status !== "running" || session.pty !== ptyProcess) {
        return;
      }

      const candidate = pickTrackedSession(
        await listGeminiSessions(session.cwd, this.userHomeDir),
        baselineSessionIds,
        launchedAt,
      );

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
      env: buildSessionEnv(
        session.id,
        provider.id,
        this.providers,
        this.cwd,
        this.stateDir,
        this.env,
        this.wikiRootPath,
      ),
      name: "xterm-256color",
      cols: session.cols,
      rows: session.rows,
    });

    session.pty = ptyProcess;
    session.status = "running";
    session.exitCode = null;
    session.exitSignal = null;
    session.restoreOnStartup = true;
    session.activityInputBuffer = "";
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
          '\u001b[1;36m[remote-vibes]\u001b[0m browser skill: export PWCLI="${PWCLI:-rv-playwright}"; "$PWCLI" open http://127.0.0.1:4173',
          '\u001b[1;36m[remote-vibes]\u001b[0m inspect UI: "$PWCLI" snapshot; use fresh refs with click/fill/type/press',
          '\u001b[1;36m[remote-vibes]\u001b[0m save artifacts: "$PWCLI" screenshot --filename output/playwright/current.png',
          '\u001b[1;36m[remote-vibes]\u001b[0m visual fallback: rv-browser describe-file results/chart.png --prompt "What should improve?"',
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
      this.trackSessionOutputActivity(session);
      this.pushOutput(session, chunk);
      this.scheduleSessionMetaBroadcast(session);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.pty = null;
      this.clearPendingProviderCaptureRetry(session);
      this.clearSessionActivityTimer(session);

      if (session.skipExitHandling) {
        this.agentRunTracker?.forgetSession(session.id);
        return;
      }

      session.status = "exited";
      session.exitCode = exitCode;
      session.exitSignal = signal ?? null;
      session.restoreOnStartup = false;
      session.activityStatus = "idle";
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
      name: snapshot.name?.trim() || snapshot.providerLabel || "Restored Session",
      shell: snapshot.shell || process.env.SHELL || "/bin/zsh",
      cwd: snapshot.cwd || this.cwd,
      createdAt: snapshot.createdAt || new Date().toISOString(),
      updatedAt: snapshot.updatedAt || snapshot.createdAt || new Date().toISOString(),
      lastOutputAt: snapshot.lastOutputAt || null,
      lastPromptAt: snapshot.lastPromptAt || null,
      activityStatus: snapshot.activityStatus === "done" ? "done" : "idle",
      activityStartedAt: snapshot.activityStartedAt || null,
      activityCompletedAt: snapshot.activityCompletedAt || null,
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
    session.autoRenameEnabled = shouldAutoRenameFromPrompt(provider, session.name, true);
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
    session.activityStatus = "idle";
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
