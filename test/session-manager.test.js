import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { SessionManager } from "../src/session-manager.js";

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
    id: "codex",
    label: "Codex",
    command: "codex",
    defaultName: "Codex",
    available: true,
    launchCommand: "codex",
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
    id: "shell",
    label: "Vanilla Shell",
    command: null,
    defaultName: "Shell",
    available: true,
    launchCommand: null,
  },
];

async function createManager({ cwd } = {}) {
  const workspaceDir = cwd || await mkdtemp(path.join(os.tmpdir(), "remote-vibes-session-manager-"));
  const userHomeDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-session-home-"));
  const manager = new SessionManager({
    cwd: workspaceDir,
    providers: fakeAgentProviders,
    persistSessions: false,
    stateDir: path.join(workspaceDir, ".remote-vibes"),
    userHomeDir,
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
      "'claude' '--session-id' '11111111-2222-4333-8444-555555555555'",
    );

    const restoredLaunch = await manager.prepareProviderLaunch(session, provider, { restored: true });
    assert.equal(
      restoredLaunch.commandString,
      "'claude' '--resume' '11111111-2222-4333-8444-555555555555' || 'claude' '--session-id' '11111111-2222-4333-8444-555555555555'",
    );
  } finally {
    await cleanupManager(manager, workspaceDir, userHomeDir);
  }
});

test("Claude and Codex provider launches use the managed wrapper command when a real binary path is resolved", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-session-manager-"));
  const userHomeDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-session-home-"));
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
    stateDir: path.join(workspaceDir, ".remote-vibes"),
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
      "'claude' '--session-id' '55555555-6666-4777-8888-999999999999'",
    );

    const codexLaunch = await manager.prepareProviderLaunch(codexSession, codexProvider, { restored: false });
    assert.equal(codexLaunch.commandString, "'codex'");
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
    assert.equal(firstLaunch.commandString, "'codex'");

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
      "'codex' 'resume' '019d92d2-75bb-74f2-bb76-ff8c56cf5626' || 'codex' 'resume' '--last' || 'codex'",
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
    assert.equal(firstLaunch.commandString, "'codex'");

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
    await writeGeminiSessions(userHomeDir, workspaceDir, "remote-vibes", [
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
  const realWorkspaceDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-session-real-"));
  const linkRootDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-session-link-"));
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
  const realWorkspaceDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-session-real-"));
  const linkRootDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-session-link-"));
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

    await writeGeminiSessions(userHomeDir, realWorkspaceDir, "remote-vibes-symlink", [
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
  const realWorkspaceDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-session-real-"));
  const linkRootDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-session-link-"));
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
