import { execFile, execFileSync } from "node:child_process";
import os from "node:os";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pty from "node-pty";
import { AGENT_PROMPT_FILENAME } from "./agent-prompt-store.js";
import {
  getBuildingAgentGuideIndexPath,
  getBuildingAgentGuidesDir,
} from "./building-agent-guides.js";
import { AgentRunTracker } from "./agent-run-tracker.js";
import { SessionStore } from "./session-store.js";
import { getLegacyWorkspaceStateDir, getVibeResearchStateDir, getVibeResearchSystemDir } from "./state-paths.js";

const MAX_BUFFER_LENGTH = 2_000_000;
const STARTUP_DELAY_MS = 180;
const SESSION_META_THROTTLE_MS = 180;
const SESSION_PERSIST_THROTTLE_MS = 180;
const SESSION_NAME_MAX_LENGTH = 64;
const SESSION_AUTO_NAME_MAX_WORDS = 6;
const SESSION_AUTO_NAME_BUFFER_LIMIT = 240;
const SESSION_ACTIVITY_IDLE_MS = Number(
  process.env.VIBE_RESEARCH_SESSION_ACTIVITY_IDLE_MS || process.env.REMOTE_VIBES_SESSION_ACTIVITY_IDLE_MS || 15_000,
);
const INITIAL_PROMPT_DELAY_MS = Number(
  process.env.VIBE_RESEARCH_INITIAL_PROMPT_DELAY_MS || process.env.REMOTE_VIBES_INITIAL_PROMPT_DELAY_MS || 1_400,
);
const INITIAL_PROMPT_READY_IDLE_MS = Number(
  process.env.VIBE_RESEARCH_INITIAL_PROMPT_READY_IDLE_MS || process.env.REMOTE_VIBES_INITIAL_PROMPT_READY_IDLE_MS || 1_200,
);
const INITIAL_PROMPT_READY_TIMEOUT_MS = Number(
  process.env.VIBE_RESEARCH_INITIAL_PROMPT_READY_TIMEOUT_MS || process.env.REMOTE_VIBES_INITIAL_PROMPT_READY_TIMEOUT_MS || 45_000,
);
const INITIAL_PROMPT_RETRY_MS = Number(
  process.env.VIBE_RESEARCH_INITIAL_PROMPT_RETRY_MS || process.env.REMOTE_VIBES_INITIAL_PROMPT_RETRY_MS || 500,
);
const INITIAL_PROMPT_SUBMIT_DELAY_MS = Number(
  process.env.VIBE_RESEARCH_INITIAL_PROMPT_SUBMIT_DELAY_MS || process.env.REMOTE_VIBES_INITIAL_PROMPT_SUBMIT_DELAY_MS || 350,
);
const PROVIDER_SESSION_LIST_LIMIT = 50;
const PROVIDER_SESSION_CAPTURE_ATTEMPTS = 16;
const PROVIDER_SESSION_CAPTURE_INTERVAL_MS = 250;
const PROVIDER_SESSION_LOOKBACK_MS = 4_000;
const PROVIDER_SESSION_CAPTURE_RETRY_INTERVAL_MS = 5_000;
const PROVIDER_SESSION_CAPTURE_RETRY_WINDOW_MS = 90_000;
const CODEX_SESSION_INDEX_LIMIT = 100;
const CODEX_SESSION_META_READ_LIMIT = 8192;
const CLAUDE_SUBAGENT_TRANSCRIPT_READ_LIMIT = 1_000_000;
const CLAUDE_BACKGROUND_TASK_TAIL_BYTES = 900_000;
const CLAUDE_BACKGROUND_TASK_STALE_MS = 24 * 60 * 60 * 1000;
const CLAUDE_BACKGROUND_TASK_GRACE_MS = 30_000;
const CLAUDE_SKIP_PERMISSIONS_ARG = "--dangerously-skip-permissions";
const CLAUDE_OLLAMA_PROVIDER_ID = "claude-ollama";
const DEFAULT_CLAUDE_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_CLAUDE_OLLAMA_MODEL = "qwen3-coder";
const PERSISTENT_TERMINAL_PROVIDER_IDS = new Set([
  "claude",
  CLAUDE_OLLAMA_PROVIDER_ID,
  "codex",
  "gemini",
  "ml-intern",
  "openclaw",
  "opencode",
  "shell",
]);
const IDLE_TERMINAL_COMMANDS = new Set(["bash", "csh", "dash", "fish", "ksh", "login", "sh", "tcsh", "zsh"]);
const PROVIDER_CREDENTIAL_ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "OPENAI_API_KEY", "HF_TOKEN"];
const TMUX_SESSION_ENV_KEYS = new Set([
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "MKL_NUM_THREADS",
  "NUMEXPR_NUM_THREADS",
  "OMP_NUM_THREADS",
  "OPENBLAS_NUM_THREADS",
  "PATH",
  "RAYON_NUM_THREADS",
  "SHELL",
  "USER",
  "VECLIB_MAXIMUM_THREADS",
]);
const RESOURCE_THREAD_ENV_KEYS = [
  "OMP_NUM_THREADS",
  "OPENBLAS_NUM_THREADS",
  "MKL_NUM_THREADS",
  "NUMEXPR_NUM_THREADS",
  "VECLIB_MAXIMUM_THREADS",
  "RAYON_NUM_THREADS",
];
const SWARM_GRAPH_MAX_RELATED_SESSIONS = 16;
const SWARM_GRAPH_MAX_PATHS = 18;
const SWARM_GRAPH_GIT_TIMEOUT_MS = 2_500;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRootDir = path.resolve(__dirname, "..");
const helperBinDir = path.join(appRootDir, "bin");
const mlInternHandoffPromptPath = path.join(appRootDir, "templates", "ml-intern-vibe-research-move.md");
const preferredCliBinDirs = [helperBinDir, "/opt/homebrew/bin", "/usr/local/bin"];
const execFileAsync = promisify(execFile);
const claudeBackgroundTaskSummaryCache = new Map();

function getShellArgs(shellPath) {
  const shellName = path.basename(shellPath);

  if (shellName === "fish") {
    return ["-i", "-l"];
  }

  return ["-i", "-l"];
}

function isDisabledFlag(value) {
  return /^(?:0|false|no|off)$/i.test(String(value ?? "").trim());
}

function isClaudeOllamaProviderId(providerId) {
  return String(providerId || "").trim().toLowerCase() === CLAUDE_OLLAMA_PROVIDER_ID;
}

function isClaudeProviderId(providerId) {
  const normalizedProviderId = String(providerId || "").trim().toLowerCase();
  return normalizedProviderId === "claude" || normalizedProviderId === CLAUDE_OLLAMA_PROVIDER_ID;
}

function getClaudeOllamaBaseUrl(env = process.env) {
  return (
    String(
      env?.VIBE_RESEARCH_CLAUDE_OLLAMA_BASE_URL ||
        env?.REMOTE_VIBES_CLAUDE_OLLAMA_BASE_URL ||
        env?.CLAUDE_OLLAMA_BASE_URL ||
        "",
    ).trim() ||
    DEFAULT_CLAUDE_OLLAMA_BASE_URL
  ).replace(/\/+$/, "");
}

function getClaudeOllamaModel(env = process.env) {
  return String(
    env?.VIBE_RESEARCH_CLAUDE_OLLAMA_MODEL ||
      env?.REMOTE_VIBES_CLAUDE_OLLAMA_MODEL ||
      env?.CLAUDE_OLLAMA_MODEL ||
      "",
  ).trim() || DEFAULT_CLAUDE_OLLAMA_MODEL;
}

function mergeNoProxy(value, entries) {
  const seen = new Set();
  return [
    ...String(value || "").split(","),
    ...entries,
  ]
    .map((entry) => String(entry || "").trim())
    .filter((entry) => {
      if (!entry || seen.has(entry.toLowerCase())) {
        return false;
      }
      seen.add(entry.toLowerCase());
      return true;
    })
    .join(",");
}

function buildProviderSpecificSessionEnv(providerId, env = process.env) {
  if (!isClaudeOllamaProviderId(providerId)) {
    return {};
  }

  const model = getClaudeOllamaModel(env);
  const noProxy = mergeNoProxy(env?.NO_PROXY || env?.no_proxy || "", ["localhost", "127.0.0.1", "::1"]);

  return {
    ANTHROPIC_AUTH_TOKEN: "ollama",
    ANTHROPIC_API_KEY: "local",
    ANTHROPIC_BASE_URL: getClaudeOllamaBaseUrl(env),
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    CLAUDE_CODE_DISABLE_THINKING: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_BUG_COMMAND: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_FEEDBACK_COMMAND: "1",
    DISABLE_INSTALL_GITHUB_APP_COMMAND: "1",
    DISABLE_INTERLEAVED_THINKING: "1",
    DISABLE_LOGIN_COMMAND: "1",
    DISABLE_PROMPT_CACHING: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_UPGRADE_COMMAND: "1",
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

function resolveExecutableCommand(command, env = process.env) {
  const rawCommand = String(command || "").trim();
  if (!rawCommand || path.isAbsolute(rawCommand) || rawCommand.includes(path.sep)) {
    return rawCommand;
  }

  try {
    const resolved = execFileSync("/bin/sh", ["-lc", 'command -v -- "$1"', "sh", rawCommand], {
      encoding: "utf8",
      env,
      timeout: 1_500,
    })
      .split("\n")[0]
      .trim();

    return resolved || rawCommand;
  } catch {
    return rawCommand;
  }
}

function getTmuxCommand(env = process.env) {
  return resolveExecutableCommand(env?.VIBE_RESEARCH_TMUX_COMMAND || env?.REMOTE_VIBES_TMUX_COMMAND || "tmux", env);
}

function getTmuxSessionName(session) {
  const safeId = String(session?.id || randomUUID()).replace(/[^A-Za-z0-9_-]/g, "-");
  return `vibe-research-${safeId}`.slice(0, 80);
}

function getTmuxEnvironmentArgs(env = process.env) {
  const args = [];
  const entries = Object.entries(env || {}).filter(([key, value]) => (
    value != null &&
    value !== "" &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
    (TMUX_SESSION_ENV_KEYS.has(key) || key.startsWith("VIBE_RESEARCH_") || key.startsWith("REMOTE_VIBES_"))
  ));

  for (const [key, value] of entries) {
    args.push("-e", `${key}=${String(value)}`);
  }

  return args;
}

function removeTerminalProviderState(providerState) {
  if (!providerState || typeof providerState !== "object") {
    return null;
  }

  const {
    terminalBackend: _terminalBackend,
    tmuxSessionName: _tmuxSessionName,
    ...rest
  } = providerState;

  return Object.keys(rest).length > 0 ? rest : null;
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
  let escapeState = "";
  let escapeSequenceLength = 0;
  let interrupted = false;

  for (const character of String(input ?? "").replace(/\r\n/g, "\r")) {
    if (escapeState) {
      escapeSequenceLength += 1;

      if (escapeState === "start") {
        if (character === "[") {
          escapeState = "control";
          continue;
        }

        if (character === "]") {
          escapeState = "osc";
          continue;
        }

        if (character === "P" || character === "^" || character === "_") {
          escapeState = "string";
          continue;
        }

        if ((character >= "@" && character <= "~") || escapeSequenceLength >= 128) {
          escapeState = "";
          escapeSequenceLength = 0;
        }
        continue;
      }

      if (escapeState === "control") {
        if ((character >= "@" && character <= "~") || escapeSequenceLength >= 128) {
          escapeState = "";
          escapeSequenceLength = 0;
        }
        continue;
      }

      if (escapeState === "osc" || escapeState === "string") {
        if (character === "\u0007") {
          escapeState = "";
          escapeSequenceLength = 0;
        } else if (character === "\u001b") {
          escapeState = "string-esc";
        } else if (escapeSequenceLength >= 512) {
          escapeState = "";
          escapeSequenceLength = 0;
        }
        continue;
      }

      if (escapeState === "string-esc") {
        if (character === "\\") {
          escapeState = "";
          escapeSequenceLength = 0;
        } else {
          escapeState = "string";
        }
        continue;
      }

      continue;
    }

    if (character === "\u001b") {
      escapeState = "start";
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

function normalizeTerminalText(value) {
  return String(value || "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, " ")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/\x1B[@-Z\\-_]/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSessionTimestamp(value, fallback) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeInitialPrompt(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r+$/g, "")
    .trimEnd();
}

function normalizePromptDelayMs(value, fallback = INITIAL_PROMPT_DELAY_MS) {
  if (value == null || value === "") {
    return Math.max(0, Number(fallback) || 0);
  }

  return Math.max(0, Number(value) || 0);
}

function hasClaudeWorkspaceTrustPrompt(buffer) {
  const text = normalizeTerminalText(buffer);
  return /Quick\s*safety\s*check|Yes,\s*I\s*trust\s*this\s*folder|Claude\s*Code'll\s*be\s*able\s*to\s*read/i.test(text);
}

function providerHasReadyHint(providerId, buffer) {
  const text = normalizeTerminalText(buffer);
  if (!text) {
    return false;
  }

  if (isClaudeProviderId(providerId)) {
    if (hasClaudeWorkspaceTrustPrompt(text)) {
      return false;
    }
    return /Claude\s*Code\s*v|bypass\s*permissions|❯|Welcome back/i.test(text);
  }

  if (providerId === "codex") {
    return /Ask for follow-up changes|Full access|GPT-|❯|›/i.test(text);
  }

  if (providerId === "gemini") {
    return /Gemini|Type your message|❯|>/i.test(text);
  }

  if (providerId === "opencode") {
    return /OpenCode\s*v|opencode\s*v|❯|>/i.test(text);
  }

  if (providerId === "ml-intern") {
    return /ML\s*Intern|Hugging\s*Face\s*Agent|>\s*$/i.test(text);
  }

  if (providerId === "openclaw") {
    return /OpenClaw|Molty|lobster|tui|>\s*$/i.test(text);
  }

  return true;
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

  if (isClaudeProviderId(provider.id) || provider.id === "codex") {
    return path.join(helperBinDir, provider.command || provider.id);
  }

  return provider.launchCommand || provider.command || null;
}

function getDefaultAgentThreadLimit(env) {
  if (isDisabledFlag(env?.VIBE_RESEARCH_AGENT_THREAD_LIMIT || env?.REMOTE_VIBES_AGENT_THREAD_LIMIT)) {
    return null;
  }

  const configuredLimit = Number(env?.VIBE_RESEARCH_AGENT_THREAD_LIMIT || env?.REMOTE_VIBES_AGENT_THREAD_LIMIT);
  if (Number.isInteger(configuredLimit) && configuredLimit > 0) {
    return String(configuredLimit);
  }

  const totalMemoryGiB = os.totalmem() / (1024 ** 3);
  if (totalMemoryGiB > 6) {
    return null;
  }

  const availableCores = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
  return String(Math.max(1, Math.min(2, availableCores || 1)));
}

function buildResourceLimitEnv(env) {
  const threadLimit = getDefaultAgentThreadLimit(env);
  if (!threadLimit) {
    return {};
  }

  return Object.fromEntries(
    RESOURCE_THREAD_ENV_KEYS
      .filter((key) => env?.[key] == null || env[key] === "")
      .map((key) => [key, threadLimit]),
  );
}

function getClaudeProviderLaunchArgs(provider, env = process.env) {
  return isClaudeOllamaProviderId(provider?.id)
    ? ["--model", getClaudeOllamaModel(env)]
    : [];
}

export function buildSessionEnv(
  sessionId,
  providerId,
  providersOrWorkspaceRoot = [],
  workspaceRoot = appRootDir,
  stateDir = null,
  baseEnv = process.env,
  wikiRootPath = null,
  systemRootPath = null,
) {
  const providers = Array.isArray(providersOrWorkspaceRoot) ? providersOrWorkspaceRoot : [];
  const resolvedWorkspaceRoot = Array.isArray(providersOrWorkspaceRoot)
    ? workspaceRoot
    : providersOrWorkspaceRoot || workspaceRoot;
  const env = baseEnv && typeof baseEnv === "object" ? baseEnv : process.env;
  const resolvedStateDir =
    stateDir ||
    (Array.isArray(providersOrWorkspaceRoot)
      ? getVibeResearchStateDir({ cwd: resolvedWorkspaceRoot, env })
      : getLegacyWorkspaceStateDir(resolvedWorkspaceRoot));
  const resolvedWikiRootPath = wikiRootPath || path.join(resolvedStateDir, "wiki");
  const resolvedSystemRootPath = path.resolve(
    resolvedWorkspaceRoot,
    systemRootPath || getVibeResearchSystemDir({
      cwd: resolvedWorkspaceRoot,
      env,
      stateDir: resolvedStateDir,
    }),
  );
  const commsDir = path.join(resolvedSystemRootPath, "comms");
  const buildingGuidesDir = getBuildingAgentGuidesDir(resolvedSystemRootPath);
  const buildingGuidesIndex = getBuildingAgentGuideIndexPath(resolvedSystemRootPath);
  const agentDir = path.join(commsDir, "agents", sessionId);
  const { NO_COLOR: _noColor, ...colorCapableEnv } = env;
  const providerSpecificEnv = buildProviderSpecificSessionEnv(providerId, colorCapableEnv);

  return {
    ...colorCapableEnv,
    ...buildResourceLimitEnv(colorCapableEnv),
    ...providerSpecificEnv,
    CLICOLOR: "1",
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: prependPathEntries(env.PATH, preferredCliBinDirs),
    PWCLI: "vr-playwright",
    VIBE_RESEARCH_APP_ROOT: appRootDir,
    VIBE_RESEARCH_BROWSER_COMMAND: "vr-playwright",
    VIBE_RESEARCH_BROWSER_FALLBACK_COMMAND: "vr-browser",
    VIBE_RESEARCH_BROWSER_USE_COMMAND: "vr-browser-use",
    VIBE_RESEARCH_OTTOAUTH_COMMAND: "vr-ottoauth",
    VIBE_RESEARCH_VIDEOMEMORY_COMMAND: "vr-videomemory",
    VIBE_RESEARCH_BROWSER_DESCRIBE:
      "vr-browser describe 4173 --prompt \"What visual issues stand out in the rendered UI?\"",
    VIBE_RESEARCH_BROWSER_HELP: "vr-playwright open http://127.0.0.1:4173 && vr-playwright snapshot",
    VIBE_RESEARCH_BROWSER_RUN_HELP:
      "vr-playwright open http://127.0.0.1:4173 && vr-playwright snapshot && vr-playwright click eX",
    VIBE_RESEARCH_BROWSER_IMAGE_HELP:
      "vr-browser describe-file results/chart.png --prompt \"What does this output show and what should improve?\"",
    VIBE_RESEARCH_BUILDING_GUIDES_DIR: buildingGuidesDir,
    VIBE_RESEARCH_BUILDING_GUIDES_INDEX: buildingGuidesIndex,
    VIBE_RESEARCH_BUILDING_GUIDES_HELP:
      "sed -n '1,220p' \"$VIBE_RESEARCH_BUILDING_GUIDES_INDEX\"",
    VIBE_RESEARCH_ML_INTERN_HANDOFF_PROMPT: mlInternHandoffPromptPath,
    VIBE_RESEARCH_ML_INTERN_HELP: "ml-intern \"$(cat \\\"$VIBE_RESEARCH_ML_INTERN_HANDOFF_PROMPT\\\")\"",
    VIBE_RESEARCH_PLAYWRIGHT_COMMAND: "vr-playwright",
    VIBE_RESEARCH_PLAYWRIGHT_SKILL: path.join(appRootDir, "skills", "playwright", "SKILL.md"),
    VIBE_RESEARCH_REAL_CLAUDE_COMMAND: getResolvedProviderCommand(providers, "claude") || "",
    VIBE_RESEARCH_REAL_CODEX_COMMAND: getResolvedProviderCommand(providers, "codex") || "",
    VIBE_RESEARCH_ROOT: resolvedStateDir,
    VIBE_RESEARCH_SYSTEM_DIR: resolvedSystemRootPath,
    VIBE_RESEARCH_AGENT_PROMPT_PATH: path.join(resolvedStateDir, AGENT_PROMPT_FILENAME),
    VIBE_RESEARCH_PROVIDER: providerId,
    VIBE_RESEARCH_SESSION_ID: sessionId,
    VIBE_RESEARCH_WIKI_DIR: resolvedWikiRootPath,
    VIBE_RESEARCH_COMMS_DIR: commsDir,
    VIBE_RESEARCH_AGENT_DIR: agentDir,
    VIBE_RESEARCH_AGENT_ENV_FILE: path.join(agentDir, "env.sh"),
    VIBE_RESEARCH_AGENT_INBOX: path.join(agentDir, "inbox"),
    VIBE_RESEARCH_AGENT_PROCESSED_DIR: path.join(agentDir, "processed"),
    VIBE_RESEARCH_AGENT_CANVAS_HELP:
      "vr-agent-canvas --image results/chart.png --title \"Latest graph\" --caption \"Best qualitative result so far.\"",
    VIBE_RESEARCH_AGENT_CANVAS_COMMAND: "vr-agent-canvas",
    VIBE_RESEARCH_AGENTMAIL_REPLY_COMMAND: "vr-agentmail-reply",
    VIBE_RESEARCH_TELEGRAM_REPLY_COMMAND: "vr-telegram-reply",
    VIBE_RESEARCH_MAIL_WATCHER: "vr-mailwatch",
    REMOTE_VIBES_APP_ROOT: appRootDir,
    REMOTE_VIBES_BROWSER_COMMAND: "rv-playwright",
    REMOTE_VIBES_BROWSER_FALLBACK_COMMAND: "rv-browser",
    REMOTE_VIBES_BROWSER_USE_COMMAND: "rv-browser-use",
    REMOTE_VIBES_OTTOAUTH_COMMAND: "rv-ottoauth",
    REMOTE_VIBES_VIDEOMEMORY_COMMAND: "rv-videomemory",
    REMOTE_VIBES_PLAYWRIGHT_COMMAND: "rv-playwright",
    REMOTE_VIBES_PLAYWRIGHT_SKILL: path.join(appRootDir, "skills", "playwright", "SKILL.md"),
    REMOTE_VIBES_BUILDING_GUIDES_DIR: buildingGuidesDir,
    REMOTE_VIBES_BUILDING_GUIDES_INDEX: buildingGuidesIndex,
    REMOTE_VIBES_BUILDING_GUIDES_HELP:
      "sed -n '1,220p' \"$REMOTE_VIBES_BUILDING_GUIDES_INDEX\"",
    REMOTE_VIBES_REAL_CLAUDE_COMMAND: getResolvedProviderCommand(providers, "claude") || "",
    REMOTE_VIBES_REAL_CODEX_COMMAND: getResolvedProviderCommand(providers, "codex") || "",
    REMOTE_VIBES_ROOT: resolvedStateDir,
    REMOTE_VIBES_SYSTEM_DIR: resolvedSystemRootPath,
    REMOTE_VIBES_AGENT_PROMPT_PATH: path.join(resolvedStateDir, AGENT_PROMPT_FILENAME),
    REMOTE_VIBES_PROVIDER: providerId,
    REMOTE_VIBES_SESSION_ID: sessionId,
    REMOTE_VIBES_WIKI_DIR: resolvedWikiRootPath,
    REMOTE_VIBES_COMMS_DIR: commsDir,
    REMOTE_VIBES_AGENT_DIR: agentDir,
    REMOTE_VIBES_AGENT_ENV_FILE: path.join(agentDir, "env.sh"),
    REMOTE_VIBES_AGENT_INBOX: path.join(agentDir, "inbox"),
    REMOTE_VIBES_AGENT_PROCESSED_DIR: path.join(agentDir, "processed"),
    REMOTE_VIBES_AGENT_CANVAS_HELP:
      "rv-agent-canvas --image results/chart.png --title \"Latest graph\" --caption \"Best qualitative result so far.\"",
    REMOTE_VIBES_AGENT_CANVAS_COMMAND: "rv-agent-canvas",
    REMOTE_VIBES_AGENTMAIL_REPLY_COMMAND: "rv-agentmail-reply",
    REMOTE_VIBES_TELEGRAM_REPLY_COMMAND: "rv-telegram-reply",
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
  return `\r\n\u001b[1;31m[vibe-research]\u001b[0m ${message}\r\n`;
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

function getProviderCredentialEntries(env) {
  return PROVIDER_CREDENTIAL_ENV_KEYS
    .map((key) => [key, env?.[key]])
    .filter(([, value]) => value != null && String(value) !== "");
}

function writeProviderCredentialEnvFile(env) {
  const envFilePath = String(env?.VIBE_RESEARCH_AGENT_ENV_FILE || "").trim();
  const entries = getProviderCredentialEntries(env);

  if (!envFilePath) {
    return;
  }

  if (!entries.length) {
    rmSync(envFilePath, { force: true });
    return;
  }

  const body = [
    "# Vibe Research agent credentials. Local file; do not commit.",
    ...entries.map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    "",
  ].join("\n");

  mkdirSync(path.dirname(envFilePath), { recursive: true });
  writeFileSync(envFilePath, body, { encoding: "utf8", mode: 0o600 });
  chmodSync(envFilePath, 0o600);
}

function withProviderCredentialEnvFile(commandString, env) {
  const envFilePath = String(env?.VIBE_RESEARCH_AGENT_ENV_FILE || "").trim();
  if (!commandString || !envFilePath || !getProviderCredentialEntries(env).length) {
    return commandString;
  }

  return `. ${shellQuote(envFilePath)}; ${commandString}`;
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

function getClaudeSessionIdsForSession(session) {
  return Array.from(
    new Set(
      [session?.providerState?.sessionId, session?.id]
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  );
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

function truncateSwarmText(value, maxLength = 96) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(1, maxLength - 1)).trim()}…`;
}

function normalizeToolPathCandidate(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 240 || /[\n\r]/.test(text)) {
    return "";
  }

  return text.replace(/^file:\/\//i, "");
}

function collectClaudeToolReferences(content) {
  const paths = [];
  const commands = [];

  if (!Array.isArray(content)) {
    return { paths, commands };
  }

  const pathKeys = new Set(["file_path", "filepath", "path", "relative_path", "relativePath", "cwd", "root"]);

  for (const entry of content) {
    if (entry?.type !== "tool_use" || !entry.input || typeof entry.input !== "object") {
      continue;
    }

    for (const [key, value] of Object.entries(entry.input)) {
      if (key === "command" && typeof value === "string") {
        const command = truncateSwarmText(value);
        if (command) {
          commands.push(command);
        }
        continue;
      }

      if (!pathKeys.has(key) || typeof value !== "string") {
        continue;
      }

      const pathCandidate = normalizeToolPathCandidate(value);
      if (pathCandidate) {
        paths.push(pathCandidate);
      }
    }
  }

  return {
    paths: Array.from(new Set(paths)),
    commands: Array.from(new Set(commands)),
  };
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
  const touchedPaths = [];
  const commands = [];

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
      const references = collectClaudeToolReferences(content);
      touchedPaths.push(...references.paths);
      commands.push(...references.commands);
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
    paths: Array.from(new Set(touchedPaths)).slice(0, SWARM_GRAPH_MAX_PATHS),
    commands: Array.from(new Set(commands)).slice(0, 8),
  };
}

function listClaudeSubagentsForSession(session, homeDirOrEnv = process.env) {
  if (!isClaudeProviderId(session?.providerId)) {
    return [];
  }

  const projectDir = getClaudeProjectDirForCwd(session.cwd, homeDirOrEnv);
  if (!projectDir) {
    return [];
  }

  const claudeSessionIds = getClaudeSessionIdsForSession(session);

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
        source: "claude",
        status: summary.status,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        promptId: summary.promptId,
        messageCount: summary.messageCount,
        toolUseCount: summary.toolUseCount,
        paths: summary.paths || [],
        commands: summary.commands || [],
      });
    }
  }

  return subagents
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
    .slice(0, 12);
}

function readFileTailSync(filePath, byteLimit) {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return "";
  }

  const size = Number(stats.size || 0);
  if (size <= 0) {
    return "";
  }

  const length = Math.min(size, byteLimit);
  const start = Math.max(0, size - length);
  const buffer = Buffer.alloc(length);
  let fd = null;

  try {
    fd = openSync(filePath, "r");
    const bytesRead = readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8", 0, bytesRead);
    if (start === 0) {
      return text;
    }

    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best effort cleanup for read-only transcript inspection.
      }
    }
  }
}

function getClaudeTranscriptPathsForSession(session, homeDirOrEnv = process.env) {
  if (!isClaudeProviderId(session?.providerId)) {
    return [];
  }

  const projectDir = getClaudeProjectDirForCwd(session.cwd, homeDirOrEnv);
  if (!projectDir) {
    return [];
  }

  return getClaudeSessionIdsForSession(session)
    .map((claudeSessionId) => path.join(projectDir, `${claudeSessionId}.jsonl`))
    .filter((transcriptPath) => {
      try {
        return statSync(transcriptPath).isFile();
      } catch {
        return false;
      }
    });
}

function getClaudeMessageText(payload) {
  const content = payload?.message?.content ?? payload?.content ?? "";
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (typeof entry?.text === "string") {
        return entry.text;
      }
      if (typeof entry?.content === "string") {
        return entry.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseTaskIdFromText(text) {
  const content = String(text || "");
  return (
    content.match(/<task-id>([^<]+)<\/task-id>/i)?.[1]
    || content.match(/\btask\s+([a-z0-9]+)\b/i)?.[1]
    || content.match(/Command running in background with ID:\s*([a-z0-9]+)/i)?.[1]
    || content.match(/Successfully stopped task:\s*([^\s(]+)/i)?.[1]
    || ""
  );
}

function parseClaudeTaskStart(text, toolUseResult = null) {
  const content = String(text || "");
  const backgroundShellId = (
    typeof toolUseResult?.backgroundTaskId === "string"
      ? toolUseResult.backgroundTaskId
      : content.match(/Command running in background with ID:\s*([a-z0-9]+)/i)?.[1]
  ) || "";
  if (backgroundShellId) {
    return {
      taskId: backgroundShellId,
      timeoutMs: 0,
      persistent: true,
      taskType: "bash",
    };
  }

  const looksLikeBackgroundTask = (
    /Monitor started/i.test(content)
    || (typeof toolUseResult?.taskId === "string" && (toolUseResult.persistent === true || toolUseResult.timeoutMs != null))
  );
  if (!looksLikeBackgroundTask) {
    return null;
  }

  const taskId = toolUseResult?.taskId || content.match(/Monitor started\s*\(\s*task\s+([^,\s)]+)/i)?.[1] || "";
  if (!taskId) {
    return null;
  }

  const timeoutText = content.match(/timeout\s+(\d+)ms/i)?.[1];
  const timeoutMs = Number(toolUseResult?.timeoutMs ?? timeoutText ?? 0);
  const persistent = Boolean(toolUseResult?.persistent) || /persistent/i.test(content);

  return {
    taskId,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 0,
    persistent,
    taskType: "monitor",
  };
}

function getClaudeTaskNotificationStatus(text) {
  const content = String(text || "");
  if (!/<task-notification>/i.test(content) && !content.includes("Monitor timed out")) {
    return "";
  }

  const status = content.match(/<status>([^<]+)<\/status>/i)?.[1]?.trim().toLowerCase() || "";
  if (["failed", "complete", "completed", "done", "cancelled", "canceled", "stopped"].includes(status)) {
    return "done";
  }

  if (/Monitor timed out|script failed|Successfully stopped task|No task found/i.test(content)) {
    return "done";
  }

  return "working";
}

function setClaudeBackgroundTaskState(tasks, taskId, patch) {
  if (!taskId) {
    return;
  }

  const existing = tasks.get(taskId) || { taskId };
  tasks.set(taskId, { ...existing, ...patch, taskId });
}

function applyClaudeBackgroundTaskEvent(tasks, payload) {
  const timestampMs = Date.parse(payload?.timestamp || "") || 0;
  const timestamp = timestampMs ? new Date(timestampMs).toISOString() : null;
  const text = [
    getClaudeMessageText(payload),
    typeof payload?.content === "string" ? payload.content : "",
    typeof payload?.toolUseResult?.message === "string" ? payload.toolUseResult.message : "",
  ].filter(Boolean).join("\n");

  const start = parseClaudeTaskStart(text, payload?.toolUseResult);
  if (start) {
    setClaudeBackgroundTaskState(tasks, start.taskId, {
      status: "working",
      startedAt: timestamp,
      startedAtMs: timestampMs,
      updatedAt: timestamp,
      updatedAtMs: timestampMs,
      timeoutMs: start.timeoutMs,
      persistent: start.persistent,
      taskType: start.taskType,
    });
  }

  const notificationStatus = getClaudeTaskNotificationStatus(text);
  const notifiedTaskId = parseTaskIdFromText(text);
  if (notificationStatus && notifiedTaskId) {
    setClaudeBackgroundTaskState(tasks, notifiedTaskId, {
      status: notificationStatus,
      updatedAt: timestamp,
      updatedAtMs: timestampMs,
    });
  }

  const stoppedTaskId = text.match(/Successfully stopped task:\s*([^\s(]+)/i)?.[1];
  if (stoppedTaskId) {
    setClaudeBackgroundTaskState(tasks, stoppedTaskId, {
      status: "done",
      stoppedAt: timestamp,
      updatedAt: timestamp,
      updatedAtMs: timestampMs,
    });
  }
}

function isClaudeBackgroundTaskActive(task, now = Date.now()) {
  if (!task || task.status !== "working") {
    return false;
  }

  const startedAtMs = Number(task.startedAtMs || 0);
  const updatedAtMs = Number(task.updatedAtMs || startedAtMs || 0);
  const timeoutMs = Number(task.timeoutMs || 0);

  if (!task.persistent && timeoutMs > 0 && startedAtMs > 0) {
    return now <= startedAtMs + timeoutMs + CLAUDE_BACKGROUND_TASK_GRACE_MS;
  }

  if (updatedAtMs > 0) {
    return now - updatedAtMs <= CLAUDE_BACKGROUND_TASK_STALE_MS;
  }

  return false;
}

function pruneClaudeBackgroundTaskSummaryCache() {
  const maxEntries = 200;
  while (claudeBackgroundTaskSummaryCache.size > maxEntries) {
    const oldestKey = claudeBackgroundTaskSummaryCache.keys().next().value;
    claudeBackgroundTaskSummaryCache.delete(oldestKey);
  }
}

function readClaudeBackgroundTasksFromTranscript(transcriptPath) {
  let stats;
  try {
    stats = statSync(transcriptPath);
  } catch {
    return [];
  }

  const cached = claudeBackgroundTaskSummaryCache.get(transcriptPath);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    return cached.tasks;
  }

  const tasks = new Map();
  const text = readFileTailSync(transcriptPath, CLAUDE_BACKGROUND_TASK_TAIL_BYTES);
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      applyClaudeBackgroundTaskEvent(tasks, JSON.parse(line));
    } catch {
      // Ignore malformed or truncated transcript lines.
    }
  }

  const taskList = Array.from(tasks.values());
  claudeBackgroundTaskSummaryCache.set(transcriptPath, {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    tasks: taskList,
  });
  pruneClaudeBackgroundTaskSummaryCache();
  return taskList;
}

function summarizeClaudeBackgroundTasksForSession(session, homeDirOrEnv = process.env) {
  if (!isClaudeProviderId(session?.providerId) || session?.status === "exited") {
    return { active: false, activeCount: 0, updatedAt: null };
  }

  const taskList = getClaudeTranscriptPathsForSession(session, homeDirOrEnv)
    .flatMap((transcriptPath) => readClaudeBackgroundTasksFromTranscript(transcriptPath));
  const activeTasks = taskList.filter((task) => isClaudeBackgroundTaskActive(task));
  const latestUpdatedAtMs = Math.max(
    0,
    ...taskList.map((task) => Number(task.updatedAtMs || task.startedAtMs || 0)),
  );

  return {
    active: activeTasks.length > 0,
    activeCount: activeTasks.length,
    updatedAt: latestUpdatedAtMs > 0 ? new Date(latestUpdatedAtMs).toISOString() : null,
  };
}

function parseGitWorktreePorcelain(output) {
  const worktrees = [];
  let current = null;

  const pushCurrent = () => {
    if (current?.path) {
      worktrees.push(current);
    }
    current = null;
  };

  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      pushCurrent();
      continue;
    }

    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") {
      pushCurrent();
      current = { path: value, head: "", branch: "", detached: false, bare: false };
    } else if (current && key === "HEAD") {
      current.head = value;
    } else if (current && key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (current && key === "detached") {
      current.detached = true;
    } else if (current && key === "bare") {
      current.bare = true;
    }
  }

  pushCurrent();
  return worktrees;
}

async function runGit(cwd, args) {
  return execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: SWARM_GRAPH_GIT_TIMEOUT_MS,
    maxBuffer: 512 * 1024,
  });
}

async function collectGitSwarmInfo(cwd) {
  const normalizedCwd = resolveCwd(cwd, process.cwd());

  try {
    const { stdout: rootStdout } = await runGit(normalizedCwd, ["rev-parse", "--show-toplevel"]);
    const root = rootStdout.trim();
    const [
      branchResult,
      headResult,
      statusResult,
      worktreeResult,
      remoteResult,
    ] = await Promise.allSettled([
      runGit(root, ["branch", "--show-current"]),
      runGit(root, ["rev-parse", "--short", "HEAD"]),
      runGit(root, ["status", "--porcelain"]),
      runGit(root, ["worktree", "list", "--porcelain"]),
      runGit(root, ["remote", "get-url", "origin"]),
    ]);
    const branch = branchResult.status === "fulfilled" ? branchResult.value.stdout.trim() : "";
    const head = headResult.status === "fulfilled" ? headResult.value.stdout.trim() : "";
    const statusLines = statusResult.status === "fulfilled"
      ? statusResult.value.stdout.split(/\r?\n/).filter(Boolean)
      : [];
    const parsedWorktrees = worktreeResult.status === "fulfilled"
      ? parseGitWorktreePorcelain(worktreeResult.value.stdout)
      : [];
    const worktrees = parsedWorktrees.length
      ? parsedWorktrees
      : [{ path: root, head, branch, detached: !branch, bare: false }];

    return {
      isRepository: true,
      root,
      branch,
      head,
      dirtyCount: statusLines.length,
      remote: remoteResult.status === "fulfilled" ? remoteResult.value.stdout.trim() : "",
      worktrees: worktrees.map((worktree) => ({
        ...worktree,
        name: path.basename(worktree.path) || worktree.path,
        current: isPathInside(worktree.path, normalizedCwd),
        headShort: String(worktree.head || "").slice(0, 7),
      })),
    };
  } catch {
    return {
      isRepository: false,
      root: normalizedCwd,
      branch: "",
      head: "",
      dirtyCount: null,
      remote: "",
      worktrees: [{ path: normalizedCwd, name: path.basename(normalizedCwd) || normalizedCwd, current: true }],
    };
  }
}

function isPathInside(parentPath, childPath) {
  const normalizedParent = normalizeComparablePath(parentPath);
  const normalizedChild = normalizeComparablePath(childPath);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
}

function normalizeComparablePath(value) {
  const resolvedPath = path.resolve(value);

  try {
    return realpathSync.native ? realpathSync.native(resolvedPath) : realpathSync(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function getWorktreeForCwd(gitInfo, cwd) {
  return (gitInfo.worktrees || []).find((worktree) => isPathInside(worktree.path, cwd)) || gitInfo.worktrees?.[0] || null;
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

function normalizeSessionOccupationId(occupationId, fallback = "researcher") {
  const normalized = String(occupationId || "").trim().toLowerCase();
  return normalized || fallback;
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
    env = process.env,
    stateDir = getVibeResearchStateDir({ cwd, env }),
    wikiRootPath = path.join(stateDir, "wiki"),
    systemRootPath = getVibeResearchSystemDir({ cwd, env, stateDir }),
    agentRunStore = null,
    runIdleTimeoutMs = Number(process.env.VIBE_RESEARCH_RUN_IDLE_MS || process.env.REMOTE_VIBES_RUN_IDLE_MS || 15_000),
    sessionActivityIdleMs = SESSION_ACTIVITY_IDLE_MS,
    persistentTerminals = true,
    extraSubagentsProvider = null,
    occupationId = "researcher",
    userHomeDir = env?.HOME || os.homedir(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    initialPromptDelayMs = INITIAL_PROMPT_DELAY_MS,
    initialPromptReadyIdleMs = INITIAL_PROMPT_READY_IDLE_MS,
    initialPromptReadyTimeoutMs = INITIAL_PROMPT_READY_TIMEOUT_MS,
    initialPromptRetryMs = INITIAL_PROMPT_RETRY_MS,
    initialPromptSubmitDelayMs = INITIAL_PROMPT_SUBMIT_DELAY_MS,
  }) {
    this.cwd = cwd;
    this.providers = providers;
    this.persistSessions = persistSessions;
    this.stateDir = stateDir;
    this.wikiRootPath = wikiRootPath;
    this.systemRootPath = path.resolve(cwd, systemRootPath);
    this.env = env && typeof env === "object" ? { ...env } : { ...process.env };
    this.persistentTerminals = Boolean(persistentTerminals);
    this.extraSubagentsProvider = typeof extraSubagentsProvider === "function" ? extraSubagentsProvider : null;
    this.occupationId = normalizeSessionOccupationId(occupationId);
    this.tmuxAvailable = null;
    this.tmuxEnvironmentArgsAvailable = null;
    this.userHomeDir = getProviderHomeDir(userHomeDir);
    this.sessionActivityIdleMs = Math.max(500, Number(sessionActivityIdleMs) || SESSION_ACTIVITY_IDLE_MS);
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.initialPromptDelayMs = Math.max(0, Number(initialPromptDelayMs) || 0);
    this.initialPromptReadyIdleMs = Math.max(0, Number(initialPromptReadyIdleMs) || 0);
    this.initialPromptReadyTimeoutMs = Math.max(0, Number(initialPromptReadyTimeoutMs) || 0);
    this.initialPromptRetryMs = Math.max(1, Number(initialPromptRetryMs) || INITIAL_PROMPT_RETRY_MS);
    this.initialPromptSubmitDelayMs = Math.max(0, Number(initialPromptSubmitDelayMs) || 0);
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

  setDefaultCwd(cwd) {
    this.cwd = resolveCwd(cwd, this.cwd);
    this.systemRootPath = path.resolve(this.cwd, this.systemRootPath);
  }

  setEnvironment(env = process.env) {
    this.env = env && typeof env === "object" ? { ...env } : { ...process.env };
    this.tmuxAvailable = null;
    this.tmuxEnvironmentArgsAvailable = null;
  }

  setSystemRootPath(systemRootPath) {
    this.systemRootPath = path.resolve(this.cwd, systemRootPath);
  }

  setExtraSubagentsProvider(extraSubagentsProvider) {
    this.extraSubagentsProvider =
      typeof extraSubagentsProvider === "function" ? extraSubagentsProvider : null;
  }

  setOccupationId(occupationId) {
    this.occupationId = normalizeSessionOccupationId(occupationId, this.occupationId);
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

  listProjectPaths() {
    const projectPaths = new Set();

    for (const session of this.sessions.values()) {
      const sessionCwd = resolveCwd(session.cwd, this.cwd);
      if (sessionCwd) {
        projectPaths.add(sessionCwd);
      }
    }

    return Array.from(projectPaths).sort((left, right) => left.localeCompare(right));
  }

  listUsageSessions() {
    this.consumePendingRenameRequests();
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      name: session.name,
      providerId: session.providerId,
      providerLabel: session.providerLabel,
      status: session.status,
      activityStatus: session.activityStatus,
      activityStartedAt: session.activityStartedAt,
      lastPromptAt: session.lastPromptAt,
      updatedAt: session.updatedAt,
    }));
  }

  async getSessionSwarmGraph(sessionId) {
    this.consumePendingRenameRequests();
    const focusSession = this.sessions.get(sessionId);

    if (!focusSession) {
      return null;
    }

    return this.buildSwarmGraph(focusSession.cwd, { focusSession });
  }

  async getProjectSwarmGraph(cwd) {
    this.consumePendingRenameRequests();
    return this.buildSwarmGraph(cwd);
  }

  async buildSwarmGraph(cwd, { focusSession = null } = {}) {
    const git = await collectGitSwarmInfo(cwd);
    const focusCwd = resolveCwd(cwd, this.cwd);
    const focusForkParentId = focusSession?.providerState?.forkedFromSessionId || null;
    const relatedSessions = Array.from(this.sessions.values())
      .filter((session) => {
        const sessionCwd = resolveCwd(session.cwd, this.cwd);

        if (focusSession) {
          return (
            session.id === focusSession.id
            || sessionCwd === focusCwd
            || session.providerState?.forkedFromSessionId === focusSession.id
            || session.id === focusForkParentId
          );
        }

        return sessionCwd === focusCwd || (git.worktrees || []).some((worktree) => isPathInside(worktree.path, sessionCwd));
      })
      .sort((left, right) => {
        if (focusSession && left.id === focusSession.id) {
          return -1;
        }
        if (focusSession && right.id === focusSession.id) {
          return 1;
        }
        return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
      })
      .slice(0, SWARM_GRAPH_MAX_RELATED_SESSIONS);
    const seenSubagents = new Set();
    const serializedSessions = relatedSessions.map((session) => {
      const serialized = this.serializeSession(session);
      serialized.subagents = (serialized.subagents || []).filter((subagent) => {
        const key = `${subagent.parentProviderSessionId || ""}:${subagent.agentId || subagent.id || ""}`;
        if (seenSubagents.has(key)) {
          return false;
        }
        seenSubagents.add(key);
        return true;
      });
      return serialized;
    });
    const nodes = [];
    const edges = [];
    const pathNodes = new Map();
    const rootNodeId = git.isRepository ? "repo" : "folder-root";

    nodes.push({
      id: rootNodeId,
      type: git.isRepository ? "repo" : "folder",
      label: path.basename(git.root) || git.root,
      meta: git.isRepository
        ? [git.branch || "detached", git.head, git.dirtyCount ? `${git.dirtyCount} changed` : "clean"].filter(Boolean).join(" · ")
        : "not a git checkout",
      path: git.root,
      status: git.dirtyCount ? "dirty" : "clean",
    });

    for (const worktree of git.worktrees || []) {
      const nodeId = `worktree:${worktree.path}`;
      nodes.push({
        id: nodeId,
        type: "worktree",
        label: worktree.name || path.basename(worktree.path) || "worktree",
        meta: [worktree.branch || (worktree.detached ? "detached" : ""), worktree.headShort].filter(Boolean).join(" · "),
        path: worktree.path,
        status: worktree.current ? "current" : "idle",
      });
      edges.push({ from: rootNodeId, to: nodeId, type: "worktree" });
    }

    for (const [index, session] of serializedSessions.entries()) {
      const sessionRecord = relatedSessions[index];
      const worktree = getWorktreeForCwd(git, session.cwd);
      const sessionNodeId = `session:${session.id}`;
      const forkParentId = sessionRecord?.providerState?.forkedFromSessionId || null;
      nodes.push({
        id: sessionNodeId,
        type: "session",
        label: session.name || session.providerLabel || "session",
        meta: [session.providerLabel, path.basename(session.cwd || "")].filter(Boolean).join(" · "),
        path: session.cwd,
        status: session.activityStatus || session.status,
        focus: Boolean(focusSession && session.id === focusSession.id),
      });

      const forkParentInGraph = forkParentId && serializedSessions.some((entry) => entry.id === forkParentId);
      edges.push({
        from: forkParentInGraph ? `session:${forkParentId}` : worktree ? `worktree:${worktree.path}` : rootNodeId,
        to: sessionNodeId,
        type: forkParentInGraph ? "fork" : "session",
      });

      for (const subagent of session.subagents || []) {
        const subagentNodeId = `subagent:${session.id}:${subagent.id}`;
        nodes.push({
          id: subagentNodeId,
          type: "subagent",
          label: subagent.name || "Claude subagent",
          meta: [subagent.agentType, subagent.status, subagent.toolUseCount != null ? `${subagent.toolUseCount} tools` : ""]
            .filter(Boolean)
            .join(" · "),
          status: subagent.status,
          updatedAt: subagent.updatedAt,
        });
        edges.push({ from: sessionNodeId, to: subagentNodeId, type: "subagent" });

        for (const touchedPath of subagent.paths || []) {
          const label = truncateSwarmText(touchedPath, 42);
          const pathNodeId = `path:${touchedPath}`;
          if (!pathNodes.has(pathNodeId)) {
            pathNodes.set(pathNodeId, true);
            nodes.push({
              id: pathNodeId,
              type: "path",
              label,
              meta: "touched path",
              path: touchedPath,
              status: "path",
            });
          }
          edges.push({ from: subagentNodeId, to: pathNodeId, type: "touch" });
        }
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      sessionId: focusSession?.id || null,
      cwd: focusCwd,
      git,
      sessions: serializedSessions,
      nodes,
      edges,
    };
  }

  getSession(sessionId) {
    this.consumePendingRenameRequests();
    return this.sessions.get(sessionId) ?? null;
  }

  buildSessionEnvironment(session, providerId = session.providerId) {
    return buildSessionEnv(
      session.id,
      providerId,
      this.providers,
      this.cwd,
      this.stateDir,
      this.env,
      this.wikiRootPath,
      this.systemRootPath,
    );
  }

  isTmuxAvailable(env) {
    if (this.tmuxAvailable !== null) {
      return this.tmuxAvailable;
    }

    const command = getTmuxCommand(env);
    try {
      execFileSync(command, ["-V"], {
        env,
        stdio: "ignore",
        timeout: 1_500,
      });
      this.tmuxAvailable = true;
    } catch {
      this.tmuxAvailable = false;
    }

    return this.tmuxAvailable;
  }

  tmuxSupportsEnvironmentArgs(env) {
    if (this.tmuxEnvironmentArgsAvailable !== null) {
      return this.tmuxEnvironmentArgsAvailable;
    }

    try {
      const output = execFileSync(getTmuxCommand(env), ["-V"], {
        encoding: "utf8",
        env,
        timeout: 1_500,
      }).trim();
      const match = output.match(/\btmux\s+(\d+)\.(\d+)/i);
      const major = Number(match?.[1] || 0);
      const minor = Number(match?.[2] || 0);
      this.tmuxEnvironmentArgsAvailable = major > 3 || (major === 3 && minor >= 2);
    } catch {
      this.tmuxEnvironmentArgsAvailable = false;
    }

    return this.tmuxEnvironmentArgsAvailable;
  }

  tmuxSessionExists(sessionName, env) {
    if (!sessionName || !this.isTmuxAvailable(env)) {
      return false;
    }

    try {
      execFileSync(getTmuxCommand(env), ["has-session", "-t", sessionName], {
        env,
        stdio: "ignore",
        timeout: 1_500,
      });
      return true;
    } catch {
      return false;
    }
  }

  shouldRevivePersistentTerminal(session) {
    if (session?.restoreOnStartup || session?.providerState?.terminalBackend !== "tmux") {
      return false;
    }

    const tmuxSessionName = session.providerState?.tmuxSessionName;
    if (!tmuxSessionName) {
      return false;
    }

    return this.tmuxSessionExists(tmuxSessionName, this.buildSessionEnvironment(session));
  }

  tmuxSessionHasForegroundProvider(sessionName, env) {
    if (!sessionName || !this.isTmuxAvailable(env)) {
      return false;
    }

    try {
      const output = execFileSync(getTmuxCommand(env), [
        "list-panes",
        "-t",
        sessionName,
        "-F",
        "#{pane_current_command}",
      ], {
        encoding: "utf8",
        env,
        timeout: 1_500,
      });
      const commands = output
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean);

      return commands.some((command) => !IDLE_TERMINAL_COMMANDS.has(path.basename(command)));
    } catch {
      return false;
    }
  }

  killTmuxSessionByName(sessionName, env) {
    if (!sessionName || !this.isTmuxAvailable(env)) {
      return;
    }

    try {
      execFileSync(getTmuxCommand(env), ["kill-session", "-t", sessionName], {
        env,
        stdio: "ignore",
        timeout: 1_500,
      });
    } catch {
      // The tmux session may already be gone; cleanup should remain best effort.
    }
  }

  detachTmuxSessionClients(sessionName, env) {
    if (!sessionName || !this.isTmuxAvailable(env)) {
      return;
    }

    try {
      execFileSync(getTmuxCommand(env), ["detach-client", "-s", sessionName], {
        env,
        stdio: "ignore",
        timeout: 1_500,
      });
    } catch {
      // The tmux client may already be detached. Preserving the session matters
      // more than forcing cleanup during server shutdown.
    }
  }

  shouldUsePersistentTerminal(provider, env) {
    if (
      !this.persistentTerminals ||
      isDisabledFlag(this.env.VIBE_RESEARCH_PERSISTENT_TERMINALS) ||
      isDisabledFlag(this.env.VIBE_RESEARCH_PERSISTENT_TERMINAL) ||
      isDisabledFlag(this.env.REMOTE_VIBES_PERSISTENT_TERMINALS) ||
      isDisabledFlag(this.env.REMOTE_VIBES_PERSISTENT_TERMINAL) ||
      !PERSISTENT_TERMINAL_PROVIDER_IDS.has(provider.id)
    ) {
      return false;
    }

    if (provider.id !== "shell" && !provider.launchCommand) {
      return false;
    }

    return this.isTmuxAvailable(env) && this.tmuxSupportsEnvironmentArgs(env);
  }

  getTerminalLaunch(session, provider, env, sessionCwd) {
    if (!this.shouldUsePersistentTerminal(provider, env)) {
      return {
        args: getShellArgs(session.shell),
        attachedExisting: false,
        backend: null,
        command: session.shell,
        tmuxSessionName: null,
      };
    }

    const tmuxSessionName = session.providerState?.tmuxSessionName || getTmuxSessionName(session);
    const attachedExisting = this.tmuxSessionExists(tmuxSessionName, env);
    const providerRunning = attachedExisting
      ? this.tmuxSessionHasForegroundProvider(tmuxSessionName, env)
      : false;

    const tmuxEnvironmentArgs = attachedExisting ? [] : getTmuxEnvironmentArgs(env);
    return {
      args: attachedExisting
        ? ["attach-session", "-t", tmuxSessionName]
        : [
            "new-session",
            ...tmuxEnvironmentArgs,
            "-s",
            tmuxSessionName,
            "-c",
            sessionCwd,
            ";",
            "set-option",
            "-t",
            tmuxSessionName,
            "status",
            "off",
          ],
      attachedExisting,
      backend: "tmux",
      command: getTmuxCommand(env),
      providerRunning,
      tmuxSessionName,
    };
  }

  killPersistentTerminal(session) {
    const tmuxSessionName = session?.providerState?.tmuxSessionName || session?.tmuxSessionName;
    if (!tmuxSessionName) {
      return;
    }

    const env = this.buildSessionEnvironment(session);
    if (!this.isTmuxAvailable(env)) {
      return;
    }

    this.killTmuxSessionByName(tmuxSessionName, env);
  }

  listTmuxPaneProcessRoots(session) {
    const tmuxSessionName = session?.providerState?.tmuxSessionName;
    if (session?.providerState?.terminalBackend !== "tmux" || !tmuxSessionName) {
      return [];
    }

    const env = this.buildSessionEnvironment(session);
    if (!this.isTmuxAvailable(env)) {
      return [];
    }

    try {
      const output = execFileSync(getTmuxCommand(env), [
        "list-panes",
        "-t",
        tmuxSessionName,
        "-F",
        "#{pane_pid}",
      ], {
        encoding: "utf8",
        env,
        timeout: 1_500,
      });

      return output
        .split(/\r?\n/)
        .map((entry) => Number(entry.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
        .map((pid) => ({
          sessionId: session.id,
          providerId: session.providerId,
          pid,
          source: "tmux-pane",
        }));
    } catch {
      return [];
    }
  }

  listAgentProcessRoots() {
    const roots = [];

    for (const session of this.sessions.values()) {
      if (session.status !== "running") {
        continue;
      }

      if (session.pty?.pid) {
        roots.push({
          sessionId: session.id,
          providerId: session.providerId,
          pid: Number(session.pty.pid),
          source: "pty",
        });
      }

      roots.push(...this.listTmuxPaneProcessRoots(session));
    }

    const seen = new Set();
    return roots.filter((root) => {
      if (!Number.isInteger(root.pid) || root.pid <= 0 || seen.has(root.pid)) {
        return false;
      }

      seen.add(root.pid);
      return true;
    });
  }

  queueInitialPromptForSession(session, provider, prompt, { delayMs = this.initialPromptDelayMs } = {}) {
    const normalizedPrompt = normalizeInitialPrompt(prompt);
    const providerId = provider?.id || session?.providerId || "";
    if (!session?.id || !normalizedPrompt || providerId === "shell" || !provider?.launchCommand) {
      return false;
    }

    const startedAt = Date.now();
    const normalizedDelayMs = normalizePromptDelayMs(delayMs, this.initialPromptDelayMs);
    let answeredWorkspaceTrust = false;

    const submitPrompt = () => {
      const currentSession = this.sessions.get(session.id);
      if (currentSession !== session || session.status === "exited" || !session.pty) {
        return false;
      }

      if (isClaudeProviderId(providerId)) {
        const pasted = this.write(session.id, normalizedPrompt);
        if (!pasted) {
          return false;
        }

        this.setTimeoutFn(() => {
          const nextSession = this.sessions.get(session.id);
          if (nextSession !== session || session.status === "exited" || !session.pty) {
            return;
          }

          this.write(session.id, "\r");
        }, this.initialPromptSubmitDelayMs);
        return true;
      }

      return this.write(session.id, `${normalizedPrompt}\r`);
    };

    const attempt = () => {
      const currentSession = this.sessions.get(session.id);
      if (currentSession !== session || session.status === "exited" || !session.pty) {
        return;
      }

      const now = Date.now();
      const lastOutputAt = parseSessionTimestamp(session.lastOutputAt || session.updatedAt || session.createdAt, startedAt);
      const elapsedMs = now - startedAt;
      const idleMs = now - lastOutputAt;

      if (isClaudeProviderId(providerId) && !answeredWorkspaceTrust && hasClaudeWorkspaceTrustPrompt(session.buffer)) {
        answeredWorkspaceTrust = true;
        this.write(session.id, "1\r");
        this.setTimeoutFn(attempt, this.initialPromptRetryMs);
        return;
      }

      const isReady =
        elapsedMs >= normalizedDelayMs &&
        idleMs >= this.initialPromptReadyIdleMs &&
        providerHasReadyHint(providerId, session.buffer);

      if (isReady || elapsedMs >= this.initialPromptReadyTimeoutMs) {
        submitPrompt();
        return;
      }

      this.setTimeoutFn(attempt, this.initialPromptRetryMs);
    };

    this.setTimeoutFn(attempt, Math.min(this.initialPromptRetryMs, normalizedDelayMs));
    return true;
  }

  createSession({ providerId, name, cwd, occupationId, initialPrompt = "", initialPromptDelayMs = null }) {
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
      occupationId: occupationId || this.occupationId,
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

    this.queueInitialPromptForSession(session, provider, initialPrompt, {
      delayMs: initialPromptDelayMs,
    });

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
      occupationId: sourceSession.occupationId || this.occupationId,
      restoreOnStartup: true,
      buffer: [
        `\u001b[1;36m[vibe-research]\u001b[0m forked from: ${sourceSession.name}`,
        sharesProviderMemory
          ? `\u001b[1;36m[vibe-research]\u001b[0m resuming the source agent memory in the same cwd`
          : `\u001b[1;36m[vibe-research]\u001b[0m started in the same cwd; no provider memory id was available to resume`,
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

    const sourceProviderState = removeTerminalProviderState(sourceSession.providerState);
    const sourceProviderSessionId =
      sourceProviderState?.sessionId ||
      (isClaudeProviderId(sourceSession.providerId) ? sourceSession.id : null);

    if (!sourceProviderSessionId) {
      return sourceProviderState
        ? { ...sourceProviderState, forkedFromSessionId: sourceSession.id }
        : null;
    }

    return {
      ...(sourceProviderState || {}),
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

    this.killPersistentTerminal(session);

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
          if (session.providerState?.terminalBackend === "tmux") {
            this.detachTmuxSessionClients(session.providerState.tmuxSessionName, session.env || this.env);
          }

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
      console.warn("[vibe-research] failed to record agent run", error);
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
    const claudeSubagents = listClaudeSubagentsForSession(session, this.userHomeDir);
    let extraSubagents = [];
    if (this.extraSubagentsProvider) {
      try {
        const provided = this.extraSubagentsProvider(session);
        extraSubagents = Array.isArray(provided) ? provided : [];
      } catch (error) {
        console.warn("[vibe-research] failed to list extra subagents", error);
      }
    }
    const subagents = [...claudeSubagents, ...extraSubagents]
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
      .slice(0, 16);
    const backgroundActivity = summarizeClaudeBackgroundTasksForSession(session, this.userHomeDir);
    const hasActiveSubagent = subagents.some((subagent) => subagent.status === "working");
    const activityStatus = session.activityStatus === "working" || backgroundActivity.active || hasActiveSubagent
      ? "working"
      : session.activityStatus;

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
      occupationId: session.occupationId || this.occupationId,
      host: os.hostname(),
      lastPromptAt: session.lastPromptAt,
      activityStatus,
      activityStartedAt: session.activityStartedAt,
      activityCompletedAt: session.activityCompletedAt,
      backgroundActivity,
      subagents,
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
    occupationId = this.occupationId,
  }) {
    return {
      id,
      providerId,
      providerLabel,
      occupationId: normalizeSessionOccupationId(occupationId, this.occupationId),
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

    if (isClaudeProviderId(provider.id)) {
      const launchCommand = getManagedProviderLaunchCommand(provider);
      const claudeLaunchArgs = getClaudeProviderLaunchArgs(provider, this.env);
      this.setPendingProviderCapture(session, null);
      const fallbackSessionId = restored
        ? listClaudeSessionsForCwd(session.cwd, this.userHomeDir)[0]?.id || null
        : null;
      const sessionId = session.providerState?.sessionId || fallbackSessionId || (!restored ? session.id : null);

      if (sessionId) {
        this.updateProviderState(session, { sessionId });
      }

      const createCommand = buildShellCommand(launchCommand, [
        ...claudeLaunchArgs,
        CLAUDE_SKIP_PERMISSIONS_ARG,
        "--session-id",
        sessionId || session.id,
      ]);
      const resumeCommand = sessionId
        ? buildShellCommand(launchCommand, [...claudeLaunchArgs, CLAUDE_SKIP_PERMISSIONS_ARG, "--resume", sessionId])
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

    if (provider.id === "openclaw") {
      this.setPendingProviderCapture(session, null);
      return {
        commandString: buildShellCommand(provider.launchCommand, ["tui"]),
        afterLaunch: null,
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

    if (provider.id === "openclaw") {
      this.setPendingProviderCapture(session, null);
      return {
        commandString: buildShellCommand(provider.launchCommand, ["tui"]),
        afterLaunch: null,
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
          this.systemRootPath,
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

  async launchProvider(session, provider, ptyProcess, launchContextPromise, sessionEnv = null) {
    let launchContext = null;

    try {
      launchContext = await launchContextPromise;
    } catch {
      launchContext = null;
    }

    if (session.status !== "running" || session.pty !== ptyProcess) {
      return;
    }

    const commandString = withProviderCredentialEnvFile(
      launchContext?.commandString || buildShellCommand(provider.launchCommand),
      sessionEnv || this.buildSessionEnvironment(session, provider.id),
    );

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
            this.systemRootPath,
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
    const sessionEnv = this.buildSessionEnvironment(session, provider.id);
    writeProviderCredentialEnvFile(sessionEnv);
    const terminalLaunch = this.getTerminalLaunch(session, provider, sessionEnv, sessionCwd);

    const ptyProcess = pty.spawn(terminalLaunch.command, terminalLaunch.args, {
      cwd: sessionCwd,
      env: sessionEnv,
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
    if (terminalLaunch.backend === "tmux") {
      this.updateProviderState(session, {
        terminalBackend: "tmux",
        tmuxSessionName: terminalLaunch.tmuxSessionName,
      });
    }
    const launchContextPromise = this.prepareProviderLaunch(session, provider, { restored });

    const bannerLines = restored
      ? [
          "",
          `\u001b[1;36m[vibe-research]\u001b[0m session restored after restart`,
          `\u001b[1;36m[vibe-research]\u001b[0m cwd: ${sessionCwd}`,
          terminalLaunch.backend === "tmux"
            ? `\u001b[1;36m[vibe-research]\u001b[0m persistent terminal: ${terminalLaunch.attachedExisting ? "reattached" : "created"} ${terminalLaunch.tmuxSessionName}`
            : null,
          provider.launchCommand
            ? terminalLaunch.attachedExisting
              ? terminalLaunch.providerRunning
                ? `\u001b[1;36m[vibe-research]\u001b[0m provider is still running inside the persistent terminal`
                : `\u001b[1;36m[vibe-research]\u001b[0m persistent terminal reattached without relaunching, so shell jobs and monitors survive`
              : `\u001b[1;36m[vibe-research]\u001b[0m relaunching: ${provider.launchCommand}`
            : `\u001b[1;36m[vibe-research]\u001b[0m vanilla shell restored`,
          "",
        ].filter(Boolean)
      : [
          `\u001b[1;36m[vibe-research]\u001b[0m ${provider.label} session ready`,
          `\u001b[1;36m[vibe-research]\u001b[0m cwd: ${sessionCwd}`,
          terminalLaunch.backend === "tmux"
            ? `\u001b[1;36m[vibe-research]\u001b[0m persistent terminal: ${terminalLaunch.attachedExisting ? "reattached" : "created"} ${terminalLaunch.tmuxSessionName}`
            : null,
          '\u001b[1;36m[vibe-research]\u001b[0m browser skill: export PWCLI="${PWCLI:-vr-playwright}"; "$PWCLI" open http://127.0.0.1:4173',
          '\u001b[1;36m[vibe-research]\u001b[0m inspect UI: "$PWCLI" snapshot; use fresh refs with click/fill/type/press',
          '\u001b[1;36m[vibe-research]\u001b[0m save artifacts: "$PWCLI" screenshot --filename output/playwright/current.png',
          '\u001b[1;36m[vibe-research]\u001b[0m visual fallback: vr-browser describe-file results/chart.png --prompt "What should improve?"',
          '\u001b[1;36m[vibe-research]\u001b[0m building guides: sed -n \'1,220p\' "$VIBE_RESEARCH_BUILDING_GUIDES_INDEX"',
          provider.launchCommand
            ? terminalLaunch.attachedExisting
              ? terminalLaunch.providerRunning
                ? `\u001b[1;36m[vibe-research]\u001b[0m provider is already running inside the persistent terminal`
                : `\u001b[1;36m[vibe-research]\u001b[0m persistent terminal reattached without launching, so shell jobs and monitors survive`
              : `\u001b[1;36m[vibe-research]\u001b[0m launching: ${provider.launchCommand}`
            : `\u001b[1;36m[vibe-research]\u001b[0m vanilla shell active`,
          "",
        ].filter(Boolean);

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

      const tmuxSessionName = session.providerState?.tmuxSessionName;
      if (session.providerState?.terminalBackend === "tmux" && this.tmuxSessionExists(tmuxSessionName, sessionEnv)) {
        session.status = "running";
        session.exitCode = null;
        session.exitSignal = null;
        session.restoreOnStartup = true;
        session.updatedAt = new Date().toISOString();
        this.pushOutput(
          session,
          `\r\n\u001b[1;36m[vibe-research]\u001b[0m persistent terminal detached; reattaching ${tmuxSessionName}\r\n`,
        );
        this.scheduleSessionMetaBroadcast(session, { immediate: true });
        this.schedulePersist({ immediate: true });
        setTimeout(() => {
          if (session.status === "running" && !session.pty && this.sessions.get(session.id) === session) {
            try {
              this.startSession(session, provider, { restored: true });
            } catch (error) {
              this.markSessionRestoreFailure(session, `could not reattach persistent terminal: ${error.message}`);
            }
          }
        }, STARTUP_DELAY_MS);
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
        `\r\n\u001b[1;31m[vibe-research]\u001b[0m session exited (code ${exitCode}${signal ? `, signal ${signal}` : ""})\r\n`,
      );
      this.queueAgentRunTracking(this.agentRunTracker?.handleSessionExit(session));
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
      this.schedulePersist({ immediate: true });
    });

    if (provider.launchCommand && !terminalLaunch.attachedExisting) {
      setTimeout(() => {
        if (session.status === "running" && session.pty === ptyProcess) {
          void this.launchProvider(session, provider, ptyProcess, launchContextPromise, sessionEnv);
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
      occupationId: snapshot.occupationId || snapshot.promptId || this.occupationId,
    });

    this.sessions.set(session.id, session);

    const revivePersistentTerminal = this.shouldRevivePersistentTerminal(session);

    if (!session.restoreOnStartup && !revivePersistentTerminal) {
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

    if (revivePersistentTerminal) {
      session.restoreOnStartup = true;
      session.status = "running";
      this.pushOutput(
        session,
        `\r\n\u001b[1;36m[vibe-research]\u001b[0m persistent terminal still exists; reattaching ${session.providerState.tmuxSessionName}\r\n`,
      );
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

      void this.persistNow().catch((error) => {
        console.warn("[vibe-research] failed to persist sessions", error);
      });
      return;
    }

    if (this.persistTimer) {
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow().catch((error) => {
        console.warn("[vibe-research] failed to persist sessions", error);
      });
    }, SESSION_PERSIST_THROTTLE_MS);
  }

  async persistNow() {
    if (!this.persistSessions) {
      return;
    }

    let sessions;
    try {
      sessions = Array.from(this.sessions.values())
        .map((session) => this.serializePersistedSession(session))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      console.warn("[vibe-research] failed to serialize sessions", error);
      return;
    }

    this.persistPromise = this.persistPromise
      .catch(() => {})
      .then(() => this.sessionStore.save(sessions))
      .catch((error) => {
        console.warn("[vibe-research] failed to persist sessions", error);
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
