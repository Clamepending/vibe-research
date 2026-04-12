<!-- remote-vibes:managed-agent-prompt -->
<!-- Edit this from Remote Vibes or .remote-vibes/agent-prompt.md. -->

# Remote Vibes Agent Prompt

Use the repo-local wiki in `.remote-vibes/` to organize experiments, findings, and open questions following Andrej Karpathy's LLM wiki pattern.

## Architecture

- `.remote-vibes/raw/` is the immutable source layer for copied notes, manifests, and exact experiment pointers.
- `.remote-vibes/wiki/` is the maintained synthesis layer.
- `.remote-vibes/wiki/index.md` is the entrypoint.
- `.remote-vibes/wiki/log.md` is append-only and chronological.

## Working Rules

- Prefer one page per experiment family under `.remote-vibes/wiki/experiments/`.
- Use `.remote-vibes/raw/sources/` for source manifests with exact paths, commands, commits, and artifact lists.
- Distinguish observed results from interpretation.
- Keep pages terse, cross-linked, and evidence-driven.
- Make sure to make experiments reproducible and note down commit and wandb hashes of each experiment

## Ingest Workflow

1. Create or update a manifest in `.remote-vibes/raw/sources/`.
2. Update the relevant synthesized page in `.remote-vibes/wiki/experiments/`.
3. Update any cross-cutting topic pages in `.remote-vibes/wiki/topics/`.
4. Update `.remote-vibes/wiki/index.md`.
5. Append a dated entry to `.remote-vibes/wiki/log.md`.

## Query Workflow

Start from `.remote-vibes/wiki/index.md`, then drill into experiment and topic pages. Prefer citing exact source manifests and result files.

<!-- remote-vibes:wiki-v2-protocol:v2 -->

## Knowledge Model

Use `.remote-vibes/` as the workspace memory system. Treat it as a living wiki that helps future agents avoid rediscovering the same things.

- `.remote-vibes/raw/` is the exact source layer for manifests, commands, commits, paths, and artifact pointers.
- `.remote-vibes/wiki/` is the synthesized knowledge layer for durable notes.
- `.remote-vibes/wiki/index.md` is the entrypoint, not the entire knowledge system.
- `.remote-vibes/wiki/log.md` is chronological and append-only.

Prefer promoting useful findings into durable notes over leaving them trapped in terminal output.

## Knowledge Lifecycle

Not all information is equally durable.

- Keep immediate session findings lightweight at first.
- Crystallize reusable conclusions into durable notes after meaningful work.
- Prefer updating canonical notes over creating near-duplicates.
- Preserve exact provenance in `.remote-vibes/raw/sources/` when it matters.
- Keep session-local scratch local unless it becomes useful to other agents.

## Note Shapes

When useful, think in these note shapes:

- observation: a concrete finding tied to evidence
- episode: a short session digest or handoff
- topic: stable cross-session knowledge
- procedure: a reusable workflow or checklist
- entity: a page for a file, dependency, experiment family, system, or concept

You do not need rigid schemas everywhere, but write notes intentionally.

## Writing Rules

- Distinguish observation from interpretation.
- Prefer one page per experiment family under `.remote-vibes/wiki/experiments/`.
- Use `.remote-vibes/wiki/topics/` for cross-cutting knowledge.
- Record relevant commits, branches, run ids, output directories, artifact paths, and commands when they matter.
- Link graphs, images, logs, notebooks, and outputs instead of pasting bulky data.
- Prefer fewer, better notes.

When useful, include lightweight metadata or clearly labeled bullets for:
- sources
- confidence
- updated_at
- supersedes
- scope

## Search And Traversal

Do not rely only on `index.md` once the wiki grows.

- Start with the directly named files, notes, messages, or artifacts for the current task before widening the search.
- Use search over markdown filenames, headings, bodies, run ids, commits, and exact terms.
- Follow `[[wikilinks]]` and normal markdown links when they look relevant.
- Treat links as traversal hints, not decoration.
- For narrowly scoped tasks, stay anchored to the specific exchange or artifact unless the direct evidence is insufficient.
- If the task already names the evidence files to use, do not roam into older related notes unless those exact files are missing, contradictory, or clearly insufficient.
- When notes disagree, prefer the newest and best-supported understanding.
- Make uncertainty explicit when the wiki is incomplete or contradictory.

If dedicated wiki search or traversal tools exist, use them.
If not, approximate the same behavior with exact search and manual link-following.

## Crystallization And Supersession

When a session produces something reusable:

- write a short digest of the question, evidence, result, and takeaway
- update the relevant canonical page instead of leaving isolated scratch notes
- mark older claims as revised, stale, or superseded when new evidence changes them
- keep the current best understanding easy to find

Do not leave contradictory notes side by side without explanation.

## Shared Knowledge Rules

- Shared project knowledge belongs in canonical wiki pages.
- Private scratch and tentative thoughts should stay lightweight unless they become reusable.
- Routine coordination, temporary resource negotiation, and short inbox exchanges should usually stay in mailboxes or shared inboxes instead of becoming durable wiki pages.
- Promote coordination into durable notes only when it establishes reusable policy, durable project state, or a decision others will need later.
- If you cite mailbox traffic durably, prefer stable message identifiers and processed paths over inbox paths because inbox contents may later be moved or emptied.
- Do not write secrets, tokens, passwords, or sensitive material into the wiki.
- Optimize for another agent being able to pick up the work later with minimal confusion.

<!-- remote-vibes:agent-mailbox-protocol:v2 -->

## Agent Mailboxes

Use markdown inboxes for lightweight agent-to-agent coordination inside `.remote-vibes/wiki/comms/`. Keep the protocol simple and async.

- Your mailbox id is the value of `REMOTE_VIBES_SESSION_ID`.
- Create your inbox on first use at `.remote-vibes/wiki/comms/agents/<REMOTE_VIBES_SESSION_ID>/inbox/`.
- Keep handled mail in `.remote-vibes/wiki/comms/agents/<REMOTE_VIBES_SESSION_ID>/processed/`.
- To message another agent, create a new markdown file in that agent's `inbox/`. Never append to or rewrite an existing message file.
- Every message must include frontmatter with at least `from`, `from_name`, `reply_to`, `sent_at`, and `subject`.
- Route by stable session ids, but use `from_name` and `subject` to keep messages readable.
- Make `from_name` a short human-readable role or task label, not just a raw uuid, an id fragment, or a model/provider brand.
- Prefer a stable workload-oriented label such as `research agent`, `eval runner`, `checkpoint worker`, `trainer`, or `results reviewer`.
- If you do not know a better role, use a neutral label such as `agent <first 8 chars of session id>` rather than `Codex <id>` or `Claude <id>`.
- Make `subject` specific to the request or result so another agent can triage it quickly.
- `sent_at` must be an ISO 8601 UTC timestamp.
- Use one file per message. A good filename pattern is `<sent_at>-<sender>.md`, for example `2026-04-11T21-04-00Z-session-a.md`.
- When checking your inbox, first move any message older than one hour from `inbox/` into `processed/` if it has not already been moved.
- After reading or acting on a message, move it to `processed/` instead of deleting it.
- Check your inbox on startup, before long-running work, after meaningful milestones, and whenever you return to a prompt.
- Remote Vibes provides `rv-session-name` on your session `PATH`.
- At the start of meaningful work, if your current session name is still generic or no longer matches the task, run `rv-session-name "<short task label>"`.
- Keep the session name short, human-readable, and workload-oriented, for example `fib coordinator`, `results reviewer`, `trainer`, or `checkpoint worker`.
- If your task changes materially, rename the session again so the sidebar and collaboration context stay accurate.
- When practical, keep `from_name` aligned with your current session name so mailbox messages and session labels stay consistent.
- Remote Vibes provides `rv-mailwatch` on your session `PATH`, and `REMOTE_VIBES_AGENT_INBOX` points at your inbox.
- If you want new-mail pings without manual polling, prefer launching `rv-mailwatch --quiet --no-bell &` as a sidecar watcher for your inbox.
- If you are actively waiting for a reply inside a running task, prefer `rv-mailwatch --quiet --no-bell --once --timeout <seconds>` so the watcher itself becomes an observable wait step.
- If you are waiting on a shared inbox rather than your default inbox, pass it explicitly with `rv-mailwatch --inbox <path> --quiet --no-bell --once --timeout <seconds>`.
- For reply waits, prefer giving `rv-mailwatch` the peer identity and your baseline timestamp directly, for example `rv-mailwatch --inbox <path> --from <peer-session-id> --after <request-sent-at> --print-path --quiet --no-bell --once --timeout <seconds>`.
- Capture the request timestamp before or when you write the outbound message, then use that same timestamp as the `--after` baseline so replies that land quickly are still treated as new.
- After a watcher event on a shared inbox, confirm the matched message's `from` field before acting if you did not already constrain the watcher with `--from`.
- `rv-mailwatch` is cross-platform and should be preferred over OS-specific commands when available.
- If `rv-mailwatch` is unavailable, prefer platform-agnostic watcher patterns that do not depend on a single OS.
- If `watchman` is available, you may use it to watch your inbox directory and update a local flag or log when new mail arrives.
- On Linux, `inotifywait` is a reasonable fallback. On macOS, `fswatch` is a reasonable fallback. If no watcher tool exists, use periodic polling with a modest sleep interval.
- Do not run a noisy foreground watcher in the main task terminal, and keep watcher output concise enough that it acts like a ping rather than a transcript flood.
- Keep messages short, concrete, and action-oriented. Link to files, graphs, or wiki pages instead of pasting long logs.
- If you need ad hoc group coordination, create a shared inbox under `.remote-vibes/wiki/comms/groups/<topic>/inbox/` and use the same one-file-per-message pattern.

Suggested message template:

```md
---
from: <REMOTE_VIBES_SESSION_ID>
from_name: <short human-readable label>
reply_to: <REMOTE_VIBES_SESSION_ID>
sent_at: 2026-04-11T21:04:00Z
subject: One-line topic
---
Message body
```
