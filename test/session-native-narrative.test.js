import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  buildClaudeNarrativeFromText,
  buildCodexNarrativeFromText,
  extractImageRefsFromText,
  extractPlanFromToolUse,
  extractSlashActionFromText,
  parseMcpToolName,
} from "../src/session-native-narrative.js";
import { SessionManager } from "../src/session-manager.js";

const fakeProviders = [
  { id: "claude", label: "Claude Code", available: true, command: "claude", launchCommand: "claude", defaultName: "Claude" },
  { id: "codex", label: "Codex", available: true, command: "codex", launchCommand: "codex", defaultName: "Codex" },
  { id: "gemini", label: "Gemini CLI", available: true, command: "gemini", launchCommand: "gemini", defaultName: "Gemini" },
  { id: "shell", label: "Vanilla Shell", available: true, command: null, launchCommand: null, defaultName: "Shell" },
];

async function createManager() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-native-ui-workspace-"));
  const userHomeDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-native-ui-home-"));
  const manager = new SessionManager({
    cwd: workspaceDir,
    providers: fakeProviders,
    persistentTerminals: false,
    persistSessions: false,
    stateDir: path.join(workspaceDir, ".vibe-research"),
    userHomeDir,
  });
  await manager.initialize();
  return { manager, workspaceDir, userHomeDir };
}

async function cleanupManager({ manager, workspaceDir, userHomeDir }) {
  await manager.shutdown({ preserveSessions: false });
  await rm(workspaceDir, { recursive: true, force: true });
  await rm(userHomeDir, { recursive: true, force: true });
}

async function writeCodexTranscript(homeDir, { sessionId, cwd, timestamp, extraLines = [], sessionMeta = {} }) {
  const date = new Date(timestamp);
  const dayDir = path.join(
    homeDir,
    ".codex",
    "sessions",
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  );
  await mkdir(dayDir, { recursive: true });
  const fileName = `rollout-${timestamp.replaceAll(":", "-")}-${sessionId}.jsonl`;
  const lines = [
    {
      timestamp,
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp,
        cwd,
        ...sessionMeta,
      },
    },
    ...extraLines,
  ];
  await writeFile(path.join(dayDir, fileName), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

test("Codex native narrative hides harness prompts and surfaces tools plus assistant output", () => {
  const timestamp = "2026-04-24T03:00:43.859Z";
  const text = [
    JSON.stringify({ timestamp, type: "session_meta", payload: { id: "codex-thread", cwd: "/tmp/demo" } }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions for /tmp/demo\n<INSTRUCTIONS>\nsecret\n</INSTRUCTIONS>" }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello there" }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_1",
        arguments: JSON.stringify({ cmd: "npm test -- --runInBand" }),
      },
    }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_1",
        output: "Chunk ID: abc\nProcess exited with code 0\nOutput:\nTests passed.",
      },
    }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I tightened the session renderer." }],
      },
    }),
  ].join("\n");

  const narrative = buildCodexNarrativeFromText(text, { providerId: "codex", providerLabel: "Codex" });

  assert.equal(narrative.providerBacked, true);
  assert.equal(narrative.entries.length, 3);
  assert.deepEqual(
    narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label, text: entry.text })),
    [
      { kind: "user", label: "You", text: "hello there" },
      { kind: "tool", label: "exec_command", text: "npm test -- --runInBand" },
      { kind: "assistant", label: "Codex", text: "I tightened the session renderer." },
    ],
  );
  assert.equal(narrative.entries[1].status, "done");
  assert.equal(narrative.entries[1].outputPreview, "Tests passed.");
});

test("Claude native narrative turns onboarding seed prompts into kickoff status and resolves tool results", () => {
  const text = [
    JSON.stringify({ type: "permission-mode", permissionMode: "bypassPermissions", timestamp: "2026-04-24T01:00:00.000Z" }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-04-24T01:00:01.000Z",
      message: {
        role: "user",
        content: "Please act as a friendly Vibe Research onboarding guide.\nContext:\n- Agent Town API: /api/agent-town\n- Library folder: /tmp/lib",
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-04-24T01:00:02.000Z",
      message: {
        role: "user",
        content: "can you help me connect google calendar?",
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-24T01:00:03.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Absolutely. We'll do it one small step at a time." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo ready", description: "Check environment" } },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-04-24T01:00:04.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ready", is_error: false }],
      },
    }),
  ].join("\n");

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude Code" });

  assert.equal(narrative.providerBacked, true);
  assert.deepEqual(
    narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label, text: entry.text })),
    [
      { kind: "status", label: "Permissions", text: "Claude is running with bypassPermissions permissions." },
      { kind: "status", label: "Kickoff", text: "Session seeded with app instructions." },
      { kind: "user", label: "You", text: "can you help me connect google calendar?" },
      { kind: "assistant", label: "Claude Code", text: "Absolutely. We'll do it one small step at a time." },
      { kind: "tool", label: "Bash", text: "echo ready" },
    ],
  );
  assert.equal(narrative.entries.at(-1).status, "done");
  assert.equal(narrative.entries.at(-1).outputPreview, "ready");
});

test("Codex native narrative uses event messages for thinking and commentary before the final answer lands", () => {
  const timestamp = "2026-04-24T04:51:37.075Z";
  const text = [
    JSON.stringify({ timestamp, type: "session_meta", payload: { id: "codex-thread", cwd: "/tmp/demo" } }),
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-1",
      },
    }),
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "I am checking the repo before I touch anything.",
        phase: "commentary",
      },
    }),
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "The changes are in place.",
        phase: "final_answer",
      },
    }),
  ].join("\n");

  const narrative = buildCodexNarrativeFromText(text, { providerId: "codex", providerLabel: "Codex" });

  assert.deepEqual(
    narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label, text: entry.text })),
    [
      { kind: "status", label: "Thinking", text: "Codex is thinking..." },
      { kind: "status", label: "Activity", text: "I am checking the repo before I touch anything." },
      { kind: "assistant", label: "Codex", text: "The changes are in place." },
    ],
  );
});

test("Claude native narrative drops the placeholder Thinking spinner when the same turn already has a tool call", () => {
  // Real thinking content should still surface; only the empty-string thinking
  // block (which only emits the generic "Claude is thinking..." placeholder)
  // should be suppressed when the same assistant content already carries a
  // visible tool_use. Otherwise the feed gets a Thinking row between every
  // pair of tool calls, which is exactly the noise the screenshot shows.
  const text = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-24T01:00:03.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo ready" } },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-04-24T01:00:04.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Exit code 1\nphase: None", is_error: true }],
      },
    }),
  ].join("\n");

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude Code" });

  assert.deepEqual(
    narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label, text: entry.text })),
    [
      { kind: "tool", label: "Bash", text: "echo ready" },
    ],
  );
  assert.equal(narrative.entries.at(-1).status, "error");
  assert.equal(narrative.entries.at(-1).outputPreview, "Exit code 1");
});

test("Claude native narrative keeps real thinking content even when a tool call follows", () => {
  // The opposite of the test above: when the thinking block has actual text
  // (Claude shared its reasoning), keep the Thinking entry — it's not a
  // redundant spinner, it's a load-bearing summary of why the tool fired.
  const text = JSON.stringify({
    type: "assistant",
    timestamp: "2026-04-24T01:00:03.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I'll check the README first to understand the layout." },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "README.md" } },
      ],
    },
  });

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude Code" });

  assert.deepEqual(
    narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label })),
    [
      { kind: "status", label: "Thinking" },
      { kind: "tool", label: "Read" },
    ],
  );
  assert.match(narrative.entries[0].text, /check the README first/);
});

test("Claude native narrative emits ONE entry for an errored assistant turn (clean pill, no JSON bubble)", () => {
  // Claude duplicates the error string into both `payload.error` and the
  // first content[].text block on auth failures. Without skipping the
  // content walk on errored turns, the chat shows a clean "Error" status
  // pill (with a Sign-in slash-action) AND a separate assistant bubble
  // dumping the raw 401 JSON next to it. Keep just the pill.
  const text = JSON.stringify({
    type: "assistant",
    timestamp: "2026-04-30T19:03:00.000Z",
    error: "authentication_failed",
    message: {
      id: "msg_err",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"Invalid authentication credentials\"},\"request_id\":\"req_abc\"}",
        },
      ],
    },
  });

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude Code" });

  assert.equal(narrative.entries.length, 1);
  assert.deepEqual(
    narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label, text: entry.text })),
    [{ kind: "status", label: "Error", text: "authentication_failed" }],
  );
});

test("Claude native narrative collapses a sequence of placeholder Thinking spinners across turns", () => {
  // Three assistant turns, each carrying only the empty thinking placeholder
  // and a tool_use. Without dedup the feed reads as Thinking · Tool · Thinking
  // · Tool · Thinking · Tool, which is the screenshot's ladder.
  const lines = [];
  for (let turn = 1; turn <= 3; turn += 1) {
    lines.push(JSON.stringify({
      type: "assistant",
      timestamp: `2026-04-24T01:00:0${turn}.000Z`,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "" },
          { type: "tool_use", id: `toolu_${turn}`, name: "Bash", input: { command: `echo ${turn}` } },
        ],
      },
    }));
    lines.push(JSON.stringify({
      type: "user",
      timestamp: `2026-04-24T01:00:0${turn}.500Z`,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `toolu_${turn}`, content: "ok" }],
      },
    }));
  }

  const narrative = buildClaudeNarrativeFromText(lines.join("\n"), { providerId: "claude", providerLabel: "Claude Code" });
  const kinds = narrative.entries.map((entry) => entry.kind);
  assert.deepEqual(kinds, ["tool", "tool", "tool"], `unexpected sequence: ${kinds.join(",")}`);
});

test("Claude native narrative renders TodoWrite tool calls with a structured todo summary instead of 'TodoWrite called'", () => {
  const text = JSON.stringify({
    type: "assistant",
    timestamp: "2026-04-24T01:00:03.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "Audit native chat", activeForm: "Auditing native chat", status: "completed" },
              { content: "Fix Thinking dedup", activeForm: "Fixing Thinking dedup", status: "in_progress" },
              { content: "Render task list", activeForm: "Rendering task list", status: "pending" },
            ],
          },
        },
      ],
    },
  });

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude Code" });
  const todoEntry = narrative.entries.find((entry) => entry.kind === "tool" && entry.label === "TodoWrite");
  assert.ok(todoEntry, "expected a TodoWrite tool entry");
  assert.notEqual(todoEntry.text, "TodoWrite called", "TodoWrite text should describe the todos, not the placeholder");
  assert.match(todoEntry.text, /3 tasks/);
  assert.deepEqual(todoEntry.todos, [
    { content: "Audit native chat", activeForm: "Auditing native chat", status: "completed" },
    { content: "Fix Thinking dedup", activeForm: "Fixing Thinking dedup", status: "in_progress" },
    { content: "Render task list", activeForm: "Rendering task list", status: "pending" },
  ]);
});

test("Session manager native narrative reads Gemini jsonl chat logs", async () => {
  const harness = await createManager();
  const { manager, workspaceDir, userHomeDir } = harness;

  try {
    const session = manager.buildSessionRecord({
      providerId: "gemini",
      providerLabel: "Gemini CLI",
      name: "Gemini 1",
      cwd: workspaceDir,
      status: "running",
    });
    manager.sessions.set(session.id, session);
    manager.updateProviderState(session, { sessionId: "gemini-thread-1" });

    const projectId = "demo-project";
    const geminiRoot = path.join(userHomeDir, ".gemini");
    await mkdir(path.join(geminiRoot, "tmp", projectId, "chats"), { recursive: true });
    await writeFile(
      path.join(geminiRoot, "projects.json"),
      JSON.stringify({
        projects: {
          [path.resolve(workspaceDir)]: projectId,
        },
      }, null, 2),
      "utf8",
    );

    const chatPath = path.join(geminiRoot, "tmp", projectId, "chats", "session-2026-04-24T01-30-demo.jsonl");
    await writeFile(
      chatPath,
      [
        JSON.stringify({
          sessionId: "gemini-thread-1",
          projectHash: "abc",
          startTime: "2026-04-24T01:30:00.000Z",
          lastUpdated: "2026-04-24T01:31:00.000Z",
          kind: "main",
        }),
        JSON.stringify({
          id: "u1",
          timestamp: "2026-04-24T01:30:10.000Z",
          type: "user",
          content: [{ text: "hello gemini" }],
        }),
        JSON.stringify({
          id: "a1",
          timestamp: "2026-04-24T01:30:12.000Z",
          type: "assistant",
          content: [{ text: "Hi! I can help." }],
        }),
      ].join("\n"),
      "utf8",
    );

    const narrative = await manager.getSessionNarrative(session.id);

    assert.equal(narrative.providerBacked, true);
    assert.equal(narrative.sourceLabel, "Gemini chat log");
    assert.deepEqual(
      narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label, text: entry.text })),
      [
        { kind: "user", label: "You", text: "hello gemini" },
        { kind: "assistant", label: "Gemini CLI", text: "Hi! I can help." },
      ],
    );
  } finally {
    await cleanupManager(harness);
  }
});

test("Session manager native narrative resolves Codex transcripts by workspace cwd", async () => {
  const harness = await createManager();
  const { manager, workspaceDir, userHomeDir } = harness;

  try {
    const session = manager.buildSessionRecord({
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex 1",
      cwd: workspaceDir,
      status: "running",
    });
    manager.sessions.set(session.id, session);

    await writeCodexTranscript(userHomeDir, {
      sessionId: "codex-thread-1",
      cwd: path.resolve(workspaceDir),
      timestamp: "2026-04-24T03:39:35.952Z",
      extraLines: [
        {
          timestamp: "2026-04-24T03:39:36.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello codex" }],
          },
        },
        {
          timestamp: "2026-04-24T03:39:37.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hi from the native transcript." }],
          },
        },
      ],
    });

    const narrative = await manager.getSessionNarrative(session.id);

    assert.equal(narrative.providerBacked, true);
    assert.equal(narrative.sourceLabel, "Codex session file");
    assert.deepEqual(
      narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label, text: entry.text })),
      [
        { kind: "user", label: "You", text: "hello codex" },
        { kind: "assistant", label: "Codex", text: "Hi from the native transcript." },
      ],
    );
  } finally {
    await cleanupManager(harness);
  }
});

test("Session manager native narrative resolves Codex transcripts with large session meta lines", async () => {
  const harness = await createManager();
  const { manager, workspaceDir, userHomeDir } = harness;

  try {
    const session = manager.buildSessionRecord({
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex Large Meta",
      cwd: workspaceDir,
      status: "running",
      updatedAt: "2026-04-24T02:45:00.000Z",
    });
    manager.sessions.set(session.id, session);

    await writeCodexTranscript(userHomeDir, {
      sessionId: "019dbdde-large-meta",
      cwd: workspaceDir,
      timestamp: "2026-04-24T02:45:00.000Z",
      sessionMeta: {
        base_instructions: {
          text: "x".repeat(24_000),
        },
      },
      extraLines: [
        {
          timestamp: "2026-04-24T02:45:02.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Hello from a large session_meta line.",
            phase: "final_answer",
          },
        },
      ],
    });

    const narrative = await manager.getSessionNarrative(session.id);

    assert.equal(narrative.providerBacked, true);
    assert.equal(narrative.sourceLabel, "Codex session file");
    assert.deepEqual(
      narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label, text: entry.text })),
      [
        { kind: "assistant", label: "Codex", text: "Hello from a large session_meta line." },
      ],
    );
  } finally {
    await cleanupManager(harness);
  }
});

// ---------------------------------------------------------------------------
// Structured wire-format fields. These tests pin the contract the client
// renderer relies on: every entry is self-describing — image refs, slash
// actions, plan-mode payloads, and MCP server identity all ride along on
// the entry object, no regex over the prose at render time.
// ---------------------------------------------------------------------------

test("extractSlashActionFromText recognises the canonical /login auth-failed phrase even when ANSI-coloured", () => {
  // Red-coloured "Please run /login" — the renderer used to regex on the cooked
  // text; the wire-format field now handles ANSI strip server-side so the client
  // just reads `entry.slashAction`.
  const ansiPainted = "[31mPlease run /login[0m to retry the request.";
  assert.deepEqual(extractSlashActionFromText(ansiPainted), { command: "/login", label: "Sign in" });
  assert.deepEqual(
    extractSlashActionFromText("Authentication failed: token expired"),
    { command: "/login", label: "Sign in" },
  );
  assert.equal(extractSlashActionFromText("just regular prose"), null);
});

test("extractImageRefsFromText pulls workspace-relative and absolute paths but skips bare basenames", () => {
  const text = "saved to figures/run-12.png and /Users/mark/runs/loss.jpg — but ignore foo.png mention";
  assert.deepEqual(
    extractImageRefsFromText(text),
    ["figures/run-12.png", "/Users/mark/runs/loss.jpg"],
  );
});

test("extractImageRefsFromText respects markdown image syntax when includeMarkdown is set", () => {
  const text = "![dropped image: cat](/abs/cat.png) See attachment ./figures/run.jpg.";
  const refs = extractImageRefsFromText(text, { includeMarkdown: true });
  assert.ok(refs.includes("/abs/cat.png"), "absolute markdown path should appear");
  assert.ok(refs.some((r) => r.endsWith("figures/run.jpg")), "relative path should appear");
});

test("parseMcpToolName splits mcp__server__tool names while ignoring native tool names", () => {
  assert.deepEqual(parseMcpToolName("mcp__filesystem__read_file"), { server: "filesystem", tool: "read_file" });
  assert.deepEqual(parseMcpToolName("mcp__github__create_pull_request"), { server: "github", tool: "create_pull_request" });
  assert.equal(parseMcpToolName("Bash"), null);
  assert.equal(parseMcpToolName("Read"), null);
  assert.equal(parseMcpToolName(""), null);
});

test("parseMcpToolName handles server names containing underscores via non-greedy matching", () => {
  // Server names like `github_enterprise` or `vector_search_remote` are
  // legitimate. The regex's non-greedy server portion has to bind to the
  // shortest prefix that still leaves a `__<tool>` suffix. Tool name can
  // contain underscores too — that's the greedy tail.
  assert.deepEqual(
    parseMcpToolName("mcp__github_enterprise__create_pr"),
    { server: "github_enterprise", tool: "create_pr" },
  );
  assert.deepEqual(
    parseMcpToolName("mcp__vector_search_remote__similarity_search"),
    { server: "vector_search_remote", tool: "similarity_search" },
  );
  assert.deepEqual(
    parseMcpToolName("mcp__a_b__c_d_e"),
    { server: "a_b", tool: "c_d_e" },
  );
});

test("parseMcpToolName: a single-segment name with mcp prefix but no tool half is null", () => {
  // Defensive: a malformed `mcp__foo` without the second `__` separator
  // is not a valid MCP tool name. Returning null is correct.
  assert.equal(parseMcpToolName("mcp__foo"), null);
  assert.equal(parseMcpToolName("mcp__"), null);
});

test("parseMcpToolName: empty server segment (mcp____tool) is rejected", () => {
  // The non-greedy server class requires at least one char, so a
  // pathological `mcp____foo` (server is empty between the two `__`s)
  // does not match. Confirms the regex doesn't accept zero-width
  // server names.
  assert.equal(parseMcpToolName("mcp____foo"), null);
  assert.equal(parseMcpToolName("mcp______tool"), null);
});

test("extractPlanFromToolUse pulls the plan body from an ExitPlanMode tool_use", () => {
  const toolUse = {
    type: "tool_use",
    name: "ExitPlanMode",
    id: "plan_1",
    input: { plan: "1. Read the file\n2. Apply the patch\n3. Run tests" },
  };
  assert.equal(extractPlanFromToolUse(toolUse), "1. Read the file\n2. Apply the patch\n3. Run tests");
  assert.equal(extractPlanFromToolUse({ name: "Bash", input: { plan: "x" } }), "");
  assert.equal(extractPlanFromToolUse({ name: "ExitPlanMode", input: {} }), "");
  assert.equal(extractPlanFromToolUse(null), "");
});

test("Claude narrative emits one entry per content block in order (interleaved text + tool_use)", () => {
  // Real Claude commonly returns content arrays like
  // [text, tool_use, text, tool_use] when the model thinks-then-tool-
  // then-thinks. Merging text into one entry ahead of every tool entry
  // would visually overlap streaming text on top of tool cards. The
  // shaper must walk content[] in order and emit one entry per block.
  const timestamp = "2026-04-30T08:00:00.000Z";
  const text = JSON.stringify({
    timestamp,
    type: "assistant",
    message: {
      id: "msg_1",
      content: [
        { type: "text", text: "First, let me check the readme." },
        { type: "tool_use", id: "tool_a", name: "Grep", input: { pattern: "INSIGHTS" } },
        { type: "text", text: "Found it. Now reading the project file." },
        { type: "tool_use", id: "tool_b", name: "Read", input: { path: "README.md" } },
      ],
    },
  });

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude" });
  const order = narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label, text: entry.text }));

  // Strict ordering: text₁, tool₁, text₂, tool₂.
  assert.equal(order.length, 4);
  assert.equal(order[0].kind, "assistant");
  assert.match(order[0].text, /First, let me check/u);
  assert.equal(order[1].kind, "tool");
  assert.equal(order[1].label, "Grep");
  assert.equal(order[2].kind, "assistant");
  assert.match(order[2].text, /Found it/u);
  assert.equal(order[3].kind, "tool");
  assert.equal(order[3].label, "Read");
});

test("Claude narrative: tool emitted between two text blocks survives across re-parse (stable per-block ids)", () => {
  // Re-parsing the same transcript should produce the same entries with
  // the same ids — the WS push protocol relies on stable ids so re-runs
  // mutate in place rather than appending duplicates.
  const timestamp = "2026-04-30T08:00:00.000Z";
  const text = JSON.stringify({
    timestamp,
    type: "assistant",
    message: {
      id: "msg_42",
      content: [
        { type: "text", text: "Block A." },
        { type: "tool_use", id: "tool_x", name: "Read", input: { path: "x" } },
        { type: "text", text: "Block B." },
      ],
    },
  });

  const first = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude" });
  const second = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude" });
  assert.deepEqual(
    first.entries.map((e) => e.id),
    second.entries.map((e) => e.id),
    "ids must be deterministic across re-parses",
  );
});

test("Claude narrative emits a `plan` entry for ExitPlanMode tool_use with the plan body", () => {
  const timestamp = "2026-04-29T12:00:00.000Z";
  const text = [
    JSON.stringify({
      timestamp,
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "plan_a", name: "ExitPlanMode", input: { plan: "Step 1.\nStep 2.\nStep 3." } },
        ],
      },
    }),
  ].join("\n");

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude Code" });
  const planEntry = narrative.entries.find((e) => e.kind === "plan");
  assert.ok(planEntry, "expected a `plan` entry");
  assert.equal(planEntry.text, "Step 1.\nStep 2.\nStep 3.");
  assert.equal(planEntry.label, "Plan");
});

test("Claude narrative tags MCP tool calls with structured server/tool metadata", () => {
  const timestamp = "2026-04-29T12:00:00.000Z";
  const text = [
    JSON.stringify({
      timestamp,
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "mcp_a", name: "mcp__filesystem__read_file", input: { path: "/tmp/x" } },
        ],
      },
    }),
  ].join("\n");

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude Code" });
  const toolEntry = narrative.entries.find((e) => e.kind === "tool");
  assert.ok(toolEntry, "expected a tool entry for the MCP call");
  assert.deepEqual(toolEntry.mcp, { server: "filesystem", tool: "read_file" });
  // Label should be human-readable: server.tool, not the raw mcp__ prefix.
  assert.equal(toolEntry.label, "filesystem.read_file");
});

test("Claude narrative attaches imageRefs to tool entries that name an image path", () => {
  const timestamp = "2026-04-29T12:00:00.000Z";
  const text = [
    JSON.stringify({
      timestamp,
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "read_a", name: "Read", input: { path: "figures/loss-curve.png" } },
        ],
      },
    }),
  ].join("\n");

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude Code" });
  const toolEntry = narrative.entries.find((e) => e.kind === "tool");
  assert.ok(toolEntry, "expected a tool entry");
  assert.deepEqual(toolEntry.imageRefs, ["figures/loss-curve.png"]);
});

test("Claude narrative attaches imageRefs to assistant messages that mention a saved figure", () => {
  const timestamp = "2026-04-29T12:00:00.000Z";
  const text = [
    JSON.stringify({
      timestamp,
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Saved the loss curve to figures/loss-curve.png so you can inspect it." },
        ],
      },
    }),
  ].join("\n");

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude Code" });
  const assistantEntry = narrative.entries.find((e) => e.kind === "assistant");
  assert.ok(assistantEntry, "expected an assistant entry");
  assert.deepEqual(assistantEntry.imageRefs, ["figures/loss-curve.png"]);
});

test("Claude narrative attaches slashAction on an auth_failed assistant error", () => {
  const timestamp = "2026-04-29T12:00:00.000Z";
  const text = [
    JSON.stringify({
      timestamp,
      type: "assistant",
      error: "Authentication failed. Please run /login to refresh your credentials.",
      message: { content: [] },
    }),
  ].join("\n");

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude Code" });
  const errorEntry = narrative.entries.find((e) => e.kind === "status" && e.label === "Error");
  assert.ok(errorEntry, "expected an Error status entry");
  assert.deepEqual(errorEntry.slashAction, { command: "/login", label: "Sign in" });
});

test("Claude narrative stamps `truncated: true` on entries whose visible text was clipped at the wire cap", () => {
  const padding = "x".repeat(14_000);
  const text = JSON.stringify({
    timestamp: "2026-04-29T12:00:00.000Z",
    type: "assistant",
    message: { content: [{ type: "text", text: padding }] },
  });
  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude" });
  const assistant = narrative.entries.find((e) => e.kind === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.truncated, true);
  assert.ok(assistant.text.length <= 12_000);
  // Trailing ellipsis is present.
  assert.match(assistant.text, /…$/u);
});

test("Claude narrative does NOT stamp `truncated: true` when the text fits within the cap", () => {
  const text = JSON.stringify({
    timestamp: "2026-04-29T12:00:00.000Z",
    type: "assistant",
    message: { content: [{ type: "text", text: "short reply" }] },
  });
  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude" });
  const assistant = narrative.entries.find((e) => e.kind === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.truncated, undefined);
});

test("Claude narrative extracts imageRefs from FULL text BEFORE truncation: a path mentioned in the tail of a >12K assistant message still appears", () => {
  // MAX_TEXT_LENGTH = 12_000. A 14K-char message with the image path
  // mentioned at the end would lose the path if extraction ran on the
  // truncated text. The shaper must extract first, then truncate the
  // visible text, and imageRefs must ride along on the entry.
  const padding = "x".repeat(14_000);
  const messageText = `Working on the analysis...\n${padding}\nFinally, saved figures/loss-curve.png for review.`;
  const text = JSON.stringify({
    timestamp: "2026-04-29T12:00:00.000Z",
    type: "assistant",
    message: { content: [{ type: "text", text: messageText }] },
  });

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude" });
  const assistant = narrative.entries.find((e) => e.kind === "assistant");
  assert.ok(assistant);
  // imageRefs survive the truncation pass.
  assert.deepEqual(assistant.imageRefs, ["figures/loss-curve.png"]);
  // Text was truncated but the image strip still renders correctly because
  // the renderer reads imageRefs, not the cropped text.
  assert.ok(assistant.text.length <= 12_000, "text truncated to MAX_TEXT_LENGTH");
});

test("Claude narrative extracts slashAction from FULL error text BEFORE truncation", () => {
  // Same invariant for slashAction: a long error message with the
  // /login trigger at the tail must still produce the inline button.
  const longTail = "y".repeat(14_000);
  const errorText = `An error happened.\n${longTail}\nPlease run /login to refresh.`;
  const text = JSON.stringify({
    timestamp: "2026-04-29T12:00:00.000Z",
    type: "assistant",
    error: errorText,
    message: { content: [] },
  });

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude" });
  const errorEntry = narrative.entries.find((e) => e.kind === "status" && e.label === "Error");
  assert.ok(errorEntry);
  assert.deepEqual(errorEntry.slashAction, { command: "/login", label: "Sign in" });
});

test("Claude narrative tool entry id stays stable across snapshot rebuilds even as message log grows", () => {
  // Regression for the "TodoWrite overwrites text output / messes up
  // chronology" bug. Tool entry ids previously included `entries.length+1`
  // — the position of the tool entry as it was being pushed. Two
  // snapshots of the SAME tool call (e.g. one before and one after a
  // later message gets appended) would compute different lengths and
  // produce different ids. The diff broadcaster then treated the call
  // as remove+add and the client moved it to the bottom of the order,
  // visually overwriting any text emitted after it.
  const ts = "2026-04-30T12:00:00.000Z";
  const initialLog = [
    JSON.stringify({
      timestamp: ts,
      type: "assistant",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [
          { type: "text", text: "Let me check the file." },
          { type: "tool_use", id: "toolu_todo_1", name: "TodoWrite", input: { todos: [{ content: "Task A", activeForm: "Doing A", status: "in_progress" }] } },
        ],
      },
    }),
  ].join("\n");

  const before = buildClaudeNarrativeFromText(initialLog, { providerId: "claude", providerLabel: "Claude Code" });
  const todoEntryBefore = before.entries.find((e) => e.kind === "tool" && Array.isArray(e.todos));
  assert.ok(todoEntryBefore, "TodoWrite entry rendered in initial snapshot");

  // Append later messages and rebuild — the same tool_use's id MUST be
  // identical so the diff sees an in-place update, not remove+add.
  const expandedLog = [
    initialLog,
    JSON.stringify({
      timestamp: ts,
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_todo_1", content: "ok", is_error: false }],
      },
    }),
    JSON.stringify({
      timestamp: ts,
      type: "assistant",
      message: {
        id: "msg_2",
        role: "assistant",
        content: [{ type: "text", text: "Done with task A. Moving on." }],
      },
    }),
  ].join("\n");

  const after = buildClaudeNarrativeFromText(expandedLog, { providerId: "claude", providerLabel: "Claude Code" });
  const todoEntryAfter = after.entries.find((e) => e.kind === "tool" && Array.isArray(e.todos));
  assert.ok(todoEntryAfter, "TodoWrite entry still present in expanded snapshot");
  assert.equal(
    todoEntryBefore.id,
    todoEntryAfter.id,
    "TodoWrite id must be stable across snapshot rebuilds — otherwise the diff broadcaster reshuffles the chat",
  );

  // Order check: the TodoWrite entry should come BEFORE the follow-up
  // assistant text "Done with task A. Moving on.", not after.
  const ids = after.entries.map((e) => e.id);
  const todoIdx = ids.indexOf(todoEntryAfter.id);
  const followupIdx = after.entries.findIndex((e) => e.kind === "assistant" && /Done with task A/.test(e.text));
  assert.ok(todoIdx >= 0 && followupIdx > todoIdx, "TodoWrite must appear before later assistant text in the order");
});

test("Claude narrative plan entry (ExitPlanMode) id is stable across snapshot rebuilds", () => {
  const ts = "2026-04-30T12:00:00.000Z";
  const log = [
    JSON.stringify({
      timestamp: ts,
      type: "assistant",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_plan_1", name: "ExitPlanMode", input: { plan: "Step 1\nStep 2" } },
        ],
      },
    }),
  ].join("\n");
  const expanded = [
    log,
    JSON.stringify({
      timestamp: ts,
      type: "assistant",
      message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "ok" }] },
    }),
  ].join("\n");
  const before = buildClaudeNarrativeFromText(log, { providerId: "claude", providerLabel: "Claude" });
  const after = buildClaudeNarrativeFromText(expanded, { providerId: "claude", providerLabel: "Claude" });
  const planBefore = before.entries.find((e) => e.kind === "plan");
  const planAfter = after.entries.find((e) => e.kind === "plan");
  assert.ok(planBefore && planAfter);
  assert.equal(planBefore.id, planAfter.id, "ExitPlanMode plan id stable across rebuilds");
});

test("Claude narrative attaches imageRefs only when user message used the explicit attachment markdown", () => {
  const timestamp = "2026-04-29T12:00:00.000Z";
  const text = [
    JSON.stringify({
      timestamp,
      type: "user",
      message: { content: "![dropped image: cat](/abs/cat.png) what's in this picture?" },
    }),
    JSON.stringify({
      timestamp,
      type: "user",
      message: { content: "look at figures/loss.png in passing" },
    }),
  ].join("\n");

  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude Code" });
  const userEntries = narrative.entries.filter((e) => e.kind === "user");
  assert.equal(userEntries.length, 2);
  // Explicit markdown attachment yields a tile.
  assert.deepEqual(userEntries[0].imageRefs, ["/abs/cat.png"]);
  // Plain prose mention does NOT — would auto-embed unrelated images.
  assert.equal(userEntries[1].imageRefs, undefined);
});
