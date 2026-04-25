import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  buildScaffoldRecipe,
  createScaffoldRecipeApplyPlan,
  getSettingSensitivity,
  previewScaffoldRecipe,
  ScaffoldRecipeService,
  SCAFFOLD_RECIPE_SCHEMA,
  testInternals,
} from "../src/scaffold-recipe-service.js";

test("scaffold recipes capture portable setup while redacting local, personal, and secret values", () => {
  const recipe = buildScaffoldRecipe({
    agentPrompt: {
      editable: true,
      prompt: "You are a researcher.",
      selectedPromptId: "researcher",
    },
    app: {
      branch: "prod",
      commit: "abc123",
      version: "0.2.18",
    },
    coreBuildings: [
      {
        id: "agent-inbox",
        name: "Agent Inbox",
        category: "Vibe Research",
        source: "vibe-research",
        install: { system: true },
      },
      {
        id: "scaffold-recipes",
        name: "Scaffold Recipes",
        category: "Vibe Research",
        source: "vibe-research",
        install: { system: true },
      },
    ],
    defaultProviderId: "codex",
    layout: {
      decorations: [{ id: "road-1", itemId: "road-square", x: 12, y: 24 }],
      functional: { "agent-inbox": { x: 40, y: 80 } },
      themeId: "green-field",
    },
    name: "PostTrainBench Harbor setup",
    providers: [{ id: "codex" }, { id: "claude" }],
    settings: {
      agentCommunicationCaptureMessageReads: true,
      agentCommunicationCaptureMessages: true,
      agentCommunicationDmBody: "freeform",
      agentCommunicationDmEnabled: true,
      agentCommunicationDmVisibility: "workspace",
      agentCommunicationGroupInboxes: "resource-hall,gpu-desk",
      agentCommunicationMaxThreadDepth: 9,
      agentCommunicationMaxUnrepliedPerAgent: 2,
      agentCommunicationRequireRelatedObject: true,
      agentOpenAiApiKey: "sk-live-secret",
      buildingHubEnabled: true,
      browserUseEnabled: true,
      installedPluginIds: ["harbor"],
      wikiGitRemoteUrl: "git@github.com:example/private-library.git",
      wikiPath: "/Users/example/private-library",
      workspaceRootPath: "/Users/example/workspace",
    },
  });

  assert.equal(recipe.schema, SCAFFOLD_RECIPE_SCHEMA);
  assert.equal(recipe.agents.defaultProvider, "codex");
  assert.equal(recipe.communication.dm.enabled, true);
  assert.equal(recipe.communication.dm.maxThreadDepth, 9);
  assert.deepEqual(recipe.communication.groupInboxes, ["resource-hall", "gpu-desk"]);
  assert.equal(recipe.layout.decorations.length, 1);
  assert.equal(recipe.settings.portable.buildingHubEnabled, true);
  assert.equal(recipe.settings.portable.browserUseEnabled, true);
  assert.ok(recipe.localBindingsRequired.some((entry) => entry.key === "agentOpenAiApiKey" && entry.sensitivity === "secret"));
  assert.ok(recipe.localBindingsRequired.some((entry) => entry.key === "workspaceRootPath" && entry.sensitivity === "local"));
  assert.ok(recipe.localBindingsRequired.some((entry) => entry.key === "wikiGitRemoteUrl" && entry.sensitivity === "personal"));
  assert.doesNotMatch(JSON.stringify(recipe), /sk-live-secret/);
  assert.doesNotMatch(JSON.stringify(recipe), /private-library\.git/);
  assert.ok(recipe.redactions.some((entry) => /agentOpenAiApiKey/.test(entry)));

  const preview = previewScaffoldRecipe(recipe, {
    availableBuildingIds: recipe.buildings.map((building) => building.id),
    localBindings: {
      agentOpenAiApiKey: "sk-provided",
      workspaceRootPath: "/tmp/next",
    },
    settings: {
      agentCommunicationDmEnabled: false,
      buildingHubEnabled: false,
    },
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.changes.layout.cosmeticCount, 1);
  assert.ok(preview.changes.settings.some((entry) => entry.key === "agentCommunicationDmEnabled"));
  assert.equal(preview.localBindingsRequired.find((entry) => entry.key === "agentOpenAiApiKey").provided, true);

  const plan = createScaffoldRecipeApplyPlan(recipe, {
    localBindings: {
      agentOpenAiApiKey: "sk-provided",
      workspaceRootPath: "/tmp/next",
    },
  });
  assert.equal(plan.settingsPatch.agentCommunicationDmEnabled, true);
  assert.equal(plan.settingsPatch.agentCommunicationGroupInboxes, "resource-hall,gpu-desk");
  assert.equal(plan.localSettingsPatch.agentOpenAiApiKey, "sk-provided");
  assert.equal(plan.localSettingsPatch.workspaceRootPath, "/tmp/next");
});

test("scaffold recipe normalization strips secret-looking portable settings", () => {
  const recipe = testInternals.normalizeScaffoldRecipe({
    id: "unsafe",
    name: "Unsafe",
    settings: {
      portable: {
        agentAutomations: [
          {
            prompt: "run a safe check",
            apiKey: "nested-secret",
          },
        ],
        agentOpenAiApiKey: "sk-should-not-export",
        buildingHubEnabled: true,
        customToken: "also-secret",
      },
    },
  });

  assert.equal(recipe.settings.portable.buildingHubEnabled, true);
  assert.equal(recipe.settings.portable.agentAutomations[0].prompt, "run a safe check");
  assert.equal(recipe.settings.portable.agentAutomations[0].apiKey, undefined);
  assert.equal(recipe.settings.portable.agentOpenAiApiKey, undefined);
  assert.equal(recipe.settings.portable.customToken, undefined);
  assert.equal(getSettingSensitivity("customToken"), "secret");
});

test("scaffold recipe captures library git commit and branch when supplied", () => {
  const recipe = buildScaffoldRecipe({
    agentPrompt: { selectedPromptId: "researcher", prompt: "p" },
    coreBuildings: [],
    library: { gitCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", gitBranch: "main" },
    name: "library-pinned",
    settings: { wikiPath: "/Users/example/library", wikiGitRemoteUrl: "" },
  });
  assert.equal(recipe.library.gitCommit, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  assert.equal(recipe.library.gitBranch, "main");
  assert.equal(recipe.library.gitRemoteConfigured, false);
});

test("scaffold recipe omits library git fields when not supplied (backward compatible)", () => {
  const recipe = buildScaffoldRecipe({
    agentPrompt: { selectedPromptId: "researcher", prompt: "p" },
    coreBuildings: [],
    name: "no-library-pin",
    settings: {},
  });
  assert.equal(recipe.library.gitCommit, "");
  assert.equal(recipe.library.gitBranch, "");
});

test("scaffold recipe normalization round-trips library git fields", () => {
  const recipe = testInternals.normalizeScaffoldRecipe({
    id: "round-trip",
    library: { gitCommit: "  abc123  ", commit: "ignored-fallback", gitBranch: "feature/foo" },
  });
  assert.equal(recipe.library.gitCommit, "abc123");
  assert.equal(recipe.library.gitBranch, "feature/foo");
});

test("preview reports library git pin as pinned when expected commit is set", () => {
  const recipe = buildScaffoldRecipe({
    agentPrompt: { selectedPromptId: "researcher", prompt: "p" },
    coreBuildings: [],
    library: { gitCommit: "abc123", gitBranch: "main" },
    name: "pin-ok",
    settings: {},
  });
  const preview = previewScaffoldRecipe(recipe, {
    availableBuildingIds: recipe.buildings.map((b) => b.id),
    currentLibraryGitCommit: "abc123",
    currentLibraryGitBranch: "main",
  });
  assert.equal(preview.libraryGitState.pinned, true);
  assert.equal(preview.libraryGitState.mismatch, false);
  assert.equal(preview.libraryGitState.unknown, false);
  assert.equal(preview.libraryGitState.expectedCommit, "abc123");
  assert.equal(preview.libraryGitState.currentCommit, "abc123");
});

test("preview flags library git mismatch when local commit differs from recipe", () => {
  const recipe = buildScaffoldRecipe({
    agentPrompt: { selectedPromptId: "researcher", prompt: "p" },
    coreBuildings: [],
    library: { gitCommit: "abc123" },
    name: "pin-mismatch",
    settings: {},
  });
  const preview = previewScaffoldRecipe(recipe, {
    availableBuildingIds: recipe.buildings.map((b) => b.id),
    currentLibraryGitCommit: "def456",
  });
  assert.equal(preview.libraryGitState.pinned, true);
  assert.equal(preview.libraryGitState.mismatch, true);
  assert.equal(preview.libraryGitState.unknown, false);
});

test("preview marks library git pin unknown when expected is set but current is empty", () => {
  const recipe = buildScaffoldRecipe({
    agentPrompt: { selectedPromptId: "researcher", prompt: "p" },
    coreBuildings: [],
    library: { gitCommit: "abc123" },
    name: "pin-unknown",
    settings: {},
  });
  const preview = previewScaffoldRecipe(recipe, {
    availableBuildingIds: recipe.buildings.map((b) => b.id),
  });
  assert.equal(preview.libraryGitState.pinned, true);
  assert.equal(preview.libraryGitState.mismatch, false);
  assert.equal(preview.libraryGitState.unknown, true);
});

test("preview library git state is not pinned when recipe has no expected commit", () => {
  const recipe = buildScaffoldRecipe({
    agentPrompt: { selectedPromptId: "researcher", prompt: "p" },
    coreBuildings: [],
    name: "no-pin",
    settings: {},
  });
  const preview = previewScaffoldRecipe(recipe, {
    availableBuildingIds: recipe.buildings.map((b) => b.id),
    currentLibraryGitCommit: "abc123",
  });
  assert.equal(preview.libraryGitState.pinned, false);
  assert.equal(preview.libraryGitState.mismatch, false);
  assert.equal(preview.libraryGitState.unknown, false);
});

test("ScaffoldRecipeService persists saved recipes and replaces by id", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vr-scaffold-recipes-"));
  const service = new ScaffoldRecipeService({
    now: () => "2026-04-22T00:00:00.000Z",
    stateDir,
  });

  try {
    await service.initialize();
    const first = await service.saveRecipe({ id: "alpha", name: "Alpha" });
    const second = await service.saveRecipe({ id: "alpha", name: "Alpha Updated" });
    assert.equal(first.id, "alpha");
    assert.equal(second.name, "Alpha Updated");
    assert.equal(service.listRecipes().length, 1);
    assert.equal(service.getRecipe("alpha").name, "Alpha Updated");

    const raw = JSON.parse(await readFile(path.join(stateDir, "scaffold-recipes.json"), "utf8"));
    assert.equal(raw.recipes.length, 1);
    assert.equal(raw.recipes[0].id, "alpha");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
