import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { SessionManager } from "../src/session-manager.js";

// Stream mode for Claude AND Codex is the runtime default but bypasses
// PTY/tmux entirely. The legacy session-manager tests exercise the PTY+tmux
// path (provider-launch wrappers, persistent terminals, transcript
// projection, etc.) and need an explicit opt-out so a default-on flag
// doesn't reroute them into the stream code path.
process.env.VIBE_RESEARCH_CLAUDE_STREAM_MODE = "0";
process.env.VIBE_RESEARCH_CODEX_STREAM_MODE = "0";

const execFileAsync = promisify(execFile);

const fakeAgentProviders = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    defaultName: "Claude",
    available: true,
    launchCommand: "claude",
  },
  {
    id: "claude-ollama",
    label: "Local Claude Code (Ollama)",
    command: "claude",
    defaultName: "Local Claude",
    available: true,
    launchCommand: "claude",
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    defaultName: "Codex",
    available: true,
    launchCommand: "codex",
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    command: "openclaw",
    defaultName: "OpenClaw",
    available: true,
    launchCommand: "openclaw",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    defaultName: "Gemini",
    available: true,
    launchCommand: "gemini",
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    defaultName: "OpenCode",
    available: true,
    launchCommand: "opencode",
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    command: "openclaw",
    defaultName: "OpenClaw",
    available: true,
    launchCommand: "openclaw",
  },
  {
    id: "ml-intern",
    label: "ML Intern",
    command: "ml-intern",
    defaultName: "ML Intern",
    available: true,
    launchCommand: "ml-intern",
  },
  {
    id: "shell",
    label: "Vanilla Shell",
    command: null,
    defaultName: "Shell",
    available: true,
    launchCommand: null,
  },
];

async function createManager({ cwd, ...managerOptions } = {}) {
  const workspaceDir = cwd || await mkdtemp(path.join(os.tmpdir(), "vibe-research-session-manager-"));
  const userHomeDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-session-home-"));
  const manager = new SessionManager({
    cwd: workspaceDir,
    providers: fakeAgentProviders,
    persistentTerminals: false,
    persistSessions: false,
    stateDir: path.join(workspaceDir, ".vibe-research"),
    userHomeDir,
    ...managerOptions,
  });

  await manager.initialize();

  return {
    manager,
    userHomeDir,
    workspaceDir,
  };
}

async function cleanupManager(manager, workspaceDir, userHomeDir) {
  await manager.shutdown({ preserveSessions: false });
  await rm(workspaceDir, { recursive: true, force: true });
  await rm(userHomeDir, { recursive: true, force: true });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const claudeWrapperCommand = shellQuote(path.join(process.cwd(), "bin", "claude"));
const codexWrapperCommand = shellQuote(path.join(process.cwd(), "bin", "codex"));

function buildCodexTrustConfigArg(cwd) {
  return `projects."${path.resolve(cwd)}".trust_level="trusted"`;
}

function buildCodexExpectedCommand(cwd, args = []) {
  return [codexWrapperCommand, shellQuote("-c"), shellQuote(buildCodexTrustConfigArg(cwd)), ...args.map(shellQuote)].join(" ");
}

async function appendCodexSessionIndex(homeDir, entries) {
  const codexDir = path.join(homeDir, ".codex");
  await mkdir(codexDir, { recursive: true });
  const payload = entries
    .map((entry) => JSON.stringify({
      id: entry.id,
      thread_name: entry.threadName || entry.id,
      updated_at: entry.updatedAt,
    }))
    .join("\n");
  await writeFile(path.join(codexDir, "session_index.jsonl"), `${payload}\n`, "utf8");
}

async function appendCodexPromptHistory(homeDir, entries) {
  const codexDir = path.join(homeDir, ".codex");
  await mkdir(codexDir, { recursive: true });
  const payload = entries
    .map((entry) => JSON.stringify({
      session_id: entry.sessionId,
      ts: entry.timestamp,
      text: entry.text || "hello",
    }))
    .join("\n");
  await writeFile(path.join(codexDir, "history.jsonl"), `${payload}\n`, "utf8");
}

async function writeCodexSessionMeta(homeDir, { sessionId, cwd, timestamp }) {
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
  const firstLine = JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp,
      cwd,
    },
  });
  await writeFile(path.join(dayDir, fileName), `${firstLine}\n`, "utf8");
}

async function writeArchivedCodexSessionMeta(homeDir, { sessionId, cwd, timestamp }) {
  const archivedDir = path.join(homeDir, ".codex", "archived_sessions");
  await mkdir(archivedDir, { recursive: true });
  const fileName = `rollout-${timestamp.replaceAll(":", "-")}-${sessionId}.jsonl`;
  const firstLine = JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp,
      cwd,
    },
  });
  await writeFile(path.join(archivedDir, fileName), `${firstLine}\n`, "utf8");
}

async function writeClaudeSubagent(homeDir, cwd, sessionId, {
  agentId = "a1234567890abcdef",
  description = "Research helper",
  agentType = "general-purpose",
  timestamps = ["2026-04-18T10:00:00.000Z", "2026-04-18T10:01:00.000Z"],
  complete = true,
} = {}) {
  const projectDir = path.join(homeDir, ".claude", "projects", path.resolve(cwd).replaceAll(path.sep, "-"));
  const subagentsDir = path.join(projectDir, sessionId, "subagents");
  const fileBase = `agent-${agentId}`;
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(
    path.join(subagentsDir, `${fileBase}.meta.json`),
    `${JSON.stringify({ agentType, description })}\n`,
    "utf8",
  );

  const lines = [
    {
      type: "user",
      isSidechain: true,
      agentId,
      promptId: "prompt-1",
      timestamp: timestamps[0],
      message: { role: "user", content: "Please explore this side task." },
    },
    {
      type: "assistant",
      isSidechain: true,
      agentId,
      timestamp: timestamps[1],
      message: {
        role: "assistant",
        stop_reason: complete ? "end_turn" : "tool_use",
        content: complete
          ? [{ type: "text", text: "Finished." }]
          : [{ type: "tool_use", name: "Read", input: { file_path: "README.md" } }],
      },
    },
  ];

  await writeFile(path.join(subagentsDir, `${fileBase}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

async function writeClaudeTranscript(homeDir, cwd, sessionId, lines) {
  const projectDir = path.join(homeDir, ".claude", "projects", path.resolve(cwd).replaceAll(path.sep, "-"));
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, `${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

async function writeGeminiSessions(homeDir, cwd, projectId, sessions) {
  const geminiDir = path.join(homeDir, ".gemini");
  await mkdir(geminiDir, { recursive: true });
  await writeFile(
    path.join(geminiDir, "projects.json"),
    JSON.stringify({
      projects: {
        [path.resolve(cwd)]: projectId,
      },
    }, null, 2),
    "utf8",
  );

  const chatsDir = path.join(geminiDir, "tmp", projectId, "chats");
  await mkdir(chatsDir, { recursive: true });

  for (const session of sessions) {
    await writeFile(
      path.join(chatsDir, session.fileName),
      JSON.stringify({
        sessionId: session.id,
        startTime: session.startTime,
        lastUpdated: session.lastUpdated,
        messages: [
          {
            type: "user",
            content: "hello",
          },
        ],
      }, null, 2),
      "utf8",
    );
  }
}

async function createExecutableScript(filePath, contents) {
  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, 0o755);
}

test("generic agent sessions auto-rename from the first submitted prompt", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const session = manager.createSession({
      providerId: "codex",
      cwd: workspaceDir,
    });

    manager.write(session.id, "please fix the flaky ");
    assert.equal(manager.getSession(session.id)?.name, "Codex 1");

    manager.write(session.id, "session rename tests");
    assert.equal(manager.getSession(session.id)?.name, "Codex 1");

    manager.write(session.id, "\r");
    assert.equal(manager.getSession(session.id)?.name, "fix the flaky session rename tests");
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("agent session auto-rename ignores terminal control responses before prompt text", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const session = manager.createSession({
      providerId: "codex",
      cwd: workspaceDir,
    });

    manager.write(
      session.id,
      "\u001b[>0;276;0c\u001b]10;rgb:f3f3/efef/e8e8\u0007hello, can you help me start?\r",
    );

    assert.equal(manager.getSession(session.id)?.name, "help me start");
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("custom session names are left alone after the first prompt", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const session = manager.createSession({
      providerId: "codex",
      cwd: workspaceDir,
      name: "investigation",
    });

    manager.write(session.id, "please audit the websocket rename flow\r");
    assert.equal(manager.getSession(session.id)?.name, "investigation");
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("initial agent prompts are submitted after provider readiness", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager({
    initialPromptDelayMs: 0,
    initialPromptReadyIdleMs: 0,
    initialPromptReadyTimeoutMs: 100,
    initialPromptRetryMs: 5,
    initialPromptSubmitDelayMs: 5,
  });

  try {
    const provider = fakeAgentProviders.find((entry) => entry.id === "claude");
    const session = manager.buildSessionRecord({
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Onboarding guide",
      cwd: workspaceDir,
      status: "running",
    });
    const writes = [];
    session.pty = {
      write(input) {
        writes.push(input);
      },
      kill() {},
    };
    session.buffer = "Claude Code v1.2.3\n❯";
    session.lastOutputAt = new Date(Date.now() - 1_000).toISOString();
    manager.sessions.set(session.id, session);

    assert.equal(
      manager.queueInitialPromptForSession(session, provider, "hello\nworld\r", { delayMs: 0 }),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(writes, ["hello\nworld", "\r"]);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("sessions record the selected occupation and forks inherit it", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager({ occupationId: "engineer" });

  try {
    const engineerSession = manager.createSession({
      providerId: "shell",
      cwd: workspaceDir,
    });
    assert.equal(engineerSession.occupationId, "engineer");

    manager.setOccupationId("custom");
    const customSession = manager.createSession({
      providerId: "shell",
      cwd: workspaceDir,
    });
    assert.equal(customSession.occupationId, "custom");

    const forkSession = manager.forkSession(engineerSession.id);
    assert.equal(forkSession.occupationId, "engineer");
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("agent sessions expose working and done activity states", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-session-manager-"));
  const userHomeDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-session-home-"));
  const pendingTimers = new Set();
  const manager = new SessionManager({
    cwd: workspaceDir,
    providers: fakeAgentProviders,
    persistSessions: false,
    stateDir: path.join(workspaceDir, ".vibe-research"),
    userHomeDir,
    sessionActivityIdleMs: 1,
    setTimeoutFn: (callback) => {
      const timer = { callback };
      pendingTimers.add(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      pendingTimers.delete(timer);
    },
  });

  const runNextTimer = () => {
    const [timer] = Array.from(pendingTimers);
    assert.ok(timer, "expected an activity timer");
    pendingTimers.delete(timer);
    timer.callback();
  };

  try {
    const session = manager.buildSessionRecord({
      id: "11111111-2222-4333-8444-activity0001",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Claude 1",
      cwd: workspaceDir,
      status: "running",
    });

    manager.trackSessionInputActivity(session, "please fix the status dot\r");
    assert.equal(session.activityStatus, "working");
    assert.match(session.lastPromptAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(session.activityCompletedAt, null);

    manager.trackSessionOutputActivity(session, "working...");
    assert.equal(session.activityStatus, "working");

    runNextTimer();
    assert.equal(session.activityStatus, "done");
    assert.match(session.activityCompletedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(manager.serializeSession(session).activityStatus, "done");
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("shell sessions do not use agent activity states", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const session = manager.buildSessionRecord({
      id: "11111111-2222-4333-8444-activity0002",
      providerId: "shell",
      providerLabel: "Vanilla Shell",
      name: "Shell 1",
      cwd: workspaceDir,
      status: "running",
    });

    manager.trackSessionInputActivity(session, "echo hi\r");
    manager.trackSessionOutputActivity(session, "hi\r\n");
    assert.equal(session.activityStatus, "idle");
    assert.equal(session.lastPromptAt, null);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Claude sessions use a fixed session id and resume it after restart", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const provider = manager.getProvider("claude");
    const session = manager.buildSessionRecord({
      id: "11111111-2222-4333-8444-555555555555",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Claude 1",
      cwd: workspaceDir,
    });

    const firstLaunch = await manager.prepareProviderLaunch(session, provider, { restored: false });
    assert.equal(
      firstLaunch.commandString,
      `${claudeWrapperCommand} '--dangerously-skip-permissions' '--session-id' '11111111-2222-4333-8444-555555555555'`,
    );

    const restoredLaunch = await manager.prepareProviderLaunch(session, provider, { restored: true });
    assert.equal(
      restoredLaunch.commandString,
      `${claudeWrapperCommand} '--dangerously-skip-permissions' '--resume' '11111111-2222-4333-8444-555555555555' || ${claudeWrapperCommand} '--dangerously-skip-permissions' '--session-id' '11111111-2222-4333-8444-555555555555'`,
    );
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("local Claude Code sessions use Ollama model args and resume like Claude", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager({
    env: {
      ...process.env,
      VIBE_RESEARCH_CLAUDE_OLLAMA_MODEL: "qwen2.5-coder:7b",
    },
  });

  try {
    const provider = manager.getProvider("claude-ollama");
    const session = manager.buildSessionRecord({
      id: "22222222-3333-4444-8555-666666666666",
      providerId: "claude-ollama",
      providerLabel: "Local Claude Code (Ollama)",
      name: "Local Claude 1",
      cwd: workspaceDir,
    });

    const firstLaunch = await manager.prepareProviderLaunch(session, provider, { restored: false });
    assert.equal(
      firstLaunch.commandString,
      `${claudeWrapperCommand} '--model' 'qwen2.5-coder:7b' '--dangerously-skip-permissions' '--session-id' '22222222-3333-4444-8555-666666666666'`,
    );

    const restoredLaunch = await manager.prepareProviderLaunch(session, provider, { restored: true });
    assert.equal(
      restoredLaunch.commandString,
      `${claudeWrapperCommand} '--model' 'qwen2.5-coder:7b' '--dangerously-skip-permissions' '--resume' '22222222-3333-4444-8555-666666666666' || ${claudeWrapperCommand} '--model' 'qwen2.5-coder:7b' '--dangerously-skip-permissions' '--session-id' '22222222-3333-4444-8555-666666666666'`,
    );
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("agent sessions reattach to persistent tmux terminals after manager restart", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-tmux-workspace-"));
  const userHomeDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-tmux-home-"));
  const stateDir = path.join(workspaceDir, ".vibe-research");
  const fakeTmuxPath = path.join(userHomeDir, "fake-tmux");
  const tmuxStatePath = path.join(userHomeDir, "tmux-session-alive");
  const tmuxProviderPath = path.join(userHomeDir, "tmux-provider-alive");
  const tmuxLogPath = path.join(userHomeDir, "tmux.log");
  let firstManager = null;
  let secondManager = null;

  const waitForLog = async (predicate) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      let contents = "";
      try {
        contents = await readFile(tmuxLogPath, "utf8");
      } catch {
        contents = "";
      }

      if (predicate(contents)) {
        return contents;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return readFile(tmuxLogPath, "utf8");
  };

  await createExecutableScript(
    fakeTmuxPath,
    `#!/bin/sh
STATE_FILE=${shellQuote(tmuxStatePath)}
PROVIDER_FILE=${shellQuote(tmuxProviderPath)}
LOG_FILE=${shellQuote(tmuxLogPath)}
printf 'args:%s\\n' "$*" >> "$LOG_FILE"
case "$1" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
  has-session)
    [ -f "$STATE_FILE" ]
    exit $?
    ;;
  list-panes)
    if [ -f "$PROVIDER_FILE" ]; then
      printf 'claude\\n'
    else
      printf 'zsh\\n'
    fi
    exit 0
    ;;
  new-session)
    : > "$STATE_FILE"
    while IFS= read -r line; do
      : > "$PROVIDER_FILE"
      printf 'stdin:%s\\n' "$line" >> "$LOG_FILE"
    done
    ;;
  attach-session)
    while IFS= read -r line; do
      : > "$PROVIDER_FILE"
      printf 'attach-stdin:%s\\n' "$line" >> "$LOG_FILE"
    done
    ;;
  detach-client)
    exit 0
    ;;
  kill-session)
    rm -f "$STATE_FILE"
    rm -f "$PROVIDER_FILE"
    exit 0
    ;;
esac
exit 0
`,
  );

  const managerOptions = {
    cwd: workspaceDir,
    env: {
      ...process.env,
      VIBE_RESEARCH_TMUX_COMMAND: fakeTmuxPath,
    },
    persistentTerminals: true,
    persistSessions: true,
    providers: fakeAgentProviders,
    stateDir,
    userHomeDir,
  };

  try {
    firstManager = new SessionManager(managerOptions);
    await firstManager.initialize();
    firstManager.createSession({
      providerId: "claude",
      cwd: workspaceDir,
      name: "Persistent Claude",
    });

    const firstLog = await waitForLog((contents) => contents.includes("args:new-session"));
    assert.match(firstLog, /args:new-session/);

    await firstManager.shutdown({ preserveSessions: true });
    const shutdownLog = await waitForLog((contents) => contents.includes("args:detach-client"));
    assert.match(shutdownLog, /args:detach-client -s vibe-research-/);

    secondManager = new SessionManager(managerOptions);
    await secondManager.initialize();

    const secondLog = await waitForLog((contents) => contents.includes("args:attach-session"));
    assert.match(secondLog, /args:attach-session/);
  } finally {
    await secondManager?.shutdown({ preserveSessions: false });
    await firstManager?.shutdown({ preserveSessions: false });
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  }
});

test("shell sessions reattach to persistent tmux terminals after manager restart", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-shell-tmux-workspace-"));
  const userHomeDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-shell-tmux-home-"));
  const stateDir = path.join(workspaceDir, ".vibe-research");
  const fakeTmuxPath = path.join(userHomeDir, "fake-tmux");
  const tmuxStatePath = path.join(userHomeDir, "tmux-session-alive");
  const tmuxLogPath = path.join(userHomeDir, "tmux.log");
  let firstManager = null;
  let secondManager = null;

  const waitForLog = async (predicate) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      let contents = "";
      try {
        contents = await readFile(tmuxLogPath, "utf8");
      } catch {
        contents = "";
      }

      if (predicate(contents)) {
        return contents;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return readFile(tmuxLogPath, "utf8");
  };

  await createExecutableScript(
    fakeTmuxPath,
    `#!/bin/sh
STATE_FILE=${shellQuote(tmuxStatePath)}
LOG_FILE=${shellQuote(tmuxLogPath)}
printf 'args:%s\\n' "$*" >> "$LOG_FILE"
case "$1" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
  has-session)
    [ -f "$STATE_FILE" ]
    exit $?
    ;;
  list-panes)
    printf 'zsh\\n'
    exit 0
    ;;
  new-session)
    : > "$STATE_FILE"
    while IFS= read -r line; do
      printf 'stdin:%s\\n' "$line" >> "$LOG_FILE"
    done
    ;;
  attach-session)
    while IFS= read -r line; do
      printf 'attach-stdin:%s\\n' "$line" >> "$LOG_FILE"
    done
    ;;
  detach-client)
    exit 0
    ;;
  kill-session)
    rm -f "$STATE_FILE"
    exit 0
    ;;
esac
exit 0
`,
  );

  const managerOptions = {
    cwd: workspaceDir,
    env: {
      ...process.env,
      VIBE_RESEARCH_TMUX_COMMAND: fakeTmuxPath,
    },
    persistentTerminals: true,
    persistSessions: true,
    providers: fakeAgentProviders,
    stateDir,
    userHomeDir,
  };

  try {
    firstManager = new SessionManager(managerOptions);
    await firstManager.initialize();
    firstManager.createSession({
      providerId: "shell",
      cwd: workspaceDir,
      name: "Persistent shell",
    });

    const firstLog = await waitForLog((contents) => contents.includes("args:new-session"));
    assert.match(firstLog, /args:new-session/);
    assert.doesNotMatch(firstLog, /stdin:/);

    await firstManager.shutdown({ preserveSessions: true });
    const shutdownLog = await waitForLog((contents) => contents.includes("args:detach-client"));
    assert.match(shutdownLog, /args:detach-client -s vibe-research-/);

    secondManager = new SessionManager(managerOptions);
    await secondManager.initialize();

    const secondLog = await waitForLog((contents) => contents.includes("args:attach-session"));
    assert.match(secondLog, /args:attach-session/);
    assert.doesNotMatch(secondLog, /attach-stdin:/);
  } finally {
    await secondManager?.shutdown({ preserveSessions: false });
    await firstManager?.shutdown({ preserveSessions: false });
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  }
});

test("agent sessions preserve idle persistent tmux terminals after manager restart", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-idle-tmux-workspace-"));
  const userHomeDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-idle-tmux-home-"));
  const stateDir = path.join(workspaceDir, ".vibe-research");
  const fakeTmuxPath = path.join(userHomeDir, "fake-tmux");
  const tmuxStatePath = path.join(userHomeDir, "tmux-session-alive");
  const tmuxProviderPath = path.join(userHomeDir, "tmux-provider-alive");
  const tmuxLogPath = path.join(userHomeDir, "tmux.log");
  const tmuxSessionName = "vibe-research-idle-claude";
  let manager = null;

  const waitForLog = async (predicate) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      let contents = "";
      try {
        contents = await readFile(tmuxLogPath, "utf8");
      } catch {
        contents = "";
      }

      if (predicate(contents)) {
        return contents;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return readFile(tmuxLogPath, "utf8");
  };

  await createExecutableScript(
    fakeTmuxPath,
    `#!/bin/sh
STATE_FILE=${shellQuote(tmuxStatePath)}
PROVIDER_FILE=${shellQuote(tmuxProviderPath)}
LOG_FILE=${shellQuote(tmuxLogPath)}
printf 'args:%s\\n' "$*" >> "$LOG_FILE"
case "$1" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
  has-session)
    [ -f "$STATE_FILE" ]
    exit $?
    ;;
  list-panes)
    if [ -f "$PROVIDER_FILE" ]; then
      printf 'claude\\n'
    else
      printf 'zsh\\n'
    fi
    exit 0
    ;;
  attach-session)
    while IFS= read -r line; do
      : > "$PROVIDER_FILE"
      printf 'attach-stdin:%s\\n' "$line" >> "$LOG_FILE"
    done
    ;;
  new-session)
    : > "$STATE_FILE"
    while IFS= read -r line; do
      : > "$PROVIDER_FILE"
      printf 'stdin:%s\\n' "$line" >> "$LOG_FILE"
    done
    ;;
  kill-session)
    rm -f "$STATE_FILE" "$PROVIDER_FILE"
    exit 0
    ;;
esac
exit 0
`,
  );

  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "sessions.json"),
      `${JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        sessions: [
          {
            id: "22222222-3333-4444-8555-666666666666",
            providerId: "claude",
            providerLabel: "Claude Code",
            name: "Idle Claude",
            cwd: workspaceDir,
            shell: "/bin/zsh",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: "running",
            restoreOnStartup: true,
            providerState: {
              sessionId: "claude-session-to-resume",
              terminalBackend: "tmux",
              tmuxSessionName,
            },
          },
        ],
      })}\n`,
      "utf8",
    );
    await writeFile(tmuxStatePath, "alive\n", "utf8");

    manager = new SessionManager({
      cwd: workspaceDir,
      env: {
        ...process.env,
        VIBE_RESEARCH_TMUX_COMMAND: fakeTmuxPath,
      },
      persistentTerminals: true,
      persistSessions: true,
      providers: fakeAgentProviders,
      stateDir,
      userHomeDir,
    });
    await manager.initialize();

    const logContents = await waitForLog((contents) =>
      contents.includes("args:list-panes") &&
      contents.includes("args:attach-session"),
    );
    assert.match(logContents, /args:list-panes/);
    assert.match(logContents, /args:attach-session -t vibe-research-idle-claude/);
    assert.doesNotMatch(logContents, /args:kill-session/);
    assert.doesNotMatch(logContents, /args:new-session/);
    assert.doesNotMatch(logContents, /stdin:.*--resume' 'claude-session-to-resume'/);
  } finally {
    await manager?.shutdown({ preserveSessions: false });
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  }
});

test("exited records reattach when their persistent tmux terminal is still alive", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-exited-tmux-workspace-"));
  const userHomeDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-exited-tmux-home-"));
  const stateDir = path.join(workspaceDir, ".vibe-research");
  const fakeTmuxPath = path.join(userHomeDir, "fake-tmux");
  const tmuxStatePath = path.join(userHomeDir, "tmux-session-alive");
  const tmuxLogPath = path.join(userHomeDir, "tmux.log");
  const tmuxSessionName = "vibe-research-exited-but-alive";
  let manager = null;

  const waitForLog = async (predicate) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      let contents = "";
      try {
        contents = await readFile(tmuxLogPath, "utf8");
      } catch {
        contents = "";
      }

      if (predicate(contents)) {
        return contents;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return readFile(tmuxLogPath, "utf8");
  };

  await createExecutableScript(
    fakeTmuxPath,
    `#!/bin/sh
STATE_FILE=${shellQuote(tmuxStatePath)}
LOG_FILE=${shellQuote(tmuxLogPath)}
printf 'args:%s\\n' "$*" >> "$LOG_FILE"
case "$1" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
  has-session)
    [ -f "$STATE_FILE" ]
    exit $?
    ;;
  list-panes)
    printf 'claude\\n'
    exit 0
    ;;
  attach-session)
    while IFS= read -r line; do
      printf 'attach-stdin:%s\\n' "$line" >> "$LOG_FILE"
    done
    ;;
  new-session)
    : > "$STATE_FILE"
    while IFS= read -r line; do
      printf 'stdin:%s\\n' "$line" >> "$LOG_FILE"
    done
    ;;
  kill-session)
    rm -f "$STATE_FILE"
    exit 0
    ;;
esac
exit 0
`,
  );

  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(tmuxStatePath, "alive\n", "utf8");
    await writeFile(
      path.join(stateDir, "sessions.json"),
      `${JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        sessions: [
          {
            id: "33333333-4444-4555-8666-777777777777",
            providerId: "claude",
            providerLabel: "Claude Code",
            name: "Revived Claude",
            cwd: workspaceDir,
            shell: "/bin/zsh",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: "exited",
            restoreOnStartup: false,
            providerState: {
              sessionId: "claude-session-to-revive",
              terminalBackend: "tmux",
              tmuxSessionName,
            },
          },
        ],
      })}\n`,
      "utf8",
    );

    manager = new SessionManager({
      cwd: workspaceDir,
      env: {
        ...process.env,
        VIBE_RESEARCH_TMUX_COMMAND: fakeTmuxPath,
      },
      persistentTerminals: true,
      persistSessions: true,
      providers: fakeAgentProviders,
      stateDir,
      userHomeDir,
    });
    await manager.initialize();

    const logContents = await waitForLog((contents) => contents.includes("args:attach-session"));
    assert.match(logContents, /args:attach-session -t vibe-research-exited-but-alive/);
    assert.doesNotMatch(logContents, /args:new-session/);
    assert.doesNotMatch(logContents, /stdin:.*--resume/);

    const [session] = manager.listSessions();
    assert.equal(session.status, "running");
  } finally {
    await manager?.shutdown({ preserveSessions: false });
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  }
});

test("forked sessions reuse provider memory without inheriting the parent's tmux terminal", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const sourceSession = manager.buildSessionRecord({
      id: "11111111-2222-4333-8444-forktmux0001",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Parent",
      cwd: workspaceDir,
      providerState: {
        sessionId: "claude-session-123",
        terminalBackend: "tmux",
        tmuxSessionName: "vibe-research-parent",
      },
    });

    assert.deepEqual(manager.getForkProviderState(sourceSession), {
      sessionId: "claude-session-123",
      forkedFromSessionId: sourceSession.id,
    });
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Claude sessions expose completed subagents from Claude sidechain transcripts", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const claudeSessionId = "11111111-2222-4333-8444-555555555555";
    await writeClaudeSubagent(userHomeDir, workspaceDir, claudeSessionId, {
      agentId: "abc123abc123",
      description: "ARC hill-climbing trial",
      agentType: "general-purpose",
      timestamps: ["2026-04-18T10:00:00.000Z", "2026-04-18T10:01:00.000Z"],
      complete: true,
    });

    const session = manager.buildSessionRecord({
      id: "99999999-8888-4777-8666-555555555555",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Claude 1",
      cwd: workspaceDir,
      providerState: {
        sessionId: claudeSessionId,
      },
    });

    const serialized = manager.serializeSession(session);
    assert.equal(serialized.subagents.length, 1);
    assert.equal(serialized.subagents[0].name, "ARC hill-climbing trial");
    assert.equal(serialized.subagents[0].agentType, "general-purpose");
    assert.equal(serialized.subagents[0].source, "claude");
    assert.equal(serialized.subagents[0].status, "done");
    assert.equal(serialized.subagents[0].messageCount, 2);
    assert.equal(serialized.subagents[0].toolUseCount, 0);
    assert.equal(serialized.subagents[0].parentProviderSessionId, claudeSessionId);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Claude sessions expose active subagents when the session id is the provider id", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const claudeSessionId = "22222222-3333-4444-8555-666666666666";
    const now = Date.now();
    await writeClaudeSubagent(userHomeDir, workspaceDir, claudeSessionId, {
      agentId: "def456def456",
      description: "Read docs in parallel",
      agentType: "explorer",
      timestamps: [new Date(now - 1_000).toISOString(), new Date(now).toISOString()],
      complete: false,
    });

    const session = manager.buildSessionRecord({
      id: claudeSessionId,
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Claude 1",
      cwd: workspaceDir,
    });

    const serialized = manager.serializeSession(session);
    assert.equal(serialized.subagents.length, 1);
    assert.equal(serialized.subagents[0].name, "Read docs in parallel");
    assert.equal(serialized.subagents[0].agentType, "explorer");
    assert.equal(serialized.subagents[0].source, "claude");
    assert.equal(serialized.subagents[0].status, "working");
    assert.equal(serialized.subagents[0].messageCount, 2);
    assert.equal(serialized.subagents[0].toolUseCount, 1);
    assert.equal(serialized.subagents[0].parentProviderSessionId, claudeSessionId);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Claude monitor tasks keep sessions working until the task stops", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const claudeSessionId = "33333333-4444-4555-8666-777777777777";
    const taskId = "bmonitor1";
    const startedAt = new Date().toISOString();
    const stoppedAt = new Date(Date.now() + 1_000).toISOString();

    const monitorStarted = {
      type: "user",
      timestamp: startedAt,
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          content: `Monitor started (task ${taskId}, timeout 600000ms). You will be notified on each event.`,
        }],
      },
      toolUseResult: { taskId, timeoutMs: 600000, persistent: false },
    };

    await writeClaudeTranscript(userHomeDir, workspaceDir, claudeSessionId, [monitorStarted]);

    const session = manager.buildSessionRecord({
      id: claudeSessionId,
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Claude 1",
      cwd: workspaceDir,
      activityStatus: "done",
      status: "running",
    });

    let serialized = manager.serializeSession(session);
    assert.equal(serialized.backgroundActivity.active, true);
    assert.equal(serialized.backgroundActivity.activeCount, 1);
    assert.equal(serialized.activityStatus, "working");

    await writeClaudeTranscript(userHomeDir, workspaceDir, claudeSessionId, [
      monitorStarted,
      {
        type: "user",
        timestamp: stoppedAt,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            content: `{"message":"Successfully stopped task: ${taskId} (tail -F train.log)","task_id":"${taskId}"}`,
          }],
        },
      },
    ]);

    serialized = manager.serializeSession(session);
    assert.equal(serialized.backgroundActivity.active, false);
    assert.equal(serialized.backgroundActivity.activeCount, 0);
    assert.equal(serialized.backgroundActivity.updatedAt, stoppedAt);
    assert.equal(serialized.activityStatus, "done");
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Claude background Bash shells keep sessions working", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const claudeSessionId = "33333333-4444-4555-8666-888888888888";
    const shellTaskId = "bshell123";
    const startedAt = new Date().toISOString();
    const foregroundCompletedAt = new Date(Date.now() + 1_000).toISOString();

    const backgroundShellStarted = {
      type: "user",
      timestamp: startedAt,
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_background",
          content: `Command running in background with ID: ${shellTaskId}. Output is being written to: /tmp/${shellTaskId}.output`,
          is_error: false,
        }],
      },
      toolUseResult: {
        stdout: "",
        stderr: "",
        interrupted: false,
        backgroundTaskId: shellTaskId,
      },
    };

    await writeClaudeTranscript(userHomeDir, workspaceDir, claudeSessionId, [backgroundShellStarted]);

    const session = manager.buildSessionRecord({
      id: claudeSessionId,
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Claude 1",
      cwd: workspaceDir,
      activityStatus: "done",
      status: "running",
    });

    let serialized = manager.serializeSession(session);
    assert.equal(serialized.backgroundActivity.active, true);
    assert.equal(serialized.backgroundActivity.activeCount, 1);
    assert.equal(serialized.activityStatus, "working");

    await writeClaudeTranscript(userHomeDir, workspaceDir, claudeSessionId, [
      backgroundShellStarted,
      {
        type: "user",
        timestamp: foregroundCompletedAt,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_foreground",
            content: "(Bash completed with no output)",
            is_error: false,
          }],
        },
        toolUseResult: {
          stdout: "",
          stderr: "",
          interrupted: false,
        },
      },
    ]);

    serialized = manager.serializeSession(session);
    assert.equal(serialized.backgroundActivity.active, true);
    assert.equal(serialized.backgroundActivity.activeCount, 1);
    assert.equal(serialized.activityStatus, "working");
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("session swarm graph includes git worktree, fork, subagent, and touched paths", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspaceDir });
    await execFileAsync("git", ["config", "user.name", "Vibe Research Test"], { cwd: workspaceDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspaceDir });
    await writeFile(path.join(workspaceDir, "README.md"), "# Swarm\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: workspaceDir });
    await execFileAsync("git", ["commit", "-m", "Initial"], { cwd: workspaceDir });

    const claudeSessionId = "33333333-4444-4555-8666-777777777777";
    await writeClaudeSubagent(userHomeDir, workspaceDir, claudeSessionId, {
      agentId: "fed456fed456",
      description: "Trace README path",
      agentType: "explorer",
      timestamps: [new Date(Date.now() - 1_000).toISOString(), new Date().toISOString()],
      complete: false,
    });

    const parentSession = manager.buildSessionRecord({
      id: "11111111-2222-4333-8444-555555555555",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Parent swarm",
      cwd: workspaceDir,
      providerState: { sessionId: claudeSessionId },
    });
    const forkSession = manager.buildSessionRecord({
      id: "22222222-3333-4444-8555-666666666666",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Fork swarm",
      cwd: workspaceDir,
      providerState: {
        sessionId: claudeSessionId,
        forkedFromSessionId: parentSession.id,
      },
    });
    manager.sessions.set(parentSession.id, parentSession);
    manager.sessions.set(forkSession.id, forkSession);

    const graph = await manager.getSessionSwarmGraph(parentSession.id);
    assert.equal(graph.git.isRepository, true);
    assert.equal(graph.git.branch, "main");
    assert.ok(graph.nodes.some((node) => node.type === "repo"));
    assert.ok(graph.nodes.some((node) => node.id === `session:${parentSession.id}`));
    assert.ok(graph.nodes.some((node) => node.id === `session:${forkSession.id}`));
    assert.ok(graph.nodes.some((node) => node.type === "subagent" && node.label === "Trace README path"));
    assert.ok(graph.nodes.some((node) => node.id === "path:README.md"));
    assert.ok(
      graph.edges.some(
        (edge) => edge.type === "fork" && edge.from === `session:${parentSession.id}` && edge.to === `session:${forkSession.id}`,
      ),
    );
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("project swarm graph is keyed by repository folder instead of a focus session", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspaceDir });
    await execFileAsync("git", ["config", "user.name", "Vibe Research Test"], { cwd: workspaceDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspaceDir });
    await writeFile(path.join(workspaceDir, "README.md"), "# Swarm\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: workspaceDir });
    await execFileAsync("git", ["commit", "-m", "Initial"], { cwd: workspaceDir });

    const nestedProjectDir = path.join(workspaceDir, "packages", "app");
    await mkdir(nestedProjectDir, { recursive: true });

    const rootSession = manager.buildSessionRecord({
      id: "44444444-5555-4666-8777-888888888888",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Root repo work",
      cwd: workspaceDir,
    });
    const nestedSession = manager.buildSessionRecord({
      id: "55555555-6666-4777-8888-999999999999",
      providerId: "codex",
      providerLabel: "Codex",
      name: "Nested repo work",
      cwd: nestedProjectDir,
    });
    manager.sessions.set(rootSession.id, rootSession);
    manager.sessions.set(nestedSession.id, nestedSession);

    const graph = await manager.getProjectSwarmGraph(nestedProjectDir);
    assert.equal(graph.sessionId, null);
    assert.equal(graph.cwd, nestedProjectDir);
    assert.equal(graph.git.root, await realpath(workspaceDir));
    assert.ok(graph.nodes.some((node) => node.id === `session:${rootSession.id}`));
    assert.ok(graph.nodes.some((node) => node.id === `session:${nestedSession.id}`));
    assert.equal(graph.nodes.some((node) => node.focus), false);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Claude and Codex provider launches use the managed wrapper command when a real binary path is resolved", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-session-manager-"));
  const userHomeDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-session-home-"));
  const manager = new SessionManager({
    cwd: workspaceDir,
    providers: [
      {
        id: "claude",
        label: "Claude Code",
        command: "claude",
        defaultName: "Claude",
        available: true,
        launchCommand: "/opt/homebrew/bin/claude",
      },
      {
        id: "codex",
        label: "Codex",
        command: "codex",
        defaultName: "Codex",
        available: true,
        launchCommand: "/Applications/Codex.app/Contents/Resources/codex",
      },
    ],
    persistSessions: false,
    stateDir: path.join(workspaceDir, ".vibe-research"),
    userHomeDir,
  });

  await manager.initialize();

  try {
    const claudeProvider = manager.getProvider("claude");
    const claudeSession = manager.buildSessionRecord({
      id: "55555555-6666-4777-8888-999999999999",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Claude 1",
      cwd: workspaceDir,
    });
    const codexProvider = manager.getProvider("codex");
    const codexSession = manager.buildSessionRecord({
      id: "66666666-7777-4888-9999-aaaaaaaaaaaa",
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex 1",
      cwd: workspaceDir,
    });

    const claudeLaunch = await manager.prepareProviderLaunch(claudeSession, claudeProvider, { restored: false });
    assert.equal(
      claudeLaunch.commandString,
      `${claudeWrapperCommand} '--dangerously-skip-permissions' '--session-id' '55555555-6666-4777-8888-999999999999'`,
    );

    const codexLaunch = await manager.prepareProviderLaunch(codexSession, codexProvider, { restored: false });
    assert.equal(codexLaunch.commandString, buildCodexExpectedCommand(workspaceDir));
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("forked provider launches resume the source provider session when available", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const claudeLaunch = await manager.prepareProviderLaunch(
      manager.buildSessionRecord({
        providerId: "claude",
        providerLabel: "Claude Code",
        name: "Claude fork",
        cwd: workspaceDir,
        providerState: {
          sessionId: "source-claude-session",
          forkedFromSessionId: "parent-claude",
        },
      }),
      manager.getProvider("claude"),
      { restored: false },
    );
    assert.equal(
      claudeLaunch.commandString,
      `${claudeWrapperCommand} '--dangerously-skip-permissions' '--resume' 'source-claude-session' || ${claudeWrapperCommand} '--dangerously-skip-permissions' '--session-id' 'source-claude-session'`,
    );

    const codexLaunch = await manager.prepareProviderLaunch(
      manager.buildSessionRecord({
        providerId: "codex",
        providerLabel: "Codex",
        name: "Codex fork",
        cwd: workspaceDir,
        providerState: {
          sessionId: "source-codex-thread",
          forkedFromSessionId: "parent-codex",
        },
      }),
      manager.getProvider("codex"),
      { restored: false },
    );
    assert.equal(
      codexLaunch.commandString,
      `${buildCodexExpectedCommand(workspaceDir, ["resume", "source-codex-thread"])} || ${buildCodexExpectedCommand(workspaceDir)}`,
    );

    const geminiLaunch = await manager.prepareProviderLaunch(
      manager.buildSessionRecord({
        providerId: "gemini",
        providerLabel: "Gemini CLI",
        name: "Gemini fork",
        cwd: workspaceDir,
        providerState: {
          sessionId: "source-gemini-chat",
          forkedFromSessionId: "parent-gemini",
        },
      }),
      manager.getProvider("gemini"),
      { restored: false },
    );
    assert.equal(
      geminiLaunch.commandString,
      "'gemini' '--resume' 'source-gemini-chat' || 'gemini' '--resume' 'latest' || 'gemini'",
    );

    const openCodeLaunch = await manager.prepareProviderLaunch(
      manager.buildSessionRecord({
        providerId: "opencode",
        providerLabel: "OpenCode",
        name: "OpenCode fork",
        cwd: workspaceDir,
        providerState: {
          sessionId: "source-opencode-session",
          forkedFromSessionId: "parent-opencode",
        },
      }),
      manager.getProvider("opencode"),
      { restored: false },
    );
    assert.equal(openCodeLaunch.commandString, "'opencode' '--session' 'source-opencode-session'");
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("ML Intern launches as a generic provider without unsupported session capture", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const session = manager.buildSessionRecord({
      providerId: "ml-intern",
      providerLabel: "ML Intern",
      name: "ML Intern 1",
      cwd: workspaceDir,
    });
    const launch = await manager.prepareProviderLaunch(session, manager.getProvider("ml-intern"), { restored: false });

    assert.equal(launch.commandString, "'ml-intern'");
    assert.equal(launch.afterLaunch, null);
    assert.equal(session.pendingProviderCapture, null);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("OpenClaw launches the TUI without unsupported session capture", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const session = manager.buildSessionRecord({
      providerId: "openclaw",
      providerLabel: "OpenClaw",
      name: "OpenClaw 1",
      cwd: workspaceDir,
    });
    const launch = await manager.prepareProviderLaunch(session, manager.getProvider("openclaw"), { restored: false });

    assert.equal(launch.commandString, "'openclaw' 'tui'");
    assert.equal(launch.afterLaunch, null);
    assert.equal(session.pendingProviderCapture, null);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("OpenClaw launch uses a sibling node runtime when available", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-openclaw-runtime-"));
  const fakeOpenClawPath = path.join(runtimeDir, "openclaw");
  const fakeNodePath = path.join(runtimeDir, "node");
  const providers = fakeAgentProviders.map((provider) => (
    provider.id === "openclaw"
      ? { ...provider, launchCommand: fakeOpenClawPath }
      : provider
  ));
  const { manager, workspaceDir, userHomeDir } = await createManager({ providers });

  try {
    await createExecutableScript(fakeOpenClawPath, "#!/usr/bin/env bash\nexit 0\n");
    await createExecutableScript(fakeNodePath, "#!/usr/bin/env bash\nexit 0\n");

    const session = manager.buildSessionRecord({
      providerId: "openclaw",
      providerLabel: "OpenClaw",
      name: "OpenClaw runtime test",
      cwd: workspaceDir,
    });
    const launch = await manager.prepareProviderLaunch(session, manager.getProvider("openclaw"), { restored: false });

    assert.equal(launch.commandString, `${shellQuote(fakeNodePath)} ${shellQuote(fakeOpenClawPath)} 'tui'`);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("ML Intern is eligible for persistent tmux terminals", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-ml-intern-tmux-workspace-"));
  const userHomeDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-ml-intern-tmux-home-"));
  const fakeTmuxPath = path.join(userHomeDir, "fake-tmux");
  const manager = new SessionManager({
    cwd: workspaceDir,
    env: {
      ...process.env,
      VIBE_RESEARCH_TMUX_COMMAND: fakeTmuxPath,
    },
    persistentTerminals: true,
    persistSessions: false,
    providers: fakeAgentProviders,
    stateDir: path.join(workspaceDir, ".vibe-research"),
    userHomeDir,
  });

  await createExecutableScript(
    fakeTmuxPath,
    `#!/bin/sh
case "$1" in
  -V)
    printf 'tmux 3.4\\n'
    exit 0
    ;;
esac
exit 0
`,
  );
  await manager.initialize();

  try {
    const session = manager.buildSessionRecord({
      providerId: "ml-intern",
      providerLabel: "ML Intern",
      name: "ML Intern 1",
      cwd: workspaceDir,
    });
    const provider = manager.getProvider("ml-intern");

    assert.equal(manager.shouldUsePersistentTerminal(provider, manager.buildSessionEnvironment(session)), true);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("older tmux without new-session environment args falls back to a plain terminal", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-old-tmux-workspace-"));
  const userHomeDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-old-tmux-home-"));
  const fakeTmuxPath = path.join(userHomeDir, "fake-tmux");
  const manager = new SessionManager({
    cwd: workspaceDir,
    env: {
      ...process.env,
      VIBE_RESEARCH_TMUX_COMMAND: fakeTmuxPath,
    },
    persistentTerminals: true,
    persistSessions: false,
    providers: fakeAgentProviders,
    stateDir: path.join(workspaceDir, ".vibe-research"),
    userHomeDir,
  });

  await createExecutableScript(
    fakeTmuxPath,
    `#!/bin/sh
case "$1" in
  -V)
    printf 'tmux 2.7\\n'
    exit 0
    ;;
esac
exit 0
`,
  );
  await manager.initialize();

  try {
    const session = manager.buildSessionRecord({
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Claude 1",
      cwd: workspaceDir,
    });
    const provider = manager.getProvider("claude");
    const env = manager.buildSessionEnvironment(session, provider.id);

    assert.equal(manager.isTmuxAvailable(env), true);
    assert.equal(manager.tmuxSupportsEnvironmentArgs(env), false);
    assert.equal(manager.shouldUsePersistentTerminal(provider, env), false);

    const terminalLaunch = manager.getTerminalLaunch(session, provider, env, workspaceDir);
    assert.equal(terminalLaunch.backend, null);
    assert.equal(terminalLaunch.command, session.shell);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("forkSession carries the source provider session id into the fork", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const sourceSession = manager.buildSessionRecord({
      id: "11111111-2222-4333-8444-555555555555",
      providerId: "codex",
      providerLabel: "Codex",
      name: "Parent Codex",
      cwd: workspaceDir,
      status: "running",
      providerState: {
        sessionId: "source-codex-thread",
      },
    });
    manager.sessions.set(sourceSession.id, sourceSession);

    const fork = manager.forkSession(sourceSession.id);
    assert.ok(fork);
    const forkRecord = manager.sessions.get(fork.id);
    assert.equal(forkRecord.providerState.sessionId, "source-codex-thread");
    assert.equal(forkRecord.providerState.forkedFromSessionId, sourceSession.id);
    assert.match(forkRecord.buffer, /resuming the source agent memory/i);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Codex sessions capture the created Codex thread id and resume it after restart", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const provider = manager.getProvider("codex");
    const session = manager.buildSessionRecord({
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex 1",
      cwd: workspaceDir,
    });
    const fakePty = {};
    session.status = "running";
    session.pty = fakePty;

    const oldUpdatedAt = "2026-04-15T20:00:00.000Z";
    await appendCodexSessionIndex(userHomeDir, [
      {
        id: "old-codex-session",
        updatedAt: oldUpdatedAt,
      },
    ]);

    const firstLaunch = await manager.prepareProviderLaunch(session, provider, { restored: false });
    assert.equal(firstLaunch.commandString, buildCodexExpectedCommand(workspaceDir));

    const newSessionId = "019d92d2-75bb-74f2-bb76-ff8c56cf5626";
    const newUpdatedAt = "2026-04-15T21:00:00.000Z";
    await appendCodexSessionIndex(userHomeDir, [
      {
        id: "old-codex-session",
        updatedAt: oldUpdatedAt,
      },
      {
        id: newSessionId,
        updatedAt: newUpdatedAt,
      },
    ]);
    await writeCodexSessionMeta(userHomeDir, {
      sessionId: newSessionId,
      cwd: workspaceDir,
      timestamp: newUpdatedAt,
    });

    await firstLaunch.afterLaunch(fakePty, Date.parse("2026-04-15T20:59:59.000Z"));
    assert.equal(session.providerState?.sessionId, newSessionId);

    const restoredLaunch = await manager.prepareProviderLaunch(session, provider, { restored: true });
    assert.equal(
      restoredLaunch.commandString,
      `${buildCodexExpectedCommand(workspaceDir, ["resume", "019d92d2-75bb-74f2-bb76-ff8c56cf5626"])} || ${buildCodexExpectedCommand(workspaceDir, ["resume", "--last"])} || ${buildCodexExpectedCommand(workspaceDir)}`,
    );
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Codex sessions capture the created Codex thread id from prompt history and archived session metadata", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const provider = manager.getProvider("codex");
    const session = manager.buildSessionRecord({
      id: "acacacac-bdbd-4eee-8f8f-c0c0c0c0c0c0",
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex History",
      cwd: workspaceDir,
    });
    const fakePty = {};
    session.status = "running";
    session.pty = fakePty;

    const firstLaunch = await manager.prepareProviderLaunch(session, provider, { restored: false });
    assert.equal(firstLaunch.commandString, buildCodexExpectedCommand(workspaceDir));

    const codexSessionId = "019d9376-d3dd-73f0-9a04-29dee0a2662f";
    const updatedAt = "2026-04-15T23:25:48.000Z";
    await appendCodexPromptHistory(userHomeDir, [
      {
        sessionId: codexSessionId,
        timestamp: Math.floor(Date.parse(updatedAt) / 1000),
        text: "remember this secret",
      },
    ]);
    await writeArchivedCodexSessionMeta(userHomeDir, {
      sessionId: codexSessionId,
      cwd: workspaceDir,
      timestamp: updatedAt,
    });

    await firstLaunch.afterLaunch(fakePty, Date.parse("2026-04-15T23:25:40.000Z"));
    assert.equal(session.providerState?.sessionId, codexSessionId);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Codex sessions can capture a single fresh thread id from prompt history before transcript metadata lands", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const provider = manager.getProvider("codex");
    const session = manager.buildSessionRecord({
      id: "adadadad-bebe-4f0f-8a8a-d1d1d1d1d1d1",
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex History Only",
      cwd: workspaceDir,
    });
    const fakePty = {};
    session.status = "running";
    session.pty = fakePty;

    const firstLaunch = await manager.prepareProviderLaunch(session, provider, { restored: false });
    const codexSessionId = "019d93c1-9120-7253-ae38-bc333b4f0596";
    const updatedAt = "2026-04-16T00:33:55.000Z";
    await appendCodexPromptHistory(userHomeDir, [
      {
        sessionId: codexSessionId,
        timestamp: Math.floor(Date.parse(updatedAt) / 1000),
        text: "remember this secret",
      },
    ]);

    await firstLaunch.afterLaunch(fakePty, Date.parse("2026-04-16T00:33:50.000Z"));
    assert.equal(session.providerState?.sessionId, codexSessionId);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Codex session capture retries after the first submitted prompt when startup was too early", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const provider = manager.getProvider("codex");
    const session = manager.buildSessionRecord({
      id: "abababab-bcbc-4ddd-8eee-fafafafafafa",
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex Retry",
      cwd: workspaceDir,
    });
    const fakePty = {
      kill() {},
      write() {},
    };
    session.status = "running";
    session.pty = fakePty;
    manager.sessions.set(session.id, session);

    await appendCodexSessionIndex(userHomeDir, [
      {
        id: "old-codex-session",
        updatedAt: "2026-04-15T20:00:00.000Z",
      },
    ]);

    const firstLaunch = await manager.prepareProviderLaunch(session, provider, { restored: false });
    await firstLaunch.afterLaunch(fakePty, Date.parse("2026-04-15T20:59:59.000Z"));
    assert.equal(session.providerState?.sessionId, undefined);
    assert.equal(session.pendingProviderCapture?.providerId, "codex");

    const delayedSessionId = "019d92d2-75bb-74f2-bb76-121212121212";
    const delayedUpdatedAt = "2026-04-15T21:00:05.000Z";
    await appendCodexSessionIndex(userHomeDir, [
      {
        id: "old-codex-session",
        updatedAt: "2026-04-15T20:00:00.000Z",
      },
      {
        id: delayedSessionId,
        updatedAt: delayedUpdatedAt,
      },
    ]);
    await writeCodexSessionMeta(userHomeDir, {
      sessionId: delayedSessionId,
      cwd: workspaceDir,
      timestamp: delayedUpdatedAt,
    });

    session.buffer = "OpenAI Codex\nmodel: gpt-5.4 xhigh\ndirectory: ~/repo\ntab to queue message\n100% context left\n› ";
    manager.write(session.id, "hello\r");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (session.providerState?.sessionId === delayedSessionId) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(session.providerState?.sessionId, delayedSessionId);
    assert.equal(session.pendingProviderCapture, null);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Codex session capture keeps retrying after launch until a delayed session id appears", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const provider = manager.getProvider("codex");
    const session = manager.buildSessionRecord({
      id: "cdcdcdcd-efef-4010-8a8a-121212121212",
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex Delayed",
      cwd: workspaceDir,
    });
    const fakePty = {
      kill() {},
      write() {},
    };
    session.status = "running";
    session.pty = fakePty;
    manager.sessions.set(session.id, session);
    const launchedAt = Date.now();
    const delayedUpdatedAt = new Date(launchedAt + 10_000).toISOString();

    await appendCodexSessionIndex(userHomeDir, [
      {
        id: "old-codex-session",
        updatedAt: "2026-04-15T20:00:00.000Z",
      },
    ]);

    const firstLaunch = await manager.prepareProviderLaunch(session, provider, { restored: false });
    await firstLaunch.afterLaunch(fakePty, launchedAt);
    assert.equal(session.providerState?.sessionId, undefined);
    assert.equal(session.pendingProviderCapture?.providerId, "codex");

    const delayedSessionId = "019d92d2-75bb-74f2-bb76-343434343434";
    setTimeout(async () => {
      await appendCodexSessionIndex(userHomeDir, [
        {
          id: "old-codex-session",
          updatedAt: "2026-04-15T20:00:00.000Z",
        },
        {
          id: delayedSessionId,
          updatedAt: delayedUpdatedAt,
        },
      ]);
      await writeCodexSessionMeta(userHomeDir, {
        sessionId: delayedSessionId,
        cwd: workspaceDir,
        timestamp: delayedUpdatedAt,
      });
    }, 5_200);

    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (session.providerState?.sessionId === delayedSessionId) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(session.providerState?.sessionId, delayedSessionId);
    assert.equal(session.pendingProviderCapture, null);
    assert.equal(session.providerCaptureRetryTimer, null);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Gemini sessions capture the project session id and resume it after restart", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const provider = manager.getProvider("gemini");
    const session = manager.buildSessionRecord({
      id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      providerId: "gemini",
      providerLabel: "Gemini CLI",
      name: "Gemini 1",
      cwd: workspaceDir,
    });
    const fakePty = {};
    session.status = "running";
    session.pty = fakePty;

    const firstLaunch = await manager.prepareProviderLaunch(session, provider, { restored: false });
    assert.equal(firstLaunch.commandString, "'gemini'");

    const geminiSessionId = "11111111-2222-4333-8444-555555555555";
    await writeGeminiSessions(userHomeDir, workspaceDir, "vibe-research", [
      {
        id: geminiSessionId,
        fileName: "session-2026-04-15T21-05-00-11111111.json",
        startTime: "2026-04-15T21:05:00.000Z",
        lastUpdated: "2026-04-15T21:05:30.000Z",
      },
    ]);

    await firstLaunch.afterLaunch(fakePty, Date.parse("2026-04-15T21:05:00.000Z"));
    assert.equal(session.providerState?.sessionId, geminiSessionId);

    const restoredLaunch = await manager.prepareProviderLaunch(session, provider, { restored: true });
    assert.equal(
      restoredLaunch.commandString,
      "'gemini' '--resume' '11111111-2222-4333-8444-555555555555' || 'gemini' '--resume' 'latest' || 'gemini'",
    );
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Codex session capture matches canonical workspace paths", async () => {
  const realWorkspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-session-real-"));
  const linkRootDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-session-link-"));
  const linkedWorkspaceDir = path.join(linkRootDir, "workspace");
  await symlink(realWorkspaceDir, linkedWorkspaceDir);

  const { manager, userHomeDir } = await createManager({ cwd: linkedWorkspaceDir });

  try {
    const provider = manager.getProvider("codex");
    const session = manager.buildSessionRecord({
      id: "dddddddd-eeee-4fff-8000-111111111111",
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex Symlink",
      cwd: linkedWorkspaceDir,
    });
    const fakePty = {};
    session.status = "running";
    session.pty = fakePty;

    const firstLaunch = await manager.prepareProviderLaunch(session, provider, { restored: false });
    const codexSessionId = "019d92d2-75bb-74f2-bb76-ffffffffffff";
    const updatedAt = "2026-04-15T22:00:00.000Z";

    await appendCodexSessionIndex(userHomeDir, [
      {
        id: codexSessionId,
        updatedAt,
      },
    ]);
    await writeCodexSessionMeta(userHomeDir, {
      sessionId: codexSessionId,
      cwd: realWorkspaceDir,
      timestamp: updatedAt,
    });

    await firstLaunch.afterLaunch(fakePty, Date.parse("2026-04-15T21:59:59.000Z"));
    assert.equal(session.providerState?.sessionId, codexSessionId);
  } finally {
    await cleanupManager(manager, linkedWorkspaceDir, userHomeDir);
    await rm(realWorkspaceDir, { recursive: true, force: true });
    await rm(linkRootDir, { recursive: true, force: true });
  }
});

test("Gemini session capture matches canonical workspace paths", async () => {
  const realWorkspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-session-real-"));
  const linkRootDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-session-link-"));
  const linkedWorkspaceDir = path.join(linkRootDir, "workspace");
  await symlink(realWorkspaceDir, linkedWorkspaceDir);

  const { manager, userHomeDir } = await createManager({ cwd: linkedWorkspaceDir });

  try {
    const provider = manager.getProvider("gemini");
    const session = manager.buildSessionRecord({
      id: "eeeeeeee-ffff-4000-8111-222222222222",
      providerId: "gemini",
      providerLabel: "Gemini CLI",
      name: "Gemini Symlink",
      cwd: linkedWorkspaceDir,
    });
    const fakePty = {};
    session.status = "running";
    session.pty = fakePty;

    const firstLaunch = await manager.prepareProviderLaunch(session, provider, { restored: false });
    const geminiSessionId = "22222222-3333-4444-8555-666666666666";

    await writeGeminiSessions(userHomeDir, realWorkspaceDir, "vibe-research-symlink", [
      {
        id: geminiSessionId,
        fileName: "session-2026-04-15T22-05-00-22222222.json",
        startTime: "2026-04-15T22:05:00.000Z",
        lastUpdated: "2026-04-15T22:05:30.000Z",
      },
    ]);

    await firstLaunch.afterLaunch(fakePty, Date.parse("2026-04-15T22:05:00.000Z"));
    assert.equal(session.providerState?.sessionId, geminiSessionId);
  } finally {
    await cleanupManager(manager, linkedWorkspaceDir, userHomeDir);
    await rm(realWorkspaceDir, { recursive: true, force: true });
    await rm(linkRootDir, { recursive: true, force: true });
  }
});

test("OpenCode session capture matches canonical workspace paths", async () => {
  const realWorkspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-session-real-"));
  const linkRootDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-session-link-"));
  const linkedWorkspaceDir = path.join(linkRootDir, "workspace");
  await symlink(realWorkspaceDir, linkedWorkspaceDir);

  const { manager, userHomeDir } = await createManager({ cwd: linkedWorkspaceDir });

  try {
    const fakeOpenCodePath = path.join(userHomeDir, "fake-opencode");
    const fakeOpenCodeStatePath = path.join(userHomeDir, "fake-opencode-state");
    await createExecutableScript(
      fakeOpenCodePath,
      `#!/bin/sh
if [ ! -f "${fakeOpenCodeStatePath}" ]; then
  : > "${fakeOpenCodeStatePath}"
  printf '%s\n' '[]'
  exit 0
fi

printf '%s\n' '[{"id":"opencode-session-789","directory":"${realWorkspaceDir}","updated":1776290730000}]'
`,
    );

    const provider = {
      ...manager.getProvider("opencode"),
      launchCommand: fakeOpenCodePath,
    };
    const session = manager.buildSessionRecord({
      id: "ffffffff-0000-4111-8222-333333333333",
      providerId: "opencode",
      providerLabel: "OpenCode",
      name: "OpenCode Symlink",
      cwd: linkedWorkspaceDir,
    });
    const fakePty = {};
    session.status = "running";
    session.pty = fakePty;

    const firstLaunch = await manager.prepareProviderLaunch(session, provider, { restored: false });
    await firstLaunch.afterLaunch(fakePty, Date.parse("2026-04-15T22:05:00.000Z"));

    assert.equal(session.providerState?.sessionId, "opencode-session-789");
  } finally {
    await cleanupManager(manager, linkedWorkspaceDir, userHomeDir);
    await rm(realWorkspaceDir, { recursive: true, force: true });
    await rm(linkRootDir, { recursive: true, force: true });
  }
});

test("OpenCode sessions resume the persisted OpenCode session id after restart", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const fakeOpenCodePath = path.join(userHomeDir, "fake-opencode-resume");
    await createExecutableScript(
      fakeOpenCodePath,
      `#!/bin/sh
printf '%s\n' '[]'
`,
    );

    const provider = {
      ...manager.getProvider("opencode"),
      launchCommand: fakeOpenCodePath,
    };
    const session = manager.buildSessionRecord({
      id: "cccccccc-dddd-4eee-8fff-000000000000",
      providerId: "opencode",
      providerLabel: "OpenCode",
      name: "OpenCode 1",
      cwd: workspaceDir,
      providerState: {
        sessionId: "opencode-session-123",
      },
    });

    const restoredLaunch = await manager.prepareProviderLaunch(session, provider, { restored: true });
    assert.equal(
      restoredLaunch.commandString,
      `'${fakeOpenCodePath}' '--session' 'opencode-session-123'`,
    );
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Codex native narrative falls back to owned session events before transcript files exist", async () => {
  const harness = await createManager({ initialPromptSubmitDelayMs: 5 });
  const { manager, workspaceDir } = harness;

  try {
    const session = manager.buildSessionRecord({
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex Native",
      cwd: workspaceDir,
      status: "running",
      buffer: "OpenAI Codex\nmodel: gpt-5.4 xhigh\ndirectory: ~/repo\ntab to queue message\n100% context left\n› ",
    });
    session.pty = {
      write() {},
      kill() {},
    };
    manager.sessions.set(session.id, session);

    manager.pushNativeNarrativeEntry(session, {
      kind: "status",
      label: "Starting",
      text: `Starting Codex in ${workspaceDir}.`,
      timestamp: "2026-04-24T04:10:00.000Z",
    });

    manager.write(session.id, "hello from native mode\r");

    const narrative = await manager.getSessionNarrative(session.id);

    assert.equal(narrative.providerBacked, false);
    assert.equal(narrative.sourceLabel, "Vibe Research native session events");
    assert.deepEqual(
      narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label, text: entry.text })),
      [
        { kind: "status", label: "Starting", text: `Starting Codex in ${workspaceDir}.` },
        { kind: "user", label: "You", text: "hello from native mode" },
      ],
    );
  } finally {
    await cleanupManager(manager, workspaceDir, harness.userHomeDir);
  }
});

test("Codex queues the first prompt until the provider is ready", async () => {
  const harness = await createManager({ initialPromptSubmitDelayMs: 5 });
  const { manager, workspaceDir } = harness;

  try {
    const writes = [];
    const session = manager.buildSessionRecord({
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex Booting",
      cwd: workspaceDir,
      status: "running",
      createdAt: "2026-04-24T04:18:00.000Z",
      updatedAt: "2026-04-24T04:18:01.000Z",
      buffer: "Starting MCP servers (0/2): codex_apps, computer-use",
    });
    session.pty = {
      write(chunk) {
        writes.push(chunk);
      },
      kill() {},
    };
    manager.sessions.set(session.id, session);

    assert.equal(manager.write(session.id, "say hello in one sentence\r"), true);
    assert.deepEqual(writes, []);
    assert.equal(session.pendingProviderInputs.length, 1);
    assert.equal(session.lastPromptAt, null);

    session.buffer = `${session.buffer}\n\nOpenAI Codex\nmodel: gpt-5.4 xhigh\ndirectory: ~/repo\ntab to queue message\n100% context left\n› `;
    assert.equal(manager.flushDeferredProviderInputsIfReady(session), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(writes, ["say hello in one sentence", "\r"]);
    assert.equal(session.pendingProviderInputs.length, 0);
    assert.ok(session.lastPromptAt);

    const narrative = await manager.getSessionNarrative(session.id);
    assert.deepEqual(
      narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label, text: entry.text })),
      [
        { kind: "user", label: "You", text: "say hello in one sentence" },
        { kind: "status", label: "Waiting", text: "Holding your message until Codex finishes booting." },
      ],
    );
  } finally {
    await cleanupManager(manager, workspaceDir, harness.userHomeDir);
  }
});

test("Codex runtime writes the prompt body before sending Enter", async () => {
  const harness = await createManager({ initialPromptSubmitDelayMs: 5 });
  const { manager, workspaceDir } = harness;

  try {
    const writes = [];
    const session = manager.buildSessionRecord({
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex Submit",
      cwd: workspaceDir,
      status: "running",
      buffer: "OpenAI Codex\nmodel: gpt-5.4 xhigh\ndirectory: ~/repo\ntab to queue message\n100% context left\n› ",
    });
    session.pty = {
      write(chunk) {
        writes.push(chunk);
      },
      kill() {},
    };
    manager.sessions.set(session.id, session);

    assert.equal(manager.write(session.id, "hello from codex\r"), true);
    assert.deepEqual(writes, ["hello from codex"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(writes, ["hello from codex", "\r"]);
  } finally {
    await cleanupManager(manager, workspaceDir, harness.userHomeDir);
  }
});

test("Codex native narrative overlays live CLI output while waiting for provider transcript files", async () => {
  const harness = await createManager();
  const { manager, workspaceDir } = harness;

  try {
    const session = manager.buildSessionRecord({
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex Streaming",
      cwd: workspaceDir,
      status: "running",
      createdAt: "2026-04-24T04:12:00.000Z",
      updatedAt: "2026-04-24T04:12:09.000Z",
      lastPromptAt: "2026-04-24T04:12:05.000Z",
      lastOutputAt: "2026-04-24T04:12:09.000Z",
      buffer: "hello codex\n\nworking on it now\n\nI am responding from the live terminal stream.",
    });
    session.pty = {
      write() {},
      kill() {},
    };
    manager.sessions.set(session.id, session);

    manager.pushNativeNarrativeEntry(session, {
      kind: "user",
      label: "You",
      text: "hello codex",
      timestamp: "2026-04-24T04:12:05.000Z",
    });

    const narrative = await manager.getSessionNarrative(session.id);

    assert.equal(narrative.providerBacked, false);
    assert.equal(narrative.sourceLabel, "Vibe Research native events + live CLI overlay");
    assert.deepEqual(
      narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label, text: entry.text })),
      [
        { kind: "user", label: "You", text: "hello codex" },
        { kind: "status", label: "Activity", text: "working on it now" },
        { kind: "assistant", label: "Codex", text: "I am responding from the live terminal stream." },
      ],
    );
  } finally {
    await cleanupManager(manager, workspaceDir, harness.userHomeDir);
  }
});

test("Claude native narrative overlays live CLI output while the provider transcript is stale", async () => {
  const harness = await createManager();
  const { manager, workspaceDir, userHomeDir } = harness;

  try {
    const sessionId = "claude-streaming-session";
    await writeClaudeTranscript(userHomeDir, workspaceDir, sessionId, [
      {
        type: "user",
        timestamp: "2026-04-24T04:15:05.000Z",
        message: {
          role: "user",
          content: "hello claude",
        },
      },
      {
        type: "assistant",
        timestamp: "2026-04-24T04:15:06.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Let me check that." }],
        },
      },
    ]);

    const session = manager.buildSessionRecord({
      id: sessionId,
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Claude Streaming",
      cwd: workspaceDir,
      status: "running",
      createdAt: "2026-04-24T04:15:00.000Z",
      updatedAt: "2026-04-24T04:15:12.000Z",
      lastPromptAt: "2026-04-24T04:15:05.000Z",
      lastOutputAt: "2026-04-24T04:15:12.000Z",
      buffer: "Bash(echo checking)\n\nI am still streaming the response.",
    });
    session.pty = {
      write() {},
      kill() {},
    };
    manager.sessions.set(session.id, session);

    const narrative = await manager.getSessionNarrative(session.id);

    assert.equal(narrative.providerBacked, true);
    assert.equal(narrative.sourceLabel, "Claude project transcript + live CLI overlay");
    assert.deepEqual(
      narrative.entries.map((entry) => ({ kind: entry.kind, label: entry.label, text: entry.text })),
      [
        { kind: "user", label: "You", text: "hello claude" },
        { kind: "assistant", label: "Claude Code", text: "Let me check that." },
        { kind: "tool", label: "Bash", text: "Bash(echo checking)" },
        { kind: "assistant", label: "Claude Code", text: "I am still streaming the response." },
      ],
    );
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Claude live overlay drops collapsed assistant fragments with no spaces", async () => {
  const harness = await createManager();
  const { manager, workspaceDir, userHomeDir } = harness;

  try {
    const sessionId = "claude-collapsed-overlay";
    await writeClaudeTranscript(userHomeDir, workspaceDir, sessionId, [
      {
        type: "assistant",
        timestamp: "2026-04-24T04:15:06.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Let me peek at the town real quick to see where we are." }],
        },
      },
    ]);

    const session = manager.buildSessionRecord({
      id: sessionId,
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Claude Overlay Filter",
      cwd: workspaceDir,
      status: "running",
      createdAt: "2026-04-24T04:15:00.000Z",
      updatedAt: "2026-04-24T04:15:12.000Z",
      lastPromptAt: "2026-04-24T04:15:10.000Z",
      lastOutputAt: "2026-04-24T04:15:12.000Z",
      buffer: "Letmepeekatthetownrealquicktoseewhereweare.",
      providerState: {
        sessionId,
      },
    });
    session.pty = {
      write() {},
      kill() {},
    };
    manager.sessions.set(session.id, session);

    const narrative = await manager.getSessionNarrative(session.id);
    assert.equal(narrative.providerBacked, true);
    assert.deepEqual(
      narrative.entries.map((entry) => entry.text),
      ["Let me peek at the town real quick to see where we are."],
    );
  } finally {
    await cleanupManager(manager, workspaceDir, harness.userHomeDir);
  }
});

test("Claude live overlay drops raw key-value tool stdout fragments", async () => {
  const harness = await createManager();
  const { manager, workspaceDir, userHomeDir } = harness;

  try {
    const sessionId = "claude-key-value-overlay";
    await writeClaudeTranscript(userHomeDir, workspaceDir, sessionId, [
      {
        type: "assistant",
        timestamp: "2026-04-24T04:15:06.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Let me check the town state." }],
        },
      },
    ]);

    const session = manager.buildSessionRecord({
      id: sessionId,
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Claude Overlay KVs",
      cwd: workspaceDir,
      status: "running",
      createdAt: "2026-04-24T04:15:00.000Z",
      updatedAt: "2026-04-24T04:15:12.000Z",
      lastPromptAt: "2026-04-24T04:15:10.000Z",
      lastOutputAt: "2026-04-24T04:15:12.000Z",
      buffer: "phase:None",
      providerState: {
        sessionId,
      },
    });
    session.pty = {
      write() {},
      kill() {},
    };
    manager.sessions.set(session.id, session);

    const narrative = await manager.getSessionNarrative(session.id);
    assert.equal(narrative.providerBacked, true);
    assert.deepEqual(
      narrative.entries.map((entry) => entry.text),
      ["Let me check the town state."],
    );
  } finally {
    await cleanupManager(manager, workspaceDir, harness.userHomeDir);
  }
});

test("Claude live overlay drops terminal glyph fragments from the header chrome", async () => {
  const harness = await createManager();
  const { manager, workspaceDir, userHomeDir } = harness;

  try {
    const sessionId = "claude-glyph-overlay";
    await writeClaudeTranscript(userHomeDir, workspaceDir, sessionId, [
      {
        type: "assistant",
        timestamp: "2026-04-24T04:15:06.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello!" }],
        },
      },
    ]);

    const session = manager.buildSessionRecord({
      id: sessionId,
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Claude Overlay Glyphs",
      cwd: workspaceDir,
      status: "running",
      createdAt: "2026-04-24T04:15:00.000Z",
      updatedAt: "2026-04-24T04:15:12.000Z",
      lastPromptAt: "2026-04-24T04:15:10.000Z",
      lastOutputAt: "2026-04-24T04:15:12.000Z",
      buffer: "▝▜█████▛▘Opus4.7(1Mcontext)withhigheffort·ClaudeMax\n▘▘▝▝~/vibe-projects/vibe-research/user",
      providerState: {
        sessionId,
      },
    });
    session.pty = {
      write() {},
      kill() {},
    };
    manager.sessions.set(session.id, session);

    const narrative = await manager.getSessionNarrative(session.id);
    assert.equal(narrative.providerBacked, true);
    assert.deepEqual(
      narrative.entries.map((entry) => entry.text),
      ["Hello!"],
    );
  } finally {
    await cleanupManager(manager, workspaceDir, harness.userHomeDir);
  }
});

function createFakeSocket() {
  const messages = [];
  let onClose = null;
  return {
    readyState: 1,
    OPEN: 1,
    send(payload) {
      messages.push(JSON.parse(payload));
    },
    on(event, handler) {
      if (event === "close") {
        onClose = handler;
      }
    },
    close() {
      this.readyState = 3;
      if (onClose) onClose();
    },
    messages,
  };
}

async function flushSetImmediate() {
  // Drain a few microtask + macrotask ticks so all queued setImmediate
  // callbacks in sendSnapshot have a chance to run.
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("attachClient streams the session buffer in chunked snapshot frames", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const buffer = "x".repeat(80_000);
    const session = manager.buildSessionRecord({
      id: "11111111-2222-4333-8444-snapshotchunk",
      providerId: "shell",
      providerLabel: "Vanilla Shell",
      name: "Snapshot Chunked",
      cwd: workspaceDir,
      status: "running",
      buffer,
    });
    manager.sessions.set(session.id, session);

    const socket = createFakeSocket();
    const result = manager.attachClient(session.id, socket);
    assert.ok(result, "attachClient returned the session");

    await flushSetImmediate();

    const types = socket.messages.map((m) => m.type);
    assert.equal(types[0], "snapshot-start");
    assert.equal(types[types.length - 1], "snapshot-end");
    assert.ok(types.length > 2, "expected at least one chunk between start and end");

    const start = socket.messages[0];
    assert.equal(start.totalBytes, 80_000);
    assert.equal(start.replayBytes, 80_000);
    assert.equal(start.truncated, false);
    assert.equal(start.session.id, session.id);

    const chunks = socket.messages.filter((m) => m.type === "snapshot-chunk");
    assert.equal(chunks.length, start.chunkCount);
    const reassembled = chunks.map((c) => c.data).join("");
    assert.equal(reassembled, buffer);
    chunks.forEach((chunk, idx) => {
      assert.equal(chunk.index, idx);
    });

    const end = socket.messages[socket.messages.length - 1];
    assert.equal(end.chunkCount, start.chunkCount);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("attachClient truncates oversized buffers to the snapshot replay limit", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    // Build a buffer larger than SNAPSHOT_REPLAY_LIMIT (256_000) so we can
    // verify that the tail is replayed and the head is dropped.
    const head = "H".repeat(50_000);
    const tail = "T".repeat(256_000);
    const buffer = head + tail;
    const session = manager.buildSessionRecord({
      id: "11111111-2222-4333-8444-snapshottrunc",
      providerId: "shell",
      providerLabel: "Vanilla Shell",
      name: "Snapshot Truncated",
      cwd: workspaceDir,
      status: "running",
      buffer,
    });
    manager.sessions.set(session.id, session);

    const socket = createFakeSocket();
    manager.attachClient(session.id, socket);
    await flushSetImmediate();

    const start = socket.messages[0];
    assert.equal(start.type, "snapshot-start");
    assert.equal(start.truncated, true, "snapshot should be marked truncated");
    assert.equal(start.replayBytes, 256_000);

    const chunks = socket.messages.filter((m) => m.type === "snapshot-chunk");
    const reassembled = chunks.map((c) => c.data).join("");
    assert.equal(reassembled.length, 256_000);
    assert.equal(reassembled, tail, "replay should contain only the tail of the buffer");
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("attachClient sends snapshot-start and snapshot-end with no chunks for an empty buffer", async () => {
  const { manager, workspaceDir, userHomeDir } = await createManager();

  try {
    const session = manager.buildSessionRecord({
      id: "11111111-2222-4333-8444-snapshotempty",
      providerId: "shell",
      providerLabel: "Vanilla Shell",
      name: "Snapshot Empty",
      cwd: workspaceDir,
      status: "running",
      buffer: "",
    });
    manager.sessions.set(session.id, session);

    const socket = createFakeSocket();
    manager.attachClient(session.id, socket);
    await flushSetImmediate();

    const types = socket.messages.map((m) => m.type);
    assert.deepEqual(types, ["snapshot-start", "snapshot-end"]);
    assert.equal(socket.messages[0].chunkCount, 0);
    assert.equal(socket.messages[0].totalBytes, 0);
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});
