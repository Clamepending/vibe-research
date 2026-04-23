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
  assert.equal(ids.includes("agentmall"), false);
  assert.ok(ids.includes("doghouse"));
  assert.ok(ids.includes("tailscale"));
  assert.ok(ids.includes("google-drive"));
  assert.ok(ids.includes("ottoauth"));
  assert.ok(ids.includes("telegram"));
  assert.ok(ids.includes("discord"));
  assert.ok(ids.includes("moltbook"));
  assert.ok(ids.includes("twitter"));
  assert.ok(ids.includes("rentahuman"));
  assert.ok(ids.includes("sora"));
  assert.ok(ids.includes("nano-banana"));
  assert.ok(ids.includes("harbor"));
  assert.ok(ids.includes("wandb"));
  assert.ok(ids.includes("modal"));
  assert.ok(ids.includes("runpod"));
  assert.ok(ids.includes("system"));
  assert.ok(ids.includes("occupations"));
  assert.ok(ids.includes("phone-imessage"));
  assert.ok(ids.includes("home-automation"));

  const googleDrive = BUILDING_CATALOG.find((building) => building.id === "google-drive");
  assert.equal(googleDrive.install.system, true);
  assert.equal(googleDrive.status, "ready");
  assert.equal(googleDrive.source, "google");
  assert.match(googleDrive.access.detail, /Drive access is enabled/i);
  assert.match(
    googleDrive.onboarding.steps.map((step) => `${step.title} ${step.detail}`).join("\n"),
    /Enable Drive access/i,
  );
  assert.equal(googleDrive.onboarding.steps[0].completeWhen?.buildingAccessConfirmed, true);

  const googleCalendar = BUILDING_CATALOG.find((building) => building.id === "google-calendar");
  assert.equal(googleCalendar.install.system, true);
  assert.equal(googleCalendar.status, "ready");
  assert.equal(googleCalendar.source, "google");
  assert.equal(googleCalendar.onboarding.steps[0].title, "Enable Calendar access");
  assert.equal(googleCalendar.onboarding.steps[0].completeWhen?.buildingAccessConfirmed, true);

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

  const buildingHub = BUILDING_CATALOG.find((building) => building.id === "buildinghub");
  assert.equal(buildingHub.install.system, true);
  assert.equal(buildingHub.install.enabledSetting, "");
  assert.equal(buildingHub.category, "Community");
  assert.equal(buildingHub.ui.mode, "workspace");
  assert.equal(buildingHub.ui.workspaceView, "plugins");
  assert.match(buildingHub.description, /skins, themes/i);
  assert.match(buildingHub.access.detail, /browser-local Agent Town preferences/i);
  assert.ok(buildingHub.agentGuide.useCases.some((useCase) => /themes/i.test(useCase)));

  const agentMail = BUILDING_CATALOG.find((building) => building.id === "agentmail");
  assert.equal(agentMail.visual.logo, "agentmail");
  assert.ok(agentMail.onboarding.variables.some((variable) => variable.setting === "agentMailApiKey" && variable.setupUrl));

  const telegram = BUILDING_CATALOG.find((building) => building.id === "telegram");
  assert.equal(telegram.visual.logo, "telegram");
  assert.ok(telegram.onboarding.variables.some((variable) => variable.setting === "telegramBotToken" && /botfather/i.test(variable.setupUrl)));

  const doghouse = BUILDING_CATALOG.find((building) => building.id === "doghouse");
  assert.equal(doghouse.install.system, true);
  assert.equal(doghouse.visual.shape, "doghouse");
  assert.ok(AGENT_TOWN_SPECIAL_BUILDING_IDS.has("doghouse"));
  assert.match(doghouse.description, /doghouse/i);
  assert.match(doghouse.access.detail, /Agent Town canvas/i);

  const system = BUILDING_CATALOG.find((building) => building.id === "system");
  assert.equal(system.install.system, true);
  assert.equal(system.ui.mode, "workspace");
  assert.equal(system.ui.workspaceView, "system");
  assert.ok(AGENT_TOWN_SPECIAL_BUILDING_IDS.has("system"));
  assert.match(system.description, /GPU utilization/i);
  assert.ok(system.agentGuide.commands.some((command) => command.command.includes("/api/system")));

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

  const modal = BUILDING_CATALOG.find((building) => building.id === "modal");
  assert.equal(modal.category, "Cloud Compute");
  assert.equal(modal.visual.shape, "lab");
  assert.equal(modal.status, "CLI install required");
  assert.match(modal.access.detail, /MODAL_TOKEN_ID/i);
  assert.match(modal.access.detail, /cloud costs stay in the agent runtime/i);
  assert.ok(modal.agentGuide.commands.some((command) => command.command === "modal token info"));
  assert.ok(modal.agentGuide.commands.some((command) => command.command.includes("modal deploy")));
  assert.ok(modal.agentGuide.env.some((envVar) => envVar.name === "MODAL_TOKEN_SECRET"));
  assert.ok(modal.agentGuide.docs.some((doc) => doc.url.includes("modal.com/docs")));
  assert.ok(modal.onboarding.steps.some((step) => step.completeWhen?.type === "installed"));

  const runPod = BUILDING_CATALOG.find((building) => building.id === "runpod");
  assert.equal(runPod.category, "Cloud Compute");
  assert.equal(runPod.visual.shape, "lab");
  assert.equal(runPod.status, "CLI/API setup required");
  assert.match(runPod.access.detail, /RunPod API key/i);
  assert.match(runPod.access.detail, /cloud costs stay outside the browser catalog/i);
  assert.ok(runPod.agentGuide.commands.some((command) => command.command === "runpodctl serverless list"));
  assert.ok(runPod.agentGuide.commands.some((command) => command.command.includes("RUNPOD_ENDPOINT_ID")));
  assert.ok(runPod.agentGuide.env.some((envVar) => envVar.name === "RUNPOD_API_KEY"));
  assert.ok(runPod.agentGuide.docs.some((doc) => doc.url.includes("docs.runpod.io")));
  assert.ok(runPod.onboarding.steps.some((step) => step.completeWhen?.type === "installed"));

  const harbor = BUILDING_CATALOG.find((building) => building.id === "harbor");
  assert.equal(harbor.category, "Evals");
  assert.equal(harbor.visual.shape, "lab");
  assert.equal(harbor.status, "CLI install required");
  assert.match(harbor.access.detail, /harbor CLI/i);
  assert.match(harbor.access.detail, /sandbox/i);
  assert.ok(harbor.agentGuide.commands.some((command) => command.command.includes("harbor run")));
  assert.ok(harbor.agentGuide.docs.some((doc) => doc.url.includes("harborframework.com")));

  const occupations = BUILDING_CATALOG.find((building) => building.id === "occupations");
  assert.equal(occupations.install.system, true);
  assert.equal(occupations.ui.mode, "workspace");
  assert.equal(occupations.ui.workspaceView, "agent-prompt");
  assert.equal(occupations.visual.shape, "school");
  assert.ok(AGENT_TOWN_SPECIAL_BUILDING_IDS.has("occupations"));
  assert.match(occupations.access.detail, /AGENTS\.md, CLAUDE\.md, and GEMINI\.md/i);
  assert.ok(occupations.agentGuide.commands.some((command) => command.command.includes("/api/agent-prompt")));

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

  const rentAHuman = BUILDING_CATALOG.find((building) => building.id === "rentahuman");
  assert.equal(rentAHuman.category, "Commerce");
  assert.equal(rentAHuman.status, "MCP-ready");
  assert.equal(rentAHuman.visual.shape, "market");
  assert.equal(rentAHuman.visual.logo, "rentahuman");
  assert.match(rentAHuman.description, /MCP server|REST API/i);
  assert.match(rentAHuman.access.detail, /operator pairing|escrow approval/i);
  assert.ok(rentAHuman.agentGuide.docs.some((doc) => doc.url.includes("rentahuman.ai/mcp")));
  assert.ok(rentAHuman.agentGuide.commands.some((command) => command.command.includes("rentahuman-mcp")));

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
      logo: "Example Logo!",
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
  assert.equal(building.visual.logo, "example-logo");
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
