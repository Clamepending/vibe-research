// Test harness: spin up the real Vibe Research app with a buildinghub
// service whose refresh() hangs for 10s, simulating the user's reported
// slow-Tailscale-relay condition. Then expose the actual server on the
// configured port so we can drive it from a headless browser via the
// Preview MCP and verify the boot fallback never fires the error UI.
//
// Used by Claude during the boot-fallback hardening work; not part of the
// shipping product.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { createVibeResearchApp } from "../src/create-app.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function makeHangingBuildingHubServiceFactory(hangMs) {
  return () => {
    return {
      async refresh() {
        console.warn(`[slow-bh] refresh() hanging for ${hangMs}ms (simulated slow remote)`);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, hangMs);
          if (typeof timer.unref === "function") timer.unref();
        });
      },
      listBuildings() { return []; },
      listLayouts() { return []; },
      listRecipes() { return []; },
      listBundles() { return []; },
      getStatus() { return { sources: [], lastRefreshAt: 0 }; },
    };
  };
}

const port = Number(process.env.VIBE_RESEARCH_PORT || 4828);
const stateDir = process.env.VIBE_RESEARCH_STATE_DIR || "/tmp/vrtest-slow-bh-state";
const cwd = process.env.VIBE_RESEARCH_WORKSPACE_DIR || "/tmp/vrtest-slow-bh-ws";
await mkdir(stateDir, { recursive: true });
await mkdir(cwd, { recursive: true });
process.env.VIBE_RESEARCH_WORKSPACE_DIR = cwd;

const hangMs = Number(process.env.SLOW_BH_HANG_MS || 10_000);

const result = await createVibeResearchApp({
  host: "127.0.0.1",
  port,
  cwd,
  stateDir,
  persistSessions: false,
  persistentTerminals: false,
  buildingHubServiceFactory: makeHangingBuildingHubServiceFactory(hangMs),
  sleepPreventionFactory: (settings) =>
    new SleepPreventionService({ enabled: settings.preventSleepEnabled, platform: "test" }),
});
console.log(`[slow-bh] server up on http://127.0.0.1:${result.config.port} (buildinghub hangs ${hangMs}ms)`);

process.on("SIGINT", async () => {
  console.log("[slow-bh] shutting down");
  await result.close();
  process.exit(0);
});
