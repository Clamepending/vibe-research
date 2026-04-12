import { spawn } from "node:child_process";
import { createRemoteVibesApp } from "./create-app.js";
import { buildStartupOutput } from "./startup-output.js";

function relaunchCurrentServer() {
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: "ignore",
  });

  child.unref();
}

const remoteVibes = await createRemoteVibesApp({
  onTerminate: async ({ relaunch = false } = {}) => {
    if (relaunch) {
      relaunchCurrentServer();
    }

    process.exit(0);
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await remoteVibes.terminate();
  });
}

console.log(buildStartupOutput(remoteVibes.config));
