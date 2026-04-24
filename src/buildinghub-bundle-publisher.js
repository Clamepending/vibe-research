import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveBuildingHubCatalogRoot } from "./buildinghub-layout-publisher.js";

const execFileAsync = promisify(execFile);
const BUNDLE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/;

function normalizeBundleId(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return BUNDLE_ID_PATTERN.test(text) ? text : "";
}

function normalizeBaseUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) return "";
  try {
    const url = new URL(rawValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (/\/(?:registry|buildinghub|catalog)\.json$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/(?:registry|buildinghub|catalog)\.json$/i, "");
    }
    if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function parseGitHubRemoteUrl(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  if (!value) return null;
  const shorthand = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2].replace(/\.git$/i, "") };
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length >= 2) return { owner: parts[0], repo: parts[1].replace(/\.git$/i, "") };
  } catch {}
  return null;
}

async function git(root, args) {
  const { stdout = "" } = await execFileAsync("git", ["-C", root, ...args], {
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.trim();
}

async function getGitMetadata(root) {
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { branch: "", remoteName: "", remoteUrl: "", github: null, isGitRepository: false };
  }
  const branch = await git(root, ["branch", "--show-current"]).catch(() => "");
  const remoteName = await git(root, ["config", `branch.${branch}.remote`]).catch(() => "origin");
  const remoteUrl = remoteName ? await git(root, ["remote", "get-url", remoteName]).catch(() => "") : "";
  return {
    branch,
    remoteName: remoteName || "origin",
    remoteUrl,
    github: parseGitHubRemoteUrl(remoteUrl),
    isGitRepository: true,
  };
}

async function commitAndPushBundle({ root, bundleId, relativePaths }) {
  const metadata = await getGitMetadata(root);
  if (!metadata.isGitRepository) {
    return { branch: "", commit: "", pushed: false, remoteName: "", remoteUrl: "", status: "written" };
  }
  const staged = await git(root, ["diff", "--cached", "--name-only"]).catch(() => "");
  if (staged) {
    const error = new Error("BuildingHub repo has staged changes. Commit or unstage them before publishing a bundle.");
    error.statusCode = 409;
    throw error;
  }
  await git(root, ["add", "--", ...relativePaths]);
  const changed = await git(root, ["status", "--porcelain", "--", ...relativePaths]);
  if (!changed) {
    return {
      branch: metadata.branch,
      commit: await git(root, ["rev-parse", "HEAD"]).catch(() => ""),
      pushed: false,
      remoteName: metadata.remoteName,
      remoteUrl: metadata.remoteUrl,
      status: "unchanged",
    };
  }
  await git(root, ["commit", "-m", `Publish Agent Town bundle ${bundleId}`]);
  const commit = await git(root, ["rev-parse", "HEAD"]).catch(() => "");
  let pushed = false;
  if (metadata.remoteName && metadata.branch) {
    await git(root, ["push", metadata.remoteName, `HEAD:${metadata.branch}`]);
    pushed = true;
  }
  return {
    branch: metadata.branch,
    commit,
    pushed,
    remoteName: metadata.remoteName,
    remoteUrl: metadata.remoteUrl,
    status: pushed ? "published" : "committed",
  };
}

function getPublicUrls({ settings, github, branch, bundleId }) {
  const configuredBaseUrl = normalizeBaseUrl(
    settings.buildingHubBundleBaseUrl || settings.buildingHubAppUrl || settings.buildingHubCatalogUrl,
  );
  let pagesBaseUrl = configuredBaseUrl;
  if (!pagesBaseUrl && github?.owner && github?.repo) {
    const repo = github.repo.replace(/\.git$/i, "");
    pagesBaseUrl =
      repo.toLowerCase() === `${github.owner.toLowerCase()}.github.io`
        ? `https://${repo}/`
        : `https://${github.owner}.github.io/${repo}/`;
  }
  const bundleUrl = pagesBaseUrl ? new URL(`bundles/${bundleId}/bundle.json`, pagesBaseUrl).toString() : "";
  const repositoryUrl =
    github?.owner && github?.repo && branch
      ? `https://github.com/${github.owner}/${github.repo}/tree/${encodeURIComponent(branch)}/bundles/${bundleId}`
      : "";
  return { bundleUrl, repositoryUrl };
}

async function postHostedBundle({ settings, accessToken, bundleId, bundle, fetchImpl }) {
  const appBaseUrl = normalizeBaseUrl(settings.buildingHubAppUrl);
  if (!appBaseUrl || !accessToken) {
    const error = new Error("Connect a hosted BuildingHub account before publishing bundles there.");
    error.statusCode = 400;
    throw error;
  }
  if (typeof fetchImpl !== "function") {
    const error = new Error("fetch is not available for hosted BuildingHub publishing.");
    error.statusCode = 500;
    throw error;
  }
  const response = await fetchImpl(new URL("/api/bundles", appBaseUrl).toString(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "vibe-research",
    },
    body: JSON.stringify({ id: bundleId, bundle }),
  });
  const payload = JSON.parse((await response.text().catch(() => "")) || "{}");
  if (!response.ok) {
    const error = new Error(payload.error || `BuildingHub bundle publish failed (${response.status}).`);
    error.statusCode = response.status || 400;
    throw error;
  }
  return {
    bundleId: String(payload.id || bundleId).trim(),
    bundleUrl: String(payload.bundleUrl || payload.url || "").trim(),
    repositoryUrl: String(payload.repositoryUrl || "").trim(),
    commit: String(payload.commit || "").trim(),
    commitUrl: String(payload.commitUrl || "").trim(),
    branch: String(payload.branch || "").trim(),
    pushed: Boolean(payload.pushed),
    publishedAt: String(payload.publishedAt || new Date().toISOString()).trim(),
    publishedVia: "api",
    recordedByBuildingHub: Boolean(payload.recordedByBuildingHub),
    sourceId: String(payload.sourceId || "hosted").trim(),
    status: String(payload.status || "published").trim(),
  };
}

export async function publishBundleToBuildingHub({
  bundle,
  bundleId: requestedId,
  settings = {},
  cwd = process.cwd(),
  env = process.env,
  accessToken = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    const error = new Error("Bundle payload is required.");
    error.statusCode = 400;
    throw error;
  }
  const bundleId = normalizeBundleId(requestedId || bundle.id || `bundle-${Date.now().toString(36)}`);
  if (!bundleId) {
    const error = new Error("Bundle id is not a valid slug.");
    error.statusCode = 400;
    throw error;
  }

  if (normalizeBaseUrl(settings.buildingHubAppUrl) && String(accessToken || "").trim()) {
    return postHostedBundle({ settings, accessToken, bundleId, bundle, fetchImpl });
  }

  const root = await resolveBuildingHubCatalogRoot({ settings, cwd, env });
  const metadata = await getGitMetadata(root);
  const bundleDir = path.join(root, "bundles", bundleId);
  await mkdir(bundleDir, { recursive: true });

  const enriched = { id: bundleId, ...bundle };
  const bundlePath = path.join(bundleDir, "bundle.json");
  await writeFile(bundlePath, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");

  const readmePath = path.join(bundleDir, "README.md");
  const summary = [
    `# Agent Town bundle: ${bundleId}`,
    "",
    `- Bundle version: ${bundle.bundleVersion || ""}`,
    `- Exported at: ${bundle.exportedAt || ""}`,
    `- Integrity: \`${bundle.integrity || "(none)"}\``,
    `- Producer: ${bundle.producer?.app || ""}@${bundle.producer?.version || ""}`,
    "",
    "Install with:",
    "```sh",
    `vr-agent-town import id:${bundleId}`,
    "```",
    "",
  ].join("\n");
  await writeFile(readmePath, summary, "utf8");

  const relativePaths = [path.join("bundles", bundleId)];
  const gitResult = await commitAndPushBundle({ root, bundleId, relativePaths });
  const publicUrls = getPublicUrls({ settings, github: metadata.github, branch: metadata.branch || "main", bundleId });
  const commitUrl =
    metadata.github?.owner && metadata.github?.repo && gitResult.commit
      ? `https://github.com/${metadata.github.owner}/${metadata.github.repo}/commit/${gitResult.commit}`
      : "";

  return {
    bundleId,
    bundleUrl: publicUrls.bundleUrl,
    repositoryUrl: publicUrls.repositoryUrl,
    commit: gitResult.commit,
    commitUrl,
    branch: gitResult.branch,
    pushed: gitResult.pushed,
    publishedAt: new Date().toISOString(),
    publishedVia: "git",
    recordedByBuildingHub: false,
    sourceId: "local",
    status: gitResult.status,
  };
}

export const testInternals = {
  normalizeBundleId,
  normalizeBaseUrl,
  parseGitHubRemoteUrl,
  getPublicUrls,
};
