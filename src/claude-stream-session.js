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
  }

  start() {
    if (this._child) {
      return this;
    }

    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
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

    const narrative = this.getNarrative();
    this.entries = Array.isArray(narrative?.entries) ? narrative.entries : [];
    this.emit("event", event);
    this.emit("entries", this.entries);

    if (event?.type === "result") {
      this.emit("turn-complete", event);
    }
  }
}

export function createClaudeStreamSession(options = {}) {
  return new ClaudeStreamSession(options).start();
}
