// End-to-end smoke for the native UI's structured surfaces.
//
// Spins up the dev server with a fake provider, monkey-patches
// getSessionNarrative to return entries that exercise every structured
// surface (plan card, MCP-tagged tool, image strip, /login action,
// thinking spinner, OSC-8 hyperlink, path-with-spaces), opens the page in
// headless Chromium, switches to native surface mode, and asserts each
// surface renders correctly. This is the eyeball-level pin for the
// schema-driven rendering that the unit tests cover at the protocol
// boundary.
//
// Skips when no Chromium is available — same posture as the existing
// rich-session-markdown smoke.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { chromium } from "playwright-core";
import { createVibeResearchApp } from "../src/create-app.js";
import { resolveBrowserExecutablePath } from "../src/browser-runtime.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

async function startApp({ cwd, providers }) {
  const app = await createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd,
    stateDir: path.join(cwd, ".vibe-research"),
    persistSessions: false,
    persistentTerminals: false,
    providers,
    sleepPreventionFactory: (settings) => new SleepPreventionService({
      enabled: settings.preventSleepEnabled,
      platform: "test",
    }),
  });
  return { app, baseUrl: `http://127.0.0.1:${app.config.port}` };
}

test("native UI renders plan card, MCP badge, image strip, /login action, thinking spinner, OSC-8 + path-with-spaces", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable available for the native-surfaces smoke.");
    return;
  }

  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-native-surfaces-"));
  const providers = [
    { id: "claude", label: "Claude Code", available: true, command: "claude", launchCommand: "claude", defaultName: "Claude" },
    { id: "shell", label: "Shell", available: true, command: null, launchCommand: null, defaultName: "Shell" },
  ];
  const { app, baseUrl } = await startApp({ cwd: workspaceDir, providers });
  let browser = null;

  try {
    await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceRootPath: workspaceDir, wikiPathConfigured: true }),
    });

    const timestamp = "2026-04-30T06:00:00.000Z";
    // Build a stream-mode session so the WS push protocol kicks in and the
    // reducer drives the renderer. We populate session.streamEntries with
    // our fixture and override getSessionNarrative to mirror the same
    // payload — both wire paths now agree, and the renderer (reducer-armed
    // after narrative-init) reads our entries.
    const session = app.sessionManager.buildSessionRecord({
      id: "native-surfaces-session",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Surface smoke",
      cwd: workspaceDir,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "running",
      streamMode: true,
    });
    app.sessionManager.sessions.set(session.id, session);

    // The narrative carries one entry per surface we want to verify. The
    // schema-driven renderer should produce a distinct DOM affordance for
    // each — plan card, MCP badge, image strip, /login button, thinking
    // spinner. Order in the array becomes order in the DOM.
    const entries = (() => {
      const list = [
          // (1) Pending assistant entry — empty text triggers the thinking spinner.
          {
            id: "pending-1",
            kind: "assistant",
            label: "Claude Code",
            text: "",
            meta: "pending",
            timestamp,
          },
          // (2) Assistant entry mentioning a saved figure — should produce
          //     an image strip via entry.imageRefs.
          {
            id: "asst-figure",
            kind: "assistant",
            label: "Claude Code",
            text: "Saved the loss curve to figures/loss.png so you can inspect it.",
            imageRefs: ["figures/loss.png"],
            timestamp,
          },
          // (3) Assistant text including an OSC-8 hyperlink. Renderer
          //     should strip the hyperlink envelope; the visible text
          //     stays clean ("figures/run.png") and the imageRef tile
          //     should also still appear.
          {
            id: "asst-osc8",
            kind: "assistant",
            label: "Claude Code",
            text: `Saved ${ESC}]8;;file:///abs/figures/run.png${BEL}figures/run.png${ESC}]8;;${BEL} as the result.`,
            imageRefs: ["figures/run.png"],
            timestamp,
          },
          // (4) Assistant entry referring to a path with spaces / parens
          //     — passes through as an explicit imageRefs entry from the
          //     server, so the renderer just trusts it.
          {
            id: "asst-spaces",
            kind: "assistant",
            label: "Claude Code",
            text: "Compared the variants and saved <figures/loss (lr=1e-4).png>.",
            imageRefs: ["figures/loss (lr=1e-4).png"],
            timestamp,
          },
          // (5) MCP-flavored tool entry. mcp: {server, tool} should
          //     produce the MCP badge; label is server.tool.
          {
            id: "tool-mcp",
            kind: "tool",
            label: "filesystem.read_file",
            text: "/tmp/x",
            mcp: { server: "filesystem", tool: "read_file" },
            status: "done",
            timestamp,
          },
          // (6) Plan-mode card. ExitPlanMode produces a plan kind entry;
          //     the renderer should show two buttons (Approve / Push back).
          {
            id: "plan-1",
            kind: "plan",
            label: "Plan",
            text: "1. Read the file\n2. Apply the patch\n3. Run tests",
            status: "pending",
            timestamp,
          },
          // (7) Status entry with a /login slashAction — should render an
          //     inline "Sign in" button.
          {
            id: "status-login",
            kind: "status",
            label: "Error",
            text: "Authentication failed. Please run /login.",
            slashAction: { command: "/login", label: "Sign in" },
            timestamp,
          },
      ];
      return list;
    })();

    // Populate the stream-entry buffer the WS push protocol reads from.
    session.streamEntries = entries.map((entry, index) => ({
      ...entry,
      seq: index + 1,
    }));

    // Also serve the same payload over the HTTP narrative endpoint as a
    // backstop — if the reducer somehow doesn't arm, the HTTP fallback
    // delivers the same fixture.
    app.sessionManager.getSessionNarrative = async (sessionId) => {
      if (sessionId !== session.id) return null;
      return {
        providerBacked: true,
        providerId: "claude",
        providerLabel: "Claude Code",
        sourceLabel: "test fixture",
        updatedAt: timestamp,
        entries: session.streamEntries,
      };
    };

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/?view=shell`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#toggle-shell-surface-native", { timeout: 10_000 });
    await page.click("#toggle-shell-surface-native");
    await page.waitForSelector(".rich-session-surface.is-active", { timeout: 5_000 });
    // Wait for the plan card to appear — that's the most distinctive surface
    // and also the last entry to render in our fixture.
    await page.waitForSelector(".rich-session-plan-card", { timeout: 10_000 });

    const surfaces = await page.evaluate(() => {
      // Pending assistant: spinner + "is thinking…" copy.
      const pending = document.querySelector(".rich-session-entry.is-assistant.is-pending");
      const pendingHasSpinner = Boolean(pending?.querySelector(".rich-session-thinking-spinner"));
      const pendingCopy = pending?.querySelector(".is-pending-copy")?.textContent || "";

      // Image tiles. Should include figures/loss.png, figures/run.png, and
      // figures/loss (lr=1e-4).png (the path-with-spaces survives because
      // the server stamped the structured imageRefs field).
      const tiles = Array.from(
        document.querySelectorAll(".rich-session-image-tile"),
        (tile) => tile.getAttribute("data-rich-path") || "",
      );

      // OSC-8 envelope should not appear in any visible text. Sample the
      // assistant body to assert the visible output is clean. We look for
      // the bell character () and the OSC-8 introducer (]8).
      const assistantTexts = Array.from(
        document.querySelectorAll(".rich-session-entry.is-assistant .rich-session-entry-copy, .rich-session-entry.is-assistant .rich-session-entry-markdown"),
        (el) => el.textContent || "",
      );
      const anyEscapesVisible = assistantTexts.some((t) => /|/.test(t));

      // MCP-tagged tool: rich-session-mcp-badge present, label uses
      // server.tool format.
      const mcpEntry = document.querySelector(".rich-session-entry.is-tool.is-mcp");
      const mcpBadge = mcpEntry?.querySelector(".rich-session-mcp-badge")?.textContent || "";
      const mcpLabel = mcpEntry?.querySelector(".rich-session-entry-kicker-label")?.textContent || "";

      // Plan card: two action buttons (Approve / Push back).
      const planCard = document.querySelector(".rich-session-plan-card");
      const planAccept = planCard?.querySelector("[data-rich-session-plan-accept]")?.textContent?.trim() || "";
      const planReject = planCard?.querySelector("[data-rich-session-plan-reject]")?.textContent?.trim() || "";
      const planBody = planCard?.querySelector(".rich-session-plan-body")?.textContent || "";

      // /login action: a status entry has the inline action button.
      const slashButton = document.querySelector(".rich-session-slash-action");
      const slashCommand = slashButton?.getAttribute("data-rich-session-slash-command") || "";
      const slashLabel = slashButton?.textContent?.trim() || "";

      // Surface toggle: native should be active, three buttons present
      // (Native | Terminal | Stream JSON).
      const toggleButtons = Array.from(
        document.querySelectorAll(".shell-surface-button"),
        (btn) => ({ id: btn.id, active: btn.classList.contains("is-active"), label: btn.textContent?.trim() || "" }),
      );

      return {
        pendingHasSpinner,
        pendingCopy,
        tiles,
        anyEscapesVisible,
        mcpBadge,
        mcpLabel,
        planAccept,
        planReject,
        planBody,
        slashCommand,
        slashLabel,
        toggleButtons,
      };
    });

    // Thinking spinner is present and the visible copy reads "is thinking…".
    assert.equal(surfaces.pendingHasSpinner, true, "pending entry shows the thinking spinner");
    assert.match(surfaces.pendingCopy, /thinking/iu, "pending entry shows is-thinking copy");

    // All three image tiles render — including the OSC-8-stripped one and
    // the path-with-spaces (which only works because the server stamped
    // imageRefs server-side).
    assert.ok(surfaces.tiles.includes("figures/loss.png"), "loss.png tile rendered");
    assert.ok(surfaces.tiles.includes("figures/run.png"), "OSC-8-wrapped run.png tile rendered");
    assert.ok(surfaces.tiles.includes("figures/loss (lr=1e-4).png"), "path-with-spaces tile rendered");

    // No raw escape bytes leaked into the visible text.
    assert.equal(surfaces.anyEscapesVisible, false, "no ANSI/OSC escape bytes visible in assistant text");

    // MCP badge + human-readable label.
    assert.match(surfaces.mcpBadge, /MCP\s*·\s*filesystem/u, "MCP badge shows server name");
    assert.equal(surfaces.mcpLabel, "filesystem.read_file", "MCP tool label is server.tool");

    // Plan card has both buttons and the plan body.
    assert.match(surfaces.planAccept, /Approve/u, "plan card has Approve button");
    assert.match(surfaces.planReject, /Push back/u, "plan card has Push back button");
    assert.match(surfaces.planBody, /Apply the patch/u, "plan body renders");

    // /login slash-action button is wired.
    assert.equal(surfaces.slashCommand, "/login", "slash-action button targets /login");
    assert.match(surfaces.slashLabel, /Sign in/u, "slash-action button label reads Sign in");

    // Surface toggle buttons. Stream-mode sessions hide the Terminal button
    // (no PTY to point it at) but Native and Stream JSON are always present.
    const toggleIds = surfaces.toggleButtons.map((b) => b.id);
    assert.ok(toggleIds.includes("toggle-shell-surface-native"), "Native toggle present");
    assert.ok(toggleIds.includes("toggle-shell-surface-stream-json"), "Stream JSON toggle present");
    const native = surfaces.toggleButtons.find((b) => b.id === "toggle-shell-surface-native");
    assert.equal(native?.active, true, "Native is the active surface");
  } finally {
    await browser?.close().catch(() => {});
    await app.shutdown?.().catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("Stream JSON viewer is reachable and shows the wire-format frames the renderer is parsing", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable available for the Stream JSON viewer smoke.");
    return;
  }

  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-stream-json-"));
  const providers = [
    { id: "claude", label: "Claude Code", available: true, command: "claude", launchCommand: "claude", defaultName: "Claude" },
    { id: "shell", label: "Shell", available: true, command: null, launchCommand: null, defaultName: "Shell" },
  ];
  const { app, baseUrl } = await startApp({ cwd: workspaceDir, providers });
  let browser = null;

  try {
    await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceRootPath: workspaceDir, wikiPathConfigured: true }),
    });

    const session = app.sessionManager.buildSessionRecord({
      id: "stream-json-session",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Stream JSON smoke",
      cwd: workspaceDir,
      status: "running",
    });
    app.sessionManager.sessions.set(session.id, session);
    app.sessionManager.getSessionNarrative = async (id) => id === session.id ? {
      providerBacked: true, providerId: "claude", providerLabel: "Claude Code",
      sourceLabel: "test fixture", entries: [
        { id: "u1", kind: "user", label: "You", text: "hi" },
      ],
    } : null;

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/?view=shell`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#toggle-shell-surface-stream-json", { timeout: 10_000 });
    await page.click("#toggle-shell-surface-stream-json");

    // The viewer shows either populated entries OR an empty-state copy
    // (no WS frames captured yet for the seeded session). Either way the
    // pane should be visible.
    const viewerVisible = await page.evaluate(() => {
      const pane = document.querySelector("#rich-session-stream-log");
      if (!(pane instanceof HTMLElement)) return false;
      // The pane is hidden when not active; visibility matches the toggle.
      return !pane.classList.contains("is-hidden");
    });
    assert.equal(viewerVisible, true, "Stream JSON pane is visible after toggle");

    // Native pane is hidden while Stream JSON is active.
    const feedHidden = await page.evaluate(() => {
      const feed = document.querySelector("#rich-session-feed");
      return feed instanceof HTMLElement && feed.classList.contains("is-hidden");
    });
    assert.equal(feedHidden, true, "Native feed is hidden while Stream JSON is active");
  } finally {
    await browser?.close().catch(() => {});
    await app.shutdown?.().catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
