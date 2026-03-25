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

You can access any localhost ports by clicking on it in the sidebar.

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
