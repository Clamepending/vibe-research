import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSessionEnv, prependPathEntries } from "../src/session-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

test("prependPathEntries prepends helper and common CLI directories once", () => {
  const result = prependPathEntries("/usr/local/bin:/usr/bin:/bin", [
    "/tmp/helper",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]);

  assert.equal(result, "/tmp/helper:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
});

test("buildSessionEnv exposes helper and common CLI directories on PATH", () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  const stateDir = path.join(rootDir, ".remote-vibes");

  try {
    const env = buildSessionEnv("session-1", "shell", [], rootDir, stateDir);
    const entries = env.PATH.split(path.delimiter);

    assert.equal(entries[0], path.join(rootDir, "bin"));
    assert.equal(entries[1], "/opt/homebrew/bin");
    assert.equal(entries[2], "/usr/local/bin");
    assert.ok(entries.includes("/usr/bin"));
    assert.ok(entries.includes("/bin"));
    assert.equal(env.REMOTE_VIBES_ROOT, stateDir);
    assert.equal(env.REMOTE_VIBES_AGENT_PROMPT_PATH, path.join(stateDir, "agent-prompt.md"));
  } finally {
    process.env.PATH = originalPath;
  }
});
