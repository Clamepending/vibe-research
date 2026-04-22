import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { BrowserUseService } from "../src/browser-use-service.js";
import { createVibeResearchApp } from "../src/create-app.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const execFileAsync = promisify(execFile);
const LARGE_SNAPSHOT_IMAGE_BASE64 = `${"iVBORw0KGgo="}${"A".repeat(180_000)}`;

async function createFakeWorkerRoot(workspaceDir) {
  const workerRoot = path.join(workspaceDir, "fake-ottoauth-worker");
  const cliPath = path.join(workerRoot, "src", "cli.mjs");
  await mkdir(path.dirname(cliPath), { recursive: true });
  await writeFile(cliPath, "console.log('fake worker');\n", "utf8");
  await chmod(cliPath, 0o755);
  return workerRoot;
}

function createFakeWorkerSpawner(calls) {
  return function fakeWorkerSpawner(command, args, options) {
    calls.push({ args, command, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4242 + calls.length;
    child.kill = () => {
      child.emit("close", null, "SIGTERM");
    };

    setTimeout(async () => {
      try {
        const configPath = path.join(options.env.OTTOAUTH_WORKER_HOME, "config.json");
        const config = JSON.parse(await readFile(configPath, "utf8"));
        child.stdout.write("fake browser worker started\n");

        const waitResponse = await fetch(`${config.serverUrl}/api/computeruse/device/wait-task?waitMs=1`, {
          headers: {
            Authorization: `Bearer ${config.authToken}`,
            "X-OttoAuth-Mock-Device": config.deviceId,
          },
        });
        assert.equal(waitResponse.status, 200);
        const task = await waitResponse.json();

        const snapshotResponse = await fetch(
          `${config.serverUrl}/api/computeruse/device/tasks/${encodeURIComponent(task.id)}/snapshot`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.authToken}`,
              "Content-Type": "application/json",
              "X-OttoAuth-Mock-Device": config.deviceId,
            },
            body: JSON.stringify({
              height: 600,
              image_base64: LARGE_SNAPSHOT_IMAGE_BASE64,
              tabs: [{ active: true, id: 1, title: "Example", url: "https://example.com/" }],
              width: 800,
            }),
          },
        );
        assert.equal(snapshotResponse.status, 200);

        const eventResponse = await fetch(
          `${config.serverUrl}/api/computeruse/device/tasks/${encodeURIComponent(task.id)}/events`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.authToken}`,
              "Content-Type": "application/json",
              "X-OttoAuth-Mock-Device": config.deviceId,
            },
            body: JSON.stringify({
              type: "tool_started",
              payload: {
                input: { url: "https://example.com/" },
                loop: 1,
                tool: "navigate",
                toolUseId: "toolu_test",
              },
            }),
          },
        );
        assert.equal(eventResponse.status, 200);

        await new Promise((resolve) => setTimeout(resolve, 150));

        const completeResponse = await fetch(
          `${config.serverUrl}/api/computeruse/device/tasks/${encodeURIComponent(task.id)}/local-agent-complete`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.authToken}`,
              "Content-Type": "application/json",
              "X-OttoAuth-Mock-Device": config.deviceId,
            },
            body: JSON.stringify({
              status: "completed",
              result: {
                status: "completed",
                summary: "Loaded example.com successfully.",
                charges: {
                  goods_cents: 0,
                  shipping_cents: 0,
                  tax_cents: 0,
                  other_cents: 0,
                  currency: "usd",
                },
              },
              usages: [{ input_tokens: 10, output_tokens: 4 }],
              messages: [
                {
                  role: "user",
                  content: "Open https://example.com and report success.",
                },
                {
                  role: "assistant",
                  content: [
                    {
                      id: "toolu_test",
                      input: { url: "https://example.com/" },
                      name: "navigate",
                      type: "tool_use",
                    },
                  ],
                },
                {
                  role: "user",
                  content: [
                    {
                      content: [{ text: "Loaded Example Domain.", type: "text" }],
                      tool_use_id: "toolu_test",
                      type: "tool_result",
                    },
                  ],
                },
                {
                  role: "assistant",
                  content: [{ text: "Loaded example.com successfully.", type: "text" }],
                },
              ],
            }),
          },
        );
        assert.equal(completeResponse.status, 200);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      } catch (error) {
        child.stderr.write(error.stack || error.message);
        child.stderr.end();
        child.emit("close", 1, null);
      }
    }, 20);

    return child;
  };
}

function createIdleWorkerSpawner(calls) {
  return function idleWorkerSpawner(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 5252 + calls.length;
    child.killCalled = false;
    child.killSignal = "";
    child.kill = (signal) => {
      child.killCalled = true;
      child.killSignal = signal || "";
      child.emit("close", null, signal || "SIGTERM");
    };
    calls.push({ args, child, command, options });
    return child;
  };
}

async function waitForBrowserUseStatus(baseUrl, sessionId, status, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions/${sessionId}`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    if (payload.session.status === status) {
      return payload.session;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for browser-use session ${sessionId} to become ${status}`);
}

test("browser-use plugin launches a local OttoAuth-compatible worker session under the caller", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-browser-use-"));
  const stateDir = path.join(workspaceDir, ".vibe-research");
  const workerRoot = await createFakeWorkerRoot(workspaceDir);
  const workerCalls = [];

  const app = await createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd: workspaceDir,
    stateDir,
    persistSessions: false,
    persistentTerminals: false,
    browserUseServiceFactory: (settings, { stateDir: serviceStateDir, systemRootPath }) =>
      new BrowserUseService({
        settings,
        stateDir: serviceStateDir,
        systemRootPath,
        workerSpawner: createFakeWorkerSpawner(workerCalls),
      }),
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({
        enabled: settings.preventSleepEnabled,
        platform: "test",
      }),
  });
  const baseUrl = `http://127.0.0.1:${app.config.port}`;

  try {
    const setupResponse = await fetch(`${baseUrl}/api/browser-use/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anthropicApiKey: "sk-test-browser-use",
        enabled: true,
        maxTurns: 12,
        profileDir: path.join(workspaceDir, "profile"),
        workerPath: workerRoot,
      }),
    });
    assert.equal(setupResponse.status, 200);
    const setupPayload = await setupResponse.json();
    assert.equal(setupPayload.settings.browserUseAnthropicApiKey, "");
    assert.equal(setupPayload.settings.browserUseAnthropicApiKeyConfigured, true);
    assert.equal(setupPayload.settings.browserUseMaxTurns, 12);
    assert.equal(setupPayload.settings.browserUseStatus.workerAvailable, true);

    const createParentResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "shell", name: "Caller" }),
    });
    assert.equal(createParentResponse.status, 201);
    const { session: parentSession } = await createParentResponse.json();

    const serverInfo = JSON.parse(await readFile(path.join(stateDir, "server.json"), "utf8"));
    const rejectedResponse = await fetch(`${baseUrl}/api/browser-use/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskPrompt: "Open https://example.com" }),
    });
    assert.equal(rejectedResponse.status, 403);

    const createBrowserResponse = await fetch(`${baseUrl}/api/browser-use/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vibe-research-browser-use-token": serverInfo.browserUseToken,
      },
      body: JSON.stringify({
        callerSessionId: parentSession.id,
        maxTurns: 7,
        taskPrompt: "Open https://example.com and report success.",
        title: "Example check",
      }),
    });
    assert.equal(createBrowserResponse.status, 201);
    const { session: browserSession } = await createBrowserResponse.json();
    assert.equal(browserSession.status, "queued");
    assert.equal(browserSession.maxTurns, 7);

    const runningSessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(runningSessionsResponse.status, 200);
    const runningSessionsPayload = await runningSessionsResponse.json();
    const runningSerializedParent = runningSessionsPayload.sessions.find((entry) => entry.id === parentSession.id);
    const runningBrowserSubagent = runningSerializedParent.subagents.find(
      (entry) => entry.browserUseSessionId === browserSession.id,
    );
    assert.equal(runningBrowserSubagent.name, "Example check");
    assert.equal(runningBrowserSubagent.source, "browser-use");
    assert.equal(runningBrowserSubagent.status, "working");

    const completed = await waitForBrowserUseStatus(baseUrl, browserSession.id, "completed");
    assert.equal(completed.result.summary, "Loaded example.com successfully.");
    assert.equal(completed.latestSnapshot.width, 800);
    assert.equal(completed.latestSnapshot.imageBase64, LARGE_SNAPSHOT_IMAGE_BASE64);
    assert.equal(completed.latestUrl, "https://example.com/");
    assert.equal(completed.activity.some((event) => event.type === "tool_started"), true);
    assert.equal(completed.activity.at(-1).type, "task_completed");
    assert.equal(completed.transcript.some((message) => message.role === "assistant"), true);

    assert.equal(workerCalls.length, 1);
    assert.equal(workerCalls[0].options.env.ANTHROPIC_API_KEY, "sk-test-browser-use");
    assert.equal(workerCalls[0].options.env.OTTOAUTH_PROFILE_DIR, path.join(workspaceDir, "profile"));
    assert.ok(workerCalls[0].args.includes("--headless"));
    assert.equal(workerCalls[0].args[workerCalls[0].args.indexOf("--max-turns") + 1], "7");

    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    const serializedParent = sessionsPayload.sessions.find((entry) => entry.id === parentSession.id);
    const browserSubagent = serializedParent.subagents.find((entry) => entry.browserUseSessionId === browserSession.id);
    assert.equal(browserSubagent, undefined);

    const { stdout: helperStdout } = await execFileAsync(
      process.execPath,
      [
        path.join(process.cwd(), "bin", "vr-browser-use"),
        "--task",
        "Open https://example.com and report success.",
        "--title",
        "Helper example check",
        "--max-steps",
        "5",
        "--wait",
        "--json",
      ],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          VIBE_RESEARCH_ROOT: stateDir,
          VIBE_RESEARCH_SESSION_ID: parentSession.id,
        },
        timeout: 8_000,
      },
    );
    const helperPayload = JSON.parse(helperStdout);
    assert.equal(helperPayload.status, "completed");
    assert.equal(helperPayload.summary, "Loaded example.com successfully.");
    assert.equal(helperPayload.latestUrl, "https://example.com/");
    assert.equal(helperPayload.maxTurns, 5);
    assert.equal(workerCalls.length, 2);
    assert.equal(workerCalls[1].args[workerCalls[1].args.indexOf("--max-turns") + 1], "5");
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("browser-use sessions can be terminated and deleted from under the caller", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-browser-use-delete-"));
  const stateDir = path.join(workspaceDir, ".vibe-research");
  const workerRoot = await createFakeWorkerRoot(workspaceDir);
  const workerCalls = [];

  const app = await createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd: workspaceDir,
    stateDir,
    persistSessions: false,
    persistentTerminals: false,
    browserUseServiceFactory: (settings, { stateDir: serviceStateDir, systemRootPath }) =>
      new BrowserUseService({
        settings,
        stateDir: serviceStateDir,
        systemRootPath,
        workerSpawner: createIdleWorkerSpawner(workerCalls),
      }),
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({
        enabled: settings.preventSleepEnabled,
        platform: "test",
      }),
  });
  const baseUrl = `http://127.0.0.1:${app.config.port}`;

  try {
    const setupResponse = await fetch(`${baseUrl}/api/browser-use/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anthropicApiKey: "sk-test-browser-use",
        enabled: true,
        profileDir: path.join(workspaceDir, "profile"),
        workerPath: workerRoot,
      }),
    });
    assert.equal(setupResponse.status, 200);

    const createParentResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "shell", name: "Caller" }),
    });
    assert.equal(createParentResponse.status, 201);
    const { session: parentSession } = await createParentResponse.json();

    const serverInfo = JSON.parse(await readFile(path.join(stateDir, "server.json"), "utf8"));
    const createBrowserResponse = await fetch(`${baseUrl}/api/browser-use/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vibe-research-browser-use-token": serverInfo.browserUseToken,
      },
      body: JSON.stringify({
        callerSessionId: parentSession.id,
        taskPrompt: "Keep the browser worker open until deleted.",
        title: "Delete me",
      }),
    });
    assert.equal(createBrowserResponse.status, 201);
    const { session: browserSession } = await createBrowserResponse.json();
    assert.equal(browserSession.status, "queued");

    const runningSessionsPayload = await (await fetch(`${baseUrl}/api/sessions`)).json();
    const runningSerializedParent = runningSessionsPayload.sessions.find((entry) => entry.id === parentSession.id);
    assert.ok(
      runningSerializedParent.subagents.some((entry) => entry.browserUseSessionId === browserSession.id),
    );

    const deleteResponse = await fetch(`${baseUrl}/api/browser-use/sessions/${browserSession.id}`, {
      method: "DELETE",
    });
    assert.equal(deleteResponse.status, 200);
    const deletePayload = await deleteResponse.json();
    assert.equal(deletePayload.session.status, "canceled");
    assert.equal(workerCalls.length, 1);
    assert.equal(workerCalls[0].child.killCalled, true);
    assert.equal(workerCalls[0].child.killSignal, "SIGTERM");

    const deletedResponse = await fetch(`${baseUrl}/api/browser-use/sessions/${browserSession.id}`);
    assert.equal(deletedResponse.status, 404);

    const sessionsPayload = await (await fetch(`${baseUrl}/api/sessions`)).json();
    const serializedParent = sessionsPayload.sessions.find((entry) => entry.id === parentSession.id);
    assert.equal(
      serializedParent.subagents.some((entry) => entry.browserUseSessionId === browserSession.id),
      false,
    );
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
