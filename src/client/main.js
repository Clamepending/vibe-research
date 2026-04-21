import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "xterm-addon-canvas";
import {
  AppWindow,
  ArrowUp,
  BookOpen,
  Bot,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Cpu,
  Database,
  File,
  FilePenLine,
  FileText,
  Folder,
  FolderCog,
  FolderPlus,
  FolderOpen,
  FolderUp,
  GitPullRequest,
  GitFork,
  Gpu,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Mail,
  MemoryStick,
  Menu,
  MessageSquarePlus,
  PanelLeftClose,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  Settings,
  Trash2,
  Type,
  Waypoints,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide";

const app = document.querySelector("#app");
const TOUCH_TAP_SLOP_PX = 10;
const KNOWLEDGE_BASE_GRAPH_WIDTH = 920;
const KNOWLEDGE_BASE_GRAPH_HEIGHT = 680;
const KNOWLEDGE_BASE_GRAPH_MIN_SCALE = 0.35;
const KNOWLEDGE_BASE_GRAPH_MAX_SCALE = 2.8;
const KNOWLEDGE_BASE_GRAPH_FIT_PADDING = 72;
const KNOWLEDGE_BASE_GRAPH_FOCUS_SCALE = 1.65;
const KNOWLEDGE_BASE_GRAPH_DRAG_SLOP_PX = 6;
const KNOWLEDGE_BASE_GRAPH_PROJECT_PREFIX = "project:";
const KNOWLEDGE_BASE_GRAPH_PHYSICS = Object.freeze({
  alphaDecay: 0.972,
  alphaCooling: 0.0018,
  stopAlpha: 0.018,
  stopVelocity: 0.045,
  damping: 0.9,
  dragDamping: 0.82,
  dragAlphaTarget: 0.32,
  centerStrength: 0.0018,
  groupAnchorStrength: 0.01,
  projectAnchorStrength: 0.014,
  sameGroupMinimumGap: 38,
  otherGroupMinimumGap: 68,
  sameGroupRepulsionBase: 3600,
  otherGroupRepulsionBase: 7600,
  sameGroupRepulsionRadius: 175,
  otherGroupRepulsionRadius: 285,
  sameGroupCollisionPush: 0.22,
  otherGroupCollisionPush: 0.34,
  sameGroupLinkDistance: 62,
  otherGroupLinkDistance: 118,
  sameGroupLinkRadius: 2.6,
  otherGroupLinkRadius: 3.6,
  sameGroupLinkStrength: 0.015,
  otherGroupLinkStrength: 0.0075,
  linkDegreeStrength: 0.00052,
  maxVelocity: 15,
  maxDragVelocity: 24,
  boundaryMargin: 58,
  boundaryStrength: 0.014,
  maxAlpha: 0.58,
});
const KNOWLEDGE_BASE_BM25_K1 = 1.2;
const KNOWLEDGE_BASE_BM25_B = 0.75;
const KNOWLEDGE_BASE_SEARCH_PREFIX_MIN_LENGTH = 2;
const KNOWLEDGE_BASE_SEARCH_FIELD_WEIGHTS = [
  ["title", 3],
  ["relativePath", 2],
  ["excerpt", 1.4],
  ["searchText", 1],
];
const PORT_PREVIEW_TAB_PREFIX = "port:";
const ROUTED_MAIN_VIEWS = new Set(["search", "plugins", "automations", "system", "swarm", "browser-use"]);
const SESSION_WORKING_SPINNER_MS = 900;
const FILE_IMAGE_MIN_ZOOM = 1;
const FILE_IMAGE_MAX_ZOOM = 8;
const FILE_IMAGE_ZOOM_STEP = 0.25;
const TERMINAL_FILE_PREVIEW_DELAY_MS = 220;
const TERMINAL_FILE_PREVIEW_TEXT_MAX_CHARS = 3600;
const TERMINAL_IMAGE_PATH_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);
const KNOWLEDGE_BASE_IMAGE_EXTENSIONS = TERMINAL_IMAGE_PATH_EXTENSIONS;
const KNOWLEDGE_BASE_VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".ogv", ".webm"]);
const KNOWLEDGE_BASE_AUDIO_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav", ".weba"]);
const TERMINAL_FILE_PATH_PATTERN = /(^|[\s"'`(<[{])((?:\\.|[^\s"'`<>()[\]{}|])+)(?=$|[\s"'`<>()[\]{}|])/gi;
const FOLDER_PICKER_DRAG_MARGIN_PX = 12;
const SYSTEM_HISTORY_REFRESH_MS = 30_000;
const PORTS_BACKGROUND_REFRESH_MS = 30_000;
const SELECTION_REFRESH_RETRY_MS = 250;
const MOBILE_KEYBOARD_RESIZE_THRESHOLD_PX = 80;
const MOBILE_KEYBOARD_SETTLE_MS = 650;
const TERMINAL_WEBSOCKET_RECONNECT_BASE_MS = 300;
const TERMINAL_WEBSOCKET_RECONNECT_MAX_MS = 4_000;
const TERMINAL_TRANSCRIPT_RAW_LIMIT = 2_000_000;
const TERMINAL_TRANSCRIPT_RENDER_LIMIT = 600_000;
const TERMINAL_THEME = {
  background: "#090b0d",
  foreground: "#f3efe8",
  cursor: "#6ae3c6",
  black: "#111315",
  red: "#ff7f79",
  green: "#6ae3c6",
  yellow: "#f0c674",
  blue: "#8fb9ff",
  magenta: "#d3a6ff",
  cyan: "#7fe0d4",
  white: "#f3efe8",
  brightBlack: "#6a7176",
  brightRed: "#ff9f99",
  brightGreen: "#8ff1d8",
  brightYellow: "#f6d58e",
  brightBlue: "#add0ff",
  brightMagenta: "#e2c2ff",
  brightCyan: "#a6efe6",
  brightWhite: "#ffffff",
};
const TERMINAL_TRANSCRIPT_BASIC_COLOR_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
];
const REMOTE_VIBES_SYSTEM_FOLDER_NAME = "remote-vibes-system";
const SYSTEM_CHART_WIDTH = 560;
const SYSTEM_CHART_HEIGHT = 150;
const SYSTEM_HISTORY_RANGES = [
  { id: "1h", label: "last hour", title: "last hour" },
  { id: "1d", label: "last day", title: "last day" },
  { id: "1w", label: "last week", title: "last week" },
];
const SYSTEM_CHART_COLORS = [
  "#f4f4f5",
  "#c7c9d1",
  "#9da1ad",
  "#d8d9de",
  "#aeb4c0",
  "#e6e1d8",
  "#b9c3cc",
  "#f0f0f2",
  "#a8adb7",
  "#d1d3da",
  "#bfc7d0",
  "#ececef",
];
const PLUGIN_CATALOG = [
  {
    id: "github",
    name: "GitHub",
    category: "Coding",
    description: "Triage PRs, inspect issues, and publish changes from agent sessions.",
    icon: GitPullRequest,
    status: "available in Codex",
    source: "plugin",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    category: "Knowledge",
    description: "Search Docs, Sheets, Slides, and shared project files when the host agent supports it.",
    icon: Database,
    status: "MCP-ready",
    source: "mcp",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    category: "Planning",
    description: "Look up events and availability from connected agent tooling.",
    icon: CalendarDays,
    status: "MCP-ready",
    source: "mcp",
  },
  {
    id: "browser-use",
    name: "Browser Use",
    category: "Remote Vibes",
    description: "Start an OttoAuth browser fulfillment agent from a coding-agent session.",
    icon: Bot,
    status: "setup available",
    source: "remote-vibes",
  },
  {
    id: "agentmail",
    name: "AgentMail",
    category: "Communication",
    description: "Give Remote Vibes an email inbox and wake a Claude session when mail arrives.",
    icon: Mail,
    status: "setup available",
    source: "remote-vibes",
  },
  {
    id: "localhost-apps",
    name: "Localhost Apps",
    category: "Remote Vibes",
    description: "Preview web apps from discovered ports without leaving the current session.",
    icon: AppWindow,
    status: "built in",
    source: "remote-vibes",
  },
  {
    id: "knowledge-base",
    name: "Knowledge Base",
    category: "Remote Vibes",
    description: "Search and edit the shared markdown wiki that agents receive in their prompt.",
    icon: BookOpen,
    status: "built in",
    source: "remote-vibes",
  },
];
const AUTOMATION_CADENCE_OPTIONS = [
  ["hourly", "Every hour"],
  ["six-hours", "Every 6 hours"],
  ["daily", "Daily"],
  ["weekday", "Weekdays"],
  ["weekly", "Weekly"],
];
const AUTOMATION_WEEKDAY_OPTIONS = [
  ["monday", "Monday"],
  ["tuesday", "Tuesday"],
  ["wednesday", "Wednesday"],
  ["thursday", "Thursday"],
  ["friday", "Friday"],
  ["saturday", "Saturday"],
  ["sunday", "Sunday"],
];
const KNOWLEDGE_BASE_GRAPH_COLOR_PALETTE = [
  {
    fill: "rgba(104, 227, 199, 0.66)",
    stroke: "rgba(104, 227, 199, 0.92)",
    label: "#dffaf2",
    connectedFill: "rgba(104, 227, 199, 0.82)",
    connectedStroke: "rgba(104, 227, 199, 0.98)",
    edge: "rgba(104, 227, 199, 0.22)",
  },
  {
    fill: "rgba(112, 175, 255, 0.64)",
    stroke: "rgba(112, 175, 255, 0.9)",
    label: "#d9e8ff",
    connectedFill: "rgba(112, 175, 255, 0.8)",
    connectedStroke: "rgba(112, 175, 255, 0.96)",
    edge: "rgba(112, 175, 255, 0.2)",
  },
  {
    fill: "rgba(243, 195, 106, 0.64)",
    stroke: "rgba(243, 195, 106, 0.9)",
    label: "#fff0c8",
    connectedFill: "rgba(243, 195, 106, 0.8)",
    connectedStroke: "rgba(243, 195, 106, 0.96)",
    edge: "rgba(243, 195, 106, 0.2)",
  },
  {
    fill: "rgba(255, 150, 118, 0.64)",
    stroke: "rgba(255, 150, 118, 0.9)",
    label: "#ffe1d8",
    connectedFill: "rgba(255, 150, 118, 0.8)",
    connectedStroke: "rgba(255, 150, 118, 0.96)",
    edge: "rgba(255, 150, 118, 0.2)",
  },
  {
    fill: "rgba(154, 214, 127, 0.62)",
    stroke: "rgba(154, 214, 127, 0.88)",
    label: "#ebffd8",
    connectedFill: "rgba(154, 214, 127, 0.78)",
    connectedStroke: "rgba(154, 214, 127, 0.94)",
    edge: "rgba(154, 214, 127, 0.2)",
  },
  {
    fill: "rgba(246, 138, 182, 0.62)",
    stroke: "rgba(246, 138, 182, 0.88)",
    label: "#ffe0ec",
    connectedFill: "rgba(246, 138, 182, 0.78)",
    connectedStroke: "rgba(246, 138, 182, 0.94)",
    edge: "rgba(246, 138, 182, 0.2)",
  },
  {
    fill: "rgba(190, 155, 255, 0.62)",
    stroke: "rgba(190, 155, 255, 0.9)",
    label: "#ece2ff",
    connectedFill: "rgba(190, 155, 255, 0.8)",
    connectedStroke: "rgba(190, 155, 255, 0.96)",
    edge: "rgba(190, 155, 255, 0.2)",
  },
  {
    fill: "rgba(96, 210, 255, 0.6)",
    stroke: "rgba(96, 210, 255, 0.88)",
    label: "#d7f5ff",
    connectedFill: "rgba(96, 210, 255, 0.78)",
    connectedStroke: "rgba(96, 210, 255, 0.96)",
    edge: "rgba(96, 210, 255, 0.2)",
  },
  {
    fill: "rgba(255, 126, 146, 0.62)",
    stroke: "rgba(255, 126, 146, 0.9)",
    label: "#ffe0e6",
    connectedFill: "rgba(255, 126, 146, 0.8)",
    connectedStroke: "rgba(255, 126, 146, 0.96)",
    edge: "rgba(255, 126, 146, 0.2)",
  },
  {
    fill: "rgba(201, 226, 90, 0.6)",
    stroke: "rgba(201, 226, 90, 0.88)",
    label: "#f5ffd0",
    connectedFill: "rgba(201, 226, 90, 0.78)",
    connectedStroke: "rgba(201, 226, 90, 0.96)",
    edge: "rgba(201, 226, 90, 0.2)",
  },
];
const LIKELY_TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".graphql",
  ".h",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const LIKELY_TEXT_FILENAMES = new Set([
  ".gitignore",
  ".npmrc",
  ".prettierignore",
  ".prettierrc",
  "dockerfile",
  "makefile",
  "readme",
  "readme.md",
]);
const SESSION_READ_STORAGE_KEY = "remote-vibes-session-read-at-v1";
const LAYOUT_STORAGE_KEY = "remote-vibes-layout-v1";
const SIDEBAR_DEFAULT_WIDTH = 276;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_COLLAPSED_RAIL_WIDTH = 0;
const WORKSPACE_FILE_PREVIEW_DEFAULT_WIDTH = 460;
const WORKSPACE_FILE_PREVIEW_MIN_WIDTH = 280;
const WORKSPACE_TERMINAL_MIN_WIDTH = 320;
const LAYOUT_RESIZE_KEYBOARD_STEP = 16;

function loadSessionReadState() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SESSION_READ_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([sessionId, timestamp]) => [sessionId, Number(timestamp)])
        .filter(([sessionId, timestamp]) => sessionId && Number.isFinite(timestamp) && timestamp > 0),
    );
  } catch {
    return {};
  }
}

function saveSessionReadState() {
  try {
    window.localStorage.setItem(SESSION_READ_STORAGE_KEY, JSON.stringify(state.sessionReadAt));
  } catch {
    // Read state is a UI nicety; private browsing/storage failures should not block sessions.
  }
}

function getStoredLayoutNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function loadLayoutPreferences() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return {
      sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
      sidebarWidth: getStoredLayoutNumber(parsed.sidebarWidth, SIDEBAR_DEFAULT_WIDTH),
      filePreviewWidth: getStoredLayoutNumber(parsed.filePreviewWidth, WORKSPACE_FILE_PREVIEW_DEFAULT_WIDTH),
    };
  } catch {
    return {};
  }
}

const layoutPreferences = loadLayoutPreferences();

const state = {
  providers: [],
  sessionProviderPickerGlobalListenersBound: false,
  sessions: [],
  sessionReadAt: loadSessionReadState(),
  sessionsRefreshDeferred: false,
  deferredSelectableRefreshes: new Set(),
  deferredSelectableRefreshTimer: null,
  ports: [],
  portsLoadedAt: 0,
  currentView: "shell",
  globalSearchQuery: "",
  pluginSearchQuery: "",
  pluginInstallActions: {},
  brainSetupCloneUrl: "",
  brainSetupClonePath: "",
  brainSetupCloning: false,
  brainSetupError: "",
  agentPrompt: "",
  agentPromptPath: "",
  agentPromptWikiRoot: ".remote-vibes/wiki",
  agentPromptTargets: [],
  swarmGraph: {
    sessionId: null,
    projectCwd: "",
    projectFallbackSessionId: "",
    projectName: "",
    loading: false,
    error: "",
    data: null,
  },
  browserUseSession: {
    id: "",
    loading: false,
    error: "",
    data: null,
  },
  settings: {
    agentMailApiKeyConfigured: false,
    agentMailClientId: "",
    agentMailDisplayName: "Remote Vibes",
    agentMailDomain: "",
    agentMailEnabled: false,
    agentMailInboxId: "",
    agentMailMode: "websocket",
    agentMailProviderId: "claude",
    agentMailStatus: null,
    agentMailUsername: "",
    agentAutomations: [],
    browserUseAnthropicApiKeyConfigured: false,
    browserUseBrowserPath: "",
    browserUseEnabled: false,
    browserUseHeadless: true,
    browserUseKeepTabs: false,
    browserUseMaxTurns: 50,
    browserUseModel: "",
    browserUseProfileDir: "",
    browserUseStatus: null,
    browserUseWorkerPath: "",
    installedPluginIds: [],
    preventSleepEnabled: true,
    sleepPrevention: null,
    wikiPath: "",
    wikiPathConfigured: false,
    wikiRelativeRoot: ".remote-vibes/wiki",
    wikiGitBackupEnabled: true,
    wikiGitRemoteBranch: "main",
    wikiGitRemoteEnabled: true,
    wikiGitRemoteName: "origin",
    wikiGitRemoteUrl: "",
    wikiBackupIntervalMs: 5 * 60 * 1000,
    wikiBackup: null,
  },
  folderPicker: {
    open: false,
    target: "",
    root: "",
    path: "",
    currentPath: "",
    parentPath: "",
    entries: [],
    treeEntries: {},
    treeExpanded: new Set([""]),
    treeLoading: new Set(),
    treeErrors: {},
    requestId: 0,
    loading: false,
    error: "",
    position: null,
  },
  sessionProjectExpanded: new Set(),
  sessionProjectInteractionSeen: false,
  sessionListInteractionUntil: 0,
  sessionRefreshFlushTimer: null,
  sessionProjectSuppressClickKey: "",
  sessionProjectSuppressClickUntil: 0,
  filesRootOverride: null,
  filesRoot: "",
  fileTreeEntries: {},
  fileTreeExpanded: new Set([""]),
  fileTreeLoading: new Set(),
  fileTreeError: "",
  openFileTabs: [],
  knowledgeBase: {
    rootPath: "",
    relativeRoot: ".remote-vibes/wiki",
    notes: [],
    edges: [],
    loading: false,
    error: "",
    selectedNotePath: "",
    selectedNoteTitle: "",
    selectedNoteContent: "",
    selectedNoteDraft: "",
    selectedNoteEditing: false,
    selectedNoteLoading: false,
    selectedNoteSaving: false,
    selectedNoteError: "",
    selectedNoteRequestId: 0,
    searchQuery: "",
    noteCache: {},
    pendingGraphFocusPath: "",
    replayGraphOnNextBind: false,
    graphLayout: {
      width: KNOWLEDGE_BASE_GRAPH_WIDTH,
      height: KNOWLEDGE_BASE_GRAPH_HEIGHT,
      nodes: [],
      edges: [],
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      alpha: 0,
      running: false,
      frameHandle: 0,
      dragState: null,
      panState: null,
      refs: null,
      cleanup: null,
      cameraInitialized: false,
    },
  },
  openFileRelativePath: "",
  openFileName: "",
  openFileStatus: "idle",
  openFileContent: "",
  openFileDraft: "",
  openFileMessage: "",
  openFileSaving: false,
  openFileRequestId: 0,
  activeSessionId: null,
  connectedSessionId: null,
  defaultCwd: "",
  defaultProviderId: "claude",
  websocket: null,
  websocketReconnectTimer: null,
  websocketReconnectAttempts: 0,
  websocketReconnectSessionId: "",
  terminal: null,
  fitAddon: null,
  terminalFileLinkDisposable: null,
  pollTimer: null,
  resizeBound: false,
  mobileSidebar: null,
  sidebarCollapsed: Boolean(layoutPreferences.sidebarCollapsed),
  sidebarWidth: layoutPreferences.sidebarWidth || SIDEBAR_DEFAULT_WIDTH,
  filePreviewWidth: layoutPreferences.filePreviewWidth || WORKSPACE_FILE_PREVIEW_DEFAULT_WIDTH,
  terminalResizeObserver: null,
  terminalSelectionDisposable: null,
  terminalFitFrame: null,
  terminalResizeScrollAnchor: null,
  terminalResizeScrollAnchorUntil: 0,
  pendingTerminalOutput: "",
  pendingTerminalScrollToBottom: false,
  terminalOutputFrame: null,
  terminalTranscriptRaw: "",
  terminalTranscriptRenderFrame: null,
  terminalTranscriptScrollToBottom: false,
  terminalTranscriptVisible: false,
  terminalComposing: false,
  terminalTextareaResetTimer: null,
  update: null,
  updateApplying: false,
  lastUpdateError: null,
  systemMetrics: null,
  systemMetricHistory: [],
  systemHistoryRange: "1h",
  systemHistoryMeta: null,
  systemHistoryLoading: false,
  systemHistoryError: "",
  systemHistoryLoadedAt: 0,
  systemHistoryRequestId: 0,
  systemMetricsLoading: false,
  systemMetricsError: "",
  systemMetricsRequestId: 0,
  updateTimer: null,
  settingsPollTimer: null,
  sessionRefreshTimer: null,
  systemToastDismissedKeys: new Set(),
  terminalInteractionCleanup: null,
  canvasAddon: null,
  terminalShowJumpToBottom: false,
  lastVisualViewportHeight: 0,
  mobileKeyboardSettlingUntil: 0,
  preferredBaseUrl: "",
};

function saveLayoutPreferences() {
  try {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
        filePreviewWidth: state.filePreviewWidth,
      }),
    );
  } catch {
    // Layout preferences are optional; the app should keep working without storage.
  }
}

let knowledgeBaseSearchIndexCache = {
  notes: null,
  index: null,
};

let knowledgeBaseSearchResultsCache = {
  notes: null,
  query: "",
  results: null,
};

function getRouteState() {
  const url = new URL(window.location.href);
  const explicitView = url.searchParams.get("view");
  const root = normalizeWorkspaceRoot(url.searchParams.get("root") || "");
  const path = normalizeFileTreePath(url.searchParams.get("path") || "");

  if (explicitView === "knowledge-base") {
    return {
      view: "knowledge-base",
      root,
      path: "",
      notePath: normalizeFileTreePath(url.searchParams.get("note") || ""),
    };
  }

  if (explicitView === "agent-prompt") {
    return {
      view: "agent-prompt",
      root,
      path: "",
      notePath: "",
    };
  }

  if (ROUTED_MAIN_VIEWS.has(explicitView)) {
    return {
      view: explicitView,
      root,
      path: "",
      notePath: "",
    };
  }

  if (explicitView === "file") {
    return {
      view: "file",
      root,
      path,
      notePath: "",
    };
  }

  return {
    view: "shell",
    root,
    path,
    notePath: "",
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderIconAttributes(attributes = {}) {
  return Object.entries(attributes)
    .map(([key, value]) => `${escapeHtml(key)}="${escapeHtml(value)}"`)
    .join(" ");
}

function renderIconNode([tagName, attributes]) {
  return `<${escapeHtml(tagName)} ${renderIconAttributes(attributes)}></${escapeHtml(tagName)}>`;
}

function renderIcon(icon, { className = "rv-icon" } = {}) {
  if (!Array.isArray(icon)) {
    return "";
  }

  return `
    <svg
      class="${escapeHtml(className)}"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >${icon.map(renderIconNode).join("")}</svg>
  `;
}

function tooltipAttributes(label, placement = "top") {
  return `data-tooltip="${escapeHtml(label)}" data-tooltip-placement="${escapeHtml(placement)}"`;
}

function getEditorLineCount(value) {
  return Math.max(1, String(value ?? "").split("\n").length);
}

function renderEditorLineNumbers(value) {
  return Array.from({ length: getEditorLineCount(value) }, (_, index) => String(index + 1)).join("\n");
}

function renderLineNumberEditor({
  id,
  className,
  value,
  name = "",
  variant = "default",
  attributes = "",
}) {
  const nameAttribute = name ? ` name="${escapeHtml(name)}"` : "";

  return `
    <div class="line-number-editor line-number-editor-${escapeHtml(variant)}" data-line-number-editor>
      <pre class="line-number-gutter" aria-hidden="true">${renderEditorLineNumbers(value)}</pre>
      <textarea
        class="${escapeHtml(className)}"
        id="${escapeHtml(id)}"
        ${nameAttribute}
        wrap="off"
        data-line-number-textarea
        ${attributes}
      >${escapeHtml(value)}</textarea>
    </div>
  `;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getViewportWidth() {
  return Math.max(0, window.innerWidth || document.documentElement?.clientWidth || 0);
}

function getSidebarWidthBounds() {
  const viewportWidth = getViewportWidth();
  const viewportMax = viewportWidth > 0 ? viewportWidth - 440 : SIDEBAR_MAX_WIDTH;
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportMax));
  return { min: SIDEBAR_MIN_WIDTH, max };
}

function getSidebarWidth() {
  const { min, max } = getSidebarWidthBounds();
  return Math.round(clamp(Number(state.sidebarWidth) || SIDEBAR_DEFAULT_WIDTH, min, max));
}

function getWorkspaceFilePreviewBounds(split = document.querySelector("#workspace-split")) {
  const splitWidth = split instanceof HTMLElement ? split.getBoundingClientRect().width : getViewportWidth();
  const available = Math.max(0, splitWidth - WORKSPACE_TERMINAL_MIN_WIDTH - 12);
  const max = Math.max(WORKSPACE_FILE_PREVIEW_MIN_WIDTH, available || WORKSPACE_FILE_PREVIEW_DEFAULT_WIDTH);
  return { min: Math.min(WORKSPACE_FILE_PREVIEW_MIN_WIDTH, max), max };
}

function getWorkspaceFilePreviewWidth(split = document.querySelector("#workspace-split")) {
  const { min, max } = getWorkspaceFilePreviewBounds(split);
  return Math.round(clamp(Number(state.filePreviewWidth) || WORKSPACE_FILE_PREVIEW_DEFAULT_WIDTH, min, max));
}

function renderAppShellStyle() {
  return `--sidebar-width: ${getSidebarWidth()}px; --sidebar-rail-width: ${SIDEBAR_COLLAPSED_RAIL_WIDTH}px;`;
}

function renderWorkspaceSplitStyle() {
  return `--file-preview-width: ${getWorkspaceFilePreviewWidth()}px;`;
}

function renderSidebarToggleButton() {
  const label = state.sidebarCollapsed ? "Open sidebar" : "Collapse sidebar";
  return `
    <button
      class="icon-button sidebar-layout-button"
      type="button"
      data-sidebar-toggle
      aria-label="${escapeHtml(label)}"
      aria-pressed="${state.sidebarCollapsed ? "true" : "false"}"
    >${renderIcon(state.sidebarCollapsed ? ChevronRight : ChevronLeft)}</button>
  `;
}

function renderSidebarResizeHandle() {
  const { min, max } = getSidebarWidthBounds();
  return `
    <div
      class="layout-resize-handle sidebar-resize-handle"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin="${min}"
      aria-valuemax="${max}"
      aria-valuenow="${getSidebarWidth()}"
      tabindex="0"
      data-layout-resize="sidebar"
    ></div>
  `;
}

function renderWorkspaceResizeHandle() {
  const { min, max } = getWorkspaceFilePreviewBounds();
  const active = state.openFileTabs.length > 0;
  return `
    <div
      class="layout-resize-handle workspace-resize-handle"
      role="separator"
      aria-label="Resize file preview"
      aria-orientation="vertical"
      aria-hidden="${active ? "false" : "true"}"
      aria-valuemin="${min}"
      aria-valuemax="${max}"
      aria-valuenow="${getWorkspaceFilePreviewWidth()}"
      tabindex="${active ? "0" : "-1"}"
      data-layout-resize="workspace"
    ></div>
  `;
}

function timestampMs(timestamp) {
  const value = Date.parse(timestamp || "");
  return Number.isFinite(value) ? value : 0;
}

function getSessionReadAt(sessionId) {
  return Number(state.sessionReadAt[sessionId] || 0);
}

function getSessionSubactivityUpdatedAt(session) {
  const subagents = Array.isArray(session?.subagents) ? session.subagents : [];
  return Math.max(
    timestampMs(session?.backgroundActivity?.updatedAt),
    ...subagents.map((subagent) => timestampMs(subagent?.updatedAt)),
  );
}

function getSessionUnreadAt(session) {
  return Math.max(
    timestampMs(session?.activityCompletedAt),
    timestampMs(session?.lastOutputAt),
    getSessionSubactivityUpdatedAt(session),
  );
}

function isSessionUnread(session) {
  const unreadAt = getSessionUnreadAt(session);
  return unreadAt > 0 && unreadAt > getSessionReadAt(session.id);
}

function markSessionRead(sessionOrId, { refresh = true } = {}) {
  const session = typeof sessionOrId === "string"
    ? state.sessions.find((entry) => entry.id === sessionOrId)
    : sessionOrId;

  if (!session?.id) {
    return false;
  }

  const readAt = Math.max(
    getSessionUnreadAt(session),
    timestampMs(session.updatedAt),
    Date.now(),
  );
  if (readAt <= getSessionReadAt(session.id)) {
    return false;
  }

  state.sessionReadAt = {
    ...state.sessionReadAt,
    [session.id]: readAt,
  };
  saveSessionReadState();

  if (refresh) {
    scheduleSessionsRefresh();
  }

  return true;
}

function shouldMarkSessionRead(sessionId) {
  return (
    sessionId === state.activeSessionId
    && state.currentView === "shell"
    && document.visibilityState !== "hidden"
  );
}

function hasWorkingSessionSubactivity(session) {
  const subagents = Array.isArray(session?.subagents) ? session.subagents : [];
  return (
    session?.backgroundActivity?.active === true
    || subagents.some((subagent) => subagent?.status === "working")
  );
}

function hasWorkingSessionActivity(session) {
  return session?.activityStatus === "working" || hasWorkingSessionSubactivity(session);
}

function pruneSessionReadState() {
  const knownSessionIds = new Set(state.sessions.map((session) => session.id));
  const nextReadAt = Object.fromEntries(
    Object.entries(state.sessionReadAt).filter(([sessionId]) => knownSessionIds.has(sessionId)),
  );
  if (Object.keys(nextReadAt).length === Object.keys(state.sessionReadAt).length) {
    return;
  }

  state.sessionReadAt = nextReadAt;
  saveSessionReadState();
}

function relativeTime(timestamp) {
  if (!timestamp) {
    return "quiet";
  }

  const deltaSeconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (deltaSeconds < 5) {
    return "live";
  }

  if (deltaSeconds < 60) {
    return `${deltaSeconds}s`;
  }

  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

function relativeTimeAgo(timestamp) {
  const label = relativeTime(timestamp);
  if (label === "quiet") {
    return "";
  }

  return label === "live" ? "just now" : `${label} ago`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let unitIndex = 0;
  let scaled = Math.max(0, value);

  while (scaled >= 1000 && unitIndex < units.length - 1) {
    scaled /= 1000;
    unitIndex += 1;
  }

  const digits = scaled >= 100 || unitIndex === 0 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[unitIndex]}`;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "not exposed";
  }

  return `${Math.round(clamp(number, 0, 100))}%`;
}

function formatCompactPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "not exposed";
  }

  const percent = clamp(number, 0, 100);
  if (percent > 0 && percent < 1) {
    return "<1%";
  }

  return `${Math.round(percent)}%`;
}

function getMetricPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, 0, 100) : 0;
}

function formatDurationMs(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function getSessionLabel(session) {
  if (session.status === "exited") {
    return { text: "exited", className: "exited", title: "session exited" };
  }

  if (hasWorkingSessionActivity(session)) {
    const title = session?.backgroundActivity?.active
      ? "agent has a live monitor or background task"
      : "agent is working";
    return { text: "working", className: "working", title };
  }

  if (isSessionUnread(session)) {
    return { text: "done", className: "unread", title: "agent finished; unread" };
  }

  return { text: "read", className: "read", title: "read" };
}

function getSessionActivityStyle(status) {
  if (status?.className !== "working") {
    return "";
  }

  const delay = Date.now() % SESSION_WORKING_SPINNER_MS;
  return ` style="--session-spinner-delay: -${delay}ms"`;
}

function getPortDisplayName(port) {
  return typeof port?.name === "string" && port.name.trim() ? port.name.trim() : String(port?.port ?? "");
}

function getPortMeta(port) {
  const parts = [];

  if (port?.customName) {
    parts.push(`:${port.port}`);
  }

  if (port?.command) {
    parts.push(port.command);
  }

  if (Array.isArray(port?.hosts) && port.hosts.length) {
    parts.push(port.hosts.join(", "));
  }

  return parts.join(" · ");
}

function getPortProxyUrl(port) {
  const proxyPath = port?.proxyPath || `/proxy/${port?.port}/`;
  return `${getAppBaseUrl()}${proxyPath}`;
}

function getPortPreviewTabId(port) {
  const portNumber = Number(port?.port ?? port);
  return Number.isInteger(portNumber) && portNumber > 0 ? `${PORT_PREVIEW_TAB_PREFIX}${portNumber}` : "";
}

function getPortPrimaryUrl(port) {
  return port?.preferredUrl || getPortProxyUrl(port);
}

function getPortAccessLabel(port) {
  if (port?.preferredAccess === "direct") {
    return "open direct";
  }

  if (port?.preferredAccess === "tailscale-serve") {
    return "open tailnet";
  }

  return "open proxy";
}

function getPortAccessHint(port) {
  if (port?.preferredAccess === "direct") {
    return "tailnet ip";
  }

  if (port?.preferredAccess === "tailscale-serve") {
    return "tailscale serve";
  }

  if (port?.canExposeWithTailscale) {
    return "localhost only";
  }

  return "remote vibes proxy";
}

function setMobileSidebar(nextSidebar) {
  state.mobileSidebar = nextSidebar;
  const leftSidebar = document.querySelector('[data-sidebar-panel="left"]');
  const rightSidebar = document.querySelector('[data-sidebar-panel="right"]');
  const scrim = document.querySelector("[data-sidebar-scrim]");

  if (leftSidebar) {
    leftSidebar.classList.toggle("is-open", nextSidebar === "left");
  }

  if (rightSidebar) {
    rightSidebar.classList.toggle("is-open", nextSidebar === "right");
  }

  if (scrim) {
    scrim.classList.toggle("is-open", Boolean(nextSidebar));
  }

  fitTerminalSoon();
}

function closeMobileSidebar() {
  setMobileSidebar(null);
}

function refreshSidebarToggleButtons() {
  const label = state.sidebarCollapsed ? "Open sidebar" : "Collapse sidebar";
  document.querySelectorAll("[data-sidebar-toggle]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", state.sidebarCollapsed ? "true" : "false");
    button.removeAttribute("data-tooltip");
    button.removeAttribute("data-tooltip-placement");
    button.innerHTML = renderIcon(state.sidebarCollapsed ? ChevronRight : ChevronLeft);
  });
}

function refreshSidebarResizeHandleUi() {
  const handle = document.querySelector('[data-layout-resize="sidebar"]');
  if (!(handle instanceof HTMLElement)) {
    return;
  }

  const { min, max } = getSidebarWidthBounds();
  handle.setAttribute("aria-valuemin", String(min));
  handle.setAttribute("aria-valuemax", String(max));
  handle.setAttribute("aria-valuenow", String(getSidebarWidth()));
}

function refreshWorkspaceResizeHandleUi() {
  const split = document.querySelector("#workspace-split");
  const handle = document.querySelector('[data-layout-resize="workspace"]');
  if (!(handle instanceof HTMLElement)) {
    return;
  }

  const active = state.openFileTabs.length > 0;
  const { min, max } = getWorkspaceFilePreviewBounds(split);
  handle.setAttribute("aria-hidden", active ? "false" : "true");
  handle.setAttribute("aria-valuemin", String(min));
  handle.setAttribute("aria-valuemax", String(max));
  handle.setAttribute("aria-valuenow", String(getWorkspaceFilePreviewWidth(split)));
  handle.tabIndex = active ? 0 : -1;
}

function refreshLayoutUi() {
  state.sidebarWidth = getSidebarWidth();

  const shell = document.querySelector(".app-shell");
  if (shell instanceof HTMLElement) {
    shell.classList.toggle("is-sidebar-collapsed", state.sidebarCollapsed);
    shell.style.setProperty("--sidebar-width", `${state.sidebarWidth}px`);
    shell.style.setProperty("--sidebar-rail-width", `${SIDEBAR_COLLAPSED_RAIL_WIDTH}px`);
  }

  const split = document.querySelector("#workspace-split");
  if (split instanceof HTMLElement) {
    state.filePreviewWidth = getWorkspaceFilePreviewWidth(split);
    split.style.setProperty("--file-preview-width", `${state.filePreviewWidth}px`);
  }

  refreshSidebarToggleButtons();
  refreshSidebarResizeHandleUi();
  refreshWorkspaceResizeHandleUi();
  fitTerminalSoon();
}

function toggleSidebarCollapsed() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  saveLayoutPreferences();
  refreshLayoutUi();
}

function setSidebarWidth(width, { persist = false } = {}) {
  const { min, max } = getSidebarWidthBounds();
  state.sidebarCollapsed = false;
  state.sidebarWidth = Math.round(clamp(width, min, max));
  refreshLayoutUi();
  if (persist) {
    saveLayoutPreferences();
  }
}

function setWorkspaceFilePreviewWidth(width, { persist = false, split = document.querySelector("#workspace-split") } = {}) {
  const { min, max } = getWorkspaceFilePreviewBounds(split);
  state.filePreviewWidth = Math.round(clamp(width, min, max));
  refreshLayoutUi();
  if (persist) {
    saveLayoutPreferences();
  }
}

function resetLayoutResizeTarget(kind) {
  if (kind === "sidebar") {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH, { persist: true });
    return;
  }

  if (kind === "workspace") {
    setWorkspaceFilePreviewWidth(WORKSPACE_FILE_PREVIEW_DEFAULT_WIDTH, { persist: true });
  }
}

function beginLayoutResize(event, kind) {
  if (event.button !== undefined && event.button !== 0) {
    return;
  }

  const handle = event.currentTarget;
  if (!(handle instanceof HTMLElement)) {
    return;
  }

  if (kind === "workspace" && !state.openFileTabs.length) {
    return;
  }

  const pointerId = event.pointerId;
  const startClientX = event.clientX;
  const split = document.querySelector("#workspace-split");
  const startSidebarWidth = getSidebarWidth();
  const startFilePreviewWidth = getWorkspaceFilePreviewWidth(split);
  const controller = new AbortController();
  const resizeClass = kind === "sidebar" ? "is-resizing-sidebar" : "is-resizing-workspace";

  document.body.classList.add("is-resizing-layout", resizeClass);
  handle.classList.add("is-dragging");

  const onPointerMove = (moveEvent) => {
    if (moveEvent.pointerId !== pointerId) {
      return;
    }

    const deltaX = moveEvent.clientX - startClientX;
    if (kind === "sidebar") {
      setSidebarWidth(startSidebarWidth + deltaX);
    } else {
      setWorkspaceFilePreviewWidth(startFilePreviewWidth - deltaX, { split });
    }

    moveEvent.preventDefault();
  };

  const onPointerEnd = (endEvent) => {
    if (endEvent.pointerId !== pointerId) {
      return;
    }

    handle.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing-layout", resizeClass);
    saveLayoutPreferences();
    controller.abort();
    fitTerminalSoon();
  };

  window.addEventListener("pointermove", onPointerMove, { signal: controller.signal });
  window.addEventListener("pointerup", onPointerEnd, { signal: controller.signal });
  window.addEventListener("pointercancel", onPointerEnd, { signal: controller.signal });

  try {
    handle.setPointerCapture(pointerId);
  } catch {
    // Pointer capture is best-effort; window listeners still keep the drag alive.
  }

  event.preventDefault();
}

function handleLayoutResizeKeydown(event, kind) {
  if (kind === "workspace" && !state.openFileTabs.length) {
    return;
  }

  const sidebarBounds = kind === "sidebar" ? getSidebarWidthBounds() : null;
  const workspaceBounds = kind === "workspace" ? getWorkspaceFilePreviewBounds() : null;
  const step = event.shiftKey ? LAYOUT_RESIZE_KEYBOARD_STEP * 4 : LAYOUT_RESIZE_KEYBOARD_STEP;

  if (kind === "sidebar") {
    if (event.key === "ArrowLeft") {
      setSidebarWidth(getSidebarWidth() - step, { persist: true });
    } else if (event.key === "ArrowRight") {
      setSidebarWidth(getSidebarWidth() + step, { persist: true });
    } else if (event.key === "Home") {
      setSidebarWidth(sidebarBounds.min, { persist: true });
    } else if (event.key === "End") {
      setSidebarWidth(sidebarBounds.max, { persist: true });
    } else {
      return;
    }
  } else if (kind === "workspace") {
    if (event.key === "ArrowLeft") {
      setWorkspaceFilePreviewWidth(getWorkspaceFilePreviewWidth() + step, { persist: true });
    } else if (event.key === "ArrowRight") {
      setWorkspaceFilePreviewWidth(getWorkspaceFilePreviewWidth() - step, { persist: true });
    } else if (event.key === "Home") {
      setWorkspaceFilePreviewWidth(workspaceBounds.min, { persist: true });
    } else if (event.key === "End") {
      setWorkspaceFilePreviewWidth(workspaceBounds.max, { persist: true });
    } else {
      return;
    }
  }

  event.preventDefault();
}

function bindLayoutResizeEvents() {
  document.querySelectorAll("[data-sidebar-toggle]").forEach((button) => {
    button.addEventListener("click", () => toggleSidebarCollapsed());
  });

  document.querySelectorAll("[data-layout-resize]").forEach((handle) => {
    const kind = handle.getAttribute("data-layout-resize");
    if (kind !== "sidebar" && kind !== "workspace") {
      return;
    }

    handle.addEventListener("pointerdown", (event) => beginLayoutResize(event, kind));
    handle.addEventListener("keydown", (event) => handleLayoutResizeKeydown(event, kind));
    handle.addEventListener("dblclick", () => resetLayoutResizeTarget(kind));
  });
}

function getTerminalViewport() {
  const viewport = document.querySelector("#terminal-mount .xterm-viewport");
  return viewport instanceof HTMLElement ? viewport : null;
}

function captureTerminalScrollSnapshot() {
  const viewport = getTerminalViewport();
  if (!viewport || viewport.scrollHeight <= viewport.clientHeight) {
    return null;
  }

  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const bottomOffset = Math.max(0, maxScrollTop - viewport.scrollTop);

  return {
    atBottom: bottomOffset <= 2,
    scrollTop: viewport.scrollTop,
  };
}

function restoreTerminalScrollSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }

  window.requestAnimationFrame(() => {
    const viewport = getTerminalViewport();
    if (!viewport) {
      return;
    }

    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const nextScrollTop = snapshot.atBottom
      ? maxScrollTop
      : Math.min(maxScrollTop, Math.max(0, snapshot.scrollTop));

    viewport.scrollTop = nextScrollTop;
    syncTerminalScrollState();
  });
}

function rememberTerminalResizeScrollAnchor() {
  if (getUiNow() < state.terminalResizeScrollAnchorUntil && state.terminalResizeScrollAnchor) {
    state.terminalResizeScrollAnchorUntil = getUiNow() + MOBILE_KEYBOARD_SETTLE_MS;
    return;
  }

  state.terminalResizeScrollAnchor = captureTerminalScrollSnapshot();
  state.terminalResizeScrollAnchorUntil = getUiNow() + MOBILE_KEYBOARD_SETTLE_MS;
}

function getActiveTerminalResizeScrollAnchor() {
  if (getUiNow() > state.terminalResizeScrollAnchorUntil) {
    state.terminalResizeScrollAnchor = null;
    state.terminalResizeScrollAnchorUntil = 0;
    return null;
  }

  return state.terminalResizeScrollAnchor;
}

function fitTerminalSoon() {
  if (state.terminalFitFrame) {
    return;
  }

  const scrollSnapshot = getActiveTerminalResizeScrollAnchor() || captureTerminalScrollSnapshot();
  state.terminalFitFrame = window.requestAnimationFrame(() => {
    state.terminalFitFrame = window.requestAnimationFrame(() => {
      state.terminalFitFrame = null;
      const mount = document.querySelector("#terminal-mount");
      if (!state.fitAddon || !state.terminal || !mount) {
        return;
      }

      if (mount.clientWidth < 20 || mount.clientHeight < 20) {
        return;
      }

      state.fitAddon.fit();
      sendResize();
      restoreTerminalScrollSnapshot(scrollSnapshot);
    });
  });
}

function cleanupTerminalInteractions() {
  state.terminalInteractionCleanup?.();
  state.terminalInteractionCleanup = null;
  if (state.terminalFitFrame) {
    window.cancelAnimationFrame(state.terminalFitFrame);
    state.terminalFitFrame = null;
  }
  state.terminalResizeScrollAnchor = null;
  state.terminalResizeScrollAnchorUntil = 0;
  if (state.terminalTextareaResetTimer) {
    window.clearTimeout(state.terminalTextareaResetTimer);
    state.terminalTextareaResetTimer = null;
  }
  state.terminalComposing = false;
}

function configureTerminalTextarea(textarea) {
  if (!(textarea instanceof HTMLTextAreaElement)) {
    return;
  }

  textarea.autocomplete = "off";
  textarea.autocorrect = "off";
  textarea.autocapitalize = "none";
  textarea.spellcheck = false;
  textarea.setAttribute("autocomplete", "off");
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocapitalize", "none");
  textarea.setAttribute("spellcheck", "false");
  textarea.setAttribute("aria-autocomplete", "none");
  textarea.setAttribute("data-form-type", "other");
  textarea.setAttribute("data-gramm", "false");
  textarea.setAttribute("data-gramm_editor", "false");
  textarea.setAttribute("data-enable-grammarly", "false");
}

function resetTerminalTextarea() {
  if (state.terminalComposing) {
    return;
  }

  const textarea = state.terminal?.textarea;
  if (!(textarea instanceof HTMLTextAreaElement) || !textarea.value) {
    return;
  }

  textarea.value = "";
  textarea.setSelectionRange(0, 0);
}

function scheduleTerminalTextareaReset(delay = 0) {
  if (state.terminalTextareaResetTimer) {
    window.clearTimeout(state.terminalTextareaResetTimer);
  }

  state.terminalTextareaResetTimer = window.setTimeout(() => {
    state.terminalTextareaResetTimer = null;
    resetTerminalTextarea();
  }, delay);
}

function isCoarsePointerDevice() {
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

const TOOLTIP_DELAY_MS = 700;
let tooltipTimer = null;
let tooltipTarget = null;
let terminalFilePreviewTimer = null;
let terminalFilePreviewSequence = 0;

function getHoverTooltipElement() {
  let tooltip = document.querySelector("#hover-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "hover-tooltip";
    tooltip.className = "hover-tooltip";
    tooltip.setAttribute("role", "tooltip");
    document.body.append(tooltip);
  }

  return tooltip;
}

function hideHoverTooltip() {
  if (tooltipTimer) {
    window.clearTimeout(tooltipTimer);
    tooltipTimer = null;
  }

  tooltipTarget = null;
  document.querySelector("#hover-tooltip")?.classList.remove("is-visible");
}

function positionHoverTooltip(target, tooltip) {
  const placement = target.dataset.tooltipPlacement || "top";
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const margin = 8;
  const gap = 10;

  let left = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;
  let top = targetRect.top - tooltipRect.height - gap;

  if (placement === "bottom") {
    top = targetRect.bottom + gap;
  } else if (placement === "right") {
    left = targetRect.right + gap;
    top = targetRect.top + targetRect.height / 2 - tooltipRect.height / 2;
  } else if (placement === "left") {
    left = targetRect.left - tooltipRect.width - gap;
    top = targetRect.top + targetRect.height / 2 - tooltipRect.height / 2;
  }

  if (top < margin) {
    top = targetRect.bottom + gap;
  }
  if (top + tooltipRect.height > viewportHeight - margin) {
    top = Math.max(margin, targetRect.top - tooltipRect.height - gap);
  }

  left = clamp(left, margin, Math.max(margin, viewportWidth - tooltipRect.width - margin));
  top = clamp(top, margin, Math.max(margin, viewportHeight - tooltipRect.height - margin));

  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function showHoverTooltip(target) {
  const label = target?.dataset?.tooltip?.trim();
  if (!label || target.disabled || isCoarsePointerDevice()) {
    return;
  }

  const tooltip = getHoverTooltipElement();
  tooltip.textContent = label;
  tooltip.classList.add("is-measuring");
  tooltip.classList.remove("is-visible");
  positionHoverTooltip(target, tooltip);
  tooltip.classList.remove("is-measuring");
  tooltip.classList.add("is-visible");
}

function scheduleHoverTooltip(target) {
  hideHoverTooltip();
  tooltipTarget = target;
  tooltipTimer = window.setTimeout(() => {
    tooltipTimer = null;
    if (tooltipTarget === target) {
      showHoverTooltip(target);
    }
  }, TOOLTIP_DELAY_MS);
}

function installDelayedTooltips() {
  document.addEventListener("pointerover", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-tooltip]") : null;
    if (target instanceof HTMLElement) {
      scheduleHoverTooltip(target);
    }
  });

  document.addEventListener("pointerout", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-tooltip]") : null;
    const nextTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (!target || (nextTarget && target.contains(nextTarget))) {
      return;
    }

    hideHoverTooltip();
  });

  document.addEventListener("focusin", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-tooltip]") : null;
    if (target instanceof HTMLElement) {
      scheduleHoverTooltip(target);
    }
  });

  document.addEventListener("focusout", hideHoverTooltip);
  window.addEventListener("scroll", hideHoverTooltip, true);
  window.addEventListener("resize", hideHoverTooltip);
}

function refreshLineNumberEditor(editor) {
  const textarea = editor.querySelector("[data-line-number-textarea]");
  const gutter = editor.querySelector(".line-number-gutter");
  if (!(textarea instanceof HTMLTextAreaElement) || !(gutter instanceof HTMLElement)) {
    return;
  }

  gutter.textContent = renderEditorLineNumbers(textarea.value);
  gutter.scrollTop = textarea.scrollTop;
}

function bindLineNumberEditors(root = document) {
  root.querySelectorAll("[data-line-number-editor]").forEach((editor) => {
    const textarea = editor.querySelector("[data-line-number-textarea]");
    const gutter = editor.querySelector(".line-number-gutter");
    if (!(editor instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement) || !(gutter instanceof HTMLElement)) {
      return;
    }

    if (editor.dataset.lineNumberBound === "true") {
      refreshLineNumberEditor(editor);
      return;
    }

    editor.dataset.lineNumberBound = "true";
    textarea.addEventListener("input", () => refreshLineNumberEditor(editor));
    textarea.addEventListener("scroll", () => {
      gutter.scrollTop = textarea.scrollTop;
    });
    refreshLineNumberEditor(editor);
  });
}

function shouldUseCanvasRenderer() {
  // The canvas addon can leave xterm viewport timers pointed at a disposed renderer
  // when Remote Vibes swaps the terminal for another main view.
  return false;
}

function isKnownTerminalDisposalError(error) {
  const message = String(error?.message || error || "");
  const stack = String(error?.stack || "");
  return message.includes("Cannot read properties of undefined (reading 'dimensions')") && stack.includes("Viewport");
}

function installTerminalDisposalGuard() {
  window.addEventListener(
    "error",
    (event) => {
      if (!isKnownTerminalDisposalError(event.error || event.message)) {
        return;
      }

      // xterm can fire a delayed viewport refresh after its renderer has already
      // been torn down during a main-view switch. The terminal is gone by then.
      event.preventDefault();
    },
    true,
  );
}

function syncViewportMetrics() {
  const viewport = window.visualViewport;
  const nextHeight = Math.max(320, Math.round(viewport?.height ?? window.innerHeight));
  document.documentElement.style.setProperty("--app-height", `${nextHeight}px`);

  const previousHeight = state.lastVisualViewportHeight;
  state.lastVisualViewportHeight = nextHeight;
  const heightDelta = previousHeight > 0 ? nextHeight - previousHeight : 0;

  if (previousHeight > 0 && isCoarsePointerDevice() && Math.abs(heightDelta) >= 20) {
    rememberTerminalResizeScrollAnchor();
  }

  if (
    previousHeight > 0 &&
    isCoarsePointerDevice() &&
    heightDelta >= MOBILE_KEYBOARD_RESIZE_THRESHOLD_PX
  ) {
    state.mobileKeyboardSettlingUntil = getUiNow() + MOBILE_KEYBOARD_SETTLE_MS;
    const textarea = state.terminal?.textarea;
    if (textarea instanceof HTMLTextAreaElement && document.activeElement === textarea) {
      textarea.blur();
    }
  }
}

function getTerminalDisplayProfile(mount) {
  const width = mount?.clientWidth ?? window.innerWidth;

  if (width <= 420) {
    return {
      fontSize: 12,
      lineHeight: 1.08,
      scrollSensitivity: 1.2,
      smoothScrollDuration: 0,
    };
  }

  if (width <= 820) {
    return {
      fontSize: 13,
      lineHeight: 1.12,
      scrollSensitivity: 1.28,
      smoothScrollDuration: 30,
    };
  }

  return {
    fontSize: 14,
    lineHeight: 1.18,
    scrollSensitivity: 1.35,
    smoothScrollDuration: 60,
  };
}

function applyTerminalDisplayProfile(mount) {
  if (!state.terminal) {
    return;
  }

  const profile = getTerminalDisplayProfile(mount);
  const currentOptions = state.terminal.options;

  if (currentOptions.fontSize !== profile.fontSize) {
    currentOptions.fontSize = profile.fontSize;
  }

  if (currentOptions.lineHeight !== profile.lineHeight) {
    currentOptions.lineHeight = profile.lineHeight;
  }

  if (currentOptions.scrollSensitivity !== profile.scrollSensitivity) {
    currentOptions.scrollSensitivity = profile.scrollSensitivity;
  }

  if (currentOptions.smoothScrollDuration !== profile.smoothScrollDuration) {
    currentOptions.smoothScrollDuration = profile.smoothScrollDuration;
  }

}

function isTerminalAtBottom() {
  if (state.terminalTranscriptVisible) {
    return isTerminalTranscriptAtBottom();
  }

  const viewport = document.querySelector("#terminal-mount .xterm-viewport");
  if (viewport instanceof HTMLElement && viewport.scrollHeight > viewport.clientHeight) {
    return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
  }

  const buffer = state.terminal?.buffer?.active;
  if (!buffer) {
    return true;
  }

  return buffer.baseY - buffer.viewportY <= 1;
}

function refreshTerminalJumpUi() {
  const button = document.querySelector("#jump-to-bottom");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  const activeSession = getActiveSession();
  const shouldShow = Boolean(activeSession) && state.terminalShowJumpToBottom;
  button.classList.toggle("is-visible", shouldShow);
  button.disabled = !activeSession;
}

function syncTerminalScrollState() {
  const nextShowJumpToBottom = !isTerminalAtBottom();

  if (state.terminalShowJumpToBottom === nextShowJumpToBottom) {
    return;
  }

  state.terminalShowJumpToBottom = nextShowJumpToBottom;
  refreshTerminalJumpUi();
}

function scrollTerminalToBottom() {
  const transcriptViewport = getTerminalTranscriptViewport();
  if (transcriptViewport instanceof HTMLElement) {
    transcriptViewport.scrollTop = transcriptViewport.scrollHeight;
  }
  hideTerminalTranscriptOverlay();

  state.terminal?.scrollToBottom();

  const viewport = document.querySelector("#terminal-mount .xterm-viewport");
  if (viewport instanceof HTMLElement) {
    viewport.scrollTop = viewport.scrollHeight;
  }

  state.terminalShowJumpToBottom = false;
  refreshTerminalJumpUi();
  if (!isCoarsePointerDevice()) {
    state.terminal?.focus();
  }
  window.requestAnimationFrame(() => {
    syncTerminalScrollState();
  });
}

function sanitizeTerminalOutputForViewport(output) {
  return String(output || "").replace(/\u001b\[\?(?:47|1047|1048|1049)[hl]/g, "");
}

function getNativeTerminalViewport() {
  const viewport = document.querySelector("#terminal-mount .xterm-viewport");
  return viewport instanceof HTMLElement ? viewport : null;
}

function hasNativeTerminalScrollableHistory() {
  const buffer = state.terminal?.buffer?.active;
  if (buffer && buffer.baseY > 0) {
    return true;
  }

  const viewport = getNativeTerminalViewport();
  return Boolean(viewport && viewport.scrollHeight - viewport.clientHeight > 2);
}

function getTerminalTranscriptViewport() {
  const viewport = document.querySelector("#terminal-transcript-scroll");
  return viewport instanceof HTMLElement ? viewport : null;
}

function isTerminalTranscriptAtBottom() {
  const viewport = getTerminalTranscriptViewport();
  if (!(viewport instanceof HTMLElement) || viewport.scrollHeight <= viewport.clientHeight) {
    return true;
  }

  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
}

function getRenderableTerminalTranscriptOutput(rawOutput) {
  return String(rawOutput || "")
    .slice(-TERMINAL_TRANSCRIPT_RENDER_LIMIT)
    .replace(/\u001b\[\?(?:47|1047|1048|1049)[hl]/g, "")
    .replace(/\u001b\[\?2004[hl]/g, "");
}

function findTerminalAnsiEscapeEnd(source, startIndex) {
  const introducer = source[startIndex + 1];
  if (!introducer) {
    return startIndex;
  }

  if (introducer === "[") {
    for (let index = startIndex + 2; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        return index;
      }
    }
    return source.length - 1;
  }

  if (introducer === "]" || introducer === "P" || introducer === "_" || introducer === "^") {
    for (let index = startIndex + 2; index < source.length; index += 1) {
      if (source[index] === "\u0007") {
        return index;
      }

      if (source[index] === "\u001b" && source[index + 1] === "\\") {
        return index + 1;
      }
    }
    return source.length - 1;
  }

  if ("()*+-./#% ".includes(introducer)) {
    return Math.min(source.length - 1, startIndex + 2);
  }

  return startIndex + 1;
}

function getTerminalAnsiSequence(source, startIndex) {
  const endIndex = findTerminalAnsiEscapeEnd(source, startIndex);
  return {
    endIndex,
    sequence: source.slice(startIndex, endIndex + 1),
  };
}

function cloneTerminalTranscriptStyle(style) {
  return {
    bold: Boolean(style.bold),
    fg: style.fg || "",
  };
}

function isSameTerminalTranscriptStyle(left, right) {
  return Boolean(left?.bold) === Boolean(right?.bold) && (left?.fg || "") === (right?.fg || "");
}

function getTerminalTranscriptStyleClass(style) {
  const classNames = [];
  if (style?.bold) {
    classNames.push("is-bold");
  }
  if (style?.fg) {
    classNames.push(`fg-${style.fg}`);
  }
  return classNames.join(" ");
}

function applyTerminalTranscriptSgr(sequence, style) {
  const match = /^\u001b\[([0-9;:]*)m$/u.exec(sequence);
  if (!match) {
    return style;
  }

  const values = match[1]
    ? match[1].split(/[;:]/u).map((value) => Number(value || 0))
    : [0];
  const nextStyle = cloneTerminalTranscriptStyle(style);
  for (const value of values) {
    if (value === 0) {
      nextStyle.bold = false;
      nextStyle.fg = "";
    } else if (value === 1) {
      nextStyle.bold = true;
    } else if (value === 22) {
      nextStyle.bold = false;
    } else if (value === 39) {
      nextStyle.fg = "";
    } else if (value >= 30 && value <= 37) {
      nextStyle.fg = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"][value - 30];
    } else if (value >= 90 && value <= 97) {
      nextStyle.fg = ["bright-black", "bright-red", "bright-green", "bright-yellow", "bright-blue", "bright-magenta", "bright-cyan", "bright-white"][value - 90];
    }
  }
  return nextStyle;
}

function getTerminalPaletteColor(index) {
  if (index >= 0 && index < TERMINAL_TRANSCRIPT_BASIC_COLOR_NAMES.length) {
    const colorName = TERMINAL_TRANSCRIPT_BASIC_COLOR_NAMES[index].replace(/-([a-z])/gu, (_, character) =>
      character.toUpperCase(),
    );
    return TERMINAL_THEME[colorName] || TERMINAL_THEME.foreground;
  }

  if (index >= 16 && index <= 231) {
    const value = index - 16;
    const red = Math.floor(value / 36);
    const green = Math.floor((value % 36) / 6);
    const blue = value % 6;
    const component = (part) => (part === 0 ? 0 : 55 + part * 40);
    return `#${[component(red), component(green), component(blue)]
      .map((part) => part.toString(16).padStart(2, "0"))
      .join("")}`;
  }

  if (index >= 232 && index <= 255) {
    const value = 8 + (index - 232) * 10;
    const hex = value.toString(16).padStart(2, "0");
    return `#${hex}${hex}${hex}`;
  }

  return TERMINAL_THEME.foreground;
}

function getTerminalRgbColor(value) {
  const numeric = Number(value) || 0;
  return `#${numeric.toString(16).padStart(6, "0").slice(-6)}`;
}

function getTerminalTranscriptCellStyle(cell) {
  const classNames = [];
  const cssRules = [];

  if (cell.isBold?.()) {
    classNames.push("is-bold");
  }
  if (cell.isItalic?.()) {
    classNames.push("is-italic");
  }
  if (cell.isDim?.()) {
    classNames.push("is-dim");
  }
  if (cell.isUnderline?.()) {
    classNames.push("is-underline");
  }
  if (cell.isStrikethrough?.()) {
    classNames.push("is-strikethrough");
  }

  let foreground = "";
  let background = "";

  if (cell.isFgPalette?.()) {
    const colorIndex = cell.getFgColor();
    if (colorIndex >= 0 && colorIndex < TERMINAL_TRANSCRIPT_BASIC_COLOR_NAMES.length) {
      classNames.push(`fg-${TERMINAL_TRANSCRIPT_BASIC_COLOR_NAMES[colorIndex]}`);
    } else {
      foreground = getTerminalPaletteColor(colorIndex);
    }
  } else if (cell.isFgRGB?.()) {
    foreground = getTerminalRgbColor(cell.getFgColor());
  }

  if (cell.isBgPalette?.()) {
    const colorIndex = cell.getBgColor();
    if (colorIndex >= 0 && colorIndex < TERMINAL_TRANSCRIPT_BASIC_COLOR_NAMES.length) {
      classNames.push(`bg-${TERMINAL_TRANSCRIPT_BASIC_COLOR_NAMES[colorIndex]}`);
    } else {
      background = getTerminalPaletteColor(colorIndex);
    }
  } else if (cell.isBgRGB?.()) {
    background = getTerminalRgbColor(cell.getBgColor());
  }

  if (cell.isInverse?.()) {
    if (!foreground) {
      foreground = TERMINAL_THEME.background;
    }
    if (!background) {
      background = TERMINAL_THEME.foreground;
    }
  }

  if (foreground) {
    cssRules.push(`color: ${foreground}`);
  }
  if (background) {
    cssRules.push(`background-color: ${background}`);
  }

  return {
    className: classNames.join(" "),
    cssText: cssRules.join("; "),
  };
}

function getTerminalTranscriptCellStyleKey(style) {
  return `${style?.className || ""}|${style?.cssText || ""}`;
}

function renderTerminalTranscriptStyledText(text, style) {
  if (!text) {
    return "";
  }

  const classAttribute = style?.className ? ` class="${escapeHtml(style.className)}"` : "";
  const styleAttribute = style?.cssText ? ` style="${escapeHtml(style.cssText)}"` : "";
  return classAttribute || styleAttribute
    ? `<span${classAttribute}${styleAttribute}>${escapeHtml(text)}</span>`
    : escapeHtml(text);
}

function isTerminalTranscriptVisibleCell(cell) {
  if (!cell || cell.isInvisible?.()) {
    return false;
  }

  const chars = cell.getChars?.() || "";
  if (chars && chars !== " ") {
    return true;
  }

  return Boolean(cell.isBgPalette?.() || cell.isBgRGB?.());
}

function renderTerminalTranscriptBufferHtml() {
  const terminal = state.terminal;
  const buffer = terminal?.buffer?.active;
  if (!terminal || !buffer || buffer.length <= 0) {
    return "";
  }

  const cols = Math.max(1, Number(terminal.cols) || 1);
  const cell = buffer.getNullCell?.();
  const lines = [];

  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line || !cell) {
      lines.push("");
      continue;
    }

    const maxColumns = Math.min(cols, line.length || cols);
    let lastVisibleColumn = -1;
    for (let column = 0; column < maxColumns; column += 1) {
      const nextCell = line.getCell(column, cell);
      if (nextCell?.getWidth?.() === 0) {
        continue;
      }
      if (isTerminalTranscriptVisibleCell(nextCell)) {
        lastVisibleColumn = column;
      }
    }

    if (lastVisibleColumn < 0) {
      lines.push("");
      continue;
    }

    let html = "";
    let chunk = "";
    let currentStyle = null;
    let currentStyleKey = "";
    const flush = () => {
      if (!chunk) {
        return;
      }
      html += renderTerminalTranscriptStyledText(chunk, currentStyle);
      chunk = "";
    };

    for (let column = 0; column <= lastVisibleColumn; column += 1) {
      const nextCell = line.getCell(column, cell);
      if (!nextCell || nextCell.getWidth?.() === 0) {
        continue;
      }

      const nextStyle = getTerminalTranscriptCellStyle(nextCell);
      const nextStyleKey = getTerminalTranscriptCellStyleKey(nextStyle);
      if (nextStyleKey !== currentStyleKey) {
        flush();
        currentStyle = nextStyle;
        currentStyleKey = nextStyleKey;
      }

      chunk += nextCell.isInvisible?.() ? " " : nextCell.getChars?.() || " ";
    }

    flush();
    lines.push(html);
  }

  return lines.join("\n").replace(/\n{8,}$/u, "\n\n");
}

function parseTerminalCsiSequence(sequence) {
  const match = /^\u001b\[([?=>]?)([0-9;:]*)([ -/]*)?([@-~])$/u.exec(sequence);
  if (!match) {
    return null;
  }

  const params = match[2]
    ? match[2].split(/[;:]/u).map((value) => Number(value || 0))
    : [];

  return {
    final: match[4],
    params,
    privatePrefix: match[1] || "",
  };
}

function renderTerminalRawTranscriptHtml(rawOutput) {
  const source = getRenderableTerminalTranscriptOutput(rawOutput);
  const lines = [[]];
  let row = 0;
  let column = 0;
  let screenTop = 0;
  let style = { bold: false, fg: "" };
  const terminalColumns = Math.max(20, Number(state.terminal?.cols) || 120);
  const terminalRows = Math.max(8, Number(state.terminal?.rows) || 36);

  const ensureLine = (nextRow) => {
    while (lines.length <= nextRow) {
      lines.push([]);
    }
  };

  const newLine = () => {
    if (row - screenTop >= terminalRows - 1) {
      lines.push([]);
      screenTop = Math.max(0, screenTop + 1);
      row = screenTop + terminalRows - 1;
    } else {
      row += 1;
      ensureLine(row);
    }
    column = 0;
  };

  const eraseLine = (mode) => {
    ensureLine(row);
    if (mode === 1) {
      for (let eraseColumn = 0; eraseColumn <= column; eraseColumn += 1) {
        delete lines[row][eraseColumn];
      }
      return;
    }

    if (mode === 2) {
      lines[row] = [];
      return;
    }

    for (let eraseColumn = column; eraseColumn < terminalColumns; eraseColumn += 1) {
      delete lines[row][eraseColumn];
    }
  };

  const applyCsiSequence = (sequence) => {
    const parsed = parseTerminalCsiSequence(sequence);
    if (!parsed || parsed.privatePrefix) {
      return false;
    }

    const getParam = (index, fallback) => Math.max(1, Number(parsed.params[index]) || fallback);
    if (parsed.final === "m") {
      style = applyTerminalTranscriptSgr(sequence, style);
      return true;
    }

    if (parsed.final === "A" || parsed.final === "B") {
      // Claude's full-screen redraws move around inside the viewport a lot.
      // For the native transcript, preserving scrollback is more important
      // than perfectly replaying those destructive screen updates.
      return true;
    }
    if (parsed.final === "C") {
      column = Math.min(terminalColumns - 1, column + getParam(0, 1));
      return true;
    }
    if (parsed.final === "D") {
      column = Math.max(0, column - getParam(0, 1));
      return true;
    }
    if (parsed.final === "E") {
      for (let count = 0; count < getParam(0, 1); count += 1) {
        newLine();
      }
      return true;
    }
    if (parsed.final === "F") {
      column = 0;
      return true;
    }
    if (parsed.final === "G") {
      column = clamp(getParam(0, 1) - 1, 0, terminalColumns - 1);
      return true;
    }
    if (parsed.final === "H" || parsed.final === "f") {
      const nextRow = getParam(0, 1) - 1;
      const nextColumn = getParam(1, 1) - 1;
      if (nextRow === 0 && nextColumn === 0 && lines[row]?.some(Boolean)) {
        newLine();
      }
      column = clamp(nextColumn, 0, terminalColumns - 1);
      return true;
    }
    if (parsed.final === "d") {
      return true;
    }
    if (parsed.final === "J") {
      if (lines[row]?.some(Boolean)) {
        newLine();
      }
      return true;
    }
    if (parsed.final === "K") {
      eraseLine(Number(parsed.params[0]) || 0);
      return true;
    }

    return false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const code = source.charCodeAt(index);

    if (character === "\u001b") {
      const { endIndex, sequence } = getTerminalAnsiSequence(source, index);
      applyCsiSequence(sequence);
      index = endIndex;
      continue;
    }

    if (character === "\r") {
      column = 0;
      continue;
    }

    if (character === "\n") {
      newLine();
      continue;
    }

    if (character === "\b") {
      column = Math.max(0, column - 1);
      continue;
    }

    if (character === "\t") {
      const spaces = 8 - (column % 8);
      for (let offset = 0; offset < spaces; offset += 1) {
        lines[row][column] = { character: " ", style: cloneTerminalTranscriptStyle(style) };
        column += 1;
      }
      continue;
    }

    if (code < 32 || code === 127) {
      continue;
    }

    lines[row][column] = { character, style: cloneTerminalTranscriptStyle(style) };
    column += 1;
    if (column >= terminalColumns) {
      newLine();
    }
  }

  return lines
    .map((line) => {
      let html = "";
      let currentStyle = null;
      let chunk = "";
      const flush = () => {
        if (!chunk) {
          return;
        }
        html += renderTerminalTranscriptStyledText(chunk, {
          className: getTerminalTranscriptStyleClass(currentStyle),
          cssText: "",
        });
        chunk = "";
      };

      for (const cell of line) {
        const nextCell = cell || { character: " ", style: { bold: false, fg: "" } };
        if (!currentStyle || !isSameTerminalTranscriptStyle(currentStyle, nextCell.style)) {
          flush();
          currentStyle = cloneTerminalTranscriptStyle(nextCell.style);
        }
        chunk += nextCell.character;
      }
      flush();
      return html.replace(/\s+$/u, "");
    })
    .join("\n")
    .replace(/\n{5,}$/u, "\n\n\n\n");
}

function renderTerminalTranscriptHtml(rawOutput) {
  const bufferHtml = renderTerminalTranscriptBufferHtml();
  const buffer = state.terminal?.buffer?.active;
  const hasScrollableBuffer = Boolean(buffer && buffer.length > (Number(state.terminal?.rows) || 0) + 2);
  return hasScrollableBuffer && bufferHtml ? bufferHtml : renderTerminalRawTranscriptHtml(rawOutput);
}

function renderTerminalTranscriptHistory({ afterRender = null, scrollToBottom = false } = {}) {
  const pre = document.querySelector("#terminal-transcript-pre");
  if (!(pre instanceof HTMLElement)) {
    return;
  }

  pre.innerHTML = renderTerminalTranscriptHtml(state.terminalTranscriptRaw);
  if (scrollToBottom || state.terminalTranscriptScrollToBottom) {
    const viewport = getTerminalTranscriptViewport();
    if (viewport instanceof HTMLElement) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }
  afterRender?.();
  state.terminalTranscriptScrollToBottom = false;
  syncTerminalScrollState();
}

function scheduleTerminalTranscriptRender({ scrollToBottom = false } = {}) {
  state.terminalTranscriptScrollToBottom = state.terminalTranscriptScrollToBottom || scrollToBottom;

  if (state.terminalTranscriptRenderFrame) {
    return;
  }

  state.terminalTranscriptRenderFrame = window.requestAnimationFrame(() => {
    state.terminalTranscriptRenderFrame = null;
    renderTerminalTranscriptHistory();
  });
}

function setTerminalTranscriptHistory(rawOutput, { scrollToBottom = false } = {}) {
  state.terminalTranscriptRaw = String(rawOutput || "").slice(-TERMINAL_TRANSCRIPT_RAW_LIMIT);
  scheduleTerminalTranscriptRender({ scrollToBottom });
}

function appendTerminalTranscriptOutput(chunk, { scrollToBottom = false } = {}) {
  if (!chunk) {
    return;
  }

  const shouldStickToBottom = scrollToBottom || (state.terminalTranscriptVisible && isTerminalTranscriptAtBottom());
  state.terminalTranscriptRaw = `${state.terminalTranscriptRaw}${chunk}`.slice(-TERMINAL_TRANSCRIPT_RAW_LIMIT);

  scheduleTerminalTranscriptRender({ scrollToBottom: shouldStickToBottom });
}

function setTerminalTranscriptVisible(visible) {
  const nextVisible = Boolean(visible);
  state.terminalTranscriptVisible = nextVisible;
  const stack = document.querySelector(".terminal-stack");
  stack?.classList.toggle("is-transcript-scroll", nextVisible);
  if (nextVisible) {
    renderTerminalTranscriptHistory();
  }
  syncTerminalScrollState();
}

function hideTerminalTranscriptOverlay() {
  if (!state.terminalTranscriptVisible) {
    return;
  }

  setTerminalTranscriptVisible(false);
}

function clearTerminalTranscriptHistory() {
  if (state.terminalTranscriptRenderFrame) {
    window.cancelAnimationFrame(state.terminalTranscriptRenderFrame);
    state.terminalTranscriptRenderFrame = null;
  }

  state.terminalTranscriptRaw = "";
  state.terminalTranscriptScrollToBottom = false;
  hideTerminalTranscriptOverlay();

  const pre = document.querySelector("#terminal-transcript-pre");
  if (pre instanceof HTMLElement) {
    pre.textContent = "";
  }
}

function getTerminalWheelDeltaY(event) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * 18;
  }

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    const viewport = getTerminalTranscriptViewport();
    return event.deltaY * (viewport?.clientHeight || 320);
  }

  return event.deltaY;
}

function routeTerminalTranscriptWheel(event) {
  if (!event.deltaY || event.ctrlKey || event.metaKey) {
    return false;
  }

  if (!state.terminalTranscriptVisible && hasNativeTerminalScrollableHistory()) {
    hideTerminalTranscriptOverlay();
    return false;
  }

  if (!(getTerminalTranscriptViewport() instanceof HTMLElement)) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();

  const wheelDeltaY = getTerminalWheelDeltaY(event);
  const applyTranscriptWheel = () => {
    const transcriptViewport = getTerminalTranscriptViewport();
    if (!(transcriptViewport instanceof HTMLElement)) {
      return;
    }
    const maxScrollTop = Math.max(0, transcriptViewport.scrollHeight - transcriptViewport.clientHeight);
    const nextScrollTop = clamp(transcriptViewport.scrollTop + wheelDeltaY, 0, maxScrollTop);
    transcriptViewport.scrollTop = nextScrollTop;

    if (event.deltaY > 0 && nextScrollTop >= maxScrollTop - 2) {
      hideTerminalTranscriptOverlay();
    } else {
      syncTerminalScrollState();
    }
  };

  if (!state.terminalTranscriptVisible) {
    setTerminalTranscriptVisible(true);
    renderTerminalTranscriptHistory({ afterRender: applyTranscriptWheel, scrollToBottom: true });
    return true;
  }

  applyTranscriptWheel();

  return true;
}

function getTerminalFilePathExtension(value) {
  const withoutSuffix = getFileDisplayName(String(value || "").split(/[?#]/)[0]).toLowerCase();
  const dotIndex = withoutSuffix.lastIndexOf(".");
  return dotIndex >= 0 ? withoutSuffix.slice(dotIndex) : "";
}

function cleanTerminalFilePathMatchText(value) {
  let text = String(value || "").trim().replace(/^<|>$/g, "");

  while (/[.,:;!?]$/u.test(text)) {
    text = text.slice(0, -1);
  }

  text = text.replace(/(?::\d+){1,2}$/u, "");

  return text;
}

function getInferredHomeDirectory() {
  const candidatePaths = [
    state.defaultCwd,
    state.filesRoot,
    state.knowledgeBase.rootPath,
    state.settings.wikiPath,
  ];

  for (const candidatePath of candidatePaths) {
    const normalizedPath = normalizeAbsolutePathForCompare(candidatePath);
    const match = /^(\/Users\/[^/]+|\/home\/[^/]+)/u.exec(normalizedPath);
    if (match) {
      return match[1];
    }
  }

  return "";
}

function normalizeTerminalFilePathText(value) {
  let normalized = cleanTerminalFilePathMatchText(value);
  if (!normalized) {
    return "";
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) && !/^file:\/\//i.test(normalized)) {
    return "";
  }

  if (/^file:\/\//i.test(normalized)) {
    try {
      const parsedUrl = new URL(normalized);
      if (parsedUrl.protocol !== "file:") {
        return "";
      }
      normalized = decodeURIComponent(parsedUrl.pathname);
    } catch {
      return "";
    }
  } else {
    normalized = normalized.replace(/\\([ "'()[\]{}])/g, "$1");
    try {
      normalized = decodeURI(normalized);
    } catch {
      // Keep the original text if it only looks partly URI-escaped.
    }
  }

  if (normalized.startsWith("~/")) {
    const homeDirectory = getInferredHomeDirectory();
    return homeDirectory ? `${homeDirectory}/${normalized.slice(2)}` : "";
  }

  return normalized;
}

function getRelativePathInsideAbsoluteRoot(candidatePath, rootPath) {
  const rawRoot = String(rootPath || "").trim().replaceAll("\\", "/");
  const candidateAliases = getAbsolutePathAliases(candidatePath);
  const rootAliases = getAbsolutePathAliases(rawRoot);

  if (!candidateAliases.length || !rawRoot) {
    return "";
  }

  if (/^\/+$/.test(rawRoot)) {
    return normalizeFileTreePath(candidateAliases[0]);
  }

  for (const candidate of candidateAliases) {
    for (const root of rootAliases) {
      if (candidate === root) {
        return "";
      }

      if (candidate.startsWith(`${root}/`)) {
        return normalizeFileTreePath(candidate.slice(root.length + 1));
      }
    }
  }

  return "";
}

function isLikelyTerminalFilePath(pathText) {
  const normalizedPath = normalizeTerminalFilePathText(pathText);
  if (!normalizedPath) {
    return false;
  }

  const basename = getFileDisplayName(normalizedPath);
  const extension = getTerminalFilePathExtension(normalizedPath);
  if (TERMINAL_IMAGE_PATH_EXTENSIONS.has(extension) || isLikelyTextFile(basename) || isLikelyTextFile(normalizedPath)) {
    return true;
  }

  return Boolean(extension && (normalizedPath.startsWith("/") || normalizedPath.includes("/")));
}

function normalizeTerminalRelativeFilePath(value) {
  const normalizedPath = normalizeTerminalFilePathText(value);
  if (!normalizedPath || normalizedPath.startsWith("/")) {
    return "";
  }

  return normalizePosixSegments(normalizedPath);
}

function getTerminalFileAbsoluteDisplayPath(candidate) {
  const root = normalizeWorkspaceRoot(candidate?.root || "");
  const relativePath = normalizeFileTreePath(candidate?.relativePath || "");
  if (!root || !relativePath) {
    return relativePath;
  }

  return root === "/" ? `/${relativePath}` : `${root}/${relativePath}`;
}

function addTerminalFileCandidate(candidates, seen, { root, relativePath, source }) {
  const normalizedRoot = normalizeWorkspaceRoot(root);
  const normalizedRelativePath = normalizeFileTreePath(relativePath);
  if (!normalizedRoot || !normalizedRelativePath) {
    return;
  }

  const key = `${normalizedRoot}\u0000${normalizedRelativePath}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  candidates.push({
    root: normalizedRoot,
    relativePath: normalizedRelativePath,
    source,
    opensInPreviewPane: normalizedRoot === normalizeWorkspaceRoot(state.filesRoot),
    url: getFileContentUrlForRoot(normalizedRoot, normalizedRelativePath),
  });
}

function getTerminalFileRootCandidates(relativePath = "") {
  const workspaceRoot = { root: state.filesRoot || getPreferredFilesRoot(), source: "workspace" };
  const wikiRoot = { root: state.knowledgeBase.rootPath || state.settings.wikiPath, source: "wiki" };
  const defaultRoot = { root: state.defaultCwd, source: "default" };

  if (relativePath && wikiRoot.root && hasKnowledgeBaseNote(relativePath)) {
    return [wikiRoot, workspaceRoot, defaultRoot];
  }

  return [workspaceRoot, wikiRoot, defaultRoot];
}

function getTerminalFileCandidates(normalizedPath) {
  const candidates = [];
  const seen = new Set();

  if (normalizedPath.startsWith("/")) {
    for (const rootCandidate of getTerminalFileRootCandidates()) {
      const relativePath = getRelativePathInsideAbsoluteRoot(normalizedPath, normalizeWorkspaceRoot(rootCandidate.root));
      if (relativePath) {
        addTerminalFileCandidate(candidates, seen, {
          root: rootCandidate.root,
          relativePath,
          source: rootCandidate.source,
        });
      }
    }

    addTerminalFileCandidate(candidates, seen, {
      root: "/",
      relativePath: normalizeFileTreePath(normalizedPath),
      source: "filesystem",
    });
    return candidates;
  }

  const relativePath = normalizeTerminalRelativeFilePath(normalizedPath);
  if (!relativePath) {
    return candidates;
  }

  for (const rootCandidate of getTerminalFileRootCandidates(relativePath)) {
    addTerminalFileCandidate(candidates, seen, {
      root: rootCandidate.root,
      relativePath,
      source: rootCandidate.source,
    });
  }

  return candidates;
}

function getTerminalFileRequest(pathText) {
  const text = cleanTerminalFilePathMatchText(pathText);
  const normalizedPath = normalizeTerminalFilePathText(text);
  if (!normalizedPath || !isLikelyTerminalFilePath(text)) {
    return null;
  }

  const candidates = getTerminalFileCandidates(normalizedPath);
  if (!candidates.length) {
    return null;
  }

  const extension = getTerminalFilePathExtension(normalizedPath);
  return {
    text,
    normalizedPath,
    isImage: TERMINAL_IMAGE_PATH_EXTENSIONS.has(extension),
    candidates,
  };
}

function getTerminalFilePathMatches(lineText) {
  const matches = [];
  TERMINAL_FILE_PATH_PATTERN.lastIndex = 0;

  for (const match of String(lineText || "").matchAll(TERMINAL_FILE_PATH_PATTERN)) {
    const text = cleanTerminalFilePathMatchText(match[2] || "");
    const startIndex = (match.index || 0) + (match[1] || "").length;
    if (!getTerminalFileRequest(text)) {
      continue;
    }

    matches.push({ text, startIndex });
  }

  return matches;
}

function getTerminalWrappedLineGroup(bufferLineNumber) {
  const buffer = state.terminal?.buffer?.active;
  if (!buffer || typeof buffer.getLine !== "function") {
    return null;
  }

  let startIndex = bufferLineNumber - 1;
  while (startIndex > 0 && buffer.getLine(startIndex)?.isWrapped) {
    startIndex -= 1;
  }

  const columns = Number(state.terminal?.cols || 0);
  const translateEndColumn = Number.isFinite(columns) && columns > 0 ? columns : undefined;
  const lines = [];
  let text = "";

  for (let lineIndex = startIndex; lineIndex < Number(buffer.length || 0); lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    if (!line || typeof line.translateToString !== "function") {
      break;
    }

    const nextLine = buffer.getLine(lineIndex + 1);
    const hasWrappedNext = Boolean(nextLine?.isWrapped);
    const lineText = line.translateToString(!hasWrappedNext, 0, translateEndColumn);
    lines.push({
      lineNumber: lineIndex + 1,
      startOffset: text.length,
      text: lineText,
    });
    text += lineText;

    if (!hasWrappedNext) {
      break;
    }
  }

  return lines.length ? { lines, text } : null;
}

function getTerminalFileMatchRange(lineGroup, match) {
  const startOffset = match.startIndex;
  const endOffset = match.startIndex + match.text.length - 1;
  const startLine = lineGroup.lines.find(
    (line) => startOffset >= line.startOffset && startOffset < line.startOffset + line.text.length,
  );
  const endLine = lineGroup.lines.find(
    (line) => endOffset >= line.startOffset && endOffset < line.startOffset + line.text.length,
  );

  if (!startLine || !endLine) {
    return null;
  }

  return {
    start: {
      x: startOffset - startLine.startOffset + 1,
      y: startLine.lineNumber,
    },
    end: {
      x: endOffset - endLine.startOffset + 1,
      y: endLine.lineNumber,
    },
  };
}

function getTerminalFilePreviewElement() {
  let preview = document.querySelector("#terminal-file-preview");
  if (!preview) {
    preview = document.createElement("div");
    preview.id = "terminal-file-preview";
    preview.className = "terminal-file-preview xterm-hover";
    preview.setAttribute("role", "tooltip");
    document.body.append(preview);
  }

  return preview;
}

function positionTerminalFilePreview(event, preview) {
  const previewRect = preview.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const margin = 10;
  const gap = 14;

  let left = event.clientX + gap;
  let top = event.clientY + gap;

  if (left + previewRect.width > viewportWidth - margin) {
    left = event.clientX - previewRect.width - gap;
  }
  if (top + previewRect.height > viewportHeight - margin) {
    top = event.clientY - previewRect.height - gap;
  }

  left = clamp(left, margin, Math.max(margin, viewportWidth - previewRect.width - margin));
  top = clamp(top, margin, Math.max(margin, viewportHeight - previewRect.height - margin));

  preview.style.left = `${Math.round(left)}px`;
  preview.style.top = `${Math.round(top)}px`;
}

function hideTerminalFilePreview() {
  if (terminalFilePreviewTimer) {
    window.clearTimeout(terminalFilePreviewTimer);
    terminalFilePreviewTimer = null;
  }

  terminalFilePreviewSequence += 1;
  const preview = document.querySelector("#terminal-file-preview");
  if (!preview) {
    return;
  }

  preview.classList.remove("is-visible", "is-loading", "is-error");
  preview.replaceChildren();
}

function buildTerminalFilePreviewCaption(text) {
  const caption = document.createElement("div");
  caption.className = "terminal-file-preview-caption";
  caption.textContent = text;
  return caption;
}

function showTerminalFilePreviewError(event, request, sequence, messageText = "file unavailable") {
  if (sequence !== terminalFilePreviewSequence) {
    return;
  }

  const preview = getTerminalFilePreviewElement();
  const message = document.createElement("div");
  const caption = buildTerminalFilePreviewCaption(request.normalizedPath);
  message.className = "terminal-file-preview-error";
  message.textContent = messageText;
  preview.replaceChildren(message, caption);
  preview.classList.remove("is-loading");
  preview.classList.add("is-error");
  positionTerminalFilePreview(event, preview);
  preview.classList.add("is-visible");
}

function loadTerminalPreviewImage(candidate) {
  const image = document.createElement("img");
  image.alt = getTerminalFileAbsoluteDisplayPath(candidate);
  image.decoding = "async";

  return new Promise((resolve, reject) => {
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", reject, { once: true });
    image.src = candidate.url;
  });
}

async function showTerminalImageFilePreview(event, request, sequence) {
  const preview = getTerminalFilePreviewElement();
  preview.classList.add("is-loading");
  preview.classList.remove("is-visible", "is-error");
  preview.replaceChildren();

  for (const candidate of request.candidates) {
    try {
      const image = await loadTerminalPreviewImage(candidate);
      if (sequence !== terminalFilePreviewSequence) {
        return;
      }

      const caption = buildTerminalFilePreviewCaption(getTerminalFileAbsoluteDisplayPath(candidate));
      preview.replaceChildren(image, caption);
      preview.classList.remove("is-loading", "is-error");
      positionTerminalFilePreview(event, preview);
      preview.classList.add("is-visible");
      return;
    } catch {
      // Try the next root candidate.
    }
  }

  showTerminalFilePreviewError(event, request, sequence, "image unavailable");
}

async function fetchTerminalTextFileCandidate(request) {
  const errors = [];

  for (const candidate of request.candidates) {
    try {
      const payload = await fetchJson(
        `/api/files/text?${getFileTextRequestParamsForRoot(candidate.root, candidate.relativePath).toString()}`,
      );
      return {
        candidate,
        file: payload.file,
      };
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(errors.find(Boolean) || "file unavailable");
}

function truncateTerminalFilePreviewText(value) {
  const text = String(value || "").replace(/\r\n/g, "\n");
  if (text.length <= TERMINAL_FILE_PREVIEW_TEXT_MAX_CHARS) {
    return text;
  }

  return `${text.slice(0, TERMINAL_FILE_PREVIEW_TEXT_MAX_CHARS).replace(/\s+$/u, "")}\n...`;
}

async function showTerminalTextFilePreview(event, request, sequence) {
  const preview = getTerminalFilePreviewElement();
  preview.classList.add("is-loading");
  preview.classList.remove("is-visible", "is-error");
  preview.replaceChildren();

  try {
    const result = await fetchTerminalTextFileCandidate(request);
    if (sequence !== terminalFilePreviewSequence) {
      return;
    }

    const code = document.createElement("pre");
    const caption = buildTerminalFilePreviewCaption(getTerminalFileAbsoluteDisplayPath(result.candidate));
    code.className = "terminal-file-preview-code";
    code.textContent = truncateTerminalFilePreviewText(result.file?.content || "");
    preview.replaceChildren(code, caption);
    preview.classList.remove("is-loading", "is-error");
    positionTerminalFilePreview(event, preview);
    preview.classList.add("is-visible");
  } catch (error) {
    showTerminalFilePreviewError(event, request, sequence, error.message || "file unavailable");
  }
}

function showTerminalFilePreview(event, request, sequence) {
  if (sequence !== terminalFilePreviewSequence) {
    return;
  }

  if (request.isImage) {
    void showTerminalImageFilePreview(event, request, sequence);
    return;
  }

  void showTerminalTextFilePreview(event, request, sequence);
}

function scheduleTerminalFilePreview(event, pathText) {
  if (isCoarsePointerDevice()) {
    return;
  }

  const request = getTerminalFileRequest(pathText);
  if (!request) {
    return;
  }

  hideTerminalFilePreview();
  const sequence = terminalFilePreviewSequence + 1;
  terminalFilePreviewSequence = sequence;
  terminalFilePreviewTimer = window.setTimeout(() => {
    terminalFilePreviewTimer = null;
    showTerminalFilePreview(event, request, sequence);
  }, TERMINAL_FILE_PREVIEW_DELAY_MS);
}

async function findReachableTerminalFileCandidate(request) {
  for (const candidate of request.candidates) {
    try {
      const response = await fetch(candidate.url, { method: "HEAD", cache: "no-store" });
      if (response.ok) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return request.candidates[0] || null;
}

async function activateTerminalFilePath(event, pathText) {
  const request = getTerminalFileRequest(pathText);
  if (!request) {
    return;
  }

  event?.preventDefault?.();
  event?.stopPropagation?.();
  hideTerminalFilePreview();

  const candidate = await findReachableTerminalFileCandidate(request);
  if (!candidate) {
    return;
  }

  if (candidate.opensInPreviewPane) {
    void openWorkspaceFilePreview(candidate.relativePath, { mode: request.isImage ? "image" : "text" });
    return;
  }

  window.open(candidate.url, "_blank", "noopener,noreferrer");
}

function buildTerminalFileLinkProvider() {
  return {
    provideLinks(bufferLineNumber, callback) {
      const lineGroup = getTerminalWrappedLineGroup(bufferLineNumber);
      if (!lineGroup) {
        callback(undefined);
        return;
      }

      const matches = getTerminalFilePathMatches(lineGroup.text);
      const links = matches
        .map((match) => {
          const range = getTerminalFileMatchRange(lineGroup, match);
          if (!range) {
            return null;
          }

          return {
            text: match.text,
            range,
            decorations: {
              pointerCursor: true,
              underline: true,
            },
            activate: (event, text) => {
              void activateTerminalFilePath(event, text);
            },
            hover: (event, text) => scheduleTerminalFilePreview(event, text),
            leave: () => hideTerminalFilePreview(),
          };
        })
        .filter(Boolean);

      callback(links.length ? links : undefined);
    },
  };
}

function installTerminalFileLinkProvider() {
  try {
    state.terminalFileLinkDisposable?.dispose?.();
  } catch {
    // Best-effort cleanup only.
  }
  state.terminalFileLinkDisposable = null;

  if (!state.terminal || typeof state.terminal.registerLinkProvider !== "function") {
    return;
  }

  state.terminalFileLinkDisposable = state.terminal.registerLinkProvider(buildTerminalFileLinkProvider());
}

function buildTerminalLinkHandler() {
  return {
    activate(_event, text) {
      if (isCoarsePointerDevice()) {
        console.info("[remote-vibes] blocked terminal link activation on touch device", text);
        return;
      }

      if (!/^https?:\/\//i.test(text)) {
        return;
      }

      window.open(text, "_blank", "noopener,noreferrer");
    },
  };
}

function clearPendingTerminalOutput() {
  if (state.terminalOutputFrame) {
    window.cancelAnimationFrame(state.terminalOutputFrame);
    state.terminalOutputFrame = null;
  }

  state.pendingTerminalOutput = "";
  state.pendingTerminalScrollToBottom = false;
}

function flushPendingTerminalOutput() {
  state.terminalOutputFrame = null;

  if (!state.terminal || !state.pendingTerminalOutput) {
    state.pendingTerminalOutput = "";
    state.pendingTerminalScrollToBottom = false;
    return;
  }

  const nextOutput = sanitizeTerminalOutputForViewport(state.pendingTerminalOutput);
  const shouldScrollToBottom = state.pendingTerminalScrollToBottom;
  state.pendingTerminalOutput = "";
  state.pendingTerminalScrollToBottom = false;

  if (!nextOutput) {
    syncTerminalScrollState();
    return;
  }

  state.terminal.write(nextOutput, () => {
    if (shouldScrollToBottom) {
      state.terminal?.scrollToBottom();
    }

    syncTerminalScrollState();
  });
}

function queueTerminalOutput(chunk, { mirrorTranscript = true, scrollToBottom = false } = {}) {
  if (!chunk) {
    return;
  }

  if (mirrorTranscript) {
    appendTerminalTranscriptOutput(chunk, { scrollToBottom });
  }

  state.pendingTerminalOutput += chunk;
  state.pendingTerminalScrollToBottom = state.pendingTerminalScrollToBottom || scrollToBottom;

  if (state.terminalOutputFrame) {
    return;
  }

  state.terminalOutputFrame = window.requestAnimationFrame(() => {
    flushPendingTerminalOutput();
  });
}

async function fetchJson(url, options = {}) {
  const { headers = {}, ...fetchOptions } = options;
  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      "Content-Type": "application/json",
      "X-Remote-Vibes-API": "1",
      ...headers,
    },
    referrerPolicy: fetchOptions.referrerPolicy || "no-referrer",
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function waitForAppRecovery({ attempts = 40, delayMs = 500 } = {}) {
  const recoveryUrl = new URL("/api/state", window.location.origin);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(delayMs);
    recoveryUrl.searchParams.set("ts", String(Date.now()));

    try {
      const response = await fetch(recoveryUrl.toString(), { cache: "no-store" });
      if (response.ok) {
        return true;
      }
    } catch {
      // Keep waiting for the relaunched server.
    }
  }

  return false;
}

function getAppBaseUrl() {
  return state.preferredBaseUrl || window.location.origin;
}

function getKnowledgeBaseUrl(notePath = "") {
  const url = new URL(`${getAppBaseUrl()}/`);
  url.searchParams.set("view", "knowledge-base");

  const normalizedNotePath = normalizeFileTreePath(notePath);
  if (normalizedNotePath) {
    url.searchParams.set("note", normalizedNotePath);
  }

  return url.toString();
}

function getAgentPromptUrl() {
  const url = new URL(`${getAppBaseUrl()}/`);
  url.searchParams.set("view", "agent-prompt");
  return url.toString();
}

function getMainViewUrl(view) {
  if (view === "knowledge-base") {
    return getKnowledgeBaseUrl(state.knowledgeBase.selectedNotePath || "");
  }

  if (view === "agent-prompt") {
    return getAgentPromptUrl();
  }

  const url = new URL(`${getAppBaseUrl()}/`);
  if (ROUTED_MAIN_VIEWS.has(view)) {
    url.searchParams.set("view", view);
  }
  return url.toString();
}

function getFolderPickerTitle() {
  if (state.folderPicker.target === "wiki-onboarding") {
    return "select brain folder";
  }

  if (state.folderPicker.target === "wiki") {
    return "choose brain folder";
  }

  if (state.folderPicker.target === "files") {
    return "choose files folder";
  }

  return "choose session folder";
}

function getFolderPickerCurrentPath() {
  return state.folderPicker.currentPath || state.folderPicker.root || state.defaultCwd || "";
}

function getFolderPickerDragPosition() {
  const position = state.folderPicker.position;
  const x = Number(position?.x);
  const y = Number(position?.y);

  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

function renderFolderPickerDragStyle() {
  if (!state.folderPicker.position) {
    return "";
  }

  const { x, y } = getFolderPickerDragPosition();
  return ` style="--folder-picker-x:${Math.round(x)}px; --folder-picker-y:${Math.round(y)}px"`;
}

function getWorkspacePathLeafName(value) {
  const normalized = normalizeWorkspaceRoot(value);

  if (!normalized) {
    return "folder";
  }

  if (normalized === "/") {
    return "/";
  }

  const parts = normalized.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || normalized;
}

function isRemoteVibesSystemFolder(entryOrPath) {
  if (typeof entryOrPath === "string") {
    return getWorkspacePathLeafName(entryOrPath) === REMOTE_VIBES_SYSTEM_FOLDER_NAME;
  }

  return (
    entryOrPath?.name === REMOTE_VIBES_SYSTEM_FOLDER_NAME ||
    getWorkspacePathLeafName(entryOrPath?.path || entryOrPath?.relativePath || "") === REMOTE_VIBES_SYSTEM_FOLDER_NAME
  );
}

function getDirectoryIcon(entryOrPath, expanded = false) {
  if (isRemoteVibesSystemFolder(entryOrPath)) {
    return FolderCog;
  }

  return expanded ? FolderOpen : Folder;
}

function renderDirectoryIcon(entryOrPath, expanded = false) {
  const className = isRemoteVibesSystemFolder(entryOrPath)
    ? "file-icon file-icon-system"
    : "file-icon file-icon-folder";
  return `<span class="${className}" aria-hidden="true">${renderIcon(getDirectoryIcon(entryOrPath, expanded))}</span>`;
}

function getFileEntryIcon(entry, openMode) {
  if (entry?.isImage) {
    return ImageIcon;
  }

  return openMode === "text" ? FileText : File;
}

function getFileEntryIconClass(entry, openMode) {
  if (entry?.isImage) {
    return "file-icon file-icon-image";
  }

  return openMode === "text" ? "file-icon file-icon-text" : "file-icon file-icon-file";
}

function renderFileEntryIcon(entry, openMode) {
  return `<span class="${getFileEntryIconClass(entry, openMode)}" aria-hidden="true">${renderIcon(getFileEntryIcon(entry, openMode))}</span>`;
}

function renderTreeCaret(expanded) {
  return `<span class="file-caret" aria-hidden="true">${renderIcon(expanded ? ChevronDown : ChevronRight)}</span>`;
}

function getWorkspaceParentPath(value) {
  const normalized = normalizeWorkspaceRoot(value);

  if (!normalized || normalized === "/") {
    return "";
  }

  const trimmed = normalized.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));

  if (separatorIndex < 0) {
    return "";
  }

  if (separatorIndex === 0) {
    return "/";
  }

  return trimmed.slice(0, separatorIndex);
}

function getFolderPickerAbsolutePath(relativePath) {
  const normalizedRelativePath = normalizeFileTreePath(relativePath);
  const root = normalizeWorkspaceRoot(state.folderPicker.root || state.defaultCwd || "/");

  if (!normalizedRelativePath) {
    return root;
  }

  const existingEntry = Object.values(state.folderPicker.treeEntries)
    .flat()
    .find((entry) => entry.relativePath === normalizedRelativePath);

  if (existingEntry?.path) {
    return existingEntry.path;
  }

  return root === "/" ? `/${normalizedRelativePath}` : `${root}/${normalizedRelativePath}`;
}

function getFolderPickerChildRelativePath(parentPath, childName) {
  const normalizedParentPath = normalizeFileTreePath(parentPath);
  const normalizedChildName = normalizeFileTreePath(childName);

  if (!normalizedChildName) {
    return normalizedParentPath;
  }

  return normalizedParentPath ? `${normalizedParentPath}/${normalizedChildName}` : normalizedChildName;
}

function getFolderPickerTargetInput() {
  if (state.folderPicker.target === "wiki") {
    return document.querySelector("#wiki-path-input");
  }

  if (state.folderPicker.target === "wiki-onboarding") {
    return document.querySelector("#brain-folder-input");
  }

  if (state.folderPicker.target === "files") {
    return document.querySelector("#files-root-input");
  }

  return null;
}

function getSelectedSessionProviderId() {
  const input = document.querySelector("[data-session-provider-value]");

  if (input instanceof HTMLInputElement && input.value) {
    return input.value;
  }

  return state.defaultProviderId;
}

function renderProviderOptions(selectedProviderId = state.defaultProviderId) {
  return state.providers
    .map(
      (provider) => `
        <option value="${provider.id}" ${provider.id === selectedProviderId ? "selected" : ""} ${provider.available ? "" : "disabled"}>
          ${escapeHtml(provider.label)}${provider.available ? "" : " · missing"}
        </option>
      `,
    )
    .join("");
}

function getSelectedProvider() {
  return (
    state.providers.find((provider) => provider.id === state.defaultProviderId)
    || state.providers.find((provider) => provider.available)
    || state.providers[0]
    || null
  );
}

function renderSessionProviderPicker() {
  const selectedProvider = getSelectedProvider();
  const selectedProviderId = selectedProvider?.id || state.defaultProviderId || "";
  const selectedLabel = selectedProvider
    ? `${selectedProvider.label}${selectedProvider.available ? "" : " · missing"}`
    : "Choose CLI";

  return `
    <div class="session-provider-picker" data-session-provider-picker>
      <input type="hidden" name="providerId" value="${escapeHtml(selectedProviderId)}" data-session-provider-value>
      <button
        class="session-provider-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-label="Session CLI"
        data-session-provider-trigger
      >
        <span class="session-provider-trigger-label">${escapeHtml(selectedLabel)}</span>
        <span class="session-provider-trigger-caret" aria-hidden="true">⌄</span>
      </button>
      <div class="session-provider-menu" role="listbox" aria-label="Session CLI">
        ${state.providers
          .map(
            (provider) => `
              <button
                class="session-provider-option ${provider.id === selectedProviderId ? "is-selected" : ""}"
                type="button"
                role="option"
                aria-selected="${provider.id === selectedProviderId ? "true" : "false"}"
                ${provider.available ? "" : "aria-disabled=\"true\" disabled"}
                data-session-provider-option="${escapeHtml(provider.id)}"
              >
                <span class="session-provider-option-check" aria-hidden="true">${provider.id === selectedProviderId ? "✓" : ""}</span>
                <span class="session-provider-option-label">${escapeHtml(provider.label)}</span>
                ${provider.available ? "" : `<span class="session-provider-option-status">missing</span>`}
              </button>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function getSleepPreventionStatusText() {
  const sleep = state.settings.sleepPrevention;

  if (!state.settings.preventSleepEnabled) {
    return "sleep prevention disabled";
  }

  if (!sleep?.lastStatus || sleep.lastStatus === "idle") {
    return "sleep prevention enabled";
  }

  if (sleep.lastStatus === "active") {
    return "preventing sleep";
  }

  if (sleep.lastStatus === "unsupported") {
    return sleep.lastMessage || "sleep prevention unsupported here";
  }

  if (sleep.lastStatus === "error") {
    return sleep.lastMessage || "sleep prevention failed";
  }

  return sleep.lastMessage || sleep.lastStatus;
}

function getWikiBackupStatusText() {
  const backup = state.settings.wikiBackup;
  const remoteEnabled = state.settings.wikiGitRemoteEnabled;

  if (!state.settings.wikiGitBackupEnabled) {
    return "git backup disabled";
  }

  if (remoteEnabled && !state.settings.wikiGitRemoteUrl && !backup?.remoteUrlConfigured) {
    return "private remote push enabled; add a remote URL";
  }

  if (backup?.hasConflicts || backup?.lastErrorKind === "merge-conflict") {
    return backup.conflictFiles?.length
      ? `wiki sync merge conflict: ${backup.conflictFiles.join(", ")}`
      : "wiki sync has a merge conflict";
  }

  if (remoteEnabled && (backup?.lastPushStatus === "error" || backup?.lastPushStatus === "conflict")) {
    return backup.lastPushMessage || "private remote push failed";
  }

  if (remoteEnabled && (backup?.lastPullStatus === "error" || backup?.lastPullStatus === "conflict")) {
    return backup.lastPullMessage || "private remote pull failed";
  }

  if (remoteEnabled && backup?.lastPullStatus === "pulled" && backup?.lastPushStatus === "pushed") {
    return "wiki pulled + pushed";
  }

  if (remoteEnabled && backup?.lastPushStatus === "pushed") {
    const remoteLabel = `${backup.remoteName || state.settings.wikiGitRemoteName || "origin"}/${
      backup.remoteBranch || state.settings.wikiGitRemoteBranch || "main"
    }`;
    return backup.lastCommit ? `backup ${backup.lastCommit} pushed to ${remoteLabel}` : `wiki pushed to ${remoteLabel}`;
  }

  if (remoteEnabled && backup?.lastPushStatus === "skipped") {
    return backup.lastPushMessage || "private remote push skipped";
  }

  if (!backup?.lastStatus || backup.lastStatus === "idle") {
    return remoteEnabled ? "git backup + private remote push enabled" : "git backup enabled";
  }

  if (backup.lastStatus === "committed") {
    return backup.lastCommit ? `last backup ${backup.lastCommit}` : "last backup committed";
  }

  if (backup.lastStatus === "clean") {
    return "wiki already backed up";
  }

  if (backup.lastStatus === "error") {
    return backup.lastMessage || "wiki backup failed";
  }

  return backup.lastMessage || backup.lastStatus;
}

function getKnowledgeBaseSyncLabel() {
  const backup = state.settings.wikiBackup;

  if (!state.settings.wikiGitBackupEnabled) {
    return "sync disabled";
  }

  if (!backup) {
    return "sync pending";
  }

  const timestamps = [backup.lastRunAt, backup.lastPullAt, backup.lastPushAt]
    .filter(Boolean)
    .map((timestamp) => ({ timestamp, time: new Date(timestamp).getTime() }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((left, right) => right.time - left.time);
  const age = relativeTimeAgo(timestamps[0]?.timestamp);
  const failed =
    backup.hasConflicts ||
    backup.lastErrorKind === "merge-conflict" ||
    backup.lastStatus === "error" ||
    backup.lastPullStatus === "error" ||
    backup.lastPullStatus === "conflict" ||
    backup.lastPushStatus === "error" ||
    backup.lastPushStatus === "conflict";

  if (!age) {
    return failed ? "sync failed" : "sync pending";
  }

  return failed ? `sync failed ${age}` : `synced ${age}`;
}

function getKnowledgeBaseHeaderMeta() {
  return `obsidian-style markdown viewer for ${state.knowledgeBase.relativeRoot} · ${getKnowledgeBaseSyncLabel()}`;
}

function formatWikiBackupIntervalLabel() {
  const intervalMs = Number(state.settings.wikiBackupIntervalMs) || 5 * 60 * 1000;
  const minutes = Math.max(1, Math.round(intervalMs / 60_000));
  return `git backup every ${minutes} min`;
}

function getAgentMailStatusText() {
  const status = state.settings.agentMailStatus;
  if (!state.settings.agentMailEnabled) {
    return state.settings.agentMailApiKeyConfigured || state.settings.agentMailInboxId
      ? "configured but disabled"
      : "not configured";
  }

  if (!state.settings.agentMailApiKeyConfigured) {
    return "add an AgentMail API key";
  }

  if (!state.settings.agentMailInboxId) {
    return "create or enter an inbox";
  }

  if (status?.connected) {
    return `listening on ${state.settings.agentMailInboxId}`;
  }

  if (status?.lastStatus === "queued") {
    return "email queued for Claude";
  }

  if (status?.lastStatus === "replied") {
    return "last email replied";
  }

  if (status?.lastStatus === "error") {
    return status.lastError || "AgentMail listener error";
  }

  return status?.lastStatus || "connecting";
}

function getBrowserUseStatusText() {
  const status = state.settings.browserUseStatus || {};
  if (!state.settings.browserUseEnabled) {
    return state.settings.browserUseAnthropicApiKeyConfigured ? "configured but disabled" : "not configured";
  }

  if (!state.settings.browserUseAnthropicApiKeyConfigured) {
    return "add an Anthropic API key";
  }

  if (!status.workerAvailable) {
    return status.reason || "OttoAuth worker not found";
  }

  const activeCount = Number(status.activeCount || 0);
  if (activeCount > 0) {
    return `${activeCount} browser task${activeCount === 1 ? "" : "s"} running`;
  }

  return "ready for rv-browser-use";
}

function getWikiBackupFailureMessage(backup) {
  if (!backup) {
    return "";
  }

  if (backup.lastPullStatus === "error" || backup.lastPullStatus === "conflict") {
    return backup.lastPullMessage || "private remote pull failed";
  }

  if (backup.lastPushStatus === "error" || backup.lastPushStatus === "conflict") {
    return backup.lastPushMessage || "private remote push failed";
  }

  if (backup.lastStatus === "error") {
    return backup.lastMessage || "wiki backup failed";
  }

  return backup.lastMessage || "";
}

function getSystemToasts() {
  const toasts = [];
  const backup = state.settings.wikiBackup;
  const backupFailed =
    state.settings.wikiGitBackupEnabled &&
    backup &&
    (backup.lastStatus === "error" ||
      backup.lastPullStatus === "error" ||
      backup.lastPullStatus === "conflict" ||
      backup.lastPushStatus === "error" ||
      backup.lastPushStatus === "conflict" ||
      backup.hasConflicts ||
      backup.lastErrorKind === "merge-conflict");

  if (backupFailed) {
    const conflictFiles = Array.isArray(backup.conflictFiles) ? backup.conflictFiles : [];
    const isConflict = Boolean(backup.hasConflicts || backup.lastErrorKind === "merge-conflict" || conflictFiles.length);
    const message = getWikiBackupFailureMessage(backup);
    const timestamp = backup.lastRunAt || backup.lastPullAt || backup.lastPushAt || "";
    toasts.push({
      action: isConflict ? "resolve-wiki-conflict" : "retry-wiki-backup",
      key: `wiki:${isConflict ? "conflict" : "error"}:${timestamp}:${message}`,
      message:
        isConflict && conflictFiles.length
          ? `${message || "Resolve the wiki git conflict."} Conflicts: ${conflictFiles.join(", ")}`
          : message || "Remote Vibes could not sync the knowledge base.",
      title: isConflict ? "Knowledge base merge conflict" : "Knowledge base sync failed",
      type: isConflict ? "conflict" : "error",
    });
  }

  const updateErrorMessage = state.lastUpdateError?.message || (state.update?.status === "error" ? state.update.reason : "");
  if (updateErrorMessage) {
    toasts.push({
      action: "retry-update-check",
      key: `update:${state.lastUpdateError?.occurredAt || state.update?.checkedAt || ""}:${updateErrorMessage}`,
      message: updateErrorMessage,
      title: "Remote Vibes update failed",
      type: "error",
    });
  }

  return toasts.filter((toast) => !state.systemToastDismissedKeys.has(toast.key));
}

function renderSystemToastActions(toast) {
  if (toast.action === "resolve-wiki-conflict") {
    return `
      <div class="system-toast-resolve-row">
        <select class="system-toast-provider" data-wiki-conflict-provider aria-label="Agent for merge conflict">
          ${renderProviderOptions(state.defaultProviderId)}
        </select>
        <button class="primary-button system-toast-action" type="button" data-system-toast-action="resolve-wiki-conflict" data-system-toast-key="${escapeHtml(toast.key)}">
          fix with agent
        </button>
      </div>
    `;
  }

  if (toast.action === "retry-wiki-backup") {
    return `
      <button class="primary-button system-toast-action" type="button" data-system-toast-action="retry-wiki-backup" data-system-toast-key="${escapeHtml(toast.key)}">
        retry sync
      </button>
    `;
  }

  if (toast.action === "retry-update-check") {
    return `
      <button class="primary-button system-toast-action" type="button" data-system-toast-action="retry-update-check" data-system-toast-key="${escapeHtml(toast.key)}">
        check again
      </button>
    `;
  }

  return "";
}

function renderSystemToasts() {
  const toasts = getSystemToasts();

  if (!toasts.length) {
    return "";
  }

  return `
    <div class="system-toast-stack" id="system-toasts" role="status" aria-live="polite">
      ${toasts
        .map(
          (toast) => `
            <section class="system-toast is-${escapeHtml(toast.type)}">
              <div class="system-toast-head">
                <strong>${escapeHtml(toast.title)}</strong>
                <button class="icon-button system-toast-dismiss" type="button" aria-label="Dismiss" ${tooltipAttributes("Dismiss")} data-system-toast-dismiss="${escapeHtml(toast.key)}">${renderIcon(X)}</button>
              </div>
              <div class="system-toast-message">${escapeHtml(toast.message)}</div>
              <div class="system-toast-actions">${renderSystemToastActions(toast)}</div>
            </section>
          `,
        )
        .join("")}
    </div>
  `;
}

function getSessionProjectKey(cwd) {
  return normalizeWorkspaceRoot(cwd || state.defaultCwd || "") || "__unknown__";
}

function getSessionProjectName(cwd) {
  const normalizedCwd = normalizeWorkspaceRoot(cwd || "");
  if (!normalizedCwd) {
    return "unknown project";
  }

  const parts = normalizedCwd.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) || normalizedCwd;
}

function getSessionProjectMeta(cwd) {
  const normalizedCwd = normalizeWorkspaceRoot(cwd || "");
  return {
    cwd: normalizedCwd,
    key: getSessionProjectKey(normalizedCwd),
    name: getSessionProjectName(normalizedCwd),
  };
}

function expandSessionProject(cwd) {
  const key = getSessionProjectKey(cwd);
  if (!key) {
    return;
  }

  state.sessionProjectExpanded.add(key);
}

async function createSessionInFolder(cwd, { providerId = getSelectedSessionProviderId(), name = "" } = {}) {
  const selectedCwd = normalizeWorkspaceRoot(cwd);

  if (!selectedCwd) {
    throw new Error("Choose a folder before starting a session.");
  }

  const payload = await fetchJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ providerId, cwd: selectedCwd, name }),
  });

  state.defaultCwd = selectedCwd;
  state.defaultProviderId = providerId;
  state.folderPicker.open = false;
  state.sessions = [payload.session, ...state.sessions];
  state.activeSessionId = payload.session.id;
  expandSessionProject(payload.session.cwd);
  setCurrentView("shell");
  renderShell();
  connectToSession(payload.session.id);
  closeMobileSidebar();
}

async function createFolderFromPicker(folderName) {
  const currentPath = getFolderPickerCurrentPath();
  const parentPath = normalizeFileTreePath(state.folderPicker.path);
  const payload = await fetchJson("/api/folders", {
    method: "POST",
    body: JSON.stringify({
      root: currentPath,
      name: folderName,
    }),
  });
  const createdPath = payload?.folder?.path || "";

  if (!createdPath) {
    throw new Error("Folder was created, but Remote Vibes could not resolve its path.");
  }

  const createdRelativePath = getFolderPickerChildRelativePath(parentPath, payload.folder.name);
  const createdEntry = {
    ...payload.folder,
    relativePath: createdRelativePath,
  };
  const parentEntries = state.folderPicker.treeEntries[parentPath] || [];
  state.folderPicker.treeEntries[parentPath] = [
    ...parentEntries.filter((entry) => entry.relativePath !== createdRelativePath),
    createdEntry,
  ].sort((left, right) => left.name.localeCompare(right.name));
  state.folderPicker.treeExpanded.add(parentPath);
  state.folderPicker.treeExpanded.add(createdRelativePath);
  state.folderPicker.currentPath = createdPath;
  state.folderPicker.path = createdRelativePath;
  state.folderPicker.parentPath = currentPath;
  state.folderPicker.treeEntries[createdRelativePath] = [];
  renderShell();
}

async function applyFolderPickerSelection() {
  const input = getFolderPickerTargetInput();
  const selectedPath = getFolderPickerCurrentPath();

  if (state.folderPicker.target === "wiki-onboarding") {
    await saveBrainFolderSelection(selectedPath);
    return;
  }

  if (state.folderPicker.target === "session") {
    await createSessionInFolder(selectedPath);
    return;
  }

  if (input instanceof HTMLInputElement && selectedPath) {
    input.value = selectedPath;
  }

  if (state.folderPicker.target === "wiki") {
    state.settings.wikiPath = selectedPath || state.settings.wikiPath;
  } else if (state.folderPicker.target === "files") {
    state.filesRootOverride = normalizeWorkspaceRoot(selectedPath) || null;
    syncFilesRoot({ force: true });
  } else {
    state.defaultCwd = selectedPath || state.defaultCwd;
  }

  state.folderPicker.open = false;
  renderShell();

  if (state.folderPicker.target === "files") {
    void refreshOpenFileTree({ force: true });
  }
}

function maybeRedirectToPreferredOrigin() {
  if (!state.preferredBaseUrl) {
    return false;
  }

  let preferredOrigin = "";
  try {
    preferredOrigin = new URL(state.preferredBaseUrl).origin;
  } catch {
    return false;
  }

  if (!preferredOrigin || preferredOrigin === window.location.origin) {
    return false;
  }

  const nextUrl = `${preferredOrigin}${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.replace(nextUrl);
  return true;
}

function isBrainSetupRequired() {
  return state.settings.wikiPathConfigured === false;
}

function inferWikiPathConfigured(settings) {
  if (settings.wikiPathConfigured !== undefined) {
    return Boolean(settings.wikiPathConfigured);
  }

  const wikiPath = normalizeWorkspaceRoot(settings.wikiPath || "");
  if (!wikiPath) {
    return state.settings.wikiPathConfigured;
  }

  const relativeRoot = String(settings.wikiRelativeRoot || settings.wikiRelativePath || "");
  const defaultWikiPath = state.defaultCwd
    ? normalizeWorkspaceRoot(`${state.defaultCwd.replace(/\/+$/, "")}/.remote-vibes/wiki`)
    : "";
  if (relativeRoot === ".remote-vibes/wiki" || (defaultWikiPath && wikiPath === defaultWikiPath)) {
    return false;
  }

  return true;
}

function getDefaultBrainClonePathHint() {
  return state.defaultCwd ? `${state.defaultCwd.replace(/\/+$/, "")}/mac-brain` : "mac-brain";
}

function sendTerminalInput(data) {
  if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN) {
    return;
  }

  state.websocket.send(JSON.stringify({ type: "input", data }));
}

function normalizeFileTreePath(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  return normalized === "." ? "" : normalized;
}

function normalizeWorkspaceRoot(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.replace(/\/+$/, "") || "/";
}

function normalizePosixSegments(value) {
  const segments = [];

  for (const rawSegment of String(value || "").replaceAll("\\", "/").split("/")) {
    const segment = rawSegment.trim();

    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (!segments.length) {
        return "";
      }

      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join("/");
}

function getRelativeDirectory(relativePath) {
  const normalized = normalizeFileTreePath(relativePath);
  if (!normalized || !normalized.includes("/")) {
    return "";
  }

  return normalized.split("/").slice(0, -1).join("/");
}

function resolveKnowledgeBaseRelativePath(fromPath, targetPath) {
  const cleanedTarget = String(targetPath || "")
    .trim()
    .replace(/^<|>$/g, "");

  if (!cleanedTarget || cleanedTarget.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(cleanedTarget)) {
    return "";
  }

  const [withoutHash] = cleanedTarget.split("#");
  const [withoutQuery] = withoutHash.split("?");
  const normalizedInput = withoutQuery.replaceAll("\\", "/").trim();

  if (!normalizedInput) {
    return "";
  }

  if (normalizedInput.startsWith("/")) {
    return normalizePosixSegments(normalizedInput.slice(1));
  }

  return normalizePosixSegments(
    [getRelativeDirectory(fromPath), normalizedInput].filter(Boolean).join("/"),
  );
}

function resolveKnowledgeBaseNotePath(fromPath, targetPath) {
  const basePath = resolveKnowledgeBaseRelativePath(fromPath, targetPath);

  if (!basePath) {
    return "";
  }

  const notePaths = new Set(state.knowledgeBase.notes.map((note) => note.relativePath));
  const hasExtension = /\.[^./]+$/.test(basePath);
  const candidates = hasExtension
    ? [basePath]
    : [basePath, `${basePath}.md`, `${basePath}.markdown`, `${basePath}/index.md`];

  return candidates.find((candidate) => notePaths.has(candidate)) || "";
}

function cleanMarkdownLinkTarget(targetPath) {
  let cleaned = String(targetPath || "").trim();

  if (!cleaned) {
    return "";
  }

  if (cleaned.startsWith("<")) {
    const closingIndex = cleaned.indexOf(">");
    if (closingIndex > 0) {
      return cleaned.slice(1, closingIndex).trim();
    }
  }

  cleaned = cleaned.replace(/^<|>$/g, "");
  const titleMatch = cleaned.match(/^(.+?)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/);
  return (titleMatch?.[1] || cleaned).trim();
}

function isSafeKnowledgeBaseExternalUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

function getKnowledgeBaseMediaExtension(targetPath) {
  const cleaned = cleanMarkdownLinkTarget(targetPath);
  if (!cleaned) {
    return "";
  }

  let pathname = cleaned;
  try {
    pathname = new URL(cleaned).pathname;
  } catch {
    [pathname] = cleaned.split(/[?#]/);
  }

  const match = String(pathname || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? `.${match[1]}` : "";
}

function getKnowledgeBaseMediaKind(targetPath, { defaultToImage = false } = {}) {
  const extension = getKnowledgeBaseMediaExtension(targetPath);

  if (KNOWLEDGE_BASE_IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (KNOWLEDGE_BASE_VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }

  if (KNOWLEDGE_BASE_AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }

  return defaultToImage ? "image" : "";
}

function splitKnowledgeBaseAbsoluteFilePath(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/").trim();

  if (!normalized.startsWith("/") || normalized === "/") {
    return null;
  }

  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments.pop();
  if (!fileName) {
    return null;
  }

  return {
    root: `/${segments.join("/")}` || "/",
    path: fileName,
  };
}

function getKnowledgeBaseAbsoluteFileUrl(filePath) {
  const absolutePath = splitKnowledgeBaseAbsoluteFilePath(filePath);
  return absolutePath ? getFileContentUrlForRoot(absolutePath.root, absolutePath.path) : "";
}

function getKnowledgeBaseMediaResource(currentPath, targetPath, { defaultToImage = false } = {}) {
  const cleanedTarget = cleanMarkdownLinkTarget(targetPath);

  if (!cleanedTarget || cleanedTarget.startsWith("#")) {
    return null;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(cleanedTarget)) {
    if (!isSafeKnowledgeBaseExternalUrl(cleanedTarget)) {
      return null;
    }

    const kind = getKnowledgeBaseMediaKind(cleanedTarget, { defaultToImage });
    return kind ? { kind, url: cleanedTarget } : null;
  }

  const absoluteAssetUrl = getKnowledgeBaseAbsoluteFileUrl(cleanedTarget);
  if (absoluteAssetUrl) {
    const kind = getKnowledgeBaseMediaKind(cleanedTarget, { defaultToImage });
    return kind ? { kind, url: absoluteAssetUrl, local: true } : null;
  }

  const relativeAssetPath = resolveKnowledgeBaseRelativePath(currentPath, cleanedTarget);
  if (!relativeAssetPath) {
    return null;
  }

  const kind = getKnowledgeBaseMediaKind(relativeAssetPath, { defaultToImage });
  return kind
    ? {
        kind,
        url: getKnowledgeBaseNoteRawUrl(relativeAssetPath),
        local: true,
      }
    : null;
}

function getFileDisplayName(relativePath) {
  const normalized = normalizeFileTreePath(relativePath);
  if (!normalized) {
    return "";
  }

  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] || normalized;
}

function isLikelyTextFile(fileName) {
  const normalized = String(fileName || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (LIKELY_TEXT_FILENAMES.has(normalized)) {
    return true;
  }

  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex > 0) {
    return LIKELY_TEXT_EXTENSIONS.has(normalized.slice(extensionIndex));
  }

  return !normalized.includes(".");
}

function getFileExtension(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex >= 0 ? normalized.slice(dotIndex) : "";
}

function isMarkdownFilePath(value) {
  return [".md", ".markdown"].includes(getFileExtension(value));
}

function normalizeSyntaxLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/^[.]+/, "");
  const aliases = {
    bash: "shell",
    cjs: "javascript",
    htm: "html",
    js: "javascript",
    jsx: "javascript",
    md: "markdown",
    mjs: "javascript",
    ps1: "powershell",
    py: "python",
    rb: "ruby",
    sh: "shell",
    ts: "typescript",
    tsx: "typescript",
    yml: "yaml",
  };

  return aliases[normalized] || normalized || "text";
}

function getSyntaxLanguageForPath(value) {
  const extension = getFileExtension(value);
  const basename = getFileDisplayName(value).toLowerCase();

  if (["dockerfile", "makefile"].includes(basename)) {
    return basename;
  }

  return normalizeSyntaxLanguage(extension || basename);
}

function getSyntaxTokenKey(index) {
  let value = Math.max(0, Number(index) || 0);
  let key = "";

  do {
    key = String.fromCharCode(97 + (value % 26)) + key;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);

  return key;
}

function restoreSyntaxTokens(output, tokens) {
  return output.replace(/%%RV_SYNTAX_([a-z]+)%%/g, (_match, key) => tokens[key] || "");
}

function highlightCode(code, language = "text") {
  const normalizedLanguage = normalizeSyntaxLanguage(language);
  const tokens = [];
  const stash = (html) => {
    const key = getSyntaxTokenKey(Object.keys(tokens).length);
    tokens[key] = html;
    return `%%RV_SYNTAX_${key}%%`;
  };
  let output = escapeHtml(code);

  const protect = (pattern, className) => {
    output = output.replace(pattern, (match) => stash(`<span class="${className}">${match}</span>`));
  };

  protect(/(&quot;(?:\\.|[^"&])*?&quot;|'(?:\\.|[^'])*?'|`(?:\\.|[^`])*?`)/g, "syntax-string");
  protect(/(&lt;!--[\s\S]*?--&gt;|\/\*[\s\S]*?\*\/|\/\/.*$|^\s*#.*$)/gm, "syntax-comment");

  if (["html", "xml", "svg"].includes(normalizedLanguage)) {
    protect(/(&lt;\/?)([a-zA-Z][\w:-]*)([^&]*?)(\/?&gt;)/g, "syntax-tag");
  }

  if (["json", "yaml", "toml"].includes(normalizedLanguage)) {
    protect(/\b(true|false|null)\b/g, "syntax-literal");
    protect(/\b-?\d+(?:\.\d+)?\b/g, "syntax-number");
    output = output.replace(/(^|\s)([A-Za-z0-9_.-]+)(\s*:)/gm, (_match, lead, key, suffix) =>
      `${lead}<span class="syntax-key">${key}</span>${suffix}`,
    );
  } else {
    const keywordPattern =
      /\b(async|await|break|case|catch|class|const|continue|def|default|do|elif|else|enum|export|extends|false|finally|for|from|func|function|go|if|import|in|interface|let|match|new|null|package|private|protected|public|return|self|static|struct|switch|this|throw|true|try|type|var|void|while|yield)\b/g;
    protect(keywordPattern, "syntax-keyword");
    protect(/\b-?\d+(?:\.\d+)?\b/g, "syntax-number");
  }

  return restoreSyntaxTokens(output, tokens);
}

function renderSyntaxCodeBlock(code, language = "text", className = "") {
  const normalizedLanguage = normalizeSyntaxLanguage(language);
  return `<pre class="${className} syntax-code language-${escapeHtml(normalizedLanguage)}"><code>${highlightCode(
    code,
    normalizedLanguage,
  )}</code></pre>`;
}

function normalizeAbsolutePathForCompare(value) {
  return String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
}

function getAbsolutePathAliases(value) {
  const normalized = normalizeAbsolutePathForCompare(value);
  if (!normalized) {
    return [];
  }

  const aliases = new Set([normalized]);
  if (normalized === "/private/tmp") {
    aliases.add("/tmp");
  } else if (normalized.startsWith("/private/tmp/")) {
    aliases.add(`/tmp/${normalized.slice("/private/tmp/".length)}`);
  } else if (normalized === "/tmp") {
    aliases.add("/private/tmp");
  } else if (normalized.startsWith("/tmp/")) {
    aliases.add(`/private/tmp/${normalized.slice("/tmp/".length)}`);
  }

  return Array.from(aliases);
}

function isAbsolutePathSameOrNested(candidatePath, rootPath) {
  const candidateAliases = getAbsolutePathAliases(candidatePath);
  const rootAliases = getAbsolutePathAliases(rootPath);

  return candidateAliases.some((candidate) =>
    rootAliases.some(
      (root) => candidate === root || (root === "/" ? candidate.startsWith(root) : candidate.startsWith(`${root}/`)),
    ),
  );
}

function joinWorkspacePath(root, relativePath) {
  const normalizedRoot = normalizeAbsolutePathForCompare(root);
  const normalizedRelative = normalizeFileTreePath(relativePath);

  if (!normalizedRoot) {
    return "";
  }

  return normalizedRelative ? `${normalizedRoot}/${normalizedRelative}` : normalizedRoot;
}

function getKnowledgeBaseNotePathForWorkspaceFile(relativePath) {
  const normalizedRelative = normalizeFileTreePath(relativePath);
  if (!normalizedRelative || !isMarkdownFilePath(normalizedRelative)) {
    return "";
  }

  const filesRoot = normalizeAbsolutePathForCompare(state.filesRoot || state.defaultCwd);
  const wikiRoot = normalizeAbsolutePathForCompare(state.knowledgeBase.rootPath || state.settings.wikiPath);
  const absoluteFilePath = joinWorkspacePath(filesRoot, normalizedRelative);

  if (!filesRoot || !wikiRoot || !absoluteFilePath) {
    return "";
  }

  for (const filePathAlias of getAbsolutePathAliases(absoluteFilePath)) {
    for (const wikiRootAlias of getAbsolutePathAliases(wikiRoot)) {
      if (filePathAlias === wikiRootAlias) {
        return "";
      }

      if (filePathAlias.startsWith(`${wikiRootAlias}/`)) {
        return normalizeFileTreePath(filePathAlias.slice(wikiRootAlias.length + 1));
      }
    }
  }

  return "";
}

function hasKnowledgeBaseNote(relativePath) {
  const normalizedPath = normalizeFileTreePath(relativePath);
  return state.knowledgeBase.notes.some((note) => note.relativePath === normalizedPath);
}

function getActiveOpenFileTab() {
  const activePath = normalizeFileTreePath(state.openFileRelativePath);
  return state.openFileTabs.find((tab) => tab.relativePath === activePath) || null;
}

function isOpenFileDirty(tab = getActiveOpenFileTab()) {
  return tab?.status === "text" && tab.draft !== tab.content;
}

function syncOpenFileStateFromTab(tab = getActiveOpenFileTab()) {
  if (!tab) {
    state.openFileRelativePath = "";
    state.openFileName = "";
    state.openFileStatus = "idle";
    state.openFileContent = "";
    state.openFileDraft = "";
    state.openFileMessage = "";
    state.openFileSaving = false;
    return;
  }

  state.openFileRelativePath = tab.relativePath;
  state.openFileName = tab.name;
  state.openFileStatus = tab.status;
  state.openFileContent = tab.content;
  state.openFileDraft = tab.draft;
  state.openFileMessage = tab.message;
  state.openFileSaving = tab.saving;
}

function ensureOpenFileTab(relativePath, { mode = "text", name = "", url, externalUrl, port } = {}) {
  const normalizedPath = normalizeFileTreePath(relativePath);
  if (!normalizedPath) {
    return null;
  }

  let tab = state.openFileTabs.find((entry) => entry.relativePath === normalizedPath);
  if (!tab) {
    tab = {
      relativePath: normalizedPath,
      name: name || getFileDisplayName(normalizedPath),
      mode,
      status: "loading",
      content: "",
      draft: "",
      message: "",
      saving: false,
      viewMode: "preview",
      requestId: 0,
      url: url || "",
      externalUrl: externalUrl || "",
      port: port ?? null,
      imageZoom: 1,
      imageOffsetX: 0,
      imageOffsetY: 0,
    };
    state.openFileTabs.push(tab);
  } else {
    tab.mode = mode || tab.mode;
    if (name) {
      tab.name = name;
    }
    if (url !== undefined) {
      tab.url = url || "";
    }
    if (externalUrl !== undefined) {
      tab.externalUrl = externalUrl || "";
    }
    if (port !== undefined) {
      tab.port = port;
    }
  }

  state.openFileRelativePath = normalizedPath;
  syncOpenFileStateFromTab(tab);
  return tab;
}

function resetOpenFile() {
  state.openFileRequestId += 1;
  state.openFileTabs = [];
  state.openFileRelativePath = "";
  state.openFileName = "";
  state.openFileStatus = "idle";
  state.openFileContent = "";
  state.openFileDraft = "";
  state.openFileMessage = "";
  state.openFileSaving = false;
}

function setOpenFileSelection(relativePath, { status = "external", message = "opened in a new tab" } = {}) {
  const normalizedPath = normalizeFileTreePath(relativePath);
  const tab = ensureOpenFileTab(normalizedPath, {
    mode: status === "image" ? "image" : status === "text" ? "text" : "raw",
  });
  if (!tab) {
    return;
  }

  state.openFileRequestId += 1;
  tab.status = status;
  tab.content = "";
  tab.draft = "";
  tab.message = message;
  tab.saving = false;
  tab.requestId = state.openFileRequestId;
  syncOpenFileStateFromTab(tab);
}

function getOpenImageZoom(tab = getActiveOpenFileTab()) {
  const zoom = Number(tab?.imageZoom);
  return Number.isFinite(zoom) ? clamp(zoom, FILE_IMAGE_MIN_ZOOM, FILE_IMAGE_MAX_ZOOM) : 1;
}

function getOpenImageOffset(tab = getActiveOpenFileTab()) {
  const offsetX = Number(tab?.imageOffsetX);
  const offsetY = Number(tab?.imageOffsetY);
  return {
    x: Number.isFinite(offsetX) ? offsetX : 0,
    y: Number.isFinite(offsetY) ? offsetY : 0,
  };
}

function setOpenImageTransform(tab, { zoom = tab?.imageZoom, offsetX = tab?.imageOffsetX, offsetY = tab?.imageOffsetY } = {}) {
  if (!tab) {
    return;
  }

  tab.imageZoom = getOpenImageZoom({ imageZoom: zoom });
  tab.imageOffsetX = Number.isFinite(Number(offsetX)) ? Number(offsetX) : 0;
  tab.imageOffsetY = Number.isFinite(Number(offsetY)) ? Number(offsetY) : 0;
}

function getOpenImageTransformStyle(tab = getActiveOpenFileTab()) {
  const zoom = getOpenImageZoom(tab);
  const offset = getOpenImageOffset(tab);
  return `--image-zoom:${zoom};--image-x:${offset.x}px;--image-y:${offset.y}px;`;
}

function getOpenImageZoomLabel(tab = getActiveOpenFileTab()) {
  return `${Math.round(getOpenImageZoom(tab) * 100)}%`;
}

function buildAppUrl(params = new URLSearchParams()) {
  const query = params.toString();
  return `${getAppBaseUrl()}/${query ? `?${query}` : ""}`;
}

function getWorkspaceUrl() {
  const params = new URLSearchParams();

  if (state.filesRoot) {
    params.set("root", state.filesRoot);
  }

  return buildAppUrl(params);
}

function openFileInNewTab(relativePath) {
  window.open(getFileContentUrl(relativePath), "_blank", "noopener,noreferrer");
}

function openTextFileInNewTab(relativePath) {
  const normalizedPath = normalizeFileTreePath(relativePath);
  if (!normalizedPath) {
    return;
  }

  const params = getFileTextRequestParams(normalizedPath);
  params.set("view", "file");
  window.open(buildAppUrl(params), "_blank", "noopener,noreferrer");
}

function getActiveSession() {
  return state.sessions.find((session) => session.id === state.activeSessionId) || null;
}

function getPreferredFilesRoot() {
  return state.filesRootOverride || getActiveSession()?.cwd || state.defaultCwd || "";
}

function syncFilesRoot({ force = false } = {}) {
  const nextRoot = normalizeWorkspaceRoot(getPreferredFilesRoot());

  if (!force && nextRoot === state.filesRoot) {
    return false;
  }

  state.filesRoot = nextRoot;
  state.fileTreeEntries = {};
  state.fileTreeExpanded = new Set([""]);
  state.fileTreeLoading = new Set();
  state.fileTreeError = "";
  resetOpenFile();
  return true;
}

async function applyFilesRoot(rootValue, { force = false } = {}) {
  state.filesRootOverride = normalizeWorkspaceRoot(rootValue) || null;
  syncFilesRoot({ force: true });
  refreshFileTreeUi();
  refreshOpenFileUi();
  await refreshOpenFileTree({ force });
}

function getFileContentUrlForRoot(root, relativePath) {
  const params = new URLSearchParams();

  if (root) {
    params.set("root", root);
  }

  if (relativePath) {
    params.set("path", relativePath);
  }

  return `${getAppBaseUrl()}/api/files/content?${params.toString()}`;
}

function getFileContentUrl(relativePath) {
  return getFileContentUrlForRoot(state.filesRoot, relativePath);
}

function getKnowledgeBaseNoteRawUrl(relativePath) {
  const params = new URLSearchParams();

  if (state.knowledgeBase.rootPath) {
    params.set("root", state.knowledgeBase.rootPath);
  }

  if (relativePath) {
    params.set("path", relativePath);
  }

  return `${getAppBaseUrl()}/api/files/content?${params.toString()}`;
}

function getKnowledgeBaseBackupRepoUrl() {
  const remoteUrl = String(state.settings.wikiGitRemoteUrl || "").trim();
  if (!remoteUrl) {
    return "";
  }

  const githubSshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (githubSshMatch) {
    return `https://github.com/${githubSshMatch[1]}`;
  }

  try {
    const parsedUrl = new URL(remoteUrl);
    if (parsedUrl.hostname.toLowerCase() === "github.com") {
      parsedUrl.username = "";
      parsedUrl.password = "";
      parsedUrl.pathname = parsedUrl.pathname.replace(/\.git$/i, "");
      parsedUrl.search = "";
      parsedUrl.hash = "";
      return parsedUrl.toString().replace(/\/$/, "");
    }
  } catch {
    // Non-browser git remotes are still useful in settings, just not as links.
  }

  return /^https?:\/\//i.test(remoteUrl) ? remoteUrl : "";
}

function getFileTextRequestParamsForRoot(root, relativePath) {
  const params = new URLSearchParams();

  if (root) {
    params.set("root", root);
  }

  if (relativePath) {
    params.set("path", relativePath);
  }

  return params;
}

function getFileTextRequestParams(relativePath) {
  return getFileTextRequestParamsForRoot(state.filesRoot, relativePath);
}

function updateRoute({
  view = state.currentView,
  notePath = state.knowledgeBase.selectedNotePath,
  filePath = state.openFileRelativePath,
  root = state.filesRoot,
} = {}) {
  const url = new URL(window.location.href);
  const normalizedRoot = normalizeWorkspaceRoot(root);

  if (normalizedRoot) {
    url.searchParams.set("root", normalizedRoot);
  } else {
    url.searchParams.delete("root");
  }

  if (view === "knowledge-base") {
    url.searchParams.set("view", "knowledge-base");
    const normalizedNotePath = normalizeFileTreePath(notePath);

    if (normalizedNotePath) {
      url.searchParams.set("note", normalizedNotePath);
    } else {
      url.searchParams.delete("note");
    }

    url.searchParams.delete("path");
    url.hash = "";
  } else if (view === "agent-prompt") {
    url.searchParams.set("view", "agent-prompt");
    url.searchParams.delete("note");
    url.searchParams.delete("path");
    url.hash = "";
  } else if (ROUTED_MAIN_VIEWS.has(view)) {
    url.searchParams.set("view", view);
    url.searchParams.delete("note");
    url.searchParams.delete("path");
    url.hash = "";
  } else if (view === "file") {
    url.searchParams.set("view", "file");
    url.searchParams.delete("note");
    const normalizedFilePath = normalizeFileTreePath(filePath);

    if (normalizedFilePath) {
      url.searchParams.set("path", normalizedFilePath);
    } else {
      url.searchParams.delete("path");
    }

    url.hash = "";
  } else {
    url.searchParams.delete("view");
    url.searchParams.delete("note");
    url.searchParams.delete("path");
    url.hash = "";
  }

  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function getKnowledgeBaseDefaultNotePath() {
  const notes = state.knowledgeBase.notes;

  if (!notes.length) {
    return "";
  }

  return notes.find((note) => note.relativePath === "index.md")?.relativePath || notes[0].relativePath;
}

function getKnowledgeBaseSelectedNoteMeta() {
  return state.knowledgeBase.notes.find((note) => note.relativePath === state.knowledgeBase.selectedNotePath) || null;
}

function getKnowledgeBaseSearchQuery() {
  return String(state.knowledgeBase.searchQuery || "").trim().toLowerCase();
}

function tokenizeKnowledgeBaseSearchText(value) {
  return String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

function getUniqueKnowledgeBaseSearchTerms(query) {
  return Array.from(new Set(tokenizeKnowledgeBaseSearchText(query)));
}

function buildKnowledgeBaseSearchIndex(notes) {
  const postings = new Map();
  const documents = notes.map((note, index) => {
    const termCounts = new Map();
    let length = 0;

    for (const [fieldName, weight] of KNOWLEDGE_BASE_SEARCH_FIELD_WEIGHTS) {
      for (const term of tokenizeKnowledgeBaseSearchText(note[fieldName])) {
        termCounts.set(term, (termCounts.get(term) || 0) + weight);
        length += weight;
      }
    }

    for (const [term, termFrequency] of termCounts) {
      if (!postings.has(term)) {
        postings.set(term, new Map());
      }

      postings.get(term).set(index, termFrequency);
    }

    return {
      note,
      index,
      length: Math.max(1, length),
    };
  });

  const totalLength = documents.reduce((sum, document) => sum + document.length, 0);

  return {
    documents,
    postings,
    terms: Array.from(postings.keys()).sort(),
    averageLength: documents.length ? totalLength / documents.length : 1,
  };
}

function getKnowledgeBaseSearchIndex(notes) {
  if (knowledgeBaseSearchIndexCache.notes === notes && knowledgeBaseSearchIndexCache.index) {
    return knowledgeBaseSearchIndexCache.index;
  }

  const index = buildKnowledgeBaseSearchIndex(notes);
  knowledgeBaseSearchIndexCache = {
    notes,
    index,
  };
  knowledgeBaseSearchResultsCache = {
    notes: null,
    query: "",
    results: null,
  };

  return index;
}

function fieldMatchesKnowledgeBaseSearchPrefixes(value, queryTerms) {
  const fieldTerms = tokenizeKnowledgeBaseSearchText(value);
  return queryTerms.every((queryTerm) => fieldTerms.some((fieldTerm) => fieldTerm.startsWith(queryTerm)));
}

function getKnowledgeBaseExactMatchBoost(note, query, queryTerms) {
  const title = String(note.title || "").toLowerCase();
  const relativePath = String(note.relativePath || "").toLowerCase();
  const excerpt = String(note.excerpt || "").toLowerCase();
  let boost = 0;

  if (title === query) {
    boost += 3;
  }

  if (title.includes(query)) {
    boost += 1.5;
  }

  if (relativePath.includes(query)) {
    boost += 1;
  }

  if (excerpt.includes(query)) {
    boost += 0.25;
  }

  if (fieldMatchesKnowledgeBaseSearchPrefixes(title, queryTerms)) {
    boost += 4;
  }

  if (fieldMatchesKnowledgeBaseSearchPrefixes(relativePath, queryTerms)) {
    boost += 2;
  }

  if (fieldMatchesKnowledgeBaseSearchPrefixes(excerpt, queryTerms)) {
    boost += 0.5;
  }

  return boost;
}

function getKnowledgeBaseSearchTermMatches(index, queryTerm) {
  const matches = [];
  const exactPostings = index.postings.get(queryTerm);

  if (exactPostings) {
    matches.push({
      term: queryTerm,
      postings: exactPostings,
      weight: 1,
    });
  }

  if (queryTerm.length < KNOWLEDGE_BASE_SEARCH_PREFIX_MIN_LENGTH) {
    return matches;
  }

  for (const term of index.terms) {
    if (term === queryTerm || !term.startsWith(queryTerm)) {
      continue;
    }

    matches.push({
      term,
      postings: index.postings.get(term),
      weight: Math.max(0.35, queryTerm.length / term.length),
    });
  }

  return matches;
}

function scoreKnowledgeBaseSearch(query, notes) {
  const terms = getUniqueKnowledgeBaseSearchTerms(query);
  if (!terms.length) {
    return notes;
  }

  const index = getKnowledgeBaseSearchIndex(notes);
  const scores = new Map();
  const matchedTermCounts = new Map();
  const documentCount = index.documents.length;

  for (const queryTerm of terms) {
    const matches = getKnowledgeBaseSearchTermMatches(index, queryTerm);
    if (!matches.length) {
      return [];
    }

    const matchedDocuments = new Set();

    for (const match of matches) {
      const documentFrequency = match.postings.size;
      const inverseDocumentFrequency = Math.log(
        1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
      );

      for (const [documentIndex, termFrequency] of match.postings) {
        const document = index.documents[documentIndex];
        const lengthNormalization =
          1 - KNOWLEDGE_BASE_BM25_B +
          KNOWLEDGE_BASE_BM25_B * (document.length / index.averageLength);
        const score =
          match.weight *
          inverseDocumentFrequency *
          ((termFrequency * (KNOWLEDGE_BASE_BM25_K1 + 1)) /
            (termFrequency + KNOWLEDGE_BASE_BM25_K1 * lengthNormalization));

        scores.set(documentIndex, (scores.get(documentIndex) || 0) + score);
        matchedDocuments.add(documentIndex);
      }
    }

    for (const documentIndex of matchedDocuments) {
      matchedTermCounts.set(documentIndex, (matchedTermCounts.get(documentIndex) || 0) + 1);
    }
  }

  return Array.from(scores, ([documentIndex, score]) => {
    const document = index.documents[documentIndex];
    return {
      note: document.note,
      index: document.index,
      score: score + getKnowledgeBaseExactMatchBoost(document.note, query, terms),
    };
  })
    .filter((result) => matchedTermCounts.get(result.index) === terms.length)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.index - right.index;
    })
    .map((result) => result.note);
}

function getFilteredKnowledgeBaseNotes() {
  const query = getKnowledgeBaseSearchQuery();
  const notes = state.knowledgeBase.notes;

  if (!query) {
    return notes;
  }

  if (
    knowledgeBaseSearchResultsCache.notes === notes &&
    knowledgeBaseSearchResultsCache.query === query &&
    knowledgeBaseSearchResultsCache.results
  ) {
    return knowledgeBaseSearchResultsCache.results;
  }

  const results = scoreKnowledgeBaseSearch(query, notes);
  knowledgeBaseSearchResultsCache = {
    notes,
    query,
    results,
  };

  return results;
}

function truncateKnowledgeBaseLabel(value, maxLength = 16) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

function hashString(value) {
  let hash = 0;

  for (const char of String(value || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return hash;
}

function isKnowledgeBaseProjectGroup(groupKey) {
  return String(groupKey || "").startsWith(KNOWLEDGE_BASE_GRAPH_PROJECT_PREFIX);
}

function buildKnowledgeBaseProjectColor(groupKey) {
  const hue = hashString(groupKey) % 360;
  const fill = `hsla(${hue}, 72%, 64%, 0.62)`;
  const stroke = `hsla(${hue}, 78%, 70%, 0.9)`;
  const label = `hsl(${hue}, 85%, 88%)`;
  return {
    fill,
    stroke,
    label,
    connectedFill: `hsla(${hue}, 78%, 66%, 0.82)`,
    connectedStroke: `hsla(${hue}, 86%, 74%, 0.98)`,
    edge: `hsla(${hue}, 78%, 66%, 0.22)`,
  };
}

function getKnowledgeBaseGraphGroupKey(relativePath) {
  const normalizedPath = normalizeFileTreePath(relativePath);

  if (!normalizedPath) {
    return "root";
  }

  if (normalizedPath === "index.md") {
    return "index";
  }

  if (normalizedPath === "log.md") {
    return "log";
  }

  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments[0] === "projects" && segments[1]) {
    return `${KNOWLEDGE_BASE_GRAPH_PROJECT_PREFIX}${segments[1]}`;
  }

  if (segments.length > 1) {
    return segments[0];
  }

  return "root";
}

function getKnowledgeBaseGraphColor(groupKey) {
  const normalizedKey = String(groupKey || "root").toLowerCase();
  if (isKnowledgeBaseProjectGroup(normalizedKey)) {
    return buildKnowledgeBaseProjectColor(normalizedKey);
  }

  const knownPalette = {
    index: KNOWLEDGE_BASE_GRAPH_COLOR_PALETTE[0],
    log: KNOWLEDGE_BASE_GRAPH_COLOR_PALETTE[2],
    topics: KNOWLEDGE_BASE_GRAPH_COLOR_PALETTE[1],
    experiments: KNOWLEDGE_BASE_GRAPH_COLOR_PALETTE[3],
    procedures: KNOWLEDGE_BASE_GRAPH_COLOR_PALETTE[4],
    entities: KNOWLEDGE_BASE_GRAPH_COLOR_PALETTE[5],
    root: KNOWLEDGE_BASE_GRAPH_COLOR_PALETTE[0],
  };

  if (knownPalette[normalizedKey]) {
    return knownPalette[normalizedKey];
  }

  return KNOWLEDGE_BASE_GRAPH_COLOR_PALETTE[hashString(normalizedKey) % KNOWLEDGE_BASE_GRAPH_COLOR_PALETTE.length];
}

function getKnowledgeBaseGraphGroupLabel(groupKey) {
  const normalizedKey = String(groupKey || "root").toLowerCase();
  if (isKnowledgeBaseProjectGroup(normalizedKey)) {
    return normalizedKey.slice(KNOWLEDGE_BASE_GRAPH_PROJECT_PREFIX.length);
  }

  const labels = {
    index: "index",
    log: "log",
    root: "root notes",
  };

  return labels[normalizedKey] || normalizedKey;
}

function getKnowledgeBaseGraphGroupSortRank(groupKey) {
  const normalizedKey = String(groupKey || "root").toLowerCase();
  if (isKnowledgeBaseProjectGroup(normalizedKey)) {
    return 20;
  }

  const knownOrder = ["index", "log", "root", "topics", "experiments", "procedures", "entities"];
  const knownIndex = knownOrder.indexOf(normalizedKey);
  return knownIndex === -1 ? 40 : knownIndex;
}

function renderKnowledgeBaseGraphLegend(layout) {
  const groups = new Map();

  for (const node of layout.nodes || []) {
    const groupKey = node.groupKey || "root";
    const group = groups.get(groupKey) || {
      key: groupKey,
      label: getKnowledgeBaseGraphGroupLabel(groupKey),
      color: node.color || getKnowledgeBaseGraphColor(groupKey),
      count: 0,
    };
    group.count += 1;
    groups.set(groupKey, group);
  }

  if (!groups.size) {
    return "";
  }

  const orderedGroups = [...groups.values()].sort((left, right) => {
    const leftRank = getKnowledgeBaseGraphGroupSortRank(left.key);
    const rightRank = getKnowledgeBaseGraphGroupSortRank(right.key);

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return left.label.localeCompare(right.label);
  });

  return `
    <div class="knowledge-base-graph-legend" aria-label="Knowledge graph color legend">
      ${orderedGroups
        .map(
          (group) => `
            <div
              class="knowledge-base-graph-legend-item"
              ${renderStyleVariables({
                "--kb-legend-fill": group.color?.fill,
                "--kb-legend-stroke": group.color?.stroke,
              })}
            >
              <span class="knowledge-base-graph-legend-swatch" aria-hidden="true"></span>
              <span class="knowledge-base-graph-legend-label">${escapeHtml(group.label)}</span>
              <span class="knowledge-base-graph-legend-count">${group.count}</span>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderStyleVariables(variables) {
  const entries = Object.entries(variables || {}).filter(([, value]) => value !== undefined && value !== null && value !== "");

  if (!entries.length) {
    return "";
  }

  return ` style="${entries
    .map(([name, value]) => `${name}:${String(value).replaceAll('"', "&quot;")}`)
    .join(";")}"`;
}

function createEmptyKnowledgeBaseGraphLayout(previousLayout = null) {
  return {
    width: KNOWLEDGE_BASE_GRAPH_WIDTH,
    height: KNOWLEDGE_BASE_GRAPH_HEIGHT,
    nodes: [],
    edges: [],
    groupAnchors: {},
    scale: previousLayout?.scale ?? 1,
    offsetX: previousLayout?.offsetX ?? 0,
    offsetY: previousLayout?.offsetY ?? 0,
    alpha: 0,
    running: false,
    frameHandle: 0,
    dragState: null,
    panState: null,
    hoveredPath: previousLayout?.hoveredPath ?? "",
    refs: null,
    cleanup: null,
    cameraInitialized: previousLayout?.cameraInitialized ?? false,
  };
}

function stopKnowledgeBaseGraphSimulation() {
  const layout = state.knowledgeBase.graphLayout;

  if (layout.frameHandle) {
    window.cancelAnimationFrame(layout.frameHandle);
    layout.frameHandle = 0;
  }

  layout.running = false;
}

function teardownKnowledgeBaseGraphInteractions() {
  const layout = state.knowledgeBase.graphLayout;
  stopKnowledgeBaseGraphSimulation();
  layout.cleanup?.();
  layout.cleanup = null;
  layout.refs = null;
  layout.dragState = null;
  layout.panState = null;
  layout.hoveredPath = "";
}

function getKnowledgeBaseGraphSvgPoint(svg, clientX, clientY) {
  if (!(svg instanceof SVGSVGElement)) {
    return null;
  }

  const matrix = svg.getScreenCTM();
  if (!matrix) {
    return null;
  }

  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  return point.matrixTransform(matrix.inverse());
}

function getKnowledgeBaseGraphWorldPoint(svg, clientX, clientY) {
  const layout = state.knowledgeBase.graphLayout;
  const point = getKnowledgeBaseGraphSvgPoint(svg, clientX, clientY);

  if (!point) {
    return null;
  }

  return {
    svgX: point.x,
    svgY: point.y,
    x: (point.x - layout.offsetX) / layout.scale,
    y: (point.y - layout.offsetY) / layout.scale,
  };
}

function syncKnowledgeBaseGraphDom() {
  const layout = state.knowledgeBase.graphLayout;
  const refs = layout.refs;

  if (!refs?.viewport) {
    return;
  }

  refs.viewport.setAttribute(
    "transform",
    `translate(${layout.offsetX.toFixed(2)} ${layout.offsetY.toFixed(2)}) scale(${layout.scale.toFixed(4)})`,
  );

  const selectedPath = state.knowledgeBase.selectedNotePath;
  const activePath = layout.hoveredPath || selectedPath;
  const connectedPaths = new Set(activePath ? [activePath] : []);

  layout.edges.forEach((edge, index) => {
    const source = layout.nodes[edge.sourceIndex];
    const target = layout.nodes[edge.targetIndex];
    const element = refs.edgeElements[index];

    if (!source || !target || !(element instanceof SVGLineElement)) {
      return;
    }

    const isConnected = Boolean(activePath && (edge.source === activePath || edge.target === activePath));
    element.classList.toggle("is-connected", isConnected);
    if (isConnected) {
      connectedPaths.add(edge.source);
      connectedPaths.add(edge.target);
    }

    element.setAttribute("x1", source.x.toFixed(2));
    element.setAttribute("y1", source.y.toFixed(2));
    element.setAttribute("x2", target.x.toFixed(2));
    element.setAttribute("y2", target.y.toFixed(2));
  });

  layout.nodes.forEach((node, index) => {
    const element = refs.nodeElements[index];
    if (!(element instanceof SVGGElement)) {
      return;
    }

    element.setAttribute("transform", `translate(${node.x.toFixed(2)} ${node.y.toFixed(2)})`);
    element.classList.toggle("is-dragging", layout.dragState?.node?.relativePath === node.relativePath);
    element.classList.toggle("is-hovered", layout.hoveredPath === node.relativePath);
    element.classList.toggle("is-selected", selectedPath === node.relativePath);
    element.classList.toggle("is-connected", connectedPaths.has(node.relativePath));
  });

  refs.svg.classList.toggle("is-panning", Boolean(layout.panState));
  refs.svg.classList.toggle("is-dragging-node", Boolean(layout.dragState));
}

function fitKnowledgeBaseGraphCamera() {
  const layout = state.knowledgeBase.graphLayout;

  if (!layout.nodes.length) {
    return;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of layout.nodes) {
    minX = Math.min(minX, node.x - node.radius - 20);
    minY = Math.min(minY, node.y - node.radius - 24);
    maxX = Math.max(maxX, node.x + node.radius + 20);
    maxY = Math.max(maxY, node.y + node.radius + 24);
  }

  const contentWidth = Math.max(180, maxX - minX);
  const contentHeight = Math.max(180, maxY - minY);
  const availableWidth = Math.max(120, layout.width - KNOWLEDGE_BASE_GRAPH_FIT_PADDING);
  const availableHeight = Math.max(120, layout.height - KNOWLEDGE_BASE_GRAPH_FIT_PADDING);
  const nextScale = clamp(
    Math.min(availableWidth / contentWidth, availableHeight / contentHeight),
    KNOWLEDGE_BASE_GRAPH_MIN_SCALE,
    KNOWLEDGE_BASE_GRAPH_MAX_SCALE,
  );

  layout.scale = nextScale;
  layout.offsetX = layout.width / 2 - ((minX + maxX) / 2) * nextScale;
  layout.offsetY = layout.height / 2 - ((minY + maxY) / 2) * nextScale;
  layout.cameraInitialized = true;
  syncKnowledgeBaseGraphDom();
}

function focusKnowledgeBaseGraphNode(relativePath) {
  const layout = state.knowledgeBase.graphLayout;
  const normalizedPath = normalizeFileTreePath(relativePath);

  if (!normalizedPath || !layout.nodes.length) {
    return false;
  }

  const node = layout.nodes.find((entry) => entry.relativePath === normalizedPath);
  if (!node) {
    return false;
  }

  const nextScale = clamp(
    Math.max(layout.scale || 1, KNOWLEDGE_BASE_GRAPH_FOCUS_SCALE),
    KNOWLEDGE_BASE_GRAPH_MIN_SCALE,
    KNOWLEDGE_BASE_GRAPH_MAX_SCALE,
  );

  layout.scale = nextScale;
  layout.offsetX = layout.width / 2 - node.x * nextScale;
  layout.offsetY = layout.height / 2 - node.y * nextScale;
  layout.cameraInitialized = true;
  syncKnowledgeBaseGraphDom();
  return true;
}

function requestKnowledgeBaseGraphFocus(relativePath) {
  const normalizedPath = normalizeFileTreePath(relativePath);
  if (!normalizedPath) {
    return;
  }

  state.knowledgeBase.pendingGraphFocusPath = normalizedPath;
}

function applyPendingKnowledgeBaseGraphFocus() {
  const pendingPath = state.knowledgeBase.pendingGraphFocusPath;

  if (!pendingPath) {
    return false;
  }

  if (!focusKnowledgeBaseGraphNode(pendingPath)) {
    return false;
  }

  state.knowledgeBase.pendingGraphFocusPath = "";
  return true;
}

function requestKnowledgeBaseGraphReplay() {
  state.knowledgeBase.replayGraphOnNextBind = true;
}

function replayKnowledgeBaseGraphUnfold() {
  const layout = state.knowledgeBase.graphLayout;

  if (!layout.nodes.length) {
    return false;
  }

  const centerX = layout.width / 2;
  const centerY = layout.height / 2;
  const spreadRadius = Math.min(layout.width, layout.height) * 0.055;
  const velocityBase = Math.min(layout.width, layout.height) * 0.0032;

  layout.scale = 1;
  layout.offsetX = 0;
  layout.offsetY = 0;
  layout.cameraInitialized = true;

  layout.nodes.forEach((node, index) => {
    const currentAngle = Math.atan2(node.y - centerY, node.x - centerX);
    const angle = Number.isFinite(currentAngle)
      ? currentAngle
      : (Math.PI * 2 * index) / Math.max(layout.nodes.length, 1);
    const radius = 8 + (index % 5) * (spreadRadius / 5);
    const velocity = velocityBase + (index % 4) * 0.18;

    node.x = centerX + Math.cos(angle) * radius;
    node.y = centerY + Math.sin(angle) * radius;
    node.vx = Math.cos(angle) * velocity;
    node.vy = Math.sin(angle) * velocity;
    node.fx = 0;
    node.fy = 0;
  });

  syncKnowledgeBaseGraphDom();
  startKnowledgeBaseGraphSimulation(0.42);
  return true;
}

function scheduleKnowledgeBaseGraphFrame() {
  const layout = state.knowledgeBase.graphLayout;

  if (layout.frameHandle || !layout.running) {
    return;
  }

  layout.frameHandle = window.requestAnimationFrame(() => {
    layout.frameHandle = 0;

    if (!layout.running || !layout.nodes.length) {
      return;
    }

    const physics = KNOWLEDGE_BASE_GRAPH_PHYSICS;
    const centerX = layout.width / 2;
    const centerY = layout.height / 2;
    const damping = layout.dragState ? physics.dragDamping : physics.damping;
    const alphaTarget = layout.dragState ? physics.dragAlphaTarget : 0;
    const alpha = Math.max(layout.alpha || 0, alphaTarget);

    for (const node of layout.nodes) {
      const anchor = layout.groupAnchors?.[node.groupKey] || { x: centerX, y: centerY };
      const anchorStrength = isKnowledgeBaseProjectGroup(node.groupKey)
        ? physics.projectAnchorStrength
        : physics.groupAnchorStrength;
      node.fx = (anchor.x - node.x) * anchorStrength + (centerX - node.x) * physics.centerStrength;
      node.fy = (anchor.y - node.y) * anchorStrength + (centerY - node.y) * physics.centerStrength;

      const rightBoundary = layout.width - physics.boundaryMargin;
      const bottomBoundary = layout.height - physics.boundaryMargin;
      if (node.x < physics.boundaryMargin) {
        node.fx += (physics.boundaryMargin - node.x) * physics.boundaryStrength;
      } else if (node.x > rightBoundary) {
        node.fx -= (node.x - rightBoundary) * physics.boundaryStrength;
      }

      if (node.y < physics.boundaryMargin) {
        node.fy += (physics.boundaryMargin - node.y) * physics.boundaryStrength;
      } else if (node.y > bottomBoundary) {
        node.fy -= (node.y - bottomBoundary) * physics.boundaryStrength;
      }
    }

    for (let leftIndex = 0; leftIndex < layout.nodes.length; leftIndex += 1) {
      const left = layout.nodes[leftIndex];

      for (let rightIndex = leftIndex + 1; rightIndex < layout.nodes.length; rightIndex += 1) {
        const right = layout.nodes[rightIndex];
        const deltaX = right.x - left.x;
        const deltaY = right.y - left.y;
        const distanceSquared = Math.max(deltaX * deltaX + deltaY * deltaY, 1);
        const distance = Math.sqrt(distanceSquared);
        const sameGroup = left.groupKey && left.groupKey === right.groupKey;
        const minimumDistance =
          left.radius + right.radius + (sameGroup ? physics.sameGroupMinimumGap : physics.otherGroupMinimumGap);
        let repulsion =
          ((sameGroup ? physics.sameGroupRepulsionBase : physics.otherGroupRepulsionBase) +
            minimumDistance * (sameGroup ? physics.sameGroupRepulsionRadius : physics.otherGroupRepulsionRadius)) /
          distanceSquared;

        if (distance < minimumDistance) {
          repulsion +=
            (minimumDistance - distance) * (sameGroup ? physics.sameGroupCollisionPush : physics.otherGroupCollisionPush);
        }

        const forceX = (deltaX / distance) * repulsion;
        const forceY = (deltaY / distance) * repulsion;

        left.fx -= forceX;
        left.fy -= forceY;
        right.fx += forceX;
        right.fy += forceY;
      }
    }

    for (const edge of layout.edges) {
      const source = layout.nodes[edge.sourceIndex];
      const target = layout.nodes[edge.targetIndex];

      if (!source || !target) {
        continue;
      }

      const deltaX = target.x - source.x;
      const deltaY = target.y - source.y;
      const distance = Math.max(1, Math.sqrt(deltaX * deltaX + deltaY * deltaY));
      const spring = (distance - edge.distance) * edge.strength;
      const forceX = (deltaX / distance) * spring;
      const forceY = (deltaY / distance) * spring;

      source.fx += forceX;
      source.fy += forceY;
      target.fx -= forceX;
      target.fy -= forceY;
    }

    let maxVelocity = 0;

    for (const node of layout.nodes) {
      if (layout.dragState?.node?.relativePath === node.relativePath) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }

      node.vx = (node.vx + node.fx * alpha) * damping;
      node.vy = (node.vy + node.fy * alpha) * damping;
      const velocity = Math.hypot(node.vx, node.vy);
      const maxNodeVelocity = layout.dragState ? physics.maxDragVelocity : physics.maxVelocity;
      if (velocity > maxNodeVelocity) {
        node.vx = (node.vx / velocity) * maxNodeVelocity;
        node.vy = (node.vy / velocity) * maxNodeVelocity;
      }
      node.x += node.vx;
      node.y += node.vy;

      maxVelocity = Math.max(maxVelocity, Math.abs(node.vx) + Math.abs(node.vy));
    }

    layout.alpha = Math.max(alphaTarget, alpha * physics.alphaDecay - physics.alphaCooling, 0);
    syncKnowledgeBaseGraphDom();

    const shouldContinue =
      Boolean(layout.dragState) || maxVelocity > physics.stopVelocity || layout.alpha > physics.stopAlpha;
    layout.running = shouldContinue;

    if (shouldContinue) {
      scheduleKnowledgeBaseGraphFrame();
    }
  });
}

function startKnowledgeBaseGraphSimulation(boost = 0.16) {
  const layout = state.knowledgeBase.graphLayout;

  if (!layout.nodes.length) {
    return;
  }

  layout.running = true;
  layout.alpha = clamp(Math.max(layout.alpha || 0, boost), 0, KNOWLEDGE_BASE_GRAPH_PHYSICS.maxAlpha);
  scheduleKnowledgeBaseGraphFrame();
}

function createKnowledgeBaseGraphLayout(notes, edges) {
  const previousLayout = state.knowledgeBase.graphLayout;
  const width = KNOWLEDGE_BASE_GRAPH_WIDTH;
  const height = KNOWLEDGE_BASE_GRAPH_HEIGHT;

  if (!notes.length) {
    return createEmptyKnowledgeBaseGraphLayout(previousLayout);
  }

  const centerX = width / 2;
  const centerY = height / 2;
  const previousNodes = new Map((previousLayout?.nodes || []).map((node) => [node.relativePath, node]));
  const groupKeys = Array.from(new Set(notes.map((note) => getKnowledgeBaseGraphGroupKey(note.relativePath)))).sort((left, right) => {
    const leftRank = getKnowledgeBaseGraphGroupSortRank(left);
    const rightRank = getKnowledgeBaseGraphGroupSortRank(right);

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return getKnowledgeBaseGraphGroupLabel(left).localeCompare(getKnowledgeBaseGraphGroupLabel(right));
  });
  const groupAnchors = {};
  const projectGroupKeys = groupKeys.filter(isKnowledgeBaseProjectGroup);
  const nonProjectGroupKeys = groupKeys.filter((groupKey) => !isKnowledgeBaseProjectGroup(groupKey));
  const projectAnchorRadius = Math.min(width, height) * (projectGroupKeys.length > 3 ? 0.46 : 0.38);
  const nonProjectAnchorRadius = Math.min(width, height) * 0.18;

  projectGroupKeys.forEach((groupKey, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(projectGroupKeys.length, 1);
    groupAnchors[groupKey] = {
      x: centerX + Math.cos(angle) * projectAnchorRadius,
      y: centerY + Math.sin(angle) * projectAnchorRadius,
    };
  });

  nonProjectGroupKeys.forEach((groupKey, index) => {
    const angle = Math.PI / 2 + (Math.PI * 2 * index) / Math.max(nonProjectGroupKeys.length, 1);
    groupAnchors[groupKey] = {
      x: centerX + Math.cos(angle) * nonProjectAnchorRadius,
      y: centerY + Math.sin(angle) * nonProjectAnchorRadius,
    };
  });

  const nodes = notes.map((note, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(notes.length, 1);
    const previousNode = previousNodes.get(note.relativePath);
    const groupKey = getKnowledgeBaseGraphGroupKey(note.relativePath);
    const anchor = groupAnchors[groupKey] || { x: centerX, y: centerY };
    const localRadius = 26 + (index % 7) * 7;

    return {
      relativePath: note.relativePath,
      title: note.title,
      groupKey,
      color: getKnowledgeBaseGraphColor(groupKey),
      x: previousNode?.x ?? anchor.x + Math.cos(angle) * localRadius,
      y: previousNode?.y ?? anchor.y + Math.sin(angle) * localRadius,
      vx: previousNode?.vx ?? 0,
      vy: previousNode?.vy ?? 0,
      fx: 0,
      fy: 0,
      degree: 0,
    };
  });
  const nodeMap = new Map(nodes.map((node, index) => [node.relativePath, { node, index }]));
  const filteredEdges = [];

  for (const edge of edges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);

    if (!source || !target) {
      continue;
    }

    source.node.degree += 1;
    target.node.degree += 1;
    filteredEdges.push({
      source: edge.source,
      target: edge.target,
      sourceIndex: source.index,
      targetIndex: target.index,
      key: `${edge.source}:::${edge.target}`,
    });
  }

  const maxDegree = Math.max(1, ...nodes.map((node) => node.degree || 0));
  const graphNodes = nodes.map((node) => ({
    ...node,
    radius: Math.min(30, 5.75 + Math.sqrt(node.degree || 0) * 3.05 + ((node.degree || 0) / maxDegree) * 10.5),
  }));
  const sizedNodeMap = new Map(graphNodes.map((node, index) => [node.relativePath, { node, index }]));
  const physics = KNOWLEDGE_BASE_GRAPH_PHYSICS;
  const previousHoveredPath = previousLayout?.hoveredPath || "";
  const hoveredPath = sizedNodeMap.has(previousHoveredPath) ? previousHoveredPath : "";

  return {
    width,
    height,
    nodes: graphNodes,
    edges: filteredEdges.map((edge) => {
      const source = sizedNodeMap.get(edge.source)?.node;
      const target = sizedNodeMap.get(edge.target)?.node;
      const sameGroup = source?.groupKey && source.groupKey === target?.groupKey;

      return {
        ...edge,
        edgeColor: sameGroup ? source?.color?.edge : "rgba(255, 255, 255, 0.08)",
        distance:
          (sameGroup ? physics.sameGroupLinkDistance : physics.otherGroupLinkDistance) +
          ((source?.radius || 10) + (target?.radius || 10)) *
            (sameGroup ? physics.sameGroupLinkRadius : physics.otherGroupLinkRadius),
        strength:
          (sameGroup ? physics.sameGroupLinkStrength : physics.otherGroupLinkStrength) +
          physics.linkDegreeStrength * Math.min((source?.degree || 0) + (target?.degree || 0), 12),
      };
    }),
    groupAnchors,
    scale: previousLayout?.scale ?? 1,
    offsetX: previousLayout?.offsetX ?? 0,
    offsetY: previousLayout?.offsetY ?? 0,
    alpha: Math.max(previousLayout?.alpha || 0, 0.22),
    running: false,
    frameHandle: 0,
    dragState: null,
    panState: null,
    hoveredPath,
    refs: null,
    cleanup: null,
    cameraInitialized: previousLayout?.cameraInitialized ?? false,
  };
}

function applyKnowledgeBaseIndexState(payload) {
  teardownKnowledgeBaseGraphInteractions();
  state.knowledgeBase.rootPath = payload?.rootPath || "";
  state.knowledgeBase.relativeRoot = payload?.relativeRoot || ".remote-vibes/wiki";
  state.knowledgeBase.notes = Array.isArray(payload?.notes) ? payload.notes : [];
  state.knowledgeBase.edges = Array.isArray(payload?.edges) ? payload.edges : [];
  state.knowledgeBase.graphLayout = createKnowledgeBaseGraphLayout(
    state.knowledgeBase.notes,
    state.knowledgeBase.edges,
  );

  const currentSelection = normalizeFileTreePath(state.knowledgeBase.selectedNotePath);
  const availablePaths = new Set(state.knowledgeBase.notes.map((note) => note.relativePath));
  state.knowledgeBase.selectedNotePath = availablePaths.has(currentSelection)
    ? currentSelection
    : getKnowledgeBaseDefaultNotePath();
}

function applyKnowledgeBaseNoteState(payload) {
  const note = payload?.note || {};
  const normalizedPath = normalizeFileTreePath(note.relativePath);

  state.knowledgeBase.selectedNotePath = normalizedPath;
  state.knowledgeBase.selectedNoteTitle = note.title || normalizedPath || "note";
  state.knowledgeBase.selectedNoteContent = note.content || "";
  state.knowledgeBase.selectedNoteDraft = state.knowledgeBase.selectedNoteContent;
  state.knowledgeBase.selectedNoteEditing = false;
  state.knowledgeBase.selectedNoteError = "";
  state.knowledgeBase.selectedNoteSaving = false;

  if (normalizedPath) {
    state.knowledgeBase.noteCache[normalizedPath] = {
      title: state.knowledgeBase.selectedNoteTitle,
      content: state.knowledgeBase.selectedNoteContent,
    };
  }
}

async function loadKnowledgeBaseIndex() {
  state.knowledgeBase.loading = true;
  state.knowledgeBase.error = "";

  try {
    const payload = await fetchJson("/api/knowledge-base");
    applyKnowledgeBaseIndexState(payload);
  } catch (error) {
    state.knowledgeBase.error = error.message;
  } finally {
    state.knowledgeBase.loading = false;
  }
}

async function loadKnowledgeBaseNote(relativePath, { force = false } = {}) {
  const normalizedPath = normalizeFileTreePath(relativePath);

  if (!normalizedPath) {
    state.knowledgeBase.selectedNotePath = "";
    state.knowledgeBase.selectedNoteTitle = "";
    state.knowledgeBase.selectedNoteContent = "";
    state.knowledgeBase.selectedNoteDraft = "";
    state.knowledgeBase.selectedNoteEditing = false;
    state.knowledgeBase.selectedNoteError = "";
    state.knowledgeBase.selectedNoteLoading = false;
    state.knowledgeBase.selectedNoteSaving = false;
    return;
  }

  const cachedNote = !force ? state.knowledgeBase.noteCache[normalizedPath] : null;
  if (cachedNote) {
    state.knowledgeBase.selectedNotePath = normalizedPath;
    state.knowledgeBase.selectedNoteTitle = cachedNote.title;
    state.knowledgeBase.selectedNoteContent = cachedNote.content;
    state.knowledgeBase.selectedNoteDraft = cachedNote.content;
    state.knowledgeBase.selectedNoteEditing = false;
    state.knowledgeBase.selectedNoteError = "";
    state.knowledgeBase.selectedNoteLoading = false;
    state.knowledgeBase.selectedNoteSaving = false;
    return;
  }

  const requestId = state.knowledgeBase.selectedNoteRequestId + 1;
  state.knowledgeBase.selectedNoteRequestId = requestId;
  state.knowledgeBase.selectedNotePath = normalizedPath;
  state.knowledgeBase.selectedNoteEditing = false;
  state.knowledgeBase.selectedNoteLoading = true;
  state.knowledgeBase.selectedNoteSaving = false;
  state.knowledgeBase.selectedNoteError = "";

  try {
    const payload = await fetchJson(`/api/knowledge-base/note?path=${encodeURIComponent(normalizedPath)}`);

    if (state.knowledgeBase.selectedNoteRequestId !== requestId) {
      return;
    }

    applyKnowledgeBaseNoteState(payload);
  } catch (error) {
    if (state.knowledgeBase.selectedNoteRequestId !== requestId) {
      return;
    }

    state.knowledgeBase.selectedNoteTitle =
      getKnowledgeBaseSelectedNoteMeta()?.title || normalizedPath;
    state.knowledgeBase.selectedNoteContent = "";
    state.knowledgeBase.selectedNoteError = error.message;
  } finally {
    if (state.knowledgeBase.selectedNoteRequestId === requestId) {
      state.knowledgeBase.selectedNoteLoading = false;
    }
  }
}

async function ensureKnowledgeBaseSelectionLoaded({ force = false } = {}) {
  if (!state.knowledgeBase.notes.length && !state.knowledgeBase.loading && !state.knowledgeBase.error) {
    await loadKnowledgeBaseIndex();
  }

  const nextPath = state.knowledgeBase.selectedNotePath || getKnowledgeBaseDefaultNotePath();
  state.knowledgeBase.selectedNotePath = nextPath;

  if (!nextPath) {
    return;
  }

  await loadKnowledgeBaseNote(nextPath, { force });
}

async function openKnowledgeBaseNote(relativePath, { force = false, focusGraph = false } = {}) {
  const normalizedPath = normalizeFileTreePath(relativePath) || getKnowledgeBaseDefaultNotePath();

  if (!normalizedPath) {
    return;
  }

  if (focusGraph) {
    requestKnowledgeBaseGraphFocus(normalizedPath);
  }

  state.knowledgeBase.selectedNotePath = normalizedPath;
  updateRoute({ view: "knowledge-base", notePath: normalizedPath });
  renderShell();
  await loadKnowledgeBaseNote(normalizedPath, { force });
  if (focusGraph) {
    requestKnowledgeBaseGraphFocus(normalizedPath);
  }
  renderShell();
}

async function selectKnowledgeBaseNoteForWorkspaceFile(relativePath, { openInKnowledgeBase = false } = {}) {
  if (!isMarkdownFilePath(relativePath)) {
    return false;
  }

  if (!state.knowledgeBase.notes.length && !state.knowledgeBase.loading && !state.knowledgeBase.error) {
    await loadKnowledgeBaseIndex();
  }

  const notePath = getKnowledgeBaseNotePathForWorkspaceFile(relativePath);
  if (!notePath || !hasKnowledgeBaseNote(notePath)) {
    return false;
  }

  state.knowledgeBase.selectedNotePath = notePath;

  if (openInKnowledgeBase || state.currentView === "knowledge-base") {
    setCurrentView("knowledge-base", { notePath });
    await openKnowledgeBaseNote(notePath, { focusGraph: true });
  }

  return true;
}

function renderKnowledgeBaseMedia(media, { altText = "", caption = "" } = {}) {
  const url = escapeHtml(media?.url || "");
  const label = String(caption || "").trim();
  const captionHtml = label
    ? `<span class="knowledge-base-media-caption">${escapeHtml(label)}</span>`
    : "";

  if (!url) {
    return "";
  }

  if (media.kind === "video") {
    return `
      <span class="knowledge-base-media knowledge-base-video-media">
        <video class="knowledge-base-media-player" src="${url}" controls preload="metadata">
          <a href="${url}" target="_blank" rel="noreferrer">${escapeHtml(altText || "Open video")}</a>
        </video>
        ${captionHtml}
      </span>
    `;
  }

  if (media.kind === "audio") {
    return `
      <span class="knowledge-base-media knowledge-base-audio-media">
        <audio class="knowledge-base-media-player" src="${url}" controls preload="metadata">
          <a href="${url}" target="_blank" rel="noreferrer">${escapeHtml(altText || "Open audio")}</a>
        </audio>
        ${captionHtml}
      </span>
    `;
  }

  const imageLoading = media.local ? "eager" : "lazy";
  return `
    <span class="knowledge-base-media knowledge-base-image-media">
      <a class="knowledge-base-media-open" href="${url}" target="_blank" rel="noreferrer">
        <img class="knowledge-base-inline-image" src="${url}" alt="${escapeHtml(altText)}" loading="${imageLoading}" decoding="async" />
      </a>
      ${captionHtml}
    </span>
  `;
}

function renderKnowledgeBaseInline(text, currentPath) {
  const tokens = [];
  const createToken = (html) => `%%KB_TOKEN_${tokens.push(html) - 1}%%`;
  let output = String(text || "");

  output = output.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, altText, target) => {
    const media = getKnowledgeBaseMediaResource(currentPath, target, { defaultToImage: true });

    if (!media) {
      return createToken(`<span>${escapeHtml(altText)}</span>`);
    }

    return createToken(renderKnowledgeBaseMedia(media, { altText }));
  });

  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, target) => {
    const cleanedTarget = cleanMarkdownLinkTarget(target);
    const notePath = resolveKnowledgeBaseNotePath(currentPath, cleanedTarget);

    if (notePath) {
      return createToken(
        `<button class="knowledge-base-inline-link" type="button" data-kb-open-note="${escapeHtml(notePath)}">${escapeHtml(label)}</button>`,
      );
    }

    const media = getKnowledgeBaseMediaResource(currentPath, cleanedTarget);
    if (media) {
      return createToken(renderKnowledgeBaseMedia(media, { altText: label, caption: label }));
    }

    const absoluteFileHref = getKnowledgeBaseAbsoluteFileUrl(cleanedTarget);
    const relativeAssetPath = absoluteFileHref ? "" : resolveKnowledgeBaseRelativePath(currentPath, cleanedTarget);
    const externalHref = absoluteFileHref || (relativeAssetPath
      ? getKnowledgeBaseNoteRawUrl(relativeAssetPath)
      : cleanedTarget || String(target || "").trim());
    return createToken(
      `<a class="knowledge-base-external-link" href="${escapeHtml(externalHref)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`,
    );
  });

  output = output.replace(/\[\[([^[\]]+)\]\]/g, (_match, body) => {
    const trimmedBody = String(body || "").trim();
    if (!trimmedBody) {
      return "";
    }

    const [targetWithAnchor, alias] = trimmedBody.split("|");
    const notePath = resolveKnowledgeBaseNotePath(currentPath, targetWithAnchor);
    const label = (alias || targetWithAnchor.split("#")[0] || "").trim();

    if (notePath) {
      return createToken(
        `<button class="knowledge-base-inline-link" type="button" data-kb-open-note="${escapeHtml(notePath)}">${escapeHtml(label || notePath)}</button>`,
      );
    }

    return createToken(`<span>${escapeHtml(label || trimmedBody)}</span>`);
  });

  output = output.replace(/`([^`]+)`/g, (_match, code) => createToken(`<code>${escapeHtml(code)}</code>`));
  output = escapeHtml(output)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");

  return output.replace(/%%KB_TOKEN_(\d+)%%/g, (_match, index) => tokens[Number(index)] || "");
}

function splitMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.includes("|")) {
    return [];
  }

  const source = trimmed.replace(/^\|/, "").replace(/\|\s*$/, "");
  const cells = [];
  let cell = "";
  let escaping = false;

  for (const character of source) {
    if (escaping) {
      cell += character === "|" ? "|" : `\\${character}`;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }

    cell += character;
  }

  if (escaping) {
    cell += "\\";
  }

  cells.push(cell.trim());
  return cells;
}

function isMarkdownTableRow(line) {
  return splitMarkdownTableRow(line).length >= 2;
}

function isMarkdownTableDivider(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function isMarkdownTableStart(lines, index) {
  return isMarkdownTableRow(lines[index]) && isMarkdownTableDivider(lines[index + 1] || "");
}

function getMarkdownTableAlignment(dividerCell) {
  const trimmed = String(dividerCell || "").replace(/\s+/g, "");
  const left = trimmed.startsWith(":");
  const right = trimmed.endsWith(":");

  if (left && right) {
    return "center";
  }

  return right ? "right" : left ? "left" : "";
}

function normalizeMarkdownTableCells(cells, columnCount) {
  return Array.from({ length: columnCount }, (_value, index) => cells[index] || "");
}

function renderKnowledgeBaseTableCell(tagName, value, alignment, currentPath) {
  const className = alignment ? ` class="is-${alignment}"` : "";
  return `<${tagName}${className}>${renderKnowledgeBaseInline(value, currentPath)}</${tagName}>`;
}

function renderKnowledgeBaseMarkdownTable(lines, startIndex, currentPath) {
  const headerCells = splitMarkdownTableRow(lines[startIndex]);
  const dividerCells = splitMarkdownTableRow(lines[startIndex + 1]);
  const columnCount = Math.max(headerCells.length, dividerCells.length);
  const normalizedHeaders = normalizeMarkdownTableCells(headerCells, columnCount);
  const alignments = normalizeMarkdownTableCells(dividerCells, columnCount).map(getMarkdownTableAlignment);
  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length && isMarkdownTableRow(lines[index]) && !isMarkdownTableDivider(lines[index])) {
    rows.push(normalizeMarkdownTableCells(splitMarkdownTableRow(lines[index]), columnCount));
    index += 1;
  }

  const head = normalizedHeaders
    .map((cell, columnIndex) => renderKnowledgeBaseTableCell("th", cell, alignments[columnIndex], currentPath))
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, columnIndex) =>
            renderKnowledgeBaseTableCell("td", cell, alignments[columnIndex], currentPath),
          )
          .join("")}</tr>`,
    )
    .join("");

  return {
    html: `
      <div class="knowledge-base-table-scroll" role="region" aria-label="Markdown table" tabindex="0">
        <table class="knowledge-base-table">
          <thead><tr>${head}</tr></thead>
          ${body ? `<tbody>${body}</tbody>` : ""}
        </table>
      </div>
    `,
    nextIndex: index,
  };
}

function renderKnowledgeBaseMarkdown(markdown, currentPath) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let index = 0;

  const isListLine = (line) => /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line);
  const isBlockBoundary = (line) =>
    !line.trim() ||
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    isMarkdownTableRow(line) ||
    /^>\s?/.test(line) ||
    isListLine(line) ||
    /^([-*_]){3,}\s*$/.test(line.trim());

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(/^```\s*([A-Za-z0-9_.+-]*)/);
    if (fenceMatch) {
      const language = normalizeSyntaxLanguage(fenceMatch[1] || "text");
      index += 1;
      const codeLines = [];

      while (index < lines.length && !/^```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      html.push(renderSyntaxCodeBlock(codeLines.join("\n"), language, "knowledge-base-code"));
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const table = renderKnowledgeBaseMarkdownTable(lines, index, currentPath);
      html.push(table.html);
      index = table.nextIndex;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length);
      html.push(`<h${level}>${renderKnowledgeBaseInline(headingMatch[2], currentPath)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];

      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }

      html.push(
        `<blockquote class="knowledge-base-blockquote">${quoteLines
          .map((entry) => `<p>${renderKnowledgeBaseInline(entry, currentPath)}</p>`)
          .join("")}</blockquote>`,
      );
      continue;
    }

    if (isListLine(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];

      while (index < lines.length && isListLine(lines[index])) {
        items.push(lines[index].replace(/^\s*(?:[-*+]\s+|\d+\.\s+)/, ""));
        index += 1;
      }

      html.push(
        `<${ordered ? "ol" : "ul"}>${items
          .map((item) => `<li>${renderKnowledgeBaseInline(item, currentPath)}</li>`)
          .join("")}</${ordered ? "ol" : "ul"}>`,
      );
      continue;
    }

    if (/^([-*_]){3,}\s*$/.test(line.trim())) {
      html.push(`<hr class="knowledge-base-rule" />`);
      index += 1;
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && !isBlockBoundary(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }

    if (!paragraphLines.length) {
      paragraphLines.push(line.trim());
      index += 1;
    }

    html.push(`<p>${renderKnowledgeBaseInline(paragraphLines.join(" "), currentPath)}</p>`);
  }

  return html.join("");
}

function renderKnowledgeBaseNoteList() {
  const notes = getFilteredKnowledgeBaseNotes();
  const query = getKnowledgeBaseSearchQuery();

  if (state.knowledgeBase.loading && !state.knowledgeBase.notes.length) {
    return `<div class="blank-state">loading notes</div>`;
  }

  if (state.knowledgeBase.error) {
    return `<div class="blank-state">${escapeHtml(state.knowledgeBase.error)}</div>`;
  }

  if (!state.knowledgeBase.notes.length) {
    return `<div class="blank-state">no markdown notes yet</div>`;
  }

  if (!notes.length) {
    return `<div class="blank-state">no notes match "${escapeHtml(state.knowledgeBase.searchQuery)}"</div>`;
  }

  return notes
    .map((note) => {
      const isActive = note.relativePath === state.knowledgeBase.selectedNotePath;
      const matchLabel = query ? "matches search" : note.excerpt || note.relativePath || "No preview yet.";
      const noteColor = getKnowledgeBaseGraphColor(getKnowledgeBaseGraphGroupKey(note.relativePath));
      const tooltip = [note.title, note.relativePath, matchLabel].filter(Boolean).join(" - ");
      return `
        <button
          class="knowledge-base-note-row ${isActive ? "is-active" : ""}"
          type="button"
          data-kb-note="${escapeHtml(note.relativePath)}"
          aria-label="${escapeHtml(tooltip)}"
          title="${escapeHtml(tooltip)}"
          ${renderStyleVariables({
            "--kb-note-accent": noteColor.stroke,
            "--kb-note-accent-fill": noteColor.fill,
          })}
        >
          <span class="knowledge-base-note-accent" aria-hidden="true"></span>
          <span class="knowledge-base-note-title">${escapeHtml(note.title)}</span>
        </button>
      `;
    })
    .join("");
}

function renderKnowledgeBaseSearchControls() {
  return `
    <div class="knowledge-base-search">
      <input
        class="knowledge-base-search-input"
        id="knowledge-base-search"
        type="search"
        value="${escapeHtml(state.knowledgeBase.searchQuery || "")}"
        placeholder="search notes"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="none"
        spellcheck="false"
      />
      <span class="knowledge-base-search-count">${escapeHtml(getKnowledgeBaseSearchResultLabel())}</span>
    </div>
  `;
}

function getKnowledgeBaseSearchResultLabel() {
  const notes = getFilteredKnowledgeBaseNotes();
  const query = getKnowledgeBaseSearchQuery();
  return query
    ? `${notes.length} of ${state.knowledgeBase.notes.length} notes`
    : `${state.knowledgeBase.notes.length} notes`;
}

function renderKnowledgeBaseGraph() {
  const layout = state.knowledgeBase.graphLayout;

  if (!layout.nodes.length) {
    return `<div class="blank-state">graph will appear once markdown notes exist</div>`;
  }

  const selectedPath = state.knowledgeBase.selectedNotePath;
  const connectedPaths = new Set([selectedPath]);

  for (const edge of layout.edges) {
    if (edge.source === selectedPath || edge.target === selectedPath) {
      connectedPaths.add(edge.source);
      connectedPaths.add(edge.target);
    }
  }

  const nodeMap = new Map(layout.nodes.map((node) => [node.relativePath, node]));

  return `
    <article class="knowledge-base-graph-card">
      <div class="knowledge-base-panel-head knowledge-base-graph-head">
        <div class="knowledge-base-graph-copy">
          <strong>Graph View</strong>
          <div class="knowledge-base-panel-meta">${escapeHtml(
            `${layout.nodes.length} notes · ${layout.edges.length} links`,
          )}</div>
          <div class="knowledge-base-graph-hint">hover nodes · drag nodes · scroll to zoom</div>
        </div>
        <div class="knowledge-base-graph-actions">
          <button
            class="icon-button toolbar-control knowledge-base-graph-icon-button"
            type="button"
            id="pulse-knowledge-base-graph"
            aria-label="Pulse graph physics"
            ${tooltipAttributes("Pulse graph physics")}
          >${renderIcon(Zap)}</button>
          <button class="ghost-button toolbar-control" type="button" id="fit-knowledge-base-graph">fit</button>
        </div>
      </div>
      <div class="knowledge-base-graph-frame">
        <svg
          class="knowledge-base-graph"
          id="knowledge-base-graph"
          viewBox="0 0 ${layout.width} ${layout.height}"
          role="img"
          aria-label="Knowledge base graph"
        >
          <rect
            class="knowledge-base-graph-surface"
            data-kb-graph-surface
            x="0"
            y="0"
            width="${layout.width}"
            height="${layout.height}"
            rx="22"
            ry="22"
          ></rect>
          <g
            data-kb-graph-viewport
            transform="translate(${layout.offsetX.toFixed(2)} ${layout.offsetY.toFixed(2)}) scale(${layout.scale.toFixed(4)})"
          >
            ${layout.edges
              .map((edge, index) => {
                const source = nodeMap.get(edge.source);
                const target = nodeMap.get(edge.target);

                if (!source || !target) {
                  return "";
                }

                const isConnected = edge.source === selectedPath || edge.target === selectedPath;
                return `
                  <line
                    class="knowledge-base-graph-edge ${isConnected ? "is-connected" : ""}"
                    data-kb-graph-edge-index="${index}"
                    ${renderStyleVariables({ "--kb-edge-stroke": edge.edgeColor })}
                    x1="${source.x.toFixed(2)}"
                    y1="${source.y.toFixed(2)}"
                    x2="${target.x.toFixed(2)}"
                    y2="${target.y.toFixed(2)}"
                  ></line>
                `;
              })
              .join("")}
            ${layout.nodes
              .map((node, index) => {
                const isSelected = node.relativePath === selectedPath;
                const isConnected = connectedPaths.has(node.relativePath);
                const shouldShowLabel = layout.nodes.length <= 26 || isSelected || isConnected;

                return `
                  <g
                    class="knowledge-base-graph-node ${shouldShowLabel ? "has-visible-label" : ""} ${isSelected ? "is-selected" : ""} ${isConnected ? "is-connected" : ""}"
                    data-kb-graph-node="${escapeHtml(node.relativePath)}"
                    data-kb-graph-node-index="${index}"
                    ${renderStyleVariables({
                      "--kb-node-fill": node.color?.fill,
                      "--kb-node-stroke": node.color?.stroke,
                      "--kb-node-label": node.color?.label,
                      "--kb-node-connected-fill": node.color?.connectedFill,
                      "--kb-node-connected-stroke": node.color?.connectedStroke,
                    })}
                    transform="translate(${node.x.toFixed(2)} ${node.y.toFixed(2)})"
                  >
                    <circle r="${node.radius.toFixed(2)}"></circle>
                    <text y="${(-node.radius - 10).toFixed(2)}">${escapeHtml(
                      truncateKnowledgeBaseLabel(node.title, 18),
                    )}</text>
                  </g>
                `;
              })
              .join("")}
          </g>
        </svg>
      </div>
      ${renderKnowledgeBaseGraphLegend(layout)}
    </article>
  `;
}

function renderKnowledgeBaseNoteBody(selectedNotePath) {
  if (state.knowledgeBase.selectedNoteLoading) {
    return `<div class="blank-state">opening note...</div>`;
  }

  if (state.knowledgeBase.selectedNoteError) {
    return `<div class="blank-state">${escapeHtml(state.knowledgeBase.selectedNoteError)}</div>`;
  }

  if (state.knowledgeBase.selectedNoteEditing) {
    const dirty = state.knowledgeBase.selectedNoteDraft !== state.knowledgeBase.selectedNoteContent;
    return `
      <div class="knowledge-base-editor">
        <div class="file-editor-status" id="knowledge-base-edit-status">${escapeHtml(
          state.knowledgeBase.selectedNoteSaving
            ? "saving changes..."
            : dirty
              ? "unsaved changes"
              : "saved",
        )}</div>
        ${renderLineNumberEditor({
          id: "knowledge-base-note-editor",
          className: "knowledge-base-editor-textarea",
          value: state.knowledgeBase.selectedNoteDraft,
          variant: "knowledge",
          attributes: `
            spellcheck="false"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
          `,
        })}
      </div>
    `;
  }

  if (state.knowledgeBase.selectedNoteContent) {
    return `
      <div class="knowledge-base-markdown">
        ${renderKnowledgeBaseMarkdown(state.knowledgeBase.selectedNoteContent, selectedNotePath)}
      </div>
    `;
  }

  return `<div class="blank-state">select a note to view it here</div>`;
}

function renderKnowledgeBaseNoteActions(rawHref) {
  const selectedNotePath = state.knowledgeBase.selectedNotePath;
  if (!selectedNotePath) {
    return rawHref
      ? `<a class="ghost-button toolbar-control" href="${escapeHtml(rawHref)}" target="_blank" rel="noreferrer">raw</a>`
      : "";
  }

  if (state.knowledgeBase.selectedNoteEditing) {
    const dirty = state.knowledgeBase.selectedNoteDraft !== state.knowledgeBase.selectedNoteContent;
    return `
      <div class="knowledge-base-note-actions">
        <button class="ghost-button toolbar-control" type="button" id="cancel-knowledge-base-edit" ${state.knowledgeBase.selectedNoteSaving ? "disabled" : ""}>cancel</button>
        <button class="${dirty ? "primary-button" : "ghost-button"} toolbar-control" type="button" id="save-knowledge-base-note" ${(!dirty || state.knowledgeBase.selectedNoteSaving) ? "disabled" : ""}>${state.knowledgeBase.selectedNoteSaving ? "saving..." : dirty ? "save" : "saved"}</button>
      </div>
    `;
  }

  return `
    <div class="knowledge-base-note-actions">
      <button class="ghost-button toolbar-control" type="button" id="edit-knowledge-base-note">edit</button>
      ${
        rawHref
          ? `<a class="ghost-button toolbar-control" href="${escapeHtml(rawHref)}" target="_blank" rel="noreferrer">raw</a>`
          : ""
      }
    </div>
  `;
}

function renderKnowledgeSettingsForm({ popover = false } = {}) {
  const form = `
      <form class="settings-form knowledge-settings-form" id="settings-form">
        <label class="field-label" for="wiki-path-input">wiki folder</label>
        <div class="folder-input-row">
          <input
            class="file-root-input"
            id="wiki-path-input"
            name="wikiPath"
            type="text"
            value="${escapeHtml(state.settings.wikiPath || "")}"
            placeholder="${escapeHtml(state.defaultCwd || "wiki folder")}"
            readonly
            data-folder-picker-target="wiki"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
          />
          <button class="ghost-button folder-browse-button" type="button" data-folder-picker-target="wiki">choose</button>
        </div>
        <div class="knowledge-settings-options">
          <label class="checkbox-row">
            <input type="checkbox" name="wikiGitBackupEnabled" ${state.settings.wikiGitBackupEnabled ? "checked" : ""} />
            <span id="wiki-backup-interval-label">${escapeHtml(formatWikiBackupIntervalLabel())}</span>
          </label>
          <label class="checkbox-row">
            <input type="checkbox" name="preventSleepEnabled" ${state.settings.preventSleepEnabled ? "checked" : ""} />
            <span>prevent this computer from sleeping</span>
          </label>
          <label class="checkbox-row">
            <input type="checkbox" name="wikiGitRemoteEnabled" ${state.settings.wikiGitRemoteEnabled ? "checked" : ""} />
            <span>push backups to a private git remote</span>
          </label>
        </div>
        <div class="settings-status">${escapeHtml(getSleepPreventionStatusText())}</div>
        <div class="knowledge-settings-remote-grid">
          <label class="field-label" for="wiki-git-remote-url">private remote URL</label>
          <input
            class="file-root-input"
            id="wiki-git-remote-url"
            name="wikiGitRemoteUrl"
            type="text"
            value="${escapeHtml(state.settings.wikiGitRemoteUrl || "")}"
            placeholder="git@github.com:you/private-mac-brain.git"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
          />
          <label class="field-label" for="wiki-git-remote-branch">remote branch</label>
          <input
            class="file-root-input"
            id="wiki-git-remote-branch"
            name="wikiGitRemoteBranch"
            type="text"
            value="${escapeHtml(state.settings.wikiGitRemoteBranch || "main")}"
            placeholder="main"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
          />
        </div>
        <input type="hidden" name="wikiGitRemoteName" value="${escapeHtml(state.settings.wikiGitRemoteName || "origin")}" />
        <div class="knowledge-settings-actions">
          <button class="primary-button settings-save-button" type="submit">save settings</button>
          <div class="settings-status" id="wiki-backup-settings-status">${escapeHtml(getWikiBackupStatusText())}</div>
        </div>
      </form>
  `;

  if (!popover) {
    return `
      <section class="knowledge-settings-card">
        <div class="knowledge-settings-head">
          <strong>Knowledge settings</strong>
          <span id="wiki-backup-status">${escapeHtml(getWikiBackupStatusText())}</span>
        </div>
        ${form}
      </section>
    `;
  }

  return `
    <details class="knowledge-settings-popover">
      <summary
        class="icon-button knowledge-settings-trigger"
        aria-label="Knowledge settings"
        ${tooltipAttributes("Knowledge settings")}
      >
        ${renderIcon(Settings)}
      </summary>
      <div class="knowledge-settings-popover-panel">
        <div class="knowledge-settings-head">
          <strong>Knowledge settings</strong>
          <span id="wiki-backup-status">${escapeHtml(getWikiBackupStatusText())}</span>
        </div>
        ${form}
      </div>
    </details>
  `;
}

function renderKnowledgeBaseView() {
  const selectedNoteMeta = getKnowledgeBaseSelectedNoteMeta();
  const selectedNotePath = state.knowledgeBase.selectedNotePath;
  const rawHref = selectedNotePath ? getKnowledgeBaseNoteRawUrl(selectedNotePath) : "";
  const backupRepoUrl = getKnowledgeBaseBackupRepoUrl();

  return `
    <section class="dashboard-panel knowledge-base-view" ${renderMainViewAttributes(
      "knowledge-base",
      `knowledge-base:${selectedNotePath || ""}:${state.knowledgeBase.selectedNoteEditing ? "edit" : "view"}`,
    )}>
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>${renderIcon(Menu)}</button>
        <div class="dashboard-copy">
          <strong>Knowledge Base</strong>
          <div class="terminal-meta" data-knowledge-base-header-meta>${escapeHtml(getKnowledgeBaseHeaderMeta())}</div>
        </div>
        <div class="dashboard-actions knowledge-base-toolbar-actions">
          ${renderKnowledgeSettingsForm({ popover: true })}
          ${
            backupRepoUrl
              ? `<a class="ghost-button toolbar-control" href="${escapeHtml(backupRepoUrl)}" target="_blank" rel="noreferrer">view backup</a>`
              : ""
          }
          <button class="ghost-button toolbar-control" type="button" id="backup-wiki-now">backup now</button>
          <button class="icon-button toolbar-control refresh-icon-button" type="button" id="refresh-knowledge-base" aria-label="Refresh knowledge base" ${tooltipAttributes("Refresh knowledge base")}>${renderIcon(RefreshCw)}</button>
        </div>
      </div>
      <div class="knowledge-base-grid">
        <aside class="knowledge-base-column knowledge-base-column-list">
          <div class="knowledge-base-panel-head">
            <div>
              <strong>Markdown Notes</strong>
              <div class="knowledge-base-panel-meta">search titles, paths, and note text</div>
            </div>
          </div>
          ${renderKnowledgeBaseSearchControls()}
          <div class="knowledge-base-note-list">
            ${renderKnowledgeBaseNoteList()}
          </div>
        </aside>
        <section class="knowledge-base-column knowledge-base-column-note">
          <div class="knowledge-base-panel-head">
            <div>
              <strong>${escapeHtml(
                state.knowledgeBase.selectedNoteTitle || selectedNoteMeta?.title || "Note Viewer",
              )}</strong>
              <div class="knowledge-base-panel-meta">${escapeHtml(
                selectedNotePath || selectedNoteMeta?.relativePath || "No note selected",
              )}</div>
            </div>
            ${renderKnowledgeBaseNoteActions(rawHref)}
          </div>
          <div class="knowledge-base-note-card">
            ${renderKnowledgeBaseNoteBody(selectedNotePath)}
          </div>
        </section>
        <aside class="knowledge-base-column knowledge-base-column-graph">
          ${renderKnowledgeBaseGraph()}
        </aside>
      </div>
    </section>
  `;
}

function renderKnowledgeBaseApp() {
  const selectedNotePath = state.knowledgeBase.selectedNotePath;
  const rawHref = selectedNotePath ? getKnowledgeBaseNoteRawUrl(selectedNotePath) : "";
  const backupRepoUrl = getKnowledgeBaseBackupRepoUrl();

  document.title = selectedNotePath
    ? `${state.knowledgeBase.selectedNoteTitle || selectedNotePath} · Knowledge Base`
    : "Knowledge Base";

  return `
    <main class="screen knowledge-base-app">
      <section class="knowledge-base-app-shell">
        <header class="knowledge-base-app-toolbar">
          <div class="knowledge-base-app-copy">
            <span class="knowledge-base-app-eyebrow">Remote Vibes</span>
            <strong>Knowledge Base</strong>
            <div class="knowledge-base-app-meta" data-knowledge-base-header-meta>${escapeHtml(getKnowledgeBaseHeaderMeta())}</div>
          </div>
          <div class="knowledge-base-app-actions">
            ${renderKnowledgeSettingsForm({ popover: true })}
            ${backupRepoUrl
              ? `<a class="ghost-button toolbar-control" href="${escapeHtml(backupRepoUrl)}" target="_blank" rel="noreferrer">view backup</a>`
              : ""}
            ${rawHref
              ? `<a class="ghost-button toolbar-control" href="${escapeHtml(rawHref)}" target="_blank" rel="noreferrer">raw</a>`
              : ""}
            <button class="icon-button toolbar-control refresh-icon-button" type="button" id="refresh-knowledge-base" aria-label="Refresh knowledge base" ${tooltipAttributes("Refresh knowledge base")}>${renderIcon(RefreshCw)}</button>
            <a class="ghost-button toolbar-control" href="${escapeHtml(getAppBaseUrl())}/">remote vibes</a>
          </div>
        </header>

        <div class="knowledge-base-grid">
          <aside class="knowledge-base-column knowledge-base-column-list">
            <div class="knowledge-base-panel-head">
              <div>
                <strong>Markdown Notes</strong>
                <div class="knowledge-base-panel-meta">search titles, paths, and note text</div>
              </div>
            </div>
            ${renderKnowledgeBaseSearchControls()}
            <div class="knowledge-base-note-list">
              ${renderKnowledgeBaseNoteList()}
            </div>
          </aside>
          <section class="knowledge-base-column knowledge-base-column-note">
            <div class="knowledge-base-panel-head">
              <div>
                <strong>${escapeHtml(
                  state.knowledgeBase.selectedNoteTitle || getKnowledgeBaseSelectedNoteMeta()?.title || "Note Viewer",
                )}</strong>
                <div class="knowledge-base-panel-meta">${escapeHtml(
                  selectedNotePath || getKnowledgeBaseSelectedNoteMeta()?.relativePath || "No note selected",
                )}</div>
              </div>
              ${renderKnowledgeBaseNoteActions(rawHref)}
            </div>
            <div class="knowledge-base-note-card">
              ${renderKnowledgeBaseNoteBody(selectedNotePath)}
            </div>
          </section>
          <aside class="knowledge-base-column knowledge-base-column-graph">
            ${renderKnowledgeBaseGraph()}
          </aside>
        </div>
      </section>
      ${renderSystemToasts()}
    </main>
  `;
}

function renderFileTextPreview(activeTab) {
  const content = activeTab?.content || "";
  const language = getSyntaxLanguageForPath(state.openFileRelativePath);
  const notePath = getKnowledgeBaseNotePathForWorkspaceFile(state.openFileRelativePath);

  if (isMarkdownFilePath(state.openFileRelativePath)) {
    return `
      <div class="file-rendered-markdown knowledge-base-markdown">
        ${renderKnowledgeBaseMarkdown(content, notePath || state.openFileRelativePath)}
      </div>
    `;
  }

  return renderSyntaxCodeBlock(content, language, "file-code-preview");
}

function renderOpenFilePanel() {
  if (!state.openFileRelativePath) {
    return `<div class="blank-state">no file selected</div>`;
  }

  const activeTab = getActiveOpenFileTab();
  const rawHref = getFileContentUrl(state.openFileRelativePath);
  const dirty = isOpenFileDirty(activeTab);
  const editing = activeTab?.viewMode === "edit" || dirty;

  if (state.openFileStatus === "web") {
    const previewUrl = activeTab?.url || "";
    const externalUrl = activeTab?.externalUrl || previewUrl;

    return `
      <div class="file-editor-card file-web-card">
        <div class="file-editor-head file-web-head">
          <div class="file-editor-actions">
            <button class="ghost-button file-editor-button" type="button" id="reload-open-file">reload</button>
            ${
              externalUrl
                ? `<a class="ghost-button file-editor-open" href="${escapeHtml(externalUrl)}" target="_blank" rel="noreferrer">open</a>`
                : ""
            }
          </div>
        </div>
        ${
          previewUrl
            ? `<div class="web-preview-frame-shell">
                <iframe class="web-preview-frame" src="${escapeHtml(previewUrl)}" title="${escapeHtml(state.openFileName || "web preview")}"></iframe>
              </div>`
            : `<div class="blank-state">this port no longer has a preview URL</div>`
        }
      </div>
    `;
  }

  if (state.openFileStatus === "loading") {
    return `
      <div class="file-editor-card">
        <div class="file-editor-head">
          <div class="file-editor-copy">
            <div class="file-editor-name">${escapeHtml(state.openFileName)}</div>
            <div class="file-editor-path" title="${escapeHtml(state.openFileRelativePath)}">${escapeHtml(state.openFileRelativePath)}</div>
          </div>
          <a class="ghost-button file-editor-open" href="${escapeHtml(rawHref)}" target="_blank" rel="noreferrer">raw</a>
        </div>
        <div class="blank-state">opening file...</div>
      </div>
    `;
  }

  if (state.openFileStatus === "external") {
    return `
      <div class="file-editor-card">
        <div class="file-editor-head">
          <div class="file-editor-copy">
            <div class="file-editor-name">${escapeHtml(state.openFileName)}</div>
            <div class="file-editor-path" title="${escapeHtml(state.openFileRelativePath)}">${escapeHtml(state.openFileRelativePath)}</div>
          </div>
          <div class="file-editor-actions">
            <button class="ghost-button file-editor-button" type="button" id="try-open-file-text">edit</button>
            <a class="ghost-button file-editor-open" href="${escapeHtml(rawHref)}" target="_blank" rel="noreferrer">open</a>
          </div>
        </div>
        <div class="blank-state">${escapeHtml(state.openFileMessage || "opened in a new tab because this file is not editable as text")}</div>
      </div>
    `;
  }

  if (state.openFileStatus === "image") {
    const zoomLabel = getOpenImageZoomLabel(activeTab);
    const imageStyle = getOpenImageTransformStyle(activeTab);
    return `
      <div class="file-editor-card file-image-card">
        <div class="file-editor-head">
          <div class="file-editor-copy">
            <div class="file-editor-name">${escapeHtml(state.openFileName)}</div>
            <div class="file-editor-path" title="${escapeHtml(state.openFileRelativePath)}">${escapeHtml(state.openFileRelativePath)}</div>
          </div>
          <div class="file-editor-actions">
            <button class="ghost-button file-editor-button file-image-control" type="button" data-image-zoom="out" aria-label="Zoom image out">${renderIcon(ZoomOut)}</button>
            <span class="file-image-zoom-label" aria-label="Image zoom">${escapeHtml(zoomLabel)}</span>
            <button class="ghost-button file-editor-button file-image-control" type="button" data-image-zoom="in" aria-label="Zoom image in">${renderIcon(ZoomIn)}</button>
            <button class="ghost-button file-editor-button" type="button" data-image-zoom="reset">fit</button>
            <a class="ghost-button file-editor-open" href="${escapeHtml(rawHref)}" target="_blank" rel="noreferrer">raw</a>
          </div>
        </div>
        <div class="file-image-preview" data-image-preview>
          <img src="${escapeHtml(rawHref)}" alt="${escapeHtml(state.openFileName)}" style="${escapeHtml(imageStyle)}" draggable="false" />
        </div>
      </div>
    `;
  }

  if (state.openFileStatus === "error") {
    return `
      <div class="file-editor-card">
        <div class="file-editor-head">
          <div class="file-editor-copy">
            <div class="file-editor-name">${escapeHtml(state.openFileName)}</div>
            <div class="file-editor-path" title="${escapeHtml(state.openFileRelativePath)}">${escapeHtml(state.openFileRelativePath)}</div>
          </div>
          <a class="ghost-button file-editor-open" href="${escapeHtml(rawHref)}" target="_blank" rel="noreferrer">raw</a>
        </div>
        <div class="blank-state">${escapeHtml(state.openFileMessage || "could not open this file")}</div>
      </div>
    `;
  }

  return `
    <div class="file-editor-card">
      <div class="file-editor-head">
        <div class="file-editor-copy">
          <div class="file-editor-name">${escapeHtml(state.openFileName)}</div>
          <div class="file-editor-path" title="${escapeHtml(state.openFileRelativePath)}">${escapeHtml(state.openFileRelativePath)}</div>
        </div>
        <div class="file-editor-actions">
          <a class="ghost-button file-editor-open" href="${escapeHtml(rawHref)}" target="_blank" rel="noreferrer">raw</a>
          <button class="ghost-button file-editor-button" type="button" id="reload-open-file" ${state.openFileSaving ? "disabled" : ""}>reload</button>
          ${
            editing
              ? `<button class="ghost-button file-editor-button" type="button" id="preview-open-file" ${dirty || state.openFileSaving ? "disabled" : ""}>preview</button>`
              : `<button class="ghost-button file-editor-button" type="button" id="edit-open-file">edit</button>`
          }
          <button class="${dirty ? "primary-button" : "ghost-button"} file-editor-button" type="button" id="save-open-file" ${(!dirty || state.openFileSaving) ? "disabled" : ""}>${state.openFileSaving ? "saving..." : dirty ? "save" : "saved"}</button>
        </div>
      </div>
      <div class="file-editor-status" id="open-file-status">${escapeHtml(
        state.openFileSaving ? "saving changes..." : dirty ? "unsaved changes" : "saved",
      )}</div>
      ${
        editing
          ? renderLineNumberEditor({
              id: "open-file-editor",
              className: "file-editor-textarea",
              value: state.openFileDraft,
              variant: "file",
              attributes: `
                spellcheck="false"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="none"
              `,
            })
          : renderFileTextPreview(activeTab)
      }
    </div>
  `;
}

function renderOpenFileTabs() {
  if (!state.openFileTabs.length) {
    return "";
  }

  return state.openFileTabs
    .map((tab) => {
      const active = tab.relativePath === state.openFileRelativePath;
      const dirty = isOpenFileDirty(tab);
      const tabTitle = tab.externalUrl || tab.url || tab.relativePath;
      const tabMode = tab.mode === "image" ? "image" : tab.status === "text" || tab.mode === "text" ? "text" : "raw";
      return `
        <div class="file-preview-tab ${active ? "is-active" : ""}" title="${escapeHtml(tabTitle)}">
          <button class="file-preview-tab-label" type="button" data-file-tab="${escapeHtml(tab.relativePath)}">
            ${renderFileEntryIcon({ isImage: tabMode === "image" }, tabMode)}
            <span class="file-preview-tab-name">${escapeHtml(tab.name)}${dirty ? " *" : ""}</span>
          </button>
          <button class="file-preview-tab-close" type="button" aria-label="Close ${escapeHtml(tab.name)}" ${tooltipAttributes(`Close ${tab.name}`)} data-close-file-tab="${escapeHtml(tab.relativePath)}">${renderIcon(X)}</button>
        </div>
      `;
    })
    .join("");
}

function renderFilePreviewPane() {
  const open = state.openFileTabs.length > 0;

  return `
    <aside class="file-preview-pane ${open ? "is-open" : ""}" id="file-preview-pane" aria-hidden="${open ? "false" : "true"}">
      <div class="file-preview-tabs">
        <div class="file-preview-tab-strip">${renderOpenFileTabs()}</div>
        <button class="icon-button file-preview-close-all" type="button" id="close-file-preview" aria-label="Close file preview" ${tooltipAttributes("Close file preview")}>${renderIcon(X)}</button>
      </div>
      <div class="file-preview-body file-editor" id="file-editor">${renderOpenFilePanel()}</div>
    </aside>
  `;
}

function renderFileTreeNodes(parentPath = "", depth = 0) {
  const entries = state.fileTreeEntries[normalizeFileTreePath(parentPath)];

  if (!entries?.length) {
    if (state.fileTreeLoading.has(normalizeFileTreePath(parentPath))) {
      return `<div class="file-tree-status" style="--depth:${depth}">loading...</div>`;
    }

    return parentPath === "" ? `<div class="blank-state">no files</div>` : "";
  }

  return entries
    .map((entry) => {
      if (entry.type === "directory") {
        const expanded = state.fileTreeExpanded.has(entry.relativePath);
        const children = expanded ? renderFileTreeNodes(entry.relativePath, depth + 1) : "";

        return `
          <div class="file-node">
            <button class="file-row file-row-button" type="button" data-file-toggle="${escapeHtml(entry.relativePath)}" style="--depth:${depth}">
              ${renderTreeCaret(expanded)}
              ${renderDirectoryIcon(entry, expanded)}
              <span class="file-label">${escapeHtml(entry.name)}</span>
            </button>
            ${children ? `<div class="file-children" style="--depth:${depth}">${children}</div>` : ""}
          </div>
        `;
      }

      const isOpen = entry.relativePath === state.openFileRelativePath;
      const openMode = entry.isImage ? "image" : isLikelyTextFile(entry.name) ? "text" : "raw";
      return `
        <button
          class="file-row file-row-button file-open-button ${isOpen ? "is-active" : ""}"
          type="button"
          data-file-open="${escapeHtml(entry.relativePath)}"
          data-file-open-mode="${openMode}"
          style="--depth:${depth}"
        >
          <span class="file-caret file-caret-spacer" aria-hidden="true"></span>
          ${renderFileEntryIcon(entry, openMode)}
          <span class="file-label">${escapeHtml(entry.name)}</span>
        </button>
      `;
    })
    .join("");
}

function renderFileTree() {
  if (!state.filesRoot) {
    return `<div class="blank-state">no workspace</div>`;
  }

  if (state.fileTreeError && !state.fileTreeEntries[""]?.length) {
    return `<div class="blank-state">${escapeHtml(state.fileTreeError)}</div>`;
  }

  if (state.fileTreeLoading.has("") && !state.fileTreeEntries[""]) {
    return `<div class="blank-state">loading files</div>`;
  }

  return renderFileTreeNodes("");
}

function getSessionProjectGroups() {
  if (!state.sessions.length) {
    return [];
  }

  const groupsByKey = new Map();

  for (const session of state.sessions) {
    const project = getSessionProjectMeta(session.cwd);
    if (!groupsByKey.has(project.key)) {
      groupsByKey.set(project.key, {
        ...project,
        sessions: [],
      });
    }

    groupsByKey.get(project.key).sessions.push(session);
  }

  return Array.from(groupsByKey.values());
}

function ensureSessionProjectDefaults(groups) {
  const knownKeys = new Set(groups.map((group) => group.key));
  for (const key of Array.from(state.sessionProjectExpanded)) {
    if (!knownKeys.has(key)) {
      state.sessionProjectExpanded.delete(key);
    }
  }

  if (state.sessionProjectInteractionSeen || state.sessionProjectExpanded.size > 0) {
    return;
  }

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || state.sessions[0];
  if (activeSession) {
    expandSessionProject(activeSession.cwd);
    return;
  }

  if (groups[0]) {
    expandSessionProject(groups[0].cwd);
  }
}

function renderSessionCard(session) {
  const status = getSessionLabel(session);
  const subagents = Array.isArray(session.subagents) ? session.subagents : [];
  const visibleSubagents = subagents.filter(
    (subagent) => subagent?.status === "working",
  );

  return `
    <article class="session-card ${session.id === state.activeSessionId ? "is-active" : ""}" data-session-id="${session.id}">
      ${renderSessionActivityButton(session, status)}
      <div class="session-main">
        <div class="session-name">${escapeHtml(session.name)}</div>
        <div class="session-subtitle">${escapeHtml(session.providerLabel)}</div>
      </div>
      <span class="session-time">${relativeTime(session.lastOutputAt)}</span>
      <div class="session-actions">
        <button class="session-action-button session-fork-button" type="button" aria-label="Fork session" ${tooltipAttributes("Fork session")} data-fork-session="${session.id}">
          ${renderIcon(GitFork)}
        </button>
        <button class="session-action-button" type="button" aria-label="Rename session" ${tooltipAttributes("Rename session")} data-rename-session="${session.id}">
          ${renderIcon(Pencil)}
        </button>
        <button class="session-action-button session-delete-button" type="button" aria-label="Delete session" ${tooltipAttributes("Delete session")} data-delete-session="${session.id}">
          ${renderIcon(Trash2)}
        </button>
      </div>
    </article>
    ${
      visibleSubagents.length
        ? `<div class="session-subagents" aria-label="Session subagents">${visibleSubagents.map((subagent) => renderSessionSubagentCard(subagent)).join("")}</div>`
        : ""
    }
  `;
}

function renderSessionActivityButton(session, status) {
  const canMarkRead = status.className === "unread";
  const title = canMarkRead ? "mark session read" : status.title;
  const dot = `<span class="session-activity-dot ${status.className}" aria-hidden="true"${getSessionActivityStyle(status)}></span>`;
  if (!canMarkRead) {
    return `
      <span class="session-activity-dot-frame" role="img" aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}">
        ${dot}
      </span>
    `;
  }

  return `
    <button
      class="session-activity-dot-button is-markable"
      type="button"
      aria-label="${escapeHtml(title)}"
      title="${escapeHtml(title)}"
      data-mark-session-read="${escapeHtml(session.id)}"
    >
      ${dot}
    </button>
  `;
}

function getSubagentLabel(subagent) {
  if (subagent?.status === "working") {
    return { className: "working", title: `${subagent?.agentType || "subagent"} is working` };
  }

  if (subagent?.status === "failed") {
    return { className: "exited", title: `${subagent?.agentType || "subagent"} failed` };
  }

  return { className: "read", title: `${subagent?.agentType || "subagent"} finished` };
}

function renderSessionSubagentCard(subagent) {
  const status = getSubagentLabel(subagent);
  const isBrowserUseSubagent = Boolean(subagent.browserUseSessionId);
  const messageCount = Number(subagent.messageCount);
  const toolUseCount = Number(subagent.toolUseCount);
  const metaParts = [
    isBrowserUseSubagent ? "browser use" : `${subagent.source === "claude" ? "Claude" : subagent.agentType || "agent"} subagent`,
    subagent.status && subagent.status !== "working" ? subagent.status : "",
    subagent.messageCount != null && Number.isFinite(messageCount) ? `${messageCount} msgs` : "",
    subagent.toolUseCount != null && Number.isFinite(toolUseCount) ? `${toolUseCount} tools` : "",
    subagent.latestUrl || "",
  ].filter(Boolean);
  const title = isBrowserUseSubagent
    ? `Open Browser Use session: ${subagent.description || subagent.name || "Browser task"}`
    : `Claude subagent: ${subagent.description || subagent.name || "subagent"}`;

  if (isBrowserUseSubagent) {
    const browserUseSessionId = escapeHtml(subagent.browserUseSessionId);
    const openLabel = `Open Browser Use session: ${escapeHtml(subagent.name || "Browser task")}`;
    const deleteLabel = "Terminate browser-use session";
    return `
      <div class="session-subagent-card is-browser-use" title="${escapeHtml(title)}">
        <button class="session-subagent-main" type="button" data-open-browser-use-session="${browserUseSessionId}" aria-label="${openLabel}">
          <span class="session-activity-dot ${status.className}" role="img" aria-label="${escapeHtml(status.title)}" title="${escapeHtml(status.title)}"${getSessionActivityStyle(status)}></span>
          <div class="session-main">
            <div class="session-name">${escapeHtml(subagent.name || "subagent")}</div>
            <div class="session-subtitle">${escapeHtml(metaParts.join(" · "))}</div>
          </div>
          <span class="session-subagent-trailing">
            <span class="session-time">${relativeTime(subagent.updatedAt)}</span>
            <span class="session-subagent-open" aria-hidden="true">${renderIcon(AppWindow)}</span>
          </span>
        </button>
        <button class="session-subagent-delete" type="button" data-delete-browser-use-session="${browserUseSessionId}" aria-label="${deleteLabel}" ${tooltipAttributes(deleteLabel)}>
          ${renderIcon(Trash2)}
        </button>
      </div>
    `;
  }

  return `
    <div class="session-subagent-card is-provider-subagent" title="${escapeHtml(title)}">
      <span class="session-activity-dot ${status.className}" role="img" aria-label="${escapeHtml(status.title)}" title="${escapeHtml(status.title)}"${getSessionActivityStyle(status)}></span>
      <div class="session-main">
        <div class="session-name">${escapeHtml(subagent.name || "subagent")}</div>
        <div class="session-subtitle">${escapeHtml(metaParts.join(" · "))}</div>
      </div>
      <span class="session-subagent-trailing">
        <span class="session-time">${relativeTime(subagent.updatedAt)}</span>
      </span>
    </div>
  `;
}

function renderSessionCards() {
  const groups = getSessionProjectGroups();
  if (!groups.length) {
    return `<div class="blank-state">no sessions</div>`;
  }

  ensureSessionProjectDefaults(groups);

  return groups
    .map((group) => {
      const expanded = state.sessionProjectExpanded.has(group.key);
      const active = group.sessions.some((session) => session.id === state.activeSessionId);
      const graphSessionId = group.sessions[0]?.id || "";
      return `
        <section class="session-project ${expanded ? "is-expanded" : ""} ${active ? "has-active-session" : ""}" data-session-project="${escapeHtml(group.key)}">
          <div class="session-project-head">
            <button
              class="session-project-toggle"
              type="button"
              data-session-project-toggle="${escapeHtml(group.key)}"
              aria-expanded="${expanded ? "true" : "false"}"
              title="${escapeHtml(group.cwd || group.name)}"
            >
              <span class="session-project-icon ${isRemoteVibesSystemFolder(group.cwd || group.name) ? "is-system" : ""}" aria-hidden="true">
                ${renderIcon(getDirectoryIcon(group.cwd || group.name, expanded))}
              </span>
              <span class="session-project-copy">
                <span class="session-project-name">${escapeHtml(group.name)}</span>
              </span>
            </button>
            <button
              class="session-project-graph"
              type="button"
              data-open-swarm-project="${escapeHtml(group.cwd)}"
              data-swarm-project-fallback-session="${escapeHtml(graphSessionId)}"
              data-swarm-project-name="${escapeHtml(group.name)}"
              aria-label="Open repo graph for ${escapeHtml(group.name)}"
              ${tooltipAttributes("Repo graph")}
            >
              ${renderIcon(Waypoints)}
            </button>
            <button
              class="session-project-new"
              type="button"
              data-create-session-in-cwd="${escapeHtml(group.cwd)}"
              aria-label="Create a new session in ${escapeHtml(group.name)}"
              ${tooltipAttributes("New session in this folder")}
            >${renderIcon(MessageSquarePlus)}</button>
          </div>
          ${
            expanded
              ? `<div class="session-project-sessions">${group.sessions.map((session) => renderSessionCard(session)).join("")}</div>`
              : ""
          }
        </section>
      `;
    })
    .join("");
}

function getSelectedProviderLabel() {
  return getSelectedProvider()?.label || "agent";
}

function renderSidebarNav() {
  const wikiLabel = state.settings.wikiRelativeRoot || state.agentPromptWikiRoot || "wiki";
  const primaryItems = [
    {
      view: "plugins",
      icon: Plug,
      label: "Plugins",
      meta: "MCPs and integrations",
    },
    {
      view: "automations",
      icon: CalendarClock,
      label: "Automations",
      meta: "scheduled helpers",
    },
    {
      view: "system",
      icon: ServerCog,
      label: "System",
      meta: "storage, CPU, GPU",
    },
  ];
  const workspaceItems = [
    {
      view: "knowledge-base",
      icon: BookOpen,
      label: "Knowledge Base",
      meta: `${state.knowledgeBase.notes.length} notes · ${wikiLabel}`,
    },
    {
      view: "agent-prompt",
      icon: FilePenLine,
      label: "Agent Prompt",
      meta: getAgentPromptTargetSummary(),
    },
  ];

  const renderItem = (item) => `
    <a
      class="sidebar-nav-item ${state.currentView === item.view ? "is-active" : ""}"
      href="${escapeHtml(getMainViewUrl(item.view))}"
      data-open-main-view="${escapeHtml(item.view)}"
      ${tooltipAttributes(item.label, "right")}
    >
      <span class="sidebar-nav-icon" aria-hidden="true">${renderIcon(item.icon)}</span>
      <span class="sidebar-nav-copy">
        <span class="sidebar-nav-label">${escapeHtml(item.label)}</span>
        <span class="sidebar-nav-meta">${escapeHtml(item.meta)}</span>
      </span>
    </a>
  `;

  return `
    <div class="sidebar-nav-stack">
      <nav class="sidebar-nav sidebar-primary-nav" aria-label="Main views">
        <button class="sidebar-nav-item sidebar-nav-button" type="button" data-folder-picker-target="session" ${tooltipAttributes("New chat", "right")}>
          <span class="sidebar-nav-icon" aria-hidden="true">${renderIcon(Plus)}</span>
          <span class="sidebar-nav-copy">
            <span class="sidebar-nav-label">New chat</span>
            <span class="sidebar-nav-meta">${escapeHtml(`${getSelectedProviderLabel()} · choose folder`)}</span>
          </span>
        </button>
        <form class="session-form session-launcher" id="session-form">
          ${renderSessionProviderPicker()}
        </form>
        ${primaryItems.map(renderItem).join("")}
      </nav>
      <nav class="sidebar-nav sidebar-workspace-nav" aria-label="Workspace views">
        ${workspaceItems.map(renderItem).join("")}
      </nav>
    </div>
  `;
}

function renderPortCards() {
  if (!isLocalhostAppsEnabled()) {
    return `<div class="blank-state">install Localhost Apps to see ports</div>`;
  }

  if (!state.ports.length) {
    return `<div class="blank-state">no ports</div>`;
  }

  return state.ports
    .map((port) => {
      const primaryUrl = getPortPrimaryUrl(port);
      const proxyUrl = getPortProxyUrl(port);
      const showProxyLink = port.preferredAccess && port.preferredAccess !== "proxy";
      const portNumber = escapeHtml(port.port);
      const exposeButton = port.canExposeWithTailscale
        ? `<button class="ghost-button port-action-button" type="button" data-expose-tailscale-port="${portNumber}">expose</button>`
        : "";

      return `
        <article class="port-card">
          <button class="port-link port-preview-trigger" type="button" data-open-port-preview="${portNumber}" aria-label="Preview ${escapeHtml(getPortDisplayName(port))}" ${tooltipAttributes(`Preview ${getPortDisplayName(port)}`)}>
            <span class="port-number">${escapeHtml(getPortDisplayName(port))}</span>
            <span class="port-meta">${escapeHtml(getPortMeta(port))}</span>
            <span class="port-access-pill">${escapeHtml(getPortAccessHint(port))}</span>
          </button>
          <div class="port-action-row">
            <button class="ghost-button port-action-button port-primary-button" type="button" data-open-port-preview="${portNumber}">preview</button>
            <a class="ghost-button port-action-button" href="${escapeHtml(primaryUrl)}" target="_blank" rel="noreferrer">${escapeHtml(getPortAccessLabel(port))}</a>
            ${showProxyLink ? `<a class="ghost-button port-action-button" href="${escapeHtml(proxyUrl)}" target="_blank" rel="noreferrer">proxy</a>` : ""}
            ${exposeButton}
            <button class="ghost-button port-action-button port-rename-button" type="button" data-rename-port="${portNumber}">edit</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function searchMatches(values, query) {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLowerCase();
  return values.some((value) => String(value || "").toLowerCase().includes(normalizedQuery));
}

function getGlobalSearchResults() {
  const query = String(state.globalSearchQuery || "").trim().toLowerCase();
  const results = [];

  for (const session of state.sessions) {
    if (!searchMatches([session.name, session.providerLabel, session.cwd], query)) {
      continue;
    }

    results.push({
      type: "session",
      title: session.name,
      meta: `${session.providerLabel} · ${relativeTime(session.lastOutputAt)}`,
      excerpt: session.cwd,
      sessionId: session.id,
    });
  }

  for (const group of getSessionProjectGroups()) {
    if (!searchMatches([group.name, group.cwd, group.sessions.map((session) => session.name).join(" ")], query)) {
      continue;
    }

    results.push({
      type: "project",
      title: group.name,
      meta: `${group.sessions.length} ${group.sessions.length === 1 ? "session" : "sessions"}`,
      excerpt: group.cwd,
      cwd: group.cwd,
    });
  }

  if (isLocalhostAppsEnabled()) {
    for (const port of state.ports) {
      if (!searchMatches([getPortDisplayName(port), getPortMeta(port), port.process, port.port], query)) {
        continue;
      }

      results.push({
        type: "port",
        title: getPortDisplayName(port),
        meta: getPortAccessHint(port),
        excerpt: getPortMeta(port),
        port: port.port,
      });
    }
  }

  for (const note of state.knowledgeBase.notes) {
    if (!searchMatches([note.title, note.relativePath, note.excerpt, note.searchText], query)) {
      continue;
    }

    results.push({
      type: "note",
      title: note.title,
      meta: note.relativePath,
      excerpt: note.excerpt || "markdown note",
      notePath: note.relativePath,
    });
  }

  return results.slice(0, 60);
}

function getGlobalSearchResultLabel() {
  const query = String(state.globalSearchQuery || "").trim();
  const count = getGlobalSearchResults().length;

  if (!query) {
    return `${count} recent items`;
  }

  return `${count} result${count === 1 ? "" : "s"} for "${query}"`;
}

function renderSearchResult(result) {
  const actionLabel =
    result.type === "session"
      ? "open"
      : result.type === "project"
        ? "new"
        : result.type === "port"
          ? "preview"
          : "read";
  const attributes =
    result.type === "session"
      ? `data-session-id="${escapeHtml(result.sessionId)}"`
      : result.type === "project"
        ? `data-create-session-in-cwd="${escapeHtml(result.cwd)}"`
        : result.type === "port"
          ? `data-open-port-preview="${escapeHtml(result.port)}"`
          : `data-open-search-note="${escapeHtml(result.notePath)}"`;

  return `
    <button class="main-search-result" type="button" ${attributes}>
      <span class="main-search-kind">${escapeHtml(result.type)}</span>
      <span class="main-search-copy">
        <strong>${escapeHtml(result.title)}</strong>
        <span>${escapeHtml(result.meta)}</span>
        <em>${escapeHtml(result.excerpt || "")}</em>
      </span>
      <span class="main-search-action">${escapeHtml(actionLabel)}</span>
    </button>
  `;
}

function renderSearchResults() {
  const results = getGlobalSearchResults();

  if (state.knowledgeBase.loading && !state.knowledgeBase.notes.length) {
    return `<div class="blank-state">loading knowledge base notes...</div>`;
  }

  if (!results.length) {
    return `<div class="blank-state">nothing matched yet</div>`;
  }

  return results.map((result) => renderSearchResult(result)).join("");
}

function renderSearchView() {
  return `
    <section class="dashboard-panel main-view search-view" ${renderMainViewAttributes(
      "search",
      `search:${state.globalSearchQuery || ""}`,
    )}>
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>${renderIcon(Menu)}</button>
        <div class="dashboard-copy">
          <strong>Search</strong>
          <div class="terminal-meta">jump across sessions, project folders, ports, and wiki notes</div>
        </div>
      </div>
      <div class="main-search-shell">
        <span class="main-search-icon" aria-hidden="true">${renderIcon(Search)}</span>
        <input
          id="global-search-input"
          class="main-search-input"
          type="search"
          value="${escapeHtml(state.globalSearchQuery)}"
          placeholder="Search Remote Vibes"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
        />
        <span class="main-search-count">${escapeHtml(getGlobalSearchResultLabel())}</span>
      </div>
      <div class="main-results-grid" id="global-search-results">${renderSearchResults()}</div>
    </section>
  `;
}

function getFilteredPlugins() {
  const query = String(state.pluginSearchQuery || "").trim().toLowerCase();
  return PLUGIN_CATALOG.filter((plugin) =>
    searchMatches([plugin.name, plugin.category, plugin.description, getPluginStatusLabel(plugin), plugin.source], query),
  );
}

function getPluginId(plugin) {
  return String(plugin?.id || plugin?.name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getPluginById(pluginId) {
  return PLUGIN_CATALOG.find((plugin) => getPluginId(plugin) === pluginId) || null;
}

function getInstalledPluginIds() {
  return new Set(Array.isArray(state.settings.installedPluginIds) ? state.settings.installedPluginIds : []);
}

function getUpdatedInstalledPluginIds(pluginId, installed) {
  const pluginIds = getInstalledPluginIds();
  if (installed) {
    pluginIds.add(pluginId);
  } else {
    pluginIds.delete(pluginId);
  }

  return [...pluginIds].sort();
}

function isPluginInstalled(plugin) {
  const pluginId = getPluginId(plugin);

  if (pluginId === "browser-use") {
    return Boolean(state.settings.browserUseEnabled);
  }

  return getInstalledPluginIds().has(pluginId);
}

function isPluginIdInstalled(pluginId) {
  const plugin = getPluginById(pluginId);
  return plugin ? isPluginInstalled(plugin) : getInstalledPluginIds().has(pluginId);
}

function isLocalhostAppsEnabled() {
  return isPluginIdInstalled("localhost-apps");
}

function getPluginPendingAction(plugin) {
  return state.pluginInstallActions[getPluginId(plugin)] || "";
}

function getPluginStatusLabel(plugin) {
  const pendingAction = getPluginPendingAction(plugin);
  if (pendingAction === "installing") {
    return "installing";
  }
  if (pendingAction === "uninstalling") {
    return "uninstalling";
  }
  return isPluginInstalled(plugin) ? "installed" : "not installed";
}

function renderPluginInstallButton(plugin) {
  const pluginId = getPluginId(plugin);
  const installed = isPluginInstalled(plugin);
  const pendingAction = getPluginPendingAction(plugin);
  const pending = Boolean(pendingAction);
  const label = pending
    ? pendingAction === "installing"
      ? "Installing..."
      : "Uninstalling..."
    : installed
      ? "Uninstall"
      : "Install";
  const ariaLabel = `${installed ? "Uninstall" : "Install"} ${plugin.name}`;
  const disabled = pending;
  const nextInstalled = installed ? "false" : "true";
  const buttonClass = `${installed ? "ghost-button" : "primary-button"} plugin-install-button ${installed ? "is-installed" : ""} ${pending ? "is-loading" : ""}`;

  return `
    <button
      class="${escapeHtml(buttonClass)}"
      type="button"
      data-plugin-install="${escapeHtml(pluginId)}"
      data-plugin-next-installed="${escapeHtml(nextInstalled)}"
      aria-label="${escapeHtml(ariaLabel)}"
      ${tooltipAttributes(ariaLabel)}
      ${disabled ? "disabled" : ""}
    >
      <span class="plugin-install-spinner" aria-hidden="true"></span>
      <span class="plugin-install-label">${escapeHtml(label)}</span>
    </button>
  `;
}

function renderPluginCards() {
  const plugins = getFilteredPlugins();

  if (!plugins.length) {
    return `<div class="blank-state">no plugins match "${escapeHtml(state.pluginSearchQuery)}"</div>`;
  }

  return plugins
    .map(
      (plugin) => {
        const installed = isPluginInstalled(plugin);
        const pendingAction = getPluginPendingAction(plugin);
        return `
        <article class="plugin-card ${installed ? "is-installed" : ""} ${pendingAction ? "is-pending" : ""}">
          <div class="plugin-icon" aria-hidden="true">${renderIcon(plugin.icon || Plug)}</div>
          <div class="plugin-copy">
            <strong>${escapeHtml(plugin.name)}</strong>
            <span>${escapeHtml(plugin.description)}</span>
            <em>${escapeHtml(plugin.category)}</em>
          </div>
          ${renderPluginInstallButton(plugin)}
          <span class="plugin-status">${escapeHtml(getPluginStatusLabel(plugin))}</span>
        </article>
      `;
      },
    )
    .join("");
}

function renderBrowserUsePluginPanel() {
  const status = state.settings.browserUseStatus || {};

  return `
    <aside class="mcp-import-card browser-use-plugin-card">
      <span class="main-search-kind">browser agent</span>
      <strong>Browser Use</strong>
      <p>Remote Vibes can launch the local OttoAuth headless worker as a browser fulfillment subagent and stream its current browser snapshot back into the session sidebar.</p>
      <form class="settings-form browser-use-form" id="browser-use-form">
        <label class="checkbox-row">
          <input type="checkbox" name="browserUseEnabled" ${state.settings.browserUseEnabled ? "checked" : ""} />
          <span>enable browser-use requests</span>
        </label>
        <label class="field-label" for="browser-use-api-key">Anthropic API key</label>
        <input
          class="file-root-input"
          id="browser-use-api-key"
          name="browserUseAnthropicApiKey"
          type="password"
          placeholder="${escapeHtml(state.settings.browserUseAnthropicApiKeyConfigured ? "saved; leave blank to keep" : "sk-ant-...")}"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
        />
        <label class="field-label" for="browser-use-worker-path">OttoAuth worker folder</label>
        <input
          class="file-root-input"
          id="browser-use-worker-path"
          name="browserUseWorkerPath"
          type="text"
          value="${escapeHtml(state.settings.browserUseWorkerPath || status.workerPath || "")}"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
        />
        <label class="field-label" for="browser-use-profile-dir">browser profile folder</label>
        <input
          class="file-root-input"
          id="browser-use-profile-dir"
          name="browserUseProfileDir"
          type="text"
          value="${escapeHtml(state.settings.browserUseProfileDir || status.profileDir || "")}"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
        />
        <div class="knowledge-settings-remote-grid">
          <label class="field-label" for="browser-use-model">model</label>
          <input
            class="file-root-input"
            id="browser-use-model"
            name="browserUseModel"
            type="text"
            value="${escapeHtml(state.settings.browserUseModel || "")}"
            placeholder="worker default"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
          />
          <label class="field-label" for="browser-use-max-turns">max steps</label>
          <input
            class="file-root-input"
            id="browser-use-max-turns"
            name="browserUseMaxTurns"
            type="number"
            min="1"
            max="200"
            step="1"
            value="${escapeHtml(String(state.settings.browserUseMaxTurns || status.maxTurns || 50))}"
            autocomplete="off"
          />
          <label class="checkbox-row browser-use-compact-checkbox">
            <input type="checkbox" name="browserUseHeadless" ${state.settings.browserUseHeadless ? "checked" : ""} />
            <span>headless</span>
          </label>
          <label class="checkbox-row browser-use-compact-checkbox">
            <input type="checkbox" name="browserUseKeepTabs" ${state.settings.browserUseKeepTabs ? "checked" : ""} />
            <span>keep tabs</span>
          </label>
        </div>
        <div class="knowledge-settings-actions">
          <button class="primary-button settings-save-button" type="submit" data-browser-use-action="setup">save browser use</button>
          <div class="settings-status" id="browser-use-settings-status">${escapeHtml(getBrowserUseStatusText())}</div>
        </div>
      </form>
      <p class="mcp-import-paths">Tool: <code>rv-browser-use --task "..."</code> · sessions appear below their caller.</p>
    </aside>
  `;
}

function renderPluginsView() {
  return `
    <section class="dashboard-panel main-view plugins-view" ${renderMainViewAttributes(
      "plugins",
      `plugins:${state.pluginSearchQuery || ""}`,
    )}>
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>${renderIcon(Menu)}</button>
        <div class="dashboard-copy">
          <strong>Plugins</strong>
          <div class="terminal-meta">a Codex-style place for MCPs, integrations, and built-in Remote Vibes tools</div>
        </div>
      </div>
      <div class="main-search-shell">
        <span class="main-search-icon" aria-hidden="true">${renderIcon(Plug)}</span>
        <input
          id="plugin-search-input"
          class="main-search-input"
          type="search"
          value="${escapeHtml(state.pluginSearchQuery)}"
          placeholder="Search plugins"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
        />
        <span class="main-search-count">${escapeHtml(`${getFilteredPlugins().length} shown`)}</span>
      </div>
      <div class="plugins-layout">
        <section class="plugin-grid" id="plugin-results">${renderPluginCards()}</section>
        <div class="plugins-side-stack">
          ${renderBrowserUsePluginPanel()}
          <aside class="mcp-import-card">
            <span class="main-search-kind">MCP bridge</span>
            <strong>Port the MCPs your agents already use</strong>
            <p>Remote Vibes launches the real Codex, Claude, Gemini, and OpenCode CLIs, so their existing MCP/plugin configs still matter inside each session. This page is the first shared surface for making those tools visible from Remote Vibes itself.</p>
            <p class="mcp-import-paths">Common places to import from next: <code>~/.codex</code>, <code>~/.claude</code>, project MCP files, and agent-specific config folders.</p>
          </aside>
        </div>
      </div>
    </section>
  `;
}

function renderAutomationSelectOptions(options, selectedValue) {
  return options
    .map(([value, label]) => `<option value="${escapeHtml(value)}" ${selectedValue === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function getAutomationCadenceLabel(cadence) {
  return AUTOMATION_CADENCE_OPTIONS.find(([value]) => value === cadence)?.[1] || "Daily";
}

function getAutomationWeekdayLabel(weekday) {
  return AUTOMATION_WEEKDAY_OPTIONS.find(([value]) => value === weekday)?.[1] || "Monday";
}

function getAutomationPromptPreview(prompt) {
  const preview = String(prompt || "")
    .trim()
    .replace(/\s+/g, " ");
  return preview.length > 140 ? `${preview.slice(0, 137)}...` : preview;
}

function getAutomationScheduleLabel(automation) {
  const time = automation?.time || "09:00";
  switch (automation?.cadence) {
    case "hourly":
      return "Every hour";
    case "six-hours":
      return "Every 6 hours";
    case "weekday":
      return `Weekdays at ${time}`;
    case "weekly":
      return `${getAutomationWeekdayLabel(automation.weekday)} at ${time}`;
    case "daily":
    default:
      return `Daily at ${time}`;
  }
}

function renderAgentAutomationCards() {
  const automations = Array.isArray(state.settings.agentAutomations) ? state.settings.agentAutomations : [];
  return automations
    .map(
      (automation) => `
        <article class="automation-card agent-automation-card ${automation.enabled === false ? "is-disabled" : "is-enabled"}">
          <div class="automation-card-icon" aria-hidden="true">${renderIcon(Bot)}</div>
          <span class="main-search-kind">${automation.enabled === false ? "disabled" : "enabled"}</span>
          <strong>${escapeHtml(getAutomationScheduleLabel(automation))}</strong>
          <p>${escapeHtml(getAutomationPromptPreview(automation.prompt))}</p>
          <button
            class="ghost-button toolbar-control"
            type="button"
            data-delete-agent-automation="${escapeHtml(automation.id)}"
            aria-label="Delete automation"
            ${tooltipAttributes("Delete automation")}
          >delete</button>
        </article>
      `,
    )
    .join("");
}

function renderCreateAutomationCard() {
  return `
    <article class="automation-card automation-create-card">
      <div class="automation-card-icon" aria-hidden="true">${renderIcon(Plus)}</div>
      <span class="main-search-kind">new</span>
      <strong>Create automation</strong>
      <form class="settings-form automation-create-form" id="automation-create-form">
        <div class="automation-create-grid">
          <label class="automation-field">
            <span class="field-label">cadence</span>
            <select class="file-root-input" name="cadence">${renderAutomationSelectOptions(AUTOMATION_CADENCE_OPTIONS, "daily")}</select>
          </label>
          <label class="automation-field">
            <span class="field-label">time</span>
            <input class="file-root-input" type="time" name="time" value="09:00" />
          </label>
          <label class="automation-field">
            <span class="field-label">day</span>
            <select class="file-root-input" name="weekday">${renderAutomationSelectOptions(AUTOMATION_WEEKDAY_OPTIONS, "monday")}</select>
          </label>
        </div>
        <label class="field-label" for="automation-prompt">agent prompt</label>
        <textarea
          class="file-root-input automation-prompt-input"
          id="automation-prompt"
          name="prompt"
          rows="5"
          required
          placeholder="Ask the agent to..."
        ></textarea>
        <button class="primary-button automation-create-button" type="submit">create automation</button>
      </form>
    </article>
  `;
}

function renderAutomationsView() {
  const wikiBackupEnabled = Boolean(state.settings.wikiGitBackupEnabled);
  const wikiBackupLabel = wikiBackupEnabled ? "enabled" : "disabled";

  return `
    <section class="dashboard-panel main-view automations-view" ${renderMainViewAttributes("automations")}>
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>${renderIcon(Menu)}</button>
        <div class="dashboard-copy">
          <strong>Automations</strong>
          <div class="terminal-meta">scheduled Remote Vibes helpers live here as this grows</div>
        </div>
      </div>
      <div class="dashboard-range">
        <span class="dashboard-range-label">status</span>
        <span>Local automations are starting with wiki backup and will grow into plugin-backed jobs.</span>
        <span class="dashboard-updated">${escapeHtml(state.settings.wikiGitBackupEnabled ? "wiki backup on" : "wiki backup off")}</span>
      </div>
      <div class="main-results-grid automation-grid">
        <article class="automation-card ${wikiBackupEnabled ? "is-enabled" : "is-disabled"}">
          <div class="automation-card-icon" aria-hidden="true">${renderIcon(CalendarClock)}</div>
          <button
            class="main-search-kind automation-status-toggle ${wikiBackupEnabled ? "is-enabled" : "is-disabled"}"
            type="button"
            data-toggle-automation="wiki-backup"
            aria-pressed="${wikiBackupEnabled ? "true" : "false"}"
            aria-label="${wikiBackupEnabled ? "Disable" : "Enable"} knowledge base git backup"
            ${tooltipAttributes(`${wikiBackupEnabled ? "Disable" : "Enable"} knowledge base git backup`)}
          >${escapeHtml(wikiBackupLabel)}</button>
          <strong>Knowledge base git backup</strong>
          <p>Backs up the selected wiki every ${escapeHtml(String(Math.round((state.settings.wikiBackupIntervalMs || 0) / 60000) || 5))} minutes when enabled.</p>
          <button class="ghost-button toolbar-control" type="button" data-open-main-view="knowledge-base">open settings</button>
        </article>
        ${renderCreateAutomationCard()}
        ${renderAgentAutomationCards()}
      </div>
    </section>
  `;
}

function renderMetricBar(value, className = "") {
  const percent = getMetricPercent(value);
  return `
    <div class="metric-bar ${escapeHtml(className)}" style="--metric-value: ${percent}%">
      <span></span>
    </div>
  `;
}

function getFiniteMetricPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, 0, 100) : null;
}

function createSystemMetricHistorySample(system) {
  if (!system) {
    return null;
  }

  const checkedAt = system.checkedAt || new Date().toISOString();

  return {
    checkedAt,
    cpu: {
      utilizationPercent: getFiniteMetricPercent(system.cpu?.utilizationPercent),
      cores: (Array.isArray(system.cpu?.cores) ? system.cpu.cores : []).map((core, index) => ({
        id: String(core?.id ?? index),
        label: core?.label || `CPU ${index + 1}`,
        utilizationPercent: getFiniteMetricPercent(core?.utilizationPercent),
      })),
    },
    storage: {
      primary: system.storage?.primary
        ? {
            name: system.storage.primary.name || "Disk",
            usedPercent: getFiniteMetricPercent(system.storage.primary.usedPercent ?? system.storage.primary.capacityPercent),
          }
        : null,
    },
    memory: system.memory
      ? {
          usedPercent: getFiniteMetricPercent(system.memory.usedPercent),
        }
      : null,
    gpus: (Array.isArray(system.gpus) ? system.gpus : []).map((gpu, index) => ({
      id: String(gpu?.id || `gpu-${index}`),
      name: gpu?.name || `GPU ${index + 1}`,
      utilizationPercent: getFiniteMetricPercent(gpu?.utilizationPercent),
    })),
  };
}

function getSystemChartHistory(system) {
  if (state.systemMetricHistory.length) {
    return state.systemMetricHistory;
  }

  const sample = createSystemMetricHistorySample(system);
  return sample ? [sample] : [];
}

function buildCpuCoreChartSeries(history) {
  const labels = new Map();
  const order = [];

  for (const sample of history) {
    for (const core of sample.cpu?.cores || []) {
      if (!labels.has(core.id)) {
        labels.set(core.id, core.label);
        order.push(core.id);
      }
    }
  }

  return order.map((id) => ({
    id,
    label: labels.get(id) || id,
    values: history.map((sample) => {
      const core = (sample.cpu?.cores || []).find((entry) => entry.id === id);
      return getFiniteMetricPercent(core?.utilizationPercent);
    }),
  }));
}

function buildMemoryChartSeries(history) {
  return [
    {
      id: "memory",
      label: "Memory",
      values: history.map((sample) => getFiniteMetricPercent(sample.memory?.usedPercent)),
    },
  ];
}

function buildStorageChartSeries(history) {
  const latestPrimary = [...history].reverse().find((sample) => sample.storage?.primary)?.storage?.primary;
  return [
    {
      id: "storage",
      label: latestPrimary?.name || "Disk",
      values: history.map((sample) => getFiniteMetricPercent(sample.storage?.primary?.usedPercent)),
    },
  ];
}

function buildGpuChartSeries(history) {
  const labels = new Map();
  const order = [];

  for (const sample of history) {
    for (const gpu of sample.gpus || []) {
      if (!labels.has(gpu.id)) {
        labels.set(gpu.id, gpu.name);
        order.push(gpu.id);
      }
    }
  }

  return order.map((id) => ({
    id,
    label: labels.get(id) || id,
    values: history.map((sample) => {
      const gpu = (sample.gpus || []).find((entry) => entry.id === id);
      return getFiniteMetricPercent(gpu?.utilizationPercent);
    }),
  }));
}

function getLatestSeriesValue(series) {
  for (let index = series.values.length - 1; index >= 0; index -= 1) {
    const value = getFiniteMetricPercent(series.values[index]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function getSystemHistoryTimestampMs(sample) {
  const timestamp = new Date(sample?.checkedAt || "").getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildSystemChartContext(history, totalPoints) {
  const timestamps = Array.from({ length: totalPoints }, (_, index) => getSystemHistoryTimestampMs(history[index]));
  const validTimestamps = timestamps.filter((timestamp) => timestamp !== null);
  const minTimestamp = validTimestamps.length ? Math.min(...validTimestamps) : null;
  const maxTimestamp = validTimestamps.length ? Math.max(...validTimestamps) : null;

  return {
    width: SYSTEM_CHART_WIDTH,
    height: SYSTEM_CHART_HEIGHT,
    x(index) {
      const timestamp = timestamps[index];
      if (timestamp !== null && minTimestamp !== null && maxTimestamp !== null && maxTimestamp > minTimestamp) {
        return ((timestamp - minTimestamp) / (maxTimestamp - minTimestamp)) * SYSTEM_CHART_WIDTH;
      }

      return totalPoints <= 1 ? SYSTEM_CHART_WIDTH / 2 : (index / (totalPoints - 1)) * SYSTEM_CHART_WIDTH;
    },
  };
}

function getChartPoint(value, index, context) {
  const x = context.x(index);
  const y = context.height - (getMetricPercent(value) / 100) * context.height;
  return {
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
  };
}

function renderChartSeries(series, seriesIndex, chartContext) {
  const color = SYSTEM_CHART_COLORS[seriesIndex % SYSTEM_CHART_COLORS.length];
  const points = series.values
    .map((value, index) => (getFiniteMetricPercent(value) === null ? null : getChartPoint(value, index, chartContext)))
    .filter(Boolean);

  if (!points.length) {
    return "";
  }

  let pathData = "";
  let openSegment = false;
  series.values.forEach((value, index) => {
    const percent = getFiniteMetricPercent(value);
    if (percent === null) {
      openSegment = false;
      return;
    }

    const point = getChartPoint(percent, index, chartContext);
    pathData += `${openSegment ? "L" : "M"} ${point.x} ${point.y} `;
    openSegment = true;
  });

  const latestPoint = points.at(-1);
  return `
    <path class="system-line-chart-path" d="${pathData.trim()}" style="--chart-color: ${escapeHtml(color)}"></path>
    <circle class="system-line-chart-dot" cx="${latestPoint.x}" cy="${latestPoint.y}" r="3.4" style="--chart-color: ${escapeHtml(color)}"></circle>
  `;
}

function formatSystemChartTime(timestamp, rangeId) {
  const date = new Date(timestamp || "");
  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  const options =
    rangeId === "1w"
      ? { weekday: "short", hour: "numeric" }
      : { hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function getSystemChartXAxisLabels(history, range) {
  const firstSample = history.find((sample) => getSystemHistoryTimestampMs(sample) !== null);
  const lastSample = [...history].reverse().find((sample) => getSystemHistoryTimestampMs(sample) !== null);
  const left = formatSystemChartTime(firstSample?.checkedAt, range.id) || "oldest";
  const right = formatSystemChartTime(lastSample?.checkedAt, range.id) || "latest";

  return {
    left,
    center: `time · ${range.title}`,
    right,
  };
}

function renderUtilizationLineChart({ emptyMessage, history, range, series, showLegendValues = true, subtitle, title }) {
  const activeSeries = series.filter((entry) => entry.values.some((value) => getFiniteMetricPercent(value) !== null));
  const totalPoints = Math.max(1, ...activeSeries.map((entry) => entry.values.length));
  const chartContext = buildSystemChartContext(history, totalPoints);
  const xAxisLabels = getSystemChartXAxisLabels(history, range);
  const visibleLegend = activeSeries.slice(0, 16);
  const hiddenLegendCount = Math.max(0, activeSeries.length - visibleLegend.length);

  return `
    <article class="system-chart-card">
      <div class="system-section-head">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(subtitle)}</span>
      </div>
      ${
        activeSeries.length
          ? `
            <div class="system-line-chart-wrap">
              <svg class="system-line-chart" viewBox="0 0 ${SYSTEM_CHART_WIDTH} ${SYSTEM_CHART_HEIGHT}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(title)} utilization history over ${escapeHtml(range.title)}">
                <line class="system-line-chart-grid" x1="0" y1="0" x2="${SYSTEM_CHART_WIDTH}" y2="0"></line>
                <line class="system-line-chart-grid" x1="0" y1="${SYSTEM_CHART_HEIGHT / 2}" x2="${SYSTEM_CHART_WIDTH}" y2="${SYSTEM_CHART_HEIGHT / 2}"></line>
                <line class="system-line-chart-grid" x1="0" y1="${SYSTEM_CHART_HEIGHT}" x2="${SYSTEM_CHART_WIDTH}" y2="${SYSTEM_CHART_HEIGHT}"></line>
                ${activeSeries.map((entry, index) => renderChartSeries(entry, index, chartContext)).join("")}
              </svg>
              <div class="system-line-chart-axis" aria-hidden="true">
                <span>100%</span>
                <span>50%</span>
                <span>0%</span>
              </div>
              <div class="system-line-chart-x-axis" aria-hidden="true">
                <span>${escapeHtml(xAxisLabels.left)}</span>
                <span>${escapeHtml(xAxisLabels.center)}</span>
                <span>${escapeHtml(xAxisLabels.right)}</span>
              </div>
            </div>
            <div class="system-chart-legend">
              ${visibleLegend
                .map((entry, index) => {
                  const color = SYSTEM_CHART_COLORS[index % SYSTEM_CHART_COLORS.length];
                  const latestValue = getLatestSeriesValue(entry);
                  return `
                    <span class="system-chart-chip" style="--chart-color: ${escapeHtml(color)}">
                      <i></i>${escapeHtml(entry.label)}
                      ${showLegendValues ? `<strong>${escapeHtml(formatPercent(latestValue))}</strong>` : ""}
                    </span>
                  `;
                })
                .join("")}
              ${hiddenLegendCount ? `<span class="system-chart-chip is-muted">${escapeHtml(`+${hiddenLegendCount} more`)}</span>` : ""}
            </div>
          `
          : `<div class="blank-state">${escapeHtml(emptyMessage)}</div>`
      }
    </article>
  `;
}

function renderSystemUtilizationCharts(system) {
  const history = getSystemChartHistory(system);
  const range = SYSTEM_HISTORY_RANGES.find((entry) => entry.id === state.systemHistoryRange) || SYSTEM_HISTORY_RANGES[0];
  const sampleCount = state.systemHistoryMeta?.sampleCount ?? history.length;
  const rawSampleCount = state.systemHistoryMeta?.rawSampleCount ?? sampleCount;
  const sampleText = sampleCount === 1 ? "1 sample" : `${sampleCount} samples`;
  const rawText = rawSampleCount > sampleCount ? ` · ${rawSampleCount} raw samples` : "";
  const intervalText = state.systemHistoryMeta?.minSampleIntervalMs
    ? ` · collected every ${Math.round(state.systemHistoryMeta.minSampleIntervalMs / 1000)}s`
    : "";

  return `
    <section class="system-history-panel">
      <div class="system-history-head">
        <div>
          <strong>History</strong>
          <span>${escapeHtml(range.title)} · x-axis is time, oldest → newest · ${escapeHtml(sampleText)}${escapeHtml(rawText)}${escapeHtml(intervalText)}</span>
        </div>
        <div class="system-history-ranges" role="group" aria-label="System history range">
          ${SYSTEM_HISTORY_RANGES.map(
            (entry) => `
              <button
                class="system-history-range-button ${entry.id === state.systemHistoryRange ? "is-active" : ""}"
                type="button"
                data-system-history-range="${escapeHtml(entry.id)}"
                aria-pressed="${entry.id === state.systemHistoryRange ? "true" : "false"}"
              >${escapeHtml(entry.label)}</button>
            `,
          ).join("")}
        </div>
      </div>
      ${
        state.systemHistoryError
          ? `<div class="system-error-card">${escapeHtml(state.systemHistoryError)}</div>`
          : ""
      }
      <div class="system-chart-grid">
        ${renderUtilizationLineChart({
          title: "CPU core history",
          subtitle: state.systemHistoryLoading ? "loading history..." : sampleText,
          history,
          range,
          series: buildCpuCoreChartSeries(history),
          showLegendValues: false,
          emptyMessage: "CPU core history starts after the first sample.",
        })}
        ${renderUtilizationLineChart({
          title: "GPU history",
          subtitle: state.systemHistoryLoading ? "loading history..." : sampleText,
          history,
          range,
          series: buildGpuChartSeries(history),
          emptyMessage: "GPU utilization is not exposed by this host.",
        })}
        ${renderUtilizationLineChart({
          title: "Memory history",
          subtitle: state.systemHistoryLoading ? "loading history..." : sampleText,
          history,
          range,
          series: buildMemoryChartSeries(history),
          emptyMessage: "Memory history starts after the first sample.",
        })}
        ${renderUtilizationLineChart({
          title: "Disk history",
          subtitle: state.systemHistoryLoading ? "loading history..." : sampleText,
          history,
          range,
          series: buildStorageChartSeries(history),
          emptyMessage: "Disk history starts after the first sample.",
        })}
      </div>
    </section>
  `;
}

function renderSystemStorageCard(system) {
  const primary = system?.storage?.primary;

  if (!primary) {
    return `
      <article class="system-storage-card">
        <div class="blank-state">storage metrics are not available on this host</div>
      </article>
    `;
  }

  const usedPercent = getMetricPercent(primary.usedPercent ?? primary.capacityPercent);
  const freeBytes = Number(primary.availableBytes || 0);
  const usedBytes = Number(primary.usedBytes || 0);
  const totalBytes = Number(primary.totalBytes || 0);
  const wiki = system?.wikiStorage;
  const wikiBytes = wiki?.exists ? Number(wiki.bytes || 0) : 0;
  const wikiPercent = totalBytes > 0 ? clamp((wikiBytes / totalBytes) * 100, 0, usedPercent) : 0;
  const project = system?.projectStorage;
  const projectRawBytes = project?.exists ? Number(project.bytes || 0) : 0;
  const projectPaths = Array.isArray(project?.paths) ? project.paths : [];
  const projectContainsWiki =
    wiki?.path && projectPaths.some((projectPath) => isAbsolutePathSameOrNested(wiki.path, projectPath));
  const projectBytes = Math.max(0, projectRawBytes - (projectContainsWiki ? wikiBytes : 0));
  const projectPercent =
    totalBytes > 0 ? clamp((projectBytes / totalBytes) * 100, 0, clamp(usedPercent - wikiPercent, 0, 100)) : 0;
  const otherUsedPercent = clamp(usedPercent - wikiPercent - projectPercent, 0, 100);
  const formatStoragePercentLabel = (percent) =>
    percent > 0 && percent < 0.01
      ? "<0.01%"
      : `${percent.toFixed(percent < 1 ? 2 : 1)}%`;
  const wikiPercentLabel = formatStoragePercentLabel(wikiPercent);
  const projectPercentLabel = formatStoragePercentLabel(projectPercent);
  const wikiLegend = wiki
    ? wiki.exists
      ? `${formatBytes(wikiBytes)} Knowledge Base (${wikiPercentLabel})`
      : "Knowledge Base folder missing"
    : "";
  const projectLegend = project
    ? project.exists
      ? `${formatBytes(projectBytes)} Project folders (${projectPercentLabel})`
      : "Project folders unavailable"
    : "";
  const wikiDetailParts = [
    wiki?.path || "",
    wiki?.source ? `measured by ${wiki.source}` : "",
    wiki?.warning || "",
    wiki?.error || "",
  ].filter(Boolean);
  const projectDetailParts = [
    project?.rootCount ? `${project.rootCount} folders measured` : "",
    project?.truncated ? `${project.measuredRootCount} of ${project.totalRootCount} folders included` : "",
    projectContainsWiki ? "Knowledge Base shown separately" : "",
    ...(Array.isArray(project?.warnings) ? project.warnings : []),
  ].filter(Boolean);

  return `
    <article class="system-storage-card">
      <div class="system-storage-head">
        <strong>${escapeHtml(primary.name || primary.mountPoint || "Storage")}</strong>
        <span>${escapeHtml(`${formatBytes(usedBytes)} of ${formatBytes(totalBytes)} used`)}</span>
      </div>
      <div class="system-storage-bar" style="--storage-used: ${otherUsedPercent}%; --storage-project: ${projectPercent}%; --storage-project-min: ${projectBytes > 0 ? "4px" : "0px"}; --storage-wiki: ${wikiPercent}%; --storage-wiki-min: ${wikiBytes > 0 ? "4px" : "0px"}">
        <span class="system-storage-used" title="Other used storage"></span>
        ${projectLegend ? `<span class="system-storage-project" title="${escapeHtml(projectLegend)}"></span>` : ""}
        ${wiki ? `<span class="system-storage-wiki" title="${escapeHtml(wikiLegend)}"></span>` : ""}
        <span class="system-storage-free"></span>
      </div>
      <div class="system-storage-legend">
        <span><i class="legend-dot is-used"></i>${escapeHtml(`${formatPercent(otherUsedPercent)} other used`)}</span>
        ${projectLegend ? `<span title="${escapeHtml(projectDetailParts.join(" · "))}"><i class="legend-dot is-project"></i>${escapeHtml(projectLegend)}</span>` : ""}
        ${wikiLegend ? `<span title="${escapeHtml(wikiDetailParts.join(" · "))}"><i class="legend-dot is-wiki"></i>${escapeHtml(wikiLegend)}</span>` : ""}
        <span><i class="legend-dot is-free"></i>${escapeHtml(`${formatBytes(freeBytes)} free`)}</span>
        <span>${escapeHtml(primary.mountPoint || "")}</span>
      </div>
    </article>
  `;
}

function renderSystemSummaryCards(system) {
  const cpu = system?.cpu;
  const memory = system?.memory;
  const gpuCount = system?.gpus?.length || 0;
  const acceleratorCount = system?.accelerators?.length || 0;

  return `
    <div class="system-summary-grid">
      <article class="system-summary-card">
        <span class="system-summary-label">${renderIcon(Cpu)} CPU</span>
        <strong>${escapeHtml(formatPercent(cpu?.utilizationPercent))}</strong>
        ${renderMetricBar(cpu?.utilizationPercent, "is-cpu")}
        <em>${escapeHtml(cpu?.coreCount ? `${cpu.coreCount} cores` : "no CPU sample")}</em>
      </article>
      <article class="system-summary-card">
        <span class="system-summary-label">${renderIcon(MemoryStick)} Memory</span>
        <strong>${escapeHtml(formatPercent(memory?.usedPercent))}</strong>
        ${renderMetricBar(memory?.usedPercent, "is-memory")}
        <em>${escapeHtml(memory ? `${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)}` : "not available")}</em>
      </article>
      <article class="system-summary-card">
        <span class="system-summary-label">${renderIcon(Gpu)} GPU</span>
        <strong>${escapeHtml(String(gpuCount))}</strong>
        <em>${escapeHtml(gpuCount === 1 ? "device found" : "devices found")}</em>
      </article>
      <article class="system-summary-card">
        <span class="system-summary-label">${renderIcon(Zap)} Accelerators</span>
        <strong>${escapeHtml(String(acceleratorCount))}</strong>
        <em>${escapeHtml(acceleratorCount === 1 ? "device found" : "devices found")}</em>
      </article>
    </div>
  `;
}

function renderCpuCoreGrid(cpu) {
  const cores = Array.isArray(cpu?.cores) ? cpu.cores : [];

  if (!cores.length) {
    return `<div class="blank-state">CPU core metrics are not available</div>`;
  }

  return `
    <div class="cpu-core-grid">
      ${cores
        .map(
          (core) => `
            <article class="cpu-core-card">
              <span>${escapeHtml(core.label || `CPU ${Number(core.id || 0) + 1}`)}</span>
              <strong>${escapeHtml(formatPercent(core.utilizationPercent))}</strong>
              ${renderMetricBar(core.utilizationPercent, "is-cpu")}
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderDeviceCard(device) {
  const utilization = device?.utilizationPercent;
  const memoryText =
    Number.isFinite(Number(device?.memoryUsedBytes)) && Number.isFinite(Number(device?.memoryTotalBytes))
      ? `${formatBytes(device.memoryUsedBytes)} of ${formatBytes(device.memoryTotalBytes)} memory`
      : "";
  const detailParts = [
    device?.source,
    Number.isFinite(Number(device?.cores)) ? `${device.cores} cores` : "",
    memoryText,
    Number.isFinite(Number(device?.temperatureC)) ? `${Math.round(device.temperatureC)}°C` : "",
    Number.isFinite(Number(device?.powerW)) ? `${Math.round(device.powerW)} W` : "",
    device?.architecture,
    device?.details,
  ].filter(Boolean);

  return `
    <article class="system-device-card">
      <div class="system-device-head">
        <strong>${escapeHtml(device?.name || "Device")}</strong>
        <span>${escapeHtml(formatPercent(utilization))}</span>
      </div>
      ${renderMetricBar(utilization, "is-device")}
      <p>${escapeHtml(detailParts.join(" · ") || "detected, but utilization is not exposed by this host")}</p>
    </article>
  `;
}

function renderDeviceSection(title, devices, emptyMessage) {
  const entries = Array.isArray(devices) ? devices : [];

  return `
    <section class="system-section">
      <div class="system-section-head">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(`${entries.length} detected`)}</span>
      </div>
      <div class="system-device-grid">
        ${entries.length ? entries.map((device) => renderDeviceCard(device)).join("") : `<div class="blank-state">${escapeHtml(emptyMessage)}</div>`}
      </div>
    </section>
  `;
}

function renderAgentUsageWindow(window) {
  const usedPercent = getMetricPercent(window?.usedPercent);
  const runCount = Number(window?.runCount || 0);
  const activeRunCount = Number(window?.activeRunCount || 0);
  const sessionCount = Number(window?.sessionCount || 0);
  const targetText = formatDurationMs(window?.targetRunMs);
  const usedText = formatDurationMs(window?.totalRunMs);
  const detailParts = runCount
    ? [
        `${usedText} observed`,
        activeRunCount ? `${activeRunCount} active` : "",
        `${runCount} ${runCount === 1 ? "activity" : "activities"}`,
        sessionCount ? `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}` : "",
        `${formatCompactPercent(usedPercent)} of ${targetText} local reference`,
      ].filter(Boolean)
    : [`no completed runs in this window`, `${targetText} local reference`];

  return `
    <div class="agent-usage-window">
      <div class="agent-usage-window-head">
        <span>${escapeHtml(window?.label || "Local usage")}</span>
        <strong>${escapeHtml(`${formatCompactPercent(usedPercent)} observed`)}</strong>
      </div>
      ${renderMetricBar(usedPercent, "is-agent-usage")}
      <p>${escapeHtml(detailParts.join(" · "))}</p>
    </div>
  `;
}

function renderAgentUsageSection(system) {
  const usage = system?.agentUsage;
  const providers = Array.isArray(usage?.providers) ? usage.providers : [];

  if (!providers.length) {
    return "";
  }

  return `
    <section class="system-section system-agent-usage-section">
      <div class="system-section-head">
        <strong>Agent usage</strong>
        <span>${escapeHtml(usage.sourceLabel || "Local activity only")}</span>
      </div>
      <div class="agent-usage-note">${escapeHtml(
        usage.quotaReason || "Not account quota; these bars only show activity observed by Remote Vibes.",
      )}</div>
      <div class="system-agent-usage-grid">
        ${providers
          .map((provider) => {
            const runningText = provider.workingSessionCount
              ? `${provider.workingSessionCount} working`
              : provider.runningSessionCount
                ? `${provider.runningSessionCount} live`
                : provider.sessionCount
                  ? `${provider.sessionCount} sessions`
                  : provider.available
                    ? "available"
                    : "missing";

            return `
              <article class="agent-usage-card">
                <div class="agent-usage-card-head">
                  <div>
                    <strong>${escapeHtml(provider.label || provider.id || "Agent")}</strong>
                    <span>${escapeHtml(runningText)}</span>
                  </div>
                  <em>${escapeHtml(provider.quotaAvailable ? "quota" : "not quota")}</em>
                </div>
                <div class="agent-usage-window-list">
                  ${(Array.isArray(provider.windows) ? provider.windows : []).map(renderAgentUsageWindow).join("")}
                </div>
              </article>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderSystemWarnings(system) {
  const warnings = Array.isArray(system?.warnings) ? system.warnings.filter(Boolean) : [];

  if (!warnings.length) {
    return "";
  }

  return `
    <div class="system-warning-list">
      ${warnings.map((warning) => `<span>${escapeHtml(warning)}</span>`).join("")}
    </div>
  `;
}

function renderSystemView() {
  const system = state.systemMetrics;
  const updatedAge = system?.checkedAt ? relativeTime(system.checkedAt) : "";
  const updated = updatedAge ? (updatedAge === "live" ? "updated just now" : `updated ${updatedAge} ago`) : "waiting for first sample";
  const refreshLabel = state.systemMetricsLoading ? "Sampling system metrics" : "Refresh system";

  return `
    <section class="dashboard-panel main-view system-view" ${renderMainViewAttributes(
      "system",
      `system:${state.systemHistoryRange || "1h"}`,
    )}>
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>${renderIcon(Menu)}</button>
        <div class="dashboard-copy">
          <strong>System</strong>
          <div class="terminal-meta">storage, CPU cores, GPUs, and accelerators on this machine</div>
        </div>
        <div class="dashboard-actions">
          <button class="icon-button toolbar-control refresh-icon-button ${state.systemMetricsLoading ? "is-loading" : ""}" type="button" id="refresh-system" aria-label="${escapeHtml(refreshLabel)}" ${tooltipAttributes(refreshLabel)} ${state.systemMetricsLoading ? "disabled" : ""}>${renderIcon(RefreshCw)}</button>
        </div>
      </div>
      <div class="dashboard-range">
        <span class="dashboard-range-label">${escapeHtml(system?.hostname || "host")}</span>
        <span>${escapeHtml(system ? `${system.platform || "unknown"} · uptime ${formatUptime(system.uptimeSeconds)}` : "sampling system metrics")}</span>
        <span class="dashboard-updated">${escapeHtml(updated)}</span>
      </div>
      <div class="system-dashboard">
        ${
          state.systemMetricsError
            ? `<div class="system-error-card">${escapeHtml(state.systemMetricsError)}</div>`
            : ""
        }
        ${renderSystemStorageCard(system)}
        ${renderSystemSummaryCards(system)}
        ${renderAgentUsageSection(system)}
        ${renderSystemUtilizationCharts(system)}
        <section class="system-section">
          <div class="system-section-head">
            <strong>CPU cores</strong>
            <span>${escapeHtml(system?.cpu?.model || "")}</span>
          </div>
          ${renderCpuCoreGrid(system?.cpu)}
        </section>
        ${renderDeviceSection("GPUs", system?.gpus, "No GPU utilization source was found on this host.")}
        ${renderDeviceSection("Accelerators", system?.accelerators, "No accelerator inventory was exposed by this host.")}
        ${renderSystemWarnings(system)}
      </div>
    </section>
  `;
}

function truncateSwarmLabel(value, maxLength = 26) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

function getSwarmNodeTypeOrder(type) {
  if (type === "repo" || type === "folder") {
    return 0;
  }
  if (type === "worktree") {
    return 1;
  }
  if (type === "session") {
    return 2;
  }
  if (type === "subagent" || type === "subagent-summary") {
    return 3;
  }
  return 4;
}

function getSwarmNodeSize(type) {
  if (type === "path-bucket" || type === "path-summary") {
    return { width: 226, height: 58 };
  }
  if (type === "path") {
    return { width: 206, height: 50 };
  }
  if (type === "subagent" || type === "subagent-summary") {
    return { width: 248, height: 62 };
  }
  if (type === "session") {
    return { width: 224, height: 58 };
  }
  if (type === "worktree") {
    return { width: 204, height: 54 };
  }
  return { width: 196, height: 54 };
}

function getSwarmNodeColumnX(order) {
  return [48, 286, 536, 824, 1116][order] ?? 1116;
}

function normalizeSwarmPath(value) {
  return String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
}

function isAbsoluteSwarmPath(value) {
  return /^\/|^[a-z]:\//i.test(normalizeSwarmPath(value));
}

function isSwarmPathInside(child, parent) {
  const normalizedChild = normalizeSwarmPath(child);
  const normalizedParent = normalizeSwarmPath(parent);
  return (
    Boolean(normalizedChild && normalizedParent) &&
    (normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`))
  );
}

function getSwarmRelativePath(child, parent) {
  const normalizedChild = normalizeSwarmPath(child);
  const normalizedParent = normalizeSwarmPath(parent);
  if (!isSwarmPathInside(normalizedChild, normalizedParent)) {
    return normalizedChild;
  }
  return normalizedChild.slice(normalizedParent.length).replace(/^\/+/, "") || ".";
}

function getSwarmPathBucketFallback(pathValue) {
  const normalized = normalizeSwarmPath(pathValue);
  const parts = normalized.split("/").filter(Boolean);

  if (!normalized || normalized === ".") {
    return { key: "paths:unknown", label: "unknown files", meta: "paths", sample: "" };
  }

  if (!isAbsoluteSwarmPath(normalized)) {
    const [first] = parts;
    return {
      key: `relative:${first || "repo"}`,
      label: first ? `${first}/` : "repo files",
      meta: "relative paths",
      sample: normalized,
    };
  }

  const macBrainIndex = parts.indexOf("mac-brain");
  if (macBrainIndex >= 0) {
    return {
      key: "absolute:mac-brain",
      label: "mac-brain",
      meta: "knowledge base",
      sample: parts.slice(macBrainIndex + 1).join("/") || ".",
    };
  }

  if (parts[0] === "tmp" || parts[0] === "var") {
    return {
      key: `absolute:${parts[0]}`,
      label: `/${parts[0]}`,
      meta: "system paths",
      sample: parts.slice(1).join("/") || ".",
    };
  }

  if (parts[0] === "Users" && parts.length >= 3) {
    const labelParts = parts.slice(2, Math.min(parts.length, 5));
    return {
      key: `absolute:user:${labelParts.join("/") || parts[1]}`,
      label: `~/${labelParts.join("/") || parts[1]}`,
      meta: "user paths",
      sample: parts.slice(Math.min(parts.length, 5)).join("/") || ".",
    };
  }

  return {
    key: `absolute:${parts.slice(0, 3).join("/")}`,
    label: `/${parts.slice(0, Math.min(parts.length, 3)).join("/")}`,
    meta: "absolute paths",
    sample: parts.slice(3).join("/") || ".",
  };
}

function getSwarmPathBucket(pathNode, graph) {
  const rawPath = normalizeSwarmPath(pathNode?.path || pathNode?.label || "");
  const gitRoot = normalizeSwarmPath(graph?.git?.root || "");
  const cwd = normalizeSwarmPath(graph?.cwd || "");
  const roots = [];

  for (const worktree of graph?.git?.worktrees || []) {
    if (worktree?.path) {
      roots.push({
        key: `worktree:${normalizeSwarmPath(worktree.path)}`,
        path: worktree.path,
        label: worktree.name || getWorkspacePathLeafName(worktree.path),
        meta: worktree.branch ? `${worktree.branch} worktree` : "git worktree",
      });
    }
  }

  if (gitRoot) {
    roots.push({
      key: `repo:${gitRoot}`,
      path: gitRoot,
      label: getWorkspacePathLeafName(gitRoot),
      meta: "repo files",
    });
  }

  if (cwd) {
    roots.push({
      key: `cwd:${cwd}`,
      path: cwd,
      label: getWorkspacePathLeafName(cwd),
      meta: "session folder",
    });
  }

  const normalizedRoots = roots
    .map((root) => ({ ...root, path: normalizeSwarmPath(root.path) }))
    .filter((root) => root.path)
    .sort((left, right) => right.path.length - left.path.length);

  if (!isAbsoluteSwarmPath(rawPath)) {
    const root = normalizedRoots[0];
    if (root) {
      return {
        key: root.key,
        label: root.label,
        meta: root.meta,
        sample: rawPath,
      };
    }
    return getSwarmPathBucketFallback(rawPath);
  }

  const matchingRoot = normalizedRoots.find((root) => isSwarmPathInside(rawPath, root.path));
  if (matchingRoot) {
    return {
      key: matchingRoot.key,
      label: matchingRoot.label,
      meta: matchingRoot.meta,
      sample: getSwarmRelativePath(rawPath, matchingRoot.path),
    };
  }

  return getSwarmPathBucketFallback(rawPath);
}

function collectSwarmPathBuckets(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const pathNodes = nodes.filter((node) => node.type === "path");
  const buckets = new Map();

  for (const pathNode of pathNodes) {
    const bucketInfo = getSwarmPathBucket(pathNode, graph);
    const bucket = buckets.get(bucketInfo.key) || {
      id: `path-bucket:${bucketInfo.key}`,
      type: "path-bucket",
      key: bucketInfo.key,
      label: bucketInfo.label,
      meta: bucketInfo.meta,
      status: "path",
      count: 0,
      samples: [],
      pathNodeIds: new Set(),
    };
    bucket.count += 1;
    bucket.pathNodeIds.add(pathNode.id);
    if (bucketInfo.sample && bucket.samples.length < 4 && !bucket.samples.includes(bucketInfo.sample)) {
      bucket.samples.push(bucketInfo.sample);
    }
    buckets.set(bucketInfo.key, bucket);
  }

  return [...buckets.values()].sort((left, right) => {
    const countDelta = right.count - left.count;
    if (countDelta) {
      return countDelta;
    }
    return left.label.localeCompare(right.label);
  });
}

function rankSwarmSubagentNodes(subagentNodes) {
  return [...subagentNodes].sort((left, right) => {
    const statusDelta = (right.status === "working" ? 1 : 0) - (left.status === "working" ? 1 : 0);
    if (statusDelta) {
      return statusDelta;
    }

    return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  });
}

function prepareSwarmGraphForDisplay(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const pathNodes = nodes.filter((node) => node.type === "path");
  const subagentNodes = nodes.filter((node) => node.type === "subagent");
  const visibleSubagentLimit = 8;
  const visibleSubagentNodes = rankSwarmSubagentNodes(subagentNodes).slice(0, visibleSubagentLimit);
  const visibleSubagentIds = new Set(visibleSubagentNodes.map((node) => node.id));
  const hiddenSubagentNodes = subagentNodes.filter((node) => !visibleSubagentIds.has(node.id));
  const subagentSummaryNode = hiddenSubagentNodes.length
    ? {
        id: "subagent-summary:hidden",
        type: "subagent-summary",
        label: `${hiddenSubagentNodes.length} more agents`,
        meta: "open the side panel",
        status: hiddenSubagentNodes.some((node) => node.status === "working") ? "working" : "done",
      }
    : null;
  const baseNodes = nodes.filter((node) => node.type !== "path" && node.type !== "subagent");
  const displayBaseNodes = [...baseNodes, ...visibleSubagentNodes, ...(subagentSummaryNode ? [subagentSummaryNode] : [])];
  const baseIds = new Set(baseNodes.map((node) => node.id));
  for (const node of visibleSubagentNodes) {
    baseIds.add(node.id);
  }
  if (subagentSummaryNode) {
    baseIds.add(subagentSummaryNode.id);
  }
  const subagentDisplayIds = new Map();
  for (const node of subagentNodes) {
    subagentDisplayIds.set(node.id, visibleSubagentIds.has(node.id) ? node.id : subagentSummaryNode?.id);
  }
  const pathBuckets = collectSwarmPathBuckets(graph);
  const visibleBucketLimit = 10;
  const visibleBuckets = pathBuckets.slice(0, visibleBucketLimit);
  const hiddenBuckets = pathBuckets.slice(visibleBucketLimit);
  const pathNodeToBucket = new Map();

  for (const bucket of visibleBuckets) {
    for (const pathNodeId of bucket.pathNodeIds) {
      pathNodeToBucket.set(pathNodeId, bucket.id);
    }
  }

  const hiddenPathNodeIds = new Set();
  for (const bucket of hiddenBuckets) {
    for (const pathNodeId of bucket.pathNodeIds) {
      hiddenPathNodeIds.add(pathNodeId);
    }
  }

  const bucketNodes = visibleBuckets.map((bucket) => ({
    ...bucket,
    pathNodeIds: undefined,
    label: bucket.label,
    meta: `${bucket.count} ${bucket.count === 1 ? "path" : "paths"} · ${bucket.meta}`,
    detail: bucket.samples.join(" · "),
  }));

  const hiddenPathCount = hiddenBuckets.reduce((total, bucket) => total + bucket.count, 0);
  const summaryNode =
    hiddenPathCount > 0
      ? {
          id: "path-summary:hidden",
          type: "path-summary",
          label: `${hiddenPathCount} more paths`,
          meta: `${hiddenBuckets.length} hidden folders`,
          status: "path",
        }
      : null;
  const visibleIds = new Set([...baseIds, ...bucketNodes.map((node) => node.id)]);
  if (summaryNode) {
    visibleIds.add(summaryNode.id);
  }

  const displayEdges = [];
  const edgeKeys = new Set();
  const summarySources = new Set();

  const addDisplayEdge = (edge) => {
    if (!edge?.from || !edge?.to || edge.from === edge.to) {
      return;
    }
    const key = `${edge.from}->${edge.to}:${edge.type || "link"}`;
    if (edgeKeys.has(key)) {
      return;
    }
    edgeKeys.add(key);
    displayEdges.push(edge);
  };

  for (const edge of edges) {
    if (edge?.type === "touch") {
      const sourceId = subagentDisplayIds.get(edge.from) || edge.from;
      if (!visibleIds.has(sourceId)) {
        continue;
      }

      const bucketId = pathNodeToBucket.get(edge.to);
      if (bucketId && visibleIds.has(bucketId)) {
        addDisplayEdge({ from: sourceId, to: bucketId, type: "touch" });
        continue;
      }

      if (summaryNode && hiddenPathNodeIds.has(edge.to)) {
        summarySources.add(sourceId);
      }
      continue;
    }

    const from = subagentDisplayIds.get(edge?.from) || edge?.from;
    const to = subagentDisplayIds.get(edge?.to) || edge?.to;
    if (visibleIds.has(from) && visibleIds.has(to)) {
      addDisplayEdge({ ...edge, from, to });
    }
  }

  for (const sourceId of summarySources) {
    addDisplayEdge({
      from: sourceId,
      to: summaryNode.id,
      type: "touch",
    });
  }

  return {
    nodes: [...displayBaseNodes, ...bucketNodes, ...(summaryNode ? [summaryNode] : [])],
    edges: displayEdges,
    hiddenPathCount,
    visiblePathCount: pathNodes.length - hiddenPathCount,
    originalPathCount: pathNodes.length,
    bucketCount: pathBuckets.length,
    hiddenSubagentCount: hiddenSubagentNodes.length,
  };
}

function layoutSwarmGraph(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const verticalGap = 28;
  const topPadding = 94;
  const groups = new Map();
  const originalIndexById = new Map(nodes.map((node, index) => [node.id, index]));
  const orderedIndexById = new Map();

  for (const node of nodes) {
    const order = getSwarmNodeTypeOrder(node.type);
    if (!groups.has(order)) {
      groups.set(order, []);
    }
    groups.get(order).push(node);
  }

  const getSourceRank = (node) => {
    const ranks = edges
      .filter((edge) => edge?.to === node.id)
      .map((edge) => orderedIndexById.get(edge.from))
      .filter((rank) => Number.isFinite(rank));

    if (!ranks.length) {
      return originalIndexById.get(node.id) || 0;
    }

    return ranks.reduce((total, rank) => total + rank, 0) / ranks.length;
  };

  for (const order of [0, 1, 2, 3, 4]) {
    const entries = groups.get(order);
    if (!entries) {
      continue;
    }

    entries.sort((left, right) => {
      const sourceDelta = getSourceRank(left) - getSourceRank(right);
      if (Math.abs(sourceDelta) > 0.001) {
        return sourceDelta;
      }

      if (left.type === "worktree" || right.type === "worktree") {
        const currentDelta = (right.status === "current" ? 1 : 0) - (left.status === "current" ? 1 : 0);
        if (currentDelta) {
          return currentDelta;
        }
      }

      if (left.type === "session" || right.type === "session") {
        const focusDelta = (right.focus ? 1 : 0) - (left.focus ? 1 : 0);
        if (focusDelta) {
          return focusDelta;
        }
      }

      const countDelta = Number(right.count || 0) - Number(left.count || 0);
      if (countDelta) {
        return countDelta;
      }

      return (originalIndexById.get(left.id) || 0) - (originalIndexById.get(right.id) || 0);
    });

    entries.forEach((node, index) => {
      orderedIndexById.set(node.id, index);
    });
  }

  const groupHeights = Array.from(groups.values()).map((entries) =>
    entries.reduce((total, node) => total + getSwarmNodeSize(node.type).height, 0) +
    Math.max(0, entries.length - 1) * verticalGap,
  );
  const maxGroupHeight = Math.max(1, ...groupHeights);
  const height = Math.max(520, topPadding + 48 + maxGroupHeight);
  const positions = new Map();
  const columns = [
    { order: 0, label: "Repo", detail: "root" },
    { order: 1, label: "Worktrees", detail: "checkouts" },
    { order: 2, label: "Sessions", detail: "threads" },
    { order: 3, label: "Agents", detail: "sidechains" },
    { order: 4, label: "Files", detail: "grouped paths" },
  ];

  for (const [order, entries] of groups.entries()) {
    const totalHeight =
      entries.reduce((total, node) => total + getSwarmNodeSize(node.type).height, 0) +
      Math.max(0, entries.length - 1) * verticalGap;
    const startY = topPadding;
    let y = startY;
    entries.forEach((node, index) => {
      const { width, height: nodeHeight } = getSwarmNodeSize(node.type);
      positions.set(node.id, {
        x: getSwarmNodeColumnX(order),
        y,
        width,
        height: nodeHeight,
      });
      y += nodeHeight + (index === entries.length - 1 ? 0 : verticalGap);
    });
  }

  return {
    width: 1390,
    height,
    positions,
    columns: columns.map((column) => ({
      ...column,
      x: getSwarmNodeColumnX(column.order),
      count: groups.get(column.order)?.length || 0,
    })),
  };
}

function getSwarmStackOffset(index, count, maxOffset) {
  if (count <= 1) {
    return 0;
  }

  const rawOffset = (index - (count - 1) / 2) * 5;
  return Math.max(-maxOffset, Math.min(maxOffset, rawOffset));
}

function getSwarmEdgePorts(edges, positions) {
  const outgoing = new Map();
  const incoming = new Map();

  edges.forEach((edge, index) => {
    if (!positions.has(edge.from) || !positions.has(edge.to)) {
      return;
    }

    if (!outgoing.has(edge.from)) {
      outgoing.set(edge.from, []);
    }
    if (!incoming.has(edge.to)) {
      incoming.set(edge.to, []);
    }
    outgoing.get(edge.from).push(index);
    incoming.get(edge.to).push(index);
  });

  const startOffsets = new Map();
  const endOffsets = new Map();

  for (const [nodeId, edgeIndexes] of outgoing.entries()) {
    const position = positions.get(nodeId);
    const maxOffset = Math.max(8, position.height * 0.34);
    edgeIndexes.forEach((edgeIndex, index) => {
      startOffsets.set(edgeIndex, getSwarmStackOffset(index, edgeIndexes.length, maxOffset));
    });
  }

  for (const [nodeId, edgeIndexes] of incoming.entries()) {
    const position = positions.get(nodeId);
    const maxOffset = Math.max(8, position.height * 0.34);
    edgeIndexes.forEach((edgeIndex, index) => {
      endOffsets.set(edgeIndex, getSwarmStackOffset(index, edgeIndexes.length, maxOffset));
    });
  }

  return { startOffsets, endOffsets };
}

function renderSwarmGraphSvg(graph) {
  const displayGraph = prepareSwarmGraphForDisplay(graph);
  const { nodes, edges } = displayGraph;
  if (!nodes.length) {
    return `<div class="blank-state">no graph data yet</div>`;
  }

  const layout = layoutSwarmGraph(displayGraph);
  const edgePorts = getSwarmEdgePorts(edges, layout.positions);
  const columnMarkup = layout.columns
    .filter((column) => column.count > 0)
    .map(
      (column) => `
        <g class="swarm-column-heading">
          <text class="swarm-column-label" x="${column.x}" y="34">${escapeHtml(column.label)}</text>
          <text class="swarm-column-meta" x="${column.x}" y="52">${escapeHtml(`${column.count} ${column.detail}`)}</text>
        </g>
      `,
    )
    .join("");
  const edgeMarkup = edges
    .map((edge, index) => {
      const from = layout.positions.get(edge.from);
      const to = layout.positions.get(edge.to);
      if (!from || !to) {
        return "";
      }

      const startX = from.x + from.width;
      const startY = from.y + from.height / 2 + (edgePorts.startOffsets.get(index) || 0);
      const sameColumn = to.x <= startX + 8;
      const endX = sameColumn ? to.x + to.width : to.x;
      const endY = to.y + to.height / 2 + (edgePorts.endOffsets.get(index) || 0);
      const controlDistance = sameColumn ? 58 + (index % 4) * 8 : Math.max(64, Math.round((endX - startX) * 0.42));
      const controlX1 = sameColumn ? Math.max(startX, endX) + controlDistance : startX + controlDistance;
      const controlX2 = sameColumn ? Math.max(startX, endX) + controlDistance : endX - controlDistance;
      return `<path class="swarm-edge swarm-edge-${escapeHtml(edge.type || "link")}" d="M ${startX} ${startY} C ${controlX1} ${startY}, ${controlX2} ${endY}, ${endX} ${endY}" marker-end="url(#swarm-arrow)" />`;
    })
    .join("");

  const clipMarkup = nodes
    .map((node, index) => {
      const position = layout.positions.get(node.id);
      if (!position) {
        return "";
      }

      return `<clipPath id="swarm-node-clip-${index}"><rect x="${position.x + 12}" y="${position.y + 7}" width="${Math.max(1, position.width - 24)}" height="${Math.max(1, position.height - 14)}" rx="6"></rect></clipPath>`;
    })
    .join("");

  const nodeMarkup = nodes
    .map((node, index) => {
      const position = layout.positions.get(node.id);
      if (!position) {
        return "";
      }

      const label = truncateSwarmLabel(node.label || node.id, node.type === "path" ? 23 : 22);
      const meta = truncateSwarmLabel(node.meta || node.path || "", node.type === "path-bucket" ? 31 : 25);
      const titleParts = [node.label || node.id, node.meta, node.detail || node.path].filter(Boolean);
      return `
        <g class="swarm-node swarm-node-${escapeHtml(node.type || "unknown")} ${node.focus ? "is-focus" : ""} swarm-status-${escapeHtml(node.status || "idle")}">
          <title>${escapeHtml(titleParts.join("\n"))}</title>
          <rect x="${position.x}" y="${position.y}" width="${position.width}" height="${position.height}" rx="15"></rect>
          <g clip-path="url(#swarm-node-clip-${index})">
            <text class="swarm-node-label" x="${position.x + 15}" y="${position.y + 22}">${escapeHtml(label)}</text>
            <text class="swarm-node-meta" x="${position.x + 15}" y="${position.y + 42}">${escapeHtml(meta)}</text>
          </g>
        </g>
      `;
    })
    .join("");
  const hiddenSummary =
    displayGraph.originalPathCount > 0 || displayGraph.hiddenSubagentCount > 0
      ? `<div class="swarm-graph-note">${[
          displayGraph.originalPathCount > 0
            ? `${displayGraph.originalPathCount} touched paths grouped into ${displayGraph.bucketCount} folders`
            : "",
          displayGraph.hiddenSubagentCount > 0 ? `${displayGraph.hiddenSubagentCount} more agents in the side panel` : "",
          displayGraph.hiddenPathCount > 0 ? `${displayGraph.hiddenPathCount} more paths in the side panel` : "",
        ]
          .filter(Boolean)
          .join(" · ")}</div>`
      : "";

  return `
    <div class="swarm-graph-scroller">
      <svg class="swarm-graph-svg" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="Agent swarm graph">
        <defs>
        <marker id="swarm-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z"></path>
        </marker>
          ${clipMarkup}
        </defs>
        ${columnMarkup}
        ${edgeMarkup}
        ${nodeMarkup}
      </svg>
      ${hiddenSummary}
    </div>
  `;
}

function renderSwarmSummary(graph) {
  const git = graph?.git || {};
  const sessions = Array.isArray(graph?.sessions) ? graph.sessions : [];
  const subagentCount = sessions.reduce((count, session) => count + (Array.isArray(session.subagents) ? session.subagents.length : 0), 0);
  const worktreeCount = Array.isArray(git.worktrees) ? git.worktrees.length : 0;
  const dirtyLabel = git.dirtyCount == null ? "unknown changes" : git.dirtyCount ? `${git.dirtyCount} changed` : "clean";
  const cards = [
    { label: "repo", value: git.isRepository ? getWorkspacePathLeafName(git.root) : "not git", meta: git.branch || git.head || "" },
    { label: "worktrees", value: String(worktreeCount), meta: git.isRepository ? dirtyLabel : "folder only" },
    { label: "sessions", value: String(sessions.length), meta: "related threads" },
    { label: "subagents", value: String(subagentCount), meta: "Claude sidechains" },
  ];

  return `
    <div class="swarm-summary-grid">
      ${cards
        .map(
          (card) => `
            <div class="swarm-summary-card">
              <span>${escapeHtml(card.label)}</span>
              <strong>${escapeHtml(card.value)}</strong>
              <em>${escapeHtml(card.meta)}</em>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderSwarmDetails(graph) {
  const sessions = Array.isArray(graph?.sessions) ? graph.sessions : [];
  const pathBuckets = collectSwarmPathBuckets(graph);
  const subagents = sessions.flatMap((session) =>
    (Array.isArray(session.subagents) ? session.subagents : []).map((subagent) => ({
      ...subagent,
      sessionName: session.name,
    })),
  );

  if (!subagents.length) {
    return `
      <aside class="swarm-details">
        <strong>Agents and files</strong>
        <div class="blank-state">No Claude subagent transcripts were found for this session yet.</div>
      </aside>
    `;
  }

  return `
    <aside class="swarm-details">
      <strong>Agents and files</strong>
      ${
        pathBuckets.length
          ? `
            <div class="swarm-detail-section">
              <span>Grouped touched folders</span>
              <div class="swarm-path-group-list">
                ${pathBuckets
                  .slice(0, 8)
                  .map(
                    (bucket) => `
                      <article class="swarm-path-group-card">
                        <div>
                          <strong>${escapeHtml(bucket.label)}</strong>
                          <em>${escapeHtml(`${bucket.count} ${bucket.count === 1 ? "path" : "paths"} · ${bucket.meta}`)}</em>
                        </div>
                        ${
                          bucket.samples.length
                            ? `<div class="swarm-pill-row">${bucket.samples.slice(0, 3).map((entry) => `<span>${escapeHtml(truncateSwarmLabel(entry, 34))}</span>`).join("")}</div>`
                            : ""
                        }
                      </article>
                    `,
                  )
                  .join("")}
              </div>
            </div>
          `
          : ""
      }
      <div class="swarm-detail-section">
        <span>Claude subagents</span>
      <div class="swarm-subagent-list">
        ${subagents
          .map((subagent) => {
            const paths = Array.isArray(subagent.paths) ? subagent.paths : [];
            const commands = Array.isArray(subagent.commands) ? subagent.commands : [];
            return `
              <article class="swarm-subagent-card swarm-status-${escapeHtml(subagent.status || "done")}">
                <div>
                  <span class="swarm-subagent-name">${escapeHtml(subagent.name || "Claude subagent")}</span>
                  <span class="swarm-subagent-meta">${escapeHtml([subagent.sessionName, subagent.agentType, subagent.status].filter(Boolean).join(" · "))}</span>
                </div>
                ${
                  paths.length
                    ? `<div class="swarm-pill-row">${paths.slice(0, 4).map((entry) => `<span>${escapeHtml(truncateSwarmLabel(entry, 28))}</span>`).join("")}</div>`
                    : commands.length
                      ? `<div class="swarm-command-preview">${escapeHtml(truncateSwarmLabel(commands[0], 60))}</div>`
                      : `<div class="swarm-command-preview">no file paths recorded</div>`
                }
              </article>
            `;
          })
          .join("")}
      </div>
      </div>
    </aside>
  `;
}

function renderSwarmGraphView() {
  const graph = state.swarmGraph.data;
  const selectedSession = state.sessions.find((session) => session.id === state.swarmGraph.sessionId) || null;
  const title =
    state.swarmGraph.projectName
    || (graph?.git?.root ? getWorkspacePathLeafName(graph.git.root) : "")
    || selectedSession?.name
    || graph?.sessions?.[0]?.name
    || "Swarm graph";
  const refreshLabel = state.swarmGraph.loading ? "Mapping swarm graph" : "Refresh swarm graph";
  const meta = graph
    ? `${graph.git?.isRepository ? "git" : "folder"} · ${graph.cwd || selectedSession?.cwd || state.defaultCwd}`
    : selectedSession
      ? `${selectedSession.providerLabel} · ${selectedSession.cwd}`
      : state.swarmGraph.projectCwd
        ? `project folder · ${state.swarmGraph.projectCwd}`
        : "choose a project folder to inspect its repo graph";
  const canRefreshSwarm = Boolean(state.swarmGraph.projectCwd || state.swarmGraph.sessionId);

  return `
    <section class="dashboard-panel main-view swarm-view" ${renderMainViewAttributes(
      "swarm",
      `swarm:${state.swarmGraph.projectCwd || state.swarmGraph.sessionId || ""}`,
    )}>
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>${renderIcon(Menu)}</button>
        <div class="dashboard-copy">
          <strong>${escapeHtml(title)}</strong>
          <div class="terminal-meta">swarm graph · ${escapeHtml(meta)}</div>
        </div>
        <div class="dashboard-actions">
          <button class="ghost-button toolbar-control" type="button" id="swarm-back-to-session">terminal</button>
          <button class="icon-button toolbar-control refresh-icon-button ${state.swarmGraph.loading ? "is-loading" : ""}" type="button" id="refresh-swarm-graph" aria-label="${escapeHtml(refreshLabel)}" ${tooltipAttributes(refreshLabel)} ${state.swarmGraph.loading || !canRefreshSwarm ? "disabled" : ""}>${renderIcon(RefreshCw)}</button>
        </div>
      </div>
      ${
        state.swarmGraph.error
          ? `<div class="system-error-card">${escapeHtml(state.swarmGraph.error)}</div>`
          : ""
      }
      ${
        state.swarmGraph.loading && !graph
          ? `<div class="blank-state">mapping sessions, git worktrees, and Claude sidechains...</div>`
          : graph
            ? `
              ${renderSwarmSummary(graph)}
              <div class="swarm-layout">
                <div class="swarm-canvas">${renderSwarmGraphSvg(graph)}</div>
                ${renderSwarmDetails(graph)}
              </div>
            `
            : `<div class="blank-state">hover a project folder and click the repo graph icon to map it.</div>`
      }
    </section>
  `;
}

function getBrowserUseViewTitle(session) {
  return session?.name || "Browser task";
}

function getBrowserUseViewMeta(session) {
  if (!session) {
    return "browser fulfillment session";
  }

  const latestUrl = session.latestUrl || session.latestSnapshot?.tabs?.find((tab) => tab.active)?.url || "";
  return [session.status, latestUrl || session.taskPrompt].filter(Boolean).join(" · ");
}

function formatBrowserUseActivityType(type) {
  return String(type || "event")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderBrowserUseCompactJson(value) {
  if (!value || typeof value !== "object" || Object.keys(value).length === 0) {
    return "";
  }

  return `<pre class="browser-use-event-json">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function renderBrowserUseActivityDetail(event) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const type = String(event?.type || "");

  if (type === "assistant_message") {
    const text = String(payload.text || "").trim();
    if (text) {
      return `<p>${escapeHtml(text)}</p>`;
    }
    return payload.toolCount
      ? `<p>chose ${escapeHtml(payload.toolCount)} tool call${Number(payload.toolCount) === 1 ? "" : "s"}.</p>`
      : "";
  }

  if (type === "tool_started") {
    return renderBrowserUseCompactJson(payload.input);
  }

  if (type === "tool_completed") {
    const preview = String(payload.outputPreview || "").trim();
    return preview ? `<p>${escapeHtml(preview)}</p>` : "";
  }

  if (type === "requester_message_received") {
    return payload.message ? `<p>${escapeHtml(payload.message)}</p>` : "";
  }

  if (type === "model_retry" || type === "page_context_injection_failed") {
    return payload.message || payload.error ? `<p>${escapeHtml(payload.message || payload.error)}</p>` : "";
  }

  const compactPayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !["tool", "toolUseId", "loop", "tabCount", "status"].includes(key)),
  );
  return renderBrowserUseCompactJson(compactPayload);
}

function getBrowserUseActivitySummary(event) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const type = String(event?.type || "event");
  const loop = payload.loop ? `loop ${payload.loop}` : "";

  if (type === "loop_started") {
    return `${loop || "loop"} started${payload.tabCount ? ` · ${payload.tabCount} tab${Number(payload.tabCount) === 1 ? "" : "s"}` : ""}`;
  }
  if (type === "assistant_message") {
    return payload.toolCount
      ? `${loop || "agent"} planned ${payload.toolCount} tool call${Number(payload.toolCount) === 1 ? "" : "s"}`
      : `${loop || "agent"} replied`;
  }
  if (type === "tool_started") {
    return `${payload.tool || "tool"} started`;
  }
  if (type === "tool_completed") {
    return `${payload.tool || "tool"} completed`;
  }
  if (type === "model_usage") {
    const input = Number(payload.input_tokens || 0);
    const output = Number(payload.output_tokens || 0);
    const total = input + output;
    return `${payload.source || "model"} · ${Number.isFinite(total) ? `${total} tokens` : "usage"}`;
  }
  if (type === "model_retry") {
    return `model retry ${payload.attempt || ""}`.trim();
  }
  if (type === "requester_message_received") {
    return "requester message received";
  }
  if (type === "task_completed") {
    return "task completed";
  }
  if (type === "task_failed") {
    return "task failed";
  }

  return formatBrowserUseActivityType(type);
}

function renderBrowserUseProcess(session) {
  const activity = Array.isArray(session?.activity) ? session.activity.slice(-80) : [];
  if (activity.length === 0) {
    return `<div class="browser-use-empty-inline">waiting for process events...</div>`;
  }

  return `
    <ol class="browser-use-activity-list">
      ${activity
        .map((event) => {
          const createdAt = event?.createdAt || "";
          const detail = renderBrowserUseActivityDetail(event);
          return `
            <li class="browser-use-activity-item">
              <div class="browser-use-activity-meta">
                <span class="browser-use-activity-type">${escapeHtml(getBrowserUseActivitySummary(event))}</span>
                ${createdAt ? `<time>${escapeHtml(relativeTime(createdAt))}</time>` : ""}
              </div>
              ${detail ? `<div class="browser-use-activity-detail">${detail}</div>` : ""}
            </li>
          `;
        })
        .join("")}
    </ol>
  `;
}

function renderBrowserUseTranscriptBlock(block) {
  if (!block || typeof block !== "object") {
    return `<p>${escapeHtml(block || "")}</p>`;
  }

  if (block.type === "text") {
    const text = String(block.text || "").trim();
    return text ? `<p>${escapeHtml(text)}</p>` : "";
  }

  if (block.type === "tool_use") {
    return `
      <div class="browser-use-tool-call">
        <span>${escapeHtml(block.name || "tool")}</span>
        ${renderBrowserUseCompactJson(block.input)}
      </div>
    `;
  }

  if (block.type === "tool_result") {
    const content = Array.isArray(block.content)
      ? block.content.map(renderBrowserUseTranscriptBlock).join("")
      : renderBrowserUseTranscriptBlock(block.content);
    return `
      <div class="browser-use-tool-result">
        <span>tool result${block.tool_use_id ? ` · ${escapeHtml(block.tool_use_id)}` : ""}</span>
        ${content || `<p>completed</p>`}
      </div>
    `;
  }

  if (block.type === "image") {
    return `<p class="browser-use-muted">[image omitted]</p>`;
  }

  return renderBrowserUseCompactJson(block);
}

function renderBrowserUseTranscript(session) {
  const transcript = Array.isArray(session?.transcript) ? session.transcript : [];
  if (transcript.length === 0) {
    const message = ["queued", "running"].includes(session?.status)
      ? "final transcript will appear after completion."
      : "no transcript was captured.";
    return `<div class="browser-use-empty-inline">${escapeHtml(message)}</div>`;
  }

  return `
    <div class="browser-use-transcript-list">
      ${transcript
        .map((message) => {
          const blocks = Array.isArray(message?.content) ? message.content : [];
          const isToolResult = blocks.length > 0 && blocks.every((block) => block?.type === "tool_result");
          const role = isToolResult ? "tool" : String(message?.role || "message");
          const label = role === "assistant" ? "agent" : role;
          return `
            <article class="browser-use-message browser-use-message-${escapeHtml(role)}">
              <span class="browser-use-message-role">${escapeHtml(label)}</span>
              <div class="browser-use-message-content">
                ${blocks.map(renderBrowserUseTranscriptBlock).join("") || `<p class="browser-use-muted">empty message</p>`}
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderBrowserUseResult(session) {
  if (!session) {
    return "";
  }

  const result = session.result && typeof session.result === "object" ? session.result : null;
  const summary =
    (result && typeof result.summary === "string" && result.summary.trim()) ||
    session.error ||
    "";
  const charges = result?.charges && typeof result.charges === "object" ? result.charges : null;
  const chargeText = charges
    ? `${Number(charges.goods_cents || 0) + Number(charges.shipping_cents || 0) + Number(charges.tax_cents || 0) + Number(charges.other_cents || 0)} cents ${charges.currency || ""}`.trim()
    : "";
  const workerLog = [session.stderr, session.stdout]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(-4_000);

  return `
    <aside class="browser-use-details">
      <section class="browser-use-detail-section">
        <div class="browser-use-section-heading">Result</div>
        ${summary ? `<p>${escapeHtml(summary)}</p>` : `<p>No final result yet.</p>`}
        <div class="browser-use-facts">
          <span>${escapeHtml(session.status || "queued")}</span>
          ${result?.merchant ? `<span>${escapeHtml(result.merchant)}</span>` : ""}
          ${chargeText ? `<span>${escapeHtml(chargeText)}</span>` : ""}
        </div>
        ${
          result
            ? `<pre class="browser-use-json">${escapeHtml(JSON.stringify(result, null, 2))}</pre>`
            : ""
        }
      </section>
      <section class="browser-use-detail-section">
        <div class="browser-use-section-heading">Process</div>
        ${renderBrowserUseProcess(session)}
      </section>
      <section class="browser-use-detail-section">
        <div class="browser-use-section-heading">Chat / Tool Calls</div>
        ${renderBrowserUseTranscript(session)}
      </section>
      ${
        workerLog
          ? `<details class="browser-use-log"><summary>worker log</summary><pre>${escapeHtml(workerLog)}</pre></details>`
          : ""
      }
    </aside>
  `;
}

function renderBrowserUseSnapshot(session) {
  const snapshot = session?.latestSnapshot;
  const imageBase64 = snapshot?.imageBase64 || "";
  const activeTab = snapshot?.tabs?.find((tab) => tab.active) || snapshot?.tabs?.[0] || null;

  if (!imageBase64) {
    return `
      <div class="browser-use-snapshot browser-use-snapshot-empty">
        <div class="blank-state">waiting for the first browser snapshot...</div>
      </div>
    `;
  }

  return `
    <div class="browser-use-snapshot">
      <div class="browser-use-snapshot-bar">
        <span>${escapeHtml(activeTab?.title || "browser")}</span>
        <em>${escapeHtml(activeTab?.url || "")}</em>
      </div>
      <img
        class="browser-use-image"
        src="data:image/png;base64,${escapeHtml(imageBase64)}"
        alt="Browser-use session snapshot"
      />
    </div>
  `;
}

function renderBrowserUseView() {
  const session = state.browserUseSession.data;
  const refreshLabel = state.browserUseSession.loading ? "Refreshing browser task" : "Refresh browser task";
  const deleteLabel = session && ["queued", "running"].includes(session.status)
    ? "Terminate browser task"
    : "Delete browser task";

  return `
    <section class="dashboard-panel main-view browser-use-view" ${renderMainViewAttributes(
      "browser-use",
      `browser-use:${state.browserUseSession.id || ""}`,
    )}>
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>${renderIcon(Menu)}</button>
        <div class="dashboard-copy">
          <strong>${escapeHtml(getBrowserUseViewTitle(session))}</strong>
          <div class="terminal-meta">${escapeHtml(getBrowserUseViewMeta(session))}</div>
        </div>
        <div class="dashboard-actions">
          <button class="ghost-button toolbar-control" type="button" id="browser-use-back-to-session">terminal</button>
          <button class="icon-button toolbar-control danger-icon-button" type="button" id="delete-browser-use-session" aria-label="${escapeHtml(deleteLabel)}" ${tooltipAttributes(deleteLabel)} ${state.browserUseSession.loading || !state.browserUseSession.id ? "disabled" : ""}>${renderIcon(Trash2)}</button>
          <button class="icon-button toolbar-control refresh-icon-button ${state.browserUseSession.loading ? "is-loading" : ""}" type="button" id="refresh-browser-use-session" aria-label="${escapeHtml(refreshLabel)}" ${tooltipAttributes(refreshLabel)} ${state.browserUseSession.loading || !state.browserUseSession.id ? "disabled" : ""}>${renderIcon(RefreshCw)}</button>
        </div>
      </div>
      ${
        state.browserUseSession.error
          ? `<div class="system-error-card">${escapeHtml(state.browserUseSession.error)}</div>`
          : ""
      }
      ${
        state.browserUseSession.loading && !session
          ? `<div class="blank-state">loading browser session...</div>`
          : session
            ? `
              <div class="browser-use-layout">
                ${renderBrowserUseSnapshot(session)}
                ${renderBrowserUseResult(session)}
              </div>
            `
            : `<div class="blank-state">choose a browser-use child session from the sidebar.</div>`
      }
    </section>
  `;
}

function formatUptime(seconds) {
  const totalSeconds = Math.max(0, Number(seconds || 0));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

function renderTerminalPanel(activeSession) {
  if (state.currentView === "knowledge-base") {
    return renderKnowledgeBaseView();
  }

  if (state.currentView === "agent-prompt") {
    return renderAgentPromptView();
  }

  if (state.currentView === "search") {
    return renderSearchView();
  }

  if (state.currentView === "plugins") {
    return renderPluginsView();
  }

  if (state.currentView === "automations") {
    return renderAutomationsView();
  }

  if (state.currentView === "system") {
    return renderSystemView();
  }

  if (state.currentView === "swarm") {
    return renderSwarmGraphView();
  }

  if (state.currentView === "browser-use") {
    return renderBrowserUseView();
  }

  return `
    <section class="terminal-panel" ${renderMainViewAttributes("shell", `shell:${activeSession?.id || ""}`)}>
      <div class="terminal-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>${renderIcon(Menu)}</button>
        <div class="terminal-copy">
          <strong id="toolbar-title">${escapeHtml(activeSession ? activeSession.name : "new session")}</strong>
          <div class="terminal-meta" id="toolbar-meta">${escapeHtml(
            activeSession ? `${activeSession.providerLabel} · ${activeSession.cwd}` : state.defaultCwd,
          )}</div>
        </div>
        <div class="toolbar-actions">
          <button class="icon-button" type="button" id="refresh-sessions" aria-label="Refresh sessions" ${tooltipAttributes("Refresh sessions")}>${renderIcon(RefreshCw)}</button>
          <button class="ghost-button toolbar-control terminal-control-button" type="button" id="tab-button" data-terminal-control aria-label="Send Tab" ${tooltipAttributes("Send Tab")} ${activeSession ? "" : "disabled"}>${renderIcon(IndentIncrease)}</button>
          <button class="ghost-button toolbar-control terminal-control-button" type="button" id="shift-tab-button" data-terminal-control aria-label="Send Shift Tab" ${tooltipAttributes("Send Shift Tab")} ${activeSession ? "" : "disabled"}>${renderIcon(IndentDecrease)}</button>
          <button class="ghost-button toolbar-control terminal-control-button" type="button" id="ctrl-p-button" data-terminal-control aria-label="Send Control P" ${tooltipAttributes("Send Control P")} ${activeSession ? "" : "disabled"}>${renderIcon(ArrowUp)}</button>
          <button class="ghost-button toolbar-control terminal-control-button" type="button" id="ctrl-t-button" data-terminal-control aria-label="Send Control T" ${tooltipAttributes("Send Control T")} ${activeSession ? "" : "disabled"}>${renderIcon(Type)}</button>
          <button class="ghost-button toolbar-control terminal-control-button" type="button" id="ctrl-c-button" data-terminal-control aria-label="Send Control C" ${tooltipAttributes("Send Control C")} ${activeSession ? "" : "disabled"}>${renderIcon(CircleStop)}</button>
        </div>
      </div>

      <div class="workspace-split ${state.openFileTabs.length ? "has-file-preview" : ""}" id="workspace-split" style="${renderWorkspaceSplitStyle()}">
        <div class="terminal-stack">
          <div class="terminal-mount" id="terminal-mount"></div>
          <div class="terminal-transcript-scroll" id="terminal-transcript-scroll" tabindex="0" aria-label="Terminal transcript history">
            <pre class="terminal-transcript-pre" id="terminal-transcript-pre"></pre>
          </div>
          <button class="jump-bottom-button ${activeSession && state.terminalShowJumpToBottom ? "is-visible" : ""}" type="button" id="jump-to-bottom" aria-label="Jump to bottom" ${tooltipAttributes("Jump to bottom")} ${activeSession ? "" : "disabled"}>
            bottom
          </button>
          <div class="empty-state ${activeSession ? "hidden" : ""}" id="empty-state">
            <p class="empty-state-copy">open the menu, choose a CLI, then pick or create a folder to start a session</p>
          </div>
        </div>
        ${renderWorkspaceResizeHandle()}
        ${renderFilePreviewPane()}
      </div>
    </section>
  `;
}

function renderAgentPromptTargets() {
  if (!state.agentPromptTargets.length) {
    return `<div class="blank-state">no managed files yet</div>`;
  }

  return state.agentPromptTargets
    .map(
      (target) => `
        <div class="prompt-target prompt-target-${escapeHtml(target.status)}">
          <span>${escapeHtml(target.label)}</span>
          <span>${escapeHtml(target.status)}</span>
        </div>
      `,
    )
    .join("");
}

function getAgentPromptTargetSummary() {
  if (!state.agentPromptTargets.length) {
    return "no managed files";
  }

  const conflictCount = state.agentPromptTargets.filter((target) => target.status === "conflict").length;
  if (conflictCount > 0) {
    return `${conflictCount} conflict${conflictCount === 1 ? "" : "s"}`;
  }

  const syncedCount = state.agentPromptTargets.filter((target) => target.status === "synced").length;
  if (syncedCount === state.agentPromptTargets.length) {
    return `${syncedCount} synced`;
  }

  return `${state.agentPromptTargets.length} managed`;
}

function renderAgentPromptView() {
  return `
    <section class="dashboard-panel agent-prompt-view" ${renderMainViewAttributes("agent-prompt")}>
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>${renderIcon(Menu)}</button>
        <div class="dashboard-copy">
          <strong>Agent Prompt</strong>
          <div class="terminal-meta">shared instructions injected into Codex, Claude, Gemini, and OpenCode sessions</div>
        </div>
        <div class="dashboard-actions">
          <button class="icon-button toolbar-control refresh-icon-button" type="button" id="refresh-agent-prompt" aria-label="Reload agent prompt from disk" ${tooltipAttributes("Reload agent prompt from disk")}>${renderIcon(RefreshCw)}</button>
        </div>
      </div>
      <div class="dashboard-range agent-prompt-summary">
        <span class="dashboard-range-label">source</span>
        <span class="agent-prompt-source">${escapeHtml(state.agentPromptPath || ".remote-vibes/agent-prompt.md")}</span>
        <span class="dashboard-updated">${escapeHtml(getAgentPromptTargetSummary())}</span>
      </div>
      <div class="agent-prompt-grid">
        <form class="agent-prompt-editor-card" id="agent-prompt-form">
          <div class="agent-prompt-card-head">
            <div>
              <strong>Prompt</strong>
              <div class="knowledge-base-panel-meta">wiki root: ${escapeHtml(state.agentPromptWikiRoot)}</div>
            </div>
            <button class="primary-button toolbar-control" type="submit">save prompt</button>
          </div>
          ${renderLineNumberEditor({
            id: "agent-prompt-textarea",
            className: "prompt-textarea agent-prompt-textarea",
            name: "prompt",
            value: state.agentPrompt,
            variant: "prompt",
            attributes: `
              spellcheck="false"
              autocapitalize="none"
              autocorrect="off"
            `,
          })}
        </form>
        <aside class="agent-prompt-target-card">
          <div class="agent-prompt-card-head">
            <div>
              <strong>Managed Files</strong>
              <div class="knowledge-base-panel-meta">where the prompt is synced for agents</div>
            </div>
          </div>
          <div class="agent-prompt-target-list" id="agent-prompt-targets">${renderAgentPromptTargets()}</div>
        </aside>
      </div>
    </section>
  `;
}

function renderFolderPickerTreeStatus(message, depth) {
  return `<div class="file-tree-status folder-picker-tree-status" style="--depth:${depth}">${escapeHtml(message)}</div>`;
}

function renderFolderPickerTreeNodes(parentPath = "", depth = 1) {
  const pathKey = normalizeFileTreePath(parentPath);
  const entries = state.folderPicker.treeEntries[pathKey] || [];

  if (state.folderPicker.treeLoading.has(pathKey) && !entries.length) {
    return renderFolderPickerTreeStatus("loading...", depth);
  }

  if (state.folderPicker.treeErrors[pathKey]) {
    return renderFolderPickerTreeStatus(state.folderPicker.treeErrors[pathKey], depth);
  }

  if (!entries.length) {
    return renderFolderPickerTreeStatus(pathKey ? "empty" : "no subfolders", depth);
  }

  return entries
    .map((entry) => {
      const entryPath = normalizeFileTreePath(entry.relativePath);
      const expanded = state.folderPicker.treeExpanded.has(entryPath);
      const selected = entryPath === state.folderPicker.path;
      const children = expanded ? renderFolderPickerTreeNodes(entryPath, depth + 1) : "";

      return `
        <div class="file-node folder-picker-node">
          <button
            class="file-row file-row-button folder-picker-tree-row ${selected ? "is-active" : ""}"
            type="button"
            data-folder-picker-select="${escapeHtml(entryPath)}"
            data-folder-picker-path="${escapeHtml(entry.path)}"
            style="--depth:${depth}"
          >
            ${renderTreeCaret(expanded)}
            ${renderDirectoryIcon(entry, expanded)}
            <span class="file-label">${escapeHtml(entry.name)}</span>
          </button>
          ${children ? `<div class="file-children" style="--depth:${depth}">${children}</div>` : ""}
        </div>
      `;
    })
    .join("");
}

function renderFolderPickerEntries() {
  if (state.folderPicker.loading && !state.folderPicker.treeEntries[""]) {
    return `<div class="blank-state">loading folders...</div>`;
  }

  if (state.folderPicker.error && !state.folderPicker.treeEntries[""]) {
    return `<div class="blank-state">${escapeHtml(state.folderPicker.error)}</div>`;
  }

  const rootPath = state.folderPicker.root || getFolderPickerCurrentPath();
  const rootSelected = !state.folderPicker.path;
  const rootExpanded = state.folderPicker.treeExpanded.has("");
  const rootChildren = rootExpanded ? renderFolderPickerTreeNodes("", 1) : "";

  return `
    <div class="file-node folder-picker-node">
      <button
        class="file-row file-row-button folder-picker-tree-row folder-picker-root-row ${rootSelected ? "is-active" : ""}"
        type="button"
        data-folder-picker-select=""
        data-folder-picker-path="${escapeHtml(rootPath)}"
        style="--depth:0"
      >
        ${renderTreeCaret(rootExpanded)}
        ${renderDirectoryIcon(rootPath, rootExpanded)}
        <span class="file-label">${escapeHtml(getWorkspacePathLeafName(rootPath))}</span>
      </button>
      ${rootChildren ? `<div class="file-children" style="--depth:0">${rootChildren}</div>` : ""}
    </div>
  `;
}

function renderFolderPickerModal() {
  if (!state.folderPicker.open) {
    return "";
  }

  const currentPath = getFolderPickerCurrentPath();
  const isSessionTarget = state.folderPicker.target === "session";
  const chooseLabel = isSessionTarget
    ? "choose folder"
    : state.folderPicker.target === "wiki-onboarding"
      ? "use this brain"
      : "choose this folder";
  const dragStyle = renderFolderPickerDragStyle();

  return `
    <div class="prompt-modal-shell" data-folder-picker-modal>
      <button class="sidebar-scrim is-open" type="button" aria-label="Close folder picker" data-close-folder-picker></button>
      <section class="prompt-modal folder-picker-modal" data-folder-picker-panel${dragStyle}>
        <div class="section-head folder-picker-drag-handle" data-folder-picker-drag-handle>
          <span>${escapeHtml(getFolderPickerTitle())}</span>
          <button class="icon-button" type="button" aria-label="Close folder picker" ${tooltipAttributes("Close folder picker")} data-close-folder-picker>${renderIcon(X)}</button>
        </div>
        <div class="folder-picker-path-row">
          <button
            class="ghost-button folder-picker-button folder-picker-up-button"
            type="button"
            id="folder-picker-up"
            aria-label="Go up one folder"
            ${tooltipAttributes("Go up one folder")}
            ${state.folderPicker.parentPath ? "" : "disabled"}
          >${renderIcon(FolderUp)}</button>
          <div class="folder-picker-path" title="${escapeHtml(currentPath)}">${escapeHtml(currentPath)}</div>
        </div>
        <div class="folder-picker-list" data-folder-picker-root="${escapeHtml(state.folderPicker.root || "")}">${renderFolderPickerEntries()}</div>
        <div class="folder-picker-footer">
          <form class="folder-create-form" id="folder-create-form">
            <input
              class="file-root-input"
              id="folder-picker-new-folder"
              name="folderName"
              type="text"
              placeholder="new folder name"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="none"
              spellcheck="false"
            />
            <button class="ghost-button folder-picker-button" type="submit">create folder</button>
          </form>
          <button class="primary-button folder-picker-button folder-picker-choose-button" type="button" id="folder-picker-select" ${currentPath ? "" : "disabled"}>${escapeHtml(chooseLabel)}</button>
        </div>
      </section>
    </div>
  `;
}

function renderMainViewAttributes(view, key = view) {
  return `data-main-view="${escapeHtml(view)}" data-main-scroll-key="${escapeHtml(key || view)}"`;
}

function captureScrollSnapshot(selector) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  return {
    left: element.scrollLeft,
    top: element.scrollTop,
  };
}

function restoreScrollSnapshot(selector, snapshot) {
  if (!snapshot) {
    return;
  }

  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    return;
  }

  element.scrollLeft = snapshot.left;
  element.scrollTop = snapshot.top;
}

const MAIN_VIEW_SCROLL_TARGETS = [
  ["mainRoot", "[data-main-view]"],
  ["dashboardGrid", ".dashboard-grid"],
  ["searchResults", "#global-search-results"],
  ["pluginsLayout", ".plugins-layout"],
  ["automationGrid", ".automation-grid"],
  ["systemDashboard", ".system-dashboard"],
  ["knowledgeBaseGrid", ".knowledge-base-grid"],
  ["knowledgeBaseNotes", ".knowledge-base-note-list"],
  ["knowledgeBaseNote", ".knowledge-base-note-card"],
  ["knowledgeBaseEditor", "#knowledge-base-note-editor"],
  ["agentPromptGrid", ".agent-prompt-grid"],
  ["agentPromptTargets", "#agent-prompt-targets"],
  ["agentPromptEditor", "#agent-prompt-textarea"],
  ["swarmGraph", ".swarm-graph-scroller"],
  ["swarmDetails", ".swarm-details"],
];

function captureMainViewScrollSnapshots() {
  const mainView = document.querySelector("[data-main-view]");
  const snapshots = {};

  for (const [key, selector] of MAIN_VIEW_SCROLL_TARGETS) {
    snapshots[key] = captureScrollSnapshot(selector);
  }

  return {
    key: mainView instanceof HTMLElement ? mainView.dataset.mainScrollKey || "" : "",
    view: mainView instanceof HTMLElement ? mainView.dataset.mainView || "" : "",
    snapshots,
  };
}

function restoreMainViewScrollSnapshots(snapshot) {
  const mainView = document.querySelector("[data-main-view]");
  if (
    !(mainView instanceof HTMLElement) ||
    !snapshot?.view ||
    mainView.dataset.mainView !== snapshot.view ||
    mainView.dataset.mainScrollKey !== snapshot.key
  ) {
    return;
  }

  for (const [key, selector] of MAIN_VIEW_SCROLL_TARGETS) {
    restoreScrollSnapshot(selector, snapshot.snapshots?.[key]);
  }
}

function captureExplorerScrollSnapshots() {
  const sidebarBody = document.querySelector('[data-sidebar-panel="left"] .sidebar-body');
  const filesTree = document.querySelector("#files-tree");
  const folderPickerList = document.querySelector(".folder-picker-list");

  return {
    sidebarBody: captureScrollSnapshot('[data-sidebar-panel="left"] .sidebar-body'),
    sidebarBodyPresent: sidebarBody instanceof HTMLElement,
    filesTree: captureScrollSnapshot("#files-tree"),
    filesRoot: filesTree instanceof HTMLElement ? filesTree.dataset.filesRoot || "" : "",
    folderPickerList: captureScrollSnapshot(".folder-picker-list"),
    folderPickerRoot: folderPickerList instanceof HTMLElement ? folderPickerList.dataset.folderPickerRoot || "" : "",
  };
}

function restoreExplorerScrollSnapshots(snapshot) {
  if (snapshot?.sidebarBodyPresent) {
    restoreScrollSnapshot('[data-sidebar-panel="left"] .sidebar-body', snapshot.sidebarBody);
  }

  const filesTree = document.querySelector("#files-tree");
  if (filesTree instanceof HTMLElement && filesTree.dataset.filesRoot === snapshot?.filesRoot) {
    restoreScrollSnapshot("#files-tree", snapshot.filesTree);
  }

  const folderPickerList = document.querySelector(".folder-picker-list");
  if (
    folderPickerList instanceof HTMLElement &&
    folderPickerList.dataset.folderPickerRoot === snapshot?.folderPickerRoot
  ) {
    restoreScrollSnapshot(".folder-picker-list", snapshot.folderPickerList);
  }
}

function renderUpdateBanner() {
  const update = state.update;

  if (state.updateApplying) {
    return `
      <section class="update-card is-applying">
        <div class="update-copy">
          <strong>updating remote vibes</strong>
          <span>installing the latest version, then restarting...</span>
        </div>
        <button class="ghost-button update-button" type="button" disabled>working</button>
      </section>
    `;
  }

  if (!update?.updateAvailable) {
    return "";
  }

  const current = update.currentTag || update.currentVersion || update.currentShort || "current";
  const latest = update.latestVersion || update.latestTag || update.latestShort || "latest";
  const branch = update.branch || "main";
  const isRelease = update.targetType === "release";
  const detail = update.canUpdate
    ? isRelease
      ? `${current} -> ${latest}${update.latestName && update.latestName !== latest ? ` · ${update.latestName}` : ""}`
      : `${branch}: ${current} -> ${latest}`
    : update.reason || "This checkout cannot be updated automatically.";
  const releaseLink =
    isRelease && update.releaseUrl
      ? `<a class="update-link" href="${escapeHtml(update.releaseUrl)}" target="_blank" rel="noreferrer">release notes</a>`
      : "";

  return `
    <section class="update-card ${update.canUpdate ? "" : "is-blocked"}">
      <div class="update-copy">
        <strong>${escapeHtml(isRelease ? `${latest} available` : "new version available")}</strong>
        <span>${escapeHtml(detail)}</span>
        ${releaseLink}
      </div>
      <button class="${update.canUpdate ? "primary-button" : "ghost-button"} update-button" type="button" id="update-app" ${update.canUpdate ? "" : "disabled"}>
        ${update.canUpdate ? "update & restart" : "blocked"}
      </button>
    </section>
  `;
}

function renderBrainSetupScreen() {
  document.title = "Set Brain Folder · Remote Vibes";

  app.innerHTML = `
    <main class="screen brain-setup-screen">
      <section class="brain-setup-card" aria-labelledby="brain-setup-title">
        <span class="brain-setup-eyebrow">Remote Vibes</span>
        <h1 id="brain-setup-title">Choose your brain</h1>
        <p>
          Remote Vibes needs one markdown wiki folder for shared memory. Select an
          existing local folder, or clone one from GitHub.
        </p>
        <div class="brain-setup-picker">
          <h2>Select a brain folder</h2>
          <p>
            If the folder is already a git repo, Remote Vibes will detect its origin
            remote and use it for private backups.
          </p>
          <label class="field-label" for="brain-folder-input">Brain folder</label>
          <div class="folder-input-row">
            <input
              id="brain-folder-input"
              class="file-root-input"
              type="text"
              value="${escapeHtml(state.settings.wikiPathConfigured ? state.settings.wikiPath || "" : "")}"
              placeholder="${escapeHtml(state.defaultCwd || "choose a folder")}"
              readonly
              data-folder-picker-target="wiki-onboarding"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="none"
              spellcheck="false"
            />
            <button class="primary-button brain-setup-button" type="button" data-folder-picker-target="wiki-onboarding">select folder</button>
          </div>
        </div>
        <div class="brain-setup-divider"><span>or</span></div>
        <form class="brain-setup-git-form" id="brain-git-form">
          <div>
            <h2>Insert GitHub URL</h2>
            <p>
              Paste a GitHub repo URL and Remote Vibes will clone it locally, set it
              as the active brain, and use its origin remote for backups.
            </p>
          </div>
          <label class="field-label" for="brain-git-url">GitHub repo URL</label>
          <input
            id="brain-git-url"
            class="file-root-input"
            name="remoteUrl"
            type="text"
            value="${escapeHtml(state.brainSetupCloneUrl)}"
            placeholder="https://github.com/you/private-mac-brain.git"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
            ${state.brainSetupCloning ? "disabled" : ""}
          />
          <label class="field-label" for="brain-clone-path">Local folder (optional)</label>
          <input
            id="brain-clone-path"
            class="file-root-input"
            name="wikiPath"
            type="text"
            value="${escapeHtml(state.brainSetupClonePath)}"
            placeholder="${escapeHtml(getDefaultBrainClonePathHint())}"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
            ${state.brainSetupCloning ? "disabled" : ""}
          />
          <div class="brain-setup-git-actions">
            <button class="ghost-button brain-setup-clone-button" type="submit" ${state.brainSetupCloning ? "disabled" : ""}>
              ${state.brainSetupCloning ? "cloning..." : "clone and use"}
            </button>
            <span class="brain-setup-hint">Private repos work if this machine's git credentials can clone them.</span>
          </div>
          ${
            state.brainSetupError
              ? `<div class="brain-setup-error" role="alert">${escapeHtml(state.brainSetupError)}</div>`
              : ""
          }
        </form>
      </section>
      ${renderFolderPickerModal()}
      ${renderSystemToasts()}
    </main>
  `;

  bindShellEvents();
  disposeTerminal();
}

function renderShell() {
  const explorerScrollSnapshot = captureExplorerScrollSnapshots();
  const mainViewScrollSnapshot = captureMainViewScrollSnapshots();
  teardownKnowledgeBaseGraphInteractions();
  syncFilesRoot();

  if (isBrainSetupRequired()) {
    renderBrainSetupScreen();
    return;
  }

  const viewTitles = {
    "knowledge-base": "Knowledge Base · Remote Vibes",
    "agent-prompt": "Agent Prompt · Remote Vibes",
    search: "Search · Remote Vibes",
    plugins: "Plugins · Remote Vibes",
    automations: "Automations · Remote Vibes",
    system: "System · Remote Vibes",
    swarm: "Swarm Graph · Remote Vibes",
    "browser-use": "Browser Use · Remote Vibes",
  };
  document.title = viewTitles[state.currentView] || "Remote Vibes";

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;

  app.innerHTML = `
    <main class="screen app-shell ${state.sidebarCollapsed ? "is-sidebar-collapsed" : ""}" style="${renderAppShellStyle()}">
      <button class="sidebar-scrim ${state.mobileSidebar ? "is-open" : ""}" type="button" aria-label="Close sidebars" data-sidebar-scrim></button>
      <aside class="sidebar sidebar-left ${state.mobileSidebar === "left" ? "is-open" : ""}" data-sidebar-panel="left">
        <div class="sidebar-desktop-actions">
          ${renderSidebarToggleButton()}
        </div>
        <div class="sidebar-mobile-actions">
          <button class="icon-button hidden-desktop" type="button" id="close-left-sidebar" aria-label="Close sidebar" ${tooltipAttributes("Close sidebar")}>${renderIcon(PanelLeftClose)}</button>
        </div>

        <div class="sidebar-body">
          <div class="update-slot" id="update-banner">${renderUpdateBanner()}</div>

          ${renderSidebarNav()}

          <section class="sidebar-section sessions-section">
            <div class="section-head">
              <span>Threads</span>
              <div class="section-actions">
                <button class="icon-button sidebar-head-button" type="button" data-folder-picker-target="session" aria-label="Add project" ${tooltipAttributes("Add project")}>${renderIcon(FolderPlus)}</button>
              </div>
            </div>
            <div class="list-shell" id="sessions-list">${renderSessionCards()}</div>
          </section>

          <section class="sidebar-section">
            <div class="section-head">
              <span>files</span>
              <div class="section-actions">
                <button class="ghost-button files-root-reset" type="button" id="auto-files-root" aria-label="Use automatic files root" ${tooltipAttributes("Use automatic files root")} ${state.filesRootOverride ? "" : "disabled"}>auto</button>
                <button class="icon-button" type="button" id="refresh-files" aria-label="Refresh files" ${tooltipAttributes("Refresh files")}>${renderIcon(RefreshCw)}</button>
              </div>
            </div>
            <form class="file-root-form" id="files-root-form">
              <input
                class="file-root-input"
                id="files-root-input"
                name="root"
                type="text"
                value="${escapeHtml(state.filesRoot || state.defaultCwd || "")}"
                placeholder="${escapeHtml(state.defaultCwd || "workspace path")}"
                readonly
                data-folder-picker-target="files"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="none"
                spellcheck="false"
              />
              <button class="ghost-button file-root-submit" type="button" data-folder-picker-target="files">choose</button>
            </form>
            <div class="file-tree" id="files-tree" data-files-root="${escapeHtml(state.filesRoot || "")}">${renderFileTree()}</div>
          </section>

          ${
            isLocalhostAppsEnabled()
              ? `
          <section class="sidebar-section ports-section">
            <div class="section-head">
              <span>ports</span>
              <button class="icon-button" type="button" id="refresh-ports" aria-label="Refresh ports" ${tooltipAttributes("Refresh ports")}>${renderIcon(RefreshCw)}</button>
            </div>
            <div class="list-shell" id="ports-list">${renderPortCards()}</div>
          </section>`
              : ""
          }
        </div>

        <div class="sidebar-footer">
          <div class="sidebar-footer-actions">
            <button class="ghost-button relaunch-button" type="button" id="relaunch-app">relaunch</button>
            <button class="danger-button terminate-button" type="button" id="terminate-app">terminate</button>
          </div>
        </div>
        ${renderSidebarResizeHandle()}
      </aside>

      ${renderTerminalPanel(activeSession)}
      ${renderFolderPickerModal()}
      ${renderSystemToasts()}
    </main>
  `;
  restoreExplorerScrollSnapshots(explorerScrollSnapshot);
  restoreMainViewScrollSnapshots(mainViewScrollSnapshot);

  bindShellEvents();

  if (state.currentView === "shell") {
    mountTerminal();
    refreshShellUi();
  } else {
    disposeTerminal();
    refreshKnowledgeBaseUi();
  }

  void refreshOpenFileTree();
}

function getUiNow() {
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
}

function isNodeInsideApp(node) {
  return Boolean(node && app && (node === app || app.contains(node)));
}

function hasSelectedTextInActiveControl() {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLInputElement) && !(activeElement instanceof HTMLTextAreaElement)) {
    return false;
  }

  if (!isNodeInsideApp(activeElement)) {
    return false;
  }

  const selectionStart = Number(activeElement.selectionStart);
  const selectionEnd = Number(activeElement.selectionEnd);
  return Number.isFinite(selectionStart) && Number.isFinite(selectionEnd) && selectionStart !== selectionEnd;
}

function hasSelectedDocumentText() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.toString()) {
    return false;
  }

  return isNodeInsideApp(selection.anchorNode) || isNodeInsideApp(selection.focusNode);
}

function hasSelectedDocumentTextWithin(element) {
  const selection = window.getSelection?.();
  if (!(element instanceof Element) || !selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.toString()) {
    return false;
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      if (selection.getRangeAt(index).intersectsNode(element)) {
        return true;
      }
    } catch {
      // A detached node can throw while the DOM is being replaced.
    }
  }

  return false;
}

function hasActiveUserTextSelection() {
  return (
    hasSelectedTextInActiveControl()
    || hasSelectedDocumentText()
    || Boolean(state.terminal?.hasSelection?.())
  );
}

function scheduleSelectableRefreshFlush(delay = SELECTION_REFRESH_RETRY_MS) {
  if (state.deferredSelectableRefreshTimer) {
    window.clearTimeout(state.deferredSelectableRefreshTimer);
  }

  state.deferredSelectableRefreshTimer = window.setTimeout(() => {
    state.deferredSelectableRefreshTimer = null;
    flushDeferredSelectableRefreshes();
  }, delay);
}

function deferSelectableRefresh(kind) {
  if (!kind) {
    return;
  }

  state.deferredSelectableRefreshes.add(kind);
  scheduleSelectableRefreshFlush();
}

function shouldDeferSelectableRefresh({ force = false } = {}) {
  return !force && hasActiveUserTextSelection();
}

function flushDeferredSelectableRefreshes({ force = false } = {}) {
  if (!state.deferredSelectableRefreshes.size) {
    return;
  }

  if (!force && hasActiveUserTextSelection()) {
    scheduleSelectableRefreshFlush();
    return;
  }

  const refreshes = new Set(state.deferredSelectableRefreshes);
  state.deferredSelectableRefreshes.clear();

  if (refreshes.has("system-view") && state.currentView === "system") {
    renderShell();
    return;
  }

  if (refreshes.has("sessions")) {
    refreshSessionsList({ force: true });
  }

  if (refreshes.has("ports")) {
    refreshPortsList({ force: true });
  }

  if (refreshes.has("update")) {
    refreshUpdateUi({ force: true });
  }

  if (refreshes.has("toasts")) {
    refreshSystemToastsUi({ force: true });
  }

  if (refreshes.has("browser-use")) {
    refreshBrowserUsePluginUi({ force: true });
  }
}

function bindSelectableRefreshEvents() {
  document.addEventListener("selectionchange", () => {
    if (!hasActiveUserTextSelection()) {
      scheduleSelectableRefreshFlush(40);
    }
  });

  window.addEventListener("copy", () => {
    scheduleSelectableRefreshFlush(400);
  });
}

function isSessionListTemporarilyProtected() {
  return getUiNow() < state.sessionListInteractionUntil;
}

function isSessionListHoveredOrFocused() {
  const sessionsList = document.querySelector("#sessions-list");
  return Boolean(
    sessionsList
    && (sessionsList.matches(":hover") || (document.activeElement instanceof HTMLElement && sessionsList.contains(document.activeElement))),
  );
}

function isSessionListInteractionActive() {
  return isSessionListTemporarilyProtected() || isSessionListHoveredOrFocused();
}

function scheduleDeferredSessionRefreshFlush(delay = 120) {
  if (state.sessionRefreshFlushTimer) {
    window.clearTimeout(state.sessionRefreshFlushTimer);
  }

  state.sessionRefreshFlushTimer = window.setTimeout(() => {
    state.sessionRefreshFlushTimer = null;
    flushDeferredSessionRefresh();
  }, delay);
}

function markSessionListInteractionActive(duration = 700) {
  state.sessionListInteractionUntil = Math.max(state.sessionListInteractionUntil, getUiNow() + duration);
  scheduleDeferredSessionRefreshFlush(duration + 40);
}

function flushDeferredSessionRefresh() {
  if (!state.sessionsRefreshDeferred) {
    return;
  }

  if (isSessionListTemporarilyProtected()) {
    const delay = Math.max(80, state.sessionListInteractionUntil - getUiNow() + 40);
    scheduleDeferredSessionRefreshFlush(delay);
    return;
  }

  if (isSessionListHoveredOrFocused()) {
    return;
  }

  state.sessionsRefreshDeferred = false;
  refreshSessionsList({ force: true });
}

function toggleSessionProject(projectKey) {
  if (!projectKey) {
    return;
  }

  state.sessionProjectInteractionSeen = true;
  markSessionListInteractionActive();

  if (state.sessionProjectExpanded.has(projectKey)) {
    state.sessionProjectExpanded.delete(projectKey);
  } else {
    state.sessionProjectExpanded.add(projectKey);
  }

  refreshSessionsList({ force: true });
}

function suppressNextSessionProjectClick(projectKey) {
  state.sessionProjectSuppressClickKey = projectKey || "";
  state.sessionProjectSuppressClickUntil = getUiNow() + 350;
  window.setTimeout(() => {
    if (getUiNow() >= state.sessionProjectSuppressClickUntil) {
      state.sessionProjectSuppressClickKey = "";
      state.sessionProjectSuppressClickUntil = 0;
    }
  }, 380);
}

function consumeSuppressedSessionProjectClick(projectKey) {
  if (
    projectKey
    && projectKey === state.sessionProjectSuppressClickKey
    && getUiNow() < state.sessionProjectSuppressClickUntil
  ) {
    state.sessionProjectSuppressClickKey = "";
    state.sessionProjectSuppressClickUntil = 0;
    return true;
  }

  return false;
}

function bindSessionEvents() {
  const sessionsList = document.querySelector("#sessions-list");
  if (sessionsList && !sessionsList.dataset.sessionRefreshBound) {
    sessionsList.dataset.sessionRefreshBound = "true";
    sessionsList.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const browserUseButton = target.closest("[data-open-browser-use-session]");
      if (!browserUseButton) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      markSessionListInteractionActive();
      const browserUseSessionId = browserUseButton.getAttribute("data-open-browser-use-session") || "";
      void openBrowserUseSession(browserUseSessionId);
    });
    sessionsList.addEventListener("pointerleave", () => {
      window.setTimeout(flushDeferredSessionRefresh, 80);
    });
    sessionsList.addEventListener("focusout", () => {
      window.setTimeout(flushDeferredSessionRefresh, 80);
    });
  }

  document.querySelectorAll("[data-session-project-toggle]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      button.dataset.sessionProjectPointerToggle = "true";
      const projectKey = button.getAttribute("data-session-project-toggle");
      suppressNextSessionProjectClick(projectKey);
      toggleSessionProject(projectKey);
    });

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const projectKey = button.getAttribute("data-session-project-toggle");
      if (button.dataset.sessionProjectPointerToggle === "true") {
        delete button.dataset.sessionProjectPointerToggle;
        consumeSuppressedSessionProjectClick(projectKey);
        return;
      }

      if (consumeSuppressedSessionProjectClick(projectKey)) {
        return;
      }

      toggleSessionProject(projectKey);
    });
  });

  document.querySelectorAll("[data-create-session-in-cwd]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const cwd = button.getAttribute("data-create-session-in-cwd") || "";
      if (!cwd) {
        return;
      }

      try {
        await createSessionInFolder(cwd);
      } catch (error) {
        window.alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-open-swarm-graph]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const sessionId = button.getAttribute("data-open-swarm-graph") || "";
      void openSwarmGraph(sessionId);
    });
  });

  document.querySelectorAll("[data-open-swarm-project]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const projectCwd = button.getAttribute("data-open-swarm-project") || "";
      const fallbackSessionId = button.getAttribute("data-swarm-project-fallback-session") || "";
      const projectName = button.getAttribute("data-swarm-project-name") || "";
      void openSwarmProjectGraph(projectCwd, { fallbackSessionId, projectName });
    });
  });

  document.querySelectorAll("[data-open-browser-use-session]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const browserUseSessionId = button.getAttribute("data-open-browser-use-session") || "";
      void openBrowserUseSession(browserUseSessionId);
    });
  });

  document.querySelectorAll("[data-delete-browser-use-session]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const browserUseSessionId = button.getAttribute("data-delete-browser-use-session") || "";
      if (!browserUseSessionId) {
        return;
      }

      if (button instanceof HTMLButtonElement) {
        button.disabled = true;
      }

      try {
        await deleteBrowserUseSession(browserUseSessionId);
      } catch (error) {
        if (button instanceof HTMLButtonElement) {
          button.disabled = false;
        }
        window.alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-mark-session-read]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const sessionId = button.getAttribute("data-mark-session-read") || "";
      if (!sessionId) {
        return;
      }

      if (markSessionRead(sessionId, { refresh: false })) {
        refreshSessionsList({ force: true });
      }
    });
  });

  document.querySelectorAll("[data-session-id]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target.closest("[data-delete-session]")) {
        return;
      }

      if (hasSelectedDocumentTextWithin(element)) {
        return;
      }

      const nextSessionId = element.getAttribute("data-session-id");
      if (!nextSessionId) {
        closeMobileSidebar();
        return;
      }

      if (state.currentView !== "shell") {
        setCurrentView("shell");
      }

      markSessionRead(nextSessionId, { refresh: false });

      if (nextSessionId === state.activeSessionId) {
        renderShell();
        connectToSession(state.activeSessionId);
        closeMobileSidebar();
        return;
      }

      state.activeSessionId = nextSessionId;
      const nextSession = state.sessions.find((session) => session.id === nextSessionId);
      if (nextSession) {
        expandSessionProject(nextSession.cwd);
      }
      renderShell();
      connectToSession(state.activeSessionId);
      closeMobileSidebar();
    });
  });

  document.querySelectorAll("[data-rename-session]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const sessionId = button.getAttribute("data-rename-session");
      const session = state.sessions.find((entry) => entry.id === sessionId);

      if (!sessionId || !session) {
        return;
      }

      const nextName = window.prompt("Rename session", session.name);
      if (nextName === null) {
        return;
      }

      if (!nextName.trim()) {
        window.alert("Session name cannot be empty.");
        return;
      }

      try {
        const payload = await fetchJson(`/api/sessions/${sessionId}`, {
          method: "PATCH",
          body: JSON.stringify({ name: nextName }),
        });
        updateSession(payload.session);
        refreshShellUi({ sessions: true, ports: false, files: false });
      } catch (error) {
        window.alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-fork-session]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const sessionId = button.getAttribute("data-fork-session");

      if (!sessionId) {
        return;
      }

      try {
        const payload = await fetchJson(`/api/sessions/${sessionId}/fork`, {
          method: "POST",
        });

        state.sessions = [payload.session, ...state.sessions.filter((session) => session.id !== payload.session.id)];
        state.activeSessionId = payload.session.id;
        expandSessionProject(payload.session.cwd);
        setCurrentView("shell");
        renderShell();
        connectToSession(payload.session.id);
        closeMobileSidebar();
      } catch (error) {
        window.alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-delete-session]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const sessionId = button.getAttribute("data-delete-session");

      try {
        await fetchJson(`/api/sessions/${sessionId}`, { method: "DELETE" });
        state.sessions = state.sessions.filter((session) => session.id !== sessionId);

        if (state.activeSessionId === sessionId) {
          closeWebsocket();
          state.activeSessionId = state.sessions[0]?.id ?? null;
          const nextSession = state.sessions.find((session) => session.id === state.activeSessionId);
          if (nextSession) {
            expandSessionProject(nextSession.cwd);
          }
          renderShell();

          if (state.activeSessionId) {
            connectToSession(state.activeSessionId);
          }
          return;
        }

        refreshShellUi();
      } catch (error) {
        window.alert(error.message);
      }
    });
  });
}

function refreshSessionsList({ force = false } = {}) {
  const sessionsList = document.querySelector("#sessions-list");
  if (!sessionsList) {
    return;
  }

  if (shouldDeferSelectableRefresh({ force })) {
    deferSelectableRefresh("sessions");
    return;
  }

  if (!force && isSessionListInteractionActive()) {
    state.sessionsRefreshDeferred = true;
    if (isSessionListTemporarilyProtected()) {
      const delay = Math.max(80, state.sessionListInteractionUntil - getUiNow() + 40);
      scheduleDeferredSessionRefreshFlush(delay);
    }
    return;
  }

  state.sessionsRefreshDeferred = false;
  sessionsList.innerHTML = renderSessionCards();
  bindSessionEvents();
}

function refreshPortsList({ force = false } = {}) {
  const portsList = document.querySelector("#ports-list");
  if (!portsList) {
    return;
  }

  if (!isLocalhostAppsEnabled()) {
    portsList.innerHTML = "";
    return;
  }

  if (shouldDeferSelectableRefresh({ force })) {
    deferSelectableRefresh("ports");
    return;
  }

  portsList.innerHTML = renderPortCards();
  bindPortEvents();
}

function bindSearchResultEvents() {
  document.querySelectorAll("[data-open-search-note]").forEach((button) => {
    button.addEventListener("click", async () => {
      const notePath = button.getAttribute("data-open-search-note") || "";
      setCurrentView("knowledge-base", { notePath });
      closeMobileSidebar();

      if (!state.knowledgeBase.notes.length && !state.knowledgeBase.loading) {
        await loadKnowledgeBaseIndex();
      }

      await openKnowledgeBaseNote(notePath);
    });
  });
}

function refreshGlobalSearchUi() {
  const count = document.querySelector(".main-search-count");
  if (count) {
    count.textContent = getGlobalSearchResultLabel();
  }

  const results = document.querySelector("#global-search-results");
  if (!results) {
    return;
  }

  results.innerHTML = renderSearchResults();
  bindSessionEvents();
  bindPortEvents();
  bindSearchResultEvents();
}

function refreshPluginSearchUi() {
  const count = document.querySelector(".plugins-view .main-search-count");
  if (count) {
    count.textContent = `${getFilteredPlugins().length} shown`;
  }

  const results = document.querySelector("#plugin-results");
  if (!results) {
    return;
  }

  results.innerHTML = renderPluginCards();
  bindPluginCardEvents();
}

async function setPluginInstalled(pluginId, installed) {
  const plugin = getPluginById(pluginId);
  if (!plugin) {
    return;
  }

  state.pluginInstallActions = {
    ...state.pluginInstallActions,
    [pluginId]: installed ? "installing" : "uninstalling",
  };
  refreshPluginSearchUi();

  try {
    const body = {
      installedPluginIds: getUpdatedInstalledPluginIds(pluginId, installed),
    };

    if (pluginId === "browser-use") {
      body.browserUseEnabled = installed;
    }

    const [payload] = await Promise.all([
      fetchJson("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
      sleep(520),
    ]);

    applySettingsState(payload.settings);
    if (payload.agentPrompt) {
      applyAgentPromptState(payload.agentPrompt);
    }
    delete state.pluginInstallActions[pluginId];

    if (pluginId === "localhost-apps") {
      if (!installed) {
        clearLocalhostAppsSurfaces();
      }
      renderShell();
      if (installed) {
        void loadPorts();
      }
      return;
    }

    refreshPluginSearchUi();

    refreshBrowserUsePluginUi({ force: true });
  } catch (error) {
    delete state.pluginInstallActions[pluginId];
    refreshPluginSearchUi();
    window.alert(error.message);
  }
}

function bindPluginCardEvents() {
  document.querySelectorAll("[data-plugin-install]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }

      const pluginId = button.getAttribute("data-plugin-install") || "";
      const installed = button.getAttribute("data-plugin-next-installed") === "true";
      void setPluginInstalled(pluginId, installed);
    });
  });
}

function createClientId(prefix) {
  const randomId =
    typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomId}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function getAgentAutomations() {
  return Array.isArray(state.settings.agentAutomations) ? state.settings.agentAutomations : [];
}

async function saveAgentAutomations(agentAutomations) {
  const payload = await fetchJson("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ agentAutomations }),
  });
  applySettingsState(payload.settings);
  if (payload.agentPrompt) {
    applyAgentPromptState(payload.agentPrompt);
  }
}

async function createAgentAutomationFromForm(form) {
  const formData = new FormData(form);
  const prompt = String(formData.get("prompt") || "").trim();
  if (!prompt) {
    throw new Error("Add a prompt for the agent first.");
  }

  const automation = {
    cadence: String(formData.get("cadence") || "daily"),
    createdAt: new Date().toISOString(),
    enabled: true,
    id: createClientId("automation"),
    prompt,
    time: String(formData.get("time") || "09:00"),
    weekday: String(formData.get("weekday") || "monday"),
  };

  await saveAgentAutomations([...getAgentAutomations(), automation]);
}

async function deleteAgentAutomation(automationId) {
  await saveAgentAutomations(getAgentAutomations().filter((automation) => automation.id !== automationId));
}

function bindAutomationEvents() {
  document.querySelectorAll("[data-toggle-automation]").forEach((button) => {
    button.addEventListener("click", async () => {
      const automation = button.getAttribute("data-toggle-automation");
      if (automation !== "wiki-backup" || !(button instanceof HTMLButtonElement)) {
        return;
      }

      const nextEnabled = !state.settings.wikiGitBackupEnabled;
      const previousText = button.textContent;
      button.disabled = true;
      button.textContent = nextEnabled ? "enabling..." : "disabling...";

      try {
        await updateWikiBackupAutomation(nextEnabled);
        renderShell();
      } catch (error) {
        button.disabled = false;
        button.textContent = previousText;
        window.alert(error.message);
      }
    });
  });

  document.querySelector("#automation-create-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const button = form.querySelector("button[type='submit']");
    if (button instanceof HTMLButtonElement) {
      button.disabled = true;
      button.textContent = "creating...";
    }

    try {
      await createAgentAutomationFromForm(form);
      renderShell();
    } catch (error) {
      if (button instanceof HTMLButtonElement) {
        button.disabled = false;
        button.textContent = "create automation";
      }
      window.alert(error.message);
    }
  });

  document.querySelectorAll("[data-delete-agent-automation]").forEach((button) => {
    button.addEventListener("click", async () => {
      const automationId = button.getAttribute("data-delete-agent-automation") || "";
      if (!automationId || !(button instanceof HTMLButtonElement)) {
        return;
      }

      button.disabled = true;
      button.textContent = "deleting...";
      try {
        await deleteAgentAutomation(automationId);
        renderShell();
      } catch (error) {
        button.disabled = false;
        button.textContent = "delete";
        window.alert(error.message);
      }
    });
  });
}

function refreshBrowserUsePluginUi({ force = false } = {}) {
  const card = document.querySelector(".browser-use-plugin-card");
  if (!card) {
    return;
  }

  if (shouldDeferSelectableRefresh({ force })) {
    deferSelectableRefresh("browser-use");
    return;
  }

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && activeElement.closest("#browser-use-form")) {
    return;
  }

  card.outerHTML = renderBrowserUsePluginPanel();
  bindBrowserUseForm();
}

function bindBrowserUseForm() {
  document.querySelector("#browser-use-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;

    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const button = form.querySelector("[data-browser-use-action]");
    if (button instanceof HTMLButtonElement) {
      button.disabled = true;
      button.textContent = "saving...";
    }

    try {
      await setupBrowserUseFromForm(form);
      renderShell();
    } catch (error) {
      window.alert(error.message);
      if (button instanceof HTMLButtonElement) {
        button.disabled = false;
        button.textContent = "save browser use";
      }
    }
  });
}

function refreshUpdateUi({ force = false } = {}) {
  const updateBanner = document.querySelector("#update-banner");
  if (!updateBanner) {
    return;
  }

  if (shouldDeferSelectableRefresh({ force })) {
    deferSelectableRefresh("update");
    return;
  }

  updateBanner.innerHTML = renderUpdateBanner();
  bindUpdateEvents();
}

function refreshKnowledgeSettingsUi() {
  const wikiBackupText = getWikiBackupStatusText();
  document.querySelectorAll("#wiki-backup-status, #wiki-backup-settings-status").forEach((element) => {
    element.textContent = wikiBackupText;
  });

  document.querySelectorAll("[data-knowledge-base-header-meta]").forEach((element) => {
    element.textContent = getKnowledgeBaseHeaderMeta();
  });

  const intervalLabel = document.querySelector("#wiki-backup-interval-label");
  if (intervalLabel) {
    intervalLabel.textContent = formatWikiBackupIntervalLabel();
  }
}

function refreshSystemToastsUi({ force = false } = {}) {
  const currentStack = document.querySelector("#system-toasts");
  const nextHtml = renderSystemToasts();

  if (shouldDeferSelectableRefresh({ force })) {
    deferSelectableRefresh("toasts");
    return;
  }

  if (currentStack) {
    if (nextHtml) {
      currentStack.outerHTML = nextHtml;
      bindSystemToastEvents();
      return;
    }

    currentStack.remove();
    return;
  }

  if (!nextHtml) {
    return;
  }

  document.querySelector("main.screen")?.insertAdjacentHTML("beforeend", nextHtml);
  bindSystemToastEvents();
}

function bindSystemToastEvents() {
  document.querySelectorAll("[data-system-toast-dismiss]").forEach((button) => {
    button.onclick = () => {
      const key = button.getAttribute("data-system-toast-dismiss");
      if (key) {
        state.systemToastDismissedKeys.add(key);
      }
      refreshSystemToastsUi();
    };
  });

  document.querySelectorAll("[data-system-toast-action]").forEach((button) => {
    button.onclick = async () => {
      const action = button.getAttribute("data-system-toast-action") || "";
      const key = button.getAttribute("data-system-toast-key") || "";
      const previousText = button.textContent;

      if (button instanceof HTMLButtonElement) {
        button.disabled = true;
        button.textContent = action === "resolve-wiki-conflict" ? "opening..." : "trying...";
      }

      try {
        if (action === "resolve-wiki-conflict") {
          const providerSelect = document.querySelector("[data-wiki-conflict-provider]");
          const providerId =
            providerSelect instanceof HTMLSelectElement && providerSelect.value
              ? providerSelect.value
              : state.defaultProviderId;
          await createSessionInFolder(state.settings.wikiPath, {
            providerId,
            name: "fix wiki conflict",
          });
          if (key) {
            state.systemToastDismissedKeys.add(key);
          }
          return;
        }

        if (action === "retry-wiki-backup") {
          await backupWikiNow();
          refreshKnowledgeSettingsUi();
          refreshSystemToastsUi();
          return;
        }

        if (action === "retry-update-check") {
          state.lastUpdateError = null;
          await loadUpdateStatus({ force: true });
          refreshSystemToastsUi();
        }
      } catch (error) {
        if (button instanceof HTMLButtonElement) {
          button.disabled = false;
          button.textContent = previousText;
        }
        if (action === "retry-update-check") {
          state.lastUpdateError = {
            message: error.message,
            occurredAt: new Date().toISOString(),
          };
          refreshSystemToastsUi();
          return;
        }
        window.alert(error.message);
      }
    };
  });
}

function bindPortEvents() {
  if (!isLocalhostAppsEnabled()) {
    return;
  }

  document.querySelectorAll("[data-open-port-preview]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (hasSelectedDocumentTextWithin(button)) {
        return;
      }
      const portNumber = Number(button.getAttribute("data-open-port-preview"));
      openPortPreview(portNumber);
    });
  });

  document.querySelectorAll("[data-expose-tailscale-port]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const portNumber = Number(button.getAttribute("data-expose-tailscale-port"));
      const previousLabel = button.textContent;
      button.disabled = true;
      button.textContent = "exposing...";

      try {
        const payload = await fetchJson(`/api/ports/${portNumber}/tailscale`, {
          method: "POST",
        });

        if (payload.port) {
          updatePort(payload.port);
        }

        refreshShellUi({ sessions: false, ports: true, files: false });
        refreshOpenFileUi();

        const nextUrl = payload.port?.preferredUrl || payload.port?.tailscaleUrl;
        if (nextUrl) {
          window.open(nextUrl, "_blank", "noopener,noreferrer");
        }
      } catch (error) {
        button.disabled = false;
        button.textContent = previousLabel;
        window.alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-rename-port]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const portNumber = Number(button.getAttribute("data-rename-port"));
      const port = state.ports.find((entry) => entry.port === portNumber);

      if (!port) {
        return;
      }

      const nextName = window.prompt(
        "Rename port (leave blank to reset)",
        port.customName ? getPortDisplayName(port) : "",
      );

      if (nextName === null) {
        return;
      }

      try {
        const payload = await fetchJson(`/api/ports/${portNumber}`, {
          method: "PATCH",
          body: JSON.stringify({ name: nextName }),
        });
        updatePort(payload.port);
        refreshShellUi({ sessions: false, ports: true, files: false });
        refreshOpenFileUi();
      } catch (error) {
        window.alert(error.message);
      }
    });
  });
}

function bindKnowledgeBaseGraphInteractions() {
  const layout = state.knowledgeBase.graphLayout;
  const previousCleanup = layout.cleanup;
  layout.cleanup = null;
  previousCleanup?.();
  stopKnowledgeBaseGraphSimulation();

  const svg = document.querySelector("#knowledge-base-graph");
  if (!(svg instanceof SVGSVGElement)) {
    layout.refs = null;
    return;
  }

  const viewport = svg.querySelector("[data-kb-graph-viewport]");
  const nodeElements = Array.from(svg.querySelectorAll("[data-kb-graph-node-index]"));
  const edgeElements = Array.from(svg.querySelectorAll("[data-kb-graph-edge-index]"));

  if (!(viewport instanceof SVGGElement)) {
    layout.refs = null;
    return;
  }

  const controller = new AbortController();
  const signal = controller.signal;
  const refs = {
    svg,
    viewport,
    edgeElements,
    nodeElements,
  };

  layout.refs = refs;

  const clearInteractionState = () => {
    layout.dragState = null;
    layout.panState = null;
    layout.hoveredPath = "";
    svg.classList.remove("is-panning", "is-dragging-node");
    layout.nodes.forEach((_node, index) => {
      const element = nodeElements[index];
      if (element instanceof SVGGElement) {
        element.classList.remove("is-dragging");
      }
    });
  };

  const setHoveredPath = (nextPath) => {
    if (layout.hoveredPath === nextPath) {
      return;
    }

    layout.hoveredPath = nextPath;
    syncKnowledgeBaseGraphDom();
  };

  const onPointerMove = (event) => {
    if (layout.dragState?.pointerId === event.pointerId) {
      const worldPoint = getKnowledgeBaseGraphWorldPoint(svg, event.clientX, event.clientY);
      if (!worldPoint) {
        return;
      }

      layout.dragState.moved =
        layout.dragState.moved ||
        Math.hypot(
          event.clientX - layout.dragState.startClientX,
          event.clientY - layout.dragState.startClientY,
        ) >= KNOWLEDGE_BASE_GRAPH_DRAG_SLOP_PX;

      layout.dragState.node.x = worldPoint.x + layout.dragState.pointerOffsetX;
      layout.dragState.node.y = worldPoint.y + layout.dragState.pointerOffsetY;
      layout.dragState.node.vx = 0;
      layout.dragState.node.vy = 0;
      syncKnowledgeBaseGraphDom();
      startKnowledgeBaseGraphSimulation(0.2);
      return;
    }

    if (layout.panState?.pointerId === event.pointerId) {
      const svgPoint = getKnowledgeBaseGraphSvgPoint(svg, event.clientX, event.clientY);
      if (!svgPoint) {
        return;
      }

      layout.panState.moved =
        layout.panState.moved ||
        Math.hypot(
          event.clientX - layout.panState.startClientX,
          event.clientY - layout.panState.startClientY,
        ) >= KNOWLEDGE_BASE_GRAPH_DRAG_SLOP_PX;

      layout.offsetX = layout.panState.originOffsetX + (svgPoint.x - layout.panState.startSvgX);
      layout.offsetY = layout.panState.originOffsetY + (svgPoint.y - layout.panState.startSvgY);
      layout.cameraInitialized = true;
      syncKnowledgeBaseGraphDom();
    }
  };

  const onPointerEnd = (event) => {
    if (layout.dragState?.pointerId === event.pointerId) {
      const { moved, notePath } = layout.dragState;
      clearInteractionState();
      syncKnowledgeBaseGraphDom();
      startKnowledgeBaseGraphSimulation(0.14);

      if (!moved) {
        void openKnowledgeBaseNote(notePath);
      }
      return;
    }

    if (layout.panState?.pointerId === event.pointerId) {
      clearInteractionState();
      syncKnowledgeBaseGraphDom();
    }
  };

  svg.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const nodeElement = target.closest("[data-kb-graph-node-index]");

      if (nodeElement instanceof SVGGElement) {
        const nodeIndex = Number.parseInt(nodeElement.getAttribute("data-kb-graph-node-index") || "", 10);
        const node = layout.nodes[nodeIndex];
        const worldPoint = getKnowledgeBaseGraphWorldPoint(svg, event.clientX, event.clientY);

        if (!node || !worldPoint) {
          return;
        }

        layout.dragState = {
          pointerId: event.pointerId,
          node,
          notePath: node.relativePath,
          startClientX: event.clientX,
          startClientY: event.clientY,
          pointerOffsetX: node.x - worldPoint.x,
          pointerOffsetY: node.y - worldPoint.y,
          moved: false,
        };
        svg.classList.add("is-dragging-node");
        nodeElement.classList.add("is-dragging");
        startKnowledgeBaseGraphSimulation(0.22);
        syncKnowledgeBaseGraphDom();
        event.preventDefault();
        return;
      }

      const svgPoint = getKnowledgeBaseGraphSvgPoint(svg, event.clientX, event.clientY);
      if (!svgPoint) {
        return;
      }

      layout.panState = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startSvgX: svgPoint.x,
        startSvgY: svgPoint.y,
        originOffsetX: layout.offsetX,
        originOffsetY: layout.offsetY,
        moved: false,
      };
      svg.classList.add("is-panning");
      event.preventDefault();
    },
    { signal },
  );

  window.addEventListener("pointermove", onPointerMove, { signal });
  window.addEventListener("pointerup", onPointerEnd, { signal });
  window.addEventListener("pointercancel", onPointerEnd, { signal });

  svg.addEventListener(
    "pointerover",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const nodeElement = target.closest("[data-kb-graph-node-index]");
      if (!(nodeElement instanceof SVGGElement)) {
        return;
      }

      const nodeIndex = Number.parseInt(nodeElement.getAttribute("data-kb-graph-node-index") || "", 10);
      setHoveredPath(layout.nodes[nodeIndex]?.relativePath || "");
    },
    { signal },
  );

  svg.addEventListener(
    "pointerout",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const nodeElement = target.closest("[data-kb-graph-node-index]");
      if (!(nodeElement instanceof SVGGElement)) {
        return;
      }

      const relatedElement =
        event.relatedTarget instanceof Element
          ? event.relatedTarget.closest("[data-kb-graph-node-index]")
          : null;
      if (relatedElement === nodeElement) {
        return;
      }

      setHoveredPath("");
    },
    { signal },
  );

  svg.addEventListener(
    "wheel",
    (event) => {
      const svgPoint = getKnowledgeBaseGraphSvgPoint(svg, event.clientX, event.clientY);
      if (!svgPoint) {
        return;
      }

      event.preventDefault();

      const worldX = (svgPoint.x - layout.offsetX) / layout.scale;
      const worldY = (svgPoint.y - layout.offsetY) / layout.scale;
      const zoomFactor = Math.exp(-event.deltaY * 0.0015);
      const nextScale = clamp(
        layout.scale * zoomFactor,
        KNOWLEDGE_BASE_GRAPH_MIN_SCALE,
        KNOWLEDGE_BASE_GRAPH_MAX_SCALE,
      );

      if (Math.abs(nextScale - layout.scale) < 0.0001) {
        return;
      }

      layout.scale = nextScale;
      layout.offsetX = svgPoint.x - worldX * nextScale;
      layout.offsetY = svgPoint.y - worldY * nextScale;
      layout.cameraInitialized = true;
      syncKnowledgeBaseGraphDom();
    },
    { signal, passive: false },
  );

  document.querySelector("#fit-knowledge-base-graph")?.addEventListener(
    "click",
    () => {
      fitKnowledgeBaseGraphCamera();
      startKnowledgeBaseGraphSimulation(0.18);
    },
    { signal },
  );

  document.querySelector("#pulse-knowledge-base-graph")?.addEventListener(
    "click",
    () => {
      replayKnowledgeBaseGraphUnfold();
    },
    { signal },
  );

  layout.cleanup = () => {
    controller.abort();
    clearInteractionState();
    if (layout.refs === refs) {
      layout.refs = null;
    }
  };

  if (!layout.cameraInitialized) {
    fitKnowledgeBaseGraphCamera();
  } else {
    syncKnowledgeBaseGraphDom();
  }

  const focusedPendingNode = applyPendingKnowledgeBaseGraphFocus();
  const replayedGraph = !focusedPendingNode && state.knowledgeBase.replayGraphOnNextBind
    ? replayKnowledgeBaseGraphUnfold()
    : false;

  if (focusedPendingNode || replayedGraph) {
    state.knowledgeBase.replayGraphOnNextBind = false;
  }

  if (!focusedPendingNode && !replayedGraph) {
    startKnowledgeBaseGraphSimulation(0.22);
  }
}

function bindKnowledgeBaseNoteOpenEvents() {
  document.querySelectorAll("[data-kb-note]").forEach((button) => {
    button.onclick = async () => {
      const notePath = button.getAttribute("data-kb-note");
      await openKnowledgeBaseNote(notePath || "", { focusGraph: true });
    };
  });

  document.querySelectorAll("[data-kb-open-note]").forEach((button) => {
    button.onclick = async () => {
      const notePath = button.getAttribute("data-kb-open-note");
      await openKnowledgeBaseNote(notePath || "", { focusGraph: true });
    };
  });
}

function refreshKnowledgeBaseSearchUi() {
  document.querySelectorAll(".knowledge-base-search-count").forEach((element) => {
    element.textContent = getKnowledgeBaseSearchResultLabel();
  });

  document.querySelectorAll(".knowledge-base-note-list").forEach((element) => {
    element.innerHTML = renderKnowledgeBaseNoteList();
  });

  bindKnowledgeBaseNoteOpenEvents();
}

function bindKnowledgeBaseEvents() {
  bindKnowledgeBaseNoteOpenEvents();
  bindSystemToastEvents();

  document.querySelector("#knowledge-base-search")?.addEventListener("input", (event) => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    state.knowledgeBase.searchQuery = input.value;
    refreshKnowledgeBaseSearchUi();
  });

  document.querySelector("#edit-knowledge-base-note")?.addEventListener("click", () => {
    startKnowledgeBaseNoteEdit();
  });

  document.querySelector("#cancel-knowledge-base-edit")?.addEventListener("click", () => {
    cancelKnowledgeBaseNoteEdit();
  });

  document.querySelector("#save-knowledge-base-note")?.addEventListener("click", async () => {
    await saveKnowledgeBaseNote();
  });

  document.querySelector("#knowledge-base-note-editor")?.addEventListener("input", (event) => {
    const textarea = event.currentTarget;
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return;
    }

    state.knowledgeBase.selectedNoteDraft = textarea.value;
    refreshKnowledgeBaseEditStateUi();
  });

  const refreshButton = document.querySelector("#refresh-knowledge-base");
  if (refreshButton instanceof HTMLButtonElement) {
    refreshButton.onclick = async () => {
      await loadKnowledgeBaseIndex();
      await ensureKnowledgeBaseSelectionLoaded({ force: true });
      updateRoute({ view: "knowledge-base", notePath: state.knowledgeBase.selectedNotePath });
      renderShell();
    };
  }
}

function refreshKnowledgeBaseUi() {
  if (state.currentView !== "knowledge-base") {
    teardownKnowledgeBaseGraphInteractions();
    return;
  }

  bindKnowledgeBaseEvents();

  const graphElement = document.querySelector("#knowledge-base-graph");
  if (state.knowledgeBase.graphLayout.refs?.svg === graphElement) {
    if (!state.knowledgeBase.graphLayout.cameraInitialized) {
      fitKnowledgeBaseGraphCamera();
    } else {
      syncKnowledgeBaseGraphDom();
    }
    applyPendingKnowledgeBaseGraphFocus();
    return;
  }

  bindKnowledgeBaseGraphInteractions();
}

function bindFileTreeEvents() {
  const filesTree = document.querySelector("#files-tree");
  if (!(filesTree instanceof HTMLElement) || filesTree.dataset.fileTreeBound === "true") {
    return;
  }

  filesTree.dataset.fileTreeBound = "true";
  filesTree.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const fileControl = target.closest("[data-file-toggle], [data-file-open]");
    if (!(fileControl instanceof HTMLElement) || !filesTree.contains(fileControl)) {
      return;
    }

    if (document.querySelector("#terminal-mount")?.contains(document.activeElement)) {
      // Sidebar tree redraws should not make xterm blur/redraw while an agent is running.
      event.preventDefault();
    }
  });
  filesTree.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const toggleButton = target.closest("[data-file-toggle]");
    if (toggleButton instanceof HTMLElement && filesTree.contains(toggleButton)) {
      event.preventDefault();
      event.stopPropagation();
      const relativePath = normalizeFileTreePath(toggleButton.getAttribute("data-file-toggle"));

      if (!relativePath) {
        return;
      }

      if (state.fileTreeExpanded.has(relativePath)) {
        state.fileTreeExpanded.delete(relativePath);
        refreshFileTreeUi();
        return;
      }

      state.fileTreeExpanded.add(relativePath);
      refreshFileTreeUi();
      void loadFileTree(relativePath);
      return;
    }

    const openButton = target.closest("[data-file-open]");
    if (!(openButton instanceof HTMLElement) || !filesTree.contains(openButton)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const relativePath = normalizeFileTreePath(openButton.getAttribute("data-file-open"));
    const openMode = openButton.getAttribute("data-file-open-mode");

    if (!relativePath) {
      return;
    }

    const openedInKnowledgeBase = await selectKnowledgeBaseNoteForWorkspaceFile(relativePath, {
      openInKnowledgeBase: state.currentView === "knowledge-base",
    });
    if (openedInKnowledgeBase && state.currentView === "knowledge-base") {
      return;
    }

    void openWorkspaceFilePreview(relativePath, { mode: openMode });
  });
}

function refreshFileTreeUi() {
  const filesRootInput = document.querySelector("#files-root-input");
  const filesTree = document.querySelector("#files-tree");
  const autoFilesRootButton = document.querySelector("#auto-files-root");
  const nextRoot = state.filesRoot || state.defaultCwd || "";
  const filesTreeScrollSnapshot = captureScrollSnapshot("#files-tree");

  if (filesRootInput instanceof HTMLInputElement) {
    if (document.activeElement !== filesRootInput) {
      filesRootInput.value = nextRoot;
    }

    filesRootInput.setAttribute("title", nextRoot);
    filesRootInput.placeholder = state.defaultCwd || "workspace path";
  }

  if (autoFilesRootButton instanceof HTMLButtonElement) {
    autoFilesRootButton.disabled = !state.filesRootOverride;
  }

  if (!filesTree) {
    return;
  }

  const previousRenderedRoot = filesTree instanceof HTMLElement ? filesTree.dataset.filesRoot || "" : "";
  filesTree.innerHTML = renderFileTree();
  if (filesTree instanceof HTMLElement) {
    filesTree.dataset.filesRoot = state.filesRoot || "";
  }
  if (previousRenderedRoot === (state.filesRoot || "")) {
    restoreScrollSnapshot("#files-tree", filesTreeScrollSnapshot);
  }
  bindFileTreeEvents();
}

function refreshOpenFileUi() {
  const previewPane = document.querySelector("#file-preview-pane");
  if (previewPane) {
    const workspaceSplit = document.querySelector("#workspace-split");
    workspaceSplit?.classList.toggle("has-file-preview", state.openFileTabs.length > 0);
    previewPane.outerHTML = renderFilePreviewPane();
    bindFileEditorEvents();
    refreshLayoutUi();
    fitTerminalSoon();
    return;
  }

  const fileEditor = document.querySelector("#file-editor");
  if (!fileEditor) {
    return;
  }

  fileEditor.innerHTML = renderOpenFilePanel();
  bindFileEditorEvents();
}

function syncOpenFileEditorStateUi() {
  syncOpenFileStateFromTab();
  const status = document.querySelector("#open-file-status");
  const saveButton = document.querySelector("#save-open-file");
  const previewButton = document.querySelector("#preview-open-file");
  const activeTab = getActiveOpenFileTab();

  if (status) {
    status.textContent = activeTab?.saving
      ? "saving changes..."
      : isOpenFileDirty(activeTab)
        ? "unsaved changes"
        : "saved";
  }

  if (saveButton instanceof HTMLButtonElement) {
    const dirty = isOpenFileDirty(activeTab);
    saveButton.disabled = !dirty || Boolean(activeTab?.saving);
    saveButton.textContent = activeTab?.saving ? "saving..." : dirty ? "save" : "saved";
    saveButton.classList.toggle("primary-button", dirty);
    saveButton.classList.toggle("ghost-button", !dirty);
  }

  if (previewButton instanceof HTMLButtonElement) {
    previewButton.disabled = isOpenFileDirty(activeTab) || Boolean(activeTab?.saving);
  }
}

function syncOpenImageTransformDom(tab = getActiveOpenFileTab()) {
  if (!tab || tab.status !== "image") {
    return;
  }

  const preview = document.querySelector("[data-image-preview]");
  const image = preview?.querySelector("img");
  const label = document.querySelector(".file-image-zoom-label");
  const zoom = getOpenImageZoom(tab);
  const offset = getOpenImageOffset(tab);

  if (image instanceof HTMLElement) {
    image.style.setProperty("--image-zoom", String(zoom));
    image.style.setProperty("--image-x", `${offset.x}px`);
    image.style.setProperty("--image-y", `${offset.y}px`);
  }

  if (label) {
    label.textContent = getOpenImageZoomLabel(tab);
  }

  document.querySelectorAll("[data-image-zoom]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const action = button.getAttribute("data-image-zoom");
    button.disabled =
      (action === "out" && zoom <= FILE_IMAGE_MIN_ZOOM + 0.001) ||
      (action === "in" && zoom >= FILE_IMAGE_MAX_ZOOM - 0.001);
  });
}

function updateOpenImageTransform(tab, { zoom, offsetX, offsetY } = {}) {
  if (!tab || tab.status !== "image") {
    return;
  }

  const nextZoom = getOpenImageZoom({ imageZoom: zoom ?? tab.imageZoom });
  const shouldResetPan = nextZoom <= FILE_IMAGE_MIN_ZOOM + 0.001;
  setOpenImageTransform(tab, {
    zoom: nextZoom,
    offsetX: shouldResetPan ? 0 : offsetX ?? tab.imageOffsetX,
    offsetY: shouldResetPan ? 0 : offsetY ?? tab.imageOffsetY,
  });
  syncOpenFileStateFromTab(tab);
  syncOpenImageTransformDom(tab);
}

function zoomOpenImage(tab, nextZoom, anchorClientPoint = null) {
  if (!tab || tab.status !== "image") {
    return;
  }

  const preview = document.querySelector("[data-image-preview]");
  const currentZoom = getOpenImageZoom(tab);
  const zoom = getOpenImageZoom({ imageZoom: nextZoom });
  const currentOffset = getOpenImageOffset(tab);

  if (
    zoom <= FILE_IMAGE_MIN_ZOOM + 0.001 ||
    !(preview instanceof HTMLElement) ||
    !anchorClientPoint
  ) {
    updateOpenImageTransform(tab, {
      zoom,
      offsetX: zoom <= FILE_IMAGE_MIN_ZOOM + 0.001 ? 0 : currentOffset.x,
      offsetY: zoom <= FILE_IMAGE_MIN_ZOOM + 0.001 ? 0 : currentOffset.y,
    });
    return;
  }

  const rect = preview.getBoundingClientRect();
  const anchorX = anchorClientPoint.clientX - rect.left - rect.width / 2;
  const anchorY = anchorClientPoint.clientY - rect.top - rect.height / 2;
  const ratio = zoom / currentZoom;
  const nextOffsetX = anchorX - (anchorX - currentOffset.x) * ratio;
  const nextOffsetY = anchorY - (anchorY - currentOffset.y) * ratio;
  updateOpenImageTransform(tab, { zoom, offsetX: nextOffsetX, offsetY: nextOffsetY });
}

function bindImagePreviewEvents() {
  const preview = document.querySelector("[data-image-preview]");
  if (!(preview instanceof HTMLElement) || preview.dataset.bound === "true") {
    return;
  }

  preview.dataset.bound = "true";
  syncOpenImageTransformDom();
  preview.addEventListener(
    "wheel",
    (event) => {
      const activeTab = getActiveOpenFileTab();
      if (!activeTab || activeTab.status !== "image") {
        return;
      }

      event.preventDefault();
      const direction = event.deltaY > 0 ? -1 : 1;
      const multiplier = direction > 0 ? 1.12 : 1 / 1.12;
      zoomOpenImage(activeTab, getOpenImageZoom(activeTab) * multiplier, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    },
    { passive: false },
  );

  preview.addEventListener("pointerdown", (event) => {
    const activeTab = getActiveOpenFileTab();
    if (!activeTab || activeTab.status !== "image" || event.button !== 0) {
      return;
    }

    event.preventDefault();
    const startOffset = getOpenImageOffset(activeTab);
    const dragState = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: startOffset.x,
      offsetY: startOffset.y,
    };
    preview.dataset.dragging = JSON.stringify(dragState);
    preview.classList.add("is-panning");
    preview.setPointerCapture?.(event.pointerId);
  });

  preview.addEventListener("pointermove", (event) => {
    const activeTab = getActiveOpenFileTab();
    if (!activeTab || activeTab.status !== "image" || !preview.dataset.dragging) {
      return;
    }

    let dragState;
    try {
      dragState = JSON.parse(preview.dataset.dragging);
    } catch {
      dragState = null;
    }

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    updateOpenImageTransform(activeTab, {
      zoom: getOpenImageZoom(activeTab),
      offsetX: dragState.offsetX + event.clientX - dragState.clientX,
      offsetY: dragState.offsetY + event.clientY - dragState.clientY,
    });
  });

  const endPan = (event) => {
    if (preview.dataset.dragging) {
      preview.releasePointerCapture?.(event.pointerId);
    }
    preview.dataset.dragging = "";
    preview.classList.remove("is-panning");
  };

  preview.addEventListener("pointerup", endPan);
  preview.addEventListener("pointercancel", endPan);
  preview.addEventListener("lostpointercapture", () => {
    preview.dataset.dragging = "";
    preview.classList.remove("is-panning");
  });
}

function bindFileEditorEvents() {
  bindLineNumberEditors();
  bindImagePreviewEvents();

  document.querySelectorAll("[data-file-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      activateOpenFileTab(button.getAttribute("data-file-tab"));
    });
  });

  document.querySelectorAll("[data-close-file-tab]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeOpenFileTab(button.getAttribute("data-close-file-tab"));
    });
  });

  document.querySelector("#close-file-preview")?.addEventListener("click", () => {
    if (!confirmCloseOpenFileTabs(state.openFileTabs)) {
      return;
    }

    resetOpenFile();
    refreshFileTreeUi();
    refreshOpenFileUi();
  });

  document.querySelector("#open-file-editor")?.addEventListener("input", (event) => {
    const textarea = event.currentTarget;
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return;
    }

    const activeTab = getActiveOpenFileTab();
    if (!activeTab) {
      return;
    }

    activeTab.draft = textarea.value;
    syncOpenFileStateFromTab(activeTab);
    syncOpenFileEditorStateUi();
  });

  document.querySelector("#edit-open-file")?.addEventListener("click", () => {
    const activeTab = getActiveOpenFileTab();
    if (!activeTab) {
      return;
    }

    activeTab.viewMode = "edit";
    syncOpenFileStateFromTab(activeTab);
    refreshOpenFileUi();
  });

  document.querySelector("#preview-open-file")?.addEventListener("click", () => {
    const activeTab = getActiveOpenFileTab();
    if (!activeTab || isOpenFileDirty(activeTab)) {
      return;
    }

    activeTab.viewMode = "preview";
    syncOpenFileStateFromTab(activeTab);
    refreshOpenFileUi();
  });

  document.querySelector("#save-open-file")?.addEventListener("click", async () => {
    await saveOpenFile();
  });

  document.querySelector("#reload-open-file")?.addEventListener("click", async () => {
    await reloadOpenFile();
  });

  document.querySelector("#try-open-file-text")?.addEventListener("click", async () => {
    if (!state.openFileRelativePath) {
      return;
    }

    await openWorkspaceFile(state.openFileRelativePath, { force: true });
  });

  document.querySelectorAll("[data-image-zoom]").forEach((button) => {
    button.addEventListener("click", () => {
      const activeTab = getActiveOpenFileTab();
      if (!activeTab || activeTab.status !== "image") {
        return;
      }

      const action = button.getAttribute("data-image-zoom");
      if (action === "reset") {
        updateOpenImageTransform(activeTab, { zoom: 1, offsetX: 0, offsetY: 0 });
        return;
      }

      const nextZoom =
        action === "in"
          ? getOpenImageZoom(activeTab) + FILE_IMAGE_ZOOM_STEP
          : getOpenImageZoom(activeTab) - FILE_IMAGE_ZOOM_STEP;
      zoomOpenImage(activeTab, nextZoom);
    });
  });
}

function refreshToolbarUi() {
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const title = document.querySelector("#toolbar-title");
  const meta = document.querySelector("#toolbar-meta");
  const emptyState = document.querySelector("#empty-state");
  const canSend = Boolean(activeSession && activeSession.status !== "exited");

  if (title) {
    title.textContent = activeSession ? activeSession.name : "new session";
  }

  if (meta) {
    meta.textContent = activeSession
      ? `${activeSession.providerLabel} · ${activeSession.cwd}`
      : state.defaultCwd;
  }

  if (emptyState) {
    emptyState.classList.toggle("hidden", Boolean(activeSession));
  }

  document.querySelectorAll("[data-terminal-control]").forEach((button) => {
    button.disabled = !canSend;
  });

  refreshTerminalJumpUi();
}

function refreshShellUi({ sessions = true, ports = true, files = true } = {}) {
  refreshUpdateUi();
  refreshSystemToastsUi();
  refreshKnowledgeSettingsUi();

  if (sessions) {
    refreshSessionsList();
  }

  if (ports) {
    refreshPortsList();
  }

  if (files) {
    refreshFileTreeUi();
    refreshOpenFileUi();
  }

  refreshKnowledgeBaseUi();
  refreshToolbarUi();
}

async function openWorkspaceFile(relativePath, { force = false } = {}) {
  const normalizedPath = normalizeFileTreePath(relativePath);
  const root = state.filesRoot;
  const tab = ensureOpenFileTab(normalizedPath, { mode: "text" });

  if (!root || !normalizedPath || !tab) {
    return;
  }

  if (!force && tab.status === "text") {
    syncOpenFileStateFromTab(tab);
    refreshOpenFileUi();
    return;
  }

  const requestId = state.openFileRequestId + 1;
  state.openFileRequestId = requestId;
  tab.requestId = requestId;
  tab.status = "loading";
  tab.content = "";
  tab.draft = "";
  tab.message = "";
  tab.saving = false;
  syncOpenFileStateFromTab(tab);
  refreshFileTreeUi();
  refreshOpenFileUi();

  try {
    const payload = await fetchJson(`/api/files/text?${getFileTextRequestParams(normalizedPath).toString()}`);

    if (tab.requestId !== requestId || state.filesRoot !== root) {
      return;
    }

    tab.status = "text";
    tab.content = payload.file.content;
    tab.draft = payload.file.content;
    tab.message = "";
    tab.saving = false;
    if (state.openFileRelativePath === normalizedPath) {
      syncOpenFileStateFromTab(tab);
      refreshOpenFileUi();
    }
  } catch (error) {
    if (tab.requestId !== requestId || state.filesRoot !== root) {
      return;
    }

    if (error.status === 400 || error.status === 413) {
      tab.status = "external";
      tab.content = "";
      tab.draft = "";
      tab.message = "this file is not editable as UTF-8 text, but you can still open it raw";
      if (state.openFileRelativePath === normalizedPath) {
        syncOpenFileStateFromTab(tab);
        refreshOpenFileUi();
      }
      return;
    }

    tab.status = "error";
    tab.message = error.message;
    if (state.openFileRelativePath === normalizedPath) {
      syncOpenFileStateFromTab(tab);
      refreshOpenFileUi();
    }
  }
}

async function openWorkspaceFilePreview(relativePath, { mode = "text", force = false } = {}) {
  const normalizedPath = normalizeFileTreePath(relativePath);
  const tab = ensureOpenFileTab(normalizedPath, { mode });

  if (!tab) {
    return;
  }

  if (mode === "image") {
    tab.status = "image";
    tab.content = "";
    tab.draft = "";
    tab.message = "";
    tab.saving = false;
    syncOpenFileStateFromTab(tab);
    refreshFileTreeUi();
    refreshOpenFileUi();
    return;
  }

  if (mode === "raw") {
    tab.status = "external";
    tab.content = "";
    tab.draft = "";
    tab.message = "preview is not available for this file type, but you can still open it raw";
    tab.saving = false;
    syncOpenFileStateFromTab(tab);
    refreshFileTreeUi();
    refreshOpenFileUi();
    return;
  }

  await openWorkspaceFile(normalizedPath, { force });
}

function openPortPreview(portNumber) {
  if (!isLocalhostAppsEnabled()) {
    return;
  }

  const port = state.ports.find((entry) => entry.port === Number(portNumber));
  if (!port) {
    return;
  }

  const tab = ensureOpenFileTab(getPortPreviewTabId(port), {
    mode: "web",
    name: getPortDisplayName(port),
    url: getPortProxyUrl(port),
    externalUrl: getPortPrimaryUrl(port),
    port: port.port,
  });

  if (!tab) {
    return;
  }

  tab.status = "web";
  tab.content = "";
  tab.draft = "";
  tab.message = "";
  tab.saving = false;
  syncOpenFileStateFromTab(tab);
  refreshFileTreeUi();
  refreshOpenFileUi();
}

function activateOpenFileTab(relativePath) {
  const normalizedPath = normalizeFileTreePath(relativePath);
  const tab = state.openFileTabs.find((entry) => entry.relativePath === normalizedPath);
  if (!tab) {
    return;
  }

  syncOpenFileStateFromTab(tab);
  refreshFileTreeUi();
  refreshOpenFileUi();
}

function confirmCloseOpenFileTabs(tabs) {
  const dirtyTabs = tabs.filter((tab) => isOpenFileDirty(tab));
  if (!dirtyTabs.length) {
    return true;
  }

  const label = dirtyTabs.length === 1 ? dirtyTabs[0].name : `${dirtyTabs.length} files`;
  return window.confirm(`Close ${label} with unsaved changes?`);
}

function closeOpenFileTab(relativePath) {
  const normalizedPath = normalizeFileTreePath(relativePath);
  const tabIndex = state.openFileTabs.findIndex((entry) => entry.relativePath === normalizedPath);
  if (tabIndex < 0) {
    return;
  }

  if (!confirmCloseOpenFileTabs([state.openFileTabs[tabIndex]])) {
    return;
  }

  const closingActiveTab = state.openFileRelativePath === normalizedPath;
  state.openFileTabs.splice(tabIndex, 1);

  if (closingActiveTab) {
    const nextTab = state.openFileTabs[Math.min(tabIndex, state.openFileTabs.length - 1)] || null;
    syncOpenFileStateFromTab(nextTab);
  }

  refreshFileTreeUi();
  refreshOpenFileUi();
}

async function reloadOpenFile() {
  const activeTab = getActiveOpenFileTab();
  if (!state.openFileRelativePath || activeTab?.saving) {
    return;
  }

  if (activeTab?.status === "image" || activeTab?.status === "web") {
    refreshOpenFileUi();
    return;
  }

  await openWorkspaceFile(state.openFileRelativePath, { force: true });
}

async function saveOpenFile() {
  const activeTab = getActiveOpenFileTab();
  if (
    !state.filesRoot ||
    !state.openFileRelativePath ||
    activeTab?.status !== "text" ||
    activeTab.saving ||
    !isOpenFileDirty(activeTab)
  ) {
    return;
  }

  const root = state.filesRoot;
  const relativePath = state.openFileRelativePath;
  activeTab.saving = true;
  syncOpenFileStateFromTab(activeTab);
  syncOpenFileEditorStateUi();

  try {
    const payload = await fetchJson("/api/files/text", {
      method: "PUT",
      body: JSON.stringify({
        root,
        path: relativePath,
        content: activeTab.draft,
      }),
    });

    if (state.filesRoot !== root || activeTab.relativePath !== relativePath) {
      return;
    }

    activeTab.content = payload.file.content;
    activeTab.draft = payload.file.content;
    activeTab.message = "";
    if (state.openFileRelativePath === relativePath) {
      syncOpenFileStateFromTab(activeTab);
    }
  } catch (error) {
    window.alert(error.message);
  } finally {
    activeTab.saving = false;
    if (state.openFileRelativePath === relativePath) {
      syncOpenFileStateFromTab(activeTab);
    }
    syncOpenFileEditorStateUi();
  }
}

function startKnowledgeBaseNoteEdit() {
  if (!state.knowledgeBase.selectedNotePath || state.knowledgeBase.selectedNoteLoading) {
    return;
  }

  state.knowledgeBase.selectedNoteDraft = state.knowledgeBase.selectedNoteContent;
  state.knowledgeBase.selectedNoteEditing = true;
  state.knowledgeBase.selectedNoteSaving = false;
  renderShell();
}

function cancelKnowledgeBaseNoteEdit() {
  state.knowledgeBase.selectedNoteDraft = state.knowledgeBase.selectedNoteContent;
  state.knowledgeBase.selectedNoteEditing = false;
  state.knowledgeBase.selectedNoteSaving = false;
  renderShell();
}

async function saveKnowledgeBaseNote() {
  if (
    !state.knowledgeBase.rootPath ||
    !state.knowledgeBase.selectedNotePath ||
    !state.knowledgeBase.selectedNoteEditing ||
    state.knowledgeBase.selectedNoteSaving ||
    state.knowledgeBase.selectedNoteDraft === state.knowledgeBase.selectedNoteContent
  ) {
    return;
  }

  const root = state.knowledgeBase.rootPath;
  const relativePath = state.knowledgeBase.selectedNotePath;
  state.knowledgeBase.selectedNoteSaving = true;
  refreshKnowledgeBaseEditStateUi();

  try {
    await fetchJson("/api/files/text", {
      method: "PUT",
      body: JSON.stringify({
        root,
        path: relativePath,
        content: state.knowledgeBase.selectedNoteDraft,
      }),
    });

    if (state.knowledgeBase.rootPath !== root || state.knowledgeBase.selectedNotePath !== relativePath) {
      return;
    }

    await loadKnowledgeBaseIndex();
    await loadKnowledgeBaseNote(relativePath, { force: true });
    updateRoute({ view: "knowledge-base", notePath: relativePath });
    renderShell();
  } catch (error) {
    window.alert(error.message);
  } finally {
    state.knowledgeBase.selectedNoteSaving = false;
    refreshKnowledgeBaseEditStateUi();
  }
}

function refreshKnowledgeBaseEditStateUi() {
  const status = document.querySelector("#knowledge-base-edit-status");
  const saveButton = document.querySelector("#save-knowledge-base-note");
  const dirty = state.knowledgeBase.selectedNoteDraft !== state.knowledgeBase.selectedNoteContent;

  if (status) {
    status.textContent = state.knowledgeBase.selectedNoteSaving
      ? "saving changes..."
      : dirty
        ? "unsaved changes"
        : "saved";
  }

  if (saveButton instanceof HTMLButtonElement) {
    saveButton.disabled = !dirty || state.knowledgeBase.selectedNoteSaving;
    saveButton.textContent = state.knowledgeBase.selectedNoteSaving ? "saving..." : dirty ? "save" : "saved";
    saveButton.classList.toggle("primary-button", dirty);
    saveButton.classList.toggle("ghost-button", !dirty);
  }
}

async function loadFileTree(relativePath = "", { force = false } = {}) {
  const pathKey = normalizeFileTreePath(relativePath);
  const root = state.filesRoot;

  if (!root) {
    return;
  }

  if (!force && (state.fileTreeLoading.has(pathKey) || state.fileTreeEntries[pathKey])) {
    return;
  }

  state.fileTreeLoading.add(pathKey);

  if (pathKey === "") {
    state.fileTreeError = "";
  }

  refreshFileTreeUi();

  try {
    const params = new URLSearchParams();
    params.set("root", root);
    if (pathKey) {
      params.set("path", pathKey);
    }

    const payload = await fetchJson(`/api/files?${params.toString()}`);

    if (state.filesRoot !== root) {
      return;
    }

    state.fileTreeEntries[pathKey] = payload.entries;
    state.fileTreeError = "";
  } catch (error) {
    if (state.filesRoot !== root) {
      return;
    }

    if (pathKey) {
      state.fileTreeExpanded.delete(pathKey);
    }

    state.fileTreeError = error.message;
  } finally {
    if (state.filesRoot === root) {
      state.fileTreeLoading.delete(pathKey);
      refreshFileTreeUi();
    }
  }
}

async function refreshOpenFileTree({ force = false } = {}) {
  if (!state.filesRoot) {
    return;
  }

  const openPaths = Array.from(state.fileTreeExpanded);

  for (const relativePath of openPaths) {
    await loadFileTree(relativePath, { force });
  }
}

function scheduleSessionsRefresh() {
  if (state.sessionRefreshTimer) {
    return;
  }

  state.sessionRefreshTimer = window.setTimeout(() => {
    state.sessionRefreshTimer = null;
    refreshShellUi({ sessions: true, ports: false, files: false });
  }, 180);
}

function applyAgentPromptState(payload) {
  state.agentPrompt = payload?.prompt || "";
  state.agentPromptPath = payload?.promptPath || ".remote-vibes/agent-prompt.md";
  state.agentPromptWikiRoot = payload?.wikiRoot || state.settings.wikiRelativeRoot || ".remote-vibes/wiki";
  state.agentPromptTargets = Array.isArray(payload?.targets) ? payload.targets : [];
}

function applySettingsState(payload) {
  const settings = payload?.settings || payload || {};
  const backup = settings.wikiBackup || settings.backup || state.settings.wikiBackup;
  const sleepPrevention = settings.sleepPrevention || settings.sleep || state.settings.sleepPrevention;
  const agentMailStatus = settings.agentMailStatus || settings.agentMail || state.settings.agentMailStatus;
  const browserUseStatus = settings.browserUseStatus || settings.browserUse || state.settings.browserUseStatus;

  state.settings = {
    agentMailApiKeyConfigured:
      settings.agentMailApiKeyConfigured === undefined
        ? state.settings.agentMailApiKeyConfigured
        : Boolean(settings.agentMailApiKeyConfigured),
    agentMailClientId: settings.agentMailClientId || state.settings.agentMailClientId || "",
    agentMailDisplayName: settings.agentMailDisplayName || state.settings.agentMailDisplayName || "Remote Vibes",
    agentMailDomain:
      settings.agentMailDomain === undefined ? state.settings.agentMailDomain || "" : String(settings.agentMailDomain || ""),
    agentMailEnabled:
      settings.agentMailEnabled === undefined
        ? state.settings.agentMailEnabled
        : Boolean(settings.agentMailEnabled),
    agentMailInboxId:
      settings.agentMailInboxId === undefined ? state.settings.agentMailInboxId || "" : String(settings.agentMailInboxId || ""),
    agentMailMode: settings.agentMailMode || state.settings.agentMailMode || "websocket",
    agentMailProviderId: settings.agentMailProviderId || state.settings.agentMailProviderId || "claude",
    agentMailStatus: agentMailStatus || null,
    agentMailUsername:
      settings.agentMailUsername === undefined ? state.settings.agentMailUsername || "" : String(settings.agentMailUsername || ""),
    agentAutomations: Array.isArray(settings.agentAutomations)
      ? settings.agentAutomations
      : state.settings.agentAutomations || [],
    browserUseAnthropicApiKeyConfigured:
      settings.browserUseAnthropicApiKeyConfigured === undefined
        ? state.settings.browserUseAnthropicApiKeyConfigured
        : Boolean(settings.browserUseAnthropicApiKeyConfigured),
    browserUseBrowserPath:
      settings.browserUseBrowserPath === undefined
        ? state.settings.browserUseBrowserPath || ""
        : String(settings.browserUseBrowserPath || ""),
    browserUseEnabled:
      settings.browserUseEnabled === undefined
        ? state.settings.browserUseEnabled
        : Boolean(settings.browserUseEnabled),
    browserUseHeadless:
      settings.browserUseHeadless === undefined
        ? state.settings.browserUseHeadless
        : Boolean(settings.browserUseHeadless),
    browserUseKeepTabs:
      settings.browserUseKeepTabs === undefined
        ? state.settings.browserUseKeepTabs
        : Boolean(settings.browserUseKeepTabs),
    browserUseMaxTurns:
      settings.browserUseMaxTurns === undefined
        ? state.settings.browserUseMaxTurns || 50
        : Number(settings.browserUseMaxTurns) || 50,
    browserUseModel:
      settings.browserUseModel === undefined ? state.settings.browserUseModel || "" : String(settings.browserUseModel || ""),
    browserUseProfileDir:
      settings.browserUseProfileDir === undefined
        ? state.settings.browserUseProfileDir || ""
        : String(settings.browserUseProfileDir || ""),
    browserUseStatus: browserUseStatus || null,
    browserUseWorkerPath:
      settings.browserUseWorkerPath === undefined
        ? state.settings.browserUseWorkerPath || ""
        : String(settings.browserUseWorkerPath || ""),
    installedPluginIds: Array.isArray(settings.installedPluginIds)
      ? settings.installedPluginIds.map((pluginId) => String(pluginId || "")).filter(Boolean)
      : state.settings.installedPluginIds || [],
    preventSleepEnabled:
      settings.preventSleepEnabled === undefined
        ? state.settings.preventSleepEnabled
        : Boolean(settings.preventSleepEnabled),
    sleepPrevention: sleepPrevention || null,
    wikiPath: settings.wikiPath || state.settings.wikiPath || "",
    wikiPathConfigured: inferWikiPathConfigured(settings),
    wikiRelativeRoot:
      settings.wikiRelativeRoot ||
      settings.wikiRelativePath ||
      state.settings.wikiRelativeRoot ||
      ".remote-vibes/wiki",
    wikiGitBackupEnabled:
      settings.wikiGitBackupEnabled === undefined
        ? state.settings.wikiGitBackupEnabled
        : Boolean(settings.wikiGitBackupEnabled),
    wikiGitRemoteBranch: settings.wikiGitRemoteBranch || state.settings.wikiGitRemoteBranch || "main",
    wikiGitRemoteEnabled:
      settings.wikiGitRemoteEnabled === undefined
        ? state.settings.wikiGitRemoteEnabled
        : Boolean(settings.wikiGitRemoteEnabled),
    wikiGitRemoteName: settings.wikiGitRemoteName || state.settings.wikiGitRemoteName || "origin",
    wikiGitRemoteUrl:
      settings.wikiGitRemoteUrl === undefined ? state.settings.wikiGitRemoteUrl || "" : String(settings.wikiGitRemoteUrl || ""),
    wikiBackupIntervalMs:
      Number(settings.wikiBackupIntervalMs) ||
      state.settings.wikiBackupIntervalMs ||
      5 * 60 * 1000,
    wikiBackup: backup || null,
  };
  state.agentPromptWikiRoot = state.settings.wikiRelativeRoot;
}

function syncViewFromLocation() {
  const route = getRouteState();
  const previousView = state.currentView;
  state.currentView = route.view;

  if (route.view === "knowledge-base") {
    if (previousView !== "knowledge-base") {
      requestKnowledgeBaseGraphReplay();
    }
    state.knowledgeBase.selectedNotePath = route.notePath;
  }
}

function setCurrentView(nextView, { notePath = state.knowledgeBase.selectedNotePath } = {}) {
  const previousView = state.currentView;

  if (nextView === "knowledge-base") {
    state.currentView = "knowledge-base";
    if (previousView !== "knowledge-base") {
      requestKnowledgeBaseGraphReplay();
    }
    updateRoute({ view: "knowledge-base", notePath });
    return;
  }

  if (nextView === "agent-prompt") {
    state.currentView = "agent-prompt";
    updateRoute({ view: "agent-prompt" });
    return;
  }

  if (ROUTED_MAIN_VIEWS.has(nextView)) {
    state.currentView = nextView;
    updateRoute({ view: nextView });
    return;
  }

  state.currentView = "shell";
  updateRoute({ view: state.currentView });
}

async function openMainView(nextView) {
  if (nextView === "knowledge-base") {
    setCurrentView("knowledge-base");
    closeMobileSidebar();
    renderShell();

    if (!state.knowledgeBase.notes.length && !state.knowledgeBase.loading) {
      await loadKnowledgeBaseIndex();
    }

    await ensureKnowledgeBaseSelectionLoaded();
    updateRoute({ view: "knowledge-base", notePath: state.knowledgeBase.selectedNotePath });
    renderShell();
    return;
  }

  if (nextView === "agent-prompt") {
    setCurrentView("agent-prompt");
    closeMobileSidebar();
    renderShell();
    return;
  }

  if (ROUTED_MAIN_VIEWS.has(nextView)) {
    setCurrentView(nextView);
    closeMobileSidebar();
    renderShell();

    if (nextView === "search" && !state.knowledgeBase.notes.length && !state.knowledgeBase.loading) {
      await loadKnowledgeBaseIndex();
      renderShell();
    }

    if (nextView === "system") {
      await loadSystemMetrics({ forceRender: true });
    }

    return;
  }

  setCurrentView("shell");
  closeMobileSidebar();
  renderShell();

  if (state.activeSessionId) {
    connectToSession(state.activeSessionId);
  }
}

async function openSwarmGraph(sessionId, { refresh = false } = {}) {
  const selectedSession = state.sessions.find((session) => session.id === sessionId);
  if (!sessionId || !selectedSession) {
    return;
  }

  state.swarmGraph = {
    sessionId,
    projectCwd: "",
    projectFallbackSessionId: "",
    projectName: "",
    loading: true,
    error: "",
    data: refresh && state.swarmGraph.sessionId === sessionId ? state.swarmGraph.data : null,
  };
  setCurrentView("swarm");
  closeMobileSidebar();
  renderShell();

  try {
    const payload = await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/swarm`, {
      cache: "no-store",
    });
    state.swarmGraph = {
      sessionId,
      projectCwd: "",
      projectFallbackSessionId: "",
      projectName: "",
      loading: false,
      error: "",
      data: payload.graph,
    };
  } catch (error) {
    state.swarmGraph = {
      sessionId,
      projectCwd: "",
      projectFallbackSessionId: "",
      projectName: "",
      loading: false,
      error: error.message,
      data: state.swarmGraph.data,
    };
  }

  renderShell();
}

async function openSwarmProjectGraph(projectCwd, { fallbackSessionId = "", projectName = "", refresh = false } = {}) {
  const normalizedCwd = normalizeWorkspaceRoot(projectCwd);
  if (!normalizedCwd) {
    return;
  }

  const cacheMatches = state.swarmGraph.projectCwd === normalizedCwd && !state.swarmGraph.sessionId;
  state.swarmGraph = {
    sessionId: null,
    projectCwd: normalizedCwd,
    projectFallbackSessionId: fallbackSessionId,
    projectName,
    loading: true,
    error: "",
    data: refresh && cacheMatches ? state.swarmGraph.data : null,
  };
  setCurrentView("swarm");
  closeMobileSidebar();
  renderShell();

  try {
    const params = new URLSearchParams({ cwd: normalizedCwd });
    let payload;
    try {
      payload = await fetchJson(`/api/projects/swarm?${params.toString()}`, {
        cache: "no-store",
      });
    } catch (error) {
      if (error.status !== 404 || !fallbackSessionId) {
        throw error;
      }

      payload = await fetchJson(`/api/sessions/${encodeURIComponent(fallbackSessionId)}/swarm`, {
        cache: "no-store",
      });
    }
    state.swarmGraph = {
      sessionId: null,
      projectCwd: normalizedCwd,
      projectFallbackSessionId: fallbackSessionId,
      projectName,
      loading: false,
      error: "",
      data: payload.graph,
    };
  } catch (error) {
    state.swarmGraph = {
      sessionId: null,
      projectCwd: normalizedCwd,
      projectFallbackSessionId: fallbackSessionId,
      projectName,
      loading: false,
      error: error.message,
      data: state.swarmGraph.data,
    };
  }

  renderShell();
}

async function loadBrowserUseSession(browserUseSessionId, { silent = false } = {}) {
  if (!browserUseSessionId) {
    return;
  }

  if (!silent) {
    state.browserUseSession = {
      id: browserUseSessionId,
      loading: true,
      error: "",
      data: state.browserUseSession.id === browserUseSessionId ? state.browserUseSession.data : null,
    };
    setCurrentView("browser-use");
    closeMobileSidebar();
    renderShell();
  }

  try {
    const payload = await fetchJson(`/api/browser-use/sessions/${encodeURIComponent(browserUseSessionId)}`, {
      cache: "no-store",
    });
    state.browserUseSession = {
      id: browserUseSessionId,
      loading: false,
      error: "",
      data: payload.session,
    };
  } catch (error) {
    state.browserUseSession = {
      id: browserUseSessionId,
      loading: false,
      error: error.message,
      data: state.browserUseSession.id === browserUseSessionId ? state.browserUseSession.data : null,
    };
  }

  if (state.currentView === "browser-use" && state.browserUseSession.id === browserUseSessionId) {
    renderShell();
  }
}

async function openBrowserUseSession(browserUseSessionId) {
  await loadBrowserUseSession(browserUseSessionId);
}

function removeBrowserUseSessionFromState(browserUseSessionId) {
  state.sessions = state.sessions.map((session) => ({
    ...session,
    subagents: Array.isArray(session.subagents)
      ? session.subagents.filter((subagent) => subagent.browserUseSessionId !== browserUseSessionId)
      : session.subagents,
  }));
}

async function deleteBrowserUseSession(browserUseSessionId) {
  if (!browserUseSessionId) {
    return;
  }

  await fetchJson(`/api/browser-use/sessions/${encodeURIComponent(browserUseSessionId)}`, {
    method: "DELETE",
  });

  removeBrowserUseSessionFromState(browserUseSessionId);

  if (state.browserUseSession.id === browserUseSessionId) {
    state.browserUseSession = {
      id: "",
      loading: false,
      error: "",
      data: null,
    };
    setCurrentView("shell");
    renderShell();
    if (state.activeSessionId) {
      connectToSession(state.activeSessionId);
    }
    return;
  }

  refreshSessionsList({ force: true });
}

function closeSessionProviderPicker() {
  const picker = document.querySelector("[data-session-provider-picker]");
  const trigger = document.querySelector("[data-session-provider-trigger]");
  picker?.classList.remove("is-open");
  trigger?.setAttribute("aria-expanded", "false");
}

function bindSessionProviderPicker() {
  const picker = document.querySelector("[data-session-provider-picker]");
  const trigger = document.querySelector("[data-session-provider-trigger]");

  if (!picker || !(trigger instanceof HTMLButtonElement)) {
    return;
  }

  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const nextOpen = !picker.classList.contains("is-open");
    picker.classList.toggle("is-open", nextOpen);
    trigger.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  });

  document.querySelectorAll("[data-session-provider-option]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!(button instanceof HTMLButtonElement) || button.disabled) {
        return;
      }

      const providerId = button.getAttribute("data-session-provider-option") || "";
      if (!providerId) {
        return;
      }

      state.defaultProviderId = providerId;
      closeSessionProviderPicker();
      renderShell();
    });
  });
}

function ensureSessionProviderPickerGlobalListeners() {
  if (state.sessionProviderPickerGlobalListenersBound) {
    return;
  }

  state.sessionProviderPickerGlobalListenersBound = true;
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("[data-session-provider-picker]")) {
      return;
    }
    closeSessionProviderPicker();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSessionProviderPicker();
    }
  });
}

function setFolderPickerPanelPosition(panel, position) {
  panel.style.setProperty("--folder-picker-x", `${Math.round(position.x)}px`);
  panel.style.setProperty("--folder-picker-y", `${Math.round(position.y)}px`);
}

function clampFolderPickerDragDelta(value, min, max) {
  if (min > max) {
    return (min + max) / 2;
  }

  return clamp(value, min, max);
}

function getClampedFolderPickerPosition(startPosition, startRect, deltaX, deltaY) {
  const minDeltaX = FOLDER_PICKER_DRAG_MARGIN_PX - startRect.left;
  const maxDeltaX = window.innerWidth - FOLDER_PICKER_DRAG_MARGIN_PX - startRect.right;
  const minDeltaY = FOLDER_PICKER_DRAG_MARGIN_PX - startRect.top;
  const maxDeltaY = window.innerHeight - FOLDER_PICKER_DRAG_MARGIN_PX - startRect.bottom;

  return {
    x: startPosition.x + clampFolderPickerDragDelta(deltaX, minDeltaX, maxDeltaX),
    y: startPosition.y + clampFolderPickerDragDelta(deltaY, minDeltaY, maxDeltaY),
  };
}

function syncFolderPickerDragPosition() {
  if (!state.folderPicker.position) {
    return;
  }

  const panel = document.querySelector("[data-folder-picker-panel]");
  if (!(panel instanceof HTMLElement)) {
    return;
  }

  const position = getFolderPickerDragPosition();
  const nextPosition = getClampedFolderPickerPosition(position, panel.getBoundingClientRect(), 0, 0);
  state.folderPicker.position = nextPosition;
  setFolderPickerPanelPosition(panel, nextPosition);
}

function bindFolderPickerDragEvents() {
  const handle = document.querySelector("[data-folder-picker-drag-handle]");
  const panel = document.querySelector("[data-folder-picker-panel]");

  if (!(handle instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
    return;
  }

  syncFolderPickerDragPosition();

  handle.addEventListener("pointerdown", (event) => {
    if (event.button != null && event.button !== 0) {
      return;
    }

    const target = event.target;
    if (target instanceof Element && target.closest("button, input, textarea, select, a")) {
      return;
    }

    const pointerId = event.pointerId;
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startPosition = getFolderPickerDragPosition();
    const startRect = panel.getBoundingClientRect();
    const controller = new AbortController();

    panel.classList.add("is-dragging");

    const onPointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }

      const nextPosition = getClampedFolderPickerPosition(
        startPosition,
        startRect,
        moveEvent.clientX - startClientX,
        moveEvent.clientY - startClientY,
      );
      state.folderPicker.position = nextPosition;

      const activePanel = document.querySelector("[data-folder-picker-panel]");
      if (activePanel instanceof HTMLElement) {
        setFolderPickerPanelPosition(activePanel, nextPosition);
      }

      moveEvent.preventDefault();
    };

    const onPointerEnd = (endEvent) => {
      if (endEvent.pointerId !== pointerId) {
        return;
      }

      panel.classList.remove("is-dragging");
      controller.abort();
    };

    window.addEventListener("pointermove", onPointerMove, { signal: controller.signal });
    window.addEventListener("pointerup", onPointerEnd, { signal: controller.signal });
    window.addEventListener("pointercancel", onPointerEnd, { signal: controller.signal });

    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // Some browsers skip pointer capture for detached/replaced nodes during rerenders.
    }

    event.preventDefault();
  });
}

function bindShellEvents() {
  bindLineNumberEditors();
  ensureSessionProviderPickerGlobalListeners();
  bindSessionProviderPicker();
  bindFolderPickerDragEvents();
  bindLayoutResizeEvents();

  document.querySelectorAll("[data-open-main-view]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const nextView = link.getAttribute("data-open-main-view") || "shell";
      void openMainView(nextView);
    });
  });

  document.querySelectorAll("[data-folder-picker-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = button.getAttribute("data-folder-picker-target") || "session";
      const isWikiTarget = target === "wiki" || target === "wiki-onboarding";
      if (target === "session") {
        state.defaultProviderId = getSelectedSessionProviderId();
      }

      const input =
        target === "wiki-onboarding"
          ? document.querySelector("#brain-folder-input")
          : target === "wiki"
            ? document.querySelector("#wiki-path-input")
          : target === "files"
            ? document.querySelector("#files-root-input")
            : null;
      const initialPath =
        input instanceof HTMLInputElement && input.value.trim()
          ? input.value.trim()
          : isWikiTarget
            ? target === "wiki-onboarding"
              ? state.defaultCwd || state.settings.wikiPath
              : state.settings.wikiPath || state.defaultCwd
            : target === "files"
              ? state.filesRoot || state.defaultCwd
              : state.defaultCwd;

      await loadFolderPicker(initialPath, { target });
    });
  });

  document.querySelectorAll("[data-close-folder-picker]").forEach((element) => {
    element.addEventListener("click", () => {
      state.folderPicker.open = false;
      renderShell();
    });
  });

  document.querySelectorAll("[data-folder-picker-select]").forEach((button) => {
    button.addEventListener("click", async () => {
      await selectFolderPickerPath(
        button.getAttribute("data-folder-picker-select") || "",
        button.getAttribute("data-folder-picker-path") || "",
      );
    });
  });

  document.querySelector("#folder-picker-up")?.addEventListener("click", async () => {
    const parentPath = getWorkspaceParentPath(getFolderPickerCurrentPath());
    if (!parentPath) {
      return;
    }

    await loadFolderPicker(parentPath, {
      target: state.folderPicker.target,
    });
  });

  document.querySelector("#folder-picker-select")?.addEventListener("click", async () => {
    try {
      await applyFolderPickerSelection();
    } catch (error) {
      window.alert(error.message);
    }
  });

  document.querySelector("#folder-create-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const folderName = String(formData.get("folderName") || "");

    try {
      await createFolderFromPicker(folderName);
    } catch (error) {
      window.alert(error.message);
    }
  });

  bindSessionEvents();
  bindPortEvents();
  bindFileTreeEvents();
  bindSearchResultEvents();
  bindPluginCardEvents();
  bindAutomationEvents();
  bindUpdateEvents();
  bindSystemToastEvents();

  document.querySelector("#global-search-input")?.addEventListener("input", (event) => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    state.globalSearchQuery = input.value;
    refreshGlobalSearchUi();
  });

  document.querySelector("#plugin-search-input")?.addEventListener("input", (event) => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    state.pluginSearchQuery = input.value;
    refreshPluginSearchUi();
  });

  if (state.currentView === "shell") {
    document.querySelector("#tab-button")?.addEventListener("click", () => sendTerminalInput("\t"));
    document.querySelector("#shift-tab-button")?.addEventListener("click", () => sendTerminalInput("\u001b[Z"));
    document.querySelector("#ctrl-p-button")?.addEventListener("click", () => sendTerminalInput("\u0010"));
    document.querySelector("#ctrl-t-button")?.addEventListener("click", () => sendTerminalInput("\u0014"));
    document.querySelector("#ctrl-c-button")?.addEventListener("click", () => sendTerminalInput("\u0003"));
    document.querySelector("#jump-to-bottom")?.addEventListener("click", () => {
      scrollTerminalToBottom();
    });
  }

  document.querySelector("#refresh-swarm-graph")?.addEventListener("click", () => {
    if (state.swarmGraph.projectCwd) {
      void openSwarmProjectGraph(state.swarmGraph.projectCwd, {
        fallbackSessionId: state.swarmGraph.projectFallbackSessionId || state.swarmGraph.data?.sessionId || "",
        projectName: state.swarmGraph.projectName,
        refresh: true,
      });
    } else if (state.swarmGraph.sessionId) {
      void openSwarmGraph(state.swarmGraph.sessionId, { refresh: true });
    }
  });
  document.querySelector("#swarm-back-to-session")?.addEventListener("click", () => {
    setCurrentView("shell");
    renderShell();
    if (state.activeSessionId) {
      connectToSession(state.activeSessionId);
    }
  });
  document.querySelector("#refresh-browser-use-session")?.addEventListener("click", () => {
    if (state.browserUseSession.id) {
      void loadBrowserUseSession(state.browserUseSession.id);
    }
  });
  document.querySelector("#delete-browser-use-session")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const browserUseSessionId = state.browserUseSession.id;
    if (!browserUseSessionId) {
      return;
    }

    if (button instanceof HTMLButtonElement) {
      button.disabled = true;
    }

    try {
      await deleteBrowserUseSession(browserUseSessionId);
    } catch (error) {
      if (button instanceof HTMLButtonElement) {
        button.disabled = false;
      }
      window.alert(error.message);
    }
  });
  document.querySelector("#browser-use-back-to-session")?.addEventListener("click", () => {
    setCurrentView("shell");
    renderShell();
    if (state.activeSessionId) {
      connectToSession(state.activeSessionId);
    }
  });

  document.querySelector("#refresh-sessions")?.addEventListener("click", () => loadSessions());
  document.querySelector("#refresh-agent-prompt")?.addEventListener("click", async () => {
    const textarea = document.querySelector("#agent-prompt-textarea");
    const hasUnsavedChanges = textarea instanceof HTMLTextAreaElement && textarea.value !== state.agentPrompt;

    if (hasUnsavedChanges && !window.confirm("You have unsaved edits in the prompt editor. Reload from disk and discard them?")) {
      return;
    }

    try {
      const payload = await fetchJson("/api/agent-prompt/reload", { method: "POST" });
      applyAgentPromptState(payload);
      renderShell();
    } catch (error) {
      window.alert(error.message);
    }
  });
  document.querySelector("#agent-prompt-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const textarea = document.querySelector("#agent-prompt-textarea");
    const prompt = textarea instanceof HTMLTextAreaElement ? textarea.value : "";

    try {
      const payload = await fetchJson("/api/agent-prompt", {
        method: "PUT",
        body: JSON.stringify({
          prompt,
        }),
      });

      applyAgentPromptState(payload);
      renderShell();
    } catch (error) {
      window.alert(error.message);
    }
  });
  document.querySelector("#settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;

    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    try {
      await saveSettingsFromForm(form);
      renderShell();
    } catch (error) {
      window.alert(error.message);
    }
  });
  document.querySelector("#brain-git-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;

    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const formData = new FormData(form);
    const remoteUrl = String(formData.get("remoteUrl") || "").trim();
    const wikiPath = String(formData.get("wikiPath") || "").trim();
    state.brainSetupCloneUrl = remoteUrl;
    state.brainSetupClonePath = wikiPath;
    state.brainSetupCloning = true;
    state.brainSetupError = "";
    renderShell();

    try {
      await cloneBrainFromGit({ remoteUrl, wikiPath });
    } catch (error) {
      state.brainSetupCloning = false;
      state.brainSetupError = error.message;
      renderShell();
    }
  });
  bindBrowserUseForm();
  document.querySelector("#backup-wiki-now")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button instanceof HTMLButtonElement) {
      button.disabled = true;
      button.textContent = "backing up...";
    }

    try {
      await backupWikiNow();
      renderShell();
    } catch (error) {
      window.alert(error.message);
      if (button instanceof HTMLButtonElement) {
        button.disabled = false;
        button.textContent = "backup now";
      }
    }
  });
  document.querySelector("#refresh-files")?.addEventListener("click", async () => {
    syncFilesRoot({ force: true });
    refreshFileTreeUi();
    await refreshOpenFileTree({ force: true });
  });
  document.querySelector("#files-root-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const formData = new FormData(form);
    await applyFilesRoot(String(formData.get("root") || ""), { force: true });
  });
  document.querySelector("#files-root-input")?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    input.value = state.filesRoot || state.defaultCwd || "";
    input.blur();
    refreshFileTreeUi();
  });
  document.querySelector("#auto-files-root")?.addEventListener("click", async () => {
    await applyFilesRoot("", { force: true });
  });
  document.querySelector("#refresh-ports")?.addEventListener("click", () => loadPorts());
  document.querySelector("#refresh-system")?.addEventListener("click", () => {
    void loadSystemMetrics({ forceRender: true });
  });
  document.querySelectorAll("[data-system-history-range]").forEach((button) => {
    button.addEventListener("click", () => {
      const range = button.getAttribute("data-system-history-range") || "1h";
      if (range === state.systemHistoryRange) {
        return;
      }

      state.systemHistoryRange = range;
      state.systemMetricHistory = [];
      state.systemHistoryMeta = null;
      state.systemHistoryLoadedAt = 0;
      void loadSystemMetricHistory({ forceRender: true });
    });
  });
  document.querySelector("#open-sidebar")?.addEventListener("click", () => setMobileSidebar("left"));
  document.querySelector("#close-left-sidebar")?.addEventListener("click", () => closeMobileSidebar());
  document.querySelector("[data-sidebar-scrim]")?.addEventListener("click", () => closeMobileSidebar());
  document.querySelector("#relaunch-app")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    if (!window.confirm("Relaunch Remote Vibes on this laptop? Live sessions will be restored if persistence is enabled.")) {
      return;
    }

    const terminateButton = document.querySelector("#terminate-app");
    if (terminateButton instanceof HTMLButtonElement) {
      terminateButton.disabled = true;
    }

    button.disabled = true;
    button.textContent = "relaunching...";

    try {
      await fetchJson("/api/relaunch", { method: "POST" });
      closeWebsocket();
      const recovered = await waitForAppRecovery();
      if (!recovered) {
        throw new Error("Remote Vibes did not come back yet. Try refreshing in a moment.");
      }
      window.location.reload();
    } catch (error) {
      button.disabled = false;
      button.textContent = "relaunch";
      if (terminateButton instanceof HTMLButtonElement) {
        terminateButton.disabled = false;
      }
      window.alert(error.message);
    }
  });
  document.querySelector("#terminate-app")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    if (!window.confirm("Terminate Remote Vibes on this laptop?")) {
      return;
    }

    button.disabled = true;
    button.textContent = "stopping...";

    try {
      await fetchJson("/api/terminate", { method: "POST" });
      closeWebsocket();
      window.setTimeout(() => {
        window.location.reload();
      }, 250);
    } catch (error) {
      button.disabled = false;
      button.textContent = "terminate";
      window.alert(error.message);
    }
  });
}

function bindUpdateEvents() {
  document.querySelector("#update-app")?.addEventListener("click", async () => {
    if (!state.update?.canUpdate || state.updateApplying) {
      return;
    }

    state.updateApplying = true;
    refreshUpdateUi({ force: true });

    try {
      const payload = await fetchJson("/api/update/apply", { method: "POST" });
      state.update = payload.update ?? state.update;
      waitForUpdateRestart();
    } catch (error) {
      state.updateApplying = false;
      state.lastUpdateError = {
        message: error.message,
        occurredAt: new Date().toISOString(),
      };
      state.update = {
        ...(state.update || {}),
        updateAvailable: true,
        canUpdate: false,
        status: "blocked",
        reason: error.message,
      };
      refreshUpdateUi({ force: true });
      refreshSystemToastsUi({ force: true });
    }
  });
}

function waitForUpdateRestart() {
  let sawShutdown = false;
  let attempts = 0;

  const timer = window.setInterval(async () => {
    attempts += 1;

    try {
      await fetchJson("/api/state", { cache: "no-store" });
      if (sawShutdown) {
        window.clearInterval(timer);
        window.location.reload();
      }
    } catch {
      sawShutdown = true;
    }

    if (attempts > 90) {
      window.clearInterval(timer);
      state.updateApplying = false;
      void loadUpdateStatus({ force: true });
    }
  }, 2000);
}

function clearWebsocketReconnectTimer() {
  if (!state.websocketReconnectTimer) {
    return;
  }

  window.clearTimeout(state.websocketReconnectTimer);
  state.websocketReconnectTimer = null;
}

function shouldReconnectTerminalSession(sessionId) {
  return Boolean(
    sessionId &&
      state.currentView === "shell" &&
      state.activeSessionId === sessionId &&
      state.terminal &&
      !state.updateApplying,
  );
}

function scheduleTerminalWebsocketReconnect(sessionId) {
  if (!shouldReconnectTerminalSession(sessionId)) {
    return;
  }

  clearWebsocketReconnectTimer();
  state.websocketReconnectAttempts += 1;
  state.websocketReconnectSessionId = sessionId;
  const delay = Math.min(
    TERMINAL_WEBSOCKET_RECONNECT_BASE_MS * 2 ** Math.max(0, state.websocketReconnectAttempts - 1),
    TERMINAL_WEBSOCKET_RECONNECT_MAX_MS,
  );

  state.websocketReconnectTimer = window.setTimeout(() => {
    state.websocketReconnectTimer = null;
    if (!shouldReconnectTerminalSession(sessionId)) {
      return;
    }

    connectToSession(sessionId);
  }, delay);
}

function closeWebsocket() {
  clearWebsocketReconnectTimer();
  clearPendingTerminalOutput();

  if (state.websocket) {
    state.websocket.close();
    state.websocket = null;
  }

  state.connectedSessionId = null;
  state.websocketReconnectSessionId = "";
  state.terminalShowJumpToBottom = false;
  refreshTerminalJumpUi();
}

function disposeTerminal() {
  closeWebsocket();
  cleanupTerminalInteractions();
  clearTerminalTranscriptHistory();
  hideTerminalFilePreview();
  try {
    state.terminalFileLinkDisposable?.dispose?.();
  } catch {
    // Best-effort cleanup only.
  }
  state.terminalFileLinkDisposable = null;
  state.terminalResizeObserver?.disconnect();
  state.terminalResizeObserver = null;

  if (state.canvasAddon) {
    try {
      state.canvasAddon.dispose();
    } catch (error) {
      console.warn("[remote-vibes] canvas renderer disposal failed", error);
    }
    state.canvasAddon = null;
  }

  if (state.fitAddon?.dispose) {
    try {
      state.fitAddon.dispose();
    } catch (error) {
      console.warn("[remote-vibes] fit addon disposal failed", error);
    }
  }
  state.fitAddon = null;

  if (state.terminal) {
    try {
      state.terminal.dispose();
    } catch (error) {
      console.warn("[remote-vibes] terminal disposal failed", error);
    }
    state.terminal = null;
  }

  try {
    state.terminalSelectionDisposable?.dispose?.();
  } catch {
    // Best-effort cleanup only.
  }
  state.terminalSelectionDisposable = null;
}

function observeTerminalMount(mount) {
  state.terminalResizeObserver?.disconnect();
  state.terminalResizeObserver = null;

  if (!mount || typeof ResizeObserver === "undefined") {
    return;
  }

  state.terminalResizeObserver = new ResizeObserver(() => {
    fitTerminalSoon();
  });

  state.terminalResizeObserver.observe(mount);
}

function loadCanvasRenderer() {
  if (!state.terminal || !shouldUseCanvasRenderer()) {
    return;
  }

  state.canvasAddon = null;

  try {
    const canvasAddon = new CanvasAddon();
    state.terminal.loadAddon(canvasAddon);
    state.canvasAddon = canvasAddon;
  } catch (error) {
    console.warn("[remote-vibes] canvas renderer unavailable", error);
  }
}

function setupTerminalInteractions(mount) {
  cleanupTerminalInteractions();

  const viewport = mount.querySelector(".xterm-viewport");
  const transcriptViewport = getTerminalTranscriptViewport();
  const helperTextarea = mount.querySelector(".xterm-helper-textarea");
  if (!viewport) {
    return;
  }

  configureTerminalTextarea(helperTextarea);

  const touchState = {
    maxDistance: 0,
    moved: false,
    startY: 0,
  };
  const focusTerminalInput = () => {
    configureTerminalTextarea(helperTextarea);
    if (helperTextarea instanceof HTMLTextAreaElement) {
      try {
        helperTextarea.focus({ preventScroll: true });
      } catch {
        helperTextarea.focus();
      }
    } else {
      state.terminal?.focus();
    }
  };

  const handlePointerDown = (event) => {
    if (event.pointerType && event.pointerType !== "mouse") {
      return;
    }

    focusTerminalInput();
  };

  const handleTouchStart = (event) => {
    if (event.touches.length !== 1) {
      return;
    }

    const touch = event.touches[0];
    touchState.startY = touch.pageY;
    touchState.maxDistance = 0;
    touchState.moved = false;
  };

  const handleTouchMove = (event) => {
    if (event.touches.length !== 1) {
      return;
    }

    const touch = event.touches[0];
    touchState.maxDistance = Math.max(touchState.maxDistance, Math.abs(touch.pageY - touchState.startY));

    if (touchState.maxDistance >= TOUCH_TAP_SLOP_PX) {
      touchState.moved = true;
    }
  };

  const finishTouch = () => {
    if (getUiNow() < state.mobileKeyboardSettlingUntil) {
      return;
    }

    if (!touchState.moved && touchState.maxDistance < TOUCH_TAP_SLOP_PX) {
      focusTerminalInput();
    }
  };

  const handleTouchEnd = () => {
    finishTouch();
  };

  const handleTouchCancel = () => {
    touchState.moved = false;
    touchState.maxDistance = 0;
  };

  const handleViewportScroll = () => {
    window.requestAnimationFrame(() => {
      syncTerminalScrollState();
    });
  };

  const handleTranscriptFallbackWheel = (event) => {
    routeTerminalTranscriptWheel(event);
  };

  const handleTranscriptClick = () => {
    focusTerminalInput();
  };

  const handleBeforeInput = (event) => {
    const currentValue = helperTextarea?.value || "";

    if (event.inputType === "insertReplacementText") {
      event.preventDefault();
      scheduleTerminalTextareaReset();
      return;
    }

    if (
      !isCoarsePointerDevice() ||
      state.terminalComposing ||
      event.inputType !== "insertText" ||
      typeof event.data !== "string" ||
      !currentValue ||
      !event.data.startsWith(currentValue)
    ) {
      return;
    }

    event.preventDefault();
    const nextText = event.data.slice(currentValue.length);
    if (nextText) {
      sendTerminalInput(nextText);
    }
    scheduleTerminalTextareaReset();
  };

  const handleCompositionStart = () => {
    state.terminalComposing = true;

    if (state.terminalTextareaResetTimer) {
      window.clearTimeout(state.terminalTextareaResetTimer);
      state.terminalTextareaResetTimer = null;
    }
  };

  const handleCompositionEnd = () => {
    window.setTimeout(() => {
      state.terminalComposing = false;
      scheduleTerminalTextareaReset();
    }, 0);
  };

  const handleTerminalFocus = () => {
    configureTerminalTextarea(helperTextarea);
    scheduleTerminalTextareaReset();
    syncViewportMetrics();
    fitTerminalSoon();
  };

  const handleTerminalBlur = () => {
    state.terminalComposing = false;
    if (state.terminalTextareaResetTimer) {
      window.clearTimeout(state.terminalTextareaResetTimer);
      state.terminalTextareaResetTimer = null;
    }
  };

  mount.addEventListener("pointerdown", handlePointerDown);
  mount.addEventListener("wheel", handleTranscriptFallbackWheel, { capture: true, passive: false });
  transcriptViewport?.addEventListener("wheel", handleTranscriptFallbackWheel, { capture: true, passive: false });
  transcriptViewport?.addEventListener("click", handleTranscriptClick);
  viewport.addEventListener("scroll", handleViewportScroll, { passive: true });
  viewport.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true });
  viewport.addEventListener("touchmove", handleTouchMove, { capture: true, passive: true });
  viewport.addEventListener("touchend", handleTouchEnd, { capture: true, passive: true });
  viewport.addEventListener("touchcancel", handleTouchCancel, { capture: true, passive: true });
  helperTextarea?.addEventListener("beforeinput", handleBeforeInput, { capture: true });
  helperTextarea?.addEventListener("compositionstart", handleCompositionStart);
  helperTextarea?.addEventListener("compositionend", handleCompositionEnd);
  helperTextarea?.addEventListener("focus", handleTerminalFocus);
  helperTextarea?.addEventListener("blur", handleTerminalBlur);

  state.terminalInteractionCleanup = () => {
    mount.removeEventListener("pointerdown", handlePointerDown);
    mount.removeEventListener("wheel", handleTranscriptFallbackWheel, true);
    transcriptViewport?.removeEventListener("wheel", handleTranscriptFallbackWheel, true);
    transcriptViewport?.removeEventListener("click", handleTranscriptClick);
    viewport.removeEventListener("scroll", handleViewportScroll);
    viewport.removeEventListener("touchstart", handleTouchStart, true);
    viewport.removeEventListener("touchmove", handleTouchMove, true);
    viewport.removeEventListener("touchend", handleTouchEnd, true);
    viewport.removeEventListener("touchcancel", handleTouchCancel, true);
    helperTextarea?.removeEventListener("beforeinput", handleBeforeInput, true);
    helperTextarea?.removeEventListener("compositionstart", handleCompositionStart);
    helperTextarea?.removeEventListener("compositionend", handleCompositionEnd);
    helperTextarea?.removeEventListener("focus", handleTerminalFocus);
    helperTextarea?.removeEventListener("blur", handleTerminalBlur);
  };
}

function mountTerminal() {
  const mount = document.querySelector("#terminal-mount");
  if (!mount) {
    return;
  }

  if (state.terminal && mount.querySelector(".xterm")) {
    observeTerminalMount(mount);
    applyTerminalDisplayProfile(mount);
    setupTerminalInteractions(mount);
    renderTerminalTranscriptHistory();
    fitTerminalSoon();

    if (state.activeSessionId) {
      connectToSession(state.activeSessionId);
    }

    syncTerminalScrollState();
    return;
  }

  disposeTerminal();
  observeTerminalMount(mount);

  state.terminal = new Terminal({
    allowProposedApi: false,
    allowTransparency: false,
    cursorBlink: true,
    customGlyphs: true,
    fontFamily: '"IBM Plex Mono", monospace',
    fontSize: getTerminalDisplayProfile(mount).fontSize,
    lineHeight: getTerminalDisplayProfile(mount).lineHeight,
    linkHandler: buildTerminalLinkHandler(),
    macOptionIsMeta: true,
    scrollSensitivity: getTerminalDisplayProfile(mount).scrollSensitivity,
    scrollback: 5000,
    smoothScrollDuration: getTerminalDisplayProfile(mount).smoothScrollDuration,
    theme: TERMINAL_THEME,
  });

  state.fitAddon = new FitAddon();
  state.terminal.loadAddon(state.fitAddon);
  state.terminalSelectionDisposable = state.terminal.onSelectionChange?.(() => {
    if (!state.terminal?.hasSelection?.()) {
      scheduleSelectableRefreshFlush(40);
    }
  });
  state.terminal.open(mount);
  installTerminalFileLinkProvider();
  configureTerminalTextarea(state.terminal.textarea);
  resetTerminalTextarea();
  applyTerminalDisplayProfile(mount);
  loadCanvasRenderer();
  setupTerminalInteractions(mount);
  renderTerminalTranscriptHistory({ scrollToBottom: true });
  fitTerminalSoon();
  window.setTimeout(() => fitTerminalSoon(), 60);
  window.setTimeout(() => fitTerminalSoon(), 220);
  window.setTimeout(() => {
    state.terminal?.refresh(0, state.terminal.rows - 1);
  }, 260);
  document.fonts?.ready
    ?.then(() => {
      fitTerminalSoon();
      state.terminal?.refresh(0, state.terminal.rows - 1);
    })
    .catch(() => {});

  state.terminal.onData((data) => {
    if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    hideTerminalTranscriptOverlay();
    state.websocket.send(JSON.stringify({ type: "input", data }));
    scheduleTerminalTextareaReset();
  });

  state.terminal.onScroll(() => {
    window.requestAnimationFrame(() => {
      syncTerminalScrollState();
    });
  });

  if (!state.resizeBound) {
    const handleResize = () => {
      const mount = document.querySelector("#terminal-mount");
      syncViewportMetrics();
      refreshLayoutUi();
      applyTerminalDisplayProfile(mount);
      fitTerminalSoon();
    };
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        syncViewportMetrics();
        fitTerminalSoon();
      }
    });
    syncViewportMetrics();
    state.resizeBound = true;
  }

  if (state.activeSessionId) {
    connectToSession(state.activeSessionId);
  }

  syncTerminalScrollState();
}

function sendResize() {
  if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN || !state.terminal) {
    return;
  }

  state.websocket.send(
    JSON.stringify({
      type: "resize",
      cols: state.terminal.cols,
      rows: state.terminal.rows,
    }),
  );
}

function connectToSession(sessionId) {
  if (!state.terminal || !sessionId) {
    return;
  }

  if (
    state.connectedSessionId === sessionId &&
    state.websocket &&
    state.websocket.readyState < WebSocket.CLOSING
  ) {
    return;
  }

  closeWebsocket();
  clearPendingTerminalOutput();
  clearTerminalTranscriptHistory();
  state.terminal.reset();
  state.terminalShowJumpToBottom = false;
  refreshTerminalJumpUi();
  state.connectedSessionId = sessionId;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(
    `${protocol}://${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`,
  );
  state.websocket = socket;

  socket.addEventListener("open", () => {
    if (state.websocket !== socket) {
      return;
    }

    state.websocketReconnectAttempts = 0;
    state.websocketReconnectSessionId = "";
    fitTerminalSoon();
    if (!isCoarsePointerDevice()) {
      state.terminal.focus();
    }
    syncTerminalScrollState();
  });

  socket.addEventListener("message", (event) => {
    if (state.websocket !== socket) {
      return;
    }

    const payload = JSON.parse(event.data);

    if (payload.type === "snapshot") {
      setTerminalTranscriptHistory(payload.data || "", { scrollToBottom: true });
      queueTerminalOutput(payload.data || "", { mirrorTranscript: false, scrollToBottom: true });
      updateSession(payload.session);
      return;
    }

    if (payload.type === "output") {
      queueTerminalOutput(payload.data || "");
      return;
    }

    if (payload.type === "session") {
      updateSession(payload.session);
      return;
    }

    if (payload.type === "session-deleted") {
      state.sessions = state.sessions.filter((session) => session.id !== payload.sessionId);
      if (state.activeSessionId === payload.sessionId) {
        state.activeSessionId = state.sessions[0]?.id ?? null;
        renderShell();
        if (state.activeSessionId) {
          connectToSession(state.activeSessionId);
        }
      }
      return;
    }

    if (payload.type === "error") {
      const errorLine = `\r\n[remote-vibes] ${payload.message}\r\n`;
      appendTerminalTranscriptOutput(errorLine, { scrollToBottom: true });
      state.terminal.write(errorLine);
      if (/session not found/i.test(payload.message || "")) {
        closeWebsocket();
        void loadSessions();
      }
    }
  });

  socket.addEventListener("close", () => {
    if (state.websocket !== socket) {
      return;
    }

    state.websocket = null;
    state.connectedSessionId = null;
    scheduleTerminalWebsocketReconnect(sessionId);
  });

  socket.addEventListener("error", () => {
    if (state.websocket !== socket) {
      return;
    }

    try {
      socket.close();
    } catch {
      scheduleTerminalWebsocketReconnect(sessionId);
    }
  });
}

function updateSession(session) {
  const index = state.sessions.findIndex((entry) => entry.id === session.id);
  if (index === -1) {
    state.sessions.unshift(session);
  } else {
    state.sessions[index] = session;
  }

  if (shouldMarkSessionRead(session.id)) {
    markSessionRead(session, { refresh: false });
  }

  refreshToolbarUi();
  scheduleSessionsRefresh();
}

function updatePort(port) {
  if (!isLocalhostAppsEnabled()) {
    return;
  }

  const index = state.ports.findIndex((entry) => entry.port === port.port);
  if (index === -1) {
    state.ports = [...state.ports, port].sort((left, right) => left.port - right.port);
  } else {
    state.ports[index] = port;
  }

  const previewTab = state.openFileTabs.find((entry) => entry.relativePath === getPortPreviewTabId(port));
  if (previewTab) {
    previewTab.name = getPortDisplayName(port);
    previewTab.url = getPortProxyUrl(port);
    previewTab.externalUrl = getPortPrimaryUrl(port);
    previewTab.port = port.port;
    if (state.openFileRelativePath === previewTab.relativePath) {
      syncOpenFileStateFromTab(previewTab);
    }
  }
}

function syncOpenPortPreviewTabs() {
  for (const tab of state.openFileTabs) {
    if (tab.mode !== "web" || !tab.port) {
      continue;
    }

    const port = state.ports.find((entry) => entry.port === tab.port);
    if (!port) {
      continue;
    }

    tab.name = getPortDisplayName(port);
    tab.url = getPortProxyUrl(port);
    tab.externalUrl = getPortPrimaryUrl(port);
    if (state.openFileRelativePath === tab.relativePath) {
      syncOpenFileStateFromTab(tab);
    }
  }
}

function closePortPreviewTabs() {
  const previousTabs = state.openFileTabs;
  const activePath = normalizeFileTreePath(state.openFileRelativePath);
  const activePortTabIndex = previousTabs.findIndex(
    (tab) => tab.relativePath === activePath && tab.mode === "web" && tab.port,
  );
  const nextTabs = previousTabs.filter((tab) => tab.mode !== "web" || !tab.port);

  if (nextTabs.length === previousTabs.length) {
    return false;
  }

  state.openFileTabs = nextTabs;

  if (activePortTabIndex >= 0) {
    syncOpenFileStateFromTab(nextTabs[Math.min(activePortTabIndex, nextTabs.length - 1)] || null);
  }

  refreshFileTreeUi();
  refreshOpenFileUi();
  return true;
}

function clearLocalhostAppsSurfaces() {
  const hadPorts = state.ports.length > 0;
  state.ports = [];
  state.portsLoadedAt = Date.now();
  return closePortPreviewTabs() || hadPorts;
}

async function loadSessions() {
  try {
    const previousActiveSessionId = state.activeSessionId;
    const payload = await fetchJson("/api/sessions");
    state.sessions = payload.sessions;
    pruneSessionReadState();

    if (state.activeSessionId && !state.sessions.some((session) => session.id === state.activeSessionId)) {
      state.activeSessionId = state.sessions[0]?.id ?? null;
    }

    if (!state.activeSessionId && state.sessions.length) {
      state.activeSessionId = state.sessions[0].id;
    }

    if (state.currentView === "browser-use" && state.browserUseSession.id && !state.browserUseSession.loading) {
      void loadBrowserUseSession(state.browserUseSession.id, { silent: true });
    }

    if (state.currentView !== "shell") {
      refreshSessionsList();
      return;
    }

    if (!document.querySelector("#terminal-mount")) {
      renderShell();
      if (state.activeSessionId) {
        connectToSession(state.activeSessionId);
      }
      return;
    }

    if (previousActiveSessionId !== state.activeSessionId) {
      renderShell();
      if (state.activeSessionId) {
        connectToSession(state.activeSessionId);
      }
      return;
    }

    refreshShellUi({ sessions: true, ports: false, files: false });
    if (state.activeSessionId && !state.connectedSessionId) {
      connectToSession(state.activeSessionId);
    }
  } catch (error) {
    console.error(error);
  }
}

async function loadPorts() {
  if (!isLocalhostAppsEnabled()) {
    clearLocalhostAppsSurfaces();
    return;
  }

  try {
    const payload = await fetchJson("/api/ports");
    state.ports = payload.ports ?? [];
    state.portsLoadedAt = Date.now();
    syncOpenPortPreviewTabs();
    refreshShellUi({ sessions: false, ports: true, files: false });
  } catch (error) {
    console.error(error);
  }
}

async function loadUpdateStatus({ force = false } = {}) {
  try {
    const payload = await fetchJson(`/api/update/status${force ? "?force=1" : ""}`, {
      cache: "no-store",
    });
    state.update = payload.update;
    if (state.update?.status !== "error") {
      state.lastUpdateError = null;
    }
  } catch (error) {
    state.lastUpdateError = {
      message: error.message,
      occurredAt: new Date().toISOString(),
    };
    state.update = {
      status: "error",
      updateAvailable: false,
      canUpdate: false,
      reason: error.message,
    };
  }

  refreshUpdateUi();
  refreshSystemToastsUi();
}

async function loadSettingsStatus() {
  try {
    const wasLocalhostAppsEnabled = isLocalhostAppsEnabled();
    const payload = await fetchJson("/api/settings", {
      cache: "no-store",
    });
    applySettingsState(payload.settings);
    const localhostAppsEnabled = isLocalhostAppsEnabled();

    if (wasLocalhostAppsEnabled !== localhostAppsEnabled) {
      if (!localhostAppsEnabled) {
        clearLocalhostAppsSurfaces();
      }
      renderShell();
      if (localhostAppsEnabled) {
        void loadPorts();
      }
      return;
    }

    refreshKnowledgeSettingsUi();
    if (state.currentView === "plugins") {
      refreshPluginSearchUi();
      refreshBrowserUsePluginUi();
    }
    refreshSystemToastsUi();
  } catch (error) {
    console.error(error);
  }
}

function normalizeSystemMetricHistorySample(sample) {
  return createSystemMetricHistorySample(sample);
}

async function loadSystemMetricHistory({ forceRender = false, renderOnComplete = true } = {}) {
  const requestId = Date.now();
  state.systemHistoryLoading = true;
  state.systemHistoryRequestId = requestId;

  if (state.currentView === "system" && forceRender) {
    renderShell();
  }

  try {
    const payload = await fetchJson(`/api/system/history?range=${encodeURIComponent(state.systemHistoryRange)}`, {
      cache: "no-store",
    });

    if (state.systemHistoryRequestId !== requestId) {
      return;
    }

    const history = payload.history || {};
    state.systemMetricHistory = (Array.isArray(history.samples) ? history.samples : [])
      .map((sample) => normalizeSystemMetricHistorySample(sample))
      .filter(Boolean);
    state.systemHistoryMeta = {
      range: history.range || state.systemHistoryRange,
      windowMs: Number(history.windowMs || 0),
      from: history.from || "",
      to: history.to || "",
      sampleCount: Number(history.sampleCount ?? state.systemMetricHistory.length),
      rawSampleCount: Number(history.rawSampleCount ?? state.systemMetricHistory.length),
      minSampleIntervalMs: Number(history.minSampleIntervalMs || 0),
    };
    state.systemHistoryLoadedAt = Date.now();
    state.systemHistoryError = "";
  } catch (error) {
    if (state.systemHistoryRequestId !== requestId) {
      return;
    }

    state.systemHistoryError = error.message || "Could not load system history.";
  } finally {
    if (state.systemHistoryRequestId === requestId) {
      state.systemHistoryLoading = false;
      if (renderOnComplete && state.currentView === "system") {
        if (shouldDeferSelectableRefresh({ force: forceRender })) {
          deferSelectableRefresh("system-view");
        } else {
          renderShell();
        }
      }
    }
  }
}

async function loadSystemMetrics({ forceRender = false } = {}) {
  const requestId = Date.now();
  state.systemMetricsLoading = true;
  state.systemMetricsRequestId = requestId;

  if (state.currentView === "system" && (forceRender || (!state.systemMetrics && !hasActiveUserTextSelection()))) {
    renderShell();
  }

  try {
    const payload = await fetchJson("/api/system", {
      cache: "no-store",
    });

    if (state.systemMetricsRequestId !== requestId) {
      return;
    }

    state.systemMetrics = payload.system || null;
    state.systemMetricsError = "";
    if (
      forceRender
      || !state.systemHistoryLoadedAt
      || Date.now() - state.systemHistoryLoadedAt > SYSTEM_HISTORY_REFRESH_MS
    ) {
      await loadSystemMetricHistory({ renderOnComplete: false });
    }
  } catch (error) {
    if (state.systemMetricsRequestId !== requestId) {
      return;
    }

    state.systemMetricsError = error.message || "Could not load system metrics.";
  } finally {
    if (state.systemMetricsRequestId === requestId) {
      state.systemMetricsLoading = false;
      if (state.currentView === "system") {
        if (shouldDeferSelectableRefresh({ force: forceRender })) {
          deferSelectableRefresh("system-view");
        } else {
          renderShell();
        }
      }
    }
  }
}

async function loadFolderPicker(root, { target = state.folderPicker.target } = {}) {
  const nextRoot = normalizeWorkspaceRoot(root || state.defaultCwd || "/");
  const requestId = state.folderPicker.requestId + 1;
  state.folderPicker = {
    ...state.folderPicker,
    currentPath: nextRoot,
    entries: [],
    error: "",
    loading: true,
    open: true,
    parentPath: getWorkspaceParentPath(nextRoot),
    path: "",
    root: nextRoot,
    target,
    treeEntries: {},
    treeExpanded: new Set([""]),
    treeLoading: new Set(),
    treeErrors: {},
    requestId,
  };
  renderShell();

  await loadFolderPickerTreePath("");
}

async function selectFolderPickerPath(relativePath = "", absolutePath = "") {
  const pathKey = normalizeFileTreePath(relativePath);
  const nextPath = normalizeWorkspaceRoot(absolutePath || getFolderPickerAbsolutePath(pathKey));
  const wasExpanded = state.folderPicker.treeExpanded.has(pathKey);

  state.folderPicker.currentPath = nextPath || state.folderPicker.root;
  state.folderPicker.path = pathKey;
  state.folderPicker.parentPath = getWorkspaceParentPath(state.folderPicker.currentPath);
  if (wasExpanded) {
    state.folderPicker.treeExpanded.delete(pathKey);
  } else {
    state.folderPicker.treeExpanded.add(pathKey);
  }
  renderShell();

  if (!wasExpanded) {
    await loadFolderPickerTreePath(pathKey);
  }
}

async function loadFolderPickerTreePath(relativePath = "", { force = false } = {}) {
  const pathKey = normalizeFileTreePath(relativePath);
  const requestRoot = state.folderPicker.root;
  const requestId = state.folderPicker.requestId;

  if (!requestRoot || !state.folderPicker.open) {
    return;
  }

  if (!force && (state.folderPicker.treeLoading.has(pathKey) || state.folderPicker.treeEntries[pathKey])) {
    return;
  }

  state.folderPicker.treeLoading.add(pathKey);
  delete state.folderPicker.treeErrors[pathKey];
  if (pathKey === "") {
    state.folderPicker.loading = true;
    state.folderPicker.error = "";
  }
  renderShell();

  try {
    const params = new URLSearchParams();
    params.set("root", requestRoot);
    if (pathKey) {
      params.set("path", pathKey);
    }
    const payload = await fetchJson(`/api/folders?${params.toString()}`);

    if (!state.folderPicker.open || state.folderPicker.requestId !== requestId) {
      return;
    }

    const normalizedPayloadPath = normalizeFileTreePath(payload.relativePath || pathKey);
    state.folderPicker = {
      ...state.folderPicker,
      currentPath:
        normalizedPayloadPath === state.folderPicker.path
          ? payload.currentPath || state.folderPicker.currentPath
          : state.folderPicker.currentPath,
      entries: Array.isArray(payload.entries) ? payload.entries : [],
      error: "",
      loading: false,
      parentPath:
        normalizedPayloadPath === state.folderPicker.path
          ? payload.parentPath || getWorkspaceParentPath(state.folderPicker.currentPath)
          : state.folderPicker.parentPath,
      path:
        normalizedPayloadPath === state.folderPicker.path
          ? normalizedPayloadPath
          : state.folderPicker.path,
      root: payload.root || requestRoot,
      treeEntries: {
        ...state.folderPicker.treeEntries,
        [normalizedPayloadPath]: Array.isArray(payload.entries) ? payload.entries : [],
      },
    };
  } catch (error) {
    if (!state.folderPicker.open || state.folderPicker.requestId !== requestId) {
      return;
    }

    const treeErrors = {
      ...state.folderPicker.treeErrors,
      [pathKey]: error.message,
    };
    state.folderPicker = {
      ...state.folderPicker,
      entries: pathKey ? state.folderPicker.entries : [],
      error: pathKey ? state.folderPicker.error : error.message,
      loading: pathKey ? state.folderPicker.loading : false,
      treeErrors,
    };
  } finally {
    if (state.folderPicker.open && state.folderPicker.requestId === requestId) {
      state.folderPicker.treeLoading.delete(pathKey);
      if (pathKey === "") {
        state.folderPicker.loading = false;
      }
    }
  }

  renderShell();
}

async function saveSettingsFromForm(form) {
  const formData = new FormData(form);
  const payload = await fetchJson("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      preventSleepEnabled: formData.get("preventSleepEnabled") === "on",
      wikiGitBackupEnabled: formData.get("wikiGitBackupEnabled") === "on",
      wikiGitRemoteBranch: String(formData.get("wikiGitRemoteBranch") || "main"),
      wikiGitRemoteEnabled: formData.get("wikiGitRemoteEnabled") === "on",
      wikiGitRemoteName: String(formData.get("wikiGitRemoteName") || "origin"),
      wikiGitRemoteUrl: String(formData.get("wikiGitRemoteUrl") || ""),
      wikiPath: String(formData.get("wikiPath") || ""),
      wikiPathConfigured: Boolean(String(formData.get("wikiPath") || "").trim()),
    }),
  });

  applySettingsState(payload.settings);
  state.settings.wikiPath = wikiPath;
  state.settings.wikiPathConfigured = true;
  applyAgentPromptState(payload.agentPrompt);
  state.knowledgeBase.noteCache = {};

  if (state.currentView === "knowledge-base") {
    await loadKnowledgeBaseIndex();
    await ensureKnowledgeBaseSelectionLoaded({ force: true });
  }
}

async function saveBrainFolderSelection(selectedPath) {
  const wikiPath = normalizeWorkspaceRoot(selectedPath);
  if (!wikiPath) {
    throw new Error("Choose or create a brain folder first.");
  }

  const payload = await fetchJson("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      wikiPath,
      wikiPathConfigured: true,
    }),
  });

  applySettingsState(payload.settings);
  state.settings.wikiPath = payload.settings?.wikiPath || state.settings.wikiPath;
  state.settings.wikiPathConfigured = true;
  applyAgentPromptState(payload.agentPrompt);
  state.knowledgeBase.noteCache = {};
  state.folderPicker.open = false;
  setCurrentView("knowledge-base");
  await loadKnowledgeBaseIndex();
  await ensureKnowledgeBaseSelectionLoaded({ force: true });
  renderShell();
}

async function cloneBrainFromGit({ remoteUrl, wikiPath = "" }) {
  const payload = await fetchJson("/api/wiki/clone", {
    method: "POST",
    body: JSON.stringify({
      remoteUrl,
      wikiPath,
    }),
  });

  applySettingsState(payload.settings);
  applyAgentPromptState(payload.agentPrompt);
  state.knowledgeBase.noteCache = {};
  state.folderPicker.open = false;
  state.brainSetupCloning = false;
  state.brainSetupError = "";
  setCurrentView("knowledge-base");
  await loadKnowledgeBaseIndex();
  await ensureKnowledgeBaseSelectionLoaded({ force: true });
  renderShell();
}

async function setupBrowserUseFromForm(form) {
  const formData = new FormData(form);
  const apiKey = String(formData.get("browserUseAnthropicApiKey") || "").trim();
  const payload = await fetchJson("/api/browser-use/setup", {
    method: "POST",
    body: JSON.stringify({
      anthropicApiKey: apiKey || undefined,
      browserPath: String(formData.get("browserUseBrowserPath") || ""),
      enabled: formData.get("browserUseEnabled") === "on",
      headless: formData.get("browserUseHeadless") === "on",
      installedPluginIds: getUpdatedInstalledPluginIds("browser-use", formData.get("browserUseEnabled") === "on"),
      keepTabs: formData.get("browserUseKeepTabs") === "on",
      maxTurns: String(formData.get("browserUseMaxTurns") || ""),
      model: String(formData.get("browserUseModel") || ""),
      profileDir: String(formData.get("browserUseProfileDir") || ""),
      workerPath: String(formData.get("browserUseWorkerPath") || ""),
    }),
  });
  applySettingsState(payload.settings);
}

async function backupWikiNow() {
  const payload = await fetchJson("/api/wiki/backup", {
    method: "POST",
  });

  applySettingsState(payload.settings || { wikiBackup: payload.backup });
}

async function updateWikiBackupAutomation(enabled) {
  const payload = await fetchJson("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      wikiGitBackupEnabled: Boolean(enabled),
    }),
  });

  applySettingsState(payload.settings);
  applyAgentPromptState(payload.agentPrompt);
}

function renderFileEditorPage() {
  document.title = state.openFileName
    ? `${state.openFileName} · Remote Vibes`
    : "File Editor · Remote Vibes";

  app.innerHTML = `
    <main class="screen file-editor-screen">
      <section class="file-editor-page-shell">
        <div class="file-editor-page-toolbar">
          <div class="file-editor-page-copy">
            <strong>${escapeHtml(state.openFileName || "file editor")}</strong>
            <div class="file-editor-page-root" title="${escapeHtml(state.filesRoot || state.defaultCwd || "")}">${escapeHtml(
              state.filesRoot || state.defaultCwd || "",
            )}</div>
          </div>
          <a class="ghost-button file-editor-page-link" href="${escapeHtml(getWorkspaceUrl())}">workspace</a>
        </div>
        <div class="file-editor-page-body">
          <div class="file-editor" id="file-editor">${renderOpenFilePanel()}</div>
        </div>
      </section>
      ${renderSystemToasts()}
    </main>
  `;

  bindFileEditorEvents();
  bindSystemToastEvents();
}

async function bootstrapApp() {
  try {
    installTerminalDisposalGuard();
    installDelayedTooltips();
    bindSelectableRefreshEvents();

    if ("virtualKeyboard" in navigator) {
      navigator.virtualKeyboard.overlaysContent = false;
    }
  } catch (error) {
    console.warn("[remote-vibes] virtual keyboard API unavailable", error);
  }

  syncViewportMetrics();
  syncViewFromLocation();
  const payload = await fetchJson("/api/state");
  state.providers = payload.providers;
  state.sessions = payload.sessions;
  pruneSessionReadState();
  state.defaultCwd = payload.cwd;
  state.defaultProviderId = payload.defaultProviderId;
  applySettingsState(payload.settings);
  state.ports = isLocalhostAppsEnabled() ? (payload.ports ?? []) : [];
  state.portsLoadedAt = Date.now();
  state.preferredBaseUrl = payload.preferredUrl ? new URL(payload.preferredUrl).origin : "";
  applyAgentPromptState(payload.agentPrompt);

  if (maybeRedirectToPreferredOrigin()) {
    return;
  }

  const route = getRouteState();
  state.filesRootOverride = route.root || null;
  state.activeSessionId = payload.sessions[0]?.id ?? null;
  syncFilesRoot({ force: true });

  if (route.view === "file" && !isBrainSetupRequired()) {
    setOpenFileSelection(route.path, {
      status: route.path ? "loading" : "idle",
      message: "",
    });
    renderFileEditorPage();

    if (route.path) {
      await openWorkspaceFile(route.path, { force: true });
    } else {
      refreshOpenFileUi();
    }
    return;
  }

  if (state.currentView === "knowledge-base" && !isBrainSetupRequired()) {
    await loadKnowledgeBaseIndex();
    await ensureKnowledgeBaseSelectionLoaded();
    updateRoute({ view: "knowledge-base", notePath: state.knowledgeBase.selectedNotePath });
  }

  renderShell();
  if (state.currentView === "system") {
    void loadSystemMetrics({ forceRender: true });
  }
  void loadUpdateStatus();

  if (state.updateTimer) {
    window.clearInterval(state.updateTimer);
  }

  state.updateTimer = window.setInterval(() => {
    void loadUpdateStatus({ force: true });
  }, 5 * 60 * 1000);

  if (state.settingsPollTimer) {
    window.clearInterval(state.settingsPollTimer);
  }

  state.settingsPollTimer = window.setInterval(() => {
    void loadSettingsStatus();
  }, 30 * 1000);

  if (state.activeSessionId && state.currentView === "shell") {
    connectToSession(state.activeSessionId);
  }

  window.addEventListener("hashchange", async () => {
    syncViewFromLocation();

    renderShell();
    if (state.currentView === "shell" && state.activeSessionId) {
      connectToSession(state.activeSessionId);
    }
  });

  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
  }

  state.pollTimer = window.setInterval(() => {
    loadSessions();
    if (isLocalhostAppsEnabled() && Date.now() - state.portsLoadedAt > PORTS_BACKGROUND_REFRESH_MS) {
      loadPorts();
    }
    if (state.currentView === "system") {
      void loadSystemMetrics();
    }
  }, 3000);
}

bootstrapApp();
