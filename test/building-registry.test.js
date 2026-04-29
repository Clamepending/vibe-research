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
  assert.ok(ids.includes("gmail"));
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
  assert.match(googleCalendar.agentGuide.summary, /create a calendar event|availability/i);
  assert.ok(googleCalendar.agentGuide.commands.some((command) => command.command.includes("/api/google/calendar/events?calendarId=primary")));
  assert.ok(googleCalendar.agentGuide.commands.some((command) => command.command.includes("/api/google/calendar/freebusy")));
  assert.ok(googleCalendar.agentGuide.commands.some((command) => command.command.includes("/api/google/calendar/events\" -H 'Content-Type: application/json'")));
  assert.ok(googleCalendar.agentGuide.env.some((envVar) => envVar.name === "VIBE_RESEARCH_URL"));
  assert.ok(googleCalendar.agentGuide.docs.some((doc) => doc.url.includes("developers.google.com/workspace/calendar/api/v3/reference/events")));

  const gmail = BUILDING_CATALOG.find((building) => building.id === "gmail");
  assert.equal(gmail.install.system, true);
  assert.equal(gmail.status, "ready");
  assert.equal(gmail.source, "google");
  assert.equal(gmail.onboarding.steps[0].title, "Enable Gmail access");
  assert.equal(gmail.onboarding.steps[0].completeWhen?.buildingAccessConfirmed, true);

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

  // Localhost Apps must be a system building so the sidebar "ports" section
  // shows up by default — without `install.system`, isPluginInstalled() returns
  // false until the user manually opts in, which (a) breaks the historical UX
  // where ports were always one click away in the sidebar and (b) hides the
  // most-useful surface for previewing local dev servers across Tailscale.
  const localhostApps = BUILDING_CATALOG.find((building) => building.id === "localhost-apps");
  assert.equal(localhostApps.install.system, true, "localhost-apps must be a default system building");
  assert.equal(localhostApps.status, "built in");
  assert.equal(localhostApps.source, "vibe-research");

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
  assert.equal(modal.status, "one-click install");
  assert.ok(modal.install?.plan, "modal must declare a one-click install plan");
  assert.equal(modal.install.plan.preflight[0].command, "command -v modal");
  assert.equal(modal.install.plan.auth.kind, "auth-browser-cli");
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
  assert.match(occupations.access.detail, /AGENTS\.md and CLAUDE\.md/i);
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

  const videoMemory = BUILDING_CATALOG.find((building) => building.id === "videomemory");
  assert.equal(videoMemory.ui.entryView, "videomemory");
  assert.equal(videoMemory.ui.mode, "panel");
  assert.equal(videoMemory.visual.shape, "camera");
  // VideoMemory has a dedicated Camera Room slot in Agent Town — it is a
  // special auto-placed building so it does not also appear as a generic
  // placeable plugin building.
  assert.equal(AGENT_TOWN_SPECIAL_BUILDING_IDS.has("videomemory"), true);

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
    ui: {
      mode: "workspace",
      entryView: "example-commerce",
      workspaceView: "plugins",
      sidebarTab: {
        enabled: true,
        label: "Example Ops",
        meta: "community helper",
      },
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
  assert.equal(building.ui.mode, "workspace");
  assert.equal(building.ui.entryView, "example-commerce");
  assert.equal(building.ui.workspaceView, "plugins");
  assert.deepEqual(building.ui.sidebarTab, {
    enabled: true,
    label: "Example Ops",
    meta: "community helper",
  });
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

test("popular MCP-server buildings are registered with one-click install plans", () => {
  const expectedMcpBuildings = [
    { id: "mcp-filesystem", verifyPackage: "@modelcontextprotocol/server-filesystem", needsAuth: false },
    { id: "mcp-github", verifyPackage: "@modelcontextprotocol/server-github", needsAuth: true, authSetting: "mcpGithubToken" },
    { id: "mcp-postgres", verifyPackage: "@modelcontextprotocol/server-postgres", needsAuth: true, authSetting: "mcpPostgresUrl" },
    { id: "mcp-sqlite", verifyPackage: "mcp-server-sqlite", needsAuth: true, authSetting: "mcpSqliteDbPath" },
    { id: "mcp-brave-search", verifyPackage: "@modelcontextprotocol/server-brave-search", needsAuth: true, authSetting: "mcpBraveSearchApiKey" },
    { id: "mcp-slack", verifyPackage: "@modelcontextprotocol/server-slack", needsAuth: true, authSetting: "mcpSlackBotToken" },
    { id: "mcp-sentry", verifyPackage: "@sentry/mcp-server", needsAuth: true, authSetting: "mcpSentryAuthToken" },
    { id: "mcp-notion", verifyPackage: "@notionhq/notion-mcp-server", needsAuth: true, authSetting: "mcpNotionToken" },
    { id: "mcp-linear", verifyPackage: "@tacticlaunch/mcp-linear", needsAuth: true, authSetting: "mcpLinearApiKey" },
  ];

  for (const expected of expectedMcpBuildings) {
    const building = BUILDING_CATALOG.find((entry) => entry.id === expected.id);
    assert.ok(building, `${expected.id} must be registered`);
    assert.equal(building.category, "MCP", `${expected.id} should be categorized as MCP`);
    assert.equal(building.status, "one-click install", `${expected.id} status`);
    const plan = building.install?.plan;
    assert.ok(plan, `${expected.id} must declare install.plan`);
    assert.ok(plan.preflight.some((step) => step.command === "command -v npx"), `${expected.id} preflight checks npx`);
    assert.ok(
      plan.verify.some((step) => step.command?.includes(`npm view ${expected.verifyPackage}`)),
      `${expected.id} verify uses npm view ${expected.verifyPackage}`,
    );
    assert.ok(plan.mcp.length > 0, `${expected.id} declares mcp launch`);
    if (expected.needsAuth) {
      assert.ok(plan.auth, `${expected.id} declares auth step`);
      assert.equal(plan.auth.kind, "auth-paste");
      assert.equal(plan.auth.setting, expected.authSetting);
    } else {
      assert.equal(plan.auth, null, `${expected.id} should not declare auth`);
    }
  }
});

test("modal + ottoauth declare install plans", () => {
  const modal = BUILDING_CATALOG.find((entry) => entry.id === "modal");
  assert.ok(modal.install.plan);
  assert.equal(modal.install.plan.auth.kind, "auth-browser-cli");
  assert.equal(modal.install.plan.auth.command, "modal token new --source web");

  const otto = BUILDING_CATALOG.find((entry) => entry.id === "ottoauth");
  assert.ok(otto.install.plan);
  const httpStep = otto.install.plan.install.find((step) => step.kind === "http");
  assert.ok(httpStep, "ottoauth should declare an http install step");
  assert.equal(httpStep.url, "https://ottoauth.vercel.app/api/agents/create");
  assert.deepEqual(httpStep.captureSettings, {
    username: "ottoAuthUsername",
    privateKey: "ottoAuthPrivateKey",
    callbackUrl: "ottoAuthCallbackUrl",
  });
  assert.equal(otto.install.plan.auth.kind, "auth-paste");
});
