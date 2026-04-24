import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { chromium } from "playwright-core";
import { createVibeResearchApp } from "../src/create-app.js";
import { resolveBrowserExecutablePath } from "../src/browser-runtime.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

async function startApp(options = {}) {
  const cwd = options.cwd || process.cwd();
  const stateDir = options.stateDir || path.join(cwd, ".vibe-research");
  const app = await createVibeResearchApp({
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

test("rich session assistant replies render markdown while tool rows stay plain", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the rich session markdown smoke.");
    return;
  }

  const workspaceDir = await createTempWorkspace("vibe-research-rich-session-markdown-");
  const providers = [
    { id: "codex", label: "Codex", available: true, command: "codex", launchCommand: "codex", defaultName: "Codex" },
    { id: "shell", label: "Shell", available: true, command: null, launchCommand: null, defaultName: "Shell" },
  ];
  const { app, baseUrl } = await startApp({ cwd: workspaceDir, providers });
  let browser = null;

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceRootPath: workspaceDir,
        wikiPathConfigured: true,
      }),
    });
    assert.equal(settingsResponse.status, 200);

    const timestamp = "2026-04-24T06:12:00.000Z";
    const session = app.sessionManager.buildSessionRecord({
      id: "rich-markdown-session",
      providerId: "codex",
      providerLabel: "Codex",
      name: "Codex Markdown Smoke",
      cwd: workspaceDir,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "running",
    });

    app.sessionManager.sessions.set(session.id, session);
    app.sessionManager.getSessionNarrative = async (sessionId) => {
      if (sessionId !== session.id) {
        return null;
      }

      return {
        providerBacked: true,
        providerId: "codex",
        providerLabel: "Codex",
        sourceLabel: "Codex session file",
        updatedAt: timestamp,
        entries: [
          {
            kind: "tool",
            label: "exec_command",
            text: "| raw | tool |\n| --- | --- |\n| keep | plain |",
            timestamp,
          },
          {
            kind: "assistant",
            label: "Codex",
            text: [
              "# Summary",
              "",
              "| item | value |",
              "| --- | ---: |",
              "| alpha | 1 |",
              "| beta | 2 |",
              "",
              "- bullet one",
              "- bullet two",
              "",
              "Use `code`, **bold**, and math symbols: α ≥ β ≠ ∑.",
            ].join("\n"),
            timestamp,
          },
        ],
      };
    };

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/?view=shell`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".rich-session-entry-markdown .knowledge-base-table", { timeout: 10_000 });

    const rendered = await page.evaluate(() => {
      const assistant = document.querySelector(".rich-session-entry.is-assistant .rich-session-entry-markdown");
      const table = assistant?.querySelector(".knowledge-base-table");
      const toolPre = document.querySelector(".rich-session-entry.is-tool .rich-session-entry-pre");
      return {
        heading: assistant?.querySelector("h1")?.textContent?.trim() || "",
        headers: Array.from(table?.querySelectorAll("thead th") || [], (cell) => cell.textContent.trim()),
        rows: Array.from(table?.querySelectorAll("tbody tr") || [], (row) =>
          Array.from(row.querySelectorAll("td"), (cell) => cell.textContent.trim()),
        ),
        bullets: Array.from(assistant?.querySelectorAll("li") || [], (item) => item.textContent.trim()),
        inlineCode: assistant?.querySelector("code")?.textContent || "",
        boldText: assistant?.querySelector("strong")?.textContent || "",
        assistantText: assistant?.textContent || "",
        toolText: toolPre?.textContent || "",
        toolTableCount: document.querySelectorAll(".rich-session-entry.is-tool .knowledge-base-table").length,
      };
    });

    assert.equal(rendered.heading, "Summary");
    assert.deepEqual(rendered.headers, ["item", "value"]);
    assert.deepEqual(rendered.rows, [["alpha", "1"], ["beta", "2"]]);
    assert.deepEqual(rendered.bullets, ["bullet one", "bullet two"]);
    assert.equal(rendered.inlineCode, "code");
    assert.equal(rendered.boldText, "bold");
    assert.match(rendered.assistantText, /α ≥ β ≠ ∑/u);
    assert.equal(rendered.toolTableCount, 0);
    assert.match(rendered.toolText, /\| --- \| --- \|/);
    assert.doesNotMatch(rendered.assistantText, /\| --- \| ---: \|/);
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
