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
  };
}

async function runShellCommand(step, { signal } = {}) {
  const timeoutMs = (step.timeoutSec || DEFAULT_COMMAND_TIMEOUT_SEC) * 1000;
  return await new Promise((resolve) => {
    const child = spawn(step.command, {
      shell: step.shell !== false,
      env: { ...process.env },
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

async function runHttpStep(step, { signal, fetchImpl } = {}) {
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
    const response = await fetcher(step.url, init);
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

export async function executeInstallPlan(plan, options = {}) {
  const {
    appendLog = () => {},
    settingsStore = null,
    signal,
    fetchImpl,
  } = options;

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
    const result = await runShellCommand(step, { signal });
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
        const result = await runShellCommand(step, { signal });
        appendLog({
          phase: "install",
          level: result.ok ? "info" : "error",
          step: step.label || step.command,
          message: result.ok ? "ok" : `failed (exit=${result.exitCode}, reason=${result.reason || "exit-code"})`,
          stdoutTail: result.stdout?.slice(-400),
          stderrTail: result.stderr?.slice(-400),
        });
        if (!result.ok) {
          return { status: "failed", reason: `install step "${step.label || step.command}" failed`, capturedSettings };
        }
      } else if (step.kind === "http") {
        const result = await runHttpStep(step, { signal, fetchImpl });
        appendLog({
          phase: "install",
          level: result.ok ? "info" : "error",
          step: step.label || step.url,
          message: result.ok ? `ok (status=${result.status})` : `failed (status=${result.status}, reason=${result.reason || "non-2xx"})`,
        });
        if (!result.ok) {
          return { status: "failed", reason: `install http step "${step.label || step.url}" failed`, capturedSettings };
        }
        Object.assign(capturedSettings, captureSettingsFromBody(step.captureSettings, result.body));
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
      const result = await runShellCommand(step, { signal });
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

  if (!firstVerify.ok && plan.auth?.kind === "auth-browser-cli") {
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
  for (const step of plan.mcp || []) {
    appendLog({
      phase: "mcp",
      level: "info",
      step: step.label || step.command,
      message: `declared mcp launcher: ${step.command} ${asArray(step.args).join(" ")}`,
    });
  }

  return { status: "ok", capturedSettings };
}

export function startInstallJob({ jobStore, building, settingsStore, fetchImpl }) {
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
      });
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
