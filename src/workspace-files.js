import path from "node:path";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
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
const INTERNAL_PATH_SEGMENTS = new Set([".vibe-research", ".remote-vibes"]);
const MANAGED_WORKSPACE_FILES = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
const MAX_EDITABLE_FILE_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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

function isManagedWorkspaceFile(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  return normalized && !normalized.includes("/") && MANAGED_WORKSPACE_FILES.has(normalized);
}

function assertWorkspaceFile(entry) {
  if (!entry.stats.isFile()) {
    throw buildHttpError("Requested path is not a file.", 400);
  }
}

function assertEditableFileSize(buffer) {
  if (buffer.byteLength > MAX_EDITABLE_FILE_BYTES) {
    throw buildHttpError(
      `Requested file is too large to edit in the browser (max ${MAX_EDITABLE_FILE_BYTES} bytes).`,
      413,
    );
  }
}

function decodeEditableText(buffer) {
  assertEditableFileSize(buffer);

  if (buffer.includes(0)) {
    throw buildHttpError("Requested file is not editable as text.", 400);
  }

  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    throw buildHttpError("Requested file is not editable as UTF-8 text.", 400);
  }
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
    .filter(
      (child) =>
        !containsInternalPathSegment(child.relativePath) && !isManagedWorkspaceFile(child.relativePath),
    )
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

export async function readWorkspaceTextFile({
  root,
  relativePath = "",
  fallbackCwd,
}) {
  const entry = await resolveWorkspaceEntry({ root, relativePath, fallbackCwd });
  assertWorkspaceFile(entry);

  const buffer = await readFile(entry.targetPath);
  const content = decodeEditableText(buffer);

  return {
    root: entry.rootPath,
    relativePath: entry.relativePath,
    content,
    byteLength: buffer.byteLength,
  };
}

export async function writeWorkspaceTextFile({
  root,
  relativePath = "",
  fallbackCwd,
  content,
}) {
  const entry = await resolveWorkspaceEntry({ root, relativePath, fallbackCwd });
  assertWorkspaceFile(entry);

  const existingBuffer = await readFile(entry.targetPath);
  decodeEditableText(existingBuffer);

  const nextBuffer = Buffer.from(String(content ?? ""), "utf8");
  assertEditableFileSize(nextBuffer);
  await writeFile(entry.targetPath, nextBuffer);

  return {
    root: entry.rootPath,
    relativePath: entry.relativePath,
    content: nextBuffer.toString("utf8"),
    byteLength: nextBuffer.byteLength,
  };
}
