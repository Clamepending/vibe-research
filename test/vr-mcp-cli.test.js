// Live integration tests for bin/vr-mcp. Spins up an ephemeral-port
// app, points the CLI at it via VIBE_RESEARCH_URL, runs the
// subcommands, and asserts on the JSON output.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";

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

const VR_MCP = path.resolve("bin/vr-mcp");

async function tmp(prefix) {
  return mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function startApp() {
  const cwd = await tmp("vr-mcp-cli-cwd");
  const stateDir = await tmp("vr-mcp-cli-state");
  // Disable scheduler + auto-sync — same reasons as the other
  // integration tests.
  const previousScheduleEnv = process.env.VIBE_RESEARCH_MCP_HEALTH_SCHEDULE;
  const previousAutoSyncEnv = process.env.VIBE_RESEARCH_MCP_AUTO_SYNC;
  process.env.VIBE_RESEARCH_MCP_HEALTH_SCHEDULE = "off";
  process.env.VIBE_RESEARCH_MCP_AUTO_SYNC = "off";
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
  });
  if (previousScheduleEnv === undefined) delete process.env.VIBE_RESEARCH_MCP_HEALTH_SCHEDULE;
  else process.env.VIBE_RESEARCH_MCP_HEALTH_SCHEDULE = previousScheduleEnv;
  if (previousAutoSyncEnv === undefined) delete process.env.VIBE_RESEARCH_MCP_AUTO_SYNC;
  else process.env.VIBE_RESEARCH_MCP_AUTO_SYNC = previousAutoSyncEnv;
  return {
    app,
    baseUrl: `http://127.0.0.1:${app.config.port}`,
    cleanup: async () => {
      try { await app.close(); } catch { /* best effort */ }
      // Tolerate ENOTEMPTY: the app's background guide-writer may still be
      // flushing to stateDir/vibe-research-system/building-guides as we
      // try to nuke it. The OS handles the next attempt.
      try { await rm(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
      try { await rm(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

// Async spawn so the test runner's event loop can keep serving HTTP from
// the embedded Express app. spawnSync would deadlock: it blocks the
// loop, the child's fetch to the embedded server never gets answered,
// and the child times out.
function runCli(baseUrl, args, { timeoutMs = 90_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_MCP, ...args], {
      env: { ...process.env, VIBE_RESEARCH_URL: baseUrl, ...env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      settle(null, "SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      settle(null, null);
    });
    child.on("exit", (code, signal) => settle(code, signal));
  });
}

test("vr-mcp: no args prints help + exits 2", () => {
  const result = spawnSync("node", [VR_MCP], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /vr-mcp — agent-callable CLI/);
});

test("vr-mcp --help: exits 0", () => {
  const result = spawnSync("node", [VR_MCP, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /vr-mcp — agent-callable CLI/);
});

test("vr-mcp: unknown subcommand exits 2 with help", () => {
  const result = spawnSync("node", [VR_MCP, "make-coffee"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown subcommand: make-coffee/);
});

test("vr-mcp: unknown flag exits 2", () => {
  const result = spawnSync("node", [VR_MCP, "list", "--no-such-flag"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown flag/);
});

test("vr-mcp list: returns server summary against a fresh app", async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    const result = await runCli(baseUrl, ["list", "--json"]);
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.server, baseUrl);
    assert.deepEqual(body.mcp.activeBuildings, []);
    assert.equal(body.mcp.totalLaunches, 0);
    assert.deepEqual(body.installedPluginIds, []);
  } finally {
    await cleanup();
  }
});

test("vr-mcp install <id>: kicks off install, polls to ok", { timeout: 180_000 }, async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    const result = await runCli(baseUrl, ["install", "mcp-filesystem", "--json"], { timeoutMs: 90_000 });
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.status, "ok", `install status: ${body.status}`);
    assert.equal(body.buildingId, "mcp-filesystem");
  } finally {
    await cleanup();
  }
});

test("vr-mcp install: 404 for unknown id exits 1", { timeout: 60_000 }, async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    const result = await runCli(baseUrl, ["install", "no-such-building", "--json"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /POST.*install failed.*Building not found/);
  } finally {
    await cleanup();
  }
});

test("vr-mcp status <id>: shows resolved launch after install", { timeout: 180_000 }, async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    await runCli(baseUrl, ["install", "mcp-filesystem", "--json"], { timeoutMs: 90_000 });
    const result = await runCli(baseUrl, ["status", "mcp-filesystem", "--json"]);
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.buildingId, "mcp-filesystem");
    assert.ok(body.launches.length >= 1);
    assert.equal(body.launches[0].buildingId, "mcp-filesystem");
  } finally {
    await cleanup();
  }
});

test("vr-mcp status: no arg shows all launches", { timeout: 180_000 }, async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    await runCli(baseUrl, ["install", "mcp-filesystem", "--json"], { timeoutMs: 90_000 });
    const result = await runCli(baseUrl, ["status", "--json"]);
    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.buildingId, "(all)");
    assert.equal(body.launches.length, 1);
  } finally {
    await cleanup();
  }
});

test("vr-mcp uninstall: removes from registry", { timeout: 180_000 }, async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    await runCli(baseUrl, ["install", "mcp-filesystem", "--json"], { timeoutMs: 90_000 });
    const result = await runCli(baseUrl, ["uninstall", "mcp-filesystem", "--json"]);
    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.removedFromRegistry, true);
    // Status after uninstall — empty launches list.
    const after = await runCli(baseUrl, ["status", "--json"]);
    assert.equal(JSON.parse(after.stdout).launches.length, 0);
  } finally {
    await cleanup();
  }
});

test("vr-mcp handshake: returns tool count for live filesystem MCP", { timeout: 120_000 }, async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    // Set mcpFilesystemRoots BEFORE install so the launch resolves.
    await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcpFilesystemRoots: "/tmp" }),
    });
    await runCli(baseUrl, ["install", "mcp-filesystem", "--json"], { timeoutMs: 90_000 });
    // (no-op fetch retained for clarity; previously a stale call site)
    await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcpFilesystemRoots: "/tmp" }),
    });
    const result = await runCli(baseUrl, ["handshake", "mcp-filesystem", "--json"], { timeoutMs: 60_000 });
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.results[0].status, "tools-listed");
    assert.ok(body.results[0].toolCount >= 4, `expected >=4 tools, got ${body.results[0].toolCount}`);
  } finally {
    await cleanup();
  }
});

test("vr-mcp tools: surfaces server name + tool count via handshake", { timeout: 120_000 }, async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    await runCli(baseUrl, ["install", "mcp-filesystem", "--json"], { timeoutMs: 90_000 });
    await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcpFilesystemRoots: "/tmp" }),
    });
    const result = await runCli(baseUrl, ["tools", "mcp-filesystem", "--json"], { timeoutMs: 60_000 });
    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.buildingId, "mcp-filesystem");
    assert.ok(body.serverName, "tools should report server name");
    assert.ok(body.toolCount >= 4);
  } finally {
    await cleanup();
  }
});

test("vr-mcp sync: returns sync result", { timeout: 60_000 }, async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    // Sandbox HOME so the sync writes don't touch the real ~/.claude.json.
    const fakeHome = await tmp("vr-mcp-cli-fakehome");
    try {
      const result = await runCli(baseUrl, ["sync", "--json"], { env: { HOME: fakeHome } });
      assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
      const body = JSON.parse(result.stdout);
      assert.ok(body.claude);
      assert.ok(body.codex);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  } finally {
    await cleanup();
  }
});

test("vr-mcp health: bulk handshake of an empty registry returns 0/0", async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    const result = await runCli(baseUrl, ["health", "--json"]);
    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.summary.total, 0);
    assert.equal(body.summary.broken, 0);
  } finally {
    await cleanup();
  }
});

test("vr-mcp install --no-wait: returns the running job id without polling", { timeout: 60_000 }, async () => {
  const { baseUrl, cleanup } = await startApp();
  try {
    const result = await runCli(baseUrl, ["install", "mcp-filesystem", "--json", "--no-wait"]);
    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.ok(body.jobId);
    assert.equal(body.status, "running");
  } finally {
    await cleanup();
  }
});
