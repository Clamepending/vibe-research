# Claude Code stream-json mode (migration sketch)

Status: design + Phase 1 building block. No client-facing runtime changes
yet — the existing PTY path is still what every Claude session uses.

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

**Phase 0 — protocol experiment (done).**
- `bin/vr-claude-stream-experiment` spawns the wrapped `bin/claude` in
  stream-json mode, sends one prompt, and pretty-prints every event line.
  Confirmed locally: Claude emits `system:init`, `rate_limit_event`,
  `assistant` (with `text`, `thinking`, `tool_use` content blocks), `user`
  (with `tool_result` content), and a final `result` event — the same shape
  the transcript file uses.

**Phase 1 — building block, no session-manager wiring (done).**
- `src/claude-stream-session.js` exports `ClaudeStreamSession`, a plain
  EventEmitter wrapping the spawn + JSONL streams. It owns the child
  process, parses each event line, builds narrative entries via the
  existing `buildClaudeNarrativeFromText`, and emits `event` / `entries` /
  `turn-complete` / `exit`.
- `bin/vr-claude-stream-chat` is an interactive multi-turn REPL on top of
  the class. Confirmed multi-turn works against a real Claude install
  without any PTY involvement.

**Phase 2 — opt-in stream-mode session in the server.**
- Add `VIBE_RESEARCH_CLAUDE_STREAM_MODE=1` env flag.
- Wire `ClaudeStreamSession` into `src/session-manager.js` so that when the
  flag is on AND the provider is Claude Code AND the user is already
  authenticated, new sessions use the stream class. Reuse the existing
  rich-session UI — entries are already in the right shape.
- Existing sessions and unauthenticated starts keep using PTY.

**Phase 3 — hide the xterm tab for stream-mode sessions.**
- Default the workspace view to rich-session for stream-mode sessions.
- Optional debug pane to view raw stdout.

**Phase 4 — own the auth + trust handoff.**
- Detect `not authenticated` exit and show our own login overlay.
- Pre-write workspace trust to `~/.claude/settings.json` so no prompt fires.

**Phase 5 — flip the default + remove the projection fallback for Claude.**
- Once Phase 2–4 cover the path the user normally hits, default the flag on.
- Keep PTY mode reachable per-session for debugging.

**Phase 6 — Codex.**
- Codex doesn't ship a stream JSON I/O mode today. Keep PTY for Codex until
  upstream adds one (or we contribute it). The Codex projection path stays,
  but with Claude removed it's a much smaller surface to keep working.

## Try it

```
bin/vr-claude-stream-experiment --prompt "hello, who are you?"
bin/vr-claude-stream-chat
```

Both go through the same wrapper Claude binary the rest of the app uses,
so they pick up your existing auth + workspace trust automatically.
