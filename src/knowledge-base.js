import path from "node:path";
import { readdir, readFile, realpath, stat } from "node:fs/promises";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

function buildHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeRelativePath(value) {
  if (!value) {
    return "";
  }

  const normalized = path.posix
    .normalize(String(value).replaceAll("\\", "/"))
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (!normalized || normalized === ".") {
    return "";
  }

  if (normalized.startsWith("../") || normalized === "..") {
    throw buildHttpError("Path escapes the knowledge base root.", 400);
  }

  return normalized;
}

function ensurePathInsideRoot(rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath);

  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  ) {
    return normalizeRelativePath(relativePath);
  }

  throw buildHttpError("Path escapes the knowledge base root.", 400);
}

function isMarkdownFile(fileName) {
  return MARKDOWN_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function stripMarkdown(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^[\]|#]+)(?:#[^[\]|]+)?(?:\|([^[\]]+))?\]\]/g, (_match, target, alias) => alias || target)
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(content, relativePath) {
  const headingMatch = String(content || "").match(/^#\s+(.+)$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }

  return path.basename(relativePath, path.extname(relativePath));
}

function extractExcerpt(content) {
  const text = stripMarkdown(content);
  return text ? text.slice(0, 180) : "";
}

function collectRawLinkTargets(content) {
  const targets = [];
  const standardLinkPattern = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;

  for (const match of String(content || "").matchAll(standardLinkPattern)) {
    if (match[1] === "!") {
      continue;
    }

    targets.push(match[3]);
  }

  const wikiLinkPattern = /\[\[([^[\]]+)\]\]/g;

  for (const match of String(content || "").matchAll(wikiLinkPattern)) {
    const body = String(match[1] || "").trim();
    if (!body) {
      continue;
    }

    const [targetWithAnchor] = body.split("|");
    const [target] = targetWithAnchor.split("#");
    targets.push(target);
  }

  return targets;
}

function resolveNoteTarget(rawTarget, currentPath, notePathSet) {
  const cleaned = String(rawTarget || "")
    .trim()
    .replace(/^<|>$/g, "");

  if (!cleaned || cleaned.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(cleaned)) {
    return "";
  }

  const [withoutHash] = cleaned.split("#");
  const [withoutQuery] = withoutHash.split("?");
  const normalizedInput = withoutQuery.replaceAll("\\", "/").trim();

  if (!normalizedInput) {
    return "";
  }

  let basePath = "";

  try {
    basePath = normalizedInput.startsWith("/")
      ? normalizeRelativePath(normalizedInput.slice(1))
      : normalizeRelativePath(path.posix.join(path.posix.dirname(currentPath), normalizedInput));
  } catch (error) {
    if (error?.statusCode === 400) {
      return "";
    }

    throw error;
  }

  if (!basePath) {
    return "";
  }

  const candidates = [];
  const extension = path.posix.extname(basePath).toLowerCase();

  if (extension) {
    candidates.push(basePath);
  } else {
    candidates.push(basePath);
    candidates.push(`${basePath}.md`);
    candidates.push(`${basePath}.markdown`);
    candidates.push(path.posix.join(basePath, "index.md"));
  }

  for (const candidate of candidates) {
    if (notePathSet.has(candidate)) {
      return candidate;
    }
  }

  return "";
}

async function resolveKnowledgeBaseRoot(rootPath) {
  const realRootPath = await realpath(rootPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError("Knowledge base root does not exist.", 404);
    }

    throw error;
  });

  const rootStats = await stat(realRootPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError("Knowledge base root does not exist.", 404);
    }

    throw error;
  });

  if (!rootStats.isDirectory()) {
    throw buildHttpError("Knowledge base root is not a directory.", 400);
  }

  return realRootPath;
}

async function collectMarkdownFiles(rootPath, relativeDirectory = "") {
  const directoryPath = path.join(rootPath, relativeDirectory);
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  const results = [];

  const sortedEntries = directoryEntries
    .filter((entry) => !entry.isSymbolicLink())
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });

  for (const entry of sortedEntries) {
    const entryRelativePath = normalizeRelativePath(
      path.posix.join(relativeDirectory, entry.name),
    );

    if (entry.isDirectory()) {
      results.push(...(await collectMarkdownFiles(rootPath, entryRelativePath)));
      continue;
    }

    if (!entry.isFile() || !isMarkdownFile(entry.name)) {
      continue;
    }

    results.push(entryRelativePath);
  }

  return results;
}

export async function listKnowledgeBase({ rootPath, relativeRoot = ".remote-vibes/wiki" }) {
  const resolvedRootPath = await resolveKnowledgeBaseRoot(rootPath);
  const notePaths = await collectMarkdownFiles(resolvedRootPath);
  const notesWithContent = await Promise.all(
    notePaths.map(async (relativePath) => {
      const content = await readFile(path.join(resolvedRootPath, relativePath), "utf8");
      return {
        relativePath,
        title: extractTitle(content, relativePath),
        excerpt: extractExcerpt(content),
        content,
      };
    }),
  );
  const notePathSet = new Set(notesWithContent.map((note) => note.relativePath));
  const edgePairs = new Set();

  const notes = notesWithContent
    .map((note) => {
      const links = collectRawLinkTargets(note.content)
        .map((target) => resolveNoteTarget(target, note.relativePath, notePathSet))
        .filter(Boolean);

      for (const target of links) {
        edgePairs.add(`${note.relativePath}::${target}`);
      }

      return {
        relativePath: note.relativePath,
        title: note.title,
        excerpt: note.excerpt,
        links: Array.from(new Set(links)),
      };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    rootPath: resolvedRootPath,
    relativeRoot,
    notes,
    edges: Array.from(edgePairs)
      .map((pair) => {
        const [source, target] = pair.split("::");
        return { source, target };
      })
      .sort((left, right) => {
        if (left.source !== right.source) {
          return left.source.localeCompare(right.source);
        }

        return left.target.localeCompare(right.target);
      }),
  };
}

export async function readKnowledgeBaseNote({ rootPath, relativePath, relativeRoot = ".remote-vibes/wiki" }) {
  const resolvedRootPath = await resolveKnowledgeBaseRoot(rootPath);
  const normalizedRelativePath = normalizeRelativePath(relativePath);

  if (!normalizedRelativePath) {
    throw buildHttpError("Knowledge base note path is required.", 400);
  }

  if (!isMarkdownFile(normalizedRelativePath)) {
    throw buildHttpError("Knowledge base notes must be markdown files.", 400);
  }

  const requestedPath = path.resolve(resolvedRootPath, normalizedRelativePath);
  const realTargetPath = await realpath(requestedPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError(`Knowledge base note does not exist: ${normalizedRelativePath}`, 404);
    }

    throw error;
  });

  const nextRelativePath = ensurePathInsideRoot(resolvedRootPath, realTargetPath);
  const entryStats = await stat(realTargetPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError(`Knowledge base note does not exist: ${nextRelativePath}`, 404);
    }

    throw error;
  });

  if (!entryStats.isFile()) {
    throw buildHttpError("Requested knowledge base path is not a file.", 400);
  }

  if (!isMarkdownFile(nextRelativePath)) {
    throw buildHttpError("Knowledge base notes must be markdown files.", 400);
  }

  const content = await readFile(realTargetPath, "utf8");

  return {
    rootPath: resolvedRootPath,
    relativeRoot,
    note: {
      relativePath: nextRelativePath,
      title: extractTitle(content, nextRelativePath),
      excerpt: extractExcerpt(content),
      content,
    },
  };
}
