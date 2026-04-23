import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentPromptStore } from "../src/agent-prompt-store.js";

test("managed prompts tell terminal agents how to find building guides", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "vr-agent-prompt-"));
  const stateDir = path.join(cwd, ".vibe-research");
  const wikiRootPath = path.join(stateDir, "wiki");
  const store = new AgentPromptStore({ cwd, stateDir, wikiRootPath });

  try {
    await store.initialize();

    const state = await store.getState();
    assert.match(state.prompt, /vibe-research:building-guides-protocol:v3/);
    assert.match(state.prompt, /\$VIBE_RESEARCH_BUILDING_GUIDES_INDEX/);
    assert.match(state.prompt, /Codex, Claude Code, OpenClaw, and shell agents/);
    assert.match(state.prompt, /## Agent Town State/);
    assert.match(state.prompt, /\$VIBE_RESEARCH_AGENT_TOWN_API\/state/);
    assert.match(state.prompt, /Situational awareness baseline/);
    assert.match(state.prompt, /Treat that response as the source of truth/);
    assert.match(state.prompt, /Never claim that Agent Town or the canvas is unavailable/);
    assert.match(state.prompt, /vr-agent-canvas --image <path>/);
    assert.match(state.prompt, /satisfied: true/);
    assert.match(state.prompt, /first_building_placed/);

    for (const filename of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
      const contents = await readFile(path.join(cwd, filename), "utf8");
      assert.match(contents, /vibe-research:managed-agent-prompt/);
      assert.match(contents, /## Building Guides/);
      assert.match(contents, /\$VIBE_RESEARCH_BUILDING_GUIDES_DIR\/<building-id>\.md/);
      assert.match(contents, /## Agent Town State/);
      assert.match(contents, /latest canvas appears under the agent profile/);
      assert.match(contents, /Never write secrets/);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
