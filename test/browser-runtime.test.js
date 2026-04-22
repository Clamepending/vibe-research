import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolveBrowserExecutablePath } from "../src/browser-runtime.js";

test("resolveBrowserExecutablePath skips Vibe Research browser detour wrappers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-browser-runtime-"));
  const appRoot = path.join(tempDir, "app-root");
  const helperDir = path.join(appRoot, "bin");
  const realBrowserDir = path.join(tempDir, "real-browser");
  const detourPath = path.join(helperDir, "google-chrome");
  const realBrowserPath = path.join(realBrowserDir, "google-chrome");

  try {
    await mkdir(helperDir, { recursive: true });
    await mkdir(realBrowserDir, { recursive: true });
    await writeFile(detourPath, "#!/usr/bin/env bash\nexit 64\n", "utf8");
    await chmod(detourPath, 0o755);
    await writeFile(realBrowserPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    await chmod(realBrowserPath, 0o755);

    const resolved = await resolveBrowserExecutablePath({
      env: {
        PATH: [helperDir, realBrowserDir].join(path.delimiter),
        VIBE_RESEARCH_APP_ROOT: appRoot,
      },
    });

    assert.equal(resolved, realBrowserPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
