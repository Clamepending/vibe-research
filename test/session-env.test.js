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
  const wikiRoot = path.join(rootDir, "mac-brain");

  try {
    const env = buildSessionEnv("session-1", "shell", [], rootDir, stateDir, process.env, wikiRoot);
    const entries = env.PATH.split(path.delimiter);

    assert.equal(entries[0], path.join(rootDir, "bin"));
    assert.equal(entries[1], "/opt/homebrew/bin");
    assert.equal(entries[2], "/usr/local/bin");
    assert.ok(entries.includes("/usr/bin"));
    assert.ok(entries.includes("/bin"));
    assert.equal(env.REMOTE_VIBES_ROOT, stateDir);
    assert.equal(env.REMOTE_VIBES_AGENT_PROMPT_PATH, path.join(stateDir, "agent-prompt.md"));
    assert.equal(env.PWCLI, "rv-playwright");
    assert.equal(env.REMOTE_VIBES_BROWSER_COMMAND, "rv-playwright");
    assert.equal(env.REMOTE_VIBES_BROWSER_FALLBACK_COMMAND, "rv-browser");
    assert.equal(env.REMOTE_VIBES_PLAYWRIGHT_COMMAND, "rv-playwright");
    assert.equal(env.REMOTE_VIBES_PLAYWRIGHT_SKILL, path.join(rootDir, "skills", "playwright", "SKILL.md"));
    assert.equal(env.REMOTE_VIBES_WIKI_DIR, wikiRoot);
    assert.equal(env.REMOTE_VIBES_COMMS_DIR, path.join(wikiRoot, "comms"));
    assert.equal(
      env.REMOTE_VIBES_AGENT_INBOX,
      path.join(wikiRoot, "comms", "agents", "session-1", "inbox"),
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("buildSessionEnv strips inherited NO_COLOR and enables terminal colors", () => {
  const stateDir = path.join(rootDir, ".remote-vibes");
  const env = buildSessionEnv(
    "session-color",
    "shell",
    [],
    rootDir,
    stateDir,
    {
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
      TERM: "dumb",
    },
    path.join(rootDir, "mac-brain"),
  );

  assert.equal(Object.hasOwn(env, "NO_COLOR"), false);
  assert.equal(env.CLICOLOR, "1");
  assert.equal(env.COLORTERM, "truecolor");
  assert.equal(env.TERM, "xterm-256color");
});
