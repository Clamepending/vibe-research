import fs from "node:fs";
import path from "node:path";

const DEBOUNCE_MS = 250;
const DEDUPE_WINDOW_MS = 1500;

function normalizeRoot(root) {
  try {
    return fs.realpathSync(root);
  } catch {
    return null;
  }
}

export function startLibraryActivityWatcher({ wikiPath, resolveSessionForPath, broadcast, log = () => {} }) {
  const root = normalizeRoot(wikiPath);
  if (!root) {
    log(`[library-activity] skipping watcher, no wiki path at ${wikiPath}`);
    return () => {};
  }

  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true, persistent: false }, (_eventType, relative) => {
      if (!relative) return;
      const relativePath = String(relative);
      if (!relativePath.endsWith(".md")) return;
      if (relativePath.split(path.sep).some((segment) => segment.startsWith("."))) return;

      const absolute = path.join(root, relativePath);
      scheduleEmit(absolute);
    });
  } catch (error) {
    log(`[library-activity] could not watch ${root}: ${error.message}`);
    return () => {};
  }

  const pendingTimers = new Map();
  const recentEmits = new Map();

  function scheduleEmit(absolutePath) {
    clearTimeout(pendingTimers.get(absolutePath));
    pendingTimers.set(
      absolutePath,
      setTimeout(() => {
        pendingTimers.delete(absolutePath);
        emit(absolutePath);
      }, DEBOUNCE_MS),
    );
  }

  function emit(absolutePath) {
    try {
      const stats = fs.statSync(absolutePath);
      if (!stats.isFile()) return;

      const dedupeKey = `${absolutePath}:${Math.floor(stats.mtimeMs / 100)}`;
      const now = Date.now();
      const lastEmitted = recentEmits.get(dedupeKey);
      if (lastEmitted && now - lastEmitted < DEDUPE_WINDOW_MS) return;
      recentEmits.set(dedupeKey, now);

      for (const [key, ts] of recentEmits) {
        if (now - ts > DEDUPE_WINDOW_MS * 4) recentEmits.delete(key);
      }

      const sessionId = resolveSessionForPath(absolutePath) || "";
      broadcast({
        type: "library-activity",
        sessionId,
        path: absolutePath,
        ts: now,
      });
    } catch {
      // Path vanished between debounce and emit; ignore.
    }
  }

  return () => {
    try {
      watcher.close();
    } catch {
      // no-op
    }
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    pendingTimers.clear();
    recentEmits.clear();
  };
}
