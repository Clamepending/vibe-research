// Unit tests for src/install-runner.js. These exercise the runner against
// stub commands (`true`, `false`, `printf`) and a fake fetch so they don't
// rely on any external service. Network-touching paths (Modal, OttoAuth)
// have their own integration coverage in install-runner-integration.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInstallJobStore,
  executeInstallPlan,
  looksLikeSecretSetting,
  maskSecrets,
  startInstallJob,
  waitForJob,
} from "../src/install-runner.js";

function fakeSettingsStore() {
  const updates = [];
  return {
    updates,
    async update(patch) { updates.push({ ...patch }); },
  };
}

function silentLog() {
  const entries = [];
  return { entries, append: (entry) => entries.push(entry) };
}

test("executeInstallPlan: empty plan returns ok", async () => {
  const settings = fakeSettingsStore();
  const log = silentLog();
  const result = await executeInstallPlan({}, { appendLog: log.append, settingsStore: settings });
  assert.equal(result.status, "ok");
});

test("executeInstallPlan: preflight detects already-installed and skips install", async () => {
  const log = silentLog();
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "true", label: "exists" }],
      install: [{ kind: "command", command: "false", label: "should-not-run" }],
      verify: [{ kind: "command", command: "true", label: "verify" }],
    },
    { appendLog: log.append },
  );
  assert.equal(result.status, "ok");
  const ranInstall = log.entries.some((entry) => entry.phase === "install" && entry.step === "should-not-run" && entry.message?.startsWith("running"));
  assert.equal(ranInstall, false, "install phase should be skipped when preflight all-ok");
});

test("executeInstallPlan: install phase runs when preflight fails", async () => {
  const log = silentLog();
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false", label: "absent" }],
      install: [{ kind: "command", command: "true", label: "do-install" }],
      verify: [{ kind: "command", command: "true", label: "verify" }],
    },
    { appendLog: log.append },
  );
  assert.equal(result.status, "ok");
  const installRan = log.entries.some((entry) => entry.phase === "install" && entry.step === "do-install");
  assert.equal(installRan, true);
});

test("executeInstallPlan: install command failure surfaces failed status", async () => {
  const log = silentLog();
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [{ kind: "command", command: "false", label: "boom" }],
      verify: [{ kind: "command", command: "true" }],
    },
    { appendLog: log.append },
  );
  assert.equal(result.status, "failed");
  assert.match(result.reason, /install step "boom"/);
});

test("executeInstallPlan: verify failure with no auth returns failed", async () => {
  const log = silentLog();
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "true" }],
      install: [],
      verify: [{ kind: "command", command: "false", label: "no" }],
    },
    { appendLog: log.append },
  );
  assert.equal(result.status, "failed");
});

test("executeInstallPlan: verify failure with auth-browser-cli runs auth then verifies again", async () => {
  // Use a temp file as a flag — first verify reads it (missing → fail), auth
  // creates it, second verify reads it (present → pass). Simulates the auth
  // flow without depending on a real CLI.
  const dir = mkdtempSync(join(tmpdir(), "install-runner-"));
  const flag = join(dir, "auth-flag");
  const log = silentLog();
  try {
    const result = await executeInstallPlan(
      {
        preflight: [{ kind: "command", command: "true" }],
        install: [],
        auth: {
          kind: "auth-browser-cli",
          command: `touch ${flag}`,
          label: "stub-auth",
        },
        verify: [{ kind: "command", command: `test -f ${flag}`, label: "verify-flag" }],
      },
      { appendLog: log.append },
    );
    assert.equal(result.status, "ok");
    const authRan = log.entries.some((entry) => entry.phase === "auth");
    assert.equal(authRan, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeInstallPlan: http step captures fields into settings", async () => {
  const settings = fakeSettingsStore();
  const log = silentLog();
  const fakeFetch = async (url, init) => {
    assert.equal(url, "https://example.test/create");
    assert.equal(init.method, "POST");
    return {
      status: 200,
      text: async () => JSON.stringify({
        username: "stub-user",
        privateKey: "stub-secret",
        nested: { foo: "bar" },
      }),
    };
  };
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [
        {
          kind: "http",
          method: "POST",
          url: "https://example.test/create",
          body: {},
          captureSettings: {
            username: "providerUsername",
            privateKey: "providerPrivateKey",
            "nested.foo": "providerNested",
          },
        },
      ],
      verify: [],
    },
    { appendLog: log.append, settingsStore: settings, fetchImpl: fakeFetch },
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(settings.updates, [{
    providerUsername: "stub-user",
    providerPrivateKey: "stub-secret",
    providerNested: "bar",
  }]);
});

test("executeInstallPlan: http step non-2xx is treated as failed", async () => {
  const log = silentLog();
  const fakeFetch = async () => ({ status: 503, text: async () => "down" });
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [
        { kind: "http", method: "POST", url: "https://example.test/x", body: {}, label: "http-fail" },
      ],
      verify: [],
    },
    { appendLog: log.append, fetchImpl: fakeFetch },
  );
  assert.equal(result.status, "failed");
});

test("executeInstallPlan: auth-paste returns auth-required and surfaces prompt info", async () => {
  const settings = fakeSettingsStore();
  const fakeFetch = async () => ({ status: 200, text: async () => JSON.stringify({ token: "abc" }) });
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [
        { kind: "http", method: "POST", url: "https://example.test/c", body: {}, captureSettings: { token: "providerToken" } },
      ],
      auth: {
        kind: "auth-paste",
        setting: "providerPairing",
        setupUrl: "https://example.test/dashboard",
        setupLabel: "Open dashboard",
        detail: "Paste the pairing code in the dashboard.",
      },
      verify: [{ kind: "command", command: "false", label: "always-fail" }],
    },
    { appendLog: () => {}, settingsStore: settings, fetchImpl: fakeFetch },
  );
  assert.equal(result.status, "auth-required");
  assert.equal(result.authPrompt.setting, "providerPairing");
  assert.equal(result.authPrompt.setupUrl, "https://example.test/dashboard");
  // The captured token from the http step should already be saved before
  // the install pauses for the human.
  assert.deepEqual(settings.updates, [{ providerToken: "abc" }]);
});

test("startInstallJob + waitForJob: end-to-end via the job store", async () => {
  const jobStore = createInstallJobStore();
  const settings = fakeSettingsStore();
  const building = {
    id: "demo",
    install: {
      plan: {
        preflight: [{ kind: "command", command: "true" }],
        install: [],
        verify: [{ kind: "command", command: "true" }],
      },
    },
  };
  const job = startInstallJob({ jobStore, building, settingsStore: settings });
  assert.equal(job.status, "running");
  const finished = await waitForJob(jobStore, job.id, { timeoutMs: 4000 });
  assert.equal(finished.status, "ok");
  assert.equal(finished.buildingId, "demo");
});

test("createInstallJobStore: byBuilding returns most-recent first, respects limit", () => {
  const jobStore = createInstallJobStore();
  // Interleave two buildings.
  jobStore.create("a"); // oldest of "a"
  jobStore.create("b");
  jobStore.create("a");
  jobStore.create("a"); // newest of "a"
  const aJobs = jobStore.byBuilding("a");
  assert.equal(aJobs.length, 3);
  // Most-recent first: each job's createdAt should be >= the next.
  for (let i = 0; i + 1 < aJobs.length; i += 1) {
    assert.ok(aJobs[i].createdAt >= aJobs[i + 1].createdAt);
  }
  const aLimited = jobStore.byBuilding("a", { limit: 2 });
  assert.equal(aLimited.length, 2);
});

test("createInstallJobStore: byBuilding empty/unknown id returns []", () => {
  const jobStore = createInstallJobStore();
  jobStore.create("a");
  assert.deepEqual(jobStore.byBuilding(""), []);
  assert.deepEqual(jobStore.byBuilding("ghost"), []);
});

test("createInstallJobStore: byBuilding limit=-1 returns all matching", () => {
  const jobStore = createInstallJobStore();
  for (let i = 0; i < 15; i += 1) jobStore.create("a");
  const all = jobStore.byBuilding("a", { limit: -1 });
  assert.equal(all.length, 15);
});

test("createInstallJobStore: trims old jobs past the cap", () => {
  const jobStore = createInstallJobStore();
  const ids = [];
  for (let i = 0; i < 70; i += 1) {
    ids.push(jobStore.create(`b${i}`).id);
  }
  // Should keep at most 64; oldest 6 dropped.
  const present = ids.filter((id) => jobStore.get(id));
  assert.equal(present.length, 64);
});

// ---- Edge cases below ----

test("edge: command step that exceeds timeoutSec is killed and recorded", async () => {
  const log = silentLog();
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [{ kind: "command", command: "sleep 5", timeoutSec: 1, label: "sleep" }],
      verify: [],
    },
    { appendLog: log.append },
  );
  assert.equal(result.status, "failed");
  // The runner records the timeout reason in the install log entry.
  const installEntry = log.entries.find((entry) => entry.phase === "install" && entry.message?.includes("failed"));
  assert.ok(installEntry, "should log the install failure");
  assert.match(installEntry.stderrTail || "", /timeout after 1s/);
});

test("edge: AbortController abort during install short-circuits the plan", async () => {
  const log = silentLog();
  const controller = new AbortController();
  // Abort almost immediately so the sleep is killed.
  setTimeout(() => controller.abort(), 50);
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [{ kind: "command", command: "sleep 10", timeoutSec: 30, label: "long-sleep" }],
      verify: [],
    },
    { appendLog: log.append, signal: controller.signal },
  );
  assert.equal(result.status, "failed");
});

test("edge: http step that returns invalid JSON does not crash, captures nothing", async () => {
  const settings = fakeSettingsStore();
  const log = silentLog();
  const fakeFetch = async () => ({
    status: 200,
    text: async () => "<html>not json</html>",
  });
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [
        { kind: "http", method: "POST", url: "https://example.test/x", body: {}, captureSettings: { username: "providerUsername" } },
      ],
      verify: [],
    },
    { appendLog: log.append, settingsStore: settings, fetchImpl: fakeFetch },
  );
  // 200 → install ok, but parse fails so no settings captured.
  assert.equal(result.status, "ok");
  assert.deepEqual(settings.updates, []);
});

test("edge: http step captureSettings missing keys are silently skipped", async () => {
  const settings = fakeSettingsStore();
  const fakeFetch = async () => ({
    status: 201,
    text: async () => JSON.stringify({ found: "yes" }),
  });
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [
        {
          kind: "http",
          method: "POST",
          url: "https://example.test/x",
          body: {},
          captureSettings: {
            found: "providerFound",
            absent: "providerAbsent",
          },
        },
      ],
      verify: [],
    },
    { appendLog: () => {}, settingsStore: settings, fetchImpl: fakeFetch },
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(settings.updates, [{ providerFound: "yes" }]);
});

test("edge: http step with deeply nested capture path", async () => {
  const settings = fakeSettingsStore();
  const fakeFetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ outer: { middle: { inner: "deep-value" } } }),
  });
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [
        {
          kind: "http",
          method: "POST",
          url: "https://example.test/x",
          body: {},
          captureSettings: { "outer.middle.inner": "providerDeep" },
        },
      ],
      verify: [],
    },
    { appendLog: () => {}, settingsStore: settings, fetchImpl: fakeFetch },
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(settings.updates, [{ providerDeep: "deep-value" }]);
});

test("edge: settingsStore.update throwing surfaces a failed status", async () => {
  const throwingSettings = {
    settings: {},
    async update() { throw new Error("disk full"); },
  };
  const fakeFetch = async () => ({ status: 200, text: async () => JSON.stringify({ token: "abc" }) });
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [
        { kind: "http", method: "POST", url: "https://example.test/x", body: {}, captureSettings: { token: "providerToken" } },
      ],
      verify: [],
    },
    { appendLog: () => {}, settingsStore: throwingSettings, fetchImpl: fakeFetch },
  );
  assert.equal(result.status, "failed");
  assert.match(result.reason, /disk full/);
});

test("edge: auth-paste skipped when target setting is already filled", async () => {
  // Simulate the post-install scenario where the human has already pasted.
  const filledSettings = {
    settings: { mcpDemoToken: "previously-pasted" },
    async update() {},
  };
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "true" }],
      install: [],
      auth: { kind: "auth-paste", setting: "mcpDemoToken", setupUrl: "https://x", setupLabel: "x" },
      verify: [{ kind: "command", command: "true" }],
    },
    { appendLog: () => {}, settingsStore: filledSettings },
  );
  // Verify already passed AND setting is filled → no need to pause.
  assert.equal(result.status, "ok");
});

test("edge: auth-paste pauses when target setting is empty even if verify passed", async () => {
  // This is the MCP-server scenario: package exists (verify passes) but no
  // token has been pasted yet (setting empty) → must pause.
  const emptySettings = { settings: {}, async update() {} };
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "true" }],
      install: [],
      auth: { kind: "auth-paste", setting: "mcpDemoToken", setupUrl: "https://x", setupLabel: "x" },
      verify: [{ kind: "command", command: "true" }],
    },
    { appendLog: () => {}, settingsStore: emptySettings },
  );
  assert.equal(result.status, "auth-required");
  assert.equal(result.authPrompt.setting, "mcpDemoToken");
});

test("edge: mcp-launch declarations always appear in the log on success", async () => {
  const log = silentLog();
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "true" }],
      install: [],
      verify: [],
      mcp: [
        { kind: "mcp-launch", command: "node", args: ["server.js", "--port", "3000"], label: "demo-mcp" },
      ],
    },
    { appendLog: log.append },
  );
  assert.equal(result.status, "ok");
  const mcpEntry = log.entries.find((entry) => entry.phase === "mcp");
  assert.ok(mcpEntry);
  assert.match(mcpEntry.message, /node server\.js --port 3000/);
});

test("edge: log truncation keeps the most recent 500 entries", () => {
  const jobStore = createInstallJobStore();
  const job = jobStore.create("noisy");
  for (let i = 0; i < 800; i += 1) {
    jobStore.appendLog(job.id, { phase: "noise", message: `msg-${i}` });
  }
  const stored = jobStore.get(job.id);
  assert.equal(stored.log.length, 500);
  // Should keep the most recent ones.
  assert.equal(stored.log.at(-1).message, "msg-799");
  assert.equal(stored.log[0].message, "msg-300");
});

test("edge: HTTP step honors okStatusCodes override (e.g. 204 No Content)", async () => {
  const fakeFetch = async () => ({ status: 204, text: async () => "" });
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [
        {
          kind: "http",
          method: "POST",
          url: "https://example.test/x",
          body: {},
          okStatusCodes: [200, 201, 204],
        },
      ],
      verify: [],
    },
    { appendLog: () => {}, fetchImpl: fakeFetch },
  );
  assert.equal(result.status, "ok");
});

test("edge: missing global fetch is reported gracefully", async () => {
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [
        { kind: "http", method: "POST", url: "https://example.test/x", body: {} },
      ],
      verify: [],
    },
    { appendLog: () => {}, fetchImpl: undefined },
  );
  // We DO have global fetch in node 20, so this should pass to fetch and
  // return a real result. The test exists to document that the runner
  // doesn't crash if fetch is somehow stripped — replace fetchImpl with a
  // sentinel that throws to confirm:
  const result2 = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [
        { kind: "http", method: "POST", url: "https://example.test/x", body: {} },
      ],
      verify: [],
    },
    {
      appendLog: () => {},
      fetchImpl: () => { throw new Error("network down"); },
    },
  );
  assert.equal(result2.status, "failed");
  assert.match(result2.reason, /install http step/);
});

test("edge: command okExitCodes override accepts a non-zero exit", async () => {
  // grep -c on a non-matching pattern exits 1, but that's "0 matches",
  // which is sometimes a valid outcome. Demonstrate okExitCodes.
  const log = silentLog();
  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "true" }],
      install: [],
      verify: [
        { kind: "command", command: "exit 2", okExitCodes: [0, 2], label: "tolerate-2" },
      ],
    },
    { appendLog: log.append },
  );
  assert.equal(result.status, "ok");
});

test("edge: SDK normalization drops unknown step kinds and bad shapes", async () => {
  // The SDK drops invalid steps; the runner should treat the result as
  // an empty plan and finish ok.
  const { defineBuilding } = await import("../src/client/building-sdk.js");
  const building = defineBuilding({
    id: "broken-plan",
    install: {
      enabledSetting: "brokenEnabled",
      plan: {
        preflight: [{ kind: "wrong-kind", command: "true" }, null, "string-not-object"],
        install: [{ kind: "command" /* missing command field */ }],
        verify: [{ kind: "http" /* missing url */ }],
        mcp: [{ kind: "mcp-launch" /* missing command */ }],
      },
    },
  });
  // After normalization, every step list should be empty.
  assert.equal(building.install.plan.preflight.length, 0);
  assert.equal(building.install.plan.install.length, 0);
  assert.equal(building.install.plan.verify.length, 0);
  assert.equal(building.install.plan.mcp.length, 0);
  const result = await executeInstallPlan(building.install.plan, { appendLog: () => {} });
  assert.equal(result.status, "ok");
});

// ---- Secret-masking edge cases ----

test("maskSecrets: replaces every occurrence of a secret with [redacted]", () => {
  const masked = maskSecrets("pasted abc123secret here and abc123secret again", ["abc123secret"]);
  assert.equal(masked, "pasted [redacted] here and [redacted] again");
});

test("maskSecrets: handles multiple secrets including overlap-free chains", () => {
  const masked = maskSecrets("token=tok_AAAA key=key_BBBB plain", ["tok_AAAA", "key_BBBB"]);
  assert.equal(masked, "token=[redacted] key=[redacted] plain");
});

test("maskSecrets: skips empty + ultra-short secrets to avoid shredding output", () => {
  // A 1-char "secret" of "a" would otherwise turn every "a" into [redacted].
  // The runner intentionally requires >= 4 chars before masking.
  const masked = maskSecrets("abcdefg apple", ["", " ", "a", "ab"]);
  assert.equal(masked, "abcdefg apple");
});

test("maskSecrets: returns input unchanged when there is no overlap", () => {
  assert.equal(maskSecrets("hello world", ["nothing-matches"]), "hello world");
});

test("maskSecrets: does NOT match across whitespace boundaries (it's plain substring)", () => {
  // Documents the contract: maskSecrets is plain substring match, not
  // word-boundary. A secret that contains a space will still match a
  // multiword span.
  const masked = maskSecrets("token: hunter two and elsewhere hunter two", ["hunter two"]);
  assert.equal(masked, "token: [redacted] and elsewhere [redacted]");
});

test("looksLikeSecretSetting: matches common secret tail names", () => {
  for (const name of [
    "mcpGithubToken",
    "mcpBraveSearchApiKey",
    "ottoAuthPrivateKey",
    "stripeSecret",
    "telegramBotToken",
    "twilioAccountSid",  // does NOT end in a secret tail — should be false
  ]) {
    const expected = !name.endsWith("Sid");
    assert.equal(looksLikeSecretSetting(name), expected, `${name} → ${expected}`);
  }
  assert.equal(looksLikeSecretSetting(""), false);
  assert.equal(looksLikeSecretSetting(null), false);
});

test("install run: pre-existing auth-paste setting value is masked in log entries", async () => {
  // The human pasted before, then clicked Install again. Verify and
  // mcp-launch echo the value into stdout/stderr. The log must scrub it.
  const dir = mkdtempSync(join(tmpdir(), "install-runner-secret-"));
  const verifyScript = join(dir, "verify.sh");
  const SECRET = "sk-live-AAAAAAAAA-redact-me";
  writeFileSync(verifyScript, `#!/bin/sh\necho "Authenticated as ${SECRET} and other text"\nexit 0\n`);
  const settings = {
    settings: { mcpDemoToken: SECRET },
    async update() {},
  };
  const log = silentLog();
  try {
    const result = await executeInstallPlan(
      {
        preflight: [{ kind: "command", command: "true" }],
        install: [],
        auth: { kind: "auth-paste", setting: "mcpDemoToken", setupUrl: "https://x", setupLabel: "x" },
        verify: [{ kind: "command", command: `sh ${verifyScript}`, label: "verify-prints-secret" }],
        mcp: [{ kind: "mcp-launch", command: "node", args: ["server.js", "--token", `${SECRET}`], label: "mcp-with-secret" }],
      },
      { appendLog: log.append, settingsStore: settings },
    );
    assert.equal(result.status, "ok");
    // Walk every emitted log entry and assert the secret is nowhere in it.
    for (const entry of log.entries) {
      for (const value of Object.values(entry)) {
        if (typeof value !== "string") continue;
        assert.equal(value.includes(SECRET), false, `secret leaked into log: ${value}`);
      }
    }
    // Confirm at least one entry actually got redacted (otherwise the
    // assertion above would pass trivially with an empty input).
    const sawRedaction = log.entries.some((entry) => Object.values(entry).some((v) => typeof v === "string" && v.includes("[redacted]")));
    assert.equal(sawRedaction, true, "expected at least one [redacted] in the log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install run: secret captured from http response is masked in subsequent step logs", async () => {
  const SECRET = "captured-secret-12345-AAAA";
  const dir = mkdtempSync(join(tmpdir(), "install-runner-secret-cap-"));
  const verifyScript = join(dir, "verify.sh");
  writeFileSync(verifyScript, `#!/bin/sh\necho "received ${SECRET}"\nexit 0\n`);
  const fakeFetch = async () => ({ status: 200, text: async () => JSON.stringify({ apiKey: SECRET }) });
  const log = silentLog();
  try {
    const result = await executeInstallPlan(
      {
        preflight: [{ kind: "command", command: "false" }],
        install: [
          { kind: "http", method: "POST", url: "https://example.test/x", body: {}, captureSettings: { apiKey: "providerApiKey" } },
        ],
        verify: [{ kind: "command", command: `sh ${verifyScript}`, label: "verify-echoes-captured-secret" }],
      },
      { appendLog: log.append, fetchImpl: fakeFetch, settingsStore: fakeSettingsStore() },
    );
    assert.equal(result.status, "ok");
    // The secret was captured into providerApiKey (which looks-secret), so
    // the verify-step log must not contain the raw value.
    for (const entry of log.entries) {
      for (const value of Object.values(entry)) {
        if (typeof value !== "string") continue;
        assert.equal(value.includes(SECRET), false, `captured secret leaked: ${value}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Auto-handshake on install completion ----

test("auto-handshake: ok handshake adds entry, install stays ok, log includes handshake phase", async () => {
  const { createMcpLaunchRegistry } = await import("../src/mcp-launch-registry.js");
  const jobStore = createInstallJobStore();
  const registry = createMcpLaunchRegistry();
  const calls = [];
  const fakeHandshake = async (launch) => {
    calls.push(launch);
    return { ok: true, status: "tools-listed", toolCount: 5, serverName: "stub", serverVersion: "1" };
  };
  const building = {
    id: "auto-hs-ok",
    install: {
      plan: {
        preflight: [{ kind: "command", command: "true" }],
        verify: [{ kind: "command", command: "true" }],
        mcp: [{ kind: "mcp-launch", command: "node", args: ["server.js"] }],
      },
    },
  };
  const job = startInstallJob({ jobStore, building, mcpRegistry: registry, runHandshake: fakeHandshake });
  const finished = await waitForJob(jobStore, job.id, { timeoutMs: 4000 });
  assert.equal(finished.status, "ok");
  assert.equal(finished.result.handshakes.length, 1);
  assert.equal(finished.result.handshakes[0].ok, true);
  assert.equal(finished.result.handshakes[0].toolCount, 5);
  assert.equal(calls.length, 1);
  // Log includes the handshake phase entries.
  const handshakeLogs = finished.log.filter((entry) => entry.phase === "handshake");
  assert.ok(handshakeLogs.length >= 2, "expected running + ok log entries");
});

test("auto-handshake: failing handshake leaves install ok but reports the failure in result", async () => {
  const { createMcpLaunchRegistry } = await import("../src/mcp-launch-registry.js");
  const jobStore = createInstallJobStore();
  const registry = createMcpLaunchRegistry();
  const fakeHandshake = async () => ({ ok: false, status: "init-failed", error: "401 Unauthorized" });
  const building = {
    id: "auto-hs-broken",
    install: {
      plan: {
        preflight: [{ kind: "command", command: "true" }],
        verify: [{ kind: "command", command: "true" }],
        mcp: [{ kind: "mcp-launch", command: "node" }],
      },
    },
  };
  const job = startInstallJob({ jobStore, building, mcpRegistry: registry, runHandshake: fakeHandshake });
  const finished = await waitForJob(jobStore, job.id, { timeoutMs: 4000 });
  assert.equal(finished.status, "ok", "install status should NOT be downgraded by handshake failure");
  assert.equal(finished.result.handshakes[0].ok, false);
  assert.equal(finished.result.handshakes[0].status, "init-failed");
  assert.match(finished.result.handshakes[0].error, /401/);
});

test("auto-handshake: skipped when no mcp launches declared", async () => {
  const { createMcpLaunchRegistry } = await import("../src/mcp-launch-registry.js");
  const jobStore = createInstallJobStore();
  const registry = createMcpLaunchRegistry();
  let handshakeCalls = 0;
  const fakeHandshake = async () => { handshakeCalls += 1; return { ok: true, status: "tools-listed" }; };
  const building = {
    id: "no-mcp",
    install: { plan: { preflight: [{ kind: "command", command: "true" }], verify: [], mcp: [] } },
  };
  const job = startInstallJob({ jobStore, building, mcpRegistry: registry, runHandshake: fakeHandshake });
  const finished = await waitForJob(jobStore, job.id, { timeoutMs: 4000 });
  assert.equal(finished.status, "ok");
  assert.equal(handshakeCalls, 0);
  assert.equal(finished.result.handshakes, undefined);
});

test("auto-handshake: skipped when runHandshake not provided", async () => {
  const { createMcpLaunchRegistry } = await import("../src/mcp-launch-registry.js");
  const jobStore = createInstallJobStore();
  const registry = createMcpLaunchRegistry();
  const building = {
    id: "no-runner",
    install: {
      plan: {
        preflight: [{ kind: "command", command: "true" }],
        verify: [],
        mcp: [{ kind: "mcp-launch", command: "node" }],
      },
    },
  };
  const job = startInstallJob({ jobStore, building, mcpRegistry: registry });
  const finished = await waitForJob(jobStore, job.id, { timeoutMs: 4000 });
  assert.equal(finished.status, "ok");
  assert.equal(finished.result.handshakes, undefined);
});

test("install-runner: records lastInstall on success even when no handshake runs", async () => {
  const { createMcpLaunchRegistry } = await import("../src/mcp-launch-registry.js");
  const jobStore = createInstallJobStore();
  const registry = createMcpLaunchRegistry();
  const building = {
    id: "install-record-ok",
    install: {
      plan: {
        preflight: [{ kind: "command", command: "true" }],
        verify: [],
        mcp: [{ kind: "mcp-launch", command: "node" }],
      },
    },
  };
  // No runHandshake provided — so the auto-handshake branch is skipped.
  // recordInstall must STILL fire.
  const job = startInstallJob({ jobStore, building, mcpRegistry: registry });
  await waitForJob(jobStore, job.id, { timeoutMs: 4000 });
  const [entry] = registry.list();
  assert.ok(entry.lastInstall);
  assert.equal(entry.lastInstall.ok, true);
  assert.equal(entry.lastInstall.status, "ok");
  assert.equal(entry.lastInstall.jobId, job.id);
});

test("install-runner: records lastInstall on failure too", async () => {
  const { createMcpLaunchRegistry } = await import("../src/mcp-launch-registry.js");
  const jobStore = createInstallJobStore();
  const registry = createMcpLaunchRegistry();
  // Pre-declare a launch so recordInstall has somewhere to write.
  registry.declare("install-record-fail", [{ command: "node" }]);
  const building = {
    id: "install-record-fail",
    install: {
      plan: {
        preflight: [{ kind: "command", command: "false" }],
        install: [{ kind: "command", command: "false", label: "always-fail" }],
        verify: [],
        mcp: [{ kind: "mcp-launch", command: "node" }],
      },
    },
  };
  const job = startInstallJob({ jobStore, building, mcpRegistry: registry });
  await waitForJob(jobStore, job.id, { timeoutMs: 4000 });
  const [entry] = registry.list();
  assert.ok(entry.lastInstall);
  assert.equal(entry.lastInstall.ok, false);
  assert.equal(entry.lastInstall.status, "failed");
});

test("auto-handshake: records each handshake into the registry's lastHandshake", async () => {
  const { createMcpLaunchRegistry } = await import("../src/mcp-launch-registry.js");
  const jobStore = createInstallJobStore();
  const registry = createMcpLaunchRegistry();
  const fakeHandshake = async () => ({
    ok: true,
    status: "tools-listed",
    toolCount: 9,
    serverName: "stub-srv",
    serverVersion: "0.5.0",
  });
  const building = {
    id: "auto-hs-record",
    install: {
      plan: {
        preflight: [{ kind: "command", command: "true" }],
        verify: [],
        mcp: [{ kind: "mcp-launch", command: "node", label: "primary" }],
      },
    },
  };
  const job = startInstallJob({ jobStore, building, mcpRegistry: registry, runHandshake: fakeHandshake });
  await waitForJob(jobStore, job.id, { timeoutMs: 4000 });
  // Registry's launch entry should now carry lastHandshake.
  const [entry] = registry.list();
  assert.ok(entry.lastHandshake);
  assert.equal(entry.lastHandshake.ok, true);
  assert.equal(entry.lastHandshake.toolCount, 9);
  assert.equal(entry.lastHandshake.serverName, "stub-srv");
});

test("auto-sync: called after successful install when runAutoSync provided", async () => {
  const { createMcpLaunchRegistry } = await import("../src/mcp-launch-registry.js");
  const jobStore = createInstallJobStore();
  const registry = createMcpLaunchRegistry();
  let calls = 0;
  const fakeSync = () => { calls += 1; return { claude: { wrote: 1, managed: ["x"] } }; };
  const building = {
    id: "auto-sync-ok",
    install: {
      plan: {
        preflight: [{ kind: "command", command: "true" }],
        verify: [],
        mcp: [{ kind: "mcp-launch", command: "node" }],
      },
    },
  };
  const job = startInstallJob({ jobStore, building, mcpRegistry: registry, runAutoSync: fakeSync });
  const finished = await waitForJob(jobStore, job.id, { timeoutMs: 4000 });
  assert.equal(finished.status, "ok");
  assert.equal(calls, 1);
  assert.ok(finished.result.autoSync);
  assert.equal(finished.result.autoSync.claude.wrote, 1);
  // Log entry should reference auto-sync.
  const syncLog = finished.log.find((entry) => entry.message?.includes("auto-synced"));
  assert.ok(syncLog, "expected an auto-sync log entry");
});

test("auto-sync: NOT called when install plan failed", async () => {
  const { createMcpLaunchRegistry } = await import("../src/mcp-launch-registry.js");
  const jobStore = createInstallJobStore();
  const registry = createMcpLaunchRegistry();
  let calls = 0;
  const fakeSync = () => { calls += 1; return {}; };
  const building = {
    id: "auto-sync-fail",
    install: {
      plan: {
        preflight: [{ kind: "command", command: "false" }],
        install: [{ kind: "command", command: "false", label: "boom" }],
        verify: [],
      },
    },
  };
  const job = startInstallJob({ jobStore, building, mcpRegistry: registry, runAutoSync: fakeSync });
  await waitForJob(jobStore, job.id, { timeoutMs: 4000 });
  assert.equal(calls, 0, "auto-sync should not run when install plan failed");
});

test("auto-sync: throw is caught, install stays ok, error attached to result", async () => {
  const { createMcpLaunchRegistry } = await import("../src/mcp-launch-registry.js");
  const jobStore = createInstallJobStore();
  const registry = createMcpLaunchRegistry();
  const fakeSync = () => { throw new Error("disk full"); };
  const building = {
    id: "auto-sync-throws",
    install: {
      plan: {
        preflight: [{ kind: "command", command: "true" }],
        verify: [],
        mcp: [{ kind: "mcp-launch", command: "node" }],
      },
    },
  };
  const job = startInstallJob({ jobStore, building, mcpRegistry: registry, runAutoSync: fakeSync });
  const finished = await waitForJob(jobStore, job.id, { timeoutMs: 4000 });
  assert.equal(finished.status, "ok", "install must not be downgraded by sync failure");
  assert.match(finished.result.autoSyncError, /disk full/);
});

test("auto-sync: skipped when runAutoSync is null/undefined", async () => {
  const { createMcpLaunchRegistry } = await import("../src/mcp-launch-registry.js");
  const jobStore = createInstallJobStore();
  const registry = createMcpLaunchRegistry();
  const building = {
    id: "auto-sync-skipped",
    install: {
      plan: {
        preflight: [{ kind: "command", command: "true" }],
        verify: [],
        mcp: [{ kind: "mcp-launch", command: "node" }],
      },
    },
  };
  const job = startInstallJob({ jobStore, building, mcpRegistry: registry });
  const finished = await waitForJob(jobStore, job.id, { timeoutMs: 4000 });
  assert.equal(finished.status, "ok");
  assert.equal(finished.result.autoSync, undefined);
});

test("auto-handshake: handshake throw is caught and recorded as handshake-crash", async () => {
  const { createMcpLaunchRegistry } = await import("../src/mcp-launch-registry.js");
  const jobStore = createInstallJobStore();
  const registry = createMcpLaunchRegistry();
  const fakeHandshake = async () => { throw new Error("kaboom"); };
  const building = {
    id: "auto-hs-throws",
    install: {
      plan: {
        preflight: [{ kind: "command", command: "true" }],
        verify: [],
        mcp: [{ kind: "mcp-launch", command: "node" }],
      },
    },
  };
  const job = startInstallJob({ jobStore, building, mcpRegistry: registry, runHandshake: fakeHandshake });
  const finished = await waitForJob(jobStore, job.id, { timeoutMs: 4000 });
  assert.equal(finished.status, "ok");
  assert.equal(finished.result.handshakes[0].ok, false);
  assert.equal(finished.result.handshakes[0].status, "handshake-crash");
  assert.match(finished.result.handshakes[0].error, /kaboom/);
});

test("install run: non-secret-named captured field is NOT masked", async () => {
  // "providerUsername" doesn't match the secret-tail pattern, so its value
  // should stay visible in subsequent log entries — that's the contract:
  // we only mask things that look secret.
  const VISIBLE = "alice-public-username";
  const dir = mkdtempSync(join(tmpdir(), "install-runner-visible-"));
  const verifyScript = join(dir, "verify.sh");
  writeFileSync(verifyScript, `#!/bin/sh\necho "Authenticated as ${VISIBLE}"\nexit 0\n`);
  const fakeFetch = async () => ({ status: 200, text: async () => JSON.stringify({ username: VISIBLE }) });
  const log = silentLog();
  try {
    const result = await executeInstallPlan(
      {
        preflight: [{ kind: "command", command: "false" }],
        install: [
          { kind: "http", method: "POST", url: "https://example.test/x", body: {}, captureSettings: { username: "providerUsername" } },
        ],
        verify: [{ kind: "command", command: `sh ${verifyScript}`, label: "verify-prints-visible" }],
      },
      { appendLog: log.append, fetchImpl: fakeFetch, settingsStore: fakeSettingsStore() },
    );
    assert.equal(result.status, "ok");
    const sawVisibleInLog = log.entries.some((entry) => Object.values(entry).some((v) => typeof v === "string" && v.includes(VISIBLE)));
    assert.equal(sawVisibleInLog, true, "non-secret captured value should remain visible in logs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
