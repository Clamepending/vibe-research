// Install runner for building install plans.
//
// A building manifest can declare an `install.plan` block with five phases:
// preflight, install, auth, verify, mcp. The runner executes the phases in
// order, captures stdout/stderr, applies any captured-settings updates via
// `settingsStore.update(...)`, and returns one of:
//   - { status: "ok" } when verify passes (also triggered when preflight
//     already detects an installed CLI and verify passes — installs are
//     skipped in that case);
//   - { status: "auth-required", reason } when the install ran but verify
//     still fails and the plan declared an auth step (the human needs to
//     finish the OAuth/token-paste flow);
//   - { status: "failed", reason } when any non-skippable step errors.
//
// The runner intentionally does NOT spawn long-lived processes for `mcp`
// steps; those are declared so the host runtime can pick them up. Future
// follow-up.

import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const DEFAULT_COMMAND_TIMEOUT_SEC = 60;
const DEFAULT_HTTP_TIMEOUT_SEC = 30;

function nowIso() {
  return new Date().toISOString();
}

function randomJobId() {
  return `inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

// Build a single-line failure reason that includes the tail of stderr (or
// stdout when stderr is empty) so the UI's "install failed" message tells
// the user WHY it failed. Without this, every install error reads "install
// step X failed" with no actionable signal — the user has to dig into the
// job log to find the actual error. We trim aggressively to keep the chip
// readable; the full tails are still in the log entries.
function formatStepFailureReason(step, result) {
  const label = step.label || step.command || "command";
  const head = `install step "${label}" failed`;
  const reasonHints = [];
  if (result.reason) reasonHints.push(result.reason);
  if (Number.isInteger(result.exitCode)) reasonHints.push(`exit=${result.exitCode}`);
  const stderr = String(result.stderr || "").trim();
  const stdout = String(result.stdout || "").trim();
  // Prefer stderr when present; fall back to stdout (some pip errors print
  // to stdout). Cap at 240 chars so the UI chip isn't a wall of text.
  const tail = (stderr || stdout).split("\n").filter((line) => line.trim()).slice(-3).join(" | ");
  const trimmedTail = tail.length > 240 ? `...${tail.slice(-240)}` : tail;
  const parts = [head];
  if (reasonHints.length) parts.push(`(${reasonHints.join(", ")})`);
  if (trimmedTail) parts.push(`: ${trimmedTail}`);
  return parts.join(" ");
}

export function createInstallJobStore() {
  const jobs = new Map();
  const MAX_JOBS = 64;

  function trim() {
    if (jobs.size <= MAX_JOBS) return;
    const oldest = [...jobs.entries()]
      .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))
      .slice(0, jobs.size - MAX_JOBS);
    for (const [id] of oldest) jobs.delete(id);
  }

  return {
    create(buildingId) {
      const id = randomJobId();
      const job = {
        id,
        buildingId,
        status: "running",
        log: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        result: null,
      };
      jobs.set(id, job);
      trim();
      return job;
    },
    get(id) {
      return jobs.get(id) || null;
    },
    update(id, patch) {
      const job = jobs.get(id);
      if (!job) return null;
      Object.assign(job, patch, { updatedAt: Date.now() });
      return job;
    },
    appendLog(id, entry) {
      const job = jobs.get(id);
      if (!job) return null;
      job.log.push({ at: nowIso(), ...entry });
      job.updatedAt = Date.now();
      // Keep logs bounded so a runaway plan can't OOM the server.
      if (job.log.length > 500) {
        job.log = job.log.slice(-500);
      }
      return job;
    },
    // List jobs for a specific building, most-recent first. Used by the
    // UI's "show me the last 5 install attempts" history view. Default
    // limit keeps the response small; -1 returns all jobs we still
    // remember.
    byBuilding(buildingId, { limit = 10 } = {}) {
      const id = String(buildingId || "").trim();
      if (!id) return [];
      const matching = [...jobs.values()].filter((job) => job.buildingId === id);
      matching.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      if (limit > 0) return matching.slice(0, limit);
      return matching;
    },
    size() { return jobs.size; },
  };
}

// Resolve a guaranteed-to-exist local bin dir for venv-installed tools.
// vr-pip-install-tool symlinks Python CLIs (modal, etc.) into here; we
// PREPEND it to PATH for every install-runner shell command so subsequent
// preflight/verify steps in the same install plan can find newly-installed
// binaries even when the user hasn't yet edited their shell profile.
function resolveVibeResearchLocalBin(env = process.env) {
  const home = env.VIBE_RESEARCH_HOME || (env.HOME ? `${env.HOME}/.vibe-research` : null);
  return home ? `${home}/bin` : null;
}

function buildSpawnEnv(extraEnv) {
  const merged = { ...process.env, ...(extraEnv || {}) };
  const localBin = resolveVibeResearchLocalBin(merged);
  if (localBin) {
    const path = String(merged.PATH || "");
    // Idempotent: don't double-prepend if it's already first.
    if (!path.split(":").includes(localBin)) {
      merged.PATH = path ? `${localBin}:${path}` : localBin;
    }
  }
  return merged;
}

async function runShellCommand(step, { signal, env: extraEnv } = {}) {
  const timeoutMs = (step.timeoutSec || DEFAULT_COMMAND_TIMEOUT_SEC) * 1000;
  return await new Promise((resolve) => {
    const child = spawn(step.command, {
      shell: step.shell !== false,
      // Spread process.env first so user shell config wins, then layer the
      // install-runner-supplied env (VIBE_RESEARCH_APP_DIR etc.) on top so
      // manifest commands can reliably reach scripts shipped under bin/.
      // Also prepend ~/.vibe-research/bin to PATH so venv-installed CLIs
      // are visible to subsequent steps in the same plan.
      env: buildSpawnEnv(extraEnv),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (payload) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      resolve(payload);
    };

    const timeoutHandle = setTimeout(() => {
      settle({
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr + `\n[install-runner] timeout after ${step.timeoutSec || DEFAULT_COMMAND_TIMEOUT_SEC}s`,
        reason: "timeout",
      });
    }, timeoutMs);

    if (signal?.aborted) {
      clearTimeout(timeoutHandle);
      settle({ ok: false, exitCode: null, stdout, stderr, reason: "aborted" });
      return;
    }
    signal?.addEventListener("abort", () => {
      clearTimeout(timeoutHandle);
      settle({ ok: false, exitCode: null, stdout, stderr, reason: "aborted" });
    });

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      settle({ ok: false, exitCode: null, stdout, stderr: stderr + `\n[install-runner] spawn error: ${err.message}`, reason: "spawn-error" });
    });
    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      const ok = (step.okExitCodes || [0]).includes(code ?? -1);
      settle({ ok, exitCode: code, stdout, stderr });
    });
  });
}

// Interpolate `${VAR}` references in a string against an env map. Used to
// let install-plan http-step URLs reference VIBE_RESEARCH_SERVER_URL (etc.)
// without callers having to know the running port. Only `${...}` is
// recognised; bare `$VAR` is left untouched to avoid surprising matches.
function interpolateEnv(input, env) {
  if (typeof input !== "string" || !env) return input;
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
    const value = env[name];
    return value === undefined || value === null ? whole : String(value);
  });
}

async function runHttpStep(step, { signal, fetchImpl, env } = {}) {
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== "function") {
    return { ok: false, reason: "no-fetch", body: null, status: null };
  }
  const timeoutMs = (step.timeoutSec || DEFAULT_HTTP_TIMEOUT_SEC) * 1000;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const init = {
      method: step.method || "GET",
      headers: { ...(step.headers || {}) },
      signal: controller.signal,
    };
    if (step.body !== undefined && init.method !== "GET" && init.method !== "HEAD") {
      if (typeof step.body === "string") {
        init.body = step.body;
      } else {
        init.body = JSON.stringify(step.body);
        init.headers["content-type"] = init.headers["content-type"] || "application/json";
      }
    }
    const resolvedUrl = interpolateEnv(step.url, env);
    const response = await fetcher(resolvedUrl, init);
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    const okStatusCodes = step.okStatusCodes || [200, 201];
    const ok = okStatusCodes.includes(response.status);
    return { ok, status: response.status, body: parsed, raw: text };
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "timeout" : "fetch-error", error: String(error?.message || error), body: null, status: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

function captureSettingsFromBody(captureSettings, body) {
  if (!captureSettings || typeof captureSettings !== "object") return {};
  if (!body || typeof body !== "object") return {};
  const out = {};
  for (const [bodyKey, settingKey] of Object.entries(captureSettings)) {
    const value = bodyKey
      .split(".")
      .reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), body);
    if (value !== undefined && value !== null) {
      out[String(settingKey)] = value;
    }
  }
  return out;
}

// A setting name "looks secret" if its tail matches one of these well-known
// suffixes. Used as a heuristic to auto-add captured values to the
// secret-mask list — keeps the install runner from leaking pasted/captured
// API tokens through stdout/stderr/error log entries by accident.
const SECRET_SETTING_TAIL_PATTERN = /(Token|Key|Secret|Password|ApiKey|PrivateKey)$/i;

export function looksLikeSecretSetting(settingKey) {
  if (!settingKey || typeof settingKey !== "string") return false;
  return SECRET_SETTING_TAIL_PATTERN.test(settingKey);
}

// Replace every occurrence of any string in `secrets` with [redacted]. The
// substitution is plain-substring (not regex) so callers don't need to
// escape anything. Empty strings and very short strings (<4 chars) are
// skipped — they'd produce too many false-positive substitutions and would
// shred normal output ("a" appearing as a "secret" would obliterate every
// "a" in stdout).
export function maskSecrets(text, secrets) {
  if (!text || !secrets) return text;
  let out = String(text);
  for (const secret of secrets) {
    const value = String(secret || "");
    if (value.length < 4) continue;
    if (!out.includes(value)) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
}

// Recursively redact every string field in a log entry. We only walk one
// level deep because the runner only emits flat objects today; a deeper
// walk would be wasted work.
function redactLogEntry(entry, secrets) {
  if (!entry || typeof entry !== "object") return entry;
  if (!secrets || secrets.size === 0) return entry;
  const out = {};
  const secretArray = [...secrets];
  for (const [key, value] of Object.entries(entry)) {
    out[key] = typeof value === "string" ? maskSecrets(value, secretArray) : value;
  }
  return out;
}

export async function executeInstallPlan(plan, options = {}) {
  const {
    appendLog: rawAppendLog = () => {},
    settingsStore = null,
    signal,
    fetchImpl,
    mcpRegistry = null,
    buildingId = null,
    // Extra env merged into every shell-step spawn. We use this to inject
    // VIBE_RESEARCH_APP_DIR so manifest commands can locate scripts under
    // <appDir>/bin/ (e.g. vr-pip-install-tool) regardless of the user's
    // PATH. Also useful for tests that want to inject HOME, etc.
    spawnEnv = null,
    // When true, an auth-browser-cli plan whose verify fails is reported
    // as `auth-required` instead of having its auth command auto-run. The
    // UI then surfaces an explicit "Authenticate" button (see
    // executeAuthPhase / POST /api/buildings/:id/authenticate) so the
    // browser tab only opens on a deliberate user click — placement no
    // longer hijacks the screen with a sign-in popup.
    deferBrowserAuth = false,
  } = options;

  // Secret-mask set: every value in here is replaced with [redacted] in
  // stdout/stderr/error/message/step text emitted to the install log. We
  // seed it from any pre-existing value at an auth-paste target setting
  // (the human may have pasted before clicking Install again) and grow it
  // as http captures land.
  const secrets = new Set();
  const noteSecret = (value) => {
    const text = String(value ?? "").trim();
    if (text.length >= 4) secrets.add(text);
  };
  if (plan && plan.auth?.kind === "auth-paste" && plan.auth.setting && settingsStore?.settings) {
    const seed = settingsStore.settings[plan.auth.setting];
    if (typeof seed === "string" && seed.trim()) noteSecret(seed);
  }
  // The runner-internal appendLog runs every entry through redactLogEntry
  // before forwarding to the caller, so even hand-written log lines that
  // happen to interpolate a secret get scrubbed.
  const appendLog = (entry) => rawAppendLog(redactLogEntry(entry, secrets));

  if (!plan || typeof plan !== "object") {
    appendLog({ phase: "system", level: "error", message: "no install plan" });
    return { status: "failed", reason: "no-plan" };
  }

  const capturedSettings = {};

  // 1) Preflight: detect existing install. If every preflight command exits
  //    cleanly we skip the install phase but still run verify (if any).
  let preflightAllOk = true;
  for (const step of plan.preflight || []) {
    appendLog({ phase: "preflight", level: "info", step: step.label || step.command, message: "running" });
    const result = await runShellCommand(step, { signal, env: spawnEnv });
    appendLog({
      phase: "preflight",
      level: result.ok ? "info" : "warn",
      step: step.label || step.command,
      message: result.ok ? "ok" : `not detected (exit=${result.exitCode})`,
      stdoutTail: result.stdout?.slice(-200),
      stderrTail: result.stderr?.slice(-200),
    });
    if (!result.ok) preflightAllOk = false;
  }

  // 2) Install steps (only if preflight didn't already detect everything).
  if (!preflightAllOk) {
    for (const step of plan.install || []) {
      appendLog({ phase: "install", level: "info", step: step.label || step.command, message: "running" });
      if (step.kind === "command") {
        const result = await runShellCommand(step, { signal, env: spawnEnv });
        appendLog({
          phase: "install",
          level: result.ok ? "info" : "error",
          step: step.label || step.command,
          message: result.ok ? "ok" : `failed (exit=${result.exitCode}, reason=${result.reason || "exit-code"})`,
          stdoutTail: result.stdout?.slice(-400),
          stderrTail: result.stderr?.slice(-400),
        });
        if (!result.ok) {
          return {
            status: "failed",
            // Include the tail of stderr in the reason so the UI shows the
            // actual failure (PEP 668, missing dep, network error) instead
            // of just "step X failed". The log entry above carries the
            // full tails too — this is the at-a-glance summary.
            reason: formatStepFailureReason(step, result),
            capturedSettings,
          };
        }
      } else if (step.kind === "http") {
        // Pass spawnEnv so the URL can reference VIBE_RESEARCH_SERVER_URL
        // and friends via ${VAR} interpolation — see runHttpStep.
        const result = await runHttpStep(step, { signal, fetchImpl, env: spawnEnv });
        appendLog({
          phase: "install",
          level: result.ok ? "info" : "error",
          step: step.label || step.url,
          message: result.ok ? `ok (status=${result.status})` : `failed (status=${result.status}, reason=${result.reason || "non-2xx"})`,
        });
        if (!result.ok) {
          return { status: "failed", reason: `install http step "${step.label || step.url}" failed`, capturedSettings };
        }
        const captured = captureSettingsFromBody(step.captureSettings, result.body);
        Object.assign(capturedSettings, captured);
        // Any captured value whose target setting name looks secret gets
        // added to the mask list immediately, so subsequent verify/auth
        // steps that echo it (e.g. a CLI that prints "Token: xxx") don't
        // leak it into the install log.
        for (const [settingKey, value] of Object.entries(captured)) {
          if (looksLikeSecretSetting(settingKey)) noteSecret(value);
        }
      }
    }
  } else {
    appendLog({ phase: "install", level: "info", message: "preflight detected existing install — skipping install phase" });
  }

  // 3) Auth step: only run if verify will need it. We try verify first; if it
  //    passes, no auth needed; if it fails AND an auth step exists, run auth
  //    then verify again.
  async function runVerify() {
    if (!plan.verify?.length) return { ok: true, reason: "no-verify" };
    for (const step of plan.verify) {
      appendLog({ phase: "verify", level: "info", step: step.label || step.command, message: "running" });
      const result = await runShellCommand(step, { signal, env: spawnEnv });
      appendLog({
        phase: "verify",
        level: result.ok ? "info" : "warn",
        step: step.label || step.command,
        message: result.ok ? "ok" : `failed (exit=${result.exitCode})`,
        stdoutTail: result.stdout?.slice(-400),
        stderrTail: result.stderr?.slice(-400),
      });
      if (!result.ok) return { ok: false, reason: result.reason || "verify-failed" };
    }
    return { ok: true };
  }

  const firstVerify = await runVerify();

  // For auth-paste, the runner pauses whenever the target setting is empty
  // — that's the contract: the package is verified, but the human still
  // needs to paste a token before the building is functional. Even if the
  // upstream verify passed (e.g. `npm view ... version` succeeds), an
  // auth-paste building remains in `auth-required` until the setting is
  // filled. This is what powers the "click Install → see paste field"
  // panel UX for popular MCP-server integrations.
  const pasteSettingMissing = (() => {
    if (plan.auth?.kind !== "auth-paste") return false;
    const setting = plan.auth.setting;
    if (!setting) return false;
    const captured = capturedSettings[setting];
    if (captured !== undefined && captured !== null && String(captured).trim() !== "") return false;
    const current = settingsStore?.settings?.[setting];
    if (current !== undefined && current !== null && String(current).trim() !== "") return false;
    return true;
  })();

  if (!firstVerify.ok && plan.auth?.kind === "auth-browser-cli" && deferBrowserAuth) {
    // Deferred-auth path: don't auto-run the browser-CLI auth command.
    // Return auth-required with the metadata the UI needs to render an
    // explicit "Authenticate" button. POST /api/buildings/:id/authenticate
    // runs executeAuthPhase to actually fire the browser-CLI command when
    // the user opts in.
    appendLog({
      phase: "auth",
      level: "info",
      step: plan.auth.command,
      message: `auth-required: deferred until user clicks Authenticate (${plan.auth.command})`,
    });
    if (settingsStore && Object.keys(capturedSettings).length) {
      try { await settingsStore.update(capturedSettings); } catch (err) {
        appendLog({ phase: "settings", level: "warn", message: `settings update failed: ${err?.message || err}` });
      }
    }
    return {
      status: "auth-required",
      reason: "browser-auth-pending",
      capturedSettings,
      authPrompt: {
        kind: "auth-browser-cli",
        command: plan.auth.command,
        label: plan.auth.label || `Sign in to ${buildingId || "building"}`,
        detail: plan.auth.detail || "",
        timeoutSec: plan.auth.timeoutSec || 300,
      },
    };
  } else if (!firstVerify.ok && plan.auth?.kind === "auth-browser-cli") {
    appendLog({ phase: "auth", level: "info", step: plan.auth.command, message: "running" });
    const result = await runShellCommand({ ...plan.auth, timeoutSec: plan.auth.timeoutSec || 300 }, { signal });
    appendLog({
      phase: "auth",
      level: result.ok ? "info" : "warn",
      step: plan.auth.command,
      message: result.ok ? "ok" : `failed (exit=${result.exitCode}, reason=${result.reason || "exit-code"})`,
      stdoutTail: result.stdout?.slice(-400),
      stderrTail: result.stderr?.slice(-400),
    });
  } else if (plan.auth?.kind === "auth-paste" && pasteSettingMissing) {
    appendLog({
      phase: "auth",
      level: "info",
      step: plan.auth.setting,
      message: `auth-required: paste credential into setting "${plan.auth.setting}"`,
    });
    if (settingsStore && Object.keys(capturedSettings).length) {
      try { await settingsStore.update(capturedSettings); } catch (err) {
        appendLog({ phase: "settings", level: "warn", message: `settings update failed: ${err?.message || err}` });
      }
    }
    return {
      status: "auth-required",
      reason: "paste-token",
      capturedSettings,
      authPrompt: {
        setting: plan.auth.setting,
        setupUrl: plan.auth.setupUrl,
        setupLabel: plan.auth.setupLabel,
        detail: plan.auth.detail,
      },
    };
  }

  // 4) Apply captured settings (e.g. ottoauth privateKey from /api/agents/create)
  if (settingsStore && Object.keys(capturedSettings).length) {
    try {
      await settingsStore.update(capturedSettings);
      appendLog({ phase: "settings", level: "info", message: `applied ${Object.keys(capturedSettings).length} captured setting(s)` });
    } catch (err) {
      appendLog({ phase: "settings", level: "error", message: `settings update failed: ${err?.message || err}` });
      return { status: "failed", reason: `settings update failed: ${err?.message || err}`, capturedSettings };
    }
  }

  // 5) Final verify (after auth if it ran).
  const secondVerify = firstVerify.ok ? firstVerify : await runVerify();
  if (!secondVerify.ok) {
    if (plan.auth) {
      return { status: "auth-required", reason: secondVerify.reason || "verify-failed-after-auth", capturedSettings };
    }
    return { status: "failed", reason: secondVerify.reason || "verify-failed", capturedSettings };
  }

  // 6) Declare MCP launches (runtime owns lifecycle).
  const declaredLaunches = [];
  for (const step of plan.mcp || []) {
    appendLog({
      phase: "mcp",
      level: "info",
      step: step.label || step.command,
      message: `declared mcp launcher: ${step.command} ${asArray(step.args).join(" ")}`,
    });
    declaredLaunches.push({
      command: step.command,
      args: asArray(step.args),
      env: step.env || {},
      label: step.label || "",
    });
  }
  if (mcpRegistry && typeof mcpRegistry.declare === "function" && buildingId) {
    try {
      mcpRegistry.declare(buildingId, declaredLaunches);
    } catch (err) {
      appendLog({ phase: "mcp", level: "warn", message: `mcp registry declare failed: ${err?.message || err}` });
    }
  }

  return { status: "ok", capturedSettings, declaredLaunches };
}

// Run ONLY the auth + verify phases of an install plan. Used by the
// deferred auth-browser-cli flow: the install runs preflight + install +
// verify and returns auth-required, then the user clicks an "Authenticate"
// button in the UI which POSTs /api/buildings/:id/authenticate, which
// invokes this. Splitting these out keeps placement-time installs from
// auto-popping a sign-in tab that the user didn't ask for.
export async function executeAuthPhase(plan, options = {}) {
  const {
    appendLog: rawAppendLog = () => {},
    settingsStore = null,
    signal,
    spawnEnv = null,
  } = options;
  const appendLog = (entry) => rawAppendLog(entry);

  if (!plan || typeof plan !== "object") {
    appendLog({ phase: "system", level: "error", message: "no install plan" });
    return { status: "failed", reason: "no-plan" };
  }
  if (plan.auth?.kind !== "auth-browser-cli") {
    appendLog({ phase: "system", level: "error", message: `auth phase not supported for kind=${plan.auth?.kind || "none"}` });
    return { status: "failed", reason: "auth-not-applicable" };
  }

  appendLog({ phase: "auth", level: "info", step: plan.auth.command, message: "running" });
  const authResult = await runShellCommand(
    { ...plan.auth, timeoutSec: plan.auth.timeoutSec || 300 },
    { signal, env: spawnEnv },
  );
  appendLog({
    phase: "auth",
    level: authResult.ok ? "info" : "warn",
    step: plan.auth.command,
    message: authResult.ok ? "ok" : `failed (exit=${authResult.exitCode}, reason=${authResult.reason || "exit-code"})`,
    stdoutTail: authResult.stdout?.slice(-400),
    stderrTail: authResult.stderr?.slice(-400),
  });
  if (!authResult.ok) {
    return { status: "failed", reason: `auth command failed (exit=${authResult.exitCode}, reason=${authResult.reason || "exit-code"})` };
  }

  // Verify the new credentials actually work (e.g. `modal token info`).
  if (Array.isArray(plan.verify) && plan.verify.length) {
    for (const step of plan.verify) {
      appendLog({ phase: "verify", level: "info", step: step.label || step.command, message: "running" });
      const result = await runShellCommand(step, { signal, env: spawnEnv });
      appendLog({
        phase: "verify",
        level: result.ok ? "info" : "warn",
        step: step.label || step.command,
        message: result.ok ? "ok" : `failed (exit=${result.exitCode})`,
        stdoutTail: result.stdout?.slice(-400),
        stderrTail: result.stderr?.slice(-400),
      });
      if (!result.ok) {
        return { status: "failed", reason: result.reason || "verify-failed-after-auth" };
      }
    }
  }

  return { status: "ok" };
}

// Build the spawn env injected into install/auth-plan shell steps. Manifest
// commands can reach internal Vibe Research APIs via `$VIBE_RESEARCH_SERVER_URL`
// — used by buildings whose install plan needs to call back into the local
// server (e.g. VideoMemory uses this to POST /api/videomemory/install-server
// during its install plan).
function buildPlanSpawnEnv({ appDir, serverBaseUrl } = {}) {
  const env = {};
  if (appDir) env.VIBE_RESEARCH_APP_DIR = appDir;
  if (serverBaseUrl) env.VIBE_RESEARCH_SERVER_URL = serverBaseUrl;
  return Object.keys(env).length ? env : null;
}

export function startAuthenticateJob({
  jobStore,
  building,
  settingsStore,
  appDir = null,
  serverBaseUrl = null,
}) {
  const job = jobStore.create(building.id);
  const controller = new AbortController();
  job.abort = () => controller.abort();

  const append = (entry) => jobStore.appendLog(job.id, entry);

  (async () => {
    try {
      append({ phase: "system", level: "info", message: `auth phase started for ${building.id}` });
      const plan = building.install?.plan;
      if (!plan) {
        jobStore.update(job.id, { status: "failed", result: { reason: "no-plan" } });
        append({ phase: "system", level: "error", message: "building has no install plan" });
        return;
      }
      const result = await executeAuthPhase(plan, {
        appendLog: append,
        settingsStore,
        signal: controller.signal,
        spawnEnv: buildPlanSpawnEnv({ appDir, serverBaseUrl }),
      });
      jobStore.update(job.id, {
        status: result.status === "ok" ? "ok" : result.status,
        result,
      });
      append({ phase: "system", level: result.status === "ok" ? "info" : "warn", message: `auth finished: ${result.status}` });
    } catch (err) {
      jobStore.update(job.id, { status: "failed", result: { reason: String(err?.message || err) } });
      append({ phase: "system", level: "error", message: `auth crashed: ${err?.message || err}` });
    }
  })().catch(() => {});

  return job;
}

export function startInstallJob({
  jobStore,
  building,
  settingsStore,
  fetchImpl,
  mcpRegistry,
  // Optional MCP-protocol handshake function. When supplied, the job
  // runs handshake on every declared mcp-launch right after the install
  // plan completes successfully. Results are attached to the job's
  // result.handshakes — the install status itself is NOT downgraded if
  // a handshake fails (a missing/wrong token is not the same kind of
  // failure as the install plan itself failing). The UI uses
  // result.handshakes to render "installed, but the server isn't
  // responding".
  runHandshake,
  // Optional auto-sync hook. When supplied, the install job calls this
  // after the handshake step (regardless of handshake outcome) so the
  // user's Claude Code + Codex configs immediately see the new
  // building. Sync errors are caught and logged but do NOT downgrade
  // install status — that's the same intent as the handshake step:
  // ancillary verification, not install gating.
  runAutoSync,
  // Absolute path to the app root (where bin/, scripts/, package.json live).
  // Injected as VIBE_RESEARCH_APP_DIR into every shell-step env so manifest
  // commands can call shipped scripts via stable paths like
  // `bash "$VIBE_RESEARCH_APP_DIR/bin/vr-pip-install-tool" modal` without
  // assuming any particular install layout on disk.
  appDir = null,
  // Resolved local URL of the running Vibe Research server (e.g.
  // `http://127.0.0.1:4828`). Injected as VIBE_RESEARCH_SERVER_URL so an
  // install plan can call back into local APIs without hard-coding the
  // port — used by VideoMemory's plan to POST
  // /api/videomemory/install-server.
  serverBaseUrl = null,
}) {
  const job = jobStore.create(building.id);
  const controller = new AbortController();
  job.abort = () => controller.abort();

  const append = (entry) => jobStore.appendLog(job.id, entry);

  // Detached promise — caller polls /jobs/:id for status.
  (async () => {
    try {
      append({ phase: "system", level: "info", message: `install plan started for ${building.id}` });
      const plan = building.install?.plan;
      if (!plan) {
        jobStore.update(job.id, { status: "failed", result: { reason: "no-plan" } });
        append({ phase: "system", level: "error", message: "building has no install plan" });
        return;
      }
      const result = await executeInstallPlan(plan, {
        appendLog: append,
        settingsStore,
        signal: controller.signal,
        fetchImpl,
        mcpRegistry,
        buildingId: building.id,
        spawnEnv: buildPlanSpawnEnv({ appDir, serverBaseUrl }),
        // Defer auth-browser-cli to a deliberate user click (POST
        // /api/buildings/:id/authenticate) instead of auto-opening a
        // sign-in tab the moment the user finishes placing the building.
        deferBrowserAuth: true,
      });
      // Record the install outcome on the registry so /api/mcp/launches
      // can show "installed 2 days ago, status ok" inline. We do this
      // BEFORE the optional auto-handshake so that even if the
      // handshake step is skipped (no runHandshake provided) the
      // lastInstall stamp still lands.
      if (mcpRegistry && typeof mcpRegistry.recordInstall === "function") {
        try {
          mcpRegistry.recordInstall(building.id, {
            jobId: job.id,
            ok: result.status === "ok",
            status: result.status,
            reason: result.reason,
          });
        } catch {}
      }
      // Auto-handshake: if the plan succeeded and declared mcp launches,
      // try to actually speak MCP against each one and stash the
      // results. This makes "click Install → see ok" mean "the server
      // works", not just "the npm package exists".
      if (
        result.status === "ok"
        && typeof runHandshake === "function"
        && mcpRegistry
        && typeof mcpRegistry.list === "function"
      ) {
        const launches = mcpRegistry
          .list({ resolved: true })
          .filter((entry) => entry.buildingId === building.id);
        if (launches.length === 0) {
          // Plan declared no mcp-launch steps (or registry was cleared
          // mid-install). Don't attach an empty handshakes array — that
          // would imply "we tried zero handshakes" rather than "we
          // didn't need to".
        }
        const handshakes = [];
        for (const launch of launches) {
          append({ phase: "handshake", level: "info", step: launch.label || launch.command, message: "running" });
          let handshakeResult;
          try {
            handshakeResult = await runHandshake({
              command: launch.command,
              args: launch.args,
              env: launch.env,
            });
          } catch (err) {
            handshakeResult = { ok: false, status: "handshake-crash", error: String(err?.message || err) };
          }
          append({
            phase: "handshake",
            level: handshakeResult.ok ? "info" : "warn",
            step: launch.label || launch.command,
            message: handshakeResult.ok
              ? `ok (${handshakeResult.toolCount ?? 0} tools)`
              : `failed: ${handshakeResult.status} ${handshakeResult.error || ""}`.trim(),
          });
          handshakes.push({
            label: launch.label || "",
            ok: Boolean(handshakeResult.ok),
            status: handshakeResult.status || "unknown",
            toolCount: handshakeResult.toolCount,
            serverName: handshakeResult.serverName,
            serverVersion: handshakeResult.serverVersion,
            error: handshakeResult.error,
          });
          // Record into the registry so the UI's launch list can show
          // "tools-listed (5 tools), 30s ago" inline next to each launch.
          if (typeof mcpRegistry.recordHandshake === "function") {
            try {
              mcpRegistry.recordHandshake(building.id, launch.label || "", {
                ok: Boolean(handshakeResult.ok),
                status: handshakeResult.status,
                toolCount: handshakeResult.toolCount,
                serverName: handshakeResult.serverName,
                serverVersion: handshakeResult.serverVersion,
                error: handshakeResult.error,
              });
            } catch {}
          }
        }
        if (handshakes.length > 0) {
          result.handshakes = handshakes;
        }
      }
      // Auto-sync: write the registry to the agent CLIs' on-disk
      // configs so Claude Code + Codex see the new building without
      // a manual round-trip. Failure here doesn't fail the install —
      // a sync error means the agents will pick up the change on the
      // next manual /api/mcp/sync, but the install itself worked.
      if (result.status === "ok" && typeof runAutoSync === "function") {
        try {
          const syncResult = await runAutoSync();
          if (syncResult) {
            result.autoSync = syncResult;
            const targets = Object.keys(syncResult).join(", ");
            append({ phase: "system", level: "info", message: `auto-synced agent configs (${targets})` });
          }
        } catch (err) {
          append({ phase: "system", level: "warn", message: `auto-sync failed: ${err?.message || err}` });
          result.autoSyncError = String(err?.message || err);
        }
      }
      jobStore.update(job.id, {
        status: result.status === "ok" ? "ok" : result.status,
        result,
      });
      append({ phase: "system", level: result.status === "ok" ? "info" : "warn", message: `install finished: ${result.status}` });
    } catch (err) {
      jobStore.update(job.id, { status: "failed", result: { reason: String(err?.message || err) } });
      append({ phase: "system", level: "error", message: `install crashed: ${err?.message || err}` });
    }
  })().catch(() => {});

  return job;
}

export const __internal = {
  buildSpawnEnv,
  formatStepFailureReason,
  resolveVibeResearchLocalBin,
};

// Tiny helper for tests so they don't have to actually wait.
export async function waitForJob(jobStore, jobId, { timeoutMs = 5000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = jobStore.get(jobId);
    if (!job) return null;
    if (job.status !== "running") return job;
    await wait(pollMs);
  }
  return jobStore.get(jobId);
}
