// Regression tests for the "Add Modal" / "Add <building>" button:
//
// When a functional Agent Town building is already placed on the map but the
// install hasn't completed yet (its enabled-setting is still false because
// `storedFallback: false`), clicking the side-panel "Add <building>" button
// previously called startFunctionalPluginPlacementInstall(), which kicked
// the user back into placement mode — asking them to re-place a building
// that was already placed.
//
// The fix: startFunctionalPluginPlacementInstall now short-circuits when
// getAgentTownFunctionalPlacement(pluginId) already returns a placement, by
// running the install plan via setPluginInstalled(..., { force: true })
// directly. setPluginInstalled flips the enabled-setting and then runs
// runBuildingInstallPlan, which kicks off the building's auth flow (e.g.
// `modal token new --source web` for Modal — the page the user actually
// expected to land on).
//
// These tests assert source-structure invariants on src/client/main.js,
// matching the pattern in test/boot-fallback-fix.test.js for testing the
// browser bundle without spinning up a full DOM.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS_PATH = path.join(HERE, "..", "src", "client", "main.js");

// Slice the body of a top-level `function name(...) { ... }` declaration out
// of a source string by tracking brace depth. Returns the substring between
// the opening `{` of the function body and its matching `}`. Throws if the
// function is missing. Correctly skips destructuring patterns and default
// values inside the parameter list (e.g. `({ force = false } = {})`).
function extractFunctionBody(source, functionName) {
  const signature = `function ${functionName}(`;
  const headIdx = source.indexOf(signature);
  assert.ok(headIdx >= 0, `function ${functionName} not found in main.js`);

  // Walk past the parameter list by tracking paren depth from the `(` that
  // ends the signature. Default-value object/array literals inside the
  // params can contain unbalanced braces relative to the body, so we MUST
  // find the closing `)` of the parameter list first, then look for `{`.
  const parenStart = headIdx + signature.length - 1;
  let parenDepth = 0;
  let cursor = parenStart;
  for (; cursor < source.length; cursor += 1) {
    const ch = source[cursor];
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        cursor += 1;
        break;
      }
    }
  }
  assert.ok(parenDepth === 0, `unterminated parameter list for ${functionName}`);

  const openIdx = source.indexOf("{", cursor);
  assert.ok(openIdx >= 0, `opening brace for ${functionName} not found`);

  let depth = 0;
  let inString = null; // null | '"' | "'" | "`"
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;

  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }

    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIdx + 1, i);
      }
    }
  }

  throw new Error(`unterminated body for ${functionName}`);
}

test("startFunctionalPluginPlacementInstall short-circuits when the building is already placed", async () => {
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const body = extractFunctionBody(source, "startFunctionalPluginPlacementInstall");

  // The new branch must consult getAgentTownFunctionalPlacement.
  assert.match(
    body,
    /getAgentTownFunctionalPlacement\(\s*normalizedPluginId\s*\)/,
    "startFunctionalPluginPlacementInstall must check whether the building is already placed",
  );

  // It must trigger the install plan via setPluginInstalled with force:true,
  // which is the codepath that runs runBuildingInstallPlan.
  assert.match(
    body,
    /setPluginInstalled\(\s*normalizedPluginId\s*,\s*true\s*,\s*\{\s*force:\s*true\s*\}\s*\)/,
    "the already-placed branch must call setPluginInstalled with force:true so runBuildingInstallPlan fires",
  );

  // It must return true so the click handler doesn't fire the
  // "Could not start placement" alert.
  const placementCheckIdx = body.indexOf("getAgentTownFunctionalPlacement(normalizedPluginId)");
  assert.ok(placementCheckIdx >= 0);
  const sliceAfterCheck = body.slice(placementCheckIdx);
  assert.match(
    sliceAfterCheck,
    /return\s+true/,
    "the already-placed branch must return true so the caller doesn't show 'Could not start placement'",
  );
});

test("the already-placed branch runs BEFORE setPluginInstallPlacementPending so we don't strand the building in pending state", async () => {
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const body = extractFunctionBody(source, "startFunctionalPluginPlacementInstall");

  // If we set placement-pending and then short-circuit, the building's
  // builder card stays "installing..." with no way to clear it.
  // The placement-check + setPluginInstalled + return-true block must come
  // strictly before the call that sets the placement-pending flag.
  const checkIdx = body.indexOf("getAgentTownFunctionalPlacement(normalizedPluginId)");
  const pendingIdx = body.indexOf("setPluginInstallPlacementPending(normalizedPluginId, true)");
  assert.ok(checkIdx >= 0 && pendingIdx >= 0);
  assert.ok(
    checkIdx < pendingIdx,
    "already-placed short-circuit must come before setPluginInstallPlacementPending(true), otherwise the card stays stuck",
  );
});

test("the not-installed-but-not-placed branch still triggers placement (the existing happy path)", async () => {
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const body = extractFunctionBody(source, "startFunctionalPluginPlacementInstall");

  // Original placement codepath must still exist for buildings that haven't
  // been placed yet. If someone collapses the new short-circuit on top of
  // the placement call, this catches it.
  assert.match(
    body,
    /startAgentTownFunctionalPlacement\(\s*normalizedPluginId/,
    "the placement codepath must still exist for never-placed buildings",
  );
  assert.match(
    body,
    /setAgentTownBuilderFeedback\(\s*`Place \$\{plugin\.name\} to finish install`/,
    "the placement codepath must still surface the Place-to-finish-install nudge",
  );
});

test("startFunctionalPluginPlacementInstall still rejects already-installed plugins", async () => {
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const body = extractFunctionBody(source, "startFunctionalPluginPlacementInstall");

  // The existing isPluginInstalled guard must remain BEFORE the placement
  // check — otherwise an already-installed building would re-trigger the
  // install plan unnecessarily on every click.
  const installedGuardIdx = body.indexOf("if (isPluginInstalled(plugin))");
  const placementCheckIdx = body.indexOf("getAgentTownFunctionalPlacement(normalizedPluginId)");
  assert.ok(installedGuardIdx >= 0, "isPluginInstalled() guard is missing");
  assert.ok(placementCheckIdx >= 0);
  assert.ok(
    installedGuardIdx < placementCheckIdx,
    "isPluginInstalled() guard must run before the already-placed short-circuit",
  );
});

test("the [data-plugin-finish-install] click handler still routes through startFunctionalPluginPlacementInstall", async () => {
  // The handler is the side-panel "Add <building>" button. It calls
  // startFunctionalPluginPlacementInstall, which now contains the
  // already-placed short-circuit. This test asserts the handler still
  // routes through that single decision point so the fix is reached.
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const handlerIdx = source.indexOf('document.querySelectorAll("[data-plugin-finish-install]")');
  assert.ok(handlerIdx >= 0, "data-plugin-finish-install handler missing");

  // Slice forward to the end of the forEach callback (depth-track from the
  // opening '(' of querySelectorAll(...).forEach(...)).
  const slice = source.slice(handlerIdx, handlerIdx + 1500);
  assert.match(
    slice,
    /startFunctionalPluginPlacementInstall\(pluginId\)/,
    "data-plugin-finish-install handler must call startFunctionalPluginPlacementInstall so the already-placed short-circuit is reached",
  );
});

test("the [data-plugin-install] click handler also routes through startFunctionalPluginPlacementInstall", async () => {
  // The plugin-list "Install" toggle has the same branching. It must reach
  // the already-placed short-circuit too — otherwise the bug recurs from
  // the plugins-list surface even after being fixed in the side-panel.
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const handlerIdx = source.indexOf('document.querySelectorAll("[data-plugin-install]")');
  assert.ok(handlerIdx >= 0, "data-plugin-install handler missing");

  const slice = source.slice(handlerIdx, handlerIdx + 1500);
  assert.match(
    slice,
    /startFunctionalPluginPlacementInstall\(pluginId\)/,
    "data-plugin-install handler must call startFunctionalPluginPlacementInstall so the already-placed short-circuit is reached",
  );
});

test("Modal's install plan still authenticates via auth-browser-cli — that's the page the user expects after Add Modal", async () => {
  // The whole point of the fix is to get the user to Modal's auth flow
  // (the "API key page"). If someone removes the auth step from Modal's
  // plan, the fix would route to setPluginInstalled but no auth would
  // open, putting us back to "I clicked Add Modal and nothing happened."
  const { BUILDING_CATALOG } = await import("../src/client/building-registry.js");
  const modal = BUILDING_CATALOG.find((building) => building.id === "modal");
  assert.ok(modal, "modal building must exist");
  assert.ok(modal.install?.plan, "modal must declare a one-click install plan");
  assert.equal(modal.install.plan.auth?.kind, "auth-browser-cli", "modal install plan must auth via the browser CLI flow");
  assert.match(
    modal.install.plan.auth.command,
    /modal token new --source web/,
    "modal auth must call `modal token new --source web` — that's what opens the API-token page in the browser",
  );

  // storedFallback:false is what makes isPluginInstalled return false until
  // modalEnabled flips. The fix relies on this state existing — if someone
  // changes storedFallback to true, the bug we're fixing doesn't trigger
  // (and this test is the breadcrumb explaining why).
  assert.equal(
    modal.install.storedFallback,
    false,
    "modal.install.storedFallback must be false — that's the state in which isPluginInstalled() reports false even after placement",
  );
});

// Behavioral test: extract the actual function source from main.js and run
// it in a sandbox with mocked dependencies. This is a stronger guarantee
// than source-level regex — it exercises the real branching logic.
function buildSandbox() {
  const calls = {
    setPluginInstalled: [],
    setPluginInstallPlacementPending: [],
    startAgentTownFunctionalPlacement: [],
    setAgentTownBuilderFeedback: [],
  };

  const sandbox = {
    state: { pluginInstallActions: {} },
    plugins: new Map(),
    placements: new Map(),
    installedSettings: new Set(),
    setPlacement(id, rect) {
      this.placements.set(id, rect);
    },
  };

  const env = {
    state: sandbox.state,
    getPluginById: (id) => sandbox.plugins.get(id) || null,
    getPluginId: (plugin) => plugin?.id || "",
    isAgentTownFunctionalPlugin: (plugin) => Boolean(plugin?.functional),
    isPluginInstalled: (plugin) => sandbox.installedSettings.has(plugin?.id),
    getAgentTownFunctionalPlacement: (id) => sandbox.placements.get(id) || null,
    setPluginInstalled: (...args) => {
      calls.setPluginInstalled.push(args);
      return Promise.resolve();
    },
    setPluginInstallPlacementPending: (...args) => {
      calls.setPluginInstallPlacementPending.push(args);
    },
    startAgentTownFunctionalPlacement: (id, opts) => {
      calls.startAgentTownFunctionalPlacement.push([id, opts]);
      return true;
    },
    setAgentTownBuilderFeedback: (...args) => {
      calls.setAgentTownBuilderFeedback.push(args);
    },
  };

  return { sandbox, env, calls };
}

async function loadStartFn(envForFn) {
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const headIdx = source.indexOf("function startFunctionalPluginPlacementInstall(");
  assert.ok(headIdx >= 0);
  // Find matching closing brace for the function.
  const openIdx = source.indexOf("{", headIdx);
  let depth = 0;
  let endIdx = openIdx;
  for (let i = openIdx; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }
  const fnSource = source.slice(headIdx, endIdx);

  // Wrap in a factory: pass deps in via a closure scope.
  const factorySource = `
    return function (deps) {
      const {
        state,
        getPluginById,
        getPluginId,
        isAgentTownFunctionalPlugin,
        isPluginInstalled,
        getAgentTownFunctionalPlacement,
        setPluginInstalled,
        setPluginInstallPlacementPending,
        startAgentTownFunctionalPlacement,
        setAgentTownBuilderFeedback,
      } = deps;
      ${fnSource}
      return startFunctionalPluginPlacementInstall;
    };
  `;
  // eslint-disable-next-line no-new-func
  const factory = new Function(factorySource)();
  return factory(envForFn);
}

test("[behavioral] already-placed building short-circuits to setPluginInstalled with force:true and skips placement", async () => {
  const { sandbox, env, calls } = buildSandbox();
  sandbox.plugins.set("modal", { id: "modal", name: "Modal", functional: true });
  sandbox.setPlacement("modal", { x: 1, y: 2, width: 3, height: 3, rotation: 0 });
  // modalEnabled is still false → not installed yet.

  const start = await loadStartFn(env);
  const result = start("modal");

  assert.equal(result, true, "must return true so the click handler does not show 'Could not start placement'");
  assert.equal(calls.setPluginInstalled.length, 1, "setPluginInstalled must be called exactly once");
  assert.deepEqual(
    calls.setPluginInstalled[0],
    ["modal", true, { force: true }],
    "must call setPluginInstalled('modal', true, { force: true })",
  );
  assert.equal(calls.startAgentTownFunctionalPlacement.length, 0, "placement must NOT be started — building is already placed");
  assert.equal(calls.setPluginInstallPlacementPending.length, 0, "placement-pending flag must NOT be set");
  assert.equal(calls.setAgentTownBuilderFeedback.length, 0, "no 'Place to finish install' nudge — there's nothing to place");
  assert.deepEqual(sandbox.state.pluginInstallActions, {}, "pluginInstallActions['modal'] must NOT be set to 'installing' (setPluginInstalled handles its own pending state)");
});

test("[behavioral] not-yet-placed building still triggers placement (regression guard)", async () => {
  const { sandbox, env, calls } = buildSandbox();
  sandbox.plugins.set("modal", { id: "modal", name: "Modal", functional: true });
  // No placement; modalEnabled false.

  const start = await loadStartFn(env);
  const result = start("modal");

  assert.equal(result, true);
  assert.equal(calls.setPluginInstalled.length, 0, "setPluginInstalled must NOT be called yet — placement comes first");
  assert.equal(calls.startAgentTownFunctionalPlacement.length, 1, "placement must be started for never-placed buildings");
  assert.equal(calls.setPluginInstallPlacementPending.length, 1);
  assert.deepEqual(calls.setPluginInstallPlacementPending[0], ["modal", true]);
  assert.equal(sandbox.state.pluginInstallActions.modal, "installing");
  assert.equal(calls.setAgentTownBuilderFeedback.length, 1);
  assert.match(calls.setAgentTownBuilderFeedback[0][0], /Place Modal to finish install/);
});

test("[behavioral] already-installed building is rejected (no double-install loop)", async () => {
  const { sandbox, env, calls } = buildSandbox();
  sandbox.plugins.set("modal", { id: "modal", name: "Modal", functional: true });
  sandbox.installedSettings.add("modal");
  sandbox.setPlacement("modal", { x: 1, y: 2, width: 3, height: 3, rotation: 0 });

  const start = await loadStartFn(env);
  const result = start("modal");

  assert.equal(result, false, "already-installed must return false");
  assert.equal(calls.setPluginInstalled.length, 0);
  assert.equal(calls.startAgentTownFunctionalPlacement.length, 0);
});

test("[behavioral] non-functional plugin is rejected", async () => {
  const { sandbox, env, calls } = buildSandbox();
  sandbox.plugins.set("system", { id: "system", name: "System", functional: false });

  const start = await loadStartFn(env);
  const result = start("system");

  assert.equal(result, false);
  assert.equal(calls.setPluginInstalled.length, 0);
});

test("[behavioral] unknown plugin id is rejected", async () => {
  const { env, calls } = buildSandbox();

  const start = await loadStartFn(env);
  const result = start("nonexistent");

  assert.equal(result, false);
  assert.equal(calls.setPluginInstalled.length, 0);
});

test("[behavioral] failed startAgentTownFunctionalPlacement clears pending state and returns false", async () => {
  const { sandbox, env, calls } = buildSandbox();
  sandbox.plugins.set("modal", { id: "modal", name: "Modal", functional: true });
  // Override: make placement fail.
  env.startAgentTownFunctionalPlacement = (id, opts) => {
    calls.startAgentTownFunctionalPlacement.push([id, opts]);
    return false;
  };

  const start = await loadStartFn(env);
  const result = start("modal");

  assert.equal(result, false);
  // Pending was set to true, then must be cleared back to false.
  assert.deepEqual(
    calls.setPluginInstallPlacementPending.map((args) => args[1]),
    [true, false],
    "must clear placement-pending flag when placement fails",
  );
  assert.equal(sandbox.state.pluginInstallActions.modal, undefined, "must clear pluginInstallActions[id]");
});

test("applySettingsState pulls modalEnabled from the /api/settings response", async () => {
  // The bug: server PATCH /api/settings returns { modalEnabled: true } when
  // the building is installed, but applySettingsState rebuilt state.settings
  // from an explicit field map that did NOT include modalEnabled. So
  // isPluginInstalled(modal) — which checks state.settings.modalEnabled
  // because Modal's `install.storedFallback` is false — stayed false even
  // after a successful install. The "Add Modal" button never disappeared,
  // and clicking it just re-ran the install while the UI sat still.
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const body = extractFunctionBody(source, "applySettingsState");

  assert.match(
    body,
    /modalEnabled\s*:\s*\n?\s*settings\.modalEnabled\s*===\s*undefined/,
    "applySettingsState must read settings.modalEnabled from the server payload",
  );
});

test("Modal's enabled-setting key is declared in initial state.settings", async () => {
  // Defense: even if applySettingsState reads modalEnabled, isPluginInstalled
  // walks state.settings and a missing initial key would briefly render the
  // building as not-installed during the very first paint. Both halves of
  // this contract need to be in place.
  const { BUILDING_CATALOG } = await import("../src/client/building-registry.js");
  const modal = BUILDING_CATALOG.find((b) => b.id === "modal");
  assert.equal(modal.install.enabledSetting, "modalEnabled");
  assert.equal(modal.install.storedFallback, false, "Modal relies on enabledSetting being authoritative — storedFallback must be false");

  const source = await readFile(MAIN_JS_PATH, "utf8");
  const initialDefaults = source.slice(source.indexOf("settings: {"), source.indexOf("settings: {") + 6000);
  assert.match(initialDefaults, /modalEnabled\s*:\s*false/, "initial state.settings must declare modalEnabled");
});

test("buildings with visual.logoImage render an image-backed sign and the asset exists on disk", async () => {
  // We replaced the CSS-painted "logo" pseudo-element with a real
  // background-image for buildings whose brand mark is best shown
  // verbatim (Modal, GitHub, Automations). This test guards three
  // properties: (a) the manifest declares a logoImage path, (b) the
  // path actually exists in public/images/buildings/, (c) the renderer
  // emits a `.plugin-building-sign-image` element when logoImage is
  // present (and not when it's absent).
  const { BUILDING_CATALOG } = await import("../src/client/building-registry.js");
  const { existsSync } = await import("node:fs");
  const path = await import("node:path");
  const fileURL = await import("node:url");
  const here = path.dirname(fileURL.fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");

  const expected = ["modal", "github", "automations"];
  for (const id of expected) {
    const building = BUILDING_CATALOG.find((b) => b.id === id);
    assert.ok(building, `building ${id} must exist in the catalog`);
    const logoImage = String(building.visual?.logoImage || "").trim();
    assert.ok(logoImage, `${id} must declare visual.logoImage`);
    assert.match(logoImage, /^\/images\/buildings\//, `${id}.visual.logoImage must point under /images/buildings/`);
    const onDisk = path.join(repoRoot, "public", logoImage.replace(/^\//, ""));
    assert.ok(existsSync(onDisk), `${id} logoImage asset missing on disk: ${onDisk}`);
  }

  const source = await readFile(MAIN_JS_PATH, "utf8");
  const body = extractFunctionBody(source, "renderPluginBuildingSign");
  assert.match(body, /visual\?\.logoImage/, "renderPluginBuildingSign must read visual.logoImage");
  assert.match(body, /plugin-building-sign-image/, "renderPluginBuildingSign must emit the image-backed class");
  // Image branch must run before the CSS-pseudo logo branch so manifests
  // declaring both fall through to the image (the more specific brand mark).
  const imageIdx = body.indexOf("plugin-building-sign-image");
  const pseudoIdx = body.indexOf("plugin-building-logo-");
  assert.ok(imageIdx >= 0 && pseudoIdx >= 0);
  assert.ok(imageIdx < pseudoIdx, "image-backed sign branch must run before the CSS-pseudo logo branch");
});

test("logoImage is stripped from community building manifests (CSS-injection mitigation)", async () => {
  // visual.logoImage flows into `style="background-image: url('...')"`
  // — community manifests are untrusted, and even with escapeHtml() a
  // crafted URL plus a syntactic mistake could break out of the style
  // context. Built-in buildings bypass the normalizer; community
  // manifests must have logoImage zeroed out. This test pins that
  // behaviour so a future refactor can't accidentally widen the trust
  // boundary.
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const normalizer = extractFunctionBody(source, "normalizeCommunityBuildingForClient");
  // The visual block must explicitly null out logoImage.
  assert.match(normalizer, /logoImage:\s*""/, "community manifests must zero out visual.logoImage");
});

test("user-facing buildings declare agentGuide.docs so the ready panel always shows quick-access doc links", async () => {
  // The collapsed ready panel renders building-name + access label + doc
  // links. Without agentGuide.docs the panel shows just the name — a UX
  // regression for the "where do I find docs once installed?" question.
  // This test pins the major user-facing buildings to a docs-present
  // contract; if a future refactor wipes them out, this catches it.
  const { BUILDING_CATALOG } = await import("../src/client/building-registry.js");

  const userFacing = [
    "github",
    "gmail",
    "google-calendar",
    "google-drive",
    "modal",
    "zinc",
    "wandb",
    "ottoauth",
    "browser-use",
    "videomemory",
    "agentmail",
    "telegram",
  ];

  for (const id of userFacing) {
    const b = BUILDING_CATALOG.find((x) => x.id === id);
    assert.ok(b, `${id} must exist in the catalog`);
    const docs = b.agentGuide?.docs;
    assert.ok(Array.isArray(docs) && docs.length >= 1, `${id} must declare at least one agentGuide.docs entry so the ready panel has a doc shortcut`);
    for (const doc of docs) {
      assert.ok(typeof doc.label === "string" && doc.label.trim().length > 0, `${id} docs entry must have a non-empty label`);
      assert.match(doc.url || "", /^https?:\/\//, `${id} docs entry must have an http(s) url, got: ${doc.url}`);
    }
  }
});

test("ready panel generalises across buildings: any system app or fully-configured building hits the collapsed view", async () => {
  // The user's ask was "make sure GitHub / Telegram / Gmail / GCal work
  // the same way." The check is generic by design — isPluginFullyReady
  // doesn't hard-code Modal — but this test locks that in by walking
  // the catalog and proving every building category that should reach
  // the fully-ready state is structurally covered.
  const { BUILDING_CATALOG } = await import("../src/client/building-registry.js");

  // Pick representatives across the auth-flow shapes the codebase actually uses.
  const cases = [
    { id: "github", reason: "install.system: true (always installed, no completeWhen on steps)" },
    { id: "gmail", reason: "Google system app, completeWhen: buildingAccessConfirmed" },
    { id: "google-calendar", reason: "Google system app, completeWhen: buildingAccessConfirmed" },
    { id: "telegram", reason: "enabledSetting + paste tokens, completeWhen: allConfigured" },
    { id: "modal", reason: "auth-browser-cli plan, completeWhen: type=installed" },
  ];

  for (const { id, reason } of cases) {
    const building = BUILDING_CATALOG.find((b) => b.id === id);
    assert.ok(building, `${id} must exist in the catalog (${reason})`);
    // Either the building has no completeWhen-tracked steps (system apps
    // like GitHub), or it has at least one — both cases must reach
    // fully-ready when conditions are met. Documenting the contract.
    const steps = Array.isArray(building.onboarding?.steps) ? building.onboarding.steps : [];
    const trackedSteps = steps.filter((s) => s?.completeWhen);
    assert.ok(
      trackedSteps.length === 0 || trackedSteps.every((s) => s.completeWhen && typeof s.completeWhen === "object"),
      `${id} steps with completeWhen must use the standard object form so isPluginOnboardingStepComplete recognises them`,
    );
  }

  // Source-level: isPluginFullyReady doesn't reference any specific
  // building id — that's how we know the ready panel generalises.
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const body = extractFunctionBody(source, "isPluginFullyReady");
  for (const id of cases.map((c) => c.id)) {
    assert.ok(
      !body.includes(`"${id}"`) && !body.includes(`'${id}'`),
      `isPluginFullyReady must stay building-agnostic — found a hardcoded reference to "${id}"`,
    );
  }
});

test("renderPluginDetailSettings switches to a collapsed ready panel when isPluginFullyReady is true", async () => {
  // Source-level guard. The fully-ready check + ready-panel render must
  // wire through renderPluginDetailSettings; otherwise the verbose
  // 4-step / 4-card setup view leaks into the installed state again.
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const settingsBody = extractFunctionBody(source, "renderPluginDetailSettings");

  // The ready-panel check must exist and call renderPluginReadyPanel.
  assert.match(
    settingsBody,
    /isPluginFullyReady\(plugin\)/,
    "renderPluginDetailSettings must consult isPluginFullyReady",
  );
  assert.match(
    settingsBody,
    /return renderPluginReadyPanel\(plugin\)/,
    "renderPluginDetailSettings must short-circuit to renderPluginReadyPanel when fully ready",
  );

  // The ready-panel branch must run AFTER the issue check (so a building
  // with auth-required or other issues falls through to the next-step
  // action) but BEFORE the verbose access/onboarding render block.
  const issueIdx = settingsBody.indexOf("if (issue) {");
  const readyIdx = settingsBody.indexOf("isPluginFullyReady(plugin)");
  const accessIdx = settingsBody.indexOf("getPluginAccess(plugin)");
  assert.ok(issueIdx >= 0 && readyIdx >= 0 && accessIdx >= 0);
  assert.ok(
    issueIdx < readyIdx,
    "fully-ready check must come AFTER the issue check (issues like auth-required take precedence)",
  );
  assert.ok(
    readyIdx < accessIdx,
    "fully-ready check must come BEFORE the verbose access/onboarding render so it intercepts cleanly",
  );
});

test("isPluginFullyReady requires installed + no issue + no install job in non-ok state + onboarding complete", async () => {
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const body = extractFunctionBody(source, "isPluginFullyReady");

  assert.match(body, /isPluginInstalled\(plugin\)/, "must require isPluginInstalled");
  assert.match(body, /getPluginBuildingIssue\(plugin\)/, "must require no building issue");
  assert.match(body, /buildingInstallJobs/, "must check the install-job state");
  assert.match(
    body,
    /installJob\.status\s*&&\s*installJob\.status\s*!==\s*["']ok["']/,
    "an install job in any non-ok terminal state must keep us out of the ready view",
  );
  assert.match(body, /getPluginOnboardingProgress\(plugin\)/, "must check onboarding completion");
});

test("setPluginInstalled fires runBuildingInstallPlan when force:true and plugin has install.plan", async () => {
  // The already-placed short-circuit relies on setPluginInstalled actually
  // running the install plan. setPluginInstalled has a hasPluginSetupFlow
  // guard that would otherwise open the plugin detail panel instead of
  // running the plan. force:true bypasses that guard. This test asserts
  // both halves are still wired.
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const body = extractFunctionBody(source, "setPluginInstalled");

  // The setup-flow guard must explicitly skip when force is true.
  assert.match(
    body,
    /hasPluginSetupFlow\(plugin\)\s*&&\s*!force/,
    "setPluginInstalled must let force:true bypass the hasPluginSetupFlow short-circuit",
  );

  // After settings flip, runBuildingInstallPlan must run for plugins that
  // declare a plan (Modal does).
  assert.match(
    body,
    /plugin\.install\?\.plan/,
    "setPluginInstalled must check for plugin.install.plan",
  );
  assert.match(
    body,
    /runBuildingInstallPlan\(plugin\)/,
    "setPluginInstalled must call runBuildingInstallPlan when plugin has a plan",
  );
});
