import assert from "node:assert/strict";
import test from "node:test";
import { BUILDING_CATALOG } from "../src/client/building-registry.js";

test("core building catalog exposes BuildingHub as a manifest-only community source", () => {
  const buildingHub = BUILDING_CATALOG.find((building) => building.id === "buildinghub");
  assert.ok(buildingHub);
  assert.equal(buildingHub.category, "Community");
  assert.equal(buildingHub.install.system, true);
  assert.equal(buildingHub.install.enabledSetting, "");
  assert.equal(buildingHub.ui.workspaceView, "plugins");
  assert.match(buildingHub.access.detail, /do not run executable code/i);
  assert.ok(
    buildingHub.onboarding.steps.some((step) =>
      step.completeWhen?.setting === "buildingHubEnabled"
    ),
  );
});
