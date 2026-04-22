#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const bump = process.argv[2] || "patch";
const noPush = process.argv.includes("--no-push");
const noGitHubRelease = process.argv.includes("--no-github-release");
const allowNonMain = process.argv.includes("--allow-non-main");
const runningInGitHubActions = process.env.GITHUB_ACTIONS === "true";
const hasGitHubToken = Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);

function run(command, args, { capture = false, allowFailure = false } = {}) {
  try {
    const output = execFileSync(command, args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    return typeof output === "string" ? output.trim() : "";
  } catch (error) {
    if (allowFailure) {
      return "";
    }

    throw error;
  }
}

function fail(message) {
  console.error(`[vibe-research-release] ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[vibe-research-release] ${message}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseVersion(version) {
  const match = String(version || "").match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    fail(`Unsupported version "${version}". Use a plain SemVer like 0.2.0.`);
  }

  return match.slice(1).map((part) => Number(part));
}

function nextVersion(currentVersion, requestedBump) {
  if (/^v?\d+\.\d+\.\d+$/.test(requestedBump)) {
    return requestedBump.replace(/^v/, "");
  }

  const [major, minor, patch] = parseVersion(currentVersion);
  if (requestedBump === "major") {
    return `${major + 1}.0.0`;
  }
  if (requestedBump === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  if (requestedBump === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }

  fail(`Unknown release bump "${requestedBump}". Use patch, minor, major, or an exact version.`);
}

function parsePorcelainPath(line) {
  const match = String(line || "").match(/^[ MADRCU?!]{1,2}\s+(.+)$/);
  const pathPart = (match?.[1] || String(line || "").slice(3)).trim();
  return pathPart.includes(" -> ") ? pathPart.split(" -> ").at(-1) : pathPart;
}

function getGitHubSlug(remoteUrl) {
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return sshMatch[1];
  }

  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return httpsMatch[1];
  }

  return "";
}

const currentBranch = run("git", ["branch", "--show-current"], { capture: true });
if (!allowNonMain && currentBranch !== "main") {
  fail(`Releases should be cut from main. Current branch is "${currentBranch || "detached"}".`);
}

const ignoredDirtyPaths = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
const dirtyTrackedLines = run("git", ["status", "--porcelain", "--untracked-files=no"], { capture: true })
  .split("\n")
  .filter(Boolean);
const blockingDirtyTracked = dirtyTrackedLines.filter((line) => {
  const renameTarget = parsePorcelainPath(line);
  return !ignoredDirtyPaths.has(renameTarget);
});

if (blockingDirtyTracked.length > 0) {
  fail("Tracked changes are present. Commit or stash them before cutting a release.");
}

if (dirtyTrackedLines.length > 0) {
  log("Ignoring managed prompt file churn while cutting the release.");
}

const packagePath = path.join(rootDir, "package.json");
const packageLockPath = path.join(rootDir, "package-lock.json");
const releaseChannelPath = path.join(rootDir, "release-channel.json");
const packageJson = readJson(packagePath);
const version = nextVersion(packageJson.version, bump);
const tag = `v${version}`;

if (run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { capture: true, allowFailure: true })) {
  fail(`Tag ${tag} already exists.`);
}

const remoteUrl = run("git", ["config", "--get", "remote.origin.url"], { capture: true });
const repoSlug = getGitHubSlug(remoteUrl);
const githubPushUrl = repoSlug ? `https://github.com/${repoSlug}.git` : "";
if (!noGitHubRelease && !repoSlug) {
  fail(`remote.origin.url is not a GitHub remote: ${remoteUrl}`);
}
if (!noGitHubRelease) {
  const ghVersion = run("gh", ["--version"], { capture: true, allowFailure: true });
  if (!ghVersion) {
    fail("GitHub CLI is required to publish a GitHub Release. Install gh or pass --no-github-release.");
  }

  if (!hasGitHubToken) {
    const ghAuth = run("gh", ["auth", "status", "--hostname", "github.com"], {
      capture: true,
      allowFailure: true,
    });
    if (!ghAuth) {
      fail("GitHub CLI is not authenticated for github.com. Run `gh auth login` or pass --no-github-release.");
    }

    run("gh", ["auth", "setup-git", "--hostname", "github.com"]);
  }
}

packageJson.version = version;
writeJson(packagePath, packageJson);

if (fs.existsSync(packageLockPath)) {
  const packageLock = readJson(packageLockPath);
  packageLock.version = version;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = version;
  }
  writeJson(packageLockPath, packageLock);
}

writeJson(releaseChannelPath, {
  schemaVersion: 1,
  name: "Vibe Research",
  repository: "https://github.com/Clamepending/vibe-research",
  website: "https://vibe-research.net",
  channel: "stable",
  version,
  tag,
  releaseUrl: `https://github.com/Clamepending/vibe-research/releases/tag/${tag}`,
  installer: `https://raw.githubusercontent.com/Clamepending/vibe-research/${tag}/install.sh`,
});

run("git", ["add", "package.json", "package-lock.json", "release-channel.json"]);
run("git", ["commit", "-m", `Release ${tag}`]);
run("git", ["tag", "-a", tag, "-m", `Vibe Research ${tag}`]);
log(`Created ${tag}.`);

const releaseAssetsDir = run(process.execPath, [path.join(rootDir, "scripts", "build-release-assets.mjs"), tag], {
  capture: true,
});
const releaseAssets = ["install.sh", "release.json", "SHASUMS256.txt"].map((fileName) =>
  path.join(releaseAssetsDir, fileName),
);
log(`Built release assets in ${path.relative(rootDir, releaseAssetsDir)}.`);

if (noPush) {
  log("Skipping push because --no-push was passed.");
  log(`Next: git push origin ${currentBranch} && git push origin ${tag}`);
  process.exit(0);
}

const pushRemote = runningInGitHubActions || noGitHubRelease || !githubPushUrl ? "origin" : githubPushUrl;
run("git", ["push", pushRemote, currentBranch]);
run("git", ["push", pushRemote, tag]);

if (noGitHubRelease) {
  log("Skipping GitHub Release because --no-github-release was passed.");
  process.exit(0);
}

run("gh", [
  "release",
  "create",
  tag,
  ...releaseAssets,
  "--repo",
  repoSlug,
  "--title",
  `Vibe Research ${tag}`,
  "--generate-notes",
]);
log(`Published GitHub Release ${tag}.`);
