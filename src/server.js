import { spawn } from "node:child_process";
import { createVibeResearchApp } from "./create-app.js";
import { buildStartupOutput } from "./startup-output.js";

const configuredHost = process.env.VIBE_RESEARCH_HOST || process.env.REMOTE_VIBES_HOST || "0.0.0.0";
const configuredPort = Number(process.env.PORT || process.env.VIBE_RESEARCH_PORT || process.env.REMOTE_VIBES_PORT || 4826);

function relaunchCurrentServer() {
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: "ignore",
  });

  child.unref();
}

let vibeResearch;

try {
  vibeResearch = await createVibeResearchApp({
    host: configuredHost,
    port: configuredPort,
    onTerminate: async ({ relaunch = false } = {}) => {
      if (relaunch) {
        relaunchCurrentServer();
      }

      process.exit(0);
    },
  });
} catch (error) {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `Vibe Research could not bind ${configuredHost}:${configuredPort}. Stop the other server or relaunch with VIBE_RESEARCH_PORT=<free-port>.`,
    );
    process.exit(1);
  }

  throw error;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await vibeResearch.terminate();
  });
}

process.on("SIGHUP", () => {
  console.log("[vibe-research] Ignoring SIGHUP; use terminate, SIGINT, or SIGTERM to stop.");
});

console.log(buildStartupOutput(vibeResearch.config));
