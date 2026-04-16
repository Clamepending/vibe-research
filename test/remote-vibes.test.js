import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { createRemoteVibesApp } from "../src/create-app.js";
import { buildSessionEnv } from "../src/session-manager.js";

const execFileAsync = promisify(execFile);

const PNG_FIXTURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92,
  0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

async function startApp(options = {}) {
  const cwd = options.cwd || process.cwd();
  const stateDir = options.stateDir || path.join(cwd, ".remote-vibes");
  const app = await createRemoteVibesApp({
    host: "127.0.0.1",
    port: 0,
    cwd,
    stateDir,
    persistSessions: false,
    ...options,
  });

  return {
    app,
    baseUrl: `http://127.0.0.1:${app.config.port}`,
  };
}

async function createTempWorkspace(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writePersistedSessions(workspaceDir, sessions) {
  const stateDir = path.join(workspaceDir, ".remote-vibes");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "sessions.json"),
    `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), sessions }, null, 2)}\n`,
    "utf8",
  );
}

async function waitForPort(baseUrl, port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/ports`);
    const payload = await response.json();

    if (payload.ports.some((entry) => entry.port === port)) {
      return payload.ports;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Port ${port} never appeared in /api/ports.`);
}

async function waitForShutdown(baseUrl) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await fetch(`${baseUrl}/api/state`);
    } catch {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Remote Vibes never shut down.");
}

async function waitForValue(check, expectedValue) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (check() === expectedValue) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Expected value ${expectedValue} was never observed.`);
}

test("state is available without authentication", async () => {
  const { app, baseUrl } = await startApp();

  try {
    const response = await fetch(`${baseUrl}/api/state`);
    assert.equal(response.status, 200);

    const state = await response.json();
    assert.equal(state.appName, "Remote Vibes");
    const expectedDefaultProviderId = state.providers.some(
      (provider) => provider.id === "claude" && provider.available,
    )
      ? "claude"
      : "shell";
    assert.equal(state.defaultProviderId, expectedDefaultProviderId);
    assert.ok(state.providers.some((provider) => provider.id === "shell" && provider.available));
    assert.ok(Array.isArray(state.urls));
    assert.ok(state.urls.length >= 1);
    assert.equal(typeof state.preferredUrl, "string");
    assert.ok(state.urls.some((entry) => entry.url === state.preferredUrl));
    assert.equal(typeof state.agentPrompt.prompt, "string");
    assert.equal(state.agentPrompt.promptPath, ".remote-vibes/agent-prompt.md");
    assert.ok(Array.isArray(state.agentPrompt.targets));

    const gpuHistoryResponse = await fetch(`${baseUrl}/api/gpu/history?range=1d`);
    assert.equal(gpuHistoryResponse.status, 200);
    const gpuHistoryPayload = await gpuHistoryResponse.json();
    assert.equal(gpuHistoryPayload.history.range, "1d");
    assert.ok(Array.isArray(gpuHistoryPayload.history.gpus));
    assert.equal(typeof gpuHistoryPayload.history.agentRuns, "object");
    assert.ok(Array.isArray(gpuHistoryPayload.history.agentRuns.buckets));
  } finally {
    await app.close();
  }
});

test("update endpoints report status and schedule restart", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-update-");
  const updatePayload = {
    status: "available",
    updateAvailable: true,
    canUpdate: true,
    branch: "main",
    currentShort: "abc1234",
    latestShort: "def5678",
  };
  const forceCalls = [];
  let runtimePort = null;
  let applyCalls = 0;
  const updateManager = {
    setRuntime({ port }) {
      runtimePort = port;
    },
    async getStatus({ force } = {}) {
      forceCalls.push(Boolean(force));
      return updatePayload;
    },
    async scheduleUpdateAndRestart() {
      applyCalls += 1;
      return { ok: true, scheduled: true, update: updatePayload };
    },
  };
  const { app, baseUrl } = await startApp({ cwd: workspaceDir, updateManager });

  try {
    assert.equal(runtimePort, app.config.port);

    const statusResponse = await fetch(`${baseUrl}/api/update/status?force=1`);
    assert.equal(statusResponse.status, 200);
    assert.deepEqual(await statusResponse.json(), { update: updatePayload });
    assert.deepEqual(forceCalls, [true]);

    const applyResponse = await fetch(`${baseUrl}/api/update/apply`, {
      method: "POST",
    });
    assert.equal(applyResponse.status, 200);
    assert.deepEqual(await applyResponse.json(), { ok: true, scheduled: true, update: updatePayload });
    assert.equal(applyCalls, 1);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("agent prompt api creates wiki scaffold and managed instruction files", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-agent-prompt-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const stateResponse = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateResponse.status, 200);
    const statePayload = await stateResponse.json();

    assert.match(statePayload.agentPrompt.prompt, /Remote Vibes Agent Prompt/);
    assert.equal(statePayload.agentPrompt.targets.length, 3);
    assert.ok(statePayload.agentPrompt.targets.every((target) => target.status !== "conflict"));

    const managedAgents = await readFile(path.join(workspaceDir, "AGENTS.md"), "utf8");
    const managedClaude = await readFile(path.join(workspaceDir, "CLAUDE.md"), "utf8");
    const promptSource = await readFile(path.join(workspaceDir, ".remote-vibes", "agent-prompt.md"), "utf8");
    const wikiIndex = await readFile(path.join(workspaceDir, ".remote-vibes", "wiki", "index.md"), "utf8");

    assert.match(managedAgents, /remote-vibes:managed-agent-prompt/);
    assert.match(managedClaude, /remote-vibes:managed-agent-prompt/);
    assert.match(managedAgents, /Edit this from Remote Vibes or \.remote-vibes\/agent-prompt\.md/);
    assert.match(promptSource, /Remote Vibes Agent Prompt/);
    assert.match(promptSource, /remote-vibes:wiki-v2-protocol:v2/);
    assert.match(promptSource, /Treat links as traversal hints, not decoration/);
    assert.match(promptSource, /Start with the directly named files, notes, messages, or artifacts/);
    assert.match(promptSource, /Routine coordination, temporary resource negotiation/);
    assert.match(promptSource, /processed paths over inbox paths/);
    assert.match(promptSource, /remote-vibes:agent-mailbox-protocol:v2/);
    assert.match(promptSource, /sent_at/);
    assert.match(promptSource, /from_name/);
    assert.match(promptSource, /subject/);
    assert.match(promptSource, /short human-readable role or task label/);
    assert.match(promptSource, /workload-oriented label/);
    assert.match(promptSource, /rather than `Codex <id>` or `Claude <id>`/);
    assert.match(promptSource, /Remote Vibes provides `rv-session-name` on your session `PATH`/);
    assert.match(promptSource, /run `rv-session-name "<short task label>"`/);
    assert.match(promptSource, /keep `from_name` aligned with your current session name/);
    assert.match(promptSource, /Remote Vibes provides `rv-mailwatch` on your session `PATH`/);
    assert.match(promptSource, /prefer launching `rv-mailwatch --quiet --no-bell &`/);
    assert.match(promptSource, /rv-mailwatch --quiet --no-bell --once --timeout/);
    assert.match(promptSource, /waiting on a shared inbox rather than your default inbox/);
    assert.match(promptSource, /rv-mailwatch --inbox <path> --from <peer-session-id> --after <request-sent-at> --print-path/);
    assert.match(promptSource, /use that same timestamp as the `--after` baseline/);
    assert.match(promptSource, /confirm the matched message's `from` field before acting/);
    assert.match(promptSource, /platform-agnostic watcher patterns/);
    assert.match(promptSource, /On Linux, `inotifywait` is a reasonable fallback/);
    assert.match(wikiIndex, /Wiki Index/);

    const updateResponse = await fetch(`${baseUrl}/api/agent-prompt`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "# Custom Prompt\n\nAlways log experiment changes in `.remote-vibes/wiki/log.md`.",
      }),
    });

    assert.equal(updateResponse.status, 200);
    const updatedPayload = await updateResponse.json();
    assert.match(updatedPayload.prompt, /Custom Prompt/);
    assert.match(updatedPayload.prompt, /remote-vibes:wiki-v2-protocol:v2/);
    assert.match(updatedPayload.prompt, /Prefer fewer, better notes/);
    assert.match(updatedPayload.prompt, /remote-vibes:agent-mailbox-protocol:v2/);
    assert.match(updatedPayload.prompt, /subject/);

    const updatedManagedAgents = await readFile(path.join(workspaceDir, "AGENTS.md"), "utf8");
    assert.match(updatedManagedAgents, /Custom Prompt/);
    assert.match(updatedManagedAgents, /Knowledge Model/);
    assert.match(updatedManagedAgents, /Agent Mailboxes/);
    assert.match(updatedManagedAgents, /processed\//);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("existing prompt files are upgraded with the built-in agent mailbox protocol", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-agent-mailbox-upgrade-");
  const stateDir = path.join(workspaceDir, ".remote-vibes");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "agent-prompt.md"),
    "# Custom Prompt\n\nAlways leave concise handoff notes in the wiki.\n",
    "utf8",
  );

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const response = await fetch(`${baseUrl}/api/agent-prompt`);
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.match(payload.prompt, /Custom Prompt/);
    assert.match(payload.prompt, /remote-vibes:wiki-v2-protocol:v2/);
    assert.match(payload.prompt, /Search And Traversal/);
    assert.match(payload.prompt, /remote-vibes:agent-mailbox-protocol:v2/);
    assert.match(payload.prompt, /REMOTE_VIBES_SESSION_ID/);
    assert.match(payload.prompt, /older than one hour/);
    assert.match(payload.prompt, /from_name/);
    assert.match(payload.prompt, /subject/);
    assert.match(payload.prompt, /rv-session-name/);
    assert.match(payload.prompt, /specific exchange or artifact/);
    assert.match(payload.prompt, /rv-mailwatch/);
    assert.match(payload.prompt, /--once --timeout/);
    assert.match(payload.prompt, /platform-agnostic watcher patterns/);
    assert.match(payload.prompt, /neutral label such as `agent <first 8 chars of session id>`/);

    const savedPrompt = await readFile(path.join(stateDir, "agent-prompt.md"), "utf8");
    assert.match(savedPrompt, /Custom Prompt/);
    assert.match(savedPrompt, /Crystallization And Supersession/);
    assert.match(savedPrompt, /Agent Mailboxes/);

    const managedGemini = await readFile(path.join(workspaceDir, "GEMINI.md"), "utf8");
    assert.match(managedGemini, /Treat links as traversal hints, not decoration/);
    assert.match(managedGemini, /Agent Mailboxes/);
    assert.match(managedGemini, /reply_to/);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("legacy built-in prompt sections are replaced with the current versions", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-agent-prompt-legacy-upgrade-");
  const stateDir = path.join(workspaceDir, ".remote-vibes");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "agent-prompt.md"),
    `# Custom Prompt

Keep a crisp research log.

<!-- remote-vibes:wiki-v2-protocol:v1 -->

## Old Wiki Section

Old guidance.

<!-- remote-vibes:agent-mailbox-protocol:v1 -->

## Old Mailbox Section

Old mailbox guidance.
`,
    "utf8",
  );

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const response = await fetch(`${baseUrl}/api/agent-prompt`);
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.match(payload.prompt, /Custom Prompt/);
    assert.doesNotMatch(payload.prompt, /remote-vibes:wiki-v2-protocol:v1/);
    assert.doesNotMatch(payload.prompt, /remote-vibes:agent-mailbox-protocol:v1/);
    assert.match(payload.prompt, /remote-vibes:wiki-v2-protocol:v2/);
    assert.match(payload.prompt, /remote-vibes:agent-mailbox-protocol:v2/);
    assert.match(payload.prompt, /from_name/);
    assert.match(payload.prompt, /Routine coordination, temporary resource negotiation/);
    assert.match(payload.prompt, /short human-readable role or task label/);
    assert.match(payload.prompt, /rv-mailwatch/);
    assert.match(payload.prompt, /On Linux, `inotifywait` is a reasonable fallback/);
    assert.doesNotMatch(payload.prompt, /Old Wiki Section/);
    assert.doesNotMatch(payload.prompt, /Old Mailbox Section/);

    const savedPrompt = await readFile(path.join(stateDir, "agent-prompt.md"), "utf8");
    assert.doesNotMatch(savedPrompt, /remote-vibes:wiki-v2-protocol:v1/);
    assert.doesNotMatch(savedPrompt, /remote-vibes:agent-mailbox-protocol:v1/);
    assert.match(savedPrompt, /processed paths over inbox paths/);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("agent prompt sync does not overwrite unmanaged instruction files", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-agent-conflict-");
  await writeFile(path.join(workspaceDir, "AGENTS.md"), "# User-owned instructions\n", "utf8");

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const response = await fetch(`${baseUrl}/api/agent-prompt`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const agentsTarget = payload.targets.find((target) => target.label === "AGENTS.md");

    assert.ok(agentsTarget);
    assert.equal(agentsTarget.status, "conflict");
    assert.equal(await readFile(path.join(workspaceDir, "AGENTS.md"), "utf8"), "# User-owned instructions\n");
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("knowledge base api indexes markdown notes and linked note content", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-knowledge-base-");
  const wikiDir = path.join(workspaceDir, ".remote-vibes", "wiki");
  const topicsDir = path.join(wikiDir, "topics");

  await mkdir(topicsDir, { recursive: true });
  await writeFile(
    path.join(wikiDir, "index.md"),
    "# Wiki Index\n\nSee [Topic A](topics/topic-a.md) and [[log]].\n",
    "utf8",
  );
  await writeFile(
    path.join(wikiDir, "log.md"),
    "# Wiki Log\n\nLinked back to [[index]].\n",
    "utf8",
  );
  await writeFile(
    path.join(topicsDir, "topic-a.md"),
    "# Topic A\n\nBack to [Index](../index.md).\n\nSource manifest: [raw](../../raw/sources/topic-a.md)\n",
    "utf8",
  );

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const indexResponse = await fetch(`${baseUrl}/api/knowledge-base`);
    assert.equal(indexResponse.status, 200);
    const indexPayload = await indexResponse.json();

    assert.equal(indexPayload.relativeRoot, ".remote-vibes/wiki");
    assert.deepEqual(
      indexPayload.notes.map((note) => note.relativePath),
      ["index.md", "log.md", "topics/topic-a.md"],
    );
    assert.deepEqual(indexPayload.edges, [
      { source: "index.md", target: "log.md" },
      { source: "index.md", target: "topics/topic-a.md" },
      { source: "log.md", target: "index.md" },
      { source: "topics/topic-a.md", target: "index.md" },
    ]);

    const noteResponse = await fetch(
      `${baseUrl}/api/knowledge-base/note?path=${encodeURIComponent("topics/topic-a.md")}`,
    );
    assert.equal(noteResponse.status, 200);
    const notePayload = await noteResponse.json();

    assert.equal(notePayload.note.relativePath, "topics/topic-a.md");
    assert.equal(notePayload.note.title, "Topic A");
    assert.match(notePayload.note.content, /Back to \[Index\]/);

    const invalidNoteResponse = await fetch(
      `${baseUrl}/api/knowledge-base/note?path=${encodeURIComponent("../agent-prompt.md")}`,
    );
    assert.equal(invalidNoteResponse.status, 400);
    assert.match((await invalidNoteResponse.json()).error, /escapes the knowledge base root/i);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("shell session streams websocket output and honors custom cwd", async () => {
  const { app, baseUrl } = await startApp();

  try {
    const requestedCwd = path.join(os.tmpdir());
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Integration Shell",
        cwd: requestedCwd,
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();
    assert.equal(session.cwd, requestedCwd);

    const websocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?sessionId=${session.id}`);
    const marker = "REMOTE_VIBES_AUTOMATED_SMOKE";
    const output = await new Promise((resolve, reject) => {
      let combined = "";
      let sentResize = false;
      let sentMarker = false;
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for terminal output."));
      }, 8_000);

      websocket.on("open", () => {
        websocket.send(
          JSON.stringify({
            type: "resize",
            cols: 100,
            rows: 30,
          }),
        );
        sentResize = true;
      });

      websocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));
        const data = payload.data || "";
        combined += data;

        if (!sentResize) {
          websocket.send(
            JSON.stringify({
              type: "resize",
              cols: 100,
              rows: 30,
            }),
          );
          sentResize = true;
        }

        if (!sentMarker) {
          websocket.send(
            JSON.stringify({
              type: "input",
              data: `printf "${marker}\\n"\r`,
            }),
          );
          sentMarker = true;
        }

        if (combined.includes(marker)) {
          clearTimeout(timeout);
          resolve(combined);
        }
      });
    });

    assert.match(output, new RegExp(marker));
    assert.doesNotMatch(output, /cannot change locale/i);

    websocket.close();
    await once(websocket, "close");

    const deleteResponse = await fetch(`${baseUrl}/api/sessions/${session.id}`, {
      method: "DELETE",
    });

    assert.equal(deleteResponse.status, 200);
  } finally {
    await app.close();
  }
});

test("login shells inherit mailbox helpers and agent inbox env vars", async () => {
  const sessionId = "mailbox-helper-session";
  const env = buildSessionEnv(sessionId, "shell", process.cwd());
  const { stdout } = await execFileAsync(
    process.env.SHELL || "/bin/zsh",
    [
      "-i",
      "-l",
      "-c",
      "printf 'INBOX=%s\\n' \"$REMOTE_VIBES_AGENT_INBOX\"; printf 'WATCHER=%s\\n' \"$REMOTE_VIBES_MAIL_WATCHER\"; command -v rv-mailwatch; command -v rv-session-name",
    ],
    { env },
  );

  assert.match(stdout, new RegExp(`INBOX=.*${sessionId}.*/inbox`));
  assert.match(stdout, /WATCHER=rv-mailwatch/);
  assert.match(stdout, /rv-mailwatch/);
  assert.match(stdout, /rv-session-name/);
});

test("session names can be updated after creation", async () => {
  const { app, baseUrl } = await startApp();

  try {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Original Name",
        cwd: process.cwd(),
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();

    const renameResponse = await fetch(`${baseUrl}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Renamed Session",
      }),
    });

    assert.equal(renameResponse.status, 200);
    const renamePayload = await renameResponse.json();
    assert.equal(renamePayload.session.name, "Renamed Session");

    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.equal(
      sessionsPayload.sessions.find((entry) => entry.id === session.id)?.name,
      "Renamed Session",
    );
  } finally {
    await app.close();
  }
});

test("rv-session-name renames the current session through server metadata", async () => {
  const workspaceDir = process.cwd();
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();
    const env = buildSessionEnv(session.id, "shell", workspaceDir);

    const helperPath = path.join(workspaceDir, "bin", "rv-session-name");
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "results reviewer"], {
      cwd: workspaceDir,
      env,
    });

    assert.equal(stdout.trim(), "results reviewer");

    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.equal(
      sessionsPayload.sessions.find((entry) => entry.id === session.id)?.name,
      "results reviewer",
    );
  } finally {
    await app.close();
  }
});

test("rv-session-name falls back to a filesystem request when localhost is unreachable", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-session-rename-fallback-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();
    const env = buildSessionEnv(session.id, "shell", workspaceDir);

    await writeFile(
      path.join(workspaceDir, ".remote-vibes", "server.json"),
      `${JSON.stringify({ helperBaseUrl: "http://127.0.0.1:9" }, null, 2)}\n`,
      "utf8",
    );

    const helperPath = path.join(process.cwd(), "bin", "rv-session-name");
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "resource coordinator"], {
      cwd: workspaceDir,
      env,
    });

    assert.equal(stdout.trim(), "resource coordinator");

    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.equal(
      sessionsPayload.sessions.find((entry) => entry.id === session.id)?.name,
      "resource coordinator",
    );
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("sessions can be forked into fresh sibling sessions", async () => {
  const { app, baseUrl } = await startApp();

  try {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Parent Session",
        cwd: process.cwd(),
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();

    const firstForkResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/fork`, {
      method: "POST",
    });
    assert.equal(firstForkResponse.status, 201);
    const firstForkPayload = await firstForkResponse.json();

    assert.notEqual(firstForkPayload.session.id, session.id);
    assert.equal(firstForkPayload.session.providerId, session.providerId);
    assert.equal(firstForkPayload.session.cwd, session.cwd);
    assert.equal(firstForkPayload.session.name, "Parent Session fork");

    const secondForkResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/fork`, {
      method: "POST",
    });
    assert.equal(secondForkResponse.status, 201);
    const secondForkPayload = await secondForkResponse.json();
    assert.equal(secondForkPayload.session.name, "Parent Session fork 2");

    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.equal(sessionsPayload.sessions.length, 3);

    const websocket = new WebSocket(
      `${baseUrl.replace("http", "ws")}/ws?sessionId=${firstForkPayload.session.id}`,
    );
    const snapshot = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for forked session snapshot."));
      }, 8_000);

      websocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));

        if (payload.type === "snapshot") {
          clearTimeout(timeout);
          resolve(payload);
        }
      });
    });

    assert.match(snapshot.data, /forked from: Parent Session/);
    assert.match(snapshot.data, /fresh sibling session/i);

    websocket.close();
    await once(websocket, "close");
  } finally {
    await app.close();
  }
});

test("ports are discoverable and proxy through localhost", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-ports-");
  const previewServer = http.createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body>preview</body></html>');
      return;
    }

    if (request.url === "/style.css") {
      response.writeHead(200, { "Content-Type": "text/css" });
      response.end("body{background:rgb(1,2,3)}");
      return;
    }

    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(`preview:${request.url}`);
  });
  const forbiddenServer = http.createServer((_request, response) => {
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.end("forbidden");
  });

  await new Promise((resolve) => previewServer.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => forbiddenServer.listen(0, "127.0.0.1", resolve));
  const previewPort = previewServer.address().port;
  const forbiddenPort = forbiddenServer.address().port;

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const ports = await waitForPort(baseUrl, previewPort);
    assert.ok(ports.some((entry) => entry.port === previewPort));
    assert.ok(!ports.some((entry) => entry.port === forbiddenPort));

    const rootResponse = await fetch(`${baseUrl}/proxy/${previewPort}/`);
    assert.equal(rootResponse.status, 200);
    assert.match(await rootResponse.text(), /href="\/style\.css"/);

    const stylesheetResponse = await fetch(`${baseUrl}/style.css`, {
      headers: {
        Referer: `${baseUrl}/proxy/${previewPort}/`,
      },
    });
    assert.equal(stylesheetResponse.status, 200);
    assert.equal(await stylesheetResponse.text(), "body{background:rgb(1,2,3)}");

    const proxyResponse = await fetch(`${baseUrl}/proxy/${previewPort}/hello`);
    assert.equal(proxyResponse.status, 200);
    assert.equal(await proxyResponse.text(), "preview:/hello");

    const renameResponse = await fetch(`${baseUrl}/api/ports/${previewPort}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "storybook" }),
    });
    assert.equal(renameResponse.status, 200);
    const renamePayload = await renameResponse.json();
    assert.equal(renamePayload.port.name, "storybook");
    assert.equal(renamePayload.port.customName, true);

    const renamedPortsResponse = await fetch(`${baseUrl}/api/ports`);
    assert.equal(renamedPortsResponse.status, 200);
    const renamedPortsPayload = await renamedPortsResponse.json();
    assert.equal(
      renamedPortsPayload.ports.find((entry) => entry.port === previewPort)?.name,
      "storybook",
    );

    const resetResponse = await fetch(`${baseUrl}/api/ports/${previewPort}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "  " }),
    });
    assert.equal(resetResponse.status, 200);
    const resetPayload = await resetResponse.json();
    assert.equal(resetPayload.port.name, String(previewPort));
    assert.equal(resetPayload.port.customName, false);
  } finally {
    await app.close();
    await new Promise((resolve) => previewServer.close(resolve));
    await new Promise((resolve) => forbiddenServer.close(resolve));
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("rejects an invalid working directory", async () => {
  const { app, baseUrl } = await startApp();

  try {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        cwd: "/definitely/not/a/real/path",
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.match(payload.error, /Working directory does not exist/);
  } finally {
    await app.close();
  }
});

test("terminate endpoint shuts down the app cleanly", async () => {
  let terminateCalls = 0;
  const { app, baseUrl } = await startApp({
    onTerminate: async () => {
      terminateCalls += 1;
    },
  });

  try {
    const response = await fetch(`${baseUrl}/api/terminate`, {
      method: "POST",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, shuttingDown: true });

    await waitForShutdown(baseUrl);
    await waitForValue(() => terminateCalls, 1);
  } finally {
    await app.close();
  }
});

test("relaunch endpoint shuts down the app cleanly and requests a restart", async () => {
  const terminateCalls = [];
  const { app, baseUrl } = await startApp({
    onTerminate: async (options = {}) => {
      terminateCalls.push(options);
    },
  });

  try {
    const response = await fetch(`${baseUrl}/api/relaunch`, {
      method: "POST",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, relaunching: true });

    await waitForShutdown(baseUrl);
    await waitForValue(() => terminateCalls.length, 1);
    assert.deepEqual(terminateCalls, [{ relaunch: true }]);
  } finally {
    await app.close();
  }
});

test("running sessions are restored with their transcript after restart", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-persist-");
  let firstApp = null;
  let secondApp = null;

  try {
    const firstRun = await startApp({
      cwd: workspaceDir,
      persistSessions: true,
    });
    firstApp = firstRun.app;

    const createResponse = await fetch(`${firstRun.baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Persistent Shell",
        cwd: workspaceDir,
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();
    const websocket = new WebSocket(`${firstRun.baseUrl.replace("http", "ws")}/ws?sessionId=${session.id}`);
    const marker = "REMOTE_VIBES_PERSISTENCE_MARKER";

    const output = await new Promise((resolve, reject) => {
      let combined = "";
      let sentResize = false;
      let sentMarker = false;
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for persisted session output."));
      }, 8_000);

      websocket.on("open", () => {
        websocket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
        sentResize = true;
      });

      websocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));
        const data = payload.data || "";
        combined += data;

        if (!sentResize) {
          websocket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
          sentResize = true;
        }

        if (!sentMarker) {
          websocket.send(
            JSON.stringify({
              type: "input",
              data: `printf "${marker}\\n"\r`,
            }),
          );
          sentMarker = true;
        }

        if (combined.includes(marker)) {
          clearTimeout(timeout);
          resolve(combined);
        }
      });
    });

    assert.match(output, new RegExp(marker));
    websocket.close();
    await once(websocket, "close");

    await firstApp.close();
    firstApp = null;

    const secondRun = await startApp({
      cwd: workspaceDir,
      persistSessions: true,
    });
    secondApp = secondRun.app;

    const sessionsResponse = await fetch(`${secondRun.baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.equal(sessionsPayload.sessions.length, 1);
    assert.equal(sessionsPayload.sessions[0].name, "Persistent Shell");
    assert.equal(sessionsPayload.sessions[0].cwd, workspaceDir);

    const restoredSocket = new WebSocket(
      `${secondRun.baseUrl.replace("http", "ws")}/ws?sessionId=${sessionsPayload.sessions[0].id}`,
    );
    const snapshot = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for restored session snapshot."));
      }, 8_000);

      restoredSocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));

        if (payload.type === "snapshot") {
          clearTimeout(timeout);
          resolve(payload);
        }
      });
    });

    assert.match(snapshot.data, new RegExp(marker));
    restoredSocket.close();
    await once(restoredSocket, "close");
  } finally {
    if (firstApp) {
      await firstApp.close();
    }

    if (secondApp) {
      await secondApp.close();
    }

    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("renamed sessions keep their updated name after restart", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-rename-persist-");
  let firstApp = null;
  let secondApp = null;

  try {
    const firstRun = await startApp({
      cwd: workspaceDir,
      persistSessions: true,
    });
    firstApp = firstRun.app;

    const createResponse = await fetch(`${firstRun.baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Before Rename",
        cwd: workspaceDir,
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();

    const renameResponse = await fetch(`${firstRun.baseUrl}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "After Rename",
      }),
    });

    assert.equal(renameResponse.status, 200);
    assert.equal((await renameResponse.json()).session.name, "After Rename");

    await firstApp.close();
    firstApp = null;

    const secondRun = await startApp({
      cwd: workspaceDir,
      persistSessions: true,
    });
    secondApp = secondRun.app;

    const sessionsResponse = await fetch(`${secondRun.baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.equal(sessionsPayload.sessions.length, 1);
    assert.equal(sessionsPayload.sessions[0].id, session.id);
    assert.equal(sessionsPayload.sessions[0].name, "After Rename");
  } finally {
    if (firstApp) {
      await firstApp.close();
    }

    if (secondApp) {
      await secondApp.close();
    }

    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("workspace file api lists directories, edits text files, and serves image files", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-files-");
  const graphsDir = path.join(workspaceDir, "graphs");
  const internalStateDir = path.join(workspaceDir, ".remote-vibes");
  const imagePath = path.join(graphsDir, "chart.png");
  const notePath = path.join(workspaceDir, "notes.txt");
  const internalStatePath = path.join(internalStateDir, "sessions.json");

  await mkdir(graphsDir, { recursive: true });
  await mkdir(internalStateDir, { recursive: true });
  await writeFile(imagePath, PNG_FIXTURE);
  await writeFile(notePath, "analysis notes\n", "utf8");
  await writeFile(internalStatePath, "{}\n", "utf8");

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const rootResponse = await fetch(`${baseUrl}/api/files?root=${encodeURIComponent(workspaceDir)}`);
    assert.equal(rootResponse.status, 200);
    const rootPayload = await rootResponse.json();

    assert.deepEqual(
      rootPayload.entries.map((entry) => ({ name: entry.name, type: entry.type })),
      [
        { name: "graphs", type: "directory" },
        { name: "notes.txt", type: "file" },
      ],
    );

    const nestedResponse = await fetch(
      `${baseUrl}/api/files?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("graphs")}`,
    );
    assert.equal(nestedResponse.status, 200);
    const nestedPayload = await nestedResponse.json();
    assert.equal(nestedPayload.entries.length, 1);
    assert.equal(nestedPayload.entries[0].name, "chart.png");
    assert.equal(nestedPayload.entries[0].isImage, true);

    const textResponse = await fetch(
      `${baseUrl}/api/files/text?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("notes.txt")}`,
    );
    assert.equal(textResponse.status, 200);
    const textPayload = await textResponse.json();
    assert.equal(textPayload.file.content, "analysis notes\n");

    const saveResponse = await fetch(`${baseUrl}/api/files/text`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        root: workspaceDir,
        path: "notes.txt",
        content: "updated notes\nwith details\n",
      }),
    });
    assert.equal(saveResponse.status, 200);
    assert.equal((await saveResponse.json()).file.content, "updated notes\nwith details\n");

    const verifyTextResponse = await fetch(
      `${baseUrl}/api/files/text?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("notes.txt")}`,
    );
    assert.equal(verifyTextResponse.status, 200);
    assert.equal((await verifyTextResponse.json()).file.content, "updated notes\nwith details\n");

    const imageResponse = await fetch(
      `${baseUrl}/api/files/content?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("graphs/chart.png")}`,
    );
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get("content-type") || "", /image\/png/);

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    assert.equal(imageBuffer.compare(PNG_FIXTURE), 0);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("deleted persisted sessions do not come back after restart", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-delete-");
  let firstApp = null;
  let secondApp = null;

  try {
    const firstRun = await startApp({
      cwd: workspaceDir,
      persistSessions: true,
    });
    firstApp = firstRun.app;

    const createResponse = await fetch(`${firstRun.baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Delete Me",
        cwd: workspaceDir,
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();

    const deleteResponse = await fetch(`${firstRun.baseUrl}/api/sessions/${session.id}`, {
      method: "DELETE",
    });
    assert.equal(deleteResponse.status, 200);

    await firstApp.close();
    firstApp = null;

    const secondRun = await startApp({
      cwd: workspaceDir,
      persistSessions: true,
    });
    secondApp = secondRun.app;

    const sessionsResponse = await fetch(`${secondRun.baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.deepEqual(sessionsPayload.sessions, []);
  } finally {
    if (firstApp) {
      await firstApp.close();
    }

    if (secondApp) {
      await secondApp.close();
    }

    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("persisted sessions with missing workspaces stay visible and show restore failure", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-missing-cwd-");
  const missingCwd = path.join(workspaceDir, "missing-workspace");
  const persistedSessionId = "persisted-missing-cwd";
  const createdAt = new Date().toISOString();

  await writePersistedSessions(workspaceDir, [
    {
      id: persistedSessionId,
      providerId: "shell",
      providerLabel: "Vanilla Shell",
      name: "Missing Workspace",
      cwd: missingCwd,
      shell: process.env.SHELL || "/bin/zsh",
      createdAt,
      updatedAt: createdAt,
      lastOutputAt: createdAt,
      status: "running",
      exitCode: null,
      exitSignal: null,
      cols: 90,
      rows: 24,
      buffer: "previous transcript\r\n",
      restoreOnStartup: true,
    },
  ]);

  const { app, baseUrl } = await startApp({
    cwd: workspaceDir,
    persistSessions: true,
  });

  try {
    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();

    assert.equal(sessionsPayload.sessions.length, 1);
    assert.equal(sessionsPayload.sessions[0].id, persistedSessionId);
    assert.equal(sessionsPayload.sessions[0].status, "exited");

    const websocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?sessionId=${persistedSessionId}`);
    const snapshot = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for missing-workspace snapshot."));
      }, 8_000);

      websocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));

        if (payload.type === "snapshot") {
          clearTimeout(timeout);
          resolve(payload);
        }
      });
    });

    assert.match(snapshot.data, /previous transcript/);
    assert.match(snapshot.data, /could not restore the session/i);
    assert.match(snapshot.data, /Working directory does not exist/i);

    websocket.close();
    await once(websocket, "close");
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("workspace file api rejects traversal and invalid entry types", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-files-guards-");
  const graphsDir = path.join(workspaceDir, "graphs");
  const internalStateDir = path.join(workspaceDir, ".remote-vibes");
  const imagePath = path.join(graphsDir, "chart.png");
  const notePath = path.join(workspaceDir, "notes.txt");
  const internalStatePath = path.join(internalStateDir, "sessions.json");

  await mkdir(graphsDir, { recursive: true });
  await mkdir(internalStateDir, { recursive: true });
  await writeFile(imagePath, PNG_FIXTURE);
  await writeFile(notePath, "analysis notes\n", "utf8");
  await writeFile(internalStatePath, "{}\n", "utf8");

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const traversalResponse = await fetch(
      `${baseUrl}/api/files?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("../")}`,
    );
    assert.equal(traversalResponse.status, 400);
    assert.match((await traversalResponse.json()).error, /escapes the selected workspace/i);

    const directoryAsFileResponse = await fetch(
      `${baseUrl}/api/files/content?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("graphs")}`,
    );
    assert.equal(directoryAsFileResponse.status, 400);
    assert.match((await directoryAsFileResponse.json()).error, /not a file/i);

    const fileAsDirectoryResponse = await fetch(
      `${baseUrl}/api/files?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("notes.txt")}`,
    );
    assert.equal(fileAsDirectoryResponse.status, 400);
    assert.match((await fileAsDirectoryResponse.json()).error, /not a directory/i);

    const internalDirectoryResponse = await fetch(
      `${baseUrl}/api/files?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent(".remote-vibes")}`,
    );
    assert.equal(internalDirectoryResponse.status, 404);
    assert.match((await internalDirectoryResponse.json()).error, /not available in the workspace browser/i);

    const internalFileResponse = await fetch(
      `${baseUrl}/api/files/content?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent(".remote-vibes/sessions.json")}`,
    );
    assert.equal(internalFileResponse.status, 404);
    assert.match((await internalFileResponse.json()).error, /not available in the workspace browser/i);

    const imageAsTextResponse = await fetch(
      `${baseUrl}/api/files/text?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("graphs/chart.png")}`,
    );
    assert.equal(imageAsTextResponse.status, 400);
    assert.match((await imageAsTextResponse.json()).error, /not editable as text/i);

    const internalTextResponse = await fetch(`${baseUrl}/api/files/text`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        root: workspaceDir,
        path: ".remote-vibes/sessions.json",
        content: "{}\n",
      }),
    });
    assert.equal(internalTextResponse.status, 404);
    assert.match((await internalTextResponse.json()).error, /not available in the workspace browser/i);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
