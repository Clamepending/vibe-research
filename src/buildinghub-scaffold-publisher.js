import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveBuildingHubCatalogRoot } from "./buildinghub-layout-publisher.js";
import { SCAFFOLD_RECIPE_SCHEMA, normalizeScaffoldRecipe } from "./scaffold-recipe-service.js";

const execFileAsync = promisify(execFile);
const BUILDINGHUB_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_DESCRIPTION = "A shared Vibe Research scaffold recipe.";
const MAX_TEXT_LENGTH = 2_000;

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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  const remoteName = branch ? await git(root, ["config", `branch.${branch}.remote`]).catch(() => "origin") : "origin";
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

function getPublicUrls({ settings, github, branch, recipeId }) {
  const configuredBaseUrl = normalizeBaseUrl(settings.buildingHubRecipeBaseUrl || settings.buildingHubCatalogUrl);
  const pagesBaseUrl = configuredBaseUrl || getGitHubPagesBaseUrl(github);
  const recipeUrl = pagesBaseUrl ? new URL(`recipes/${recipeId}/`, pagesBaseUrl).toString() : "";
  const repositoryUrl = github?.owner && github?.repo && branch
    ? `https://github.com/${github.owner}/${github.repo}/tree/${encodeURIComponent(branch)}/recipes/${recipeId}`
    : "";
  return {
    recipeUrl,
    repositoryUrl,
  };
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function renderRecipeReadme({ manifest, publicUrls }) {
  const sourceUrl = publicUrls.repositoryUrl || publicUrls.recipeUrl;
  const links = [
    publicUrls.recipeUrl ? `- Share page: ${publicUrls.recipeUrl}` : "",
    sourceUrl ? `- Source: ${sourceUrl}` : "",
  ].filter(Boolean).join("\n");

  return `# ${manifest.name}

${manifest.description || DEFAULT_DESCRIPTION}

## Scaffold

- Schema: \`${SCAFFOLD_RECIPE_SCHEMA}\`
- Buildings: ${manifest.buildings.length}
- Functional buildings in layout: ${Object.keys(manifest.layout?.functional || {}).length}
- Cosmetic pieces in layout: ${(manifest.layout?.decorations || []).length}
- DM policy: ${manifest.communication.dm.enabled ? "enabled" : "disabled"} (${manifest.communication.dm.body}, ${manifest.communication.dm.visibility})
- Local bindings required: ${manifest.localBindingsRequired.length}

${links ? `## Links\n\n${links}\n` : ""}`;
}

function renderRecipePage({ manifest, publicUrls }) {
  const title = `${manifest.name} - BuildingHub`;
  const description = manifest.description || DEFAULT_DESCRIPTION;
  const sourceLink = publicUrls.repositoryUrl
    ? `<a class="button secondary" href="${escapeHtml(publicUrls.repositoryUrl)}">View source</a>`
    : "";
  const buildingCount = manifest.buildings.length;
  const localBindingCount = manifest.localBindingsRequired.length;
  const functionalCount = Object.keys(manifest.layout?.functional || {}).length;
  const cosmeticCount = (manifest.layout?.decorations || []).length;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; background: #111512; color: #f7f3ea; }
    main { display: grid; gap: 18px; width: min(980px, calc(100% - 32px)); margin: 0 auto; padding: 34px 0 44px; }
    h1 { margin: 0; max-width: 12ch; font-size: clamp(2.2rem, 8vw, 5.2rem); line-height: .94; letter-spacing: 0; }
    p { margin: 0; max-width: 72ch; color: #d7d1c7; line-height: 1.55; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
    .stat { min-height: 86px; padding: 14px; border: 1px solid rgba(247,243,234,.14); border-radius: 8px; background: rgba(247,243,234,.055); }
    .stat strong { display: block; font-size: 1.8rem; line-height: 1; }
    .stat span { display: block; margin-top: 8px; color: #c9c4ba; font-size: .86rem; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; color: #e4ead0; font-size: .84rem; }
    .meta span { padding: 7px 9px; border: 1px solid rgba(247,243,234,.13); border-radius: 999px; background: rgba(247,243,234,.06); }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: 0 14px; border: 1px solid rgba(247,243,234,.18); border-radius: 8px; background: #d4f06a; color: #111512; font-weight: 800; text-decoration: none; }
    .button.secondary { background: transparent; color: #f7f3ea; }
  </style>
</head>
<body>
  <main>
    <div class="meta">
      <span>${escapeHtml(manifest.version)}</span>
      <span>${escapeHtml(manifest.compatibility?.vibeResearch?.version || "vibe-research")}</span>
      <span>${escapeHtml(manifest.communication?.dm?.enabled ? "agent DMs enabled" : "agent DMs disabled")}</span>
    </div>
    <h1>${escapeHtml(manifest.name)}</h1>
    <p>${escapeHtml(description)}</p>
    <section class="stats" aria-label="Scaffold recipe contents">
      <div class="stat"><strong>${buildingCount}</strong><span>buildings captured</span></div>
      <div class="stat"><strong>${functionalCount}</strong><span>functional placements</span></div>
      <div class="stat"><strong>${cosmeticCount}</strong><span>cosmetic placements</span></div>
      <div class="stat"><strong>${localBindingCount}</strong><span>local bindings to supply</span></div>
    </section>
    <div class="actions">
      <a class="button" href="../../">Browse BuildingHub</a>
      ${sourceLink}
    </div>
  </main>
</body>
</html>
`;
}

function ensurePublishableRecipe({ recipe, recipeId }) {
  if (recipe.schema !== SCAFFOLD_RECIPE_SCHEMA) {
    const error = new Error("Only Vibe Research scaffold recipe v1 manifests can be published.");
    error.statusCode = 400;
    throw error;
  }

  if (!BUILDINGHUB_ID_PATTERN.test(recipeId)) {
    const error = new Error("Scaffold recipe id cannot be used as a BuildingHub recipe id.");
    error.statusCode = 400;
    throw error;
  }

  if (!recipe.buildings.length && !recipe.layout && !Object.keys(recipe.settings.portable || {}).length) {
    const error = new Error("Add at least one building, layout, or portable setting before publishing a scaffold recipe.");
    error.statusCode = 400;
    throw error;
  }
}

async function assertNoStagedChanges(root) {
  const staged = await git(root, ["diff", "--cached", "--name-only"]).catch(() => "");
  if (staged) {
    const error = new Error("BuildingHub repo has staged changes. Commit or unstage them before publishing a scaffold recipe.");
    error.statusCode = 409;
    throw error;
  }
}

async function commitAndPush({ root, recipeId, relativePaths }) {
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

  await git(root, ["commit", "-m", `Publish Vibe Research scaffold recipe ${recipeId}`]);
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

export async function publishScaffoldRecipeToBuildingHub({
  recipe,
  settings = {},
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const root = await resolveBuildingHubCatalogRoot({ settings, cwd, env });
  const existingId = normalizeBuildingHubId(recipe?.id || recipe?.recipeId || recipe?.name);
  const recipeId = existingId || normalizeBuildingHubId(`recipe-${Date.now().toString(36)}`);
  const recipeDir = path.join(root, "recipes", recipeId);
  const siteRecipeDir = path.join(root, "site", "recipes", recipeId);
  const existingManifest = await readJsonIfPresent(path.join(recipeDir, "recipe.json"));
  const metadata = await getGitMetadata(root);
  const publicUrls = getPublicUrls({
    settings,
    github: metadata.github,
    branch: metadata.branch || "main",
    recipeId,
  });

  const manifest = normalizeScaffoldRecipe({
    ...existingManifest,
    ...recipe,
    id: recipeId,
    description: normalizeText(recipe?.description || existingManifest?.description || DEFAULT_DESCRIPTION, 900)
      || DEFAULT_DESCRIPTION,
    source: {
      ...(recipe?.source || {}),
      kind: "buildinghub",
      sourceId: "local",
      repositoryUrl: publicUrls.repositoryUrl,
      recipeUrl: publicUrls.recipeUrl,
      publishedAt: new Date().toISOString(),
    },
  });
  ensurePublishableRecipe({ recipe: manifest, recipeId });

  await mkdir(recipeDir, { recursive: true });
  await mkdir(siteRecipeDir, { recursive: true });
  await writeFile(path.join(recipeDir, "recipe.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(recipeDir, "README.md"), renderRecipeReadme({ manifest, publicUrls }), "utf8");
  await writeFile(path.join(siteRecipeDir, "index.html"), renderRecipePage({ manifest, publicUrls }), "utf8");

  const relativePaths = [
    path.join("recipes", recipeId),
    path.join("site", "recipes", recipeId),
  ];
  const gitResult = await commitAndPush({ root, recipeId, relativePaths });
  const commitUrl = metadata.github?.owner && metadata.github?.repo && gitResult.commit
    ? `https://github.com/${metadata.github.owner}/${metadata.github.repo}/commit/${gitResult.commit}`
    : "";

  return {
    recipeId,
    recipeUrl: publicUrls.recipeUrl || publicUrls.repositoryUrl,
    repositoryUrl: publicUrls.repositoryUrl,
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
  parseGitHubRemoteUrl,
  renderRecipePage,
  renderRecipeReadme,
};
