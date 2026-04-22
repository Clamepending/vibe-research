# Security Policy

Vibe Research is a local-first control plane for coding-agent terminals. It can
start local agent sessions, read and write selected workspace files, proxy local
ports, and store provider settings. Treat access to a running Vibe Research
instance like access to the machine running it.

## Official Sources

- Website: https://vibe-research.net
- Repository: https://github.com/Clamepending/vibe-research
- Releases: https://github.com/Clamepending/vibe-research/releases
- Installer: `curl -fsSL https://vibe-research.net/install.sh | bash`

Do not run installers, update commands, or BuildingHub catalogs from lookalike
domains, unrelated forks, or social posts that do not point back to these
official sources.

## Supported Versions

Security fixes are shipped through GitHub Releases. The in-app updater and the
installer both track the latest stable release by default.

If you are reporting a vulnerability, please include the output of:

```bash
cd ~/.vibe-research/app
git describe --tags --always --dirty
git rev-parse HEAD
```

## Reporting A Vulnerability

Please do not open a public issue for a vulnerability that could expose user
machines, credentials, private files, or agent sessions.

Use GitHub private vulnerability reporting if it is enabled for the repository.
If that is unavailable, contact the maintainer through the official GitHub
profile and ask for a private security channel.

Include:

- affected version or commit
- operating system and install method
- concise reproduction steps
- impact and what an attacker can access or change
- whether the issue is already public

## Deployment Guidance

Vibe Research is intended for localhost, trusted LAN, or private Tailscale use.
Do not expose port `4123` or any Vibe Research URL to the open internet unless
you put a separate authentication layer in front of it.

For safest local-only use:

```bash
VIBE_RESEARCH_HOST=127.0.0.1 ~/.vibe-research/app/start.sh
```

If you use a reverse proxy, Cloudflare Tunnel, ngrok, or Tailscale Funnel, put
authentication in front of the app and assume anyone who reaches it can control
local agent sessions.

## Release Integrity

Releases publish checksum assets where available:

- `install.sh`
- `release.json`
- `SHASUMS256.txt`

Before a high-trust install, compare the downloaded installer checksum against
the checksum attached to the GitHub Release.
