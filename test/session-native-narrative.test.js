import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  buildClaudeNarrativeFromText,
  buildCodexNarrativeFromText,
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
