import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BUILDINGHUB_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_LAYOUT_VERSION = "0.1.0";
const DEFAULT_CATEGORY = "Shared Base";
const DEFAULT_DESCRIPTION = "A shared Agent Town base layout.";
const DEFAULT_LAYOUT_DECORATION = Object.freeze({
  id: "default-road-anchor",
  itemId: "road-square",
  x: 548,
  y: 98,
});
const MAX_TEXT_LENGTH = 2_000;
const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

function expandHomePath(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  if (rawValue === "~") {
    return homedir();
  }

  if (rawValue.startsWith("~/")) {
    return path.join(homedir(), rawValue.slice(2));
  }

  return rawValue;
}

function normalizeText(value, limit = MAX_TEXT_LENGTH) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, Math.max(1, limit));
}

function normalizeBuildingHubId(value, fallback = "") {
  const id = String(value || fallback || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return BUILDINGHUB_ID_PATTERN.test(id) ? id : "";
}

function normalizeLayoutId(value) {
  return normalizeBuildingHubId(value, `town-${Date.now().toString(36)}`);
}

function normalizeRotation(value) {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(Math.round(number)) % 2 === 1 ? 1 : 0;
}

function normalizeCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(2_000, Math.round(number))) : null;
}

function normalizeDecoration(decoration, index) {
  if (!decoration || typeof decoration !== "object" || Array.isArray(decoration)) {
    return null;
  }

  const itemId = normalizeBuildingHubId(decoration.itemId || decoration.kind || decoration.type);
  const x = normalizeCoordinate(decoration.x);
  const y = normalizeCoordinate(decoration.y);
  if (!itemId || x === null || y === null) {
    return null;
  }

  const id = normalizeBuildingHubId(decoration.id, `${itemId}-${index + 1}`);
  const normalized = {
    id: id || `${itemId}-${index + 1}`,
    itemId,
    x,
    y,
  };
  const rotation = normalizeRotation(decoration.rotation ?? decoration.rotated);
  if (rotation) {
    normalized.rotation = rotation;
  }
  return normalized;
}

function normalizeOffsetMap(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([id, offset]) => {
        const normalizedId = normalizeBuildingHubId(id);
        const x = normalizeCoordinate(offset?.x);
        const y = normalizeCoordinate(offset?.y);
        return normalizedId && x !== null && y !== null ? [normalizedId, { x, y }] : null;
      })
      .filter(Boolean),
  );
}

function normalizeFunctional(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([id, placement]) => {
        const buildingId = normalizeBuildingHubId(id);
        const x = normalizeCoordinate(placement?.x);
        const y = normalizeCoordinate(placement?.y);
        if (!buildingId || x === null || y === null) {
          return null;
        }
        const normalized = { x, y };
        const rotation = normalizeRotation(placement.rotation ?? placement.rotated);
        if (rotation) {
          normalized.rotation = rotation;
        }
        return [buildingId, normalized];
      })
      .filter(Boolean),
  );
}

function normalizePendingFunctional(value = []) {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((entry) => normalizeBuildingHubId(entry))
        .filter(Boolean),
    ),
  );
}

function normalizeTownLayoutForBuildingHub(layout = {}) {
  const source = layout && typeof layout === "object" && !Array.isArray(layout) ? layout : {};
  return {
    places: normalizeOffsetMap(source.places),
    roads: normalizeOffsetMap(source.roads),
    decorations: (Array.isArray(source.decorations) ? source.decorations : [])
      .map(normalizeDecoration)
      .filter(Boolean),
    functional: normalizeFunctional(source.functional),
    pendingFunctional: normalizePendingFunctional(source.pendingFunctional),
    themeId: normalizeBuildingHubId(source.themeId || source.theme || "default") || "default",
    dogName: normalizeText(source.dogName || source.companionName, 48),
  };
}

function pathExists(filePath) {
  return stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function isBuildingHubCatalogRoot(candidatePath) {
  if (!candidatePath) {
    return false;
  }

  try {
    const stats = await stat(candidatePath);
    if (!stats.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  return (
    await pathExists(path.join(candidatePath, "bin", "buildinghub.mjs")) ||
    await pathExists(path.join(candidatePath, "registry.json")) ||
    await pathExists(path.join(candidatePath, "layouts"))
  );
}

export async function resolveBuildingHubCatalogRoot({ settings = {}, cwd = process.cwd(), env = process.env } = {}) {
  const configuredPath = normalizeText(settings.buildingHubCatalogPath || env.VIBE_RESEARCH_BUILDINGHUB_PATH, 1_000);
  const candidates = [
    configuredPath ? path.resolve(expandHomePath(configuredPath)) : "",
    path.resolve(cwd, "..", "buildinghub"),
    path.resolve(cwd, "..", "..", "buildinghub"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await isBuildingHubCatalogRoot(candidate)) {
      return candidate;
    }
  }

  const error = new Error("BuildingHub catalog repo not found. Choose a local BuildingHub folder before sharing.");
  error.statusCode = 400;
  throw error;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeBaseUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  try {
    const url = new URL(rawValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }

    if (/\/(?:registry|buildinghub|catalog)\.json$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/(?:registry|buildinghub|catalog)\.json$/i, "");
    }

    if (!url.pathname.endsWith("/")) {
      url.pathname = `${url.pathname}/`;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function parseGitHubRemoteUrl(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  if (!value) {
    return null;
  }

  const shorthand = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (shorthand) {
    return { owner: shorthand[1], repo: shorthand[2].replace(/\.git$/i, "") };
  }

  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length >= 2) {
      return { owner: parts[0], repo: parts[1].replace(/\.git$/i, "") };
    }
  } catch {
    const ssh = value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
    if (ssh) {
      return { owner: ssh[1], repo: ssh[2].replace(/\.git$/i, "") };
    }
  }

  return null;
}

async function git(root, args, options = {}) {
  const { stdout = "" } = await execFileAsync("git", ["-C", root, ...args], {
    maxBuffer: 1024 * 1024,
    ...options,
  });
  return stdout.trim();
}

async function getGitMetadata(root) {
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return {
      branch: "",
      remoteName: "",
      remoteUrl: "",
      github: null,
      isGitRepository: false,
    };
  }

  const branch = await git(root, ["branch", "--show-current"]).catch(() => "");
  const remoteName = await git(root, ["config", "branch." + branch + ".remote"]).catch(() => "origin");
  const remoteUrl = remoteName ? await git(root, ["remote", "get-url", remoteName]).catch(() => "") : "";
  return {
    branch,
    remoteName: remoteName || "origin",
    remoteUrl,
    github: parseGitHubRemoteUrl(remoteUrl),
    isGitRepository: true,
  };
}

function getGitHubPagesBaseUrl(github) {
  if (!github?.owner || !github?.repo) {
    return "";
  }

  const repo = github.repo.replace(/\.git$/i, "");
  if (repo.toLowerCase() === `${github.owner.toLowerCase()}.github.io`) {
    return `https://${repo}/`;
  }
  return `https://${github.owner}.github.io/${repo}/`;
}

function getPublicUrls({ settings, github, branch, layoutId, previewAssetName }) {
  const configuredBaseUrl = normalizeBaseUrl(settings.buildingHubLayoutBaseUrl || settings.buildingHubCatalogUrl);
  const pagesBaseUrl = configuredBaseUrl || getGitHubPagesBaseUrl(github);
  const layoutUrl = pagesBaseUrl ? new URL(`layouts/${layoutId}/`, pagesBaseUrl).toString() : "";
  const previewUrl = pagesBaseUrl && previewAssetName
    ? new URL(`assets/layouts/${previewAssetName}`, pagesBaseUrl).toString()
    : "";
  const repositoryUrl = github?.owner && github?.repo && branch
    ? `https://github.com/${github.owner}/${github.repo}/tree/${encodeURIComponent(branch)}/layouts/${layoutId}`
    : "";
  return {
    layoutUrl,
    previewUrl,
    repositoryUrl,
  };
}

function renderLayoutReadme({ manifest, publicUrls }) {
  const sourceUrl = publicUrls.repositoryUrl || publicUrls.layoutUrl;
  const imageLine = publicUrls.previewUrl ? `\n![${manifest.name} preview](${publicUrls.previewUrl})\n` : "";
  const links = [
    publicUrls.layoutUrl ? `- Share page: ${publicUrls.layoutUrl}` : "",
    sourceUrl ? `- Source: ${sourceUrl}` : "",
  ].filter(Boolean).join("\n");

  return `# ${manifest.name}

${manifest.description}
${imageLine}
## Layout

- Theme: ${manifest.layout.themeId || "default"}
- Cosmetic pieces: ${manifest.layout.decorations.length}
- Functional buildings: ${Object.keys(manifest.layout.functional || {}).length}

${links ? `## Links\n\n${links}\n` : ""}`;
}

function renderLayoutPage({ manifest, publicUrls, previewAssetName }) {
  const title = `${manifest.name} - BuildingHub`;
  const description = manifest.description || DEFAULT_DESCRIPTION;
  const previewPath = previewAssetName ? `../../assets/layouts/${previewAssetName}` : "";
  const imageMeta = publicUrls.previewUrl
    ? `
  <meta property="og:image" content="${escapeHtml(publicUrls.previewUrl)}" />
  <meta name="twitter:image" content="${escapeHtml(publicUrls.previewUrl)}" />`
    : "";
  const sourceLink = publicUrls.repositoryUrl
    ? `<a class="button secondary" href="${escapeHtml(publicUrls.repositoryUrl)}">View source</a>`
    : "";
  const image = previewPath
    ? `<img class="preview" src="${escapeHtml(previewPath)}" alt="${escapeHtml(`${manifest.name} Agent Town preview`)}" />`
    : `<div class="preview empty">No preview image</div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />${imageMeta}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; background: #101312; color: #f6f1e8; }
    main { display: grid; gap: 18px; width: min(980px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 40px; }
    .preview { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border: 1px solid rgba(246,241,232,.14); border-radius: 8px; background: #17211d; }
    .empty { display: grid; place-items: center; color: #b9b5ac; }
    h1 { margin: 0; font-size: clamp(2rem, 7vw, 4.4rem); line-height: .95; letter-spacing: 0; }
    p { margin: 0; max-width: 72ch; color: #d1ccc2; line-height: 1.55; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; color: #e5ead0; font-size: .84rem; }
    .meta span { padding: 7px 9px; border: 1px solid rgba(246,241,232,.13); border-radius: 999px; background: rgba(246,241,232,.06); }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: 0 14px; border: 1px solid rgba(246,241,232,.18); border-radius: 8px; background: #d7f36b; color: #101312; font-weight: 800; text-decoration: none; }
    .button.secondary { background: transparent; color: #f6f1e8; }
  </style>
</head>
<body>
  <main>
    ${image}
    <div class="meta">
      <span>${escapeHtml(`${manifest.layout.decorations.length} cosmetic`)}</span>
      <span>${escapeHtml(`${Object.keys(manifest.layout.functional || {}).length} functional`)}</span>
      <span>${escapeHtml(`theme ${manifest.layout.themeId || "default"}`)}</span>
    </div>
    <h1>${escapeHtml(manifest.name)}</h1>
    <p>${escapeHtml(description)}</p>
    <div class="actions">
      <a class="button" href="../../">Browse BuildingHub</a>
      ${sourceLink}
    </div>
  </main>
</body>
</html>
`;
}

async function copyPreviewImage({ townShare, stateDir, layoutId, siteAssetsDir, layoutDir }) {
  const rawImagePath = normalizeText(townShare.imagePath, 1_000);
  if (!rawImagePath) {
    return { previewAssetName: "", previewExtension: "" };
  }

  const sourcePath = path.resolve(stateDir, rawImagePath);
  const relative = path.relative(stateDir, sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { previewAssetName: "", previewExtension: "" };
  }

  const extension = path.extname(sourcePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    return { previewAssetName: "", previewExtension: "" };
  }

  try {
    const stats = await stat(sourcePath);
    if (!stats.isFile()) {
      return { previewAssetName: "", previewExtension: "" };
    }
  } catch {
    return { previewAssetName: "", previewExtension: "" };
  }

  const previewAssetName = `${layoutId}${extension}`;
  await mkdir(siteAssetsDir, { recursive: true });
  await copyFile(sourcePath, path.join(siteAssetsDir, previewAssetName));
  await copyFile(sourcePath, path.join(layoutDir, `snapshot${extension}`));
  return { previewAssetName, previewExtension: extension };
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function ensurePublishableLayout({ layout, layoutId }) {
  if (!layout.decorations.length) {
    layout.decorations = [{ ...DEFAULT_LAYOUT_DECORATION }];
  }

  for (const decoration of layout.decorations) {
    if (!BUILDINGHUB_ID_PATTERN.test(decoration.itemId)) {
      const error = new Error(`BuildingHub layout ${layoutId} has an invalid decoration item id.`);
      error.statusCode = 400;
      throw error;
    }
  }

  for (const buildingId of Object.keys(layout.functional || {})) {
    if (!BUILDINGHUB_ID_PATTERN.test(buildingId)) {
      const error = new Error(`BuildingHub layout ${layoutId} has an invalid functional building id.`);
      error.statusCode = 400;
      throw error;
    }
  }
}

async function assertNoStagedChanges(root) {
  const staged = await git(root, ["diff", "--cached", "--name-only"]).catch(() => "");
  if (staged) {
    const error = new Error("BuildingHub repo has staged changes. Commit or unstage them before publishing an Agent Town layout.");
    error.statusCode = 409;
    throw error;
  }
}

async function commitAndPush({ root, layoutId, relativePaths }) {
  const metadata = await getGitMetadata(root);
  if (!metadata.isGitRepository) {
    return {
      branch: "",
      commit: "",
      pushed: false,
      remoteName: "",
      remoteUrl: "",
      status: "written",
    };
  }

  await assertNoStagedChanges(root);
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

  await git(root, ["commit", "-m", `Publish Agent Town layout ${layoutId}`]);
  const commit = await git(root, ["rev-parse", "HEAD"]).catch(() => "");
  let pushed = false;
  if (metadata.remoteName && metadata.branch) {
    await git(root, ["push", metadata.remoteName, `HEAD:${metadata.branch}`], { maxBuffer: 2 * 1024 * 1024 });
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

export async function publishTownShareToBuildingHub({
  townShare,
  stateDir,
  settings = {},
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  if (!townShare || typeof townShare !== "object" || Array.isArray(townShare)) {
    const error = new Error("Agent Town share is required before publishing to BuildingHub.");
    error.statusCode = 400;
    throw error;
  }

  const root = await resolveBuildingHubCatalogRoot({ settings, cwd, env });
  const layoutId = normalizeLayoutId(townShare.id);
  if (!layoutId) {
    const error = new Error("Agent Town share id cannot be used as a BuildingHub layout id.");
    error.statusCode = 400;
    throw error;
  }

  const layout = normalizeTownLayoutForBuildingHub(townShare.layout || {});
  ensurePublishableLayout({ layout, layoutId });

  const metadata = await getGitMetadata(root);
  const layoutDir = path.join(root, "layouts", layoutId);
  const siteLayoutDir = path.join(root, "site", "layouts", layoutId);
  const siteAssetsDir = path.join(root, "site", "assets", "layouts");
  await mkdir(layoutDir, { recursive: true });
  await mkdir(siteLayoutDir, { recursive: true });

  const preview = await copyPreviewImage({ townShare, stateDir, layoutId, siteAssetsDir, layoutDir });
  const publicUrls = getPublicUrls({
    settings,
    github: metadata.github,
    branch: metadata.branch || "main",
    layoutId,
    previewAssetName: preview.previewAssetName || `${layoutId}.svg`,
  });

  const existingManifest = await readJsonIfPresent(path.join(layoutDir, "layout.json"));
  const requiredBuildings = Array.from(
    new Set([
      ...Object.keys(layout.functional || {}),
      ...normalizePendingFunctional(layout.pendingFunctional),
      ...(Array.isArray(existingManifest?.requiredBuildings)
        ? existingManifest.requiredBuildings.map((entry) => normalizeBuildingHubId(entry)).filter(Boolean)
        : []),
    ]),
  ).sort();

  const manifest = {
    id: layoutId,
    name: normalizeText(townShare.name || existingManifest?.name || "Agent Town", 120) || "Agent Town",
    version: normalizeText(existingManifest?.version || DEFAULT_LAYOUT_VERSION, 40) || DEFAULT_LAYOUT_VERSION,
    category: normalizeText(existingManifest?.category || DEFAULT_CATEGORY, 80) || DEFAULT_CATEGORY,
    description: normalizeText(townShare.description || existingManifest?.description || DEFAULT_DESCRIPTION, 900)
      || DEFAULT_DESCRIPTION,
    tags: Array.from(new Set([
      "agent-town",
      "base",
      "shared",
      layout.themeId,
      ...(Array.isArray(existingManifest?.tags) ? existingManifest.tags.map((entry) => normalizeText(entry, 60)) : []),
    ].filter(Boolean))).slice(0, 20),
    requiredBuildings,
    ...(publicUrls.repositoryUrl ? { repositoryUrl: publicUrls.repositoryUrl } : {}),
    ...(publicUrls.layoutUrl ? { homepageUrl: publicUrls.layoutUrl } : {}),
    ...(publicUrls.previewUrl ? { previewUrl: publicUrls.previewUrl } : {}),
    layout,
  };

  await writeFile(path.join(layoutDir, "layout.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(layoutDir, "README.md"), renderLayoutReadme({ manifest, publicUrls }), "utf8");
  await writeFile(
    path.join(siteLayoutDir, "index.html"),
    renderLayoutPage({ manifest, publicUrls, previewAssetName: preview.previewAssetName || `${layoutId}.svg` }),
    "utf8",
  );

  const relativePaths = [
    path.join("layouts", layoutId),
    path.join("site", "layouts", layoutId),
    ...(preview.previewAssetName ? [path.join("site", "assets", "layouts", preview.previewAssetName)] : []),
  ];
  const gitResult = await commitAndPush({ root, layoutId, relativePaths });
  const commitUrl = metadata.github?.owner && metadata.github?.repo && gitResult.commit
    ? `https://github.com/${metadata.github.owner}/${metadata.github.repo}/commit/${gitResult.commit}`
    : "";

  return {
    layoutId,
    layoutUrl: publicUrls.layoutUrl || publicUrls.repositoryUrl,
    repositoryUrl: publicUrls.repositoryUrl,
    previewUrl: publicUrls.previewUrl,
    commit: gitResult.commit,
    commitUrl,
    branch: gitResult.branch,
    pushed: gitResult.pushed,
    publishedAt: new Date().toISOString(),
    status: gitResult.status,
  };
}

export const testInternals = {
  getPublicUrls,
  normalizeBaseUrl,
  normalizeTownLayoutForBuildingHub,
  parseGitHubRemoteUrl,
};
