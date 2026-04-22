import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const installScript = path.join(rootDir, "install.sh");

async function createSourceRepo() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-source-"));
  const repoDir = path.join(tempRoot, "repo");
  await mkdir(repoDir, { recursive: true });

  await writeFile(
    path.join(repoDir, "start.sh"),
    "#!/usr/bin/env bash\nset -euo pipefail\necho SOURCE_VERSION=$(cat VERSION)\necho FORCE_RESTART=${VIBE_RESEARCH_FORCE_RESTART:-${REMOTE_VIBES_FORCE_RESTART:-}}\n",
  );
  await writeFile(path.join(repoDir, "VERSION"), "v1\n");

  await execFile("chmod", ["+x", path.join(repoDir, "start.sh")]);
  await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFile("git", ["config", "user.name", "Vibe Research Test"], { cwd: repoDir });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await execFile("git", ["add", "."], { cwd: repoDir });
  await execFile("git", ["commit", "-m", "Initial"], { cwd: repoDir });

  return { tempRoot, repoDir };
}

function installTestEnv(overrides = {}) {
  return {
    ...process.env,
    VIBE_RESEARCH_INSTALL_SYSTEM_DEPS: "0",
    VIBE_RESEARCH_INSTALL_TAILSCALE: "0",
    VIBE_RESEARCH_INSTALL_CLAUDE_CODE: "0",
    VIBE_RESEARCH_INSTALL_SERVICE: "0",
    ...overrides,
  };
}

test("install.sh can render the polished terminal installer UI when requested", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-install-ui-"));
  const installDir = path.join(installRoot, "vibe-research");

  try {
    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        NO_COLOR: "1",
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_INSTALL_ANIMATION: "0",
        VIBE_RESEARCH_INSTALL_UI: "fancy",
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_SKIP_RUN: "1",
      }),
    });

    assert.match(result.stdout, /Vibe Research/);
    assert.match(result.stdout, /Installer for local agent workspaces/);
    assert.match(result.stdout, /\[1\/10\] Terminal locale/);
    assert.match(result.stdout, /\[7\/10\] App checkout/);
    assert.match(result.stdout, /\[done\] App checkout/);
    assert.match(result.stdout, /\[8\/10\] Terminal launcher/);
    assert.match(result.stdout, /\[10\/10\] Service setup/);
    assert.match(result.stdout, /Install complete/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});
