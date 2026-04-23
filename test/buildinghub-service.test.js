import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { BuildingHubService, testInternals } from "../src/buildinghub-service.js";

async function createCatalogDir() {
  const catalogDir = await mkdtemp(path.join(os.tmpdir(), "vr-buildinghub-"));
  const buildingDir = path.join(catalogDir, "buildings", "community-linear");
  const layoutDir = path.join(catalogDir, "layouts", "community-main-street");
  const recipeDir = path.join(catalogDir, "recipes", "research-bench");
  await mkdir(buildingDir, { recursive: true });
  await mkdir(layoutDir, { recursive: true });
  await mkdir(recipeDir, { recursive: true });
  await writeFile(
    path.join(buildingDir, "building.json"),
    JSON.stringify(
      {
        id: "Community Linear",
        name: "Community Linear",
        category: "Project Management",
        description: "Coordinate issue triage from a community manifest.",
        status: "manifest ready",
        source: "third-party",
        install: {
          enabledSetting: "linearEnabled",
          system: true,
          storedFallback: false,
        },
        visual: {
          shape: "Market",
          specialTownPlace: true,
        },
        ui: {
          mode: "workspace",
          entryView: "linear-panel",
          workspaceView: "linear-app",
          sidebarTab: {
            enabled: true,
            label: "Linear Ops",
            meta: "community triage",
          },
        },
        access: {
          label: "Linear token",
          detail: "Requires a Linear API token configured outside the manifest.",
        },
        capabilities: [
          {
            type: "helper",
            name: "Sync issues",
            command: "linear-sync",
            detail: "Summarize and update issues.",
          },
        ],
        agentGuide: {
          summary: "Use Linear safely from a community manifest.",
          useCases: ["Read issue metadata before editing a roadmap."],
          setup: ["Confirm token scope before writing back to Linear."],
          commands: [
            {
              label: "Preview issue sync",
              command: "linear-sync --dry-run",
              detail: "Preview changes without mutating issues.",
            },
          ],
          env: [
            {
              name: "LINEAR_API_KEY",
              detail: "Provider-side token; never print it.",
              required: true,
            },
          ],
          docs: [
            {
              label: "Linear GraphQL docs",
              url: "https://developers.linear.app/docs/graphql/working-with-the-graphql-api",
            },
          ],
        },
        onboarding: {
          setupSelector: ".dangerous-selector",
          variables: [
            {
              label: "API token configured",
              configuredSetting: "linearApiKeyConfigured",
              required: true,
              secret: true,
              setupUrl: "https://linear.app/settings/api",
              setupLabel: "Get token",
              setupHint: "Create a scoped Linear token before enabling writes.",
            },
          ],
          steps: [
            {
              title: "Install the building",
              detail: "Add the manifest to the town.",
              completeWhen: { type: "installed" },
            },
            {
              title: "Choose a source",
              detail: "Use either a local or remote source.",
              completeWhen: { anyConfigured: ["linearPath", "linearUrl"] },
            },
          ],
        },
        repositoryUrl: "https://github.com/example/buildinghub-linear",
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(layoutDir, "layout.json"),
    JSON.stringify(
      {
        id: "Community Main Street",
        name: "Community Main Street",
        category: "Starter Layout",
        description: "A simple shared road spine for new towns.",
        tags: ["street", "starter", "layout"],
        requiredBuildings: ["community-linear", "BuildingHub"],
        layout: {
          themeId: "green-field",
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

  await writeFile(
    path.join(recipeDir, "recipe.json"),
    JSON.stringify(
      {
        schema: "vibe-research.scaffold.recipe.v1",
        id: "Research Bench",
        name: "Research Bench",
        description: "A portable recipe for repeatable research evaluations.",
        settings: {
          portable: {
            agentCommunicationDmEnabled: true,
            agentOpenAiApiKey: "sk-should-not-load",
            buildingHubEnabled: true,
            customToken: "also-secret",
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
            { id: "road-c", itemId: "road-square", x: 224, y: 252 },
          ],
          functional: {
            "community-linear": { x: 252, y: 224 },
          },
        },
      },
      null,
      2,
    ),
  );

  await writeFile(
    path.join(catalogDir, "registry.json"),
    JSON.stringify(
      {
        buildings: [
          {
            id: "community-supabase",
            name: "Community Supabase",
            description: "Read and write project database notes through a reviewed helper.",
          },
        ],
        layouts: [
          {
            id: "community-grid",
            name: "Community Grid",
            description: "A registry-exported modular grid layout.",
            layout: {
              decorations: [
                { id: "road-a", itemId: "road-square", x: 252, y: 224 },
                { id: "road-b", itemId: "road-square", x: 280, y: 224 },
              ],
            },
          },
        ],
        recipes: [
          {
            schema: "vibe-research.scaffold.recipe.v1",
            id: "registry-research",
            name: "Registry Research",
            communication: {
              dm: {
                enabled: false,
              },
            },
            settings: {
              portable: {
                buildingHubEnabled: true,
              },
            },
          },
        ],
      },
      null,
      2,
    ),
  );

  return catalogDir;
}

test("BuildingHubService loads local manifest catalogs as safe community buildings", async () => {
  const catalogDir = await createCatalogDir();
  const service = new BuildingHubService({
    refreshIntervalMs: 0,
    settings: {
      buildingHubCatalogPath: catalogDir,
      buildingHubEnabled: true,
    },
  });

  try {
    await service.refresh({ force: true });

    const buildings = service.listBuildings();
    assert.equal(buildings.length, 2);
    const layouts = service.listLayouts();
    assert.equal(layouts.length, 2);
    const recipes = service.listRecipes();
    assert.equal(recipes.length, 2);

    const linear = buildings.find((building) => building.id === "community-linear");
    assert.ok(linear);
    assert.equal(linear.source, "buildinghub");
    assert.equal(linear.status, "manifest ready");
    assert.equal(linear.install.enabledSetting, "");
    assert.equal(linear.install.system, false);
    assert.equal(linear.visual.shape, "market");
    assert.equal(linear.visual.specialTownPlace, false);
    assert.equal(linear.ui.mode, "panel");
    assert.equal(linear.ui.entryView, "");
    assert.equal(linear.ui.workspaceView, "");
    assert.deepEqual(linear.ui.sidebarTab, {
      enabled: true,
      label: "Linear Ops",
      meta: "community triage",
    });
    assert.equal(linear.onboarding.setupSelector, "");
    assert.deepEqual(linear.onboarding.variables[0], {
      label: "API token configured",
      value: "",
      setting: "",
      configuredSetting: "linearApiKeyConfigured",
      required: true,
      secret: true,
      suffix: "",
      setupUrl: "https://linear.app/settings/api",
      setupLabel: "Get token",
      setupHint: "Create a scoped Linear token before enabling writes.",
    });
    assert.deepEqual(linear.onboarding.steps[1].completeWhen, {
      anyConfigured: ["linearPath", "linearUrl"],
    });
    assert.deepEqual(linear.buildingHub.capabilities[0], {
      type: "helper",
      name: "Sync issues",
      command: "linear-sync",
      detail: "Summarize and update issues.",
      required: true,
    });
    assert.equal(linear.agentGuide.summary, "Use Linear safely from a community manifest.");
    assert.deepEqual(linear.agentGuide.useCases, ["Read issue metadata before editing a roadmap."]);
    assert.deepEqual(linear.agentGuide.setup, ["Confirm token scope before writing back to Linear."]);
    assert.deepEqual(linear.agentGuide.commands[0], {
      label: "Preview issue sync",
      command: "linear-sync --dry-run",
      detail: "Preview changes without mutating issues.",
    });
    assert.deepEqual(linear.agentGuide.env[0], {
      name: "LINEAR_API_KEY",
      detail: "Provider-side token; never print it.",
      required: true,
    });
    assert.deepEqual(linear.agentGuide.docs[0], {
      label: "Linear GraphQL docs",
      url: "https://developers.linear.app/docs/graphql/working-with-the-graphql-api",
    });
    assert.equal(linear.buildingHub.repositoryUrl, "https://github.com/example/buildinghub-linear");

    const mainStreet = layouts.find((layout) => layout.id === "community-main-street");
    assert.ok(mainStreet);
    assert.equal(mainStreet.source, "buildinghub");
    assert.equal(mainStreet.category, "Starter Layout");
    assert.deepEqual(mainStreet.requiredBuildings, ["community-linear", "buildinghub"]);
    assert.equal(mainStreet.layout.themeId, "green-field");
    assert.deepEqual(mainStreet.layout.decorations[0], {
      id: "road-1",
      itemId: "road-square",
      x: 280,
      y: 252,
    });
    assert.deepEqual(mainStreet.layout.functional["community-linear"], {
      x: 336,
      y: 224,
    });
    assert.equal(mainStreet.buildingHub.trust, "layout-blueprint");

    const registryGrid = layouts.find((layout) => layout.id === "community-grid");
    assert.ok(registryGrid);
    assert.equal(registryGrid.layout.decorations.length, 2);

    const researchBench = recipes.find((recipe) => recipe.id === "research-bench");
    assert.ok(researchBench);
    assert.equal(researchBench.source.kind, "buildinghub");
    assert.equal(researchBench.source.sourceId, "local");
    assert.equal(researchBench.communication.dm.enabled, true);
    assert.equal(researchBench.settings.portable.buildingHubEnabled, true);
    assert.equal(researchBench.settings.portable.agentOpenAiApiKey, undefined);
    assert.equal(researchBench.settings.portable.customToken, undefined);
    assert.deepEqual(researchBench.communication.groupInboxes, ["resource-hall"]);

    const registryResearch = recipes.find((recipe) => recipe.id === "registry-research");
    assert.ok(registryResearch);
    assert.equal(registryResearch.source.sourceId, "local");

    const status = service.getStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.buildingCount, 2);
    assert.equal(status.layoutCount, 2);
    assert.equal(status.recipeCount, 2);
    assert.equal(status.sources.length, 1);
    assert.equal(status.sources[0].status, "ok");
    assert.equal(status.sources[0].count, 2);
    assert.equal(status.sources[0].layoutCount, 2);
    assert.equal(status.sources[0].recipeCount, 2);
    assert.equal(status.lastRefreshError, "");
  } finally {
    await rm(catalogDir, { recursive: true, force: true });
  }
});

test("BuildingHubService stays inert when disabled", async () => {
  const catalogDir = await createCatalogDir();
  const service = new BuildingHubService({
    refreshIntervalMs: 0,
    settings: {
      buildingHubCatalogPath: catalogDir,
      buildingHubEnabled: false,
    },
  });

  try {
    await service.refresh({ force: true });
    assert.deepEqual(service.listBuildings(), []);
    assert.deepEqual(service.listLayouts(), []);
    assert.deepEqual(service.listRecipes(), []);
    assert.equal(service.getStatus().buildingCount, 0);
    assert.equal(service.getStatus().layoutCount, 0);
    assert.equal(service.getStatus().recipeCount, 0);
    assert.equal(service.getStatus().sources.length, 0);
  } finally {
    await rm(catalogDir, { recursive: true, force: true });
  }
});

test("BuildingHubService restart invalidates cached disabled refreshes", async () => {
  const catalogDir = await createCatalogDir();
  const service = new BuildingHubService({
    refreshIntervalMs: 60_000,
    settings: {
      buildingHubCatalogPath: catalogDir,
      buildingHubEnabled: false,
    },
  });

  try {
    await service.refresh({ force: true });
    assert.equal(service.getStatus().buildingCount, 0);
    assert.equal(service.getStatus().layoutCount, 0);
    assert.equal(service.getStatus().recipeCount, 0);

    service.restart({
      buildingHubCatalogPath: catalogDir,
      buildingHubEnabled: true,
    });
    await service.refresh();

    assert.equal(service.getStatus().buildingCount, 2);
    assert.equal(service.getStatus().layoutCount, 2);
    assert.equal(service.getStatus().recipeCount, 2);
  } finally {
    await rm(catalogDir, { recursive: true, force: true });
  }
});

test("BuildingHub manifest normalization rejects invalid and trims unsupported control fields", () => {
  assert.equal(testInternals.normalizeBuildingHubManifest(null), null);
  assert.equal(testInternals.normalizeBuildingHubManifest({ id: "", name: "" }), null);

  const manifest = testInternals.normalizeBuildingHubManifest({
    id: "Danger Zone!",
    name: "Danger Zone",
    description: "A manifest that tries to become a local app.",
    install: { enabledSetting: "dangerEnabled", system: true },
    visual: { specialTownPlace: true },
    ui: {
      mode: "workspace",
      entryView: "danger",
      workspaceView: "danger",
      sidebarTab: {
        enabled: true,
        label: "Danger Ops",
        meta: "routing review",
      },
    },
  });

  assert.equal(manifest.id, "danger-zone");
  assert.equal(manifest.source, "buildinghub");
  assert.equal(manifest.install.enabledSetting, "");
  assert.equal(manifest.install.system, false);
  assert.equal(manifest.visual.specialTownPlace, false);
  assert.equal(manifest.ui.mode, "panel");
  assert.equal(manifest.ui.entryView, "");
  assert.equal(manifest.ui.workspaceView, "");
  assert.deepEqual(manifest.ui.sidebarTab, {
    enabled: true,
    label: "Danger Ops",
    meta: "routing review",
  });
});

test("BuildingHub layout normalization rejects unsafe layouts and trims payloads", () => {
  assert.equal(testInternals.normalizeBuildingHubLayout(null), null);
  assert.equal(testInternals.normalizeBuildingHubLayout({ id: "empty", layout: { decorations: [] } }), null);

  const layout = testInternals.normalizeBuildingHubLayout({
    id: "Factory Loop!",
    name: "Factory Loop",
    category: "Factory",
    description: "A reusable production-style base loop.",
    tags: ["factory", "factory", "loop"],
    requiredBuildings: ["GitHub", "Unknown Tool", ""],
    layout: {
      themeId: "neon-night",
      decorations: [
        { id: "road", itemId: "road-square", x: 15.4, y: 22.7 },
        { id: "bad", itemId: "", x: 10, y: 20 },
        { id: "rotated", itemId: "fence-vertical", x: 2_400, y: -12, rotation: 3 },
      ],
      functional: {
        GitHub: { x: 88.9, y: 91.2, rotation: 1 },
        "": { x: 1, y: 2 },
      },
    },
  }, { sourceId: "test-source" });

  assert.equal(layout.id, "factory-loop");
  assert.equal(layout.category, "Factory");
  assert.deepEqual(layout.tags, ["factory", "loop"]);
  assert.deepEqual(layout.requiredBuildings, ["github", "unknown-tool"]);
  assert.equal(layout.layout.themeId, "neon-night");
  assert.deepEqual(layout.layout.decorations, [
    { id: "road", itemId: "road-square", x: 15, y: 23 },
    { id: "rotated", itemId: "fence-vertical", x: 2000, y: 0, rotation: 1 },
  ]);
  assert.deepEqual(layout.layout.functional.github, { x: 89, y: 91, rotation: 1 });
  assert.equal(layout.buildingHub.sourceId, "test-source");
});

test("BuildingHub recipe normalization accepts scaffold recipes without secret values", () => {
  assert.equal(testInternals.normalizeBuildingHubRecipe(null), null);
  assert.equal(testInternals.normalizeBuildingHubRecipe({ id: "", name: "" }), null);

  const recipe = testInternals.normalizeBuildingHubRecipe({
    schema: "vibe-research.scaffold.recipe.v1",
    id: "GPU Bench!",
    name: "GPU Bench",
    repositoryUrl: "https://github.com/example/buildinghub/tree/main/recipes/gpu-bench",
    settings: {
      portable: {
        agentCommunicationDmEnabled: true,
        agentOpenAiApiKey: "sk-should-not-survive",
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
    buildings: [{ id: "Harbor", name: "Harbor", required: true }],
  }, { sourceId: "test-source" });

  assert.equal(recipe.id, "gpu-bench");
  assert.equal(recipe.source.kind, "buildinghub");
  assert.equal(recipe.source.sourceId, "test-source");
  assert.equal(recipe.source.repositoryUrl, "https://github.com/example/buildinghub/tree/main/recipes/gpu-bench");
  assert.equal(recipe.settings.portable.buildingHubEnabled, true);
  assert.equal(recipe.settings.portable.agentOpenAiApiKey, undefined);
  assert.equal(recipe.communication.dm.enabled, true);
  assert.deepEqual(recipe.communication.groupInboxes, ["resource-hall"]);
  assert.equal(recipe.buildings[0].id, "harbor");
});
