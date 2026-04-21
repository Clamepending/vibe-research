# Remote Vibes

## Quickstart

Minimal browser terminal to vibe code on your server/cluster/Mac/Raspberry Pi via your phone/laptop on the go.

1. On the machine you want to control, run `curl -fsSL https://vibe-research.net/install.sh | bash`
2. Install the [Tailscale app](https://tailscale.com/download) on your laptop/phone, sign into the same account, then open the Tailscale URL or scan the QR printed by step 1.

## Claude Code Install

Claude Code's native installer is the recommended path. Remote Vibes prefers the native `~/.local/bin/claude` binary over older npm/Homebrew shims when both are present.

```bash
curl -fsSL https://claude.ai/install.sh | bash
npm uninstall -g @anthropic-ai/claude-code 2>/dev/null || true
[ -x /opt/homebrew/bin/npm ] && /opt/homebrew/bin/npm uninstall -g @anthropic-ai/claude-code || true
[ -x /usr/local/bin/npm ] && /usr/local/bin/npm uninstall -g @anthropic-ai/claude-code || true
```

## Details...

Use the `vibe-research.net` installer URL directly. It is a small stable wrapper around the canonical installer in this repo. If a very minimal machine does not have `curl` yet, install `curl` first and rerun the quickstart command.

The installer handles Tailscale, git, build tools, Node.js 22.x, Remote Vibes, and startup on supported macOS/Linux/Raspberry Pi systems. Coding agents like Claude, Codex, Gemini, or OpenCode are still installed separately.

By default, the installer uses the latest GitHub Release when one exists, then falls back to `main` while the project is still bootstrapping. Set `REMOTE_VIBES_UPDATE_CHANNEL=branch` or `REMOTE_VIBES_REF=<branch-or-tag>` before running the installer if you intentionally want a dev checkout.

The install command now launches Remote Vibes as a background server, so it keeps running even after the SSH session or terminal closes. The app checkout lives under `~/.remote-vibes/app`, and settings, logs, session history, and the managed pid live under `~/.remote-vibes/`. On Linux installs, `tmux` is installed too; coding-agent terminals use it when available so Remote Vibes restarts can reattach to live agent work instead of merely replaying a transcript.

New sessions can be started by choosing a folder from the browser, then picking the agent provider. The knowledge base folder is configurable in the sidebar settings; by default, Remote Vibes keeps local git backups of the wiki every 10 minutes. To back that wiki up off-machine, create a private Git repo, paste its SSH or credential-helper remote URL into the sidebar's private remote backup field, enable remote push, and Remote Vibes will push wiki backup commits there on each backup run.

## Releases

Remote Vibes uses GitHub Releases as the stable update channel. Friends' installs update to release tags like `v0.2.1`, not random in-progress commits on `main`.

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

You can access local app ports from the sidebar. Remote Vibes prefers direct
`http://<tailscale-ip>:<port>/` links when a service is already listening on all
interfaces, offers an `expose` button for localhost-only services via Tailscale
Serve, and keeps `/proxy/<port>/` as the fallback.

Example thing I did was text my agent to fix and [pretrain GPT2-small on a 4090!](https://x.com/clamepending/status/2039185482639462763?s=20)

Agents inside Remote Vibes get a Playwright CLI browser skill on `PATH` via `rv-playwright`, `playwright-cli`, and `PWCLI`. This is the preferred way for agents to inspect localhost apps with a real browser:

```bash
command -v npx >/dev/null 2>&1
export PWCLI="${PWCLI:-rv-playwright}"
"$PWCLI" open http://127.0.0.1:4173
"$PWCLI" snapshot
"$PWCLI" click e15
"$PWCLI" fill e2 "make it cinematic"
"$PWCLI" press Enter
"$PWCLI" screenshot --filename output/playwright/final.png
```

The key loop is: open the page, snapshot to get stable element refs, interact with refs from the newest snapshot, snapshot again after UI changes, and save artifacts under `output/playwright/`. `rv-playwright` runs `npx --package @playwright/cli playwright-cli`, so agents do not need a global `playwright-cli` install as long as Node/npm provide `npx`.

`rv-browser` is still available as a fallback for qualitative visual feedback from Codex or Claude:

```bash
rv-browser describe 4173 --prompt "What visual issues stand out in the rendered UI?"
rv-browser describe-file results/chart.png --prompt "Critique this chart's readability."
```

For model training or experiment loops, the lightweight pattern is:
- serve the demo or chart on localhost and inspect it with `rv-playwright open`, `snapshot`, interactions, and `screenshot`
- save generated images or plots to disk and use `rv-browser describe-file` for a qualitative read
- ask the agent to write a short keep-training / stop-training note grounded in those rendered artifacts

For a repeatable live agent smoke test inside a Remote Vibes shell session, run:

```bash
node scripts/eval-rv-browser-codex.mjs --provider codex
node scripts/eval-rv-browser-codex.mjs --provider claude
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
