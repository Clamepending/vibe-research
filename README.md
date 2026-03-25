# Remote Vibes

Remote Vibes is a tiny browser terminal hub for your laptop. Start it with one command, open the link from your phone over Tailscale, unlock it with a short passcode, and spin up live shell windows that can auto-launch `claude`, `codex`, `gemini`, or just a plain shell.

## What it does

- Creates multiple terminal windows backed by real PTYs on the host laptop
- Streams live output over websockets to a mobile-friendly web UI
- Lets each new session choose a provider preset and a working directory
- Adds a quick command bar for phone dictation or one-shot commands
- Protects the app with a passcode and session cookie

## Quick start

```bash
./start.sh
```

On first run that will install dependencies, build the client bundle, and start the server.

At startup the app prints:

- a passcode
- `localhost` and LAN/Tailscale URLs
- which agent CLIs are installed on the host

Open the printed URL on your phone, enter the passcode once, and create a session.

## Session presets

- `Claude Code`: opens a shell and runs `claude`
- `Codex`: opens a shell and runs `codex`
- `Gemini CLI`: opens a shell and runs `gemini` if installed
- `Vanilla Shell`: opens a plain shell session on the host

If a CLI is missing, the preset is disabled in the UI.

## Config

Optional environment variables:

- `REMOTE_VIBES_HOST` defaults to `0.0.0.0`
- `REMOTE_VIBES_PORT` defaults to `4123`
- `REMOTE_VIBES_PASSCODE` defaults to a random short code generated at startup

Example:

```bash
REMOTE_VIBES_PASSCODE=mycode REMOTE_VIBES_PORT=4200 ./start.sh
```

## Notes

- Sessions run locally on the host laptop. This is not an outbound SSH multiplexer yet.
- Some agent CLIs may still show their own trust or permissions prompts the first time they launch in a directory.
- On macOS, `node-pty` needs its `spawn-helper` marked executable. The repo fixes that automatically during `npm install`.

## Tests

```bash
npm test
```
