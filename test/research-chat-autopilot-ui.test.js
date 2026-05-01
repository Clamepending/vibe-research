import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { chromium } from "playwright-core";
import { createVibeResearchApp } from "../src/create-app.js";
import { resolveBrowserExecutablePath } from "../src/browser-runtime.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

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

test("same-chat supervisor Start creates project memory and queues takeover while agent is busy", async (t) => {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    t.skip("No local Chromium/Chrome executable available for the chat supervisor UI canary.");
    return;
  }

  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-chat-supervisor-ui-"));
  const providers = [
    { id: "claude", label: "Claude Code", available: true, command: "/bin/sh", launchCommand: "/bin/sh", defaultName: "Claude" },
    { id: "shell", label: "Shell", available: true, command: null, launchCommand: null, defaultName: "Shell" },
  ];
  const { app, baseUrl } = await startApp({ cwd: workspaceDir, providers });
  let browser = null;

  try {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceRootPath: workspaceDir, wikiPathConfigured: true }),
    });
    assert.equal(settingsResponse.status, 200);

    const timestamp = "2026-05-01T10:00:00.000Z";
    const session = app.sessionManager.buildSessionRecord({
      id: "chat-supervisor-start-session",
      providerId: "claude",
      providerLabel: "Claude Code",
      name: "Supervisor start smoke",
      cwd: workspaceDir,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "running",
      streamMode: true,
    });
    session.streamWorking = true;
    app.sessionManager.sessions.set(session.id, session);
    app.sessionManager.getSessionNarrative = async (sessionId) => {
      if (sessionId !== session.id) return null;
      return {
        providerBacked: true,
        providerId: "claude",
        providerLabel: "Claude Code",
        sourceLabel: "test fixture",
        updatedAt: timestamp,
        entries: [
          {
            id: "busy-turn",
            kind: "assistant",
            label: "Claude Code",
            text: "I am still working on the current turn.",
            status: "running",
            timestamp,
          },
        ],
      };
    };

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/?view=shell`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#toggle-shell-surface-native", { timeout: 30_000 });
    await page.click("#toggle-shell-surface-native");
    await page.waitForSelector(".rich-session-surface.is-active", { timeout: 10_000 });

    const startButton = page.locator("[data-chat-autopilot-start-project]");
    await startButton.waitFor({ timeout: 20_000 });
    assert.match(
      await page.locator(".rich-session-autopilot-status").textContent(),
      /ready to supervise this chat/,
    );
    await startButton.click();

    await page.waitForSelector('[data-rich-session-queue-item^="autopilot-"]', { timeout: 20_000 });
    const uiState = await page.evaluate((sessionId) => {
      const rawQueue = window.localStorage.getItem("vibe-research-composer-queue-v1") || "{}";
      const queue = JSON.parse(rawQueue);
      const items = Array.isArray(queue[sessionId]) ? queue[sessionId] : [];
      const first = items[0] || null;
      const status = document.querySelector(".rich-session-autopilot-status")?.textContent?.trim() || "";
      const projectLabel = document.querySelector(".rich-session-autopilot-project-pill")?.textContent?.trim() || "";
      const policyLabel = document.querySelector("[data-chat-autopilot-policy]")?.textContent?.trim() || "";
      const policyTitle = document.querySelector("[data-chat-autopilot-policy]")?.getAttribute("title") || "";
      const traceButton = document.querySelector("[data-chat-autopilot-supervisor-history]");
      const queuePreview = document.querySelector(".rich-session-queue-text")?.textContent?.trim() || "";
      const queueMeta = document.querySelector(".rich-session-queue-meta")?.textContent?.trim() || "";
      return {
        status,
        projectLabel,
        policyLabel,
        policyTitle,
        traceTitle: traceButton?.getAttribute("title") || "",
        traceExpanded: traceButton?.getAttribute("aria-expanded") || "",
        queuePreview,
        queueMeta,
        queuedId: first?.id || "",
        queuedText: first?.text || "",
      };
    }, session.id);

    assert.match(uiState.status, /supervisor next step queued/);
    assert.match(uiState.projectLabel, /vibe-research-chat-supervisor/);
    assert.equal(uiState.policyLabel, "evidence · integrity · compute");
    assert.match(uiState.policyTitle, /Evidence:/);
    assert.match(uiState.policyTitle, /Integrity:/);
    assert.match(uiState.policyTitle, /Compute:/);
    assert.match(uiState.policyTitle, /Continuity:/);
    assert.match(uiState.traceTitle, /supervisor review history/i);
    assert.equal(uiState.traceExpanded, "false");
    assert.match(uiState.queuedId, /^autopilot-/);
    assert.match(uiState.queuePreview, /Claim QUEUE row 1/);
    assert.equal(uiState.queueMeta, "supervisor next step - sends after current turn");
    assert.match(uiState.queuedText, /Claim QUEUE row 1 \(initial-research-loop\)/);
    assert.match(uiState.queuedText, /Use the README\/project goal as the north star/);
    assert.match(uiState.queuedText, /set a monitor\/wakeup\/log watcher/);
    assert.doesNotMatch(uiState.queuedText, /\n/);
    assert.doesNotMatch(uiState.queuedText, /Autopilot/i);

    await page.click("[data-chat-autopilot-supervisor-history]");
    await page.waitForSelector("[data-chat-autopilot-supervisor-drawer].is-open", { timeout: 10_000 });
    const drawerState = await page.evaluate(() => ({
      title: document.querySelector(".rich-session-supervisor-drawer-head strong")?.textContent?.trim() || "",
      status: document.querySelector(".rich-session-supervisor-state")?.textContent?.trim() || "",
      preview: document.querySelector(".rich-session-supervisor-card p")?.textContent?.trim() || "",
      history: Array.from(document.querySelectorAll(".rich-session-supervisor-event"))
        .map((entry) => entry.textContent?.trim() || "")
        .join(" "),
      expanded: document.querySelector("[data-chat-autopilot-supervisor-history]")?.getAttribute("aria-expanded") || "",
    }));
    assert.equal(drawerState.title, "Supervisor");
    assert.equal(drawerState.status, "resting");
    assert.match(drawerState.preview, /Claim QUEUE row 1/);
    assert.match(drawerState.history, /takeover/);
    assert.match(drawerState.history, /directive/);
    assert.equal(drawerState.expanded, "true");

    await page.fill("[data-chat-autopilot-supervisor-input]", "Should I ask for qualitative heatmaps or ablations next?");
    await page.click('[data-chat-autopilot-supervisor-submit="ask"]');
    await page.waitForFunction(() => {
      const text = Array.from(document.querySelectorAll(".rich-session-supervisor-message"))
        .map((entry) => entry.textContent || "")
        .join(" ");
      return /qualitative heatmaps or ablations/i.test(text) && /Recommendation:/i.test(text);
    }, null, { timeout: 20_000 });
    const askState = await page.evaluate((sessionId) => {
      const rawQueue = window.localStorage.getItem("vibe-research-composer-queue-v1") || "{}";
      const queue = JSON.parse(rawQueue);
      const items = Array.isArray(queue[sessionId]) ? queue[sessionId] : [];
      return {
        queueCount: items.length,
        messages: Array.from(document.querySelectorAll(".rich-session-supervisor-message"))
          .map((entry) => entry.textContent?.trim() || ""),
      };
    }, session.id);
    assert.equal(askState.queueCount, 1);
    assert.ok(askState.messages.some((text) => /Should I ask for qualitative heatmaps or ablations next\?/i.test(text)));
    assert.ok(askState.messages.some((text) => /Recommendation:/i.test(text)));

    await page.fill("[data-chat-autopilot-supervisor-input]", "Please tell the worker to inspect qualitative heatmaps before more GPU spend.");
    await page.click('[data-chat-autopilot-supervisor-submit="directive"]');
    await page.waitForFunction((sessionId) => {
      const rawQueue = window.localStorage.getItem("vibe-research-composer-queue-v1") || "{}";
      const queue = JSON.parse(rawQueue);
      const items = Array.isArray(queue[sessionId]) ? queue[sessionId] : [];
      const text = Array.from(document.querySelectorAll(".rich-session-supervisor-message"))
        .map((entry) => entry.textContent || "")
        .join(" ");
      return items.length >= 2 && /Sent to worker|Directive sent/i.test(text);
    }, session.id, { timeout: 20_000 });
    const directiveState = await page.evaluate((sessionId) => {
      const rawQueue = window.localStorage.getItem("vibe-research-composer-queue-v1") || "{}";
      const queue = JSON.parse(rawQueue);
      const items = Array.isArray(queue[sessionId]) ? queue[sessionId] : [];
      return {
        queueCount: items.length,
        secondText: items[1]?.text || "",
        secondMeta: Array.from(document.querySelectorAll(".rich-session-queue-meta"))
          .map((entry) => entry.textContent?.trim() || "")[1] || "",
        messages: Array.from(document.querySelectorAll(".rich-session-supervisor-message"))
          .map((entry) => entry.textContent?.trim() || "")
          .join(" "),
      };
    }, session.id);
    assert.equal(directiveState.queueCount, 2);
    assert.match(directiveState.secondText, /Please prioritize:/);
    assert.match(directiveState.secondText, /qualitative heatmaps/);
    assert.doesNotMatch(directiveState.secondText, /\n/);
    assert.equal(directiveState.secondMeta, "supervisor queued - #2");
    assert.match(directiveState.messages, /Sent to worker|Directive sent/i);

    const projectsResponse = await fetch(`${baseUrl}/api/research/projects`);
    assert.equal(projectsResponse.status, 200);
    const projectsPayload = await projectsResponse.json();
    assert.equal(projectsPayload.projects.length, 1);
    const projectName = projectsPayload.projects[0].name;
    assert.match(projectName, /^vibe-research-chat-supervisor-ui-/);
    assert.equal(projectsPayload.projects[0].queueSize, 1);

    const attachmentResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/research-autopilot`);
    assert.equal(attachmentResponse.status, 200);
    const attachmentPayload = await attachmentResponse.json();
    assert.equal(attachmentPayload.attachment.enabled, true);
    assert.equal(attachmentPayload.attachment.driver, "session");
    assert.equal(attachmentPayload.attachment.projectName, projectName);
    assert.match(attachmentPayload.attachment.lastMessage, /qualitative heatmaps/);

    session.status = "exited";
    session.streamWorking = false;
    session.exitCode = 143;
    session.updatedAt = "2026-05-01T10:05:00.000Z";
    app.sessionManager.broadcastSessionMeta(session);

    let sessionsPayload = { sessions: [] };
    let continuedSession = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      sessionsPayload = await (await fetch(`${baseUrl}/api/sessions`)).json();
      continuedSession = sessionsPayload.sessions.find((entry) => entry.id !== session.id && /continued/i.test(entry.name || ""));
      if (continuedSession) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(
      continuedSession,
      `recovery created a continued session: ${JSON.stringify(sessionsPayload.sessions.map((entry) => ({ id: entry.id, name: entry.name, status: entry.status })))}`,
    );
    assert.equal(continuedSession.cwd, workspaceDir);

    const oldAttachment = await (await fetch(`${baseUrl}/api/sessions/${session.id}/research-autopilot`)).json();
    assert.equal(oldAttachment.attachment.enabled, false);
    assert.equal(oldAttachment.attachment.statusText, "continued in new chat");

    const continuedAttachment = await (await fetch(`${baseUrl}/api/sessions/${continuedSession.id}/research-autopilot`)).json();
    assert.equal(continuedAttachment.attachment.enabled, true);
    assert.equal(continuedAttachment.attachment.driver, "session");
    assert.equal(continuedAttachment.attachment.projectName, projectName);
    assert.equal(continuedAttachment.attachment.lastMessage, uiState.queuedText);

    const queueAfterRecovery = await page.evaluate((oldSessionId) => {
      const rawQueue = window.localStorage.getItem("vibe-research-composer-queue-v1") || "{}";
      const queue = JSON.parse(rawQueue);
      return Array.isArray(queue[oldSessionId]) ? queue[oldSessionId] : [];
    }, session.id);
    assert.equal(queueAfterRecovery.some((entry) => /^autopilot-/.test(entry?.id || "")), false);
  } finally {
    await browser?.close().catch(() => {});
    await app.close?.().catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
