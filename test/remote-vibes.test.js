import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createRemoteVibesApp } from "../src/create-app.js";

async function login(baseUrl, passcode) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ passcode }),
  });

  assert.equal(response.status, 200);
  const cookieHeader = response.headers.get("set-cookie");
  assert.ok(cookieHeader);
  return cookieHeader.split(";")[0];
}

async function startApp() {
  const app = await createRemoteVibesApp({
    host: "127.0.0.1",
    port: 0,
    cwd: process.cwd(),
    passcode: "test-passcode",
  });

  return {
    app,
    baseUrl: `http://127.0.0.1:${app.config.port}`,
  };
}

test("requires login before state is visible", async () => {
  const { app, baseUrl } = await startApp();

  try {
    const unauthenticated = await fetch(`${baseUrl}/api/state`);
    assert.equal(unauthenticated.status, 401);

    const publicConfig = await fetch(`${baseUrl}/api/public-config`).then((response) => response.json());
    assert.equal(publicConfig.appName, "Remote Vibes");
    assert.equal(publicConfig.passcodeHint, "te");

    const cookie = await login(baseUrl, "test-passcode");
    const stateResponse = await fetch(`${baseUrl}/api/state`, {
      headers: {
        Cookie: cookie,
      },
    });

    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.defaultProviderId, "claude");
    assert.ok(state.providers.some((provider) => provider.id === "shell" && provider.available));
  } finally {
    await app.close();
  }
});

test("shell session streams websocket output and honors custom cwd", async () => {
  const { app, baseUrl } = await startApp();

  try {
    const cookie = await login(baseUrl, "test-passcode");
    const requestedCwd = path.join(os.tmpdir());
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
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

    const websocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?sessionId=${session.id}`, {
      headers: {
        Cookie: cookie,
      },
    });

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
      headers: {
        Cookie: cookie,
      },
    });

    assert.equal(deleteResponse.status, 200);
  } finally {
    await app.close();
  }
});

test("rejects an invalid working directory", async () => {
  const { app, baseUrl } = await startApp();

  try {
    const cookie = await login(baseUrl, "test-passcode");
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
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
