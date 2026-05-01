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
      // Surface token usage as a quiet status row at the end of the
      // turn. Schema: { usage: { input_tokens, cached_input_tokens,
      // output_tokens, reasoning_output_tokens } }. The previous
      // implementation dropped this entirely; users had no visibility
      // into per-turn cost. Cached tokens are surfaced inline when
      // non-zero so prompt-caching wins are visible.
      const usage = event.usage || {};
      const inputTokens = Number(usage.input_tokens || 0);
      const cachedTokens = Number(usage.cached_input_tokens || 0);
      const outputTokens = Number(usage.output_tokens || 0);
      const reasoningTokens = Number(usage.reasoning_output_tokens || 0);
      const totalTokens = inputTokens + outputTokens + reasoningTokens;
      if (totalTokens > 0) {
        const parts = [`${totalTokens.toLocaleString()} tokens`];
        const detailBits = [];
        if (inputTokens) detailBits.push(`in ${inputTokens.toLocaleString()}`);
        if (cachedTokens) detailBits.push(`cached ${cachedTokens.toLocaleString()}`);
        if (outputTokens) detailBits.push(`out ${outputTokens.toLocaleString()}`);
        if (reasoningTokens) detailBits.push(`reasoning ${reasoningTokens.toLocaleString()}`);
        const detail = detailBits.length ? ` (${detailBits.join(", ")})` : "";
        this._appendEntry({
          id: `codex-usage-${turnIndex}`,
          kind: "status",
          label: "Usage",
          text: `${parts[0]}${detail}`,
          timestamp: stamp,
          meta: "codex-usage",
        });
      }
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
    const baseKey = `codex-${turnIndex}-${item.id}`;
    const built = this._buildEntryForItem(baseKey, item, stamp, completed);
    if (!built) {
      return;
    }
    // file_change items expand into one entry per file (mirrors Claude's
    // per-file Edit/Write rows). Everything else returns a single entry.
    const built_list = Array.isArray(built) ? built : [built];
    for (const entry of built_list) {
      if (!entry?.id) continue;
      const existing = this._allEntries.find((existingEntry) => existingEntry.id === entry.id);
      if (existing) {
        Object.assign(existing, entry);
      } else {
        this._appendEntry(entry);
      }
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
      // Schema: { changes: [{path, kind: "add"|"delete"|"update"}], status }
      // The previous implementation read item.summary / item.path which
      // don't exist in the upstream schema (codex-rs/exec/src/exec_events.rs
      // FileChangeItem) — every file change rendered as the literal
      // string "file change" with no useful info. Now we expand into one
      // entry per file so the renderer's compact-tool path gives each
      // its own Add/Delete/Update badge, mirroring how Claude renders
      // per-file Edit/Write tool_use rows.
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const status = completed
        ? (String(item.status || "").toLowerCase() === "failed" ? "error" : "done")
        : "running";
      if (!changes.length) {
        return {
          id,
          kind: "tool",
          label: "Edit",
          text: "file change (no paths reported)",
          timestamp: stamp,
          meta: baseMeta,
          status,
        };
      }
      return changes.map((change, fileIdx) => {
        const path = String(change?.path || "(unknown)").trim();
        const kind = String(change?.kind || "update").toLowerCase();
        // Map kind -> Claude-style label so the renderer's tool-label
        // dispatch gives each its visual treatment. "Write" for new
        // files, "Edit" for updates (existing convention), and a
        // dedicated "Delete" badge — none of the existing label
        // dispatch recognises Delete as a known label, so it'll fall
        // back to the generic tool styling, which is fine.
        const label = kind === "add" ? "Write" : kind === "delete" ? "Delete" : "Edit";
        return {
          id: `${id}::${fileIdx}`,
          kind: "tool",
          label,
          text: path,
          timestamp: stamp,
          meta: baseMeta,
          status,
        };
      });
    }
    if (type === "mcp_tool_call") {
      // Schema: { server, tool, arguments, result: { content, structured_content }, error, status }
      // The previous implementation read item.tool / item.input — server
      // wasn't surfaced (so the renderer's MCP badge at main.js:6027
      // never fired) and result.content was thrown away (so the user
      // never saw what the MCP call returned).
      const server = String(item.server || "").trim();
      const tool = String(item.tool || item.name || "MCP").trim() || "MCP";
      const args = item.arguments;
      const text = typeof args === "string"
        ? args.trim()
        : args && typeof args === "object"
        ? JSON.stringify(args)
        : "";
      const failed = String(item.status || "").toLowerCase() === "failed";
      const errorMessage = String(item.error?.message || "").trim();
      // Concatenate text content blocks from result.content. Each block
      // is an MCP content shape — we surface { type: "text", text } and
      // ignore image/resource blocks here (those need separate rendering
      // we don't have hooks for yet). structured_content is a JSON dump
      // fallback so the user at least sees the payload.
      const resultContent = Array.isArray(item.result?.content) ? item.result.content : [];
      const textBlocks = [];
      for (const block of resultContent) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          textBlocks.push(block.text);
        }
      }
      const structured = item.result?.structured_content;
      let outputPreview = "";
      if (failed && errorMessage) {
        outputPreview = `Error: ${errorMessage}`;
      } else if (textBlocks.length) {
        outputPreview = textBlocks.join("\n\n").trim();
      } else if (structured !== undefined && structured !== null) {
        try {
          outputPreview = typeof structured === "string"
            ? structured
            : JSON.stringify(structured, null, 2);
        } catch {
          outputPreview = String(structured);
        }
      }
      // Cap MCP output the same way command_execution caps it; same
      // rationale (renderer's <details> collapse keeps long output
      // out of view by default).
      if (outputPreview.length > 5000) {
        const head = outputPreview.slice(0, 4000).trimEnd();
        const tail = outputPreview.slice(-1000).trimStart();
        const elided = outputPreview.length - 4000 - 1000;
        outputPreview = `${head}\n\n… (${elided.toLocaleString()} more chars elided) …\n\n${tail}`;
      }
      return {
        id,
        kind: "tool",
        label: tool,
        text,
        outputPreview: outputPreview || undefined,
        timestamp: stamp,
        meta: baseMeta,
        status: completed ? (failed ? "error" : "done") : "running",
        // Structured field the renderer reads to attach the MCP server
        // badge (main.js:6027). Without this, mcp_tool_call entries
        // looked like generic tool entries with no server attribution.
        ...(server ? { mcp: { server, tool } } : {}),
      };
    }
    if (type === "todo_list") {
      // Schema: { items: [{text, completed}] }
      // Renderer at main.js:6121 detects label === "TodoWrite" + a
      // todos array and renders the compact "N tasks: x done · y open"
      // tick — same audit row Claude's TodoWrite uses. Codex's todo
      // schema only carries {text, completed:bool} (no in_progress
      // concept), so map completed -> "completed", else "pending".
      const items = Array.isArray(item.items) ? item.items : [];
      const todos = items.map((todo) => ({
        text: String(todo?.text || "").trim(),
        status: todo?.completed ? "completed" : "pending",
      })).filter((todo) => todo.text);
      if (!todos.length) return null;
      const summary = `${todos.length} task${todos.length === 1 ? "" : "s"}`;
      return {
        id,
        kind: "tool",
        label: "TodoWrite",
        text: summary,
        todos,
        timestamp: stamp,
        meta: baseMeta,
        status: completed ? "done" : "running",
      };
    }
    if (type === "web_search") {
      // Schema: { id, query, action }
      // Renderer's compact-tool path already recognises "WebSearch" as
      // a known label (main.js:6190 isCompactToolEntry regex), so this
      // gets the same one-line + badge treatment as a Bash/Read row.
      const query = String(item.query || "").trim();
      const actionType = item.action && typeof item.action === "object"
        ? String(item.action.type || "").trim()
        : "";
      return {
        id,
        kind: "tool",
        label: "WebSearch",
        text: query || "(no query)",
        timestamp: stamp,
        meta: actionType || baseMeta,
        status: completed ? "done" : "running",
      };
    }
    if (type === "collab_tool_call") {
      // Schema: { tool: SpawnAgent|SendInput|Wait|CloseAgent,
      //           sender_thread_id, receiver_thread_ids, prompt,
      //           agents_states, status }
      // Codex's subagent system. Render as a Task-like row with the
      // collab tool action as the label and the prompt as the text.
      // Status reflects the SpawnAgent/etc lifecycle.
      const collabTool = String(item.tool || "collab").trim() || "collab";
      // Prettier label per tool: SpawnAgent -> "Spawn agent",
      // SendInput -> "Send input", etc. Renderer-side we treat this
      // generically (no compact-tool dispatch); it gets the standard
      // tool entry styling.
      const labelMap = {
        spawn_agent: "Spawn agent",
        send_input: "Send input",
        wait: "Wait",
        close_agent: "Close agent",
      };
      const label = labelMap[collabTool.toLowerCase()] || collabTool;
      const prompt = String(item.prompt || "").trim();
      const receivers = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : [];
      const text = prompt || (receivers.length ? `→ ${receivers.length} agent${receivers.length === 1 ? "" : "s"}` : label);
      const failed = String(item.status || "").toLowerCase() === "failed";
      return {
        id,
        kind: "tool",
        label,
        text,
        timestamp: stamp,
        meta: baseMeta,
        status: completed ? (failed ? "error" : "done") : "running",
      };
    }
    if (type === "error") {
      // Item-level error (distinct from the top-level `error` event).
      // Schema: { message }. Surface as a status row with error styling
      // so it's visually distinct from successful items.
      const message = String(item.message || "").trim() || "Codex item error";
      return {
        id,
        kind: "status",
        label: "Error",
        text: message,
        timestamp: stamp,
        meta: "codex-item-error",
        status: "error",
      };
    }
    // Unknown item type — render generically. Future Codex versions
    // may add new item types; surfacing them as a small status row
    // (rather than dropping them) gives us a visible signal that
    // something new arrived without crashing the renderer.
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
