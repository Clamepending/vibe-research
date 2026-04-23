# Building Architecture

Buildings are the extension unit for Vibe Research integrations. A building gives an integration a visible home, install state, onboarding checklist, settings variables, and optional Agent Town behavior.

For the broader visual operating-system contract that buildings plug into, see `docs/visual-os-foundation.md`.

## Files

- `src/client/building-sdk.js` owns the manifest primitives: `defineBuilding`, `createBuildingRegistry`, and `normalizeBuildingId`.
- `src/client/building-registry.js` registers the core buildings shipped with Vibe Research.
- `src/client/main.js` consumes the registry to render install cards, onboarding steps, install toggles, and generic Agent Town building lots.

## Manifest Shape

```js
import { defineBuilding } from "./building-registry.js";

export default defineBuilding({
  id: "example-commerce",
  name: "Example Commerce",
  category: "Commerce",
  description: "Let agents submit requests to Example Commerce.",
  source: "custom",
  status: "setup available",
  icon: ShoppingCart,

  install: {
    enabledSetting: "exampleCommerceEnabled",
    storedFallback: false,
  },

  visual: {
    shape: "market",
    specialTownPlace: false,
  },

  ui: {
    mode: "panel",
    entryView: "example-commerce",
    workspaceView: "",
    sidebarTab: {
      enabled: true,
      label: "Example Commerce",
      meta: "community helper",
    },
  },

  onboarding: {
    setupSelector: ".example-commerce-plugin-card",
    variables: [
      {
        label: "API key",
        setting: "exampleCommerceApiKey",
        configuredSetting: "exampleCommerceApiKeyConfigured",
        secret: true,
        required: true,
        setupUrl: "https://example.com/account/api-keys",
        setupLabel: "Get key",
        setupHint: "Create a scoped API key, then paste it here.",
      },
      { label: "Default budget", setting: "exampleCommerceBudgetCents", suffix: "cents" },
    ],
    steps: [
      { title: "Enable the building", detail: "Turn on Example Commerce.", completeWhen: { type: "installed" } },
      {
        title: "Save variables",
        detail: "Add the API key and request defaults.",
        completeWhen: { allConfigured: ["exampleCommerceApiKeyConfigured"] },
      },
      { title: "Call the helper", detail: "Agents can run the building helper from a session." },
    ],
  },

  agentGuide: {
    summary: "Use Example Commerce when an agent needs to create or inspect commerce requests.",
    useCases: [
      "Check whether commerce credentials are configured.",
      "Run a dry-run helper before creating a real request.",
    ],
    setup: [
      "Confirm the API key is configured before making write requests.",
      "Keep generated artifacts under the result directory for the current move.",
    ],
    commands: [
      {
        label: "Dry run request",
        command: "example-commerce --dry-run --request request.json",
        detail: "Validates local setup without spending money or writing remote state.",
      },
    ],
    env: [
      { name: "EXAMPLE_COMMERCE_API_KEY", required: true, detail: "Provider credential; never print it." },
    ],
    docs: [
      { label: "Example Commerce API docs", url: "https://example.com/docs" },
    ],
  },
});
```

## Contracts

- `id` is normalized with `normalizeBuildingId` and must be stable.
- `install.enabledSetting` lets the generic install button toggle a persisted settings key.
- `install.storedFallback: false` means the settings key is the source of truth for installed state.
- `visual.shape` selects the generic card/town building treatment. Use `lab` for sandboxed eval providers where working agents should visually sit inside glass test pods.
- `visual.specialTownPlace: true` reserves a custom hand-drawn Agent Town place, such as OttoAuth or VideoMemory.
- `ui.mode` is `panel`, `wide`, or `workspace`; workspace buildings can open a compact town panel first and expand into a full-screen app.
- `ui.entryView` names the compact building panel implementation; `ui.workspaceView` names the routed view used when the building needs the whole screen.
- `ui.sidebarTab` is optional. When enabled on a community BuildingHub manifest, the app shows a "community tabs" sidebar section with a link that opens that building's detail panel.
- `onboarding.variables` powers the generic install checklist.
- `onboarding.variables[].setting` makes a setup row clickable: the UI looks for a form control with that exact `name`, scrolls to it, focuses it, and briefly highlights it.
- `onboarding.variables[].focusSelector` can override `setting` when the target is not a normal form control. Keep selectors scoped to first-party UI; BuildingHub community manifests cannot provide executable setup selectors.
- `onboarding.variables[].setupUrl`, `setupLabel`, and `setupHint` add beginner-friendly help for keys, pairing codes, or provider setup pages. Only use public HTTPS URLs; never put secrets or user-specific codes in manifests.
- `onboarding.steps[].completeWhen` can use `{ type: "installed" }`, `{ setting: "key" }`, `{ configuredSetting: "key" }`, `{ allConfigured: ["key"] }`, `{ anyConfigured: ["key"] }`, or `{ buildingAccessConfirmed: true }` for one-click external access confirmations.
- `onboarding.steps[].setupUrl` and `setupLabel` power the single next-step button shown while that step is incomplete. Keep this copy human-facing: "Enable Calendar access", not protocol or provider plumbing.
- `agentGuide` powers generated Markdown manuals for Codex, Claude Code, OpenClaw, and shell agents. The generated index is available at `$VIBE_RESEARCH_BUILDING_GUIDES_INDEX`; per-building files live in `$VIBE_RESEARCH_BUILDING_GUIDES_DIR/<building-id>.md`.
- `agentGuide.commands` are declarative setup or inspection commands for agents to try when appropriate. They are not automatically executed by the catalog.
- `agentGuide.env` should name runtime environment variables and credential expectations without including secret values.
- Secrets should use a redacted public setting such as `exampleApiKeyConfigured`; the raw secret should not be returned to the browser.
- Sensitive building actions should create Agent Inbox approval cards with capability tags before they spend money, send messages, publish work, use credentials, delete user content, control devices, or expose private data.

## BuildingHub

BuildingHub is the installed system building for the local building catalog, Agent Town skins/themes, and the community catalog path for people who want to contribute buildings without editing Vibe Research itself. Community catalog loading is off by default. It is intentionally manifest-only: catalogs can add building cards, install checklist copy, required variables, access notes, visual treatment, docs links, capability descriptions, `agentGuide` manuals, and optional `ui.sidebarTab` labels/meta for the community tabs section, but they cannot register executable client code, add custom workspace routes, reserve special Agent Town places, or toggle arbitrary local settings.

Vibe Research can load BuildingHub from a local folder such as `/Users/mark/Desktop/projects/buildinghub`, a direct JSON file, or a reviewed remote registry JSON URL. A folder source may contain a top-level `registry.json`, `buildinghub.json`, or `catalog.json`, plus individual manifests at `buildings/<slug>/building.json`, Agent Town layouts at `layouts/<slug>/layout.json`, and scaffold recipes at `recipes/<slug>/recipe.json`.

Community manifests are normalized on the server by `src/buildinghub-service.js` before they reach the browser. The loader forces `source: "buildinghub"`, strips `install.enabledSetting`, disables `install.system`, clears `onboarding.setupSelector`, coerces workspace UI modes back to panel/wide, prevents `visual.specialTownPlace`, and sanitizes `agentGuide` strings and docs URLs. The browser also refuses community manifests whose normalized id collides with a core building id.

Scaffold recipes are portable setup snapshots for sharing a whole working Vibe Research shape: building set, portable settings, communication policy, occupation metadata, sandbox assumptions, Library binding requirements, and Agent Town layout. They intentionally do not carry secrets, personal identity values, or machine-local paths; those are expressed as local bindings that must be supplied during apply. See `docs/scaffold-recipes.md`.

The app exposes `GET /api/buildinghub/catalog?force=1` for explicit refreshes and includes `{ buildingHub: { buildings, layouts, recipes, status } }` in `GET /api/state`. Runtime configuration lives in settings keys:

- `buildingHubEnabled`
- `buildingHubCatalogPath`
- `buildingHubCatalogUrl`

The companion starter catalog lives at `/Users/mark/Desktop/projects/buildinghub`. Its expected contribution flow is: copy `templates/basic-building/building.json`, fill in the manifest and README under `buildings/<slug>/`, run its validator, rebuild `registry.json`, then open a normal review PR.

Built-in Agent Town themes live in first-party client code and are exposed through BuildingHub. Theme selection is browser-local and persists via local storage; it is not a community manifest capability.

## Toolshed

Toolshed is the built-in Agent Town building for people and agents creating new buildings. It should answer two questions without making a newcomer leave the canvas:

- how Vibe Research works as a whole: Agent Town, buildings, Library, settings, occupations, automations, and communication bridges
- how a building moves from idea to publishable artifact: draft a manifest, keep credentials out of client data, validate the catalog, rebuild `registry.json`, and open a reviewed BuildingHub PR

Toolshed is first-party app code, not a BuildingHub community manifest, because it links together workspace routes and local project conventions. Community buildings should still start in BuildingHub unless they need executable server routes, custom client code, or special Agent Town behavior.

## Current Scope

The core registry is client-side, while BuildingHub catalogs are loaded by a server-side manifest reader and merged into the client catalog at runtime. Runtime helper services, API routes, session env vars, generated building guides, and custom Agent Town behavior still need first-party Vibe Research code. The intended direction is to make more safe pieces declarative as the building SDK matures.

## Generative Media Buildings

Treat image and video generation products as separate provider buildings, not one generic image-generation building. Sora, Nano Banana, Veo, Runway, or similar tools can share a `Generative Media` category while keeping their own auth expectations, model families, output artifacts, deprecation notes, and onboarding copy.

Use `visual.shape: "studio"` for prompt-to-image or prompt-to-video provider cards unless the integration has a more specific custom place. Keep provider credentials in the agent runtime or provider connector; the building catalog should describe the requirement without storing raw API keys in the client manifest.

## Evaluation Buildings

Use `visual.shape: "lab"` for sandboxed agent-evaluation systems such as Harbor. These buildings should make the setup boundary explicit: the catalog can tell agents when Harbor is warranted, how to check the CLI, and which docs/commands to start from, but model keys, cloud sandbox credentials, and costly run approval stay in the agent runtime and human workflow.

When the runtime can identify an active eval from commands, paths, or session naming, Agent Town may route that working agent into the lab so the map reflects an agent inside a sandboxed test environment.

## Cloud Compute Buildings

Use separate provider buildings for cloud compute systems such as Modal and RunPod. These buildings should make agents' access path explicit: required CLI or SDK, runtime credential environment variables, account or project scope, read-only smoke checks, and approval boundaries before creating resources that can spend money.

Cloud compute credentials stay in the agent runtime or provider tooling. The building catalog should describe `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `RUNPOD_API_KEY`, endpoint IDs, pod IDs, and similar variables without collecting or rendering their values in the browser. Prefer `visual.shape: "lab"` when the provider is primarily used for sandboxes, GPU jobs, or remote worker environments.

## Physical Robotics Buildings

Use dedicated provider buildings for physical robotics workflows such as LeRobot + SO-101. These buildings should encode the full operational chain agents need to respect: procurement state, assembly readiness, hardware connectivity, teleoperation/data capture, and policy training/evaluation.

Robot-control actions should be treated like other sensitive capabilities: require human approval before purchases, initiating physical motion, and launching expensive cloud or GPU training jobs. Keep credentials, ports, and machine-local hardware details in the agent runtime or local notes, not in browser settings manifests.
