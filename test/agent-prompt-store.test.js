import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentPromptStore } from "../src/agent-prompt-store.js";

test("managed prompts tell Codex and Claude Code how to find building guides", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "vr-agent-prompt-"));
  const stateDir = path.join(cwd, ".vibe-research");
  const wikiRootPath = path.join(stateDir, "wiki");
  const store = new AgentPromptStore({ cwd, stateDir, wikiRootPath });

  try {
    await store.initialize();

    const state = await store.getState();
    assert.match(state.prompt, /vibe-research:building-guides-protocol:v1/);
    assert.match(state.prompt, /\$VIBE_RESEARCH_BUILDING_GUIDES_INDEX/);
    assert.match(state.prompt, /Codex, Claude Code, OpenClaw, and shell agents/);

    for (const filename of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
      const contents = await readFile(path.join(cwd, filename), "utf8");
      assert.match(contents, /vibe-research:managed-agent-prompt/);
      assert.match(contents, /## Building Guides/);
      assert.match(contents, /\$VIBE_RESEARCH_BUILDING_GUIDES_DIR\/<building-id>\.md/);
      assert.match(contents, /Never write secrets/);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
