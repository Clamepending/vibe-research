import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createVibeResearchApp } from "../src/create-app.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const shellProvider = {
  id: "shell",
  label: "Vanilla Shell",
  command: null,
  launchCommand: null,
  defaultName: "Shell",
  available: true,
};

async function createTempWorkspace(prefix) {
  return mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function createBuildingHubCatalog() {
  const catalogDir = await createTempWorkspace("vr-buildinghub-catalog");
  const buildingDir = path.join(catalogDir, "buildings", "community-linear");
  const layoutDir = path.join(catalogDir, "layouts", "community-main-street");
  const recipeDir = path.join(catalogDir, "recipes", "community-research");
  await mkdir(buildingDir, { recursive: true });
  await mkdir(layoutDir, { recursive: true });
  await mkdir(recipeDir, { recursive: true });
  await writeFile(
    path.join(buildingDir, "building.json"),
    JSON.stringify(
      {
        id: "community-linear",
        name: "Community Linear",
        category: "Project Management",
        description: "Coordinate issue triage from a community manifest.",
        status: "manifest ready",
        access: {
          label: "Linear token",
          detail: "Requires a Linear API token configured outside the manifest.",
        },
        onboarding: {
          steps: [
            {
              title: "Install the building",
              detail: "Add the manifest to the town.",
              completeWhen: { type: "installed" },
            },
          ],
        },
        ui: {
          sidebarTab: {
            enabled: true,
            label: "Linear Ops",
            meta: "community triage",
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(recipeDir, "recipe.json"),
    JSON.stringify(
      {
        schema: "vibe-research.scaffold.recipe.v1",
        id: "community-research",
        name: "Community Research",
        description: "A BuildingHub recipe with a layout and communication policy.",
        settings: {
          portable: {
            agentCommunicationDmEnabled: true,
            buildingHubEnabled: true,
          },
        },
        communication: {
          dm: {
            enabled: true,
            body: "freeform",
            visibility: "workspace",
          },
          groupInboxes: ["resource-hall"],
        },
        buildings: [
          { id: "community-linear", name: "Community Linear", required: true },
        ],
        layout: {
          decorations: [
            { id: "road-1", itemId: "road-square", x: 280, y: 252 },
          ],
          functional: {
            "community-linear": { x: 336, y: 224 },
          },
        },
      },
      null,
      2,
    ),
  );

  await writeFile(
    path.join(layoutDir, "layout.json"),
    JSON.stringify(
      {
        id: "community-main-street",
        name: "Community Main Street",
        description: "A shared town layout from the BuildingHub repository.",
        tags: ["street", "starter"],
        requiredBuildings: ["community-linear"],
        layout: {
          decorations: [
            { id: "road-1", itemId: "road-square", x: 280, y: 252 },
            { id: "road-2", itemId: "road-square", x: 308, y: 252 },
            { id: "planter-1", itemId: "planter", x: 308, y: 280 },
          ],
          functional: {
            "community-linear": { x: 336, y: 224 },
          },
        },
      },
      null,
      2,
    ),
  );
  return catalogDir;
}

async function startApp(options = {}) {
  const cwd = options.cwd || process.cwd();
  const stateDir = options.stateDir || path.join(cwd, ".vibe-research");
  const app = await createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd,
    stateDir,
    persistSessions: false,
    persistentTerminals: false,
    providers: [shellProvider],
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({
        enabled: settings.preventSleepEnabled,
        platform: "test",
      }),
    ...options,
  });

  return {
    app,
    baseUrl: `http://127.0.0.1:${app.config.port}`,
  };
}

test("Vibe Research exposes BuildingHub catalogs through settings and state", async () => {
  const workspaceDir = await createTempWorkspace("vr-buildinghub-workspace");
  const stateDir = await createTempWorkspace("vr-buildinghub-state");
  const catalogDir = await createBuildingHubCatalog();
  const { app, baseUrl } = await startApp({ cwd: workspaceDir, stateDir });

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buildingHubCatalogPath: catalogDir,
        buildingHubEnabled: true,
      }),
    });
    assert.equal(settingsResponse.status, 200);
    const settingsPayload = await settingsResponse.json();
    assert.equal(settingsPayload.settings.buildingHubCatalogPath, catalogDir);
    assert.equal(settingsPayload.settings.buildingHubEnabled, true);
    assert.equal(settingsPayload.settings.installedPluginIds.includes("buildinghub"), false);

    const catalogResponse = await fetch(`${baseUrl}/api/buildinghub/catalog?force=1`);
    assert.equal(catalogResponse.status, 200);
    const catalogPayload = await catalogResponse.json();
    assert.equal(catalogPayload.buildingHub.enabled, true);
    assert.equal(catalogPayload.buildingHub.buildingCount, 1);
    assert.equal(catalogPayload.buildingHub.layoutCount, 1);
    assert.equal(catalogPayload.buildingHub.recipeCount, 1);
    assert.equal(catalogPayload.buildings[0].id, "community-linear");
    assert.equal(catalogPayload.buildings[0].source, "buildinghub");
    assert.equal(catalogPayload.buildings[0].install.enabledSetting, "");
    assert.deepEqual(catalogPayload.buildings[0].ui.sidebarTab, {
      enabled: true,
      label: "Linear Ops",
      meta: "community triage",
    });
    assert.equal(catalogPayload.layouts[0].id, "community-main-street");
    assert.equal(catalogPayload.layouts[0].source, "buildinghub");
    assert.equal(catalogPayload.layouts[0].layout.decorations.length, 3);
    assert.deepEqual(catalogPayload.layouts[0].layout.functional["community-linear"], {
      x: 336,
      y: 224,
    });
    assert.equal(catalogPayload.recipes[0].id, "community-research");
    assert.equal(catalogPayload.recipes[0].communication.dm.enabled, true);
    assert.deepEqual(catalogPayload.recipes[0].communication.groupInboxes, ["resource-hall"]);

    const stateResponse = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateResponse.status, 200);
    const statePayload = await stateResponse.json();
    assert.equal(statePayload.buildingHub.buildings[0].id, "community-linear");
    assert.equal(statePayload.buildingHub.layouts[0].id, "community-main-street");
    assert.equal(statePayload.buildingHub.recipes[0].id, "community-research");
    assert.equal(statePayload.settings.buildingHubStatus.buildingCount, 1);
    assert.equal(statePayload.settings.buildingHubStatus.layoutCount, 1);
    assert.equal(statePayload.settings.buildingHubStatus.recipeCount, 1);
    assert.equal(statePayload.settings.buildingHubStatus.sources[0].status, "ok");
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(catalogDir, { recursive: true, force: true });
  }
});
