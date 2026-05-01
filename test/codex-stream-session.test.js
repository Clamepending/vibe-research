// Codex stream session: tool dispatch + reasoning shape contracts.
//
// These tests pin the wire-shape decisions the chat renderer relies on:
//   - command_execution gets per-tool labels (Read / Grep / Glob / Bash)
//     so renderRichSessionEntry's compact-tool path picks the right
//     badge instead of bucketing every shell call as "Bash".
//   - reasoning items emit the Claude-style thinking shape (kind:status,
//     label:Thinking, thinking:true) so the renderer's collapsible
//     reasoning pane kicks in.
//   - Empty reasoning items return null so we don't emit placeholder
//     Thinking rows (matches #129's defensive filter).
//   - Output preview keeps a head/tail elision pattern but holds more
//     bytes than the previous 1.6KB cap.

import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexStreamSession,
  classifyShellCommandLabel,
  extractCodexReasoningText,
} from "../src/codex-stream-session.js";

// ---- classifyShellCommandLabel ----

test("classifyShellCommandLabel: rg / grep variants → Grep", () => {
  assert.equal(classifyShellCommandLabel("rg -n 'foo' src/"), "Grep");
  assert.equal(classifyShellCommandLabel("grep -r needle ."), "Grep");
  assert.equal(classifyShellCommandLabel("egrep '(a|b)' file.txt"), "Grep");
  assert.equal(classifyShellCommandLabel("/usr/bin/grep -i needle"), "Grep");
});

test("classifyShellCommandLabel: cat / head / tail with file arg → Read", () => {
  assert.equal(classifyShellCommandLabel("cat /etc/hosts"), "Read");
  assert.equal(classifyShellCommandLabel("head -50 README.md"), "Read");
  assert.equal(classifyShellCommandLabel("tail -f /var/log/foo.log"), "Read");
  assert.equal(classifyShellCommandLabel("bat src/main.js"), "Read");
});

test("classifyShellCommandLabel: bare cat (no path arg) stays Bash", () => {
  // `cat` alone is just bash piping; only classify as Read when there's
  // a path/file arg the model is actually trying to inspect.
  assert.equal(classifyShellCommandLabel("cat"), "Bash");
});

test("classifyShellCommandLabel: find / fd / ls / tree → Glob", () => {
  assert.equal(classifyShellCommandLabel("find . -name '*.js'"), "Glob");
  assert.equal(classifyShellCommandLabel("fd -e ts"), "Glob");
  assert.equal(classifyShellCommandLabel("ls -la src/"), "Glob");
});

test("classifyShellCommandLabel: anything else → Bash", () => {
  assert.equal(classifyShellCommandLabel("npm test"), "Bash");
  assert.equal(classifyShellCommandLabel("git status"), "Bash");
  assert.equal(classifyShellCommandLabel("python script.py"), "Bash");
  assert.equal(classifyShellCommandLabel(""), "Bash");
});

test("classifyShellCommandLabel: sudo / time / nohup wrappers are stripped", () => {
  // Without wrapper-stripping, `sudo cat /etc/shadow` would classify
  // as Bash instead of Read — losing the badge for the actual op.
  assert.equal(classifyShellCommandLabel("sudo cat /etc/hosts"), "Read");
  assert.equal(classifyShellCommandLabel("time grep foo bar.txt"), "Grep");
  assert.equal(classifyShellCommandLabel("nohup find . -name '*.log'"), "Glob");
  assert.equal(classifyShellCommandLabel("env FOO=1 BAR=2 rg pattern"), "Grep");
});

// ---- extractCodexReasoningText ----

test("extractCodexReasoningText: pulls summary array of strings", () => {
  const item = { type: "reasoning", summary: ["First thought.", "Second thought."] };
  assert.equal(extractCodexReasoningText(item), "First thought.\n\nSecond thought.");
});

test("extractCodexReasoningText: pulls summary array of {text} objects", () => {
  const item = { type: "reasoning", summary: [{ text: "Reasoned A" }, { text: "Reasoned B" }] };
  assert.equal(extractCodexReasoningText(item), "Reasoned A\n\nReasoned B");
});

test("extractCodexReasoningText: falls back to item.text when summary is empty", () => {
  const item = { type: "reasoning", summary: [], text: "Direct reasoning text." };
  assert.equal(extractCodexReasoningText(item), "Direct reasoning text.");
});

test("extractCodexReasoningText: returns empty string when nothing readable", () => {
  // The caller treats "" as "skip this row" so we don't emit empty
  // Thinking placeholders (matches #129's behavior).
  assert.equal(extractCodexReasoningText({ type: "reasoning" }), "");
  assert.equal(extractCodexReasoningText({ type: "reasoning", summary: [{}, {}] }), "");
  assert.equal(extractCodexReasoningText(null), "");
  assert.equal(extractCodexReasoningText({}), "");
});

// ---- end-to-end: _buildEntryForItem dispatch ----

function makeSession() {
  return new CodexStreamSession({
    sessionId: "test-session",
    cwd: "/tmp",
    codexBin: "/usr/bin/echo", // never actually spawned; we call private helpers directly
    env: {},
  });
}

test("_buildEntryForItem: command_execution dispatches to Read for `cat path`", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("id-1", {
    type: "command_execution",
    command: "cat src/foo.js",
    aggregated_output: "console.log('hi');",
    exit_code: 0,
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entry.kind, "tool");
  assert.equal(entry.label, "Read");
  assert.equal(entry.text, "cat src/foo.js");
  assert.equal(entry.outputPreview, "console.log('hi');");
  assert.equal(entry.status, "done");
});

test("_buildEntryForItem: command_execution dispatches to Grep for `rg`", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("id-2", {
    type: "command_execution",
    command: "rg -n 'TODO' src/",
    aggregated_output: "src/foo.js:12: // TODO\n",
    exit_code: 0,
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entry.label, "Grep");
});

test("_buildEntryForItem: command_execution truncates with head/tail elision over the cap", () => {
  // Bumped cap is 4000 head + 1000 tail; build something >5KB to trigger.
  const big = "x".repeat(6000);
  const session = makeSession();
  const entry = session._buildEntryForItem("id-3", {
    type: "command_execution",
    command: "cat huge.txt",
    aggregated_output: big,
    exit_code: 0,
  }, "2026-04-30T12:00:00Z", true);
  assert.ok(entry.outputPreview.includes("more chars elided"), "should show elision marker");
  assert.ok(entry.outputPreview.length < big.length, "preview should be smaller than raw");
  // Sanity-check the cap is the new larger one (>2KB), not the old ~1.6KB.
  assert.ok(entry.outputPreview.length > 2000, "preview should hold at least 2KB after the bump");
});

test("_buildEntryForItem: command_execution under the cap passes through verbatim", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("id-4", {
    type: "command_execution",
    command: "ls",
    aggregated_output: "a\nb\nc\n",
    exit_code: 0,
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entry.outputPreview, "a\nb\nc");
  assert.ok(!entry.outputPreview.includes("elided"));
});

test("_buildEntryForItem: reasoning emits Claude-style thinking shape", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("id-5", {
    type: "reasoning",
    summary: ["I should check the README first."],
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entry.kind, "status");
  assert.equal(entry.label, "Thinking");
  assert.equal(entry.thinking, true);
  assert.equal(entry.text, "I should check the README first.");
});

test("_buildEntryForItem: empty reasoning returns null (no placeholder row)", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("id-6", {
    type: "reasoning",
    summary: [],
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entry, null);
});

test("_buildEntryForItem: failing command sets status:error", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("id-7", {
    type: "command_execution",
    command: "false",
    aggregated_output: "",
    exit_code: 1,
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entry.status, "error");
});

// ---- file_change: schema {changes: [{path, kind: add|delete|update}], status} ----

test("_buildEntryForItem: file_change emits one entry per changed file with Add/Edit/Delete labels", () => {
  const session = makeSession();
  const entries = session._buildEntryForItem("fc-1", {
    type: "file_change",
    status: "completed",
    changes: [
      { path: "src/new.js", kind: "add" },
      { path: "src/existing.js", kind: "update" },
      { path: "src/old.js", kind: "delete" },
    ],
  }, "2026-04-30T12:00:00Z", true);
  assert.ok(Array.isArray(entries), "file_change should expand to an array");
  assert.equal(entries.length, 3);
  assert.equal(entries[0].label, "Write");
  assert.equal(entries[0].text, "src/new.js");
  assert.equal(entries[1].label, "Edit");
  assert.equal(entries[1].text, "src/existing.js");
  assert.equal(entries[2].label, "Delete");
  assert.equal(entries[2].text, "src/old.js");
  // Ids must be unique per file so _upsertItemEntry doesn't clobber siblings.
  const ids = new Set(entries.map((e) => e.id));
  assert.equal(ids.size, 3);
});

test("_buildEntryForItem: file_change with failed status maps to error", () => {
  const session = makeSession();
  const entries = session._buildEntryForItem("fc-2", {
    type: "file_change",
    status: "failed",
    changes: [{ path: "src/x.js", kind: "update" }],
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entries[0].status, "error");
});

test("_buildEntryForItem: file_change with no changes still emits a placeholder entry (not null)", () => {
  // A file_change item with empty changes is still a signal that the
  // agent attempted to patch — drop it silently and the chat loses
  // attribution. Render a single fallback entry so the user knows
  // something happened.
  const session = makeSession();
  const entry = session._buildEntryForItem("fc-3", {
    type: "file_change",
    status: "completed",
    changes: [],
  }, "2026-04-30T12:00:00Z", true);
  assert.ok(entry, "should not return null for empty changes");
  assert.equal(entry.label, "Edit");
  assert.match(entry.text, /no paths reported/);
});

// ---- mcp_tool_call: schema {server, tool, arguments, result, error, status} ----

test("_buildEntryForItem: mcp_tool_call sets entry.mcp = {server, tool} for the renderer's MCP badge", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("mcp-1", {
    type: "mcp_tool_call",
    server: "filesystem",
    tool: "read_file",
    arguments: { path: "/tmp/foo" },
    status: "completed",
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entry.label, "read_file");
  assert.deepEqual(entry.mcp, { server: "filesystem", tool: "read_file" });
});

test("_buildEntryForItem: mcp_tool_call surfaces text content blocks as outputPreview", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("mcp-2", {
    type: "mcp_tool_call",
    server: "fs",
    tool: "read_file",
    result: {
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
        { type: "image", data: "..." }, // ignored — no rendering for images yet
      ],
    },
    status: "completed",
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entry.outputPreview, "line one\n\nline two");
});

test("_buildEntryForItem: mcp_tool_call falls back to structured_content as JSON when no text blocks", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("mcp-3", {
    type: "mcp_tool_call",
    server: "fs",
    tool: "stat",
    result: { content: [], structured_content: { size: 42, kind: "file" } },
    status: "completed",
  }, "2026-04-30T12:00:00Z", true);
  assert.ok(entry.outputPreview.includes('"size"'));
  assert.ok(entry.outputPreview.includes("42"));
});

test("_buildEntryForItem: mcp_tool_call with error.message renders failure inline + status:error", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("mcp-4", {
    type: "mcp_tool_call",
    server: "fs",
    tool: "read_file",
    error: { message: "permission denied" },
    status: "failed",
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entry.status, "error");
  assert.match(entry.outputPreview, /permission denied/);
});

// ---- todo_list: schema {items: [{text, completed}]} ----

test("_buildEntryForItem: todo_list emits TodoWrite-shaped entry with status mapped from completed bool", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("todo-1", {
    type: "todo_list",
    items: [
      { text: "step one", completed: true },
      { text: "step two", completed: false },
      { text: "step three", completed: false },
    ],
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entry.label, "TodoWrite");
  assert.equal(entry.todos.length, 3);
  assert.equal(entry.todos[0].status, "completed");
  assert.equal(entry.todos[1].status, "pending");
  assert.equal(entry.text, "3 tasks");
});

test("_buildEntryForItem: todo_list with no items returns null (no empty checklist row)", () => {
  const session = makeSession();
  assert.equal(session._buildEntryForItem("todo-2", { type: "todo_list", items: [] }, "t", true), null);
});

// ---- web_search: schema {id, query, action} ----

test("_buildEntryForItem: web_search emits a WebSearch compact entry with the query", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("ws-1", {
    type: "web_search",
    id: "search-123",
    query: "claude code subagents",
    action: { type: "search" },
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entry.label, "WebSearch");
  assert.equal(entry.text, "claude code subagents");
});

// ---- collab_tool_call: schema {tool, sender_thread_id, receiver_thread_ids, prompt, ...} ----

test("_buildEntryForItem: collab_tool_call SpawnAgent renders prompt + 'Spawn agent' label", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("collab-1", {
    type: "collab_tool_call",
    tool: "spawn_agent",
    sender_thread_id: "parent",
    receiver_thread_ids: ["child-1"],
    prompt: "Investigate the failing test",
    status: "in_progress",
  }, "2026-04-30T12:00:00Z", false);
  assert.equal(entry.label, "Spawn agent");
  assert.equal(entry.text, "Investigate the failing test");
  assert.equal(entry.status, "running");
});

test("_buildEntryForItem: collab_tool_call without prompt falls back to receiver count", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("collab-2", {
    type: "collab_tool_call",
    tool: "wait",
    sender_thread_id: "parent",
    receiver_thread_ids: ["a", "b"],
    status: "completed",
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entry.label, "Wait");
  assert.match(entry.text, /2 agents/);
});

// ---- error item ----

test("_buildEntryForItem: error item emits a status row with status:error", () => {
  const session = makeSession();
  const entry = session._buildEntryForItem("err-1", {
    type: "error",
    message: "Something went wrong",
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(entry.kind, "status");
  assert.equal(entry.label, "Error");
  assert.equal(entry.status, "error");
  assert.equal(entry.text, "Something went wrong");
});

// ---- _upsertItemEntry handles the multi-entry array return from file_change ----

test("_upsertItemEntry: file_change appends one _allEntries row per file", () => {
  const session = makeSession();
  session._upsertItemEntry(1, {
    id: "fc-multi",
    type: "file_change",
    status: "completed",
    changes: [
      { path: "a.js", kind: "add" },
      { path: "b.js", kind: "update" },
    ],
  }, "2026-04-30T12:00:00Z", true);
  assert.equal(session._allEntries.length, 2);
  assert.equal(session._allEntries[0].text, "a.js");
  assert.equal(session._allEntries[1].text, "b.js");
});

test("_upsertItemEntry: re-emitting the same file_change updates in place (no duplicates)", () => {
  // Codex's schema says file_change is only emitted at completion, but
  // the renderer shouldn't blow up if the same id is re-sent — the
  // upsert path keys off the per-file id suffix (`${itemId}::${fileIdx}`)
  // so a repeat emission updates the existing rows.
  const session = makeSession();
  const item = {
    id: "fc-dup",
    type: "file_change",
    status: "completed",
    changes: [{ path: "x.js", kind: "update" }],
  };
  session._upsertItemEntry(1, item, "t1", true);
  session._upsertItemEntry(1, item, "t2", true);
  assert.equal(session._allEntries.length, 1);
});

// ---- turn.completed.usage: appended as a quiet status row ----

test("_handleLine: turn.completed with usage appends a Usage status row with token counts", () => {
  const session = makeSession();
  session._turnIndex = 1;
  session._handleLine(1, JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 1234, cached_input_tokens: 100, output_tokens: 567, reasoning_output_tokens: 89 },
  }));
  const usageEntry = session._allEntries.find((e) => e.id?.startsWith("codex-usage-"));
  assert.ok(usageEntry, "should append a usage entry");
  assert.equal(usageEntry.label, "Usage");
  assert.equal(usageEntry.kind, "status");
  // Total = 1234 + 567 + 89 = 1890
  assert.match(usageEntry.text, /1,890 tokens/);
  assert.match(usageEntry.text, /in 1,234/);
  assert.match(usageEntry.text, /cached 100/);
  assert.match(usageEntry.text, /out 567/);
  assert.match(usageEntry.text, /reasoning 89/);
});

test("_handleLine: turn.completed with zero usage skips the Usage row", () => {
  const session = makeSession();
  session._turnIndex = 1;
  session._handleLine(1, JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
  }));
  const usageEntry = session._allEntries.find((e) => e.id?.startsWith("codex-usage-"));
  assert.equal(usageEntry, undefined);
});
