#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const version = String(packageJson.version || "").trim();
const tag = (process.argv[2] || `v${version}`).replace(/^([^v])/, "v$1");
const outDir = path.join(rootDir, "dist", "releases", tag);

function run(command, args) {
  return execFileSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function writeAsset(fileName, content) {
  const filePath = path.join(outDir, fileName);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  writeFileSync(filePath, buffer);
  return {
    fileName,
    filePath,
    bytes: buffer.byteLength,
    sha256: sha256(buffer),
  };
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`package.json version must be plain SemVer, got "${version}".`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const commit = run("git", ["rev-parse", "HEAD"]);
const installerBuffer = readFileSync(path.join(rootDir, "install.sh"));
const installer = writeAsset("install.sh", installerBuffer);
const releaseUrl = `https://github.com/Clamepending/vibe-research/releases/tag/${encodeURIComponent(tag)}`;
const manifestPayload = {
  schemaVersion: 1,
  name: "Vibe Research",
  version,
  tag,
  commit,
  generatedAt: new Date().toISOString(),
  official: {
    website: "https://vibe-research.net",
    repository: "https://github.com/Clamepending/vibe-research",
    release: releaseUrl,
    installer: `https://raw.githubusercontent.com/Clamepending/vibe-research/${tag}/install.sh`,
  },
  assets: [
    {
      name: installer.fileName,
      bytes: installer.bytes,
      sha256: installer.sha256,
    },
  ],
};
const manifest = writeAsset("release.json", `${JSON.stringify(manifestPayload, null, 2)}\n`);
const shasums = [installer, manifest]
  .map((asset) => `${asset.sha256}  ${asset.fileName}`)
  .join("\n");
const checksum = writeAsset("SHASUMS256.txt", `${shasums}\n`);

console.log(outDir);
console.error(`[vibe-research-release] wrote ${installer.fileName}, ${manifest.fileName}, ${checksum.fileName}`);
