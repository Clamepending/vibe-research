// Keep the user's standalone VideoMemory checkout (~/videomemory by default)
// up to date with origin/main. This is the "periodic git pull" piece of the
// VideoMemory building's lifecycle: once Vibe Research has cloned the repo
// during install, the working tree drifts the moment the upstream merges
// new code, and the launched server keeps running stale logic.
//
// What this module does NOT do:
//   - Auto-restart the launched server. A pull-and-restart loop would
//     interrupt running monitors at unpredictable times. We pull (so
//     newer code is on disk) and let the user trigger a restart by
//     toggling videoMemoryEnabled or restarting Vibe Research itself.
//   - Reset uncommitted changes. If the user is hacking on
//     ~/videomemory, `--ff-only` makes the pull fail loudly instead of
//     clobbering their work.

import { execFile } from "node:child_process";
import { stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 60_000;

const execFileAsync = promisify(execFile);

// Pull origin/main on the user's videomemory checkout. Returns a structured
// result; callers (the server hook + the API endpoint + the tests) read
// `.ok` to decide whether to log a warning.
//
//   - returns { ok: false, reason: "not-installed" } when the path is
//     missing or doesn't have a .git dir — there's nothing to pull yet.
//   - returns { ok: true, status: "no-op" } when nothing changed.
//   - returns { ok: true, status: "pulled", stdout } when fast-forward
//     succeeded.
//   - returns { ok: false, status: "failed", reason } on any error,
//     including non-fast-forward (uncommitted changes, divergent
//     history) — those are user-fixable, not silent corruption.
export async function runVideoMemoryGitPull({
  installRoot,
  execFileImpl = execFileAsync,
  statImpl = fsStat,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!installRoot || typeof installRoot !== "string") {
    return { ok: false, reason: "no-install-root" };
  }

  const gitDir = path.join(installRoot, ".git");
  try {
    const info = await statImpl(gitDir);
    if (!info.isDirectory()) {
      return { ok: false, reason: "not-installed" };
    }
  } catch {
    return { ok: false, reason: "not-installed" };
  }

  try {
    const { stdout = "" } = await execFileImpl(
      "git",
      ["-C", installRoot, "pull", "--ff-only", "origin"],
      { timeout: timeoutMs },
    );
    const text = String(stdout || "").trim();
    if (/already up to date/i.test(text) || !text) {
      return { ok: true, status: "no-op", stdout: text };
    }
    return { ok: true, status: "pulled", stdout: text };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      reason: error?.stderr ? String(error.stderr).trim() : String(error?.message || error),
    };
  }
}

// Start a recurring 24-hour timer that pulls the checkout in the background.
// Returns a function the caller invokes during shutdown to stop the timer.
//
// We run the pull once immediately on startup so a long-running server
// picks up upstream fixes without waiting for the next tick.
//
// Callers pass `log` to record outcomes; default is a silent no-op so
// tests don't have to capture noise.
export function startPeriodicVideoMemoryGitPull({
  installRoot,
  intervalMs = DEFAULT_INTERVAL_MS,
  log = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  pullImpl = runVideoMemoryGitPull,
  runImmediately = true,
} = {}) {
  if (!installRoot) return () => {};

  let cancelled = false;
  let timer = null;

  const tick = async () => {
    if (cancelled) return;
    try {
      const result = await pullImpl({ installRoot });
      log({ event: "videomemory-git-pull", installRoot, result });
    } catch (error) {
      log({
        event: "videomemory-git-pull",
        installRoot,
        result: { ok: false, status: "crash", reason: String(error?.message || error) },
      });
    }
  };

  if (runImmediately) {
    void tick();
  }
  timer = setIntervalImpl(() => { void tick(); }, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();

  return function stop() {
    cancelled = true;
    if (timer != null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  };
}
