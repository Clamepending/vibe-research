# Remote Vibes

Minimal browser terminal to vibe code on your laptop via your phone on the go.

1. Install [Tailscale](https://tailscale.com/download) on your laptop and phone.
2. Sign into the same account on both.
3. Run this on the laptop:

```bash
bash <(curl -fsSL https://gist.githubusercontent.com/Clamepending/b40db6fc8775b843e6fc06a2b5857604/raw/install.sh)
```

4. Open the Tailscale URL printed in the terminal on your phone.
5. Run the same command again any time you want to update.

Use that gist URL directly. The repo `raw.githubusercontent.com/.../install.sh` link can get rate-limited.

The install command now launches Remote Vibes as a background server, so it keeps running even after the SSH session or terminal closes. Logs and the managed pid live under `~/.remote-vibes/.remote-vibes/`.

You can access any localhost ports by clicking on it in the sidebar.

Agents inside Remote Vibes also get an `rv-browser` command on `PATH`, so they can inspect localhost apps with a real browser. A few examples:

```bash
rv-browser doctor
rv-browser screenshot 4173
rv-browser run 4173 --steps-file eval-steps.json --output final.png
rv-browser describe 4173 --prompt "What visual issues stand out in the rendered UI?"
rv-browser describe-file results/chart.png --prompt "Critique this chart's readability."
```

`rv-browser` is meant for arbitrary local UIs, not just Gradio. It works with anything the agent serves on `localhost` or `127.0.0.1`, captures screenshots, can click/fill/upload files through a simple JSON step plan, and can ask Codex or Claude to turn a screenshot or local image into plain-text qualitative feedback.

For model training or experiment loops, the lightweight pattern is:
- serve the demo or chart on localhost and inspect it with `rv-browser screenshot`, `run`, or `describe`
- save generated images or plots to disk and use `rv-browser describe-file` for a qualitative read
- ask the agent to write a short keep-training / stop-training note grounded in those rendered artifacts

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
