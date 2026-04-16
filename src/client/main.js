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
const KNOWLEDGE_BASE_GRAPH_DRAG_SLOP_PX = 6;
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

const state = {
  providers: [],
  sessions: [],
  ports: [],
  gpu: {
    available: false,
    total: 0,
    used: 0,
    idle: 0,
    activeAgentSessions: 0,
    totalMemoryMb: 0,
    remoteVibesMemoryMb: 0,
    otherMemoryMb: 0,
    freeMemoryMb: 0,
    perGpu: [],
  },
  gpuHistory: {
    range: "1d",
    latestTimestamp: null,
    lastUpdatedAt: null,
    sampleIntervalMs: 0,
    gpus: [],
    agentRuns: {
      totalRuns: 0,
      totalRunMs: 0,
      sessionCount: 0,
      medianRunMs: 0,
      p90RunMs: 0,
      maxRunMs: 0,
      latestEndedAt: null,
      buckets: [],
    },
  },
  currentView: "shell",
  agentPrompt: "",
  agentPromptPath: "",
  agentPromptWikiRoot: ".remote-vibes",
  agentPromptTargets: [],
  agentPromptEditorOpen: false,
  filesRootOverride: null,
  filesRoot: "",
  fileTreeEntries: {},
  fileTreeExpanded: new Set([""]),
  fileTreeLoading: new Set(),
  fileTreeError: "",
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
    selectedNoteLoading: false,
    selectedNoteError: "",
    selectedNoteRequestId: 0,
    noteCache: {},
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
  updateTimer: null,
  sessionRefreshTimer: null,
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

  if (explicitView === "gpu") {
    return {
      view: "gpu",
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
    view: window.location.hash === "#gpu" ? "gpu" : "shell",
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isLive(session) {
  if (session.status === "exited" || !session.lastOutputAt) {
    return false;
  }

  return Date.now() - new Date(session.lastOutputAt).getTime() < 2500;
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

function getSessionLabel(session) {
  if (session.status === "exited") {
    return { text: "x", className: "exited" };
  }

  return isLive(session)
    ? { text: "live", className: "live" }
    : { text: "idle", className: "idle" };
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

function shouldUseCanvasRenderer() {
  return !isCoarsePointerDevice() && !/firefox/i.test(window.navigator.userAgent || "");
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
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
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

function getGpuDashboardUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "gpu");
  url.searchParams.delete("note");
  url.hash = "";
  return url.toString();
}

function getShellUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("view");
  url.searchParams.delete("note");
  url.hash = "";
  return url.toString();
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

function isOpenFileDirty() {
  return state.openFileStatus === "text" && state.openFileDraft !== state.openFileContent;
}

function resetOpenFile() {
  state.openFileRequestId += 1;
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
  state.openFileRequestId += 1;
  state.openFileRelativePath = normalizedPath;
  state.openFileName = getFileDisplayName(normalizedPath);
  state.openFileStatus = status;
  state.openFileContent = "";
  state.openFileDraft = "";
  state.openFileMessage = message;
  state.openFileSaving = false;
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
  } else if (view === "gpu") {
    url.searchParams.set("view", "gpu");
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
  state.knowledgeBase.selectedNoteError = "";

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
    state.knowledgeBase.selectedNoteError = "";
    state.knowledgeBase.selectedNoteLoading = false;
    return;
  }

  const cachedNote = !force ? state.knowledgeBase.noteCache[normalizedPath] : null;
  if (cachedNote) {
    state.knowledgeBase.selectedNotePath = normalizedPath;
    state.knowledgeBase.selectedNoteTitle = cachedNote.title;
    state.knowledgeBase.selectedNoteContent = cachedNote.content;
    state.knowledgeBase.selectedNoteError = "";
    state.knowledgeBase.selectedNoteLoading = false;
    return;
  }

  const requestId = state.knowledgeBase.selectedNoteRequestId + 1;
  state.knowledgeBase.selectedNoteRequestId = requestId;
  state.knowledgeBase.selectedNotePath = normalizedPath;
  state.knowledgeBase.selectedNoteLoading = true;
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

async function openKnowledgeBaseNote(relativePath, { force = false } = {}) {
  const normalizedPath = normalizeFileTreePath(relativePath) || getKnowledgeBaseDefaultNotePath();

  if (!normalizedPath) {
    return;
  }

  state.knowledgeBase.selectedNotePath = normalizedPath;
  updateRoute({ view: "knowledge-base", notePath: normalizedPath });
  renderShell();
  await loadKnowledgeBaseNote(normalizedPath, { force });
  renderShell();
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

    if (/^```/.test(line)) {
      index += 1;
      const codeLines = [];

      while (index < lines.length && !/^```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      html.push(`<pre class="knowledge-base-code"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
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
  if (state.knowledgeBase.loading && !state.knowledgeBase.notes.length) {
    return `<div class="blank-state">loading notes</div>`;
  }

  if (state.knowledgeBase.error) {
    return `<div class="blank-state">${escapeHtml(state.knowledgeBase.error)}</div>`;
  }

  if (!state.knowledgeBase.notes.length) {
    return `<div class="blank-state">no markdown notes yet</div>`;
  }

  return state.knowledgeBase.notes
    .map((note) => {
      const isActive = note.relativePath === state.knowledgeBase.selectedNotePath;
      return `
        <button
          class="knowledge-base-note-row ${isActive ? "is-active" : ""}"
          type="button"
          data-kb-note="${escapeHtml(note.relativePath)}"
        >
          <span class="knowledge-base-note-title">${escapeHtml(note.title)}</span>
          <span class="knowledge-base-note-path">${escapeHtml(note.relativePath)}</span>
          <span class="knowledge-base-note-excerpt">${escapeHtml(note.excerpt || "No preview yet.")}</span>
        </button>
      `;
    })
    .join("");
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

function renderKnowledgeBaseView() {
  const selectedNoteMeta = getKnowledgeBaseSelectedNoteMeta();
  const selectedNotePath = state.knowledgeBase.selectedNotePath;
  const rawHref = selectedNotePath ? getKnowledgeBaseNoteRawUrl(selectedNotePath) : "";

  let noteBody = `<div class="blank-state">select a note to view it here</div>`;

  if (state.knowledgeBase.selectedNoteLoading) {
    noteBody = `<div class="blank-state">opening note...</div>`;
  } else if (state.knowledgeBase.selectedNoteError) {
    noteBody = `<div class="blank-state">${escapeHtml(state.knowledgeBase.selectedNoteError)}</div>`;
  } else if (state.knowledgeBase.selectedNoteContent) {
    noteBody = `
      <div class="knowledge-base-markdown">
        ${renderKnowledgeBaseMarkdown(state.knowledgeBase.selectedNoteContent, selectedNotePath)}
      </div>
    `;
  }

  return `
    <section class="dashboard-panel knowledge-base-view">
      <div class="dashboard-toolbar">
        <div class="dashboard-copy">
          <strong>Knowledge Base</strong>
          <div class="terminal-meta">obsidian-style markdown viewer for ${escapeHtml(state.knowledgeBase.relativeRoot)}</div>
        </div>
        <div class="dashboard-actions knowledge-base-toolbar-actions">
          <button class="ghost-button toolbar-control" type="button" id="refresh-knowledge-base">refresh</button>
          <button class="ghost-button toolbar-control" type="button" id="back-to-shell">back</button>
        </div>
      </div>
      <div class="dashboard-range knowledge-base-summary">
        <span class="dashboard-range-label">root</span>
        <span class="knowledge-base-root">${escapeHtml(state.knowledgeBase.relativeRoot)}</span>
        <span class="dashboard-updated">${escapeHtml(
          `${state.knowledgeBase.notes.length} notes`,
        )}</span>
      </div>
      <div class="knowledge-base-grid">
        <aside class="knowledge-base-column knowledge-base-column-list">
          <div class="knowledge-base-panel-head">
            <div>
              <strong>Markdown Notes</strong>
              <div class="knowledge-base-panel-meta">browse linked pages</div>
            </div>
          </div>
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
            ${
              rawHref
                ? `<a class="ghost-button toolbar-control" href="${escapeHtml(rawHref)}" target="_blank" rel="noreferrer">raw</a>`
                : ""
            }
          </div>
          <div class="knowledge-base-note-card">
            ${noteBody}
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
            <div class="knowledge-base-app-meta">${escapeHtml(
              `Obsidian-style markdown workspace for ${state.knowledgeBase.relativeRoot}`,
            )}</div>
          </div>
          <div class="knowledge-base-app-actions">
            ${rawHref
              ? `<a class="ghost-button toolbar-control" href="${escapeHtml(rawHref)}" target="_blank" rel="noreferrer">raw</a>`
              : ""}
            <button class="ghost-button toolbar-control" type="button" id="refresh-knowledge-base">refresh</button>
            <a class="ghost-button toolbar-control" href="${escapeHtml(getAppBaseUrl())}/">remote vibes</a>
          </div>
        </header>

        <div class="knowledge-base-app-summary">
          <span class="dashboard-range-label">root</span>
          <span class="knowledge-base-root">${escapeHtml(state.knowledgeBase.relativeRoot)}</span>
          <span class="dashboard-updated">${escapeHtml(
            `${state.knowledgeBase.notes.length} notes`,
          )}</span>
        </div>

        <div class="knowledge-base-grid">
          <aside class="knowledge-base-column knowledge-base-column-list">
            <div class="knowledge-base-panel-head">
              <div>
                <strong>Markdown Notes</strong>
                <div class="knowledge-base-panel-meta">browse linked pages</div>
              </div>
            </div>
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
            </div>
            <div class="knowledge-base-note-card">
              ${
                state.knowledgeBase.selectedNoteLoading
                  ? `<div class="blank-state">opening note...</div>`
                  : state.knowledgeBase.selectedNoteError
                    ? `<div class="blank-state">${escapeHtml(state.knowledgeBase.selectedNoteError)}</div>`
                    : state.knowledgeBase.selectedNoteContent
                      ? `<div class="knowledge-base-markdown">${renderKnowledgeBaseMarkdown(
                          state.knowledgeBase.selectedNoteContent,
                          selectedNotePath,
                        )}</div>`
                      : `<div class="blank-state">select a note to view it here</div>`
              }
            </div>
          </section>
          <aside class="knowledge-base-column knowledge-base-column-graph">
            ${renderKnowledgeBaseGraph()}
          </aside>
        </div>
      </section>
    </main>
  `;
}

function renderOpenFilePanel() {
  if (!state.openFileRelativePath) {
    return `<div class="blank-state">no file selected</div>`;
  }

  const rawHref = getFileContentUrl(state.openFileRelativePath);
  const dirty = isOpenFileDirty();

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
          <button class="${dirty ? "primary-button" : "ghost-button"} file-editor-button" type="button" id="save-open-file" ${(!dirty || state.openFileSaving) ? "disabled" : ""}>${state.openFileSaving ? "saving..." : dirty ? "save" : "saved"}</button>
        </div>
      </div>
      <div class="file-editor-status" id="open-file-status">${escapeHtml(
        state.openFileSaving ? "saving changes..." : dirty ? "unsaved changes" : "saved",
      )}</div>
      <textarea
        class="file-editor-textarea"
        id="open-file-editor"
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="none"
      >${escapeHtml(state.openFileDraft)}</textarea>
    </div>
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
              <span class="file-caret">${expanded ? "v" : ">"}</span>
              <span class="file-label">${escapeHtml(entry.name)}</span>
            </button>
            ${children}
          </div>
        `;
      }

      const isOpen = entry.relativePath === state.openFileRelativePath;
      const openMode = entry.isImage ? "raw" : isLikelyTextFile(entry.name) ? "text" : "raw";
      return `
        <button
          class="file-row file-row-button file-open-button ${isOpen ? "is-active" : ""}"
          type="button"
          data-file-open="${escapeHtml(entry.relativePath)}"
          data-file-open-mode="${openMode}"
          style="--depth:${depth}"
        >
          <span class="file-caret">${entry.isImage ? "img" : openMode === "text" ? "txt" : "file"}</span>
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

function renderSessionCards() {
  if (!state.sessions.length) {
    return `<div class="blank-state">no sessions</div>`;
  }

  return state.sessions
    .map((session) => {
      const status = getSessionLabel(session);

      return `
        <article class="session-card ${session.id === state.activeSessionId ? "is-active" : ""}" data-session-id="${session.id}">
          <div class="session-main">
            <div class="session-name">${escapeHtml(session.name)}</div>
            <div class="session-subtitle">${escapeHtml(session.providerLabel)}</div>
          </div>
          <div class="session-side">
            <span class="session-status ${status.className}">${status.text}</span>
            <div class="session-actions">
              <button class="ghost-button session-action-button" type="button" aria-label="Fork session" data-fork-session="${session.id}">fork</button>
              <button class="ghost-button session-action-button" type="button" aria-label="Rename session" data-rename-session="${session.id}">edit</button>
              <button class="danger-button" type="button" aria-label="Delete session" data-delete-session="${session.id}">x</button>
            </div>
          </div>
          <div class="session-time">${relativeTime(session.lastOutputAt)}</div>
        </article>
      `;
    })
    .join("");
}

function renderPortCards() {
  if (!state.ports.length) {
    return `<div class="blank-state">no ports</div>`;
  }

  return state.ports
    .map(
      (port) => `
        <article class="port-card">
          <a class="port-link" href="${escapeHtml(`${getAppBaseUrl()}${port.proxyPath}`)}" target="_blank" rel="noreferrer">
            <span class="port-number">${escapeHtml(getPortDisplayName(port))}</span>
            <span class="port-meta">${escapeHtml(getPortMeta(port))}</span>
          </a>
          <button class="ghost-button port-rename-button" type="button" data-rename-port="${escapeHtml(port.port)}">edit</button>
        </article>
      `,
    )
    .join("");
}

function renderGpuCard() {
  const gpu = state.gpu || {};
  const statusText = gpu.available ? `${gpu.used} / ${gpu.total} in use` : "unavailable";
  const detailText = gpu.available
    ? `${gpu.activeAgentSessions || 0} active agent${gpu.activeAgentSessions === 1 ? "" : "s"}`
    : "nvidia-smi unavailable";
  const summaryText = gpu.available
    ? `${Math.round((gpu.remoteVibesMemoryMb || 0) / 1024)} GB ours · ${Math.round((gpu.otherMemoryMb || 0) / 1024)} GB other`
    : "green: remote vibes · yellow: other";
  const bars = gpu.available && Array.isArray(gpu.perGpu) && gpu.perGpu.length
    ? gpu.perGpu
        .map((entry) => {
          const total = Math.max(1, entry.totalMemoryMb || 0);
          const remotePercent = Math.max(0, Math.min(100, (entry.remoteVibesMemoryMb / total) * 100));
          const otherPercent = Math.max(0, Math.min(100 - remotePercent, (entry.otherMemoryMb / total) * 100));

          return `
            <div class="gpu-row">
              <div class="gpu-row-copy">
                <span class="gpu-row-label">gpu ${escapeHtml(entry.index)}</span>
                <span class="gpu-row-meta">${escapeHtml(
                  `${Math.round(entry.remoteVibesMemoryMb / 1024)}G ours · ${Math.round(entry.otherMemoryMb / 1024)}G other / ${Math.round(entry.totalMemoryMb / 1024)}G`,
                )}</span>
              </div>
              <div class="gpu-bar" aria-hidden="true">
                <span class="gpu-bar-fill gpu-bar-fill-remote" style="width:${remotePercent}%"></span>
                <span class="gpu-bar-fill gpu-bar-fill-other" style="left:${remotePercent}%;width:${otherPercent}%"></span>
              </div>
            </div>
          `;
        })
        .join("")
    : `<div class="gpu-empty">No GPU telemetry available.</div>`;

  return `
    <a class="gpu-card ${gpu.available ? "" : "is-unavailable"}" href="${escapeHtml(getGpuDashboardUrl())}" target="_blank" rel="noreferrer">
      <div class="gpu-topline">
        <span class="gpu-metric">${escapeHtml(statusText)}</span>
        <span class="gpu-detail">${escapeHtml(detailText)}</span>
      </div>
      <div class="gpu-summary">${escapeHtml(summaryText)}</div>
      <div class="gpu-bars">${bars}</div>
    </a>
  `;
}

function formatGpuRangeLabel(range) {
  if (range === "7d") {
    return "7 days";
  }

  if (range === "30d") {
    return "month";
  }

  return "1 day";
}

function formatDurationCompact(durationMs) {
  const totalSeconds = Math.max(0, Math.round((Number(durationMs) || 0) / 1000));
  if (!totalSeconds) {
    return "0s";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
  }

  if (hours) {
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes) {
    return seconds && minutes < 5 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}

function formatGpuDashboardTimestamp(timestamp, range) {
  if (!timestamp) {
    return "No samples yet";
  }

  const date = new Date(timestamp);

  if (range === "1d") {
    return date.toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
  }

  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" });
}

function buildGpuAreaPath(points, width, height, key, lowerKey = null) {
  if (!points.length) {
    return "";
  }

  const topPoints = points.map((point) => `${point.x},${point[key]}`);
  const lowerPoints = points
    .slice()
    .reverse()
    .map((point) => `${point.x},${lowerKey ? point[lowerKey] : height}`);

  return `M ${topPoints.join(" L ")} L ${lowerPoints.join(" L ")} Z`;
}

function buildGpuLinePath(points, width, key) {
  if (!points.length) {
    return "";
  }

  return `M ${points.map((point) => `${point.x},${point[key]}`).join(" L ")}`;
}

function renderAgentRunDistributionCard() {
  const history = state.gpuHistory.agentRuns || {};
  const totalRuns = Number(history.totalRuns) || 0;
  const buckets = Array.isArray(history.buckets) ? history.buckets : [];
  const maxBucketCount = Math.max(1, ...buckets.map((bucket) => Number(bucket.count) || 0));
  const bucketMarkup = buckets.length
    ? buckets
        .map((bucket) => {
          const count = Number(bucket.count) || 0;
          const percent = totalRuns ? Math.round((count / totalRuns) * 100) : 0;
          const width = Math.max(count > 0 ? 10 : 0, Math.round((count / maxBucketCount) * 100));

          return `
            <div class="run-bucket-row">
              <div class="run-bucket-copy">
                <span class="run-bucket-label">${escapeHtml(bucket.label)}</span>
                <span class="run-bucket-meta">${escapeHtml(`${count} run${count === 1 ? "" : "s"} · ${percent}%`)}</span>
              </div>
              <div class="run-bucket-bar" aria-hidden="true">
                <span class="run-bucket-fill" style="width:${width}%"></span>
              </div>
            </div>
          `;
        })
        .join("")
    : "";
  const stats = [
    { label: "runs", value: String(totalRuns) },
    { label: "sessions", value: String(Number(history.sessionCount) || 0) },
    { label: "median", value: formatDurationCompact(history.medianRunMs) },
    { label: "p90", value: formatDurationCompact(history.p90RunMs) },
    { label: "max", value: formatDurationCompact(history.maxRunMs) },
    { label: "autonomy", value: formatDurationCompact(history.totalRunMs) },
  ]
    .map(
      (entry) => `
        <div class="run-stat">
          <span class="run-stat-label">${escapeHtml(entry.label)}</span>
          <strong class="run-stat-value">${escapeHtml(entry.value)}</strong>
        </div>
      `,
    )
    .join("");

  return `
    <article class="gpu-chart-card run-distribution-card">
      <div class="gpu-chart-header">
        <div>
          <strong>Agent Run Lengths</strong>
          <div class="gpu-chart-meta">prompt submit to quiet or exit · longer buckets mean more autonomous runs</div>
        </div>
      </div>
      <div class="run-stats-grid">
        ${stats}
      </div>
      ${
        totalRuns
          ? `
            <div class="run-buckets">
              ${bucketMarkup}
            </div>
          `
          : `<div class="blank-state">No completed agent runs yet for this range. Start a prompt in an agent session and it will show up here once the run goes quiet.</div>`
      }
    </article>
  `;
}

function renderGpuChart(gpuEntry) {
  const width = 860;
  const height = 220;
  const paddingTop = 18;
  const paddingBottom = 28;
  const chartHeight = height - paddingTop - paddingBottom;
  const points = gpuEntry.points;

  if (!points.length) {
    return `<div class="blank-state">no samples for gpu ${escapeHtml(gpuEntry.index)}</div>`;
  }

  const minTimestamp = points[0].timestamp;
  const maxTimestamp = points[points.length - 1].timestamp || minTimestamp + 1;
  const timestampSpan = Math.max(1, maxTimestamp - minTimestamp);
  const totalMemoryMb = Math.max(
    1,
    ...points.map((point) => Math.max(point.totalMemoryMb, point.remoteVibesMemoryMb + point.otherMemoryMb)),
  );
  const scaledPoints = points.map((point) => {
    const usedRemote = point.remoteVibesMemoryMb;
    const usedStacked = point.remoteVibesMemoryMb + point.otherMemoryMb;
    return {
      x: ((point.timestamp - minTimestamp) / timestampSpan) * width,
      remoteTop: paddingTop + chartHeight * (1 - usedRemote / totalMemoryMb),
      stackedTop: paddingTop + chartHeight * (1 - usedStacked / totalMemoryMb),
      timestamp: point.timestamp,
    };
  });
  const startLabel = formatGpuDashboardTimestamp(minTimestamp, state.gpuHistory.range);
  const endLabel = formatGpuDashboardTimestamp(maxTimestamp, state.gpuHistory.range);

  return `
    <article class="gpu-chart-card">
      <div class="gpu-chart-header">
        <div>
          <strong>GPU ${escapeHtml(gpuEntry.index)}</strong>
          <div class="gpu-chart-meta">${escapeHtml(
            `${Math.round((points[points.length - 1].totalMemoryMb || 0) / 1024)} GB total`,
          )}</div>
        </div>
      </div>
      <svg class="gpu-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="GPU ${escapeHtml(gpuEntry.index)} history">
        <line class="gpu-grid-line" x1="0" y1="${paddingTop}" x2="${width}" y2="${paddingTop}" />
        <line class="gpu-grid-line" x1="0" y1="${paddingTop + chartHeight / 2}" x2="${width}" y2="${paddingTop + chartHeight / 2}" />
        <line class="gpu-grid-line" x1="0" y1="${paddingTop + chartHeight}" x2="${width}" y2="${paddingTop + chartHeight}" />
        <path class="gpu-area-other" d="${buildGpuAreaPath(scaledPoints, width, height, "stackedTop", "remoteTop")}" />
        <path class="gpu-area-remote" d="${buildGpuAreaPath(scaledPoints, width, height, "remoteTop")}" />
        <path class="gpu-line-remote" d="${buildGpuLinePath(scaledPoints, width, "remoteTop")}" />
        <path class="gpu-line-stacked" d="${buildGpuLinePath(scaledPoints, width, "stackedTop")}" />
      </svg>
      <div class="gpu-chart-axis">
        <span>${escapeHtml(startLabel)}</span>
        <span>${escapeHtml(endLabel)}</span>
      </div>
    </article>
  `;
}

function renderGpuDashboard() {
  const history = state.gpuHistory;
  const gpuCards = history.gpus.length
    ? history.gpus.map((gpuEntry) => renderGpuChart(gpuEntry)).join("")
    : `<div class="blank-state">No GPU history yet. Samples will appear here after Remote Vibes records them.</div>`;
  const cards = `${renderAgentRunDistributionCard()}${gpuCards}`;

  return `
    <section class="dashboard-panel">
      <div class="dashboard-toolbar">
        <div class="dashboard-copy">
          <strong>GPU Dashboard</strong>
          <div class="terminal-meta">stacked GPU memory history plus agent autonomy · green is remote vibes · yellow is other workloads</div>
        </div>
        <div class="dashboard-actions">
          <a class="ghost-button toolbar-control" href="${escapeHtml(getShellUrl())}">remote vibes</a>
        </div>
      </div>
      <div class="dashboard-range">
        <span class="dashboard-range-label">range</span>
        ${["1d", "7d", "30d"]
          .map(
            (range) => `
              <button class="ghost-button dashboard-range-button ${history.range === range ? "is-active" : ""}" type="button" data-gpu-range="${range}">
                ${escapeHtml(formatGpuRangeLabel(range))}
              </button>
            `,
          )
          .join("")}
        <span class="dashboard-updated">${escapeHtml(formatGpuDashboardTimestamp(history.lastUpdatedAt, history.range))}</span>
      </div>
      <div class="dashboard-grid">
        ${cards}
      </div>
    </section>
  `;
}

function renderGpuApp() {
  document.title = "GPU Dashboard · Remote Vibes";

  return `
    <main class="screen">
      ${renderGpuDashboard()}
    </main>
  `;
}

function renderTerminalPanel(activeSession) {
  if (state.currentView === "knowledge-base") {
    return renderKnowledgeBaseView();
  }

  if (state.currentView === "gpu") {
    return renderGpuDashboard();
  }

  return `
    <section class="terminal-panel">
      <div class="terminal-toolbar">
        <button class="icon-button hidden-desktop" type="button" id="open-sidebar">≡</button>
        <div class="terminal-copy">
          <strong id="toolbar-title">${escapeHtml(activeSession ? activeSession.name : "new session")}</strong>
          <div class="terminal-meta" id="toolbar-meta">${escapeHtml(
            activeSession ? `${activeSession.providerLabel} · ${activeSession.cwd}` : state.defaultCwd,
          )}</div>
        </div>
        <div class="toolbar-actions">
          <button class="ghost-button hidden-desktop toolbar-control" type="button" id="open-files-sidebar" aria-label="Open files sidebar">files</button>
          <button class="icon-button" type="button" id="refresh-sessions" aria-label="Refresh sessions">↻</button>
          <button class="ghost-button toolbar-control" type="button" id="tab-button" data-terminal-control aria-label="Send Tab" ${activeSession ? "" : "disabled"}>tab</button>
          <button class="ghost-button toolbar-control" type="button" id="shift-tab-button" data-terminal-control aria-label="Send Shift Tab" ${activeSession ? "" : "disabled"}>⇧⇥</button>
          <button class="ghost-button toolbar-control" type="button" id="ctrl-p-button" data-terminal-control aria-label="Send Control P" ${activeSession ? "" : "disabled"}>^P</button>
          <button class="ghost-button toolbar-control" type="button" id="ctrl-t-button" data-terminal-control aria-label="Send Control T" ${activeSession ? "" : "disabled"}>^T</button>
          <button class="ghost-button toolbar-control" type="button" id="ctrl-c-button" data-terminal-control aria-label="Send Control C" ${activeSession ? "" : "disabled"}>^C</button>
        </div>
      </div>

      <div class="terminal-stack">
        <div class="terminal-mount" id="terminal-mount"></div>
        <button class="jump-bottom-button ${activeSession && state.terminalShowJumpToBottom ? "is-visible" : ""}" type="button" id="jump-to-bottom" aria-label="Jump to bottom" ${activeSession ? "" : "disabled"}>
          bottom
        </button>
        <div class="empty-state ${activeSession ? "hidden" : ""}" id="empty-state">
          <p class="empty-state-copy">open the menu by tapping the top left icon, then click + to create a new session</p>
        </div>
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

function renderAgentPromptModal() {
  if (!state.agentPromptEditorOpen) {
    return "";
  }

  return `
    <div class="prompt-modal-shell" data-prompt-modal>
      <button class="sidebar-scrim is-open" type="button" aria-label="Close prompt editor" data-close-prompt></button>
      <section class="prompt-modal">
        <div class="section-head">
          <span>agent prompt</span>
          <button class="icon-button" type="button" data-close-prompt>×</button>
        </div>
        <div class="prompt-modal-copy">
          <div>source: ${escapeHtml(state.agentPromptPath || ".remote-vibes/agent-prompt.md")}</div>
          <div>wiki root: ${escapeHtml(state.agentPromptWikiRoot)}</div>
        </div>
        <form class="prompt-form" id="agent-prompt-form">
          <textarea
            class="prompt-textarea"
            name="prompt"
            spellcheck="false"
            autocapitalize="none"
            autocorrect="off"
          >${escapeHtml(state.agentPrompt)}</textarea>
          <div class="inline-form">
            <button class="ghost-button" type="button" data-close-prompt>close</button>
            <button class="primary-button" type="submit">save</button>
          </div>
        </form>
      </section>
    </div>
  `;
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
  if (state.currentView === "knowledge-base") {
    app.innerHTML = renderKnowledgeBaseApp();
    disposeTerminal();
    refreshKnowledgeBaseUi();
    return;
  }

  if (state.currentView === "gpu") {
    app.innerHTML = renderGpuApp();
    disposeTerminal();
    bindGpuDashboardEvents();
    return;
  }

  document.title = "Remote Vibes";

  teardownKnowledgeBaseGraphInteractions();
  syncFilesRoot();
  document.title = "Remote Vibes";

  const providerOptions = state.providers
    .map(
      (provider) => `
        <option value="${provider.id}" ${provider.id === state.defaultProviderId ? "selected" : ""} ${provider.available ? "" : "disabled"}>
          ${escapeHtml(provider.label)}${provider.available ? "" : " · missing"}
        </option>
      `,
    )
    .join("");

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;

  app.innerHTML = `
    <main class="screen app-shell">
      <button class="sidebar-scrim ${state.mobileSidebar ? "is-open" : ""}" type="button" aria-label="Close sidebars" data-sidebar-scrim></button>
      <aside class="sidebar sidebar-left ${state.mobileSidebar === "left" ? "is-open" : ""}" data-sidebar-panel="left">
        <div class="sidebar-mobile-actions">
          <button class="icon-button hidden-desktop" type="button" id="close-left-sidebar">×</button>
        </div>

        <div class="sidebar-body">
          <div class="update-slot" id="update-banner">${renderUpdateBanner()}</div>

          <form class="session-form" id="session-form">
            <select name="providerId">${providerOptions}</select>
            <input type="text" name="cwd" value="${escapeHtml(state.defaultCwd || "")}" placeholder="cwd" />
            <div class="inline-form">
              <input type="text" name="name" placeholder="name" />
              <button class="primary-button" type="submit">+</button>
            </div>
          </form>

          <section class="sidebar-section">
            <div class="section-head">
              <span>sessions</span>
            </div>
            <div class="list-shell" id="sessions-list">${renderSessionCards()}</div>
          </section>

          <section class="sidebar-section">
            <div class="section-head">
              <span>gpu usage</span>
              <a class="ghost-button" href="${escapeHtml(getGpuDashboardUrl())}" target="_blank" rel="noreferrer">view</a>
            </div>
            <div id="gpu-card">${renderGpuCard()}</div>
          </section>

          <section class="sidebar-section">
            <div class="section-head">
              <span>knowledge base</span>
              <a
                class="ghost-button"
                id="open-knowledge-base"
                href="${escapeHtml(getKnowledgeBaseUrl(state.knowledgeBase.selectedNotePath || ""))}"
                target="_blank"
                rel="noreferrer"
              >
                view
              </a>
            </div>
            <div class="prompt-copy">
              <div>obsidian-style view for ${escapeHtml(state.agentPromptWikiRoot)}/wiki</div>
              <div>markdown notes + graph view in a dedicated tab</div>
            </div>
          </section>

          <section class="sidebar-section">
            <div class="section-head">
              <span>agent prompt</span>
              <button class="ghost-button" type="button" id="edit-agent-prompt">edit</button>
            </div>
            <div class="prompt-copy">
              <div>source: ${escapeHtml(state.agentPromptPath || ".remote-vibes/agent-prompt.md")}</div>
              <div>wiki root: ${escapeHtml(state.agentPromptWikiRoot)}</div>
            </div>
            <div class="list-shell" id="agent-prompt-targets">${renderAgentPromptTargets()}</div>
          </section>

          <section class="sidebar-section">
            <div class="section-head">
              <span>files</span>
              <div class="section-actions">
                <button class="ghost-button files-root-reset" type="button" id="auto-files-root" ${state.filesRootOverride ? "" : "disabled"}>auto</button>
                <button class="icon-button" type="button" id="refresh-files">↻</button>
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
                autocomplete="off"
                autocorrect="off"
                autocapitalize="none"
                spellcheck="false"
              />
              <button class="ghost-button file-root-submit" type="submit">set</button>
            </form>
            <div class="file-tree" id="files-tree">${renderFileTree()}</div>
          </section>

          <section class="sidebar-section">
            <div class="section-head">
              <span>ports</span>
              <button class="icon-button" type="button" id="refresh-ports">↻</button>
            </div>
            <div class="list-shell" id="ports-list">${renderPortCards()}</div>
          </section>
        </div>

        <div class="sidebar-footer">
          <div class="sidebar-footer-actions">
            <button class="ghost-button relaunch-button" type="button" id="relaunch-app">relaunch</button>
            <button class="danger-button terminate-button" type="button" id="terminate-app">terminate</button>
          </div>
        </div>
      </aside>

      ${renderTerminalPanel(activeSession)}
      ${renderAgentPromptModal()}
      <aside class="sidebar sidebar-right ${state.mobileSidebar === "right" ? "is-open" : ""}" data-sidebar-panel="right">
        <div class="sidebar-mobile-actions sidebar-mobile-actions-right">
          <button class="icon-button hidden-desktop" type="button" id="close-right-sidebar">×</button>
        </div>

        <div class="sidebar-body">
          <section class="sidebar-section sidebar-section-fill">
            <div class="section-head">
              <span>files</span>
              <div class="section-actions">
                <button class="ghost-button files-root-reset" type="button" id="auto-files-root" ${state.filesRootOverride ? "" : "disabled"}>auto</button>
                <button class="icon-button" type="button" id="refresh-files">↻</button>
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
                autocomplete="off"
                autocorrect="off"
                autocapitalize="none"
                spellcheck="false"
              />
              <button class="ghost-button file-root-submit" type="submit">set</button>
            </form>
            <div class="file-browser-stack">
              <div class="file-tree" id="files-tree">${renderFileTree()}</div>
            </div>
          </section>
        </div>
      </aside>
    </main>
  `;

  bindShellEvents();

  if (state.currentView === "shell") {
    mountTerminal();
    refreshShellUi();
  } else {
    disposeTerminal();
    refreshGpuCard();
    refreshKnowledgeBaseUi();
  }

  void refreshOpenFileTree();
}

function bindSessionEvents() {
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

      if (nextSessionId === state.activeSessionId) {
        renderShell();
        connectToSession(state.activeSessionId);
        closeMobileSidebar();
        return;
      }

      state.activeSessionId = nextSessionId;
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

function refreshUpdateUi() {
  const updateBanner = document.querySelector("#update-banner");
  if (!updateBanner) {
    return;
  }

  updateBanner.innerHTML = renderUpdateBanner();
  bindUpdateEvents();
}

function refreshGpuCard() {
  const gpuCard = document.querySelector("#gpu-card");
  if (!gpuCard) {
    return;
  }

  gpuCard.innerHTML = renderGpuCard();
  bindGpuNavigationEvents();
}

function bindGpuNavigationEvents() {
  document.querySelector("#gpu-card .gpu-card")?.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }

    event.preventDefault();
    setCurrentView("gpu");
    void loadGpuHistory(state.gpuHistory.range).then(() => renderShell());
  });
}

function bindPortEvents() {
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

  startKnowledgeBaseGraphSimulation(0.22);
}

function bindKnowledgeBaseEvents() {
  document.querySelectorAll("[data-kb-note]").forEach((button) => {
    button.onclick = async () => {
      const notePath = button.getAttribute("data-kb-note");
      await openKnowledgeBaseNote(notePath || "");
    };
  });

  document.querySelectorAll("[data-kb-open-note]").forEach((button) => {
    button.onclick = async () => {
      const notePath = button.getAttribute("data-kb-open-note");
      await openKnowledgeBaseNote(notePath || "");
    };
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
    return;
  }

  bindKnowledgeBaseGraphInteractions();
}

function bindFileTreeEvents() {
  document.querySelectorAll("[data-file-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const relativePath = normalizeFileTreePath(button.getAttribute("data-file-toggle"));

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
    });
  });

  document.querySelectorAll("[data-file-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const relativePath = normalizeFileTreePath(button.getAttribute("data-file-open"));
      const openMode = button.getAttribute("data-file-open-mode");

      if (!relativePath) {
        return;
      }

      if (openMode === "raw") {
        setOpenFileSelection(relativePath);
        refreshFileTreeUi();
        refreshOpenFileUi();
        openFileInNewTab(relativePath);
        return;
      }

      setOpenFileSelection(relativePath);
      refreshFileTreeUi();
      refreshOpenFileUi();
      openTextFileInNewTab(relativePath);
    });
  });
}

function refreshFileTreeUi() {
  const filesRootInput = document.querySelector("#files-root-input");
  const filesTree = document.querySelector("#files-tree");
  const autoFilesRootButton = document.querySelector("#auto-files-root");
  const nextRoot = state.filesRoot || state.defaultCwd || "";

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

  filesTree.innerHTML = renderFileTree();
  bindFileTreeEvents();
}

function refreshOpenFileUi() {
  const fileEditor = document.querySelector("#file-editor");
  if (!fileEditor) {
    return;
  }

  fileEditor.innerHTML = renderOpenFilePanel();
  bindFileEditorEvents();
}

function syncOpenFileEditorStateUi() {
  const status = document.querySelector("#open-file-status");
  const saveButton = document.querySelector("#save-open-file");

  if (status) {
    status.textContent = state.openFileSaving
      ? "saving changes..."
      : isOpenFileDirty()
        ? "unsaved changes"
        : "saved";
  }

  if (saveButton instanceof HTMLButtonElement) {
    const dirty = isOpenFileDirty();
    saveButton.disabled = !dirty || state.openFileSaving;
    saveButton.textContent = state.openFileSaving ? "saving..." : dirty ? "save" : "saved";
    saveButton.classList.toggle("primary-button", dirty);
    saveButton.classList.toggle("ghost-button", !dirty);
  }
}

function bindFileEditorEvents() {
  document.querySelector("#open-file-editor")?.addEventListener("input", (event) => {
    const textarea = event.currentTarget;
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return;
    }

    state.openFileDraft = textarea.value;
    syncOpenFileEditorStateUi();
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

  refreshGpuCard();
  refreshKnowledgeBaseUi();
  refreshToolbarUi();
}

async function openWorkspaceFile(relativePath, { force = false } = {}) {
  const normalizedPath = normalizeFileTreePath(relativePath);
  const root = state.filesRoot;

  if (!root || !normalizedPath) {
    return;
  }

  if (!force && state.openFileRelativePath === normalizedPath && state.openFileStatus === "text") {
    refreshOpenFileUi();
    return;
  }

  const requestId = state.openFileRequestId + 1;
  state.openFileRequestId = requestId;
  state.openFileRelativePath = normalizedPath;
  state.openFileName = getFileDisplayName(normalizedPath);
  state.openFileStatus = "loading";
  state.openFileContent = "";
  state.openFileDraft = "";
  state.openFileMessage = "";
  state.openFileSaving = false;
  refreshFileTreeUi();
  refreshOpenFileUi();

  try {
    const payload = await fetchJson(`/api/files/text?${getFileTextRequestParams(normalizedPath).toString()}`);

    if (state.openFileRequestId !== requestId || state.filesRoot !== root) {
      return;
    }

    state.openFileStatus = "text";
    state.openFileContent = payload.file.content;
    state.openFileDraft = payload.file.content;
    state.openFileMessage = "";
    state.openFileSaving = false;
    refreshOpenFileUi();
  } catch (error) {
    if (state.openFileRequestId !== requestId || state.filesRoot !== root) {
      return;
    }

    if (error.status === 400 || error.status === 413) {
      state.openFileStatus = "external";
      state.openFileContent = "";
      state.openFileDraft = "";
      state.openFileMessage = "this file is not editable as UTF-8 text, but you can still open it raw";
      refreshOpenFileUi();
      return;
    }

    state.openFileStatus = "error";
    state.openFileMessage = error.message;
    refreshOpenFileUi();
  }
}

async function reloadOpenFile() {
  if (!state.openFileRelativePath || state.openFileSaving) {
    return;
  }

  await openWorkspaceFile(state.openFileRelativePath, { force: true });
}

async function saveOpenFile() {
  if (
    !state.filesRoot ||
    !state.openFileRelativePath ||
    state.openFileStatus !== "text" ||
    state.openFileSaving ||
    !isOpenFileDirty()
  ) {
    return;
  }

  const root = state.filesRoot;
  const relativePath = state.openFileRelativePath;
  state.openFileSaving = true;
  syncOpenFileEditorStateUi();

  try {
    const payload = await fetchJson("/api/files/text", {
      method: "PUT",
      body: JSON.stringify({
        root,
        path: relativePath,
        content: state.openFileDraft,
      }),
    });

    if (state.filesRoot !== root || state.openFileRelativePath !== relativePath) {
      return;
    }

    state.openFileContent = payload.file.content;
    state.openFileDraft = payload.file.content;
    state.openFileMessage = "";
  } catch (error) {
    window.alert(error.message);
  } finally {
    state.openFileSaving = false;
    syncOpenFileEditorStateUi();
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
    refreshShellUi({ sessions: true, ports: false });
  }, 180);
}

function applyAgentPromptState(payload) {
  state.agentPrompt = payload?.prompt || "";
  state.agentPromptPath = payload?.promptPath || ".remote-vibes/agent-prompt.md";
  state.agentPromptWikiRoot = payload?.wikiRoot || ".remote-vibes";
  state.agentPromptTargets = Array.isArray(payload?.targets) ? payload.targets : [];
}

function applyGpuState(payload) {
  state.gpu = {
    available: Boolean(payload?.available),
    total: Number(payload?.total) || 0,
    used: Number(payload?.used) || 0,
    idle: Number(payload?.idle) || 0,
    activeAgentSessions: Number(payload?.activeAgentSessions) || 0,
    totalMemoryMb: Number(payload?.totalMemoryMb) || 0,
    remoteVibesMemoryMb: Number(payload?.remoteVibesMemoryMb) || 0,
    otherMemoryMb: Number(payload?.otherMemoryMb) || 0,
    freeMemoryMb: Number(payload?.freeMemoryMb) || 0,
    perGpu: Array.isArray(payload?.perGpu) ? payload.perGpu : [],
  };
}

function applyGpuHistoryState(payload) {
  const agentRuns = payload?.agentRuns || {};
  const latestTimestamp = payload?.latestTimestamp || null;
  const latestEndedAt = agentRuns?.latestEndedAt || null;

  state.gpuHistory = {
    range: payload?.range || state.gpuHistory.range || "1d",
    latestTimestamp,
    lastUpdatedAt: Math.max(Number(latestTimestamp) || 0, Number(latestEndedAt) || 0) || null,
    sampleIntervalMs: Number(payload?.sampleIntervalMs) || 0,
    gpus: Array.isArray(payload?.gpus) ? payload.gpus : [],
    agentRuns: {
      totalRuns: Number(agentRuns?.totalRuns) || 0,
      totalRunMs: Number(agentRuns?.totalRunMs) || 0,
      sessionCount: Number(agentRuns?.sessionCount) || 0,
      medianRunMs: Number(agentRuns?.medianRunMs) || 0,
      p90RunMs: Number(agentRuns?.p90RunMs) || 0,
      maxRunMs: Number(agentRuns?.maxRunMs) || 0,
      latestEndedAt,
      buckets: Array.isArray(agentRuns?.buckets) ? agentRuns.buckets : [],
    },
  };
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

  state.currentView = nextView === "gpu" ? "gpu" : "shell";
  updateRoute({ view: state.currentView });
}

function bindGpuDashboardEvents() {
  document.querySelectorAll("[data-gpu-range]").forEach((button) => {
    button.addEventListener("click", async () => {
      const range = button.getAttribute("data-gpu-range") || "1d";
      await loadGpuHistory(range);
      renderShell();
    });
  });
}

function bindShellEvents() {
  document.querySelector("#session-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const providerId = String(formData.get("providerId") || state.defaultProviderId);
    const cwd = String(formData.get("cwd") || state.defaultCwd || "");
    const name = String(formData.get("name") || "");

    try {
      const payload = await fetchJson("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ providerId, name, cwd }),
      });

      state.defaultCwd = cwd || state.defaultCwd;
      state.sessions = [payload.session, ...state.sessions];
      state.activeSessionId = payload.session.id;
      renderShell();
      connectToSession(payload.session.id);
      closeMobileSidebar();
    } catch (error) {
      window.alert(error.message);
    }
  });

  bindSessionEvents();
  bindUpdateEvents();

  if (state.currentView === "shell") {
    document.querySelector("#tab-button")?.addEventListener("click", () => sendTerminalInput("\t"));
    document.querySelector("#shift-tab-button")?.addEventListener("click", () => sendTerminalInput("\u001b[Z"));
    document.querySelector("#ctrl-p-button")?.addEventListener("click", () => sendTerminalInput("\u0010"));
    document.querySelector("#ctrl-t-button")?.addEventListener("click", () => sendTerminalInput("\u0014"));
    document.querySelector("#ctrl-c-button")?.addEventListener("click", () => sendTerminalInput("\u0003"));
    document.querySelector("#jump-to-bottom")?.addEventListener("click", () => {
      state.terminal?.scrollToBottom();
      state.terminal?.focus();
      syncTerminalScrollState();
    });
  }

  document.querySelector("#refresh-sessions")?.addEventListener("click", () => loadSessions());
  document.querySelector("#edit-agent-prompt")?.addEventListener("click", () => {
    state.agentPromptEditorOpen = true;
    renderShell();
  });
  document.querySelectorAll("[data-close-prompt]").forEach((element) => {
    element.addEventListener("click", () => {
      state.agentPromptEditorOpen = false;
      renderShell();
    });
  });
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
      state.agentPromptEditorOpen = false;
      renderShell();
    } catch (error) {
      window.alert(error.message);
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
  document.querySelector("#open-sidebar")?.addEventListener("click", () => setMobileSidebar("left"));
  document.querySelector("#open-files-sidebar")?.addEventListener("click", () => setMobileSidebar("right"));
  document.querySelector("#close-left-sidebar")?.addEventListener("click", () => closeMobileSidebar());
  document.querySelector("#close-right-sidebar")?.addEventListener("click", () => closeMobileSidebar());
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
      state.update = {
        ...(state.update || {}),
        updateAvailable: true,
        canUpdate: false,
        status: "blocked",
        reason: error.message,
      };
      refreshUpdateUi();
      window.alert(error.message);
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

  refreshToolbarUi();
  scheduleSessionsRefresh();
}

function updatePort(port) {
  const index = state.ports.findIndex((entry) => entry.port === port.port);
  if (index === -1) {
    state.ports = [...state.ports, port].sort((left, right) => left.port - right.port);
    return;
  }

  state.ports[index] = port;
}

async function loadSessions() {
  try {
    const previousActiveSessionId = state.activeSessionId;
    const payload = await fetchJson("/api/sessions");
    state.sessions = payload.sessions;

    if (state.activeSessionId && !state.sessions.some((session) => session.id === state.activeSessionId)) {
      state.activeSessionId = state.sessions[0]?.id ?? null;
    }

    if (!state.activeSessionId && state.sessions.length) {
      state.activeSessionId = state.sessions[0].id;
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

    refreshShellUi({ sessions: true, ports: false });
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
    refreshShellUi({ sessions: false, ports: true });
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
  } catch (error) {
    state.update = {
      status: "error",
      updateAvailable: false,
      canUpdate: false,
      reason: error.message,
    };
  }

  refreshUpdateUi();
}

async function loadGpu() {
  try {
    const payload = await fetchJson("/api/gpu");
    applyGpuState(payload.gpu);
    refreshShellUi({ sessions: false, ports: false, files: false });
  } catch (error) {
    console.error(error);
  }
}

async function loadGpuHistory(range = state.gpuHistory.range || "1d") {
  try {
    const payload = await fetchJson(`/api/gpu/history?range=${encodeURIComponent(range)}`);
    applyGpuHistoryState(payload.history);
  } catch (error) {
    console.error(error);
  }
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
    </main>
  `;

  bindFileEditorEvents();
}

async function bootstrapApp() {
  try {
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
  state.ports = payload.ports ?? [];
  state.defaultCwd = payload.cwd;
  state.defaultProviderId = payload.defaultProviderId;
  applyGpuState(payload.gpu);
  state.preferredBaseUrl = payload.preferredUrl ? new URL(payload.preferredUrl).origin : "";
  applyAgentPromptState(payload.agentPrompt);
  await loadGpuHistory(state.gpuHistory.range);

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
  void loadUpdateStatus();

  if (state.updateTimer) {
    window.clearInterval(state.updateTimer);
  }

  state.updateTimer = window.setInterval(() => {
    void loadUpdateStatus({ force: true });
  }, 5 * 60 * 1000);

  if (state.activeSessionId && state.currentView === "shell") {
    connectToSession(state.activeSessionId);
  }

  window.addEventListener("hashchange", async () => {
    syncViewFromLocation();
    if (state.currentView === "gpu") {
      await loadGpuHistory(state.gpuHistory.range);
    }

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
    loadGpu();
    if (state.currentView === "gpu") {
      void loadGpuHistory(state.gpuHistory.range).then(() => renderShell());
    }
    void refreshOpenFileTree({ force: true });
  }, 3000);
}

bootstrapApp();
