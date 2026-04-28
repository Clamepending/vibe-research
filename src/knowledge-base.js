import path from "node:path";
import { readdir, readFile, realpath, stat } from "node:fs/promises";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const RECOVERABLE_SCAN_ERROR_CODES = new Set(["EACCES", "ENOENT", "ENOTDIR", "EPERM", "ELOOP"]);
const ALLOWED_HIDDEN_KNOWLEDGE_BASE_DIRECTORY_NAMES = new Set([".vibe-research", ".remote-vibes"]);
const IGNORED_KNOWLEDGE_BASE_DIRECTORY_NAMES = new Set([
  ".DocumentRevisions-V100",
  ".Spotlight-V100",
  ".TemporaryItems",
  ".Trash",
  ".fseventsd",
  ".git",
  ".hg",
  ".svn",
  "$RECYCLE.BIN",
  "Applications",
  "Library",
  "System Volume Information",
  "node_modules",
]);

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
    throw buildHttpError("Path escapes the library root.", 400);
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

  throw buildHttpError("Path escapes the library root.", 400);
}

function isMarkdownFile(fileName) {
  return MARKDOWN_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function isRecoverableScanError(error) {
  return RECOVERABLE_SCAN_ERROR_CODES.has(error?.code);
}

function shouldSkipKnowledgeBaseDirectory(directoryName) {
  return (
    IGNORED_KNOWLEDGE_BASE_DIRECTORY_NAMES.has(directoryName) ||
    (directoryName.startsWith(".") && !ALLOWED_HIDDEN_KNOWLEDGE_BASE_DIRECTORY_NAMES.has(directoryName))
  );
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

const HEADLINE_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
]);

const HEADLINE_TAKEAWAY_LIMIT = 280;

function* iterateImageMarkdown(content) {
  const text = String(content || "");
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf("![", cursor);
    if (start < 0) {
      return;
    }

    if (start > 0 && text[start - 1] === "\\") {
      cursor = start + 2;
      continue;
    }

    let altDepth = 1;
    let altCursor = start + 2;
    while (altCursor < text.length && altDepth > 0) {
      const character = text[altCursor];
      if (character === "\\") {
        altCursor += 2;
        continue;
      }

      if (character === "[") {
        altDepth += 1;
      } else if (character === "]") {
        altDepth -= 1;
        if (altDepth === 0) {
          break;
        }
      }

      altCursor += 1;
    }

    if (altDepth !== 0 || text[altCursor] !== "]" || text[altCursor + 1] !== "(") {
      cursor = start + 2;
      continue;
    }

    const alt = text.slice(start + 2, altCursor);

    let parenDepth = 1;
    let parenCursor = altCursor + 2;
    while (parenCursor < text.length && parenDepth > 0) {
      const character = text[parenCursor];
      if (character === "\\") {
        parenCursor += 2;
        continue;
      }

      if (character === "(") {
        parenDepth += 1;
      } else if (character === ")") {
        parenDepth -= 1;
        if (parenDepth === 0) {
          break;
        }
      }

      parenCursor += 1;
    }

    if (parenDepth !== 0) {
      cursor = start + 2;
      continue;
    }

    const destinationField = text.slice(altCursor + 2, parenCursor).trim();
    yield { alt: alt.trim(), destinationField };
    cursor = parenCursor + 1;
  }
}

function parseImageDestination(destinationField) {
  if (!destinationField) {
    return "";
  }

  let candidate = destinationField;
  if (candidate.startsWith("<")) {
    const closing = candidate.indexOf(">");
    if (closing >= 0) {
      candidate = candidate.slice(1, closing);
    } else {
      candidate = candidate.slice(1);
    }
  } else {
    const whitespaceMatch = candidate.match(/\s/);
    if (whitespaceMatch) {
      candidate = candidate.slice(0, whitespaceMatch.index);
    }
  }

  return candidate.trim();
}

function extractHeadlineImage(content) {
  for (const candidate of iterateImageMarkdown(content)) {
    const url = parseImageDestination(candidate.destinationField);
    if (!url) {
      continue;
    }

    const [pathPart] = url.split("#");
    const [pathWithoutQuery] = pathPart.split("?");
    const lowercasePath = pathWithoutQuery.toLowerCase();
    const dotIndex = lowercasePath.lastIndexOf(".");
    if (dotIndex < 0) {
      continue;
    }

    const extension = lowercasePath.slice(dotIndex);
    if (!HEADLINE_IMAGE_EXTENSIONS.has(extension)) {
      continue;
    }

    return { url, alt: candidate.alt };
  }

  return { url: "", alt: "" };
}

function extractTakeaway(content) {
  const text = String(content || "");

  const headingMatch = text.match(
    /(?:^|\r?\n)#{1,6}[ \t]+(?:\*\*)?TAKEAWAY(?:\*\*)?[ \t]*(?:\r?\n)+([\s\S]*?)(?=\r?\n#{1,6}[ \t]+|$)/,
  );

  if (headingMatch?.[1]) {
    const stripped = stripMarkdown(headingMatch[1]).trim();
    if (stripped) {
      return stripped.slice(0, HEADLINE_TAKEAWAY_LIMIT);
    }
  }

  const inlineMatch = text.match(
    /(?:^|\r?\n)[ \t]*(?:[-*][ \t]+)?\*\*TAKEAWAY\*\*[ \t]*[—–\-:]?[ \t]*([^\r\n]+(?:\r?\n(?![ \t]*\*\*[A-Z]|[ \t]*#{1,6}[ \t]|[ \t]*\r?\n)[^\r\n]+)*)/,
  );

  if (inlineMatch?.[1]) {
    const stripped = stripMarkdown(inlineMatch[1]).trim();
    if (stripped) {
      return stripped.slice(0, HEADLINE_TAKEAWAY_LIMIT);
    }
  }

  return "";
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
      throw buildHttpError("Library root does not exist.", 404);
    }

    throw error;
  });

  const rootStats = await stat(realRootPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError("Library root does not exist.", 404);
    }

    throw error;
  });

  if (!rootStats.isDirectory()) {
    throw buildHttpError("Library root is not a directory.", 400);
  }

  return realRootPath;
}

async function resolveNestedKnowledgeBaseRoot(realRootPath) {
  const nestedRootCandidates = [
    path.join(realRootPath, "vibe-research", "buildings", "library"),
    path.join(realRootPath, ".vibe-research", "wiki"),
    path.join(realRootPath, ".remote-vibes", "wiki"),
  ];

  for (const nestedRootPath of nestedRootCandidates) {
    const nestedStats = await stat(nestedRootPath).catch(() => null);

    if (nestedStats?.isDirectory()) {
      return realpath(nestedRootPath).catch(() => null);
    }
  }

  return null;
}

async function resolveKnowledgeBaseRootInfo(rootPath) {
  const realRootPath = await resolveKnowledgeBaseRoot(rootPath);
  const nestedRootPath = await resolveNestedKnowledgeBaseRoot(realRootPath);

  if (!nestedRootPath) {
    return {
      rootPath: realRootPath,
      relativeRoot: "",
    };
  }

  return {
    rootPath: nestedRootPath,
    relativeRoot: normalizeRelativePath(path.relative(realRootPath, nestedRootPath)),
  };
}

async function collectMarkdownFiles(rootPath, relativeDirectory = "", scanState = { skippedEntries: 0 }) {
  const directoryPath = path.join(rootPath, relativeDirectory);
  let directoryEntries = [];
  try {
    directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (!relativeDirectory || !isRecoverableScanError(error)) {
      throw error;
    }

    scanState.skippedEntries += 1;
    return [];
  }

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
      if (shouldSkipKnowledgeBaseDirectory(entry.name)) {
        scanState.skippedEntries += 1;
        continue;
      }

      results.push(...(await collectMarkdownFiles(rootPath, entryRelativePath, scanState)));
      continue;
    }

    if (!entry.isFile() || !isMarkdownFile(entry.name)) {
      continue;
    }

    results.push(entryRelativePath);
  }

  return results;
}

export async function listKnowledgeBase({ rootPath, relativeRoot = "vibe-research/buildings/library" }) {
  const rootInfo = await resolveKnowledgeBaseRootInfo(rootPath);
  const resolvedRootPath = rootInfo.rootPath;
  const scanState = { skippedEntries: 0 };
  const notePaths = await collectMarkdownFiles(resolvedRootPath, "", scanState);
  const notesWithContent = (await Promise.all(
    notePaths.map(async (relativePath) => {
      let content = "";
      try {
        content = await readFile(path.join(resolvedRootPath, relativePath), "utf8");
      } catch (error) {
        if (!isRecoverableScanError(error)) {
          throw error;
        }

        scanState.skippedEntries += 1;
        return null;
      }

      return {
        relativePath,
        title: extractTitle(content, relativePath),
        excerpt: extractExcerpt(content),
        headlineImage: extractHeadlineImage(content),
        takeaway: extractTakeaway(content),
        content,
      };
    }),
  )).filter(Boolean);
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
        headlineImageUrl: note.headlineImage.url,
        headlineImageAlt: note.headlineImage.alt,
        takeaway: note.takeaway,
        links: Array.from(new Set(links)),
        searchText: stripMarkdown(note.content),
      };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    rootPath: resolvedRootPath,
    relativeRoot: rootInfo.relativeRoot || relativeRoot,
    skippedEntries: scanState.skippedEntries,
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

export async function readKnowledgeBaseNote({ rootPath, relativePath, relativeRoot = "vibe-research/buildings/library" }) {
  const rootInfo = await resolveKnowledgeBaseRootInfo(rootPath);
  const resolvedRootPath = rootInfo.rootPath;
  const normalizedRelativePath = normalizeRelativePath(relativePath);

  if (!normalizedRelativePath) {
    throw buildHttpError("Library note path is required.", 400);
  }

  if (!isMarkdownFile(normalizedRelativePath)) {
    throw buildHttpError("Library notes must be markdown files.", 400);
  }

  const requestedPath = path.resolve(resolvedRootPath, normalizedRelativePath);
  const realTargetPath = await realpath(requestedPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError(`Library note does not exist: ${normalizedRelativePath}`, 404);
    }

    throw error;
  });

  const nextRelativePath = ensurePathInsideRoot(resolvedRootPath, realTargetPath);
  const entryStats = await stat(realTargetPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw buildHttpError(`Library note does not exist: ${nextRelativePath}`, 404);
    }

    throw error;
  });

  if (!entryStats.isFile()) {
    throw buildHttpError("Requested library path is not a file.", 400);
  }

  if (!isMarkdownFile(nextRelativePath)) {
    throw buildHttpError("Library notes must be markdown files.", 400);
  }

  const content = await readFile(realTargetPath, "utf8");
  const headlineImage = extractHeadlineImage(content);

  return {
    rootPath: resolvedRootPath,
    relativeRoot: rootInfo.relativeRoot || relativeRoot,
    note: {
      relativePath: nextRelativePath,
      title: extractTitle(content, nextRelativePath),
      excerpt: extractExcerpt(content),
      headlineImageUrl: headlineImage.url,
      headlineImageAlt: headlineImage.alt,
      takeaway: extractTakeaway(content),
      content,
    },
  };
}
