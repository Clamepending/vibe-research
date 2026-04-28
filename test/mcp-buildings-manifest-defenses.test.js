// Defensive checks against MCP-server building manifests. Catches the
// kinds of typos that would silently leave a building broken in
// production — e.g. an mcp-launch step referencing ${mcpGithubToekn}
// instead of ${mcpGithubToken} would store the templated form in the
// registry forever and the launch would never resolve.
//
// These tests don't spawn anything; they just statically validate the
// manifest shape against the live SettingsStore defaults so a manifest
// PR fails CI before it ships a broken building.

import test from "node:test";
import assert from "node:assert/strict";

import { BUILDING_CATALOG } from "../src/client/building-registry.js";
import { SettingsStore } from "../src/settings-store.js";

const TEMPLATE_PATTERN = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function collectTemplateRefs(launch) {
  const refs = new Set();
  const harvest = (text) => {
    if (typeof text !== "string") return;
    TEMPLATE_PATTERN.lastIndex = 0;
    let match;
    while ((match = TEMPLATE_PATTERN.exec(text)) !== null) {
      refs.add(match[1]);
    }
  };
  harvest(launch.command);
  if (Array.isArray(launch.args)) {
    for (const arg of launch.args) harvest(arg);
  }
  if (launch.env && typeof launch.env === "object") {
    for (const value of Object.values(launch.env)) harvest(value);
  }
  return refs;
}

const MCP_BUILDINGS = BUILDING_CATALOG.filter((building) => building.category === "MCP");

test("MCP catalog: at least one MCP building is registered", () => {
  assert.ok(MCP_BUILDINGS.length >= 1, "at least one MCP building should be in the catalog");
});

for (const building of MCP_BUILDINGS) {
  test(`${building.id}: declares an install.plan with non-empty mcp launches`, () => {
    assert.ok(building.install?.plan, "must have install.plan");
    assert.ok(
      Array.isArray(building.install.plan.mcp) && building.install.plan.mcp.length > 0,
      "must declare at least one mcp-launch step",
    );
  });

  test(`${building.id}: every mcp-launch declares a non-empty command`, () => {
    for (const step of building.install.plan.mcp || []) {
      assert.equal(step.kind, "mcp-launch");
      assert.ok(typeof step.command === "string" && step.command.length > 0, `${building.id}: empty command`);
    }
  });

  test(`${building.id}: install plan has a non-empty preflight or verify (so it can fail loudly)`, () => {
    const plan = building.install.plan;
    const hasPreflight = Array.isArray(plan.preflight) && plan.preflight.length > 0;
    const hasVerify = Array.isArray(plan.verify) && plan.verify.length > 0;
    assert.ok(
      hasPreflight || hasVerify,
      "an MCP building with no preflight AND no verify can never report a meaningful failure",
    );
  });

  test(`${building.id}: every \${settingKey} template references a real settings-store key`, () => {
    // Build a fake SettingsStore to inspect the defaults shape. Pure
    // shape check — we don't load any persisted settings.
    const store = new SettingsStore({ cwd: process.cwd(), stateDir: "/tmp/_unused", env: {} });
    const validKeys = new Set(Object.keys(store.settings));
    const allRefs = new Set();
    for (const step of building.install.plan.mcp || []) {
      for (const ref of collectTemplateRefs(step)) allRefs.add(ref);
    }
    for (const ref of allRefs) {
      assert.ok(
        validKeys.has(ref),
        `${building.id}: template \${${ref}} does not match any settings-store key. ` +
          `Likely a typo. Valid keys with similar prefix: ${[...validKeys].filter((k) => k.toLowerCase().startsWith(ref.slice(0, 4).toLowerCase())).join(", ") || "(none found)"}`,
      );
    }
  });

  test(`${building.id}: if auth-paste declared, the target setting exists in the settings store`, () => {
    const auth = building.install.plan.auth;
    if (!auth) return;
    if (auth.kind !== "auth-paste") return;
    assert.ok(auth.setting, `${building.id}: auth-paste must name a setting`);
    const store = new SettingsStore({ cwd: process.cwd(), stateDir: "/tmp/_unused", env: {} });
    assert.ok(
      Object.prototype.hasOwnProperty.call(store.settings, auth.setting),
      `${building.id}: auth-paste references "${auth.setting}" which is not a registered settings key. ` +
        "Add it to settings-store.js defaults + normalize block, and to PATCH /api/settings allowlist.",
    );
  });

  test(`${building.id}: install.enabledSetting (if declared) exists in the settings store`, () => {
    const setting = building.install?.enabledSetting;
    if (!setting) return;
    const store = new SettingsStore({ cwd: process.cwd(), stateDir: "/tmp/_unused", env: {} });
    assert.ok(
      Object.prototype.hasOwnProperty.call(store.settings, setting),
      `${building.id}: install.enabledSetting "${setting}" is not a registered settings key`,
    );
  });
}
