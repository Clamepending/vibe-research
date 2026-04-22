import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("build-release-assets writes installer manifest and checksums", async () => {
  const tag = "v9.9.9-test";
  const { stdout } = await execFileAsync(process.execPath, ["scripts/build-release-assets.mjs", tag], {
    cwd: rootDir,
  });
  const outDir = stdout.trim().split(/\r?\n/).at(-1);

  try {
    const manifest = JSON.parse(await readFile(path.join(outDir, "release.json"), "utf8"));
    const checksums = await readFile(path.join(outDir, "SHASUMS256.txt"), "utf8");
    const installer = await readFile(path.join(outDir, "install.sh"), "utf8");

    assert.equal(manifest.tag, tag);
    assert.equal(manifest.name, "Vibe Research");
    assert.match(manifest.commit, /^[0-9a-f]{40}$/);
    assert.match(installer, /VIBE_RESEARCH_REPO_SLUG/);
    assert.match(checksums, /^[0-9a-f]{64}  install\.sh/m);
    assert.match(checksums, /^[0-9a-f]{64}  release\.json/m);
  } finally {
    await rm(path.join(rootDir, "dist", "releases", tag), { recursive: true, force: true });
  }
});
