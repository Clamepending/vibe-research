import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsStore } from "../src/settings-store.js";

const WORKSPACE_LIBRARY_RELATIVE = path.join("vibe-research", "buildings", "library");

async function withWorkspace(prefix, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("SettingsStore repairs persisted demo Library paths back to the configured workspace", async () => {
  await withWorkspace("vr-settings-repair-", async (workspaceDir) => {
    const stateDir = path.join(workspaceDir, ".vibe-research");
    await mkdir(stateDir, { recursive: true });
    const staleDemoLibrary = path.join("/tmp", "vr-demo-ui-stale", WORKSPACE_LIBRARY_RELATIVE);
    await writeFile(
      path.join(stateDir, "settings.json"),
      `${JSON.stringify({
        version: 1,
        settings: {
          workspaceRootPath: workspaceDir,
          wikiPath: staleDemoLibrary,
          wikiPathConfigured: true,
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const store = new SettingsStore({
      cwd: workspaceDir,
      stateDir,
      env: { VIBE_RESEARCH_WORKSPACE_DIR: workspaceDir },
    });
    await store.initialize();

    const expectedLibrary = path.join(workspaceDir, WORKSPACE_LIBRARY_RELATIVE);
    assert.equal(store.settings.workspaceRootPath, workspaceDir);
    assert.equal(store.settings.wikiPath, expectedLibrary);
    assert.equal(store.settings.wikiPathConfigured, true);

    const saved = JSON.parse(await readFile(path.join(stateDir, "settings.json"), "utf8"));
    assert.equal(saved.settings.wikiPath, expectedLibrary);
  });
});

test("SettingsStore preserves explicit non-demo Library paths", async () => {
  await withWorkspace("vr-settings-custom-", async (workspaceDir) => {
    const stateDir = path.join(workspaceDir, ".vibe-research");
    const customLibrary = path.join(workspaceDir, "custom-library");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "settings.json"),
      `${JSON.stringify({
        version: 1,
        settings: {
          workspaceRootPath: workspaceDir,
          wikiPath: customLibrary,
          wikiPathConfigured: true,
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const store = new SettingsStore({ cwd: workspaceDir, stateDir, env: {} });
    await store.initialize();

    assert.equal(store.settings.wikiPath, customLibrary);
    assert.equal(store.settings.wikiPathConfigured, true);
  });
});
