# Vibe Research Desktop

This package builds a thin desktop launcher and first-run installer for Vibe Research.

The desktop app does not run the server inside Electron. Release builds bundle a Vibe Research source template, copy it into `~/.vibe-research/app`, ensure a local Node.js runtime exists, start the normal local server, then load `http://127.0.0.1:4123/` in an Electron window. That keeps the terminal and native dependency path the same as the shell installer while avoiding a first-run Git dependency for nontechnical macOS users.

## Development

```bash
npm run desktop:install
npm run desktop:dev
```

Development launches from the source checkout. Set `VIBE_RESEARCH_DESKTOP_USE_SOURCE=0` to exercise the installed-app path.

## Packaging

```bash
npm run desktop:pack
npm run desktop:dist
npm --prefix desktop run dist:mas
```

macOS artifacts are written to `desktop/dist/`. Local builds use ad-hoc signing unless a Developer ID certificate is available. Public release tags require these GitHub secrets so the build is signed, notarized, and usable without Gatekeeper warnings:

- `MACOS_CSC_LINK` — base64-encoded Developer ID Application certificate export (`.p12`).
- `MACOS_CSC_KEY_PASSWORD` — password for that certificate export.
- `APPLE_ID` — Apple Developer account email.
- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password for notarization.
- `APPLE_TEAM_ID` — Apple Developer team id.

Tag builds publish the DMG, ZIP, blockmaps, and `latest-mac.yml` through `electron-builder` so `electron-updater` can update installed desktop apps from GitHub Releases.

## Mac App Store builds

`dist:mas` creates a Mac App Store package target. This requires App Store signing assets (application + installer identities and a provisioning profile) instead of the Developer ID certificate used for DMG/ZIP notarized builds.

Expected env for MAS builds:

- `MAS_PROVISIONING_PROFILE` — path to the `.provisionprofile` for `net.vibe-research.desktop`.
- `CSC_LINK` / `CSC_KEY_PASSWORD` — signing certificate export that includes Mac App Store signing identities.

Mac App Store builds disable `electron-updater` and expect App Store-managed updates.

GitHub Actions release tags also require:

- `MACOS_APPSTORE_CSC_LINK`
- `MACOS_APPSTORE_CSC_KEY_PASSWORD`
- `MAS_PROVISIONING_PROFILE_BASE64` (base64-encoded `.provisionprofile`)
