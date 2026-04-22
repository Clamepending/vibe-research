import {
  AppWindow,
  Banana,
  BookOpen,
  Bot,
  Camera,
  CalendarClock,
  CalendarDays,
  Clapperboard,
  Database,
  GitPullRequest,
  Lightbulb,
  Mail,
  MessageCircle,
  MessagesSquare,
  Notebook,
  Plug,
  Send,
  ShoppingCart,
  Smartphone,
} from "lucide";
import { createBuildingRegistry, defineBuilding, normalizeBuildingId } from "./building-sdk.js";

const CORE_BUILDING_MANIFESTS = [
  {
    id: "github",
    name: "GitHub",
    category: "Coding",
    description: "Triage PRs, inspect issues, and publish changes from agent sessions.",
    icon: GitPullRequest,
    install: {
      system: true,
    },
    status: "available in Codex",
    source: "plugin",
    access: {
      label: "Host connector",
      detail: "Available to host agents that have the GitHub connector or gh authentication. Local terminal agents need their own GitHub auth.",
    },
    onboarding: {
      variables: [
        { label: "GitHub account", value: "Codex connector or gh auth", required: true },
        { label: "Repository access", value: "granted in host agent", required: true },
      ],
      steps: [
        { title: "Connect GitHub", detail: "Enable the GitHub plugin or authenticate gh where agents run." },
        { title: "Start a session", detail: "Agents can inspect repositories, issues, pull requests, and checks." },
      ],
    },
  },
  {
    id: "google-drive",
    name: "Google Drive",
    category: "Knowledge",
    description: "Search Docs, Sheets, Slides, and shared project files when the host agent supports it.",
    icon: Database,
    install: {
      system: true,
    },
    status: "MCP-ready",
    source: "mcp",
    access: {
      label: "Host connector",
      detail: "Available to host agents with the Google Drive connector enabled. Vibe Research does not inject Drive tools into local terminal agents.",
    },
    onboarding: {
      variables: [
        { label: "Google account", value: "connected host MCP account", required: true },
        { label: "Shared drive scope", value: "docs/sheets/slides access", required: false },
        { label: "Local terminal agents", value: "provider MCP required", required: false },
      ],
      steps: [
        { title: "Connect the MCP", detail: "Authorize Drive in the host agent that will use this building." },
        { title: "Name the source", detail: "Tell agents which folders, docs, or sheets are relevant." },
        { title: "Local agents", detail: "Configure Google Drive in the local CLI/provider separately if a terminal agent needs direct access." },
      ],
    },
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    category: "Planning",
    description: "Look up events and availability from connected agent tooling.",
    icon: CalendarDays,
    install: {
      system: true,
    },
    status: "MCP-ready",
    source: "mcp",
    access: {
      label: "Host connector",
      detail: "Available to host agents with the Google Calendar connector enabled. Local terminal agents need their own provider calendar connector.",
    },
    onboarding: {
      variables: [
        { label: "Google account", value: "connected MCP account", required: true },
        { label: "Calendar scope", value: "event and availability access", required: true },
      ],
      steps: [
        { title: "Connect the MCP", detail: "Authorize Calendar in the agent host that will run this building." },
        { title: "Pick calendars", detail: "Keep the account scope narrow enough for agents to reason about." },
      ],
    },
  },
  {
    id: "buildinghub",
    name: "BuildingHub",
    category: "Community",
    description: "Load manifest-only community buildings from a local or remote BuildingHub catalog.",
    icon: Plug,
    install: {
      enabledSetting: "buildingHubEnabled",
      storedFallback: false,
    },
    status: "catalog ready",
    source: "vibe-research",
    visual: {
      shape: "plugin",
    },
    access: {
      label: "Manifest catalog",
      detail: "BuildingHub catalogs contribute setup guides and visual buildings only. They do not run executable code inside Vibe Research.",
    },
    onboarding: {
      variables: [
        { label: "Local catalog", setting: "buildingHubCatalogPath", required: false },
        { label: "Remote catalog", setting: "buildingHubCatalogUrl", required: false },
      ],
      steps: [
        { title: "Enable BuildingHub", detail: "Turn on community building catalogs.", completeWhen: { type: "installed" } },
        {
          title: "Choose a source",
          detail: "Point Vibe Research at a local BuildingHub checkout or a reviewed registry JSON URL.",
          completeWhen: { anyConfigured: ["buildingHubCatalogPath", "buildingHubCatalogUrl"] },
        },
        { title: "Review manifests", detail: "Install community buildings after checking their setup notes and required capabilities." },
      ],
    },
  },
  {
    id: "sora",
    name: "Sora",
    category: "Generative Media",
    description: "Create, edit, and extend OpenAI video generations through a Videos API or provider connector.",
    icon: Clapperboard,
    status: "API sunset 2026-09-24",
    source: "external",
    visual: {
      shape: "studio",
    },
    access: {
      label: "OpenAI Videos API",
      detail: "Requires OPENAI_API_KEY and account access to the OpenAI Videos API where the agent runs. Sora 2 and the Videos API are deprecated and scheduled to shut down on September 24, 2026.",
    },
    onboarding: {
      variables: [
        { label: "OpenAI API key", value: "OPENAI_API_KEY in agent environment", required: true },
        { label: "Model", value: "sora-2 or sora-2-pro while available", required: true },
        { label: "Artifact scope", value: "video IDs, downloads, thumbnails, and prompts", required: false },
      ],
      steps: [
        { title: "Confirm availability", detail: "Check that the account still has Videos API access before assigning Sora work." },
        { title: "Connect OpenAI", detail: "Provide OPENAI_API_KEY to the provider or local environment that will generate videos." },
        { title: "Install the building", detail: "Add the Sora studio once the external API or connector is ready.", completeWhen: { type: "installed" } },
      ],
    },
  },
  {
    id: "nano-banana",
    name: "Nano Banana",
    category: "Generative Media",
    description: "Generate, edit, and iterate on Gemini images with Nano Banana models.",
    icon: Banana,
    status: "connector-ready",
    source: "external",
    visual: {
      shape: "studio",
    },
    access: {
      label: "Gemini image API",
      detail: "Requires GEMINI_API_KEY, Google AI Studio, or Vertex AI access where the agent runs. Use this building for Nano Banana 2, Nano Banana Pro, and Gemini 2.5 Flash Image workflows.",
    },
    onboarding: {
      variables: [
        { label: "Gemini API key", value: "GEMINI_API_KEY in agent environment", required: true },
        { label: "Model family", value: "Nano Banana 2, Nano Banana Pro, or Gemini 2.5 Flash Image", required: true },
        { label: "Artifact policy", value: "save prompts, source images, output paths, and watermarked assets", required: false },
      ],
      steps: [
        { title: "Choose the model", detail: "Pick the Nano Banana model that matches speed, fidelity, and editing needs." },
        { title: "Connect Gemini", detail: "Provide Gemini API access to the provider or local environment that will generate images." },
        { title: "Install the building", detail: "Add the Nano Banana studio once the external API or connector is ready.", completeWhen: { type: "installed" } },
      ],
    },
  },
  {
    id: "browser-use",
    name: "Browser Use",
    category: "Vibe Research",
    description: "Start an OttoAuth browser fulfillment agent from a coding-agent session.",
    icon: Bot,
    install: {
      enabledSetting: "browserUseEnabled",
      storedFallback: false,
    },
    status: "setup available",
    source: "vibe-research",
    visual: {
      shape: "browser",
      specialTownPlace: true,
    },
    onboarding: {
      setupSelector: ".browser-use-plugin-card",
      variables: [
        {
          label: "Anthropic API key",
          setting: "browserUseAnthropicApiKey",
          configuredSetting: "browserUseAnthropicApiKeyConfigured",
          secret: true,
          required: true,
        },
        { label: "Worker folder", setting: "browserUseWorkerPath", required: true },
        { label: "Profile folder", setting: "browserUseProfileDir", required: true },
        { label: "Max steps", setting: "browserUseMaxTurns", required: false },
      ],
      steps: [
        { title: "Enable the building", detail: "Turn on browser-use requests.", completeWhen: { type: "installed" } },
        {
          title: "Save browser variables",
          detail: "Add the API key, worker folder, profile folder, and run defaults.",
          completeWhen: { allConfigured: ["browserUseAnthropicApiKeyConfigured", "browserUseWorkerPath", "browserUseProfileDir"] },
        },
        { title: "Call the helper", detail: "Agents can run vr-browser-use --task \"...\" from a session." },
      ],
    },
  },
  {
    id: "ottoauth",
    name: "OttoAuth",
    category: "Commerce",
    description: "Let agents buy things through OttoAuth's hosted, human-linked service layer.",
    icon: ShoppingCart,
    install: {
      enabledSetting: "ottoAuthEnabled",
      storedFallback: false,
    },
    status: "setup available",
    source: "vibe-research",
    visual: {
      shape: "market",
      specialTownPlace: true,
    },
    onboarding: {
      setupSelector: ".ottoauth-plugin-card",
      variables: [
        { label: "Username", setting: "ottoAuthUsername", required: true },
        {
          label: "Private key",
          setting: "ottoAuthPrivateKey",
          configuredSetting: "ottoAuthPrivateKeyConfigured",
          secret: true,
          required: true,
        },
        { label: "Service URL", setting: "ottoAuthBaseUrl", required: true },
        { label: "Default spend cap", setting: "ottoAuthDefaultMaxChargeCents", suffix: "cents", required: false },
        { label: "Callback URL", setting: "ottoAuthCallbackUrl", required: false },
      ],
      steps: [
        { title: "Enable the building", detail: "Turn on OttoAuth requests.", completeWhen: { type: "installed" } },
        {
          title: "Save commerce variables",
          detail: "Add the username, private key, service URL, and spend defaults.",
          completeWhen: { allConfigured: ["ottoAuthUsername", "ottoAuthPrivateKeyConfigured", "ottoAuthBaseUrl"] },
        },
        { title: "Call the helper", detail: "Agents can run vr-ottoauth --task \"...\" --max-charge-cents 2500 --wait." },
      ],
    },
  },
  {
    id: "videomemory",
    name: "VideoMemory",
    category: "Vibe Research",
    description: "Let coding agents create video monitors that wake their own Vibe Research sessions.",
    icon: Camera,
    install: {
      enabledSetting: "videoMemoryEnabled",
      storedFallback: false,
    },
    status: "setup available",
    source: "vibe-research",
    visual: {
      shape: "camera",
      specialTownPlace: true,
    },
    onboarding: {
      setupSelector: ".videomemory-plugin-card",
      variables: [
        { label: "VideoMemory URL", setting: "videoMemoryBaseUrl", required: true },
        { label: "Wake provider", setting: "videoMemoryProviderId", required: true },
        { label: "Camera permission", value: "browser permission", required: true },
      ],
      steps: [
        { title: "Enable the building", detail: "Turn on camera monitors.", completeWhen: { type: "installed" } },
        {
          title: "Save monitor variables",
          detail: "Set the service URL and provider agents should wake.",
          completeWhen: { allConfigured: ["videoMemoryBaseUrl", "videoMemoryProviderId"] },
        },
        { title: "Grant camera access", detail: "Start a monitor and allow camera access when the browser asks." },
      ],
    },
  },
  {
    id: "agentmail",
    name: "AgentMail",
    category: "Communication",
    description: "Give Vibe Research an email inbox handled by one dedicated communications agent.",
    icon: Mail,
    install: {
      enabledSetting: "agentMailEnabled",
      storedFallback: true,
    },
    status: "setup available",
    source: "vibe-research",
    onboarding: {
      setupSelector: ".communications-plugin-card",
      variables: [
        {
          label: "AgentMail API key",
          setting: "agentMailApiKey",
          configuredSetting: "agentMailApiKeyConfigured",
          secret: true,
          required: true,
        },
        { label: "Inbox ID", setting: "agentMailInboxId", required: true },
        { label: "Communications agent", setting: "agentMailProviderId", required: true },
      ],
      steps: [
        { title: "Enable the building", detail: "Turn on the AgentMail listener.", completeWhen: { type: "installed" } },
        {
          title: "Save mail variables",
          detail: "Add the API key and inbox the listener should watch.",
          completeWhen: { allConfigured: ["agentMailApiKeyConfigured", "agentMailInboxId"] },
        },
        { title: "Reply from one session", detail: "Incoming email is routed into the dedicated AgentMail communications session." },
      ],
    },
  },
  {
    id: "telegram",
    name: "Telegram",
    category: "Communication",
    description: "Route Telegram bot messages into one dedicated communications agent session.",
    icon: Send,
    install: {
      enabledSetting: "telegramEnabled",
      storedFallback: true,
    },
    status: "setup available",
    source: "vibe-research",
    onboarding: {
      setupSelector: ".communications-plugin-card",
      variables: [
        {
          label: "Bot token",
          setting: "telegramBotToken",
          configuredSetting: "telegramBotTokenConfigured",
          secret: true,
          required: true,
        },
        { label: "Allowed chat IDs", setting: "telegramAllowedChatIds", required: false },
        { label: "Communications agent", setting: "telegramProviderId", required: true },
      ],
      steps: [
        { title: "Create a bot", detail: "Use BotFather to get a Telegram bot token.", completeWhen: { type: "installed" } },
        {
          title: "Save Telegram variables",
          detail: "Add the bot token and optionally limit which chat IDs the bot may answer.",
          completeWhen: { allConfigured: ["telegramBotTokenConfigured"] },
        },
        { title: "Reply from one session", detail: "Incoming Telegram messages are routed into the dedicated Telegram communications session." },
      ],
    },
  },
  {
    id: "discord",
    name: "Discord",
    category: "Communication",
    description: "Route Discord server or DM activity through a dedicated provider connector.",
    icon: MessagesSquare,
    status: "connector-ready",
    source: "external",
    visual: {
      shape: "post",
    },
    access: {
      label: "External connector",
      detail: "Requires a Discord bot, webhook, or provider MCP configured where the agent runs. Vibe Research does not inject Discord credentials into local terminal agents.",
    },
    onboarding: {
      variables: [
        { label: "Discord app", value: "bot or webhook", required: false },
        { label: "Server scope", value: "channels and DMs to monitor", required: false },
        { label: "Agent access", value: "provider MCP or local bridge", required: false },
      ],
      steps: [
        { title: "Create an app", detail: "Create a Discord bot or webhook with the narrow channel permissions agents need." },
        { title: "Connect the provider", detail: "Add the Discord connector to the host/provider that will handle messages." },
        { title: "Install the building", detail: "Add this building to Agent Town once the external connector is ready.", completeWhen: { type: "installed" } },
      ],
    },
  },
  {
    id: "moltbook",
    name: "Moltbook",
    category: "Knowledge",
    description: "Keep a social notebook or research log connector visible for agents.",
    icon: Notebook,
    status: "connector-ready",
    source: "external",
    visual: {
      shape: "library",
    },
    access: {
      label: "External connector",
      detail: "Requires a Moltbook-compatible API, MCP, or sync bridge configured in the agent provider. Vibe Research only tracks the building and setup state.",
    },
    onboarding: {
      variables: [
        { label: "Workspace", value: "Moltbook notebook or team", required: false },
        { label: "Sync scope", value: "notes, posts, or research logs", required: false },
        { label: "Agent access", value: "provider MCP or API bridge", required: false },
      ],
      steps: [
        { title: "Pick the notebook", detail: "Choose which Moltbook space agents should read or update." },
        { title: "Configure access", detail: "Connect the API or MCP in the host/provider that will use it." },
        { title: "Install the building", detail: "Add the building once the external connector is ready.", completeWhen: { type: "installed" } },
      ],
    },
  },
  {
    id: "twitter",
    name: "Twitter / X",
    category: "Social",
    description: "Let agents monitor posts, draft replies, or manage social updates through a provider connector.",
    icon: MessageCircle,
    status: "connector-ready",
    source: "external",
    visual: {
      shape: "post",
    },
    access: {
      label: "External connector",
      detail: "Requires Twitter/X API access or an MCP connector configured in the agent provider. Local terminal agents do not receive social credentials from Vibe Research.",
    },
    onboarding: {
      variables: [
        { label: "Account", value: "Twitter/X account or app", required: false },
        { label: "Permissions", value: "read, draft, or post", required: false },
        { label: "Agent access", value: "provider MCP or API bridge", required: false },
      ],
      steps: [
        { title: "Create API access", detail: "Prepare the Twitter/X account, app, and scopes the agent should use." },
        { title: "Connect the provider", detail: "Configure the API or MCP in the agent host, not in a prompt." },
        { title: "Install the building", detail: "Add this building once the external connector is ready.", completeWhen: { type: "installed" } },
      ],
    },
  },
  {
    id: "phone-imessage",
    name: "Phone / iMessage",
    category: "Communication",
    description: "Coordinate SMS, calls, or iMessage-style conversations through a local bridge.",
    icon: Smartphone,
    status: "bridge required",
    source: "external",
    visual: {
      shape: "post",
    },
    access: {
      label: "Local bridge",
      detail: "Requires a phone, SMS, or Apple Messages bridge configured on the machine/provider that will send messages. Vibe Research does not inject phone or iMessage access into agents.",
    },
    onboarding: {
      variables: [
        { label: "Bridge", value: "SMS, phone, or Messages relay", required: false },
        { label: "Allowed contacts", value: "explicit allowlist recommended", required: false },
        { label: "Agent access", value: "provider MCP or local helper", required: false },
      ],
      steps: [
        { title: "Choose a relay", detail: "Set up the SMS, call, or Messages bridge outside Vibe Research." },
        { title: "Restrict contacts", detail: "Use explicit allowlists and confirmation flows for outbound communication." },
        { title: "Install the building", detail: "Add this building once the bridge is ready.", completeWhen: { type: "installed" } },
      ],
    },
  },
  {
    id: "home-automation",
    name: "Home Automation",
    category: "Home",
    description: "Control lights and home devices through Home Assistant, HomeKit, Matter, or a similar bridge.",
    icon: Lightbulb,
    status: "bridge required",
    source: "external",
    visual: {
      shape: "plugin",
    },
    access: {
      label: "Local bridge",
      detail: "Requires a Home Assistant, HomeKit, Matter, or device-specific bridge configured where the agent runs. Vibe Research does not grant device control by itself.",
    },
    onboarding: {
      variables: [
        { label: "Controller", value: "Home Assistant, HomeKit, or Matter", required: false },
        { label: "Device scope", value: "lights, switches, scenes", required: false },
        { label: "Safety", value: "confirm destructive actions", required: false },
      ],
      steps: [
        { title: "Connect a controller", detail: "Expose only the lights, switches, or scenes the agent should control." },
        { title: "Add safety rules", detail: "Require confirmation for locks, alarms, appliances, or anything safety-critical." },
        { title: "Install the building", detail: "Add this building once the local bridge is ready.", completeWhen: { type: "installed" } },
      ],
    },
  },
  {
    id: "automations",
    name: "Automations",
    category: "Planning",
    description: "Schedule recurring Vibe Research helpers from the Berkeley Campanile-inspired clock tower.",
    icon: CalendarClock,
    install: {
      system: true,
    },
    status: "built in",
    source: "vibe-research",
    visual: {
      shape: "campanile",
      specialTownPlace: true,
    },
    onboarding: {
      variables: [
        { label: "Default workspace", value: "current project folder", required: true },
        { label: "Cadence", value: "daily, weekly, or hourly schedule", required: true },
        { label: "Prompt", value: "helper task instructions", required: true },
      ],
      steps: [
        { title: "Open the tower", detail: "Use the Automations tab from the Campanile building in Agent Town." },
        { title: "Choose a schedule", detail: "Pick the cadence and workspace where the helper should run." },
        { title: "Write the task", detail: "Describe the recurring helper work and save it." },
      ],
    },
  },
  {
    id: "localhost-apps",
    name: "Localhost Apps",
    category: "Vibe Research",
    description: "Preview web apps from discovered ports without leaving the current session.",
    icon: AppWindow,
    status: "built in",
    source: "vibe-research",
    visual: {
      shape: "dock",
      specialTownPlace: true,
    },
    onboarding: {
      variables: [
        { label: "Port scan", value: "local workspace ports", required: true },
        { label: "Proxy path", value: "/proxy/<port>/", required: false },
      ],
      steps: [
        { title: "Enable the dock", detail: "Installed sessions show discovered local app ports." },
        { title: "Open a preview", detail: "Pick a detected port to inspect the running app." },
      ],
    },
  },
  {
    id: "knowledge-base",
    name: "Library",
    category: "Vibe Research",
    description: "Search and edit the shared markdown Library that agents receive in their prompt.",
    icon: BookOpen,
    status: "built in",
    source: "vibe-research",
    ui: {
      entryView: "library-foyer",
      mode: "workspace",
      workspaceView: "knowledge-base",
    },
    visual: {
      shape: "library",
      specialTownPlace: true,
    },
    onboarding: {
      variables: [
        { label: "Library folder", setting: "wikiPath", required: true },
        { label: "Library backup", setting: "wikiGitBackupEnabled", required: false },
        { label: "Remote", setting: "wikiGitRemoteUrl", required: false },
      ],
      steps: [
        { title: "Choose a Library", detail: "Select the markdown Library agents receive in their prompt." },
        { title: "Enable backup", detail: "Connect a git remote when this knowledge should travel between machines." },
      ],
    },
  },
];

export const CORE_BUILDINGS = Object.freeze(CORE_BUILDING_MANIFESTS.map((manifest) => defineBuilding(manifest)));
export const BUILDING_REGISTRY = createBuildingRegistry(CORE_BUILDINGS);
export const BUILDING_CATALOG = Object.freeze(BUILDING_REGISTRY.list());
export const AGENT_TOWN_SPECIAL_BUILDING_IDS = BUILDING_REGISTRY.specialTownIds();

export { createBuildingRegistry, defineBuilding, normalizeBuildingId };
