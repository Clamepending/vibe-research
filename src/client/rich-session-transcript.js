const RICH_SESSION_TOOL_NAMES = new Set([
  "ApplyPatch",
  "Bash",
  "Browser",
  "Edit",
  "Find",
  "Glob",
  "Grep",
  "LS",
  "MultiEdit",
  "NotebookRead",
  "Open",
  "Playwright",
  "Python",
  "Read",
  "Search",
  "Shell",
  "Task",
  "TodoWrite",
  "View",
  "WebFetch",
  "WebSearch",
  "Write",
]);

const RICH_SESSION_PROVIDER_COMMAND_PATTERN = String.raw`(?:claude|codex)`;
const RICH_SESSION_PROVIDER_BINARY_PATTERN = String.raw`(?:${RICH_SESSION_PROVIDER_COMMAND_PATTERN})(?:\.(?:bat|cmd|exe|ps1|sh))?`;
const RICH_SESSION_PROVIDER_LAUNCH_COMMAND_RE = new RegExp(
  String.raw`(?:^|['"\s;&|])(?:[^'"\s]*[\\/])*(?:${RICH_SESSION_PROVIDER_BINARY_PATTERN})(?=$|['"\s;&|])`,
  "iu",
);
const RICH_SESSION_EXPLICIT_PROVIDER_BINARY_PATH_RE = new RegExp(
  String.raw`(?:^|['"\s;&|])(?:[^'"\s]*[\\/])+(?:${RICH_SESSION_PROVIDER_BINARY_PATTERN})(?=$|['"\s;&|])`,
  "iu",
);
const RICH_SESSION_ENV_ACTIVATION_RE = /(?:^|[\s;&|])(?:\.|source)\s+['"]?[^'"\n]*(?:env|activate)(?:\.[A-Za-z0-9._-]+)?['"]?/iu;

export function renderWrappedTerminalBufferPlainText(buffer, { columns = 0 } = {}) {
  if (!buffer || typeof buffer.getLine !== "function") {
    return "";
  }

  const bufferLength = Number(buffer.length || 0);
  if (!Number.isFinite(bufferLength) || bufferLength <= 0) {
    return "";
  }

  const translateEndColumn = Number.isFinite(Number(columns)) && Number(columns) > 0 ? Number(columns) : undefined;
  const lines = [];

  for (let row = 0; row < bufferLength; row += 1) {
    const line = buffer.getLine(row);
    if (!line) {
      lines.push("");
      continue;
    }

    if (line.isWrapped) {
      continue;
    }

    let text = "";
    let lastRow = row;
    while (lastRow < bufferLength) {
      const nextLine = buffer.getLine(lastRow);
      if (!nextLine || typeof nextLine.translateToString !== "function") {
        break;
      }

      const hasWrappedNext = Boolean(buffer.getLine(lastRow + 1)?.isWrapped);
      text += nextLine.translateToString(!hasWrappedNext, 0, translateEndColumn);
      if (!hasWrappedNext) {
        break;
      }
      lastRow += 1;
    }

    lines.push(text);
    row = lastRow;
  }

  return normalizeRichSessionTranscriptText(lines.join("\n"));
}

export function normalizeRichSessionTranscriptText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/\d+(?:;\d+){2,}[A-Za-z]/gu, " ")
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim();
}

export function normalizeRichSessionComparableText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\d+(?:;\d+){2,}[A-Za-z]/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/^[›❯>]\s+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripRichSessionFrameLine(line) {
  return String(line || "")
    .trim()
    .replace(/^[│┃]\s*/u, "")
    .replace(/\s*[│┃]$/u, "")
    .trim();
}

function isRichSessionSystemBannerLine(line) {
  const trimmed = String(line || "").trim();
  return (
    /^\[vibe-research\]/iu.test(trimmed)
    // The PTY wrapper announces its workspace cwd reset before launching the
    // provider. Sometimes it carries the [vibe-research] prefix, sometimes the
    // wrapper has rewrapped it past the prefix, but the body itself is always
    // ephemeral chrome the user shouldn't see.
    || /^Shell cwd was reset to\b/iu.test(trimmed)
  );
}

// Claude Code's TUI footer rotates a few hint lines: "ctrl+t to hide tasks",
// "tab to queue message", "n% context left", etc. Tasks for the active turn
// also spawn one-line progress rows that include the spinner glyph (✦, ✶, etc),
// the task title, and a counter like "1 ✶ ✶". Both are pure presentation
// state and disappear from the TUI as the run progresses, so they should never
// be persisted into the native feed.
function isRichSessionTuiFooterLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return false;
  }

  return (
    /^ctrl\+t to (?:hide|show) tasks$/iu.test(trimmed)
    || /^shift\+tab to (?:queue|cycle).+/iu.test(trimmed)
    || /^esc to interrupt$/iu.test(trimmed)
    // Spinner-prefixed task progress: optional bullets/separators between
    // glyphs, ending with a counter that re-renders every frame.
    || /^[✦✶✻✧✩•◦*·]\s+.+(?:\.{3}|…)\s*\d+\s*[✦✶✻✧✩•◦*·]/u.test(trimmed)
    || /^[✦✶✻✧✩•◦*·][\s·*]*\d+\s+[✦✶✻✧✩•◦*·][\s·*].+(?:\.{3}|…)/u.test(trimmed)
    // Claude Code's "↓ to manage" / "↑ to scroll" footer hints.
    || /^(?:↑|↓)?\s*to\s+(?:manage|scroll|edit)\s*$/iu.test(trimmed)
    // Standalone redraw frame of the spinner phrase (no leading prose).
    || /^\s*[✦✶✻✧✩•◦*·]?\s*almost\s+done\s+thinking\b/iu.test(trimmed)
    || /^\s*[✦✶✻✧✩•◦*·]?\s*thought\s+for\s+\d+\s*s\b/iu.test(trimmed)
  );
}

function isRichSessionSeparatorLine(line) {
  const trimmed = String(line || "").trim();
  return /^[\u2500-\u257f\u2580-\u259f\u23af\-_=~]{6,}$/u.test(trimmed);
}

function isRichSessionCliFrameLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return false;
  }

  if (/^[┌┐└┘├┤┬┴┼─│┃\s]+$/u.test(trimmed)) {
    return true;
  }

  const stripped = stripRichSessionFrameLine(trimmed);
  return !stripped && /[│┃]/u.test(trimmed);
}

function isRichSessionPromptLine(line) {
  const trimmed = String(line || "").trim();
  return /^(?:❯|›|»|>)\s*$/u.test(trimmed) || /^⏵{2,}\s*bypass permissions on\b/iu.test(trimmed);
}

function isRichSessionShellPromptPrefix(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return false;
  }

  return (
    /^(?:\([^)\n]{1,24}\)\s*)*(?:PS\s+)?[\w@.~:/\\ -]*[$#%>]\s*$/u.test(trimmed)
    || /^(?:\([^)\n]{1,24}\)\s*)*[\w@.~:/\\ -]*[›❯➜](?:\s+[\w@.~:/\\-]+){0,3}\s*$/u.test(trimmed)
  );
}

function isRichSessionShellCommandLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return false;
  }

  return (
    /^(?:\([^)\n]{1,24}\)\s*)*(?:PS\s+)?[\w@.~:/\\ -]*[$#%>]\s*\S+/u.test(trimmed)
    || /^(?:\([^)\n]{1,24}\)\s*)*[\w@.~:/\\ -]*[›❯➜](?:\s+[\w@.~:/\\-]+){0,3}\s+\S+/u.test(trimmed)
  );
}

function hasRichSessionProviderLaunchCommand(text) {
  return RICH_SESSION_PROVIDER_LAUNCH_COMMAND_RE.test(String(text || ""));
}

function hasRichSessionExplicitProviderBinaryPath(text) {
  return RICH_SESSION_EXPLICIT_PROVIDER_BINARY_PATH_RE.test(String(text || ""));
}

function hasRichSessionEnvActivation(text) {
  return RICH_SESSION_ENV_ACTIVATION_RE.test(String(text || ""));
}

function isRichSessionShellLaunchFragment(text) {
  const normalized = normalizeRichSessionComparableText(text);
  if (!normalized) {
    return false;
  }

  return (
    /^(?:\.|source)\s+['"]/iu.test(normalized)
    && hasRichSessionEnvActivation(normalized)
    && hasRichSessionExplicitProviderBinaryPath(normalized)
    && /[;&|]\s*['"][^'"]+/u.test(normalized)
  );
}

function isRichSessionLaunchWrapFragment(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.length > 160 || /\s{2,}/u.test(trimmed)) {
    return false;
  }

  return (
    /[\\/]/u.test(trimmed)
    && new RegExp(String.raw`(?:^|[\\/])(?:bin[\\/])?${RICH_SESSION_PROVIDER_BINARY_PATTERN}['"]?$`, "iu").test(trimmed)
  );
}

function getRichSessionMatchCommandStartIndex(match) {
  if (!match || !Number.isFinite(match.index)) {
    return Number.POSITIVE_INFINITY;
  }

  const leadingDelimiter = /^[\s'";&|]+/u.exec(match[0]);
  return match.index + (leadingDelimiter ? leadingDelimiter[0].length : 0);
}

function getRichSessionShellLaunchPrefix(text) {
  const normalized = normalizeRichSessionComparableText(text);
  if (!normalized) {
    return "";
  }

  const startIndex = Math.min(
    getRichSessionMatchCommandStartIndex(RICH_SESSION_ENV_ACTIVATION_RE.exec(normalized)),
    getRichSessionMatchCommandStartIndex(RICH_SESSION_PROVIDER_LAUNCH_COMMAND_RE.exec(normalized)),
  );
  if (!Number.isFinite(startIndex)) {
    return normalized;
  }

  return normalized.slice(0, startIndex).trim();
}

function isRichSessionShellLaunchEchoComparableText(text) {
  const normalized = normalizeRichSessionComparableText(text);
  if (!normalized) {
    return false;
  }

  return (
    isRichSessionShellPromptPrefix(getRichSessionShellLaunchPrefix(normalized))
    && hasRichSessionProviderLaunchCommand(normalized)
    && (hasRichSessionEnvActivation(normalized) || hasRichSessionExplicitProviderBinaryPath(normalized))
  );
}

function isRichSessionShellLaunchEchoLine(line) {
  return isRichSessionShellLaunchEchoComparableText(line);
}

function isRichSessionStartupMetadataLine(line) {
  const stripped = stripRichSessionFrameLine(line);
  if (!stripped) {
    return false;
  }

  return (
    /^(?:>_\s+)?(?:OpenAI Codex|Claude Code)\b/iu.test(stripped)
    || /^gpt-[\w.-]+(?:\s+\w+)?\s+·\s+~?\//iu.test(stripped)
    || /^(?:model|directory|cwd|workspace):\s+/iu.test(stripped)
    || /^Tip:\s+Try the Codex App\b/iu.test(stripped)
    || /^Starting MCP servers\b/iu.test(stripped)
    || /^tab to queue message$/iu.test(stripped)
    || /^\d+%\s+context left$/iu.test(stripped)
    || /^Use \/skills to list available skills$/iu.test(stripped)
    || /^Do you trust the contents of this directory\?$/iu.test(stripped)
    || /^Press enter to continue$/iu.test(stripped)
    || /^Tip:\s+(?:New!?\s+)?Use \/[a-z0-9_-]+\b/iu.test(stripped)
    // Generic Tip: catch-all for the rotating Claude/Codex tooltips we don't
    // already have a more specific pattern for ("Tip: Use /btw to ask…").
    // The tip text itself is remote-driven, so an explicit allow-list rots.
    || /^(?:\*New\*\s+)?Tip:\s+/iu.test(stripped)
  );
}

function isRichSessionEphemeralLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return false;
  }

  if (
    isRichSessionSystemBannerLine(trimmed)
    || isRichSessionSeparatorLine(trimmed)
    || isRichSessionCliFrameLine(trimmed)
    || isRichSessionPromptLine(trimmed)
    || isRichSessionShellLaunchEchoLine(trimmed)
    || isRichSessionShellLaunchFragment(trimmed)
    || isRichSessionStartupMetadataLine(trimmed)
    || isRichSessionTuiFooterLine(trimmed)
  ) {
    return true;
  }

  if (/^(?:✻\s*)?brewed for\b/iu.test(trimmed)) {
    return true;
  }

  return false;
}

export function sanitizeRichSessionTranscriptText(text) {
  const normalizedText = normalizeRichSessionTranscriptText(text);
  if (!normalizedText) {
    return "";
  }

  const lines = normalizedText.split("\n").map((line) => line.replace(/\s+$/u, ""));
  const sanitizedLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    const nextLine = lines[index];
    const previousLine = lines[index - 1] || "";
    const followingLine = lines[index + 1] || "";

    if (
      isRichSessionLaunchWrapFragment(nextLine)
      && (
        isRichSessionShellLaunchEchoLine(previousLine)
        || isRichSessionShellLaunchFragment(previousLine)
        || isRichSessionShellLaunchEchoLine(followingLine)
        || isRichSessionShellLaunchFragment(followingLine)
      )
    ) {
      continue;
    }

    if (isRichSessionEphemeralLine(nextLine)) {
      continue;
    }

    if (!nextLine.trim()) {
      if (sanitizedLines.length && sanitizedLines[sanitizedLines.length - 1] !== "") {
        sanitizedLines.push("");
      }
      continue;
    }

    sanitizedLines.push(nextLine);
  }

  return normalizeRichSessionTranscriptText(sanitizedLines.join("\n"));
}

function isRichSessionStartupNoiseBlock(block) {
  const normalizedBlock = normalizeRichSessionComparableText(block);
  if (!normalizedBlock) {
    return false;
  }

  return (
    /Use \/skills to list available skills/iu.test(normalizedBlock)
    || /Starting MCP servers/iu.test(normalizedBlock)
    || /Try the Codex App\./iu.test(normalizedBlock)
    || /tab to queue message/iu.test(normalizedBlock)
    || /\bctrl\+t to (?:hide|show) tasks\b/iu.test(normalizedBlock)
    || /\bcontext left\b/iu.test(normalizedBlock)
    || /Do you trust the contents of this directory\?/iu.test(normalizedBlock)
    || /Press enter to continue/iu.test(normalizedBlock)
    || /(?:OpenAI Codex|Claude Code)/iu.test(normalizedBlock)
    || /^Shell cwd was reset to\b/iu.test(normalizedBlock)
    // Generic tooltip rotation. Anchored at the start of the comparable block
    // so a paragraph that merely *mentions* the word "Tip:" still survives.
    || /^(?:\*New\*\s+)?Tip:\s/iu.test(normalizedBlock)
    // Claude Code TUI shell counter footer ("2 shells, 1") — appears as the
    // header of the leaked task panels in the screenshot.
    || /^\d+\s+shells?,\s+\d+\s*$/iu.test(normalizedBlock)
    // Claude Code TUI tasks panel: "5 tasks (4 done, 1 open) ✓ task title …".
    // The panel re-renders on every keystroke and is already mirrored by the
    // structured TodoWrite entry above it; in the projected feed it reads as
    // a wall of partial titles and ☐/✓ glyphs, which is exactly the noise
    // shown in the DSRL screenshot.
    || /\b\d+\s+tasks?\s*\(\s*\d+\s+done\b/iu.test(normalizedBlock)
    // Claude Code's status-row spinner phrases. The TUI animates them with
    // a leading glyph + "almost done thinking" or "thought for Ns" + a
    // counter; the same line gets captured 5–10× per second when the PTY
    // is read mid-redraw. The phrase *itself* is a perfect signature.
    || /\balmost\s+done\s+thinking\b/iu.test(normalizedBlock)
    || /\bthought\s+for\s+\d+\s*s\b/iu.test(normalizedBlock)
    // Claude Code's bottom-row "↓ to manage" / "↑ to scroll" hints.
    || /^(?:↑|↓)?\s*to\s+(?:manage|scroll|edit)\s*$/iu.test(normalizedBlock)
    // Status-line text inside Claude Code's "doing X..." pill: "Generating
    // clean train2017+LVIS targets...". Anchored on the trailing ellipsis
    // and absence of a sentence terminator so prose mentions of the same
    // gerund still survive ("Generating the train2017 set is slow.").
    || /^(?:↑|↓)?\s*[A-Z][\w-]+ing\b[^.!?]*\.{3}\s*[↑↓]?\s*$/u.test(normalizedBlock)
    || (
      /^gpt-[\w.-]+(?:\s+\w+)?\s+·\s+~?\//iu.test(normalizedBlock)
      && /\b(?:model|directory|cwd|workspace):\b/iu.test(normalizedBlock)
    )
    || isRichSessionShellLaunchEchoComparableText(normalizedBlock)
  );
}

function isRichSessionEchoedInputBlock(block, recentInputs) {
  const normalizedBlock = normalizeRichSessionComparableText(block);
  if (!normalizedBlock) {
    return false;
  }

  return recentInputs.includes(normalizedBlock);
}

function isRichSessionPromptEchoBlock(block) {
  const trimmed = String(block || "").trim();
  return /^(?:›|❯|»)\s+\S.{0,280}$/u.test(trimmed) && !/\n/u.test(trimmed);
}

export function shouldSuppressRichSessionBlock(block, { recentInputs = [] } = {}) {
  return (
    isRichSessionStartupNoiseBlock(block)
    || isRichSessionEchoedInputBlock(block, recentInputs)
    || isRichSessionPromptEchoBlock(block)
  );
}

export function getRichSessionToolName(block) {
  const firstLine = String(block || "")
    .split("\n", 1)[0]
    .trim();
  const match = /^([A-Z][A-Za-z0-9_-]{1,40})\(/u.exec(firstLine);
  if (!match) {
    return "";
  }

  const name = match[1];
  return RICH_SESSION_TOOL_NAMES.has(name) ? name : "";
}

export function looksLikeRichSessionCodeBlock(block) {
  const lines = String(block || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  if (!lines.length) {
    return false;
  }

  if (lines.length === 1 && isRichSessionShellCommandLine(lines[0])) {
    return true;
  }

  if (lines.length < 2) {
    return false;
  }

  let score = 0;
  for (const line of lines.slice(0, 10)) {
    if (/^\s{2,}\S/u.test(line)) {
      score += 1;
    }
    if (/[{}[\];<>]/u.test(line)) {
      score += 0.6;
    }
    if (isRichSessionShellCommandLine(line)) {
      score += 1.4;
    }
    if (/(=>|const |let |var |function |import |export |curl |git |npm |node |python |--[a-z-]+)/u.test(line)) {
      score += 1.1;
    }
  }

  return score >= 3;
}

export function getRichSessionBlockKind(block) {
  const lines = String(block || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const firstLine = lines[0]?.trim() || "";

  if (getRichSessionToolName(block)) {
    return "tool";
  }
  // Standard git command outputs are easy to recognise and read much better
  // as a code block than as assistant prose.
  if (
    /^\[[\w./@-]+\s+[0-9a-f]{4,40}\]/u.test(firstLine)
    || /^On branch\s+\S/u.test(firstLine)
    || /^(?:Your branch is up to date|Your branch is ahead of)\b/u.test(firstLine)
    || /^Switched to (?:a new )?branch\s+/u.test(firstLine)
    || /^\s*\d+\s+files?\s+changed/u.test(firstLine)
  ) {
    return "code";
  }
  if (/^(?:recap|summary|takeaway):/iu.test(firstLine)) {
    return "recap";
  }
  if (/^(?:\*|•|-)\s/u.test(firstLine) && lines.length <= 3) {
    return "status";
  }
  if (/^(?:timeout|timed out|working|waiting|queued|running|completed|done|brew(?:ed)? for)\b/iu.test(firstLine)) {
    return "status";
  }
  if (looksLikeRichSessionCodeBlock(block)) {
    return "code";
  }

  return "message";
}

export function splitRichSessionTranscriptBlocks(text, { recentInputs = [], maxBlocks = 72 } = {}) {
  const normalizedText = sanitizeRichSessionTranscriptText(text);
  if (!normalizedText) {
    return [];
  }

  const blocks = [];
  for (const candidate of normalizedText.split(/\n{2,}/u)) {
    const block = candidate.trim();
    if (!block) {
      continue;
    }

    if (/(?:^|\n)\s*※\s*recap:/iu.test(block)) {
      continue;
    }

    if (shouldSuppressRichSessionBlock(block, { recentInputs })) {
      continue;
    }

    if (blocks[blocks.length - 1] === block) {
      continue;
    }

    blocks.push(block);
  }

  return blocks.slice(-Math.max(1, Number(maxBlocks) || 72));
}
