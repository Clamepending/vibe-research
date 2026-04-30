import assert from "node:assert/strict";
import test from "node:test";
import {
  getRichSessionBlockKind,
  normalizeRichSessionComparableText,
  renderWrappedTerminalBufferPlainText,
  sanitizeRichSessionTranscriptText,
  splitRichSessionTranscriptBlocks,
} from "../src/client/rich-session-transcript.js";

function createTerminalBuffer(lines) {
  return {
    length: lines.length,
    getLine(index) {
      const line = lines[index];
      if (!line) {
        return null;
      }

      return {
        isWrapped: Boolean(line.isWrapped),
        translateToString(trimRight) {
          const text = String(line.text || "");
          return trimRight ? text.replace(/\s+$/u, "") : text;
        },
      };
    },
  };
}

test("rich session transcript merges wrapped buffer lines before filtering startup noise", () => {
  const buffer = createTerminalBuffer([
    { text: "[vibe-research] persistent terminal: created vibe-research-4990df63-5b5a-4ad" },
    { text: "7-8521-da5a4cc52592", isWrapped: true },
    { text: "(base) ➜  user . '/Users/mark/.vibe-research/vibe-research-system/comms/agents/4990df63-5b5a-4ad" },
    { text: "7-8521-da5a4cc52592/env.sh'; '/Users/mark/Desktop/projects/vibe-research/bin/codex'", isWrapped: true },
    { text: "Use /skills to list available skills" },
    { text: "Investigating startup handling now." },
  ]);

  const transcript = renderWrappedTerminalBufferPlainText(buffer, { columns: 120 });
  assert.match(transcript, /vibe-research-4990df63-5b5a-4ad7-8521-da5a4cc52592/);
  assert.match(transcript, /\/Users\/mark\/Desktop\/projects\/vibe-research\/bin\/codex/);
  assert.equal(sanitizeRichSessionTranscriptText(transcript), "Investigating startup handling now.");
});

test("rich session transcript suppresses framed Codex startup banners", () => {
  const transcript = `
gpt-5.4 xhigh · ~/vibe-projects/vibe-research/user
│ >_ OpenAI Codex (v0.122.0-alpha.13)           │
│                                               │
│ model:     gpt-5.4 xhigh   /model to change   │
│ directory: ~/vibe-projects/vibe-research/user │
  Tip: Try the Codex App. Run 'codex app' or visit
  Starting MCP servers (1/2): codex_apps (0s • esc to interrupt)

I checked the startup path and found the renderer was treating soft-wrapped CLI lines as separate messages.
`;

  assert.deepEqual(
    splitRichSessionTranscriptBlocks(transcript, { maxBlocks: 10 }),
    ["I checked the startup path and found the renderer was treating soft-wrapped CLI lines as separate messages."],
  );
});

test("rich session transcript suppresses provider launch echoes across common shell prompts", () => {
  const transcript = `
mark@macbook:~/repo$ source /tmp/codex-session/env.sh && /usr/local/bin/codex

(base) ➜  user . '/Users/mark/.vibe-research/session/env.sh'; '/Applications/Codex.app/Contents/Resources/codex'

PS C:\\Users\\mark\\repo> . .\\env.ps1; codex

The session is ready for real work now.
`;

  assert.deepEqual(
    splitRichSessionTranscriptBlocks(transcript, { maxBlocks: 10 }),
    ["The session is ready for real work now."],
  );
});

test("rich session transcript keeps prose that merely mentions launch commands", () => {
  const transcript = `
If you need to repro locally, run \`source /tmp/codex-session/env.sh && /usr/local/bin/codex\`.

That example should stay visible because it is guidance, not a prompt echo.
`;

  assert.deepEqual(
    splitRichSessionTranscriptBlocks(transcript, { maxBlocks: 10 }),
    [
      "If you need to repro locally, run `source /tmp/codex-session/env.sh && /usr/local/bin/codex`.",
      "That example should stay visible because it is guidance, not a prompt echo.",
    ],
  );
});

test("rich session transcript suppresses bootstrap fragments even when the shell prompt is missing", () => {
  const transcript = `
h/bin/codex'
. '/Users/mark/.vibe-research/vibe-research-system/comms/agents/3de08590-5e3f-43fc-acb2-23efd51dcdf3/env.sh'; '/Users/mark/Desktop/projects/vibe-research/bin/codex'

The actual response starts after the bootstrap line.
`;

  assert.deepEqual(
    splitRichSessionTranscriptBlocks(transcript, { maxBlocks: 10 }),
    ["The actual response starts after the bootstrap line."],
  );
});

test("rich session transcript suppresses echoed recent inputs but keeps later responses", () => {
  const recentInputs = [normalizeRichSessionComparableText("hello there")];
  const transcript = `
hello there

I searched the startup transcript and found the prompt echo is coming from the shell wrapper.
`;

  assert.deepEqual(
    splitRichSessionTranscriptBlocks(transcript, { recentInputs, maxBlocks: 10 }),
    ["I searched the startup transcript and found the prompt echo is coming from the shell wrapper."],
  );
});

test("rich session transcript suppresses prompt-style input echoes after reloads", () => {
  const transcript = `
› hello

I searched the transcript after reload and only the agent response should remain.
`;

  assert.deepEqual(
    splitRichSessionTranscriptBlocks(transcript, { maxBlocks: 10 }),
    ["I searched the transcript after reload and only the agent response should remain."],
  );
});

test("rich session transcript keeps generic shell commands as snippets instead of assistant prose", () => {
  const transcript = `
$ npm test -- --runInBand

The renderer should keep real terminal work visible.
`;

  const blocks = splitRichSessionTranscriptBlocks(transcript, { maxBlocks: 10 });
  assert.deepEqual(blocks, [
    "$ npm test -- --runInBand",
    "The renderer should keep real terminal work visible.",
  ]);
  assert.equal(getRichSessionBlockKind(blocks[0]), "code");
  assert.equal(getRichSessionBlockKind(blocks[1]), "message");
});

test("rich session transcript strips Claude Code TUI footer hints and ✦ task progress lines", () => {
  const transcript = `
ctrl+t to hide tasks

✦ · 3 ✦ * Run doctor and fix README placeholder rows... * 1 * *

✦ Run doctor and fix README placeholder rows... 1 ✶ ✶

Tip: Use /btw to ask a quick side question without interrupting Claude's current work

  Tip: New! Use /memory to manage Claude's persistent memory

The actual response begins here.
`;

  assert.deepEqual(
    splitRichSessionTranscriptBlocks(transcript, { maxBlocks: 10 }),
    ["The actual response begins here."],
  );
});

test("rich session transcript drops the [vibe-research] shell cwd reset notice in any leading position", () => {
  const transcript = `
[vibe-research] Shell cwd was reset to /home/ogata/mac-brain/projects/bidir-video-rl-bench

Shell cwd was reset to /home/ogata/mac-brain/projects/bidir-video-rl-bench

Continuing the actual conversation.
`;

  assert.deepEqual(
    splitRichSessionTranscriptBlocks(transcript, { maxBlocks: 10 }),
    ["Continuing the actual conversation."],
  );
});

test("rich session transcript merges hard-wrapped paths back together so file paths stay clickable", () => {
  const buffer = createTerminalBuffer([
    { text: "Shell cwd was reset to /home/ogata/mac-brain/projects/bidir-vid" },
    { text: "eo-rl-bench", isWrapped: true },
    { text: "" },
    { text: "Investigation continues." },
  ]);

  const transcript = renderWrappedTerminalBufferPlainText(buffer, { columns: 64 });
  assert.match(transcript, /bidir-video-rl-bench/);
  assert.equal(sanitizeRichSessionTranscriptText(transcript), "Investigation continues.");
});

test("rich session transcript classifies a git-style commit summary as a code block, not assistant prose", () => {
  const block = "[main b27b686] bidir-video-rl-bench: bench-v1-init resolved\n 3 files changed, 6 insertions(+), 10 deletions(-)";
  assert.equal(getRichSessionBlockKind(block), "code");
});

test("rich session transcript drops Claude Code TUI task panels (e.g. '5 tasks (4 done, 1 open) ✓ ...') from projection", () => {
  // The DSRL session screenshot showed Snippet entries containing the TUI's
  // tasks panel inlined into a projected snippet. The panel is pure UI state
  // — already rendered above as the assistant's TodoWrite — and pollutes the
  // feed when it leaks through transcript projection.
  const transcript = `
The variant misses the falsifier band by 0.4σ — borderline.

   5  tasks ( 4  done, 1  open)
       ✓  Fix 3 REINFORCE bugs (first-ba…
       ✓  Phase 7-lite: auto-tuned KL α …
       □  A/B comparison: Phase 7-lite v…
       ✓  Image bench Phase 1: launch DS…
       ✓  Wave 1.5: re-run SDXL cells wi…

Continuing the analysis with the planned reruns.
`;

  assert.deepEqual(
    splitRichSessionTranscriptBlocks(transcript, { maxBlocks: 10 }),
    [
      "The variant misses the falsifier band by 0.4σ — borderline.",
      "Continuing the analysis with the planned reruns.",
    ],
  );
});

test("rich session transcript drops the '2 shells, N' header that prefixes leaked TUI status panels", () => {
  // Matches the Snippet headers in the DSRL screenshot. The "2 shells, 1"
  // line is the Claude Code TUI footer counting active shells; it has no
  // useful information for the native feed.
  const transcript = `
2 shells, 1

The plan stays the same.
`;

  assert.deepEqual(
    splitRichSessionTranscriptBlocks(transcript, { maxBlocks: 10 }),
    ["The plan stays the same."],
  );
});

test("rich session transcript strips the startup artifact mix shown in the rich session snippet", () => {
  const transcript = `
[vibe-research] Codex session ready
[vibe-research] cwd: /Users/mark/vibe-projects/vibe-research/user
[vibe-research] persistent terminal: created vibe-research-4990df63-5b5a-4ad7-8521-da5a4cc52592
[vibe-research] browser skill: export PWCLI="\${PWCLI:-vr-playwright}"; "$PWCLI" open http://127.0.0.1:4173
[vibe-research] inspect UI: "$PWCLI" snapshot; use fresh refs with click/fill/type/press
[vibe-research] save artifacts: "$PWCLI" screenshot --filename output/playwright/current.png
[vibe-research] visual fallback: vr-browser describe-file results/chart.png --prompt "What should improve?"
[vibe-research] building guides: sed -n '1,220p' "$VIBE_RESEARCH_BUILDING_GUIDES_INDEX"
[vibe-research] launching: /Applications/Codex.app/Contents/Resources/codexAssistant
(base) ➜  user . '/Users/mark/.vibe-research/vibe-research-system/comms/agents/4990df63-5b5a-4ad7-8521-da5a4cc52592/env.sh'; '/Users/mark/Desktop/projects/vibe-research/bin/codex'
› Use /skills to list available skills
gpt-5.4 xhigh · ~/vibe-projects/vibe-research/user
│ >_ OpenAI Codex (v0.122.0-alpha.13)           │
│                                               │
│ model:     gpt-5.4 xhigh   /model to change   │
│ directory: ~/vibe-projects/vibe-research/user │
  Tip: Try the Codex App. Run 'codex app' or visit
  Tip: New! Use /fast to enable our fastest inference with increased plan usage.
  Starting MCP servers (1/2): codex_apps (0s • esc to interrupt)
› hello

Investigating startup handling now.
`;

  assert.deepEqual(
    splitRichSessionTranscriptBlocks(transcript, { maxBlocks: 10 }),
    ["Investigating startup handling now."],
  );
});
