import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { SessionManager } from "../src/session-manager.js";

async function createTempWorkspace(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTempHome(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function buildEnv(homeDir) {
  return {
    ...process.env,
    HOME: homeDir,
  };
}

async function createFakeOpenCodeCli(rootDir, stateDir) {
  const scriptPath = path.join(rootDir, "fake-opencode.mjs");
  const script = `#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const stateDir = ${JSON.stringify(stateDir)};
const sessionsFile = path.join(stateDir, "sessions.json");

mkdirSync(stateDir, { recursive: true });

function loadSessions() {
  try {
    return JSON.parse(readFileSync(sessionsFile, "utf8"));
  } catch {
    return [];
  }
}

const args = process.argv.slice(2);

if (args[0] === "session" && args[1] === "list") {
  process.stdout.write(JSON.stringify(loadSessions()));
  process.exit(0);
}
`;

  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

function buildProviders(fakeOpenCodePath) {
  return [
    {
      id: "opencode",
      label: "OpenCode",
      command: "opencode",
      launchCommand: fakeOpenCodePath,
      defaultName: "OpenCode",
      available: true,
    },
    {
      id: "shell",
      label: "Vanilla Shell",
      command: null,
      launchCommand: null,
      defaultName: "Shell",
      available: true,
    },
  ];
}

function buildClaudeProvider() {
  return {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    launchCommand: "claude",
    defaultName: "Claude",
    available: true,
  };
}

function buildCodexProvider() {
  return {
    id: "codex",
    label: "Codex",
    command: "codex",
    launchCommand: "codex",
    defaultName: "Codex",
    available: true,
  };
}

async function writeOpenCodeSessions(stateDir, sessions) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "sessions.json"), JSON.stringify(sessions), "utf8");
}

function getClaudeProjectDir(homeDir, cwd) {
  return path.join(homeDir, ".claude", "projects", path.resolve(cwd).replaceAll(path.sep, "-"));
}

async function writeClaudeSessionFile(homeDir, cwd, sessionId, content = "") {
  const projectDir = getClaudeProjectDir(homeDir, cwd);
  const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);
  await mkdir(projectDir, { recursive: true });
  await writeFile(sessionPath, content || `${JSON.stringify({ sessionId, cwd })}\n`, "utf8");
  return { projectDir, sessionPath };
}

function getCodexSessionDir(homeDir) {
  return path.join(homeDir, ".codex", "sessions", "9999", "12", "31");
}

async function writeCodexSessionFile(homeDir, sessionId, cwd) {
  const sessionDir = getCodexSessionDir(homeDir);
  const sessionPath = path.join(sessionDir, `rollout-9999-12-31T23-59-59-${sessionId}.jsonl`);
  const firstLine = {
    timestamp: new Date().toISOString(),
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd,
      originator: "Remote Vibes Test",
    },
  };

  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionPath, `${JSON.stringify(firstLine)}\n`, "utf8");
  return { sessionDir, sessionPath };
}

test("opencode session ids are captured and persisted for future restores", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-opencode-");
  const fakeStateDir = path.join(workspaceDir, ".fake-opencode");
  const fakeOpenCodePath = await createFakeOpenCodeCli(workspaceDir, fakeStateDir);
  const providers = buildProviders(fakeOpenCodePath);
  const provider = providers[0];
  const expectedSessionId = "ses_captured_for_restore";
  let manager = null;

  try {
    manager = new SessionManager({
      cwd: workspaceDir,
      providers,
      persistSessions: true,
    });
    const session = manager.buildSessionRecord({
      providerId: "opencode",
      providerLabel: "OpenCode",
      name: "Persistent OpenCode",
      cwd: workspaceDir,
      restoreOnStartup: true,
    });
    const fakePty = {};

    session.status = "running";
    session.pty = fakePty;

    setTimeout(() => {
      void writeOpenCodeSessions(fakeStateDir, [
        {
          id: expectedSessionId,
          title: "Captured OpenCode Session",
          updated: Date.now(),
          created: Date.now(),
          directory: workspaceDir,
        },
      ]);
    }, 100);

    await manager.captureOpenCodeSessionId(session, provider, fakePty, new Set(), Date.now());

    assert.equal(session.providerState.sessionId, expectedSessionId);
    assert.equal(
      manager.serializePersistedSession(session).providerState.sessionId,
      expectedSessionId,
    );

    const restoredSession = manager.buildSessionRecord({
      providerId: "opencode",
      providerLabel: "OpenCode",
      name: "Persistent OpenCode",
      cwd: workspaceDir,
      restoreOnStartup: true,
      providerState: session.providerState,
    });
    const launchContext = await manager.prepareProviderLaunch(restoredSession, provider, {
      restored: true,
    });

    assert.match(launchContext.commandString, new RegExp(`--session' '${expectedSessionId}'`));
  } finally {
    if (manager) {
      await manager.shutdown({ preserveSessions: false });
    }

    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("opencode restore can best-effort reconnect older snapshots without provider state", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-opencode-legacy-");
  const fakeStateDir = path.join(workspaceDir, ".fake-opencode");
  const fakeOpenCodePath = await createFakeOpenCodeCli(workspaceDir, fakeStateDir);
  const providers = buildProviders(fakeOpenCodePath);
  const provider = providers[0];
  const expectedSessionId = "ses_existing_restore_target";
  let manager = null;

  try {
    await writeOpenCodeSessions(fakeStateDir, [
      {
        id: expectedSessionId,
        title: "Existing OpenCode Session",
        updated: Date.now(),
        created: Date.now() - 1_000,
        directory: workspaceDir,
      },
    ]);

    manager = new SessionManager({
      cwd: workspaceDir,
      providers,
      persistSessions: true,
    });
    const legacySession = manager.buildSessionRecord({
      id: "legacy-session",
      providerId: "opencode",
      providerLabel: "OpenCode",
      name: "Legacy OpenCode",
      shell: process.env.SHELL || "/bin/zsh",
      cwd: workspaceDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      restoreOnStartup: true,
    });
    const launchContext = await manager.prepareProviderLaunch(legacySession, provider, {
      restored: true,
    });

    assert.equal(legacySession.providerState.sessionId, expectedSessionId);
    assert.match(launchContext.commandString, new RegExp(`--session' '${expectedSessionId}'`));
  } finally {
    if (manager) {
      await manager.shutdown({ preserveSessions: false });
    }

    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("claude sessions use a deterministic session id so restores pick up exactly where they left off", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-claude-");
  const provider = buildClaudeProvider();
  let manager = null;

  try {
    manager = new SessionManager({
      cwd: workspaceDir,
      providers: [provider],
      persistSessions: true,
    });
    const session = manager.buildSessionRecord({
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Persistent Claude",
      cwd: workspaceDir,
      restoreOnStartup: true,
    });

    const launchContext = await manager.prepareProviderLaunch(session, provider, {
      restored: false,
    });
    assert.equal(session.providerState.sessionId, session.id);
    assert.match(launchContext.commandString, new RegExp(`--session-id' '${session.id}'`));

    const restoredContext = await manager.prepareProviderLaunch(session, provider, {
      restored: true,
    });
    assert.match(restoredContext.commandString, new RegExp(`--resume' '${session.id}'`));
  } finally {
    if (manager) {
      await manager.shutdown({ preserveSessions: false });
    }

    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("claude restore can recover older snapshots by matching the workspace project directory", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-claude-legacy-");
  const homeDir = await createTempHome("remote-vibes-claude-home-");
  const provider = buildClaudeProvider();
  const expectedSessionId = "11111111-2222-4333-8444-555555555555";
  let manager = null;
  let projectDir = null;
  let sessionPath = null;

  try {
    ({ projectDir, sessionPath } = await writeClaudeSessionFile(homeDir, workspaceDir, expectedSessionId));

    manager = new SessionManager({
      cwd: workspaceDir,
      providers: [provider],
      persistSessions: true,
      env: buildEnv(homeDir),
    });
    const legacySession = manager.buildSessionRecord({
      id: "legacy-claude-session",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Legacy Claude",
      cwd: workspaceDir,
      restoreOnStartup: true,
    });
    const launchContext = await manager.prepareProviderLaunch(legacySession, provider, {
      restored: true,
    });

    assert.equal(legacySession.providerState.sessionId, expectedSessionId);
    assert.match(launchContext.commandString, new RegExp(`--resume' '${expectedSessionId}'`));
  } finally {
    if (manager) {
      await manager.shutdown({ preserveSessions: false });
    }

    if (sessionPath) {
      await rm(sessionPath, { force: true });
    }

    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
    }

    await rm(workspaceDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("codex sessions are captured and persisted for future restores", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-codex-");
  const homeDir = await createTempHome("remote-vibes-codex-home-");
  const provider = buildCodexProvider();
  const expectedSessionId = "019d9000-1111-7222-8333-444444444444";
  let manager = null;
  let sessionDir = null;
  let sessionPath = null;
  let scheduledWrite = Promise.resolve();

  try {
    manager = new SessionManager({
      cwd: workspaceDir,
      providers: [provider],
      persistSessions: true,
      env: buildEnv(homeDir),
    });
    const session = manager.buildSessionRecord({
      providerId: "codex",
      providerLabel: "Codex",
      name: "Persistent Codex",
      cwd: workspaceDir,
      restoreOnStartup: true,
    });
    const fakePty = {};

    session.status = "running";
    session.pty = fakePty;

    scheduledWrite = new Promise((resolve, reject) => {
      setTimeout(() => {
        writeCodexSessionFile(homeDir, expectedSessionId, workspaceDir)
          .then((result) => {
            ({ sessionDir, sessionPath } = result);
            resolve();
          })
          .catch(reject);
      }, 100);
    });

    await manager.captureCodexSessionId(session, fakePty, new Set(), Date.now());
    await scheduledWrite;

    assert.equal(session.providerState.sessionId, expectedSessionId);
    assert.equal(
      manager.serializePersistedSession(session).providerState.sessionId,
      expectedSessionId,
    );

    const restoredSession = manager.buildSessionRecord({
      providerId: "codex",
      providerLabel: "Codex",
      name: "Persistent Codex",
      cwd: workspaceDir,
      restoreOnStartup: true,
      providerState: session.providerState,
    });
    const launchContext = await manager.prepareProviderLaunch(restoredSession, provider, {
      restored: true,
    });

    assert.match(launchContext.commandString, new RegExp(`resume' '${expectedSessionId}'`));
  } finally {
    if (manager) {
      await manager.shutdown({ preserveSessions: false });
    }

    if (sessionPath) {
      await rm(sessionPath, { force: true });
    }

    if (sessionDir) {
      await rm(sessionDir, { recursive: true, force: true });
    }

    await rm(workspaceDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("codex restore can best-effort reconnect older snapshots without provider state", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-codex-legacy-");
  const homeDir = await createTempHome("remote-vibes-codex-legacy-home-");
  const provider = buildCodexProvider();
  const expectedSessionId = "019d9000-aaaa-7bbb-8ccc-dddddddddddd";
  let manager = null;
  let sessionDir = null;
  let sessionPath = null;

  try {
    ({ sessionDir, sessionPath } = await writeCodexSessionFile(homeDir, expectedSessionId, workspaceDir));

    manager = new SessionManager({
      cwd: workspaceDir,
      providers: [provider],
      persistSessions: true,
      env: buildEnv(homeDir),
    });
    const legacySession = manager.buildSessionRecord({
      id: "legacy-codex-session",
      providerId: "codex",
      providerLabel: "Codex",
      name: "Legacy Codex",
      cwd: workspaceDir,
      restoreOnStartup: true,
    });
    const launchContext = await manager.prepareProviderLaunch(legacySession, provider, {
      restored: true,
    });

    assert.equal(legacySession.providerState.sessionId, expectedSessionId);
    assert.match(launchContext.commandString, new RegExp(`resume' '${expectedSessionId}'`));
  } finally {
    if (manager) {
      await manager.shutdown({ preserveSessions: false });
    }

    if (sessionPath) {
      await rm(sessionPath, { force: true });
    }

    if (sessionDir) {
      await rm(sessionDir, { recursive: true, force: true });
    }

    await rm(workspaceDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});
