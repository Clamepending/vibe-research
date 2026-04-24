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
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildClaudeNarrativeFromText } from "./session-native-narrative.js";

const DEFAULT_CLAUDE_BIN = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "bin", "claude");
})();

const DEFAULT_MAX_ENTRIES = 96;

export class ClaudeStreamSession extends EventEmitter {
  constructor({
    sessionId = randomUUID(),
    cwd = process.cwd(),
    claudeBin = DEFAULT_CLAUDE_BIN,
    extraArgs = [],
    env = process.env,
    maxEntries = DEFAULT_MAX_ENTRIES,
  } = {}) {
    super();
    this.sessionId = sessionId;
    this.providerSessionId = "";
    this.cwd = cwd;
    this.claudeBin = claudeBin;
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs : [];
    this.env = env;
    this.maxEntries = Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
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
    const rawEntries = Array.isArray(narrative?.entries) ? narrative.entries : [];
    const synthesizedEntries = this._synthesizePartialEntries(stamp);
    const combined = [...rawEntries, ...synthesizedEntries];
    this.entries = combined.map((entry, index) => {
      if (entry?.timestamp) {
        return entry;
      }
      const cacheKey = entry?.id || `entry-${index}`;
      let cachedStamp = this._entryStamps.get(cacheKey);
      if (!cachedStamp) {
        cachedStamp = stamp;
        this._entryStamps.set(cacheKey, cachedStamp);
      }
      return { ...entry, timestamp: cachedStamp };
    });
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
      return;
    }

    if (event.type === "result") {
      this._partialByMessage.clear();
      this._pendingThinking = false;
    }
  }

  _synthesizePartialEntries(stamp) {
    const synthesized = [];
    let anyPartialText = false;
    for (const [messageId, partialText] of this._partialByMessage) {
      const text = String(partialText || "").trim();
      if (!text) {
        continue;
      }
      anyPartialText = true;
      synthesized.push({
        id: `claude-partial-${messageId}`,
        kind: "assistant",
        label: "Claude Code",
        text: partialText,
        timestamp: stamp,
        meta: "streaming",
      });
    }
    // Only surface "Thinking" while we are genuinely waiting on first tokens.
    // Hide the moment any partial text has arrived so the indicator never sits
    // alongside the reply. The pending flag itself is also cleared on
    // message_start / assistant / result events in _updatePartialState.
    if (this._pendingThinking && !anyPartialText) {
      synthesized.push({
        id: "claude-thinking-pending",
        kind: "status",
        label: "Thinking",
        text: "Claude is thinking...",
        timestamp: stamp,
        meta: "streaming",
      });
    }
    return synthesized;
  }
}

export function createClaudeStreamSession(options = {}) {
  return new ClaudeStreamSession(options).start();
}
