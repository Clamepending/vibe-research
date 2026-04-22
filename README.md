# Vibe Research

## Quickstart

Minimal browser terminal to vibe code on your server/cluster/Mac/Raspberry Pi via your phone/laptop on the go.

1. On the machine you want to control, run `curl -fsSL https://vibe-research.net/install.sh | bash`
2. Install the [Tailscale app](https://tailscale.com/download) on your laptop/phone, sign into the same account, then open the Tailscale URL or scan the QR printed by step 1.

## Claude Code Install

Claude Code's native installer is the recommended path. Vibe Research prefers the native `~/.local/bin/claude` binary over older npm/Homebrew shims when both are present.

```bash
curl -fsSL https://claude.ai/install.sh | bash
npm uninstall -g @anthropic-ai/claude-code 2>/dev/null || true
[ -x /opt/homebrew/bin/npm ] && /opt/homebrew/bin/npm uninstall -g @anthropic-ai/claude-code || true
[ -x /usr/local/bin/npm ] && /usr/local/bin/npm uninstall -g @anthropic-ai/claude-code || true
```

## Details...

Use the `vibe-research.net` installer URL directly. It is a small stable wrapper around the canonical installer in this repo. If a very minimal machine does not have `curl` yet, install `curl` first and rerun the quickstart command.

The installer handles Tailscale, git, build tools, Node.js 22.x, Vibe Research, and startup on supported macOS/Linux/Raspberry Pi systems. Coding agents like Claude, Codex, Gemini, or OpenCode are still installed separately.

By default, the installer uses the latest GitHub Release when one exists, then falls back to `main` while the project is still bootstrapping. Set `VIBE_RESEARCH_UPDATE_CHANNEL=branch` or `VIBE_RESEARCH_REF=<branch-or-tag>` before running the installer if you intentionally want a dev checkout.

The install command now launches Vibe Research as a background server, so it keeps running even after the SSH session or terminal closes. The app checkout lives under `~/.vibe-research/app`, and settings, logs, session history, and the managed pid live under `~/.vibe-research/`. On Linux installs, `tmux` is installed too; coding-agent terminals use it when available so Vibe Research restarts can reattach to live agent work instead of merely replaying a transcript.

New sessions can be started by choosing a folder from the browser, then picking the agent provider. The knowledge base folder is configurable in the sidebar settings; by default, Vibe Research keeps local git backups of the wiki every 10 minutes. To back that wiki up off-machine, create a private Git repo, paste its SSH or credential-helper remote URL into the sidebar's private remote backup field, enable remote push, and Vibe Research will push wiki backup commits there on each backup run.

## Releases

Vibe Research uses GitHub Releases as the stable update channel. Friends' installs update to release tags like `v0.2.1`, not random in-progress commits on `main`.

The safest path is the manual GitHub Actions workflow:

1. Open GitHub Actions.
2. Select `Release`.
3. Click `Run workflow`.
4. Choose `patch`, `minor`, or `major`.

The workflow checks out a clean copy, installs Node.js 22, runs the full test suite, bumps the version, creates the tag, and publishes the GitHub Release.

You can still cut a release locally from a clean `main` checkout:

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

Both paths bump `package.json`, commit `Release vX.Y.Z`, create an annotated git tag, push `main` and the tag, then publish a GitHub Release with generated notes. The in-app updater checks the latest GitHub Release first and only falls back to `main` if no release exists yet.

You can access local app ports from the sidebar. Vibe Research prefers direct
`http://<tailscale-ip>:<port>/` links when a service is already listening on all
interfaces, offers an `expose` button for localhost-only services via Tailscale
Serve, and keeps `/proxy/<port>/` as the fallback.

Example thing I did was text my agent to fix and [pretrain GPT2-small on a 4090!](https://x.com/clamepending/status/2039185482639462763?s=20)

Agents inside Vibe Research get a Playwright CLI browser skill on `PATH` via `vr-playwright`, `playwright-cli`, and `PWCLI`. This is the preferred way for agents to inspect localhost apps with a real browser:

```bash
command -v npx >/dev/null 2>&1
export PWCLI="${PWCLI:-vr-playwright}"
"$PWCLI" open http://127.0.0.1:4173
"$PWCLI" snapshot
"$PWCLI" click e15
"$PWCLI" fill e2 "make it cinematic"
"$PWCLI" press Enter
"$PWCLI" screenshot --filename output/playwright/final.png
```

The key loop is: open the page, snapshot to get stable element refs, interact with refs from the newest snapshot, snapshot again after UI changes, and save artifacts under `output/playwright/`. `vr-playwright` runs `npx --package @playwright/cli playwright-cli`, so agents do not need a global `playwright-cli` install as long as Node/npm provide `npx`.

`vr-browser` is still available as a fallback for qualitative visual feedback from Codex or Claude:

```bash
vr-browser describe 4173 --prompt "What visual issues stand out in the rendered UI?"
vr-browser describe-file results/chart.png --prompt "Critique this chart's readability."
```

For model training or experiment loops, the lightweight pattern is:
- serve the demo or chart on localhost and inspect it with `vr-playwright open`, `snapshot`, interactions, and `screenshot`
- save generated images or plots to disk and use `vr-browser describe-file` for a qualitative read
- ask the agent to write a short keep-training / stop-training note grounded in those rendered artifacts

## ML Intern

Vibe Research detects Hugging Face's `ml-intern` CLI when it is installed and shows it as an agent provider. Install it from the upstream repo, then start an `ML Intern` session from the provider picker:

```bash
git clone https://github.com/huggingface/ml-intern.git
cd ml-intern
uv sync
uv tool install -e .
```

`ml-intern` needs `HF_TOKEN`, and usually `ANTHROPIC_API_KEY` and `GITHUB_TOKEN`, in the environment used by the Vibe Research server. `HF_TOKEN`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` can also be saved in Vibe Research under Settings -> Model Provider Keys; saved values are injected into newly started agent sessions without being returned by `/api/settings`. Sessions run in the same persistent terminal system as other agents, so a restart can reattach to live training monitors or long HF job supervision.

For a one-move Vibe Research handoff, agent sessions expose:

```bash
ml-intern "$(cat "$VIBE_RESEARCH_ML_INTERN_HANDOFF_PROMPT")"
```

That prompt tells ML Intern to keep Vibe Research as the research ledger: claim one QUEUE row, run 1-3 committed cycles, cite papers/datasets/jobs/artifacts, update the result doc and leaderboard, and push the wiki/code repos.

For a repeatable live agent smoke test inside a Vibe Research shell session, run:

```bash
node scripts/eval-vr-browser-codex.mjs --provider codex
node scripts/eval-vr-browser-codex.mjs --provider claude
```

tips:
- Press the "shift+tab" button on the top right to swap to bypass-permisisons mode to not have to approve things all the time.
- Use builtin voice to text to just speak and send commands

<p align="center">
  <a href="claude_code.jpg"><img src="claude_code.jpg" alt="Claude Code session" width="220" /></a>
  <a href="shell.jpg"><img src="shell.jpg" alt="Shell session" width="220" /></a>
</p>

<p align="center">
  <a href="menu1.jpg"><img src="menu1.jpg" alt="Sidebar sessions view" width="220" /></a>
  <a href="menu2.jpg"><img src="menu2.jpg" alt="Sidebar ports view" width="220" /></a>
</p>


Sessions are saved, and coding-agent sessions use persistent `tmux` terminals when available, so restarts are much less likely to interrupt in-progress agent work. The file explorer lets you see image files by tapping on them (useful for graphs).
