import { createRemoteVibesApp } from "./create-app.js";

const remoteVibes = await createRemoteVibesApp();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await remoteVibes.close();
    process.exit(0);
  });
}

console.log("");
console.log("Remote Vibes is live.");
console.log(`Passcode: ${remoteVibes.config.passcode}`);
console.log(`Workspace: ${remoteVibes.config.cwd}`);
console.log("Available URLs:");

for (const entry of remoteVibes.config.urls) {
  console.log(`- ${entry.label}: ${entry.url}`);
}

console.log("Providers:");
for (const provider of remoteVibes.config.providers) {
  console.log(`- ${provider.label}: ${provider.available ? "available" : "missing"}`);
}

console.log("");
