# Remote Vibes

## Quickstart

Minimal browser terminal to vibe code on your server/cluster via your phone/laptop on the go.

1. Install [Tailscale](https://tailscale.com/download) on your server/cluster and phone/laptop.
2. Sign into the same account on both.
3. Run this on the server/cluster:

```bash
bash <(curl -fsSL https://gist.githubusercontent.com/Clamepending/b40db6fc8775b843e6fc06a2b5857604/raw/install.sh)
```

4. Open the Tailscale URL printed in the terminal on your phone/laptop.
5. When a new GitHub Release is available, Remote Vibes shows an update-and-restart button in the app. You can also run the install command again to update.

## Raspberry Pi Quickstart

Run this on the Raspberry Pi. It installs `curl` if needed, then the installer handles git, build tools, Node.js 22.x, Remote Vibes, and startup. Coding agents like Claude, Codex, Gemini, or OpenCode are still installed separately.

```bash
bash -c 'command -v curl >/dev/null || (sudo apt-get update && sudo apt-get install -y curl ca-certificates); bash <(curl -fsSL https://gist.githubusercontent.com/Clamepending/b40db6fc8775b843e6fc06a2b5857604/raw/install.sh)'
```

## Details...

Use that gist URL directly. The repo `raw.githubusercontent.com/.../install.sh` link can get rate-limited.

By default, the installer uses the latest GitHub Release when one exists, then falls back to `main` while the project is still bootstrapping. Set `REMOTE_VIBES_UPDATE_CHANNEL=branch` or `REMOTE_VIBES_REF=<branch-or-tag>` before running the installer if you intentionally want a dev checkout.

The install command now launches Remote Vibes as a background server, so it keeps running even after the SSH session or terminal closes. The app checkout lives under `~/.remote-vibes/app`, and settings, logs, session history, and the managed pid live under `~/.remote-vibes/`.

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

Agents inside Remote Vibes also get an `rv-browser` command on `PATH`, so they can inspect localhost apps with a real browser. A few examples:

```bash
rv-browser doctor
rv-browser screenshot 4173
rv-browser run 4173 --steps-file eval-steps.json --output final.png
rv-browser run 4173 --steps '[{"action":"type","selector":"textarea","text":"make it cinematic"},{"action":"click","selector":"text=Generate"},{"action":"wait","text":"Done"},{"action":"screenshot","path":"final.png"}]'
rv-browser describe 4173 --prompt "What visual issues stand out in the rendered UI?"
rv-browser describe-file results/chart.png --prompt "Critique this chart's readability."
```

`rv-browser` is meant for arbitrary local UIs, not just Gradio. It works with anything the agent serves on `localhost` or `127.0.0.1`, captures screenshots, can click and type through a simple JSON step plan, and can ask Codex or Claude to turn a screenshot or local image into plain-text qualitative feedback. The recommended `run` actions are `type`, `click`, `select`, `wait`, and `screenshot`, with lower-level actions still available when needed.

For model training or experiment loops, the lightweight pattern is:
- serve the demo or chart on localhost and inspect it with `rv-browser screenshot`, `run`, or `describe`
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


Sessions are saved, so restarts don't erase your sessions. The file explorer lets you see image files by tapping on them (useful for graphs).
