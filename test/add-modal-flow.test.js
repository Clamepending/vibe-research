// End-to-end test for the "Add Modal" click flow.
//
// This is the test that would have caught the second-order bug we just hit:
// the Modal install plan ran cleanly, but the UI never reflected that the
// building was installed because applySettingsState was dropping the
// modalEnabled flag from /api/settings responses. From the user's seat that
// reads as "I clicked Add Modal, the screen flickered, and nothing changed."
//
// Skips when no Chromium is available (matches the existing Playwright tests
// in vibe-research.test.js, which also skip on machines without a browser).

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

import { createVibeResearchApp } from "../src/create-app.js";
import { resolveBrowserExecutablePath } from "../src/browser-runtime.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

async function startApp({ cwd, stateDir }) {
  const app = await createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd,
    stateDir,
    persistSessions: false,
    persistentTerminals: false,
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({ enabled: settings.preventSleepEnabled, platform: "test" }),
  });
  return { app, baseUrl: `http://127.0.0.1:${app.config.port}` };
}

test("clicking Add Modal flips modalEnabled and the 'Add Modal' button disappears", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium found.");
    return;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-add-modal-"));
  const stateDir = path.join(tmp, ".vibe-research");
  await mkdir(stateDir, { recursive: true });
  const wikiDir = path.join(tmp, "library");
  await mkdir(wikiDir, { recursive: true });

  const { app, baseUrl } = await startApp({ cwd: tmp, stateDir });

  // Skip the first-run "choose your workspace" wizard.
  await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceRootPath: tmp,
      wikiPath: wikiDir,
      wikiPathConfigured: true,
      wikiGitRemoteEnabled: false,
    }),
  });

  // Place Modal in Agent Town so the click handler reaches the
  // "already-placed → run install plan" branch (the codepath this test
  // suite was written for). Without a placement, the click would trigger
  // placement mode instead, which is a different flow.
  await fetch(`${baseUrl}/api/agent-town/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ layout: { functional: { modal: { x: 0, y: 0 } } }, reason: "test-setup" }),
  });

  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/?view=plugins&building=modal`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-plugin-finish-install="modal"]')),
      { timeout: 20_000 },
    );

    // Sanity check on the pre-click state: server says modal is NOT installed.
    const before = await fetch(`${baseUrl}/api/state`).then((r) => r.json());
    assert.equal(before.settings.modalEnabled, false, "preflight: modalEnabled should be false");
    assert.deepEqual(before.settings.installedPluginIds, [], "preflight: no installed plugins");

    // Stub out the install runner with a fast-success response. The real
    // install plan can take ~2s and depends on the Modal CLI being on the
    // host's PATH — neither acceptable for CI. We patch fetchJson at the
    // window layer to short-circuit just the install POST, leaving every
    // other API call intact.
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (url.includes("/api/buildings/modal/install")) {
          return Promise.resolve(new Response(
            JSON.stringify({ jobId: "test-job", status: "ok", log: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ));
        }
        return originalFetch(input, init);
      };
    });

    // Click "Add Modal".
    await page.click('[data-plugin-finish-install="modal"]');

    // After the PATCH lands, isPluginInstalled(modal) should flip true and
    // the button should disappear. This is the regression we're guarding —
    // before the applySettingsState fix, the button stayed forever.
    await page.waitForFunction(
      () => !document.querySelector('[data-plugin-finish-install="modal"]'),
      { timeout: 10_000 },
    );

    // Server-side: settings persisted.
    const after = await fetch(`${baseUrl}/api/state`).then((r) => r.json());
    assert.equal(after.settings.modalEnabled, true, "server should have modalEnabled=true after click");
    assert.ok(
      after.settings.installedPluginIds.includes("modal"),
      "server should record modal in installedPluginIds",
    );

    // Client-side: side panel reflects the installed status.
    const panelText = await page.evaluate(() => {
      const heading = document.body.innerText.match(/Cloud Compute[^\n]*/);
      return heading ? heading[0] : null;
    });
    assert.match(
      panelText || "",
      /Cloud Compute · installed/,
      `panel header should switch from "not configured" to "installed", got: ${panelText}`,
    );
  } finally {
    if (browser) await browser.close();
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("POST /api/buildings/:id/install and /authenticate are rate-limited (CodeQL Missing-Rate-Limit guard)", async () => {
  // Both endpoints spawn subprocesses (CLI installers, `modal token new
  // --source web`, etc.). A loop bug in the client or any future
  // exposure of these endpoints beyond localhost would be a denial-of-
  // service vector. The rate limiter caps requests-per-minute at the
  // value defined in BUILDING_INSTALL_RATE_LIMIT_MAX. Any 200 response
  // mixed with a 429 response within the window proves the limit is
  // active; we don't pin the exact constant so it can be tuned.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-rate-limit-"));
  const stateDir = path.join(tmp, ".vibe-research");
  await mkdir(stateDir, { recursive: true });

  const { app, baseUrl } = await startApp({ cwd: tmp, stateDir });
  try {
    let saw429 = false;
    let saw200 = false;
    // Hammer the authenticate endpoint with > BUILDING_INSTALL_RATE_LIMIT_MAX
    // requests in quick succession. The limit is small (~12/minute) so 30
    // sequential requests is well over the cap.
    for (let i = 0; i < 30; i += 1) {
      const res = await fetch(`${baseUrl}/api/buildings/modal/authenticate`, { method: "POST" });
      if (res.status === 200) saw200 = true;
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    assert.ok(saw200, "at least one /authenticate request should succeed before the limiter fires");
    assert.ok(saw429, "/authenticate must return 429 once BUILDING_INSTALL_RATE_LIMIT_MAX is exceeded");
  } finally {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("POST /api/buildings/modal/authenticate exists and runs only the auth phase", async () => {
  // Server-API contract for the deferred auth flow. The endpoint must
  // exist and accept POST; calling it on Modal kicks off a job that runs
  // ONLY the auth + verify phases (no preflight, no install). We don't
  // actually run `modal token new --source web` here — we trust the
  // executeAuthPhase unit tests to cover the runner behaviour, and use
  // this test to lock in the API surface.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-auth-endpoint-"));
  const stateDir = path.join(tmp, ".vibe-research");
  await mkdir(stateDir, { recursive: true });

  const { app, baseUrl } = await startApp({ cwd: tmp, stateDir });
  try {
    const response = await fetch(`${baseUrl}/api/buildings/modal/authenticate`, { method: "POST" });
    assert.equal(response.status, 200, "POST /api/buildings/modal/authenticate must succeed (200)");
    const body = await response.json();
    assert.equal(body.buildingId, "modal");
    assert.ok(body.jobId, "response must include jobId so the client can poll");

    // Endpoint refuses unknown buildings.
    const unknown = await fetch(`${baseUrl}/api/buildings/no-such-building/authenticate`, { method: "POST" });
    assert.equal(unknown.status, 404);

    // Endpoint refuses buildings that don't have an auth step (e.g. a
    // building with no install plan at all). Use github (system app, no plan).
    const wrong = await fetch(`${baseUrl}/api/buildings/github/authenticate`, { method: "POST" });
    assert.equal(wrong.status, 400);
  } finally {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("auth-browser-cli buildings: install returns auth-required, then a manual Authenticate click finishes setup", async (t) => {
  // End-to-end UX guarantee: clicking "Add Modal" no longer hijacks the
  // screen with a sign-in tab. Instead the install runner returns
  // auth-required, the side panel surfaces an explicit "Sign in to Modal"
  // button (`data-plugin-authenticate="modal"`), and that button is what
  // actually triggers the auth phase.
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium found.");
    return;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-add-modal-deferred-"));
  const stateDir = path.join(tmp, ".vibe-research");
  await mkdir(stateDir, { recursive: true });
  const wikiDir = path.join(tmp, "library");
  await mkdir(wikiDir, { recursive: true });

  const { app, baseUrl } = await startApp({ cwd: tmp, stateDir });
  await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceRootPath: tmp,
      wikiPath: wikiDir,
      wikiPathConfigured: true,
      wikiGitRemoteEnabled: false,
    }),
  });
  await fetch(`${baseUrl}/api/agent-town/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ layout: { functional: { modal: { x: 0, y: 0 } } }, reason: "test-setup" }),
  });

  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/?view=plugins&building=modal`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-plugin-finish-install="modal"]')),
      { timeout: 20_000 },
    );

    // Stub install + authenticate endpoints so the test doesn't depend
    // on the host having modal CLI installed. We simulate the realistic
    // install→auth-required→authenticate sequence that the deferred-auth
    // refactor introduced. The runner returns "running" from the initial
    // POST and lets the poll loop pick up the terminal status — we mirror
    // that here, otherwise the client never fetches the full job result
    // (which is where authPrompt lives).
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      window.__authClickCount = 0;
      window.__installPolls = 0;
      window.__authPolls = 0;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (url.includes("/api/buildings/modal/install") && (init?.method || "").toUpperCase() === "POST" && !url.includes("/jobs/")) {
          return Promise.resolve(new Response(
            JSON.stringify({ jobId: "test-install-job", status: "running", buildingId: "modal" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ));
        }
        if (url.includes("/api/buildings/modal/install/jobs/test-install-job")) {
          window.__installPolls += 1;
          return Promise.resolve(new Response(
            JSON.stringify({
              id: "test-install-job",
              buildingId: "modal",
              status: "auth-required",
              log: [],
              result: {
                status: "auth-required",
                authPrompt: {
                  kind: "auth-browser-cli",
                  command: "modal token new --source web",
                  label: "Sign in to Modal",
                  detail: "Sign in via the browser to finish Modal setup.",
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ));
        }
        if (url.includes("/api/buildings/modal/authenticate") && (init?.method || "").toUpperCase() === "POST") {
          window.__authClickCount += 1;
          return Promise.resolve(new Response(
            JSON.stringify({ jobId: "test-auth-job", status: "running", buildingId: "modal" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ));
        }
        if (url.includes("/api/buildings/modal/install/jobs/test-auth-job")) {
          window.__authPolls += 1;
          return Promise.resolve(new Response(
            JSON.stringify({
              id: "test-auth-job",
              buildingId: "modal",
              status: "ok",
              log: [],
              result: { status: "ok" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ));
        }
        return originalFetch(input, init);
      };
    });

    // Click "Add Modal" — install fires, returns auth-required, panel
    // pivots to render an Authenticate button.
    await page.click('[data-plugin-finish-install="modal"]');
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-plugin-authenticate="modal"]')),
      { timeout: 15_000 },
    );

    // Pre-click sanity: no auth call yet.
    const beforeClicks = await page.evaluate(() => window.__authClickCount);
    assert.equal(beforeClicks, 0, "Authenticate must NOT fire automatically — only on user click");

    // The button label should mirror the authPrompt.label — that's how
    // the user identifies which building they're signing into when
    // multiple panels are open.
    const buttonText = await page.locator('[data-plugin-authenticate="modal"]').innerText();
    assert.match(buttonText, /Sign in to Modal/, `button label should reflect the building, got: ${buttonText}`);

    // Click Authenticate — endpoint fires, status returns ok, button goes away.
    await page.click('[data-plugin-authenticate="modal"]');
    await page.waitForFunction(
      () => !document.querySelector('[data-plugin-authenticate="modal"]'),
      { timeout: 10_000 },
    );

    const afterClicks = await page.evaluate(() => window.__authClickCount);
    assert.equal(afterClicks, 1, "Authenticate endpoint must be called exactly once on the user's click");
  } finally {
    if (browser) await browser.close();
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("once Modal is fully installed and verified, the panel collapses to a green ready pill + doc links (no 4-step setup wall)", async (t) => {
  // Tests the renderPluginReadyPanel cleanup. After install completes
  // with status "ok", the side panel should switch from the verbose
  // 4-step / 4-card layout to a focused "ready" view. The verbose
  // version is what made the user say "this whole wall of text isn't
  // necessary" — once it's installed, the user wants confirmation +
  // shortcuts to docs, not a re-statement of the install contract.
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium found.");
    return;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-modal-ready-"));
  const stateDir = path.join(tmp, ".vibe-research");
  await mkdir(stateDir, { recursive: true });
  const wikiDir = path.join(tmp, "library");
  await mkdir(wikiDir, { recursive: true });

  const { app, baseUrl } = await startApp({ cwd: tmp, stateDir });
  await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceRootPath: tmp,
      wikiPath: wikiDir,
      wikiPathConfigured: true,
      wikiGitRemoteEnabled: false,
    }),
  });
  // Pre-place + mark Modal as installed to land in the fully-ready state.
  await fetch(`${baseUrl}/api/agent-town/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ layout: { functional: { modal: { x: 0, y: 0 } } }, reason: "test-setup" }),
  });
  await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modalEnabled: true, installedPluginIds: ["modal"] }),
  });

  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/?view=plugins&building=modal`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-plugin-setup-root="modal"]')),
      { timeout: 20_000 },
    );

    // Ready panel must render.
    const readyPanel = await page.locator('.plugin-ready-panel[data-plugin-setup-root="modal"]').count();
    assert.equal(readyPanel, 1, "fully-ready Modal building must render the .plugin-ready-panel collapsed view");

    // Green ready pill — visible identifier the user asked for.
    const pillCount = await page.locator('.plugin-ready-panel .plugin-ready-pill').count();
    assert.equal(pillCount, 1, "ready panel must include the green ✓ ready pill");
    const pillText = await page.locator('.plugin-ready-panel .plugin-ready-pill').innerText();
    assert.match(pillText, /ready/i, `pill text should say "ready", got: ${pillText}`);

    // The verbose 4-step setup list must NOT render anymore — that's
    // exactly the wall of text the user wanted gone.
    const stepList = await page.locator('.plugin-onboarding-steps').count();
    assert.equal(stepList, 0, "verbose 4-step setup list must be hidden in fully-ready view");
    const variableCards = await page.locator('.plugin-onboarding-vars').count();
    assert.equal(variableCards, 0, "verbose variable cards must be hidden in fully-ready view");

    // Docs links must still be present so the user can jump to docs.
    const docLinks = await page.locator('.plugin-ready-panel .plugin-ready-doc-link').count();
    assert.ok(docLinks >= 1, `ready panel must include at least one docs link, got: ${docLinks}`);

    // The big access description block ("Requires the modal Python
    // package/CLI...") must NOT render — it's redundant once installed.
    const accessPanel = await page.locator('.plugin-access-panel').count();
    assert.equal(accessPanel, 0, "verbose access description must be hidden when fully ready");
  } finally {
    if (browser) await browser.close();
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Zinc settings: zincEnabled + zincApiKey persist; only zincApiKeyConfigured is echoed back (no secret leak)", async () => {
  // Plumbing test for the new Zinc building. The API key is a secret —
  // PATCH must accept it, settings-store must persist it, but /api/state
  // must NEVER return the raw value. Only zincApiKeyConfigured (a bool)
  // surfaces, same pattern as telegramBotToken / wandbApiKey.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-zinc-roundtrip-"));
  const stateDir = path.join(tmp, ".vibe-research");
  await mkdir(stateDir, { recursive: true });

  const { app, baseUrl } = await startApp({ cwd: tmp, stateDir });
  try {
    // Pre-flight: zinc is off, no key.
    const before = await fetch(`${baseUrl}/api/state`).then((r) => r.json());
    assert.equal(before.settings.zincEnabled, false);
    assert.equal(before.settings.zincApiKeyConfigured, false);
    assert.equal(before.settings.zincApiKey, "", "raw zincApiKey must NEVER appear in /api/state");

    // PATCH key + flag.
    const patch = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zincEnabled: true, zincApiKey: "test-zinc-token-secret-1234" }),
    }).then((r) => r.json());
    assert.equal(patch.settings.zincEnabled, true);
    assert.equal(patch.settings.zincApiKeyConfigured, true);
    assert.equal(
      patch.settings.zincApiKey,
      "",
      "PATCH response must scrub the raw zincApiKey (only the configured-flag escapes the server)",
    );

    // /api/state must reflect the persisted state without leaking the key.
    const after = await fetch(`${baseUrl}/api/state`).then((r) => r.json());
    assert.equal(after.settings.zincEnabled, true);
    assert.equal(after.settings.zincApiKeyConfigured, true);
    assert.equal(after.settings.zincApiKey, "");
    // Belt + braces: the secret must not appear anywhere in the
    // serialised body. Catches an accidental field bleed from a future
    // refactor that adds the raw key to a sibling field.
    const stateBody = JSON.stringify(after);
    assert.equal(stateBody.includes("test-zinc-token-secret-1234"), false, "zincApiKey value must never serialize anywhere in /api/state");
  } finally {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("settings PATCH for modalEnabled round-trips correctly through /api/state", async () => {
  // Pure server-API test, no browser. Catches the case where the server
  // settings store or PATCH route stops accepting/persisting modalEnabled.
  // Modal is the cloud-compute building whose install flow surfaces this
  // contract; if the round-trip breaks, the client UI never sees the flip.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-settings-roundtrip-"));
  const stateDir = path.join(tmp, ".vibe-research");
  await mkdir(stateDir, { recursive: true });

  const { app, baseUrl } = await startApp({ cwd: tmp, stateDir });
  try {
    const patch = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modalEnabled: true }),
    }).then((r) => r.json());
    assert.equal(patch.settings.modalEnabled, true, "PATCH response should reflect modalEnabled=true");

    const state = await fetch(`${baseUrl}/api/state`).then((r) => r.json());
    assert.equal(state.settings.modalEnabled, true, "/api/state should include modalEnabled=true after PATCH");
  } finally {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
