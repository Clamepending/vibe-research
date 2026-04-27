import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { resolveCwd } from "./session-manager.js";

const PROJECT_TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);

function humanizeProjectSlug(slug) {
  return String(slug || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildProjectReadmeSeed(slug) {
  const title = humanizeProjectSlug(slug) || slug;
  return `# ${slug}: ${title}

## GOAL

_One paragraph. What question are we ultimately trying to answer?_

## CODE REPO

_<github-url for this project's code repo>_

## SUCCESS CRITERIA

- _bullet 1_
- _bullet 2_

## RANKING CRITERION

_quantitative: <metric-name> (higher|lower is better) — OR — qualitative: <dimension> — OR — mix: <metric> + <dimension>_

## LEADERBOARD

| rank | result | branch | commit | score / verdict |

## INSIGHTS

## ACTIVE

| move | result doc | branch | agent | started |

## QUEUE

| move | starting-point | why |

## LOG

| date | event | slug or ref | one-line summary | link |
`;
}

async function seedProjectSkeleton(targetPath, slug) {
  const paperTemplatePath = path.join(PROJECT_TEMPLATES_DIR, "paper-template.md");
  let paperContent = "";
  try {
    paperContent = await readFile(paperTemplatePath, "utf8");
  } catch {
    paperContent = "# <Project title>\n";
  }
  const titled = paperContent.replace(
    /^# <Project title>$/m,
    `# ${humanizeProjectSlug(slug) || slug}`,
  );

  await writeFile(path.join(targetPath, "paper.md"), titled, "utf8");
  await writeFile(path.join(targetPath, "README.md"), buildProjectReadmeSeed(slug), "utf8");
  await mkdir(path.join(targetPath, "results"), { recursive: true });
  await writeFile(path.join(targetPath, "results", ".gitkeep"), "", "utf8");
}

function buildHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeRelativePath(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  return normalized === "." ? "" : normalized;
}

function ensurePathInsideRoot(rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath);

  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  ) {
    return normalizeRelativePath(relativePath);
  }

  throw buildHttpError("Path escapes the selected folder root.", 400);
}

function normalizeFolderName(value) {
  const folderName = String(value || "").trim();

  if (!folderName) {
    throw buildHttpError("Folder name is required.", 400);
  }

  if (
    folderName.includes("\0") ||
    folderName.includes("/") ||
    folderName.includes("\\") ||
    folderName === "." ||
    folderName === ".."
  ) {
    throw buildHttpError("Folder name must be a single folder name.", 400);
  }

  return folderName;
}

export async function listFolderEntries({
  root,
  relativePath = "",
  fallbackCwd,
}) {
  const rootPath = resolveCwd(root || fallbackCwd, fallbackCwd);
  const realRootPath = await realpath(rootPath);
  const requestedPath = path.resolve(realRootPath, relativePath || ".");
  const realTargetPath = await realpath(requestedPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError(`Folder does not exist: ${normalizeRelativePath(relativePath) || rootPath}`, 404);
    }

    throw error;
  });
  const normalizedRelativePath = ensurePathInsideRoot(realRootPath, realTargetPath);
  const entryStats = await stat(realTargetPath);

  if (!entryStats.isDirectory()) {
    throw buildHttpError("Selected path is not a folder.", 400);
  }

  const directoryEntries = await readdir(realTargetPath, { withFileTypes: true });
  const entries = directoryEntries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      path: path.join(realTargetPath, entry.name),
      relativePath: normalizeRelativePath(path.relative(realRootPath, path.join(realTargetPath, entry.name))),
      type: "directory",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const parentPath =
    realTargetPath === path.parse(realTargetPath).root ? "" : path.dirname(realTargetPath);

  return {
    currentPath: realTargetPath,
    entries,
    parentPath,
    relativePath: normalizedRelativePath,
    root: realRootPath,
  };
}

export async function createFolderEntry({
  root,
  relativePath = "",
  name,
  fallbackCwd,
}) {
  const folderName = normalizeFolderName(name);
  const rootPath = resolveCwd(root || fallbackCwd, fallbackCwd);
  const realRootPath = await realpath(rootPath);
  const requestedPath = path.resolve(realRootPath, relativePath || ".");
  const realParentPath = await realpath(requestedPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError(`Folder does not exist: ${normalizeRelativePath(relativePath) || rootPath}`, 404);
    }

    throw error;
  });
  ensurePathInsideRoot(realRootPath, realParentPath);

  const parentStats = await stat(realParentPath);
  if (!parentStats.isDirectory()) {
    throw buildHttpError("Selected path is not a folder.", 400);
  }

  const targetPath = path.join(realParentPath, folderName);
  ensurePathInsideRoot(realRootPath, targetPath);

  try {
    await mkdir(targetPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw buildHttpError("Folder already exists.", 409);
    }

    throw error;
  }

  const realTargetPath = await realpath(targetPath);

  const isProjectFolder = path.basename(realParentPath) === "projects";
  if (isProjectFolder) {
    try {
      await seedProjectSkeleton(realTargetPath, folderName);
    } catch {
      // Best-effort scaffolding: leave the empty folder if seeding fails.
    }
  }

  return {
    folder: {
      name: folderName,
      path: realTargetPath,
      relativePath: normalizeRelativePath(path.relative(realRootPath, realTargetPath)),
      type: "directory",
      seededAsProject: isProjectFolder || undefined,
    },
  };
}
