import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { getGitHubHttpsRemoteUrl, UpdateManager } from "../src/update-manager.js";

const execFile = promisify(execFileCallback);

async function git(cwd, args) {
  return execFile("git", ["-C", cwd, ...args]);
}

async function createRepoPair() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-update-"));
  const sourceDir = path.join(tempRoot, "source");
  const checkoutDir = path.join(tempRoot, "checkout");

  await execFile("git", ["init", "-b", "main", sourceDir]);
  await git(sourceDir, ["config", "user.name", "Remote Vibes Test"]);
  await git(sourceDir, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(sourceDir, "VERSION"), "v1\n", "utf8");
  await git(sourceDir, ["add", "."]);
  await git(sourceDir, ["commit", "-m", "Initial"]);
  await execFile("git", ["clone", sourceDir, checkoutDir]);

  return { checkoutDir, sourceDir, tempRoot };
}

async function commitSourceVersion(sourceDir, version) {
  await writeFile(path.join(sourceDir, "VERSION"), `${version}\n`, "utf8");
  await git(sourceDir, ["add", "VERSION"]);
  await git(sourceDir, ["commit", "-m", `Release ${version}`]);
  const { stdout } = await git(sourceDir, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

test("getGitHubHttpsRemoteUrl converts GitHub SSH remotes to public HTTPS remotes", () => {
  assert.equal(
    getGitHubHttpsRemoteUrl("git@github.com:Clamepending/remote-vibes.git"),
    "https://github.com/Clamepending/remote-vibes.git",
  );
  assert.equal(
    getGitHubHttpsRemoteUrl("ssh://git@github.com/Clamepending/remote-vibes"),
    "https://github.com/Clamepending/remote-vibes.git",
  );
  assert.equal(
    getGitHubHttpsRemoteUrl("https://github.com/Clamepending/remote-vibes"),
    "https://github.com/Clamepending/remote-vibes.git",
  );
});

test("UpdateManager reports current checkouts as current", async () => {
  const { checkoutDir, tempRoot } = await createRepoPair();

  try {
    const manager = new UpdateManager({
      cwd: checkoutDir,
      stateDir: path.join(tempRoot, "state"),
      cacheMs: 0,
    });
    const status = await manager.getStatus({ force: true });

    assert.equal(status.supported, true);
    assert.equal(status.status, "current");
    assert.equal(status.updateAvailable, false);
    assert.equal(status.canUpdate, false);
    assert.equal(status.branch, "main");
    assert.match(status.currentShort, /^[0-9a-f]{7}$/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("UpdateManager reports a clean checkout behind the remote as updateable", async () => {
  const { checkoutDir, sourceDir, tempRoot } = await createRepoPair();
  const latestCommit = await commitSourceVersion(sourceDir, "v2");

  try {
    const manager = new UpdateManager({
      cwd: checkoutDir,
      stateDir: path.join(tempRoot, "state"),
      cacheMs: 0,
    });
    const status = await manager.getStatus({ force: true });

    assert.equal(status.status, "available");
    assert.equal(status.updateAvailable, true);
    assert.equal(status.canUpdate, true);
    assert.equal(status.latestCommit, latestCommit);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("UpdateManager blocks automatic updates when local changes are present", async () => {
  const { checkoutDir, sourceDir, tempRoot } = await createRepoPair();
  await commitSourceVersion(sourceDir, "v2");
  await writeFile(path.join(checkoutDir, "LOCAL.txt"), "work in progress\n", "utf8");

  try {
    const manager = new UpdateManager({
      cwd: checkoutDir,
      stateDir: path.join(tempRoot, "state"),
      cacheMs: 0,
    });
    const status = await manager.getStatus({ force: true });

    assert.equal(status.status, "blocked");
    assert.equal(status.updateAvailable, true);
    assert.equal(status.canUpdate, false);
    assert.equal(status.dirty, true);
    assert.match(status.reason, /Local changes/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("UpdateManager schedules a detached pull and restart for clean updates", async () => {
  const { checkoutDir, sourceDir, tempRoot } = await createRepoPair();
  await commitSourceVersion(sourceDir, "v2");
  const spawnCalls = [];

  try {
    const manager = new UpdateManager({
      cwd: checkoutDir,
      stateDir: path.join(tempRoot, "state"),
      cacheMs: 0,
      port: 49123,
      spawn(command, args, options) {
        spawnCalls.push({ command, args, options });
        return {
          unref() {},
        };
      },
    });

    const result = await manager.scheduleUpdateAndRestart();

    assert.equal(result.scheduled, true);
    assert.equal(spawnCalls.length, 1);
    assert.match(spawnCalls[0].args[1], /git pull --ff-only 'origin' 'main'/);
    assert.match(spawnCalls[0].args[1], /http:\/\/127\.0\.0\.1:49123\/api\/terminate/);
    assert.equal(spawnCalls[0].options.detached, true);
    assert.equal(spawnCalls[0].options.env.REMOTE_VIBES_STATE_DIR, path.join(tempRoot, "state"));
    assert.equal(await readFile(result.logPath, "utf8"), "");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
