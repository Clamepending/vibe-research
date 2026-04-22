import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { getGitHubHttpsRemoteUrl, UpdateManager } from "../src/update-manager.js";

const execFile = promisify(execFileCallback);
const releaseChannelUrl = "https://raw.githubusercontent.com/Clamepending/vibe-research/main/release-channel.json";
const MANAGED_PROMPT_MARKER = "<!-- vibe-research:managed-agent-prompt -->";
const LEGACY_MANAGED_PROMPT_MARKER = "<!-- remote-vibes:managed-agent-prompt -->";

async function git(cwd, args) {
  return execFile("git", ["-C", cwd, ...args]);
}

async function createRepoPair() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-update-"));
  const sourceDir = path.join(tempRoot, "source");
  const checkoutDir = path.join(tempRoot, "checkout");

  await execFile("git", ["init", "-b", "main", sourceDir]);
  await git(sourceDir, ["config", "user.name", "Vibe Research Test"]);
  await git(sourceDir, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(sourceDir, "VERSION"), "v1\n", "utf8");
  await writeFile(path.join(sourceDir, "AGENTS.md"), `${MANAGED_PROMPT_MARKER}\nInitial prompt\n`, "utf8");
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
    getGitHubHttpsRemoteUrl("git@github.com:Clamepending/vibe-research.git"),
    "https://github.com/Clamepending/vibe-research.git",
  );
  assert.equal(
    getGitHubHttpsRemoteUrl("ssh://git@github.com/Clamepending/vibe-research"),
    "https://github.com/Clamepending/vibe-research.git",
  );
  assert.equal(
    getGitHubHttpsRemoteUrl("https://github.com/Clamepending/vibe-research"),
    "https://github.com/Clamepending/vibe-research.git",
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

test("UpdateManager reports non-git workspaces as unsupported without raw git errors", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-not-git-"));

  try {
    const manager = new UpdateManager({
      cwd: tempRoot,
      stateDir: path.join(tempRoot, "state"),
      cacheMs: 0,
    });
    const status = await manager.getStatus({ force: true });

    assert.equal(status.supported, false);
    assert.equal(status.status, "unsupported");
    assert.equal(status.updateAvailable, false);
    assert.equal(status.canUpdate, false);
    assert.equal(status.cwd, tempRoot);
    assert.match(status.reason, /not running from a git checkout/);
    assert.doesNotMatch(status.reason, /Command failed|rev-parse|fatal:/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("UpdateManager rejects apply from non-git workspaces with a friendly error", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-not-git-"));

  try {
    const manager = new UpdateManager({
      cwd: tempRoot,
      stateDir: path.join(tempRoot, "state"),
      cacheMs: 0,
    });

    await assert.rejects(
      () => manager.scheduleUpdateAndRestart(),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /not running from a git checkout/);
        assert.doesNotMatch(error.message, /Command failed|rev-parse|fatal:/);
        assert.equal(error.update?.status, "unsupported");
        return true;
      },
    );
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

test("UpdateManager allows updates when local app checkout changes are present", async () => {
  const { checkoutDir, sourceDir, tempRoot } = await createRepoPair();
  await commitSourceVersion(sourceDir, "v2");
  await writeFile(path.join(checkoutDir, "VERSION"), "local edit\n", "utf8");

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
    assert.equal(status.dirty, true);
    assert.equal(status.blockingDirty, false);
    assert.deepEqual(status.dirtyFiles, ["VERSION"]);
    assert.equal(status.reason, "");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("UpdateManager restores managed prompt file churn before updating", async () => {
  const { checkoutDir, sourceDir, tempRoot } = await createRepoPair();
  await commitSourceVersion(sourceDir, "v2");
  await writeFile(path.join(checkoutDir, "AGENTS.md"), `${MANAGED_PROMPT_MARKER}\nRuntime prompt\n`, "utf8");

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
    assert.equal(status.dirty, false);
    assert.equal(status.blockingDirty, false);
    assert.deepEqual(status.dirtyFiles, []);
    assert.deepEqual(status.ignoredDirtyFiles, []);
    assert.deepEqual(status.restoredManagedPromptFiles, ["AGENTS.md"]);
    assert.equal(await readFile(path.join(checkoutDir, "AGENTS.md"), "utf8"), `${MANAGED_PROMPT_MARKER}\nInitial prompt\n`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("UpdateManager treats Remote Vibes managed prompt churn as generated during migration", async () => {
  const { checkoutDir, sourceDir, tempRoot } = await createRepoPair();
  await commitSourceVersion(sourceDir, "v2");
  await writeFile(path.join(checkoutDir, "AGENTS.md"), `${LEGACY_MANAGED_PROMPT_MARKER}\nRuntime prompt\n`, "utf8");

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
    assert.equal(status.dirty, false);
    assert.deepEqual(status.restoredManagedPromptFiles, ["AGENTS.md"]);
    assert.equal(await readFile(path.join(checkoutDir, "AGENTS.md"), "utf8"), `${MANAGED_PROMPT_MARKER}\nInitial prompt\n`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("UpdateManager does not block updates for generated smoke artifacts", async () => {
  const { checkoutDir, sourceDir, tempRoot } = await createRepoPair();
  await commitSourceVersion(sourceDir, "v2");
  await mkdir(path.join(checkoutDir, ".playwright-cli"), { recursive: true });
  await writeFile(path.join(checkoutDir, ".playwright-cli", "snapshot.yml"), "generated\n", "utf8");
  await mkdir(path.join(checkoutDir, "output", "playwright"), { recursive: true });
  await writeFile(path.join(checkoutDir, "output", "playwright", "hover.png"), "generated\n", "utf8");

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
    assert.equal(status.dirty, true);
    assert.equal(status.blockingDirty, false);
    assert.deepEqual(status.dirtyFiles, []);
    assert.deepEqual(status.ignoredDirtyFiles, [".playwright-cli/", "output/"]);
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
    assert.match(spawnCalls[0].args[1], /git reset --hard HEAD/);
    assert.match(spawnCalls[0].args[1], /git clean -fd/);
    assert.match(spawnCalls[0].args[1], /git pull --ff-only 'origin' 'main'/);
    assert.match(spawnCalls[0].args[1], /http:\/\/127\.0\.0\.1:49123\/api\/terminate/);
    assert.equal(spawnCalls[0].options.detached, true);
    assert.equal(spawnCalls[0].options.env.VIBE_RESEARCH_STATE_DIR, path.join(tempRoot, "state"));
    assert.equal(await readFile(result.logPath, "utf8"), "");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("UpdateManager prefers the static release channel when available", async () => {
  const { checkoutDir, sourceDir, tempRoot } = await createRepoPair();
  const latestCommit = await commitSourceVersion(sourceDir, "v2");
  await git(checkoutDir, ["remote", "set-url", "origin", "git@github.com:Clamepending/vibe-research.git"]);

  try {
    const manager = new UpdateManager({
      cwd: checkoutDir,
      stateDir: path.join(tempRoot, "state"),
      cacheMs: 0,
      fetch: async (url) => {
        assert.equal(url, releaseChannelUrl);
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              name: "Vibe Research",
              version: "2.0.0",
              tag: "v2.0.0",
              releaseUrl: "https://github.com/Clamepending/vibe-research/releases/tag/v2.0.0",
            };
          },
        };
      },
      execFile(command, args, options) {
        if (
          command === "git" &&
          args[2] === "ls-remote" &&
          args[3] === "https://github.com/Clamepending/vibe-research.git" &&
          args[4] === "refs/tags/v2.0.0"
        ) {
          return Promise.resolve({
            stdout: `${latestCommit}\trefs/tags/v2.0.0\n`,
            stderr: "",
          });
        }

        return execFile(command, args, options);
      },
    });

    const status = await manager.getStatus({ force: true });

    assert.equal(status.status, "available");
    assert.equal(status.targetType, "release");
    assert.equal(status.latestVersion, "v2.0.0");
    assert.equal(status.latestTag, "v2.0.0");
    assert.equal(status.latestCommit, latestCommit);
    assert.equal(status.releaseCheck, "channel");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("UpdateManager prefers GitHub Releases and schedules a tag checkout", async () => {
  const { checkoutDir, sourceDir, tempRoot } = await createRepoPair();
  const latestCommit = await commitSourceVersion(sourceDir, "v2");
  await git(checkoutDir, ["remote", "set-url", "origin", "git@github.com:Clamepending/vibe-research.git"]);
  const spawnCalls = [];

  try {
    const manager = new UpdateManager({
      cwd: checkoutDir,
      stateDir: path.join(tempRoot, "state"),
      cacheMs: 0,
      port: 49124,
      fetch: async (url) => {
        if (url === releaseChannelUrl) {
          return {
            ok: false,
            status: 404,
          };
        }

        assert.equal(url, "https://api.github.com/repos/Clamepending/vibe-research/releases/latest");
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              tag_name: "v2.0.0",
              name: "Vibe Research v2.0.0",
              html_url: "https://github.com/Clamepending/vibe-research/releases/tag/v2.0.0",
              published_at: "2026-04-16T08:00:00Z",
            };
          },
        };
      },
      execFile(command, args, options) {
        if (
          command === "git" &&
          args[2] === "ls-remote" &&
          args[3] === "https://github.com/Clamepending/vibe-research.git" &&
          args[4] === "refs/tags/v2.0.0"
        ) {
          return Promise.resolve({
            stdout: `${latestCommit}\trefs/tags/v2.0.0\n`,
            stderr: "",
          });
        }

        return execFile(command, args, options);
      },
      spawn(command, args, options) {
        spawnCalls.push({ command, args, options });
        return {
          unref() {},
        };
      },
    });

    const status = await manager.getStatus({ force: true });
    assert.equal(status.status, "available");
    assert.equal(status.targetType, "release");
    assert.equal(status.latestVersion, "v2.0.0");
    assert.equal(status.latestTag, "v2.0.0");
    assert.equal(status.latestCommit, latestCommit);
    assert.equal(status.releaseUrl, "https://github.com/Clamepending/vibe-research/releases/tag/v2.0.0");

    const result = await manager.scheduleUpdateAndRestart();
    assert.equal(result.scheduled, true);
    assert.equal(spawnCalls.length, 1);
    assert.match(
      spawnCalls[0].args[1],
      /git fetch --force --depth 1 'https:\/\/github\.com\/Clamepending\/vibe-research\.git' 'refs\/tags\/v2\.0\.0:refs\/tags\/v2\.0\.0'/,
    );
    assert.match(spawnCalls[0].args[1], /git checkout --detach 'refs\/tags\/v2\.0\.0'/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("UpdateManager falls back to remote version tags for detached release checkouts", async () => {
  const { checkoutDir, sourceDir, tempRoot } = await createRepoPair();
  const { stdout: currentCommitStdout } = await git(checkoutDir, ["rev-parse", "HEAD"]);
  const currentCommit = currentCommitStdout.trim();
  const latestCommit = await commitSourceVersion(sourceDir, "v2");
  await git(checkoutDir, ["checkout", "--detach"]);
  await git(checkoutDir, ["remote", "set-url", "origin", "git@github.com:Clamepending/vibe-research.git"]);
  const spawnCalls = [];

  try {
    const manager = new UpdateManager({
      cwd: checkoutDir,
      stateDir: path.join(tempRoot, "state"),
      cacheMs: 0,
      port: 49125,
      fetch: async (url) => ({
        ok: false,
        status: url === releaseChannelUrl ? 404 : 403,
      }),
      execFile(command, args, options) {
        if (
          command === "git" &&
          args[2] === "ls-remote" &&
          args[3] === "--tags" &&
          args[4] === "https://github.com/Clamepending/vibe-research.git" &&
          args[5] === "refs/tags/v*"
        ) {
          return Promise.resolve({
            stdout: [
              "1111111111111111111111111111111111111111\trefs/tags/v1.0.0",
              `${currentCommit}\trefs/tags/v1.0.0^{}`,
              "2222222222222222222222222222222222222222\trefs/tags/v2.0.0",
              `${latestCommit}\trefs/tags/v2.0.0^{}`,
            ].join("\n"),
            stderr: "",
          });
        }

        return execFile(command, args, options);
      },
      spawn(command, args, options) {
        spawnCalls.push({ command, args, options });
        return {
          unref() {},
        };
      },
    });

    const status = await manager.getStatus({ force: true });

    assert.equal(status.status, "available");
    assert.equal(status.currentBranch, "");
    assert.equal(status.canUpdate, true);
    assert.equal(status.targetType, "release");
    assert.equal(status.latestVersion, "v2.0.0");
    assert.equal(status.latestCommit, latestCommit);
    assert.equal(status.releaseCheck, "git-tags fallback after channel none; GitHub release lookup failed with HTTP 403.");

    await manager.scheduleUpdateAndRestart();

    assert.equal(spawnCalls.length, 1);
    assert.match(
      spawnCalls[0].args[1],
      /git fetch --force --depth 1 'https:\/\/github\.com\/Clamepending\/vibe-research\.git' 'refs\/tags\/v2\.0\.0:refs\/tags\/v2\.0\.0'/,
    );
    assert.match(spawnCalls[0].args[1], /git checkout --detach 'refs\/tags\/v2\.0\.0'/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("UpdateManager does not offer to downgrade branch checkouts ahead of the latest release", async () => {
  const { checkoutDir, sourceDir, tempRoot } = await createRepoPair();
  const releaseCommit = await commitSourceVersion(sourceDir, "v2");
  await commitSourceVersion(sourceDir, "v3");
  await git(checkoutDir, ["pull", "--ff-only"]);
  await git(checkoutDir, ["remote", "set-url", "origin", "git@github.com:Clamepending/vibe-research.git"]);

  try {
    const manager = new UpdateManager({
      cwd: checkoutDir,
      stateDir: path.join(tempRoot, "state"),
      cacheMs: 0,
      fetch: async (url) => {
        if (url === releaseChannelUrl) {
          return {
            ok: false,
            status: 404,
          };
        }

        return {
          ok: true,
          status: 200,
          async json() {
            return {
              tag_name: "v2.0.0",
              name: "Vibe Research v2.0.0",
              html_url: "https://github.com/Clamepending/vibe-research/releases/tag/v2.0.0",
              published_at: "2026-04-16T08:00:00Z",
            };
          },
        };
      },
      execFile(command, args, options) {
        if (
          command === "git" &&
          args[2] === "ls-remote" &&
          args[3] === "https://github.com/Clamepending/vibe-research.git" &&
          args[4] === "refs/tags/v2.0.0"
        ) {
          return Promise.resolve({
            stdout: `${releaseCommit}\trefs/tags/v2.0.0\n`,
            stderr: "",
          });
        }

        return execFile(command, args, options);
      },
    });

    const status = await manager.getStatus({ force: true });

    assert.equal(status.status, "current");
    assert.equal(status.updateAvailable, false);
    assert.equal(status.canUpdate, false);
    assert.equal(status.targetType, "release");
    assert.equal(status.latestVersion, "v2.0.0");
    assert.equal(status.aheadOfTarget, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
