import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "xterm-addon-canvas";

const app = document.querySelector("#app");
const TOUCH_TAP_SLOP_PX = 10;

const state = {
  providers: [],
  sessions: [],
  ports: [],
  filesRootOverride: null,
  filesRoot: "",
  fileTreeEntries: {},
  fileTreeExpanded: new Set([""]),
  fileTreeLoading: new Set(),
  fileTreeError: "",
  activeSessionId: null,
  connectedSessionId: null,
  defaultCwd: "",
  defaultProviderId: "claude",
  websocket: null,
  terminal: null,
  fitAddon: null,
  pollTimer: null,
  resizeBound: false,
  sidebarOpen: false,
  terminalResizeObserver: null,
  pendingTerminalOutput: "",
  pendingTerminalScrollToBottom: false,
  terminalOutputFrame: null,
  terminalComposing: false,
  terminalTextareaResetTimer: null,
  sessionRefreshTimer: null,
  terminalInteractionCleanup: null,
  canvasAddon: null,
  terminalShowJumpToBottom: false,
  preferredBaseUrl: "",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

function setSidebarOpen(nextValue) {
  state.sidebarOpen = nextValue;
  const sidebar = document.querySelector("[data-sidebar]");
  const scrim = document.querySelector("[data-sidebar-scrim]");
  if (sidebar) {
    sidebar.classList.toggle("is-open", nextValue);
  }

  if (scrim) {
    scrim.classList.toggle("is-open", nextValue);
  }

  fitTerminalSoon();
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

function getAppBaseUrl() {
  return state.preferredBaseUrl || window.location.origin;
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
  return true;
}

async function applyFilesRoot(rootValue, { force = false } = {}) {
  state.filesRootOverride = normalizeWorkspaceRoot(rootValue) || null;
  syncFilesRoot({ force: true });
  refreshFileTreeUi();
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

      if (entry.isImage) {
        return `
          <a class="file-row file-link" href="${escapeHtml(getFileContentUrl(entry.relativePath))}" target="_blank" rel="noreferrer" style="--depth:${depth}">
            <span class="file-caret">img</span>
            <span class="file-label">${escapeHtml(entry.name)}</span>
          </a>
        `;
      }

      return `
        <div class="file-row file-static" style="--depth:${depth}">
          <span class="file-caret">-</span>
          <span class="file-label">${escapeHtml(entry.name)}</span>
        </div>
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
            <button class="danger-button" type="button" aria-label="Delete session" data-delete-session="${session.id}">x</button>
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
        <a class="port-card" href="${escapeHtml(`${getAppBaseUrl()}${port.proxyPath}`)}" target="_blank" rel="noreferrer">
          <span class="port-number">${port.port}</span>
          <span class="port-meta">${escapeHtml(port.command)} · ${escapeHtml(port.hosts.join(", "))}</span>
        </a>
      `,
    )
    .join("");
}

function renderShell() {
  syncFilesRoot();

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
      <button class="sidebar-scrim ${state.sidebarOpen ? "is-open" : ""}" type="button" aria-label="Close menu" data-sidebar-scrim></button>
      <aside class="sidebar ${state.sidebarOpen ? "is-open" : ""}" data-sidebar>
        <div class="sidebar-mobile-actions">
          <button class="icon-button hidden-desktop" type="button" id="close-sidebar">×</button>
        </div>

        <div class="sidebar-body">
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
          <button class="danger-button terminate-button" type="button" id="terminate-app">terminate</button>
        </div>
      </aside>

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
    </main>
  `;

  bindShellEvents();
  mountTerminal();
  refreshShellUi();
  void refreshOpenFileTree();
}

function bindSessionEvents() {
  document.querySelectorAll("[data-session-id]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target.closest("[data-delete-session]")) {
        return;
      }

      const nextSessionId = element.getAttribute("data-session-id");
      if (!nextSessionId || nextSessionId === state.activeSessionId) {
        setSidebarOpen(false);
        return;
      }

      state.activeSessionId = nextSessionId;
      renderShell();
      connectToSession(state.activeSessionId);
      setSidebarOpen(false);
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
  if (sessions) {
    refreshSessionsList();
  }

  if (ports) {
    refreshPortsList();
  }

  if (files) {
    refreshFileTreeUi();
  }

  refreshToolbarUi();
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
      setSidebarOpen(false);
    } catch (error) {
      window.alert(error.message);
    }
  });

  bindSessionEvents();

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

  document.querySelector("#refresh-sessions")?.addEventListener("click", () => loadSessions());
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
  document.querySelector("#open-sidebar")?.addEventListener("click", () => setSidebarOpen(true));
  document.querySelector("#close-sidebar")?.addEventListener("click", () => setSidebarOpen(false));
  document.querySelector("[data-sidebar-scrim]")?.addEventListener("click", () => setSidebarOpen(false));
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

async function bootstrapApp() {
  try {
    if ("virtualKeyboard" in navigator) {
      navigator.virtualKeyboard.overlaysContent = false;
    }
  } catch (error) {
    console.warn("[remote-vibes] virtual keyboard API unavailable", error);
  }

  syncViewportMetrics();
  const payload = await fetchJson("/api/state");
  state.providers = payload.providers;
  state.sessions = payload.sessions;
  state.ports = payload.ports ?? [];
  state.defaultCwd = payload.cwd;
  state.defaultProviderId = payload.defaultProviderId;
  state.preferredBaseUrl = payload.preferredUrl ? new URL(payload.preferredUrl).origin : "";

  if (maybeRedirectToPreferredOrigin()) {
    return;
  }

  state.activeSessionId = payload.sessions[0]?.id ?? null;
  renderShell();

  if (state.activeSessionId) {
    connectToSession(state.activeSessionId);
  }

  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
  }

  state.pollTimer = window.setInterval(() => {
    loadSessions();
    loadPorts();
    void refreshOpenFileTree({ force: true });
  }, 3000);
}

bootstrapApp();
