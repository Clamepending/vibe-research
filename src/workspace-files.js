import path from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
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
const MANAGED_WORKSPACE_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
const MAX_EDITABLE_FILE_BYTES = 1024 * 1024;
// 2 GiB default upload ceiling. Override with VIBE_RESEARCH_UPLOAD_MAX_BYTES.
// Picked to comfortably hold a typical phone-shot 4K video (a few hundred MB)
// without forcing power users to tune env vars; still bounded so a runaway
// drop can't fill the disk.
const DEFAULT_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
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

// In-flight upload temp files use the `.vr-upload-<id>.tmp` pattern.
// They live alongside the final destination so the rename is atomic
// (same filesystem). Hide them from the browser-side file listing so
// a half-completed upload (e.g. user closed the tab mid-stream)
// doesn't show up as a confusing 0-byte file in the tree.
function isUploadTempFile(name) {
  if (typeof name !== "string") return false;
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  return base.startsWith(".vr-upload-") && base.endsWith(".tmp");
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
        !containsInternalPathSegment(child.relativePath) &&
        !isManagedWorkspaceFile(child.relativePath) &&
        !isUploadTempFile(child.name),
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

// Hard-validates a single file-name segment supplied by the client. Does
// NOT accept slashes — when the user drops a folder, the client walks the
// directory entries on its end and uploads each leaf file separately, so
// the server only ever sees one filename at a time.
function sanitizeUploadFileName(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw buildHttpError("File name is required.", 400);
  }

  // Strip any path the browser leaked through (e.g. webkitRelativePath
  // baked into a single field). We rebuild the directory tree from the
  // explicit `relativePath` parameter, never from the file-name field.
  const lastSlash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  const tail = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;
  const cleaned = tail.replace(/[\u0000-\u001f\u007f]/g, "").trim();

  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw buildHttpError("File name is invalid.", 400);
  }
  if (cleaned.length > 255) {
    throw buildHttpError("File name is too long (max 255 chars).", 400);
  }
  // Block reserved Windows device names defensively even on POSIX hosts —
  // a synced workspace might land on a Windows machine later.
  const stem = cleaned.replace(/\.[^.]*$/, "").toUpperCase();
  if (
    /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/.test(stem)
  ) {
    throw buildHttpError("File name is reserved by the OS.", 400);
  }
  return cleaned;
}

// Picks a non-colliding name in `directoryPath`. If `<stem>.<ext>` exists,
// we walk `<stem> (1).<ext>`, `<stem> (2).<ext>`, ... until we find a
// missing slot. Capped at 1000 so a malicious or buggy client can't
// trigger an unbounded stat loop.
async function pickAvailableFileName(directoryPath, fileName) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = attempt === 0 ? fileName : `${stem} (${attempt})${ext}`;
    const candidatePath = path.join(directoryPath, candidate);
    try {
      await stat(candidatePath);
      // exists — try the next suffix
    } catch (error) {
      if (error?.code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }
  throw buildHttpError("Could not find a free file name (too many duplicates).", 409);
}

function readUploadMaxBytes(override) {
  if (Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const raw = Number(process.env.VIBE_RESEARCH_UPLOAD_MAX_BYTES || "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_UPLOAD_MAX_BYTES;
}

function buildSizeLimitTransform(maxBytes) {
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        const error = buildHttpError(
          `Upload exceeds the maximum size (${maxBytes} bytes).`,
          413,
        );
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
}

// Streams `source` into a new file inside the workspace directory at
// `relativePath`. Steps:
//   1. resolve + validate the destination directory (must exist, must be
//      inside the workspace, must not be the managed-files top level)
//   2. sanitize the requested file name (no slashes, no control chars,
//      no Windows reserved names)
//   3. pick a non-colliding name (suffix `(N)` if needed)
//   4. write to a same-directory `.vr-upload-<id>.tmp` first, then rename
//      atomically so a half-uploaded file never appears in listings
//   5. enforce `maxBytes` mid-stream so giant uploads fail fast and we
//      can clean up the temp file
// Returns the metadata of the saved file (real absolute path, normalized
// relative path, byte length, and the MIME type the client supplied —
// the server never trusts that for serving, but the client uses it for
// inline preview).
export async function uploadWorkspaceFile({
  root,
  relativePath = "",
  fileName,
  source,
  fallbackCwd,
  maxBytes,
  mimeType,
}) {
  if (!source || typeof source.pipe !== "function") {
    throw buildHttpError("Upload source stream is required.", 400);
  }

  const directoryEntry = await resolveWorkspaceEntry({
    root,
    relativePath,
    fallbackCwd,
  });
  if (!directoryEntry.stats.isDirectory()) {
    throw buildHttpError("Upload destination is not a directory.", 400);
  }

  const safeName = sanitizeUploadFileName(fileName);
  // Refuse to overwrite the managed files at the workspace top level.
  // Nested AGENTS.md / CLAUDE.md inside a sub-directory are fine —
  // those are not the managed pair (which only matters at the root).
  const candidateRelative = directoryEntry.relativePath
    ? `${directoryEntry.relativePath}/${safeName}`
    : safeName;
  if (isManagedWorkspaceFile(candidateRelative)) {
    throw buildHttpError("Cannot overwrite a managed workspace file.", 400);
  }

  // Belt-and-suspenders: resolveWorkspaceEntry already rejected internal
  // segments in the destination dir, but the safe name itself shouldn't
  // re-introduce one (e.g. someone uploads a file literally named
  // ".vibe-research"). MANAGED_WORKSPACE_FILES is fine because we accept
  // those nested.
  if (INTERNAL_PATH_SEGMENTS.has(safeName)) {
    throw buildHttpError("File name is reserved by the workspace.", 400);
  }

  const destinationDirectory = directoryEntry.targetPath;
  const finalName = await pickAvailableFileName(destinationDirectory, safeName);
  const finalPath = path.join(destinationDirectory, finalName);
  const tempPath = path.join(
    destinationDirectory,
    `.vr-upload-${randomUUID().replace(/-/g, "").slice(0, 12)}.tmp`,
  );

  const limit = readUploadMaxBytes(maxBytes);
  const sizeGate = buildSizeLimitTransform(limit);
  const writeStream = createWriteStream(tempPath, { flags: "wx" });

  let writtenBytes = 0;
  sizeGate.on("data", (chunk) => {
    writtenBytes += chunk.length;
  });

  try {
    await pipeline(source, sizeGate, writeStream);
  } catch (error) {
    // Best-effort cleanup; ignore failure when the temp file never
    // existed (e.g. wx flag bailed before write).
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  if (writtenBytes === 0) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw buildHttpError("Uploaded file is empty.", 400);
  }

  try {
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  const finalRelative = directoryEntry.relativePath
    ? `${directoryEntry.relativePath}/${finalName}`
    : finalName;

  return {
    root: directoryEntry.rootPath,
    relativePath: finalRelative,
    name: finalName,
    byteLength: writtenBytes,
    isImage: isImageFile(finalName),
    mimeType: typeof mimeType === "string" ? mimeType : "",
    renamed: finalName !== safeName,
    requestedName: safeName,
  };
}

// Same-directory create-helper for nested folder uploads. The client
// walks the dropped folder tree and asks the server to mkdir the
// intermediate directories before uploading the leaf files. We resolve
// the parent directory through the same workspace-safety checks so a
// crafted path can't escape the root.
export async function ensureWorkspaceDirectory({
  root,
  relativePath = "",
  name,
  fallbackCwd,
}) {
  const folderName = sanitizeUploadFileName(name);
  const parentEntry = await resolveWorkspaceEntry({
    root,
    relativePath,
    fallbackCwd,
  });
  if (!parentEntry.stats.isDirectory()) {
    throw buildHttpError("Parent path is not a directory.", 400);
  }

  if (INTERNAL_PATH_SEGMENTS.has(folderName)) {
    throw buildHttpError("Folder name is reserved by the workspace.", 400);
  }

  const targetPath = path.join(parentEntry.targetPath, folderName);
  await mkdir(targetPath, { recursive: true });

  const finalRelative = parentEntry.relativePath
    ? `${parentEntry.relativePath}/${folderName}`
    : folderName;

  return {
    root: parentEntry.rootPath,
    relativePath: finalRelative,
    name: folderName,
  };
}
