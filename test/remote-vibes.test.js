import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";
import { createRemoteVibesApp } from "../src/create-app.js";
import { resolveBrowserExecutablePath } from "../src/browser-runtime.js";
import { buildSessionEnv } from "../src/session-manager.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const execFileAsync = promisify(execFile);

const PNG_FIXTURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92,
  0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);
const GIF_FIXTURE = Buffer.from("R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

async function startApp(options = {}) {
  const cwd = options.cwd || process.cwd();
  const stateDir = options.stateDir || path.join(cwd, ".remote-vibes");
  const app = await createRemoteVibesApp({
    host: "127.0.0.1",
    port: 0,
    cwd,
    stateDir,
    persistSessions: false,
    persistentTerminals: false,
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({
        enabled: settings.preventSleepEnabled,
        platform: "test",
      }),
    ...options,
  });

  return {
    app,
    baseUrl: `http://127.0.0.1:${app.config.port}`,
  };
}

async function createTempWorkspace(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitForWikiBackupRun(baseUrl, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/settings`);
    const payload = await response.json();
    const backup = payload.settings?.wikiBackup;

    if (backup?.lastRunAt) {
      return backup;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timed out waiting for wiki backup to finish");
}

async function writePersistedSessions(workspaceDir, sessions) {
  const stateDir = path.join(workspaceDir, ".remote-vibes");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "sessions.json"),
    `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), sessions }, null, 2)}\n`,
    "utf8",
  );
}

async function waitForPort(baseUrl, port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/ports`);
    const payload = await response.json();

    if (payload.ports.some((entry) => entry.port === port)) {
      return payload.ports;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Port ${port} never appeared in /api/ports.`);
}

async function createBrainGitRemote(workspaceDir, name = "mac-brain") {
  const sourceDir = path.join(workspaceDir, `${name}-source`);
  const remoteDir = path.join(workspaceDir, `${name}.git`);
  await mkdir(sourceDir, { recursive: true });
  await execFileAsync("git", ["-C", sourceDir, "init", "-b", "main"]);
  await writeFile(
    path.join(sourceDir, "index.md"),
    `# Existing Brain\n\nLoaded from ${name}.\n`,
    "utf8",
  );
  await writeFile(path.join(sourceDir, "log.md"), "# Log\n\n- cloned brain fixture\n", "utf8");
  await execFileAsync("git", ["-C", sourceDir, "add", "."]);
  await execFileAsync("git", [
    "-C",
    sourceDir,
    "-c",
    "user.name=Remote Vibes Test",
    "-c",
    "user.email=remote-vibes@example.test",
    "commit",
    "-m",
    "seed brain",
  ]);
  await execFileAsync("git", ["clone", "--bare", sourceDir, remoteDir]);

  return {
    remoteDir,
    sourceDir,
  };
}

async function waitForShutdown(baseUrl) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await fetch(`${baseUrl}/api/state`);
    } catch {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Remote Vibes never shut down.");
}

async function waitForValue(check, expectedValue) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (check() === expectedValue) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Expected value ${expectedValue} was never observed.`);
}

async function listFilesRecursive(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(entryPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

async function waitForAttachmentFiles(root, expectedCount) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const files = await listFilesRecursive(root);
    if (files.length >= expectedCount) {
      return files;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Expected at least ${expectedCount} attachment files under ${root}.`);
}

test("state is available without authentication", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-state-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const response = await fetch(`${baseUrl}/api/state`);
    assert.equal(response.status, 200);

    const state = await response.json();
    assert.equal(state.appName, "Remote Vibes");
    const expectedDefaultProviderId = state.providers.some(
      (provider) => provider.id === "claude" && provider.available,
    )
      ? "claude"
      : "shell";
    assert.equal(state.defaultProviderId, expectedDefaultProviderId);
    assert.ok(state.providers.some((provider) => provider.id === "shell" && provider.available));
    assert.ok(Array.isArray(state.urls));
    assert.ok(state.urls.length >= 1);
    assert.equal(typeof state.preferredUrl, "string");
    assert.ok(state.urls.some((entry) => entry.url === state.preferredUrl));
    assert.equal(typeof state.agentPrompt.prompt, "string");
    assert.equal(state.agentPrompt.promptPath, ".remote-vibes/agent-prompt.md");
    assert.equal(state.agentPrompt.wikiRoot, ".remote-vibes/wiki");
    assert.ok(Array.isArray(state.agentPrompt.targets));
    assert.equal(state.settings.preventSleepEnabled, true);
    assert.equal(state.settings.sleepPrevention.enabled, true);
    assert.equal(state.settings.sleepPrevention.lastStatus, "unsupported");
    assert.equal(state.settings.wikiGitBackupEnabled, true);
    assert.equal(state.settings.wikiGitRemoteEnabled, true);
    assert.equal(state.settings.wikiGitRemoteBranch, "main");
    assert.equal(state.settings.wikiGitRemoteName, "origin");
    assert.equal(state.settings.wikiGitRemoteUrl, "");
    assert.equal(state.settings.wikiBackupIntervalMs, 5 * 60 * 1000);
    assert.equal(state.settings.wikiRelativeRoot, ".remote-vibes/wiki");
    assert.equal(typeof state.settings.wikiPath, "string");
    assert.equal(state.settings.wikiPathConfigured, false);
    assert.deepEqual(state.settings.agentAutomations, []);
    assert.deepEqual(state.settings.installedPluginIds, []);
    assert.equal(state.settings.wikiBackup.enabled, true);

    const gpuResponse = await fetch(`${baseUrl}/api/gpu`);
    assert.equal(gpuResponse.status, 404);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("image attachments are saved under the Remote Vibes state directory", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-attachment-workspace-");
  const stateDir = await createTempWorkspace("remote-vibes-attachment-state-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir, stateDir });

  try {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "shell", name: "attachment test" }),
    });
    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();

    const response = await fetch(`${baseUrl}/api/attachments/images`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        source: "paste",
        name: "screenshot.png",
        dataUrl: `data:image/png;base64,${PNG_FIXTURE.toString("base64")}`,
      }),
    });

    assert.equal(response.status, 201);
    const payload = await response.json();
    const attachment = payload.attachment;
    const expectedPrefix = path.join(stateDir, "attachments", "sessions", session.id);
    assert.equal(attachment.kind, "image");
    assert.equal(attachment.mimeType, "image/png");
    assert.equal(attachment.source, "paste");
    assert.equal(attachment.byteLength, PNG_FIXTURE.byteLength);
    assert.ok(attachment.absolutePath.startsWith(`${expectedPrefix}${path.sep}`));
    assert.ok(!attachment.absolutePath.startsWith(`${workspaceDir}${path.sep}`));
    assert.equal(path.extname(attachment.absolutePath), ".png");
    assert.deepEqual(await readFile(attachment.absolutePath), PNG_FIXTURE);

    const hintedMimeResponse = await fetch(`${baseUrl}/api/attachments/images`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        source: "drop",
        name: "fallback-image",
        mimeType: "image/gif",
        dataUrl: `data:;base64,${GIF_FIXTURE.toString("base64")}`,
      }),
    });
    assert.equal(hintedMimeResponse.status, 201);
    const hintedMimePayload = await hintedMimeResponse.json();
    assert.equal(hintedMimePayload.attachment.mimeType, "image/gif");
    assert.equal(path.extname(hintedMimePayload.attachment.absolutePath), ".gif");
    assert.deepEqual(await readFile(hintedMimePayload.attachment.absolutePath), GIF_FIXTURE);

    const missingSessionResponse = await fetch(`${baseUrl}/api/attachments/images`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "missing-session",
        dataUrl: `data:image/png;base64,${PNG_FIXTURE.toString("base64")}`,
      }),
    });
    assert.equal(missingSessionResponse.status, 404);

    const unsupportedTypeResponse = await fetch(`${baseUrl}/api/attachments/images`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        dataUrl: "data:text/plain;base64,aGVsbG8=",
      }),
    });
    assert.equal(unsupportedTypeResponse.status, 415);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("terminal paste and drop insert safe saved image markdown references", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for terminal attachment smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("remote-vibes-terminal-attachment-workspace-");
  const stateDir = await createTempWorkspace("remote-vibes-terminal-attachment-state-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir, stateDir });
  let browser = null;

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wikiPath: path.join(workspaceDir, "brain") }),
    });
    assert.equal(settingsResponse.status, 200);

    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "shell",
        name: "Attachment Terminal",
        cwd: workspaceDir,
      }),
    });
    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();
    const attachmentRoot = path.join(stateDir, "attachments", "sessions", session.id);

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(baseUrl);
    await page.waitForSelector("#terminal-mount .xterm-helper-textarea", { timeout: 10_000 });

    const pasteResult = await page.evaluate((pngBase64) => {
      const mount = document.querySelector("#terminal-mount");
      const binary = atob(pngBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "mobile screenshot.png", { type: "image/png" }));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: transfer });
      const defaultAllowed = mount.dispatchEvent(event);

      return {
        defaultAllowed,
        defaultPrevented: event.defaultPrevented,
      };
    }, PNG_FIXTURE.toString("base64"));

    assert.equal(pasteResult.defaultAllowed, false);
    assert.equal(pasteResult.defaultPrevented, true);
    await page.waitForFunction(
      () =>
        document.querySelector("#terminal-mount .xterm")?.textContent?.includes(
          "Attached image: ![pasted image: mobile-screenshot-",
        ),
      { timeout: 10_000 },
    );
    const pastedFiles = await waitForAttachmentFiles(attachmentRoot, 1);
    const pastedContents = await Promise.all(pastedFiles.map((filePath) => readFile(filePath)));
    assert.ok(pastedContents.some((content) => content.equals(PNG_FIXTURE)));

    const dropResult = await page.evaluate((gifBase64) => {
      const mount = document.querySelector("#terminal-mount");
      const binary = atob(gifBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "wireframe.gif", { type: "image/gif" }));
      const dispatch = (type) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: transfer });
        const defaultAllowed = mount.dispatchEvent(event);
        return {
          defaultAllowed,
          defaultPrevented: event.defaultPrevented,
          dragover: mount.classList.contains("is-attachment-dragover"),
        };
      };

      const entered = dispatch("dragenter");
      const hovered = dispatch("dragover");
      const dropped = dispatch("drop");

      return {
        entered,
        hovered,
        dropped,
        dragoverAfterDrop: mount.classList.contains("is-attachment-dragover"),
      };
    }, GIF_FIXTURE.toString("base64"));

    assert.equal(dropResult.entered.defaultAllowed, false);
    assert.equal(dropResult.hovered.defaultAllowed, false);
    assert.equal(dropResult.hovered.dragover, true);
    assert.equal(dropResult.dropped.defaultAllowed, false);
    assert.equal(dropResult.dropped.defaultPrevented, true);
    assert.equal(dropResult.dragoverAfterDrop, false);
    await page.waitForFunction(
      () =>
        document.querySelector("#terminal-mount .xterm")?.textContent?.includes(
          "Attached image: ![dropped image: wireframe-",
        ),
      { timeout: 10_000 },
    );

    const placeholderPasteResult = await page.evaluate((pngBase64) => {
      const mount = document.querySelector("#terminal-mount");
      const binary = atob(pngBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          read: async () => [
            {
              types: ["image/png"],
              getType: async () => new Blob([bytes], { type: "image/png" }),
            },
          ],
        },
      });

      const transfer = new DataTransfer();
      transfer.setData("text/plain", "[image 1]");
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: transfer });
      const defaultAllowed = mount.dispatchEvent(event);

      return {
        defaultAllowed,
        defaultPrevented: event.defaultPrevented,
      };
    }, PNG_FIXTURE.toString("base64"));

    assert.equal(placeholderPasteResult.defaultAllowed, false);
    assert.equal(placeholderPasteResult.defaultPrevented, true);
    await page.waitForFunction(
      () =>
        document.querySelector("#terminal-mount .xterm")?.textContent?.includes(
          "Attached image: ![pasted image: clipboard-image-1-",
        ),
      { timeout: 10_000 },
    );

    const allFiles = await waitForAttachmentFiles(attachmentRoot, 3);
    const allContents = await Promise.all(allFiles.map((filePath) => readFile(filePath)));
    assert.ok(allContents.some((content) => content.equals(PNG_FIXTURE)));
    assert.ok(allContents.some((content) => content.equals(GIF_FIXTURE)));

    const terminalText = await page.evaluate(
      () => document.querySelector("#terminal-mount .xterm")?.textContent || "",
    );
    assert.match(terminalText, /!\[pasted image: mobile-screenshot-[^\]]+\.png\]\(/);
    assert.match(terminalText, /!\[pasted image: clipboard-image-1-[^\]]+\.png\]\(/);
    assert.match(terminalText, /!\[dropped image: wireframe-[^\]]+\.gif\]\(/);
    assert.doesNotMatch(terminalText, /(?:^|[\r\n])!\[(?:pasted|dropped) image:/);
    assert.ok(terminalText.includes(path.join(stateDir, "attachments", "sessions", session.id)));
    assert.ok(!terminalText.includes(path.join(workspaceDir, ".remote-vibes", "attachments")));
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("settings api persists simple agent automations", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-agent-automations-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentAutomations: [
          {
            cadence: "weekly",
            createdAt: "2026-04-21T09:00:00.000Z",
            enabled: true,
            id: "automation-weekly-review",
            prompt: "Review the project and summarize anything that needs attention.",
            time: "09:30",
            weekday: "tuesday",
          },
          {
            cadence: "daily",
            id: "empty-prompt",
            prompt: "",
          },
        ],
      }),
    });

    assert.equal(settingsResponse.status, 200);
    const settingsPayload = await settingsResponse.json();
    assert.deepEqual(settingsPayload.settings.agentAutomations, [
      {
        cadence: "weekly",
        createdAt: "2026-04-21T09:00:00.000Z",
        enabled: true,
        id: "automation-weekly-review",
        prompt: "Review the project and summarize anything that needs attention.",
        time: "09:30",
        weekday: "tuesday",
      },
    ]);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("settings api persists installed plugin ids", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-installed-plugins-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        installedPluginIds: ["agentmail", "github", "knowledge-base", "localhost-apps", "agentmail", "../bad"],
      }),
    });

    assert.equal(settingsResponse.status, 200);
    const settingsPayload = await settingsResponse.json();
    assert.deepEqual(settingsPayload.settings.installedPluginIds, [
      "agentmail",
      "github",
      "knowledge-base",
      "localhost-apps",
    ]);

    const stateResponse = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateResponse.status, 200);
    const statePayload = await stateResponse.json();
    assert.deepEqual(statePayload.settings.installedPluginIds, [
      "agentmail",
      "github",
      "knowledge-base",
      "localhost-apps",
    ]);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("saved wiki paths from existing installs count as configured", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-existing-wiki-");
  const stateDir = path.join(workspaceDir, ".remote-vibes");
  const wikiDir = path.join(workspaceDir, "mac-brain");
  await mkdir(wikiDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "settings.json"),
    `${JSON.stringify({ version: 1, settings: { wikiPath: wikiDir } }, null, 2)}\n`,
    "utf8",
  );

  const { app, baseUrl } = await startApp({ cwd: workspaceDir, stateDir });

  try {
    const response = await fetch(`${baseUrl}/api/state`);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.settings.wikiPathConfigured, true);
    assert.equal(state.settings.wikiPath, wikiDir);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("wiki clone endpoint sets the brain from an existing git repo", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-clone-brain-");
  const { remoteDir } = await createBrainGitRemote(workspaceDir, "mac-brain");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const cloneResponse = await fetch(`${baseUrl}/api/wiki/clone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        remoteUrl: remoteDir,
      }),
    });
    assert.equal(cloneResponse.status, 200);
    const clonePayload = await cloneResponse.json();
    const canonicalBrainDir = await realpath(path.join(workspaceDir, "mac-brain"));
    assert.equal(clonePayload.settings.wikiPathConfigured, true);
    assert.equal(clonePayload.settings.wikiPath, canonicalBrainDir);
    assert.equal(clonePayload.settings.wikiGitRemoteEnabled, true);
    assert.equal(clonePayload.settings.wikiGitRemoteUrl, remoteDir);
    assert.equal(clonePayload.settings.wikiGitRemoteBranch, "main");

    const indexResponse = await fetch(`${baseUrl}/api/knowledge-base`);
    assert.equal(indexResponse.status, 200);
    const indexPayload = await indexResponse.json();
    assert.ok(indexPayload.notes.some((note) => note.relativePath === "index.md"));
    assert.ok(indexPayload.notes.some((note) => note.relativePath === "log.md"));
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("wiki clone endpoint replaces the installer mac-brain scaffold automatically", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-clone-scaffold-");
  const { remoteDir } = await createBrainGitRemote(workspaceDir, "mac-brain");
  const scaffoldDir = path.join(workspaceDir, "mac-brain");
  await mkdir(scaffoldDir, { recursive: true });
  await execFileAsync("git", ["-C", scaffoldDir, "init"]);
  await writeFile(
    path.join(scaffoldDir, "README.md"),
    `# mac-brain\n\nLocal wiki for this Mac.\n\nRemote Vibes settings live in:\n\n\`\`\`\n${path.join(workspaceDir, ".remote-vibes")}\n\`\`\`\n`,
    "utf8",
  );
  await writeFile(path.join(scaffoldDir, ".gitignore"), ".DS_Store\n", "utf8");
  const { app, baseUrl } = await startApp({
    cwd: path.join(workspaceDir, ".remote-vibes", "app"),
    stateDir: path.join(workspaceDir, ".remote-vibes"),
  });

  try {
    const cloneResponse = await fetch(`${baseUrl}/api/wiki/clone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        remoteUrl: remoteDir,
      }),
    });
    assert.equal(cloneResponse.status, 200);
    const clonePayload = await cloneResponse.json();
    const canonicalBrainDir = await realpath(scaffoldDir);
    assert.equal(clonePayload.clone.action, "clone");
    assert.match(clonePayload.clone.backupPath, /mac-brain\.remote-vibes-scaffold-/);
    assert.equal(clonePayload.settings.wikiPath, canonicalBrainDir);
    assert.equal(clonePayload.settings.wikiPathConfigured, true);
    assert.equal(clonePayload.settings.wikiGitRemoteUrl, remoteDir);

    const backupReadme = await readFile(path.join(clonePayload.clone.backupPath, "README.md"), "utf8");
    assert.match(backupReadme, /Local wiki for this Mac/);

    const clonedReadme = await readFile(path.join(scaffoldDir, "index.md"), "utf8");
    assert.match(clonedReadme, /Existing Brain/);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("update endpoints report status and schedule restart", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-update-");
  const updatePayload = {
    status: "available",
    updateAvailable: true,
    canUpdate: true,
    branch: "main",
    currentShort: "abc1234",
    latestShort: "def5678",
  };
  const forceCalls = [];
  let runtimePort = null;
  let applyCalls = 0;
  const updateManager = {
    setRuntime({ port }) {
      runtimePort = port;
    },
    async getStatus({ force } = {}) {
      forceCalls.push(Boolean(force));
      return updatePayload;
    },
    async scheduleUpdateAndRestart() {
      applyCalls += 1;
      return { ok: true, scheduled: true, update: updatePayload };
    },
  };
  const { app, baseUrl } = await startApp({ cwd: workspaceDir, updateManager });

  try {
    assert.equal(runtimePort, app.config.port);

    const statusResponse = await fetch(`${baseUrl}/api/update/status?force=1`);
    assert.equal(statusResponse.status, 200);
    assert.deepEqual(await statusResponse.json(), { update: updatePayload });
    assert.deepEqual(forceCalls, [true]);

    const applyResponse = await fetch(`${baseUrl}/api/update/apply`, {
      method: "POST",
    });
    assert.equal(applyResponse.status, 200);
    assert.deepEqual(await applyResponse.json(), { ok: true, scheduled: true, update: updatePayload });
    assert.equal(applyCalls, 1);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("system endpoint reports host storage and utilization metrics", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-system-");
  const checkedAt = new Date().toISOString();
  const systemPayload = {
    checkedAt,
    hostname: "test-host",
    platform: "test",
    uptimeSeconds: 120,
    storage: {
      primary: {
        name: "Test Disk",
        mountPoint: "/",
        totalBytes: 1000,
        usedBytes: 700,
        availableBytes: 300,
        usedPercent: 70,
      },
      volumes: [],
      warnings: [],
    },
    cpu: {
      model: "Test CPU",
      coreCount: 1,
      utilizationPercent: 25,
      cores: [{ id: 0, label: "CPU 1", utilizationPercent: 25 }],
      loadAverage: [0, 0, 0],
    },
    memory: {
      totalBytes: 1000,
      usedBytes: 500,
      freeBytes: 500,
      usedPercent: 50,
    },
    gpus: [{ id: "gpu-0", name: "Test GPU", utilizationPercent: 33, source: "test" }],
    accelerators: [{ id: "accel-0", name: "Test Accelerator", utilizationPercent: null, source: "test" }],
    warnings: [],
  };
  let calls = 0;
  const { app, baseUrl } = await startApp({
    cwd: workspaceDir,
    providers: [{ id: "codex", label: "Codex", available: true, command: "true" }],
    systemMetricsProvider: async ({ cwd }) => {
      calls += 1;
      assert.equal(cwd, workspaceDir);
      return systemPayload;
    },
  });

  try {
    const response = await fetch(`${baseUrl}/api/system`);
    assert.equal(response.status, 200);
    const systemResponse = await response.json();
    assert.deepEqual(systemResponse, { system: systemPayload });
    assert.equal(systemResponse.system.agentUsage.source, "remote-vibes-local");
    assert.equal(systemResponse.system.agentUsage.providers[0].id, "codex");
    const historyResponse = await fetch(`${baseUrl}/api/system/history?range=1h`);
    assert.equal(historyResponse.status, 200);
    const history = (await historyResponse.json()).history;
    assert.equal(history.range, "1h");
    assert.equal(history.rawSampleCount, 1);
    assert.equal(history.samples[0].checkedAt, checkedAt);
    assert.equal(history.samples[0].memory.usedPercent, 50);
    assert.equal(history.samples[0].storage.primary.usedPercent, 70);
    assert.equal(calls, 1);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("agent prompt api creates wiki scaffold and managed instruction files", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-agent-prompt-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const stateResponse = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateResponse.status, 200);
    const statePayload = await stateResponse.json();

    assert.match(statePayload.agentPrompt.prompt, /Remote Vibes Agent Prompt/);
    assert.equal(statePayload.agentPrompt.targets.length, 3);
    assert.ok(statePayload.agentPrompt.targets.every((target) => target.status !== "conflict"));

    const managedAgents = await readFile(path.join(workspaceDir, "AGENTS.md"), "utf8");
    const managedClaude = await readFile(path.join(workspaceDir, "CLAUDE.md"), "utf8");
    const promptSource = await readFile(path.join(workspaceDir, ".remote-vibes", "agent-prompt.md"), "utf8");
    const wikiIndex = await readFile(path.join(workspaceDir, ".remote-vibes", "wiki", "index.md"), "utf8");

    assert.match(managedAgents, /remote-vibes:managed-agent-prompt/);
    assert.match(managedClaude, /remote-vibes:managed-agent-prompt/);
    assert.match(managedAgents, /Edit this from Remote Vibes or \.remote-vibes\/agent-prompt\.md/);
    assert.match(promptSource, /Remote Vibes Agent Prompt/);
    assert.match(promptSource, /You are a research agent/);
    assert.match(promptSource, /Always take QUEUE row 1/);
    assert.match(promptSource, /remote-vibes:wiki-v2-protocol:v2/);
    assert.match(promptSource, /Treat links as traversal hints, not decoration/);
    assert.match(promptSource, /Start with the directly named files, notes, messages, or artifacts/);
    assert.doesNotMatch(promptSource, /\/Users\/mark\/mac-brain/);
    assert.doesNotMatch(promptSource, /remote-vibes:agent-mailbox-protocol/);
    assert.doesNotMatch(promptSource, /Agent Mailboxes/);
    assert.doesNotMatch(promptSource, /rv-mailwatch/);
    assert.doesNotMatch(promptSource, /from_name/);
    assert.match(wikiIndex, /Wiki Index/);

    const updateResponse = await fetch(`${baseUrl}/api/agent-prompt`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "# Custom Prompt\n\nAlways log experiment changes in `.remote-vibes/wiki/log.md`.",
      }),
    });

    assert.equal(updateResponse.status, 200);
    const updatedPayload = await updateResponse.json();
    assert.match(updatedPayload.prompt, /Custom Prompt/);
    assert.match(updatedPayload.prompt, /remote-vibes:wiki-v2-protocol:v2/);
    assert.match(updatedPayload.prompt, /Prefer fewer, better notes/);
    assert.doesNotMatch(updatedPayload.prompt, /remote-vibes:agent-mailbox-protocol/);
    assert.doesNotMatch(updatedPayload.prompt, /Agent Mailboxes/);

    const updatedManagedAgents = await readFile(path.join(workspaceDir, "AGENTS.md"), "utf8");
    assert.match(updatedManagedAgents, /Custom Prompt/);
    assert.match(updatedManagedAgents, /Knowledge Model/);
    assert.doesNotMatch(updatedManagedAgents, /Agent Mailboxes/);
    assert.doesNotMatch(updatedManagedAgents, /rv-mailwatch/);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("agent prompt save preserves edits inside the current wiki protocol section", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-agent-prompt-save-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const response = await fetch(`${baseUrl}/api/agent-prompt`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.match(payload.prompt, /remote-vibes:wiki-v2-protocol:v2/);
    assert.match(payload.prompt, /Prefer fewer, better notes/);

    const editedPrompt = payload.prompt.replace(
      "Prefer fewer, better notes.",
      "Prefer fewer, better durable notes.",
    );
    const updateResponse = await fetch(`${baseUrl}/api/agent-prompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: editedPrompt }),
    });
    assert.equal(updateResponse.status, 200);
    const updatedPayload = await updateResponse.json();
    assert.match(updatedPayload.prompt, /Prefer fewer, better durable notes/);
    assert.doesNotMatch(updatedPayload.prompt, /Prefer fewer, better notes\./);

    const savedPrompt = await readFile(
      path.join(workspaceDir, ".remote-vibes", "agent-prompt.md"),
      "utf8",
    );
    assert.match(savedPrompt, /Prefer fewer, better durable notes/);

    const managedClaude = await readFile(path.join(workspaceDir, "CLAUDE.md"), "utf8");
    assert.match(managedClaude, /Prefer fewer, better durable notes/);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("existing prompt files are upgraded with the current built-in wiki protocol only", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-agent-prompt-upgrade-");
  const stateDir = path.join(workspaceDir, ".remote-vibes");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "agent-prompt.md"),
    "# Custom Prompt\n\nAlways leave concise handoff notes in the wiki.\n",
    "utf8",
  );

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const response = await fetch(`${baseUrl}/api/agent-prompt`);
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.match(payload.prompt, /Custom Prompt/);
    assert.match(payload.prompt, /remote-vibes:wiki-v2-protocol:v2/);
    assert.match(payload.prompt, /Search And Traversal/);
    assert.match(payload.prompt, /specific exchange or artifact/);
    assert.doesNotMatch(payload.prompt, /remote-vibes:agent-mailbox-protocol/);
    assert.doesNotMatch(payload.prompt, /Agent Mailboxes/);
    assert.doesNotMatch(payload.prompt, /rv-mailwatch/);
    assert.doesNotMatch(payload.prompt, /REMOTE_VIBES_SESSION_ID/);

    const savedPrompt = await readFile(path.join(stateDir, "agent-prompt.md"), "utf8");
    assert.match(savedPrompt, /Custom Prompt/);
    assert.match(savedPrompt, /Crystallization And Supersession/);
    assert.doesNotMatch(savedPrompt, /Agent Mailboxes/);

    const managedGemini = await readFile(path.join(workspaceDir, "GEMINI.md"), "utf8");
    assert.match(managedGemini, /Treat links as traversal hints, not decoration/);
    assert.doesNotMatch(managedGemini, /Agent Mailboxes/);
    assert.doesNotMatch(managedGemini, /reply_to/);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("legacy built-in prompt sections are replaced with the current versions", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-agent-prompt-legacy-upgrade-");
  const stateDir = path.join(workspaceDir, ".remote-vibes");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "agent-prompt.md"),
    `# Custom Prompt

Keep a crisp research log.

<!-- remote-vibes:wiki-v2-protocol:v1 -->

## Old Wiki Section

Old guidance.

<!-- remote-vibes:agent-mailbox-protocol:v1 -->

## Old Mailbox Section

Old mailbox guidance.
`,
    "utf8",
  );

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const response = await fetch(`${baseUrl}/api/agent-prompt`);
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.match(payload.prompt, /Custom Prompt/);
    assert.doesNotMatch(payload.prompt, /remote-vibes:wiki-v2-protocol:v1/);
    assert.doesNotMatch(payload.prompt, /remote-vibes:agent-mailbox-protocol/);
    assert.match(payload.prompt, /remote-vibes:wiki-v2-protocol:v2/);
    assert.match(payload.prompt, /Knowledge Model/);
    assert.doesNotMatch(payload.prompt, /Agent Mailboxes/);
    assert.doesNotMatch(payload.prompt, /from_name/);
    assert.doesNotMatch(payload.prompt, /rv-mailwatch/);
    assert.doesNotMatch(payload.prompt, /Old Wiki Section/);
    assert.doesNotMatch(payload.prompt, /Old Mailbox Section/);

    const savedPrompt = await readFile(path.join(stateDir, "agent-prompt.md"), "utf8");
    assert.doesNotMatch(savedPrompt, /remote-vibes:wiki-v2-protocol:v1/);
    assert.doesNotMatch(savedPrompt, /remote-vibes:agent-mailbox-protocol/);
    assert.match(savedPrompt, /Knowledge Model/);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("agent prompt sync does not overwrite unmanaged instruction files", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-agent-conflict-");
  await writeFile(path.join(workspaceDir, "AGENTS.md"), "# User-owned instructions\n", "utf8");

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const response = await fetch(`${baseUrl}/api/agent-prompt`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const agentsTarget = payload.targets.find((target) => target.label === "AGENTS.md");

    assert.ok(agentsTarget);
    assert.equal(agentsTarget.status, "conflict");
    assert.equal(await readFile(path.join(workspaceDir, "AGENTS.md"), "utf8"), "# User-owned instructions\n");
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("knowledge base api indexes markdown notes and linked note content", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-knowledge-base-");
  const wikiDir = path.join(workspaceDir, ".remote-vibes", "wiki");
  const topicsDir = path.join(wikiDir, "topics");

  await mkdir(topicsDir, { recursive: true });
  await writeFile(
    path.join(wikiDir, "index.md"),
    "# Wiki Index\n\nSee [Topic A](topics/topic-a.md) and [[log]].\n",
    "utf8",
  );
  await writeFile(
    path.join(wikiDir, "log.md"),
    "# Wiki Log\n\nLinked back to [[index]].\n",
    "utf8",
  );
  await writeFile(
    path.join(topicsDir, "topic-a.md"),
    "# Topic A\n\nBack to [Index](../index.md).\n\nSource manifest: [raw](../../raw/sources/topic-a.md)\n",
    "utf8",
  );

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const indexResponse = await fetch(`${baseUrl}/api/knowledge-base`);
    assert.equal(indexResponse.status, 200);
    const indexPayload = await indexResponse.json();

    assert.equal(indexPayload.relativeRoot, ".remote-vibes/wiki");
    assert.deepEqual(
      indexPayload.notes.map((note) => note.relativePath),
      ["index.md", "log.md", "topics/topic-a.md"],
    );
    assert.match(
      indexPayload.notes.find((note) => note.relativePath === "topics/topic-a.md").searchText,
      /Source manifest/,
    );
    assert.deepEqual(indexPayload.edges, [
      { source: "index.md", target: "log.md" },
      { source: "index.md", target: "topics/topic-a.md" },
      { source: "log.md", target: "index.md" },
      { source: "topics/topic-a.md", target: "index.md" },
    ]);

    const noteResponse = await fetch(
      `${baseUrl}/api/knowledge-base/note?path=${encodeURIComponent("topics/topic-a.md")}`,
    );
    assert.equal(noteResponse.status, 200);
    const notePayload = await noteResponse.json();

    assert.equal(notePayload.note.relativePath, "topics/topic-a.md");
    assert.equal(notePayload.note.title, "Topic A");
    assert.match(notePayload.note.content, /Back to \[Index\]/);

    const invalidNoteResponse = await fetch(
      `${baseUrl}/api/knowledge-base/note?path=${encodeURIComponent("../agent-prompt.md")}`,
    );
    assert.equal(invalidNoteResponse.status, 400);
    assert.match((await invalidNoteResponse.json()).error, /escapes the knowledge base root/i);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("knowledge base api skips inaccessible and system directories", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-knowledge-base-skip-");
  const wikiDir = path.join(workspaceDir, ".remote-vibes", "wiki");
  const trashDir = path.join(wikiDir, ".Trash");
  const hiddenToolsDir = path.join(wikiDir, ".antigravity", "extensions", "example");
  const modulesDir = path.join(wikiDir, "node_modules", "pkg");
  const lockedDir = path.join(wikiDir, "locked");

  await mkdir(trashDir, { recursive: true });
  await mkdir(hiddenToolsDir, { recursive: true });
  await mkdir(modulesDir, { recursive: true });
  await mkdir(lockedDir, { recursive: true });
  await writeFile(path.join(wikiDir, "index.md"), "# Wiki Index\n\nReadable.\n", "utf8");
  await writeFile(path.join(trashDir, "deleted.md"), "# Deleted\n\nShould not index.\n", "utf8");
  await writeFile(path.join(hiddenToolsDir, "readme.md"), "# Extension\n\nShould not index.\n", "utf8");
  await writeFile(path.join(modulesDir, "readme.md"), "# Package\n\nShould not index.\n", "utf8");
  await writeFile(path.join(lockedDir, "secret.md"), "# Secret\n\nShould not crash.\n", "utf8");
  await chmod(lockedDir, 0);

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const indexResponse = await fetch(`${baseUrl}/api/knowledge-base`);
    assert.equal(indexResponse.status, 200);
    const indexPayload = await indexResponse.json();

    assert.deepEqual(
      indexPayload.notes.map((note) => note.relativePath),
      ["index.md", "log.md"],
    );
    assert.ok(indexPayload.skippedEntries >= 3);
  } finally {
    await chmod(lockedDir, 0o700).catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("knowledge base api narrows broad roots to nested remote vibes wiki", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-knowledge-base-nested-");
  const wikiDir = path.join(workspaceDir, ".remote-vibes", "wiki");
  await mkdir(wikiDir, { recursive: true });
  const canonicalWikiDir = await realpath(wikiDir);

  await writeFile(path.join(workspaceDir, "README.md"), "# Project README\n\nNot a wiki note.\n", "utf8");
  await writeFile(path.join(wikiDir, "index.md"), "# Wiki Index\n\nReadable.\n", "utf8");

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wikiPath: workspaceDir }),
    });
    assert.equal(settingsResponse.status, 200);

    const indexResponse = await fetch(`${baseUrl}/api/knowledge-base`);
    assert.equal(indexResponse.status, 200);
    const indexPayload = await indexResponse.json();

    assert.equal(indexPayload.rootPath, canonicalWikiDir);
    assert.equal(indexPayload.relativeRoot, ".remote-vibes/wiki");
    assert.deepEqual(
      indexPayload.notes.map((note) => note.relativePath),
      ["index.md", "log.md"],
    );
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("knowledge base search ranks prefix markdown notes with BM25", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the knowledge search smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("remote-vibes-knowledge-search-");
  const wikiDir = path.join(workspaceDir, ".remote-vibes", "wiki");
  await mkdir(wikiDir, { recursive: true });
  await writeFile(path.join(wikiDir, "index.md"), "# Wiki Index\n\nStart here.\n", "utf8");
  await writeFile(path.join(wikiDir, "install-guide.md"), "# Install Guide\n\nUse this for setup.\n", "utf8");
  await writeFile(
    path.join(wikiDir, "meeting-notes.md"),
    "# Meeting Notes\n\ninstall guide install guide install guide install guide install guide\n",
    "utf8",
  );

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let browser = null;

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wikiPath: wikiDir }),
    });
    assert.equal(settingsResponse.status, 200);

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/?view=knowledge-base`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".knowledge-base-view", { timeout: 10_000 });
    await page.fill("#knowledge-base-search", "inst gui");
    await page.waitForFunction(() => document.querySelectorAll(".knowledge-base-note-row").length === 2, null, {
      timeout: 10_000,
    });

    const titles = await page.$$eval(".knowledge-base-note-title", (elements) =>
      elements.map((element) => element.textContent.trim()),
    );

    assert.deepEqual(titles, ["Install Guide", "Meeting Notes"]);
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("knowledge base graph highlights linked notes on hover and can pulse physics", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the knowledge graph smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("remote-vibes-knowledge-graph-");
  const wikiDir = path.join(workspaceDir, ".remote-vibes", "wiki");
  await mkdir(wikiDir, { recursive: true });
  await writeFile(path.join(wikiDir, "index.md"), "# Wiki Index\n\nSee [[topic-a]].\n", "utf8");
  await writeFile(path.join(wikiDir, "topic-a.md"), "# Topic A\n\nBack to [[index]] and next [[topic-b]].\n", "utf8");
  await writeFile(path.join(wikiDir, "topic-b.md"), "# Topic B\n\nLeaf note.\n", "utf8");

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let browser = null;

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wikiPath: wikiDir }),
    });
    assert.equal(settingsResponse.status, 200);

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/?view=knowledge-base`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#knowledge-base-graph", { timeout: 10_000 });
    await page.waitForFunction(() => {
      return Boolean(
        document.querySelector('[data-kb-graph-node="topic-a.md"]') &&
          document.querySelector('[data-kb-graph-node="topic-b.md"]'),
      );
    }, null, {
      timeout: 10_000,
    });

    await page.click("#pulse-knowledge-base-graph");
    await page.locator('[data-kb-graph-node="topic-a.md"] circle').hover();
    await page.waitForFunction(() => {
      return document.querySelector('[data-kb-graph-node="topic-b.md"]')?.classList.contains("is-connected");
    }, null, { timeout: 10_000 });

    const graphState = await page.evaluate(() => {
      return {
        pulseLabel: document.querySelector("#pulse-knowledge-base-graph")?.getAttribute("aria-label") || "",
        topicBConnected: document
          .querySelector('[data-kb-graph-node="topic-b.md"]')
          ?.classList.contains("is-connected"),
        connectedEdges: document.querySelectorAll(".knowledge-base-graph-edge.is-connected").length,
      };
    });

    assert.equal(graphState.pulseLabel, "Pulse graph physics");
    assert.equal(graphState.topicBConnected, true);
    assert.ok(graphState.connectedEdges >= 1);
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("knowledge base graph keeps dense replay inside the viewport", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the knowledge graph fit smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("remote-vibes-knowledge-graph-fit-");
  const wikiDir = path.join(workspaceDir, ".remote-vibes", "wiki");
  await mkdir(wikiDir, { recursive: true });

  const noteLinks = [];
  for (let index = 0; index < 48; index += 1) {
    const groupName = `cluster-${index % 8}`;
    const noteDir = path.join(wikiDir, groupName);
    const noteName = `note-${String(index).padStart(2, "0")}.md`;
    await mkdir(noteDir, { recursive: true });
    await writeFile(
      path.join(noteDir, noteName),
      `# ${groupName} ${index}\n\nBack to [[../index]] and [[../cluster-${(index + 1) % 8}/note-${String((index + 1) % 48).padStart(2, "0")}]].\n`,
      "utf8",
    );
    noteLinks.push(`[[${groupName}/${noteName.replace(/\.md$/, "")}]]`);
  }

  await writeFile(path.join(wikiDir, "index.md"), `# Dense Index\n\n${noteLinks.join(" ")}\n`, "utf8");

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let browser = null;

  const readGraphClipState = async (page) =>
    page.evaluate(() => {
      const svg = document.querySelector("#knowledge-base-graph");
      const frame = document.querySelector(".knowledge-base-graph-frame");
      const viewport = document.querySelector("[data-kb-graph-viewport]");
      const svgBox = svg?.getBoundingClientRect();
      const frameBox = frame?.getBoundingClientRect();
      if (!svg || !svgBox || !frameBox) {
        return {
          clippedCircles: -1,
          clippedCirclesAgainstFrame: -1,
          clippedVisibleLabelsAgainstFrame: -1,
          graphFrameCornerRadii: {},
          minCircleFrameGutter: -1,
          minVisibleLabelFrameGutter: -1,
          scale: 0,
          svgExtendsPastFrame: true,
          svgFrameGaps: {},
          transform: "",
        };
      }

      const getMinimumFrameGutter = (elements) => {
        if (!elements.length) {
          return Infinity;
        }

        return Math.min(
          ...elements.map((element) => {
            const box = element.getBoundingClientRect();
            return Math.min(
              box.left - frameBox.left,
              frameBox.right - box.right,
              box.top - frameBox.top,
              frameBox.bottom - box.bottom,
            );
          }),
        );
      };

      const isOutsideBox = (element, box, tolerance = 1) => {
        const elementBox = element.getBoundingClientRect();
        return (
          elementBox.left < box.left - tolerance ||
          elementBox.right > box.right + tolerance ||
          elementBox.top < box.top - tolerance ||
          elementBox.bottom > box.bottom + tolerance
        );
      };

      const circles = Array.from(document.querySelectorAll("[data-kb-graph-node] circle"));
      const visibleLabels = Array.from(
        document.querySelectorAll(
          "[data-kb-graph-node].has-visible-label text, [data-kb-graph-node].is-connected text, [data-kb-graph-node].is-hovered text, [data-kb-graph-node].is-selected text",
        ),
      );
      const clippedCircles = circles.filter((circle) => {
        const box = circle.getBoundingClientRect();
        return (
          box.left < svgBox.left - 1 ||
          box.right > svgBox.right + 1 ||
          box.top < svgBox.top - 1 ||
          box.bottom > svgBox.bottom + 1
        );
      }).length;
      const clippedCirclesAgainstFrame = circles.filter((circle) => isOutsideBox(circle, frameBox)).length;
      const clippedVisibleLabelsAgainstFrame = visibleLabels.filter((label) => isOutsideBox(label, frameBox)).length;
      const frameStyle = window.getComputedStyle(frame);

      const transform = viewport?.getAttribute("transform") || "";
      const scaleMatch = transform.match(/scale\(([0-9.]+)\)/);

      return {
        clippedCircles,
        clippedCirclesAgainstFrame,
        clippedVisibleLabelsAgainstFrame,
        graphFrameCornerRadii: {
          bottomLeft: frameStyle.borderBottomLeftRadius,
          bottomRight: frameStyle.borderBottomRightRadius,
        },
        minCircleFrameGutter: getMinimumFrameGutter(circles),
        minVisibleLabelFrameGutter: getMinimumFrameGutter(visibleLabels),
        scale: Number.parseFloat(scaleMatch?.[1] || "0"),
        svgExtendsPastFrame:
          svgBox.left < frameBox.left - 1 ||
          svgBox.right > frameBox.right + 1 ||
          svgBox.top < frameBox.top - 1 ||
          svgBox.bottom > frameBox.bottom + 1,
        svgFrameGaps: {
          bottom: frameBox.bottom - svgBox.bottom,
          left: svgBox.left - frameBox.left,
          right: frameBox.right - svgBox.right,
          top: svgBox.top - frameBox.top,
        },
        transform,
      };
    });

  const readGraphRadialState = async (page) =>
    page.evaluate(() => {
      const svg = document.querySelector("#knowledge-base-graph");
      const viewBox = svg?.viewBox?.baseVal;
      const centerX = viewBox ? viewBox.x + viewBox.width / 2 : 460;
      const centerY = viewBox ? viewBox.y + viewBox.height / 2 : 340;
      const distances = Array.from(document.querySelectorAll("[data-kb-graph-node]"))
        .map((node) => {
          const transform = node.getAttribute("transform") || "";
          const match = transform.match(/translate\((-?[0-9.]+)\s+(-?[0-9.]+)\)/);
          if (!match) {
            return null;
          }

          const x = Number.parseFloat(match[1]);
          const y = Number.parseFloat(match[2]);
          return Number.isFinite(x) && Number.isFinite(y) ? Math.hypot(x - centerX, y - centerY) : null;
        })
        .filter((distance) => Number.isFinite(distance));
      const minRadius = distances.length ? Math.min(...distances) : 0;
      const maxRadius = distances.length ? Math.max(...distances) : 0;

      return {
        closeToCenterShare: distances.length
          ? distances.filter((distance) => distance < 56).length / distances.length
          : 1,
        count: distances.length,
        maxRadius,
        minRadius,
        radiusRange: maxRadius - minRadius,
      };
    });

  const assertGraphHasFrameGutter = (graphState, phase) => {
    assert.equal(graphState.svgExtendsPastFrame, false, `${phase}: graph SVG should fit inside the outer frame`);
    for (const [side, gap] of Object.entries(graphState.svgFrameGaps || {})) {
      assert.ok(Math.abs(gap) <= 1, `${phase}: graph SVG should be flush to ${side} frame edge, saw ${gap}px`);
    }
    assert.equal(graphState.graphFrameCornerRadii?.bottomLeft, "0px", `${phase}: lower graph edge should meet legend`);
    assert.equal(graphState.graphFrameCornerRadii?.bottomRight, "0px", `${phase}: lower graph edge should meet legend`);
    assert.equal(graphState.clippedCircles, 0, `${phase}: circles should fit inside the SVG viewport`);
    assert.equal(
      graphState.clippedCirclesAgainstFrame,
      0,
      `${phase}: circles should not be clipped by the outer graph frame`,
    );
    assert.equal(
      graphState.clippedVisibleLabelsAgainstFrame,
      0,
      `${phase}: visible labels should not be clipped by the outer graph frame`,
    );
    assert.ok(
      graphState.minCircleFrameGutter >= 8,
      `${phase}: expected at least 8px circle gutter, saw ${graphState.minCircleFrameGutter}`,
    );
    assert.ok(
      graphState.minVisibleLabelFrameGutter >= 4,
      `${phase}: expected at least 4px visible-label gutter, saw ${graphState.minVisibleLabelFrameGutter}`,
    );
  };

  const sampleReplayScales = async (page) => {
    const scales = [];
    for (let index = 0; index < 5; index += 1) {
      await page.waitForTimeout(120);
      scales.push((await readGraphClipState(page)).scale);
    }
    return scales;
  };

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wikiPath: wikiDir }),
    });
    assert.equal(settingsResponse.status, 200);

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.goto(`${baseUrl}/?view=knowledge-base`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#knowledge-base-graph", { timeout: 10_000 });
    await page.waitForFunction(() => document.querySelectorAll("[data-kb-graph-node]").length >= 49, null, {
      timeout: 10_000,
    });

    const initialReplayScales = await sampleReplayScales(page);
    const maxInitialReplayScale = Math.max(...initialReplayScales);
    assert.ok(
      maxInitialReplayScale > 0 && maxInitialReplayScale <= 1.16,
      `dense graph replay should stay at overview scale, saw ${initialReplayScales.join(", ")}`,
    );
    await page.waitForTimeout(700);

    const initialClipState = await readGraphClipState(page);
    assertGraphHasFrameGutter(initialClipState, "initial dense replay");
    assert.match(initialClipState.transform, /scale\([0-9.]+\)/);

    await page.click("#pulse-knowledge-base-graph");
    const pulseStartShape = await readGraphRadialState(page);
    assert.ok(pulseStartShape.count >= 49, `expected dense graph nodes, saw ${pulseStartShape.count}`);
    assert.ok(
      pulseStartShape.maxRadius >= 95,
      `pulse replay should start from an irregular graph-shaped cloud, saw max radius ${pulseStartShape.maxRadius}`,
    );
    assert.ok(
      pulseStartShape.radiusRange >= 70,
      `pulse replay should avoid a uniform center bloom, saw radius range ${pulseStartShape.radiusRange}`,
    );
    assert.ok(
      pulseStartShape.closeToCenterShare < 0.55,
      `pulse replay should not collapse most nodes near center, saw share ${pulseStartShape.closeToCenterShare}`,
    );
    const pulseReplayScales = await sampleReplayScales(page);
    const maxPulseReplayScale = Math.max(...pulseReplayScales);
    assert.ok(
      maxPulseReplayScale > 0 && maxPulseReplayScale <= 1.16,
      `pulse replay should stay at overview scale, saw ${pulseReplayScales.join(", ")}`,
    );
    await page.waitForTimeout(700);

    const replayClipState = await readGraphClipState(page);
    assertGraphHasFrameGutter(replayClipState, "pulse replay");

    await page.setViewportSize({ width: 1024, height: 620 });
    await page.waitForTimeout(200);
    await page.click("#fit-knowledge-base-graph");
    await page.waitForTimeout(700);

    const shortViewportClipState = await readGraphClipState(page);
    assertGraphHasFrameGutter(shortViewportClipState, "short viewport fit");
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("fresh browser starts on brain folder setup until a folder is chosen", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the brain setup smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("remote-vibes-brain-setup-");
  const { remoteDir } = await createBrainGitRemote(workspaceDir, "brain-remote");
  const brainDir = path.join(workspaceDir, "brain-repo");
  await mkdir(brainDir, { recursive: true });
  await writeFile(path.join(brainDir, "index.md"), "# Local Brain\n", "utf8");
  await execFileAsync("git", ["-C", brainDir, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", brainDir, "remote", "add", "origin", remoteDir]);
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let browser = null;

  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".brain-setup-screen", { timeout: 10_000 });
    await page.waitForSelector("text=Select a brain folder", { timeout: 10_000 });
    await page.waitForSelector("text=Insert GitHub URL", { timeout: 10_000 });
    assert.equal(await page.locator(".app-shell").count(), 0);

    await page.locator(".brain-setup-button").click();
    await page.waitForSelector(".folder-picker-modal", { timeout: 10_000 });
    await page.locator(".folder-picker-tree-row", { hasText: "brain-repo" }).click();
    await page.waitForFunction(() => document.querySelector(".folder-picker-path")?.textContent?.includes("brain-repo"), null, {
      timeout: 10_000,
    });
    const canonicalBrainDir = await realpath(brainDir);

    await page.click("#folder-picker-select");
    await page.waitForSelector(".app-shell", { timeout: 10_000 });
    await page.waitForSelector(".knowledge-base-view", { timeout: 10_000 });

    const settingsResponse = await fetch(`${baseUrl}/api/settings`);
    assert.equal(settingsResponse.status, 200);
    const settingsPayload = await settingsResponse.json();
    assert.equal(settingsPayload.settings.wikiPathConfigured, true);
    assert.equal(settingsPayload.settings.wikiPath, canonicalBrainDir);
    assert.equal(settingsPayload.settings.wikiGitRemoteUrl, remoteDir);
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("brain setup can clone an existing git brain from the browser", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the brain clone smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("remote-vibes-brain-clone-ui-");
  const { remoteDir } = await createBrainGitRemote(workspaceDir, "existing-brain");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let browser = null;

  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".brain-setup-screen", { timeout: 10_000 });
    await page.fill("#brain-git-url", remoteDir);
    await page.click("#brain-git-form button[type='submit']");
    await page.waitForSelector(".app-shell", { timeout: 20_000 });
    await page.waitForSelector(".knowledge-base-view", { timeout: 10_000 });
    await page.waitForSelector(".knowledge-base-markdown", { timeout: 10_000 });

    const renderedText = await page.locator(".knowledge-base-markdown").textContent();
    assert.match(renderedText || "", /Existing Brain/);

    const settingsResponse = await fetch(`${baseUrl}/api/settings`);
    assert.equal(settingsResponse.status, 200);
    const settingsPayload = await settingsResponse.json();
    const canonicalBrainDir = await realpath(path.join(workspaceDir, "existing-brain"));
    assert.equal(settingsPayload.settings.wikiPathConfigured, true);
    assert.equal(settingsPayload.settings.wikiPath, canonicalBrainDir);
    assert.equal(settingsPayload.settings.wikiGitRemoteUrl, remoteDir);
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("brain setup remains scrollable on short viewports", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the brain setup scroll smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("remote-vibes-brain-scroll-ui-");
  const stateDir = path.join(workspaceDir, ".remote-vibes");
  const appDir = path.join(stateDir, "app");
  const expectedClonePath = path.join(workspaceDir, "mac-brain");
  await mkdir(appDir, { recursive: true });
  const { app, baseUrl } = await startApp({ cwd: appDir, stateDir });
  let browser = null;

  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 768, height: 640 } });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".brain-setup-screen", { timeout: 10_000 });

    const before = await page.evaluate(() => {
      const screen = document.querySelector(".brain-setup-screen");
      const cloneButton = document.querySelector(".brain-setup-clone-button");
      const clonePathInput = document.querySelector("#brain-clone-path");
      const screenBounds = screen.getBoundingClientRect();
      const buttonBounds = cloneButton.getBoundingClientRect();

      return {
        clonePathPlaceholder: clonePathInput?.getAttribute("placeholder") || "",
        screenBottom: screenBounds.bottom,
        screenClientHeight: screen.clientHeight,
        screenScrollHeight: screen.scrollHeight,
        buttonBottom: buttonBounds.bottom,
        viewportHeight: window.innerHeight,
      };
    });

    assert.equal(before.clonePathPlaceholder, expectedClonePath);
    assert.ok(before.screenScrollHeight > before.screenClientHeight, "setup screen should expose a scroll range");
    assert.equal(before.screenBottom, before.viewportHeight);
    assert.ok(before.buttonBottom > before.viewportHeight, "clone button should start below the short viewport");

    await page.locator(".brain-setup-clone-button").scrollIntoViewIfNeeded();

    const after = await page.evaluate(() => {
      const screen = document.querySelector(".brain-setup-screen");
      const cloneButton = document.querySelector(".brain-setup-clone-button");
      const buttonBounds = cloneButton.getBoundingClientRect();

      return {
        screenScrollTop: screen.scrollTop,
        buttonTop: buttonBounds.top,
        buttonBottom: buttonBounds.bottom,
        viewportHeight: window.innerHeight,
      };
    });

    assert.ok(after.screenScrollTop > 0, "setup screen did not scroll");
    assert.ok(after.buttonTop >= 0, "clone button scrolled above the viewport");
    assert.ok(after.buttonBottom <= after.viewportHeight, "clone button is still below the viewport");

    await page.waitForTimeout(3_500);

    const afterPoll = await page.evaluate(() => {
      const screen = document.querySelector(".brain-setup-screen");
      const cloneButton = document.querySelector(".brain-setup-clone-button");
      const buttonBounds = cloneButton.getBoundingClientRect();

      return {
        screenScrollTop: screen.scrollTop,
        buttonTop: buttonBounds.top,
        buttonBottom: buttonBounds.bottom,
        viewportHeight: window.innerHeight,
      };
    });

    assert.ok(afterPoll.screenScrollTop > 0, "session polling reset the setup scroll position");
    assert.ok(afterPoll.buttonTop >= 0, "clone button scrolled above the viewport after polling");
    assert.ok(afterPoll.buttonBottom <= afterPoll.viewportHeight, "clone button moved below the viewport after polling");
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("knowledge base markdown viewer renders GitHub-style tables", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the markdown table smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("remote-vibes-markdown-table-");
  const wikiDir = path.join(workspaceDir, ".remote-vibes", "wiki");
  await mkdir(wikiDir, { recursive: true });
  await writeFile(path.join(wikiDir, "index.md"), "# Wiki Index\n\nSee [[leaderboard]].\n", "utf8");
  await writeFile(
    path.join(wikiDir, "leaderboard.md"),
    [
      "# Experiment Scores",
      "",
      "LEADERBOARD",
      "| rank | result | branch | commit | score |",
      "|------|--------|--------|--------|------:|",
      "| 1 | **iql** | [branch](https://github.com/Clamepending/ogbench-cube/tree/r/iql) | `abc123` | 0.42 |",
      "| 2 | bc | main | `def456` | 0.31 |",
      "",
    ].join("\n"),
    "utf8",
  );

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let browser = null;

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wikiPath: wikiDir }),
    });
    assert.equal(settingsResponse.status, 200);

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/?view=knowledge-base&note=leaderboard.md`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".knowledge-base-table", { timeout: 10_000 });

    const rendered = await page.evaluate(() => {
      const table = document.querySelector(".knowledge-base-table");
      return {
        headers: Array.from(table.querySelectorAll("thead th"), (cell) => cell.textContent.trim()),
        rows: Array.from(table.querySelectorAll("tbody tr"), (row) =>
          Array.from(row.querySelectorAll("td"), (cell) => cell.textContent.trim()),
        ),
        linkHref: table.querySelector("tbody a")?.getAttribute("href") || "",
        codeText: table.querySelector("tbody code")?.textContent || "",
        paragraphText: document.querySelector(".knowledge-base-markdown")?.textContent || "",
      };
    });

    assert.deepEqual(rendered.headers, ["rank", "result", "branch", "commit", "score"]);
    assert.deepEqual(rendered.rows[0], ["1", "iql", "branch", "abc123", "0.42"]);
    assert.equal(rendered.linkHref, "https://github.com/Clamepending/ogbench-cube/tree/r/iql");
    assert.equal(rendered.codeText, "abc123");
    assert.doesNotMatch(rendered.paragraphText, /\|------\|/);
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("knowledge base markdown viewer renders image, GIF, and video media links", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the markdown media smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("remote-vibes-markdown-media-");
  const wikiDir = path.join(workspaceDir, ".remote-vibes", "wiki");
  const assetsDir = path.join(wikiDir, "assets");
  const absoluteAssetsDir = path.join(workspaceDir, "absolute-assets");
  const absoluteImagePath = path.join(absoluteAssetsDir, "held-out-grid.png");
  await mkdir(assetsDir, { recursive: true });
  await mkdir(absoluteAssetsDir, { recursive: true });
  await writeFile(path.join(assetsDir, "diagram.png"), PNG_FIXTURE);
  await writeFile(path.join(assetsDir, "flow.gif"), GIF_FIXTURE);
  await writeFile(path.join(assetsDir, "demo.mp4"), Buffer.from("not a real video, but enough for a DOM smoke\n"));
  await writeFile(absoluteImagePath, PNG_FIXTURE);
  await writeFile(path.join(wikiDir, "index.md"), "# Wiki Index\n\nSee [[media]].\n", "utf8");
  await writeFile(
    path.join(wikiDir, "media.md"),
    [
      "# Media",
      "",
      "![Diagram](assets/diagram.png)",
      "![Animated flow](assets/flow.gif)",
      `![Absolute held-out grid](${absoluteImagePath})`,
      "[Demo clip](assets/demo.mp4)",
      "[External still](https://example.com/still.webp)",
      "[Plain docs](https://example.com/docs)",
      "",
    ].join("\n"),
    "utf8",
  );

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let browser = null;

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wikiPath: wikiDir }),
    });
    assert.equal(settingsResponse.status, 200);

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/?view=knowledge-base&note=media.md`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".knowledge-base-inline-image", { timeout: 10_000 });
    await page.waitForSelector("video.knowledge-base-media-player", { timeout: 10_000 });

    const rendered = await page.evaluate(() => {
      const markdown = document.querySelector(".knowledge-base-markdown");
      const imageData = Array.from(markdown.querySelectorAll("img.knowledge-base-inline-image"), (image) => {
        const src = image.getAttribute("src") || "";
        const parsed = src.startsWith("http") ? new URL(src) : null;
        return {
          alt: image.getAttribute("alt") || "",
          path: parsed?.searchParams.get("path") || "",
          src,
          loading: image.getAttribute("loading") || "",
          decoding: image.getAttribute("decoding") || "",
        };
      });
      const video = markdown.querySelector("video.knowledge-base-media-player");
      const videoUrl = new URL(video?.getAttribute("src") || "", window.location.href);
      const plainDocsLink = Array.from(markdown.querySelectorAll("a.knowledge-base-external-link")).find(
        (link) => link.textContent?.trim() === "Plain docs",
      );

      return {
        images: imageData,
        videoPath: videoUrl.searchParams.get("path") || "",
        videoControls: Boolean(video?.hasAttribute("controls")),
        videoPreload: video?.getAttribute("preload") || "",
        captions: Array.from(markdown.querySelectorAll(".knowledge-base-media-caption"), (caption) =>
          caption.textContent.trim(),
        ),
        plainDocsHref: plainDocsLink?.getAttribute("href") || "",
      };
    });

    assert.deepEqual(
      rendered.images.map((image) => image.alt),
      ["Diagram", "Animated flow", "Absolute held-out grid", "External still"],
    );
    assert.deepEqual(
      rendered.images.slice(0, 3).map((image) => image.path),
      ["assets/diagram.png", "assets/flow.gif", "held-out-grid.png"],
    );
    assert.equal(new URL(rendered.images[2].src).searchParams.get("root"), absoluteAssetsDir);
    assert.equal(rendered.images[3].src, "https://example.com/still.webp");
    assert.deepEqual(
      rendered.images.map((image) => image.loading),
      ["eager", "eager", "eager", "lazy"],
    );
    assert.ok(rendered.images.every((image) => image.decoding === "async"));
    assert.equal(rendered.videoPath, "assets/demo.mp4");
    assert.equal(rendered.videoControls, true);
    assert.equal(rendered.videoPreload, "metadata");
    assert.deepEqual(rendered.captions, ["Demo clip", "External still"]);
    assert.equal(rendered.plainDocsHref, "https://example.com/docs");
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("settings api moves the wiki folder, refreshes agent instructions, and the knowledge base follows", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-custom-wiki-");
  const customWikiDir = path.join(workspaceDir, "mac-brain");
  await mkdir(path.join(customWikiDir, "topics"), { recursive: true });
  const canonicalCustomWikiDir = await realpath(customWikiDir);
  await writeFile(
    path.join(customWikiDir, "index.md"),
    "# Custom Wiki\n\nSee [[topics/one]].\n",
    "utf8",
  );
  await writeFile(path.join(customWikiDir, "topics", "one.md"), "# One\n\nhello\n", "utf8");
  await execFileAsync("git", ["-C", customWikiDir, "init", "-b", "main"]);
  await execFileAsync("git", [
    "-C",
    customWikiDir,
    "remote",
    "add",
    "origin",
    "git@github.com:example/private-mac-brain.git",
  ]);

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        preventSleepEnabled: false,
        wikiGitBackupEnabled: false,
        wikiPath: customWikiDir,
      }),
    });

    assert.equal(settingsResponse.status, 200);
    const settingsPayload = await settingsResponse.json();
    assert.equal(settingsPayload.settings.wikiPath, customWikiDir);
    assert.equal(settingsPayload.settings.wikiRelativeRoot, "mac-brain");
    assert.equal(settingsPayload.settings.preventSleepEnabled, false);
    assert.equal(settingsPayload.settings.sleepPrevention.lastStatus, "disabled");
    assert.equal(settingsPayload.settings.wikiGitBackupEnabled, false);
    assert.equal(
      settingsPayload.settings.wikiGitRemoteUrl,
      "git@github.com:example/private-mac-brain.git",
    );
    assert.equal(settingsPayload.agentPrompt.wikiRoot, "mac-brain");

    const managedAgents = await readFile(path.join(workspaceDir, "AGENTS.md"), "utf8");
    assert.match(managedAgents, /Use `mac-brain` as the workspace memory system/);
    assert.match(managedAgents, /`mac-brain\/raw\/sources\/`/);
    assert.doesNotMatch(managedAgents, /Agent Mailboxes/);

    const indexResponse = await fetch(`${baseUrl}/api/knowledge-base`);
    assert.equal(indexResponse.status, 200);
    const indexPayload = await indexResponse.json();
    assert.equal(indexPayload.rootPath, canonicalCustomWikiDir);
    assert.equal(indexPayload.relativeRoot, "mac-brain");
    assert.deepEqual(
      indexPayload.notes.map((note) => note.relativePath),
      ["index.md", "log.md", "topics/one.md"],
    );
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("{{WIKI}} placeholder stays in source but expands in managed files and tracks wiki path changes", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-wiki-placeholder-");
  const customWikiDir = path.join(workspaceDir, "mac-brain");
  await mkdir(customWikiDir, { recursive: true });

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const customPrompt =
      "# Custom Prompt\n\n" +
      "Notes live in `{{WIKI}}/experiments/`.\n" +
      "Log updates at `{{WIKI}}/log.md`.\n";

    const updateResponse = await fetch(`${baseUrl}/api/agent-prompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: customPrompt }),
    });
    assert.equal(updateResponse.status, 200);

    const defaultSource = await readFile(
      path.join(workspaceDir, ".remote-vibes", "agent-prompt.md"),
      "utf8",
    );
    assert.match(defaultSource, /`\{\{WIKI\}\}\/experiments\/`/);
    assert.match(defaultSource, /`\{\{WIKI\}\}\/log\.md`/);

    const defaultManaged = await readFile(path.join(workspaceDir, "CLAUDE.md"), "utf8");
    assert.ok(!defaultManaged.includes("{{WIKI}}"), "managed file should not contain raw placeholders");
    assert.match(defaultManaged, /`\.remote-vibes\/wiki\/experiments\/`/);
    assert.match(defaultManaged, /`\.remote-vibes\/wiki\/log\.md`/);

    const moveResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preventSleepEnabled: false,
        wikiGitBackupEnabled: false,
        wikiPath: customWikiDir,
      }),
    });
    assert.equal(moveResponse.status, 200);

    const movedSource = await readFile(
      path.join(workspaceDir, ".remote-vibes", "agent-prompt.md"),
      "utf8",
    );
    assert.match(movedSource, /`\{\{WIKI\}\}\/experiments\/`/);
    assert.match(movedSource, /`\{\{WIKI\}\}\/log\.md`/);

    const movedManaged = await readFile(path.join(workspaceDir, "CLAUDE.md"), "utf8");
    assert.ok(!movedManaged.includes("{{WIKI}}"), "managed file should not contain raw placeholders after wiki move");
    assert.match(movedManaged, /`mac-brain\/experiments\/`/);
    assert.match(movedManaged, /`mac-brain\/log\.md`/);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("wiki backup endpoint initializes git and commits wiki changes", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-wiki-backup-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  const wikiDir = path.join(workspaceDir, ".remote-vibes", "wiki");

  try {
    const firstBackupResponse = await fetch(`${baseUrl}/api/wiki/backup`, {
      method: "POST",
    });
    assert.equal(firstBackupResponse.status, 200);
    const firstBackupPayload = await firstBackupResponse.json();
    assert.equal(firstBackupPayload.backup.lastStatus, "committed");
    assert.match(firstBackupPayload.backup.lastCommit, /^[0-9a-f]+$/);

    await writeFile(path.join(wikiDir, "log.md"), "# Wiki Log\n\n- new note\n", "utf8");
    const secondBackupResponse = await fetch(`${baseUrl}/api/wiki/backup`, {
      method: "POST",
    });
    assert.equal(secondBackupResponse.status, 200);
    const secondBackupPayload = await secondBackupResponse.json();
    assert.equal(secondBackupPayload.backup.lastStatus, "committed");

    const { stdout } = await execFileAsync("git", ["-C", wikiDir, "log", "--oneline"]);
    assert.match(stdout, /Remote Vibes wiki backup/);
    assert.ok(stdout.trim().split("\n").length >= 2);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("wiki backup endpoint can push to a configured private remote", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-wiki-remote-backup-");
  const remoteDir = path.join(workspaceDir, "private-wiki.git");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  const wikiDir = path.join(workspaceDir, ".remote-vibes", "wiki");

  try {
    await execFileAsync("git", ["init", "--bare", remoteDir]);

    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        wikiGitRemoteBranch: "main",
        wikiGitRemoteEnabled: true,
        wikiGitRemoteUrl: remoteDir,
      }),
    });
    assert.equal(settingsResponse.status, 200);
    const settingsPayload = await settingsResponse.json();
    assert.equal(settingsPayload.settings.wikiGitRemoteEnabled, true);
    assert.equal(settingsPayload.settings.wikiGitRemoteUrl, remoteDir);

    await waitForWikiBackupRun(baseUrl);
    await writeFile(path.join(wikiDir, "private-note.md"), "# Private note\n", "utf8");
    const backupResponse = await fetch(`${baseUrl}/api/wiki/backup`, {
      method: "POST",
    });
    assert.equal(backupResponse.status, 200);
    const backupPayload = await backupResponse.json();
    assert.equal(backupPayload.backup.lastStatus, "committed");
    assert.equal(backupPayload.backup.lastPushStatus, "pushed");
    assert.equal(backupPayload.backup.remoteUrlConfigured, true);

    const { stdout } = await execFileAsync("git", [
      "--git-dir",
      remoteDir,
      "log",
      "--oneline",
      "refs/heads/main",
    ]);
    assert.match(stdout, /Remote Vibes wiki backup/);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("folder browser api lists selectable folders and supports parent navigation", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-folder-picker-");
  await mkdir(path.join(workspaceDir, "alpha", "nested"), { recursive: true });
  await writeFile(path.join(workspaceDir, "notes.txt"), "not a folder\n", "utf8");
  const canonicalWorkspaceDir = await realpath(workspaceDir);
  const canonicalAlphaDir = await realpath(path.join(workspaceDir, "alpha"));

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const rootResponse = await fetch(`${baseUrl}/api/folders?root=${encodeURIComponent(workspaceDir)}`);
    assert.equal(rootResponse.status, 200);
    const rootPayload = await rootResponse.json();

    assert.equal(rootPayload.currentPath, canonicalWorkspaceDir);
    assert.ok(rootPayload.parentPath);
    assert.ok(rootPayload.entries.some((entry) => entry.name === "alpha"));
    assert.ok(!rootPayload.entries.some((entry) => entry.name === "notes.txt"));

    const childResponse = await fetch(
      `${baseUrl}/api/folders?root=${encodeURIComponent(path.join(workspaceDir, "alpha"))}`,
    );
    assert.equal(childResponse.status, 200);
    const childPayload = await childResponse.json();
    assert.equal(childPayload.currentPath, canonicalAlphaDir);
    assert.equal(childPayload.parentPath, canonicalWorkspaceDir);
    assert.deepEqual(
      childPayload.entries.map((entry) => entry.name),
      ["nested"],
    );

    const createResponse = await fetch(`${baseUrl}/api/folders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        root: workspaceDir,
        name: "beta",
      }),
    });
    assert.equal(createResponse.status, 201);
    const createPayload = await createResponse.json();
    assert.equal(createPayload.folder.name, "beta");
    assert.equal(createPayload.folder.path, await realpath(path.join(workspaceDir, "beta")));

    const traversalResponse = await fetch(`${baseUrl}/api/folders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        root: workspaceDir,
        name: "../outside",
      }),
    });
    assert.equal(traversalResponse.status, 400);
    assert.match((await traversalResponse.json()).error, /single folder name/i);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("remote vibes api header keeps folder picker requests out of proxied apps", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-folder-picker-referrer-");
  const proxyTarget = http.createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "proxied app handled this request" }));
  });
  proxyTarget.listen(0, "127.0.0.1");
  await once(proxyTarget, "listening");
  const proxyAddress = proxyTarget.address();
  const proxyPort = typeof proxyAddress === "object" && proxyAddress ? proxyAddress.port : 0;
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  const proxiedReferrer = `${baseUrl}/proxy/${proxyPort}/`;

  try {
    const accidentalProxyResponse = await fetch(
      `${baseUrl}/api/folders?root=${encodeURIComponent(workspaceDir)}`,
      {
        headers: {
          referer: proxiedReferrer,
        },
      },
    );
    assert.equal(accidentalProxyResponse.status, 404);
    assert.equal((await accidentalProxyResponse.json()).error, "proxied app handled this request");

    const listResponse = await fetch(`${baseUrl}/api/folders?root=${encodeURIComponent(workspaceDir)}`, {
      headers: {
        referer: proxiedReferrer,
        "X-Remote-Vibes-API": "1",
      },
    });
    assert.equal(listResponse.status, 200);
    assert.equal((await listResponse.json()).currentPath, await realpath(workspaceDir));

    const createResponse = await fetch(`${baseUrl}/api/folders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        referer: proxiedReferrer,
        "X-Remote-Vibes-API": "1",
      },
      body: JSON.stringify({
        root: workspaceDir,
        name: "created-from-session-picker",
      }),
    });
    assert.equal(createResponse.status, 201);
    assert.equal(
      (await createResponse.json()).folder.path,
      await realpath(path.join(workspaceDir, "created-from-session-picker")),
    );
  } finally {
    await app.close();
    await new Promise((resolve) => proxyTarget.close(resolve));
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("shell session streams websocket output and honors custom cwd", async () => {
  const { app, baseUrl } = await startApp();

  try {
    const requestedCwd = path.join(os.tmpdir());
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Integration Shell",
        cwd: requestedCwd,
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();
    assert.equal(session.cwd, requestedCwd);

    const websocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?sessionId=${session.id}`);
    const marker = "REMOTE_VIBES_AUTOMATED_SMOKE";
    const output = await new Promise((resolve, reject) => {
      let combined = "";
      let sentResize = false;
      let sentMarker = false;
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for terminal output."));
      }, 8_000);

      websocket.on("open", () => {
        websocket.send(
          JSON.stringify({
            type: "resize",
            cols: 100,
            rows: 30,
          }),
        );
        sentResize = true;
      });

      websocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));
        const data = payload.data || "";
        combined += data;

        if (!sentResize) {
          websocket.send(
            JSON.stringify({
              type: "resize",
              cols: 100,
              rows: 30,
            }),
          );
          sentResize = true;
        }

        if (!sentMarker) {
          websocket.send(
            JSON.stringify({
              type: "input",
              data: `printf "${marker}\\n"\r`,
            }),
          );
          sentMarker = true;
        }

        if (combined.includes(marker)) {
          clearTimeout(timeout);
          resolve(combined);
        }
      });
    });

    assert.match(output, new RegExp(marker));
    assert.doesNotMatch(output, /cannot change locale/i);

    websocket.close();
    await once(websocket, "close");

    const deleteResponse = await fetch(`${baseUrl}/api/sessions/${session.id}`, {
      method: "DELETE",
    });

    assert.equal(deleteResponse.status, 200);
  } finally {
    await app.close();
  }
});

test("shell session keeps running while the browser websocket disconnects", async () => {
  const { app, baseUrl } = await startApp();
  let session = null;
  let firstSocket = null;
  let secondSocket = null;

  try {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Disconnect Smoke",
        cwd: process.cwd(),
      }),
    });

    assert.equal(createResponse.status, 201);
    ({ session } = await createResponse.json());

    const websocketUrl = `${baseUrl.replace("http", "ws")}/ws?sessionId=${session.id}`;
    const command =
      "for i in 1 2 3 4 5; do printf 'RV_WS_KEEPALIVE_%s\\n' \"$i\"; sleep 0.2; done\r";

    firstSocket = new WebSocket(websocketUrl);
    await new Promise((resolve, reject) => {
      let combined = "";
      let sentCommand = false;
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for first websocket output."));
      }, 8_000);

      firstSocket.on("open", () => {
        firstSocket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
      });

      firstSocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));
        combined += payload.data || "";

        if (!sentCommand) {
          firstSocket.send(JSON.stringify({ type: "input", data: command }));
          sentCommand = true;
        }

        if (combined.includes("RV_WS_KEEPALIVE_1")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    firstSocket.close();
    await once(firstSocket, "close");
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    secondSocket = new WebSocket(websocketUrl);
    const reattachedOutput = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for reattached websocket output."));
      }, 8_000);

      secondSocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));
        const data = payload.data || "";

        if (payload.type === "snapshot" && data.includes("RV_WS_KEEPALIVE_5")) {
          clearTimeout(timeout);
          resolve(data);
        }
      });
    });

    assert.match(reattachedOutput, /RV_WS_KEEPALIVE_5/);
  } finally {
    if (firstSocket && firstSocket.readyState < WebSocket.CLOSING) {
      firstSocket.close();
    }
    if (secondSocket && secondSocket.readyState < WebSocket.CLOSING) {
      secondSocket.close();
      await once(secondSocket, "close");
    }
    if (session?.id) {
      await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: "DELETE" });
    }
    await app.close();
  }
});

test("mobile terminal stays usable while the keyboard viewport resizes", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the mobile terminal smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("remote-vibes-mobile-scroll-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let websocket = null;
  let browser = null;

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wikiPath: path.join(workspaceDir, "brain") }),
    });
    assert.equal(settingsResponse.status, 200);

    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Mobile Scroll Smoke",
        cwd: workspaceDir,
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();
    const websocketUrl = `${baseUrl.replace("http", "ws")}/ws?sessionId=${session.id}`;
    const command =
      "i=1; while [ \"$i\" -le 180 ]; do printf 'RV_MOBILE_SCROLL_%03d\\n' \"$i\"; i=$((i+1)); done\r";

    websocket = new WebSocket(websocketUrl);
    await new Promise((resolve, reject) => {
      let combined = "";
      let sentCommand = false;
      const timeout = setTimeout(() => {
        reject(new Error("Timed out writing terminal history for the mobile scroll smoke."));
      }, 10_000);

      websocket.on("open", () => {
        websocket.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
      });

      websocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));
        combined += payload.data || "";

        if (!sentCommand) {
          websocket.send(JSON.stringify({ type: "input", data: command }));
          sentCommand = true;
        }

        if (combined.includes("RV_MOBILE_SCROLL_180")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 760 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#terminal-mount .xterm-viewport", { timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelector("#terminal-mount .xterm")?.textContent?.includes("RV_MOBILE_SCROLL_180"),
      null,
      { timeout: 10_000 },
    );

    const initial = await page.evaluate(() => {
      const viewport = document.querySelector("#terminal-mount .xterm-viewport");
      const textarea = document.querySelector("#terminal-mount .xterm-helper-textarea");

      viewport.scrollTop = Math.round(viewport.scrollHeight * 0.42);
      viewport.dispatchEvent(new Event("scroll"));
      textarea?.focus();

      return {
        activeIsTextarea: document.activeElement === textarea,
      };
    });

    assert.equal(initial.activeIsTextarea, true);

    await page.setViewportSize({ width: 390, height: 430 });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 390, height: 760 });
    await page.waitForTimeout(500);

    const expanded = await page.evaluate(() => {
      const viewport = document.querySelector("#terminal-mount .xterm-viewport");
      const textarea = document.querySelector("#terminal-mount .xterm-helper-textarea");

      return {
        activeIsTextarea: document.activeElement === textarea,
        terminalMounted: Boolean(document.querySelector("#terminal-mount .xterm")),
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
      };
    });

    assert.equal(expanded.terminalMounted, true);
    assert.ok(expanded.scrollHeight > expanded.clientHeight);
    assert.equal(expanded.activeIsTextarea, false);
  } finally {
    if (websocket && websocket.readyState < WebSocket.CLOSING) {
      websocket.close();
    }
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("terminal wheel opens a scrollable transcript history", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the terminal wheel smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("remote-vibes-xterm-wheel-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let websocket = null;
  let browser = null;

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wikiPath: path.join(workspaceDir, "brain") }),
    });
    assert.equal(settingsResponse.status, 200);

    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Xterm Wheel Smoke",
        cwd: workspaceDir,
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();
    websocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?sessionId=${session.id}`);

    await new Promise((resolve, reject) => {
      let combined = "";
      let sentCommand = false;
      const timeout = setTimeout(() => {
        reject(new Error("Timed out writing terminal history for the xterm wheel smoke."));
      }, 10_000);

      websocket.on("open", () => {
        websocket.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
      });

      websocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));
        combined += payload.data || "";

        if (!sentCommand) {
          websocket.send(
            JSON.stringify({
              type: "input",
              data: "i=1; while [ \"$i\" -le 180 ]; do printf 'RV_XTERM_SCROLL_%03d\\n' \"$i\"; i=$((i+1)); done\r",
            }),
          );
          sentCommand = true;
        }

        if (combined.includes("RV_XTERM_SCROLL_180")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#terminal-mount .xterm-viewport", { timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelector("#terminal-mount .xterm")?.textContent?.includes("RV_XTERM_SCROLL_180"),
      null,
      { timeout: 10_000 },
    );

    const wheelStart = await page.evaluate(() => {
      const terminal = document.querySelector("#terminal-mount .xterm");
      const viewport = document.querySelector("#terminal-mount .xterm-viewport");
      const bounds = terminal.getBoundingClientRect();
      viewport.scrollTop = viewport.scrollHeight;
      return {
        before: viewport.scrollTop,
        x: bounds.left + 32,
        y: bounds.top + 32,
      };
    });

    await page.mouse.move(wheelStart.x, wheelStart.y);
    await page.mouse.wheel(0, -360);
    await page.waitForTimeout(100);

    const wheelAfter = await page.evaluate(() => {
      const nativeViewport = document.querySelector("#terminal-mount .xterm-viewport");
      const transcriptViewport = document.querySelector("#terminal-transcript-scroll");
      const transcript = document.querySelector("#terminal-transcript-pre");
      return {
        nativeMaxScrollTop: Math.max(0, nativeViewport.scrollHeight - nativeViewport.clientHeight),
        nativeScrollTop: nativeViewport.scrollTop,
        transcriptMaxScrollTop: Math.max(0, transcriptViewport.scrollHeight - transcriptViewport.clientHeight),
        transcriptScrollTop: transcriptViewport.scrollTop,
        transcriptText: transcript?.textContent || "",
        terminalText: document.querySelector("#terminal-mount .xterm")?.textContent || "",
        transcriptVisible: document.querySelector(".terminal-stack")?.classList.contains("is-transcript-scroll"),
      };
    });

    assert.ok(
      wheelAfter.transcriptVisible || wheelAfter.nativeMaxScrollTop > 0,
      "terminal did not expose scrollable history",
    );
    if (wheelAfter.transcriptVisible) {
      assert.ok(wheelAfter.transcriptMaxScrollTop > 0, "transcript did not expose scrollable history");
      assert.ok(
        wheelAfter.transcriptScrollTop < wheelAfter.transcriptMaxScrollTop,
        "wheel did not move the transcript away from bottom",
      );
      assert.match(wheelAfter.transcriptText, /RV_XTERM_SCROLL_/);
    } else {
      assert.ok(
        wheelAfter.nativeScrollTop < wheelAfter.nativeMaxScrollTop,
        "wheel did not move native xterm history away from bottom",
      );
      assert.match(wheelAfter.terminalText, /RV_XTERM_SCROLL_/);
    }
  } finally {
    if (websocket && websocket.readyState < WebSocket.CLOSING) {
      websocket.close();
    }
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("terminal keyboard scroll chords move history without stealing plain arrows", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the terminal keyboard scroll smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("remote-vibes-keyboard-scroll-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let websocket = null;
  let browser = null;
  let websocketOutput = "";

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wikiPath: path.join(workspaceDir, "brain") }),
    });
    assert.equal(settingsResponse.status, 200);

    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Keyboard Scroll Smoke",
        cwd: workspaceDir,
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();
    websocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?sessionId=${session.id}`);

    await new Promise((resolve, reject) => {
      let sentCommand = false;
      const timeout = setTimeout(() => {
        reject(new Error("Timed out preparing terminal keyboard scroll history."));
      }, 10_000);

      websocket.on("open", () => {
        websocket.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
      });

      websocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));
        websocketOutput += payload.data || "";

        if (!sentCommand) {
          websocket.send(
            JSON.stringify({
              type: "input",
              data: "i=1; while [ \"$i\" -le 120 ]; do printf 'RV_KEY_SCROLL_LINE_%03d\\n' \"$i\"; i=$((i+1)); done; cat -v\r",
            }),
          );
          sentCommand = true;
        }

        if (websocketOutput.includes("RV_KEY_SCROLL_LINE_120") && websocketOutput.includes("cat -v")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#terminal-mount .xterm-viewport", { timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelector("#terminal-mount .xterm")?.textContent?.includes("RV_KEY_SCROLL_LINE_120"),
      null,
      { timeout: 10_000 },
    );

    const focused = await page.evaluate(() => {
      const viewport = document.querySelector("#terminal-mount .xterm-viewport");
      const textarea = document.querySelector("#terminal-mount .xterm-helper-textarea");
      viewport.scrollTop = viewport.scrollHeight;
      textarea?.focus();
      return document.activeElement === textarea;
    });
    assert.equal(focused, true);

    await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.up("Shift");
    await page.waitForTimeout(100);

    const afterShiftArrow = await page.evaluate(() => {
      const nativeViewport = document.querySelector("#terminal-mount .xterm-viewport");
      const transcriptViewport = document.querySelector("#terminal-transcript-scroll");
      return {
        nativeMaxScrollTop: Math.max(0, nativeViewport.scrollHeight - nativeViewport.clientHeight),
        nativeScrollTop: nativeViewport.scrollTop,
        transcriptMaxScrollTop: Math.max(0, transcriptViewport.scrollHeight - transcriptViewport.clientHeight),
        transcriptScrollTop: transcriptViewport.scrollTop,
        transcriptVisible: document.querySelector(".terminal-stack")?.classList.contains("is-transcript-scroll"),
      };
    });

    assert.ok(
      afterShiftArrow.transcriptVisible
        ? afterShiftArrow.transcriptScrollTop < afterShiftArrow.transcriptMaxScrollTop
        : afterShiftArrow.nativeScrollTop < afterShiftArrow.nativeMaxScrollTop,
      "Shift+ArrowUp did not scroll terminal history",
    );
    assert.doesNotMatch(websocketOutput, /\^\[(?:\[|O)1;2A/);

    await page.keyboard.press("ArrowUp");
    await waitForValue(() => /\^\[(?:\[|O)A/.test(websocketOutput), true);
  } finally {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: "input", data: "\u0003" }));
    }
    if (websocket && websocket.readyState < WebSocket.CLOSING) {
      websocket.close();
    }
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("terminal wheel without xterm scrollback opens transcript instead of sending arrows", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the terminal wheel fallback smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("remote-vibes-transcript-wheel-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });
  let websocket = null;
  let browser = null;

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wikiPath: path.join(workspaceDir, "brain") }),
    });
    assert.equal(settingsResponse.status, 200);

    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Transcript Wheel Smoke",
        cwd: workspaceDir,
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();
    websocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?sessionId=${session.id}`);

    await new Promise((resolve, reject) => {
      let combined = "";
      let sentCommand = false;
      const timeout = setTimeout(() => {
        reject(new Error("Timed out starting cat for the terminal transcript wheel smoke."));
      }, 10_000);

      websocket.on("open", () => {
        websocket.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
      });

      websocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));
        combined += payload.data || "";

        if (!sentCommand) {
          websocket.send(
            JSON.stringify({
              type: "input",
              data: "printf '\\033[31mRV_TRANSCRIPT_RED\\033[0m\\n'; i=1; while [ \"$i\" -le 90 ]; do printf 'RV_TRANSCRIPT_LINE_%03d\\n' \"$i\"; i=$((i+1)); done; cat -v\r",
            }),
          );
          sentCommand = true;
        }

        if (combined.includes("RV_TRANSCRIPT_LINE_090") && combined.includes("cat -v")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#terminal-mount .xterm-viewport", { timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelector("#terminal-mount .xterm")?.textContent?.includes("RV_TRANSCRIPT_LINE_090"),
      null,
      { timeout: 10_000 },
    );

    const wheelTarget = await page.evaluate(() => {
      const terminal = document.querySelector("#terminal-mount .xterm");
      const bounds = terminal.getBoundingClientRect();
      return {
        x: bounds.left + 32,
        y: bounds.top + 32,
      };
    });

    await page.mouse.move(wheelTarget.x, wheelTarget.y);
    await page.mouse.wheel(0, -360);
    await page.waitForTimeout(200);
    const result = await page.evaluate(() => {
      const nativeViewport = document.querySelector("#terminal-mount .xterm-viewport");
      const transcriptViewport = document.querySelector("#terminal-transcript-scroll");
      const transcript = document.querySelector("#terminal-transcript-pre");
      return {
        nativeMaxScrollTop: Math.max(0, nativeViewport.scrollHeight - nativeViewport.clientHeight),
        nativeScrollTop: nativeViewport.scrollTop,
        transcriptMaxScrollTop: Math.max(0, transcriptViewport.scrollHeight - transcriptViewport.clientHeight),
        transcriptScrollTop: transcriptViewport.scrollTop,
        transcriptHtml: transcript?.innerHTML || "",
        transcriptVisible: document.querySelector(".terminal-stack")?.classList.contains("is-transcript-scroll"),
        terminalText: document.querySelector("#terminal-mount .xterm")?.textContent || "",
        transcriptText: transcript?.textContent || "",
      };
    });

    assert.ok(
      result.transcriptVisible || result.nativeMaxScrollTop > 0,
      "terminal did not expose scrollable fallback history",
    );
    if (result.transcriptVisible) {
      assert.ok(result.transcriptMaxScrollTop > 0, "transcript did not expose scrollable fallback history");
      assert.ok(
        result.transcriptScrollTop < result.transcriptMaxScrollTop,
        "wheel did not move the fallback transcript away from bottom",
      );
      assert.match(result.transcriptText, /RV_TRANSCRIPT_(?:RED|LINE_)/);
      assert.match(result.transcriptHtml, /fg-red/);
    } else {
      assert.ok(
        result.nativeScrollTop < result.nativeMaxScrollTop,
        "wheel did not move native xterm fallback history away from bottom",
      );
      assert.match(result.terminalText, /RV_TRANSCRIPT_(?:RED|LINE_)/);
    }
    assert.doesNotMatch(`${result.terminalText}\n${result.transcriptText}`, /\^\[(?:\[|O)?[AB]/);
  } finally {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: "input", data: "\u0003" }));
    }
    if (websocket && websocket.readyState < WebSocket.CLOSING) {
      websocket.close();
    }
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("login shells inherit mailbox helpers and agent inbox env vars", async () => {
  const sessionId = "mailbox-helper-session";
  const env = buildSessionEnv(sessionId, "shell", process.cwd());
  const { stdout } = await execFileAsync(
    process.env.SHELL || "/bin/zsh",
    [
      "-i",
      "-l",
      "-c",
      "printf 'INBOX=%s\\n' \"$REMOTE_VIBES_AGENT_INBOX\"; printf 'WATCHER=%s\\n' \"$REMOTE_VIBES_MAIL_WATCHER\"; printf 'PWCLI=%s\\n' \"$PWCLI\"; printf 'PWSKILL=%s\\n' \"$REMOTE_VIBES_PLAYWRIGHT_SKILL\"; command -v rv-mailwatch; command -v rv-session-name; command -v rv-playwright; command -v playwright-cli",
    ],
    { env },
  );

  assert.match(stdout, new RegExp(`INBOX=.*${sessionId}.*/inbox`));
  assert.match(stdout, /WATCHER=rv-mailwatch/);
  assert.match(stdout, /PWCLI=rv-playwright/);
  assert.match(stdout, /PWSKILL=.*skills\/playwright\/SKILL\.md/);
  assert.match(stdout, /rv-mailwatch/);
  assert.match(stdout, /rv-session-name/);
  assert.match(stdout, /rv-playwright/);
  assert.match(stdout, /playwright-cli/);
});

test("session names can be updated after creation", async () => {
  const { app, baseUrl } = await startApp();

  try {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Original Name",
        cwd: process.cwd(),
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();

    const renameResponse = await fetch(`${baseUrl}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Renamed Session",
      }),
    });

    assert.equal(renameResponse.status, 200);
    const renamePayload = await renameResponse.json();
    assert.equal(renamePayload.session.name, "Renamed Session");

    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.equal(
      sessionsPayload.sessions.find((entry) => entry.id === session.id)?.name,
      "Renamed Session",
    );
  } finally {
    await app.close();
  }
});

test("rv-session-name renames the current session through server metadata", async () => {
  const workspaceDir = process.cwd();
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();
    const env = buildSessionEnv(session.id, "shell", workspaceDir);

    const helperPath = path.join(workspaceDir, "bin", "rv-session-name");
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "results reviewer"], {
      cwd: workspaceDir,
      env,
    });

    assert.equal(stdout.trim(), "results reviewer");

    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.equal(
      sessionsPayload.sessions.find((entry) => entry.id === session.id)?.name,
      "results reviewer",
    );
  } finally {
    await app.close();
  }
});

test("rv-session-name falls back to a filesystem request when localhost is unreachable", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-session-rename-fallback-");
  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();
    const env = buildSessionEnv(session.id, "shell", workspaceDir);

    await writeFile(
      path.join(workspaceDir, ".remote-vibes", "server.json"),
      `${JSON.stringify({ helperBaseUrl: "http://127.0.0.1:9" }, null, 2)}\n`,
      "utf8",
    );

    const helperPath = path.join(process.cwd(), "bin", "rv-session-name");
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "resource coordinator"], {
      cwd: workspaceDir,
      env,
    });

    assert.equal(stdout.trim(), "resource coordinator");

    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.equal(
      sessionsPayload.sessions.find((entry) => entry.id === session.id)?.name,
      "resource coordinator",
    );
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("sessions can be forked and report whether provider memory is resumable", async () => {
  const { app, baseUrl } = await startApp();

  try {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Parent Session",
        cwd: process.cwd(),
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();

    const firstForkResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/fork`, {
      method: "POST",
    });
    assert.equal(firstForkResponse.status, 201);
    const firstForkPayload = await firstForkResponse.json();

    assert.notEqual(firstForkPayload.session.id, session.id);
    assert.equal(firstForkPayload.session.providerId, session.providerId);
    assert.equal(firstForkPayload.session.cwd, session.cwd);
    assert.equal(firstForkPayload.session.name, "Parent Session fork");

    const secondForkResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/fork`, {
      method: "POST",
    });
    assert.equal(secondForkResponse.status, 201);
    const secondForkPayload = await secondForkResponse.json();
    assert.equal(secondForkPayload.session.name, "Parent Session fork 2");

    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.equal(sessionsPayload.sessions.length, 3);

    const websocket = new WebSocket(
      `${baseUrl.replace("http", "ws")}/ws?sessionId=${firstForkPayload.session.id}`,
    );
    const snapshot = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for forked session snapshot."));
      }, 8_000);

      websocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));

        if (payload.type === "snapshot") {
          clearTimeout(timeout);
          resolve(payload);
        }
      });
    });

    assert.match(snapshot.data, /forked from: Parent Session/);
    assert.match(snapshot.data, /no provider memory id was available to resume/i);

    websocket.close();
    await once(websocket, "close");
  } finally {
    await app.close();
  }
});

test("forked Claude sessions resume source memory with a secret-word flow", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-claude-fork-memory-");
  const fakeBinDir = path.join(workspaceDir, "fake-bin");
  const memoryDir = path.join(workspaceDir, "fake-claude-memory");
  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });

  const fakeClaudePath = path.join(fakeBinDir, "claude");
  await writeFile(
    fakeClaudePath,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'Claude Code v0.0.0-test\\n'
  exit 0
fi
session_id=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--session-id" ] || [ "$previous" = "--resume" ]; then
    session_id="$arg"
  fi
  previous="$arg"
done
if [ -z "$session_id" ]; then
  session_id="default"
fi
memory_file="$FAKE_CLAUDE_MEMORY_DIR/$session_id.txt"
printf '[fake-claude] session %s ready\\n' "$session_id"
while IFS= read -r line; do
  clean="$(printf '%s' "$line" | tr -d '\\r')"
  case "$clean" in
    *"remember our secret word is "*)
      secret="\${clean##*remember our secret word is }"
      printf '%s\\n' "$secret" > "$memory_file"
      printf 'remembered %s\\n' "$secret"
      ;;
    *"what was the secret word"*)
      if [ -f "$memory_file" ]; then
        printf 'secret word: %s\\n' "$(cat "$memory_file")"
      else
        printf 'secret word: unknown\\n'
      fi
      ;;
    *)
      printf 'heard: %s\\n' "$clean"
      ;;
  esac
done
`,
    "utf8",
  );
  await chmod(fakeClaudePath, 0o755);

  const previousMemoryDir = process.env.FAKE_CLAUDE_MEMORY_DIR;
  process.env.FAKE_CLAUDE_MEMORY_DIR = memoryDir;

  const { app, baseUrl } = await startApp({
    cwd: workspaceDir,
    stateDir: path.join(workspaceDir, ".remote-vibes"),
    providers: [
      {
        id: "claude",
        label: "Claude Code",
        command: "claude",
        defaultName: "Claude",
        available: true,
        launchCommand: fakeClaudePath,
      },
      {
        id: "shell",
        label: "Vanilla Shell",
        command: null,
        defaultName: "Shell",
        available: true,
        launchCommand: null,
      },
    ],
  });

  const waitForSessionOutput = async (sessionId, trigger, matcher) => {
    const websocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?sessionId=${sessionId}`);

    try {
      return await new Promise((resolve, reject) => {
        let combined = "";
        let triggered = false;
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for session output: ${matcher}\n${combined}`));
        }, 8_000);

        websocket.on("message", (chunk) => {
          const payload = JSON.parse(String(chunk));
          combined += payload.data || "";

          if (!triggered && combined.includes("[fake-claude] session")) {
            triggered = true;
            websocket.send(JSON.stringify({ type: "input", data: trigger }));
          }

          if (matcher.test(combined)) {
            clearTimeout(timeout);
            resolve(combined);
          }
        });
      });
    } finally {
      websocket.close();
      await once(websocket, "close").catch(() => {});
    }
  };

  try {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "claude",
        name: "Secret Parent",
        cwd: workspaceDir,
      }),
    });
    assert.equal(createResponse.status, 201);
    const { session: parentSession } = await createResponse.json();

    await waitForSessionOutput(
      parentSession.id,
      "remember our secret word is amethyst\r",
      /remembered amethyst/,
    );

    const forkResponse = await fetch(`${baseUrl}/api/sessions/${parentSession.id}/fork`, {
      method: "POST",
    });
    assert.equal(forkResponse.status, 201);
    const { session: forkSession } = await forkResponse.json();

    const forkOutput = await waitForSessionOutput(
      forkSession.id,
      "what was the secret word?\r",
      /secret word: amethyst/,
    );
    assert.match(forkOutput, /resuming the source agent memory/i);
  } finally {
    await app.close();
    if (previousMemoryDir === undefined) {
      delete process.env.FAKE_CLAUDE_MEMORY_DIR;
    } else {
      process.env.FAKE_CLAUDE_MEMORY_DIR = previousMemoryDir;
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("ports are discoverable and proxy through localhost", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-ports-");
  const previewServer = http.createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body>preview</body></html>');
      return;
    }

    if (request.url === "/style.css") {
      response.writeHead(200, { "Content-Type": "text/css" });
      response.end("body{background:rgb(1,2,3)}");
      return;
    }

    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(`preview:${request.url}`);
  });
  const forbiddenServer = http.createServer((_request, response) => {
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.end("forbidden");
  });

  await new Promise((resolve) => previewServer.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => forbiddenServer.listen(0, "127.0.0.1", resolve));
  const previewPort = previewServer.address().port;
  const forbiddenPort = forbiddenServer.address().port;

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const ports = await waitForPort(baseUrl, previewPort);
    assert.ok(ports.some((entry) => entry.port === previewPort));
    assert.ok(!ports.some((entry) => entry.port === forbiddenPort));

    const rootResponse = await fetch(`${baseUrl}/proxy/${previewPort}/`);
    assert.equal(rootResponse.status, 200);
    assert.match(await rootResponse.text(), /href="\/style\.css"/);

    const stylesheetResponse = await fetch(`${baseUrl}/style.css`, {
      headers: {
        Referer: `${baseUrl}/proxy/${previewPort}/`,
      },
    });
    assert.equal(stylesheetResponse.status, 200);
    assert.equal(await stylesheetResponse.text(), "body{background:rgb(1,2,3)}");

    const proxyResponse = await fetch(`${baseUrl}/proxy/${previewPort}/hello`);
    assert.equal(proxyResponse.status, 200);
    assert.equal(await proxyResponse.text(), "preview:/hello");

    const renameResponse = await fetch(`${baseUrl}/api/ports/${previewPort}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "storybook" }),
    });
    assert.equal(renameResponse.status, 200);
    const renamePayload = await renameResponse.json();
    assert.equal(renamePayload.port.name, "storybook");
    assert.equal(renamePayload.port.customName, true);

    const renamedPortsResponse = await fetch(`${baseUrl}/api/ports`);
    assert.equal(renamedPortsResponse.status, 200);
    const renamedPortsPayload = await renamedPortsResponse.json();
    assert.equal(
      renamedPortsPayload.ports.find((entry) => entry.port === previewPort)?.name,
      "storybook",
    );

    const resetResponse = await fetch(`${baseUrl}/api/ports/${previewPort}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "  " }),
    });
    assert.equal(resetResponse.status, 200);
    const resetPayload = await resetResponse.json();
    assert.equal(resetPayload.port.name, String(previewPort));
    assert.equal(resetPayload.port.customName, false);
  } finally {
    await app.close();
    await new Promise((resolve) => previewServer.close(resolve));
    await new Promise((resolve) => forbiddenServer.close(resolve));
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("ports prefer direct tailnet URLs and can expose localhost-only ports with Tailscale Serve", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-tailscale-ports-");
  const exposedPorts = new Set();
  const fakeTailscaleServeManager = {
    async getStatus() {
      return {
        available: true,
        config: {
          TCP: Object.fromEntries(
            Array.from(exposedPorts).map((port) => [
              String(port),
              { target: `tcp://localhost:${port}` },
            ]),
          ),
        },
        enabled: exposedPorts.size > 0,
      };
    },
    async getPortStatus(port) {
      return {
        available: true,
        config: null,
        enabled: exposedPorts.has(Number(port)),
        port: Number(port),
      };
    },
    async exposePort(port) {
      exposedPorts.add(Number(port));
      return {
        available: true,
        enabled: true,
        port: Number(port),
      };
    },
  };
  const listPorts = async () => [
    {
      command: "vite",
      hosts: ["0.0.0.0"],
      pid: 111,
      port: 3100,
      previewStatusCode: 200,
      proxyPath: "/proxy/3100/",
    },
    {
      command: "gradio",
      hosts: ["127.0.0.1"],
      pid: 222,
      port: 3200,
      previewStatusCode: 200,
      proxyPath: "/proxy/3200/",
    },
  ];
  const accessUrlsProvider = async (_host, remoteVibesPort) => [
    { label: "Local", url: `http://localhost:${remoteVibesPort}` },
    { label: "Tailscale", url: `http://100.64.0.5:${remoteVibesPort}` },
  ];

  const { app, baseUrl } = await startApp({
    accessUrlsProvider,
    cwd: workspaceDir,
    listPorts,
    tailscaleServeManager: fakeTailscaleServeManager,
  });

  try {
    const portsResponse = await fetch(`${baseUrl}/api/ports`);
    assert.equal(portsResponse.status, 200);
    const portsPayload = await portsResponse.json();
    const directPort = portsPayload.ports.find((entry) => entry.port === 3100);
    const localhostPort = portsPayload.ports.find((entry) => entry.port === 3200);

    assert.equal(directPort.directUrl, "http://100.64.0.5:3100/");
    assert.equal(directPort.preferredAccess, "direct");
    assert.equal(directPort.preferredUrl, "http://100.64.0.5:3100/");
    assert.equal(directPort.canExposeWithTailscale, false);

    assert.equal(localhostPort.directUrl, null);
    assert.equal(localhostPort.localOnly, true);
    assert.equal(localhostPort.canExposeWithTailscale, true);
    assert.equal(localhostPort.preferredAccess, "proxy");
    assert.equal(localhostPort.tailscaleUrl, "http://100.64.0.5:3200/");

    const exposeResponse = await fetch(`${baseUrl}/api/ports/3200/tailscale`, {
      method: "POST",
    });
    assert.equal(exposeResponse.status, 200);
    const exposePayload = await exposeResponse.json();

    assert.equal(exposePayload.tailscale.enabled, true);
    assert.equal(exposePayload.port.exposedWithTailscale, true);
    assert.equal(exposePayload.port.preferredAccess, "tailscale-serve");
    assert.equal(exposePayload.port.preferredUrl, "http://100.64.0.5:3200/");
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("rejects an invalid working directory", async () => {
  const { app, baseUrl } = await startApp();

  try {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        cwd: "/definitely/not/a/real/path",
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.match(payload.error, /Working directory does not exist/);
  } finally {
    await app.close();
  }
});

test("terminate endpoint shuts down the app cleanly", async () => {
  let terminateCalls = 0;
  const { app, baseUrl } = await startApp({
    onTerminate: async () => {
      terminateCalls += 1;
    },
  });

  try {
    const response = await fetch(`${baseUrl}/api/terminate`, {
      method: "POST",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, shuttingDown: true });

    await waitForShutdown(baseUrl);
    await waitForValue(() => terminateCalls, 1);
  } finally {
    await app.close();
  }
});

test("relaunch endpoint shuts down the app cleanly and requests a restart", async () => {
  const terminateCalls = [];
  const { app, baseUrl } = await startApp({
    onTerminate: async (options = {}) => {
      terminateCalls.push(options);
    },
  });

  try {
    const response = await fetch(`${baseUrl}/api/relaunch`, {
      method: "POST",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, relaunching: true });

    await waitForShutdown(baseUrl);
    await waitForValue(() => terminateCalls.length, 1);
    assert.deepEqual(terminateCalls, [{ relaunch: true }]);
  } finally {
    await app.close();
  }
});

test("running sessions are restored with their transcript after restart", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-persist-");
  let firstApp = null;
  let secondApp = null;

  try {
    const firstRun = await startApp({
      cwd: workspaceDir,
      persistSessions: true,
    });
    firstApp = firstRun.app;

    const createResponse = await fetch(`${firstRun.baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Persistent Shell",
        cwd: workspaceDir,
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();
    const websocket = new WebSocket(`${firstRun.baseUrl.replace("http", "ws")}/ws?sessionId=${session.id}`);
    const marker = "REMOTE_VIBES_PERSISTENCE_MARKER";

    const output = await new Promise((resolve, reject) => {
      let combined = "";
      let sentResize = false;
      let sentMarker = false;
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for persisted session output."));
      }, 8_000);

      websocket.on("open", () => {
        websocket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
        sentResize = true;
      });

      websocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));
        const data = payload.data || "";
        combined += data;

        if (!sentResize) {
          websocket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
          sentResize = true;
        }

        if (!sentMarker) {
          websocket.send(
            JSON.stringify({
              type: "input",
              data: `printf "${marker}\\n"\r`,
            }),
          );
          sentMarker = true;
        }

        if (combined.includes(marker)) {
          clearTimeout(timeout);
          resolve(combined);
        }
      });
    });

    assert.match(output, new RegExp(marker));
    websocket.close();
    await once(websocket, "close");

    await firstApp.close();
    firstApp = null;

    const secondRun = await startApp({
      cwd: workspaceDir,
      persistSessions: true,
    });
    secondApp = secondRun.app;

    const sessionsResponse = await fetch(`${secondRun.baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.equal(sessionsPayload.sessions.length, 1);
    assert.equal(sessionsPayload.sessions[0].name, "Persistent Shell");
    assert.equal(sessionsPayload.sessions[0].cwd, workspaceDir);

    const restoredSocket = new WebSocket(
      `${secondRun.baseUrl.replace("http", "ws")}/ws?sessionId=${sessionsPayload.sessions[0].id}`,
    );
    const snapshot = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for restored session snapshot."));
      }, 8_000);

      restoredSocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));

        if (payload.type === "snapshot") {
          clearTimeout(timeout);
          resolve(payload);
        }
      });
    });

    assert.match(snapshot.data, new RegExp(marker));
    restoredSocket.close();
    await once(restoredSocket, "close");
  } finally {
    if (firstApp) {
      await firstApp.close();
    }

    if (secondApp) {
      await secondApp.close();
    }

    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("renamed sessions keep their updated name after restart", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-rename-persist-");
  let firstApp = null;
  let secondApp = null;

  try {
    const firstRun = await startApp({
      cwd: workspaceDir,
      persistSessions: true,
    });
    firstApp = firstRun.app;

    const createResponse = await fetch(`${firstRun.baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Before Rename",
        cwd: workspaceDir,
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();

    const renameResponse = await fetch(`${firstRun.baseUrl}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "After Rename",
      }),
    });

    assert.equal(renameResponse.status, 200);
    assert.equal((await renameResponse.json()).session.name, "After Rename");

    await firstApp.close();
    firstApp = null;

    const secondRun = await startApp({
      cwd: workspaceDir,
      persistSessions: true,
    });
    secondApp = secondRun.app;

    const sessionsResponse = await fetch(`${secondRun.baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.equal(sessionsPayload.sessions.length, 1);
    assert.equal(sessionsPayload.sessions[0].id, session.id);
    assert.equal(sessionsPayload.sessions[0].name, "After Rename");
  } finally {
    if (firstApp) {
      await firstApp.close();
    }

    if (secondApp) {
      await secondApp.close();
    }

    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("workspace file api lists directories, edits text files, and serves image files", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-files-");
  const graphsDir = path.join(workspaceDir, "graphs");
  const internalStateDir = path.join(workspaceDir, ".remote-vibes");
  const imagePath = path.join(graphsDir, "chart.png");
  const notePath = path.join(workspaceDir, "notes.txt");
  const internalStatePath = path.join(internalStateDir, "sessions.json");

  await mkdir(graphsDir, { recursive: true });
  await mkdir(internalStateDir, { recursive: true });
  await writeFile(imagePath, PNG_FIXTURE);
  await writeFile(notePath, "analysis notes\n", "utf8");
  await writeFile(internalStatePath, "{}\n", "utf8");

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const rootResponse = await fetch(`${baseUrl}/api/files?root=${encodeURIComponent(workspaceDir)}`);
    assert.equal(rootResponse.status, 200);
    const rootPayload = await rootResponse.json();

    assert.deepEqual(
      rootPayload.entries.map((entry) => ({ name: entry.name, type: entry.type })),
      [
        { name: "graphs", type: "directory" },
        { name: "notes.txt", type: "file" },
      ],
    );

    const nestedResponse = await fetch(
      `${baseUrl}/api/files?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("graphs")}`,
    );
    assert.equal(nestedResponse.status, 200);
    const nestedPayload = await nestedResponse.json();
    assert.equal(nestedPayload.entries.length, 1);
    assert.equal(nestedPayload.entries[0].name, "chart.png");
    assert.equal(nestedPayload.entries[0].isImage, true);

    const textResponse = await fetch(
      `${baseUrl}/api/files/text?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("notes.txt")}`,
    );
    assert.equal(textResponse.status, 200);
    const textPayload = await textResponse.json();
    assert.equal(textPayload.file.content, "analysis notes\n");

    const saveResponse = await fetch(`${baseUrl}/api/files/text`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        root: workspaceDir,
        path: "notes.txt",
        content: "updated notes\nwith details\n",
      }),
    });
    assert.equal(saveResponse.status, 200);
    assert.equal((await saveResponse.json()).file.content, "updated notes\nwith details\n");

    const verifyTextResponse = await fetch(
      `${baseUrl}/api/files/text?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("notes.txt")}`,
    );
    assert.equal(verifyTextResponse.status, 200);
    assert.equal((await verifyTextResponse.json()).file.content, "updated notes\nwith details\n");

    const imageResponse = await fetch(
      `${baseUrl}/api/files/content?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("graphs/chart.png")}`,
    );
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get("content-type") || "", /image\/png/);

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    assert.equal(imageBuffer.compare(PNG_FIXTURE), 0);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("deleted persisted sessions do not come back after restart", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-delete-");
  let firstApp = null;
  let secondApp = null;

  try {
    const firstRun = await startApp({
      cwd: workspaceDir,
      persistSessions: true,
    });
    firstApp = firstRun.app;

    const createResponse = await fetch(`${firstRun.baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Delete Me",
        cwd: workspaceDir,
      }),
    });

    assert.equal(createResponse.status, 201);
    const { session } = await createResponse.json();

    const deleteResponse = await fetch(`${firstRun.baseUrl}/api/sessions/${session.id}`, {
      method: "DELETE",
    });
    assert.equal(deleteResponse.status, 200);

    await firstApp.close();
    firstApp = null;

    const secondRun = await startApp({
      cwd: workspaceDir,
      persistSessions: true,
    });
    secondApp = secondRun.app;

    const sessionsResponse = await fetch(`${secondRun.baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.deepEqual(sessionsPayload.sessions, []);
  } finally {
    if (firstApp) {
      await firstApp.close();
    }

    if (secondApp) {
      await secondApp.close();
    }

    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("persisted sessions with missing workspaces stay visible and show restore failure", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-missing-cwd-");
  const missingCwd = path.join(workspaceDir, "missing-workspace");
  const persistedSessionId = "persisted-missing-cwd";
  const createdAt = new Date().toISOString();

  await writePersistedSessions(workspaceDir, [
    {
      id: persistedSessionId,
      providerId: "shell",
      providerLabel: "Vanilla Shell",
      name: "Missing Workspace",
      cwd: missingCwd,
      shell: process.env.SHELL || "/bin/zsh",
      createdAt,
      updatedAt: createdAt,
      lastOutputAt: createdAt,
      status: "running",
      exitCode: null,
      exitSignal: null,
      cols: 90,
      rows: 24,
      buffer: "previous transcript\r\n",
      restoreOnStartup: true,
    },
  ]);

  const { app, baseUrl } = await startApp({
    cwd: workspaceDir,
    persistSessions: true,
  });

  try {
    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();

    assert.equal(sessionsPayload.sessions.length, 1);
    assert.equal(sessionsPayload.sessions[0].id, persistedSessionId);
    assert.equal(sessionsPayload.sessions[0].status, "exited");

    const websocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?sessionId=${persistedSessionId}`);
    const snapshot = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for missing-workspace snapshot."));
      }, 8_000);

      websocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));

        if (payload.type === "snapshot") {
          clearTimeout(timeout);
          resolve(payload);
        }
      });
    });

    assert.match(snapshot.data, /previous transcript/);
    assert.match(snapshot.data, /could not restore the session/i);
    assert.match(snapshot.data, /Working directory does not exist/i);

    websocket.close();
    await once(websocket, "close");
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("workspace file api rejects traversal and invalid entry types", async () => {
  const workspaceDir = await createTempWorkspace("remote-vibes-files-guards-");
  const graphsDir = path.join(workspaceDir, "graphs");
  const internalStateDir = path.join(workspaceDir, ".remote-vibes");
  const imagePath = path.join(graphsDir, "chart.png");
  const notePath = path.join(workspaceDir, "notes.txt");
  const internalStatePath = path.join(internalStateDir, "sessions.json");

  await mkdir(graphsDir, { recursive: true });
  await mkdir(internalStateDir, { recursive: true });
  await writeFile(imagePath, PNG_FIXTURE);
  await writeFile(notePath, "analysis notes\n", "utf8");
  await writeFile(internalStatePath, "{}\n", "utf8");

  const { app, baseUrl } = await startApp({ cwd: workspaceDir });

  try {
    const traversalResponse = await fetch(
      `${baseUrl}/api/files?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("../")}`,
    );
    assert.equal(traversalResponse.status, 400);
    assert.match((await traversalResponse.json()).error, /escapes the selected workspace/i);

    const directoryAsFileResponse = await fetch(
      `${baseUrl}/api/files/content?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("graphs")}`,
    );
    assert.equal(directoryAsFileResponse.status, 400);
    assert.match((await directoryAsFileResponse.json()).error, /not a file/i);

    const fileAsDirectoryResponse = await fetch(
      `${baseUrl}/api/files?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("notes.txt")}`,
    );
    assert.equal(fileAsDirectoryResponse.status, 400);
    assert.match((await fileAsDirectoryResponse.json()).error, /not a directory/i);

    const internalDirectoryResponse = await fetch(
      `${baseUrl}/api/files?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent(".remote-vibes")}`,
    );
    assert.equal(internalDirectoryResponse.status, 404);
    assert.match((await internalDirectoryResponse.json()).error, /not available in the workspace browser/i);

    const internalFileResponse = await fetch(
      `${baseUrl}/api/files/content?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent(".remote-vibes/sessions.json")}`,
    );
    assert.equal(internalFileResponse.status, 404);
    assert.match((await internalFileResponse.json()).error, /not available in the workspace browser/i);

    const imageAsTextResponse = await fetch(
      `${baseUrl}/api/files/text?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("graphs/chart.png")}`,
    );
    assert.equal(imageAsTextResponse.status, 400);
    assert.match((await imageAsTextResponse.json()).error, /not editable as text/i);

    const internalTextResponse = await fetch(`${baseUrl}/api/files/text`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        root: workspaceDir,
        path: ".remote-vibes/sessions.json",
        content: "{}\n",
      }),
    });
    assert.equal(internalTextResponse.status, 404);
    assert.match((await internalTextResponse.json()).error, /not available in the workspace browser/i);
  } finally {
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("workspace file api serves content from hidden install roots", async () => {
  const parentDir = await createTempWorkspace("remote-vibes-hidden-root-");
  const workspaceDir = path.join(parentDir, ".remote-vibes", "app");
  const imagePath = path.join(workspaceDir, "shell.jpg");

  await mkdir(workspaceDir, { recursive: true });
  await writeFile(imagePath, PNG_FIXTURE);

  const { app, baseUrl } = await startApp({
    cwd: workspaceDir,
    stateDir: path.join(parentDir, "state"),
  });

  try {
    const imageResponse = await fetch(
      `${baseUrl}/api/files/content?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("shell.jpg")}`,
    );
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get("content-type") || "", /image\/jpeg/);

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    assert.equal(imageBuffer.compare(PNG_FIXTURE), 0);
  } finally {
    await app.close();
    await rm(parentDir, { recursive: true, force: true });
  }
});
