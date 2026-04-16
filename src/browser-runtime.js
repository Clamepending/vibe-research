import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getLegacyWorkspaceStateDir } from "./state-paths.js";

const execFileAsync = promisify(execFile);
const LOOPBACK_V4_PATTERN = /^127(?:\.\d{1,3}){3}$/;

export const browserCommandHints = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "chrome",
  "brave-browser",
  "microsoft-edge",
];

export const browserExecutableHints = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Arc.app/Contents/MacOS/Arc",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
];
const browserDetourCommandNames = new Set([
  ...browserCommandHints,
  "firefox",
]);

export function createBrowserError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stripIpv6Brackets(hostname) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }

  return hostname;
}

async function isExecutable(targetPath) {
  try {
    await access(targetPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isBrowserDetourWrapper(candidatePath, env = process.env) {
  const appRoot = String(env.REMOTE_VIBES_APP_ROOT || "").trim();
  if (!appRoot) {
    return false;
  }

  const helperDir = path.resolve(appRoot, "bin");
  const absoluteCandidatePath = path.resolve(candidatePath);

  return (
    path.dirname(absoluteCandidatePath) === helperDir &&
    browserDetourCommandNames.has(path.basename(absoluteCandidatePath))
  );
}

export async function findCommandInPath(
  command,
  envPath = process.env.PATH || "",
  { ignore = null } = {},
) {
  for (const entry of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, command);
    if (await isExecutable(candidate)) {
      if (typeof ignore === "function" && ignore(candidate)) {
        continue;
      }

      return candidate;
    }
  }

  return null;
}

export function isLocalBrowserHostname(hostname) {
  const normalized = stripIpv6Brackets(String(hostname || "").trim()).toLowerCase();

  return (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    LOOPBACK_V4_PATTERN.test(normalized)
  );
}

export function normalizeBrowserTarget(target) {
  const rawTarget = String(target ?? "").trim();
  if (!rawTarget) {
    throw createBrowserError("TARGET_REQUIRED", "A localhost URL or port is required.");
  }

  if (/^\d+$/.test(rawTarget)) {
    return `http://127.0.0.1:${rawTarget}/`;
  }

  const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(rawTarget);
  const candidateUrl = hasScheme ? rawTarget : `http://${rawTarget}`;

  let url;
  try {
    url = new URL(candidateUrl);
  } catch {
    throw createBrowserError(
      "INVALID_TARGET",
      `Could not parse "${rawTarget}" as a localhost URL or port.`,
    );
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw createBrowserError(
      "INVALID_TARGET_PROTOCOL",
      `Only http:// and https:// targets are supported, got ${url.protocol}.`,
    );
  }

  return url.toString();
}

export function ensureLocalBrowserTarget(target) {
  const normalizedTarget = normalizeBrowserTarget(target);
  const url = new URL(normalizedTarget);

  if (!isLocalBrowserHostname(url.hostname)) {
    throw createBrowserError(
      "TARGET_NOT_LOCAL",
      `rv-browser only connects to localhost targets. Use 127.0.0.1, localhost, or a bare port instead of ${url.hostname}.`,
    );
  }

  return normalizedTarget;
}

export async function resolveBrowserExecutablePath({ env = process.env } = {}) {
  const overrideCandidates = [
    env.REMOTE_VIBES_BROWSER_EXECUTABLE_PATH,
    env.CHROME_EXECUTABLE_PATH,
    env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  ].filter(Boolean);

  for (const candidate of overrideCandidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  for (const command of browserCommandHints) {
    const resolved = await findCommandInPath(command, env.PATH || "", {
      ignore: (candidate) => isBrowserDetourWrapper(candidate, env),
    });
    if (resolved) {
      return resolved;
    }
  }

  for (const hint of browserExecutableHints) {
    if (await isExecutable(hint)) {
      return hint;
    }
  }

  return null;
}

export async function inspectBrowserRuntime({ env = process.env } = {}) {
  const executablePath = await resolveBrowserExecutablePath({ env });

  if (!executablePath) {
    return {
      available: false,
      executablePath: null,
      version: null,
    };
  }

  let version = null;
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, ["--version"]);
    version = `${stdout || stderr}`.trim() || null;
  } catch {
    version = null;
  }

  return {
    available: true,
    executablePath,
    version,
  };
}

export async function ensureBrowserArtifactsDir({ cwd = process.cwd(), env = process.env } = {}) {
  const stateDir = env.REMOTE_VIBES_ROOT || getLegacyWorkspaceStateDir(cwd);
  const artifactsDir = path.resolve(stateDir, "browser");
  await mkdir(artifactsDir, { recursive: true });
  return artifactsDir;
}

function buildTimestampToken() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export async function resolveBrowserOutputPath(
  outputPath,
  { cwd = process.cwd(), env = process.env, prefix = "capture", extension = ".png" } = {},
) {
  const absolutePath = outputPath
    ? path.resolve(cwd, outputPath)
    : path.join(
        await ensureBrowserArtifactsDir({ cwd, env }),
        `${prefix}-${buildTimestampToken()}${extension}`,
      );

  await mkdir(path.dirname(absolutePath), { recursive: true });
  return absolutePath;
}

export function truncateBrowserText(value, maxLength = 20_000) {
  const text = String(value ?? "");

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...[truncated]`;
}
