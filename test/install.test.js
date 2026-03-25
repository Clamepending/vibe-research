import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const installScript = path.join(rootDir, "install.sh");

async function createSourceRepo() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-source-"));
  const repoDir = path.join(tempRoot, "repo");
  await mkdir(repoDir, { recursive: true });

  await writeFile(
    path.join(repoDir, "start.sh"),
    "#!/usr/bin/env bash\nset -euo pipefail\necho SOURCE_VERSION=$(cat VERSION)\n",
  );
  await writeFile(path.join(repoDir, "VERSION"), "v1\n");

  await execFile("chmod", ["+x", path.join(repoDir, "start.sh")]);
  await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFile("git", ["config", "user.name", "Remote Vibes Test"], { cwd: repoDir });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await execFile("git", ["add", "."], { cwd: repoDir });
  await execFile("git", ["commit", "-m", "Initial"], { cwd: repoDir });

  return { tempRoot, repoDir };
}

test("install.sh clones and updates a checkout in one command", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-install-"));
  const installDir = path.join(installRoot, "remote-vibes");

  try {
    const firstRun = await execFile("bash", [installScript], {
      env: {
        ...process.env,
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_SKIP_RUN: "1",
      },
    });

    assert.match(firstRun.stdout, /Skipping launch/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
    assert.equal(await readFile(path.join(installDir, "VERSION"), "utf8"), "v1\n");

    await writeFile(path.join(repoDir, "VERSION"), "v2\n");
    await execFile("git", ["add", "VERSION"], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "Update"], { cwd: repoDir });

    const secondRun = await execFile("bash", [installScript], {
      env: {
        ...process.env,
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_SKIP_RUN: "1",
      },
    });

    assert.match(secondRun.stdout, /Updating existing checkout/);
    assert.equal(await readFile(path.join(installDir, "VERSION"), "utf8"), "v2\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});
