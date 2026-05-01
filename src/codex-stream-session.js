// Codex stream-mode session — Phase 6 of the migration in
// docs/claude-stream-mode.md. Same shape as ClaudeStreamSession but for
// `codex exec --json`, which is one-shot per turn (not long-running). We
// spawn a fresh child process for each user turn, capture thread_id from
// `thread.started`, and resume that thread on subsequent turns via
// `codex exec resume <thread_id>`.
//
// Event reference (codex-rs/exec/src/exec_events.rs):
//   thread.started     { thread_id }
//   turn.started       {}
//   item.started       { item: { id, type, ...details } }
//   item.updated       { item: { id, type, ...details } }
//   item.completed     { item: { id, type, ...details } }
//   turn.completed     { usage: {...} }
//   turn.failed        { error }
//   error              { message }
// item.type values: agent_message, reasoning, command_execution,
// file_change, mcp_tool_call.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_CODEX_BIN = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "bin", "codex");
})();

const DEFAULT_MAX_ENTRIES = 96;

// Pull whatever text-bearing fields a Codex `reasoning` item carries
// (depends on the model + responses-API version). Returns "" when
// the payload has no human-readable content; the caller treats that
// as "skip this row" so we don't emit empty Thinking placeholders.
// Mirrors the resume-time helper at session-native-narrative.js so
// live and resumed Codex sessions surface reasoning identically.
export function extractCodexReasoningText(item) {
  if (!item || typeof item !== "object") return "";
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const chunks = [];
  for (const part of summary) {
    if (typeof part === "string" && part.trim()) {
      chunks.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      if (typeof part.text === "string" && part.text.trim()) {
        chunks.push(part.text);
        continue;
      }
      if (typeof part.summary === "string" && part.summary.trim()) {
        chunks.push(part.summary);
      }
    }
  }
  if (typeof item.text === "string" && item.text.trim()) {
    chunks.push(item.text);
  }
  return chunks.join("\n\n").trim();
}

// Map a shell command line to the Claude-style tool label (Read /
// Grep / Glob / Bash) so the renderer's compact-tool path picks the
// matching badge and treatment. Codex emits everything as a generic
// `command_execution` item; without this dispatch every shell call
// would render as "Bash", losing the Read/Grep/Glob distinction the
// rest of the chat surface uses.
//
// Heuristics — first executable token only, ignore flags:
//   rg | grep | egrep | fgrep            → Grep
//   cat | head | tail | bat | less | more (with a path arg) → Read
//   find | fd | ls (with a glob arg)     → Glob
//   anything else                        → Bash
//
// Pulled out as a pure module-level function so it has direct unit
// tests in test/codex-stream-session.test.js.
export function classifyShellCommandLabel(command) {
  const text = String(command || "").trim();
  if (!text) return "Bash";

  // Strip a leading `sudo` / `time` / `env VAR=val` wrapper so e.g.
  // `sudo cat /etc/hosts` still classifies as Read.
  let working = text;
  while (true) {
    const wrapperMatch = working.match(/^(?:sudo|time|nohup|env(?:\s+\w+=\S+)*)\s+/u);
    if (!wrapperMatch) break;
    working = working.slice(wrapperMatch[0].length);
  }

  // First whitespace-delimited token — strip an optional path prefix
  // (`/usr/bin/grep` → `grep`).
  const firstToken = working.split(/\s+/u, 1)[0] || "";
  const exe = firstToken.split("/").filter(Boolean).pop() || "";
  const lowered = exe.toLowerCase();

  if (/^(?:rg|grep|egrep|fgrep|ack|ag)$/u.test(lowered)) {
    return "Grep";
  }
  if (/^(?:cat|head|tail|bat|less|more)$/u.test(lowered)) {
    // Only call it Read when there's an actual path/file arg — `tail
    // -f /var/log/foo` reads, but bare `cat` (rare) is just bash.
    const restAfterExe = working.slice(firstToken.length).trim();
    if (restAfterExe) return "Read";
    return "Bash";
  }
  if (/^(?:find|fd|ls|tree)$/u.test(lowered)) {
    return "Glob";
  }
  return "Bash";
}

export class CodexStreamSession extends EventEmitter {
  constructor({
    sessionId = randomUUID(),
    cwd = process.cwd(),
    codexBin = DEFAULT_CODEX_BIN,
    extraArgs = [],
    env = process.env,
    maxEntries = DEFAULT_MAX_ENTRIES,
    allocateSeq = null,
  } = {}) {
    super();
    this.sessionId = sessionId;
    this.threadId = "";
    this.cwd = cwd;
    this.codexBin = codexBin;
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs : [];
    this.env = env;
    this.maxEntries = Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
    this.status = "idle";
    this.lastEventAt = "";
    this.entries = [];
    this.stderrBuffer = "";
    this._allocateSeq = typeof allocateSeq === "function" ? allocateSeq : (() => 0);
    this._entrySeqs = new Map();
    this._entryStamps = new Map();
    // The flat ordered list of entries we've ever seen across all turns.
    // Each entry is keyed by `${turnIndex}::${itemId}` so item ids reused
    // across turns don't collide.
    this._allEntries = [];
    this._turnIndex = 0;
    this._activeChild = null;
    this._activeStdoutBuffer = "";
    this._pendingThinking = false;
  }

  start() {
    // No long-running process for codex exec; each turn spawns its own.
    return this;
  }

  send(text) {
    const value = String(text ?? "").trim();
    if (!value) {
      return false;
    }
    if (this._activeChild) {
      // Codex exec is one-shot. Reject overlapping turns.
      this.emit("error", new Error("CodexStreamSession is busy with a prior turn"));
      return false;
    }
    this._spawnTurn(value);
    return true;
  }

  close() {
    if (this._activeChild) {
      try {
        this._activeChild.kill("SIGTERM");
      } catch {
        // child already exited
      }
      this._activeChild = null;
    }
    this.status = "exited";
    this.emit("exit", { code: 0, signal: null });
  }

  _spawnTurn(prompt) {
    this._turnIndex += 1;
    const turnIndex = this._turnIndex;

    // Pending placeholder for the new turn — same OpenCode pattern as
    // ClaudeStreamSession. Renders as the spinner until the first
    // assistant/tool item arrives.
    this._pendingThinking = true;
    this._refreshEntries();

    const args = ["exec", "--json", "--skip-git-repo-check"];
    if (this.threadId) {
      args.splice(1, 0, "resume", this.threadId);
    }
    args.push(...this.extraArgs);
    args.push(prompt);

    const child = spawn(this.codexBin, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this._activeChild = child;
    this._activeStdoutBuffer = "";
    this.status = "running";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._handleStdoutChunk(turnIndex, chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 32 * 1024) {
        this.stderrBuffer = this.stderrBuffer.slice(-16 * 1024);
      }
      this.emit("stderr", chunk);
    });

    child.on("error", (error) => {
      this._pendingThinking = false;
      this._activeChild = null;
      this.emit("error", error);
      this.status = "idle";
    });

    child.on("close", (code, signal) => {
      this._flushStdoutBuffer(turnIndex);
      this._pendingThinking = false;
      this._activeChild = null;
      this.status = "idle";
      this._refreshEntries();
      this.emit("turn-complete", { code, signal });
    });
  }

  _handleStdoutChunk(turnIndex, chunk) {
    this._activeStdoutBuffer += chunk;
    let nl = this._activeStdoutBuffer.indexOf("\n");
    while (nl !== -1) {
      const line = this._activeStdoutBuffer.slice(0, nl);
      this._activeStdoutBuffer = this._activeStdoutBuffer.slice(nl + 1);
      this._handleLine(turnIndex, line);
      nl = this._activeStdoutBuffer.indexOf("\n");
    }
  }

  _flushStdoutBuffer(turnIndex) {
    if (this._activeStdoutBuffer.trim()) {
      this._handleLine(turnIndex, this._activeStdoutBuffer);
      this._activeStdoutBuffer = "";
    }
  }

  _handleLine(turnIndex, rawLine) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line) {
      return;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.emit("non-json", line);
      return;
    }

    const stamp = new Date().toISOString();
    this.lastEventAt = stamp;

    if (event?.type === "thread.started" && typeof event.thread_id === "string") {
      this.threadId = event.thread_id;
    } else if (event?.type === "turn.started") {
      // _pendingThinking already true from _spawnTurn
    } else if (event?.type === "item.started" || event?.type === "item.updated") {
      this._upsertItemEntry(turnIndex, event.item, stamp, /* completed */ false);
    } else if (event?.type === "item.completed") {
      this._upsertItemEntry(turnIndex, event.item, stamp, /* completed */ true);
      this._pendingThinking = false;
    } else if (event?.type === "turn.completed") {
      this._pendingThinking = false;
    } else if (event?.type === "turn.failed" || event?.type === "error") {
      this._pendingThinking = false;
      const rawMessage = event.error?.message || event.message || "Codex turn failed";
      const isAuthFailure = /401\s*Unauthorized|Missing\s+bearer|not\s*authenticated|please\s+sign\s+in|codex\s+login/iu.test(rawMessage);
      // Codex retries 5 times on 401 before giving up — that's a multi-second
      // hang for the user. As soon as we see the first auth failure, surface
      // it prominently and kill the child so retries don't pile up.
      const message = isAuthFailure
        ? "Codex is not signed in. Run `codex login` in a terminal, then try again."
        : rawMessage;
      this._appendEntry({
        id: `codex-error-${turnIndex}-${randomUUID()}`,
        kind: "status",
        label: isAuthFailure ? "Sign in required" : "Error",
        text: message,
        timestamp: stamp,
        meta: isAuthFailure ? "codex-auth-required" : "codex-error",
        status: "error",
      });
      if (isAuthFailure && this._activeChild) {
        try {
          this._activeChild.kill("SIGTERM");
        } catch {
          // child already exited
        }
      }
    }

    this._refreshEntries();
    this.emit("event", event);
  }

  _upsertItemEntry(turnIndex, item, stamp, completed) {
    if (!item || typeof item !== "object" || !item.id) {
      return;
    }
    const key = `codex-${turnIndex}-${item.id}`;
    const existing = this._allEntries.find((entry) => entry.id === key);
    const built = this._buildEntryForItem(key, item, stamp, completed);
    if (!built) {
      return;
    }
    if (existing) {
      Object.assign(existing, built, { id: key });
    } else {
      this._appendEntry(built);
    }
  }

  _buildEntryForItem(id, item, stamp, completed) {
    const type = String(item.type || "").trim();
    const baseMeta = completed ? "completed" : "running";
    if (type === "agent_message") {
      const text = String(item.text || "");
      if (!text.trim()) {
        return null;
      }
      return {
        id,
        kind: "assistant",
        label: "Codex",
        text,
        timestamp: stamp,
        meta: completed ? null : "streaming",
      };
    }
    if (type === "reasoning") {
      // Codex emits `reasoning` for visible reasoning blocks. Match
      // Claude's wire shape so the renderer's thinking path picks it
      // up: kind "status" + label "Thinking" + thinking:true. The
      // renderer's body branch then wraps the text in a <details>
      // collapsible so the chat stays scannable but the reasoning is
      // one click away. Empty/whitespace summaries fall through to
      // null (filtered out at the appendEntry boundary) — see #129
      // for why we skip placeholder Thinking rows.
      const text = extractCodexReasoningText(item);
      if (!text) return null;
      return {
        id,
        kind: "status",
        label: "Thinking",
        text,
        timestamp: stamp,
        thinking: true,
      };
    }
    if (type === "command_execution") {
      const command = String(item.command || "").trim();
      const rawOutput = String(item.aggregated_output || "");
      // Tool output can be tens of KB (file dumps, JSON arrays, grep
      // across a tree). The renderer's compact-tool path already wraps
      // long output in a <details> element that stays collapsed until
      // the user clicks "show more" — so we want to send MORE bytes
      // than the previous 1.2K+400B cap, not fewer. Bump to 4K head +
      // 1K tail (~5KB total) so substantive output survives, but keep
      // the head/tail elision pattern so a 200KB log dump can't blow
      // up the entry list. Matches the spirit of Claude's tool_result
      // truncation cap (2.2KB; we go higher because the compact
      // renderer's collapse hides the bulk by default).
      const previewLimit = 4000;
      const tailLimit = 1000;
      let outputPreview = rawOutput.trim();
      if (rawOutput.length > previewLimit + tailLimit + 80) {
        const head = rawOutput.slice(0, previewLimit).trimEnd();
        const tail = rawOutput.slice(-tailLimit).trimStart();
        const elided = rawOutput.length - previewLimit - tailLimit;
        outputPreview = `${head}\n\n… (${elided.toLocaleString()} more chars elided) …\n\n${tail}`;
      }
      const exitCode = item.exit_code;
      const status = completed ? (exitCode === 0 ? "done" : "error") : "running";
      // Per-tool dispatch on the actual command so the renderer can
      // pick the right badge / compact treatment instead of bucketing
      // everything as "Bash". Keys off the first executable token,
      // not flags — the renderer's isCompactToolEntry check at
      // renderRichSessionEntry recognises Read/Grep/Glob and gives
      // them the same compact one-line + expand affordance Claude's
      // tool_use cards get.
      const label = classifyShellCommandLabel(command);
      return {
        id,
        kind: "tool",
        label,
        text: command,
        outputPreview,
        timestamp: stamp,
        meta: baseMeta,
        status,
      };
    }
    if (type === "file_change") {
      const summary = String(item.summary || item.path || "file change").trim();
      return {
        id,
        kind: "tool",
        label: "Edit",
        text: summary,
        timestamp: stamp,
        meta: baseMeta,
        status: completed ? "done" : "running",
      };
    }
    if (type === "mcp_tool_call") {
      const tool = String(item.tool || item.name || "MCP").trim() || "MCP";
      const text = String(item.input || item.arguments || "").trim();
      return {
        id,
        kind: "tool",
        label: tool,
        text,
        timestamp: stamp,
        meta: baseMeta,
        status: completed ? "done" : "running",
      };
    }
    // Unknown item type — render generically
    return {
      id,
      kind: "status",
      label: type || "Item",
      text: JSON.stringify(item).slice(0, 240),
      timestamp: stamp,
      meta: "codex-item",
    };
  }

  _appendEntry(entry) {
    this._allEntries.push(entry);
    if (this._allEntries.length > this.maxEntries * 2) {
      this._allEntries.splice(0, this._allEntries.length - this.maxEntries * 2);
    }
  }

  _refreshEntries() {
    const stamp = new Date().toISOString();
    const stampedRaw = this._allEntries.map((entry, index) => {
      const cacheKey = entry?.id || `raw-${index}`;
      let cachedStamp = this._entryStamps.get(cacheKey);
      if (!cachedStamp) {
        cachedStamp = entry.timestamp || stamp;
        this._entryStamps.set(cacheKey, cachedStamp);
      }
      let seq = this._entrySeqs.get(cacheKey);
      if (seq == null) {
        seq = this._allocateSeq();
        this._entrySeqs.set(cacheKey, seq);
      }
      return { ...entry, timestamp: cachedStamp, seq };
    });

    if (this._pendingThinking) {
      const cacheKey = `codex-pending-${this._turnIndex}`;
      let seq = this._entrySeqs.get(cacheKey);
      if (seq == null) {
        seq = this._allocateSeq();
        this._entrySeqs.set(cacheKey, seq);
      }
      stampedRaw.push({
        id: cacheKey,
        kind: "assistant",
        label: "Codex",
        text: "",
        timestamp: stamp,
        meta: "pending",
        seq,
      });
    }

    this.entries = stampedRaw.slice(-this.maxEntries);
    this.emit("entries", this.entries);
  }
}

export function createCodexStreamSession(options = {}) {
  return new CodexStreamSession(options).start();
}
