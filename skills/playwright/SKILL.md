---
name: "playwright"
description: "Use when the task requires automating a real browser from a Vibe Research session: navigation, form filling, snapshots, screenshots, UI-flow debugging, or webapp inspection via vr-playwright/playwright-cli."
---

# Playwright CLI Skill

Drive a real browser from the terminal using Vibe Research's `vr-playwright` wrapper. This is the preferred browser automation path for agents in Vibe Research.

Treat this as CLI-first browser automation. Do not pivot to Playwright test specs unless the user explicitly asks for test files.

## Prerequisite Check

Before browser automation, check whether `npx` is available:

```bash
command -v npx >/dev/null 2>&1
```

If it is not available, pause and ask the user to install Node.js/npm. Provide these steps:

```bash
# Verify Node/npm are installed
node --version
npm --version

# If missing, install Node.js/npm, then:
npm install -g @playwright/cli@latest
playwright-cli --help
```

Once `npx` is present, proceed with the Vibe Research wrapper. A global install of `playwright-cli` is optional.

## Skill Path

Vibe Research sets this in agent sessions:

```bash
export PWCLI="${PWCLI:-vr-playwright}"
```

You can use either command:

```bash
"$PWCLI" --help
vr-playwright --help
playwright-cli --help
```

`vr-playwright` runs `npx --package @playwright/cli playwright-cli`, so it works without a global `playwright-cli` install. It also scopes browser sessions by a short hash of `VIBE_RESEARCH_SESSION_ID` unless you pass your own `-s=<session>`.

## Quick Start

```bash
"$PWCLI" open http://127.0.0.1:4173
"$PWCLI" snapshot
"$PWCLI" click e15
"$PWCLI" type "hello from Vibe Research"
"$PWCLI" press Enter
"$PWCLI" screenshot --filename output/playwright/final.png
```

## Core Workflow

1. Open the page.
2. Snapshot to get stable element refs.
3. Interact using refs from the latest snapshot.
4. Re-snapshot after navigation or significant DOM changes.
5. Capture screenshots, PDFs, traces, or console/network output when useful.

Minimal loop:

```bash
"$PWCLI" open http://127.0.0.1:4173
"$PWCLI" snapshot
"$PWCLI" click e3
"$PWCLI" snapshot
```

## When To Snapshot Again

Snapshot again after navigation, clicks that change the UI, opening or closing modals, and tab switches.

Refs can go stale. When a command fails because a ref is missing, snapshot again before trying another ref.

If a snapshot returns an empty tree right after `open`, wait a moment and run `"$PWCLI" snapshot` again.

## Recommended Patterns

### Form Fill And Submit

```bash
"$PWCLI" open http://127.0.0.1:4173/form
"$PWCLI" snapshot
"$PWCLI" fill e1 "user@example.com"
"$PWCLI" fill e2 "password123"
"$PWCLI" click e3
"$PWCLI" snapshot
```

### Debug With Traces

```bash
"$PWCLI" open http://127.0.0.1:4173 --headed
"$PWCLI" tracing-start
# interact with the page
"$PWCLI" tracing-stop
```

### Multi-Tab Work

```bash
"$PWCLI" tab-new http://127.0.0.1:4173/other
"$PWCLI" tab-list
"$PWCLI" tab-select 0
"$PWCLI" snapshot
```

## Vibe Research Fallbacks

Prefer `vr-playwright` for browser interaction. If it fails because `npx` or the Playwright browser runtime is unavailable, fall back to `vr-browser` and report the concrete failure.

Use `vr-browser describe` or `vr-browser describe-file` only when you specifically need Codex/Claude to turn a screenshot or local image into textual visual feedback.

## Guardrails

- Always snapshot before referencing element ids like `e12`.
- Re-snapshot when refs seem stale.
- Prefer explicit commands over `eval` and `run-code` unless needed.
- When you do not have a fresh snapshot, use placeholder refs like `eX` and say why; do not bypass refs with `run-code`.
- Use `--headed` when a visual check will help.
- Save artifacts under `output/playwright/` when possible.
- Do not infer visuals from curl or HTML alone.
- Default to CLI commands and workflows, not Playwright test specs.
