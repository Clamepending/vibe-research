// Dry-run an MCP-launch declaration: spawn the resolved command, watch it
// for a short window, kill it, report whether it stayed alive.
//
// This is intentionally weaker than a full MCP-protocol handshake. It
// only confirms:
//   - the configured binary (e.g. `npx`) is on PATH
//   - the npx fetch / binary launch did not error immediately
//   - the process didn't crash inside the warmup window (default 1.5s)
//
// What it does NOT confirm:
//   - that the server speaks correct MCP (no tools/list round-trip)
//   - that the token actually works against the upstream API
//
// That deeper check is a follow-up. For "did clicking Install actually
// produce a usable MCP server?" this is good enough to catch the common
// failure modes (typo in args, missing required env, missing binary).

import { spawn as defaultSpawn } from "node:child_process";

const DEFAULT_WARMUP_MS = 1500;
const DEFAULT_KILL_GRACE_MS = 500;
const STDIO_TAIL_BYTES = 800;

function clampString(text, max) {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

export async function testLaunch(launch, options = {}) {
  const {
    spawnImpl = defaultSpawn,
    warmupMs = DEFAULT_WARMUP_MS,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    env = process.env,
  } = options;

  if (!launch || typeof launch !== "object") {
    return { ok: false, status: "invalid-launch", error: "no launch provided" };
  }
  if (!launch.command || typeof launch.command !== "string") {
    return { ok: false, status: "invalid-launch", error: "launch has no command" };
  }
  // Refuse to test an unresolved launch — it would just hard-fail when the
  // upstream server tried to read ${...} as a literal token.
  const everyArg = Array.isArray(launch.args) ? launch.args : [];
  const envValues = launch.env && typeof launch.env === "object" ? Object.values(launch.env) : [];
  const stillTemplated = (text) => typeof text === "string" && /\$\{[a-zA-Z_][a-zA-Z0-9_]*\}/.test(text);
  if (stillTemplated(launch.command) || everyArg.some(stillTemplated) || envValues.some(stillTemplated)) {
    return { ok: false, status: "unresolved-template", error: "launch still contains ${settingKey} templates" };
  }

  return await new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (payload) => {
      if (settled) return;
      settled = true;
      try { child?.kill?.("SIGTERM"); } catch {}
      // Hard kill after a small grace window in case the process ignores SIGTERM.
      setTimeout(() => {
        try { child?.kill?.("SIGKILL"); } catch {}
      }, killGraceMs);
      resolve(payload);
    };

    try {
      child = spawnImpl(launch.command, everyArg, {
        env: { ...env, ...(launch.env || {}) },
      });
    } catch (err) {
      resolve({ ok: false, status: "spawn-failed", error: err?.message || String(err) });
      return;
    }

    child.stdout?.on?.("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on?.("data", (chunk) => { stderr += chunk.toString(); });
    child.on?.("error", (err) => {
      settle({
        ok: false,
        status: "spawn-failed",
        error: err?.message || String(err),
        stdoutTail: clampString(stdout, STDIO_TAIL_BYTES),
        stderrTail: clampString(stderr, STDIO_TAIL_BYTES),
      });
    });
    child.on?.("exit", (code, signal) => {
      // The process exited inside the warmup window. That's a fail signal
      // for an MCP server (it should run until we kill it).
      settle({
        ok: false,
        status: "exited-fast",
        exitCode: code,
        signal,
        stdoutTail: clampString(stdout, STDIO_TAIL_BYTES),
        stderrTail: clampString(stderr, STDIO_TAIL_BYTES),
      });
    });

    setTimeout(() => {
      // Process is still alive after warmupMs — that's success.
      settle({
        ok: true,
        status: "alive",
        warmupMs,
        stdoutTail: clampString(stdout, STDIO_TAIL_BYTES),
        stderrTail: clampString(stderr, STDIO_TAIL_BYTES),
      });
    }, warmupMs);
  });
}
