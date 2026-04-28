import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVibeResearchApp } from "../src/create-app.js";
import { GoogleOAuthTokenStore } from "../src/google-oauth-token-store.js";
import { GoogleService } from "../src/google-service.js";

function textResponse(payload, status = 200) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Response(body, {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function createFetch(responses = []) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = queue.shift();
    if (!next) {
      return textResponse({}, 200);
    }
    return textResponse(next.body ?? {}, next.status ?? 200);
  };
  fetchImpl.calls = calls;
  fetchImpl.push = (...responsesToAdd) => {
    queue.push(...responsesToAdd);
  };
  return fetchImpl;
}

function makeSettingsStore(overrides = {}) {
  return {
    settings: {
      googleOAuthClientId: "client-id-123",
      googleOAuthClientSecret: "client-secret-xyz",
      ...overrides,
    },
  };
}

test("GoogleService.exchangeAuthCode POSTs form body and persists tokens", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-google-exchange-"));
  try {
    const tokenStore = new GoogleOAuthTokenStore({ stateDir });
    await tokenStore.load();
    const fetchImpl = createFetch([
      {
        body: {
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          scope:
            "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events",
          token_type: "Bearer",
        },
      },
    ]);
    const service = new GoogleService({
      tokenStore,
      settingsStore: makeSettingsStore(),
      fetchImpl,
    });

    const before = Date.now();
    await service.exchangeAuthCode({
      buildingId: "google-calendar",
      code: "auth-code-1",
      redirectUri: "http://127.0.0.1:9999/api/google/oauth/callback",
    });
    const after = Date.now();

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, "https://oauth2.googleapis.com/token");
    const sentBody = new URLSearchParams(fetchImpl.calls[0].options.body);
    assert.equal(sentBody.get("grant_type"), "authorization_code");
    assert.equal(sentBody.get("code"), "auth-code-1");
    assert.equal(sentBody.get("client_id"), "client-id-123");
    assert.equal(sentBody.get("client_secret"), "client-secret-xyz");
    assert.equal(
      sentBody.get("redirect_uri"),
      "http://127.0.0.1:9999/api/google/oauth/callback",
    );

    const stored = JSON.parse(
      await readFile(path.join(stateDir, "google-tokens.json"), "utf8"),
    );
    assert.equal(stored.tokens["google-calendar"].accessToken, "access-1");
    assert.equal(stored.tokens["google-calendar"].refreshToken, "refresh-1");
    assert.deepEqual(stored.tokens["google-calendar"].scopes, [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ]);
    const expiresAt = stored.tokens["google-calendar"].expiresAt;
    assert.ok(
      expiresAt >= before + 3600 * 1000 - 60_000 - 1000 &&
        expiresAt <= after + 3600 * 1000 - 60_000 + 1000,
      `expected expiresAt to account for 60s skew, got ${expiresAt}`,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("GoogleService.getValidAccessToken returns stored token when fresh", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-google-valid-"));
  try {
    const tokenStore = new GoogleOAuthTokenStore({ stateDir });
    await tokenStore.load();
    await tokenStore.setTokens("google-calendar", {
      accessToken: "still-fresh",
      refreshToken: "refresh-zzz",
      expiresAt: Date.now() + 10 * 60 * 1000,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    const fetchImpl = createFetch();
    const service = new GoogleService({
      tokenStore,
      settingsStore: makeSettingsStore(),
      fetchImpl,
    });

    const accessToken = await service.getValidAccessToken("google-calendar");
    assert.equal(accessToken, "still-fresh");
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("GoogleService.getValidAccessToken triggers refresh when expired", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-google-refresh-"));
  try {
    const tokenStore = new GoogleOAuthTokenStore({ stateDir });
    await tokenStore.load();
    await tokenStore.setTokens("google-calendar", {
      accessToken: "stale",
      refreshToken: "refresh-abc",
      expiresAt: Date.now() - 10_000,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    const fetchImpl = createFetch([
      {
        body: {
          access_token: "fresh-access",
          expires_in: 1800,
          token_type: "Bearer",
        },
      },
    ]);
    const service = new GoogleService({
      tokenStore,
      settingsStore: makeSettingsStore(),
      fetchImpl,
    });

    const before = Date.now();
    const accessToken = await service.getValidAccessToken("google-calendar");
    const after = Date.now();

    assert.equal(accessToken, "fresh-access");
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, "https://oauth2.googleapis.com/token");
    const sentBody = new URLSearchParams(fetchImpl.calls[0].options.body);
    assert.equal(sentBody.get("grant_type"), "refresh_token");
    assert.equal(sentBody.get("refresh_token"), "refresh-abc");

    const tokens = tokenStore.getTokens("google-calendar");
    assert.equal(tokens.accessToken, "fresh-access");
    assert.equal(tokens.refreshToken, "refresh-abc");
    assert.ok(
      tokens.expiresAt >= before + 1800 * 1000 - 60_000 - 1000 &&
        tokens.expiresAt <= after + 1800 * 1000 - 60_000 + 1000,
      `expected expiresAt to update, got ${tokens.expiresAt}`,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("GoogleService.refreshAccessToken preserves existing refresh token when Google omits one", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-google-preserve-"));
  try {
    const tokenStore = new GoogleOAuthTokenStore({ stateDir });
    await tokenStore.load();
    await tokenStore.setTokens("google-calendar", {
      accessToken: "old",
      refreshToken: "refresh-keep",
      expiresAt: Date.now() - 5_000,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    const fetchImpl = createFetch([
      {
        body: {
          access_token: "fresh",
          expires_in: 3600,
          token_type: "Bearer",
        },
      },
    ]);
    const service = new GoogleService({
      tokenStore,
      settingsStore: makeSettingsStore(),
      fetchImpl,
    });

    await service.refreshAccessToken("google-calendar");
    const tokens = tokenStore.getTokens("google-calendar");
    assert.equal(tokens.accessToken, "fresh");
    assert.equal(tokens.refreshToken, "refresh-keep");
    assert.deepEqual(tokens.scopes, [
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("GoogleService.listCalendarEvents builds URL and sends Authorization header", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-google-list-"));
  try {
    const tokenStore = new GoogleOAuthTokenStore({ stateDir });
    await tokenStore.load();
    await tokenStore.setTokens("google-calendar", {
      accessToken: "bearer-token-1",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    const fetchImpl = createFetch([
      {
        body: { items: [{ id: "event-1", summary: "Standup" }] },
      },
    ]);
    const service = new GoogleService({
      tokenStore,
      settingsStore: makeSettingsStore(),
      fetchImpl,
    });

    const result = await service.listCalendarEvents({
      calendarId: "primary",
      timeMin: "2026-04-23T00:00:00Z",
      timeMax: "2026-04-24T00:00:00Z",
      maxResults: 10,
      q: "standup",
    });

    assert.deepEqual(result, { items: [{ id: "event-1", summary: "Standup" }] });
    assert.equal(fetchImpl.calls.length, 1);
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(url.pathname, "/calendar/v3/calendars/primary/events");
    assert.equal(url.searchParams.get("timeMin"), "2026-04-23T00:00:00Z");
    assert.equal(url.searchParams.get("timeMax"), "2026-04-24T00:00:00Z");
    assert.equal(url.searchParams.get("maxResults"), "10");
    assert.equal(url.searchParams.get("singleEvents"), "true");
    assert.equal(url.searchParams.get("orderBy"), "startTime");
    assert.equal(url.searchParams.get("q"), "standup");
    assert.equal(
      fetchImpl.calls[0].options.headers.Authorization,
      "Bearer bearer-token-1",
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("GoogleService retries once on 401 with refreshed token", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-google-retry-"));
  try {
    const tokenStore = new GoogleOAuthTokenStore({ stateDir });
    await tokenStore.load();
    await tokenStore.setTokens("google-calendar", {
      accessToken: "expired-access",
      refreshToken: "refresh-abc",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    const fetchImpl = createFetch([
      { body: { error: { code: 401, message: "Invalid Credentials" } }, status: 401 },
      {
        body: {
          access_token: "recovered-access",
          expires_in: 3600,
        },
      },
      { body: { items: [{ id: "event-retry" }] } },
    ]);
    const service = new GoogleService({
      tokenStore,
      settingsStore: makeSettingsStore(),
      fetchImpl,
    });

    const result = await service.listCalendarEvents({ calendarId: "primary" });
    assert.deepEqual(result, { items: [{ id: "event-retry" }] });
    assert.equal(fetchImpl.calls.length, 3);
    assert.equal(fetchImpl.calls[1].url, "https://oauth2.googleapis.com/token");
    assert.equal(
      fetchImpl.calls[2].options.headers.Authorization,
      "Bearer recovered-access",
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("GoogleService.searchGmailThreads builds the right URL", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-google-gmail-"));
  try {
    const tokenStore = new GoogleOAuthTokenStore({ stateDir });
    await tokenStore.load();
    await tokenStore.setTokens("gmail", {
      accessToken: "gmail-token",
      refreshToken: "gmail-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    const fetchImpl = createFetch([
      { body: { threads: [{ id: "thread-1" }], resultSizeEstimate: 1 } },
    ]);
    const service = new GoogleService({
      tokenStore,
      settingsStore: makeSettingsStore(),
      fetchImpl,
    });

    const result = await service.searchGmailThreads({
      q: "from:alice@example.com",
      maxResults: 5,
      pageToken: "tok-1",
    });

    assert.deepEqual(result, { threads: [{ id: "thread-1" }], resultSizeEstimate: 1 });
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.origin, "https://gmail.googleapis.com");
    assert.equal(url.pathname, "/gmail/v1/users/me/threads");
    assert.equal(url.searchParams.get("q"), "from:alice@example.com");
    assert.equal(url.searchParams.get("maxResults"), "5");
    assert.equal(url.searchParams.get("pageToken"), "tok-1");
    assert.equal(
      fetchImpl.calls[0].options.headers.Authorization,
      "Bearer gmail-token",
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("createVibeResearchApp exposes /api/google/calendar/events using stored tokens", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-google-app-"));
  const stateDir = path.join(workspaceDir, ".vibe-research");
  let appContext = null;
  const fetchImpl = createFetch([
    { body: { items: [{ id: "event-app", summary: "App-level meeting" }] } },
  ]);

  try {
    // Pre-seed tokens
    const seedStore = new GoogleOAuthTokenStore({ stateDir });
    await seedStore.load();
    await seedStore.setTokens("google-calendar", {
      accessToken: "seeded-access",
      refreshToken: "seeded-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });

    appContext = await createVibeResearchApp({
      cwd: workspaceDir,
      port: 0,
      persistSessions: false,
      persistentTerminals: false,
      stateDir,
      providers: [
        {
          id: "claude",
          label: "Claude Code",
          available: true,
          defaultName: "Claude",
          command: "node",
          args: ["-e", "setInterval(() => {}, 1000)"],
        },
      ],
      systemMetricsSampleIntervalMs: 0,
      googleFetchImpl: fetchImpl,
    });

    const baseUrl = `http://127.0.0.1:${appContext.config.port}`;
    const response = await fetch(
      `${baseUrl}/api/google/calendar/events?calendarId=primary&timeMin=${encodeURIComponent(
        "2026-04-23T00:00:00Z",
      )}&maxResults=3`,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload, {
      items: [{ id: "event-app", summary: "App-level meeting" }],
    });

    assert.equal(fetchImpl.calls.length, 1);
    const requestedUrl = new URL(fetchImpl.calls[0].url);
    assert.equal(requestedUrl.pathname, "/calendar/v3/calendars/primary/events");
    assert.equal(requestedUrl.searchParams.get("timeMin"), "2026-04-23T00:00:00Z");
    assert.equal(requestedUrl.searchParams.get("maxResults"), "3");
    assert.equal(
      fetchImpl.calls[0].options.headers.Authorization,
      "Bearer seeded-access",
    );
  } finally {
    await appContext?.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("GoogleService.searchDriveFiles builds URL with q and pageSize and sends Authorization header", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-google-drive-search-"));
  try {
    const tokenStore = new GoogleOAuthTokenStore({ stateDir });
    await tokenStore.load();
    await tokenStore.setTokens("google-drive", {
      accessToken: "drive-token",
      refreshToken: "drive-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const fetchImpl = createFetch([
      { body: { files: [{ id: "f-1", name: "Project Plan", mimeType: "application/vnd.google-apps.document" }] } },
    ]);
    const service = new GoogleService({
      tokenStore,
      settingsStore: makeSettingsStore(),
      fetchImpl,
    });

    const result = await service.searchDriveFiles({
      q: "name contains 'project' and trashed=false",
      pageSize: 5,
      pageToken: "page-2",
      orderBy: "modifiedTime desc",
    });

    assert.deepEqual(result, {
      files: [{ id: "f-1", name: "Project Plan", mimeType: "application/vnd.google-apps.document" }],
    });
    assert.equal(fetchImpl.calls.length, 1);
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(url.pathname, "/drive/v3/files");
    assert.equal(url.searchParams.get("q"), "name contains 'project' and trashed=false");
    assert.equal(url.searchParams.get("pageSize"), "5");
    assert.equal(url.searchParams.get("pageToken"), "page-2");
    assert.equal(url.searchParams.get("orderBy"), "modifiedTime desc");
    assert.equal(
      fetchImpl.calls[0].options.headers.Authorization,
      "Bearer drive-token",
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("GoogleService.getDriveFile encodes fileId path segment", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-google-drive-get-"));
  try {
    const tokenStore = new GoogleOAuthTokenStore({ stateDir });
    await tokenStore.load();
    await tokenStore.setTokens("google-drive", {
      accessToken: "drive-token",
      refreshToken: "drive-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const fetchImpl = createFetch([
      { body: { id: "weird/id+thing", name: "Doc" } },
    ]);
    const service = new GoogleService({
      tokenStore,
      settingsStore: makeSettingsStore(),
      fetchImpl,
    });

    await service.getDriveFile({ fileId: "weird/id+thing" });

    assert.equal(fetchImpl.calls.length, 1);
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.pathname, "/drive/v3/files/weird%2Fid%2Bthing");
    assert.equal(
      fetchImpl.calls[0].options.headers.Authorization,
      "Bearer drive-token",
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("GoogleService.exportDriveFile returns body + content-type", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-google-drive-export-"));
  try {
    const tokenStore = new GoogleOAuthTokenStore({ stateDir });
    await tokenStore.load();
    await tokenStore.setTokens("google-drive", {
      accessToken: "drive-token",
      refreshToken: "drive-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const fetchImpl = async (url, options = {}) => {
      fetchImpl.calls.push({ url: String(url), options });
      return new Response("doc body line 1\ndoc body line 2\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    };
    fetchImpl.calls = [];
    const service = new GoogleService({
      tokenStore,
      settingsStore: makeSettingsStore(),
      fetchImpl,
    });

    const result = await service.exportDriveFile({ fileId: "doc-123", mimeType: "text/plain" });

    assert.equal(result.body, "doc body line 1\ndoc body line 2\n");
    assert.equal(result.contentType, "text/plain");
    assert.equal(fetchImpl.calls.length, 1);
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.pathname, "/drive/v3/files/doc-123/export");
    assert.equal(url.searchParams.get("mimeType"), "text/plain");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("createVibeResearchApp exposes /api/google/drive/files using stored tokens", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-google-drive-app-"));
  const stateDir = path.join(workspaceDir, ".vibe-research");
  let appContext = null;
  const fetchImpl = createFetch([
    {
      body: {
        files: [
          { id: "drive-file-1", name: "Roadmap", mimeType: "application/vnd.google-apps.document" },
        ],
      },
    },
  ]);

  try {
    const seedStore = new GoogleOAuthTokenStore({ stateDir });
    await seedStore.load();
    await seedStore.setTokens("google-drive", {
      accessToken: "drive-seeded",
      refreshToken: "drive-seeded-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });

    appContext = await createVibeResearchApp({
      cwd: workspaceDir,
      port: 0,
      persistSessions: false,
      persistentTerminals: false,
      stateDir,
      providers: [
        {
          id: "claude",
          label: "Claude Code",
          available: true,
          defaultName: "Claude",
          command: "node",
          args: ["-e", "setInterval(() => {}, 1000)"],
        },
      ],
      systemMetricsSampleIntervalMs: 0,
      googleFetchImpl: fetchImpl,
    });

    const baseUrl = `http://127.0.0.1:${appContext.config.port}`;
    const response = await fetch(
      `${baseUrl}/api/google/drive/files?q=${encodeURIComponent(
        "name contains 'roadmap' and trashed=false",
      )}&pageSize=5`,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload, {
      files: [
        { id: "drive-file-1", name: "Roadmap", mimeType: "application/vnd.google-apps.document" },
      ],
    });

    assert.equal(fetchImpl.calls.length, 1);
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.pathname, "/drive/v3/files");
    assert.equal(url.searchParams.get("q"), "name contains 'roadmap' and trashed=false");
    assert.equal(url.searchParams.get("pageSize"), "5");
    assert.equal(
      fetchImpl.calls[0].options.headers.Authorization,
      "Bearer drive-seeded",
    );
  } finally {
    await appContext?.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
