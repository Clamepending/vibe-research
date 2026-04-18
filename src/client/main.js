import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "xterm-addon-canvas";

const app = document.querySelector("#app");
const TOUCH_TAP_SLOP_PX = 10;
const KNOWLEDGE_BASE_GRAPH_WIDTH = 920;
const KNOWLEDGE_BASE_GRAPH_HEIGHT = 680;
const KNOWLEDGE_BASE_GRAPH_MIN_SCALE = 0.35;
const KNOWLEDGE_BASE_GRAPH_MAX_SCALE = 2.8;
const KNOWLEDGE_BASE_GRAPH_FIT_PADDING = 72;
const KNOWLEDGE_BASE_GRAPH_FOCUS_SCALE = 1.65;
const KNOWLEDGE_BASE_GRAPH_DRAG_SLOP_PX = 6;
const PORT_PREVIEW_TAB_PREFIX = "port:";
const ROUTED_MAIN_VIEWS = new Set(["search", "plugins", "automations", "system"]);
const SYSTEM_HISTORY_LIMIT = 48;
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
    name: "GitHub",
    category: "Coding",
    description: "Triage PRs, inspect issues, and publish changes from agent sessions.",
    status: "available in Codex",
    source: "plugin",
  },
  {
    name: "Google Drive",
    category: "Knowledge",
    description: "Search Docs, Sheets, Slides, and shared project files when the host agent supports it.",
    status: "MCP-ready",
    source: "mcp",
  },
  {
    name: "Google Calendar",
    category: "Planning",
    description: "Look up events and availability from connected agent tooling.",
    status: "MCP-ready",
    source: "mcp",
  },
  {
    name: "Stripe",
    category: "Business",
    description: "Use official Stripe docs and account tools from capable coding agents.",
    status: "available in Codex",
    source: "plugin",
  },
  {
    name: "AgentMail",
    category: "Communication",
    description: "Give Remote Vibes an email inbox and wake a Claude session when mail arrives.",
    status: "setup available",
    source: "remote-vibes",
  },
  {
    name: "Slack",
    category: "Team",
    description: "A placeholder for chat-driven workflows once Remote Vibes exposes imported MCPs directly.",
    status: "coming soon",
    source: "mcp",
  },
  {
    name: "Figma",
    category: "Design",
    description: "Design-to-code workflows belong here when a local MCP is configured for the agent.",
    status: "coming soon",
    source: "mcp",
  },
  {
    name: "Localhost Apps",
    category: "Remote Vibes",
    description: "Preview web apps from discovered ports without leaving the current session.",
    status: "built in",
    source: "remote-vibes",
  },
  {
    name: "Knowledge Base",
    category: "Remote Vibes",
    description: "Search and edit the shared markdown wiki that agents receive in their prompt.",
    status: "built in",
    source: "remote-vibes",
  },
];
const KNOWLEDGE_BASE_GRAPH_COLOR_PALETTE = [
  {
    fill: "rgba(104, 227, 199, 0.28)",
    stroke: "rgba(104, 227, 199, 0.72)",
    label: "#dffaf2",
    connectedFill: "rgba(104, 227, 199, 0.38)",
    connectedStroke: "rgba(104, 227, 199, 0.86)",
    edge: "rgba(104, 227, 199, 0.22)",
  },
  {
    fill: "rgba(112, 175, 255, 0.24)",
    stroke: "rgba(112, 175, 255, 0.7)",
    label: "#d9e8ff",
    connectedFill: "rgba(112, 175, 255, 0.34)",
    connectedStroke: "rgba(112, 175, 255, 0.82)",
    edge: "rgba(112, 175, 255, 0.2)",
  },
  {
    fill: "rgba(243, 195, 106, 0.24)",
    stroke: "rgba(243, 195, 106, 0.72)",
    label: "#fff0c8",
    connectedFill: "rgba(243, 195, 106, 0.34)",
    connectedStroke: "rgba(243, 195, 106, 0.84)",
    edge: "rgba(243, 195, 106, 0.2)",
  },
  {
    fill: "rgba(255, 150, 118, 0.24)",
    stroke: "rgba(255, 150, 118, 0.7)",
    label: "#ffe1d8",
    connectedFill: "rgba(255, 150, 118, 0.34)",
    connectedStroke: "rgba(255, 150, 118, 0.82)",
    edge: "rgba(255, 150, 118, 0.2)",
  },
  {
    fill: "rgba(154, 214, 127, 0.24)",
    stroke: "rgba(154, 214, 127, 0.68)",
    label: "#ebffd8",
    connectedFill: "rgba(154, 214, 127, 0.34)",
    connectedStroke: "rgba(154, 214, 127, 0.8)",
    edge: "rgba(154, 214, 127, 0.2)",
  },
  {
    fill: "rgba(246, 138, 182, 0.24)",
    stroke: "rgba(246, 138, 182, 0.68)",
    label: "#ffe0ec",
    connectedFill: "rgba(246, 138, 182, 0.34)",
    connectedStroke: "rgba(246, 138, 182, 0.8)",
    edge: "rgba(246, 138, 182, 0.2)",
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

const state = {
  providers: [],
  sessions: [],
  sessionReadAt: loadSessionReadState(),
  ports: [],
  currentView: "shell",
  globalSearchQuery: "",
  pluginSearchQuery: "",
  agentPrompt: "",
  agentPromptPath: "",
  agentPromptWikiRoot: ".remote-vibes/wiki",
  agentPromptTargets: [],
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
    preventSleepEnabled: true,
    sleepPrevention: null,
    wikiPath: "",
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
  },
  sessionProjectExpanded: new Set(),
  sessionProjectInteractionSeen: false,
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
  terminal: null,
  fitAddon: null,
  pollTimer: null,
  resizeBound: false,
  mobileSidebar: null,
  terminalResizeObserver: null,
  pendingTerminalOutput: "",
  pendingTerminalScrollToBottom: false,
  terminalOutputFrame: null,
  terminalComposing: false,
  terminalTextareaResetTimer: null,
  update: null,
  updateApplying: false,
  lastUpdateError: null,
  systemMetrics: null,
  systemMetricHistory: [],
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
  preferredBaseUrl: "",
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

function timestampMs(timestamp) {
  const value = Date.parse(timestamp || "");
  return Number.isFinite(value) ? value : 0;
}

function getSessionReadAt(sessionId) {
  return Number(state.sessionReadAt[sessionId] || 0);
}

function getSessionUnreadAt(session) {
  return Math.max(
    timestampMs(session?.activityCompletedAt),
    timestampMs(session?.lastOutputAt),
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

function getMetricPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, 0, 100) : 0;
}

function getSessionLabel(session) {
  if (session.status === "exited") {
    return { text: "exited", className: "exited", title: "session exited" };
  }

  if (session.activityStatus === "working") {
    return { text: "working", className: "working", title: "agent is working" };
  }

  if (isSessionUnread(session)) {
    return { text: "done", className: "unread", title: "agent finished; unread" };
  }

  return { text: "read", className: "read", title: "read" };
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

function fitTerminalSoon() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const mount = document.querySelector("#terminal-mount");
      if (!state.fitAddon || !state.terminal || !mount) {
        return;
      }

      if (mount.clientWidth < 20 || mount.clientHeight < 20) {
        return;
      }

      state.fitAddon.fit();
      sendResize();
    });
  });
}

function cleanupTerminalInteractions() {
  state.terminalInteractionCleanup?.();
  state.terminalInteractionCleanup = null;
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
}

function getTerminalDisplayProfile(mount) {
  const width = mount?.clientWidth ?? window.innerWidth;

  if (width <= 420) {
    return {
      fontSize: 12,
      lineHeight: 1.08,
      scrollSensitivity: 1.2,
    };
  }

  if (width <= 820) {
    return {
      fontSize: 13,
      lineHeight: 1.12,
      scrollSensitivity: 1.28,
    };
  }

  return {
    fontSize: 14,
    lineHeight: 1.18,
    scrollSensitivity: 1.35,
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
}

function isTerminalAtBottom() {
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
  state.terminal?.scrollToBottom();

  const viewport = document.querySelector("#terminal-mount .xterm-viewport");
  if (viewport instanceof HTMLElement) {
    viewport.scrollTop = viewport.scrollHeight;
  }

  state.terminalShowJumpToBottom = false;
  refreshTerminalJumpUi();
  state.terminal?.focus();
  window.requestAnimationFrame(() => {
    syncTerminalScrollState();
  });
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

  const nextOutput = state.pendingTerminalOutput;
  const shouldScrollToBottom = state.pendingTerminalScrollToBottom;
  state.pendingTerminalOutput = "";
  state.pendingTerminalScrollToBottom = false;
  state.terminal.write(nextOutput, () => {
    if (shouldScrollToBottom) {
      state.terminal?.scrollToBottom();
    }

    syncTerminalScrollState();
  });
}

function queueTerminalOutput(chunk, { scrollToBottom = false } = {}) {
  if (!chunk) {
    return;
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
  if (state.folderPicker.target === "wiki") {
    return "choose wiki folder";
  }

  if (state.folderPicker.target === "files") {
    return "choose files folder";
  }

  return "choose session folder";
}

function getFolderPickerCurrentPath() {
  return state.folderPicker.currentPath || state.folderPicker.root || state.defaultCwd || "";
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

  if (state.folderPicker.target === "files") {
    return document.querySelector("#files-root-input");
  }

  return null;
}

function getSelectedSessionProviderId() {
  const select = document.querySelector("#session-provider-select");

  if (select instanceof HTMLSelectElement && select.value) {
    return select.value;
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
                <button class="icon-button system-toast-dismiss" type="button" aria-label="Dismiss" ${tooltipAttributes("Dismiss")} data-system-toast-dismiss="${escapeHtml(toast.key)}">×</button>
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

  if (state.folderPicker.target === "session") {
    await createSessionInFolder(createdPath);
    return;
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

function getFileContentUrl(relativePath) {
  const params = new URLSearchParams();

  if (state.filesRoot) {
    params.set("root", state.filesRoot);
  }

  if (relativePath) {
    params.set("path", relativePath);
  }

  return `${getAppBaseUrl()}/api/files/content?${params.toString()}`;
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

function getFileTextRequestParams(relativePath) {
  const params = new URLSearchParams();

  if (state.filesRoot) {
    params.set("root", state.filesRoot);
  }

  if (relativePath) {
    params.set("path", relativePath);
  }

  return params;
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

function noteMatchesKnowledgeBaseSearch(note, query) {
  if (!query) {
    return true;
  }

  const haystack = [
    note.title,
    note.relativePath,
    note.excerpt,
    note.searchText,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return haystack.includes(query);
}

function getFilteredKnowledgeBaseNotes() {
  const query = getKnowledgeBaseSearchQuery();
  return state.knowledgeBase.notes.filter((note) => noteMatchesKnowledgeBaseSearch(note, query));
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
  if (segments.length > 1) {
    return segments[0];
  }

  return "root";
}

function getKnowledgeBaseGraphColor(groupKey) {
  const normalizedKey = String(groupKey || "root").toLowerCase();
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
    scale: previousLayout?.scale ?? 1,
    offsetX: previousLayout?.offsetX ?? 0,
    offsetY: previousLayout?.offsetY ?? 0,
    alpha: 0,
    running: false,
    frameHandle: 0,
    dragState: null,
    panState: null,
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

  layout.edges.forEach((edge, index) => {
    const source = layout.nodes[edge.sourceIndex];
    const target = layout.nodes[edge.targetIndex];
    const element = refs.edgeElements[index];

    if (!source || !target || !(element instanceof SVGLineElement)) {
      return;
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

    const centerX = layout.width / 2;
    const centerY = layout.height / 2;
    const damping = layout.dragState ? 0.72 : 0.84;
    const baseAlpha = layout.dragState ? 0.2 : 0.085;
    const alpha = Math.max(layout.alpha || 0, baseAlpha);

    for (const node of layout.nodes) {
      node.fx = (centerX - node.x) * 0.0054;
      node.fy = (centerY - node.y) * 0.0054;
    }

    for (let leftIndex = 0; leftIndex < layout.nodes.length; leftIndex += 1) {
      const left = layout.nodes[leftIndex];

      for (let rightIndex = leftIndex + 1; rightIndex < layout.nodes.length; rightIndex += 1) {
        const right = layout.nodes[rightIndex];
        const deltaX = right.x - left.x;
        const deltaY = right.y - left.y;
        const distanceSquared = Math.max(deltaX * deltaX + deltaY * deltaY, 1);
        const distance = Math.sqrt(distanceSquared);
        const minimumDistance = left.radius + right.radius + 16;
        let repulsion = (1650 + minimumDistance * 96) / distanceSquared;

        if (distance < minimumDistance) {
          repulsion += (minimumDistance - distance) * 0.085;
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
      node.x += node.vx;
      node.y += node.vy;

      const minX = node.radius + 10;
      const maxX = layout.width - node.radius - 10;
      const minY = node.radius + 10;
      const maxY = layout.height - node.radius - 10;

      if (node.x < minX || node.x > maxX) {
        node.x = clamp(node.x, minX, maxX);
        node.vx *= -0.28;
      }

      if (node.y < minY || node.y > maxY) {
        node.y = clamp(node.y, minY, maxY);
        node.vy *= -0.28;
      }

      maxVelocity = Math.max(maxVelocity, Math.abs(node.vx) + Math.abs(node.vy));
    }

    layout.alpha = Math.max(0, alpha * 0.985 - 0.00025);
    syncKnowledgeBaseGraphDom();

    const shouldContinue = Boolean(layout.dragState) || maxVelocity > 0.032 || layout.alpha > 0.026;
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
  layout.alpha = Math.max(layout.alpha || 0, boost);
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
  const baseRadius = Math.min(width, height) * 0.34;
  const previousNodes = new Map((previousLayout?.nodes || []).map((node) => [node.relativePath, node]));
  const nodes = notes.map((note, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(notes.length, 1);
    const previousNode = previousNodes.get(note.relativePath);
    const groupKey = getKnowledgeBaseGraphGroupKey(note.relativePath);

    return {
      relativePath: note.relativePath,
      title: note.title,
      groupKey,
      color: getKnowledgeBaseGraphColor(groupKey),
      x: previousNode?.x ?? centerX + Math.cos(angle) * baseRadius,
      y: previousNode?.y ?? centerY + Math.sin(angle) * baseRadius,
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
    radius: Math.min(26, 6.5 + Math.sqrt(node.degree || 0) * 2.85 + ((node.degree || 0) / maxDegree) * 8.5),
  }));
  const sizedNodeMap = new Map(graphNodes.map((node, index) => [node.relativePath, { node, index }]));

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
        distance: 50 + ((source?.radius || 10) + (target?.radius || 10)) * 2.8,
        strength: 0.010 + 0.00045 * Math.min((source?.degree || 0) + (target?.degree || 0), 12),
      };
    }),
    scale: previousLayout?.scale ?? 1,
    offsetX: previousLayout?.offsetX ?? 0,
    offsetY: previousLayout?.offsetY ?? 0,
    alpha: Math.max(previousLayout?.alpha || 0, 0.22),
    running: false,
    frameHandle: 0,
    dragState: null,
    panState: null,
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

function renderKnowledgeBaseInline(text, currentPath) {
  const tokens = [];
  const createToken = (html) => `%%KB_TOKEN_${tokens.push(html) - 1}%%`;
  let output = String(text || "");

  output = output.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, altText, target) => {
    const relativeAssetPath = resolveKnowledgeBaseRelativePath(currentPath, target);

    if (!relativeAssetPath) {
      return createToken(`<span>${escapeHtml(altText)}</span>`);
    }

    return createToken(
      `<img class="knowledge-base-inline-image" src="${escapeHtml(getKnowledgeBaseNoteRawUrl(relativeAssetPath))}" alt="${escapeHtml(altText)}" loading="lazy" />`,
    );
  });

  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, target) => {
    const notePath = resolveKnowledgeBaseNotePath(currentPath, target);

    if (notePath) {
      return createToken(
        `<button class="knowledge-base-inline-link" type="button" data-kb-open-note="${escapeHtml(notePath)}">${escapeHtml(label)}</button>`,
      );
    }

    const relativeAssetPath = resolveKnowledgeBaseRelativePath(currentPath, target);
    const externalHref = relativeAssetPath
      ? getKnowledgeBaseNoteRawUrl(relativeAssetPath)
      : String(target || "").trim();
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

function renderKnowledgeBaseMarkdown(markdown, currentPath) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let index = 0;

  const isListLine = (line) => /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line);
  const isBlockBoundary = (line) =>
    !line.trim() ||
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
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
      const matchLabel = query ? "matches search" : note.excerpt || "No preview yet.";
      return `
        <button
          class="knowledge-base-note-row ${isActive ? "is-active" : ""}"
          type="button"
          data-kb-note="${escapeHtml(note.relativePath)}"
        >
          <span class="knowledge-base-note-title">${escapeHtml(note.title)}</span>
          <span class="knowledge-base-note-path">${escapeHtml(note.relativePath)}</span>
          <span class="knowledge-base-note-excerpt">${escapeHtml(matchLabel)}</span>
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
          <div class="knowledge-base-graph-hint">drag nodes · drag canvas · scroll to zoom</div>
        </div>
        <div class="knowledge-base-graph-actions">
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
                    class="knowledge-base-graph-node ${isSelected ? "is-selected" : ""} ${isConnected ? "is-connected" : ""}"
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
                    ${
                      shouldShowLabel
                        ? `<text y="${(-node.radius - 10).toFixed(2)}">${escapeHtml(
                            truncateKnowledgeBaseLabel(node.title, 18),
                          )}</text>`
                        : ""
                    }
                  </g>
                `;
              })
              .join("")}
          </g>
        </svg>
      </div>
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
        <span aria-hidden="true">⚙</span>
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
    <section class="dashboard-panel knowledge-base-view">
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>≡</button>
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
          <button class="ghost-button toolbar-control" type="button" id="refresh-knowledge-base">refresh</button>
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
            <button class="ghost-button toolbar-control" type="button" id="refresh-knowledge-base">refresh</button>
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
    const portMeta = activeTab?.port ? `:${activeTab.port}` : previewUrl;

    return `
      <div class="file-editor-card file-web-card">
        <div class="file-editor-head">
          <div class="file-editor-copy">
            <div class="file-editor-name">${escapeHtml(state.openFileName || "web preview")}</div>
            <div class="file-editor-path" title="${escapeHtml(externalUrl)}">${escapeHtml(portMeta)}</div>
          </div>
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
    return `
      <div class="file-editor-card file-image-card">
        <div class="file-editor-head">
          <div class="file-editor-copy">
            <div class="file-editor-name">${escapeHtml(state.openFileName)}</div>
            <div class="file-editor-path" title="${escapeHtml(state.openFileRelativePath)}">${escapeHtml(state.openFileRelativePath)}</div>
          </div>
          <div class="file-editor-actions">
            <a class="ghost-button file-editor-open" href="${escapeHtml(rawHref)}" target="_blank" rel="noreferrer">raw</a>
          </div>
        </div>
        <div class="file-image-preview">
          <img src="${escapeHtml(rawHref)}" alt="${escapeHtml(state.openFileName)}" />
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
      return `
        <div class="file-preview-tab ${active ? "is-active" : ""}" title="${escapeHtml(tabTitle)}">
          <button class="file-preview-tab-label" type="button" data-file-tab="${escapeHtml(tab.relativePath)}">
            <span class="file-preview-tab-name">${escapeHtml(tab.name)}${dirty ? " *" : ""}</span>
          </button>
          <button class="file-preview-tab-close" type="button" aria-label="Close ${escapeHtml(tab.name)}" ${tooltipAttributes(`Close ${tab.name}`)} data-close-file-tab="${escapeHtml(tab.relativePath)}">×</button>
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
        <button class="icon-button file-preview-close-all" type="button" id="close-file-preview" aria-label="Close file preview" ${tooltipAttributes("Close file preview")}>×</button>
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
              <span class="file-caret">${expanded ? "▾" : "▸"}</span>
              <span class="file-icon file-icon-folder ${expanded ? "is-open" : ""}" aria-hidden="true"></span>
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
          <span class="file-caret file-caret-spacer">·</span>
          <span class="file-icon ${entry.isImage ? "file-icon-image" : openMode === "text" ? "file-icon-text" : "file-icon-file"}" aria-hidden="true"></span>
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

  return `
    <article class="session-card ${session.id === state.activeSessionId ? "is-active" : ""}" data-session-id="${session.id}">
      <span class="session-activity-dot ${status.className}" role="img" aria-label="${escapeHtml(status.title)}" title="${escapeHtml(status.title)}"></span>
      <div class="session-main">
        <div class="session-name">${escapeHtml(session.name)}</div>
        <div class="session-subtitle">${escapeHtml(session.providerLabel)}</div>
      </div>
      <span class="session-time">${relativeTime(session.lastOutputAt)}</span>
      <div class="session-actions">
        <button class="session-action-button" type="button" aria-label="Fork session" ${tooltipAttributes("Fork session")} data-fork-session="${session.id}">
          <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
            <path d="M5 3.5v2.2a4.8 4.8 0 0 0 4.8 4.8H13" />
            <path d="M5 14.5v-2.2a4.8 4.8 0 0 1 4.8-4.8H13" />
            <path d="M12 5.5 14.5 8 12 10.5" />
          </svg>
        </button>
        <button class="session-action-button" type="button" aria-label="Rename session" ${tooltipAttributes("Rename session")} data-rename-session="${session.id}">
          <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
            <path d="m4 12.8-.5 2.7 2.7-.5 7.7-7.7-2.2-2.2L4 12.8Z" />
            <path d="m10.8 6 2.2 2.2" />
          </svg>
        </button>
        <button class="session-action-button session-delete-button" type="button" aria-label="Delete session" ${tooltipAttributes("Delete session")} data-delete-session="${session.id}">
          <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
            <path d="M4.5 6h9" />
            <path d="M7 6V4.5h4V6" />
            <path d="m6 8 .4 6h5.2l.4-6" />
          </svg>
        </button>
      </div>
    </article>
    ${
      subagents.length
        ? `<div class="session-subagents" aria-label="Claude subagents">${subagents.map((subagent) => renderSessionSubagentCard(subagent)).join("")}</div>`
        : ""
    }
  `;
}

function getSubagentLabel(subagent) {
  if (subagent?.status === "working") {
    return { className: "working", title: "Claude subagent is working" };
  }

  return { className: "read", title: "Claude subagent finished" };
}

function renderSessionSubagentCard(subagent) {
  const status = getSubagentLabel(subagent);
  const messageCount = Number(subagent.messageCount);
  const toolUseCount = Number(subagent.toolUseCount);
  const metaParts = [
    subagent.agentType || "subagent",
    subagent.messageCount != null && Number.isFinite(messageCount) ? `${messageCount} msgs` : "",
    subagent.toolUseCount != null && Number.isFinite(toolUseCount) ? `${toolUseCount} tools` : "",
  ].filter(Boolean);

  return `
    <div class="session-subagent-card" title="${escapeHtml(subagent.description || subagent.name || "Claude subagent")}">
      <span class="session-activity-dot ${status.className}" role="img" aria-label="${escapeHtml(status.title)}" title="${escapeHtml(status.title)}"></span>
      <div class="session-main">
        <div class="session-name">${escapeHtml(subagent.name || "Claude subagent")}</div>
        <div class="session-subtitle">${escapeHtml(metaParts.join(" · "))}</div>
      </div>
      <span class="session-time">${relativeTime(subagent.updatedAt)}</span>
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
              <span class="file-caret">${expanded ? "▾" : "▸"}</span>
              <span class="file-icon file-icon-folder ${expanded ? "is-open" : ""}" aria-hidden="true"></span>
              <span class="session-project-copy">
                <span class="session-project-name">${escapeHtml(group.name)}</span>
              </span>
            </button>
            <button
              class="session-project-new"
              type="button"
              data-create-session-in-cwd="${escapeHtml(group.cwd)}"
              aria-label="Create a new session in ${escapeHtml(group.name)}"
              ${tooltipAttributes("New session in this folder")}
            >✎</button>
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
  return state.providers.find((provider) => provider.id === state.defaultProviderId)?.label || "agent";
}

function renderSidebarNav(providerOptions) {
  const wikiLabel = state.settings.wikiRelativeRoot || state.agentPromptWikiRoot || "wiki";
  const primaryItems = [
    {
      view: "plugins",
      icon: "⌘",
      label: "Plugins",
      meta: "MCPs and integrations",
    },
    {
      view: "automations",
      icon: "◷",
      label: "Automations",
      meta: "scheduled helpers",
    },
    {
      view: "system",
      icon: "◌",
      label: "System",
      meta: "storage, CPU, GPU",
    },
  ];
  const workspaceItems = [
    {
      view: "knowledge-base",
      icon: "◇",
      label: "Knowledge Base",
      meta: `${state.knowledgeBase.notes.length} notes · ${wikiLabel}`,
    },
    {
      view: "agent-prompt",
      icon: "✎",
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
      <span class="sidebar-nav-icon" aria-hidden="true">${escapeHtml(item.icon)}</span>
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
          <span class="sidebar-nav-icon" aria-hidden="true">+</span>
          <span class="sidebar-nav-copy">
            <span class="sidebar-nav-label">New chat</span>
            <span class="sidebar-nav-meta">${escapeHtml(`${getSelectedProviderLabel()} · choose folder`)}</span>
          </span>
        </button>
        <form class="session-form session-launcher" id="session-form">
          <select id="session-provider-select" name="providerId" aria-label="Session CLI">${providerOptions}</select>
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
    <section class="dashboard-panel main-view search-view">
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>≡</button>
        <div class="dashboard-copy">
          <strong>Search</strong>
          <div class="terminal-meta">jump across sessions, project folders, ports, and wiki notes</div>
        </div>
      </div>
      <div class="main-search-shell">
        <span class="main-search-icon" aria-hidden="true">⌕</span>
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
    searchMatches([plugin.name, plugin.category, plugin.description, plugin.status, plugin.source], query),
  );
}

function renderPluginCards() {
  const plugins = getFilteredPlugins();

  if (!plugins.length) {
    return `<div class="blank-state">no plugins match "${escapeHtml(state.pluginSearchQuery)}"</div>`;
  }

  return plugins
    .map(
      (plugin) => `
        <article class="plugin-card">
          <div class="plugin-icon" aria-hidden="true">${escapeHtml(plugin.name.slice(0, 1))}</div>
          <div class="plugin-copy">
            <strong>${escapeHtml(plugin.name)}</strong>
            <span>${escapeHtml(plugin.description)}</span>
            <em>${escapeHtml(plugin.category)}</em>
          </div>
          <span class="plugin-status">${escapeHtml(plugin.status)}</span>
        </article>
      `,
    )
    .join("");
}

function renderAgentMailPluginPanel() {
  const status = state.settings.agentMailStatus || {};
  const providerOptions = renderProviderOptions(state.settings.agentMailProviderId || state.defaultProviderId || "claude");
  const lastEvent = status.lastEventAt ? relativeTime(status.lastEventAt) : "";

  return `
    <aside class="mcp-import-card agentmail-plugin-card">
      <span class="main-search-kind">email agent</span>
      <strong>AgentMail inbox</strong>
      <p>Remote Vibes can create or attach an AgentMail inbox, keep an outbound WebSocket listener open, and launch a Claude session when new mail arrives.</p>
      <form class="settings-form agentmail-form" id="agentmail-form">
        <label class="checkbox-row">
          <input type="checkbox" name="agentMailEnabled" ${state.settings.agentMailEnabled ? "checked" : ""} />
          <span>listen for incoming AgentMail messages</span>
        </label>
        <label class="field-label" for="agentmail-api-key">AgentMail API key</label>
        <input
          class="file-root-input"
          id="agentmail-api-key"
          name="agentMailApiKey"
          type="password"
          placeholder="${escapeHtml(state.settings.agentMailApiKeyConfigured ? "saved; leave blank to keep" : "am_...")}"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
        />
        <div class="knowledge-settings-remote-grid">
          <label class="field-label" for="agentmail-inbox-id">inbox email</label>
          <input
            class="file-root-input"
            id="agentmail-inbox-id"
            name="agentMailInboxId"
            type="text"
            value="${escapeHtml(state.settings.agentMailInboxId || "")}"
            placeholder="leave blank to create one"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
          />
          <label class="field-label" for="agentmail-provider">reply agent</label>
          <select class="file-root-input" id="agentmail-provider" name="agentMailProviderId">${providerOptions}</select>
          <label class="field-label" for="agentmail-username">new inbox username</label>
          <input
            class="file-root-input"
            id="agentmail-username"
            name="agentMailUsername"
            type="text"
            value="${escapeHtml(state.settings.agentMailUsername || "")}"
            placeholder="optional"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
          />
          <label class="field-label" for="agentmail-domain">domain</label>
          <input
            class="file-root-input"
            id="agentmail-domain"
            name="agentMailDomain"
            type="text"
            value="${escapeHtml(state.settings.agentMailDomain || "")}"
            placeholder="agentmail.to"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
          />
        </div>
        <label class="field-label" for="agentmail-display-name">display name</label>
        <input
          class="file-root-input"
          id="agentmail-display-name"
          name="agentMailDisplayName"
          type="text"
          value="${escapeHtml(state.settings.agentMailDisplayName || "Remote Vibes")}"
          placeholder="Remote Vibes"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
        />
        <div class="knowledge-settings-actions">
          <button class="primary-button settings-save-button" type="submit" data-agentmail-action="setup">
            ${state.settings.agentMailInboxId ? "save + reconnect" : "create inbox"}
          </button>
          <div class="settings-status" id="agentmail-settings-status">${escapeHtml(getAgentMailStatusText())}</div>
        </div>
      </form>
      <p class="mcp-import-paths">Mode: <code>WebSocket</code> ${lastEvent ? `· last email ${escapeHtml(lastEvent)} ago` : ""} · processed ${escapeHtml(String(status.processedCount || 0))}</p>
      <p class="mcp-import-paths">The reply agent uses <code>rv-agentmail-reply</code>; the API key stays server-side.</p>
    </aside>
  `;
}

function renderPluginsView() {
  return `
    <section class="dashboard-panel main-view plugins-view">
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>≡</button>
        <div class="dashboard-copy">
          <strong>Plugins</strong>
          <div class="terminal-meta">a Codex-style place for MCPs, integrations, and built-in Remote Vibes tools</div>
        </div>
      </div>
      <div class="main-search-shell">
        <span class="main-search-icon" aria-hidden="true">⌘</span>
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
          ${renderAgentMailPluginPanel()}
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

function renderAutomationsView() {
  return `
    <section class="dashboard-panel main-view automations-view">
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>≡</button>
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
        <article class="automation-card">
          <span class="main-search-kind">enabled</span>
          <strong>Knowledge base git backup</strong>
          <p>Backs up the selected wiki every ${escapeHtml(String(Math.round((state.settings.wikiBackupIntervalMs || 0) / 60000) || 5))} minutes when enabled.</p>
          <button class="ghost-button toolbar-control" type="button" data-open-main-view="knowledge-base">open settings</button>
        </article>
        <article class="automation-card">
          <span class="main-search-kind">coming soon</span>
          <strong>Agent check-ins</strong>
          <p>A future home for heartbeat tasks, plugin-backed automations, and proactive session health checks.</p>
        </article>
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
    gpus: (Array.isArray(system.gpus) ? system.gpus : []).map((gpu, index) => ({
      id: String(gpu?.id || `gpu-${index}`),
      name: gpu?.name || `GPU ${index + 1}`,
      utilizationPercent: getFiniteMetricPercent(gpu?.utilizationPercent),
    })),
  };
}

function appendSystemMetricHistory(system) {
  const sample = createSystemMetricHistorySample(system);
  if (!sample) {
    return;
  }

  const lastSample = state.systemMetricHistory.at(-1);
  if (lastSample?.checkedAt === sample.checkedAt) {
    state.systemMetricHistory[state.systemMetricHistory.length - 1] = sample;
  } else {
    state.systemMetricHistory.push(sample);
  }

  if (state.systemMetricHistory.length > SYSTEM_HISTORY_LIMIT) {
    state.systemMetricHistory.splice(0, state.systemMetricHistory.length - SYSTEM_HISTORY_LIMIT);
  }
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

function getChartPoint(value, index, totalPoints, width, height) {
  const x = totalPoints <= 1 ? width / 2 : (index / (totalPoints - 1)) * width;
  const y = height - (getMetricPercent(value) / 100) * height;
  return {
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
  };
}

function renderChartSeries(series, seriesIndex, totalPoints) {
  const width = 560;
  const height = 150;
  const color = SYSTEM_CHART_COLORS[seriesIndex % SYSTEM_CHART_COLORS.length];
  const points = series.values
    .map((value, index) => (getFiniteMetricPercent(value) === null ? null : getChartPoint(value, index, totalPoints, width, height)))
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

    const point = getChartPoint(percent, index, totalPoints, width, height);
    pathData += `${openSegment ? "L" : "M"} ${point.x} ${point.y} `;
    openSegment = true;
  });

  const latestPoint = points.at(-1);
  return `
    <path class="system-line-chart-path" d="${pathData.trim()}" style="--chart-color: ${escapeHtml(color)}"></path>
    <circle class="system-line-chart-dot" cx="${latestPoint.x}" cy="${latestPoint.y}" r="3.4" style="--chart-color: ${escapeHtml(color)}"></circle>
  `;
}

function renderUtilizationLineChart({ emptyMessage, series, subtitle, title }) {
  const activeSeries = series.filter((entry) => entry.values.some((value) => getFiniteMetricPercent(value) !== null));
  const totalPoints = Math.max(1, ...activeSeries.map((entry) => entry.values.length));
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
              <svg class="system-line-chart" viewBox="0 0 560 150" role="img" aria-label="${escapeHtml(title)} utilization history">
                <line class="system-line-chart-grid" x1="0" y1="0" x2="560" y2="0"></line>
                <line class="system-line-chart-grid" x1="0" y1="75" x2="560" y2="75"></line>
                <line class="system-line-chart-grid" x1="0" y1="150" x2="560" y2="150"></line>
                ${activeSeries.map((entry, index) => renderChartSeries(entry, index, totalPoints)).join("")}
              </svg>
              <div class="system-line-chart-axis" aria-hidden="true">
                <span>100%</span>
                <span>50%</span>
                <span>0%</span>
              </div>
            </div>
            <div class="system-chart-legend">
              ${visibleLegend
                .map((entry, index) => {
                  const color = SYSTEM_CHART_COLORS[index % SYSTEM_CHART_COLORS.length];
                  const latestValue = getLatestSeriesValue(entry);
                  return `
                    <span class="system-chart-chip" style="--chart-color: ${escapeHtml(color)}">
                      <i></i>${escapeHtml(entry.label)} <strong>${escapeHtml(formatPercent(latestValue))}</strong>
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
  const sampleText = history.length === 1 ? "1 sample" : `${history.length} samples`;

  return `
    <div class="system-chart-grid">
      ${renderUtilizationLineChart({
        title: "CPU core history",
        subtitle: sampleText,
        series: buildCpuCoreChartSeries(history),
        emptyMessage: "CPU core history starts after the first sample.",
      })}
      ${renderUtilizationLineChart({
        title: "GPU history",
        subtitle: sampleText,
        series: buildGpuChartSeries(history),
        emptyMessage: "GPU utilization is not exposed by this host.",
      })}
    </div>
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

  return `
    <article class="system-storage-card">
      <div class="system-storage-head">
        <strong>${escapeHtml(primary.name || primary.mountPoint || "Storage")}</strong>
        <span>${escapeHtml(`${formatBytes(usedBytes)} of ${formatBytes(totalBytes)} used`)}</span>
      </div>
      <div class="system-storage-bar" style="--storage-used: ${usedPercent}%">
        <span class="system-storage-used"></span>
        <span class="system-storage-free"></span>
      </div>
      <div class="system-storage-legend">
        <span><i class="legend-dot is-used"></i>${escapeHtml(`${formatPercent(usedPercent)} used`)}</span>
        <span><i class="legend-dot is-free"></i>${escapeHtml(`${formatBytes(freeBytes)} free`)}</span>
        <span>${escapeHtml(primary.mountPoint || "")}</span>
      </div>
    </article>
  `;
}

function renderWikiStorageCard(system) {
  const wiki = system?.wikiStorage;
  if (!wiki) {
    return "";
  }

  const primary = system?.storage?.primary;
  const wikiBytes = Number(wiki.bytes || 0);
  const volumeBytes = Number(primary?.totalBytes || 0);
  const rawPercent = volumeBytes > 0 ? clamp((wikiBytes / volumeBytes) * 100, 0, 100) : null;
  const visiblePercent = rawPercent && rawPercent > 0 ? Math.max(rawPercent, 1) : 0;
  const countParts = [
    Number.isFinite(Number(wiki.fileCount)) ? `${wiki.fileCount} files` : "",
    Number.isFinite(Number(wiki.directoryCount)) ? `${wiki.directoryCount} folders` : "",
    wiki.truncated ? "partial count" : "",
  ].filter(Boolean);
  const detailParts = [
    wiki.exists ? `${formatBytes(wikiBytes)} in wiki folder` : "folder not found",
    rawPercent === null ? "" : `${rawPercent < 0.01 && rawPercent > 0 ? "<0.01" : rawPercent.toFixed(rawPercent < 1 ? 2 : 1)}% of ${primary?.name || "disk"}`,
    wiki.source ? `measured by ${wiki.source}` : "",
    countParts.join(" · "),
  ].filter(Boolean);

  return `
    <article class="system-storage-card system-wiki-storage-card">
      <div class="system-storage-head">
        <strong>Knowledge base storage</strong>
        <span>${escapeHtml(wiki.exists ? formatBytes(wikiBytes) : "missing")}</span>
      </div>
      <div class="system-storage-path" title="${escapeHtml(wiki.path || "")}">${escapeHtml(wiki.path || "no wiki folder configured")}</div>
      <div class="system-storage-bar" style="--storage-used: ${visiblePercent}%">
        <span class="system-storage-used"></span>
        <span class="system-storage-free"></span>
      </div>
      <div class="system-storage-legend">
        <span><i class="legend-dot is-wiki"></i>${escapeHtml(detailParts.join(" · "))}</span>
        ${wiki.warning ? `<span>${escapeHtml(wiki.warning)}</span>` : ""}
        ${wiki.error ? `<span>${escapeHtml(wiki.error)}</span>` : ""}
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
        <span>CPU</span>
        <strong>${escapeHtml(formatPercent(cpu?.utilizationPercent))}</strong>
        ${renderMetricBar(cpu?.utilizationPercent, "is-cpu")}
        <em>${escapeHtml(cpu?.coreCount ? `${cpu.coreCount} cores` : "no CPU sample")}</em>
      </article>
      <article class="system-summary-card">
        <span>Memory</span>
        <strong>${escapeHtml(formatPercent(memory?.usedPercent))}</strong>
        ${renderMetricBar(memory?.usedPercent, "is-memory")}
        <em>${escapeHtml(memory ? `${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)}` : "not available")}</em>
      </article>
      <article class="system-summary-card">
        <span>GPU</span>
        <strong>${escapeHtml(String(gpuCount))}</strong>
        <em>${escapeHtml(gpuCount === 1 ? "device found" : "devices found")}</em>
      </article>
      <article class="system-summary-card">
        <span>Accelerators</span>
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

  return `
    <section class="dashboard-panel main-view system-view">
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>≡</button>
        <div class="dashboard-copy">
          <strong>System</strong>
          <div class="terminal-meta">storage, CPU cores, GPUs, and accelerators on this machine</div>
        </div>
        <div class="dashboard-actions">
          <button class="ghost-button toolbar-control" type="button" id="refresh-system" ${state.systemMetricsLoading ? "disabled" : ""}>
            ${state.systemMetricsLoading ? "sampling..." : "refresh"}
          </button>
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
        ${renderWikiStorageCard(system)}
        ${renderSystemSummaryCards(system)}
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

  return `
    <section class="terminal-panel">
      <div class="terminal-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>≡</button>
        <div class="terminal-copy">
          <strong id="toolbar-title">${escapeHtml(activeSession ? activeSession.name : "new session")}</strong>
          <div class="terminal-meta" id="toolbar-meta">${escapeHtml(
            activeSession ? `${activeSession.providerLabel} · ${activeSession.cwd}` : state.defaultCwd,
          )}</div>
        </div>
        <div class="toolbar-actions">
          <button class="icon-button" type="button" id="refresh-sessions" aria-label="Refresh sessions" ${tooltipAttributes("Refresh sessions")}>↻</button>
          <button class="ghost-button toolbar-control" type="button" id="tab-button" data-terminal-control aria-label="Send Tab" ${tooltipAttributes("Send Tab")} ${activeSession ? "" : "disabled"}>tab</button>
          <button class="ghost-button toolbar-control" type="button" id="shift-tab-button" data-terminal-control aria-label="Send Shift Tab" ${tooltipAttributes("Send Shift Tab")} ${activeSession ? "" : "disabled"}>⇧⇥</button>
          <button class="ghost-button toolbar-control" type="button" id="ctrl-p-button" data-terminal-control aria-label="Send Control P" ${tooltipAttributes("Send Control P")} ${activeSession ? "" : "disabled"}>^P</button>
          <button class="ghost-button toolbar-control" type="button" id="ctrl-t-button" data-terminal-control aria-label="Send Control T" ${tooltipAttributes("Send Control T")} ${activeSession ? "" : "disabled"}>^T</button>
          <button class="ghost-button toolbar-control" type="button" id="ctrl-c-button" data-terminal-control aria-label="Send Control C" ${tooltipAttributes("Send Control C")} ${activeSession ? "" : "disabled"}>^C</button>
        </div>
      </div>

      <div class="workspace-split ${state.openFileTabs.length ? "has-file-preview" : ""}" id="workspace-split">
        <div class="terminal-stack">
          <div class="terminal-mount" id="terminal-mount"></div>
          <button class="jump-bottom-button ${activeSession && state.terminalShowJumpToBottom ? "is-visible" : ""}" type="button" id="jump-to-bottom" aria-label="Jump to bottom" ${tooltipAttributes("Jump to bottom")} ${activeSession ? "" : "disabled"}>
            bottom
          </button>
          <div class="empty-state ${activeSession ? "hidden" : ""}" id="empty-state">
            <p class="empty-state-copy">open the menu, choose a CLI, then pick or create a folder to start a session</p>
          </div>
        </div>
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
    <section class="dashboard-panel agent-prompt-view">
      <div class="dashboard-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar" aria-label="Open sidebar" ${tooltipAttributes("Open sidebar")}>≡</button>
        <div class="dashboard-copy">
          <strong>Agent Prompt</strong>
          <div class="terminal-meta">shared instructions injected into Codex, Claude, Gemini, and OpenCode sessions</div>
        </div>
        <div class="dashboard-actions agent-prompt-toolbar-actions">
          <a class="ghost-button toolbar-control" href="${escapeHtml(getAgentPromptUrl())}" target="_blank" rel="noreferrer">open tab</a>
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
            <span class="file-caret">${expanded ? "▾" : "▸"}</span>
            <span class="file-icon file-icon-folder ${expanded ? "is-open" : ""}" aria-hidden="true"></span>
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
  const rootChildren = renderFolderPickerTreeNodes("", 1);

  return `
    <div class="file-node folder-picker-node">
      <button
        class="file-row file-row-button folder-picker-tree-row folder-picker-root-row ${rootSelected ? "is-active" : ""}"
        type="button"
        data-folder-picker-select=""
        data-folder-picker-path="${escapeHtml(rootPath)}"
        style="--depth:0"
      >
        <span class="file-caret">▾</span>
        <span class="file-icon file-icon-folder is-open" aria-hidden="true"></span>
        <span class="file-label">${escapeHtml(getWorkspacePathLeafName(rootPath))}</span>
      </button>
      <div class="file-children" style="--depth:0">${rootChildren}</div>
    </div>
  `;
}

function renderFolderPickerModal() {
  if (!state.folderPicker.open) {
    return "";
  }

  const currentPath = getFolderPickerCurrentPath();
  const isSessionTarget = state.folderPicker.target === "session";

  return `
    <div class="prompt-modal-shell" data-folder-picker-modal>
      <button class="sidebar-scrim is-open" type="button" aria-label="Close folder picker" data-close-folder-picker></button>
      <section class="prompt-modal folder-picker-modal">
        <div class="section-head">
          <span>${escapeHtml(getFolderPickerTitle())}</span>
          <button class="icon-button" type="button" aria-label="Close folder picker" ${tooltipAttributes("Close folder picker")} data-close-folder-picker>×</button>
        </div>
        <div class="folder-picker-path" title="${escapeHtml(currentPath)}">${escapeHtml(currentPath)}</div>
        <div class="folder-picker-actions">
          <button class="ghost-button folder-picker-button" type="button" id="folder-picker-up" ${state.folderPicker.parentPath ? "" : "disabled"}>up</button>
          <button class="primary-button folder-picker-button" type="button" id="folder-picker-select" ${currentPath ? "" : "disabled"}>${isSessionTarget ? "start session here" : "choose this folder"}</button>
        </div>
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
          <button class="ghost-button folder-picker-button" type="submit">${isSessionTarget ? "create + start" : "create folder"}</button>
        </form>
        <div class="folder-picker-list" data-folder-picker-root="${escapeHtml(state.folderPicker.root || "")}">${renderFolderPickerEntries()}</div>
      </section>
    </div>
  `;
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

function captureExplorerScrollSnapshots() {
  const filesTree = document.querySelector("#files-tree");
  const folderPickerList = document.querySelector(".folder-picker-list");

  return {
    filesTree: captureScrollSnapshot("#files-tree"),
    filesRoot: filesTree instanceof HTMLElement ? filesTree.dataset.filesRoot || "" : "",
    folderPickerList: captureScrollSnapshot(".folder-picker-list"),
    folderPickerRoot: folderPickerList instanceof HTMLElement ? folderPickerList.dataset.folderPickerRoot || "" : "",
  };
}

function restoreExplorerScrollSnapshots(snapshot) {
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

function renderShell() {
  const explorerScrollSnapshot = captureExplorerScrollSnapshots();
  teardownKnowledgeBaseGraphInteractions();
  syncFilesRoot();
  const viewTitles = {
    "knowledge-base": "Knowledge Base · Remote Vibes",
    "agent-prompt": "Agent Prompt · Remote Vibes",
    search: "Search · Remote Vibes",
    plugins: "Plugins · Remote Vibes",
    automations: "Automations · Remote Vibes",
    system: "System · Remote Vibes",
  };
  document.title = viewTitles[state.currentView] || "Remote Vibes";

  const providerOptions = renderProviderOptions(state.defaultProviderId);

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;

  app.innerHTML = `
    <main class="screen app-shell">
      <button class="sidebar-scrim ${state.mobileSidebar ? "is-open" : ""}" type="button" aria-label="Close sidebars" data-sidebar-scrim></button>
      <aside class="sidebar sidebar-left ${state.mobileSidebar === "left" ? "is-open" : ""}" data-sidebar-panel="left">
        <div class="sidebar-mobile-actions">
          <button class="icon-button hidden-desktop" type="button" id="close-left-sidebar" aria-label="Close sidebar" ${tooltipAttributes("Close sidebar")}>×</button>
        </div>

        <div class="sidebar-body">
          <div class="update-slot" id="update-banner">${renderUpdateBanner()}</div>

          ${renderSidebarNav(providerOptions)}

          <section class="sidebar-section sessions-section">
            <div class="section-head">
              <span>Threads</span>
              <div class="section-actions">
                <button class="icon-button sidebar-head-button" type="button" data-folder-picker-target="session" aria-label="Add project" ${tooltipAttributes("Add project")}>+</button>
              </div>
            </div>
            <div class="list-shell" id="sessions-list">${renderSessionCards()}</div>
          </section>

          <section class="sidebar-section">
            <div class="section-head">
              <span>files</span>
              <div class="section-actions">
                <button class="ghost-button files-root-reset" type="button" id="auto-files-root" aria-label="Use automatic files root" ${tooltipAttributes("Use automatic files root")} ${state.filesRootOverride ? "" : "disabled"}>auto</button>
                <button class="icon-button" type="button" id="refresh-files" aria-label="Refresh files" ${tooltipAttributes("Refresh files")}>↻</button>
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

          <section class="sidebar-section">
            <div class="section-head">
              <span>ports</span>
              <button class="icon-button" type="button" id="refresh-ports" aria-label="Refresh ports" ${tooltipAttributes("Refresh ports")}>↻</button>
            </div>
            <div class="list-shell" id="ports-list">${renderPortCards()}</div>
          </section>
        </div>

        <div class="sidebar-footer">
          <button class="sidebar-settings-link" type="button" data-open-main-view="knowledge-base">
            <span aria-hidden="true">⚙</span>
            <span>Settings</span>
          </button>
          <div class="sidebar-footer-actions">
            <button class="ghost-button relaunch-button" type="button" id="relaunch-app">relaunch</button>
            <button class="danger-button terminate-button" type="button" id="terminate-app">terminate</button>
          </div>
        </div>
      </aside>

      ${renderTerminalPanel(activeSession)}
      ${renderFolderPickerModal()}
      ${renderSystemToasts()}
    </main>
  `;
  restoreExplorerScrollSnapshots(explorerScrollSnapshot);

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

function bindSessionEvents() {
  document.querySelectorAll("[data-session-project-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const projectKey = button.getAttribute("data-session-project-toggle");
      if (!projectKey) {
        return;
      }

      state.sessionProjectInteractionSeen = true;
      if (state.sessionProjectExpanded.has(projectKey)) {
        state.sessionProjectExpanded.delete(projectKey);
      } else {
        state.sessionProjectExpanded.add(projectKey);
      }

      refreshSessionsList();
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

  document.querySelectorAll("[data-session-id]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target.closest("[data-delete-session]")) {
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

function refreshSessionsList() {
  const sessionsList = document.querySelector("#sessions-list");
  if (!sessionsList) {
    return;
  }

  sessionsList.innerHTML = renderSessionCards();
  bindSessionEvents();
}

function refreshPortsList() {
  const portsList = document.querySelector("#ports-list");
  if (!portsList) {
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
}

function refreshAgentMailPluginUi() {
  const card = document.querySelector(".agentmail-plugin-card");
  if (!card) {
    return;
  }

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && activeElement.closest("#agentmail-form")) {
    return;
  }

  card.outerHTML = renderAgentMailPluginPanel();
  bindAgentMailForm();
}

function bindAgentMailForm() {
  document.querySelector("#agentmail-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;

    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const button = form.querySelector("[data-agentmail-action]");
    if (button instanceof HTMLButtonElement) {
      button.disabled = true;
      button.textContent = "connecting...";
    }

    try {
      await setupAgentMailFromForm(form);
      renderShell();
    } catch (error) {
      window.alert(error.message);
      if (button instanceof HTMLButtonElement) {
        button.disabled = false;
        button.textContent = state.settings.agentMailInboxId ? "save + reconnect" : "create inbox";
      }
    }
  });
}

function refreshUpdateUi() {
  const updateBanner = document.querySelector("#update-banner");
  if (!updateBanner) {
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

function refreshSystemToastsUi() {
  const currentStack = document.querySelector("#system-toasts");
  const nextHtml = renderSystemToasts();

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
  document.querySelectorAll("[data-open-port-preview]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
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
    svg.classList.remove("is-panning", "is-dragging-node");
    layout.nodes.forEach((_node, index) => {
      const element = nodeElements[index];
      if (element instanceof SVGGElement) {
        element.classList.remove("is-dragging");
      }
    });
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

      layout.dragState.node.x = clamp(
        worldPoint.x + layout.dragState.pointerOffsetX,
        layout.dragState.node.radius + 10,
        layout.width - layout.dragState.node.radius - 10,
      );
      layout.dragState.node.y = clamp(
        worldPoint.y + layout.dragState.pointerOffsetY,
        layout.dragState.node.radius + 10,
        layout.height - layout.dragState.node.radius - 10,
      );
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

  if (!focusedPendingNode) {
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
  filesTree.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const toggleButton = target.closest("[data-file-toggle]");
    if (toggleButton instanceof HTMLElement && filesTree.contains(toggleButton)) {
      event.preventDefault();
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

function bindFileEditorEvents() {
  bindLineNumberEditors();

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
    preventSleepEnabled:
      settings.preventSleepEnabled === undefined
        ? state.settings.preventSleepEnabled
        : Boolean(settings.preventSleepEnabled),
    sleepPrevention: sleepPrevention || null,
    wikiPath: settings.wikiPath || state.settings.wikiPath || "",
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
  state.currentView = route.view;

  if (route.view === "knowledge-base") {
    state.knowledgeBase.selectedNotePath = route.notePath;
  }
}

function setCurrentView(nextView, { notePath = state.knowledgeBase.selectedNotePath } = {}) {
  if (nextView === "knowledge-base") {
    state.currentView = "knowledge-base";
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

function bindShellEvents() {
  bindLineNumberEditors();

  document.querySelectorAll("[data-open-main-view]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const nextView = link.getAttribute("data-open-main-view") || "shell";
      void openMainView(nextView);
    });
  });

  document.querySelector("#session-provider-select")?.addEventListener("change", () => {
    state.defaultProviderId = getSelectedSessionProviderId();
  });

  document.querySelectorAll("[data-folder-picker-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = button.getAttribute("data-folder-picker-target") || "session";
      if (target === "session") {
        state.defaultProviderId = getSelectedSessionProviderId();
      }

      const input =
        target === "wiki"
          ? document.querySelector("#wiki-path-input")
          : target === "files"
            ? document.querySelector("#files-root-input")
            : null;
      const initialPath =
        input instanceof HTMLInputElement && input.value.trim()
          ? input.value.trim()
          : target === "wiki"
            ? state.settings.wikiPath || state.defaultCwd
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

  document.querySelector("#refresh-sessions")?.addEventListener("click", () => loadSessions());
  document.querySelector("#agent-prompt-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
      const payload = await fetchJson("/api/agent-prompt", {
        method: "PUT",
        body: JSON.stringify({
          prompt: String(formData.get("prompt") || ""),
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
  bindAgentMailForm();
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

    const targetLabel =
      state.update?.targetType === "release" && state.update?.latestVersion
        ? state.update.latestVersion
        : "the latest GitHub version";

    if (!window.confirm(`Update Remote Vibes to ${targetLabel} and restart it?`)) {
      return;
    }

    state.updateApplying = true;
    refreshUpdateUi();

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
      refreshUpdateUi();
      refreshSystemToastsUi();
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

function closeWebsocket() {
  clearPendingTerminalOutput();

  if (state.websocket) {
    state.websocket.close();
    state.websocket = null;
  }

  state.connectedSessionId = null;
  state.terminalShowJumpToBottom = false;
  refreshTerminalJumpUi();
}

function disposeTerminal() {
  closeWebsocket();
  cleanupTerminalInteractions();
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

  const handlePointerDown = (event) => {
    if (event.pointerType && event.pointerType !== "mouse") {
      return;
    }

    state.terminal?.focus();
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
    if (!touchState.moved && touchState.maxDistance < TOUCH_TAP_SLOP_PX) {
      state.terminal?.focus();
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
    smoothScrollDuration: 60,
    theme: {
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
    },
  });

  state.fitAddon = new FitAddon();
  state.terminal.loadAddon(state.fitAddon);
  state.terminal.open(mount);
  configureTerminalTextarea(state.terminal.textarea);
  resetTerminalTextarea();
  applyTerminalDisplayProfile(mount);
  loadCanvasRenderer();
  setupTerminalInteractions(mount);
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
      queueTerminalOutput(payload.data || "", { scrollToBottom: true });
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
      state.terminal.writeln(`\r\n[remote-vibes] ${payload.message}`);
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
  try {
    const payload = await fetchJson("/api/ports");
    state.ports = payload.ports;
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
    const payload = await fetchJson("/api/settings", {
      cache: "no-store",
    });
    applySettingsState(payload.settings);
    refreshKnowledgeSettingsUi();
    if (state.currentView === "plugins") {
      refreshAgentMailPluginUi();
    }
    refreshSystemToastsUi();
  } catch (error) {
    console.error(error);
  }
}

async function loadSystemMetrics({ forceRender = false } = {}) {
  const requestId = Date.now();
  state.systemMetricsLoading = true;
  state.systemMetricsRequestId = requestId;

  if (state.currentView === "system" && (forceRender || !state.systemMetrics)) {
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
    appendSystemMetricHistory(state.systemMetrics);
    state.systemMetricsError = "";
  } catch (error) {
    if (state.systemMetricsRequestId !== requestId) {
      return;
    }

    state.systemMetricsError = error.message || "Could not load system metrics.";
  } finally {
    if (state.systemMetricsRequestId === requestId) {
      state.systemMetricsLoading = false;
      if (state.currentView === "system") {
        renderShell();
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

  state.folderPicker.currentPath = nextPath || state.folderPicker.root;
  state.folderPicker.path = pathKey;
  state.folderPicker.parentPath = getWorkspaceParentPath(state.folderPicker.currentPath);
  state.folderPicker.treeExpanded.add(pathKey);
  renderShell();

  await loadFolderPickerTreePath(pathKey);
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
    }),
  });

  applySettingsState(payload.settings);
  applyAgentPromptState(payload.agentPrompt);
  state.knowledgeBase.noteCache = {};

  if (state.currentView === "knowledge-base") {
    await loadKnowledgeBaseIndex();
    await ensureKnowledgeBaseSelectionLoaded({ force: true });
  }
}

async function setupAgentMailFromForm(form) {
  const formData = new FormData(form);
  const apiKey = String(formData.get("agentMailApiKey") || "").trim();
  const body = {
    agentMailProviderId: String(formData.get("agentMailProviderId") || "claude"),
    apiKey: apiKey || undefined,
    displayName: String(formData.get("agentMailDisplayName") || "Remote Vibes"),
    domain: String(formData.get("agentMailDomain") || ""),
    inboxId: String(formData.get("agentMailInboxId") || ""),
    username: String(formData.get("agentMailUsername") || ""),
  };

  if (formData.get("agentMailEnabled") !== "on") {
    const payload = await fetchJson("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        agentMailDisplayName: body.displayName,
        agentMailDomain: body.domain,
        agentMailEnabled: false,
        agentMailInboxId: body.inboxId,
        agentMailProviderId: body.agentMailProviderId,
        agentMailUsername: body.username,
        ...(apiKey ? { agentMailApiKey: apiKey } : {}),
      }),
    });
    applySettingsState(payload.settings);
    return;
  }

  const payload = await fetchJson("/api/agentmail/setup", {
    method: "POST",
    body: JSON.stringify(body),
  });
  applySettingsState(payload.settings);
}

async function backupWikiNow() {
  const payload = await fetchJson("/api/wiki/backup", {
    method: "POST",
  });

  applySettingsState(payload.settings || { wikiBackup: payload.backup });
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
  state.ports = payload.ports ?? [];
  state.defaultCwd = payload.cwd;
  state.defaultProviderId = payload.defaultProviderId;
  applySettingsState(payload.settings);
  state.preferredBaseUrl = payload.preferredUrl ? new URL(payload.preferredUrl).origin : "";
  applyAgentPromptState(payload.agentPrompt);

  if (maybeRedirectToPreferredOrigin()) {
    return;
  }

  const route = getRouteState();
  state.filesRootOverride = route.root || null;
  state.activeSessionId = payload.sessions[0]?.id ?? null;
  syncFilesRoot({ force: true });

  if (route.view === "file") {
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

  if (state.currentView === "knowledge-base") {
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
    loadPorts();
    if (state.currentView === "system") {
      void loadSystemMetrics();
    }
  }, 3000);
}

bootstrapApp();
