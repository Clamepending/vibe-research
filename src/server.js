import { spawn } from "node:child_process";
import { createRemoteVibesApp } from "./create-app.js";
import { buildStartupOutput } from "./startup-output.js";

const configuredHost = process.env.REMOTE_VIBES_HOST || "0.0.0.0";
const configuredPort = Number(process.env.REMOTE_VIBES_PORT || 4123);

function relaunchCurrentServer() {
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: "ignore",
  });

  child.unref();
}

let remoteVibes;

try {
  remoteVibes = await createRemoteVibesApp({
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
      `Remote Vibes could not bind ${configuredHost}:${configuredPort}. Stop the other server or relaunch with REMOTE_VIBES_PORT=<free-port>.`,
    );
    process.exit(1);
  }

  throw error;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await remoteVibes.terminate();
  });
}

process.on("SIGHUP", () => {
  console.log("[remote-vibes] Ignoring SIGHUP; use terminate, SIGINT, or SIGTERM to stop.");
});

console.log(buildStartupOutput(remoteVibes.config));
