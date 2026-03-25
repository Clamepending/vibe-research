import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";

const app = document.querySelector("#app");

const state = {
  providers: [],
  sessions: [],
  activeSessionId: null,
  connectedSessionId: null,
  defaultCwd: "",
  defaultProviderId: "claude",
  websocket: null,
  terminal: null,
  fitAddon: null,
  sessionPollTimer: null,
  resizeBound: false,
  sidebarOpen: false,
};

function escapeHtml(value) {
  return value
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
    return "No output yet";
  }

  const deltaSeconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (deltaSeconds < 5) {
    return "Just now";
  }

  if (deltaSeconds < 60) {
    return `${deltaSeconds}s ago`;
  }

  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function getSessionLabel(session) {
  if (session.status === "exited") {
    return { text: "Exited", className: "exited" };
  }

  return isLive(session)
    ? { text: "Live", className: "live" }
    : { text: "Idle", className: "idle" };
}

function setSidebarOpen(nextValue) {
  state.sidebarOpen = nextValue;
  const sidebar = document.querySelector("[data-sidebar]");
  if (sidebar) {
    sidebar.classList.toggle("is-open", nextValue);
  }
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
    const message = payload?.error || `Request failed with status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return payload;
}

function renderLogin({ errorMessage = "", hint = "" } = {}) {
  app.innerHTML = `
    <main class="screen login-screen">
      <section class="login-card">
        <div class="status-pill">Protected Session Hub</div>
        <h1>Remote Vibes</h1>
        <p class="subtle">
          This host is protected with a short passcode. Enter it once and your browser keeps the session.
        </p>
        <form id="login-form" class="field">
          <label for="passcode">Passcode${hint ? ` (starts with ${escapeHtml(hint)})` : ""}</label>
          <input id="passcode" name="passcode" autocomplete="one-time-code" inputmode="text" />
          <button class="primary-button" type="submit">Unlock</button>
          <div class="error-text">${escapeHtml(errorMessage)}</div>
        </form>
      </section>
    </main>
  `;

  const loginForm = document.querySelector("#login-form");
  loginForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(loginForm);
    const passcode = String(formData.get("passcode") || "");

    try {
      await fetchJson("/api/login", {
        method: "POST",
        body: JSON.stringify({ passcode }),
      });

      await bootstrapApp();
    } catch (error) {
      renderLogin({ errorMessage: error.message, hint });
    }
  });
}

function renderShell() {
  const providerOptions = state.providers
    .map(
      (provider) => `
        <option value="${provider.id}" ${provider.id === state.defaultProviderId ? "selected" : ""} ${provider.available ? "" : "disabled"}>
          ${escapeHtml(provider.label)}${provider.available ? "" : " (missing)"}
        </option>
      `,
    )
    .join("");

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const toolbarTitle = activeSession
    ? `${activeSession.name} · ${activeSession.providerLabel}`
    : "Pick or create a session";
  const toolbarMeta = activeSession
    ? `${activeSession.cwd} · ${activeSession.status === "exited" ? `exit ${activeSession.exitCode ?? 0}` : "interactive"}`
    : "Each session is a live PTY on this laptop";

  app.innerHTML = `
    <main class="screen app-shell">
      <aside class="sidebar ${state.sidebarOpen ? "is-open" : ""}" data-sidebar>
        <div class="sidebar-header">
          <div class="sidebar-copy">
            <div class="status-pill">Host Online</div>
            <h1 class="app-title">Remote Vibes</h1>
            <div class="subtle">Browser terminals for Claude, Codex, Gemini, or a plain shell.</div>
          </div>
          <button class="menu-button hidden-desktop" type="button" id="close-sidebar">Close</button>
        </div>

        <form class="session-form" id="session-form">
          <div class="section-label">New Window</div>
          <select name="providerId">${providerOptions}</select>
          <input type="text" name="cwd" placeholder="Working directory" value="${escapeHtml(state.defaultCwd || "")}" />
          <input type="text" name="name" placeholder="Optional label" />
          <button class="primary-button" type="submit">Create Session</button>
          <div class="subtle">Default launches Claude if it is installed.</div>
        </form>

        <section class="sessions-list" id="sessions-list">
          ${renderSessionCards()}
        </section>

        <footer class="sidebar-footer">
          <div>Phone-friendly over Tailscale.</div>
          <div>Shells run locally on this host.</div>
        </footer>
      </aside>

      <section class="terminal-panel">
        <div class="terminal-toolbar">
          <div>
            <button class="menu-button hidden-desktop" type="button" id="open-sidebar">Sessions</button>
            <strong id="toolbar-title">${escapeHtml(toolbarTitle)}</strong>
            <div class="terminal-meta" id="toolbar-meta">${escapeHtml(toolbarMeta)}</div>
          </div>
          <div>
            <button class="ghost-button" type="button" id="refresh-sessions">Refresh</button>
            <button class="ghost-button" type="button" id="logout-button">Lock</button>
          </div>
        </div>

        <div class="terminal-stack">
          <div class="terminal-mount" id="terminal-mount"></div>
          <div class="empty-state ${activeSession ? "hidden" : ""}" id="empty-state">
            <div class="empty-state-card">
              <h2 class="app-title">Open a shell from the sidebar</h2>
              <div class="subtle">
                Choose a provider, create a window, and this browser becomes a live terminal for the host laptop.
              </div>
            </div>
          </div>
        </div>

        <form class="composer-bar" id="composer-form">
          <input
            id="quick-command"
            type="text"
            autocomplete="off"
            placeholder="Quick command or dictation input"
            ${activeSession ? "" : "disabled"}
          />
          <button class="ghost-button" type="button" id="ctrl-c-button" ${activeSession ? "" : "disabled"}>Ctrl+C</button>
          <button class="primary-button" type="submit" id="send-button" ${activeSession ? "" : "disabled"}>Send</button>
        </form>
      </section>
    </main>
  `;

  bindShellEvents();
  mountTerminal();
  refreshShellUi();
}

function renderSessionCards() {
  if (!state.sessions.length) {
    return `
      <div class="session-form">
        <div class="section-label">No windows yet</div>
        <div class="subtle">Create your first session above.</div>
      </div>
    `;
  }

  return state.sessions
    .map((session) => {
      const status = getSessionLabel(session);

      return `
        <article class="session-card ${session.id === state.activeSessionId ? "is-active" : ""}" data-session-id="${session.id}">
          <div class="session-card-top">
            <div>
              <h2 class="session-name">${escapeHtml(session.name)}</h2>
              <div class="session-provider">${escapeHtml(session.providerLabel)}</div>
            </div>
            <span class="session-status ${status.className}">${status.text}</span>
          </div>
          <div class="session-meta">
            <span class="session-time">${relativeTime(session.lastOutputAt)}</span>
            <button class="danger-button" type="button" data-delete-session="${session.id}">Delete</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function bindSessionListEvents() {
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

  bindSessionListEvents();
  document.querySelector("#composer-form")?.addEventListener("submit", (event) => {
    event.preventDefault();

    if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    const input = document.querySelector("#quick-command");
    const value = input?.value ?? "";
    if (!value.trim()) {
      return;
    }

    state.websocket.send(JSON.stringify({ type: "input", data: `${value}\r` }));
    input.value = "";
  });

  document.querySelector("#ctrl-c-button")?.addEventListener("click", () => {
    if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    state.websocket.send(JSON.stringify({ type: "input", data: "\u0003" }));
  });

  document.querySelector("#refresh-sessions")?.addEventListener("click", () => loadSessions());
  document.querySelector("#logout-button")?.addEventListener("click", async () => {
    try {
      closeWebsocket();
      await fetchJson("/api/logout", { method: "POST" });
      if (state.sessionPollTimer) {
        window.clearInterval(state.sessionPollTimer);
      }
      renderLogin();
    } catch (error) {
      window.alert(error.message);
    }
  });

  document.querySelector("#open-sidebar")?.addEventListener("click", () => setSidebarOpen(true));
  document.querySelector("#close-sidebar")?.addEventListener("click", () => setSidebarOpen(false));
}

function closeWebsocket() {
  if (state.websocket) {
    state.websocket.close();
    state.websocket = null;
  }

  state.connectedSessionId = null;
}

function mountTerminal() {
  const mount = document.querySelector("#terminal-mount");
  if (!mount) {
    return;
  }

  state.terminal?.dispose();
  closeWebsocket();

  state.terminal = new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    fontFamily: '"IBM Plex Mono", monospace',
    fontSize: 14,
    lineHeight: 1.2,
    macOptionIsMeta: true,
    scrollback: 5000,
    theme: {
      background: "#060708",
      foreground: "#f4f2ed",
      cursor: "#6ae3c6",
      black: "#111315",
      red: "#ff7f79",
      green: "#6ae3c6",
      yellow: "#f0c674",
      blue: "#87b8ff",
      magenta: "#d3a6ff",
      cyan: "#5ecac2",
      white: "#f4f2ed",
      brightBlack: "#6a7176",
      brightRed: "#ff9f99",
      brightGreen: "#8ff1d8",
      brightYellow: "#f6d58e",
      brightBlue: "#add0ff",
      brightMagenta: "#e2c2ff",
      brightCyan: "#9fe7df",
      brightWhite: "#ffffff",
    },
  });

  state.fitAddon = new FitAddon();
  state.terminal.loadAddon(state.fitAddon);
  state.terminal.open(mount);
  state.fitAddon.fit();

  state.terminal.onData((data) => {
    if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    state.websocket.send(JSON.stringify({ type: "input", data }));
  });

  if (!state.resizeBound) {
    window.addEventListener("resize", () => {
      if (!state.fitAddon) {
        return;
      }

      state.fitAddon.fit();
      sendResize();
    });
    state.resizeBound = true;
  }

  if (state.activeSessionId) {
    connectToSession(state.activeSessionId);
  }
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
  const terminal = state.terminal;
  if (!terminal || !sessionId) {
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
  terminal.reset();
  state.connectedSessionId = sessionId;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  state.websocket = new WebSocket(`${protocol}://${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`);

  state.websocket.addEventListener("open", () => {
    if (state.fitAddon) {
      state.fitAddon.fit();
    }
    sendResize();
    terminal.focus();
  });

  state.websocket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "snapshot") {
      terminal.write(payload.data || "");
      updateSession(payload.session);
      return;
    }

    if (payload.type === "output") {
      terminal.write(payload.data || "");
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
      terminal.writeln(`\r\n[remote-vibes] ${payload.message}`);
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

  refreshShellUi();
}

function refreshShellUi() {
  const list = document.querySelector("#sessions-list");
  if (list) {
    list.innerHTML = renderSessionCards();
    bindSessionListEvents();
  }

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const title = document.querySelector("#toolbar-title");
  const meta = document.querySelector("#toolbar-meta");
  const emptyState = document.querySelector("#empty-state");
  const quickCommand = document.querySelector("#quick-command");
  const ctrlCButton = document.querySelector("#ctrl-c-button");
  const sendButton = document.querySelector("#send-button");
  const canSend = Boolean(activeSession && activeSession.status !== "exited");

  if (title) {
    title.textContent = activeSession
      ? `${activeSession.name} · ${activeSession.providerLabel}`
      : "Pick or create a session";
  }

  if (meta) {
    meta.textContent = activeSession
      ? `${activeSession.cwd} · ${activeSession.status === "exited" ? `exit ${activeSession.exitCode ?? 0}` : "interactive"}`
      : "Each session is a live PTY on this laptop";
  }

  if (emptyState) {
    emptyState.classList.toggle("hidden", Boolean(activeSession));
  }

  if (quickCommand) {
    quickCommand.disabled = !canSend;
  }

  if (ctrlCButton) {
    ctrlCButton.disabled = !canSend;
  }

  if (sendButton) {
    sendButton.disabled = !canSend;
  }
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

    refreshShellUi();
    if (state.activeSessionId && !state.connectedSessionId) {
      connectToSession(state.activeSessionId);
    }
  } catch (error) {
    if (error.status === 401) {
      closeWebsocket();
      if (state.sessionPollTimer) {
        window.clearInterval(state.sessionPollTimer);
      }
      renderLogin();
      return;
    }

    console.error(error);
  }
}

async function bootstrapApp() {
  try {
    const payload = await fetchJson("/api/state");
    state.providers = payload.providers;
    state.sessions = payload.sessions;
    state.defaultCwd = payload.cwd;
    state.defaultProviderId = payload.defaultProviderId;
    state.activeSessionId = payload.sessions[0]?.id ?? null;
    renderShell();

    if (state.activeSessionId) {
      connectToSession(state.activeSessionId);
    }

    if (state.sessionPollTimer) {
      window.clearInterval(state.sessionPollTimer);
    }

    state.sessionPollTimer = window.setInterval(() => {
      loadSessions();
    }, 2500);
  } catch (error) {
    if (error.status === 401) {
      const publicConfig = await fetchJson("/api/public-config");
      renderLogin({ hint: publicConfig.passcodeHint });
      return;
    }

    renderLogin({ errorMessage: error.message });
  }
}

bootstrapApp();
