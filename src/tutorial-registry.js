import { promises as fs } from "node:fs";
import path from "node:path";

const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/;

function parseFrontmatter(text) {
  const match = FRONTMATTER_PATTERN.exec(String(text || ""));
  if (!match) {
    return null;
  }
  const rawMeta = match[1];
  const body = match[2];
  const meta = {};
  for (const line of rawMeta.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) {
      continue;
    }
    meta[key] = value;
  }
  return { meta, body };
}

function toOrder(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}

function normalizeMeta(meta = {}) {
  const id = String(meta.id || "").trim();
  const title = String(meta.title || "").trim();
  if (!id || !title) {
    return null;
  }
  return {
    id,
    title,
    buildingId: String(meta.buildingId || "").trim(),
    summary: String(meta.summary || "").trim(),
    priority: String(meta.priority || "normal").trim() || "normal",
    order: toOrder(meta.order),
  };
}

export class TutorialRegistry {
  constructor({ tutorialsDir, fsImpl = fs } = {}) {
    this.tutorialsDir = tutorialsDir;
    this.fsImpl = fsImpl;
    this.cache = new Map();
    this.loaded = false;
  }

  async load() {
    this.cache = new Map();
    let entries = [];
    try {
      entries = await this.fsImpl.readdir(this.tutorialsDir);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[vibe-research] tutorial registry readdir failed:", error);
      }
      this.loaded = true;
      return;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      const filePath = path.join(this.tutorialsDir, entry);
      let text;
      try {
        text = await this.fsImpl.readFile(filePath, "utf8");
      } catch (error) {
        console.warn(`[vibe-research] tutorial registry read failed for ${entry}:`, error);
        continue;
      }

      const parsed = parseFrontmatter(text);
      if (!parsed) {
        console.warn(`[vibe-research] tutorial ${entry} is missing frontmatter; skipping.`);
        continue;
      }

      const meta = normalizeMeta(parsed.meta);
      if (!meta) {
        console.warn(`[vibe-research] tutorial ${entry} is missing required fields (id, title); skipping.`);
        continue;
      }

      this.cache.set(meta.id, {
        ...meta,
        body: parsed.body.replace(/^\s+/, "").replace(/\s+$/, "") + "\n",
      });
    }

    this.loaded = true;
  }

  list() {
    return Array.from(this.cache.values())
      .map(({ body: _body, ...metadata }) => ({ ...metadata }))
      .sort((left, right) => {
        if (left.order !== right.order) {
          return left.order - right.order;
        }
        return left.id.localeCompare(right.id);
      });
  }

  get(id) {
    const key = String(id || "").trim();
    if (!key) {
      return null;
    }
    const entry = this.cache.get(key);
    return entry ? { ...entry } : null;
  }
}
