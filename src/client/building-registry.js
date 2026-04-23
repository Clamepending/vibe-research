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
  Handshake,
  Inbox,
  Lightbulb,
  Mail,
  MessageCircle,
  MessagesSquare,
  Notebook,
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
        { name: "VIBE_RESEARCH_AGENT_TOWN_API", detail: "Base URL for the local Agent Town API, such as http://127.0.0.1:4123/api/agent-town." },
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
        { label: "List app ports", command: "curl -s http://127.0.0.1:${VIBE_RESEARCH_PORT:-4123}/api/ports -H 'X-Vibe-Research-API: 1'", detail: "Use the current app port when known; browser UI usually exposes ports directly." },
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
        { title: "Read the map", detail: "Understand buildings, Library memory, settings, occupations, automations, and communications before adding new surfaces." },
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
        { label: "Read current metrics", command: "curl -s http://127.0.0.1:${VIBE_RESEARCH_PORT:-4123}/api/system -H 'X-Vibe-Research-API: 1'", detail: "Shows current storage, CPU, memory, GPU, accelerator, and agent usage metrics." },
        { label: "Read one-hour history", command: "curl -s 'http://127.0.0.1:${VIBE_RESEARCH_PORT:-4123}/api/system/history?range=1h' -H 'X-Vibe-Research-API: 1'", detail: "Shows the sampled history backing the System charts." },
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
    status: "connector-ready",
    source: "external",
    visual: {
      shape: "studio",
    },
    access: {
      label: "Weights & Biases API",
      detail: "Requires WANDB_API_KEY or an existing wandb login where the agent runs, plus explicit entity/project scope for experiment logging.",
    },
    onboarding: {
      variables: [
        { label: "W&B API key", value: "WANDB_API_KEY in agent environment", required: true },
        { label: "Entity / project", value: "wandb entity and project name", required: true },
        { label: "Artifact policy", value: "run URLs, configs, checkpoints, tables, and plots", required: false },
      ],
      steps: [
        { title: "Authenticate wandb", detail: "Log in or provide WANDB_API_KEY in the environment used by the training agent." },
        { title: "Declare the project", detail: "Tell agents which entity/project to log to before long runs start." },
        { title: "Install the building", detail: "Add W&B to Agent Town once experiment logging is configured.", completeWhen: { type: "installed" } },
      ],
    },
  },
  {
    id: "modal",
    name: "Modal",
    category: "Cloud Compute",
    description: "Run serverless Python apps, batch jobs, sandboxes, and GPU-backed workloads on Modal.",
    icon: CloudCog,
    status: "CLI install required",
    source: "external",
    visual: {
      shape: "lab",
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
        "Compare CLI agents such as Codex, Claude Code, Gemini CLI, OpenHands, or a custom Harbor agent import.",
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
    name: "Occupations",
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
      detail: "Uses the local Occupations prompt store and syncs managed instructions into AGENTS.md, CLAUDE.md, and GEMINI.md so Codex, Claude, OpenClaw, Gemini, and OpenCode sessions receive the same role guidance.",
    },
    agentGuide: {
      summary: "Use Occupations when an agent needs to inspect or explain the shared role prompt that will be injected into new sessions.",
      useCases: [
        "Check which occupation is selected before starting a new agent.",
        "Inspect the managed prompt source and synced AGENTS.md, CLAUDE.md, and GEMINI.md files.",
        "Diagnose prompt sync conflicts without writing secrets or credentials into managed instruction files.",
      ],
      commands: [
        { label: "Read current occupation", command: "curl -s http://127.0.0.1:${VIBE_RESEARCH_PORT:-4123}/api/agent-prompt -H 'X-Vibe-Research-API: 1'", detail: "Shows the selected occupation, source path, and managed target files." },
        { label: "Open prompt source", command: "sed -n '1,220p' \"$VIBE_RESEARCH_AGENT_PROMPT_PATH\"", detail: "Read the active prompt file from the agent environment when available." },
      ],
      env: [
        { name: "VIBE_RESEARCH_AGENT_PROMPT_PATH", detail: "Path to the active Occupations prompt file for this session." },
      ],
    },
    onboarding: {
      variables: [
        { label: "Selected occupation", value: "Researcher, Engineer, or Custom", required: true },
        { label: "Prompt source", value: ".vibe-research/agent-prompt.md", required: true },
        { label: "Managed files", value: "AGENTS.md, CLAUDE.md, GEMINI.md", required: true },
      ],
      steps: [
        { title: "Choose an occupation", detail: "Pick the role prompt that should shape newly launched agents.", completeWhen: { type: "installed" } },
        { title: "Edit custom guidance", detail: "Use the custom occupation when the built-in researcher or engineer prompt needs project-specific instructions." },
        { title: "Review managed files", detail: "Check conflicts before overwriting AGENTS.md, CLAUDE.md, or GEMINI.md." },
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
        { label: "Local catalog", setting: "buildingHubCatalogPath", required: false },
        { label: "Remote catalog", setting: "buildingHubCatalogUrl", required: false },
        { label: "Theme catalog", value: "default, snowy, desert", required: true },
        { label: "Theme persistence", value: "browser local storage", required: true },
      ],
      steps: [
        { title: "Open BuildingHub", detail: "Use the BuildingHub building for the local building catalog.", completeWhen: { type: "installed" } },
        { title: "Pick a town theme", detail: "Choose the Agent Town skin from BuildingHub.", completeWhen: { type: "installed" } },
        { title: "Enable community catalogs", detail: "Turn on reviewed community catalog loading only when you want shared manifest-only buildings.", completeWhen: { setting: "buildingHubEnabled" } },
        {
          title: "Choose a source",
          detail: "Point Vibe Research at a local BuildingHub checkout or a reviewed registry JSON URL.",
          completeWhen: { anyConfigured: ["buildingHubCatalogPath", "buildingHubCatalogUrl"] },
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
    },
    status: "setup available",
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
    visual: {
      shape: "camera",
      specialTownPlace: true,
    },
    agentGuide: {
      summary: "Use VideoMemory when an agent needs a camera or video monitor that can wake a Vibe Research session later.",
      useCases: [
        "Create a monitor that watches a browser/camera condition and wakes an agent.",
        "Check whether camera permission or service URL setup is blocking monitors.",
        "Record monitor IDs, task URLs, and artifact paths in the Library when they matter.",
      ],
      commands: [
        { label: "Start a monitor", command: "vr-videomemory --help", detail: "Read helper options before creating a monitor." },
        { label: "Read VideoMemory guide", command: "sed -n '1,220p' \"$VIBE_RESEARCH_BUILDING_GUIDES_DIR/videomemory.md\"", detail: "Review setup and camera permission expectations first." },
      ],
      env: [
        { name: "VIBE_RESEARCH_VIDEOMEMORY_COMMAND", detail: "Canonical helper command for local agents." },
      ],
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
    agentGuide: {
      summary: "Use Localhost Apps when an agent needs to discover, rename, preview, or expose web apps running from the workspace.",
      useCases: [
        "Find development servers discovered by Vibe Research.",
        "Preview a local app through the Vibe Research proxy or direct URL.",
        "Expose eligible localhost-only ports through the Tailscale portal when available.",
      ],
      commands: [
        { label: "List discovered ports", command: "curl -s http://127.0.0.1:${VIBE_RESEARCH_PORT:-4123}/api/ports -H 'X-Vibe-Research-API: 1'", detail: "Use the runtime app port if it differs from 4123." },
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
