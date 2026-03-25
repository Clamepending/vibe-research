import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";

const app = document.querySelector("#app");

const state = {
  providers: [],
  sessions: [],
  ports: [],
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
      if (!state.fitAddon || !state.terminal) {
        return;
      }

      state.fitAddon.fit();
      sendResize();
    });
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
            <button class="danger-button" type="button" data-delete-session="${session.id}">del</button>
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
        <a class="port-card" href="${escapeHtml(port.proxyPath)}" target="_blank" rel="noreferrer">
          <span class="port-number">${port.port}</span>
          <span class="port-meta">${escapeHtml(port.command)} · ${escapeHtml(port.hosts.join(", "))}</span>
        </a>
      `,
    )
    .join("");
}

function renderShell() {
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
        <div class="sidebar-body">
          <div class="sidebar-mobile-actions">
            <button class="icon-button hidden-desktop" type="button" id="close-sidebar">×</button>
          </div>

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
              <span>ports</span>
              <button class="icon-button" type="button" id="refresh-ports">↻</button>
            </div>
            <div class="list-shell" id="ports-list">${renderPortCards()}</div>
          </section>
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
          <button class="icon-button" type="button" id="refresh-sessions">↻</button>
        </div>

        <div class="terminal-stack">
          <button class="ghost-button terminal-signal" type="button" id="ctrl-c-button" ${activeSession ? "" : "disabled"}>^C</button>
          <div class="terminal-mount" id="terminal-mount"></div>
          <div class="empty-state ${activeSession ? "hidden" : ""}" id="empty-state">new session</div>
        </div>
      </section>
    </main>
  `;

  bindShellEvents();
  mountTerminal();
  refreshShellUi();
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

  document.querySelector("#ctrl-c-button")?.addEventListener("click", () => {
    if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    state.websocket.send(JSON.stringify({ type: "input", data: "\u0003" }));
  });

  document.querySelector("#refresh-sessions")?.addEventListener("click", () => loadSessions());
  document.querySelector("#refresh-ports")?.addEventListener("click", () => loadPorts());
  document.querySelector("#open-sidebar")?.addEventListener("click", () => setSidebarOpen(true));
  document.querySelector("#close-sidebar")?.addEventListener("click", () => setSidebarOpen(false));
  document.querySelector("[data-sidebar-scrim]")?.addEventListener("click", () => setSidebarOpen(false));
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
    cursorBlink: true,
    fontFamily: '"IBM Plex Mono", monospace',
    fontSize: 14,
    lineHeight: 1.18,
    macOptionIsMeta: true,
    scrollback: 5000,
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
  fitTerminalSoon();
  mount.addEventListener("pointerdown", () => {
    state.terminal?.focus();
  });

  state.terminal.onData((data) => {
    if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    state.websocket.send(JSON.stringify({ type: "input", data }));
  });

  if (!state.resizeBound) {
    const handleResize = () => fitTerminalSoon();
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);
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
  state.terminal.reset();
  state.connectedSessionId = sessionId;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  state.websocket = new WebSocket(
    `${protocol}://${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`,
  );

  state.websocket.addEventListener("open", () => {
    fitTerminalSoon();
    state.terminal.focus();
  });

  state.websocket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "snapshot") {
      state.terminal.write(payload.data || "");
      updateSession(payload.session);
      return;
    }

    if (payload.type === "output") {
      state.terminal.write(payload.data || "");
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

  refreshShellUi();
}

function refreshShellUi() {
  const sessionsList = document.querySelector("#sessions-list");
  const portsList = document.querySelector("#ports-list");
  if (sessionsList) {
    sessionsList.innerHTML = renderSessionCards();
    bindSessionEvents();
  }

  if (portsList) {
    portsList.innerHTML = renderPortCards();
  }

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
  const title = document.querySelector("#toolbar-title");
  const meta = document.querySelector("#toolbar-meta");
  const emptyState = document.querySelector("#empty-state");
  const ctrlCButton = document.querySelector("#ctrl-c-button");
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

  if (ctrlCButton) {
    ctrlCButton.disabled = !canSend;
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
    console.error(error);
  }
}

async function loadPorts() {
  try {
    const payload = await fetchJson("/api/ports");
    state.ports = payload.ports;
    refreshShellUi();
  } catch (error) {
    console.error(error);
  }
}

async function bootstrapApp() {
  const payload = await fetchJson("/api/state");
  state.providers = payload.providers;
  state.sessions = payload.sessions;
  state.ports = payload.ports ?? [];
  state.defaultCwd = payload.cwd;
  state.defaultProviderId = payload.defaultProviderId;
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
  }, 3000);
}

bootstrapApp();
