import { createRemoteVibesApp } from "./create-app.js";
import { buildStartupOutput } from "./startup-output.js";

const remoteVibes = await createRemoteVibesApp();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await remoteVibes.close();
    process.exit(0);
  });
}

console.log(buildStartupOutput(remoteVibes.config));
