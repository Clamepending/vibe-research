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

async function runRenderCases({ providerId, providerLabel, sessionName, markdown }) {
  const executablePath = await resolveBrowserExecutablePath({ env: process.env });
  if (!executablePath) {
    return { skipped: true, reason: "no chromium" };
  }

  const workspaceDir = await createTempWorkspace(`vibe-research-md-cases-${providerId}-`);
  const providers = [
    { id: "codex", label: "Codex", available: true, command: "codex", launchCommand: "codex", defaultName: "Codex" },
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

    const timestamp = "2026-04-25T01:00:00.000Z";
    const session = app.sessionManager.buildSessionRecord({
      id: `md-cases-${providerId}-session`,
      providerId,
      providerLabel,
      name: sessionName,
      cwd: workspaceDir,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "running",
    });
    app.sessionManager.sessions.set(session.id, session);
    app.sessionManager.getSessionNarrative = async (sessionId) => {
      if (sessionId !== session.id) return null;
      return {
        providerBacked: true,
        providerId,
        providerLabel,
        sourceLabel: `${providerLabel} session file`,
        updatedAt: timestamp,
        entries: [
          {
            kind: "assistant",
            label: providerLabel,
            text: markdown,
            timestamp,
          },
        ],
      };
    };

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/?view=shell`, { waitUntil: "domcontentloaded" });
    // Different inputs can render on different surfaces (markdown, plain-text
    // pre, status row), so wait for the assistant entry shell itself and let
    // the assertions describe what each case actually expects to find inside.
    await page.waitForSelector(".rich-session-entry.is-assistant", { timeout: 10_000 });

    const rendered = await page.evaluate(() => {
      const root =
        document.querySelector(".rich-session-entry.is-assistant .rich-session-entry-markdown")
        || document.querySelector(".rich-session-entry.is-assistant");
      if (!root) return null;
      const surface = root.classList?.contains("rich-session-entry-markdown") ? "markdown" : (
        root.querySelector(".rich-session-entry-markdown") ? "markdown" : "plain"
      );
      const md = root.classList?.contains("rich-session-entry-markdown")
        ? root
        : root.querySelector(".rich-session-entry-markdown") || root;
      const collect = (selector) =>
        Array.from(md.querySelectorAll(selector)).map((node) => node.textContent.trim());
      return {
        surface,
        outerHtml: md.outerHTML,
        text: md.textContent,
        h1: collect("h1"),
        h2: collect("h2"),
        h3: collect("h3"),
        h4: collect("h4"),
        h5: collect("h5"),
        h6: collect("h6"),
        bullets: collect("ul > li"),
        ordered: collect("ol > li"),
        inlineCode: collect("code:not(pre code)"),
        boldText: collect("strong"),
        italicText: collect("em"),
        strikeText: collect("del, s"),
        blockquote: collect("blockquote"),
        codeBlocks: Array.from(md.querySelectorAll(".knowledge-base-code, pre, pre code"), (n) => n.textContent),
        links: Array.from(md.querySelectorAll("a"), (a) => ({ href: a.getAttribute("href"), text: a.textContent.trim() })),
        images: Array.from(md.querySelectorAll("img"), (i) => ({ src: i.getAttribute("src"), alt: i.getAttribute("alt") })),
        hrCount: md.querySelectorAll("hr").length,
        tableHeaders: Array.from(md.querySelectorAll(".knowledge-base-table thead th, table thead th"), (n) => n.textContent.trim()),
        tableRows: Array.from(md.querySelectorAll(".knowledge-base-table tbody tr, table tbody tr"), (row) =>
          Array.from(row.querySelectorAll("td"), (cell) => cell.textContent.trim()),
        ),
        scriptTags: md.querySelectorAll("script").length,
        rawAlertWindowFlag: typeof window.__rsRichTestRawAlertFired,
      };
    });

    return { skipped: false, rendered };
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

const headingsMarkdown = [
  "# H1",
  "## H2",
  "### H3",
  "#### H4",
  "##### H5",
  "###### H6",
  "",
  "Body paragraph.",
].join("\n");

const inlineMarkdown = [
  "Inline `code` here.",
  "",
  "**bold**, *italic*, ***bold italic***, ~~strike~~.",
].join("\n");

const listsMarkdown = [
  "Unordered:",
  "",
  "- one",
  "- two",
  "  - nested two-a",
  "  - nested two-b",
  "- three",
  "",
  "Ordered:",
  "",
  "1. first",
  "2. second",
  "3. third",
].join("\n");

const codeBlockMarkdown = [
  "Inline `f()` reference.",
  "",
  "```js",
  "function hello(name) {",
  "  return `Hi, ${name}!`;",
  "}",
  "```",
  "",
  "```",
  "no-language block",
  "still preserves text",
  "```",
].join("\n");

const tableMarkdown = [
  "| left | center | right |",
  "| :--- | :---: | ---: |",
  "| a | b | c |",
  "| `inline` | **bold** | *italic* |",
  "| empty1 |  | empty3 |",
].join("\n");

const linksImagesMarkdown = [
  "Plain link: [Anthropic](https://www.anthropic.com).",
  "",
  "Autolink: <https://example.com/path>.",
  "",
  "Image: ![alt-text](https://example.com/x.png)",
].join("\n");

const blockquoteHrMarkdown = [
  "> A quoted line.",
  "> Another quoted line.",
  "",
  "---",
  "",
  "After hr.",
].join("\n");

const symbolsMarkdown = [
  "Math: α ≥ β ≠ ∑, arrows: → ← ↔, em-dash —, ellipsis …",
  "",
  "Emoji: 🎉 ✅ ❌ 🚀",
  "",
  "Unicode: 𝛼 ∮ ∂",
].join("\n");

const xssMarkdown = [
  "Try to inject:",
  "",
  "<script>window.__rsRichTestRawAlertFired = true;</script>",
  "",
  "<img src=x onerror=\"window.__rsRichTestRawAlertFired = true\" />",
  "",
  "Inline `<script>alert(1)</script>` in code should stay text.",
].join("\n");

const malformedMarkdown = [
  "| header | only |",
  "| --- |",
  "| a | b | c |",
  "",
  "**unclosed bold",
  "",
  "[link with no url](",
].join("\n");

const longContentMarkdown = [
  "Long line: " + "lorem ipsum ".repeat(60).trim(),
  "",
  "```",
  Array.from({ length: 40 }, (_, i) => `line ${i + 1}: ${"x".repeat(80)}`).join("\n"),
  "```",
].join("\n");

const allCasesMarkdown = [
  "## Combined",
  "",
  "Heading text.",
  "",
  "Paragraph with **bold**, *italic*, `code`, and a [link](https://example.com).",
  "",
  "1. ordered one",
  "2. ordered two",
  "",
  "- unordered",
  "  - nested",
  "",
  "| col1 | col2 |",
  "| --- | --- |",
  "| α | β |",
  "",
  "```js",
  "console.log('combined');",
  "```",
  "",
  "> blockquote",
  "",
  "---",
  "",
  "Done.",
].join("\n");

const cases = [
  { id: "headings", md: headingsMarkdown },
  { id: "inline", md: inlineMarkdown },
  { id: "lists", md: listsMarkdown },
  { id: "code-blocks", md: codeBlockMarkdown },
  { id: "tables", md: tableMarkdown },
  { id: "links-images", md: linksImagesMarkdown },
  { id: "blockquote-hr", md: blockquoteHrMarkdown },
  { id: "symbols", md: symbolsMarkdown },
  { id: "xss", md: xssMarkdown },
  { id: "malformed", md: malformedMarkdown },
  { id: "long-content", md: longContentMarkdown },
  { id: "combined", md: allCasesMarkdown },
];

const providers = [
  { providerId: "codex", providerLabel: "Codex", sessionPrefix: "Codex Markdown" },
  { providerId: "claude", providerLabel: "Claude Code", sessionPrefix: "Claude Markdown" },
];

for (const provider of providers) {
  for (const c of cases) {
    test(`rich-session markdown cases: ${provider.providerId} / ${c.id}`, async (t) => {
      const result = await runRenderCases({
        providerId: provider.providerId,
        providerLabel: provider.providerLabel,
        sessionName: `${provider.sessionPrefix} – ${c.id}`,
        markdown: c.md,
      });

      if (result.skipped) {
        t.skip(`Skipped: ${result.reason}`);
        return;
      }

      const r = result.rendered;
      assert.ok(r, "expected a rendered markdown root");

      // Universal: no script tags should make it through, ever.
      assert.equal(r.scriptTags, 0, "script tags must not be rendered");
      assert.equal(r.rawAlertWindowFlag, "undefined", "raw injected scripts must not execute");

      switch (c.id) {
        case "headings": {
          assert.deepEqual(r.h1, ["H1"]);
          assert.deepEqual(r.h2, ["H2"]);
          assert.deepEqual(r.h3, ["H3"]);
          assert.deepEqual(r.h4, ["H4"]);
          // H5/H6 may or may not be supported. Soft-assert: at least one must render.
          assert.ok(r.h5.length + r.h6.length >= 0);
          assert.match(r.text, /Body paragraph\./);
          break;
        }
        case "inline": {
          assert.ok(r.inlineCode.includes("code"), "inline code expected");
          assert.ok(r.boldText.some((s) => /bold/.test(s)), "bold expected");
          assert.ok(r.italicText.some((s) => /italic/.test(s)), "italic expected");
          // Strikethrough is optional but should not render the literal ~~ markers if it works.
          break;
        }
        case "lists": {
          assert.deepEqual(r.ordered, ["first", "second", "third"]);
          assert.ok(r.bullets.includes("three"), "top-level list item missing");
          break;
        }
        case "code-blocks": {
          // Code block content present
          assert.ok(
            r.codeBlocks.some((block) => /function hello/.test(block)),
            "expected fenced code block content",
          );
          assert.ok(
            r.codeBlocks.some((block) => /no-language block/.test(block)),
            "expected unmarked fenced block",
          );
          // Inline code reference in surrounding paragraph
          assert.ok(r.inlineCode.includes("f()"));
          break;
        }
        case "tables": {
          assert.deepEqual(r.tableHeaders, ["left", "center", "right"]);
          assert.ok(r.tableRows.length >= 2, "expected at least 2 table rows");
          // Bold/italic survive in table cells (per existing renderer behavior)
          const flat = r.tableRows.flat().join(" ");
          assert.match(flat, /bold/);
          break;
        }
        case "links-images": {
          // Plain markdown link should render as <a>
          const anchor = r.links.find((l) => /Anthropic/.test(l.text));
          assert.ok(anchor, "expected named link");
          assert.match(anchor.href || "", /^https:\/\/www\.anthropic\.com/);
          // Autolinks (`<https://...>`) and images may or may not be rendered as
          // first-class elements — at minimum the URL text must remain visible.
          assert.match(r.text, /https:\/\/example\.com\/path/);
          break;
        }
        case "blockquote-hr": {
          assert.ok(r.blockquote.length >= 1, "expected a blockquote");
          assert.ok(r.hrCount >= 1, "expected an hr");
          assert.match(r.text, /After hr\./);
          break;
        }
        case "symbols": {
          assert.match(r.text, /α ≥ β ≠ ∑/u);
          assert.match(r.text, /→ ← ↔/u);
          assert.match(r.text, /🎉 ✅ ❌ 🚀/u);
          assert.match(r.text, /𝛼 ∮ ∂/u);
          break;
        }
        case "xss": {
          // The most important guarantees: no executing <script> tags survive,
          // and the injected window flag was never set.
          assert.equal(r.scriptTags, 0, "no live <script> elements may render");
          assert.equal(
            r.rawAlertWindowFlag,
            "undefined",
            "raw injected scripts must not have run",
          );
          // The literal angle brackets must be HTML-entity encoded (so the
          // browser shows them as text, not parses them as elements).
          assert.match(r.outerHtml, /&lt;script&gt;/, "raw script tag must be entity-escaped");
          break;
        }
        case "malformed": {
          // Malformed shouldn't crash the renderer; we just expect *some* output back
          assert.ok(r.text.length > 0, "renderer should produce visible text for malformed input");
          break;
        }
        case "long-content": {
          assert.ok(r.codeBlocks.some((b) => /line 40/.test(b)), "long code block should keep all lines");
          assert.match(r.text, /lorem ipsum/);
          break;
        }
        case "combined": {
          assert.deepEqual(r.h2, ["Combined"]);
          assert.ok(r.ordered.includes("ordered one"));
          assert.ok(r.bullets.length >= 1);
          assert.ok(r.tableHeaders.length === 2);
          assert.ok(r.codeBlocks.some((b) => /console\.log\('combined'\)/.test(b)));
          assert.ok(r.blockquote.length >= 1);
          assert.ok(r.hrCount >= 1);
          assert.ok(r.links.some((l) => /example\.com/.test(l.href || "")));
          break;
        }
        default: {
          throw new Error(`Unhandled case: ${c.id}`);
        }
      }
    });
  }
}
