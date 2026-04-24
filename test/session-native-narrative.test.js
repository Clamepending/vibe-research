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

async function writeCodexTranscript(homeDir, { sessionId, cwd, timestamp, extraLines = [] }) {
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

test("Claude native narrative surfaces thinking blocks before tool calls complete", () => {
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
      { kind: "status", label: "Thinking", text: "Claude is thinking..." },
      { kind: "tool", label: "Bash", text: "echo ready" },
    ],
  );
  assert.equal(narrative.entries.at(-1).status, "error");
  assert.equal(narrative.entries.at(-1).outputPreview, "Exit code 1");
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
