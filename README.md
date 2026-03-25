# Remote Vibes

1. Install Tailscale on your computer and your phone.
2. Make sure both are signed into the same Tailnet.
3. Make sure the host laptop has Node.js 20+.
4. Run:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Clamepending/remote-vibes/main/install.sh)
```

5. Open the Tailscale URL printed in the terminal on your phone.

If raw GitHub access is not available, use:

```bash
git clone git@github.com:Clamepending/remote-vibes.git && cd remote-vibes && ./start.sh
```
