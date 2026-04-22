import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_TOWN_SPECIAL_BUILDING_IDS,
  BUILDING_CATALOG,
  createBuildingRegistry,
  defineBuilding,
  normalizeBuildingId,
} from "../src/client/building-registry.js";

test("building registry exposes core building manifests", () => {
  const ids = BUILDING_CATALOG.map((building) => building.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("automations"));
  assert.ok(ids.includes("agent-inbox"));
  assert.ok(ids.includes("ci-repair-shop"));
  assert.ok(ids.includes("toolshed"));
  assert.ok(ids.includes("tailscale"));
  assert.ok(ids.includes("google-drive"));
  assert.ok(ids.includes("ottoauth"));
  assert.ok(ids.includes("telegram"));
  assert.ok(ids.includes("discord"));
  assert.ok(ids.includes("moltbook"));
  assert.ok(ids.includes("twitter"));
  assert.ok(ids.includes("sora"));
  assert.ok(ids.includes("nano-banana"));
  assert.ok(ids.includes("wandb"));
  assert.ok(ids.includes("phone-imessage"));
  assert.ok(ids.includes("home-automation"));

  const googleDrive = BUILDING_CATALOG.find((building) => building.id === "google-drive");
  assert.equal(googleDrive.install.system, true);
  assert.equal(googleDrive.status, "MCP-ready");
  assert.match(googleDrive.access.detail, /does not inject Drive tools into local terminal agents/i);
  assert.match(
    googleDrive.onboarding.steps.map((step) => `${step.title} ${step.detail}`).join("\n"),
    /local CLI\/provider separately/i,
  );

  const googleCalendar = BUILDING_CATALOG.find((building) => building.id === "google-calendar");
  assert.equal(googleCalendar.install.system, true);

  const github = BUILDING_CATALOG.find((building) => building.id === "github");
  assert.equal(github.install.system, true);

  const agentInbox = BUILDING_CATALOG.find((building) => building.id === "agent-inbox");
  assert.equal(agentInbox.install.system, true);
  assert.equal(agentInbox.ui.mode, "workspace");
  assert.equal(agentInbox.ui.workspaceView, "agent-inbox");
  assert.match(agentInbox.access.detail, /session state/i);

  const ciRepairShop = BUILDING_CATALOG.find((building) => building.id === "ci-repair-shop");
  assert.equal(ciRepairShop.install.system, true);
  assert.equal(ciRepairShop.category, "Coding");
  assert.match(ciRepairShop.access.detail, /GitHub connector|gh authentication/i);

  const toolshed = BUILDING_CATALOG.find((building) => building.id === "toolshed");
  assert.equal(toolshed.install.system, true);
  assert.equal(toolshed.category, "Vibe Research");
  assert.match(toolshed.description, /BuildingHub/i);
  assert.match(toolshed.access.detail, /Building SDK|BuildingHub/i);

  const tailscale = BUILDING_CATALOG.find((building) => building.id === "tailscale");
  assert.equal(tailscale.install.system, true);
  assert.equal(tailscale.category, "Networking");
  assert.equal(tailscale.visual.shape, "portal");
  assert.match(tailscale.access.detail, /Tailscale Serve/i);
  assert.match(tailscale.agentGuide.summary, /tailnet URLs/i);
  assert.ok(tailscale.agentGuide.commands.some((command) => command.command === "tailscale status"));

  const sora = BUILDING_CATALOG.find((building) => building.id === "sora");
  assert.equal(sora.category, "Generative Media");
  assert.equal(sora.visual.shape, "studio");
  assert.equal(sora.status, "API sunset 2026-09-24");
  assert.match(sora.access.detail, /Videos API/i);
  assert.match(sora.access.detail, /September 24, 2026/i);

  const nanoBanana = BUILDING_CATALOG.find((building) => building.id === "nano-banana");
  assert.equal(nanoBanana.category, "Generative Media");
  assert.equal(nanoBanana.visual.shape, "studio");
  assert.equal(nanoBanana.status, "connector-ready");
  assert.match(nanoBanana.access.detail, /Gemini/i);

  const wandb = BUILDING_CATALOG.find((building) => building.id === "wandb");
  assert.equal(wandb.category, "Observability");
  assert.equal(wandb.visual.shape, "studio");
  assert.match(wandb.access.detail, /WANDB_API_KEY/i);
  assert.ok(wandb.onboarding.steps.some((step) => step.completeWhen?.type === "installed"));

  const externalConnectorIds = ["discord", "moltbook", "twitter", "phone-imessage", "home-automation"];
  for (const connectorId of externalConnectorIds) {
    const connector = BUILDING_CATALOG.find((building) => building.id === connectorId);
    assert.ok(connector, `${connectorId} building should exist`);
    assert.equal(Boolean(connector.install.system), false);
    assert.ok(["connector-ready", "bridge required"].includes(connector.status));
    assert.ok(connector.access.detail);
    assert.match(connector.access.detail, /Requires|requires|Vibe Research/i);
    assert.ok(connector.onboarding.steps.some((step) => step.completeWhen?.type === "installed"));
  }

  const automations = BUILDING_CATALOG.find((building) => building.id === "automations");
  assert.equal(automations.install.system, true);
  assert.equal(automations.visual.shape, "campanile");
  assert.ok(AGENT_TOWN_SPECIAL_BUILDING_IDS.has("automations"));

  const library = BUILDING_CATALOG.find((building) => building.id === "knowledge-base");
  assert.equal(library.ui.mode, "workspace");
  assert.equal(library.ui.entryView, "library-foyer");
  assert.equal(library.ui.workspaceView, "knowledge-base");

  const ottoAuth = BUILDING_CATALOG.find((building) => building.id === "ottoauth");
  assert.equal(ottoAuth.install.enabledSetting, "ottoAuthEnabled");
  assert.equal(ottoAuth.visual.shape, "market");
  assert.equal(ottoAuth.onboarding.setupSelector, ".ottoauth-plugin-card");
  assert.ok(AGENT_TOWN_SPECIAL_BUILDING_IDS.has("ottoauth"));

  for (const building of BUILDING_CATALOG) {
    assert.equal(typeof building.name, "string");
    assert.equal(typeof building.description, "string");
    assert.ok(building.agentGuide);
    assert.ok(Array.isArray(building.agentGuide.commands));
    assert.ok(Array.isArray(building.agentGuide.docs));
    assert.ok(Array.isArray(building.agentGuide.env));
    assert.ok(Array.isArray(building.agentGuide.setup));
    assert.ok(Array.isArray(building.agentGuide.useCases));
    assert.ok(building.onboarding);
    assert.ok(Array.isArray(building.onboarding.steps));
    assert.ok(Array.isArray(building.onboarding.variables));
  }
});

test("custom building manifests normalize through the registry sdk", () => {
  const registry = createBuildingRegistry();
  const building = registry.register({
    id: "Example Commerce!",
    name: "Example Commerce",
    category: "Commerce",
    description: "A custom checkout building.",
    install: {
      enabledSetting: "exampleCommerceEnabled",
      storedFallback: false,
    },
    onboarding: {
      variables: [{ label: "API key", setting: "exampleApiKey", required: true }],
      steps: [{ title: "Save variables", detail: "Add the API key." }],
    },
    visual: {
      shape: "Market",
      specialTownPlace: true,
    },
    agentGuide: {
      commands: [
        "example-commerce status",
        { name: "Dry run", example: "example-commerce --dry-run", description: "Preview the request." },
      ],
      docs: ["https://example.com/docs"],
      env: ["EXAMPLE_COMMERCE_API_KEY"],
      setup: ["Confirm the API key is configured."],
      summary: "Use this building for commerce dry runs.",
      useCases: ["Preview checkout requests."],
    },
  });

  assert.equal(normalizeBuildingId("Example Commerce!"), "example-commerce");
  assert.equal(building.id, "example-commerce");
  assert.equal(building.install.enabledSetting, "exampleCommerceEnabled");
  assert.equal(building.install.system, false);
  assert.equal(building.install.storedFallback, false);
  assert.equal(building.ui.mode, "panel");
  assert.equal(building.visual.shape, "market");
  assert.deepEqual(building.agentGuide.commands[0], {
    command: "example-commerce status",
    label: "",
    detail: "",
  });
  assert.deepEqual(building.agentGuide.commands[1], {
    command: "example-commerce --dry-run",
    label: "Dry run",
    detail: "Preview the request.",
  });
  assert.deepEqual(building.agentGuide.docs, [{ label: "", url: "https://example.com/docs" }]);
  assert.deepEqual(building.agentGuide.env, [{ name: "EXAMPLE_COMMERCE_API_KEY", detail: "", required: false }]);
  assert.deepEqual(building.agentGuide.setup, ["Confirm the API key is configured."]);
  assert.deepEqual(building.agentGuide.useCases, ["Preview checkout requests."]);
  assert.ok(registry.specialTownIds().has("example-commerce"));
  assert.equal(registry.get("example commerce"), building);
});

test("defineBuilding rejects empty manifests", () => {
  assert.throws(() => defineBuilding(null), /Building manifest/);
  assert.throws(() => defineBuilding({ id: "", name: "" }), /requires an id or name/);
});
