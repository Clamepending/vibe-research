import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import http from "node:http";

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

async function createWorkingTreeRepoSnapshot() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-working-tree-"));
  const repoDir = path.join(tempRoot, "repo");

  await cp(rootDir, repoDir, {
    recursive: true,
    filter(source) {
      const relativePath = path.relative(rootDir, source);
      if (!relativePath) {
        return true;
      }

      const topLevelName = relativePath.split(path.sep)[0];
      return topLevelName !== ".git" && topLevelName !== "node_modules" && topLevelName !== ".remote-vibes";
    },
  });

  await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFile("git", ["config", "user.name", "Remote Vibes Test"], { cwd: repoDir });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await execFile("git", ["add", "."], { cwd: repoDir });
  await execFile("git", ["commit", "-m", "Snapshot"], { cwd: repoDir });

  return { tempRoot, repoDir };
}

async function getFreePort() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForShutdown(url) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await fetch(url);
    } catch {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ${url} to shut down.`);
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

test("install.sh can launch remote vibes in one command", async () => {
  const { tempRoot, repoDir } = await createWorkingTreeRepoSnapshot();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-launch-"));
  const installDir = path.join(installRoot, "remote-vibes");
  const port = await getFreePort();
  const repoUrl = repoDir;
  let child;
  let combinedOutput = "";

  try {
    child = spawn("bash", [installScript], {
      cwd: rootDir,
      env: {
        ...process.env,
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoUrl,
        REMOTE_VIBES_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const capture = (chunk) => {
      combinedOutput += String(chunk);
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for launcher output.\n${combinedOutput}`));
      }, 20_000);

      const handleOutput = () => {
        if (!combinedOutput.includes("Remote Vibes is live.")) {
          return;
        }

        clearTimeout(timeout);
        child.stdout.off("data", handleOutput);
        child.stderr.off("data", handleOutput);
        resolve();
      };

      child.stdout.on("data", handleOutput);
      child.stderr.on("data", handleOutput);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Launcher exited early with code ${code}.\n${combinedOutput}`));
      });
    });

    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
    assert.match(combinedOutput, /Background server pid:/);

    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.appName, "Remote Vibes");
  } finally {
    try {
      await fetch(`http://127.0.0.1:${port}/api/terminate`, {
        method: "POST",
      });
      await waitForShutdown(`http://127.0.0.1:${port}/api/state`);
    } catch {
      // Server may have already exited.
    }

    if (child && child.exitCode === null) {
      try {
        child.kill("SIGINT");
      } catch {
        // Process already exited.
      }

      await Promise.race([
        once(child, "exit"),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Timed out shutting down launcher.")), 10_000);
        }),
      ]);
    }

    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});
