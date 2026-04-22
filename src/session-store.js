import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

const SESSION_FILE_VERSION = 1;

function buildPayload(sessions) {
  return {
    version: SESSION_FILE_VERSION,
    savedAt: new Date().toISOString(),
    sessions,
  };
}

export class SessionStore {
  constructor({ enabled = true, stateDir }) {
    this.enabled = enabled;
    this.stateDir = stateDir;
    this.filePath = path.join(stateDir, "sessions.json");
    this.tempFilePath = path.join(stateDir, "sessions.json.tmp");
    this.saveCounter = 0;
    this.saveQueue = Promise.resolve();
  }

  async load() {
    if (!this.enabled) {
      return [];
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      const payload = JSON.parse(raw);

      if (payload?.version !== SESSION_FILE_VERSION || !Array.isArray(payload.sessions)) {
        return [];
      }

      return payload.sessions;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }

      console.warn("[vibe-research] failed to load persisted sessions", error);
      return [];
    }
  }

  async save(sessions) {
    if (!this.enabled) {
      return;
    }

    const snapshot = Array.isArray(sessions) ? sessions : [];
    this.saveQueue = this.saveQueue
      .catch(() => {})
      .then(() => this.writeSnapshot(snapshot));
    return this.saveQueue;
  }

  async writeSnapshot(sessions) {
    await mkdir(this.stateDir, { recursive: true });
    const payload = `${JSON.stringify(buildPayload(sessions), null, 2)}\n`;
    this.saveCounter += 1;
    const tempFilePath = `${this.filePath}.${process.pid}.${this.saveCounter}.tmp`;

    try {
      await writeFile(tempFilePath, payload, "utf8");
      await rename(tempFilePath, this.filePath);
    } finally {
      await rm(tempFilePath, { force: true }).catch(() => {});
    }
  }

  async clear() {
    if (!this.enabled) {
      return;
    }

    await rm(this.filePath, { force: true });
    await rm(this.tempFilePath, { force: true });
  }
}
