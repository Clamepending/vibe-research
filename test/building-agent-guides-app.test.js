import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getBuildingAgentGuideIndexPath,
  getBuildingAgentGuidePath,
} from "../src/building-agent-guides.js";
import { createVibeResearchApp } from "../src/create-app.js";
import { getVibeResearchSystemDir } from "../src/state-paths.js";

function createNoopSleepPreventionService() {
  return {
    getStatus() {
      return { enabled: false, running: false };
    },
    setConfig() {},
    start() {},
    stop() {},
  };
}

test("app startup writes building guide files for spawned agents", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "vr-guides-app-"));
  const stateDir = path.join(cwd, ".vibe-research");
  const app = await createVibeResearchApp({
    cwd,
    host: "127.0.0.1",
    port: 0,
    persistSessions: false,
    persistentTerminals: false,
    sleepPreventionFactory: createNoopSleepPreventionService,
    stateDir,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${app.config.port}/api/state`);
    assert.equal(response.status, 200);

    const systemRootPath = getVibeResearchSystemDir({ cwd, stateDir });
    const index = await readFile(getBuildingAgentGuideIndexPath(systemRootPath), "utf8");
    const tailscaleGuide = await readFile(getBuildingAgentGuidePath(systemRootPath, "tailscale"), "utf8");

    assert.match(index, /# Vibe Research Building Guides/);
    assert.match(index, /\[Tailscale\]\(\.\/tailscale\.md\)/);
    assert.match(tailscaleGuide, /tailscale status/);
    assert.match(tailscaleGuide, /Agent Rules/);
  } finally {
    await app.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
