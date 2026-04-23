import assert from "node:assert/strict";
import test from "node:test";
import { Wrench } from "lucide";
import { BUILDING_CATALOG } from "../src/client/building-registry.js";

test("core building catalog exposes BuildingHub as a manifest-only community source", () => {
  const buildingHub = BUILDING_CATALOG.find((building) => building.id === "buildinghub");
  assert.ok(buildingHub);
  assert.equal(buildingHub.category, "Community");
  assert.equal(buildingHub.install.system, true);
  assert.equal(buildingHub.install.enabledSetting, "");
  assert.deepEqual(buildingHub.icon, Wrench);
  assert.equal(buildingHub.visual.shape, "plugin");
  assert.equal(buildingHub.ui.workspaceView, "plugins");
  assert.match(buildingHub.access.detail, /do not run executable code/i);
  assert.match(buildingHub.description, /skins, themes/i);
  assert.match(buildingHub.access.detail, /browser-local Agent Town preferences/i);
  assert.ok(buildingHub.agentGuide.useCases.some((useCase) => /themes/i.test(useCase)));
  assert.ok(
    buildingHub.onboarding.steps.some((step) =>
      step.completeWhen?.setting === "buildingHubEnabled"
    ),
  );
});
