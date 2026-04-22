import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  const stateDir = path.join(rootDir, ".vibe-research");
  const wikiRoot = path.join(rootDir, "mac-brain");
  const systemRoot = path.join(stateDir, "vibe-research-system");

  try {
    const env = buildSessionEnv("session-1", "shell", [], rootDir, stateDir, process.env, wikiRoot, systemRoot);
    const entries = env.PATH.split(path.delimiter);

    assert.equal(entries[0], path.join(rootDir, "bin"));
    assert.equal(entries[1], "/opt/homebrew/bin");
    assert.equal(entries[2], "/usr/local/bin");
    assert.ok(entries.includes("/usr/bin"));
    assert.ok(entries.includes("/bin"));
    assert.equal(env.VIBE_RESEARCH_ROOT, stateDir);
    assert.equal(env.VIBE_RESEARCH_SYSTEM_DIR, systemRoot);
    assert.equal(env.VIBE_RESEARCH_AGENT_PROMPT_PATH, path.join(stateDir, "agent-prompt.md"));
    assert.equal(env.PWCLI, "vr-playwright");
    assert.equal(env.VIBE_RESEARCH_BROWSER_COMMAND, "vr-playwright");
    assert.equal(env.VIBE_RESEARCH_BROWSER_FALLBACK_COMMAND, "vr-browser");
    assert.equal(env.VIBE_RESEARCH_BROWSER_USE_COMMAND, "vr-browser-use");
    assert.equal(env.VIBE_RESEARCH_PLAYWRIGHT_COMMAND, "vr-playwright");
    assert.equal(env.VIBE_RESEARCH_PLAYWRIGHT_SKILL, path.join(rootDir, "skills", "playwright", "SKILL.md"));
    assert.equal(
      env.VIBE_RESEARCH_ML_INTERN_HANDOFF_PROMPT,
      path.join(rootDir, "templates", "ml-intern-vibe-research-move.md"),
    );
    assert.equal(
      env.VIBE_RESEARCH_ML_INTERN_HELP,
      "ml-intern \"$(cat \\\"$VIBE_RESEARCH_ML_INTERN_HANDOFF_PROMPT\\\")\"",
    );
    assert.equal(env.VIBE_RESEARCH_WIKI_DIR, wikiRoot);
    assert.equal(env.VIBE_RESEARCH_COMMS_DIR, path.join(systemRoot, "comms"));
    assert.equal(
      env.VIBE_RESEARCH_AGENT_INBOX,
      path.join(systemRoot, "comms", "agents", "session-1", "inbox"),
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("ML Intern handoff prompt keeps Vibe Research as the research ledger", async () => {
  const prompt = await readFile(path.join(rootDir, "templates", "ml-intern-vibe-research-move.md"), "utf8");

  assert.match(prompt, /execute exactly one Vibe Research move/);
  assert.match(prompt, /Read `AGENTS\.md`/);
  assert.match(prompt, /take QUEUE row 1/i);
  assert.match(prompt, /commit and push the wiki/i);
  assert.match(prompt, /cite paper\(s\)/i);
  assert.match(prompt, /inspect dataset schema/i);
  assert.match(prompt, /Do not hide a search over multiple independent candidates inside one move/i);
});

test("buildSessionEnv strips inherited NO_COLOR and enables terminal colors", () => {
  const stateDir = path.join(rootDir, ".vibe-research");
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

test("buildSessionEnv can cap native math thread pools for low-power hosts", () => {
  const stateDir = path.join(rootDir, ".vibe-research");
  const env = buildSessionEnv(
    "session-threads",
    "shell",
    [],
    rootDir,
    stateDir,
    {
      PATH: "/usr/bin:/bin",
      VIBE_RESEARCH_AGENT_THREAD_LIMIT: "2",
    },
    path.join(rootDir, "mac-brain"),
  );

  assert.equal(env.OMP_NUM_THREADS, "2");
  assert.equal(env.OPENBLAS_NUM_THREADS, "2");
  assert.equal(env.MKL_NUM_THREADS, "2");
  assert.equal(env.NUMEXPR_NUM_THREADS, "2");
  assert.equal(env.VECLIB_MAXIMUM_THREADS, "2");
  assert.equal(env.RAYON_NUM_THREADS, "2");
});
