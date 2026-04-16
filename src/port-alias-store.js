import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

const PORT_ALIAS_FILE_VERSION = 1;

function buildPayload(aliases) {
  return {
    version: PORT_ALIAS_FILE_VERSION,
    savedAt: new Date().toISOString(),
    aliases,
  };
}

export class PortAliasStore {
  constructor({ stateDir }) {
    this.stateDir = stateDir;
    this.filePath = path.join(stateDir, "port-aliases.json");
    this.tempFilePath = path.join(stateDir, "port-aliases.json.tmp");
    this.aliases = new Map();
  }

  async initialize() {
    this.aliases = new Map(Object.entries(await this.load()));
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const payload = JSON.parse(raw);

      if (payload?.version !== PORT_ALIAS_FILE_VERSION || !payload.aliases || typeof payload.aliases !== "object") {
        return {};
      }

      return payload.aliases;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {};
      }

      console.warn("[remote-vibes] failed to load persisted port aliases", error);
      return {};
    }
  }

  getAlias(port) {
    return this.aliases.get(String(port)) || "";
  }

  apply(entries) {
    return entries.map((entry) => {
      const alias = this.getAlias(entry.port);
      return {
        ...entry,
        name: alias || String(entry.port),
        customName: Boolean(alias),
      };
    });
  }

  async rename(port, name) {
    if (typeof name !== "string") {
      throw new Error("Port name must be a string.");
    }

    const normalizedName = name.trim();
    const key = String(port);

    if (normalizedName) {
      this.aliases.set(key, normalizedName);
    } else {
      this.aliases.delete(key);
    }

    await this.save();
    return normalizedName;
  }

  async save() {
    await mkdir(this.stateDir, { recursive: true });
    const aliases = Object.fromEntries(
      Array.from(this.aliases.entries()).sort(([left], [right]) => Number(left) - Number(right)),
    );
    const payload = `${JSON.stringify(buildPayload(aliases), null, 2)}\n`;
    await writeFile(this.tempFilePath, payload, "utf8");
    await rename(this.tempFilePath, this.filePath);
  }

  async clear() {
    this.aliases.clear();
    await rm(this.filePath, { force: true });
    await rm(this.tempFilePath, { force: true });
  }
}
