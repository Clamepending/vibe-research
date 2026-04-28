// Periodic health-check scheduler for the MCP-launch health monitor.
//
// Without this, the UI only refreshes "broken MCP server" status when
// the user explicitly clicks refresh. Tokens expire silently, upstream
// services go down — the user doesn't notice until they try to use the
// affected tool. Running monitor.checkAll() on a timer (default every
// 5 minutes) surfaces problems proactively.
//
// API:
//   const scheduler = createMcpLaunchHealthScheduler({ monitor, intervalMs });
//   scheduler.start();    // schedules the first tick
//   scheduler.stop();     // cancels the next tick
//   scheduler.isRunning();
//
// Implementation uses setTimeout-based recursive scheduling rather than
// setInterval so:
//   - the tick can run for longer than the interval without overlapping
//   - errors in checkAll don't kill the scheduler — the next tick is
//     scheduled in the .finally() handler regardless
//   - tests can inject setTimeoutImpl + clearTimeoutImpl to drive ticks
//     deterministically without sleep()

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_INITIAL_DELAY_MS = 10_000;

export function createMcpLaunchHealthScheduler({
  monitor,
  intervalMs = DEFAULT_INTERVAL_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  onError = (err) => { console.error("[mcp-health-scheduler] tick failed:", err); },
} = {}) {
  if (!monitor || typeof monitor.checkAll !== "function") {
    throw new TypeError("monitor with checkAll() is required");
  }

  // intervalMs accepts either a Number or a callable that returns the
  // current desired interval. Callable form lets a settings change take
  // effect on the next scheduled tick without stop/start dance.
  const resolveIntervalMs = () => {
    const raw = typeof intervalMs === "function" ? intervalMs() : intervalMs;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_INTERVAL_MS;
    return numeric;
  };

  let timer = null;
  let running = false;
  let tickCount = 0;
  let inFlight = null;

  const scheduleNext = (delay) => {
    if (!running) return;
    timer = setTimeoutImpl(tick, delay);
  };

  async function tick() {
    timer = null;
    if (!running) return;
    tickCount += 1;
    const promise = (async () => {
      try {
        await monitor.checkAll({ force: true });
      } catch (err) {
        try { onError(err); } catch {}
      }
    })();
    inFlight = promise;
    promise.finally(() => {
      if (inFlight === promise) inFlight = null;
      scheduleNext(resolveIntervalMs());
    });
    await promise;
  }

  return {
    start() {
      if (running) return;
      running = true;
      scheduleNext(initialDelayMs);
    },
    stop() {
      running = false;
      if (timer !== null) {
        clearTimeoutImpl(timer);
        timer = null;
      }
    },
    isRunning() { return running; },
    tickCount() { return tickCount; },
    // Run a single tick immediately. Useful for tests + the
    // /api/mcp/launches/health POST handler when it wants to trigger a
    // background check without blocking the request thread.
    async runOnce() {
      tickCount += 1;
      try {
        await monitor.checkAll({ force: true });
      } catch (err) {
        try { onError(err); } catch {}
      }
    },
  };
}
