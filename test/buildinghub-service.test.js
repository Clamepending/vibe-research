import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { BuildingHubService, testInternals } from "../src/buildinghub-service.js";

async function createCatalogDir() {
  const catalogDir = await mkdtemp(path.join(os.tmpdir(), "vr-buildinghub-"));
  const buildingDir = path.join(catalogDir, "buildings", "community-linear");
  await mkdir(buildingDir, { recursive: true });
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
    assert.equal(linear.onboarding.setupSelector, "");
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

    const status = service.getStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.buildingCount, 2);
    assert.equal(status.sources.length, 1);
    assert.equal(status.sources[0].status, "ok");
    assert.equal(status.sources[0].count, 2);
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
    assert.equal(service.getStatus().buildingCount, 0);
    assert.equal(service.getStatus().sources.length, 0);
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
    ui: { mode: "workspace", entryView: "danger", workspaceView: "danger" },
  });

  assert.equal(manifest.id, "danger-zone");
  assert.equal(manifest.source, "buildinghub");
  assert.equal(manifest.install.enabledSetting, "");
  assert.equal(manifest.install.system, false);
  assert.equal(manifest.visual.specialTownPlace, false);
  assert.equal(manifest.ui.mode, "panel");
  assert.equal(manifest.ui.entryView, "");
  assert.equal(manifest.ui.workspaceView, "");
});
