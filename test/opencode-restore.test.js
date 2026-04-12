import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { SessionManager } from "../src/session-manager.js";

async function createTempWorkspace(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
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

async function writeOpenCodeSessions(stateDir, sessions) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "sessions.json"), JSON.stringify(sessions), "utf8");
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
