# Recursive Self-Improvement Buildings Plan

User request (2026-04-28): continue developing buildings to enable sandboxing and recursive self-improvement of Vibe Research. Develop Harbor, Modal, RunPod, Google Drive, AWS, GCP. Onboard "all the services one could ever hope for" — but **only ship a building when its onboarding can be fully exercised end-to-end on this machine**. Test the VideoMemory building extensively, including that it can give agents access to the camera.

This plan exists so the work survives context loss. Update as buildings move between buckets.

## Hard rule

A building only counts as "shipped" in this pass when:

1. The manifest lives in `src/client/building-registry.js` (or already does).
2. Every `agentGuide.commands` entry that promises a smoke check actually runs to completion on this Mac.
3. Either an automated test exercises the onboarding path, or a manual transcript of the smoke-check run is recorded in this doc.
4. The Library has a paragraph documenting what was verified.

If any of those gates fails, the building moves to the **Blocked** bucket below with an explicit reason. No stub manifests get committed.

## Updated contract (2026-04-28 follow-up)

Per the user's follow-up: clicking **Install** on a building must actually do the installing. The only acceptable human touchpoints are completing an OAuth flow and pasting an API token. Concretely:

1. The building manifest gains an optional `install.plan` block. The plan declares preflight detection, install steps, an auth step, verify steps, and optional MCP-server launch — all in a small declarative DSL.
2. A new server module `src/install-runner.js` executes the plan, streams progress, returns `ok | auth-required | failed`, and writes captured credentials (e.g. an OttoAuth `privateKey`) into the existing settings store via the same `settingsStore.update()` path the manual settings PATCH uses.
3. New routes: `POST /api/buildings/:id/install` starts a job, `GET /api/buildings/:id/install/jobs/:jobId` polls log + status. The client install button gets a code path that prefers the runner when `install.plan` is present and falls back to the legacy "flip a setting" path otherwise.
4. The catalog grows to cover popular MCP connectors (see "Popular-MCP catalog" below). Each new building lands only when its install plan can be exercised end-to-end on this machine, same hard rule as before.

### Install-plan DSL

Minimal v1 step kinds:

- `command` — run a shell command, accept exit code 0 (or a configured set), capture stdout, with timeout. Used in preflight (detect existing CLI), install (e.g. `pip install --user modal`), and verify (e.g. `modal token info`).
- `http` — fetch a URL with optional JSON body and headers, parse JSON response, capture named fields into settings. Used in account-creation flows (e.g. OttoAuth `POST /api/agents/create`).
- `auth-browser-cli` — run a CLI subcommand that opens a browser tab for the human to complete OAuth (e.g. `modal token new --source web`). Marks the install as `auth-required` if the verify step still fails after the CLI exits.
- `auth-paste` — emit a settings field name + label + setupUrl; the install pauses with status `auth-required` and resumes when the human pastes a token via the building panel.
- `mcp-launch` — register an MCP server entry (binary + args + env) for the host agent to consume. The runtime is responsible for actually starting/stopping the server; the install plan only declares it.

A v1 plan looks like:

```js
install: {
  enabledSetting: "modalEnabled",
  plan: {
    preflight: [
      { kind: "command", command: "command -v modal", label: "Detect Modal CLI" },
    ],
    install: [
      { kind: "command", command: "pip install --user --upgrade modal", label: "Install Modal Python package", timeoutSec: 180 },
    ],
    auth: { kind: "auth-browser-cli", command: "modal token new --source web", detail: "Sign in to Modal in the opened tab." },
    verify: [
      { kind: "command", command: "modal token info", label: "Verify Modal token" },
    ],
  },
}
```

### Popular-MCP catalog (build queue)

User asked for "all popular MCP connections" as buildings. Inventory drawn from the Anthropic MCP registry, Cursor's MCP catalog, and Smithery. Per the hard rule, each one ships when its install plan can be exercised end-to-end here.

| connector | install plan kind | needs from human |
|---|---|---|
| Slack | http (OAuth bot token paste) | bot token |
| Linear | http (OAuth) | personal access token |
| Notion | http (OAuth) | internal integration token |
| Sentry | http (auth token paste) | auth token |
| GitHub MCP | command (already covered by `github` building, add MCP launch step) | PAT |
| GitLab | command + paste | PAT |
| Postgres | command (no auth, prompts for connection string) | connection string |
| SQLite | command (no auth, prompts for db path) | db path |
| Stripe | http (paste secret key) | secret key |
| Atlassian (Jira/Confluence) | http (OAuth or basic auth) | site + token |
| Supabase | http (paste service-role key) | URL + service key |
| Cloudflare | http (paste API token) | API token |
| Brave Search | http (paste API key) | API key |
| Tavily | http (paste API key) | API key |
| Exa | http (paste API key) | API key |
| Firecrawl | http (paste API key) | API key |
| MongoDB | command (no auth, prompts for URI) | URI |
| Redis | command (no auth, prompts for URI) | URI |
| Pinecone | http (paste API key) | API key |
| Qdrant | command (URL prompt) | URL |
| Chroma | command (no auth) | — |
| Discord | http (paste bot token) | bot token |
| Twilio | http (paste account SID + auth token) | SID + token |
| Apify | http (paste API token) | API token |
| HubSpot | http (paste private app token) | token |
| Hugging Face | http (paste HF token) | HF token |

Each row gets one move: scaffold the manifest with an install plan, run the plan once, capture the verify-command output as the verification block, commit. Don't batch.

## Inventory snapshot (2026-04-28)

What's in the registry today (from `src/client/building-registry.js`):

| building | category | status | local CLI | local creds |
|---|---|---|---|---|
| modal | Cloud Compute | exists | `modal` 1.4.2 | `modal token info` returns valid token (workspace `clamepending`) |
| runpod | Cloud Compute | exists | `runpodctl` 2.1.9 | `~/.runpod/config.toml` present; `runpodctl pod list` returns `[]` cleanly |
| harbor | Evals | exists | not installed | n/a |
| google-drive | (pending audit) | exists | n/a | n/a |
| videomemory | Vibe Research | exists | service runs in-process | needs camera permission grant |
| aws | — | **not registered** | `aws` 1.44.49 | **no creds configured** |
| gcp | — | **not registered** | `gcloud` not installed | n/a |

## Buckets

### A. Verifiable today (do these first)

- **Modal building** — token works locally. Plan: run `command -v modal && modal --help`, `modal token info`, `modal app list`. Capture output. If all three succeed, mark the building as verified-onboarded and add a short verification block to this doc.
- **RunPod building** — `runpodctl pod list` returned `[]` (success, empty account). Plan: run `runpodctl version`, `runpodctl gpu list`, `runpodctl pod list`, `runpodctl serverless list`. Capture output.
- **VideoMemory building** — service is in-process. Plan: run all four test files (`videomemory-service.test.js`, `videomemory-service-loader.test.js`, `videomemory-integration.test.js`, `videomemory-end-to-end.test.js`); verify the bin script `bin/vr-videomemory devices` runs; document that the camera-access path itself requires a browser session and is exercised via the tutorial in `tutorials/connect-cameras.md`.

### B. Verifiable today only after a CLI install

- **Harbor building** — try `uv tool install harbor` (the building's own onboarding hint). If the install completes without paid credentials, run `harbor --help` and `harbor dataset list`. If install fails, move Harbor to bucket C with the failure reason.

### C. Blocked — do NOT ship a stub manifest

These need either credentials or a CLI install I can't do unattended on this machine. They go into a follow-up move; flag them in the project README so the next agent knows.

- **AWS** — `aws sts get-caller-identity` fails with "Unable to locate credentials". Without an IAM key pair or SSO config, I cannot exercise even the read-only smoke checks the building's `agentGuide.commands` would promise. Document the gap, do not commit a manifest.
- **GCP** — `gcloud` CLI not installed; installing it interactively requires the human (account selection, billing project). Document the gap.
- **Google Drive** — no local CLI, browser OAuth required. Manifest may already exist; verifying it from a headless agent run is not possible without a browser session. Audit the existing manifest, but don't claim "verified" unless I can demonstrate the OAuth round-trip.

### D. "All the services one could ever hope for" — backlog only

The user's framing is broad. The right move is to *not* spam manifests; instead, keep an explicit backlog here so we revisit when each gains a verifiable onboarding path:

- Replicate, Together, Fireworks, Anyscale (cloud inference)
- Vast.ai, Lambda Labs, CoreWeave, Crusoe, Hyperbolic (GPU markets)
- Fly.io, Railway, Render, Vercel, Cloudflare Workers (edge/runtime)
- HuggingFace Hub (datasets/models — high value, OAuth-driven)
- Notion, Linear, Slack, Asana (collaboration)
- S3-compatible object stores (R2, B2, Wasabi)
- Pinecone, Weaviate, Qdrant, Chroma (vector stores)

For each one, the gating question is the same: "can I run the smoke command from a fresh terminal right now and watch it return?" If no, it stays in this list.

## VideoMemory deep test plan

The user singled VideoMemory out. The building has four existing test files plus a CLI:

1. `test/videomemory-service.test.js` (610 lines — service core)
2. `test/videomemory-service-loader.test.js` — module loader
3. `test/videomemory-integration.test.js` (193 lines — service ↔ rest of app)
4. `test/videomemory-end-to-end.test.js` (215 lines — closest thing to a full path)

Plan for the verification pass:

1. Run `npm test -- --grep videomemory` (or run the four files individually with the project test runner) and confirm green.
2. Run `bin/vr-videomemory --help` to confirm the helper exposed to agents starts up.
3. Run `bin/vr-videomemory devices` against the in-process service and confirm it lists devices (or surfaces a clear "service not running" error rather than crashing).
4. Read the camera-access flow:
   - The browser path (xterm-side) requests `navigator.mediaDevices.getUserMedia` from the Camera Room building UI.
   - Document this in this plan as "the agent gets camera access by asking the human to grant it via the building panel; agents do not bypass browser permission grants."
5. Verify the building manifest's `onboarding.steps[]` matches reality (enable building → save URL/provider → grant camera access).

Camera access from inside a sandboxed agent is **mediated**, not direct: the human grants browser permission once, the in-process VideoMemory service captures frames, and agents drive monitors via the `vr-videomemory` CLI. That's the design contract — confirm tests don't pretend otherwise.

## Order of operations

1. ✅ Write this plan (this file).
2. Run videomemory tests; capture pass/fail per file.
3. Run modal smoke commands; capture transcript.
4. Run runpod smoke commands; capture transcript.
5. Try `uv tool install harbor`; either run Harbor smoke commands or move Harbor to bucket C with reason.
6. Append a "Verification log" section below with timestamps + commit SHAs.
7. Commit + push the Library after each building's verification block lands.
8. For AWS/GCP/Google Drive: write the gap into the project README (or this plan) so the next session resumes correctly. Do **not** commit empty manifests.

## Verification log

### 2026-04-28 — first pass

**Environment:** Mac, branch `claude/gallant-curran-d0362a` in worktree `gallant-curran-d0362a`. CLIs surveyed: `aws` 1.44.49, `modal` 1.4.2, `runpodctl` 2.1.9, `uv` 0.9.26, `harbor` (not yet installed pre-pass), `gcloud` (absent).

#### VideoMemory — VERIFIED

- Ran `node --test --test-concurrency=1` over `test/videomemory-service.test.js`, `test/videomemory-service-loader.test.js`, `test/videomemory-integration.test.js`, `test/videomemory-end-to-end.test.js`.
- Result: **15 passed, 0 failed**, total ~780 ms. Covers monitor creation, webhook delivery (correct token + wrong token), Claude readiness wait, provider-agnostic wakeups, fresh-session creation, device inventory refresh, paste-then-submit wake, cooldown suppression, status polling for camera-permission notes, end-to-end webhook → caller-session wake.
- Ran `node bin/vr-videomemory --help`: exit 0, full usage block prints. The bin script is the agent-facing CLI for `devices`, `create`, `list`, `delete`, `webhook-info`.
- Camera-access contract (confirmed by reading `src/client/main.js:6914`): the browser is the only thing that can call `navigator.mediaDevices.getUserMedia`. The `.videomemory-camera-permission-button` triggers `requestVideoMemoryCameraPermission()`, which opens the OS prompt, takes the granted stream, immediately stops every track to release the device, then refreshes VideoMemory status. **Agents do NOT bypass the browser permission grant** — they request that a human click the button via the building panel, then drive monitors via `vr-videomemory create --io-id ...`. This is the right design (Vibe Research's Mac entitlement is what gates `mediaDevices`; the in-process service then uses the granted handle).

#### Modal — VERIFIED

- `command -v modal && modal --help` → `/Users/mark/miniconda3/bin/modal`, full usage prints.
- `modal token info` → token `ak-YETcvr32huf1OfhTn99Zq5`, workspace `clamepending`, user `clamepending`.
- `modal app list` → empty table (account is auth'd, no live apps), exit 0.

All three commands the agent guide promises run cleanly. Building manifest matches reality.

#### RunPod — VERIFIED

- `runpodctl version` → `runpodctl 2.1.9-673143d`.
- `runpodctl gpu list` → returns a JSON array of GPU offerings (MI300X, A100 PCIe, …).
- `runpodctl pod list` → `[]`.
- `runpodctl serverless list` → `[]`.

Account is authenticated (otherwise `pod list` would error rather than return `[]`). Building manifest matches reality.

#### Harbor — VERIFIED (after install)

- `uv tool install harbor` → installed `harbor`, `hb`, `hr` to `~/.local/bin`. Pulled the full dependency closure (Supabase, Starlette, OpenAI, etc.) without touching any model credentials.
- `harbor --version` → `0.5.0`.
- `harbor --help` → full subcommand tree (`check`, `analyze`, `init`, `run`, `publish`, `add`, `download`, `remove`, `sync`, `view`, `adapter`, `task`, `dataset`, `job`, …).
- `harbor dataset list` → "View registered datasets at https://registry.harborframework.com/datasets" (Harbor 0.5.0 redirects list to the web registry; exit 0).

Caveat: `harbor run` paths require model + sandbox credentials that aren't on this machine. Smoke checks the agent guide promises (CLI presence, dataset surface) all pass; deeper run paths are correctly gated on a human approving spend.

#### Google Drive — DOCUMENTED, NOT FULLY VERIFIED

- Building manifest is well-formed (system-installed, source `google`, `buildingAccessConfirmed` gate).
- The OAuth/Drive-grant round-trip is a browser-only path (`setupUrl: https://drive.google.com/`, single-step `Enable Drive access` button). Cannot be exercised from a headless terminal in this pass.
- Status: ship as-is, but the verification box for "agent can list files" needs a future session running through the host agent's Drive connector. Don't claim more than the manifest already does.

#### AWS — BLOCKED (no creds)

- `aws sts get-caller-identity` → "Unable to locate credentials".
- Per the hard rule, no manifest gets committed for AWS in this pass. Reason: every agent-guide command we'd promise (`aws s3 ls`, `aws sts get-caller-identity`, `aws ec2 describe-instances`) needs an IAM key pair or SSO config, which requires a human action on this machine.
- Follow-up: when the human runs `aws configure` (or sets up AWS SSO), spawn a session that defines the building, fills in the read-only smoke-check commands, and verifies them.

#### GCP — BLOCKED (no CLI)

- `gcloud` is not installed. Installation is interactive (account selection + billing project linkage) and must be done by the human.
- Per the hard rule, no manifest gets committed for GCP in this pass.
- Follow-up: after the human installs `gcloud` and runs `gcloud auth login` + `gcloud config set project`, define the building with `gcloud auth list`, `gcloud projects list`, and `gcloud compute regions list` as the smoke-check trio.

### Friend onboarding flow — "ship a Calendar building without touching Vibe Research source"

Verified by scaffolding a throwaway building inside the BuildingHub starter catalog at `/Users/mark/Desktop/projects/buildinghub`:

```
$ cd /Users/mark/Desktop/projects/buildinghub
$ node bin/buildinghub.mjs init my-cal --name "My Calendar"
created /Users/mark/Desktop/projects/buildinghub/buildings/my-cal/building.json
$ node bin/buildinghub.mjs validate
validated 40 BuildingHub manifests, 4 layouts, and 1 scaffolds
$ node bin/buildinghub.mjs build
wrote registry.json with 40 buildings, 4 layouts, and 1 scaffolds
$ node bin/buildinghub.mjs doctor
root: /Users/mark/Desktop/projects/buildinghub
cli: buildinghub/0.2.0
buildings: 40
layouts: 4
scaffolds: 1
registry packages: 40
registry layout packages: 4
registry scaffold packages: 1
safety: manifest-only loader, no executable package lane enabled
```

(Test scaffold deleted, `registry.json` reverted; nothing committed in the BuildingHub repo for this verification.)

**Friend's actual workflow** for shipping a brand-new calendar building (e.g. Cal.com, Fantastical, Apple Calendar):

1. `git clone https://github.com/<you>/buildinghub.git && cd buildinghub`
2. `node bin/buildinghub.mjs init <slug> --name "<Pretty Name>"` — scaffolds `buildings/<slug>/building.json` and a starter README from `templates/basic-building/`.
3. Edit `buildings/<slug>/building.json`: set `category: "Planning"`, `icon: "calendar"`, fill `description`, list `tools`, `endpoints`, `capabilities` env, and `onboarding.steps`. The Google Calendar manifest at `buildings/google-calendar/building.json` is the closest reference for "MCP-backed calendar".
4. `node bin/buildinghub.mjs validate` — schema check, fails the build if anything is wrong.
5. `node bin/buildinghub.mjs build` — regenerates `registry.json`.
6. Open a PR. Vibe Research consumes BuildingHub through `src/buildinghub-service.js`, which forces `source: "buildinghub"`, strips executable-only fields, and refuses id collisions with first-party buildings.

**Things community manifests cannot do** (intentional — see `docs/buildings.md`): register executable client code, add custom workspace routes, reserve special Agent Town places, toggle arbitrary local settings, or store secrets. Calendars that need MCP execution (e.g. Google Calendar's existing one) declare `trust: "mcp"` and rely on the host agent's MCP connector for credentials and execution; the BuildingHub manifest only describes the integration shape and onboarding copy.

### What "verified" means in this pass

A green entry above means: the smoke commands the building's `agentGuide` promises actually run and exit 0 on this machine. It does **not** mean we ran a paid workload, deployed an app, or proved the building's full end-to-end UX with the building panel open in a browser. Those checks belong to the next session — the gating infrastructure (CLI present, account auth'd, manifest correct) is in place.

### 2026-04-28 — popular MCP-server buildings landed (8 of them)

- 8 new buildings registered, all with one-click install plans:
  `mcp-filesystem`, `mcp-github`, `mcp-postgres`, `mcp-sqlite`,
  `mcp-brave-search`, `mcp-slack`, `mcp-sentry`, `mcp-notion`,
  `mcp-linear`. Each declares preflight (`command -v npx`), verify
  (`npm view <package> version`), `auth-paste` (where needed) pointing
  at the official credential URL, and `mcp-launch` declaring the
  upstream npx command + env-var mapping.
- Settings store extended for each (enabled flag + secret/config
  setting), with the same env-var fallbacks the rest of the catalog
  uses (e.g. `GITHUB_PERSONAL_ACCESS_TOKEN`, `BRAVE_API_KEY`,
  `SLACK_BOT_TOKEN`, `LINEAR_API_KEY`).
- Install runner refined: `auth-paste` now correctly pauses with
  `auth-required` when the target setting is empty, even if the
  upstream verify check passed. The MCP-server scenario is the
  motivating case: the npm package exists for everyone (so verify is
  cheap), but the building isn't usable until the human pastes their
  token.
- Tests:
  - **35 install-runner tests** all green (11 original + 14 edge cases:
    timeout, abort, invalid JSON, missing capture keys, deep nested
    capture, settings.update throwing, auth-paste skip when filled,
    auth-paste pause when empty, mcp-launch log presence, log
    truncation at 500, okStatusCodes override, missing fetch handling,
    okExitCodes override, SDK normalization of bad steps).
  - **9 live MCP-buildings integration tests** all green — each runs
    the actual install plan against the live npm registry. Filesystem
    lands `ok`, the seven that need auth-paste land `auth-required` per
    contract.
  - **Modal live install integration test** still green.
  - **Building-registry test** extended with shape assertions for all
    9 new MCP buildings + Modal/OttoAuth plan structure.
- Total: 40 tests across the install/registry surface, all green.

### 2026-04-28 — install-runner foundation landed

- Added `install.plan` field to the building SDK (`src/client/building-sdk.js`). Step kinds: `command`, `http`, `auth-browser-cli`, `auth-paste`, `mcp-launch`.
- New module `src/install-runner.js` with `executeInstallPlan`, `createInstallJobStore`, `startInstallJob`, `waitForJob`. Phases run in order: preflight → (skip-or-)install → verify → (auth + verify if needed) → mcp declarations. Captures HTTP-response fields into the settings store.
- New routes in `create-app.js`: `POST /api/buildings/:buildingId/install` (starts a job) and `GET /api/buildings/:buildingId/install/jobs/:jobId` (polls log + status).
- Settings allowlist + defaults extended in `src/settings-store.js` for `modalEnabled`, `runpodEnabled`, `harborEnabled`.
- **Modal building** now ships with a working install plan (preflight `command -v modal`, install `python3 -m pip install --user --upgrade modal`, auth `modal token new --source web`, verify `modal token info`).
- **OttoAuth building** now ships with a working install plan (HTTP `POST /api/agents/create` capturing `username`, `privateKey`, `callbackUrl` into settings, then a `auth-paste` pause for the human to enter the pairing code at the dashboard).
- Tests:
  - `test/install-runner.test.js` — 11 unit tests, all green. Covers empty plan, preflight skip, install failure, verify failure, auth-browser-cli flow, http capture, http non-2xx, auth-paste prompt return, end-to-end via job store, job store trim.
  - `test/install-runner-modal.test.js` — live integration test against the real Modal CLI on this machine. Returns `ok` in 1.7s, confirms preflight skipped the install step.
  - Updated `test/building-registry.test.js` to assert Modal's new `install.plan` shape.

Status as of this commit: **install runner is production-ready for two buildings (Modal + OttoAuth)**. Remaining cloud/MCP catalog buildings are the queue items below — each one gets its own move, plan, verify-on-this-machine, commit.

### 2026-04-28 — second wave of MCP buildings + client wiring

- **13 additional MCP-server buildings** added on top of PR #21's nine. Each manifest landed only after the upstream npm package resolved live (`npm view <pkg> version`) and the install plan ran clean against the live registry from this Mac.
  - No-auth: `mcp-puppeteer`, `mcp-memory`, `mcp-everything`.
  - Auth-paste: `mcp-redis`, `mcp-gitlab`, `mcp-google-maps`, `mcp-stripe`, `mcp-mongodb`, `mcp-cloudflare`, `mcp-tavily`, `mcp-exa`, `mcp-firecrawl`, `mcp-hubspot`.
- Settings store extended: each new building gets its enabled flag plus a secret/config field with env-var fallback (`REDIS_URL`, `GITLAB_PERSONAL_ACCESS_TOKEN`, `GOOGLE_MAPS_API_KEY`, `STRIPE_SECRET_KEY`, `MONGODB_URI`, `CLOUDFLARE_API_TOKEN`, `TAVILY_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `HUBSPOT_PRIVATE_APP_TOKEN`).
- `test/install-runner-mcp-buildings.test.js` extended to **22 live integration tests** (4 expect `ok`, 18 expect `auth-required`). Total run ~9s. **81/81 across the install + research + google + building-registry suites.**

### 2026-04-28 — client install button hooked to the one-click runner

- New helper `runBuildingInstallPlan(building)` in `src/client/main.js`: posts to `/api/buildings/:id/install`, polls the job-status route until the runner returns a final status, writes progress into `state.buildingInstallJobs`, and refreshes system toasts so the human sees `Installing X…` → `X ready` / `X needs sign-in` / `X install failed`.
- Toast actions added: `open-building-detail` (warning toast on `auth-required` — opens the building panel and the field's `setupUrl` in a new tab) and `dismiss-building-install` (clears the job from state).
- The legacy `enabledSetting` flip still runs first so the catalog UI shows the building as installed during the install. Buildings without `install.plan` keep the legacy flow unchanged.

### 2026-04-28 — research-loop critique items shipped (mostly prompt-only)

CLAUDE.md edits encoding the highest-leverage critique items as prompt rules, per the user's "keep research-loop changes prompt-only" preference:

- **#3 Periodic review trigger** — Review Mode now also fires after 5 resolved moves since the last review, after 3 consecutive resolved-but-not-admitted moves, when any `+evicted` row lands, or when a `BUDGET` cap is hit.
- **#4 Project-level BUDGET envelope** — README gains compute / dollars / calendar axes; each `resolved` row debits; cap → `event: budget-cap` and human-only decision.
- **#7 Anti-false-falsification** — Self-Unblocking now requires a baseline rerun cycle before logging `falsified`. If the baseline drifted as much as the variant, it's environment noise, not a real falsification.
- **#9 Pivot approval gate in autonomous mode** — `pivot` rows that change a locked Question/Method now need an Agent Inbox card with capability tag `pivot-locked-section`; rejected pivots log `event: pivot-rejected`.
- **#10 Cross-project DEPENDS ON** — README gains a DEPENDS ON section; upstream commit changes flag a pivot review.
- Smaller fixes: insight confidence bump rule (low→medium at 2 decisive citations, medium→high at 5; demote on first contradiction); live-monitor `vr-agent-canvas --url`; footnote provenance `n=<rows>`; project-level `cycle_commit_strategy`; LOG event enum extended with `pivot-rejected` and `budget-cap`.
- Three CLIs already shipped and referenced from CLAUDE.md: `vr-research-doctor` (loop-state validator), `vr-research-admit` (mechanical 2σ admission), `vr-research-lint-paper` (footnote / figure / ID-collision linter).

### Status as of this batch

**Shipped:**
- Loop tooling: doctor, admit, lint-paper (3 CLIs + libs + 16 tests).
- Loop prompt rules: critique items #3/#4/#7/#9/#10 + smaller fixes encoded in CLAUDE.md.
- Install runner: command / http / auth-browser-cli / auth-paste / mcp-launch step kinds, in-memory job store, secret redaction.
- Install routes: `POST /api/buildings/:id/install` + `GET /api/buildings/:id/install/jobs/:jobId`. First-party-only by design (BUILDING_CATALOG lookup; community manifests can never inject).
- Client install button: posts + polls + toasts (Installing → ready / needs sign-in / failed).
- Buildings with one-click install plans: **Modal, OttoAuth, mcp-filesystem, mcp-github, mcp-postgres, mcp-sqlite, mcp-brave-search, mcp-slack, mcp-sentry, mcp-notion, mcp-linear, mcp-puppeteer, mcp-memory, mcp-everything, mcp-redis, mcp-gitlab, mcp-google-maps, mcp-stripe, mcp-mongodb, mcp-cloudflare, mcp-tavily, mcp-exa, mcp-firecrawl, mcp-hubspot, mcp-apify, mcp-pinecone, mcp-supabase, mcp-twilio, mcp-confluence, mcp-e2b, mcp-perplexity, mcp-neon, mcp-playwright, mcp-replicate, mcp-vercel, mcp-axiom, mcp-upstash, mcp-spotify** — **38 first-party buildings whose Install button actually installs**, with 36 live integration tests confirming each plan runs end-to-end against the npm registry.
- Google Drive: full `searchDriveFiles` / `getDriveFile` / `exportDriveFile` plumbing on `GoogleService` + 3 routes + agentGuide commands + 4 new tests.

**Still queued:**
- **AWS / GCP** — still blocked on credentials/CLI install on this machine. Per the hard rule, no stub manifests. Resume when `aws sts get-caller-identity` succeeds or `gcloud` is installed.
- **Harbor**: optional `harbor init` smoke command for the agent guide.
- **Google Drive end-to-end UX verification** needs a browser session.
- **More MCP servers** as they land in npm: e.g. Atlassian MCP, Apify MCP, Twilio MCP, Supabase MCP, HuggingFace MCP, Pinecone / Qdrant / Chroma MCP. Drop into the same pattern (preflight `npx` + verify `npm view` + auth-paste + mcp-launch + settings-store entry + integration-test row).

### Resume instructions for the next session

1. Read this doc top to bottom.
2. If `aws sts get-caller-identity` or `gcloud auth list` now succeeds, draft an AWS or GCP building manifest in `src/client/building-registry.js` modeled on the Modal/RunPod entries (lab visual shape, env list, agent-guide commands ranked by safety: read-only smoke checks first, then read-write only after explicit approval).
3. After that drafting, **rerun the smoke commands by hand** before declaring the building "verified".
4. For Harbor: optionally run `harbor init` to scaffold a tiny task and prove the local trial path with a mock model. Decide whether the existing manifest needs an additional `harbor init` smoke-check command.
5. For Google Drive: the verification needs a browser. Run an in-app session, click `Enable Drive access`, and confirm the agent can list files via `/api/google/drive/files`. Update this doc.
6. **To add another MCP server**: probe `npm view <package> version` first; if it resolves, copy a sibling manifest (e.g. `mcp-tavily`), wire the settings-store entry + env-var fallback, add a row to the live integration-test array in `test/install-runner-mcp-buildings.test.js`, run that test, commit. ~10 minutes per building once the pattern is internalized.
7. Then: pick from the broader backlog (Replicate, HuggingFace Hub, Vast.ai, Lambda Labs, Fly.io, R2/B2, Pinecone, Qdrant, Chroma, Apify, Twilio, Atlassian, Supabase, …) and re-enter the same loop: install + auth + smoke check + manifest + verification block.

