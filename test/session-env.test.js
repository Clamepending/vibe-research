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
    assert.equal(env.VIBE_RESEARCH_BUILDING_GUIDES_DIR, path.join(systemRoot, "building-guides"));
    assert.equal(env.VIBE_RESEARCH_BUILDING_GUIDES_INDEX, path.join(systemRoot, "building-guides", "README.md"));
    assert.equal(
      env.VIBE_RESEARCH_BUILDING_GUIDES_HELP,
      "sed -n '1,220p' \"$VIBE_RESEARCH_BUILDING_GUIDES_INDEX\"",
    );
    assert.equal(env.REMOTE_VIBES_BUILDING_GUIDES_DIR, path.join(systemRoot, "building-guides"));
    assert.equal(env.REMOTE_VIBES_BUILDING_GUIDES_INDEX, path.join(systemRoot, "building-guides", "README.md"));
    assert.equal(
      env.REMOTE_VIBES_BUILDING_GUIDES_HELP,
      "sed -n '1,220p' \"$REMOTE_VIBES_BUILDING_GUIDES_INDEX\"",
    );
    assert.equal(env.PWCLI, "vr-playwright");
    assert.equal(env.VIBE_RESEARCH_BROWSER_COMMAND, "vr-playwright");
    assert.equal(env.VIBE_RESEARCH_BROWSER_FALLBACK_COMMAND, "vr-browser");
    assert.equal(env.VIBE_RESEARCH_BROWSER_USE_COMMAND, "vr-browser-use");
    assert.equal(env.VIBE_RESEARCH_OTTOAUTH_COMMAND, "vr-ottoauth");
    assert.equal(env.VIBE_RESEARCH_SCAFFOLD_RECIPE_COMMAND, "vr-scaffold-recipe");
    assert.equal(env.VIBE_RESEARCH_SCAFFOLD_RECIPE_HELP, "vr-scaffold-recipe export --pretty");
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
    assert.equal(env.VIBE_RESEARCH_AGENT_CANVAS_COMMAND, "vr-agent-canvas");
    assert.equal(env.REMOTE_VIBES_AGENT_CANVAS_COMMAND, "rv-agent-canvas");
    assert.equal(env.REMOTE_VIBES_SCAFFOLD_RECIPE_COMMAND, "rv-scaffold-recipe");
    assert.equal(env.REMOTE_VIBES_SCAFFOLD_RECIPE_HELP, "rv-scaffold-recipe export --pretty");
    assert.match(env.VIBE_RESEARCH_AGENT_CANVAS_HELP, /vr-agent-canvas --image results\/chart\.png/);
    assert.match(env.REMOTE_VIBES_AGENT_CANVAS_HELP, /rv-agent-canvas --image results\/chart\.png/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("ML Intern handoff prompt keeps Vibe Research as the research ledger", async () => {
  const prompt = await readFile(path.join(rootDir, "templates", "ml-intern-vibe-research-move.md"), "utf8");

  assert.match(prompt, /execute exactly one Vibe Research move/);
  assert.match(prompt, /Read `AGENTS\.md`/);
  assert.match(prompt, /take QUEUE row 1/i);
  assert.match(prompt, /commit and push the Library/i);
  assert.match(prompt, /cite paper\(s\)/i);
  assert.match(prompt, /inspect dataset schema/i);
  assert.match(prompt, /Do not hide a search over multiple independent candidates inside one move/i);
});

test("buildSessionEnv does not inject Google Drive connector access into local terminal agents", () => {
  const rootDir = "/tmp/vibe-research-test-root";
  const stateDir = "/tmp/vibe-research-test-state";
  const wikiRoot = "/tmp/vibe-research-test-wiki";
  const systemRoot = "/tmp/vibe-research-test-system";
  const env = buildSessionEnv(
    "session-drive",
    "codex",
    [],
    rootDir,
    stateDir,
    { PATH: "/usr/bin:/bin" },
    wikiRoot,
    systemRoot,
  );

  const connectorKeys = Object.keys(env).filter((key) => /GOOGLE|DRIVE|MCP/i.test(key));
  assert.deepEqual(connectorKeys, []);
});

test("buildSessionEnv does not inject external social or device connector credentials", () => {
  const rootDir = "/tmp/vibe-research-test-root";
  const stateDir = "/tmp/vibe-research-test-state";
  const wikiRoot = "/tmp/vibe-research-test-wiki";
  const systemRoot = "/tmp/vibe-research-test-system";
  const env = buildSessionEnv(
    "session-connectors",
    "codex",
    [],
    rootDir,
    stateDir,
    { PATH: "/usr/bin:/bin" },
    wikiRoot,
    systemRoot,
  );

  const connectorKeys = Object.keys(env).filter((key) =>
    /DISCORD|MOLTBOOK|TWITTER|IMESSAGE|PHONE|SMS|HOMEKIT|HOME_ASSISTANT|MATTER/i.test(key),
  );
  assert.deepEqual(connectorKeys, []);
});

test("buildSessionEnv routes local Claude Code sessions through Ollama", () => {
  const rootDir = "/tmp/vibe-research-test-root";
  const stateDir = "/tmp/vibe-research-test-state";
  const wikiRoot = "/tmp/vibe-research-test-wiki";
  const systemRoot = "/tmp/vibe-research-test-system";
  const env = buildSessionEnv(
    "session-local-claude",
    "claude-ollama",
    [],
    rootDir,
    stateDir,
    {
      ANTHROPIC_API_KEY: "sk-ant-real-key",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      PATH: "/usr/bin:/bin",
      VIBE_RESEARCH_CLAUDE_OLLAMA_BASE_URL: "http://127.0.0.1:11435/",
      VIBE_RESEARCH_CLAUDE_OLLAMA_MODEL: "qwen2.5-coder:7b",
      NO_PROXY: "example.test,localhost",
    },
    wikiRoot,
    systemRoot,
  );

  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "ollama");
  assert.equal(env.ANTHROPIC_API_KEY, "local");
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:11435");
  assert.equal(env.ANTHROPIC_MODEL, "qwen2.5-coder:7b");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "qwen2.5-coder:7b");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "qwen2.5-coder:7b");
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "qwen2.5-coder:7b");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "qwen2.5-coder:7b");
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_THINKING, "1");
  assert.equal(env.DISABLE_INTERLEAVED_THINKING, "1");
  assert.equal(env.DISABLE_PROMPT_CACHING, "1");
  assert.equal(env.NO_PROXY, "example.test,localhost,127.0.0.1,::1");
  assert.equal(env.no_proxy, "example.test,localhost,127.0.0.1,::1");
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
