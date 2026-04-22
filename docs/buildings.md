# Building Architecture

Buildings are the extension unit for Vibe Research integrations. A building gives an integration a visible home, install state, onboarding checklist, settings variables, and optional Agent Town behavior.

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
- `visual.shape` selects the generic card/town building treatment.
- `visual.specialTownPlace: true` reserves a custom hand-drawn Agent Town place, such as OttoAuth or VideoMemory.
- `ui.mode` is `panel`, `wide`, or `workspace`; workspace buildings can open a compact town panel first and expand into a full-screen app.
- `ui.entryView` names the compact building panel implementation; `ui.workspaceView` names the routed view used when the building needs the whole screen.
- `onboarding.variables` powers the generic install checklist.
- `onboarding.steps[].completeWhen` can use `{ type: "installed" }`, `{ setting: "key" }`, `{ configuredSetting: "key" }`, `{ allConfigured: ["key"] }`, or `{ anyConfigured: ["key"] }`.
- `agentGuide` powers generated Markdown manuals for Codex, Claude Code, and shell agents. The generated index is available at `$VIBE_RESEARCH_BUILDING_GUIDES_INDEX`; per-building files live in `$VIBE_RESEARCH_BUILDING_GUIDES_DIR/<building-id>.md`.
- `agentGuide.commands` are declarative setup or inspection commands for agents to try when appropriate. They are not automatically executed by the catalog.
- `agentGuide.env` should name runtime environment variables and credential expectations without including secret values.
- Secrets should use a redacted public setting such as `exampleApiKeyConfigured`; the raw secret should not be returned to the browser.

## BuildingHub

BuildingHub is the installed system building for the local building catalog and the community catalog path for people who want to contribute buildings without editing Vibe Research itself. Community catalog loading is off by default. It is intentionally manifest-only: catalogs can add building cards, install checklist copy, required variables, access notes, visual treatment, docs links, capability descriptions, and `agentGuide` manuals, but they cannot register executable client code, add custom workspace routes, reserve special Agent Town places, or toggle arbitrary local settings.

Vibe Research can load BuildingHub from a local folder such as `/Users/mark/Desktop/projects/buildinghub`, a direct JSON file, or a reviewed remote registry JSON URL. A folder source may contain a top-level `registry.json`, `buildinghub.json`, or `catalog.json`, plus individual manifests at `buildings/<slug>/building.json`.

Community manifests are normalized on the server by `src/buildinghub-service.js` before they reach the browser. The loader forces `source: "buildinghub"`, strips `install.enabledSetting`, disables `install.system`, clears `onboarding.setupSelector`, coerces workspace UI modes back to panel/wide, prevents `visual.specialTownPlace`, and sanitizes `agentGuide` strings and docs URLs. The browser also refuses community manifests whose normalized id collides with a core building id.

The app exposes `GET /api/buildinghub/catalog?force=1` for explicit refreshes and includes `{ buildingHub: { buildings, status } }` in `GET /api/state`. Runtime configuration lives in settings keys:

- `buildingHubEnabled`
- `buildingHubCatalogPath`
- `buildingHubCatalogUrl`

The companion starter catalog lives at `/Users/mark/Desktop/projects/buildinghub`. Its expected contribution flow is: copy `templates/basic-building/building.json`, fill in the manifest and README under `buildings/<slug>/`, run its validator, rebuild `registry.json`, then open a normal review PR.

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
