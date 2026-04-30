// Phase 1 of the Claude stream-mode migration (see docs/claude-stream-mode.md).
//
// Encapsulates a single Claude Code session that talks JSONL on stdin/stdout
// instead of being driven through a PTY. Reuses the existing
// `buildClaudeNarrativeFromText` parser so each event line we receive ends up
// as a narrative entry in the same shape the rich-session UI already renders
// for transcript-backed sessions.
//
// This module is server-side only and has no integration with the existing
// session-manager yet — it is the building block the next phase wires in.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildClaudeNarrativeFromText } from "./session-native-narrative.js";

const DEFAULT_CLAUDE_BIN = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "bin", "claude");
})();

const IMAGE_MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

function inferImageMimeType(absolutePath, declaredMime = "") {
  const declared = String(declaredMime || "").trim().toLowerCase();
  if (declared.startsWith("image/")) return declared;
  const ext = path.extname(String(absolutePath || "")).toLowerCase();
  return IMAGE_MIME_BY_EXTENSION[ext] || "image/png";
}

const DEFAULT_MAX_ENTRIES = 96;

export class ClaudeStreamSession extends EventEmitter {
  constructor({
    sessionId = randomUUID(),
    cwd = process.cwd(),
    claudeBin = DEFAULT_CLAUDE_BIN,
    extraArgs = [],
    env = process.env,
    maxEntries = DEFAULT_MAX_ENTRIES,
    allocateSeq = null,
    bypassPermissions = true,
  } = {}) {
    super();
    this.sessionId = sessionId;
    this.providerSessionId = "";
    this.cwd = cwd;
    this.claudeBin = claudeBin;
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs : [];
    this.env = env;
    this.maxEntries = Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
    // Default ON to match the PTY launcher (which always passes
    // --dangerously-skip-permissions). Without this, a stream-mode
    // session is sandboxed to the cwd and can't read sibling project
    // dirs (Library, other projects), which the user reported when
    // asking the agent to look at a figure outside the session cwd.
    // Toggleable per-session for paranoid users who want the prompts.
    this.bypassPermissions = bypassPermissions !== false;
    // Caller-provided monotonic sequence allocator. Each new stream-entry
    // id gets one seq the first time we see it. The owner (SessionManager)
    // shares the counter with native entry pushes so we get a single
    // session-wide insertion order — that's the OpenCode pattern.
    this._allocateSeq = typeof allocateSeq === "function" ? allocateSeq : (() => 0);
    this._entrySeqs = new Map();
    this.status = "starting";
    this.exitCode = null;
    this.exitSignal = null;
    this.startError = null;
    this.transcriptLines = [];
    this.entries = [];
    this.lastEventAt = "";
    this.stderrBuffer = "";
    this._stdoutBuffer = "";
    this._child = null;
    // Claude's stream-json events frequently arrive without a `timestamp`
    // field. The narrative parser then leaves entries with empty timestamps,
    // which sort to position 0 and end up rendered above the user/native
    // entries that DO have timestamps. Cache a stamp the first time we see
    // each entry id so chronology matches arrival order.
    this._entryStamps = new Map();
    // Track partial assistant text per in-flight message id so we can render
    // the reply token-by-token. Cleared once the canonical `assistant` event
    // arrives for the same message.
    this._partialByMessage = new Map();
    this._pendingThinking = false;
    // FIFO queue of ExitPlanMode tool_use_ids awaiting a user response.
    // Real Claude rarely emits two parallel plans, but it CAN — and the
    // earlier scalar tracker overwrote the awaiting id, leaving older
    // plan cards with buttons that no longer addressed any tool_use.
    // Queue semantics fix that: getPendingPlanToolUseId returns the head,
    // sendToolResult dequeues the matching id (not just the head, so an
    // out-of-order resolution still works), and the queue is capped at
    // MAX_PENDING_PLANS so a buggy provider can't fill memory.
    this._pendingPlanToolUseIds = [];
  }

  start() {
    if (this._child) {
      return this;
    }

    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--session-id", this.sessionId,
      ...(this.bypassPermissions ? ["--dangerously-skip-permissions"] : []),
      ...this.extraArgs,
    ];

    try {
      this._child = spawn(this.claudeBin, args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.status = "exited";
      this.startError = error;
      this.emit("error", error);
      this.emit("exit", { code: 1, signal: null, error });
      return this;
    }

    this.status = "running";
    this._child.stdout.setEncoding("utf8");
    this._child.stderr.setEncoding("utf8");

    this._child.stdout.on("data", (chunk) => this._handleStdoutChunk(chunk));
    this._child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 32 * 1024) {
        this.stderrBuffer = this.stderrBuffer.slice(-16 * 1024);
      }
      this.emit("stderr", chunk);
    });
    this._child.on("error", (error) => {
      this.startError = this.startError || error;
      this.emit("error", error);
    });
    this._child.on("close", (code, signal) => {
      this._flushStdoutBuffer();
      this.status = "exited";
      this.exitCode = code;
      this.exitSignal = signal;
      this.emit("exit", { code, signal });
    });

    return this;
  }

  send(text) {
    if (!this._child || this.status !== "running") {
      throw new Error(`ClaudeStreamSession ${this.sessionId} is not running`);
    }
    const value = String(text ?? "");
    if (!value.trim()) {
      return false;
    }

    const message = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: value }],
      },
    };
    this._child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  // Send a user message with one or more image attachments. Each
  // attachment is a path on disk; the file gets read and base64-encoded
  // into a Claude content block of `{type: "image", source: {type:
  // "base64", media_type, data}}`. The wire shape Claude's stream-json
  // input expects matches the one its assistant content uses, just
  // inverted (user role).
  //
  // Failure modes are non-fatal: an unreadable file gets dropped with a
  // console warning and the message goes through with the surviving
  // attachments. If ALL attachments fail, the text-only fallback fires —
  // user still sees their question land, just without the images.
  async sendWithImages(text, attachments = []) {
    if (!this._child || this.status !== "running") {
      throw new Error(`ClaudeStreamSession ${this.sessionId} is not running`);
    }
    const value = String(text ?? "");
    const list = Array.isArray(attachments) ? attachments : [];
    if (!value.trim() && !list.length) {
      return false;
    }

    const imageBlocks = [];
    for (const att of list) {
      const absolutePath = String(att?.absolutePath || att?.path || "").trim();
      if (!absolutePath) continue;
      try {
        const bytes = await readFile(absolutePath);
        const mime = inferImageMimeType(absolutePath, att?.mimeType);
        imageBlocks.push({
          type: "image",
          source: { type: "base64", media_type: mime, data: bytes.toString("base64") },
        });
      } catch (error) {
        console.warn(`[claude-stream-session] could not read attachment ${absolutePath}: ${error.message}`);
      }
    }

    const content = [];
    if (value.trim()) content.push({ type: "text", text: value });
    content.push(...imageBlocks);
    if (!content.length) {
      return false;
    }

    const message = { type: "user", message: { role: "user", content } };
    this._child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  // Emit a structured tool_result content block back to Claude. Used today
  // by the plan-mode approve/reject flow: when the user clicks "Approve
  // plan", the session manager calls sendToolResult(awaitingPlanToolUseId,
  // "User approved the plan…") which is what Claude's CLI expects to mark
  // the ExitPlanMode call complete.
  //
  // The wire shape is the user-message inverse of what the assistant
  // emits: a `user` message whose content array contains one tool_result
  // block referencing the original tool_use_id.
  sendToolResult(toolUseId, content, { isError = false } = {}) {
    if (!this._child || this.status !== "running") {
      throw new Error(`ClaudeStreamSession ${this.sessionId} is not running`);
    }
    const id = String(toolUseId || "").trim();
    if (!id) {
      throw new Error("sendToolResult requires a non-empty toolUseId");
    }
    const message = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: typeof content === "string" ? content : JSON.stringify(content ?? ""),
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
    };
    this._child.stdin.write(`${JSON.stringify(message)}\n`);
    // Dequeue the matching id from anywhere in the FIFO — not just the
    // head — so out-of-order resolutions still clear the right slot.
    const idx = this._pendingPlanToolUseIds.indexOf(id);
    if (idx >= 0) {
      this._pendingPlanToolUseIds.splice(idx, 1);
    }
    return true;
  }

  // Returns the tool_use_id of the OLDEST ExitPlanMode call waiting on a
  // user response, or "" if no plan is awaiting. The session manager
  // dispatches plan-response API calls against this head; if the user
  // clicks Approve on a card whose id matches the head, that's the FIFO
  // path. (Out-of-order resolutions are still fine — sendToolResult
  // dequeues by id, not position.)
  getPendingPlanToolUseId() {
    return this._pendingPlanToolUseIds[0] || "";
  }

  // Returns all currently awaiting plan tool_use_ids. Used by tests and
  // diagnostics to confirm the FIFO depth.
  getPendingPlanToolUseIds() {
    return this._pendingPlanToolUseIds.slice();
  }

  close({ signal = "SIGTERM" } = {}) {
    if (!this._child) {
      return;
    }
    try {
      this._child.stdin.end();
    } catch {
      // stdin may already be closed; ignore.
    }
    try {
      this._child.kill(signal);
    } catch {
      // child may already be exited.
    }
  }

  getNarrative() {
    return buildClaudeNarrativeFromText(this.transcriptLines.join("\n"), {
      providerId: "claude",
      providerLabel: "Claude Code",
    }, { maxEntries: this.maxEntries });
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      providerSessionId: this.providerSessionId,
      status: this.status,
      cwd: this.cwd,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      lastEventAt: this.lastEventAt,
      entries: this.entries.slice(-this.maxEntries),
    };
  }

  _handleStdoutChunk(chunk) {
    this._stdoutBuffer += chunk;
    let nlIdx = this._stdoutBuffer.indexOf("\n");
    while (nlIdx !== -1) {
      const line = this._stdoutBuffer.slice(0, nlIdx);
      this._stdoutBuffer = this._stdoutBuffer.slice(nlIdx + 1);
      this._handleLine(line);
      nlIdx = this._stdoutBuffer.indexOf("\n");
    }
  }

  _flushStdoutBuffer() {
    if (this._stdoutBuffer.trim()) {
      this._handleLine(this._stdoutBuffer);
      this._stdoutBuffer = "";
    }
  }

  _handleLine(rawLine) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) {
      return;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.emit("non-json", line);
      return;
    }

    this.transcriptLines.push(line);
    if (this.transcriptLines.length > this.maxEntries * 8) {
      this.transcriptLines = this.transcriptLines.slice(-this.maxEntries * 8);
    }

    if (event?.session_id && !this.providerSessionId) {
      this.providerSessionId = String(event.session_id);
    }

    const stamp = new Date().toISOString();
    this.lastEventAt = stamp;

    this._updatePartialState(event);

    const narrative = this.getNarrative();
    const rawEntriesAll = Array.isArray(narrative?.entries) ? narrative.entries : [];
    // Drop claude's own "Thinking" entries (extractClaudeThinkingText output).
    // The Thinking indicator is now the empty-text state of the assistant
    // entry itself (OpenCode-inspired) so we don't need a parallel row.
    const rawEntries = rawEntriesAll.filter(
      (entry) => !(entry?.kind === "status" && /^thinking$/iu.test(String(entry?.label || ""))),
    );
    // Stamp each raw entry with our first-observation timestamp AND a
    // session-wide monotonic sequence number. The sequence number is the
    // sort key the merger uses (see mergeNarrativeEntries) — wall-clock
    // timestamps from Claude's stream events bleed across turns and aren't
    // safe for ordering.
    const stampedRaw = rawEntries.map((entry, index) => {
      const cacheKey = entry?.id || `raw-${index}`;
      let cachedStamp = this._entryStamps.get(cacheKey);
      if (!cachedStamp) {
        cachedStamp = stamp;
        this._entryStamps.set(cacheKey, cachedStamp);
      }
      let seq = this._entrySeqs.get(cacheKey);
      if (seq == null) {
        seq = this._allocateSeq();
        this._entrySeqs.set(cacheKey, seq);
      }
      return { ...entry, timestamp: cachedStamp, seq };
    });
    const synthesizedEntries = this._synthesizePartialEntries(stamp);
    this.entries = [...stampedRaw, ...synthesizedEntries];
    this.emit("event", event);
    this.emit("entries", this.entries);

    if (event?.type === "result") {
      this.emit("turn-complete", event);
    }
  }

  _updatePartialState(event) {
    if (!event || typeof event !== "object") {
      return;
    }

    if (event.type === "system" && event.subtype === "status") {
      this._pendingThinking = event.status === "requesting";
      return;
    }

    if (event.type === "stream_event" && event.event && typeof event.event === "object") {
      const innerType = event.event.type;
      if (innerType === "message_start") {
        const messageId = String(event.event.message?.id || "current");
        this._partialByMessage.set(messageId, "");
        this._pendingThinking = false;
        return;
      }
      if (innerType === "content_block_delta") {
        const delta = event.event.delta;
        if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
          // The CLI doesn't repeat message_id on every stream_event, so fall
          // back to the most recently opened partial slot.
          const lastKey = Array.from(this._partialByMessage.keys()).pop() || "current";
          const existing = this._partialByMessage.get(lastKey) || "";
          this._partialByMessage.set(lastKey, existing + delta.text);
          this._pendingThinking = false;
        }
        return;
      }
      return;
    }

    if (event.type === "assistant") {
      const messageId = String(event.message?.id || "");
      if (messageId) {
        this._partialByMessage.delete(messageId);
      } else {
        this._partialByMessage.clear();
      }
      this._pendingThinking = false;
      // Watch the assistant content for ExitPlanMode tool_uses. Real
      // Claude rarely emits more than one per turn, but the queue is
      // append-only: if a second plan arrives before the first is
      // resolved, both ids ride in the FIFO and the older card's button
      // still addresses its real tool_use_id. Cap at MAX_PENDING_PLANS
      // so a buggy producer can't fill memory.
      const MAX_PENDING_PLANS = 32;
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const item of content) {
        if (item?.type === "tool_use" && String(item.name || "") === "ExitPlanMode") {
          const planId = String(item.id || "");
          if (planId && !this._pendingPlanToolUseIds.includes(planId)) {
            this._pendingPlanToolUseIds.push(planId);
            if (this._pendingPlanToolUseIds.length > MAX_PENDING_PLANS) {
              this._pendingPlanToolUseIds.splice(0, this._pendingPlanToolUseIds.length - MAX_PENDING_PLANS);
            }
          }
        }
      }
      return;
    }

    if (event.type === "user") {
      // If the user (or another client) already provided a tool_result
      // for an awaiting plan, dequeue the matching id from the FIFO so
      // a stale Approve click doesn't double-resolve.
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const item of content) {
        if (item?.type === "tool_result") {
          const matchedId = String(item.tool_use_id || "");
          const idx = matchedId ? this._pendingPlanToolUseIds.indexOf(matchedId) : -1;
          if (idx >= 0) {
            this._pendingPlanToolUseIds.splice(idx, 1);
          }
          break;
        }
      }
      return;
    }

    if (event.type === "result") {
      this._partialByMessage.clear();
      this._pendingThinking = false;
      // Invalidate the per-turn placeholder cache so the next turn gets a
      // fresh seq for its own waiting-placeholder. Without this the second
      // turn would re-use the first turn's seq and sort to the wrong spot.
      this._entrySeqs.delete("claude-pending-assistant");
      this._entryStamps.delete("claude-pending-assistant");
    }
  }

  _synthesizePartialEntries(stamp) {
    // OpenCode pattern: the Thinking indicator is the empty-text state of
    // the assistant entry itself. While we're waiting on the first text
    // delta we emit an assistant entry with empty text; the renderer shows
    // it as a spinner. Once deltas arrive, the same id mutates into the
    // streaming text. When the canonical `assistant` event lands the
    // partial slot is cleared and the parser's entry takes over (with the
    // same seq cached against its id, so position is stable).
    const synthesized = [];
    for (const [messageId, partialText] of this._partialByMessage) {
      const cacheKey = `claude-partial-${messageId}`;
      let seq = this._entrySeqs.get(cacheKey);
      if (seq == null) {
        seq = this._allocateSeq();
        this._entrySeqs.set(cacheKey, seq);
      }
      synthesized.push({
        id: cacheKey,
        kind: "assistant",
        label: "Claude Code",
        text: String(partialText || ""),
        timestamp: stamp,
        meta: "streaming",
        seq,
      });
    }
    if (this._pendingThinking && this._partialByMessage.size === 0) {
      const cacheKey = "claude-pending-assistant";
      let seq = this._entrySeqs.get(cacheKey);
      if (seq == null) {
        seq = this._allocateSeq();
        this._entrySeqs.set(cacheKey, seq);
      }
      synthesized.push({
        id: cacheKey,
        kind: "assistant",
        label: "Claude Code",
        text: "",
        timestamp: stamp,
        meta: "pending",
        seq,
      });
    }
    return synthesized;
  }
}

export function createClaudeStreamSession(options = {}) {
  return new ClaudeStreamSession(options).start();
}
