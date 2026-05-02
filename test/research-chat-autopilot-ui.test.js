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

test("same-chat supervisor Start creates project memory and arms silently while agent is busy", async (t) => {
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
    app.sessionManager.setExtraSubagentsProvider((candidate) => {
      if (candidate.id !== session.id) return [];
      return [
        {
          id: "subagent-qualitative-review",
          name: "Qualitative review",
          source: "codex",
          status: "working",
          updatedAt: timestamp,
          messageCount: 4,
          toolUseCount: 2,
        },
      ];
    });
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
    const preStartSideChat = await page.locator("[data-chat-autopilot-supervisor-history]").evaluate((button) => ({
      label: button.textContent?.trim() || "",
      title: button.getAttribute("title") || "",
      expanded: button.getAttribute("aria-expanded") || "",
      disabled: button.hasAttribute("disabled"),
    }));
    assert.equal(preStartSideChat.label, "Side chat");
    assert.match(preStartSideChat.title, /side-by-side supervisor chat and history/i);
    assert.equal(preStartSideChat.expanded, "true");
    assert.equal(preStartSideChat.disabled, false);
    await page.waitForSelector("[data-chat-autopilot-supervisor-drawer].is-open", { timeout: 10_000 });
    assert.equal(
      await page.locator(".rich-session-surface").evaluate((surface) => surface.classList.contains("is-supervisor-open")),
      true,
    );
    assert.match(
      await page.locator(".rich-session-autopilot-status").textContent(),
      /ready to supervise this chat/,
    );
    await startButton.click();

    await page.waitForFunction(() => /watching current turn/i.test(document.querySelector(".rich-session-autopilot-status")?.textContent || ""), null, { timeout: 20_000 });
    const uiState = await page.evaluate((sessionId) => {
      const rawQueue = window.localStorage.getItem("vibe-research-composer-queue-v1") || "{}";
      const queue = JSON.parse(rawQueue);
      const items = Array.isArray(queue[sessionId]) ? queue[sessionId] : [];
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
        traceLabel: traceButton?.textContent?.trim() || "",
        traceExpanded: traceButton?.getAttribute("aria-expanded") || "",
        queuePreview,
        queueMeta,
        queueCount: items.length,
      };
    }, session.id);

    assert.match(uiState.status, /watching current turn/);
    assert.match(uiState.projectLabel, /vibe-research-chat-supervisor/);
    assert.equal(uiState.policyLabel, "evidence · integrity · compute");
    assert.match(uiState.policyTitle, /Evidence:/);
    assert.match(uiState.policyTitle, /Integrity:/);
    assert.match(uiState.policyTitle, /Compute:/);
    assert.match(uiState.policyTitle, /Continuity:/);
    assert.match(uiState.traceTitle, /side-by-side supervisor chat and history/i);
    assert.equal(uiState.traceLabel, "Side chat");
    assert.equal(uiState.traceExpanded, "true");
    assert.equal(uiState.queueCount, 0);
    assert.equal(uiState.queuePreview, "");
    assert.equal(uiState.queueMeta, "");

    await page.waitForSelector("[data-chat-autopilot-supervisor-drawer].is-open", { timeout: 10_000 });
    const drawerState = await page.evaluate(() => ({
      title: document.querySelector(".rich-session-supervisor-drawer-head strong")?.textContent?.trim() || "",
      status: document.querySelector(".rich-session-supervisor-state")?.textContent?.trim() || "",
      preview: document.querySelector(".rich-session-supervisor-summary p")?.textContent?.trim() || "",
      signals: Array.from(document.querySelectorAll(".rich-session-supervisor-signal"))
        .map((entry) => entry.textContent?.trim() || ""),
      history: Array.from(document.querySelectorAll(".rich-session-supervisor-event"))
        .map((entry) => entry.textContent?.trim() || "")
        .join(" "),
      expanded: document.querySelector("[data-chat-autopilot-supervisor-history]")?.getAttribute("aria-expanded") || "",
      surfaceOpen: document.querySelector(".rich-session-surface")?.classList.contains("is-supervisor-open") || false,
      drawerPosition: getComputedStyle(document.querySelector("[data-chat-autopilot-supervisor-drawer]")).position,
    }));
    assert.equal(drawerState.title, "Side chat");
    assert.equal(drawerState.status, "resting");
    assert.match(drawerState.preview, /Waiting for the next worker pause/);
    assert.ok(drawerState.signals.includes("worker running"));
    assert.ok(drawerState.signals.includes("1 subagent working"));
    assert.ok(drawerState.signals.includes("no background tasks"));
    assert.ok(drawerState.signals.includes("continuity unknown"));
    assert.match(drawerState.history, /No supervisor decisions yet/);
    assert.equal(drawerState.expanded, "true");
    assert.equal(drawerState.surfaceOpen, true);
    assert.equal(drawerState.drawerPosition, "sticky");
    const scrollState = await page.evaluate(() => {
      const body = document.querySelector(".rich-session-supervisor-drawer-body");
      if (!(body instanceof HTMLElement)) return null;
      const chatLog = document.querySelector(".rich-session-supervisor-chat-log");
      if (!(chatLog instanceof HTMLElement)) return null;
      const filler = document.createElement("article");
      filler.className = "rich-session-supervisor-message is-supervisor";
      filler.setAttribute("data-test-supervisor-scroll-filler", "true");
      filler.innerHTML = `<div class="rich-session-supervisor-message-top"><span>Supervisor</span></div><p>${"debug scroll row ".repeat(260)}</p>`;
      chatLog.appendChild(filler);
      body.scrollTop = 0;
      body.scrollBy(0, 320);
      const state = {
        clientHeight: body.clientHeight,
        scrollHeight: body.scrollHeight,
        scrollTop: body.scrollTop,
        overflowY: getComputedStyle(body).overflowY,
        tabIndex: body.tabIndex,
        chatSectionHeight: document.querySelector(".rich-session-supervisor-history")?.clientHeight || 0,
      };
      filler.remove();
      body.scrollTop = 0;
      return state;
    });
    assert.ok(scrollState);
    assert.equal(scrollState.overflowY, "auto");
    assert.equal(scrollState.tabIndex, 0);
    assert.ok(scrollState.scrollHeight > scrollState.clientHeight);
    assert.ok(scrollState.scrollTop > 0);
    assert.ok(scrollState.chatSectionHeight > 180);

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
    assert.equal(askState.queueCount, 0);
    assert.ok(askState.messages.some((text) => /Should I ask for qualitative heatmaps or ablations next\?/i.test(text)));
    assert.ok(askState.messages.some((text) => /Recommendation:/i.test(text)));
    assert.ok(askState.messages.some((text) => /1 active subagent/i.test(text)));

    const longSideQuestion = `Scroll retention probe. ${"Keep this in the supervisor side chat only while I read older messages. ".repeat(90)}`;
    await page.fill("[data-chat-autopilot-supervisor-input]", longSideQuestion);
    await page.click('[data-chat-autopilot-supervisor-submit="ask"]');
    await page.waitForFunction(() => {
      const text = Array.from(document.querySelectorAll(".rich-session-supervisor-message"))
        .map((entry) => entry.textContent || "")
        .join(" ");
      return /Scroll retention probe/i.test(text) && /Recommendation:/i.test(text);
    }, null, { timeout: 20_000 });
    const preservedScroll = await page.evaluate(() => {
      const body = document.querySelector(".rich-session-supervisor-drawer-body");
      const projectButton = document.querySelector("[data-chat-autopilot-change-project]");
      if (!(body instanceof HTMLElement) || !(projectButton instanceof HTMLElement)) return null;
      body.scrollTop = Math.min(360, Math.max(0, body.scrollHeight - body.clientHeight));
      const before = body.scrollTop;
      projectButton.click();
      const after = document.querySelector(".rich-session-supervisor-drawer-body")?.scrollTop || 0;
      return { before, after };
    });
    assert.ok(preservedScroll);
    assert.ok(preservedScroll.before > 0);
    assert.ok(preservedScroll.after >= preservedScroll.before - 8, JSON.stringify(preservedScroll));

    await page.fill("[data-chat-autopilot-supervisor-input]", "Please tell the worker to inspect qualitative heatmaps before more GPU spend.");
    await page.click('[data-chat-autopilot-supervisor-submit="directive"]');
    await page.waitForFunction((sessionId) => {
      const rawQueue = window.localStorage.getItem("vibe-research-composer-queue-v1") || "{}";
      const queue = JSON.parse(rawQueue);
      const items = Array.isArray(queue[sessionId]) ? queue[sessionId] : [];
      const text = Array.from(document.querySelectorAll(".rich-session-supervisor-message"))
        .map((entry) => entry.textContent || "")
        .join(" ");
      return items.length >= 1 && /Sent to session agent|Directive sent/i.test(text);
    }, session.id, { timeout: 20_000 });
    const directiveState = await page.evaluate((sessionId) => {
      const rawQueue = window.localStorage.getItem("vibe-research-composer-queue-v1") || "{}";
      const queue = JSON.parse(rawQueue);
      const items = Array.isArray(queue[sessionId]) ? queue[sessionId] : [];
      return {
        queueCount: items.length,
        queuedText: items[0]?.text || "",
        queuedMeta: Array.from(document.querySelectorAll(".rich-session-queue-meta"))
          .map((entry) => entry.textContent?.trim() || "")[0] || "",
        messages: Array.from(document.querySelectorAll(".rich-session-supervisor-message"))
          .map((entry) => entry.textContent?.trim() || "")
          .join(" "),
      };
    }, session.id);
    assert.equal(directiveState.queueCount, 1);
    assert.match(directiveState.queuedText, /Please prioritize:/);
    assert.match(directiveState.queuedText, /qualitative heatmaps/);
    assert.match(directiveState.queuedText, /GPU\/process state/);
    assert.match(directiveState.queuedText, /validation samples\/heatmaps\/failure cases yourself/);
    assert.match(directiveState.queuedText, /safe idle GPUs\/subagents saturated/);
    assert.match(directiveState.queuedText, /literature\/current-docs/);
    assert.doesNotMatch(directiveState.queuedText, /\n/);
    assert.equal(directiveState.queuedMeta, "supervisor next step - sends after current turn");
    assert.match(directiveState.messages, /Sent to session agent|Directive sent/i);
    const directiveHighlight = await page.evaluate(() => {
      const entry = Array.from(document.querySelectorAll(".rich-session-supervisor-message"))
        .find((candidate) => /Sent to session agent|Directive sent/i.test(candidate.textContent || ""));
      if (!(entry instanceof HTMLElement)) return null;
      const style = getComputedStyle(entry);
      return {
        hasDirectiveClass: entry.classList.contains("is-directive"),
        borderColor: style.borderColor,
        backgroundColor: style.backgroundColor,
      };
    });
    assert.ok(directiveHighlight?.hasDirectiveClass);
    assert.match(directiveHighlight.borderColor, /255,\s*121,\s*109/);

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
    assert.equal(continuedAttachment.attachment.lastMessage, directiveState.queuedText);

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
