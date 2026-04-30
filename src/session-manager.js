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
  renameSync,
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
import {
  buildProjectedNarrative,
  classifyPromptEntry,
  loadProviderBackedNarrative,
} from "./session-native-narrative.js";
import {
  makeNarrativeEventFrame,
  makeNarrativeInitFrame,
  normaliseNarrativeEntry,
} from "./narrative-schema.js";
import { ClaudeStreamSession } from "./claude-stream-session.js";
import { CodexStreamSession } from "./codex-stream-session.js";
import { SessionStore } from "./session-store.js";
import { getLegacyWorkspaceStateDir, getVibeResearchStateDir, getVibeResearchSystemDir } from "./state-paths.js";
import { WorkspaceStore } from "./workspace-store.js";

const MAX_BUFFER_LENGTH = 512_000;
// Cap how much buffered scrollback we replay on attach. The full PTY buffer can
// reach MAX_BUFFER_LENGTH, but parsing megabytes of ANSI in the browser's main
// thread freezes input handling — see attachClient. 256 KB is roughly the last
// few thousand visible lines for a typical session, which is what users
// actually care to see, and it parses in single-digit milliseconds.
const SNAPSHOT_REPLAY_LIMIT = 256_000;
// Snapshot is split into multiple WebSocket text frames so each JSON.parse on
// the client is small, the main thread can pump input/scroll events between
// frames, and xterm's internal write queue gets bite-sized inputs.
const SNAPSHOT_CHUNK_SIZE = 32_768;
const STARTUP_DELAY_MS = 180;
const SESSION_META_THROTTLE_MS = 180;
const SESSION_PERSIST_THROTTLE_MS = 180;
// PTY chunks arrive at keystroke frequency; running the projected-narrative
// parser per chunk would thrash CPU and the wire. 200ms is the sweet spot:
// faster than perceptible UI lag (humans tolerate <250ms), slower than the
// fastest typing or paste interactions (which produce dozens of chunks).
const NARRATIVE_DIFF_THROTTLE_MS = 200;
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
const CODEX_SESSION_META_READ_LIMIT = 512 * 1024;
const NATIVE_NARRATIVE_EVENT_LIMIT = 128;
const NATIVE_NARRATIVE_TEXT_LIMIT = 4_000;
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
  "CLICOLOR",
  "CODEX_HOME",
  "COLORTERM",
  "FORCE_COLOR",
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
  "TERM",
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

function isClaudeStreamModeEnabled(env = process.env) {
  // Stream mode is opt-in for Claude sessions. By default we use the PTY+TUI
  // surface so the xterm chat view shows the unaltered Claude CLI. Set
  // VIBE_RESEARCH_CLAUDE_STREAM_MODE=1 to opt into the JSONL stream surface.
  const value = String(
    env?.VIBE_RESEARCH_CLAUDE_STREAM_MODE
      ?? env?.REMOTE_VIBES_CLAUDE_STREAM_MODE
      ?? "",
  ).trim();
  if (!value) {
    return false;
  }
  return !/^(?:0|false|off|no)$/i.test(value);
}

function isCodexStreamModeEnabled(env = process.env) {
  // Same opt-in semantics as Claude: PTY+TUI is the default so new Codex
  // sessions render the raw CLI in xterm. Set VIBE_RESEARCH_CODEX_STREAM_MODE=1
  // to opt into the codex exec --json stream surface.
  const value = String(
    env?.VIBE_RESEARCH_CODEX_STREAM_MODE
      ?? env?.REMOTE_VIBES_CODEX_STREAM_MODE
      ?? "",
  ).trim();
  if (!value) {
    return false;
  }
  return !/^(?:0|false|off|no)$/i.test(value);
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

function normalizeNarrativeEventText(value, maxLength = NATIVE_NARRATIVE_TEXT_LIMIT) {
  const normalized = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .trim();

  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function buildNarrativeEntryDedupKey(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }

  return [
    entry.kind || "",
    entry.label || "",
    normalizeNarrativeEventText(entry.text || "", 1_200),
    entry.status || "",
    entry.meta || "",
  ].join("::");
}

function shouldPreferNativeBootstrapNarrative(providerId) {
  return new Set(["codex", "claude", CLAUDE_OLLAMA_PROVIDER_ID, "gemini"]).has(
    String(providerId || "").trim().toLowerCase(),
  );
}

function mergeNarrativeEntries(localEntries = [], providerEntries = [], maxEntries = NATIVE_NARRATIVE_EVENT_LIMIT) {
  const providerKeys = new Set(
    providerEntries
      .filter((entry) => entry?.kind === "user" || entry?.label === "Kickoff")
      .map((entry) => buildNarrativeEntryDedupKey(entry))
      .filter(Boolean),
  );

  const combined = [
    ...localEntries
      .filter((entry) => {
        if (!entry || typeof entry !== "object") {
          return false;
        }

        const key = buildNarrativeEntryDedupKey(entry);
        return !(providerKeys.has(key) && (entry.kind === "user" || entry.label === "Kickoff"));
      })
      .map((entry, index) => ({ ...entry, __origin: "local", __index: index })),
    ...providerEntries.map((entry, index) => ({ ...entry, __origin: "provider", __index: index })),
  ]
    .sort((left, right) => {
      // Prefer session-wide insertion sequence numbers (OpenCode pattern):
      // wall-clock timestamps from Claude's stream events bleed across turns
      // and aren't a reliable sort key. We fall back to timestamp/origin/index
      // for legacy entries that don't carry a seq.
      const leftSeq = Number.isFinite(Number(left.seq)) ? Number(left.seq) : null;
      const rightSeq = Number.isFinite(Number(right.seq)) ? Number(right.seq) : null;
      if (leftSeq != null && rightSeq != null && leftSeq !== rightSeq) {
        return leftSeq - rightSeq;
      }
      if (leftSeq != null && rightSeq == null) {
        return -1;
      }
      if (leftSeq == null && rightSeq != null) {
        return 1;
      }

      const leftTime = parseSessionTimestamp(left.timestamp, 0);
      const rightTime = parseSessionTimestamp(right.timestamp, 0);

      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }

      if (left.__origin !== right.__origin) {
        return left.__origin === "local" ? -1 : 1;
      }

      return left.__index - right.__index;
    });

  const deduped = [];
  let previousKey = "";

  for (const entry of combined) {
    const { __origin: _origin, __index: _index, ...cleanEntry } = entry;
    const key = buildNarrativeEntryDedupKey(cleanEntry);
    // Empty-text entries are usually noise EXCEPT for the OpenCode-style
    // thinking placeholder: a kind:"assistant" entry whose text is "" IS
    // the thinking spinner. Renderer keys off `text.trim() === ""` so we
    // need to let it through. Same goes for explicit thinking entries.
    const isPlaceholder = !cleanEntry.text
      && cleanEntry.kind === "assistant"
      && (cleanEntry.meta === "pending" || cleanEntry.meta === "streaming" || cleanEntry.thinking === true);
    if ((!cleanEntry.text && !isPlaceholder) || !key || key === previousKey) {
      continue;
    }

    deduped.push(cleanEntry);
    previousKey = key;
  }

  return deduped.slice(Math.max(0, deduped.length - Math.max(1, Number(maxEntries) || NATIVE_NARRATIVE_EVENT_LIMIT)));
}

function shouldRetainNativeEntryWithProviderNarrative(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  if (entry.kind === "user") {
    return true;
  }

  if (entry.status === "error") {
    return true;
  }

  return new Set(["process-exit", "restore-failure", "signal"]).has(String(entry.meta || "").trim().toLowerCase());
}

function shouldProjectLiveNarrativeOverlay(session, providerNarrative = null) {
  if (!session || session.status !== "running") {
    return false;
  }

  const lastPromptAt = parseSessionTimestamp(session.lastPromptAt, 0);
  const lastOutputAt = parseSessionTimestamp(session.lastOutputAt || session.updatedAt || session.createdAt, 0);

  if (!lastPromptAt || !lastOutputAt || lastOutputAt < lastPromptAt) {
    return false;
  }

  if (!providerNarrative) {
    return true;
  }

  const providerUpdatedAt = parseSessionTimestamp(providerNarrative.updatedAt, 0);
  return lastOutputAt > providerUpdatedAt + 250;
}

function filterProjectedOverlayEntries(entries = []) {
  return entries.filter((entry) => {
    if (!entry?.text || entry.kind === "user") {
      return false;
    }

    const normalizedText = String(entry.text || "").replace(/\s+/g, " ").trim();
    if (!normalizedText) {
      return false;
    }

    if (
      /bypass\s*permissions\s*on|bypasspermissionson|press\s*enter\s*to\s*continue|do\s*you\s*trust\s*the\s*contents\s*of\s*this\s*directory/iu.test(normalizedText)
      || /use\s*\/skills\s*to\s*list\s*available\s*skills|starting\s*mcp\s*servers|tip:\s*try\s*the\s*codex\s*app/iu.test(normalizedText)
      || /[─│┃┌┐└┘]{20,}/u.test(entry.text)
    ) {
      return false;
    }

    // Codex TUI chrome that leaks through PTY-projection. Sources:
    // - codex-rs/tui/src/status_indicator_widget.rs (spinner + status header)
    // - codex-rs/tui/src/status/helpers.rs (token formatter)
    // - codex-rs/tui/tooltips.txt + tooltips.rs (the rotating Tip: lines)
    // - codex-rs/tui/src/chatwidget.rs (gerund status text from reasoning)
    // - codex-rs/tui/src/chatwidget/status_surfaces.rs (status verbs)
    // The proper fix for Codex is to stop scraping PTY altogether and
    // adopt `codex exec --json` (codex-rs/exec/src/cli.rs) — that's
    // tracked separately. For now strip the worst offenders.
    if (
      // Spinner glyph + gerund/past + ellipsis: "✶ Ruminating…", "• Working...", "* Tempering…"
      /^[\s•◦✶✻✦✧✩\*]+\S+(?:ing|ed)…/iu.test(normalizedText)
      // Bare status-verb headers with the Codex spinner format: "Ruminating…", "Tempering… (5s · ↓ 66 tokens)"
      || /^[\s•◦✶✻✦✧✩\*]*(?:Ruminating|Tempering|Pondering|Working|Waiting|Undoing|Thinking|Starting|Ready)\b.*…/iu.test(normalizedText)
      // Token / elapsed counter + interrupt hint
      || /\([\d\s.smh]+(?:·|•)\s*esc\s+to\s+interrupt\)/iu.test(normalizedText)
      || /[↓↑]\s*[\d.]+\s*(?:K|M|B|T)?\s*tokens?\b/iu.test(normalizedText)
      // Tooltips — remote-driven, prefix-only match
      || /^\s*(?:\*New\*\s*)?Tip:\s/iu.test(normalizedText)
      // Lines that are JUST Braille spinner frames
      || /^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+$/u.test(normalizedText)
      // Esc-to-interrupt hint, even when not in parens
      || /\besc\s+to\s+interrupt\b/iu.test(normalizedText)
    ) {
      return false;
    }

    // Filter the verbose provider launch command echoed by the shell when we
    // boot a Codex or Claude session. The buffer parser otherwise splits the
    // wrapped command into multiple short "assistant" entries that escape the
    // length-based heuristics below and end up rendered as giant cards in the
    // chat after every message.
    if (
      /bin\/(?:codex|claude)\b/iu.test(normalizedText)
      && /\s-c\b/u.test(normalizedText)
      && /trust_level\s*=/iu.test(normalizedText)
    ) {
      return false;
    }

    if (entry.kind === "assistant") {
      if (
        /tab\s+to\s+queue\s+message|context\s+left|\/model\s+to\s+change/iu.test(normalizedText)
        || (/OpenAI\s+Codex/iu.test(normalizedText) && /(?:model|directory)\s*:/iu.test(normalizedText))
      ) {
        return false;
      }

      // Previously capped at 700 characters, which silently dropped any longer
      // assistant reply (Claude in particular often emits multi-paragraph
      // answers). Cap is now generous enough to fit a normal answer while still
      // rejecting full-screen TUI dumps.
      if (normalizedText.length > 4000) {
        return false;
      }

      const whitespaceCount = (normalizedText.match(/\s/g) || []).length;
      const blockGlyphCount = (String(entry.text || "").match(/[▀-▿▁-▏█▓▒░■□◼◻◾◽]/gu) || []).length;
      if ((/^[\u23fa\u23bf\u23f5]/u.test(normalizedText) || /exitcode\d+/iu.test(normalizedText))
        || (normalizedText.length > 120 && whitespaceCount < 8)) {
        return false;
      }

      if (blockGlyphCount >= 3) {
        return false;
      }

      if (!/\n/u.test(entry.text) && /^[a-z][a-z0-9_-]{1,24}\s*:\s*\S/iu.test(normalizedText) && normalizedText.length < 120) {
        return false;
      }

      if (
        normalizedText.length >= 28
        && whitespaceCount === 0
        && /^[\p{L}\p{N}"'`.,!?;:()[\]{}%/+\\-]+$/u.test(normalizedText)
      ) {
        return false;
      }

      if (/\b(?:Bash|ApplyPatch|Edit|Find|Glob|Grep|LS|Open|Read|Search|Task|Write)\(/u.test(normalizedText)) {
        return false;
      }
    }

    // Snippet entries (label "Snippet", from the projected code-block path)
    // are the worst offenders for runaway length — TUI panels, partial
    // tasks lists, paginated git output. Cap them tightly. Real tool
    // entries (Bash, Edit, etc.) keep the more generous 500-char cap so
    // long shell commands and paths still survive.
    if (entry.kind === "tool" && entry.label === "Snippet" && normalizedText.length > 280) {
      return false;
    }

    if ((entry.kind === "tool" || entry.kind === "status") && normalizedText.length > 500) {
      return false;
    }

    return entry.kind === "assistant" || entry.kind === "tool" || entry.kind === "status";
  });
}

function timestampNarrativeEntries(entries = [], anchorTimestamp) {
  const anchorMs = parseSessionTimestamp(anchorTimestamp, Date.now());
  const count = Array.isArray(entries) ? entries.length : 0;

  return (Array.isArray(entries) ? entries : []).map((entry, index) => {
    const offset = Math.max(0, count - index - 1) * 40;
    return {
      ...entry,
      timestamp: entry.timestamp || new Date(anchorMs - offset).toISOString(),
    };
  });
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

// Detects the Claude Code "Select login method:" chooser. Claude Code
// re-renders the menu on every keystroke, so we normalize ANSI + whitespace
// before matching. The chooser is always three numbered options in the same
// order; we don't try to extract the label from the buffer (too brittle) —
// we hard-code the documented labels and treat the buffer match as the signal.
function detectClaudeLoginChooser(buffer) {
  const text = normalizeTerminalText(buffer);
  if (!text) return null;
  if (!/Select\s+login\s+method/i.test(text)) return null;
  // Require at least two of the three known option keywords to be present so
  // we don't false-positive on a session that happens to print the phrase.
  const hits = [
    /Claude\s+account\s+with\s+subscription|Pro,\s*Max,\s*Team/i,
    /Anthropic\s+Console\s+account|API\s+usage\s+billing/i,
    /3rd-?party\s+platform|Amazon\s+Bedrock|Vertex\s+AI|Microsoft\s+Foundry/i,
  ].filter((pattern) => pattern.test(text)).length;
  if (hits < 2) return null;

  return {
    kind: "login-chooser",
    title: "Pick a Claude login",
    hint: "Choose how to sign Claude Code in. The choice is sent back to the CLI automatically.",
    options: [
      {
        id: "1",
        label: "Claude subscription",
        detail: "Pro, Max, Team, or Enterprise",
      },
      {
        id: "2",
        label: "Anthropic Console",
        detail: "API key · pay-per-use billing",
      },
      {
        id: "3",
        label: "3rd-party platform",
        detail: "Bedrock · Foundry · Vertex AI",
      },
    ],
  };
}

// Detects the OAuth URL prompt Claude Code shows after picking option 1.
// Returns the URL so the UI can turn it into a single-click button.
function detectClaudeOAuthUrl(buffer) {
  const text = normalizeTerminalText(buffer);
  if (!text) return null;
  // Claude Code prints "Open the following URL ... https://claude.ai/..."
  // or a similar invitation alongside the link.
  if (!/Open\s+(?:the\s+)?(?:following\s+)?URL|Paste\s+this\s+URL|Visit(?:ing)?\s+this\s+URL|Log\s+in\s+(?:with|via)\s+your\s+browser/i.test(text)) {
    return null;
  }
  const match = text.match(/https:\/\/(?:www\.)?(?:claude\.ai|anthropic\.com|console\.anthropic\.com)[^\s"'<>]+/i);
  if (!match) return null;
  return {
    kind: "oauth-url",
    title: "Finish Claude login in your browser",
    hint: "Claude Code is waiting for you to complete sign-in. Click to open the verification URL, sign in, and come back.",
    url: match[0],
  };
}

// Detects the prompt Claude Code (or the Console login) shows asking for an
// API key. We don't try to autocomplete here — the user pastes it and we
// write it into the PTY followed by a newline.
function detectClaudeApiKeyPrompt(buffer) {
  const text = normalizeTerminalText(buffer);
  if (!text) return null;
  // The chooser is gone but the login prompt is still asking for an API key.
  if (/Select\s+login\s+method/i.test(text)) return null;
  if (
    /Enter\s+(?:your\s+)?(?:Anthropic\s+)?API\s+key|Paste\s+(?:your\s+)?API\s+key|anthropic\s+api\s+key:\s*$/i.test(text)
    || /\bsk-ant-\.\.\.|\bsk-ant-xxxx/i.test(text)
  ) {
    return {
      kind: "api-key",
      title: "Enter your Anthropic API key",
      hint: "Paste the key you copied from console.anthropic.com. It gets sent directly to Claude Code — Vibe Research doesn't store it.",
      consoleUrl: "https://console.anthropic.com/settings/keys",
    };
  }
  return null;
}

// Detects the credit-refill / usage-limit notice. We don't route this back
// into the PTY — we surface a billing button and let the user decide.
function detectClaudeCreditRefill(buffer) {
  const text = normalizeTerminalText(buffer);
  if (!text) return null;
  if (
    /reached\s+your\s+usage\s+limit|credit\s+balance\s+is\s+too\s+low|out\s+of\s+credits|please\s+add\s+credits|purchase\s+more\s+credits|insufficient\s+credits|low\s+on\s+credits/i.test(text)
  ) {
    return {
      kind: "credit-refill",
      title: "Anthropic credits exhausted",
      hint: "Claude Code says the account is out of credits. Top up and come back — no PTY input is needed from this card.",
      billingUrl: "https://console.anthropic.com/settings/billing",
    };
  }
  return null;
}

// Returns the most-relevant Claude setup/runtime prompt detected in the
// session's visible buffer, or null. Ordered so the most actionable prompt
// wins when multiple match (e.g. if the buffer still has an old login chooser
// above a newer API key prompt, surface the API key).
function detectClaudePrompt(session) {
  if (!isClaudeProviderId(session?.providerId)) return null;
  if (!session?.buffer) return null;
  return (
    detectClaudeApiKeyPrompt(session.buffer)
    || detectClaudeLoginChooser(session.buffer)
    || detectClaudeOAuthUrl(session.buffer)
    || detectClaudeCreditRefill(session.buffer)
    || null
  );
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
    return /tab\s+to\s+queue\s+message|context\s+left|OpenAI\s+Codex|\/model\s+to\s+change|(?:model|directory)\s*:/iu.test(text);
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

function shouldDeferProviderInput(input) {
  const text = String(input || "");
  if (!text || (!text.includes("\r") && !text.includes("\n"))) {
    return false;
  }

  const strippedText = text.replace(/[\r\n]+/g, "").trim();
  if (!strippedText) {
    return false;
  }

  return !/[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/u.test(text.replace(/[\r\n\t]+/g, ""));
}

function splitProviderSubmitInput(session, input) {
  if (session?.providerId !== "codex") {
    return null;
  }

  const text = String(input || "");
  const trailingSubmit = /(?:\r\n|\r|\n)+$/u.exec(text)?.[0] || "";
  if (!trailingSubmit) {
    return null;
  }

  const body = text.slice(0, text.length - trailingSubmit.length);
  if (!body.trim()) {
    return null;
  }

  return {
    body,
    submit: "\r",
  };
}

function getRecentNarrativeInputTexts(entries = [], maxEntries = 8) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.kind === "user" && entry.text)
    .slice(-Math.max(1, Number(maxEntries) || 8))
    .map((entry) => entry.text);
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
  const { NO_COLOR: _noColor, FORCE_COLOR: _forceColor, ...colorCapableEnv } = env;
  const providerSpecificEnv = buildProviderSpecificSessionEnv(providerId, colorCapableEnv);

  return {
    ...colorCapableEnv,
    ...buildResourceLimitEnv(colorCapableEnv),
    ...providerSpecificEnv,
    CLICOLOR: "1",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: prependPathEntries(env.PATH, preferredCliBinDirs),
    TERM: "xterm-256color",
    PWCLI: "vr-playwright",
    VIBE_RESEARCH_APP_ROOT: appRootDir,
    VIBE_RESEARCH_BROWSER_COMMAND: "vr-playwright",
    VIBE_RESEARCH_BROWSER_FALLBACK_COMMAND: "vr-browser",
    VIBE_RESEARCH_BROWSER_USE_COMMAND: "vr-browser-use",
    VIBE_RESEARCH_OTTOAUTH_COMMAND: "vr-ottoauth",
    VIBE_RESEARCH_SCAFFOLD_RECIPE_COMMAND: "vr-scaffold-recipe",
    VIBE_RESEARCH_SCAFFOLD_RECIPE_HELP: "vr-scaffold-recipe export --pretty",
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
    REMOTE_VIBES_SCAFFOLD_RECIPE_COMMAND: "rv-scaffold-recipe",
    REMOTE_VIBES_SCAFFOLD_RECIPE_HELP: "rv-scaffold-recipe export --pretty",
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

function tryResolveCwd(inputCwd, fallbackCwd = "") {
  try {
    return resolveCwd(inputCwd, fallbackCwd);
  } catch {
    return "";
  }
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

function buildCodexProjectTrustConfig(cwd) {
  const normalizedCwd = String(cwd || "").trim();
  if (!normalizedCwd) {
    return "";
  }

  const escapedCwd = path.resolve(normalizedCwd).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
  return `projects."${escapedCwd}".trust_level="trusted"`;
}

function getCodexLaunchArgs(cwd, args = []) {
  const trustConfig = buildCodexProjectTrustConfig(cwd);
  return trustConfig ? ["-c", trustConfig, ...args] : [...args];
}

function getSiblingNodeRuntime(commandPath) {
  const normalizedCommandPath = String(commandPath || "").trim();
  if (!normalizedCommandPath || !normalizedCommandPath.includes("/")) {
    return null;
  }

  const candidate = path.join(path.dirname(normalizedCommandPath), "node");
  const stats = statSync(candidate, { throwIfNoEntry: false });
  if (!stats || !stats.isFile() || (stats.mode & 0o111) === 0) {
    return null;
  }

  return candidate;
}

function buildOpenClawLaunchCommand(commandPath) {
  const siblingNodeRuntime = getSiblingNodeRuntime(commandPath);
  if (siblingNodeRuntime) {
    return buildShellCommand(siblingNodeRuntime, [commandPath, "tui"]);
  }

  return buildShellCommand(commandPath, ["tui"]);
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

function ensureClaudeFolderTrusted(cwd, homeDirOrEnv = process.env) {
  if (!cwd || typeof cwd !== "string") {
    return;
  }
  const resolvedCwd = path.resolve(cwd);
  const claudeHome = getClaudeHomeDir(homeDirOrEnv);
  const configPath = path.join(claudeHome, ".claude.json");
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return;
  }
  if (!config || typeof config !== "object") {
    return;
  }
  if (!config.projects || typeof config.projects !== "object") {
    config.projects = {};
  }
  const existing = config.projects[resolvedCwd] && typeof config.projects[resolvedCwd] === "object"
    ? config.projects[resolvedCwd]
    : {};
  if (existing.hasTrustDialogAccepted === true) {
    return;
  }
  config.projects[resolvedCwd] = { ...existing, hasTrustDialogAccepted: true };
  try {
    const tmpPath = `${configPath}.vr-trust-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(tmpPath, configPath);
  } catch {
    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    } catch {
      // best-effort; if we can't write, fall back to the trust dialog
    }
  }
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
    const chunks = [];
    let position = 0;

    while (position < byteLimit) {
      const nextChunkSize = Math.min(16 * 1024, byteLimit - position);
      const buffer = Buffer.alloc(nextChunkSize);
      const { bytesRead } = await handle.read(buffer, 0, nextChunkSize, position);
      if (!bytesRead) {
        break;
      }

      const chunk = buffer.toString("utf8", 0, bytesRead);
      const newlineIndex = chunk.search(/\r?\n/u);
      if (newlineIndex >= 0) {
        chunks.push(chunk.slice(0, newlineIndex));
        break;
      }

      chunks.push(chunk);
      position += bytesRead;
      if (bytesRead < nextChunkSize) {
        break;
      }
    }

    return chunks.join("");
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
      filePath,
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
          filePath: entry.filePath || existingEntry?.filePath || null,
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
    if (
      !fileName.startsWith("session-")
      || (!fileName.endsWith(".json") && !fileName.endsWith(".jsonl"))
    ) {
      continue;
    }

    try {
      const filePath = path.join(chatsDir, fileName);
      const contents = await readFile(filePath, "utf8");
      const firstLine = contents.split(/\r?\n/, 1)[0] || "";
      const payload = JSON.parse(fileName.endsWith(".jsonl") ? firstLine : contents);
      const hasMessages = fileName.endsWith(".jsonl")
        ? contents
          .split(/\r?\n/)
          .slice(1)
          .some((line) => {
            try {
              const entry = JSON.parse(line);
              return entry?.type === "user" || entry?.type === "assistant" || entry?.type === "response";
            } catch {
              return false;
            }
          })
        : hasGeminiConversationMessages(payload.messages);
      if (typeof payload?.sessionId !== "string" || !payload.sessionId || !hasMessages) {
        continue;
      }

      sessions.push({
        id: payload.sessionId,
        updated: Date.parse(payload.lastUpdated || payload.startTime || 0) || 0,
        filePath,
      });
    } catch {
      // Ignore malformed Gemini session files.
    }
  }

  return sessions
    .sort((left, right) => Number(right.updated || 0) - Number(left.updated || 0))
    .slice(0, PROVIDER_SESSION_LIST_LIMIT);
}

function findClaudeSessionFile(session, homeDirOrEnv = process.env) {
  const projectDir = getClaudeProjectDirForCwd(session?.cwd, homeDirOrEnv);
  if (!projectDir) {
    return "";
  }

  for (const sessionId of getClaudeSessionIdsForSession(session)) {
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    try {
      if (statSync(filePath).isFile()) {
        return filePath;
      }
    } catch {
      // Keep looking for another Claude session artifact.
    }
  }

  const fallbackSessionId = listClaudeSessionsForCwd(session?.cwd, homeDirOrEnv)[0]?.id || "";
  if (!fallbackSessionId) {
    return "";
  }

  const fallbackFilePath = path.join(projectDir, `${fallbackSessionId}.jsonl`);
  try {
    return statSync(fallbackFilePath).isFile() ? fallbackFilePath : "";
  } catch {
    return "";
  }
}

async function findGeminiSessionFile(cwd, sessionId, homeDir = os.homedir()) {
  const knownSessions = await listGeminiSessions(cwd, homeDir);
  if (!knownSessions.length) {
    return "";
  }

  if (typeof sessionId === "string" && sessionId.trim()) {
    const matchingSession = knownSessions.find((entry) => entry.id === sessionId);
    if (matchingSession?.filePath) {
      return matchingSession.filePath;
    }
  }

  return String(knownSessions[0]?.filePath || "");
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
    sessionEnvironmentProvider = null,
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
    this.sessionEnvironmentProvider =
      typeof sessionEnvironmentProvider === "function" ? sessionEnvironmentProvider : null;
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
    this.workspaceStore = new WorkspaceStore({
      enabled: persistSessions,
      stateDir,
      defaultWorkspaceRoot: this.cwd,
    });
    this.sessions = new Map();
    this.persistTimer = null;
    this.persistPromise = Promise.resolve();
    this.isShuttingDown = false;
    this.broadcastAll = null;
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
    this.workspaceStore.defaultWorkspaceRoot = this.cwd;
    this.workspaceStore.ensureWorkspace(this.cwd, { id: "default", kind: "default", opened: true });
    this.systemRootPath = path.resolve(this.cwd, this.systemRootPath);
  }

  setEnvironment(env = process.env) {
    this.env = env && typeof env === "object" ? { ...env } : { ...process.env };
    this.tmuxAvailable = null;
    this.tmuxEnvironmentArgsAvailable = null;
  }

  setBroadcast(broadcast) {
    this.broadcastAll = typeof broadcast === "function" ? broadcast : null;
  }

  setSystemRootPath(systemRootPath) {
    this.systemRootPath = path.resolve(this.cwd, systemRootPath);
  }

  setExtraSubagentsProvider(extraSubagentsProvider) {
    this.extraSubagentsProvider =
      typeof extraSubagentsProvider === "function" ? extraSubagentsProvider : null;
  }

  setSessionEnvironmentProvider(sessionEnvironmentProvider) {
    this.sessionEnvironmentProvider =
      typeof sessionEnvironmentProvider === "function" ? sessionEnvironmentProvider : null;
  }

  setOccupationId(occupationId) {
    this.occupationId = normalizeSessionOccupationId(occupationId, this.occupationId);
  }

  registerSessionWorkspace(cwd, { workspaceId = "", label = "", kind = "workspace", opened = false } = {}) {
    const resolvedCwd = resolveCwd(cwd, this.cwd);
    const workspace = this.workspaceStore.ensureWorkspace(resolvedCwd, {
      id: workspaceId,
      label,
      kind,
      opened,
    });
    return {
      cwd: resolvedCwd,
      workspaceId: workspace.id,
      launchContext: {
        kind: "workspace",
        relativePath: ".",
      },
      lastResolvedCwd: resolvedCwd,
      lastResolvedAt: new Date().toISOString(),
    };
  }

  repairSessionWorkspace(session, { markBlocked = false } = {}) {
    const resolution = this.workspaceStore.resolveSessionCwd(session, this.cwd);
    const now = new Date().toISOString();

    if (!resolution.cwd) {
      if (markBlocked) {
        this.markSessionRestoreFailure(
          session,
          `could not restore the session: Working directory does not exist: ${resolution.missingCwd || session.cwd || this.cwd}`,
        );
      }
      return { ...resolution, repaired: false };
    }

    if (resolution.workspace?.id) {
      session.workspaceId = resolution.workspace.id;
    }
    session.launchContext = {
      kind: "workspace",
      relativePath: ".",
      ...(session.launchContext && typeof session.launchContext === "object" ? session.launchContext : {}),
    };
    session.lastResolvedCwd = resolution.cwd;
    session.lastResolvedAt = now;

    if (session.cwd !== resolution.cwd) {
      const previousCwd = session.cwd;
      session.cwd = resolution.cwd;
      session.updatedAt = now;
      session.workspaceRepair = {
        repairedAt: now,
        previousCwd,
        reason: resolution.reason || "workspace-registry",
      };
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Workspace repaired",
        text: previousCwd
          ? `Repaired missing working directory ${previousCwd}; using ${resolution.cwd}.`
          : `Resolved working directory to ${resolution.cwd}.`,
        timestamp: now,
        meta: resolution.reason || "workspace-registry",
      });
      this.pushOutput(
        session,
        `\r\n\u001b[1;36m[vibe-research]\u001b[0m repaired working directory: ${previousCwd || "(empty)"} -> ${resolution.cwd}\r\n`,
      );
      return { ...resolution, repaired: true };
    }

    return resolution;
  }

  async initialize() {
    await this.workspaceStore.load();
    const persistedSessions = await this.sessionStore.load();

    for (const snapshot of persistedSessions) {
      this.restoreSession(snapshot);
    }

    await this.workspaceStore.save();
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
      const sessionCwd = tryResolveCwd(session.cwd, this.cwd);
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
    const focusCwd = tryResolveCwd(cwd, this.cwd) || this.cwd;
    const focusForkParentId = focusSession?.providerState?.forkedFromSessionId || null;
    const relatedSessions = Array.from(this.sessions.values())
      .filter((session) => {
        const sessionCwd = tryResolveCwd(session.cwd, this.cwd);

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

  async getSessionNarrative(sessionId, { maxEntries = 96 } = {}) {
    this.consumePendingRenameRequests();
    const session = this.sessions.get(sessionId);

    if (!session) {
      return null;
    }

    if (session.streamMode || session.streamSession) {
      const streamEntries = Array.isArray(session.streamEntries) ? session.streamEntries.slice(-maxEntries) : [];
      const nativeEntries = this.getNativeNarrativeEntries(session, { maxEntries, includePlaceholder: streamEntries.length === 0 });
      const merged = mergeNarrativeEntries(nativeEntries, streamEntries, maxEntries);
      return {
        providerId: session.providerId,
        providerLabel: session.providerLabel,
        providerBacked: true,
        sourceLabel: "Claude stream-mode JSONL",
        updatedAt: session.lastOutputAt || session.updatedAt || session.createdAt,
        entries: merged,
      };
    }

    const serializedSession = this.serializeSession(session);
    const nativeEntries = this.getNativeNarrativeEntries(session, { maxEntries, includePlaceholder: false });
    const recentInputTexts = getRecentNarrativeInputTexts(nativeEntries);
    const buildProjectedOverlayEntries = () => {
      const projectedNarrative = buildProjectedNarrative({
        providerId: serializedSession.providerId,
        providerLabel: serializedSession.providerLabel,
        transcript: session.buffer,
        maxEntries,
        recentInputs: recentInputTexts,
      });

      return {
        sourceLabel: projectedNarrative.sourceLabel,
        entries: timestampNarrativeEntries(
          filterProjectedOverlayEntries(projectedNarrative.entries || []).slice(-Math.max(1, Math.min(12, maxEntries))),
          session.lastOutputAt || session.updatedAt || session.createdAt,
        ),
      };
    };
    let filePath = "";

    try {
      if (session.providerId === "codex") {
        const codexRootDir = getCodexRootDir(this.userHomeDir);
        const referenceTime = Date.parse(session.updatedAt || session.createdAt || "") || Date.now();
        const knownSessionId = session.providerState?.sessionId || "";

        if (knownSessionId) {
          filePath = String((await findCodexSessionMeta(codexRootDir, knownSessionId, referenceTime))?.filePath || "");
        }

        if (!filePath) {
          const transcriptSession = matchCodexSessionsByCwd(await listCodexTranscriptSessions(this.userHomeDir), session.cwd)[0] || null;
          if (transcriptSession?.filePath) {
            filePath = transcriptSession.filePath;
          }
        }

        if (!filePath) {
          const trackedSession = matchCodexSessionsByCwd(await listCodexTrackedSessions(this.userHomeDir), session.cwd)[0] || null;
          const trackedMeta = trackedSession?.filePath
            ? trackedSession
            : trackedSession?.id
              ? await findCodexSessionMeta(codexRootDir, trackedSession.id, trackedSession.updated || referenceTime)
              : null;
          filePath = String(trackedMeta?.filePath || "");
        }
      } else if (isClaudeProviderId(session.providerId)) {
        filePath = findClaudeSessionFile(session, this.userHomeDir);
      } else if (session.providerId === "gemini") {
        filePath = await findGeminiSessionFile(session.cwd, session.providerState?.sessionId || "", this.userHomeDir);
      }
    } catch (error) {
      console.warn("[vibe-research] failed to locate provider narrative artifact", error);
    }

    if (filePath) {
      try {
        const providerNarrative = await loadProviderBackedNarrative({
          providerId: session.providerId,
          filePath,
          session: serializedSession,
          maxEntries,
        });

        if (providerNarrative) {
          const relevantNativeEntries = nativeEntries.filter(shouldRetainNativeEntryWithProviderNarrative);
          const projectedOverlay = shouldProjectLiveNarrativeOverlay(session, providerNarrative)
            ? buildProjectedOverlayEntries()
            : { sourceLabel: "", entries: [] };
          return {
            ...providerNarrative,
            sourceLabel: projectedOverlay.entries.length
              ? `${providerNarrative.sourceLabel} + live CLI overlay`
              : providerNarrative.sourceLabel,
            entries: mergeNarrativeEntries(
              [...relevantNativeEntries, ...projectedOverlay.entries],
              providerNarrative.entries || [],
              maxEntries,
            ),
          };
        }
      } catch (error) {
        console.warn("[vibe-research] failed to load provider narrative", error);
      }
    }

    if (shouldPreferNativeBootstrapNarrative(serializedSession.providerId)) {
      const projectedOverlay = shouldProjectLiveNarrativeOverlay(session)
        ? buildProjectedOverlayEntries()
        : { sourceLabel: "", entries: [] };
      return {
        providerBacked: false,
        providerId: serializedSession.providerId,
        providerLabel: serializedSession.providerLabel,
        sourceLabel: projectedOverlay.entries.length
          ? "Vibe Research native events + live CLI overlay"
          : "Vibe Research native session events",
        updatedAt: serializedSession.updatedAt || serializedSession.createdAt || "",
        entries: projectedOverlay.entries.length
          ? mergeNarrativeEntries(
            nativeEntries.length
              ? nativeEntries
              : this.getNativeNarrativeEntries(session, { maxEntries, includePlaceholder: true }),
            projectedOverlay.entries,
            maxEntries,
          )
          : nativeEntries.length
            ? nativeEntries
            : this.getNativeNarrativeEntries(session, { maxEntries, includePlaceholder: true }),
      };
    }

    const projectedNarrative = buildProjectedNarrative({
      providerId: serializedSession.providerId,
      providerLabel: serializedSession.providerLabel,
      transcript: session.buffer,
      maxEntries,
      recentInputs: recentInputTexts,
    });

    // The projection path is the only thing left when no provider transcript
    // file exists, so any TUI noise that survived the block-level filters
    // would otherwise reach the user unmoderated. Apply the same overlay
    // filter we use on the with-provider path so behaviour is consistent.
    const filteredProjectedEntries = filterProjectedOverlayEntries(projectedNarrative.entries || []);

    return {
      ...projectedNarrative,
      sourceLabel: nativeEntries.length ? "Vibe Research native events + CLI projection" : projectedNarrative.sourceLabel,
      entries: mergeNarrativeEntries(
        nativeEntries.length
          ? nativeEntries
          : this.getNativeNarrativeEntries(session, { maxEntries, includePlaceholder: true }),
        filteredProjectedEntries,
        maxEntries,
      ),
    };
  }

  buildSessionEnvironment(session, providerId = session.providerId) {
    const env = buildSessionEnv(
      session.id,
      providerId,
      this.providers,
      this.cwd,
      this.stateDir,
      this.env,
      this.wikiRootPath,
      this.systemRootPath,
    );

    if (!this.sessionEnvironmentProvider) {
      return env;
    }

    try {
      const provided = this.sessionEnvironmentProvider(session, providerId, env);
      return provided && typeof provided === "object" ? { ...env, ...provided } : env;
    } catch (error) {
      console.warn("[vibe-research] failed to build session environment extension", error);
      return env;
    }
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
    const workspaceState = this.registerSessionWorkspace(cwd || this.cwd, { opened: true });
    const session = this.buildSessionRecord({
      cwd: workspaceState.cwd,
      workspaceId: workspaceState.workspaceId,
      launchContext: workspaceState.launchContext,
      lastResolvedCwd: workspaceState.lastResolvedCwd,
      lastResolvedAt: workspaceState.lastResolvedAt,
      name: normalizedName || this.makeDefaultName(provider),
      providerId: provider.id,
      providerLabel: provider.label,
      occupationId: occupationId || this.occupationId,
      createdAt,
      updatedAt: createdAt,
      restoreOnStartup: true,
      autoRenameEnabled: shouldAutoRenameFromPrompt(provider, normalizedName || provider.defaultName, !normalizedName),
    });

    if (isClaudeProviderId(provider.id)) {
      session.streamMode = isClaudeStreamModeEnabled(this.env);
    } else if (provider.id === "codex") {
      session.streamMode = isCodexStreamModeEnabled(this.env);
    } else {
      session.streamMode = false;
    }

    this.sessions.set(session.id, session);
    void this.workspaceStore.save().catch((error) => {
      console.warn("[vibe-research] failed to persist workspaces", error);
    });
    this.pushNativeNarrativeEntry(session, {
      kind: "status",
      label: "Starting",
      text: `Starting ${provider.label} in ${session.cwd}.`,
      timestamp: createdAt,
      meta: "launch",
    });

    if (provider.id !== "shell") {
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Native",
        text: "Native view is live. Switch to Terminal any time for the raw CLI.",
        timestamp: createdAt,
        meta: "owned-ui",
      });
    }

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
      workspaceId: sourceSession.workspaceId,
      launchContext: sourceSession.launchContext,
      lastResolvedCwd: sourceSession.lastResolvedCwd || sourceSession.cwd,
      lastResolvedAt: sourceSession.lastResolvedAt,
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

    this.broadcastAll?.({ type: "session-deleted", sessionId });

    session.skipExitHandling = true;
    session.restoreOnStartup = false;
    this.clearPendingMetaBroadcast(session);
    this.clearPendingProviderInputRetry(session);
    this.clearPendingProviderCaptureRetry(session);
    this.clearSessionActivityTimer(session);
    if (session.narrativeDiffTimer) {
      clearTimeout(session.narrativeDiffTimer);
      session.narrativeDiffTimer = null;
    }
    session.clients.clear();
    this.queueAgentRunTracking(this.agentRunTracker?.handleSessionDelete(session));

    this.killPersistentTerminal(session);

    if (session.streamSession) {
      try {
        session.streamSession.close();
      } catch (error) {
        console.warn("[vibe-research] error closing claude stream session", error);
      }
      session.streamSession = null;
    }

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

    socket.on("close", () => {
      session.clients.delete(socket);
    });

    this.sendSnapshot(socket, session);

    // Push the narrative baseline so the client reducer has coherent state
    // immediately, instead of waiting on the first /api/sessions/:id/narrative
    // HTTP fetch. Stream-mode sessions emit incremental events as JSONL
    // arrives; PTY-backed sessions emit them throttled per pushOutput.
    // Either way the reducer is the source of truth on the client once
    // armed, so always seed it with an init frame.
    this.broadcastNarrativeInit(session, socket);

    return session;
  }

  sendSnapshot(socket, session) {
    const buffer = String(session.buffer || "");
    const totalBytes = buffer.length;
    const replayBuffer =
      totalBytes > SNAPSHOT_REPLAY_LIMIT ? buffer.slice(totalBytes - SNAPSHOT_REPLAY_LIMIT) : buffer;
    const replayBytes = replayBuffer.length;
    const truncated = replayBytes < totalBytes;
    const chunkSize = SNAPSHOT_CHUNK_SIZE;
    const chunkCount = replayBytes === 0 ? 0 : Math.ceil(replayBytes / chunkSize);

    const sendJson = (payload) => {
      if (socket.readyState !== socket.OPEN) {
        return false;
      }
      try {
        socket.send(JSON.stringify(payload));
        return true;
      } catch (error) {
        console.warn("[vibe-research] snapshot send failed", error);
        return false;
      }
    };

    if (
      !sendJson({
        type: "snapshot-start",
        session: this.serializeSession(session),
        totalBytes,
        replayBytes,
        chunkSize,
        chunkCount,
        truncated,
      })
    ) {
      return;
    }

    if (chunkCount === 0) {
      sendJson({ type: "snapshot-end", index: 0, chunkCount: 0 });
      return;
    }

    let index = 0;
    const sendNextChunk = () => {
      if (index >= chunkCount) {
        sendJson({ type: "snapshot-end", index, chunkCount });
        return;
      }
      if (socket.readyState !== socket.OPEN) {
        return;
      }
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, replayBytes);
      const ok = sendJson({
        type: "snapshot-chunk",
        index,
        chunkCount,
        data: replayBuffer.slice(start, end),
      });
      index += 1;
      if (!ok) {
        return;
      }
      // setImmediate so each chunk lands on its own event-loop tick → its own
      // WebSocket frame → its own browser message event. This is what lets the
      // client stay responsive to keystrokes/scroll while the snapshot streams.
      setImmediate(sendNextChunk);
    };

    setImmediate(sendNextChunk);
  }

  write(sessionId, input) {
    const session = this.sessions.get(sessionId);

    if (!session || session.status === "exited") {
      return false;
    }

    if (session.streamSession) {
      return this.writeToClaudeStreamSession(session, input);
    }

    if (!session.pty) {
      return false;
    }

    if (this.shouldQueueProviderInputUntilReady(session, input)) {
      return this.queueProviderInputUntilReady(session, input);
    }

    return this.performSessionWrite(session, input);
  }

  writeToClaudeStreamSession(session, input) {
    if (!session?.streamSession) {
      return false;
    }
    session.streamInputBuffer = `${session.streamInputBuffer || ""}${String(input ?? "")}`;
    const lines = session.streamInputBuffer.split(/\r\n?|\n/);
    session.streamInputBuffer = lines.pop() ?? "";
    let sentAny = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      // Stamp + push the user entry BEFORE handing the prompt to Claude so the
      // user message timestamp is unambiguously earlier than any partial /
      // final assistant entry the stream emits afterwards.
      const userTimestamp = new Date().toISOString();
      this.pushNativeNarrativeEntry(session, {
        kind: "user",
        label: "You",
        text: line,
        timestamp: userTimestamp,
      });
      session.lastPromptAt = userTimestamp;

      // No separate Thinking push anymore. The stream session synthesizes an
      // empty-text "claude-pending-assistant" entry between system:status
      // and the first text-delta of the new turn; the renderer turns that
      // empty assistant entry into the Thinking spinner. Same DOM node then
      // mutates into the streaming reply, so there is no race to clear.

      try {
        session.streamSession.send(line);
        session.streamWorking = true;
        sentAny = true;
      } catch (error) {
        this.pushNativeNarrativeEntry(session, {
          kind: "status",
          label: "Error",
          text: `Failed to send to stream: ${error.message}`,
          timestamp: new Date().toISOString(),
          meta: "stream-mode",
        });
      }
    }
    if (sentAny) {
      session.updatedAt = new Date().toISOString();
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
      this.schedulePersist();
    }
    return sentAny;
  }


  // Resolve a pending ExitPlanMode call by emitting a structured tool_result
  // back to the stream session. Approve sends a confirming text body; reject
  // sends an is_error: true block carrying the user's pushback text so
  // Claude treats the plan as declined without inferring intent from prose.
  // Returns { ok, reason } so the route can respond clearly to the client.
  resolvePlanMode(sessionId, { approve, message } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, reason: "session-not-found" };
    }
    if (!session.streamSession || typeof session.streamSession.sendToolResult !== "function") {
      return { ok: false, reason: "not-stream-mode" };
    }
    const toolUseId = session.streamSession.getPendingPlanToolUseId?.() || "";
    if (!toolUseId) {
      return { ok: false, reason: "no-plan-awaiting" };
    }

    const isApprove = approve !== false;
    const body = isApprove
      ? "User approved the plan. Proceed with the proposed steps."
      : `User pushed back on the plan${message ? `: ${String(message).trim()}` : "."}`;

    try {
      session.streamSession.sendToolResult(toolUseId, body, { isError: !isApprove });
    } catch (error) {
      return { ok: false, reason: error.message || "send-failed" };
    }

    session.streamWorking = true;
    session.lastPromptAt = new Date().toISOString();
    session.updatedAt = session.lastPromptAt;
    this.scheduleSessionMetaBroadcast(session, { immediate: true });
    this.schedulePersist();
    return { ok: true, toolUseId, approved: isApprove };
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
      this.clearPendingProviderInputRetry(session);
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

    // Schedule a debounced narrative diff so PTY-backed sessions get the
    // same WS push protocol as stream sessions. Debounced to avoid
    // re-running buildProjectedNarrative on every keystroke during
    // interactive use; the renderer's empty-state painted by the existing
    // pull model is fine in the meantime.
    this.scheduleNarrativeDiffBroadcast(session);

    this.schedulePersist();
  }

  // Debounced narrative diff broadcast for the PTY hot-path. Stream-mode
  // callers fire broadcastNarrativeDiff directly because their cadence is
  // already moderate; PTY chunks at keystroke frequency would thrash the
  // wire (and re-run the projected-narrative parser) without throttling.
  scheduleNarrativeDiffBroadcast(session) {
    if (!session) return;
    if (session.narrativeDiffTimer) return;
    session.narrativeDiffTimer = this.setTimeoutFn(() => {
      session.narrativeDiffTimer = null;
      try {
        this.broadcastNarrativeDiff(session);
      } catch (error) {
        console.warn(`[vibe-research] narrative diff broadcast failed for session ${session.id}:`, error?.message);
      }
    }, NARRATIVE_DIFF_THROTTLE_MS);
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

  // Build the canonical narrative snapshot a session's WS push protocol
  // carries to its clients. Dispatches by mode:
  //
  //   stream-mode → merges native entries with the stream session's
  //                 structured entries (Claude/Codex JSONL paths).
  //   PTY-backed  → merges native entries with the projected narrative
  //                 over session.buffer (the PTY transcript). Same shape
  //                 as getSessionNarrative's HTTP path uses, just synchronous
  //                 and skipping the empty-state placeholder.
  //
  // Skipping the placeholder is deliberate: the WS reducer treats an empty
  // entries[] as a legitimate baseline and the renderer paints its own
  // empty state, so a synthetic "waiting for stream" entry just to remove
  // it on the first real event is wire-format noise.
  getNarrativeSnapshot(session, { maxEntries = 96 } = {}) {
    if (!session) return [];
    const nativeEntries = this.getNativeNarrativeEntries(session, {
      maxEntries,
      includePlaceholder: false,
    });

    let providerEntries = [];
    if (session.streamMode || session.streamSession) {
      providerEntries = Array.isArray(session.streamEntries) ? session.streamEntries.slice(-maxEntries) : [];
    } else {
      const recentInputTexts = getRecentNarrativeInputTexts(nativeEntries);
      const projectedNarrative = buildProjectedNarrative({
        providerId: session.providerId,
        providerLabel: session.providerLabel,
        transcript: session.buffer || "",
        maxEntries,
        recentInputs: recentInputTexts,
      });
      providerEntries = timestampNarrativeEntries(
        filterProjectedOverlayEntries(projectedNarrative.entries || []).slice(-Math.max(1, Math.min(12, maxEntries))),
        session.lastOutputAt || session.updatedAt || session.createdAt,
      );
    }

    const merged = mergeNarrativeEntries(nativeEntries, providerEntries, maxEntries);
    return merged.map((entry, index) => {
      try {
        return normaliseNarrativeEntry({
          ...entry,
          id: entry.id || `synthetic-${index}`,
          seq: entry.seq || 0,
        });
      } catch (error) {
        console.warn(`[vibe-research] narrative entry ${entry?.id || index} failed validation:`, error.message);
        return null;
      }
    }).filter(Boolean);
  }

  // Backwards-compat alias kept for any caller that hardcoded the old name.
  getStreamNarrativeSnapshot(session, options = {}) {
    return this.getNarrativeSnapshot(session, options);
  }

  // Send a narrative-init frame to one client (or all of a session's
  // clients). Used on WebSocket connect to warm the client's reducer with
  // a coherent baseline before any incremental events arrive.
  broadcastNarrativeInit(session, target = null) {
    if (!session) return;
    const entries = this.getNarrativeSnapshot(session);
    if (typeof session.broadcastSeq !== "number") session.broadcastSeq = 0;
    const lastSeq = session.broadcastSeq;
    let frame;
    try {
      frame = makeNarrativeInitFrame({ sessionId: session.id, entries, lastSeq });
    } catch (error) {
      console.warn(`[vibe-research] could not build narrative-init for ${session.id}:`, error.message);
      return;
    }
    const payload = JSON.stringify(frame);
    const clients = target ? [target] : (session.clients || []);
    for (const client of clients) {
      if (client && client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
    // Cache the snapshot so the diff helper has a baseline for the next
    // entries update. Storing as a Map keyed by entry id keeps the diff
    // O(n) on whichever side has more entries.
    session.lastBroadcastNarrative = new Map(entries.map((entry) => [entry.id, entry]));
  }

  // Compute and emit a narrative-event diff after a session produces a
  // new entries snapshot. Each upsert/remove gets its own seq so a client
  // can detect a missed frame and resync via the HTTP endpoint (or by
  // re-handshaking the WebSocket). Stream-mode and PTY-backed sessions
  // share this path — `getNarrativeSnapshot` does the dispatch.
  //
  // PTY sessions can produce many small chunks per second, so callers in
  // the PTY hot-path (pushOutput) use scheduleNarrativeDiffBroadcast which
  // debounces; stream-mode callers fire this directly because their event
  // cadence is already moderate.
  broadcastNarrativeDiff(session) {
    if (!session) return;
    const next = this.getNarrativeSnapshot(session);
    const nextById = new Map(next.map((entry) => [entry.id, entry]));
    const prevById = session.lastBroadcastNarrative instanceof Map ? session.lastBroadcastNarrative : new Map();
    if (typeof session.broadcastSeq !== "number") session.broadcastSeq = 0;

    const upserts = [];
    for (const [id, entry] of nextById) {
      const previous = prevById.get(id);
      // A trivial JSON-equality check is enough — the entries are pure data
      // and small. Skipping the upsert when nothing changed keeps the wire
      // quiet during long-running tool runs that don't mutate the entry.
      if (!previous || JSON.stringify(previous) !== JSON.stringify(entry)) {
        upserts.push(entry);
      }
    }

    const removes = [];
    for (const id of prevById.keys()) {
      if (!nextById.has(id)) {
        removes.push(id);
      }
    }

    if (!upserts.length && !removes.length) {
      return;
    }

    const frames = [];
    for (const entry of upserts) {
      session.broadcastSeq += 1;
      try {
        frames.push(makeNarrativeEventFrame({
          sessionId: session.id, op: "upsert", seq: session.broadcastSeq, entry,
        }));
      } catch (error) {
        console.warn(`[vibe-research] could not build upsert frame for ${entry.id}:`, error.message);
      }
    }
    for (const entryId of removes) {
      session.broadcastSeq += 1;
      try {
        frames.push(makeNarrativeEventFrame({
          sessionId: session.id, op: "remove", seq: session.broadcastSeq, entryId,
        }));
      } catch (error) {
        console.warn(`[vibe-research] could not build remove frame for ${entryId}:`, error.message);
      }
    }

    for (const frame of frames) {
      const payload = JSON.stringify(frame);
      for (const client of session.clients || []) {
        if (client.readyState === client.OPEN) {
          client.send(payload);
        }
      }
    }
    session.lastBroadcastNarrative = nextById;
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
      workspaceId: session.workspaceId || "",
      launchContext: session.launchContext || { kind: "workspace", relativePath: "." },
      lastResolvedCwd: session.lastResolvedCwd || session.cwd,
      lastResolvedAt: session.lastResolvedAt || null,
      workspaceRepair: session.workspaceRepair || null,
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
      streamMode: Boolean(session.streamMode),
      streamWorking: Boolean(session.streamWorking),
      claudePrompt: detectClaudePrompt(session),
      // Per-session slash command catalog. Empty today — the client falls
      // back to the built-in list. When per-session command sets land
      // (research routines like /research-resolve, /wandb-pull, …) the
      // shape is [{command, label, hint?, aliases?}]; the renderer
      // already reads it via resolveRichSessionSlashCommands.
      availableSlashCommands: Array.isArray(session.availableSlashCommands) ? session.availableSlashCommands : [],
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
    nativeNarrativeEntries = [],
    nativeNarrativeInputBuffer = "",
    restoreOnStartup = false,
    providerState = null,
    workspaceId = "",
    launchContext = null,
    lastResolvedCwd = "",
    lastResolvedAt = null,
    workspaceRepair = null,
    autoRenameEnabled = false,
    occupationId = this.occupationId,
    streamMode = false,
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
      nativeNarrativeEntries: Array.isArray(nativeNarrativeEntries)
        ? nativeNarrativeEntries
          .map((entry) => (
            entry && typeof entry === "object"
              ? {
                  id: String(entry.id || randomUUID()),
                  kind: String(entry.kind || "status"),
                  label: String(entry.label || "Activity"),
                  text: normalizeNarrativeEventText(entry.text || ""),
                  timestamp: entry.timestamp || null,
                  status: entry.status || null,
                  meta: entry.meta || null,
                  outputPreview: entry.outputPreview || "",
                }
              : null
          ))
          .filter((entry) => entry?.text)
          .slice(-NATIVE_NARRATIVE_EVENT_LIMIT)
        : [],
      nativeNarrativeInputBuffer: String(nativeNarrativeInputBuffer || ""),
      clients: new Set(),
      metaBroadcastTimer: null,
      restoreOnStartup,
      providerState:
        providerState && typeof providerState === "object" ? { ...providerState } : null,
      workspaceId: String(workspaceId || ""),
      launchContext: launchContext && typeof launchContext === "object"
        ? { ...launchContext }
        : { kind: "workspace", relativePath: "." },
      lastResolvedCwd: String(lastResolvedCwd || cwd || ""),
      lastResolvedAt,
      workspaceRepair: workspaceRepair && typeof workspaceRepair === "object" ? { ...workspaceRepair } : null,
      autoRenameEnabled: Boolean(autoRenameEnabled),
      autoRenameBuffer: "",
      activityInputBuffer: "",
      activityIdleTimer: null,
      pendingProviderInputs: [],
      pendingProviderInputRetryTimer: null,
      providerReadyNotified: false,
      pendingProviderCapture: null,
      providerCapturePromise: null,
      providerCaptureRetryTimer: null,
      skipExitHandling: false,
      streamMode: Boolean(streamMode),
      streamSession: null,
      streamInputBuffer: "",
      streamEntries: [],
      // OpenCode-inspired: insertion-order sequence numbers are the only sort
      // key. Wall-clock timestamps from Claude's stream events bleed across
      // turns (a tool_use_result event's timestamp infects every subsequent
      // assistant entry's `updatedAt`). Sequence numbers don't have that
      // problem — first observation wins and they're stable across re-parses.
      entrySeqCounter: 0,
      // True between when the user sends a prompt and the underlying stream
      // session emits turn-complete. Lets the client render a persistent
      // "agent is working" indicator that survives across the pending /
      // streaming / tool-use phases — a single source of truth for "is the
      // agent done yet?".
      streamWorking: false,
    };
  }

  removeNativeNarrativeEntry(session, entryId) {
    if (!session || !entryId || !Array.isArray(session.nativeNarrativeEntries)) {
      return false;
    }
    const idx = session.nativeNarrativeEntries.findIndex((entry) => entry?.id === entryId);
    if (idx < 0) {
      return false;
    }
    session.nativeNarrativeEntries.splice(idx, 1);
    this.schedulePersist();
    return true;
  }

  pushNativeNarrativeEntry(session, entry) {
    if (!session || !entry || typeof entry !== "object") {
      return false;
    }

    const text = normalizeNarrativeEventText(entry.text || "");
    if (!text) {
      return false;
    }

    if (typeof session.entrySeqCounter !== "number") {
      session.entrySeqCounter = 0;
    }
    const seq = ++session.entrySeqCounter;
    const normalizedEntry = {
      id: String(entry.id || randomUUID()),
      kind: String(entry.kind || "status"),
      label: String(entry.label || "Activity"),
      text,
      timestamp: entry.timestamp || new Date().toISOString(),
      status: entry.status || null,
      meta: entry.meta || null,
      outputPreview: normalizeNarrativeEventText(entry.outputPreview || "", 2_200),
      seq,
    };

    const previousEntry = session.nativeNarrativeEntries[session.nativeNarrativeEntries.length - 1] || null;
    if (
      previousEntry
      && buildNarrativeEntryDedupKey(previousEntry) === buildNarrativeEntryDedupKey(normalizedEntry)
    ) {
      return false;
    }

    session.nativeNarrativeEntries.push(normalizedEntry);
    if (session.nativeNarrativeEntries.length > NATIVE_NARRATIVE_EVENT_LIMIT) {
      session.nativeNarrativeEntries.splice(0, session.nativeNarrativeEntries.length - NATIVE_NARRATIVE_EVENT_LIMIT);
    }

    this.schedulePersist();
    return true;
  }

  recordNativeNarrativeInput(session, input) {
    if (!session || session.providerId === "shell") {
      return;
    }

    const parsed = consumePromptInput(session.nativeNarrativeInputBuffer || "", input);
    session.nativeNarrativeInputBuffer = parsed.buffer;

    for (const completedLine of parsed.completedLines) {
      const normalizedLine = normalizeInitialPrompt(completedLine);
      if (!normalizedLine) {
        continue;
      }

      if (
        isClaudeProviderId(session.providerId)
        && normalizedLine === "1"
        && hasClaudeWorkspaceTrustPrompt(session.buffer)
      ) {
        continue;
      }

      const classified = classifyPromptEntry(normalizedLine);
      if (classified.kind === "hide" || !classified.text) {
        continue;
      }

      this.pushNativeNarrativeEntry(session, {
        kind: classified.kind === "status" ? "status" : "user",
        label: classified.kind === "status" ? "Kickoff" : "You",
        text: classified.text,
        timestamp: new Date().toISOString(),
      });
    }

    if (parsed.interrupted) {
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Interrupt",
        text: "Interrupted the current run.",
        timestamp: new Date().toISOString(),
        meta: "signal",
      });
    }
  }

  getNativeNarrativeEntries(session, { maxEntries = 96, includePlaceholder = true } = {}) {
    const entries = Array.isArray(session?.nativeNarrativeEntries)
      ? session.nativeNarrativeEntries.slice(-Math.max(1, Number(maxEntries) || 96))
      : [];

    if (entries.length) {
      return entries;
    }

    if (!includePlaceholder) {
      return [];
    }

    const timestamp = session?.updatedAt || session?.createdAt || new Date().toISOString();
    if (session?.status === "exited") {
      return [{
        id: `${session.id}-native-exited`,
        kind: "status",
        label: "Exited",
        text: `${session.providerLabel || "Session"} exited.`,
        timestamp,
        meta: "offline",
      }];
    }

    return [{
      id: `${session?.id || "session"}-native-starting`,
      kind: "status",
      label: "Starting",
      text: `Starting ${session?.providerLabel || "session"}. Native view will switch to provider-backed conversation data as it becomes available.`,
      timestamp,
      meta: "bootstrapping",
    }];
  }

  clearPendingProviderInputRetry(session) {
    if (!session?.pendingProviderInputRetryTimer) {
      return;
    }

    clearTimeout(session.pendingProviderInputRetryTimer);
    session.pendingProviderInputRetryTimer = null;
  }

  isProviderReadyForInput(session) {
    if (!session || session.providerId === "shell") {
      return true;
    }

    return providerHasReadyHint(session.providerId, session.buffer);
  }

  shouldQueueProviderInputUntilReady(session, input) {
    if (
      !session
      || session.status === "exited"
      || !session.pty
      || session.providerId === "shell"
      || session.lastPromptAt
      || !shouldDeferProviderInput(input)
    ) {
      return false;
    }

    if (isClaudeProviderId(session.providerId) && hasClaudeWorkspaceTrustPrompt(session.buffer)) {
      return false;
    }

    const provider = this.getProvider(session.providerId);
    if (!provider?.launchCommand || this.isProviderReadyForInput(session)) {
      return false;
    }

    return true;
  }

  performSessionWrite(session, input, { recordNarrativeInput = true } = {}) {
    if (!session || session.status === "exited" || !session.pty) {
      return false;
    }

    if (recordNarrativeInput) {
      this.recordNativeNarrativeInput(session, input);
    }

    this.queueAgentRunTracking(this.agentRunTracker?.handleInput(session, input));

    const stagedSubmit = splitProviderSubmitInput(session, input);
    if (stagedSubmit) {
      session.pty.write(stagedSubmit.body);
      this.setTimeoutFn(() => {
        const currentSession = this.sessions.get(session.id);
        if (currentSession !== session || session.status === "exited" || !session.pty) {
          return;
        }

        session.pty.write(stagedSubmit.submit);
      }, this.initialPromptSubmitDelayMs);
    } else {
      session.pty.write(input);
    }

    this.trackSessionInputActivity(session, input);
    this.maybeAutoRenameSessionFromInput(session, input);
    this.maybeRetryPendingProviderCaptureFromInput(session, input);
    session.updatedAt = new Date().toISOString();
    this.schedulePersist();
    return true;
  }

  schedulePendingProviderInputRetry(session) {
    if (!session?.pendingProviderInputs?.length || session.pendingProviderInputRetryTimer) {
      return;
    }

    session.pendingProviderInputRetryTimer = this.setTimeoutFn(() => {
      session.pendingProviderInputRetryTimer = null;
      this.flushDeferredProviderInputsIfReady(session);
    }, this.initialPromptRetryMs);
  }

  flushDeferredProviderInputsIfReady(session) {
    if (!session?.pendingProviderInputs?.length) {
      this.clearPendingProviderInputRetry(session);
      return false;
    }

    if (session.status === "exited" || !session.pty) {
      session.pendingProviderInputs = [];
      this.clearPendingProviderInputRetry(session);
      return false;
    }

    const oldestQueuedAt = Math.min(
      ...session.pendingProviderInputs.map((entry) => Number(entry?.queuedAt || 0)).filter((value) => Number.isFinite(value)),
    );
    const timedOut = Number.isFinite(oldestQueuedAt) && oldestQueuedAt > 0
      ? Date.now() - oldestQueuedAt >= this.initialPromptReadyTimeoutMs
      : false;

    if (!timedOut && !this.isProviderReadyForInput(session)) {
      this.schedulePendingProviderInputRetry(session);
      return false;
    }

    const queuedInputs = session.pendingProviderInputs.slice();
    session.pendingProviderInputs = [];
    this.clearPendingProviderInputRetry(session);

    for (const entry of queuedInputs) {
      this.performSessionWrite(session, entry.data, { recordNarrativeInput: false });
    }

    this.scheduleSessionMetaBroadcast(session, { immediate: true });
    return queuedInputs.length > 0;
  }

  queueProviderInputUntilReady(session, input) {
    if (!session) {
      return false;
    }

    session.pendingProviderInputs.push({
      data: input,
      queuedAt: Date.now(),
    });
    this.recordNativeNarrativeInput(session, input);
    this.maybeAutoRenameSessionFromInput(session, input);
    this.maybeRetryPendingProviderCaptureFromInput(session, input);
    this.pushNativeNarrativeEntry(session, {
      kind: "status",
      label: "Waiting",
      text: `Holding your message until ${session.providerLabel || "the provider"} finishes booting.`,
      timestamp: new Date().toISOString(),
      meta: "queued-input",
    });
    session.updatedAt = new Date().toISOString();
    this.scheduleSessionMetaBroadcast(session, { immediate: true });
    this.schedulePendingProviderInputRetry(session);
    this.schedulePersist();
    return true;
  }

  clearPendingProviderCaptureRetry(session) {
    if (session?.providerCaptureRetryTimer) {
      clearTimeout(session.providerCaptureRetryTimer);
      session.providerCaptureRetryTimer = null;
    }
  }

  updateProviderState(session, nextProviderState) {
    const previousSessionId = session?.providerState?.sessionId || "";
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
      this.clearPendingProviderInputRetry(session);
      this.clearPendingProviderCaptureRetry(session);
      session.pendingProviderCapture = null;
      session.providerCapturePromise = null;
    }
    if (
      normalizedState?.sessionId
      && normalizedState.sessionId !== previousSessionId
      && !session.streamMode
    ) {
      // Stream-mode sessions don't need this status — they're driven by the
      // structured event protocol, so "transcript connected" adds no signal.
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Connected",
        text: `${session.providerLabel || "Provider"} transcript connected.`,
        timestamp: new Date().toISOString(),
        meta: "provider-backed",
      });
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
      this.clearPendingProviderInputRetry(session);
      this.clearPendingProviderCaptureRetry(session);
      session.pendingProviderCapture = null;
      session.providerCapturePromise = null;
      return;
    }

    this.clearPendingProviderInputRetry(session);
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
      this.clearPendingProviderInputRetry(session);
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
      ensureClaudeFolderTrusted(session.cwd, this.env);
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
      const createCommand = buildShellCommand(launchCommand, getCodexLaunchArgs(session.cwd));
      const resumeLastCommand = buildShellCommand(launchCommand, getCodexLaunchArgs(session.cwd, ["resume", "--last"]));
      const knownSessions = matchCodexSessionsByCwd(
        await listCodexTrackedSessions(this.userHomeDir),
        session.cwd,
      );
      const existingSessionId = session.providerState?.sessionId || null;

      if (!restored && existingSessionId) {
        this.setPendingProviderCapture(session, null);
        return {
          commandString: buildFallbackCommand([
            buildShellCommand(launchCommand, getCodexLaunchArgs(session.cwd, ["resume", existingSessionId])),
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
          ? buildShellCommand(launchCommand, getCodexLaunchArgs(session.cwd, ["resume", restoreSessionId]))
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
        commandString: buildOpenClawLaunchCommand(provider.launchCommand),
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
    // Ctrl-U (kill-line) clears any escape-sequence garbage the shell may
    // have buffered — e.g. DA responses echoed back from xterm.js before the
    // launch command is injected. Without this, the user sees junk like
    // "^[[?1;2c^[[>0;276;0c" prepended to the launch command.
    ptyProcess.write(`\x15${commandString}\r`);

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
    const workspaceResolution = this.repairSessionWorkspace(session, { markBlocked: true });
    if (!workspaceResolution.cwd) {
      throw new Error(`Working directory does not exist: ${workspaceResolution.missingCwd || session.cwd || this.cwd}`);
    }

    if (session.streamMode) {
      if (isClaudeProviderId(provider.id)) {
        this.startClaudeStreamSession(session, provider, { restored });
        return;
      }
      if (provider.id === "codex") {
        this.startCodexStreamSession(session, provider, { restored });
        return;
      }
      // Unknown stream-mode provider — fall back to PTY.
      session.streamMode = false;
    }

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
    session.nativeNarrativeInputBuffer = "";
    session.pendingProviderInputs = [];
    session.providerReadyNotified = false;
    this.clearPendingProviderInputRetry(session);
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

    this.pushNativeNarrativeEntry(session, {
      kind: "status",
      label: restored ? "Restored" : "Launch",
      text: restored
        ? `Restored ${provider.label} in ${sessionCwd}.`
        : `Launching ${provider.label} in ${sessionCwd}.`,
      timestamp: session.updatedAt,
      meta: terminalLaunch.backend === "tmux" ? "persistent-terminal" : "pty",
    });

    if (provider.launchCommand && !terminalLaunch.attachedExisting) {
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Waiting",
        text: `Waiting for ${provider.label} to expose native session history.`,
        timestamp: session.updatedAt,
        meta: "bootstrapping",
      });
    }

    this.pushOutput(session, bannerLines.join("\r\n"));

    ptyProcess.onData((chunk) => {
      session.updatedAt = new Date().toISOString();
      session.lastOutputAt = session.updatedAt;
      this.agentRunTracker?.handleOutput(session, chunk);
      this.trackSessionOutputActivity(session);
      this.pushOutput(session, chunk);
      if (!session.providerReadyNotified && this.isProviderReadyForInput(session)) {
        session.providerReadyNotified = true;
        this.pushNativeNarrativeEntry(session, {
          kind: "status",
          label: "Ready",
          text: `${provider.label} is ready for prompts.`,
          timestamp: session.updatedAt,
          meta: "provider-ready",
        });
      }
      this.flushDeferredProviderInputsIfReady(session);
      this.scheduleSessionMetaBroadcast(session);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.pty = null;
      this.clearPendingProviderInputRetry(session);
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
        this.pushNativeNarrativeEntry(session, {
          kind: "status",
          label: "Reattaching",
          text: `Persistent terminal detached; reattaching ${tmuxSessionName}.`,
          timestamp: session.updatedAt,
          meta: "persistent-terminal",
        });
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
      session.pendingProviderInputs = [];
      this.clearPendingProviderInputRetry(session);
      session.updatedAt = new Date().toISOString();
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Exited",
        text: `Session exited (code ${exitCode}${signal ? `, signal ${signal}` : ""}).`,
        timestamp: session.updatedAt,
        status: exitCode === 0 ? "done" : "error",
        meta: "process-exit",
      });

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

  startClaudeStreamSession(session, provider, { restored = false } = {}) {
    const sessionCwd = resolveCwd(session.cwd, this.cwd);
    session.cwd = sessionCwd;
    const sessionEnv = this.buildSessionEnvironment(session, provider.id);
    writeProviderCredentialEnvFile(sessionEnv);

    if (restored) {
      // Stream-mode child processes don't survive a server restart. Mark the
      // session exited and let the user start a new one.
      session.status = "exited";
      session.exitCode = null;
      session.exitSignal = null;
      session.streamSession = null;
      session.restoreOnStartup = false;
      session.updatedAt = new Date().toISOString();
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Stream",
        text: "Stream-mode sessions don't survive server restarts. Start a new agent to continue.",
        timestamp: session.updatedAt,
        meta: "stream-mode",
      });
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
      return;
    }

    const claudeBin = getManagedProviderLaunchCommand(provider) || provider.launchCommand;
    if (!claudeBin) {
      session.status = "exited";
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Error",
        text: `Cannot find Claude launch binary for stream mode (${provider.label}).`,
        timestamp: new Date().toISOString(),
        meta: "stream-mode",
      });
      return;
    }

    const streamSession = new ClaudeStreamSession({
      sessionId: session.id,
      cwd: sessionCwd,
      env: sessionEnv,
      claudeBin,
      allocateSeq: () => {
        if (typeof session.entrySeqCounter !== "number") {
          session.entrySeqCounter = 0;
        }
        session.entrySeqCounter += 1;
        return session.entrySeqCounter;
      },
    });

    session.streamSession = streamSession;
    session.streamInputBuffer = "";
    session.streamEntries = [];
    session.status = "running";
    session.exitCode = null;
    session.exitSignal = null;
    session.restoreOnStartup = true;
    session.activityInputBuffer = "";
    session.nativeNarrativeInputBuffer = "";
    session.providerReadyNotified = true;
    session.updatedAt = new Date().toISOString();
    session.lastOutputAt = session.updatedAt;

    this.pushNativeNarrativeEntry(session, {
      kind: "status",
      label: "Stream",
      text: `Stream mode active for ${provider.label}. Replies stream from JSONL events instead of a PTY.`,
      timestamp: session.updatedAt,
      meta: "stream-mode",
    });

    streamSession.on("event", () => {
      session.lastOutputAt = new Date().toISOString();
      session.updatedAt = session.lastOutputAt;
    });

    streamSession.on("entries", (entries) => {
      session.streamEntries = Array.isArray(entries) ? entries : [];
      // Push narrative diffs over the WS so the client reducer applies
      // upserts/removes directly — no HTTP round-trip required. The legacy
      // session-meta broadcast still fires alongside (cheap; small payload)
      // because session-level fields like backgroundActivity ride on it.
      this.broadcastNarrativeDiff(session);
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
    });

    streamSession.on("turn-complete", () => {
      session.streamWorking = false;
      this.broadcastNarrativeDiff(session);
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
      this.schedulePersist();
    });

    streamSession.on("stderr", (chunk) => {
      const text = String(chunk || "").trim();
      if (text) {
        console.warn(`[vibe-research] claude stream stderr (${session.id}):`, text);
      }
    });

    streamSession.on("error", (error) => {
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Error",
        text: `Claude stream error: ${error.message}`,
        timestamp: new Date().toISOString(),
        meta: "stream-mode",
      });
      this.broadcastNarrativeDiff(session);
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
    });

    streamSession.on("exit", ({ code, signal }) => {
      session.status = "exited";
      session.exitCode = code;
      session.exitSignal = signal;
      session.streamSession = null;
      session.streamWorking = false;
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Exited",
        text: `Stream session exited (code=${code ?? "n/a"}, signal=${signal || "n/a"}).`,
        timestamp: new Date().toISOString(),
        meta: "stream-mode",
      });
      this.broadcastNarrativeDiff(session);
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
      this.schedulePersist({ immediate: true });
    });

    streamSession.start();
  }

  startCodexStreamSession(session, provider, { restored = false } = {}) {
    const sessionCwd = resolveCwd(session.cwd, this.cwd);
    session.cwd = sessionCwd;
    const sessionEnv = this.buildSessionEnvironment(session, provider.id);
    writeProviderCredentialEnvFile(sessionEnv);

    if (restored) {
      // Per-turn child processes don't survive across restarts, but we DO
      // remember the codex thread id from the persisted providerState so the
      // first new turn can resume the same Codex thread automatically.
      session.status = "running";
      session.exitCode = null;
      session.exitSignal = null;
      session.restoreOnStartup = true;
    }

    const codexBin = getManagedProviderLaunchCommand(provider) || provider.launchCommand;
    if (!codexBin) {
      session.status = "exited";
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Error",
        text: `Cannot find Codex launch binary for stream mode (${provider.label}).`,
        timestamp: new Date().toISOString(),
        meta: "stream-mode",
      });
      return;
    }

    const streamSession = new CodexStreamSession({
      sessionId: session.id,
      cwd: sessionCwd,
      env: sessionEnv,
      codexBin,
      allocateSeq: () => {
        if (typeof session.entrySeqCounter !== "number") {
          session.entrySeqCounter = 0;
        }
        session.entrySeqCounter += 1;
        return session.entrySeqCounter;
      },
    });

    // Pre-seed the threadId from previously persisted providerState so the
    // first turn after a restart resumes the prior Codex conversation.
    const persistedThreadId = String(session.providerState?.sessionId || "").trim();
    if (persistedThreadId) {
      streamSession.threadId = persistedThreadId;
    }

    session.streamSession = streamSession;
    session.streamInputBuffer = "";
    session.streamEntries = [];
    session.status = "running";
    session.exitCode = null;
    session.exitSignal = null;
    session.restoreOnStartup = true;
    session.activityInputBuffer = "";
    session.nativeNarrativeInputBuffer = "";
    session.providerReadyNotified = true;
    session.updatedAt = new Date().toISOString();
    session.lastOutputAt = session.updatedAt;

    this.pushNativeNarrativeEntry(session, {
      kind: "status",
      label: "Stream",
      text: restored
        ? `Stream mode active for ${provider.label} (resuming prior thread).`
        : `Stream mode active for ${provider.label}. Each turn runs codex exec --json.`,
      timestamp: session.updatedAt,
      meta: "stream-mode",
    });

    streamSession.on("event", () => {
      session.lastOutputAt = new Date().toISOString();
      session.updatedAt = session.lastOutputAt;
    });

    streamSession.on("entries", (entries) => {
      session.streamEntries = Array.isArray(entries) ? entries : [];
      this.broadcastNarrativeDiff(session);
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
    });

    streamSession.on("turn-complete", () => {
      session.streamWorking = false;
      // Persist the codex thread id so reloads can resume in the same thread.
      if (streamSession.threadId) {
        this.updateProviderState(session, { sessionId: streamSession.threadId });
      }
      this.broadcastNarrativeDiff(session);
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
      this.schedulePersist();
    });

    streamSession.on("stderr", (chunk) => {
      const text = String(chunk || "").trim();
      if (text) {
        console.warn(`[vibe-research] codex stream stderr (${session.id}):`, text);
      }
    });

    streamSession.on("error", (error) => {
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Error",
        text: `Codex stream error: ${error.message}`,
        timestamp: new Date().toISOString(),
        meta: "stream-mode",
      });
      this.broadcastNarrativeDiff(session);
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
    });

    streamSession.on("exit", ({ code, signal }) => {
      session.status = "exited";
      session.exitCode = code;
      session.exitSignal = signal;
      session.streamSession = null;
      session.streamWorking = false;
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Exited",
        text: `Stream session exited (code=${code ?? "n/a"}, signal=${signal || "n/a"}).`,
        timestamp: new Date().toISOString(),
        meta: "stream-mode",
      });
      this.broadcastNarrativeDiff(session);
      this.scheduleSessionMetaBroadcast(session, { immediate: true });
      this.schedulePersist({ immediate: true });
    });

    streamSession.start();
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
      nativeNarrativeEntries: snapshot.nativeNarrativeEntries || [],
      nativeNarrativeInputBuffer: snapshot.nativeNarrativeInputBuffer || "",
      restoreOnStartup: Boolean(snapshot.restoreOnStartup),
      providerState: snapshot.providerState || null,
      workspaceId: snapshot.workspaceId || "",
      launchContext: snapshot.launchContext || null,
      lastResolvedCwd: snapshot.lastResolvedCwd || "",
      lastResolvedAt: snapshot.lastResolvedAt || null,
      workspaceRepair: snapshot.workspaceRepair || null,
      occupationId: snapshot.occupationId || snapshot.promptId || this.occupationId,
      streamMode: Boolean(snapshot.streamMode),
    });

    this.sessions.set(session.id, session);
    const workspaceResolution = this.repairSessionWorkspace(session, { markBlocked: true });

    const revivePersistentTerminal = workspaceResolution.cwd ? this.shouldRevivePersistentTerminal(session) : false;

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
      this.pushNativeNarrativeEntry(session, {
        kind: "status",
        label: "Reattaching",
        text: `Persistent terminal still exists; reattaching ${session.providerState.tmuxSessionName}.`,
        timestamp: new Date().toISOString(),
        meta: "persistent-terminal",
      });
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
    this.pushNativeNarrativeEntry(session, {
      kind: "status",
      label: "Restore failed",
      text: message,
      timestamp: session.updatedAt,
      status: "error",
      meta: "restore-failure",
    });
    this.pushOutput(session, buildPersistedExitMessage(message));
  }

  getProvider(providerId) {
    return this.providers.find((entry) => entry.id === providerId) ?? null;
  }

  serializePersistedSession(session) {
    return {
      ...this.serializeSession(session),
      buffer: session.buffer,
      nativeNarrativeEntries: session.nativeNarrativeEntries,
      nativeNarrativeInputBuffer: session.nativeNarrativeInputBuffer,
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

export const claudePromptDetectionInternals = Object.freeze({
  detectClaudeLoginChooser,
  detectClaudeOAuthUrl,
  detectClaudeApiKeyPrompt,
  detectClaudeCreditRefill,
  detectClaudePrompt,
});
