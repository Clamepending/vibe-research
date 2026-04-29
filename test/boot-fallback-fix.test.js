// Regression tests for the boot-fallback fix:
//  - /api/state must not block longer than ~2s on a hung buildinghub refresh.
//    Previously a slow remote buildinghub host (8s fetch timeout) made the
//    state endpoint exceed the client's 4s boot watchdog.
//  - public/index.html must distinguish "bundle didn't load" (real failure,
//    show recovery) from "bundle loaded but waiting on /api/state" (slow
//    network, soften message + wait longer).

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createVibeResearchApp } from "../src/create-app.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_INDEX = path.join(HERE, "..", "public", "index.html");

// Mock BuildingHubService whose refresh() hangs for `hangMs` before resolving.
// This simulates a slow remote catalog without a real network call.
function makeHangingBuildingHubServiceFactory(hangMs) {
  return () => {
    let refreshes = 0;
    const pendingTimers = new Set();
    return {
      async refresh() {
        refreshes += 1;
        // Use unref() so a hung refresh doesn't keep the test process alive
        // past the test body — we don't need the refresh to actually finish,
        // we just need /api/state to NOT block on it.
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            resolve();
          }, hangMs);
          if (typeof timer.unref === "function") timer.unref();
          pendingTimers.add(timer);
        });
      },
      listBuildings() { return []; },
      listLayouts() { return []; },
      listRecipes() { return []; },
      listBundles() { return []; },
      getStatus() { return { sources: [], lastRefreshAt: 0 }; },
      getRefreshCount() { return refreshes; },
      // Test-only: clear any pending timers so app.close() returns promptly.
      __cancelPendingRefresh() {
        for (const timer of pendingTimers) clearTimeout(timer);
        pendingTimers.clear();
      },
    };
  };
}

async function startApp(options) {
  const cwd = options.cwd;
  const stateDir = path.join(cwd, ".vibe-research");
  const app = await createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd,
    stateDir,
    persistSessions: false,
    persistentTerminals: false,
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({ enabled: settings.preventSleepEnabled, platform: "test" }),
    ...options,
  });
  return { app, baseUrl: `http://127.0.0.1:${app.config.port}` };
}

test("/api/state returns within ~2.5s even when buildinghub.refresh() hangs for 8s", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-boot-fix-"));
  let app;
  try {
    const started = await startApp({
      cwd: tmp,
      buildingHubServiceFactory: makeHangingBuildingHubServiceFactory(8_000),
    });
    app = started.app;
    const t0 = Date.now();
    const res = await fetch(`${started.baseUrl}/api/state`, {
      signal: AbortSignal.timeout(5_000),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 200);
    // 2s race timeout + small overhead. If this exceeds 3.5s the fix is broken.
    assert.ok(elapsed < 3_500, `expected /api/state to return in <3.5s, got ${elapsed}ms`);
    const body = await res.json();
    // Even though refresh hadn't completed, the response should be well-formed
    // with whatever the cache had (empty arrays here).
    assert.ok(body.buildingHub, "expected buildingHub in response");
    assert.ok(Array.isArray(body.buildingHub.buildings));
  } finally {
    if (app) await app.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("/api/state returns immediately when buildinghub.refresh() resolves fast", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-boot-fix-fast-"));
  let app;
  try {
    const started = await startApp({
      cwd: tmp,
      buildingHubServiceFactory: makeHangingBuildingHubServiceFactory(50),
    });
    app = started.app;
    const t0 = Date.now();
    const res = await fetch(`${started.baseUrl}/api/state`, {
      signal: AbortSignal.timeout(5_000),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 200);
    // Should be well under the 2s race budget.
    assert.ok(elapsed < 1_500, `expected /api/state to return fast, got ${elapsed}ms`);
  } finally {
    if (app) await app.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("public/index.html has both BUNDLE_LOAD_TIMEOUT and APP_BOOT_TIMEOUT", async () => {
  // Doc-style test: confirm the inline boot-fallback distinguishes the two
  // failure cases and waits much longer for slow /api/state. If someone
  // collapses these back into one timeout, this test catches the regression.
  const html = await readFile(PUBLIC_INDEX, "utf8");
  assert.match(html, /BUNDLE_LOAD_TIMEOUT_MS\s*=\s*4000/);
  assert.match(html, /APP_BOOT_TIMEOUT_MS\s*=\s*20000/);
  // Bundle-loaded signal must be wired into both the event listener and the
  // global hook for main.js to call.
  assert.match(html, /vibe-research:bundle-loaded/);
  assert.match(html, /__vibeResearchBundleLoaded/);
  // Stage-1 watchdog only sets the error if the bundle never loaded.
  assert.match(html, /if \(!bundleLoaded\)/);
});

test("src/client/main.js dispatches vibe-research:bundle-loaded immediately at top-level", async () => {
  const main = await readFile(path.join(HERE, "..", "src", "client", "main.js"), "utf8");
  // markBundleLoaded is defined and called at module-evaluation time, BEFORE
  // any await. (We don't run the module here; we assert the source structure.)
  assert.match(main, /function markBundleLoaded\(\)/);
  assert.match(main, /vibe-research:bundle-loaded/);
  // The call site must be after the function definition and before bootstrapApp.
  const fnIdx = main.indexOf("function markBundleLoaded()");
  const callIdx = main.indexOf("\nmarkBundleLoaded();");
  const bootstrapIdx = main.indexOf("async function bootstrapApp");
  assert.ok(fnIdx > 0 && callIdx > fnIdx, "expected markBundleLoaded() call after definition");
  assert.ok(callIdx < bootstrapIdx, "expected markBundleLoaded() to be called before bootstrapApp definition runs");
});

test("/api/state is bounded even when listNamedPorts and buildinghub both hang", async () => {
  // Defense-in-depth: even with multiple slow async dependencies, /api/state
  // should never block past the boot fallback budget.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-boot-multi-hang-"));
  let app;
  try {
    const started = await startApp({
      cwd: tmp,
      buildingHubServiceFactory: makeHangingBuildingHubServiceFactory(8_000),
      listPorts: async () => {
        // Simulate a hung lsof / port-probe step.
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 8_000);
          if (typeof t.unref === "function") t.unref();
        });
        return [];
      },
    });
    app = started.app;
    const t0 = Date.now();
    const res = await fetch(`${started.baseUrl}/api/state`, {
      signal: AbortSignal.timeout(5_000),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 200);
    // Both timeouts run in PARALLEL (not sequentially), so the wall is
    // max(2s, 1.5s) = 2s + small overhead, NOT 2s + 1.5s = 3.5s. This
    // assertion guards the parallelization — if someone re-introduces a
    // sequential `await` chain, it'll fail loudly.
    assert.ok(elapsed < 2_800, `expected /api/state to return in <2.8s (parallel timeouts), got ${elapsed}ms`);
  } finally {
    if (app) await app.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("fetchJson has a default timeout that aborts hung requests", async () => {
  // Source-level assertion: fetchJson must wire AbortController + setTimeout
  // for the default 15s timeout. Without this, a stuck network never gets
  // surfaced — bootstrapApp hangs forever and the user sees a stale spinner.
  const main = await readFile(path.join(HERE, "..", "src", "client", "main.js"), "utf8");
  // Find the fetchJson body and confirm timeout wiring is present.
  const fetchJsonStart = main.indexOf("async function fetchJson(url, options = {})");
  assert.ok(fetchJsonStart > 0, "fetchJson definition not found");
  const fetchJsonBlock = main.slice(fetchJsonStart, fetchJsonStart + 4000);
  assert.match(fetchJsonBlock, /AbortController/);
  assert.match(fetchJsonBlock, /15_000/, "default timeout must be 15s");
  assert.match(fetchJsonBlock, /controller\.abort/);
});

test("public/index.html exposes a Retry button + wires __vibeResearchRetryBoot", async () => {
  const html = await readFile(PUBLIC_INDEX, "utf8");
  // Retry button visible to the user
  assert.match(html, /data-boot-retry/);
  // Click handler invokes the retry hook from main.js
  assert.match(html, /__vibeResearchRetryBoot/);
  // Stage-1 watchdog still differentiates bundle-load failure from in-flight boot
  assert.match(html, /BUNDLE_LOAD_TIMEOUT_MS\s*=\s*4000/);
  assert.match(html, /APP_BOOT_TIMEOUT_MS\s*=\s*20000/);
});

test("src/client/main.js exposes __vibeResearchRetryBoot for in-place retry", async () => {
  const main = await readFile(path.join(HERE, "..", "src", "client", "main.js"), "utf8");
  // Both the global hook and the bootstrap function must be present.
  assert.match(main, /window\.__vibeResearchRetryBoot\s*=/);
  assert.match(main, /function runBootstrap\(\)/);
  // The hook resets appBootReported so a successful retry re-fires the
  // boot-ready signal and dismisses the fallback.
  const retryIdx = main.indexOf("window.__vibeResearchRetryBoot =");
  const retryBlock = main.slice(retryIdx, retryIdx + 800);
  assert.match(retryBlock, /appBootReported\s*=\s*false/);
});
