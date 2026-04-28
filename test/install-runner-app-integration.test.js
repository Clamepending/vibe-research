// Integration tests against the real Express app for the install-runner /
// MCP-launch-registry surface. Spawns a Vibe Research app on an ephemeral
// port and hits the routes via fetch().

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";

import { createVibeResearchApp } from "../src/create-app.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const shellProvider = {
  id: "shell",
  label: "Vanilla Shell",
  command: null,
  launchCommand: null,
  defaultName: "Shell",
  available: true,
};

async function tmp(prefix) {
  return mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function startApp(options = {}) {
  const cwd = options.cwd || (await tmp("vr-test-cwd"));
  const stateDir = options.stateDir || (await tmp("vr-test-state"));
  const app = await createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd,
    stateDir,
    persistSessions: false,
    persistentTerminals: false,
    providers: [shellProvider],
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({
        enabled: settings.preventSleepEnabled,
        platform: "test",
      }),
    ...options,
  });
  return {
    app,
    baseUrl: `http://127.0.0.1:${app.config.port}`,
    cleanup: async () => {
      await app.close();
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

test("GET /api/mcp/launches and /api/mcp/config return empty when no installs ran", async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    const launchesResp = await fetch(`${baseUrl}/api/mcp/launches`);
    assert.equal(launchesResp.status, 200);
    const launchesBody = await launchesResp.json();
    assert.deepEqual(launchesBody.launches, []);

    const configResp = await fetch(`${baseUrl}/api/mcp/config`);
    assert.equal(configResp.status, 200);
    const configBody = await configResp.json();
    assert.deepEqual(configBody, { mcpServers: {} });

    const stateResp = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateResp.status, 200);
    const state = await stateResp.json();
    assert.equal(state.mcp.totalLaunches, 0);
    assert.equal(state.mcp.unresolvedLaunches, 0);
    assert.deepEqual(state.mcp.buildings, []);
  } finally {
    await cleanup();
  }
});

test("install plan: declares an MCP launch + GET /api/mcp/launches surfaces it", async () => {
  // Use mcp-filesystem since its install plan requires no auth and runs
  // cleanly (just `command -v npx` + `npm view`).
  const { baseUrl, cleanup } = await startApp();
  try {
    // Trigger the install. Returns immediately with a job id.
    const startResp = await fetch(`${baseUrl}/api/buildings/mcp-filesystem/install`, { method: "POST" });
    assert.equal(startResp.status, 200);
    const { jobId } = await startResp.json();
    assert.ok(jobId);

    // Poll the job until it completes.
    const deadline = Date.now() + 60_000;
    let final = null;
    while (Date.now() < deadline) {
      const jobResp = await fetch(`${baseUrl}/api/buildings/mcp-filesystem/install/jobs/${jobId}`);
      const job = await jobResp.json();
      if (job.status !== "running") { final = job; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(final, "install job should complete");
    assert.equal(final.status, "ok", `expected ok, got ${final.status}: ${JSON.stringify(final.result)}`);

    // GET /api/mcp/launches should now include the filesystem entry.
    const launchesResp = await fetch(`${baseUrl}/api/mcp/launches`);
    const { launches } = await launchesResp.json();
    const fsEntry = launches.find((entry) => entry.buildingId === "mcp-filesystem");
    assert.ok(fsEntry, "mcp-filesystem entry should be in /api/mcp/launches");
    assert.equal(fsEntry.command, "npx");
    assert.ok(fsEntry.args.includes("@modelcontextprotocol/server-filesystem"));

    // GET /api/mcp/config should expose the same in claude_desktop shape.
    const configResp = await fetch(`${baseUrl}/api/mcp/config`);
    const config = await configResp.json();
    assert.ok(config.mcpServers["mcp-filesystem"], "config should include mcp-filesystem key");
    assert.equal(config.mcpServers["mcp-filesystem"].command, "npx");

    // GET /api/state should include the summary.
    const stateResp = await fetch(`${baseUrl}/api/state`);
    const state = await stateResp.json();
    assert.equal(state.mcp.totalLaunches, 1);
    assert.deepEqual(state.mcp.buildings, ["mcp-filesystem"]);
  } finally {
    await cleanup();
  }
});

test("install plan: PATCH /api/settings removing a building from installedPluginIds clears registry", async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    // Install mcp-filesystem.
    const startResp = await fetch(`${baseUrl}/api/buildings/mcp-filesystem/install`, { method: "POST" });
    const { jobId } = await startResp.json();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const j = await (await fetch(`${baseUrl}/api/buildings/mcp-filesystem/install/jobs/${jobId}`)).json();
      if (j.status !== "running") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // Sanity: the install left an entry in the registry.
    const before = await (await fetch(`${baseUrl}/api/mcp/launches`)).json();
    assert.equal(before.launches.some((entry) => entry.buildingId === "mcp-filesystem"), true);

    // Inject mcp-filesystem into installedPluginIds (the install endpoint
    // doesn't do this — only the client install button does, via the
    // settings PATCH). Then immediately remove it.
    await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installedPluginIds: ["mcp-filesystem"] }),
    });
    await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installedPluginIds: [] }),
    });

    // Removal of mcp-filesystem from installedPluginIds should have cleared
    // its registry entry.
    const after = await (await fetch(`${baseUrl}/api/mcp/launches`)).json();
    assert.equal(
      after.launches.some((entry) => entry.buildingId === "mcp-filesystem"),
      false,
      "uninstalled building's launches should be cleared",
    );
  } finally {
    await cleanup();
  }
});

test("GET /api/mcp/config/download: returns json with download disposition + matching body", async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    // Empty registry first — should still be a valid file with mcpServers: {}
    const empty = await fetch(`${baseUrl}/api/mcp/config/download`);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get("content-type"), "application/json; charset=utf-8");
    const dispEmpty = empty.headers.get("content-disposition");
    assert.ok(dispEmpty);
    assert.match(dispEmpty, /attachment/);
    assert.match(dispEmpty, /claude_desktop_config\.json/);
    const emptyBody = await empty.text();
    assert.ok(emptyBody.endsWith("\n"), "downloadable file must end in a newline");
    assert.deepEqual(JSON.parse(emptyBody), { mcpServers: {} });

    // Install a building so the file has actual content.
    const startResp = await fetch(`${baseUrl}/api/buildings/mcp-filesystem/install`, { method: "POST" });
    const { jobId } = await startResp.json();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const j = await (await fetch(`${baseUrl}/api/buildings/mcp-filesystem/install/jobs/${jobId}`)).json();
      if (j.status !== "running") break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // Download should now contain the entry.
    const dl = await fetch(`${baseUrl}/api/mcp/config/download`);
    assert.equal(dl.status, 200);
    const text = await dl.text();
    const parsed = JSON.parse(text);
    assert.ok(parsed.mcpServers["mcp-filesystem"]);
    // The downloadable form must match the body of /api/mcp/config exactly.
    const apiResp = await (await fetch(`${baseUrl}/api/mcp/config`)).json();
    assert.deepEqual(parsed, apiResp);
    // Pretty-printed (i.e. has at least one newline inside the body, not just at end).
    assert.ok(text.includes("\n  "), "downloadable file should be pretty-printed");
  } finally {
    await cleanup();
  }
});

test("install plan: ?resolved=1 interpolates ${settingKey} from live settings", async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    // Install mcp-github (auth-paste, will pause as auth-required, but the
    // mcp-launch declaration only lands when the install fully resolves —
    // so we paste the token first via settings PATCH, THEN install.
    await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcpGithubToken: "ghp_TEST_TOKEN_12345" }),
    });

    const startResp = await fetch(`${baseUrl}/api/buildings/mcp-github/install`, { method: "POST" });
    const { jobId } = await startResp.json();
    const deadline = Date.now() + 60_000;
    let final = null;
    while (Date.now() < deadline) {
      const j = await (await fetch(`${baseUrl}/api/buildings/mcp-github/install/jobs/${jobId}`)).json();
      if (j.status !== "running") { final = j; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(final);
    assert.equal(final.status, "ok", `expected ok with token pre-pasted, got ${final.status}`);

    // Without ?resolved the env should still contain ${mcpGithubToken}.
    const rawResp = await fetch(`${baseUrl}/api/mcp/launches`);
    const raw = await rawResp.json();
    const ghRaw = raw.launches.find((entry) => entry.buildingId === "mcp-github");
    assert.ok(ghRaw);
    assert.equal(ghRaw.env.GITHUB_PERSONAL_ACCESS_TOKEN, "${mcpGithubToken}");

    // With ?resolved=1 it should be interpolated.
    const resolvedResp = await fetch(`${baseUrl}/api/mcp/launches?resolved=1`);
    const resolved = await resolvedResp.json();
    const ghResolved = resolved.launches.find((entry) => entry.buildingId === "mcp-github");
    assert.equal(ghResolved.env.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_TEST_TOKEN_12345");
    assert.equal(ghResolved.unresolved, false);

    // The /api/state summary should reflect 1 launch, 0 unresolved.
    const state = await (await fetch(`${baseUrl}/api/state`)).json();
    assert.equal(state.mcp.totalLaunches, 1);
    assert.equal(state.mcp.unresolvedLaunches, 0);
  } finally {
    await cleanup();
  }
});
