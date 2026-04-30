// Pure helpers used by the native chat renderer. Extracted so the test suite
// can hit them directly without a full DOM/Playwright run.

// ============================================================================
// ANSI SGR (Select Graphic Rendition) → HTML span colour conversion.
// ============================================================================
//
// CLI agents lean on terminal colors heavily — red for errors, green for OK,
// yellow for warnings, blue for paths. Stripping ANSI entirely makes the
// native feed feel washed out compared to the terminal view. We support the
// 16 standard foreground colours (codes 30-37, 90-97), bold (1), italic (3),
// underline (4), and the resets that turn each off. Background colours and
// 256/24-bit truecolour are deliberately skipped — they're rare in practice
// and add risk (unbounded inline styles) for marginal benefit.
//
// Output is escaped HTML with `<span style="...">` wrappers; the caller can
// run a path linkifier on the inner text segments without breaking spans.

const ANSI_FG_COLORS = {
  30: "#9aa0a6", 31: "#ff7b72", 32: "#7ee787", 33: "#f0c674",
  34: "#79c0ff", 35: "#d2a8ff", 36: "#56d4dd", 37: "#e6e6e6",
  90: "#6e7681", 91: "#ffa198", 92: "#aff5b4", 93: "#f8e3a1",
  94: "#a5c8ff", 95: "#e5b8ff", 96: "#9efeff", 97: "#ffffff",
};

const ANSI_SEQUENCE_RE = /\u001b\[((?:\d+(?:;\d+)*)?)m/gu;

function escapeAnsiHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function buildAnsiStyleString(state) {
  const parts = [];
  if (state.fgColor) parts.push(`color:${state.fgColor}`);
  if (state.bold) parts.push("font-weight:600");
  if (state.italic) parts.push("font-style:italic");
  if (state.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

function applyAnsiCodes(state, codes) {
  for (const codeStr of codes.split(";")) {
    const code = Number(codeStr || 0);
    if (!Number.isFinite(code) || code === 0) {
      // Reset all attributes — code 0 OR an empty `[m` form.
      state.fgColor = "";
      state.bold = false;
      state.italic = false;
      state.underline = false;
      continue;
    }
    if (code === 1) { state.bold = true; continue; }
    if (code === 22) { state.bold = false; continue; }
    if (code === 3) { state.italic = true; continue; }
    if (code === 23) { state.italic = false; continue; }
    if (code === 4) { state.underline = true; continue; }
    if (code === 24) { state.underline = false; continue; }
    if (code === 39) { state.fgColor = ""; continue; }
    if (ANSI_FG_COLORS[code]) {
      state.fgColor = ANSI_FG_COLORS[code];
      continue;
    }
    // Unknown / unsupported codes (background colours, 256-colour, etc.)
    // are silently ignored — the spans they produce would be unbounded and
    // are rarely necessary for the assistant-feed use case.
  }
}

// Converts a string with ANSI SGR codes to HTML spans. The `escape` callback
// transforms each plain-text segment between codes (default is HTML escape;
// callers like the native feed can pass a function that ALSO linkifies file
// paths inside the segment, since path linkification has to run on plain
// text — applying it after we've inserted spans would tangle markup).
export function renderAnsiToHtml(text, { escape = escapeAnsiHtml } = {}) {
  const source = String(text ?? "");
  if (!source) {
    return "";
  }

  let out = "";
  let cursor = 0;
  let openSpan = false;
  const state = { fgColor: "", bold: false, italic: false, underline: false };

  const closeSpanIfOpen = () => {
    if (openSpan) {
      out += "</span>";
      openSpan = false;
    }
  };

  const openSpanIfStyled = () => {
    const style = buildAnsiStyleString(state);
    if (style) {
      out += `<span style="${style}">`;
      openSpan = true;
    }
  };

  for (const match of source.matchAll(ANSI_SEQUENCE_RE)) {
    const segment = source.slice(cursor, match.index);
    if (segment) {
      if (!openSpan) openSpanIfStyled();
      out += escape(segment);
    }
    closeSpanIfOpen();
    applyAnsiCodes(state, match[1] || "");
    cursor = match.index + match[0].length;
  }

  const tail = source.slice(cursor);
  if (tail) {
    if (!openSpan) openSpanIfStyled();
    out += escape(tail);
  }
  closeSpanIfOpen();

  return out;
}

// Strip ANSI sequences (CSI + OSC) from a string without colour conversion.
// Used by callers that want raw text for matching/comparison even when the
// terminal output had colours.
export function stripAnsi(value) {
  return String(value ?? "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");
}


export const RICH_SESSION_INLINE_IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp)\b/iu;

// Slash commands the native composer recognises. Order matters: the slash
// menu surfaces them top-down. The `aliases` array is the prose triggers
// for the inline action button (e.g. "Please run /login" on an auth_failed
// status entry).
//
// This is the BUILT-IN catalog. The composer prefers the server-emitted
// list on `session.availableSlashCommands` when present (see
// resolveRichSessionSlashCommands below) — that's the path per-session
// custom commands take when we add them. Today the server doesn't emit
// a custom list yet; the menu falls through to this static array.
export const RICH_SESSION_SLASH_COMMANDS = [
  { command: "/login", label: "Sign in", hint: "Open Claude login flow", aliases: [/please\s+run\s+\/login/iu, /authentication[_\s]?(?:failed|error)/iu, /invalid\s+authentication\s+credentials/iu] },
  { command: "/logout", label: "Sign out", hint: "Sign out of the current Claude account", aliases: [/please\s+run\s+\/logout/iu] },
  { command: "/clear", label: "Clear context", hint: "Reset Claude's conversation memory", aliases: [/please\s+run\s+\/clear/iu] },
  { command: "/compact", label: "Compact context", hint: "Compress prior turns", aliases: [/please\s+run\s+\/compact/iu] },
  { command: "/model", label: "Pick a model", hint: "Switch the Claude model", aliases: [/please\s+run\s+\/model/iu] },
  { command: "/help", label: "Help", hint: "Show available commands", aliases: [/please\s+run\s+\/help/iu] },
  { command: "/resume", label: "Resume", hint: "Resume a previous Claude session", aliases: [/please\s+run\s+\/resume/iu] },
];

// Pulls the slash command catalog for a session. Prefers the server-
// emitted `session.availableSlashCommands` (each entry: {command, label,
// hint?, aliases?}) when present; falls back to the static built-in
// catalog. The aliases / hint fields are optional; missing values fall
// back to sensible defaults so the menu never ships a half-empty row.
export function resolveRichSessionSlashCommands(session) {
  const list = Array.isArray(session?.availableSlashCommands) ? session.availableSlashCommands : null;
  if (!list || !list.length) {
    return RICH_SESSION_SLASH_COMMANDS;
  }
  return list
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const command = String(entry.command || "").trim();
      if (!command || !command.startsWith("/")) return null;
      return {
        command,
        label: String(entry.label || command).trim(),
        hint: String(entry.hint || "").trim(),
        aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
      };
    })
    .filter(Boolean);
}

// Server-side narrative shaper now emits `entry.slashAction = {command,label}`
// directly. This regex-based extractor is kept as a fallback for legacy
// entries (sessions that started before the structured field was wired up,
// or projected/transcript-backed sessions whose entry path doesn't have the
// shaper enriching them). New rendering code paths should prefer
// `entry.slashAction` and only fall back to this when missing.
export function extractRichSessionSlashAction(text) {
  // Strip ANSI before matching so colour-coded errors (red "Please run
  // /login") still trigger the inline action button.
  const value = stripAnsi(String(text || ""));
  if (!value) {
    return null;
  }

  for (const entry of RICH_SESSION_SLASH_COMMANDS) {
    if (entry.aliases?.some((pattern) => pattern.test(value))) {
      return { command: entry.command, label: entry.label };
    }
  }

  return null;
}

// Resolves a slash action for an entry. Reads the structured field set by
// the server-side narrative shaper. Every producer (claude/codex stream,
// projected transcript, gemini) now enriches entries with this field
// before they hit the wire, so the renderer is a pure function of the
// schema. The legacy regex fallback was removed; the underlying
// extractRichSessionSlashAction stays exported for the producers and the
// unit tests that still pin its behaviour.
export function resolveRichSessionSlashAction(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  if (entry.slashAction && typeof entry.slashAction.command === "string") {
    return {
      command: entry.slashAction.command,
      label: entry.slashAction.label || entry.slashAction.command,
    };
  }
  return null;
}

// Resolves the image refs for an entry. Reads the structured field set by
// the server-side narrative shaper. See resolveRichSessionSlashAction for
// why the regex fallback was removed.
export function resolveRichSessionImageRefs(entry, options = {}) {
  if (!entry || typeof entry !== "object") {
    return [];
  }
  if (Array.isArray(entry.imageRefs) && entry.imageRefs.length) {
    return entry.imageRefs.slice(0, options.maxRefs || 4);
  }
  return [];
}

// Pulls every plausible image path out of a CLI / assistant text block.
// Catches:
//   * POSIX absolute: /Users/.../foo.png
//   * Workspace-relative: figures/foo.png, src/img/x.jpg
// Bare filenames like "foo.png" with no slash are skipped (too noisy).
export function extractRichSessionImageRefs(text, { includeMarkdown = false, maxRefs = 4 } = {}) {
  const seen = new Set();
  const out = [];
  // Strip ANSI before extraction so a coloured "saved [32mfigures/x.png[0m"
  // still produces a clean "figures/x.png" tile.
  const source = stripAnsi(String(text ?? ""));
  if (!source) {
    return out;
  }

  const trimTrailingPunct = (raw) => {
    let trimmed = String(raw || "");
    while (trimmed.length && /[.,;:!?)\]]/u.test(trimmed[trimmed.length - 1])) {
      trimmed = trimmed.slice(0, -1);
    }
    return trimmed;
  };

  const pushIfImage = (raw) => {
    const trimmed = trimTrailingPunct(raw);
    if (!trimmed) return;
    if (!RICH_SESSION_INLINE_IMAGE_EXTENSIONS.test(trimmed)) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  // Pull paths out of markdown image syntax explicitly when the caller asks
  // for it. Used for user-message entries (which don't render markdown via
  // the knowledge-base renderer) and for tool entries that paste in an
  // attachment reference.
  if (includeMarkdown) {
    for (const match of source.matchAll(/!\[[^\]]*\]\(<?([^)<>\s]+)(?:\s+"[^"]*")?>?\)/gu)) {
      pushIfImage(match[1]);
      if (out.length >= maxRefs) {
        return out;
      }
    }
  }

  // Strip markdown image syntax before scanning for plain paths so we don't
  // double-extract a path that already appeared inside ![](...) above.
  const sanitized = source.replace(/!\[[^\]]*\]\([^)]+\)/gu, "");

  // Skip text inside ` `-delimited inline code: every plot script's grep
  // -rn output ends up here, and embedding all of it bloats the feed.
  const codeStripped = sanitized.replace(/`[^`]*`/g, "");

  const re = /(\/(?:[\w.@~+-]+(?:\s\w[\w.@~+-]*)*\/)+[\w.@~+-]+\.[A-Za-z0-9]{2,8}|(?:[\w.@~+-]+\/)+[\w.@~+-]+\.[A-Za-z0-9]{2,8})/gu;
  for (const match of codeStripped.matchAll(re)) {
    pushIfImage(match[1]);
    if (out.length >= maxRefs) {
      break;
    }
  }

  return out;
}

// Resolves an image path to a URL the renderer can drop into <img src=...>.
// Three cases:
//   1. Absolute path under the vibe-research attachments dir (drag/paste
//      uploads) — route through /api/attachments/file.
//   2. Absolute path inside the active workspace root, OR a workspace-
//      relative path — route through /api/files/content.
//   3. Anything else (absolute path outside both) → return "" and let the
//      renderer fall back to the path link.
export function getRichSessionImageUrl(rawPath, { workspaceRoot = "" } = {}) {
  const trimmed = String(rawPath || "").trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("/") && /\/attachments\/sessions\//u.test(trimmed)) {
    return `/api/attachments/file?${new URLSearchParams({ path: trimmed }).toString()}`;
  }

  const root = String(workspaceRoot || "").replace(/\/+$/u, "") || "/";
  let relativePath = "";

  if (trimmed.startsWith("/")) {
    if (root && (trimmed === root || trimmed.startsWith(`${root}/`))) {
      relativePath = trimmed === root ? "" : trimmed.slice(root.length + 1);
    }
  } else {
    relativePath = trimmed;
  }

  if (!relativePath || !root || root === "/") {
    return "";
  }

  const params = new URLSearchParams({ root, path: relativePath });
  return `/api/files/content?${params.toString()}`;
}
