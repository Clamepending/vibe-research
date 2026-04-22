const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, chmodSync } = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const appName = "Vibe Research";
const defaultPort = Number(process.env.VIBE_RESEARCH_PORT || process.env.REMOTE_VIBES_PORT || 4123);
const localUrl = `http://127.0.0.1:${defaultPort}/`;
const state = {
  booting: false,
  lastLogLines: [],
  mainWindow: null,
};

function expandHome(input) {
  if (!input) {
    return input;
  }
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function sourceRootDir() {
  return path.resolve(__dirname, "..", "..");
}

function installedAppDir() {
  return expandHome(process.env.VIBE_RESEARCH_HOME || process.env.REMOTE_VIBES_HOME || "~/.vibe-research/app");
}

function looksLikeVibeResearchApp(appDir) {
  return Boolean(
    appDir &&
      existsSync(path.join(appDir, "start.sh")) &&
      existsSync(path.join(appDir, "src", "server.js")) &&
      existsSync(path.join(appDir, "package.json")),
  );
}

function shouldUseSourceCheckout() {
  if (process.env.VIBE_RESEARCH_DESKTOP_USE_SOURCE === "1") {
    return true;
  }
  if (process.env.VIBE_RESEARCH_DESKTOP_USE_SOURCE === "0") {
    return false;
  }
  return !app.isPackaged && looksLikeVibeResearchApp(sourceRootDir());
}

function activeAppDir() {
  if (shouldUseSourceCheckout()) {
    return sourceRootDir();
  }
  return installedAppDir();
}

function installerPath() {
  const packagedInstaller = path.join(process.resourcesPath || "", "install.sh");
  if (app.isPackaged && existsSync(packagedInstaller)) {
    return packagedInstaller;
  }

  return path.join(sourceRootDir(), "install.sh");
}

function desktopEnv(extra = {}) {
  const workspaceDir = path.join(os.homedir(), "vibe-projects");
  return {
    ...process.env,
    VIBE_RESEARCH_HOME: installedAppDir(),
    REMOTE_VIBES_HOME: installedAppDir(),
    VIBE_RESEARCH_PORT: String(defaultPort),
    REMOTE_VIBES_PORT: String(defaultPort),
    VIBE_RESEARCH_WORKSPACE_DIR: process.env.VIBE_RESEARCH_WORKSPACE_DIR || workspaceDir,
    REMOTE_VIBES_WORKSPACE_DIR:
      process.env.REMOTE_VIBES_WORKSPACE_DIR || process.env.VIBE_RESEARCH_WORKSPACE_DIR || workspaceDir,
    VIBE_RESEARCH_OPEN_BROWSER: "0",
    REMOTE_VIBES_OPEN_BROWSER: "0",
    ...extra,
  };
}

function sendStatus(payload) {
  const normalized = {
    ...payload,
    logLines: state.lastLogLines.slice(-160),
  };
  state.mainWindow?.webContents.send("vibe-status", normalized);
}

function appendLog(line) {
  const text = String(line || "").trimEnd();
  if (!text) {
    return;
  }
  state.lastLogLines.push(text);
  if (state.lastLogLines.length > 400) {
    state.lastLogLines.splice(0, state.lastLogLines.length - 400);
  }
  sendStatus({ phase: "log" });
}

function splitAndLog(chunk) {
  String(chunk || "")
    .split(/\r?\n/)
    .forEach((line) => appendLog(line));
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    appendLog(`$ ${[command, ...args].join(" ")}`);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", splitAndLog);
    child.stderr.on("data", splitAndLog);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${options.label || command} exited with code ${code}`));
      }
    });
  });
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 2000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("Timed out"));
    });
    request.on("error", reject);
  });
}

async function probeServer() {
  const payload = await requestJson(`${localUrl}api/state`);
  if (payload?.appName !== "Vibe Research" && payload?.appName !== "Remote Vibes") {
    throw new Error("Port is not serving Vibe Research");
  }
  return payload;
}

async function waitForServer({ timeoutMs = 60000 } = {}) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await probeServer();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error("Timed out waiting for Vibe Research");
}

async function installIfNeeded() {
  if (process.platform === "win32") {
    throw new Error("The desktop installer currently supports macOS and Linux. Use WSL on Windows for now.");
  }

  if (looksLikeVibeResearchApp(activeAppDir())) {
    return;
  }

  const script = installerPath();
  if (!existsSync(script)) {
    throw new Error(`Could not find install.sh at ${script}`);
  }

  try {
    chmodSync(script, 0o755);
  } catch {
    // The script may live in a read-only app bundle; bash can still read it.
  }

  sendStatus({
    phase: "installing",
    title: "Installing Vibe Research",
    detail: "This can take a few minutes the first time while Node.js and app files are prepared.",
  });

  await runCommand("bash", [script], {
    label: "Vibe Research installer",
    env: desktopEnv({
      VIBE_RESEARCH_SKIP_RUN: "1",
      REMOTE_VIBES_SKIP_RUN: "1",
      VIBE_RESEARCH_INSTALL_SERVICE: "0",
      REMOTE_VIBES_INSTALL_SERVICE: "0",
      VIBE_RESEARCH_INSTALL_UI: "plain",
      REMOTE_VIBES_INSTALL_UI: "plain",
    }),
  });
}

async function startServer() {
  try {
    await probeServer();
    appendLog(`Vibe Research is already running at ${localUrl}`);
    return;
  } catch {
    // Start it below.
  }

  const appDir = activeAppDir();
  if (!looksLikeVibeResearchApp(appDir)) {
    throw new Error(`Vibe Research is not installed at ${appDir}`);
  }

  sendStatus({
    phase: "starting",
    title: "Starting Vibe Research",
    detail: "Preparing the local server and workspace.",
  });

  await runCommand("bash", [path.join(appDir, "start.sh")], {
    cwd: appDir,
    label: "Vibe Research startup",
    env: desktopEnv(
      shouldUseSourceCheckout()
        ? {
            VIBE_RESEARCH_HOME: appDir,
            REMOTE_VIBES_HOME: appDir,
          }
        : {},
    ),
  });

  await waitForServer({ timeoutMs: 90000 });
}

async function loadVibeResearch() {
  sendStatus({
    phase: "loading",
    title: "Opening Vibe Research",
    detail: localUrl,
  });
  await state.mainWindow.loadURL(localUrl);
}

async function boot({ force = false } = {}) {
  if (state.booting && !force) {
    return;
  }

  state.booting = true;
  state.lastLogLines = force ? [] : state.lastLogLines;

  try {
    sendStatus({
      phase: "checking",
      title: "Checking Vibe Research",
      detail: shouldUseSourceCheckout()
        ? "Using this source checkout for desktop development."
        : "Looking for the installed local app.",
    });
    await installIfNeeded();
    await startServer();
    await loadVibeResearch();
  } catch (error) {
    sendStatus({
      phase: "failed",
      title: "Could not start Vibe Research",
      detail: error?.message || String(error),
    });
  } finally {
    state.booting = false;
  }
}

function createWindow() {
  state.mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 620,
    title: appName,
    backgroundColor: "#101418",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  state.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  state.mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(localUrl) || url.startsWith("http://localhost:")) {
      return;
    }
    event.preventDefault();
    shell.openExternal(url);
  });

  state.mainWindow.loadFile(path.join(__dirname, "index.html"));
  state.mainWindow.once("ready-to-show", () => {
    state.mainWindow.show();
  });
}

function installMenu() {
  const template = [
    {
      label: appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Open in Browser",
          click: () => shell.openExternal(localUrl),
        },
        {
          label: "Show Installer Log",
          click: () => sendStatus({ phase: "log" }),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("vibe-retry", async () => {
  await state.mainWindow.loadFile(path.join(__dirname, "index.html"));
  await boot({ force: true });
});

ipcMain.handle("vibe-open-browser", async () => {
  await shell.openExternal(localUrl);
});

ipcMain.handle("vibe-quit", () => {
  app.quit();
});

app.whenReady().then(async () => {
  app.setName(appName);
  installMenu();
  createWindow();
  await boot();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    void boot();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
