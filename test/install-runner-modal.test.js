// Live integration test: run the Modal building's install plan via the
// install-runner and confirm we end at status "ok" without modifying any
// installed Modal credentials.
//
// Skipped automatically on machines without a `modal` CLI on PATH. This
// keeps CI happy while still proving the plan works on the developer
// machine where Modal is already configured.

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

import { BUILDING_CATALOG } from "../src/client/building-registry.js";
import { executeInstallPlan } from "../src/install-runner.js";

function modalAvailable() {
  try {
    execSync("command -v modal", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function modalAuthed() {
  try {
    execSync("modal token info", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

test("modal install plan: preflight + verify pass when CLI is installed and auth'd", async (t) => {
  if (!modalAvailable()) {
    t.skip("modal CLI not on PATH");
    return;
  }
  if (!modalAuthed()) {
    t.skip("modal token info fails — no live token to verify against");
    return;
  }

  const modal = BUILDING_CATALOG.find((entry) => entry.id === "modal");
  assert.ok(modal, "modal building must exist in catalog");
  assert.ok(modal.install?.plan, "modal building must declare an install plan");

  const log = [];
  const result = await executeInstallPlan(modal.install.plan, {
    appendLog: (entry) => log.push(entry),
  });

  assert.equal(result.status, "ok", `expected ok, got ${result.status}: ${result.reason || ""}`);

  // Sanity: preflight should have detected the existing install and skipped
  // the install phase entirely (i.e. no `pip install` should have run).
  const installRan = log.some((entry) => entry.phase === "install" && entry.message?.startsWith("running"));
  assert.equal(installRan, false, "install phase must be skipped when preflight detects existing modal CLI");

  const verifyRan = log.some((entry) => entry.phase === "verify" && entry.step === "Verify Modal token");
  assert.equal(verifyRan, true);
});
