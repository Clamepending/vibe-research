# Claude Code stream-json mode (migration sketch)

Status: design + experiment script. No runtime behavior changes yet.

## Why

Today every Claude Code session runs as a TUI inside an xterm.js PTY. We
extract structured replies through two paths:

1. **provider-backed narrative** (good): we read the JSONL transcript Claude
   Code writes to `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`,
   parse it via `buildClaudeNarrativeFromText`, and render entries directly.
2. **projected narrative** (brittle): when the transcript file isn't found
   yet (no captured session id, slow disk write, fresh session), we fall back
   to scraping `session.buffer` (raw xterm bytes) and running heuristics in
   `filterProjectedOverlayEntries` to guess which lines were assistant
   replies, tool calls, or noise.

The brittle path is the source of:

- "Codex command flashes giant in the chat after every prompt" — the wrapped
  shell echo of the launch command escapes the length-based filter.
- "Claude doesn't reply but is doing work" — long replies get dropped by the
  `length > 4000` cap (was 700), and entries that contain both prose and a
  tool call get dropped by the `Bash|ApplyPatch|Edit(...` regex.

Each fix is a heuristic stacked on a heuristic. The right move is to stop
scraping the TUI and read the structured stream directly.

## Target architecture

Claude Code's CLI supports a fully streaming, structured I/O mode that the
official SDK uses internally:

```
claude --input-format stream-json --output-format stream-json --verbose [--session-id <id> | --resume <id>]
```

- stdin: one JSON message per line. User turns look like
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`.
- stdout: one JSON event per line — `assistant`, `tool_use`, `tool_result`,
  `permission-mode`, `result`, etc. Same shape as the transcript file we
  already parse.

A "stream-mode" Claude session would:

1. Spawn `bin/claude --input-format stream-json --output-format stream-json
   --verbose --session-id <session.id>` as a regular child_process (not a
   PTY). No xterm involved.
2. Pipe stdout through a line splitter and feed each line into a streaming
   variant of `buildClaudeNarrativeFromText`. Push entries straight onto
   `session.nativeNarrativeEntries` and broadcast them like we do today.
3. Forward the rich-session composer's submit event as a single JSON line on
   stdin — no PTY echo, no Ctrl-U trick, no 'press enter twice' staging.
4. Hide the xterm tab for these sessions (or keep a "raw stdout" debug pane
   behind a flag).

## What we lose

- **In-app auth flow.** Claude Code's first-run login uses the TUI's "press
  enter to log in" flow. In stream mode the CLI errors if it isn't already
  authenticated. We need to detect the unauthenticated case and either drop
  back to PTY for the login dance, or surface our own "open this URL"
  handoff.
- **Workspace-trust prompt.** Today we scrape `hasClaudeWorkspaceTrustPrompt`
  to auto-answer. In stream mode we need to set the trust config in
  `~/.claude/settings.json` (or pass `--add-dir`) before launch so no prompt
  fires.
- **Slash commands typed into the TUI.** `/model`, `/config`, etc. — would
  need our own pickers, or a "drop to terminal" escape hatch.
- **Resume-on-rerun semantics from the TUI.** We can still pass `--resume
  <id>`; we just need to manage that ourselves.

## What we gain

- No `filterProjectedOverlayEntries`. No `length > 4000` magic. No "is this
  line a wrapped shell command echo?" pattern matching.
- Native rendering of every event type — markdown blocks, code blocks, tool
  calls, tool results — exactly as Claude emitted them.
- Reliable input — no shell quoting, no race between the TUI being ready and
  us pushing input.
- Easier streaming UX — token-by-token assistant deltas are already in the
  protocol.

## Migration plan

**Phase 0 — protocol experiment (this PR).**
- Ship a standalone script `bin/vr-claude-stream-experiment` that spawns the
  wrapped `bin/claude` in stream-json mode, sends one prompt, and pretty-
  prints every event line. Lets us validate the protocol on a real machine
  with the user's existing Claude install before wiring anything into the
  session manager.

**Phase 1 — opt-in stream-mode session, no UI changes.**
- Add `VIBE_RESEARCH_CLAUDE_STREAM_MODE=1` env flag.
- Introduce `ClaudeStreamSession` alongside the existing PTY-backed session
  in `src/session-manager.js`. When the flag is on AND the provider is
  Claude Code AND the user is already authenticated, new sessions use the
  stream class. Reuse `buildClaudeNarrativeFromText` as a line streamer.
- Existing sessions and unauthenticated starts keep using PTY.

**Phase 2 — hide the xterm tab for stream-mode sessions.**
- Default the workspace view to rich-session for stream-mode sessions.
- Optional debug pane to view raw stdout.

**Phase 3 — own the auth + trust handoff.**
- Detect `not authenticated` exit and show our own login overlay.
- Pre-write workspace trust to `~/.claude/settings.json` so no prompt fires.

**Phase 4 — flip the default + remove the projection fallback for Claude.**
- Once Phase 1–3 cover the path the user normally hits, default the flag on.
- Keep PTY mode reachable per-session for debugging.

**Phase 5 — Codex.**
- Codex doesn't ship a stream JSON I/O mode today. Keep PTY for Codex until
  upstream adds one (or we contribute it). The Codex projection path stays,
  but with Claude removed it's a much smaller surface to keep working.

## Out of scope for this PR

Everything past Phase 0. No new runtime code path, no flag honored at
runtime — just docs and an experiment script.
