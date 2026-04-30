import assert from "node:assert/strict";
import test from "node:test";
import {
  RICH_SESSION_SLASH_COMMANDS,
  extractRichSessionImageRefs,
  extractRichSessionSlashAction,
  getRichSessionImageUrl,
  renderAnsiToHtml,
  resolveRichSessionImageRefs,
  resolveRichSessionSlashAction,
  stripAnsi,
} from "../src/client/rich-session-helpers.js";

const ESC = String.fromCharCode(0x1b); // ANSI escape (single byte)

// ============================================================================
// extractRichSessionImageRefs
// ============================================================================

test("image extractor: empty / nullish input returns []", () => {
  assert.deepEqual(extractRichSessionImageRefs(""), []);
  assert.deepEqual(extractRichSessionImageRefs(null), []);
  assert.deepEqual(extractRichSessionImageRefs(undefined), []);
});

test("image extractor: bare filename without slash is NOT extracted (too noisy)", () => {
  assert.deepEqual(extractRichSessionImageRefs("see foo.png"), []);
  assert.deepEqual(extractRichSessionImageRefs("foo.jpg"), []);
});

test("image extractor: workspace-relative paths with at least one slash ARE extracted", () => {
  assert.deepEqual(
    extractRichSessionImageRefs("see figures/x.png"),
    ["figures/x.png"],
  );
  assert.deepEqual(
    extractRichSessionImageRefs("look at deeply/nested/path/y.jpg please"),
    ["deeply/nested/path/y.jpg"],
  );
});

test("image extractor: POSIX absolute paths are extracted", () => {
  assert.deepEqual(
    extractRichSessionImageRefs("saved at /Users/x/figures/foo.png"),
    ["/Users/x/figures/foo.png"],
  );
});

test("image extractor: capital letter extensions match (case-insensitive)", () => {
  assert.deepEqual(
    extractRichSessionImageRefs("look at figures/Capture.PNG"),
    ["figures/Capture.PNG"],
  );
});

test("image extractor: deduplicates the same path mentioned twice", () => {
  assert.deepEqual(
    extractRichSessionImageRefs("see figures/x.png and again figures/x.png"),
    ["figures/x.png"],
  );
});

test("image extractor: caps at 4 refs by default to keep the strip bounded", () => {
  const text = "p1/a.png p2/b.png p3/c.png p4/d.png p5/e.png p6/f.png";
  const refs = extractRichSessionImageRefs(text);
  assert.equal(refs.length, 4);
  assert.deepEqual(refs, ["p1/a.png", "p2/b.png", "p3/c.png", "p4/d.png"]);
});

test("image extractor: respects maxRefs option", () => {
  const text = "p1/a.png p2/b.png p3/c.png";
  assert.deepEqual(
    extractRichSessionImageRefs(text, { maxRefs: 2 }),
    ["p1/a.png", "p2/b.png"],
  );
});

test("image extractor: trims trailing punctuation that landed inside the path match", () => {
  // The regex is greedy on the path-character class so a trailing period
  // ("see figures/x.png.") would otherwise become "figures/x.png." which
  // would 404 on the file endpoint.
  assert.deepEqual(
    extractRichSessionImageRefs("see figures/x.png. Also figures/y.jpg, then bye."),
    ["figures/x.png", "figures/y.jpg"],
  );
});

test("image extractor: SVG and PDF are NOT auto-embedded (kept as text/path-link)", () => {
  // Browsers can render SVG/PDF inline but with very different ergonomics
  // (PDF in particular is huge); treat them as path links only.
  assert.deepEqual(extractRichSessionImageRefs("see figures/x.svg"), []);
  assert.deepEqual(extractRichSessionImageRefs("paper at docs/paper.pdf"), []);
});

test("image extractor: skips paths inside inline code spans (`grep -rn '.png' figures/` shouldn't auto-embed)", () => {
  assert.deepEqual(
    extractRichSessionImageRefs("Run `grep -rn 'foo.png' figures/x.png` next."),
    [],
  );
});

test("image extractor: includeMarkdown=true pulls path out of ![alt](path)", () => {
  assert.deepEqual(
    extractRichSessionImageRefs("![dropped image](figures/x.png)", { includeMarkdown: true }),
    ["figures/x.png"],
  );
});

test("image extractor: includeMarkdown=true handles ![alt](<path with spaces>) angle-bracket form", () => {
  assert.deepEqual(
    extractRichSessionImageRefs("![hi](<figures/x.png>)", { includeMarkdown: true }),
    ["figures/x.png"],
  );
});

test("image extractor: includeMarkdown=true handles ![alt](path \"title\") syntax", () => {
  assert.deepEqual(
    extractRichSessionImageRefs('![hi](figures/x.png "Caption text")', { includeMarkdown: true }),
    ["figures/x.png"],
  );
});

test("image extractor: empty alt text in markdown still extracts", () => {
  assert.deepEqual(
    extractRichSessionImageRefs("![](figures/x.png)", { includeMarkdown: true }),
    ["figures/x.png"],
  );
});

test("image extractor: includeMarkdown=false does NOT double-extract paths inside ![](...)", () => {
  // Markdown image syntax is stripped before plain-path scanning so the same
  // path doesn't appear twice when the assistant uses both forms in one msg.
  assert.deepEqual(
    extractRichSessionImageRefs("![alt](figures/x.png) and figures/y.png"),
    ["figures/y.png"],
  );
});

test("image extractor: handles ANSI cursor noise + image path on same line", () => {
  // Codex-style cursor escapes shouldn't blow up extraction.
  assert.deepEqual(
    extractRichSessionImageRefs("[2K saved figures/x.png"),
    ["figures/x.png"],
  );
});

// ============================================================================
// extractRichSessionSlashAction
// ============================================================================

test("slash action: 'Please run /login' → /login button", () => {
  const action = extractRichSessionSlashAction("Please run /login · API Error: 401");
  assert.deepEqual(action, { command: "/login", label: "Sign in" });
});

test("slash action: 'authentication_failed' alone → /login button (no explicit Please run)", () => {
  const action = extractRichSessionSlashAction("authentication_failed\nInvalid authentication credentials");
  assert.deepEqual(action, { command: "/login", label: "Sign in" });
});

test("slash action: case-insensitive match", () => {
  const action = extractRichSessionSlashAction("PLEASE RUN /LOGIN before continuing");
  assert.deepEqual(action, { command: "/login", label: "Sign in" });
});

test("slash action: 'Please run /clear' → /clear button (not /login)", () => {
  const action = extractRichSessionSlashAction("Please run /clear to reset context.");
  assert.deepEqual(action, { command: "/clear", label: "Clear context" });
});

test("slash action: prose mention without 'Please run' returns null", () => {
  // A user who *talks about* /login in their message shouldn't get a button
  // injected onto every status entry that quotes them.
  assert.equal(extractRichSessionSlashAction("As a side note, /login lets you authenticate."), null);
});

test("slash action: empty / null returns null", () => {
  assert.equal(extractRichSessionSlashAction(""), null);
  assert.equal(extractRichSessionSlashAction(null), null);
});

test("slash action: registry covers all 7 commands wired into the menu", () => {
  const commands = RICH_SESSION_SLASH_COMMANDS.map((entry) => entry.command);
  assert.deepEqual(commands.sort(), [
    "/clear",
    "/compact",
    "/help",
    "/login",
    "/logout",
    "/model",
    "/resume",
  ]);
});

// ============================================================================
// getRichSessionImageUrl
// ============================================================================

test("image url: empty path returns empty string", () => {
  assert.equal(getRichSessionImageUrl(""), "");
  assert.equal(getRichSessionImageUrl(null), "");
});

test("image url: workspace-relative path uses /api/files/content", () => {
  const url = getRichSessionImageUrl("figures/x.png", { workspaceRoot: "/Users/me/proj" });
  assert.match(url, /^\/api\/files\/content\?/);
  const params = new URL(url, "http://x").searchParams;
  assert.equal(params.get("root"), "/Users/me/proj");
  assert.equal(params.get("path"), "figures/x.png");
});

test("image url: absolute path inside workspace root → relative + /api/files/content", () => {
  const url = getRichSessionImageUrl("/Users/me/proj/figures/x.png", {
    workspaceRoot: "/Users/me/proj",
  });
  const params = new URL(url, "http://x").searchParams;
  assert.equal(params.get("path"), "figures/x.png");
});

test("image url: absolute path under attachments dir → /api/attachments/file (regardless of workspace root)", () => {
  const url = getRichSessionImageUrl("/var/state/attachments/sessions/abc/2026-04-29/img.png", {
    workspaceRoot: "/Users/me/proj",
  });
  assert.match(url, /^\/api\/attachments\/file\?/);
  const params = new URL(url, "http://x").searchParams;
  assert.equal(params.get("path"), "/var/state/attachments/sessions/abc/2026-04-29/img.png");
});

test("image url: absolute path outside workspace root AND not an attachment returns ''", () => {
  // Renderer falls back to the path link instead of a broken <img>.
  const url = getRichSessionImageUrl("/etc/passwd.png", {
    workspaceRoot: "/Users/me/proj",
  });
  assert.equal(url, "");
});

test("image url: trailing slash on workspace root is normalised", () => {
  const url = getRichSessionImageUrl("/Users/me/proj/figures/x.png", {
    workspaceRoot: "/Users/me/proj/",
  });
  const params = new URL(url, "http://x").searchParams;
  assert.equal(params.get("path"), "figures/x.png");
});

test("image url: workspace root '/' is treated as missing (so we don't auto-serve / as the root)", () => {
  const url = getRichSessionImageUrl("etc/passwd.png", { workspaceRoot: "/" });
  assert.equal(url, "");
});

test("image url: query string params are URL-encoded for paths with spaces", () => {
  const url = getRichSessionImageUrl("figures/my file.png", { workspaceRoot: "/Users/me/proj" });
  assert.match(url, /path=figures%2Fmy\+file\.png/);
});

// ============================================================================
// renderAnsiToHtml + stripAnsi
// ============================================================================

test("ansi: empty input returns empty string", () => {
  assert.equal(renderAnsiToHtml(""), "");
  assert.equal(renderAnsiToHtml(null), "");
  assert.equal(renderAnsiToHtml(undefined), "");
});

test("ansi: plain text without escapes is HTML-escaped, not wrapped in spans", () => {
  assert.equal(renderAnsiToHtml("hello world"), "hello world");
  assert.equal(renderAnsiToHtml("a < b > c"), "a &lt; b &gt; c");
});

test("ansi: red foreground (31m) wraps text in a coloured span", () => {
  const html = renderAnsiToHtml(`${ESC}[31mPlease run /login${ESC}[0m`);
  assert.match(html, /<span style="color:[^"]+">Please run \/login<\/span>/);
  assert.match(html, /color:#ff7b72/);  // red maps to GitHub-ish red
});

test("ansi: green foreground (32m) maps to GitHub green", () => {
  const html = renderAnsiToHtml(`${ESC}[32mok${ESC}[0m`);
  assert.match(html, /color:#7ee787/);
});

test("ansi: bold + colour combine into one span style", () => {
  const html = renderAnsiToHtml(`${ESC}[1;31mERROR${ESC}[0m`);
  assert.match(html, /font-weight:600/);
  assert.match(html, /color:#ff7b72/);
});

test("ansi: reset code 0 closes the span and unsets state", () => {
  const html = renderAnsiToHtml(`${ESC}[31mred${ESC}[0m plain`);
  // 'plain' must NOT be inside any span (state was reset).
  const tail = html.slice(html.lastIndexOf("</span>") + "</span>".length);
  assert.equal(tail, " plain");
});

test("ansi: implicit reset (empty params: ESC[m) unsets state", () => {
  const html = renderAnsiToHtml(`${ESC}[31mred${ESC}[m plain`);
  assert.match(html, /<\/span> plain$/);
});

test("ansi: switching colours mid-string closes one span before opening the next", () => {
  const html = renderAnsiToHtml(`${ESC}[31mred${ESC}[32mgreen${ESC}[0m`);
  assert.match(html, /color:#ff7b72">red<\/span>.*color:#7ee787">green<\/span>/);
});

test("ansi: HTML special characters inside coloured segments are escaped", () => {
  const html = renderAnsiToHtml(`${ESC}[31m<script>${ESC}[0m`);
  assert.equal(html.includes("<script>"), false, `unsafe HTML survived: ${html}`);
  assert.match(html, /&lt;script&gt;/);
});

test("ansi: unsupported codes (background, 256-colour) are silently ignored", () => {
  // 48;5;X is a 256-colour BACKGROUND escape — we don't support it; output
  // should be the plain text.
  const html = renderAnsiToHtml(`${ESC}[48;5;196mhi${ESC}[0m`);
  assert.equal(html.includes("style="), false, `unexpected style: ${html}`);
  assert.match(html, /hi/);
});

test("ansi: cursor-movement CSI (e.g. ESC[2K) is left intact (renderer doesn't drop it)", () => {
  // The render function targets SGR (m-terminated). Non-m sequences pass
  // through unchanged because the upstream parser is the one that strips
  // them. The native feed already runs that parser before reaching here.
  const html = renderAnsiToHtml(`${ESC}[2Kfoo`);
  // Non-SGR escapes pass through. Verify no exception, and the text 'foo'
  // appears.
  assert.match(html, /foo/);
});

test("ansi: stripAnsi removes both CSI and OSC sequences", () => {
  assert.equal(stripAnsi(`${ESC}[31mred${ESC}[0m`), "red");
  assert.equal(stripAnsi(`prefix${ESC}]0;Title${ESC}\\suffix`), "prefixsuffix");
});

test("ansi: custom escape callback is invoked for each plain segment (path linkifier integration)", () => {
  const segments = [];
  const result = renderAnsiToHtml(`${ESC}[31mred${ESC}[0m green${ESC}[32mgreen-text${ESC}[0m`, {
    escape: (segment) => {
      segments.push(segment);
      return `<X>${segment}</X>`;
    },
  });
  assert.deepEqual(segments, ["red", " green", "green-text"]);
  assert.match(result, /<X>red<\/X>/);
  assert.match(result, /<X>green-text<\/X>/);
});

test("ansi: slash-action detection works on coloured 'Please run /login'", () => {
  // Real bug from the auth_failed screenshot: the agent's red error string
  // had ANSI codes wrapping "/login". Without ANSI stripping in the
  // detector, the regex /please\s+run\s+\/login/ would miss because of the
  // `[31m` and `[0m` bytes inside.
  const action = extractRichSessionSlashAction(`${ESC}[31mPlease run /login${ESC}[0m`);
  assert.deepEqual(action, { command: "/login", label: "Sign in" });
});

test("ansi: image extractor cleans coloured paths so the tile gets the bare path", () => {
  // Bash plot scripts often emit `saved [32mfigures/x.png[0m`.
  const refs = extractRichSessionImageRefs(`saved ${ESC}[32mfigures/x.png${ESC}[0m`);
  assert.deepEqual(refs, ["figures/x.png"]);
});

// ============================================================================
// resolveRichSessionSlashAction / resolveRichSessionImageRefs — schema-only
// resolvers used by the renderer. After the schema rollout, every producer
// emits structured fields directly, so the resolvers are now thin readers
// of `entry.slashAction` / `entry.imageRefs`. The regex extractors stay
// exported because the producers themselves use them at parse time.
// ============================================================================

test("resolver: reads structured slashAction field when present", () => {
  const entry = { kind: "status", text: "unrelated body", slashAction: { command: "/login", label: "Sign in" } };
  assert.deepEqual(resolveRichSessionSlashAction(entry), { command: "/login", label: "Sign in" });
});

test("resolver: returns null when slashAction is absent (no regex fallback)", () => {
  // Renderer-side resolver no longer regexes the prose. The shaper is
  // responsible for stamping the field; if it didn't, the entry has no
  // action attached.
  const entry = { kind: "status", text: "Authentication failed: please reauthenticate" };
  assert.equal(resolveRichSessionSlashAction(entry), null);
});

test("resolver: returns null on missing/null entry", () => {
  assert.equal(resolveRichSessionSlashAction({ kind: "status", text: "all good" }), null);
  assert.equal(resolveRichSessionSlashAction(null), null);
});

test("resolver: reads structured imageRefs field when present", () => {
  const entry = { kind: "tool", text: "see foo", imageRefs: ["figures/a.png", "figures/b.png"] };
  assert.deepEqual(resolveRichSessionImageRefs(entry), ["figures/a.png", "figures/b.png"]);
});

test("resolver: returns [] when imageRefs absent (no regex fallback)", () => {
  const entry = { kind: "tool", text: "saved to figures/x.png" };
  assert.deepEqual(resolveRichSessionImageRefs(entry), []);
});
