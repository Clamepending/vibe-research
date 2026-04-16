import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

test("install.sh defaults to an app checkout under the home Remote Vibes directory", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const homeDir = path.join(tempRoot, "home");
  const installDir = path.join(homeDir, ".remote-vibes", "app");

  try {
    const result = await execFile("bash", [installScript], {
      env: {
        ...process.env,
        HOME: homeDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_SKIP_RUN: "1",
      },
    });

    assert.match(result.stdout, new RegExp(`Cloning into ${escapeRegExp(installDir)}`));
    assert.match(result.stdout, /Skipping launch/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("start.sh refuses to reuse a different workspace already running on the requested port", async () => {
  const { tempRoot, repoDir } = await createWorkingTreeRepoSnapshot();
  const port = await getFreePort();
  const foreignWorkspace = path.join(os.tmpdir(), "remote-vibes-foreign-workspace");
  const foreignServer = http.createServer((request, response) => {
    if (request.url === "/api/state") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ appName: "Remote Vibes", cwd: foreignWorkspace }));
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });

  await new Promise((resolve) => foreignServer.listen(port, "127.0.0.1", resolve));

  try {
    await assert.rejects(
      () =>
        execFile("bash", [path.join(repoDir, "start.sh")], {
          env: {
            ...process.env,
            REMOTE_VIBES_PORT: String(port),
            REMOTE_VIBES_READY_TIMEOUT_SECONDS: "1",
            REMOTE_VIBES_STATE_DIR: path.join(tempRoot, "state"),
            REMOTE_VIBES_WIKI_DIR: path.join(tempRoot, "mac-brain"),
          },
        }),
      (error) => {
        const combinedOutput = `${error.stdout || ""}${error.stderr || ""}`;
        assert.match(
          combinedOutput,
          new RegExp(
            `Port ${port} is already serving Remote Vibes from ${escapeRegExp(foreignWorkspace)}`,
          ),
        );
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => foreignServer.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("start.sh relaunches the same workspace when the running state dir differs", async () => {
  const { tempRoot, repoDir } = await createWorkingTreeRepoSnapshot();
  const canonicalRepoDir = await realpath(repoDir);
  const port = await getFreePort();
  const oldStateDir = path.join(tempRoot, "old-state");
  const newStateDir = path.join(tempRoot, "new-state");
  let terminateRequested = false;
  const runningServer = http.createServer((request, response) => {
    if (request.url === "/api/state") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ appName: "Remote Vibes", cwd: canonicalRepoDir, stateDir: oldStateDir }));
      return;
    }

    if (request.url === "/api/terminate" && request.method === "POST") {
      terminateRequested = true;
      response.setHeader("Content-Type", "application/json");
      response.end("{}");
      setImmediate(() => {
        runningServer.close();
      });
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });

  await new Promise((resolve) => runningServer.listen(port, "127.0.0.1", resolve));

  try {
    const result = await execFile("bash", [path.join(repoDir, "start.sh")], {
      env: {
        ...process.env,
        REMOTE_VIBES_PORT: String(port),
        REMOTE_VIBES_READY_TIMEOUT_SECONDS: "30",
        REMOTE_VIBES_STATE_DIR: newStateDir,
        REMOTE_VIBES_WIKI_DIR: path.join(tempRoot, "mac-brain"),
      },
      timeout: 60_000,
    });
    const combinedOutput = `${result.stdout}${result.stderr}`;

    assert.equal(terminateRequested, true);
    assert.match(combinedOutput, new RegExp(`relaunching with ${escapeRegExp(newStateDir)}`));

    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.appName, "Remote Vibes");
    assert.equal(payload.cwd, canonicalRepoDir);
    assert.equal(payload.stateDir, newStateDir);
  } finally {
    try {
      await fetch(`http://127.0.0.1:${port}/api/terminate`, {
        method: "POST",
      });
      await waitForShutdown(`http://127.0.0.1:${port}/api/state`);
    } catch {
      // Server may have already exited.
    }

    try {
      await new Promise((resolve) => runningServer.close(() => resolve()));
    } catch {
      // Fake server may already be closed.
    }

    await rm(tempRoot, { recursive: true, force: true });
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
        REMOTE_VIBES_STATE_DIR: path.join(installRoot, "state"),
        REMOTE_VIBES_WIKI_DIR: path.join(installRoot, "mac-brain"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const capture = (chunk) => {
      combinedOutput += String(chunk);
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const [exitCode] = await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Timed out waiting for launcher exit.\n${combinedOutput}`));
        }, 40_000);
      }),
    ]);
    assert.equal(exitCode, 0);
    assert.match(combinedOutput, /Background server pid:/);
    assert.match(combinedOutput, /will keep running after this terminal closes/);
    assert.match(combinedOutput, new RegExp(`State directory: ${escapeRegExp(path.join(installRoot, "state"))}`));
    assert.match(combinedOutput, new RegExp(`Wiki directory: ${escapeRegExp(path.join(installRoot, "mac-brain"))}`));
    assert.ok(await stat(path.join(installRoot, "state", ".git")));
    assert.ok(await stat(path.join(installRoot, "mac-brain", ".git")));

    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.appName, "Remote Vibes");
    assert.equal(payload.stateDir, path.join(installRoot, "state"));

    const pidMatch = combinedOutput.match(/Background server pid: (\d+)/);
    assert.ok(pidMatch);
    process.kill(Number(pidMatch[1]), "SIGHUP");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const afterHangupResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(afterHangupResponse.status, 200);
    const afterHangupPayload = await afterHangupResponse.json();
    assert.equal(afterHangupPayload.appName, "Remote Vibes");
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

test("start.sh migrates an old home checkout into app and uses home root for settings", async () => {
  const { tempRoot, repoDir } = await createWorkingTreeRepoSnapshot();
  const homeDir = path.join(tempRoot, "home");
  const homeRemoteVibesDir = path.join(homeDir, ".remote-vibes");
  const port = await getFreePort();

  try {
    await mkdir(path.join(homeRemoteVibesDir, "src"), { recursive: true });
    await writeFile(path.join(homeRemoteVibesDir, "package.json"), "{}\n");
    await writeFile(path.join(homeRemoteVibesDir, "start.sh"), "#!/usr/bin/env bash\n");
    await writeFile(path.join(homeRemoteVibesDir, "src", "server.js"), "console.log('old checkout');\n");

    await mkdir(path.join(homeRemoteVibesDir, "state"), { recursive: true });
    await writeFile(path.join(homeRemoteVibesDir, "state", "agent-prompt.md"), "remember root state\n");
    await mkdir(path.join(homeRemoteVibesDir, ".remote-vibes"), { recursive: true });
    await writeFile(path.join(homeRemoteVibesDir, ".remote-vibes", "sessions.json"), "{\"sessions\":[]}\n");
    await mkdir(path.join(repoDir, ".remote-vibes"), { recursive: true });
    await writeFile(path.join(repoDir, ".remote-vibes", "port-aliases.json"), "{\"aliases\":{}}\n");

    const result = await execFile("bash", [path.join(repoDir, "start.sh")], {
      env: {
        ...process.env,
        HOME: homeDir,
        REMOTE_VIBES_PORT: String(port),
        REMOTE_VIBES_READY_TIMEOUT_SECONDS: "30",
      },
      timeout: 60_000,
    });
    const combinedOutput = `${result.stdout}${result.stderr}`;

    assert.match(combinedOutput, /Moving old Remote Vibes checkout/);
    assert.match(
      combinedOutput,
      new RegExp(`State directory: ${escapeRegExp(homeRemoteVibesDir)}`),
    );
    assert.ok(await stat(path.join(homeRemoteVibesDir, "app", "package.json")));
    assert.ok(await stat(path.join(homeRemoteVibesDir, "app", "src", "server.js")));
    assert.ok(await stat(path.join(homeRemoteVibesDir, ".git")));
    const migratedPrompt = await readFile(path.join(homeRemoteVibesDir, "agent-prompt.md"), "utf8");
    assert.match(migratedPrompt, /^remember root state\n/);
    assert.match(migratedPrompt, /remote-vibes:wiki-v2-protocol:v2/);
    const sessionsPayload = JSON.parse(await readFile(path.join(homeRemoteVibesDir, "sessions.json"), "utf8"));
    assert.deepEqual(sessionsPayload.sessions, []);
    assert.equal(
      await readFile(path.join(homeRemoteVibesDir, "port-aliases.json"), "utf8"),
      "{\"aliases\":{}}\n",
    );
    assert.match(await readFile(path.join(homeRemoteVibesDir, ".gitignore"), "utf8"), /^app\/$/m);
    assert.match(await readFile(path.join(homeRemoteVibesDir, ".gitignore"), "utf8"), /^state\/$/m);

    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.appName, "Remote Vibes");
    assert.equal(payload.stateDir, homeRemoteVibesDir);
  } finally {
    try {
      await fetch(`http://127.0.0.1:${port}/api/terminate`, {
        method: "POST",
      });
      await waitForShutdown(`http://127.0.0.1:${port}/api/state`);
    } catch {
      // Server may have already exited.
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});
