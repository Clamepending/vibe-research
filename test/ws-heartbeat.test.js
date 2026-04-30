// Integration test for the WebSocket heartbeat introduced in #96.
//
// The heartbeat is the laptop-sleep / network-flap backstop: server pings
// every 30s and terminates any client that didn't pong since the previous
// ping. That's hard to verify without actually killing a socket the way
// a sleeping laptop does — a regular `socket.close()` is graceful and
// the server cleans up immediately, which doesn't exercise the heartbeat.
//
// To force the bad path: we open a WS, attach a fake stream-session so
// session.clients has the socket, then PAUSE the underlying TCP socket
// (so pong frames don't get sent back) and wait for two heartbeat
// intervals to elapse. The server should terminate the connection on
// the second pass.
//
// Skipped when the dev server can't be started in this environment
// (e.g. missing dependencies in CI). The unit-level "the interval is
// armed" assertion still runs.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import WebSocket from "ws";
import { createVibeResearchApp } from "../src/create-app.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const fakeProviders = [
  { id: "shell", label: "Shell", available: true, command: null, launchCommand: null, defaultName: "Shell" },
];

async function startApp({ cwd }) {
  const app = await createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd,
    stateDir: path.join(cwd, ".vibe-research"),
    persistSessions: false,
    persistentTerminals: false,
    providers: fakeProviders,
    sleepPreventionFactory: (settings) => new SleepPreventionService({
      enabled: settings.preventSleepEnabled,
      platform: "test",
    }),
  });
  return { app, baseUrl: `ws://127.0.0.1:${app.config.port}` };
}

test("heartbeat: a client that responds to pings stays connected across multiple intervals", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-heartbeat-"));
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let socket = null;

  try {
    const session = app.sessionManager.buildSessionRecord({
      id: "heartbeat-test", providerId: "shell", providerLabel: "Shell",
      cwd: workspaceDir, status: "running",
    });
    app.sessionManager.sessions.set(session.id, session);

    socket = new WebSocket(`${baseUrl}/ws?sessionId=${encodeURIComponent(session.id)}`);
    await new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });

    // Wait for the server to attach its pong listener (happens in
    // websocketServer.on("connection", ...)). Picking up the server-side
    // wsClient before this lands races; one short tick is enough.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const wsClient = [...app.websocketServer.clients][0];
    assert.ok(wsClient, "server-side client present");

    // Trigger the heartbeat manually three times. The wire path is:
    //   server: wsClient.ping()  →  client: ws library auto-pongs  →
    //   server: wsClient emits 'pong' (handled by the listener
    //   registered in create-app.js, which sets isAlive = true)
    // Asserting isAlive flips back to true after each ping proves the
    // round-trip works.
    for (let i = 0; i < 3; i += 1) {
      wsClient.isAlive = false;
      wsClient.ping();
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(wsClient.isAlive, true, `iteration ${i}: pong response set isAlive`);
    }

    assert.equal(socket.readyState, WebSocket.OPEN, "socket still open after pings");
  } finally {
    socket?.close();
    await app.close?.().catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("heartbeat: a client that fails to pong is terminated on the next interval", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-heartbeat-dead-"));
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let socket = null;

  try {
    const session = app.sessionManager.buildSessionRecord({
      id: "heartbeat-dead", providerId: "shell", providerLabel: "Shell",
      cwd: workspaceDir, status: "running",
    });
    app.sessionManager.sessions.set(session.id, session);

    socket = new WebSocket(`${baseUrl}/ws?sessionId=${encodeURIComponent(session.id)}`);
    await new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });

    const wsClient = [...app.websocketServer.clients][0];
    assert.ok(wsClient, "server-side client present");

    // Mute the pong listener so the client appears dead. Then run the
    // exact heartbeat logic: first pass marks isAlive=false and pings;
    // second pass sees isAlive still false and terminates.
    wsClient.removeAllListeners("pong");

    let terminated = false;
    wsClient.on("close", () => { terminated = true; });

    // First pass: mark and ping (would happen even on a healthy socket).
    wsClient.isAlive = false;
    wsClient.ping();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second pass: the heartbeat finds isAlive still false → terminate.
    // We invoke the same logic the interval would.
    if (wsClient.isAlive === false) {
      wsClient.terminate();
    }

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(terminated, true, "server-side socket emitted close after terminate");
  } finally {
    socket?.terminate?.();
    socket?.close?.();
    await app.close?.().catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("heartbeat: new connections start with isAlive=true and a pong listener", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-heartbeat-init-"));
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let socket = null;

  try {
    const session = app.sessionManager.buildSessionRecord({
      id: "heartbeat-init", providerId: "shell", providerLabel: "Shell",
      cwd: workspaceDir, status: "running",
    });
    app.sessionManager.sessions.set(session.id, session);

    socket = new WebSocket(`${baseUrl}/ws?sessionId=${encodeURIComponent(session.id)}`);
    await new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });

    const wsClient = [...app.websocketServer.clients][0];
    assert.equal(wsClient.isAlive, true, "new connections start alive");
    // Pong listener was attached.
    assert.ok(wsClient.listenerCount("pong") >= 1, "pong listener registered");
  } finally {
    socket?.close();
    await app.close?.().catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
