import path from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import { resolveCwd } from "./session-manager.js";

const IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);
const INTERNAL_PATH_SEGMENTS = new Set([".remote-vibes"]);

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

  throw buildHttpError("Path escapes the selected workspace.", 400);
}

function containsInternalPathSegment(relativePath) {
  return normalizeRelativePath(relativePath)
    .split("/")
    .filter(Boolean)
    .some((segment) => INTERNAL_PATH_SEGMENTS.has(segment));
}

export function isImageFile(fileName) {
  return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

export async function resolveWorkspaceEntry({
  root,
  relativePath = "",
  fallbackCwd,
}) {
  const workspaceRoot = resolveCwd(root || fallbackCwd, fallbackCwd);
  const realRootPath = await realpath(workspaceRoot).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError(`Workspace does not exist: ${workspaceRoot}`, 404);
    }

    throw error;
  });

  const requestedPath = path.resolve(realRootPath, relativePath || ".");
  const realTargetPath = await realpath(requestedPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError(`Entry does not exist: ${normalizeRelativePath(relativePath) || "."}`, 404);
    }

    throw error;
  });

  const nextRelativePath = ensurePathInsideRoot(realRootPath, realTargetPath);
  if (containsInternalPathSegment(nextRelativePath)) {
    throw buildHttpError("Requested path is not available in the workspace browser.", 404);
  }

  const entryStats = await stat(realTargetPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError(`Entry does not exist: ${nextRelativePath || "."}`, 404);
    }

    throw error;
  });

  return {
    rootPath: realRootPath,
    targetPath: realTargetPath,
    relativePath: nextRelativePath,
    stats: entryStats,
  };
}

export async function listWorkspaceEntries({
  root,
  relativePath = "",
  fallbackCwd,
}) {
  const entry = await resolveWorkspaceEntry({ root, relativePath, fallbackCwd });

  if (!entry.stats.isDirectory()) {
    throw buildHttpError("Requested path is not a directory.", 400);
  }

  const directoryEntries = await readdir(entry.targetPath, { withFileTypes: true });
  const entries = directoryEntries
    .filter((child) => !child.isSymbolicLink())
    .map((child) => {
      const childRelativePath = normalizeRelativePath(
        path.relative(entry.rootPath, path.join(entry.targetPath, child.name)),
      );

      return {
        name: child.name,
        relativePath: childRelativePath,
        type: child.isDirectory() ? "directory" : "file",
        isImage: child.isFile() && isImageFile(child.name),
      };
    })
    .filter((child) => !containsInternalPathSegment(child.relativePath))
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });

  return {
    root: entry.rootPath,
    relativePath: entry.relativePath,
    entries,
  };
}
