import { readFile, stat } from "node:fs/promises";
import {
  getRichSessionBlockKind,
  getRichSessionToolName,
  splitRichSessionTranscriptBlocks,
} from "./client/rich-session-transcript.js";

const DEFAULT_MAX_ENTRIES = 96;
const MAX_TEXT_LENGTH = 12_000;
const MAX_INLINE_LENGTH = 320;
const MAX_FILE_CACHE_ENTRIES = 48;
const fileCache = new Map();

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
}

function stripAnsiAndControlText(value) {
  // OSC sequences are pure metadata (titles, hyperlinks) — drop entirely.
  // CSI sequences include cursor-movement (e.g. ESC[5C = move 5 right) which
  // visually creates gaps between glyphs in the terminal. If we drop them
  // outright, words rendered with cursor positioning collapse together
  // ("Hello! What would you like to work on?" -> "Hello!Whatwouldyouliketoworkon?"
  // — Codex hits this hard). Substitute a single space so the projection
  // preserves at least the visible gap; downstream collapses runs anyway.
  return String(value ?? "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[()][0-9A-Za-z]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\u009b[0-9;?]*[ -/]*[@-~]/g, " ");
}

function truncateText(value, maxLength = MAX_TEXT_LENGTH) {
  const text = normalizeText(value);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function truncateInline(value, maxLength = MAX_INLINE_LENGTH) {
  const text = normalizeText(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function parseTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function makeEntryId(prefix, index, suffix = "") {
  return suffix ? `${prefix}-${index}-${suffix}` : `${prefix}-${index}`;
}

function dedupePush(entries, nextEntry, maxEntries = DEFAULT_MAX_ENTRIES) {
  if (!nextEntry || !nextEntry.text) {
    return;
  }

  const normalizedText = truncateText(nextEntry.text);
  if (!normalizedText) {
    return;
  }

  const previous = entries[entries.length - 1] || null;
  if (
    previous
    && previous.kind === nextEntry.kind
    && previous.label === nextEntry.label
    && normalizeText(previous.text) === normalizedText
  ) {
    return;
  }

  entries.push({
    ...nextEntry,
    text: normalizedText,
  });

  if (entries.length > maxEntries) {
    entries.splice(0, entries.length - maxEntries);
  }
}

function toNarrative({
  providerBacked = false,
  providerId = "",
  providerLabel = "",
  sourceLabel = "",
  updatedAt = "",
  entries = [],
} = {}) {
  return {
    providerBacked: Boolean(providerBacked),
    providerId: String(providerId || ""),
    providerLabel: String(providerLabel || ""),
    sourceLabel: String(sourceLabel || ""),
    updatedAt: parseTimestamp(updatedAt) || "",
    entries: Array.isArray(entries) ? entries : [],
  };
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getMessageTextFromParts(parts) {
  if (!Array.isArray(parts)) {
    return "";
  }

  const chunks = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue;
    }

    if (typeof part.text === "string" && part.text.trim()) {
      chunks.push(part.text);
      continue;
    }

    if (typeof part.output === "string" && part.output.trim()) {
      chunks.push(part.output);
    }
  }

  return normalizeText(chunks.join("\n\n"));
}

function classifyPromptEntry(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return { kind: "hide", text: "" };
  }

  if (
    /^# AGENTS\.md instructions for\b/imu.test(normalized)
    || /<(?:INSTRUCTIONS|permissions instructions|app-context|collaboration_mode|apps_instructions|skills_instructions|plugins_instructions|environment_context)>/iu.test(normalized)
  ) {
    return { kind: "hide", text: "" };
  }

  if (
    /Please act as a friendly Vibe Research onboarding guide/iu.test(normalized)
    || (/^Context:/imu.test(normalized) && /Agent Town API:/iu.test(normalized) && /Library folder:/iu.test(normalized))
    || (normalized.length > 1_600 && /After the name\/background step|Do not overload me|bite-sized|mini bite-sized/iu.test(normalized))
  ) {
    return {
      kind: "status",
      text: "Session seeded with app instructions.",
    };
  }

  return { kind: "user", text: normalized };
}

function summarizeCommand(command) {
  return truncateInline(command, 220);
}

function summarizeToolArguments(name, argumentsText) {
  const parsed = safeJsonParse(argumentsText);
  if (!parsed || typeof parsed !== "object") {
    return truncateInline(argumentsText || `${name} called`, 220);
  }

  if (typeof parsed.cmd === "string" && parsed.cmd.trim()) {
    return summarizeCommand(parsed.cmd);
  }

  if (typeof parsed.message === "string" && parsed.message.trim()) {
    return truncateInline(parsed.message, 220);
  }

  if (typeof parsed.prompt === "string" && parsed.prompt.trim()) {
    return truncateInline(parsed.prompt, 220);
  }

  if (typeof parsed.path === "string" && parsed.path.trim()) {
    return truncateInline(parsed.path, 220);
  }

  if (typeof parsed.q === "string" && parsed.q.trim()) {
    return truncateInline(parsed.q, 220);
  }

  if (Array.isArray(parsed.tool_uses) && parsed.tool_uses.length) {
    return `${parsed.tool_uses.length} parallel tool call${parsed.tool_uses.length === 1 ? "" : "s"}`;
  }

  return `${name} called`;
}

function summarizeToolOutput(output) {
  const text = normalizeText(output);
  if (!text) {
    return { text: "", status: "done", meta: "" };
  }

  let status = "done";
  const exitMatch = text.match(/Process exited with code\s+(-?\d+)/iu);
  if (exitMatch) {
    status = exitMatch[1] === "0" ? "done" : "error";
  } else if (/error|failed|traceback|exception/iu.test(text)) {
    status = "error";
  }

  const meaningfulLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => (
      line
      && !/^Chunk ID:/iu.test(line)
      && !/^Wall time:/iu.test(line)
      && !/^Process exited with code/iu.test(line)
      && !/^Original token count:/iu.test(line)
      && !/^Output:$/iu.test(line)
      && !/^Total output lines:/iu.test(line)
    )) || "";

  return {
    text: truncateText(meaningfulLine || text, 2_200),
    status,
    meta: exitMatch ? `exit ${exitMatch[1]}` : status === "error" ? "error" : "completed",
  };
}

function markToolResult(entry, output) {
  const summary = summarizeToolOutput(output);
  return {
    ...entry,
    meta: summary.meta || entry.meta,
    status: summary.status || entry.status,
    outputPreview: summary.text,
  };
}

function extractClaudeMessageText(content) {
  if (typeof content === "string") {
    return normalizeText(content);
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const textChunks = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      textChunks.push(part.text);
    }
  }

  return normalizeText(textChunks.join("\n\n"));
}

function extractClaudeThinkingText(content) {
  if (!Array.isArray(content)) {
    return "";
  }

  const thinkingChunks = [];
  let sawThinking = false;
  for (const part of content) {
    if (part?.type !== "thinking") {
      continue;
    }

    sawThinking = true;
    if (typeof part.thinking === "string" && part.thinking.trim()) {
      thinkingChunks.push(part.thinking);
      continue;
    }

    if (typeof part.text === "string" && part.text.trim()) {
      thinkingChunks.push(part.text);
    }
  }

  if (!sawThinking) {
    return "";
  }

  return normalizeText(thinkingChunks.join("\n\n")) || "Claude is thinking...";
}

function extractClaudeToolResultText(toolResult) {
  if (!toolResult || typeof toolResult !== "object") {
    return "";
  }

  const content = toolResult.content ?? toolResult.toolUseResult ?? "";
  if (typeof content === "string") {
    return normalizeText(content);
  }

  if (Array.isArray(content)) {
    return normalizeText(
      content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }

          if (part?.type === "text" && typeof part.text === "string") {
            return part.text;
          }

          if (typeof part?.content === "string") {
            return part.content;
          }

          if (typeof part?.stdout === "string" || typeof part?.stderr === "string") {
            return [part.stdout || "", part.stderr || ""].filter(Boolean).join("\n");
          }

          return "";
        })
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  if (content && typeof content === "object") {
    return normalizeText(
      [
        typeof content.stdout === "string" ? content.stdout : "",
        typeof content.stderr === "string" ? content.stderr : "",
        typeof content.content === "string" ? content.content : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  return "";
}

function summarizeClaudeToolInput(toolUse) {
  if (!toolUse || typeof toolUse !== "object") {
    return "";
  }

  const input = toolUse.input;
  if (input && typeof input === "object") {
    // TodoWrite carries the entire todo list in `input.todos`. Show a one-line
    // breakdown instead of the generic "TodoWrite called" placeholder so the
    // entry is still useful when no special renderer is wired up. The full
    // structured list rides along on the entry as `todos:` for the renderer.
    if (Array.isArray(input.todos) && input.todos.length) {
      return summarizeTodos(input.todos);
    }

    if (typeof input.command === "string" && input.command.trim()) {
      return summarizeCommand(input.command);
    }

    if (typeof input.description === "string" && input.description.trim()) {
      return truncateInline(input.description, 220);
    }

    if (typeof input.path === "string" && input.path.trim()) {
      return truncateInline(input.path, 220);
    }
  }

  return `${toolUse.name || "Tool"} called`;
}

function normalizeTodoStatus(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "completed" || normalized === "done") {
    return "completed";
  }
  if (normalized === "in_progress" || normalized === "active" || normalized === "doing") {
    return "in_progress";
  }
  return "pending";
}

function summarizeTodos(todos) {
  if (!Array.isArray(todos) || !todos.length) {
    return "0 tasks";
  }

  const counts = { completed: 0, in_progress: 0, pending: 0 };
  for (const todo of todos) {
    counts[normalizeTodoStatus(todo?.status)] += 1;
  }

  const parts = [];
  if (counts.completed) parts.push(`${counts.completed} done`);
  if (counts.in_progress) parts.push(`${counts.in_progress} in progress`);
  if (counts.pending) parts.push(`${counts.pending} open`);
  const breakdown = parts.length ? ` (${parts.join(", ")})` : "";
  return `${todos.length} ${todos.length === 1 ? "task" : "tasks"}${breakdown}`;
}

function extractTodoListPayload(toolUse) {
  if (!toolUse || typeof toolUse !== "object") {
    return null;
  }

  const name = String(toolUse.name || "").trim();
  if (name !== "TodoWrite" && name !== "TaskUpdate") {
    return null;
  }

  const todos = toolUse.input?.todos;
  if (!Array.isArray(todos) || !todos.length) {
    return null;
  }

  return todos
    .map((todo) => ({
      content: String(todo?.content || todo?.task || "").trim(),
      activeForm: String(todo?.activeForm || todo?.active_form || "").trim(),
      status: normalizeTodoStatus(todo?.status),
    }))
    .filter((todo) => Boolean(todo.content));
}

function extractGeminiText(content) {
  if (typeof content === "string") {
    return normalizeText(content);
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return normalizeText(
    content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .filter(Boolean)
      .join("\n\n"),
  );
}

function buildCodexNarrativeFromText(text, session = {}, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const entries = [];
  const toolEntries = new Map();
  let updatedAt = "";

  for (const rawLine of String(text || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const payload = safeJsonParse(line);
    if (!payload || typeof payload !== "object") {
      continue;
    }

    updatedAt = parseTimestamp(payload.timestamp) || updatedAt;

    if (payload.type === "event_msg" && payload.payload && typeof payload.payload === "object") {
      const eventPayload = payload.payload;

      if (eventPayload.type === "task_started") {
        dedupePush(entries, {
          id: makeEntryId("codex-thinking", entries.length + 1),
          kind: "status",
          label: "Thinking",
          text: `${session.providerLabel || "Codex"} is thinking...`,
          timestamp: updatedAt,
        }, maxEntries);
        continue;
      }

      if (eventPayload.type === "user_message" && typeof eventPayload.message === "string") {
        const classified = classifyPromptEntry(eventPayload.message);
        if (classified.kind === "hide") {
          continue;
        }

        dedupePush(entries, {
          id: makeEntryId("codex-user", entries.length + 1),
          kind: classified.kind,
          label: classified.kind === "status" ? "Kickoff" : "You",
          text: classified.text,
          timestamp: updatedAt,
        }, maxEntries);
        continue;
      }

      if (eventPayload.type === "agent_message" && typeof eventPayload.message === "string") {
        dedupePush(entries, {
          id: makeEntryId("codex-agent-message", entries.length + 1),
          kind: eventPayload.phase === "commentary" ? "status" : "assistant",
          label: eventPayload.phase === "commentary" ? "Activity" : session.providerLabel || "Assistant",
          text: eventPayload.message,
          timestamp: updatedAt,
        }, maxEntries);
        continue;
      }
    }

    if (payload.type !== "response_item" || !payload.payload || typeof payload.payload !== "object") {
      continue;
    }

    const item = payload.payload;
    if (item.type === "reasoning") {
      dedupePush(entries, {
        id: makeEntryId("codex-thinking", entries.length + 1),
        kind: "status",
        label: "Thinking",
        text: `${session.providerLabel || "Codex"} is thinking...`,
        timestamp: updatedAt,
      }, maxEntries);
      continue;
    }

    if (item.type === "message") {
      if (item.role === "developer") {
        continue;
      }

      const textValue = getMessageTextFromParts(item.content);
      if (!textValue) {
        continue;
      }

      if (item.role === "user") {
        const classified = classifyPromptEntry(textValue);
        if (classified.kind === "hide") {
          continue;
        }

        dedupePush(entries, {
          id: makeEntryId("codex-user", entries.length + 1),
          kind: classified.kind,
          label: classified.kind === "status" ? "Kickoff" : "You",
          text: classified.text,
          timestamp: updatedAt,
        }, maxEntries);
        continue;
      }

      if (item.role === "assistant") {
        dedupePush(entries, {
          id: makeEntryId("codex-assistant", entries.length + 1),
          kind: item.phase === "commentary" ? "status" : "assistant",
          label: item.phase === "commentary" ? "Activity" : session.providerLabel || "Assistant",
          text: textValue,
          timestamp: updatedAt,
        }, maxEntries);
      }

      continue;
    }

    if (item.type === "function_call") {
      const toolEntry = {
        id: makeEntryId("codex-tool", entries.length + 1),
        kind: "tool",
        label: item.name || "Tool",
        text: summarizeToolArguments(item.name || "Tool", item.arguments || ""),
        timestamp: updatedAt,
        status: "running",
        meta: "running",
        outputPreview: "",
      };
      toolEntries.set(String(item.call_id || toolEntry.id), toolEntry);
      dedupePush(entries, toolEntry, maxEntries);
      continue;
    }

    if (item.type === "function_call_output") {
      const toolEntry = toolEntries.get(String(item.call_id || ""));
      if (!toolEntry) {
        dedupePush(entries, {
          id: makeEntryId("codex-tool-result", entries.length + 1),
          kind: "tool",
          label: "Tool",
          text: truncateText(item.output || ""),
          timestamp: updatedAt,
          status: "done",
          meta: "completed",
        }, maxEntries);
        continue;
      }

      const index = entries.findIndex((entry) => entry.id === toolEntry.id);
      if (index >= 0) {
        entries[index] = markToolResult(entries[index], item.output || "");
      }
    }
  }

  return toNarrative({
    providerBacked: true,
    providerId: session.providerId,
    providerLabel: session.providerLabel,
    sourceLabel: "Codex session file",
    updatedAt,
    entries,
  });
}

function buildClaudeNarrativeFromText(text, session = {}, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const entries = [];
  const toolEntries = new Map();
  let updatedAt = "";

  for (const rawLine of String(text || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const payload = safeJsonParse(line);
    if (!payload || typeof payload !== "object") {
      continue;
    }

    updatedAt = parseTimestamp(payload.timestamp) || updatedAt;

    if (payload.type === "permission-mode") {
      dedupePush(entries, {
        id: makeEntryId("claude-permissions", entries.length + 1),
        kind: "status",
        label: "Permissions",
        text: `Claude is running with ${payload.permissionMode || "default"} permissions.`,
        timestamp: updatedAt,
      }, maxEntries);
      continue;
    }

    if (payload.type === "assistant") {
      if (payload.error && typeof payload.error === "string") {
        dedupePush(entries, {
          id: makeEntryId("claude-error", entries.length + 1),
          kind: "status",
          label: "Error",
          text: payload.error,
          timestamp: updatedAt,
        }, maxEntries);
      }

      const content = Array.isArray(payload.message?.content) ? payload.message.content : [];
      const thinkingText = extractClaudeThinkingText(content);
      const hasToolUse = content.some((item) => item?.type === "tool_use");
      const assistantText = extractClaudeMessageText(content);
      const placeholderThinking = thinkingText === "Claude is thinking...";

      // The empty thinking placeholder is just a spinner. When the same turn
      // already has a tool_use or visible assistant text, the Thinking entry
      // is redundant — the user can see the work. Only surface it when it is
      // actual reasoning content OR the only thing the turn produced so far.
      if (thinkingText && (!placeholderThinking || (!hasToolUse && !assistantText))) {
        dedupePush(entries, {
          id: makeEntryId("claude-thinking", entries.length + 1),
          kind: "status",
          label: "Thinking",
          text: thinkingText,
          timestamp: updatedAt,
        }, maxEntries);
      }

      if (assistantText) {
        dedupePush(entries, {
          id: makeEntryId("claude-assistant", entries.length + 1),
          kind: "assistant",
          label: session.providerLabel || "Assistant",
          text: assistantText,
          timestamp: updatedAt,
        }, maxEntries);
      }

      for (const item of content) {
        if (item?.type !== "tool_use") {
          continue;
        }

        const toolEntry = {
          id: makeEntryId("claude-tool", entries.length + 1, item.id || ""),
          kind: "tool",
          label: item.name || "Tool",
          text: summarizeClaudeToolInput(item),
          timestamp: updatedAt,
          status: "running",
          meta: "running",
          outputPreview: "",
        };

        // Carry the structured todo list along on TodoWrite entries so the
        // renderer can show a real checklist instead of the one-line summary.
        const todoPayload = extractTodoListPayload(item);
        if (todoPayload) {
          toolEntry.todos = todoPayload;
          toolEntry.status = "done";
          toolEntry.meta = "completed";
        }

        toolEntries.set(String(item.id || toolEntry.id), toolEntry);
        dedupePush(entries, toolEntry, maxEntries);
      }

      continue;
    }

    if (payload.type === "user") {
      const content = payload.message?.content;

      if (typeof content === "string") {
        const classified = classifyPromptEntry(content);
        if (classified.kind === "hide") {
          continue;
        }

        dedupePush(entries, {
          id: makeEntryId("claude-user", entries.length + 1),
          kind: classified.kind,
          label: classified.kind === "status" ? "Kickoff" : "You",
          text: classified.text,
          timestamp: updatedAt,
        }, maxEntries);
        continue;
      }

      if (!Array.isArray(content)) {
        continue;
      }

      for (const item of content) {
        if (item?.type !== "tool_result") {
          continue;
        }

        const toolEntry = toolEntries.get(String(item.tool_use_id || ""));
        if (!toolEntry) {
          continue;
        }

        const outputText = extractClaudeToolResultText(item);
        const index = entries.findIndex((entry) => entry.id === toolEntry.id);
        if (index >= 0) {
          const nextEntry = markToolResult(entries[index], outputText);
          entries[index] = {
            ...nextEntry,
            status: item.is_error ? "error" : nextEntry.status,
            meta: item.is_error ? "error" : nextEntry.meta,
          };
        }
      }
    }
  }

  return toNarrative({
    providerBacked: true,
    providerId: session.providerId,
    providerLabel: session.providerLabel,
    sourceLabel: "Claude project transcript",
    updatedAt,
    entries,
  });
}

function buildGeminiNarrativeFromText(text, session = {}, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const entries = [];
  let updatedAt = "";

  for (const rawLine of String(text || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const payload = safeJsonParse(line);
    if (!payload || typeof payload !== "object") {
      continue;
    }

    updatedAt = parseTimestamp(payload.timestamp || payload.lastUpdated || payload.startTime) || updatedAt;

    if (payload.type === "user") {
      const textValue = extractGeminiText(payload.content);
      if (!textValue) {
        continue;
      }

      const classified = classifyPromptEntry(textValue);
      if (classified.kind === "hide") {
        continue;
      }

      dedupePush(entries, {
        id: makeEntryId("gemini-user", entries.length + 1),
        kind: classified.kind,
        label: classified.kind === "status" ? "Kickoff" : "You",
        text: classified.text,
        timestamp: updatedAt,
      }, maxEntries);
      continue;
    }

    if (payload.type === "assistant" || payload.type === "model" || payload.type === "response") {
      const textValue = extractGeminiText(payload.content);
      if (!textValue) {
        continue;
      }

      dedupePush(entries, {
        id: makeEntryId("gemini-assistant", entries.length + 1),
        kind: "assistant",
        label: session.providerLabel || "Assistant",
        text: textValue,
        timestamp: updatedAt,
      }, maxEntries);
      continue;
    }

    if (payload.type === "info") {
      const textValue = extractGeminiText(payload.content);
      if (!textValue) {
        continue;
      }

      dedupePush(entries, {
        id: makeEntryId("gemini-info", entries.length + 1),
        kind: "status",
        label: "Activity",
        text: textValue,
        timestamp: updatedAt,
      }, maxEntries);
    }
  }

  return toNarrative({
    providerBacked: true,
    providerId: session.providerId,
    providerLabel: session.providerLabel,
    sourceLabel: "Gemini chat log",
    updatedAt,
    entries,
  });
}

async function readFileCached(filePath) {
  const stats = await stat(filePath);
  const existing = fileCache.get(filePath);
  if (existing && existing.mtimeMs === stats.mtimeMs && existing.size === stats.size) {
    return existing;
  }

  const text = await readFile(filePath, "utf8");
  const record = {
    filePath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    text,
  };
  fileCache.set(filePath, record);

  while (fileCache.size > MAX_FILE_CACHE_ENTRIES) {
    const oldestKey = fileCache.keys().next().value;
    fileCache.delete(oldestKey);
  }

  return record;
}

export async function loadProviderBackedNarrative({
  providerId,
  filePath,
  session,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  if (!filePath || !providerId) {
    return null;
  }

  const record = await readFileCached(filePath);
  const baseSession = session && typeof session === "object" ? session : {};

  if (providerId === "codex") {
    return buildCodexNarrativeFromText(record.text, baseSession, { maxEntries });
  }

  if (providerId === "claude" || providerId === "claude-ollama") {
    return buildClaudeNarrativeFromText(record.text, baseSession, { maxEntries });
  }

  if (providerId === "gemini") {
    return buildGeminiNarrativeFromText(record.text, baseSession, { maxEntries });
  }

  return null;
}

export function buildProjectedNarrative({
  providerId = "",
  providerLabel = "",
  transcript = "",
  maxEntries = DEFAULT_MAX_ENTRIES,
  recentInputs = [],
} = {}) {
  const blocks = splitRichSessionTranscriptBlocks(stripAnsiAndControlText(String(transcript || "")), {
    maxBlocks: maxEntries,
    recentInputs,
  });
  const entries = blocks.map((block, index) => {
    const blockKind = getRichSessionBlockKind(block);
    if (blockKind === "tool") {
      return {
        id: makeEntryId("projected-tool", index + 1),
        kind: "tool",
        label: getRichSessionToolName(block) || "Tool",
        text: block,
        status: "done",
        meta: "transcript",
      };
    }

    if (blockKind === "code") {
      return {
        id: makeEntryId("projected-code", index + 1),
        kind: "tool",
        label: "Snippet",
        text: block,
        status: "done",
        meta: "transcript",
      };
    }

    if (blockKind === "status" || blockKind === "recap") {
      return {
        id: makeEntryId("projected-status", index + 1),
        kind: "status",
        label: blockKind === "recap" ? "Recap" : "Activity",
        text: block,
      };
    }

    return {
      id: makeEntryId("projected-message", index + 1),
      kind: "assistant",
      label: providerLabel || "Assistant",
      text: block,
    };
  });

  return toNarrative({
    providerBacked: false,
    providerId,
    providerLabel,
    sourceLabel: "CLI transcript projection",
    entries,
  });
}

export {
  buildClaudeNarrativeFromText,
  buildCodexNarrativeFromText,
  buildGeminiNarrativeFromText,
  classifyPromptEntry,
  summarizeToolArguments,
  summarizeToolOutput,
};
