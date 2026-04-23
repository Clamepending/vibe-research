const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn } = require("node:child_process");
const { chmodSync, existsSync } = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  copyTemplateApp,
  expandHome,
  looksLikeVibeResearchApp,
  readPackageVersion,
  shouldSyncTemplate,
} = require("./runtime.cjs");

const appName = "Vibe Research";
const isMacAppStoreBuild = process.mas === true;
const defaultPort = Number(process.env.VIBE_RESEARCH_PORT || process.env.REMOTE_VIBES_PORT || 4123);
const localUrl = `http://127.0.0.1:${defaultPort}/`;
const state = {
  booting: false,
  lastLogLines: [],
  mainWindow: null,
  manualUpdateCheck: false,
  updateReady: false,
};

function sourceRootDir() {
  return path.resolve(__dirname, "..", "..");
}

function installedAppDir() {
  if (isMacAppStoreBuild) {
    return path.join(app.getPath("userData"), "app");
  }
  return expandHome(process.env.VIBE_RESEARCH_HOME || process.env.REMOTE_VIBES_HOME || "~/.vibe-research/app");
}

function bundledTemplateDir() {
  const templateDir = path.join(process.resourcesPath || "", "app-template");
  return existsSync(templateDir) ? templateDir : "";
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
  const workspaceDir = isMacAppStoreBuild ? path.join(app.getPath("userData"), "workspace") : path.join(os.homedir(), "vibe-projects");
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
  if (state.lastLogLines.length > 500) {
    state.lastLogLines.splice(0, state.lastLogLines.length - 500);
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
    if (options.logCommand !== false) {
      appendLog(`$ ${[command, ...args].join(" ")}`);
    }

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

function commandSucceeds(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
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

async function externalNodeIsReady() {
  return commandSucceeds(
    "bash",
    [
      "-lc",
      "node -e \"process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)\" && npm -v >/dev/null",
    ],
    { env: desktopEnv() },
  );
}

async function ensureExternalNodeRuntime() {
  if (await externalNodeIsReady()) {
    appendLog("Node.js runtime is ready.");
    return;
  }

  if (isMacAppStoreBuild) {
    throw new Error(
      "Mac App Store builds cannot install Node.js automatically. Install Node.js 20+ first, then relaunch Vibe Research.",
    );
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
    title: "Installing Node.js",
    detail: "Vibe Research needs a local Node.js runtime. macOS may ask for an administrator password.",
  });

  await runCommand("bash", [script, "--ensure-node-only"], {
    label: "Node.js setup",
    env: desktopEnv({
      VIBE_RESEARCH_INSTALL_SERVICE: "0",
      REMOTE_VIBES_INSTALL_SERVICE: "0",
      VIBE_RESEARCH_INSTALL_UI: "plain",
      REMOTE_VIBES_INSTALL_UI: "plain",
    }),
  });
}

async function installViaShellInstaller() {
  if (isMacAppStoreBuild) {
    throw new Error(
      "Mac App Store builds do not support shell-based installation. Reinstall from the App Store package or use the direct download build.",
    );
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
    detail: "Downloading the latest release and preparing the local app.",
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

async function prepareAppInstall() {
  if (process.platform === "win32") {
    throw new Error("The desktop installer currently supports macOS and Linux. Use WSL on Windows for now.");
  }

  if (shouldUseSourceCheckout()) {
    return;
  }

  const templateDir = bundledTemplateDir();
  if (templateDir) {
    const appDir = installedAppDir();
    if (shouldSyncTemplate({ templateDir, appDir, force: process.env.VIBE_RESEARCH_DESKTOP_RESYNC === "1" })) {
      const templateVersion = readPackageVersion(templateDir);
      sendStatus({
        phase: "installing",
        title: looksLikeVibeResearchApp(appDir) ? "Updating Vibe Research" : "Installing Vibe Research",
        detail: `Copying the bundled Vibe Research ${templateVersion || "release"} into your local app folder.`,
      });

      const result = copyTemplateApp({
        templateDir,
        appDir,
        logger: appendLog,
      });
      appendLog(`Prepared bundled Vibe Research ${result.templateVersion} (${result.fileCount} files).`);
    } else {
      appendLog(`Bundled Vibe Research ${readPackageVersion(templateDir)} is already installed.`);
    }

    await ensureExternalNodeRuntime();
    return;
  }

  if (looksLikeVibeResearchApp(activeAppDir())) {
    await ensureExternalNodeRuntime();
    return;
  }

  await installViaShellInstaller();
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

  await waitForServer({ timeoutMs: 120000 });
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
        : "Preparing the installed local app.",
    });
    await prepareAppInstall();
    await startServer();
    await loadVibeResearch();
    setTimeout(() => {
      void checkForDesktopUpdates();
    }, 2500);
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
    if (url.startsWith(localUrl) || url.startsWith(`http://localhost:${defaultPort}/`)) {
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

async function showUpdateReadyDialog(info) {
  state.updateReady = true;
  installMenu();
  const version = info?.version ? ` ${info.version}` : "";
  const result = await dialog.showMessageBox(state.mainWindow, {
    type: "info",
    buttons: ["Restart and install", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Vibe Research update ready",
    message: `Vibe Research${version} is ready to install.`,
    detail: "Restarting will close this desktop window, install the update, and reopen the app normally.",
  });

  if (result.response === 0) {
    autoUpdater.quitAndInstall(false, true);
  }
}

function configureAutoUpdates() {
  if (!app.isPackaged || process.env.VIBE_RESEARCH_DESKTOP_AUTO_UPDATE === "0" || isMacAppStoreBuild) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    appendLog("Checking for desktop updates.");
  });
  autoUpdater.on("update-available", (info) => {
    appendLog(`Desktop update ${info?.version || ""} is available; downloading.`);
  });
  autoUpdater.on("download-progress", (progress) => {
    if (progress?.percent) {
      appendLog(`Desktop update download ${Math.round(progress.percent)}%.`);
    }
  });
  autoUpdater.on("update-not-available", () => {
    appendLog("Desktop app is already up to date.");
    if (state.manualUpdateCheck) {
      state.manualUpdateCheck = false;
      void dialog.showMessageBox(state.mainWindow, {
        type: "info",
        title: "No update available",
        message: "Vibe Research is already up to date.",
      });
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    appendLog(`Desktop update ${info?.version || ""} downloaded.`);
    sendStatus({
      phase: "update-downloaded",
      title: "Update Ready",
      detail: "Restart Vibe Research to install the downloaded desktop update.",
    });
    void showUpdateReadyDialog(info);
  });
  autoUpdater.on("error", (error) => {
    appendLog(`Desktop update check failed: ${error?.message || error}`);
    if (state.manualUpdateCheck) {
      state.manualUpdateCheck = false;
      void dialog.showErrorBox("Update check failed", error?.message || String(error));
    }
  });
}

async function checkForDesktopUpdates({ manual = false } = {}) {
  if (isMacAppStoreBuild) {
    if (manual) {
      await dialog.showMessageBox(state.mainWindow, {
        type: "info",
        title: "Updates via App Store",
        message: "This build updates through the Mac App Store.",
      });
    }
    return;
  }

  if (!app.isPackaged || process.env.VIBE_RESEARCH_DESKTOP_AUTO_UPDATE === "0") {
    if (manual) {
      await dialog.showMessageBox(state.mainWindow, {
        type: "info",
        title: "Updates unavailable in development",
        message: "Desktop auto-update runs in packaged release builds.",
      });
    }
    return;
  }

  state.manualUpdateCheck = manual;
  await autoUpdater.checkForUpdatesAndNotify();
}

function installMenu() {
  const template = [
    {
      label: appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Check for Updates",
          click: () => {
            void checkForDesktopUpdates({ manual: true });
          },
        },
        {
          label: "Install Downloaded Update",
          enabled: !isMacAppStoreBuild && state.updateReady,
          click: () => autoUpdater.quitAndInstall(false, true),
        },
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

ipcMain.handle("vibe-install-update", () => {
  if (state.updateReady) {
    autoUpdater.quitAndInstall(false, true);
  }
});

ipcMain.handle("vibe-quit", () => {
  app.quit();
});

app.whenReady().then(async () => {
  app.setName(appName);
  configureAutoUpdates();
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
