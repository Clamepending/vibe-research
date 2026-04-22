# Vibe Research Desktop

This package builds a thin desktop launcher and first-run installer for Vibe Research.

The desktop app does not run the server inside Electron. On first launch it runs the repository installer, installs Vibe Research into `~/.vibe-research/app`, starts the normal local server, then loads `http://127.0.0.1:4123/` in an Electron window. That keeps the terminal and native dependency path the same as the shell installer.

## Development

```bash
npm run desktop:install
npm run desktop:dev
```

Development launches from the source checkout. Set `VIBE_RESEARCH_DESKTOP_USE_SOURCE=0` to exercise the first-run install path.

## Packaging

```bash
npm run desktop:pack
npm run desktop:dist
```

Unsigned macOS artifacts are written to `desktop/dist/`. For distribution outside a developer machine, sign and notarize the app with Apple Developer ID credentials.
