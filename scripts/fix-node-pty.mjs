import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

if (process.platform === "darwin") {
  const targetDir = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  const helperPath = path.join(
    rootDir,
    "node_modules",
    "node-pty",
    "prebuilds",
    targetDir,
    "spawn-helper",
  );

  try {
    execFileSync("/bin/chmod", ["755", helperPath], { stdio: "ignore" });
  } catch {
    // Ignore missing helpers on unsupported or partially installed setups.
  }
}
