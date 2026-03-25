import { createRemoteVibesApp } from "./create-app.js";
import { buildStartupOutput } from "./startup-output.js";

const remoteVibes = await createRemoteVibesApp({
  onTerminate: async () => {
    process.exit(0);
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await remoteVibes.terminate();
  });
}

console.log(buildStartupOutput(remoteVibes.config));
