import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

test("rich session native feed is clean even when the raw transcript is full of CLI noise", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable is available for the rich session screenshot smoke.");
    return;
  }

  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-rich-session-look-"));
  await mkdir(path.join(workspaceDir, "src"), { recursive: true });
  const providers = [
    { id: "claude", label: "Claude Code", available: true, command: "claude", launchCommand: "claude", defaultName: "Claude" },
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

    const timestamp = "2026-04-29T12:00:00.000Z";
    const session = app.sessionManager.buildSessionRecord({
      id: "rich-look-session",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "bidir-video-rl-bench",
      cwd: workspaceDir,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "running",
    });
    app.sessionManager.sessions.set(session.id, session);

    // The narrative we hand the renderer mirrors what a real
    // bench-init move would produce: kickoff, two tool calls (one running,
    // one errored), a git-style commit summary that should render as code,
    // a clean assistant reply with an inline file path, and a benign
    // status entry. None of the screenshot's noise lines (ctrl+t, ✦ progress,
    // Tip:, Shell cwd was reset to ...) appear here because the parser is
    // expected to have stripped them upstream.
    app.sessionManager.getSessionNarrative = async (sessionId) => {
      if (sessionId !== session.id) {
        return null;
      }

      return {
        providerBacked: true,
        providerId: "claude",
        providerLabel: "Claude Code",
        sourceLabel: "Claude project transcript",
        updatedAt: timestamp,
        entries: [
          {
            kind: "user",
            label: "You",
            text: "Run doctor and fix README placeholder rows for bidir-video-rl-bench.",
            timestamp,
          },
          {
            kind: "tool",
            label: "Bash",
            text: "vr-research-doctor projects/bidir-video-rl-bench",
            status: "done",
            meta: "completed",
            outputPreview: "doctor: 0 errors · 0 warnings",
            timestamp,
          },
          // TodoWrite entry — should render as a checklist with the
          // in-progress item shown first, completed items strikethrough,
          // and a footer count for additional completed items.
          {
            kind: "tool",
            label: "TodoWrite",
            text: "5 tasks (3 done, 1 in progress, 1 open)",
            status: "done",
            meta: "completed",
            timestamp,
            todos: [
              { content: "Map projection-narrative pipeline", activeForm: "Mapping projection pipeline", status: "completed" },
              { content: "Add tests for ✦ noise lines", activeForm: "Adding regression tests", status: "completed" },
              { content: "Tighten transcript filters", activeForm: "Tightening transcript filters", status: "completed" },
              { content: "Render TodoWrite as a real task list", activeForm: "Rendering TodoWrite", status: "in_progress" },
              { content: "Restrict monitor pills to long-running tools", activeForm: "Restricting monitor pills", status: "pending" },
            ],
          },
          {
            kind: "tool",
            label: "Edit",
            text: "src/research/bench-init.md",
            status: "running",
            meta: "running",
            timestamp,
          },
          // ToolSearch is a transient running tool that the OLD monitor row
          // would promote into a pill. The new behavior keeps it in the
          // feed but does NOT echo it into the monitor pill row.
          {
            kind: "tool",
            label: "ToolSearch",
            text: "lookup file API",
            status: "running",
            meta: "running",
            timestamp,
          },
          // A real long-running monitor — this one DOES belong in the
          // monitor pill row.
          {
            kind: "tool",
            label: "Monitor",
            text: "FID 3-seed run progress",
            status: "running",
            meta: "running",
            timestamp,
          },
          {
            kind: "tool",
            label: "Bash",
            text: "git commit -m 'bench-v1-init resolved'",
            status: "error",
            meta: "exit 1",
            outputPreview: "fatal: cannot lock ref 'HEAD' at projects/bidir-video-rl-bench/.git/HEAD",
            timestamp,
          },
          // Auth failure — should produce an inline "Sign in" action button
          // since the body says "Please run /login".
          {
            kind: "status",
            label: "Error",
            status: "error",
            text: "authentication_failed\nPlease run /login · API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"Invalid authentication credentials\"}}",
            timestamp,
          },
          {
            kind: "assistant",
            label: "Claude Code",
            text: [
              "Doctor passed. I pinned the v1 eval contract in projects/bidir-video-rl-bench/benchmark.md and installed paper.md from the template.",
              "",
              "**Next:** open src/research/bench-init.md to add the calibration table.",
            ].join("\n"),
            timestamp,
          },
        ],
      };
    };

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1300 }, deviceScaleFactor: 2 });
    await page.goto(`${baseUrl}/?view=shell`, { waitUntil: "domcontentloaded" });
    // Default shell surface is "terminal"; flip it to "native" so the feed
    // is visible. The button is only rendered once the active session loads.
    await page.waitForSelector("#toggle-shell-surface-native", { timeout: 10_000 });
    await page.click("#toggle-shell-surface-native");
    await page.waitForSelector(".rich-session-surface.is-active", { timeout: 5_000 });
    await page.waitForSelector(".rich-session-entry.is-tool .rich-session-path-link", { timeout: 10_000 });

    const screenshotPath = process.env.RICH_SESSION_SCREENSHOT_PATH
      || path.join(workspaceDir, "rich-session-native.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[rich-session-native-look] wrote ${screenshotPath}`);

    const summary = await page.evaluate(() => {
      const feed = document.querySelector("#rich-session-feed");
      const entries = feed ? Array.from(feed.querySelectorAll("[data-rich-session-entry]")) : [];
      const toolEntries = entries.filter((entry) => entry.classList.contains("is-tool"));
      const errorTools = toolEntries.filter((entry) => entry.classList.contains("is-error"));
      const runningTools = toolEntries.filter((entry) => entry.classList.contains("is-running"));
      const thinkingEntries = entries.filter((entry) => entry.classList.contains("is-thinking"));
      const pathLinks = feed ? Array.from(feed.querySelectorAll(".rich-session-path-link")) : [];
      const todoBlock = document.querySelector(".rich-session-todo-block");
      const todoItems = todoBlock ? Array.from(todoBlock.querySelectorAll(".rich-session-todo-item")) : [];
      const monitorPills = Array.from(document.querySelectorAll("#rich-session-monitors .rich-session-monitor-pill"));
      const slashAction = document.querySelector("[data-rich-session-slash-command]");
      return {
        feedText: feed?.textContent || "",
        toolCount: toolEntries.length,
        errorToolCount: errorTools.length,
        runningToolCount: runningTools.length,
        thinkingCount: thinkingEntries.length,
        firstPathHref: pathLinks[0]?.getAttribute("data-rich-path") || "",
        pathLinkCount: pathLinks.length,
        todoSummary: todoBlock?.querySelector(".rich-session-todo-summary")?.textContent?.trim() || "",
        todoCount: todoItems.length,
        todoInProgressFirst: todoItems[0]?.classList.contains("is-in-progress") || false,
        monitorPillLabels: monitorPills.map((pill) => pill.textContent.trim()),
        slashActionCommand: slashAction?.getAttribute("data-rich-session-slash-command") || "",
        slashActionLabel: slashAction?.textContent?.trim() || "",
      };
    });

    // 1. The CLI noise patterns must not appear in the rendered feed.
    assert.doesNotMatch(summary.feedText, /ctrl\+t to hide tasks/iu);
    assert.doesNotMatch(summary.feedText, /Shell cwd was reset to/iu);
    assert.doesNotMatch(summary.feedText, /Tip:\s+Use \/btw/iu);
    assert.doesNotMatch(summary.feedText, /✦\s+·\s+\d+\s+✦/u);

    // 2. Tool entry counts and statuses match the input.
    assert.equal(summary.toolCount, 6, "expected 6 tool entries (Bash, TodoWrite, Edit, ToolSearch, Monitor, Bash)");
    assert.equal(summary.runningToolCount, 3);
    assert.equal(summary.errorToolCount, 1);

    // 3. No standalone Thinking spinner is rendered (the parser dropped the
    //    placeholder; the test fixture omits it but the assertion is the
    //    contract for future regressions).
    assert.equal(summary.thinkingCount, 0, "no placeholder Thinking entry should remain");

    // 4. TodoWrite renders a structured checklist with the in-progress
    //    task first.
    assert.match(summary.todoSummary, /5 tasks/);
    assert.match(summary.todoSummary, /1 in progress/);
    assert.ok(summary.todoCount >= 5, `expected >=5 todo items, got ${summary.todoCount}`);
    assert.equal(summary.todoInProgressFirst, true, "in-progress task should be ordered first");

    // 5. The monitor row shows the long-running Monitor tool exactly once
    //    and does NOT promote ToolSearch / Edit / TodoWrite into pills.
    assert.deepEqual(summary.monitorPillLabels, ["running Monitor"], `unexpected monitor pills: ${JSON.stringify(summary.monitorPillLabels)}`);

    // 6. File paths are linkified.
    assert.ok(summary.pathLinkCount >= 2, "expected file paths to be linkified");
    assert.match(summary.firstPathHref, /^[\w./-]+\.\w+$/);

    // 7. The "Please run /login" auth_failed status entry produces an inline
    //    "Sign in" action button bound to the /login slash command.
    assert.equal(summary.slashActionCommand, "/login");
    assert.match(summary.slashActionLabel, /sign\s*in/i);

    // 8. Typing "/" in the composer surfaces the slash-command menu with
    //    the matching commands; pressing Tab populates the textarea with
    //    the highlighted command.
    await page.click("#rich-session-input");
    await page.keyboard.type("/lo");
    await page.waitForSelector("#rich-session-slash-menu.is-active", { timeout: 5_000 });
    const slashMenu = await page.evaluate(() => {
      const menu = document.querySelector("#rich-session-slash-menu");
      const items = menu ? Array.from(menu.querySelectorAll("[data-rich-slash-command]")) : [];
      return {
        visible: menu?.classList.contains("is-active") || false,
        commands: items.map((item) => item.getAttribute("data-rich-slash-command")),
        activeCommand: menu?.getAttribute("data-active-command") || "",
      };
    });
    assert.equal(slashMenu.visible, true);
    assert.ok(slashMenu.commands.includes("/login"), `expected /login in menu, got ${slashMenu.commands.join(",")}`);
    assert.ok(slashMenu.commands.includes("/logout"), `expected /logout in menu, got ${slashMenu.commands.join(",")}`);
    assert.equal(slashMenu.activeCommand, "/login");

    await page.keyboard.press("Tab");
    const inputAfterTab = await page.inputValue("#rich-session-input");
    assert.equal(inputAfterTab, "/login ");
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
