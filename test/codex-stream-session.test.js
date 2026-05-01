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
