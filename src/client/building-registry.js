import {
  AppWindow,
  Activity,
  Banana,
  BookOpen,
  Bot,
  Boxes,
  Camera,
  CalendarClock,
  CalendarDays,
  Clapperboard,
  CloudCog,
  Database,
  Dog,
  FlaskConical,
  GitPullRequest,
  Globe,
  Handshake,
  Inbox,
  Lightbulb,
  Mail,
  MessageCircle,
  MessagesSquare,
  Notebook,
  Package,
  Plug,
  School,
  Send,
  ServerCog,
  ShoppingCart,
  Smartphone,
  Waypoints,
  Wrench,
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
    visual: {
      logoImage: "/images/buildings/github.avif",
    },
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
    agentGuide: {
      docs: [
        { label: "GitHub CLI", url: "https://cli.github.com/manual/" },
        { label: "Pull requests API", url: "https://docs.github.com/en/rest/pulls" },
        { label: "Issues API", url: "https://docs.github.com/en/rest/issues" },
        { label: "Actions checks API", url: "https://docs.github.com/en/rest/checks" },
      ],
    },
  },
  {
    id: "agent-inbox",
    name: "Agent Inbox",
    category: "Vibe Research",
    description: "Review agent sessions that are working, finished, exited, or ready for human attention.",
    icon: Inbox,
    install: {
      system: true,
    },
    status: "built in",
    source: "vibe-research",
    ui: {
      entryView: "agent-inbox",
      mode: "workspace",
      workspaceView: "agent-inbox",
    },
    visual: {
      shape: "post",
    },
    access: {
      label: "Session stream",
      detail: "Uses local Vibe Research session state, read markers, background task summaries, and subagent status. No extra credentials are required.",
    },
    agentGuide: {
      summary: "Use Agent Inbox when an agent needs to create bite-sized UI action items, wait for Agent Town predicates, or direct the human back to a specific session.",
      useCases: [
        "Guide onboarding one action at a time without overloading the human.",
        "Create an actionable Agent Inbox card that opens Agent Town or another workspace and names its target object.",
        "Request a human approval with priority and capability metadata before sensitive work continues.",
        "Publish an agent canvas image, such as the best qualitative result so far, a generated graph, or experiment output, for the terminal chat profile.",
        "Wait for Agent Town state changes such as placing the first building, clicking an agent, creating an automation, or saving a Library note.",
      ],
      commands: [
        { label: "Read Agent Town state", command: "curl -s \"$VIBE_RESEARCH_AGENT_TOWN_API/state\"", detail: "Shows layout summary, open action items, recent events, and tutorial signals." },
        { label: "Set agent canvas", command: "vr-agent-canvas --image results/chart.png --title \"Latest graph\" --caption \"Best qualitative result so far.\"", detail: "Shows a generated image in the selected agent's terminal chat canvas." },
        { label: "Create first-building action", command: "curl -s \"$VIBE_RESEARCH_AGENT_TOWN_API/action-items\" -H 'Content-Type: application/json' -d '{\"id\":\"onboarding-first-building\",\"kind\":\"setup\",\"priority\":\"normal\",\"title\":\"Place your first building\",\"detail\":\"Open Agent Town and place one cosmetic or functional building.\",\"href\":\"?view=swarm\",\"cta\":\"Open Agent Town\",\"predicate\":\"first_building_placed\",\"source\":\"onboarding\",\"target\":{\"type\":\"building\",\"id\":\"buildinghub\",\"label\":\"BuildingHub\"},\"capabilityIds\":[\"ui-guidance\"]}'", detail: "Adds a small Agent Inbox card the user can act on." },
        { label: "Create approval action", command: "curl -s \"$VIBE_RESEARCH_AGENT_TOWN_API/action-items\" -H 'Content-Type: application/json' -d '{\"kind\":\"approval\",\"priority\":\"high\",\"title\":\"Approve outbound message\",\"detail\":\"Review the draft before the agent sends it.\",\"cta\":\"Review\",\"href\":\"?view=agent-inbox\",\"capabilityIds\":[\"sends-messages\"]}'", detail: "Use before a sensitive action that should stop for human consent." },
        { label: "Wait for first building", command: "curl -s \"$VIBE_RESEARCH_AGENT_TOWN_API/wait\" -H 'Content-Type: application/json' -d '{\"predicate\":\"first_building_placed\",\"timeoutMs\":30000}'", detail: "Long-polls until the browser mirrors a placed building or the timeout expires." },
      ],
      env: [
        { name: "VIBE_RESEARCH_URL", detail: "Base URL for the local Vibe Research app. Prefer this over hard-coded ports when a guide does not provide a narrower API URL." },
        { name: "VIBE_RESEARCH_AGENT_TOWN_API", detail: "Base URL for the local Agent Town API, such as http://127.0.0.1:4826/api/agent-town." },
        { name: "VIBE_RESEARCH_AGENT_CALLBACK_URL", detail: "Per-agent webhook URL for buildings or services that need to send later notifications back to this session." },
        { name: "VIBE_RESEARCH_AGENT_CANVAS_HELP", detail: "Example command for publishing the current session's visible canvas image." },
      ],
      setup: [
        "Keep action items short: one concrete action, one CTA, and one predicate when possible.",
        "For researcher agents, keep the canvas pointed at the most significant qualitative result or graph the human should inspect next.",
        "Use approvals for messages, purchases, credentials, publishing, deletes, and other sensitive capabilities.",
        "Read the state endpoint before creating duplicate tutorial cards.",
      ],
    },
    onboarding: {
      variables: [
        { label: "Sessions", value: "local Vibe Research sessions", required: true },
        { label: "Read markers", value: "browser-local attention state", required: true },
        { label: "Notifications", value: "AgentMail, Telegram, or browser push later", required: false },
      ],
      steps: [
        { title: "Open the inbox", detail: "Use the Agent Inbox workspace to see working, unread, and exited sessions.", completeWhen: { type: "installed" } },
        { title: "Review finished work", detail: "Open unread sessions, inspect the result, and mark them read." },
        { title: "Jump back to context", detail: "Each inbox row opens the underlying terminal session." },
      ],
    },
  },
  {
    id: "tailscale",
    name: "Tailscale",
    category: "Networking",
    description: "Open Vibe Research and localhost app ports through a tailnet portal.",
    icon: Waypoints,
    install: {
      system: true,
    },
    status: "auto-detected",
    source: "vibe-research",
    visual: {
      shape: "portal",
    },
    access: {
      label: "Tailnet portal",
      detail: "Uses the local Tailscale CLI when available to show tailnet URLs and expose localhost-only ports with Tailscale Serve. Vibe Research does not store Tailscale credentials.",
    },
    agentGuide: {
      summary: "Use Tailscale when an agent needs to understand private remote access, tailnet URLs, or why a localhost app can be exposed safely through Tailscale Serve.",
      useCases: [
        "Check whether this Vibe Research instance has a tailnet URL.",
        "Diagnose why a localhost-only app is not reachable from another device.",
        "Explain to a human what Tailscale Serve setup is missing without asking for credentials unless login is required.",
      ],
      commands: [
        { label: "Check local Tailscale status", command: "tailscale status", detail: "Shows whether the machine is logged into a tailnet." },
        { label: "Check Serve config", command: "tailscale serve status", detail: "Shows active Tailscale Serve forwards." },
        { label: "List app ports", command: "curl -s http://127.0.0.1:${VIBE_RESEARCH_PORT:-4826}/api/ports -H 'X-Vibe-Research-API: 1'", detail: "Use the current app port when known; browser UI usually exposes ports directly." },
      ],
      docs: [
        { label: "Tailscale Serve docs", url: "https://tailscale.com/kb/1242/tailscale-serve" },
      ],
      env: [
        { name: "VIBE_RESEARCH_BUILDING_GUIDES_DIR", detail: "Directory containing all generated building guides." },
        { name: "VIBE_RESEARCH_BUILDING_GUIDES_INDEX", detail: "Index of generated building guides." },
      ],
    },
    onboarding: {
      variables: [
        { label: "Tailscale CLI", value: "installed and logged in on this machine", required: false },
        { label: "Tailnet URL", value: "auto-detected when Tailscale is connected", required: false },
        { label: "Serve permissions", value: "local tailscale serve access", required: false },
      ],
      steps: [
        { title: "Connect Tailscale", detail: "Sign in with the local Tailscale CLI if tailnet URLs are not appearing." },
        { title: "Use the portal", detail: "Open Vibe Research from the Tailscale URL shown in startup output or port previews." },
        { title: "Expose local apps", detail: "Use the Localhost Apps dock to publish eligible localhost-only ports with Tailscale Serve." },
      ],
    },
  },
  {
    id: "ci-repair-shop",
    name: "CI Repair Shop",
    category: "Coding",
    description: "Turn failing GitHub checks into focused repair-agent sessions with logs, repro commands, and PR updates.",
    icon: Wrench,
    install: {
      system: true,
    },
    status: "built in",
    source: "vibe-research",
    visual: {
      shape: "plugin",
    },
    access: {
      label: "GitHub + local tests",
      detail: "Uses the GitHub connector or gh authentication plus the checked-out repository's test commands. Local terminal agents still need repo and GitHub access where they run.",
    },
    onboarding: {
      variables: [
        { label: "GitHub access", value: "Codex connector or gh auth", required: true },
        { label: "Repository checkout", value: "local workspace folder", required: true },
        { label: "Repro command", value: "project test or check command", required: true },
      ],
      steps: [
        { title: "Connect GitHub", detail: "Make sure the host agent or local shell can read PR checks and logs." },
        { title: "Pick a failing check", detail: "Start from the PR check summary, job log, and branch SHA." },
        { title: "Repair locally", detail: "Have an agent reproduce the failure, patch, rerun the focused command, and prepare the PR update." },
      ],
    },
  },
  {
    id: "toolshed",
    name: "Toolshed",
    category: "Vibe Research",
    description: "Build new Agent Town buildings, prepare BuildingHub submissions, and keep the Vibe Research operating map close at hand.",
    icon: Wrench,
    install: {
      system: true,
    },
    status: "built in",
    source: "vibe-research",
    visual: {
      shape: "plugin",
    },
    access: {
      label: "Building SDK + BuildingHub",
      detail: "Uses the local building docs, core manifest registry, and optional BuildingHub catalog workflow. Community buildings stay manifest-only until reviewed.",
    },
    agentGuide: {
      summary: "Use Toolshed when an agent needs to create, review, or extend a building manifest and its generated setup guide.",
      useCases: [
        "Draft a first-party building manifest with setup, access, and agentGuide fields.",
        "Create or review a manifest-only BuildingHub entry.",
        "Find the generated building guide index that Codex and Claude Code sessions can read.",
      ],
      commands: [
        { label: "Read building docs", command: "sed -n '1,220p' docs/buildings.md", detail: "Start here before changing building contracts." },
        { label: "Read generated guide index", command: "sed -n '1,220p' \"$VIBE_RESEARCH_BUILDING_GUIDES_INDEX\"", detail: "Shows every building guide available to the current agent." },
      ],
      env: [
        { name: "VIBE_RESEARCH_BUILDING_GUIDES_DIR", detail: "Generated per-building guide directory." },
        { name: "VIBE_RESEARCH_BUILDING_GUIDES_INDEX", detail: "Generated building guide index." },
      ],
    },
    onboarding: {
      variables: [
        { label: "Building docs", value: "docs/buildings.md", required: true },
        { label: "Starter catalog", value: "BuildingHub checkout or template", required: false },
        { label: "Publish path", value: "GitHub PR to BuildingHub", required: false },
      ],
      steps: [
        { title: "Read the map", detail: "Understand buildings, Library memory, settings, prompts, automations, and communications before adding new surfaces." },
        { title: "Draft a manifest", detail: "Copy a BuildingHub template or add a first-party manifest with a stable id, setup variables, and Agent Town visual shape." },
        { title: "Validate and publish", detail: "Run the catalog validator, rebuild registry.json, and open a reviewed BuildingHub pull request when the building is community-safe." },
      ],
    },
  },
  {
    id: "doghouse",
    name: "Doghouse",
    category: "Vibe Research",
    description: "Adds a tiny doghouse to Agent Town with a dog that wanders around the map.",
    icon: Dog,
    install: {
      system: true,
    },
    status: "built in",
    source: "vibe-research",
    visual: {
      shape: "doghouse",
      specialTownPlace: true,
    },
    access: {
      label: "Agent Town companion",
      detail: "Uses only the local Agent Town canvas. No setup, network access, or credentials are required.",
    },
    onboarding: {
      variables: [
        { label: "Town canvas", value: "local Agent Town visual interface", required: true },
      ],
      steps: [
        { title: "Open Agent Town", detail: "The doghouse appears on the map automatically.", completeWhen: { type: "installed" } },
        { title: "Watch the patrol", detail: "The town dog leaves the doghouse and wanders nearby while the map is open." },
      ],
    },
    agentGuide: {
      summary: "Use Doghouse when work involves the decorative Agent Town doghouse or roaming dog animation.",
      useCases: [
        "Verify Agent Town decorative sprites render correctly.",
        "Adjust the doghouse placement or dog patrol route.",
        "Check that map hit areas still open the Doghouse building panel.",
      ],
    },
  },
  {
    id: "system",
    name: "System",
    category: "Vibe Research",
    description: "Inspect this host's storage, CPU, memory, GPU utilization, accelerators, and agent usage.",
    icon: ServerCog,
    install: {
      system: true,
    },
    status: "built in",
    source: "vibe-research",
    ui: {
      entryView: "system",
      mode: "workspace",
      workspaceView: "system",
    },
    visual: {
      shape: "plugin",
      specialTownPlace: true,
    },
    access: {
      label: "Host metrics",
      detail: "Uses the local system metrics sampler for host storage, CPU, memory, GPU, accelerator, and Vibe Research agent usage data. No extra credentials are required.",
    },
    agentGuide: {
      summary: "Use System when an agent needs to inspect host capacity, GPU availability, storage pressure, or local Vibe Research agent usage.",
      useCases: [
        "Check GPU utilization and ownership before starting heavy experiments.",
        "Review CPU, memory, storage, and accelerator inventory for the local machine.",
        "Inspect recent system metric history when diagnosing host pressure.",
      ],
      commands: [
        { label: "Read current metrics", command: "curl -s http://127.0.0.1:${VIBE_RESEARCH_PORT:-4826}/api/system -H 'X-Vibe-Research-API: 1'", detail: "Shows current storage, CPU, memory, GPU, accelerator, and agent usage metrics." },
        { label: "Read one-hour history", command: "curl -s 'http://127.0.0.1:${VIBE_RESEARCH_PORT:-4826}/api/system/history?range=1h' -H 'X-Vibe-Research-API: 1'", detail: "Shows the sampled history backing the System charts." },
      ],
      env: [
        { name: "VIBE_RESEARCH_PORT", detail: "Current Vibe Research server port when available." },
        { name: "VIBE_RESEARCH_SYSTEM_DIR", detail: "Local system workspace directory for generated guides and communication state." },
      ],
    },
    onboarding: {
      variables: [
        { label: "Metrics endpoint", value: "/api/system", required: true },
        { label: "History endpoint", value: "/api/system/history", required: true },
      ],
      steps: [
        { title: "Open System", detail: "Use the System building to inspect host storage, CPU, memory, GPU, accelerator, and agent usage metrics.", completeWhen: { type: "installed" } },
        { title: "Check GPU ownership", detail: "Review which GPU processes belong to Vibe Research sessions before scheduling heavy work." },
      ],
    },
  },
  {
    id: "wandb",
    name: "W&B",
    category: "Observability",
    description: "Track training runs, sweeps, metrics, and artifacts from research-agent experiments.",
    icon: Activity,
    status: "one-click install",
    source: "external",
    visual: {
      shape: "studio",
    },
    install: {
      enabledSetting: "wandbEnabled",
      storedFallback: false,
      plan: {
        preflight: [
          {
            kind: "command",
            // Detect wandb on PATH, or importable from system Python, or in
            // the vr-managed venv created by vr-pip-install-tool.
            command: "command -v wandb || python3 -c 'import wandb' 2>/dev/null || [ -x \"${VIBE_RESEARCH_HOME:-$HOME/.vibe-research}/bin/wandb\" ]",
            label: "Detect wandb client",
          },
        ],
        install: [
          {
            kind: "command",
            command: "bash \"$VIBE_RESEARCH_APP_DIR/bin/vr-pip-install-tool\" wandb",
            label: "Install wandb Python package",
            timeoutSec: 300,
          },
        ],
        auth: {
          kind: "auth-paste",
          setting: "wandbApiKey",
          setupUrl: "https://wandb.ai/authorize",
          setupLabel: "Get W&B API key",
          detail: "Generate an API key at wandb.ai/authorize and paste it here. The key is stored in Vibe Research settings and injected into agent processes as WANDB_API_KEY.",
        },
        verify: [
          {
            kind: "command",
            // Just confirm the wandb library is importable. The pasted API
            // key is verified at agent-runtime when wandb.init() is called;
            // matches the convention used by MCP-server buildings.
            command: "python3 -c \"import wandb; print(wandb.__version__)\"",
            label: "Verify wandb importable",
            timeoutSec: 60,
          },
        ],
      },
    },
    access: {
      label: "wandb CLI + API key",
      detail: "Requires the wandb Python package where the agent runs plus W&B credentials from wandb login or WANDB_API_KEY. Vibe Research tracks the building and guide only; API keys, run secrets, and account scope stay in the agent runtime.",
    },
    onboarding: {
      variables: [
        {
          label: "W&B API key",
          setting: "wandbApiKey",
          configuredSetting: "wandbApiKeyConfigured",
          secret: true,
          required: true,
          setupUrl: "https://wandb.ai/authorize",
        },
        {
          label: "W&B entity (user or team)",
          setting: "wandbEntity",
          required: false,
        },
      ],
      steps: [
        { title: "Place W&B in the map", detail: "Drop the building anywhere — install starts automatically." },
        { title: "Install wandb", detail: "We pip install wandb into the agent environment. If it's already there, this step is skipped.", completeWhen: { type: "installed" } },
        { title: "Paste your API key", detail: "Click \"Get W&B API key\" to open wandb.ai/authorize, copy the key, and paste it into the field. Stored in settings; never logged." },
        { title: "(Optional) Set entity", detail: "Type your W&B entity (username or team) so the project shortcut and vr-research-init seeding can find your account. Skippable." },
      ],
    },
    agentGuide: {
      summary: "Use W&B for any cycle that produces metrics-over-time (training, fine-tuning, eval sweeps). Project/group/name follow the researcher contract: project=<project-slug>, group=<move-slug>, name=cycle-N.",
      useCases: [
        "Log full training metric history for a research cycle so curves are inspectable later.",
        "Group all cycles of one move under a single W&B group for per-move comparison.",
        "Archive every move of a research project under one W&B project for cross-move review.",
        "Persist run config (hyperparams, seed, commit SHA) and artifacts (checkpoints, sample outputs, plots) alongside metrics.",
      ],
      setup: [
        "Run wandb login or set WANDB_API_KEY before the first wandb.init() call.",
        "Set WANDB_ENTITY in the environment so vr-research-init seeds the W&B project at creation time and the project shortcut links to a real page.",
        "Always pass project=<project-slug>, group=<move-slug>, name=cycle-N to wandb.init so leaderboard discipline and W&B grouping stay aligned.",
        "Pin the run URL with vr-agent-canvas --url after wandb.init returns so the human sees a live monitor without opening the result doc.",
      ],
      commands: [
        { label: "Check wandb CLI", command: "command -v wandb && wandb --help", detail: "Confirms wandb is installed in the agent environment." },
        { label: "Check auth", command: "python3 -c \"import wandb; print(wandb.Api().viewer.username)\"", detail: "Prints the authenticated W&B username; non-zero exit means creds are missing." },
        { label: "Init a run", command: "python3 -c \"import wandb; r=wandb.init(project='<slug>', group='<move>', name='cycle-1', config={'seed':0}); wandb.finish()\"", detail: "Smoke-test that wandb.init works with the contract's project/group/name shape." },
        { label: "List recent runs", command: "python3 -c \"import wandb; api=wandb.Api(); [print(r.url) for r in api.runs(f'{api.viewer.username}/<slug>', per_page=5)]\"", detail: "Read-only check of the project's recent run URLs." },
      ],
      env: [
        { name: "WANDB_API_KEY", detail: "W&B API key for non-interactive authentication; keep secret.", required: false },
        { name: "WANDB_ENTITY", detail: "Default W&B entity (user or team) used for project seeding and the UI shortcut.", required: false },
        { name: "WANDB_PROJECT", detail: "Override default project; usually unnecessary because the contract derives it from the project slug.", required: false },
        { name: "WANDB_MODE", detail: "Set to 'offline' to log without network; 'disabled' to skip W&B entirely.", required: false },
      ],
      docs: [
        { label: "W&B docs", url: "https://docs.wandb.ai/" },
        { label: "Quickstart", url: "https://docs.wandb.ai/quickstart" },
        { label: "wandb.init API", url: "https://docs.wandb.ai/ref/python/init" },
        { label: "Groups & organizing runs", url: "https://docs.wandb.ai/guides/runs/grouping" },
        { label: "Public API (read runs)", url: "https://docs.wandb.ai/ref/python/public-api/api" },
      ],
    },
  },
  {
    id: "modal",
    name: "Modal",
    category: "Cloud Compute",
    description: "Run serverless Python apps, batch jobs, sandboxes, and GPU-backed workloads on Modal.",
    icon: CloudCog,
    status: "one-click install",
    source: "external",
    visual: {
      shape: "lab",
      logoImage: "/images/buildings/modal.jpg",
    },
    install: {
      enabledSetting: "modalEnabled",
      storedFallback: false,
      plan: {
        preflight: [
          {
            kind: "command",
            // Detect Modal whether it's on the user's PATH (pip --user install,
            // pipx, system package) OR in the vr-managed venv created by
            // vr-pip-install-tool (~/.vibe-research/bin/modal).
            command: "command -v modal || [ -x \"${VIBE_RESEARCH_HOME:-$HOME/.vibe-research}/bin/modal\" ]",
            label: "Detect Modal CLI",
          },
        ],
        install: [
          {
            kind: "command",
            // vr-pip-install-tool tries pipx → managed venv → --break-system-packages
            // in order. Plain `pip install --user` blew up on PEP 668 hosts
            // (Ubuntu 24.04+ / Debian 12+ / Fedora 40+) with
            // "error: externally-managed-environment", which is the
            // failure mode we hit on cthulhu1. The script picks the right
            // strategy automatically and prints which one it used so the
            // install log is debuggable.
            command: "bash \"$VIBE_RESEARCH_APP_DIR/bin/vr-pip-install-tool\" modal",
            label: "Install Modal Python package",
            timeoutSec: 300,
          },
        ],
        auth: {
          kind: "auth-browser-cli",
          command: "modal token new --source web",
          detail: "Opens a browser tab; sign in to Modal and approve the token.",
          timeoutSec: 600,
        },
        verify: [
          { kind: "command", command: "modal token info", label: "Verify Modal token" },
        ],
      },
    },
    access: {
      label: "Modal CLI + account token",
      detail: "Requires the modal Python package/CLI where the agent runs plus Modal account credentials from modal setup, modal token set, or MODAL_TOKEN_ID and MODAL_TOKEN_SECRET. Vibe Research tracks the building and guide only; tokens, secrets, deploy approvals, and cloud costs stay in the agent runtime and human workflow.",
    },
    onboarding: {
      variables: [
        { label: "Modal CLI", value: "python package and modal command on PATH", required: true },
        { label: "Modal credentials", value: "modal setup, modal token set, or MODAL_TOKEN_ID / MODAL_TOKEN_SECRET", required: true },
        { label: "Profile / environment", value: "MODAL_PROFILE or MODAL_ENVIRONMENT when the workspace uses multiple scopes", required: false },
        { label: "Cost approval", value: "explicit human approval before GPUs, long jobs, deploys, or persistent apps", required: true },
      ],
      steps: [
        { title: "Install Modal", detail: "Install the Modal Python package in the agent environment and confirm modal --help works." },
        { title: "Authenticate", detail: "Use modal setup for interactive login or modal token set for token-based setup." },
        { title: "Check scope", detail: "Confirm the active profile and environment before listing, running, serving, or deploying apps." },
        { title: "Install the building", detail: "Add Modal to Agent Town once the CLI and credentials are ready for agents.", completeWhen: { type: "installed" } },
      ],
    },
    agentGuide: {
      summary: "Use Modal when an agent needs scalable Python compute, serverless jobs, GPU functions, web endpoints, or cloud sandboxes backed by a Modal account.",
      useCases: [
        "Run a small Modal function or local entrypoint to validate cloud compute setup.",
        "Serve or deploy a web endpoint after the human approves cloud use and naming.",
        "Inspect running or deployed Modal apps, logs, history, and active profile.",
        "Use Modal as a sandbox or GPU runtime for experiments that cannot fit on the local machine.",
      ],
      setup: [
        "Read this guide and run modal token info before assuming the current agent has account access.",
        "Prefer read-only checks such as modal app list and modal token info before running workloads.",
        "Ask for human approval before using GPUs, long-running jobs, deploys, persistent web endpoints, or commands that can spend money.",
        "Keep Modal token IDs, token secrets, secret values, app-specific credentials, and private logs out of the Library, result docs, screenshots, and generated guides.",
        "Record app file, app name, Modal environment/profile, command, output path, and code commit when a result depends on Modal.",
      ],
      commands: [
        { label: "Check Modal CLI", command: "command -v modal && modal --help", detail: "Confirms the Modal CLI is installed in the current agent environment." },
        { label: "Check active token", command: "modal token info", detail: "Shows whether Modal credentials are configured without printing token secrets." },
        { label: "List apps", command: "modal app list", detail: "Read-only smoke check for account access and active environment." },
        { label: "Run an app", command: "modal run <path/to/app.py>", detail: "Runs a Modal function or local entrypoint; get approval first for costly resources." },
        { label: "Serve an app", command: "modal serve <path/to/app.py>", detail: "Hot-reloads web endpoints while developing; note that dev URLs are externally reachable." },
        { label: "Deploy an app", command: "modal deploy <path/to/app.py> --name <app-name>", detail: "Creates or updates a persistent deployment; requires explicit approval." },
        { label: "Stream logs", command: "modal app logs <app-name-or-id> --timestamps", detail: "Inspect runtime failures without exposing secrets in copied logs." },
      ],
      env: [
        { name: "MODAL_TOKEN_ID", detail: "Modal token ID for non-interactive authentication; keep secret-adjacent and never print with the token secret.", required: false },
        { name: "MODAL_TOKEN_SECRET", detail: "Modal token secret for non-interactive authentication; keep secret.", required: false },
        { name: "MODAL_PROFILE", detail: "Optional Modal credentials profile to select.", required: false },
        { name: "MODAL_ENVIRONMENT", detail: "Optional Modal environment when the workspace has multiple environments.", required: false },
      ],
      docs: [
        { label: "Modal docs", url: "https://modal.com/docs" },
        { label: "User account setup", url: "https://modal.com/docs/guide/modal-user-account-setup" },
        { label: "Token CLI", url: "https://modal.com/docs/reference/cli/token" },
        { label: "Run CLI", url: "https://modal.com/docs/reference/cli/run" },
        { label: "Serve CLI", url: "https://modal.com/docs/reference/cli/serve" },
        { label: "Deploy CLI", url: "https://modal.com/docs/reference/cli/deploy" },
        { label: "Managing deployments", url: "https://modal.com/docs/guide/managing-deployments" },
      ],
    },
  },
  {
    id: "runpod",
    name: "RunPod",
    category: "Cloud Compute",
    description: "Manage GPU Pods and Serverless endpoints for AI workloads through RunPod.",
    icon: Boxes,
    status: "CLI/API setup required",
    source: "external",
    visual: {
      shape: "lab",
    },
    access: {
      label: "RunPod API key + runpodctl or SDK",
      detail: "Requires a RunPod API key in the agent runtime or configured with runpodctl, plus endpoint, pod, template, network volume, and spend scopes chosen by the human. Vibe Research only tracks the building and generated guide; API keys, pod SSH keys, endpoint secrets, and cloud costs stay outside the browser catalog.",
    },
    onboarding: {
      variables: [
        { label: "RunPod API key", value: "RUNPOD_API_KEY or runpodctl config --apiKey", required: true },
        { label: "RunPod CLI", value: "runpodctl on PATH for Pods, Serverless, templates, and file transfer", required: false },
        { label: "Serverless SDK", value: "Python, JavaScript, or Go SDK when code calls endpoints programmatically", required: false },
        { label: "Endpoint / Pod scope", value: "endpoint IDs, pod IDs, templates, GPU types, network volumes, and region constraints", required: true },
        { label: "Cost approval", value: "explicit human approval before creating Pods, endpoints, GPUs, or persistent workers", required: true },
      ],
      steps: [
        { title: "Create scoped API access", detail: "Use a restricted RunPod API key with only the permissions this project needs." },
        { title: "Install helpers", detail: "Install runpodctl or the relevant RunPod SDK in the agent environment." },
        { title: "Verify read access", detail: "Run a read-only list command before creating Pods or Serverless endpoints." },
        { title: "Install the building", detail: "Add RunPod to Agent Town once API access and spend rules are ready.", completeWhen: { type: "installed" } },
      ],
    },
    agentGuide: {
      summary: "Use RunPod when an agent needs on-demand GPUs, long-lived Pods, Serverless AI endpoints, templates, or remote file transfer for compute-heavy work.",
      useCases: [
        "List GPU availability, templates, Pods, or Serverless endpoints before choosing a remote runtime.",
        "Submit requests to an existing Serverless endpoint using a scoped API key and endpoint ID.",
        "Create or manage GPU Pods only after human approval for cost, data, SSH, and shutdown policy.",
        "Package a worker image or template for AI inference, training, ComfyUI, or batch processing.",
      ],
      setup: [
        "Start with read-only commands such as runpodctl version, runpodctl gpu list, runpodctl pod list, and runpodctl serverless list.",
        "Use restricted RunPod API keys and endpoint-specific permissions where possible.",
        "Ask for human approval before creating, updating, or deleting Pods, Serverless endpoints, templates, network volumes, workers, or GPU allocations.",
        "Do not print or store RunPod API keys, pod SSH keys, endpoint environment variables, container secrets, or private logs in the Library or screenshots.",
        "Record endpoint ID or pod ID, GPU type, template or image, command, artifact paths, output logs, and code commit when a result depends on RunPod.",
      ],
      commands: [
        { label: "Check runpodctl", command: "command -v runpodctl && runpodctl version", detail: "Confirms the RunPod CLI is installed in the current agent environment." },
        { label: "Read runpodctl help", command: "runpodctl help", detail: "Shows the CLI command tree before using account resources." },
        { label: "List GPUs", command: "runpodctl gpu list", detail: "Read-only availability check for GPU choices." },
        { label: "List Pods", command: "runpodctl pod list", detail: "Read-only account smoke check after API key configuration." },
        { label: "List Serverless endpoints", command: "runpodctl serverless list", detail: "Read-only check for endpoint access; sls is also accepted by runpodctl." },
        { label: "Check Python SDK", command: "python -c \"import runpod; print(runpod.__version__)\"", detail: "Confirms the Python SDK is importable where endpoint client code will run." },
        { label: "Check endpoint health", command: "curl -s -H \"Authorization: Bearer $RUNPOD_API_KEY\" \"https://api.runpod.ai/v2/$RUNPOD_ENDPOINT_ID/health\"", detail: "Validates a known Serverless endpoint without submitting a job." },
      ],
      env: [
        { name: "RUNPOD_API_KEY", detail: "RunPod API key for SDK or HTTP access; keep secret and use restricted permissions.", required: false },
        { name: "RUNPOD_ENDPOINT_ID", detail: "Serverless endpoint ID for endpoint health checks and requests.", required: false },
        { name: "RUNPOD_POD_ID", detail: "Pod ID when a task targets a long-lived Pod.", required: false },
        { name: "RUNPOD_NETWORK_VOLUME_ID", detail: "Optional network volume ID for shared model/data storage.", required: false },
      ],
      docs: [
        { label: "RunPod docs", url: "https://docs.runpod.io/" },
        { label: "RunPod CLI overview", url: "https://docs.runpod.io/runpodctl/overview" },
        { label: "Install runpodctl", url: "https://docs.runpod.io/runpodctl/install-runpodctl" },
        { label: "Serverless overview", url: "https://docs.runpod.io/serverless/overview" },
        { label: "Serverless CLI", url: "https://docs.runpod.io/runpodctl/reference/runpodctl-serverless" },
        { label: "Python SDK", url: "https://docs.runpod.io/sdks/python/overview" },
        { label: "API keys", url: "https://docs.runpod.io/get-started/api-keys" },
      ],
    },
  },
  {
    id: "harbor",
    name: "Harbor",
    category: "Evals",
    description: "Evaluate agents and models in sandboxed Harbor tasks, datasets, and jobs.",
    icon: FlaskConical,
    status: "CLI install required",
    source: "external",
    visual: {
      shape: "lab",
    },
    access: {
      label: "Harbor CLI + sandbox runtime",
      detail: "Requires the harbor CLI where the agent runs, plus Docker or a configured cloud sandbox provider. Model and sandbox provider API credentials must live in the agent runtime; Vibe Research only tracks the building and generated guide.",
    },
    onboarding: {
      variables: [
        { label: "Harbor CLI", value: "harbor on PATH, usually from uv tool install harbor", required: true },
        { label: "Sandbox runtime", value: "Docker locally, or Daytona, Modal, E2B, or Runloop for cloud runs", required: true },
        { label: "Model credentials", value: "OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or provider-specific env", required: true },
        { label: "Dataset or task", value: "Harbor registry dataset, local task directory, local dataset path, or job config", required: true },
      ],
      steps: [
        { title: "Install Harbor", detail: "Install the CLI in the agent environment and confirm harbor --help works." },
        { title: "Choose the eval", detail: "Pick a registry dataset, local task path, local dataset, or job config before starting a run." },
        { title: "Confirm runtime", detail: "Verify Docker or the selected cloud sandbox credentials are available." },
        { title: "Install the building", detail: "Add the Harbor lab once agents should consider Harbor evals for this project.", completeWhen: { type: "installed" } },
      ],
    },
    agentGuide: {
      summary: "Use Harbor when an agent needs to evaluate or optimize agents/models in sandboxed task environments, especially when the answer should be backed by reproducible trials instead of an ad hoc local run.",
      useCases: [
        "Run a registered benchmark dataset against a named agent and model.",
        "Run a local Harbor task or dataset to test an agent in a containerized sandbox.",
        "Compare CLI agents such as Codex, Claude Code, OpenHands, or a custom Harbor agent import.",
        "Generate rollouts, trajectories, or rewards for eval, prompt optimization, SFT, or RL workflows.",
        "Create reproducible evidence for an agent-evaluation result before admitting it into project memory.",
        "Scale an eval across cloud sandboxes after checking quota, credentials, and cost approval.",
      ],
      setup: [
        "Read the Harbor docs for the task shape before creating or adapting datasets.",
        "Run command -v harbor and harbor --help before assuming the CLI is installed.",
        "Use Harbor only when sandboxed agent evaluation is warranted; keep quick local checks outside Harbor.",
        "Record dataset or task version, agent, model, sandbox provider, command, output directory, and commit in result docs.",
        "Ask before running expensive cloud sandboxes or broad benchmark sweeps.",
        "Do not print or store model keys, sandbox provider keys, or private task data in the Library or generated guides.",
      ],
      commands: [
        { label: "Check Harbor CLI", command: "command -v harbor && harbor --help", detail: "Confirms the CLI is installed in the current agent environment." },
        { label: "List datasets", command: "harbor dataset list || harbor datasets list", detail: "Shows registry datasets; Harbor CLI versions may expose singular or plural dataset commands." },
        { label: "Run registered dataset", command: "harbor run -d \"<org/name>\" -m \"<model>\" -a \"<agent>\"", detail: "Runs a registry-backed eval for the chosen model and agent." },
        { label: "Run local dataset", command: "harbor run -p \"<path/to/dataset>\" -m \"<model>\" -a \"<agent>\"", detail: "Runs a local Harbor task or dataset directory." },
        { label: "Run job config", command: "harbor run -c \"<path/to/job.yaml>\"", detail: "Runs a multi-trial Harbor job configuration." },
        { label: "Run cloud sandbox", command: "harbor run -d \"<org/name>\" -m \"<model>\" -a \"<agent>\" --env \"daytona\" -n 32", detail: "Example horizontal cloud run; verify provider credentials, quota, and cost approval first." },
        { label: "Run custom agent", command: "harbor run -d \"<dataset@version>\" --agent-import-path path.to.agent:SomeAgent", detail: "Uses Harbor's custom agent import hook without modifying Harbor source." },
      ],
      env: [
        { name: "OPENAI_API_KEY", detail: "Model provider key for OpenAI-backed Harbor runs; keep secret.", required: false },
        { name: "ANTHROPIC_API_KEY", detail: "Model provider key for Anthropic-backed Harbor runs; keep secret.", required: false },
        { name: "GEMINI_API_KEY", detail: "Model provider key for Gemini-backed Harbor runs; keep secret.", required: false },
        { name: "DAYTONA_API_KEY", detail: "Cloud sandbox provider key when using Daytona environments; keep secret.", required: false },
        { name: "MODAL_TOKEN_ID / MODAL_TOKEN_SECRET", detail: "Cloud sandbox credentials when using Modal environments; keep secret.", required: false },
      ],
      docs: [
        { label: "Harbor docs", url: "https://www.harborframework.com/docs" },
        { label: "Getting started", url: "https://www.harborframework.com/docs/getting-started" },
        { label: "Agents", url: "https://www.harborframework.com/docs/agents" },
        { label: "Tasks", url: "https://www.harborframework.com/docs/tasks" },
        { label: "Registry", url: "https://registry.harborframework.com/" },
        { label: "Trajectory format", url: "https://www.harborframework.com/docs/trajectory-format" },
      ],
    },
  },
  {
    id: "occupations",
    name: "Prompts",
    category: "Vibe Research",
    description: "Edit the school of system prompt roles that shape new agents before they start work.",
    icon: School,
    install: {
      system: true,
    },
    status: "built in",
    source: "vibe-research",
    ui: {
      entryView: "occupations",
      mode: "workspace",
      workspaceView: "agent-prompt",
    },
    visual: {
      shape: "school",
      specialTownPlace: true,
    },
    access: {
      label: "Managed prompts",
      detail: "Uses the local Prompts store and syncs managed instructions into AGENTS.md and CLAUDE.md so Codex and Claude Code sessions receive the same role guidance.",
    },
    agentGuide: {
      summary: "Use Prompts when an agent needs to inspect or explain the shared role prompt that will be injected into new sessions.",
      useCases: [
        "Check which prompt is selected before starting a new agent.",
        "Inspect the managed prompt source and synced AGENTS.md and CLAUDE.md files.",
        "Diagnose prompt sync conflicts without writing secrets or credentials into managed instruction files.",
      ],
      commands: [
        { label: "Read current prompt", command: "curl -s http://127.0.0.1:${VIBE_RESEARCH_PORT:-4826}/api/agent-prompt -H 'X-Vibe-Research-API: 1'", detail: "Shows the selected prompt, source path, and managed target files." },
        { label: "Open prompt source", command: "sed -n '1,220p' \"$VIBE_RESEARCH_AGENT_PROMPT_PATH\"", detail: "Read the active prompt file from the agent environment when available." },
      ],
      env: [
        { name: "VIBE_RESEARCH_AGENT_PROMPT_PATH", detail: "Path to the active prompt file for this session." },
      ],
    },
    onboarding: {
      variables: [
        { label: "Selected prompt", value: "Researcher, Engineer, or Custom", required: true },
        { label: "Prompt source", value: ".vibe-research/agent-prompt.md", required: true },
        { label: "Managed files", value: "AGENTS.md, CLAUDE.md", required: true },
      ],
      steps: [
        { title: "Choose a prompt", detail: "Pick the role prompt that should shape newly launched agents.", completeWhen: { type: "installed" } },
        { title: "Edit custom guidance", detail: "Use the custom prompt when the built-in researcher or engineer prompt needs project-specific instructions." },
        { title: "Review managed files", detail: "Check conflicts before overwriting AGENTS.md or CLAUDE.md." },
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
    status: "ready",
    source: "google",
    access: {
      label: "Google access",
      detail: "Drive access is enabled for this town. Keep the shared folders narrow so agents see only the files they need.",
    },
    agentGuide: {
      summary: "Use Google Drive when an agent needs to search files, inspect file metadata, or pull the text of a Google Doc, Sheet, or Slide for the connected Google account.",
      useCases: [
        "Find the most recently modified files matching a topic before reading or summarizing them.",
        "Look up a single file's metadata (title, owner, mimeType, modifiedTime) before fetching contents.",
        "Export a Google Doc, Sheet, or Slide as plain text or CSV when the agent needs to read it.",
      ],
      commands: [
        {
          label: "Search files",
          command: "curl -s \"$VIBE_RESEARCH_URL/api/google/drive/files?q=name+contains+'project'+and+trashed=false&pageSize=10\"",
          detail: "Returns Drive file metadata matching the q filter (Drive search syntax).",
        },
        {
          label: "Get file metadata",
          command: "curl -s \"$VIBE_RESEARCH_URL/api/google/drive/files/<fileId>\"",
          detail: "Returns title, owners, mimeType, modifiedTime, and webViewLink for a single file.",
        },
        {
          label: "Export Doc as text",
          command: "curl -s \"$VIBE_RESEARCH_URL/api/google/drive/files/<fileId>/export?mimeType=text/plain\"",
          detail: "Streams the plain-text export of a Google Doc; use text/csv for Sheets, application/pdf for Slides.",
        },
      ],
      docs: [
        { label: "Google Drive API files.list", url: "https://developers.google.com/drive/api/v3/reference/files/list" },
        { label: "Drive search query syntax", url: "https://developers.google.com/drive/api/guides/search-files" },
        { label: "Google Drive API files.export", url: "https://developers.google.com/drive/api/v3/reference/files/export" },
      ],
      env: [
        { name: "VIBE_RESEARCH_URL", detail: "Base URL for the current Vibe Research instance." },
      ],
      setup: [
        "Confirm Google Drive access from the building detail before sending API requests.",
        "Prefer searching for files before exporting bulk text — keep agent context windows tight.",
      ],
    },
    onboarding: {
      variables: [
        { label: "Google account", value: "Drive access enabled", required: true },
        { label: "Shared drive scope", value: "docs/sheets/slides access", required: false },
      ],
      steps: [
        {
          title: "Enable Drive access",
          detail: "Sign in with Google and allow Drive access for the account agents should use.",
          setupUrl: "https://drive.google.com/",
          setupLabel: "Enable Drive access",
          completeWhen: { buildingAccessConfirmed: true },
        },
        { title: "Name the source", detail: "Tell agents which folders, docs, or sheets are relevant." },
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
    status: "ready",
    source: "google",
    access: {
      label: "Google access",
      detail: "Calendar access is enabled for this town. Keep the calendar scope narrow enough for agents to reason about safely.",
    },
    agentGuide: {
      summary: "Use Google Calendar when an agent needs to inspect events, check availability, or create a calendar event for the connected Google account.",
      useCases: [
        "List upcoming events on the primary calendar before proposing a meeting time.",
        "Check free/busy coverage across one or more calendars before scheduling.",
        "Create a simple calendar event after the human confirms the title and time.",
      ],
      commands: [
        {
          label: "List events",
          command: "curl -s \"$VIBE_RESEARCH_URL/api/google/calendar/events?calendarId=primary&timeMin=2026-04-23T00:00:00Z&timeMax=2026-04-24T00:00:00Z\"",
          detail: "Returns events from the connected calendar within the requested time range.",
        },
        {
          label: "Check free busy",
          command: "curl -s \"$VIBE_RESEARCH_URL/api/google/calendar/freebusy\" -H 'Content-Type: application/json' -d '{\"timeMin\":\"2026-04-23T00:00:00Z\",\"timeMax\":\"2026-04-24T00:00:00Z\",\"calendars\":[\"primary\"]}'",
          detail: "Checks availability windows without creating anything.",
        },
        {
          label: "Create event",
          command: "curl -s \"$VIBE_RESEARCH_URL/api/google/calendar/events\" -H 'Content-Type: application/json' -d '{\"calendarId\":\"primary\",\"event\":{\"summary\":\"First day on Vibe Research\",\"start\":{\"dateTime\":\"2026-04-23T17:00:00Z\"},\"end\":{\"dateTime\":\"2026-04-23T17:30:00Z\"}}}'",
          detail: "Creates a calendar event on the selected calendar.",
        },
      ],
      docs: [
        { label: "Google Calendar API events", url: "https://developers.google.com/workspace/calendar/api/v3/reference/events" },
        { label: "Google Calendar API freeBusy", url: "https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query" },
      ],
      env: [
        { name: "VIBE_RESEARCH_URL", detail: "Base URL for the current Vibe Research instance." },
      ],
      setup: [
        "Confirm Google Calendar access from the building detail before sending API requests.",
        "Prefer checking events or free/busy before creating a new meeting.",
      ],
    },
    onboarding: {
      variables: [
        { label: "Google account", value: "Calendar access enabled", required: true },
        { label: "Calendar scope", value: "event and availability access", required: true },
      ],
      steps: [
        {
          title: "Enable Calendar access",
          detail: "Sign in with Google and allow Calendar access for the account agents should use.",
          setupUrl: "https://calendar.google.com/",
          setupLabel: "Enable Calendar access",
          completeWhen: { buildingAccessConfirmed: true },
        },
        { title: "Pick calendars", detail: "Keep the account scope narrow enough for agents to reason about." },
      ],
    },
  },
  {
    id: "gmail",
    name: "Gmail",
    category: "Communications",
    description: "Search inbox threads and read message context from connected agent tooling.",
    icon: Mail,
    install: {
      system: true,
    },
    status: "ready",
    source: "google",
    access: {
      label: "Google access",
      detail: "Gmail access is enabled for this town. Keep mailbox scope narrow enough for agents to reason safely.",
    },
    onboarding: {
      variables: [
        { label: "Google account", value: "Gmail access enabled", required: true },
        { label: "Mailbox scope", value: "message read access", required: true },
      ],
      steps: [
        {
          title: "Enable Gmail access",
          detail: "Sign in with Google and allow Gmail access for the account agents should use.",
          setupUrl: "https://mail.google.com/",
          setupLabel: "Enable Gmail access",
          completeWhen: { buildingAccessConfirmed: true },
        },
        { title: "Pick labels", detail: "Keep mailbox labels and categories narrow enough for agents to reason about." },
      ],
    },
    agentGuide: {
      docs: [
        { label: "Gmail API", url: "https://developers.google.com/gmail/api/guides" },
        { label: "Messages reference", url: "https://developers.google.com/gmail/api/reference/rest/v1/users.messages" },
        { label: "Gmail web", url: "https://mail.google.com/" },
      ],
    },
  },
  {
    id: "buildinghub",
    name: "BuildingHub",
    category: "Community",
    description: "Load manifest-only community buildings and manage Agent Town skins, themes, and catalog lots.",
    icon: Wrench,
    install: {
      system: true,
    },
    status: "catalog ready",
    source: "vibe-research",
    ui: {
      entryView: "building-catalog",
      mode: "workspace",
      workspaceView: "plugins",
    },
    visual: {
      shape: "plugin",
    },
    access: {
      label: "Manifest catalog",
      detail: "BuildingHub catalogs contribute setup guides and visual buildings only. They do not run executable code inside Vibe Research. Town skins and themes are browser-local Agent Town preferences.",
    },
    onboarding: {
      variables: [
        { label: "BuilderHub login", setting: "buildingHubAuthProvider", required: true },
        { label: "BuilderHub profile", setting: "buildingHubProfileUrl", required: false },
        { label: "Local catalog", setting: "buildingHubCatalogPath", required: false },
        { label: "Remote catalog", setting: "buildingHubCatalogUrl", required: false },
        { label: "Theme catalog", value: "default, snowy, desert", required: false },
        { label: "Theme persistence", value: "browser local storage", required: false },
      ],
      steps: [
        {
          title: "Log in to BuilderHub",
          detail: "Open the BuildingHub building and click Log in with GitHub.",
          setupLabel: "Open login",
          completeWhen: { buildingAccessConfirmed: true },
        },
        { title: "Pick a town theme", detail: "Choose the Agent Town skin from BuildingHub.", completeWhen: { type: "installed" } },
        { title: "Enable community catalogs", detail: "Turn on reviewed community catalog loading only when you want shared manifest-only buildings." },
        {
          title: "Choose a source",
          detail: "Point Vibe Research at a local BuildingHub checkout or a reviewed registry JSON URL.",
        },
        { title: "Review manifests", detail: "Install community buildings after checking their setup notes and required capabilities." },
      ],
    },
    agentGuide: {
      summary: "Use BuildingHub for the building catalog, manifest-only community entries, and browser-local Agent Town skins and themes.",
      useCases: [
        "Open the system building catalog and inspect available building manifests.",
        "Check which built-in Agent Town themes are available.",
        "Modify theme palettes for the visual game canvas.",
        "Verify the selected theme persists in browser-local preferences.",
      ],
      setup: [
        "Use the BuildingHub catalog view for buildings and the BuildingHub town builder theme tab for skins.",
        "Keep theme data client-side unless a future task explicitly asks for shared settings.",
        "Keep community BuildingHub entries manifest-only unless reviewed into first-party code.",
      ],
    },
  },
  {
    id: "scaffold-recipes",
    name: "Scaffold Recipes",
    category: "Vibe Research",
    description: "Export, import, and share complete Vibe Research setups: buildings, layout, portable settings, communication policy, sandbox assumptions, Library bindings, and occupation metadata.",
    icon: Notebook,
    install: {
      system: true,
    },
    status: "built in",
    source: "vibe-research",
    visual: {
      shape: "library",
    },
    ui: {
      entryView: "scaffold-recipes",
    },
    access: {
      label: "Local setup snapshot",
      detail: "Recipes include portable settings and local binding placeholders. Secrets, personal values, and machine paths are recorded as required bindings, not exported as values.",
    },
    agentGuide: {
      summary: "Use Scaffold Recipes when an agent needs to snapshot a working Vibe Research setup, preview someone else's setup before applying it, or publish a reusable setup to BuildingHub.",
      useCases: [
        "Capture the current occupation, building set, communication policy, and Agent Town layout before a meta-experiment.",
        "Preview a shared setup and identify missing buildings or local bindings before changing settings.",
        "Apply a recipe with explicit local bindings supplied by the human or local environment.",
        "Publish a portable setup to BuildingHub after verifying secrets and personal values are redacted.",
      ],
      commands: [
        { label: "Export current recipe", command: "vr-scaffold-recipe export --pretty", detail: "Prints the current setup without secret, personal, or local path values." },
        { label: "List saved recipes", command: "vr-scaffold-recipe list", detail: "Shows recipes saved in this Vibe Research state directory." },
        { label: "Preview a recipe", command: "vr-scaffold-recipe preview recipe.json --pretty", detail: "Reports settings changes, missing buildings, layout summary, and local bindings required." },
        { label: "Apply with binding", command: "vr-scaffold-recipe apply recipe.json --binding workspaceRootPath=$PWD", detail: "Applies portable settings and only the local bindings explicitly supplied." },
        { label: "Read recipe API", command: "curl -s \"$VIBE_RESEARCH_SCAFFOLD_RECIPES_API/current\"", detail: "Raw API endpoint used by the helper command." },
      ],
      env: [
        { name: "VIBE_RESEARCH_SCAFFOLD_RECIPES_API", detail: "Base URL for scaffold recipe export, preview, apply, and publish endpoints." },
        { name: "VIBE_RESEARCH_SCAFFOLD_RECIPE_COMMAND", detail: "Canonical helper command for local agents." },
        { name: "VIBE_RESEARCH_BUILDING_GUIDES_INDEX", detail: "Generated building guide index; read before using or setting up buildings." },
      ],
      setup: [
        "Preview before applying a recipe; do not silently overwrite local setup values.",
        "Treat localBindingsRequired as a checklist of values to source from the local machine or the human.",
        "Never paste secrets into result docs, Library notes, logs, screenshots, or published recipes.",
        "Use BuildingHub publishing only after confirming redactions are present for configured secrets, personal values, and local paths.",
      ],
    },
    onboarding: {
      variables: [
        { label: "Saved recipes", value: "$VIBE_RESEARCH_ROOT/scaffold-recipes.json", required: false },
        { label: "Current setup API", value: "$VIBE_RESEARCH_SCAFFOLD_RECIPES_API/current", required: true },
        { label: "BuildingHub checkout", setting: "buildingHubCatalogPath", required: false },
      ],
      steps: [
        { title: "Export current setup", detail: "Create a portable scaffold recipe from the current Vibe Research state.", completeWhen: { type: "installed" } },
        { title: "Preview before applying", detail: "Inspect missing buildings and required local bindings before mutating settings or layout." },
        { title: "Share deliberately", detail: "Publish only redacted recipes to BuildingHub after verifying the generated JSON." },
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
    agentGuide: {
      summary: "Use Browser Use when a coding agent needs a separate browser-fulfillment worker for long or delegated web tasks.",
      useCases: [
        "Start a browser worker from an existing agent session.",
        "Hand off a web task that needs OttoAuth browser state or an Anthropic-backed worker.",
        "Check missing setup before asking the human for an API key or profile path.",
      ],
      commands: [
        { label: "Run a browser-use task", command: "vr-browser-use --task \"Describe the task here\" --wait", detail: "Starts the configured worker and waits for completion." },
        { label: "Check generated guide", command: "sed -n '1,220p' \"$VIBE_RESEARCH_BUILDING_GUIDES_DIR/browser-use.md\"", detail: "Read the local setup checklist first." },
      ],
      env: [
        { name: "VIBE_RESEARCH_BROWSER_USE_COMMAND", detail: "Canonical helper command for local agents." },
        { name: "VIBE_RESEARCH_BUILDING_GUIDES_DIR", detail: "Generated per-building guide directory." },
      ],
      docs: [
        { label: "Anthropic Console keys", url: "https://console.anthropic.com/settings/keys" },
        { label: "browser-use repo", url: "https://github.com/browser-use/browser-use" },
        { label: "OttoAuth dashboard", url: "https://ottoauth.vercel.app/dashboard" },
      ],
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
          setupUrl: "https://console.anthropic.com/settings/keys",
          setupLabel: "Get API key",
          setupHint: "Create an Anthropic key, then paste it here.",
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
      plan: {
        // Preflight = "do we already have credentials?" If both username + key
        // are saved, the install is a no-op. (true exits 0 unconditionally;
        // the real check belongs in the http step's idempotency guard, which
        // OttoAuth's create endpoint enforces server-side.)
        preflight: [
          { kind: "command", command: "true", label: "OttoAuth: noop preflight" },
        ],
        install: [
          {
            kind: "http",
            method: "POST",
            url: "https://ottoauth.vercel.app/api/agents/create",
            body: {},
            headers: { "content-type": "application/json" },
            label: "Register a new OttoAuth agent identity",
            captureSettings: {
              username: "ottoAuthUsername",
              privateKey: "ottoAuthPrivateKey",
              callbackUrl: "ottoAuthCallbackUrl",
            },
          },
        ],
        // Pairing is a human action: they enter the pairingKey at the
        // dashboard. We surface that as a paste-style auth step so the
        // install panel shows the dashboard link + the pairingKey to
        // copy. Verify is left empty for v1; the Library should record
        // the pairing as a human task.
        auth: {
          kind: "auth-paste",
          setting: "ottoAuthPairingConfirmed",
          setupUrl: "https://ottoauth.vercel.app/dashboard",
          setupLabel: "Open OttoAuth dashboard",
          detail: "Sign into OttoAuth and enter the pairing code from the install log.",
        },
        verify: [],
      },
    },
    status: "one-click install",
    source: "vibe-research",
    visual: {
      shape: "market",
      specialTownPlace: true,
    },
    agentGuide: {
      summary: "Use OttoAuth when an agent needs human-linked checkout or purchase help through a bounded service request.",
      useCases: [
        "Create an OttoAuth task from an agent session.",
        "Respect spend caps and callback setup before asking a human to approve commerce actions.",
        "Diagnose missing username, private key, service URL, or default spend cap setup.",
      ],
      commands: [
        { label: "Start an OttoAuth task", command: "vr-ottoauth --task \"Describe the purchase or checkout task\" --max-charge-cents 2500 --wait", detail: "Use an explicit spending bound for commerce requests." },
        { label: "Read OttoAuth guide", command: "sed -n '1,220p' \"$VIBE_RESEARCH_BUILDING_GUIDES_DIR/ottoauth.md\"", detail: "Review setup and safety expectations first." },
      ],
      env: [
        { name: "VIBE_RESEARCH_OTTOAUTH_COMMAND", detail: "Canonical helper command for local agents." },
        { name: "VIBE_RESEARCH_AGENT_CALLBACK_URL", detail: "Automatically passed by vr-ottoauth so OttoAuth services can send multi-turn updates back to this agent." },
      ],
      docs: [
        { label: "OttoAuth dashboard", url: "https://ottoauth.vercel.app/dashboard" },
        { label: "OttoAuth skill", url: "https://ottoauth.vercel.app/skill.md" },
      ],
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
          setupUrl: "https://ottoauth.vercel.app/skill.md",
          setupLabel: "Open skill",
          setupHint: "Open the OttoAuth skill, then paste the private key here.",
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
    id: "zinc",
    name: "Zinc",
    category: "Commerce",
    description: "Let agents place real-world retail orders (Amazon, Walmart, etc.) through Zinc's managed retail API.",
    icon: ShoppingCart,
    install: {
      enabledSetting: "zincEnabled",
      storedFallback: false,
    },
    status: "API key required",
    source: "external",
    visual: {
      shape: "market",
    },
    access: {
      label: "Zinc client token",
      detail: "Requires a Zinc client token from app.zinc.com (Bearer auth on api.zinc.com). Real money: every successful POST /orders charges the linked retailer account. Vibe Research stores the token, never the order details — cart contents, shipping addresses, and charge approvals stay in the agent runtime and human workflow.",
    },
    onboarding: {
      variables: [
        {
          label: "Zinc client token",
          setting: "zincApiKey",
          configuredSetting: "zincApiKeyConfigured",
          secret: true,
          required: true,
          setupUrl: "https://app.zinc.com",
          setupLabel: "Get a Zinc token",
          setupHint: "Sign up at app.zinc.com, then copy the client token from the dashboard.",
        },
        { label: "Spend approval", value: "explicit human approval before every order", required: true },
      ],
      steps: [
        { title: "Enable the building", detail: "Turn on Zinc retail orders.", completeWhen: { type: "installed" } },
        {
          title: "Paste the Zinc client token",
          detail: "Copy your Zinc client token from app.zinc.com and paste it here. Vibe Research will store it locally, never in the agent prompt.",
          completeWhen: { allConfigured: ["zincApiKeyConfigured"] },
        },
        { title: "Place a test order with approval", detail: "Use POST https://api.zinc.com/orders with Bearer auth — only after a human has approved the cart, max_price, and shipping address." },
      ],
    },
    agentGuide: {
      summary: "Use Zinc when an agent needs to place a real retail order on the human's behalf. Treat every Zinc call as spending real money — get explicit cart and dollar approval first.",
      useCases: [
        "Order a specific product from Amazon / Walmart / etc. after the human confirms the cart, max price, and shipping address.",
        "Cancel a pending Zinc order before it ships.",
        "Inspect order status, tracking, and charges for a specific Zinc order id.",
      ],
      setup: [
        "Read this guide and check `command -v jq` plus `command -v curl` before assuming the agent environment can call Zinc.",
        "Never call POST /orders without the human's explicit approval of: product url, max_price (cap), shipping_address, and retailer.",
        "Quote prices in the same currency Zinc bills (USD by default) so max_price comparisons aren't misleading.",
        "Keep the Zinc client token, full shipping address, and payment-method tokens out of the Library, agent prompts, and screenshots.",
      ],
      commands: [
        {
          label: "Place an order (with approval)",
          command: "curl -s -X POST https://api.zinc.com/orders -H 'Authorization: Bearer $ZINC_API_KEY' -H 'Content-Type: application/json' -d @order.json",
          detail: "POST /orders with the approved cart in order.json. Include products[], max_price, shipping_address, and retailer.",
        },
        {
          label: "Check order status",
          command: "curl -s https://api.zinc.com/orders/<order_id> -H 'Authorization: Bearer $ZINC_API_KEY'",
          detail: "Read-only — fetches order state, tracking, and charges.",
        },
        {
          label: "Cancel a pending order",
          command: "curl -s -X POST https://api.zinc.com/orders/<order_id>/cancel -H 'Authorization: Bearer $ZINC_API_KEY'",
          detail: "Cancels before shipment if Zinc still allows it.",
        },
      ],
      env: [
        { name: "ZINC_API_KEY", detail: "Zinc client token used as the Bearer credential. Never print or log this.", required: true },
      ],
      docs: [
        { label: "Zinc docs", url: "https://www.zinc.com/docs" },
        { label: "Quickstart", url: "https://www.zinc.com/docs/quickstart" },
        { label: "Place an order", url: "https://www.zinc.com/docs/orders" },
      ],
    },
  },
  {
    id: "rentahuman",
    name: "RentAHuman",
    category: "Commerce",
    description: "Let AI agents hire humans for real-world tasks through RentAHuman's MCP server or REST API.",
    icon: Handshake,
    status: "MCP-ready",
    source: "external",
    visual: {
      logo: "rentahuman",
      shape: "market",
    },
    access: {
      label: "RentAHuman MCP/API",
      detail: "Requires RentAHuman MCP, REST API, or account setup where the agent runs. Vibe Research tracks the building and guide only; API keys, operator pairing, payments, and escrow approval stay with the agent runtime and human workflow.",
    },
    onboarding: {
      variables: [
        { label: "MCP server", value: "npx rentahuman-mcp", required: false },
        { label: "API URL", value: "https://rentahuman.ai/api", required: false },
        { label: "API key or operator pairing", value: "required for posting bounties, hiring, messaging, or payments", required: true },
        { label: "Spend policy", value: "budget, escrow, and release approval rules", required: true },
      ],
      steps: [
        { title: "Read the agent docs", detail: "Review the MCP guide, REST API docs, and task/payment model before giving agents write access." },
        { title: "Connect RentAHuman", detail: "Configure the MCP server or REST API in the provider or local environment that will use it." },
        { title: "Set approval rules", detail: "Require explicit human approval before posting paid bounties, funding escrow, releasing payment, or exposing private data." },
        { title: "Install the building", detail: "Add RentAHuman to Agent Town once the MCP or API path is ready.", completeWhen: { type: "installed" } },
      ],
    },
    agentGuide: {
      summary: "Use RentAHuman when an agent needs a human workforce for physical-world tasks through RentAHuman's MCP server or REST API.",
      useCases: [
        "Search humans by skill, rate, location, city, or country.",
        "Post bounties for field research, errands, delivery, media capture, QA, or local presence tasks.",
        "Book services, manage applications, and track escrow-backed completion when the account is approved.",
        "Inspect public bounties or profiles before asking the human for credentials, spend approval, or operator pairing.",
      ],
      setup: [
        "Start with read-only search and browsing unless the user has explicitly approved posting or spending.",
        "Keep RentAHuman API keys, generated identities, pairing codes, prepaid card details, and Stripe data out of prompts, Library notes, logs, and screenshots.",
        "Record task scope, budget, location, deadline, evidence requirements, and approval points before creating paid bounties.",
        "Ask for human approval before posting paid work, accepting applications, funding escrow, releasing payment, sending money, or sharing private user data.",
      ],
      commands: [
        { label: "Check MCP package help", command: "npx -y rentahuman-mcp --help", detail: "Confirms the MCP package can run in the current agent environment." },
        { label: "Read agent quickstart", command: "curl -L https://rentahuman.ai/llms.txt", detail: "Shows the current MCP package name, public endpoints, and tool list." },
        { label: "Try public human search", command: "curl -s \"https://rentahuman.ai/api/humans?skill=Photography&limit=3\"", detail: "Uses a no-auth endpoint to validate basic network access without spending money." },
      ],
      docs: [
        { label: "RentAHuman", url: "https://rentahuman.ai/" },
        { label: "MCP guide", url: "https://rentahuman.ai/mcp" },
        { label: "API docs", url: "https://rentahuman.ai/api-docs" },
        { label: "OpenAPI spec", url: "https://rentahuman.ai/.well-known/openapi.yaml" },
        { label: "Agent quickstart", url: "https://rentahuman.ai/llms.txt" },
      ],
      env: [
        { name: "RENTAHUMAN_API_URL", required: false, detail: "REST API base URL, usually https://rentahuman.ai/api." },
        { name: "RENTAHUMAN_API_KEY", required: false, detail: "Account credential for authenticated write/payment actions; never print it." },
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
    ui: {
      entryView: "videomemory",
      mode: "panel",
      workspaceView: "",
    },
    visual: {
      shape: "camera",
      // VideoMemory has a dedicated Camera Room slot in Agent Town. Marking it
      // as a special town place stops it from also appearing as a generic
      // placeable plugin building — otherwise the user sees two buildings
      // (the auto-placed Camera Room and a duplicate VideoMemory tile).
      specialTownPlace: true,
    },
    agentGuide: {
      summary: "Use VideoMemory when the human asks you to watch a live camera or video stream for some condition and react when it happens — either waking your own session with the details or spawning a fresh session. It handles the video-watching and fires a webhook back into Vibe Research when the condition is met.",
      useCases: [
        "Turn a natural-language 'watch for X' request into an armed monitor; by default `vr-videomemory create` wakes the caller session.",
        "Pick the right camera/input for a monitor by matching the human's description to a reported device.",
        "Diagnose why a monitor never fires (camera permission, service URL, disabled plugin) before blaming the condition.",
        "Record monitor IDs, task URLs, and artifact paths in the Library when they matter.",
      ],
      commands: [
        { label: "List cameras", command: "vr-videomemory devices", detail: "Prints the ioIds and names the VideoMemory server is reporting so you can pick the right --io-id for a monitor." },
        { label: "Start a monitor", command: "vr-videomemory create --io-id <ioId> --trigger \"<natural-language condition>\" --action \"<what to do on wake>\"", detail: "Defaults to waking the current session; add --new-session to spawn a fresh one instead." },
        { label: "List active monitors", command: "vr-videomemory list", detail: "See armed monitors and their wake targets." },
        { label: "Read VideoMemory guide", command: "sed -n '1,220p' \"$VIBE_RESEARCH_BUILDING_GUIDES_DIR/videomemory.md\"", detail: "Review setup and camera permission expectations first." },
      ],
      env: [
        { name: "VIBE_RESEARCH_VIDEOMEMORY_COMMAND", detail: "Canonical helper command for local agents." },
      ],
      docs: [
        { label: "Anthropic Console keys", url: "https://console.anthropic.com/settings/keys" },
        { label: "Claude vision capabilities", url: "https://docs.claude.com/en/docs/build-with-claude/vision" },
      ],
    },
    onboarding: {
      setupSelector: ".videomemory-plugin-card",
      variables: [
        // Anthropic key is optional: the local VideoMemory service will use it
        // for VLM calls if present, but many deployments rely on the external
        // service's own credentials. Keeping it non-required means a plain
        // two-step install (Install → Enable cameras) finishes as "configured"
        // and users can still add a key later from the building panel.
        {
          label: "Anthropic API key (optional)",
          setting: "videoMemoryAnthropicApiKey",
          configuredSetting: "videoMemoryAnthropicApiKeyConfigured",
          secret: true,
          required: false,
          setupUrl: "https://console.anthropic.com/settings/keys",
          setupLabel: "Open Anthropic Console",
          setupHint: "Paste a Claude API key if VideoMemory should make VLM calls on your behalf.",
        },
        { label: "VideoMemory URL", setting: "videoMemoryBaseUrl", required: true },
        { label: "Wake provider", setting: "videoMemoryProviderId", required: true },
        {
          label: "Camera permission",
          value: "browser permission",
          required: true,
          setupSelector: ".videomemory-camera-permission-button",
          setupHint: "Click to request camera access now.",
        },
      ],
      steps: [
        { title: "Enable the building", detail: "Turn on camera monitors.", completeWhen: { type: "installed" } },
        {
          title: "Save monitor variables",
          detail: "Set the service URL and provider agents should wake.",
          completeWhen: {
            allConfigured: [
              "videoMemoryBaseUrl",
              "videoMemoryProviderId",
            ],
          },
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
    visual: {
      logo: "agentmail",
    },
    onboarding: {
      setupSelector: ".communications-plugin-card",
      variables: [
        {
          label: "AgentMail API key",
          setting: "agentMailApiKey",
          configuredSetting: "agentMailApiKeyConfigured",
          secret: true,
          required: true,
          setupUrl: "https://docs.agentmail.to/",
          setupLabel: "Open docs",
          setupHint: "Create or copy an AgentMail API key, then paste it here.",
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
    agentGuide: {
      docs: [
        { label: "AgentMail docs", url: "https://docs.agentmail.to/" },
        { label: "Send / receive API", url: "https://docs.agentmail.to/api-reference" },
        { label: "Webhooks", url: "https://docs.agentmail.to/webhooks" },
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
    visual: {
      logo: "telegram",
    },
    onboarding: {
      setupSelector: ".communications-plugin-card",
      variables: [
        {
          label: "Bot token",
          setting: "telegramBotToken",
          configuredSetting: "telegramBotTokenConfigured",
          secret: true,
          required: true,
          setupUrl: "https://telegram.me/botfather",
          setupLabel: "Open BotFather",
          setupHint: "Use BotFather to create a bot, then paste the token here.",
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
    agentGuide: {
      docs: [
        { label: "Bot API reference", url: "https://core.telegram.org/bots/api" },
        { label: "BotFather", url: "https://telegram.me/botfather" },
        { label: "sendMessage", url: "https://core.telegram.org/bots/api#sendmessage" },
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
      logoImage: "/images/buildings/automations.jpg",
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
    install: {
      // System building: always available without an explicit install step.
      // Promotes the sidebar "ports" section back into the default UI so
      // every detected listening port is one click away (preview tab,
      // direct LAN URL, Tailscale Serve URL, or /proxy/<port>/ fallback —
      // whichever is reachable). Each port's `preferredUrl` is decided
      // server-side by decoratePortForAccess() so the click target is
      // always the best-available URL for the viewer's network.
      system: true,
    },
    status: "built in",
    source: "vibe-research",
    visual: {
      shape: "dock",
      specialTownPlace: true,
    },
    agentGuide: {
      summary: "Use Localhost Apps when an agent needs to discover, rename, preview, or expose web apps running from the workspace.",
      useCases: [
        "Find development servers discovered by Vibe Research.",
        "Preview a local app through the Vibe Research proxy or direct URL.",
        "Expose eligible localhost-only ports through the Tailscale portal when available.",
      ],
      commands: [
        { label: "List discovered ports", command: "curl -s http://127.0.0.1:${VIBE_RESEARCH_PORT:-4826}/api/ports -H 'X-Vibe-Research-API: 1'", detail: "Use the runtime app port if it differs from 4826." },
        { label: "Open with Playwright", command: "vr-playwright open http://127.0.0.1:4173 && vr-playwright snapshot", detail: "Inspect a local app with a real browser." },
      ],
      env: [
        { name: "VIBE_RESEARCH_PLAYWRIGHT_COMMAND", detail: "Canonical Playwright helper command." },
        { name: "VIBE_RESEARCH_BROWSER_FALLBACK_COMMAND", detail: "Visual fallback helper for screenshots/images." },
      ],
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
  // Popular MCP-server buildings. Each one is a thin wrapper around an
  // npm-published Model Context Protocol server. The install plan
  // verifies npx is available and that the upstream package exists in
  // the npm registry; the human pastes the API key (or chooses a path),
  // and the runtime owns mcp-launch lifecycle.
  {
    id: "mcp-filesystem",
    name: "MCP Filesystem",
    category: "MCP",
    description: "Give agents a sandboxed view of one or more directories via the official Model Context Protocol filesystem server.",
    icon: Database,
    status: "one-click install",
    source: "modelcontextprotocol",
    install: {
      enabledSetting: "mcpFilesystemEnabled",
      storedFallback: false,
      plan: {
        preflight: [
          { kind: "command", command: "command -v npx", label: "Detect npx" },
        ],
        install: [],
        verify: [
          {
            kind: "command",
            command: "npm view @modelcontextprotocol/server-filesystem version",
            label: "Verify @modelcontextprotocol/server-filesystem package exists",
            timeoutSec: 60,
          },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "${mcpFilesystemRoots}"],
            label: "Launch MCP filesystem server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Directory roots", setting: "mcpFilesystemRoots", required: true, setupHint: "Comma-separated absolute paths the MCP server should expose. Keep the scope narrow." },
      ],
      steps: [
        { title: "Install the server", detail: "Click install — the runner verifies npx and the upstream npm package.", completeWhen: { type: "installed" } },
        { title: "Pick directory roots", detail: "Set the absolute paths agents may read and write. One per line." },
      ],
    },
    agentGuide: {
      summary: "The MCP filesystem server lets agents list, read, and write files inside the configured roots.",
      env: [{ name: "MCP_FILESYSTEM_ROOTS", detail: "Comma-separated absolute paths the server is allowed to touch.", required: true }],
      docs: [{ label: "MCP filesystem server", url: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem" }],
    },
  },
  {
    id: "mcp-github",
    name: "MCP GitHub",
    category: "MCP",
    description: "Browse, search, and edit GitHub repositories via the official Model Context Protocol GitHub server.",
    icon: GitPullRequest,
    status: "one-click install",
    source: "modelcontextprotocol",
    install: {
      enabledSetting: "mcpGithubEnabled",
      storedFallback: false,
      plan: {
        preflight: [
          { kind: "command", command: "command -v npx", label: "Detect npx" },
        ],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpGithubToken",
          setupUrl: "https://github.com/settings/tokens?type=beta",
          setupLabel: "Create GitHub PAT",
          detail: "Create a fine-grained personal access token with the repository scopes you want to expose, then paste it.",
        },
        verify: [
          {
            kind: "command",
            command: "npm view @modelcontextprotocol/server-github version",
            label: "Verify @modelcontextprotocol/server-github package exists",
            timeoutSec: 60,
          },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${mcpGithubToken}" },
            label: "Launch MCP GitHub server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "GitHub PAT", setting: "mcpGithubToken", required: true, secret: true, setupUrl: "https://github.com/settings/tokens?type=beta" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a fine-grained PAT", detail: "Restrict scopes to the repos agents should touch." },
      ],
    },
    agentGuide: {
      summary: "MCP GitHub gives agents repo browsing, issue management, file edits, and PR creation. Always use a fine-grained PAT.",
      env: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", required: true }],
      docs: [{ label: "MCP GitHub server", url: "https://github.com/modelcontextprotocol/servers/tree/main/src/github" }],
    },
  },
  {
    id: "mcp-postgres",
    name: "MCP Postgres",
    category: "MCP",
    description: "Read-only Postgres access for agents through the official Model Context Protocol Postgres server.",
    icon: Database,
    status: "one-click install",
    source: "modelcontextprotocol",
    install: {
      enabledSetting: "mcpPostgresEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpPostgresUrl",
          setupLabel: "Paste connection string",
          detail: "Use a read-only role. Format: postgres://user:pass@host:port/db",
        },
        verify: [
          { kind: "command", command: "npm view @modelcontextprotocol/server-postgres version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-postgres", "${mcpPostgresUrl}"],
            label: "Launch MCP Postgres server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Connection string", setting: "mcpPostgresUrl", required: true, secret: true },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a read-only Postgres URL", detail: "Use a role scoped to SELECT only when possible." },
      ],
    },
    agentGuide: {
      summary: "Read-only Postgres access. Always pass a connection string scoped to a SELECT-only role.",
      docs: [{ label: "MCP Postgres server", url: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres" }],
    },
  },
  {
    id: "mcp-sqlite",
    name: "MCP SQLite",
    category: "MCP",
    description: "Local SQLite access for agents via the mcp-server-sqlite package.",
    icon: Database,
    status: "one-click install",
    source: "community",
    install: {
      enabledSetting: "mcpSqliteEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpSqliteDbPath",
          setupLabel: "Paste SQLite db path",
          detail: "Absolute path to the .db file you want agents to query.",
        },
        verify: [
          { kind: "command", command: "npm view mcp-server-sqlite version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "mcp-server-sqlite", "${mcpSqliteDbPath}"],
            label: "Launch MCP SQLite server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "SQLite db path", setting: "mcpSqliteDbPath", required: true },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Set the db path", detail: "Absolute path to the .db file." },
      ],
    },
    agentGuide: {
      summary: "Query a local SQLite file from an agent session.",
      docs: [{ label: "mcp-server-sqlite", url: "https://www.npmjs.com/package/mcp-server-sqlite" }],
    },
  },
  {
    id: "mcp-brave-search",
    name: "MCP Brave Search",
    category: "MCP",
    description: "Web search for agents via Brave Search through the official Model Context Protocol server.",
    icon: Lightbulb,
    status: "one-click install",
    source: "modelcontextprotocol",
    install: {
      enabledSetting: "mcpBraveSearchEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpBraveSearchApiKey",
          setupUrl: "https://api.search.brave.com/app/keys",
          setupLabel: "Get Brave API key",
          detail: "Create a Brave Search API key, then paste it. The free tier is enough for most agent traffic.",
        },
        verify: [
          { kind: "command", command: "npm view @modelcontextprotocol/server-brave-search version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-brave-search"],
            env: { BRAVE_API_KEY: "${mcpBraveSearchApiKey}" },
            label: "Launch MCP Brave Search server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Brave API key", setting: "mcpBraveSearchApiKey", required: true, secret: true, setupUrl: "https://api.search.brave.com/app/keys" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste your Brave API key" },
      ],
    },
    agentGuide: {
      summary: "Web + local search via Brave Search. Use sparingly — the API has request quotas.",
      env: [{ name: "BRAVE_API_KEY", required: true }],
      docs: [{ label: "MCP Brave Search server", url: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search" }],
    },
  },
  {
    id: "mcp-slack",
    name: "MCP Slack",
    category: "MCP",
    description: "Read and post Slack messages from agent sessions via the official Model Context Protocol Slack server.",
    icon: MessageCircle,
    status: "one-click install",
    source: "modelcontextprotocol",
    install: {
      enabledSetting: "mcpSlackEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpSlackBotToken",
          setupUrl: "https://api.slack.com/apps",
          setupLabel: "Open Slack apps",
          detail: "Create or pick a Slack app, install it to your workspace, then paste the Bot User OAuth Token (starts with xoxb-).",
        },
        verify: [
          { kind: "command", command: "npm view @modelcontextprotocol/server-slack version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-slack"],
            env: {
              SLACK_BOT_TOKEN: "${mcpSlackBotToken}",
              SLACK_TEAM_ID: "${mcpSlackTeamId}",
            },
            label: "Launch MCP Slack server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Slack bot token", setting: "mcpSlackBotToken", required: true, secret: true, setupUrl: "https://api.slack.com/apps" },
        { label: "Slack team id", setting: "mcpSlackTeamId", required: false },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a Slack bot token", detail: "xoxb-... from your Slack app." },
        { title: "Set the team id", detail: "Optional but improves channel disambiguation." },
      ],
    },
    agentGuide: {
      summary: "Read channel history, list users/channels, post messages via a Slack app's bot token.",
      env: [
        { name: "SLACK_BOT_TOKEN", required: true },
        { name: "SLACK_TEAM_ID", required: false },
      ],
      docs: [{ label: "MCP Slack server", url: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack" }],
    },
  },
  {
    id: "mcp-sentry",
    name: "MCP Sentry",
    category: "MCP",
    description: "Surface Sentry issues, events, and stack traces in agent sessions via the official Sentry MCP server.",
    icon: Activity,
    status: "one-click install",
    source: "sentry",
    install: {
      enabledSetting: "mcpSentryEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpSentryAuthToken",
          setupUrl: "https://sentry.io/settings/account/api/auth-tokens/",
          setupLabel: "Create a Sentry auth token",
          detail: "Create a personal API token with the org:read + project:read + event:read scopes minimum.",
        },
        verify: [
          { kind: "command", command: "npm view @sentry/mcp-server version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@sentry/mcp-server"],
            env: { SENTRY_AUTH_TOKEN: "${mcpSentryAuthToken}" },
            label: "Launch MCP Sentry server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Sentry auth token", setting: "mcpSentryAuthToken", required: true, secret: true, setupUrl: "https://sentry.io/settings/account/api/auth-tokens/" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a Sentry auth token" },
      ],
    },
    agentGuide: {
      summary: "Triage Sentry issues from an agent: list orgs/projects, fetch issue details, page through events.",
      env: [{ name: "SENTRY_AUTH_TOKEN", required: true }],
      docs: [{ label: "Sentry MCP server", url: "https://www.npmjs.com/package/@sentry/mcp-server" }],
    },
  },
  {
    id: "mcp-notion",
    name: "MCP Notion",
    category: "MCP",
    description: "Read and edit Notion pages and databases via the official Notion Model Context Protocol server.",
    icon: Notebook,
    status: "one-click install",
    source: "notion",
    install: {
      enabledSetting: "mcpNotionEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpNotionToken",
          setupUrl: "https://www.notion.so/my-integrations",
          setupLabel: "Create a Notion integration",
          detail: "Create an internal integration, share the workspace pages you want to expose with it, then paste the integration token.",
        },
        verify: [
          { kind: "command", command: "npm view @notionhq/notion-mcp-server version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@notionhq/notion-mcp-server"],
            env: {
              OPENAPI_MCP_HEADERS: "{\"Authorization\": \"Bearer ${mcpNotionToken}\", \"Notion-Version\": \"2022-06-28\"}",
            },
            label: "Launch MCP Notion server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Notion integration token", setting: "mcpNotionToken", required: true, secret: true, setupUrl: "https://www.notion.so/my-integrations" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Create the integration + share pages", detail: "Notion only sees pages explicitly shared with the integration." },
      ],
    },
    agentGuide: {
      summary: "Read or edit Notion pages and databases. Pages must be explicitly shared with the integration in Notion's UI.",
      env: [{ name: "NOTION_INTEGRATION_TOKEN", required: true }],
      docs: [{ label: "@notionhq/notion-mcp-server", url: "https://www.npmjs.com/package/@notionhq/notion-mcp-server" }],
    },
  },
  {
    id: "mcp-linear",
    name: "MCP Linear",
    category: "MCP",
    description: "Read and edit Linear issues from agent sessions via the @tacticlaunch/mcp-linear server.",
    icon: Activity,
    status: "one-click install",
    source: "community",
    install: {
      enabledSetting: "mcpLinearEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpLinearApiKey",
          setupUrl: "https://linear.app/settings/api",
          setupLabel: "Create a Linear personal API key",
          detail: "Use a personal API key (lin_api_...) scoped to the workspaces agents should touch.",
        },
        verify: [
          { kind: "command", command: "npm view @tacticlaunch/mcp-linear version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@tacticlaunch/mcp-linear"],
            env: { LINEAR_API_KEY: "${mcpLinearApiKey}" },
            label: "Launch MCP Linear server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Linear API key", setting: "mcpLinearApiKey", required: true, secret: true, setupUrl: "https://linear.app/settings/api" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a Linear personal API key" },
      ],
    },
    agentGuide: {
      summary: "List, search, create, and update Linear issues from agent sessions.",
      env: [{ name: "LINEAR_API_KEY", required: true }],
      docs: [{ label: "@tacticlaunch/mcp-linear", url: "https://www.npmjs.com/package/@tacticlaunch/mcp-linear" }],
    },
  },
  // Anthropic-maintained AWS Bedrock Knowledge Base retrieval — the
  // first AWS MCP we ship that doesn't need the local AWS CLI.
  // Credentials propagate through the user's environment (set
  // AWS_REGION + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in the
  // shell that launched Vibe Research, or use ~/.aws/credentials);
  // Vibe Research only captures the Knowledge Base ID via auth-paste.
  {
    id: "mcp-aws-kb-retrieval",
    name: "MCP AWS Bedrock KB",
    category: "MCP",
    description: "Query AWS Bedrock Knowledge Bases from agent sessions via Anthropic's official MCP server.",
    icon: Database,
    status: "one-click install",
    source: "modelcontextprotocol",
    install: {
      enabledSetting: "mcpAwsKbEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpAwsKbId",
          setupUrl: "https://console.aws.amazon.com/bedrock/home#/knowledge-bases",
          setupLabel: "Open Bedrock Knowledge Bases",
          detail: "Paste the Knowledge Base ID. AWS credentials propagate from the user's environment (AWS_REGION + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or ~/.aws/credentials).",
        },
        verify: [
          { kind: "command", command: "npm view @modelcontextprotocol/server-aws-kb-retrieval version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-aws-kb-retrieval"],
            env: { KNOWLEDGE_BASE_ID: "${mcpAwsKbId}" },
            label: "Launch MCP AWS Bedrock KB retrieval server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Knowledge Base ID", setting: "mcpAwsKbId", required: true, setupUrl: "https://console.aws.amazon.com/bedrock/home#/knowledge-bases" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Configure AWS credentials", detail: "Make sure AWS_REGION + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY are set in the shell that launched Vibe Research, or that ~/.aws/credentials exists." },
        { title: "Paste the Knowledge Base ID" },
      ],
    },
    agentGuide: {
      summary: "Query AWS Bedrock knowledge bases from agent sessions. Read-only retrieval; no write actions.",
      env: [
        { name: "KNOWLEDGE_BASE_ID", required: true },
        { name: "AWS_REGION", required: true },
        { name: "AWS_ACCESS_KEY_ID", required: false },
        { name: "AWS_SECRET_ACCESS_KEY", required: false },
      ],
      docs: [{ label: "@modelcontextprotocol/server-aws-kb-retrieval", url: "https://www.npmjs.com/package/@modelcontextprotocol/server-aws-kb-retrieval" }],
    },
  },
  // Kubernetes MCP — talks to whatever cluster `kubectl` is currently
  // pointed at via ~/.kube/config. No auth-paste needed; the launch
  // inherits the user's KUBECONFIG environment.
  {
    id: "mcp-kubernetes",
    name: "MCP Kubernetes",
    category: "MCP",
    description: "Inspect and manage Kubernetes clusters from agent sessions via mcp-server-kubernetes.",
    icon: Boxes,
    status: "one-click install",
    source: "community",
    install: {
      enabledSetting: "mcpKubernetesEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        verify: [
          { kind: "command", command: "npm view mcp-server-kubernetes version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "mcp-server-kubernetes"],
            label: "Launch MCP Kubernetes server",
          },
        ],
      },
    },
    onboarding: {
      variables: [],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Confirm kubectl context", detail: "Make sure `kubectl get nodes` works in the shell that launched Vibe Research — the MCP server uses the current kube context for all calls." },
      ],
    },
    agentGuide: {
      summary: "kubectl-style cluster inspection + management from agent sessions. Defers to your current kubeconfig.",
      env: [{ name: "KUBECONFIG", required: false, detail: "Optional override of the kube config path." }],
      docs: [{ label: "mcp-server-kubernetes", url: "https://www.npmjs.com/package/mcp-server-kubernetes" }],
    },
  },
  // Obsidian MCP — needs the Obsidian Local REST API plugin running
  // in the user's Obsidian app + the API key it generated.
  {
    id: "mcp-obsidian",
    name: "MCP Obsidian",
    category: "MCP",
    description: "Read, search, and edit notes in your Obsidian vault via obsidian-mcp-server.",
    icon: BookOpen,
    status: "one-click install",
    source: "community",
    install: {
      enabledSetting: "mcpObsidianEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpObsidianApiKey",
          setupUrl: "obsidian://show-plugin?id=obsidian-local-rest-api",
          setupLabel: "Install Obsidian Local REST API plugin",
          detail: "Install the Obsidian Local REST API plugin in your vault, copy its API key, then paste it here. Also set the vault path on the building panel.",
        },
        verify: [
          { kind: "command", command: "npm view obsidian-mcp-server version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "obsidian-mcp-server"],
            env: {
              OBSIDIAN_API_KEY: "${mcpObsidianApiKey}",
              OBSIDIAN_BASE_URL: "https://127.0.0.1:27124",
            },
            label: "Launch MCP Obsidian server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Obsidian API key", setting: "mcpObsidianApiKey", required: true, secret: true, setupUrl: "obsidian://show-plugin?id=obsidian-local-rest-api" },
        { label: "Obsidian vault path", setting: "mcpObsidianVaultPath", required: false },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Install the Obsidian Local REST API plugin in your vault" },
        { title: "Paste its API key" },
      ],
    },
    agentGuide: {
      summary: "Search + edit Obsidian notes from agent sessions. Requires the Local REST API plugin in your vault.",
      env: [
        { name: "OBSIDIAN_API_KEY", required: true },
        { name: "OBSIDIAN_BASE_URL", required: false },
      ],
      docs: [{ label: "obsidian-mcp-server", url: "https://www.npmjs.com/package/obsidian-mcp-server" }],
    },
  },
  // CircleCI-maintained official MCP. Token via CIRCLECI_TOKEN.
  {
    id: "mcp-circleci",
    name: "MCP CircleCI",
    category: "MCP",
    description: "Inspect CircleCI projects, pipelines, and workflows from agent sessions via the official @circleci/mcp-server-circleci.",
    icon: GitPullRequest,
    status: "one-click install",
    source: "circleci",
    install: {
      enabledSetting: "mcpCircleciEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpCircleciToken",
          setupUrl: "https://app.circleci.com/settings/user/tokens",
          setupLabel: "Create a CircleCI personal API token",
          detail: "Create a personal API token (read scope is enough for inspection-only use).",
        },
        verify: [
          { kind: "command", command: "npm view @circleci/mcp-server-circleci version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@circleci/mcp-server-circleci"],
            env: { CIRCLECI_TOKEN: "${mcpCircleciToken}" },
            label: "Launch MCP CircleCI server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "CircleCI personal API token", setting: "mcpCircleciToken", required: true, secret: true, setupUrl: "https://app.circleci.com/settings/user/tokens" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a CircleCI personal API token" },
      ],
    },
    agentGuide: {
      summary: "Read CircleCI projects, pipelines, jobs, and build logs from agent sessions. Token-scoped to read by default.",
      env: [{ name: "CIRCLECI_TOKEN", required: true }],
      docs: [{ label: "@circleci/mcp-server-circleci", url: "https://www.npmjs.com/package/@circleci/mcp-server-circleci" }],
    },
  },
  // Airtable MCP — reads + writes records via personal access token.
  {
    id: "mcp-airtable",
    name: "MCP Airtable",
    category: "MCP",
    description: "Read + write Airtable bases from agent sessions via airtable-mcp-server.",
    icon: Database,
    status: "one-click install",
    source: "community",
    install: {
      enabledSetting: "mcpAirtableEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpAirtableApiKey",
          setupUrl: "https://airtable.com/create/tokens",
          setupLabel: "Create an Airtable personal access token",
          detail: "Create a personal access token scoped to the bases agents should touch. data.records:read at minimum; add data.records:write only if agents should edit.",
        },
        verify: [
          { kind: "command", command: "npm view airtable-mcp-server version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "airtable-mcp-server"],
            env: { AIRTABLE_API_KEY: "${mcpAirtableApiKey}" },
            label: "Launch MCP Airtable server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Airtable personal access token", setting: "mcpAirtableApiKey", required: true, secret: true, setupUrl: "https://airtable.com/create/tokens" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste an Airtable personal access token (scoped to specific bases)" },
      ],
    },
    agentGuide: {
      summary: "List bases + tables, read records, optionally write records. Scope the token narrowly.",
      env: [{ name: "AIRTABLE_API_KEY", required: true }],
      docs: [{ label: "airtable-mcp-server", url: "https://www.npmjs.com/package/airtable-mcp-server" }],
    },
  },
  // Datadog MCP — needs both API key + APP key.
  {
    id: "mcp-datadog",
    name: "MCP Datadog",
    category: "MCP",
    description: "Query Datadog metrics, logs, and monitors from agent sessions via datadog-mcp-server.",
    icon: Activity,
    status: "one-click install",
    source: "community",
    install: {
      enabledSetting: "mcpDatadogEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpDatadogApiKey",
          setupUrl: "https://app.datadoghq.com/organization-settings/api-keys",
          setupLabel: "Create Datadog API + App keys",
          detail: "Datadog needs BOTH an API key and an Application key. Paste the API key here; the App key goes in the mcpDatadogAppKey setting on the building panel. Set mcpDatadogSite if you're not on US1 (e.g. datadoghq.eu).",
        },
        verify: [
          { kind: "command", command: "npm view datadog-mcp-server version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "datadog-mcp-server"],
            env: {
              DD_API_KEY: "${mcpDatadogApiKey}",
              DD_APP_KEY: "${mcpDatadogAppKey}",
              DD_SITE: "${mcpDatadogSite}",
            },
            label: "Launch MCP Datadog server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Datadog API key", setting: "mcpDatadogApiKey", required: true, secret: true, setupUrl: "https://app.datadoghq.com/organization-settings/api-keys" },
        { label: "Datadog Application key", setting: "mcpDatadogAppKey", required: true, secret: true, setupUrl: "https://app.datadoghq.com/personal-settings/application-keys" },
        { label: "Datadog site", setting: "mcpDatadogSite", required: false, setupHint: "datadoghq.com (default), datadoghq.eu, us3.datadoghq.com, …" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste API + App keys", detail: "Both required. App key is per-user; create one at /personal-settings/application-keys." },
        { title: "Set the Datadog site if not US1" },
      ],
    },
    agentGuide: {
      summary: "Query Datadog metrics, logs, monitors. Read-only by token scope; agents should not create or modify monitors.",
      env: [
        { name: "DD_API_KEY", required: true },
        { name: "DD_APP_KEY", required: true },
        { name: "DD_SITE", required: false },
      ],
      docs: [{ label: "datadog-mcp-server", url: "https://www.npmjs.com/package/datadog-mcp-server" }],
    },
  },
  // Second wave of MCP-server buildings. Each pulls a verified npm package via
  // npx; install plans skip the install step (npx fetches on first run) and
  // gate usage on either an auth-paste field or, for no-auth servers, just the
  // `npm view` verify check.
  {
    id: "mcp-puppeteer",
    name: "MCP Puppeteer",
    category: "MCP",
    description: "Browser automation for agents via the official Model Context Protocol Puppeteer server.",
    icon: Globe,
    status: "one-click install",
    source: "modelcontextprotocol",
    install: {
      enabledSetting: "mcpPuppeteerEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        verify: [
          { kind: "command", command: "npm view @modelcontextprotocol/server-puppeteer version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-puppeteer"],
            label: "Launch MCP Puppeteer server",
          },
        ],
      },
    },
    onboarding: {
      variables: [],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Use it", detail: "No auth required; agents can browse and screenshot pages." },
      ],
    },
    agentGuide: {
      summary: "Drive a headless Chromium for browsing, scraping, screenshotting, and form filling.",
      docs: [{ label: "MCP Puppeteer server", url: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer" }],
    },
  },
  {
    id: "mcp-memory",
    name: "MCP Memory",
    category: "MCP",
    description: "Persistent in-memory knowledge graph for agents via the Model Context Protocol Memory server.",
    icon: BookOpen,
    status: "one-click install",
    source: "modelcontextprotocol",
    install: {
      enabledSetting: "mcpMemoryEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        verify: [
          { kind: "command", command: "npm view @modelcontextprotocol/server-memory version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-memory"],
            label: "Launch MCP Memory server",
          },
        ],
      },
    },
    onboarding: {
      variables: [],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Use it", detail: "No auth required; the server persists facts across sessions." },
      ],
    },
    agentGuide: {
      summary: "Lets agents store and retrieve typed memory entries (entities, relations, observations).",
      docs: [{ label: "MCP Memory server", url: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory" }],
    },
  },
  {
    id: "mcp-redis",
    name: "MCP Redis",
    category: "MCP",
    description: "Read and write Redis from agent sessions via the official Model Context Protocol Redis server.",
    icon: Database,
    status: "one-click install",
    source: "modelcontextprotocol",
    install: {
      enabledSetting: "mcpRedisEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpRedisUrl",
          setupLabel: "Paste Redis URL",
          detail: "Format: redis://default:password@host:port. Use a least-privilege user.",
        },
        verify: [
          { kind: "command", command: "npm view @modelcontextprotocol/server-redis version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-redis", "${mcpRedisUrl}"],
            label: "Launch MCP Redis server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Redis URL", setting: "mcpRedisUrl", required: true, secret: true },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a Redis URL" },
      ],
    },
    agentGuide: {
      summary: "GET/SET/HGETALL/etc. against a configured Redis instance.",
      docs: [{ label: "MCP Redis server", url: "https://github.com/modelcontextprotocol/servers/tree/main/src/redis" }],
    },
  },
  {
    id: "mcp-gitlab",
    name: "MCP GitLab",
    category: "MCP",
    description: "Browse and edit GitLab projects from agent sessions via the official MCP GitLab server.",
    icon: GitPullRequest,
    status: "one-click install",
    source: "modelcontextprotocol",
    install: {
      enabledSetting: "mcpGitlabEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpGitlabToken",
          setupUrl: "https://gitlab.com/-/profile/personal_access_tokens",
          setupLabel: "Create a GitLab personal access token",
          detail: "Use a token with api / read_repository scopes; for self-hosted, also set MCP_GITLAB_URL.",
        },
        verify: [
          { kind: "command", command: "npm view @modelcontextprotocol/server-gitlab version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-gitlab"],
            env: {
              GITLAB_PERSONAL_ACCESS_TOKEN: "${mcpGitlabToken}",
              GITLAB_API_URL: "${mcpGitlabUrl}",
            },
            label: "Launch MCP GitLab server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "GitLab token", setting: "mcpGitlabToken", required: true, secret: true, setupUrl: "https://gitlab.com/-/profile/personal_access_tokens" },
        { label: "GitLab API URL", setting: "mcpGitlabUrl", required: false },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a personal access token" },
      ],
    },
    agentGuide: {
      summary: "Browse repos, manage issues, create branches and MRs on GitLab.",
      env: [{ name: "GITLAB_PERSONAL_ACCESS_TOKEN", required: true }],
      docs: [{ label: "MCP GitLab server", url: "https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab" }],
    },
  },
  {
    id: "mcp-google-maps",
    name: "MCP Google Maps",
    category: "MCP",
    description: "Geocode, search places, and route via the official Model Context Protocol Google Maps server.",
    icon: Globe,
    status: "one-click install",
    source: "modelcontextprotocol",
    install: {
      enabledSetting: "mcpGoogleMapsEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpGoogleMapsApiKey",
          setupUrl: "https://console.cloud.google.com/google/maps-apis/credentials",
          setupLabel: "Create a Google Maps API key",
          detail: "Restrict the key to the Maps APIs you actually use (Geocoding, Places, Directions).",
        },
        verify: [
          { kind: "command", command: "npm view @modelcontextprotocol/server-google-maps version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-google-maps"],
            env: { GOOGLE_MAPS_API_KEY: "${mcpGoogleMapsApiKey}" },
            label: "Launch MCP Google Maps server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Google Maps API key", setting: "mcpGoogleMapsApiKey", required: true, secret: true, setupUrl: "https://console.cloud.google.com/google/maps-apis/credentials" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste an API key" },
      ],
    },
    agentGuide: {
      summary: "Geocode, search places, fetch directions and distance matrices.",
      env: [{ name: "GOOGLE_MAPS_API_KEY", required: true }],
      docs: [{ label: "MCP Google Maps server", url: "https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps" }],
    },
  },
  {
    id: "mcp-everything",
    name: "MCP Everything",
    category: "MCP",
    description: "Reference Model Context Protocol server bundling every demo tool — useful for testing client integrations.",
    icon: Package,
    status: "one-click install",
    source: "modelcontextprotocol",
    install: {
      enabledSetting: "mcpEverythingEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        verify: [
          { kind: "command", command: "npm view @modelcontextprotocol/server-everything version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-everything"],
            label: "Launch MCP Everything server",
          },
        ],
      },
    },
    onboarding: {
      variables: [],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Use it for client testing" },
      ],
    },
    agentGuide: {
      summary: "Bundles every demo tool the MCP project ships — handy when wiring a new MCP client.",
      docs: [{ label: "MCP Everything server", url: "https://github.com/modelcontextprotocol/servers/tree/main/src/everything" }],
    },
  },
  {
    id: "mcp-stripe",
    name: "MCP Stripe",
    category: "MCP",
    description: "Inspect and manage Stripe charges, customers, and subscriptions via the official @stripe/mcp server.",
    icon: ShoppingCart,
    status: "one-click install",
    source: "stripe",
    install: {
      enabledSetting: "mcpStripeEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpStripeApiKey",
          setupUrl: "https://dashboard.stripe.com/apikeys",
          setupLabel: "Stripe restricted API key",
          detail: "Use a restricted key, never the live secret. Read-only is best for agents.",
        },
        verify: [
          { kind: "command", command: "npm view @stripe/mcp version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@stripe/mcp"],
            env: { STRIPE_SECRET_KEY: "${mcpStripeApiKey}" },
            label: "Launch MCP Stripe server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Stripe API key", setting: "mcpStripeApiKey", required: true, secret: true, setupUrl: "https://dashboard.stripe.com/apikeys" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a restricted API key" },
      ],
    },
    agentGuide: {
      summary: "Read charges, customers, prices, products, subscriptions; create checkout sessions when authorised.",
      env: [{ name: "STRIPE_SECRET_KEY", required: true }],
      docs: [{ label: "@stripe/mcp", url: "https://www.npmjs.com/package/@stripe/mcp" }],
    },
  },
  {
    id: "mcp-mongodb",
    name: "MCP MongoDB",
    category: "MCP",
    description: "Query MongoDB clusters from agent sessions via the official mongodb-mcp-server package.",
    icon: Database,
    status: "one-click install",
    source: "mongodb",
    install: {
      enabledSetting: "mcpMongodbEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpMongodbUri",
          setupLabel: "Paste MongoDB URI",
          detail: "Use a least-privilege user. Format: mongodb+srv://user:pass@cluster/db",
        },
        verify: [
          { kind: "command", command: "npm view mongodb-mcp-server version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "mongodb-mcp-server"],
            env: { MDB_MCP_CONNECTION_STRING: "${mcpMongodbUri}" },
            label: "Launch MCP MongoDB server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "MongoDB URI", setting: "mcpMongodbUri", required: true, secret: true },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a connection URI" },
      ],
    },
    agentGuide: {
      summary: "List databases/collections, run filtered finds, aggregations, and inspect indexes.",
      env: [{ name: "MDB_MCP_CONNECTION_STRING", required: true }],
      docs: [{ label: "mongodb-mcp-server", url: "https://www.npmjs.com/package/mongodb-mcp-server" }],
    },
  },
  {
    id: "mcp-cloudflare",
    name: "MCP Cloudflare",
    category: "MCP",
    description: "Manage Cloudflare zones, workers, and KV stores from agent sessions via the official MCP Cloudflare server.",
    icon: Globe,
    status: "one-click install",
    source: "cloudflare",
    install: {
      enabledSetting: "mcpCloudflareEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpCloudflareApiToken",
          setupUrl: "https://dash.cloudflare.com/profile/api-tokens",
          setupLabel: "Create a Cloudflare API token",
          detail: "Restrict the token to the zones / accounts agents should touch.",
        },
        verify: [
          { kind: "command", command: "npm view mcp-server-cloudflare version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "mcp-server-cloudflare"],
            env: { CLOUDFLARE_API_TOKEN: "${mcpCloudflareApiToken}" },
            label: "Launch MCP Cloudflare server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Cloudflare API token", setting: "mcpCloudflareApiToken", required: true, secret: true, setupUrl: "https://dash.cloudflare.com/profile/api-tokens" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste an API token" },
      ],
    },
    agentGuide: {
      summary: "List + edit DNS records, deploy Workers, browse KV namespaces.",
      env: [{ name: "CLOUDFLARE_API_TOKEN", required: true }],
      docs: [{ label: "mcp-server-cloudflare", url: "https://www.npmjs.com/package/mcp-server-cloudflare" }],
    },
  },
  {
    id: "mcp-tavily",
    name: "MCP Tavily Search",
    category: "MCP",
    description: "AI-grade web search for agents via the tavily-mcp server.",
    icon: Globe,
    status: "one-click install",
    source: "community",
    install: {
      enabledSetting: "mcpTavilyEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpTavilyApiKey",
          setupUrl: "https://app.tavily.com/account/api-keys",
          setupLabel: "Create a Tavily API key",
          detail: "Tavily ships a generous free tier; the key is a `tvly-...` string.",
        },
        verify: [
          { kind: "command", command: "npm view tavily-mcp version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "tavily-mcp"],
            env: { TAVILY_API_KEY: "${mcpTavilyApiKey}" },
            label: "Launch MCP Tavily server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Tavily API key", setting: "mcpTavilyApiKey", required: true, secret: true, setupUrl: "https://app.tavily.com/account/api-keys" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a Tavily API key" },
      ],
    },
    agentGuide: {
      summary: "Web search optimised for LLM-grade context retrieval (snippet relevance + citations).",
      env: [{ name: "TAVILY_API_KEY", required: true }],
      docs: [{ label: "tavily-mcp", url: "https://www.npmjs.com/package/tavily-mcp" }],
    },
  },
  {
    id: "mcp-exa",
    name: "MCP Exa Search",
    category: "MCP",
    description: "Neural web search for agents via the exa-mcp-server package.",
    icon: Globe,
    status: "one-click install",
    source: "community",
    install: {
      enabledSetting: "mcpExaEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpExaApiKey",
          setupUrl: "https://dashboard.exa.ai/api-keys",
          setupLabel: "Create an Exa API key",
          detail: "Exa's neural search returns LLM-friendly chunks; key is required.",
        },
        verify: [
          { kind: "command", command: "npm view exa-mcp-server version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "exa-mcp-server"],
            env: { EXA_API_KEY: "${mcpExaApiKey}" },
            label: "Launch MCP Exa server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Exa API key", setting: "mcpExaApiKey", required: true, secret: true, setupUrl: "https://dashboard.exa.ai/api-keys" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste an Exa API key" },
      ],
    },
    agentGuide: {
      summary: "Neural web search and content retrieval; complements Tavily for multi-source agents.",
      env: [{ name: "EXA_API_KEY", required: true }],
      docs: [{ label: "exa-mcp-server", url: "https://www.npmjs.com/package/exa-mcp-server" }],
    },
  },
  {
    id: "mcp-firecrawl",
    name: "MCP Firecrawl",
    category: "MCP",
    description: "Crawl and structurally extract web content for agents via the firecrawl-mcp server.",
    icon: Globe,
    status: "one-click install",
    source: "community",
    install: {
      enabledSetting: "mcpFirecrawlEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpFirecrawlApiKey",
          setupUrl: "https://www.firecrawl.dev/app/api-keys",
          setupLabel: "Create a Firecrawl API key",
          detail: "Firecrawl key is a `fc-...` string. Free tier is enough to try.",
        },
        verify: [
          { kind: "command", command: "npm view firecrawl-mcp version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "firecrawl-mcp"],
            env: { FIRECRAWL_API_KEY: "${mcpFirecrawlApiKey}" },
            label: "Launch MCP Firecrawl server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Firecrawl API key", setting: "mcpFirecrawlApiKey", required: true, secret: true, setupUrl: "https://www.firecrawl.dev/app/api-keys" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a Firecrawl API key" },
      ],
    },
    agentGuide: {
      summary: "Crawl URLs, scrape pages, run structured extraction with schemas.",
      env: [{ name: "FIRECRAWL_API_KEY", required: true }],
      docs: [{ label: "firecrawl-mcp", url: "https://www.npmjs.com/package/firecrawl-mcp" }],
    },
  },
  {
    id: "mcp-hubspot",
    name: "MCP HubSpot",
    category: "MCP",
    description: "Inspect and update HubSpot contacts, deals, and companies via the official @hubspot/mcp-server package.",
    icon: ShoppingCart,
    status: "one-click install",
    source: "hubspot",
    install: {
      enabledSetting: "mcpHubspotEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpHubspotPrivateAppToken",
          setupUrl: "https://app.hubspot.com/private-apps",
          setupLabel: "Create a HubSpot private app",
          detail: "Use a private-app token with the scopes agents need (CRM read at minimum).",
        },
        verify: [
          { kind: "command", command: "npm view @hubspot/mcp-server version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@hubspot/mcp-server"],
            env: { PRIVATE_APP_ACCESS_TOKEN: "${mcpHubspotPrivateAppToken}" },
            label: "Launch MCP HubSpot server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "HubSpot private-app token", setting: "mcpHubspotPrivateAppToken", required: true, secret: true, setupUrl: "https://app.hubspot.com/private-apps" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a private-app token" },
      ],
    },
    agentGuide: {
      summary: "List + edit contacts, deals, companies, custom objects on HubSpot.",
      env: [{ name: "PRIVATE_APP_ACCESS_TOKEN", required: true }],
      docs: [{ label: "@hubspot/mcp-server", url: "https://www.npmjs.com/package/@hubspot/mcp-server" }],
    },
  },
  // Third wave (2026-04-28): scraping, vector DBs, alt. databases, sandboxes,
  // search engines. Same pattern; each npm package verified live.
  {
    id: "mcp-apify",
    name: "MCP Apify",
    category: "MCP",
    description: "Run Apify scraping actors and pull structured web data via @apify/actors-mcp-server.",
    icon: Globe,
    status: "one-click install",
    source: "apify",
    install: {
      enabledSetting: "mcpApifyEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpApifyToken",
          setupUrl: "https://console.apify.com/account/integrations",
          setupLabel: "Create an Apify API token",
          detail: "Apify API tokens look like `apify_api_...`. Use a least-privilege token.",
        },
        verify: [
          { kind: "command", command: "npm view @apify/actors-mcp-server version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@apify/actors-mcp-server"],
            env: { APIFY_TOKEN: "${mcpApifyToken}" },
            label: "Launch MCP Apify server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Apify token", setting: "mcpApifyToken", required: true, secret: true, setupUrl: "https://console.apify.com/account/integrations" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste an Apify token" },
      ],
    },
    agentGuide: {
      summary: "Run Apify Actors (web scrapers, LinkedIn, Google Maps, etc.) and inspect their datasets.",
      env: [{ name: "APIFY_TOKEN", required: true }],
      docs: [{ label: "@apify/actors-mcp-server", url: "https://www.npmjs.com/package/@apify/actors-mcp-server" }],
    },
  },
  {
    id: "mcp-pinecone",
    name: "MCP Pinecone",
    category: "MCP",
    description: "Vector search and upserts against Pinecone via the official @pinecone-database/mcp server.",
    icon: Database,
    status: "one-click install",
    source: "pinecone",
    install: {
      enabledSetting: "mcpPineconeEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpPineconeApiKey",
          setupUrl: "https://app.pinecone.io/organizations/-/projects/-/keys",
          setupLabel: "Create a Pinecone API key",
          detail: "Pinecone keys are project-scoped; pick the project containing the indexes agents should touch.",
        },
        verify: [
          { kind: "command", command: "npm view @pinecone-database/mcp version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@pinecone-database/mcp"],
            env: { PINECONE_API_KEY: "${mcpPineconeApiKey}" },
            label: "Launch MCP Pinecone server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Pinecone API key", setting: "mcpPineconeApiKey", required: true, secret: true, setupUrl: "https://app.pinecone.io/organizations/-/projects/-/keys" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a Pinecone API key" },
      ],
    },
    agentGuide: {
      summary: "List indexes, upsert vectors, run similarity queries, fetch namespace stats.",
      env: [{ name: "PINECONE_API_KEY", required: true }],
      docs: [{ label: "@pinecone-database/mcp", url: "https://www.npmjs.com/package/@pinecone-database/mcp" }],
    },
  },
  {
    id: "mcp-supabase",
    name: "MCP Supabase",
    category: "MCP",
    description: "Supabase project + database operations via the official @supabase/mcp-server-supabase server.",
    icon: Database,
    status: "one-click install",
    source: "supabase",
    install: {
      enabledSetting: "mcpSupabaseEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpSupabaseAccessToken",
          setupUrl: "https://supabase.com/dashboard/account/tokens",
          setupLabel: "Create a Supabase access token",
          detail: "Access tokens scope to your account; pair with a project ref when launching for safety.",
        },
        verify: [
          { kind: "command", command: "npm view @supabase/mcp-server-supabase version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@supabase/mcp-server-supabase"],
            env: { SUPABASE_ACCESS_TOKEN: "${mcpSupabaseAccessToken}" },
            label: "Launch MCP Supabase server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Supabase access token", setting: "mcpSupabaseAccessToken", required: true, secret: true, setupUrl: "https://supabase.com/dashboard/account/tokens" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a Supabase access token" },
      ],
    },
    agentGuide: {
      summary: "List projects, run SQL, manage tables, inspect storage buckets, generate types.",
      env: [{ name: "SUPABASE_ACCESS_TOKEN", required: true }],
      docs: [{ label: "@supabase/mcp-server-supabase", url: "https://www.npmjs.com/package/@supabase/mcp-server-supabase" }],
    },
  },
  {
    id: "mcp-twilio",
    name: "MCP Twilio",
    category: "MCP",
    description: "Send SMS, query call logs, and manage messaging via the alpha @twilio-alpha/mcp server.",
    icon: Smartphone,
    status: "one-click install",
    source: "twilio",
    install: {
      enabledSetting: "mcpTwilioEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpTwilioAccountSid",
          setupUrl: "https://console.twilio.com/",
          setupLabel: "Twilio Account SID + Auth Token",
          detail: "Paste your Account SID. Set the auth token via TWILIO_AUTH_TOKEN before launching.",
        },
        verify: [
          { kind: "command", command: "npm view @twilio-alpha/mcp version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@twilio-alpha/mcp"],
            env: {
              TWILIO_ACCOUNT_SID: "${mcpTwilioAccountSid}",
              TWILIO_AUTH_TOKEN: "${mcpTwilioAuthToken}",
            },
            label: "Launch MCP Twilio server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Twilio Account SID", setting: "mcpTwilioAccountSid", required: true, secret: true, setupUrl: "https://console.twilio.com/" },
        { label: "Twilio Auth Token", setting: "mcpTwilioAuthToken", required: true, secret: true },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste your Twilio credentials" },
      ],
    },
    agentGuide: {
      summary: "Send SMS / WhatsApp, list messages, manage phone numbers, inspect call records.",
      env: [{ name: "TWILIO_ACCOUNT_SID", required: true }, { name: "TWILIO_AUTH_TOKEN", required: true }],
      docs: [{ label: "@twilio-alpha/mcp", url: "https://www.npmjs.com/package/@twilio-alpha/mcp" }],
    },
  },
  {
    id: "mcp-confluence",
    name: "MCP Confluence",
    category: "MCP",
    description: "Search and edit Confluence pages via the mcp-confluence server (Atlassian Cloud).",
    icon: BookOpen,
    status: "one-click install",
    source: "atlassian",
    install: {
      enabledSetting: "mcpConfluenceEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpConfluenceApiToken",
          setupUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
          setupLabel: "Create an Atlassian API token",
          detail: "Atlassian Cloud uses email + API token + site URL. Set MCP_CONFLUENCE_URL and MCP_CONFLUENCE_USERNAME too.",
        },
        verify: [
          { kind: "command", command: "npm view mcp-confluence version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "mcp-confluence"],
            env: {
              CONFLUENCE_URL: "${mcpConfluenceUrl}",
              CONFLUENCE_USERNAME: "${mcpConfluenceUsername}",
              CONFLUENCE_API_TOKEN: "${mcpConfluenceApiToken}",
            },
            label: "Launch MCP Confluence server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Confluence site URL", setting: "mcpConfluenceUrl", required: true },
        { label: "Account email", setting: "mcpConfluenceUsername", required: true },
        { label: "API token", setting: "mcpConfluenceApiToken", required: true, secret: true, setupUrl: "https://id.atlassian.com/manage-profile/security/api-tokens" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste your Atlassian credentials" },
      ],
    },
    agentGuide: {
      summary: "Search pages, read content, create + edit pages on a Confluence Cloud site.",
      env: [
        { name: "CONFLUENCE_URL", required: true },
        { name: "CONFLUENCE_USERNAME", required: true },
        { name: "CONFLUENCE_API_TOKEN", required: true },
      ],
      docs: [{ label: "mcp-confluence", url: "https://www.npmjs.com/package/mcp-confluence" }],
    },
  },
  {
    id: "mcp-e2b",
    name: "MCP E2B Sandbox",
    category: "MCP",
    description: "Run code in disposable cloud sandboxes via the official @e2b/mcp-server.",
    icon: ServerCog,
    status: "one-click install",
    source: "e2b",
    install: {
      enabledSetting: "mcpE2bEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpE2bApiKey",
          setupUrl: "https://e2b.dev/dashboard?tab=keys",
          setupLabel: "Create an E2B API key",
          detail: "E2B keys are `e2b_...`. Sandboxes spin up on-demand and cost compute-minutes.",
        },
        verify: [
          { kind: "command", command: "npm view @e2b/mcp-server version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@e2b/mcp-server"],
            env: { E2B_API_KEY: "${mcpE2bApiKey}" },
            label: "Launch MCP E2B server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "E2B API key", setting: "mcpE2bApiKey", required: true, secret: true, setupUrl: "https://e2b.dev/dashboard?tab=keys" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste an E2B API key" },
      ],
    },
    agentGuide: {
      summary: "Spin up disposable cloud sandboxes; run Python/JS code with file IO and network access.",
      env: [{ name: "E2B_API_KEY", required: true }],
      docs: [{ label: "@e2b/mcp-server", url: "https://www.npmjs.com/package/@e2b/mcp-server" }],
    },
  },
  {
    id: "mcp-perplexity",
    name: "MCP Perplexity",
    category: "MCP",
    description: "Question-answering search via the perplexity-mcp server (Sonar API).",
    icon: Globe,
    status: "one-click install",
    source: "perplexity",
    install: {
      enabledSetting: "mcpPerplexityEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpPerplexityApiKey",
          setupUrl: "https://www.perplexity.ai/settings/api",
          setupLabel: "Create a Perplexity API key",
          detail: "Perplexity Sonar API key. Free tier covers light agent use.",
        },
        verify: [
          { kind: "command", command: "npm view perplexity-mcp version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "perplexity-mcp"],
            env: { PERPLEXITY_API_KEY: "${mcpPerplexityApiKey}" },
            label: "Launch MCP Perplexity server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Perplexity API key", setting: "mcpPerplexityApiKey", required: true, secret: true, setupUrl: "https://www.perplexity.ai/settings/api" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a Perplexity API key" },
      ],
    },
    agentGuide: {
      summary: "Run Sonar question-answering queries; great for fresh, citation-backed answers.",
      env: [{ name: "PERPLEXITY_API_KEY", required: true }],
      docs: [{ label: "perplexity-mcp", url: "https://www.npmjs.com/package/perplexity-mcp" }],
    },
  },
  {
    id: "mcp-neon",
    name: "MCP Neon",
    category: "MCP",
    description: "Manage Neon serverless Postgres projects + branches via the official @neondatabase/mcp-server-neon.",
    icon: Database,
    status: "one-click install",
    source: "neon",
    install: {
      enabledSetting: "mcpNeonEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpNeonApiKey",
          setupUrl: "https://console.neon.tech/app/settings/api-keys",
          setupLabel: "Create a Neon API key",
          detail: "Neon's serverless Postgres; the API key scopes to your account.",
        },
        verify: [
          { kind: "command", command: "npm view @neondatabase/mcp-server-neon version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@neondatabase/mcp-server-neon"],
            env: { NEON_API_KEY: "${mcpNeonApiKey}" },
            label: "Launch MCP Neon server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Neon API key", setting: "mcpNeonApiKey", required: true, secret: true, setupUrl: "https://console.neon.tech/app/settings/api-keys" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a Neon API key" },
      ],
    },
    agentGuide: {
      summary: "List + create Neon projects, manage branches, run SQL against branch databases.",
      env: [{ name: "NEON_API_KEY", required: true }],
      docs: [{ label: "@neondatabase/mcp-server-neon", url: "https://www.npmjs.com/package/@neondatabase/mcp-server-neon" }],
    },
  },
  {
    id: "mcp-playwright",
    name: "MCP Playwright",
    category: "MCP",
    description: "Browser automation for agents via the official @playwright/mcp server.",
    icon: Globe,
    status: "one-click install",
    source: "microsoft",
    install: {
      enabledSetting: "mcpPlaywrightEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        verify: [
          { kind: "command", command: "npm view @playwright/mcp version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@playwright/mcp"],
            label: "Launch MCP Playwright server",
          },
        ],
      },
    },
    onboarding: {
      variables: [],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Use it", detail: "No auth required; browses headless Chromium." },
      ],
    },
    agentGuide: {
      summary: "Browser automation: navigate, click, type, screenshot, evaluate JS — Playwright-grade.",
      docs: [{ label: "@playwright/mcp", url: "https://www.npmjs.com/package/@playwright/mcp" }],
    },
  },
  // Fourth wave (2026-04-28): hosting, observability, KV, music — last batch
  // for now. Each npm package verified live before this commit.
  {
    id: "mcp-replicate",
    name: "MCP Replicate",
    category: "MCP",
    description: "Run hosted ML models via Replicate's MCP server (replicate-mcp).",
    icon: ServerCog,
    status: "one-click install",
    source: "replicate",
    install: {
      enabledSetting: "mcpReplicateEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpReplicateApiToken",
          setupUrl: "https://replicate.com/account/api-tokens",
          setupLabel: "Create a Replicate API token",
          detail: "Replicate tokens look like `r8_...`. Pay-as-you-go; check pricing before launching big runs.",
        },
        verify: [
          { kind: "command", command: "npm view replicate-mcp version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "replicate-mcp"],
            env: { REPLICATE_API_TOKEN: "${mcpReplicateApiToken}" },
            label: "Launch MCP Replicate server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Replicate API token", setting: "mcpReplicateApiToken", required: true, secret: true, setupUrl: "https://replicate.com/account/api-tokens" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a Replicate API token" },
      ],
    },
    agentGuide: {
      summary: "List models, run predictions, fetch artifacts from Replicate's hosted catalog.",
      env: [{ name: "REPLICATE_API_TOKEN", required: true }],
      docs: [{ label: "replicate-mcp", url: "https://www.npmjs.com/package/replicate-mcp" }],
    },
  },
  {
    id: "mcp-vercel",
    name: "MCP Vercel",
    category: "MCP",
    description: "Manage Vercel deployments and projects via the vercel-mcp server.",
    icon: ServerCog,
    status: "one-click install",
    source: "community",
    install: {
      enabledSetting: "mcpVercelEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpVercelApiToken",
          setupUrl: "https://vercel.com/account/tokens",
          setupLabel: "Create a Vercel API token",
          detail: "Vercel personal access token; scope to specific teams/projects when possible.",
        },
        verify: [
          { kind: "command", command: "npm view vercel-mcp version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "vercel-mcp"],
            env: { VERCEL_TOKEN: "${mcpVercelApiToken}" },
            label: "Launch MCP Vercel server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Vercel API token", setting: "mcpVercelApiToken", required: true, secret: true, setupUrl: "https://vercel.com/account/tokens" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste a Vercel API token" },
      ],
    },
    agentGuide: {
      summary: "List + inspect Vercel deployments, projects, domains, env vars; trigger redeploys.",
      env: [{ name: "VERCEL_TOKEN", required: true }],
      docs: [{ label: "vercel-mcp", url: "https://www.npmjs.com/package/vercel-mcp" }],
    },
  },
  {
    id: "mcp-axiom",
    name: "MCP Axiom",
    category: "MCP",
    description: "Query Axiom logs and observability data via the axiom-mcp server.",
    icon: Activity,
    status: "one-click install",
    source: "axiom",
    install: {
      enabledSetting: "mcpAxiomEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpAxiomToken",
          setupUrl: "https://app.axiom.co/profile",
          setupLabel: "Create an Axiom API token",
          detail: "Axiom personal access token + org id. Read-only is enough for log queries.",
        },
        verify: [
          { kind: "command", command: "npm view axiom-mcp version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "axiom-mcp"],
            env: {
              AXIOM_TOKEN: "${mcpAxiomToken}",
              AXIOM_ORG_ID: "${mcpAxiomOrgId}",
            },
            label: "Launch MCP Axiom server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Axiom token", setting: "mcpAxiomToken", required: true, secret: true, setupUrl: "https://app.axiom.co/profile" },
        { label: "Axiom org id", setting: "mcpAxiomOrgId", required: false },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste your Axiom credentials" },
      ],
    },
    agentGuide: {
      summary: "Run APL queries against Axiom log streams; inspect dataset schemas; fetch monitor states.",
      env: [{ name: "AXIOM_TOKEN", required: true }],
      docs: [{ label: "axiom-mcp", url: "https://www.npmjs.com/package/axiom-mcp" }],
    },
  },
  {
    id: "mcp-upstash",
    name: "MCP Upstash",
    category: "MCP",
    description: "Manage Upstash Redis and queues via the official @upstash/mcp-server.",
    icon: Database,
    status: "one-click install",
    source: "upstash",
    install: {
      enabledSetting: "mcpUpstashEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpUpstashApiKey",
          setupUrl: "https://console.upstash.com/account/api",
          setupLabel: "Create an Upstash management API key",
          detail: "Upstash management API key + the email on the account.",
        },
        verify: [
          { kind: "command", command: "npm view @upstash/mcp-server version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "@upstash/mcp-server"],
            env: {
              UPSTASH_EMAIL: "${mcpUpstashEmail}",
              UPSTASH_API_KEY: "${mcpUpstashApiKey}",
            },
            label: "Launch MCP Upstash server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Upstash account email", setting: "mcpUpstashEmail", required: true },
        { label: "Upstash management API key", setting: "mcpUpstashApiKey", required: true, secret: true, setupUrl: "https://console.upstash.com/account/api" },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste your Upstash credentials" },
      ],
    },
    agentGuide: {
      summary: "List + create Upstash Redis databases, manage QStash queues, fetch usage stats.",
      env: [{ name: "UPSTASH_EMAIL", required: true }, { name: "UPSTASH_API_KEY", required: true }],
      docs: [{ label: "@upstash/mcp-server", url: "https://www.npmjs.com/package/@upstash/mcp-server" }],
    },
  },
  {
    id: "mcp-spotify",
    name: "MCP Spotify",
    category: "MCP",
    description: "Search and inspect Spotify catalog via the spotify-mcp server.",
    icon: MessageCircle,
    status: "one-click install",
    source: "community",
    install: {
      enabledSetting: "mcpSpotifyEnabled",
      storedFallback: false,
      plan: {
        preflight: [{ kind: "command", command: "command -v npx", label: "Detect npx" }],
        install: [],
        auth: {
          kind: "auth-paste",
          setting: "mcpSpotifyClientId",
          setupUrl: "https://developer.spotify.com/dashboard",
          setupLabel: "Create a Spotify Developer app",
          detail: "Spotify client id + client secret from a developer-dashboard app. Client-credentials flow only.",
        },
        verify: [
          { kind: "command", command: "npm view spotify-mcp version", timeoutSec: 60 },
        ],
        mcp: [
          {
            kind: "mcp-launch",
            command: "npx",
            args: ["-y", "spotify-mcp"],
            env: {
              SPOTIFY_CLIENT_ID: "${mcpSpotifyClientId}",
              SPOTIFY_CLIENT_SECRET: "${mcpSpotifyClientSecret}",
            },
            label: "Launch MCP Spotify server",
          },
        ],
      },
    },
    onboarding: {
      variables: [
        { label: "Spotify client id", setting: "mcpSpotifyClientId", required: true, secret: true, setupUrl: "https://developer.spotify.com/dashboard" },
        { label: "Spotify client secret", setting: "mcpSpotifyClientSecret", required: true, secret: true },
      ],
      steps: [
        { title: "Install the server", completeWhen: { type: "installed" } },
        { title: "Paste your Spotify Developer credentials" },
      ],
    },
    agentGuide: {
      summary: "Search tracks/artists/albums/playlists, fetch audio features, browse genres.",
      env: [{ name: "SPOTIFY_CLIENT_ID", required: true }, { name: "SPOTIFY_CLIENT_SECRET", required: true }],
      docs: [{ label: "spotify-mcp", url: "https://www.npmjs.com/package/spotify-mcp" }],
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
