// Aggregate health checker for MCP launches.
//
// Runs a protocol handshake against every declared launch in the
// registry, returns a per-building summary, and caches the result for a
// short window so repeated UI polls don't stampede the (real-process-
// spawning) handshake.
//
// API:
//   const monitor = createMcpLaunchHealthMonitor({ registry, runHandshake });
//   await monitor.checkAll({ force });   // returns { generatedAt, results, summary }
//   monitor.lastResult();                // last cached result, or null
//   monitor.invalidate();                // drop the cache
//
// `runHandshake(launch)` is dependency-injected so tests don't have to
// spawn real MCP servers; production passes the real handshake module.

const DEFAULT_CACHE_TTL_MS = 30_000;

export function createMcpLaunchHealthMonitor({
  registry,
  runHandshake,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (!registry || typeof registry.list !== "function") {
    throw new TypeError("registry is required");
  }
  if (typeof runHandshake !== "function") {
    throw new TypeError("runHandshake is required");
  }

  let cached = null;
  // Single-flight: if checkAll() is in flight, subsequent calls share the
  // promise instead of triggering N parallel handshakes.
  let inFlight = null;

  function summarize(results) {
    const ok = results.filter((entry) => entry.ok).length;
    const broken = results.length - ok;
    return {
      total: results.length,
      ok,
      broken,
      brokenBuildings: results.filter((entry) => !entry.ok).map((entry) => entry.buildingId),
    };
  }

  async function runCheck() {
    const launches = registry.list({ resolved: true });
    const results = [];
    for (const launch of launches) {
      const handshakeResult = await runHandshake({
        command: launch.command,
        args: launch.args,
        env: launch.env,
      });
      results.push({
        buildingId: launch.buildingId,
        label: launch.label || "",
        ok: Boolean(handshakeResult.ok),
        status: handshakeResult.status || "unknown",
        toolCount: handshakeResult.toolCount,
        serverName: handshakeResult.serverName,
        serverVersion: handshakeResult.serverVersion,
        error: handshakeResult.error,
      });
    }
    return {
      generatedAt: now(),
      results,
      summary: summarize(results),
    };
  }

  return {
    async checkAll({ force = false } = {}) {
      if (!force && cached && now() - cached.generatedAt < cacheTtlMs) {
        return cached;
      }
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const result = await runCheck();
          cached = result;
          return result;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
    lastResult() {
      return cached;
    },
    invalidate() {
      cached = null;
    },
    isCacheFresh() {
      return Boolean(cached && now() - cached.generatedAt < cacheTtlMs);
    },
  };
}
