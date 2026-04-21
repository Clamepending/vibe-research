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

function installTestEnv(overrides = {}) {
  return {
    ...process.env,
    REMOTE_VIBES_INSTALL_SYSTEM_DEPS: "0",
    REMOTE_VIBES_INSTALL_TAILSCALE: "0",
    REMOTE_VIBES_INSTALL_SERVICE: "0",
    ...overrides,
  };
}

test("install.sh clones and updates a checkout in one command", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-install-"));
  const installDir = path.join(installRoot, "remote-vibes");

  try {
    const firstRun = await execFile("bash", [installScript], {
      env: installTestEnv({
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_SKIP_RUN: "1",
      }),
    });

    assert.match(firstRun.stdout, /Skipping launch/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
    assert.equal(await readFile(path.join(installDir, "VERSION"), "utf8"), "v1\n");

    await writeFile(path.join(repoDir, "VERSION"), "v2\n");
    await execFile("git", ["add", "VERSION"], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "Update"], { cwd: repoDir });

    const secondRun = await execFile("bash", [installScript], {
      env: installTestEnv({
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_SKIP_RUN: "1",
      }),
    });

    assert.match(secondRun.stdout, /Updating existing checkout/);
    assert.equal(await readFile(path.join(installDir, "VERSION"), "utf8"), "v2\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh restores generated package-lock churn before updating a checkout", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-lockfile-update-"));
  const installDir = path.join(installRoot, "remote-vibes");

  try {
    await writeFile(path.join(repoDir, "package-lock.json"), '{"lockfileVersion":3}\n');
    await execFile("git", ["add", "package-lock.json"], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "Add lockfile"], { cwd: repoDir });

    await execFile("bash", [installScript], {
      env: installTestEnv({
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_SKIP_RUN: "1",
      }),
    });

    await writeFile(path.join(installDir, "package-lock.json"), '{"lockfileVersion":3,"packages":{"node_modules/xterm":{"peer":true}}}\n');
    await writeFile(path.join(repoDir, "VERSION"), "v2\n");
    await execFile("git", ["add", "VERSION"], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "Update"], { cwd: repoDir });

    const secondRun = await execFile("bash", [installScript], {
      env: installTestEnv({
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_SKIP_RUN: "1",
      }),
    });

    assert.match(secondRun.stdout, /Restoring generated package-lock change before update/);
    assert.match(secondRun.stdout, /Updating existing checkout/);
    assert.equal(await readFile(path.join(installDir, "VERSION"), "utf8"), "v2\n");
    assert.equal(await readFile(path.join(installDir, "package-lock.json"), "utf8"), '{"lockfileVersion":3}\n');
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
      env: installTestEnv({
        HOME: homeDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_SKIP_RUN: "1",
      }),
    });

    assert.match(result.stdout, new RegExp(`Cloning into ${escapeRegExp(installDir)}`));
    assert.match(result.stdout, /Skipping launch/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("install.sh installs Node.js on fresh macOS hosts before cloning", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-macos-node-install-"));
  const installDir = path.join(installRoot, "remote-vibes");
  const fakeBin = path.join(installRoot, "bin");
  const nodeInstalledState = path.join(installRoot, "node-installed");
  const nodePkg = "node-v22.99.0.pkg";

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Darwin\\n'\n");
    await writeFile(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env sh
if [ ! -f ${JSON.stringify(nodeInstalledState)} ]; then
  exit 127
fi
if [ "\${1:-}" = "-p" ]; then
  printf '22\\n'
else
  printf 'v22.99.0\\n'
fi
`,
    );
    await writeFile(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env sh
if [ ! -f ${JSON.stringify(nodeInstalledState)} ]; then
  exit 127
fi
printf '10.9.9\\n'
`,
    );
    await writeFile(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
url=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
case "$url" in
  *SHASUMS256.txt)
    printf 'abc  ${nodePkg}\\n'
    ;;
  *${nodePkg})
    printf 'node package' > "$output"
    ;;
  *)
    printf 'unexpected curl URL: %s\\n' "$url" >&2
    exit 1
    ;;
esac
`,
    );
    await writeFile(
      path.join(fakeBin, "installer"),
      `#!/usr/bin/env sh
: > ${JSON.stringify(nodeInstalledState)}
exit 0
`,
    );
    await writeFile(path.join(fakeBin, "sudo"), "#!/usr/bin/env sh\nexec \"$@\"\n");
    await execFile("chmod", ["+x", ...["uname", "node", "npm", "curl", "installer", "sudo"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_SKIP_RUN: "1",
      }),
    });

    assert.match(result.stdout, /Installing Node\.js 22\.x for macOS/);
    assert.match(result.stdout, /Using Node v22\.99\.0 and npm 10\.9\.9/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh starts Tailscale onboarding when Tailscale is installed but logged out", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-tailscale-install-"));
  const installDir = path.join(installRoot, "remote-vibes");
  const fakeBin = path.join(installRoot, "bin");
  const tailscaleLog = path.join(installRoot, "tailscale.log");
  const tailscaleState = path.join(installRoot, "tailscale-connected");

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      path.join(fakeBin, "tailscale"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(tailscaleLog)}
if [ "\${1:-}" = "ip" ]; then
  if [ -f ${JSON.stringify(tailscaleState)} ]; then
    printf '100.64.0.5\\n'
    exit 0
  fi
  exit 1
fi
if [ "\${1:-}" = "up" ]; then
  : > ${JSON.stringify(tailscaleState)}
  exit 0
fi
exit 0
`,
    );
    await execFile("chmod", ["+x", path.join(fakeBin, "tailscale")]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_INSTALL_TAILSCALE: "1",
        REMOTE_VIBES_TAILSCALE_USE_SUDO: "0",
        REMOTE_VIBES_SKIP_RUN: "1",
      }),
    });

    assert.match(result.stdout, /Starting Tailscale/);
    assert.match(result.stdout, /Tailscale connected at 100\.64\.0\.5/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
    assert.deepEqual((await readFile(tailscaleLog, "utf8")).trim().split("\n"), [
      "ip -4",
      "up",
      "ip -4",
      "ip -4",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh starts tailscaled before Tailscale login on Linux", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-tailscaled-install-"));
  const installDir = path.join(installRoot, "remote-vibes");
  const fakeBin = path.join(installRoot, "bin");
  const tailscaleLog = path.join(installRoot, "tailscale.log");
  const systemctlLog = path.join(installRoot, "systemctl.log");
  const tailscaleDaemonState = path.join(installRoot, "tailscaled-running");
  const tailscaleConnectedState = path.join(installRoot, "tailscale-connected");

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Linux\\n'\n");
    await writeFile(path.join(fakeBin, "sudo"), "#!/usr/bin/env sh\nexec \"$@\"\n");
    await writeFile(
      path.join(fakeBin, "systemctl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}
if [ "\${1:-}" = "is-active" ]; then
  if [ -f ${JSON.stringify(tailscaleDaemonState)} ]; then
    exit 0
  fi
  exit 3
fi
if [ "\${1:-}" = "enable" ] && [ "\${2:-}" = "--now" ] && [ "\${3:-}" = "tailscaled" ]; then
  : > ${JSON.stringify(tailscaleDaemonState)}
  exit 0
fi
if [ "\${1:-}" = "start" ] && [ "\${2:-}" = "tailscaled" ]; then
  : > ${JSON.stringify(tailscaleDaemonState)}
  exit 0
fi
exit 0
`,
    );
    await writeFile(
      path.join(fakeBin, "tailscale"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(tailscaleLog)}
if [ "\${1:-}" = "ip" ]; then
  if [ -f ${JSON.stringify(tailscaleDaemonState)} ] && [ -f ${JSON.stringify(tailscaleConnectedState)} ]; then
    printf '100.64.0.9\\n'
    exit 0
  fi
  exit 1
fi
if [ "\${1:-}" = "up" ]; then
  if [ ! -f ${JSON.stringify(tailscaleDaemonState)} ]; then
    printf "failed to connect to local tailscaled; it doesn't appear to be running\\n" >&2
    exit 1
  fi
  : > ${JSON.stringify(tailscaleConnectedState)}
  exit 0
fi
exit 0
`,
    );
    await execFile("chmod", ["+x", ...["uname", "sudo", "systemctl", "tailscale"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_INSTALL_TAILSCALE: "1",
        REMOTE_VIBES_SKIP_RUN: "1",
      }),
    });

    assert.match(result.stdout, /Starting tailscaled service/);
    assert.match(result.stdout, /Starting Tailscale/);
    assert.match(result.stdout, /Tailscale connected at 100\.64\.0\.9/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
    assert.deepEqual((await readFile(systemctlLog, "utf8")).trim().split("\n"), [
      "is-active --quiet tailscaled",
      "enable --now tailscaled",
    ]);
    assert.deepEqual((await readFile(tailscaleLog, "utf8")).trim().split("\n"), [
      "status --json",
      "ip -4",
      "up",
      "ip -4",
      "ip -4",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh retries Tailscale login after a tailscaled startup race", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-tailscaled-race-"));
  const installDir = path.join(installRoot, "remote-vibes");
  const fakeBin = path.join(installRoot, "bin");
  const tailscaleLog = path.join(installRoot, "tailscale.log");
  const systemctlLog = path.join(installRoot, "systemctl.log");
  const startAttemptState = path.join(installRoot, "tailscaled-start-attempted");
  const tailscaleDaemonState = path.join(installRoot, "tailscaled-running");
  const tailscaleConnectedState = path.join(installRoot, "tailscale-connected");

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Linux\\n'\n");
    await writeFile(path.join(fakeBin, "sudo"), "#!/usr/bin/env sh\nexec \"$@\"\n");
    await writeFile(
      path.join(fakeBin, "systemctl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}
if [ "\${1:-}" = "is-active" ]; then
  if [ -f ${JSON.stringify(tailscaleDaemonState)} ]; then
    exit 0
  fi
  exit 3
fi
if [ "\${1:-}" = "enable" ] && [ "\${2:-}" = "--now" ] && [ "\${3:-}" = "tailscaled" ]; then
  if [ -f ${JSON.stringify(startAttemptState)} ]; then
    : > ${JSON.stringify(tailscaleDaemonState)}
  else
    : > ${JSON.stringify(startAttemptState)}
  fi
  exit 0
fi
exit 0
`,
    );
    await writeFile(
      path.join(fakeBin, "tailscale"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(tailscaleLog)}
if [ "\${1:-}" = "status" ]; then
  if [ -f ${JSON.stringify(tailscaleDaemonState)} ]; then
    printf '{}\\n'
    exit 0
  fi
  printf "failed to connect to local tailscaled; it doesn't appear to be running\\n" >&2
  exit 1
fi
if [ "\${1:-}" = "ip" ]; then
  if [ -f ${JSON.stringify(tailscaleDaemonState)} ] && [ -f ${JSON.stringify(tailscaleConnectedState)} ]; then
    printf '100.64.0.10\\n'
    exit 0
  fi
  exit 1
fi
if [ "\${1:-}" = "up" ]; then
  if [ ! -f ${JSON.stringify(tailscaleDaemonState)} ]; then
    printf "failed to connect to local tailscaled; it doesn't appear to be running\\n" >&2
    exit 1
  fi
  : > ${JSON.stringify(tailscaleConnectedState)}
  exit 0
fi
exit 0
`,
    );
    await execFile("chmod", ["+x", ...["uname", "sudo", "systemctl", "tailscale"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_INSTALL_TAILSCALE: "1",
        REMOTE_VIBES_TAILSCALE_DAEMON_WAIT_SECONDS: "1",
        REMOTE_VIBES_SKIP_RUN: "1",
      }),
    });

    assert.match(result.stdout, /Tailscale login could not reach tailscaled yet/);
    assert.match(result.stdout, /Tailscale connected at 100\.64\.0\.10/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
    assert.deepEqual((await readFile(systemctlLog, "utf8")).trim().split("\n"), [
      "is-active --quiet tailscaled",
      "enable --now tailscaled",
      "start tailscaled",
      "is-active --quiet tailscaled",
      "enable --now tailscaled",
    ]);
    assert.deepEqual((await readFile(tailscaleLog, "utf8")).trim().split("\n"), [
      "status --json",
      "status --json",
      "ip -4",
      "up",
      "status --json",
      "up",
      "ip -4",
      "ip -4",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh falls back to userspace tailscaled when service startup cannot reach the daemon", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-tailscaled-userspace-"));
  const installDir = path.join(installRoot, "remote-vibes");
  const fakeBin = path.join(installRoot, "bin");
  const tailscaleLog = path.join(installRoot, "tailscale.log");
  const tailscaledLog = path.join(installRoot, "tailscaled.log");
  const systemctlLog = path.join(installRoot, "systemctl.log");
  const tailscaleDaemonState = path.join(installRoot, "tailscaled-running");
  const tailscaleConnectedState = path.join(installRoot, "tailscale-connected");

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Linux\\n'\n");
    await writeFile(
      path.join(fakeBin, "sudo"),
      `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  mkdir | rm)
    exit 0
    ;;
esac
exec "$@"
`,
    );
    await writeFile(
      path.join(fakeBin, "systemctl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}
exit 1
`,
    );
    await writeFile(
      path.join(fakeBin, "tailscaled"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(tailscaledLog)}
case " $* " in
  *" --tun=userspace-networking "*)
    : > ${JSON.stringify(tailscaleDaemonState)}
    exit 0
    ;;
esac
exit 1
`,
    );
    await writeFile(
      path.join(fakeBin, "tailscale"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(tailscaleLog)}
if [ "\${1:-}" = "status" ]; then
  if [ -f ${JSON.stringify(tailscaleDaemonState)} ]; then
    printf '{}\\n'
    exit 0
  fi
  printf "failed to connect to local tailscaled; it doesn't appear to be running\\n" >&2
  exit 1
fi
if [ "\${1:-}" = "ip" ]; then
  if [ -f ${JSON.stringify(tailscaleDaemonState)} ] && [ -f ${JSON.stringify(tailscaleConnectedState)} ]; then
    printf '100.64.0.11\\n'
    exit 0
  fi
  exit 1
fi
if [ "\${1:-}" = "up" ]; then
  if [ ! -f ${JSON.stringify(tailscaleDaemonState)} ]; then
    printf "failed to connect to local tailscaled; it doesn't appear to be running\\n" >&2
    exit 1
  fi
  : > ${JSON.stringify(tailscaleConnectedState)}
  exit 0
fi
exit 0
`,
    );
    await execFile("chmod", ["+x", ...["uname", "sudo", "systemctl", "tailscaled", "tailscale"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_INSTALL_TAILSCALE: "1",
        REMOTE_VIBES_TAILSCALE_DAEMON_WAIT_SECONDS: "2",
        REMOTE_VIBES_SKIP_RUN: "1",
      }),
    });

    assert.match(result.stdout, /Starting tailscaled directly in userspace networking mode/);
    assert.match(result.stdout, /Tailscale connected at 100\.64\.0\.11/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
    assert.deepEqual((await readFile(systemctlLog, "utf8")).trim().split("\n"), [
      "is-active --quiet tailscaled",
      "enable --now tailscaled",
      "start tailscaled",
    ]);
    assert.match(await readFile(tailscaledLog, "utf8"), /--tun=userspace-networking/);
    assert.deepEqual((await readFile(tailscaleLog, "utf8")).trim().split("\n"), [
      "status --json",
      "ip -4",
      "up",
      "ip -4",
      "ip -4",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh enables a systemd service on Linux after launch", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-systemd-install-"));
  const installDir = path.join(installRoot, "remote-vibes");
  const fakeBin = path.join(installRoot, "bin");
  const serviceDir = path.join(installRoot, "systemd");
  const systemctlLog = path.join(installRoot, "systemctl.log");
  const stateDir = path.join(installRoot, "state");
  const wikiDir = path.join(installRoot, "wiki");

  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(serviceDir, { recursive: true });
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Linux\\n'\n");
    await writeFile(
      path.join(fakeBin, "ps"),
      `#!/usr/bin/env sh
if [ "\${1:-}" = "-p" ] && [ "\${2:-}" = "1" ]; then
  printf 'systemd\\n'
  exit 0
fi
exec /bin/ps "$@"
`,
    );
    await writeFile(
      path.join(fakeBin, "systemctl"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}
if [ "\${1:-}" = "is-system-running" ]; then
  printf 'running\\n'
  exit 0
fi
exit 0
`,
    );
    await writeFile(path.join(fakeBin, "sudo"), "#!/usr/bin/env sh\nexec \"$@\"\n");
    await execFile("chmod", ["+x", ...["uname", "ps", "systemctl", "sudo"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_INSTALL_SERVICE: "1",
        REMOTE_VIBES_SYSTEMD_SERVICE_DIR: serviceDir,
        REMOTE_VIBES_SERVICE_NAME: "remote-vibes-test",
        REMOTE_VIBES_STATE_DIR: stateDir,
        REMOTE_VIBES_WIKI_DIR: wikiDir,
        REMOTE_VIBES_PORT: "4999",
      }),
    });

    assert.match(result.stdout, /SOURCE_VERSION=v1/);
    assert.match(result.stdout, /Installing systemd service remote-vibes-test\.service/);
    assert.match(result.stdout, /Enabled remote-vibes-test\.service/);

    const unit = await readFile(path.join(serviceDir, "remote-vibes-test.service"), "utf8");
    assert.match(unit, new RegExp(`WorkingDirectory=${escapeRegExp(installDir)}`));
    assert.match(unit, new RegExp(`ExecStart=${escapeRegExp(path.join(installDir, "start.sh"))}`));
    assert.match(unit, new RegExp(`Environment=REMOTE_VIBES_STATE_DIR=${escapeRegExp(stateDir)}`));
    assert.match(unit, new RegExp(`Environment=REMOTE_VIBES_WIKI_DIR=${escapeRegExp(wikiDir)}`));
    assert.match(unit, /Environment=REMOTE_VIBES_PORT=4999/);
    assert.match(unit, new RegExp(`PIDFile=${escapeRegExp(path.join(stateDir, "server.pid"))}`));
    assert.match(unit, /Restart=always/);
    assert.match(unit, /KillMode=process/);

    assert.deepEqual((await readFile(systemctlLog, "utf8")).trim().split("\n"), [
      "is-system-running",
      "daemon-reload",
      "enable --now remote-vibes-test.service",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh skips service install when systemctl reports offline", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-systemd-offline-"));
  const installDir = path.join(installRoot, "remote-vibes");
  const fakeBin = path.join(installRoot, "bin");
  const serviceDir = path.join(installRoot, "systemd");
  const systemctlLog = path.join(installRoot, "systemctl.log");

  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(serviceDir, { recursive: true });
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Linux\\n'\n");
    await writeFile(
      path.join(fakeBin, "systemctl"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}
if [ "\${1:-}" = "is-system-running" ]; then
  printf 'offline\\n'
  exit 1
fi
exit 1
`,
    );
    await writeFile(path.join(fakeBin, "sudo"), "#!/usr/bin/env sh\nexec \"$@\"\n");
    await execFile("chmod", ["+x", ...["uname", "systemctl", "sudo"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_INSTALL_SERVICE: "1",
        REMOTE_VIBES_SYSTEMD_SERVICE_DIR: serviceDir,
      }),
    });

    assert.match(result.stdout, /SOURCE_VERSION=v1/);
    assert.match(result.stdout, /Skipping service install because systemd is not available/);
    await assert.rejects(() => stat(path.join(serviceDir, "remote-vibes.service")));
    assert.deepEqual((await readFile(systemctlLog, "utf8")).trim().split("\n"), [
      "is-system-running",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
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
          env: installTestEnv({
            REMOTE_VIBES_PORT: String(port),
            REMOTE_VIBES_READY_TIMEOUT_SECONDS: "1",
            REMOTE_VIBES_STATE_DIR: path.join(tempRoot, "state"),
            REMOTE_VIBES_WIKI_DIR: path.join(tempRoot, "mac-brain"),
          }),
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
      env: installTestEnv({
        REMOTE_VIBES_PORT: String(port),
        REMOTE_VIBES_READY_TIMEOUT_SECONDS: "30",
        REMOTE_VIBES_STATE_DIR: newStateDir,
        REMOTE_VIBES_WIKI_DIR: path.join(tempRoot, "mac-brain"),
      }),
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

test("start.sh keeps the same workspace running when state already matches", async () => {
  const { tempRoot, repoDir } = await createWorkingTreeRepoSnapshot();
  const canonicalRepoDir = await realpath(repoDir);
  const port = await getFreePort();
  const stateDir = path.join(tempRoot, "state");
  let terminateRequested = false;
  const runningServer = http.createServer((request, response) => {
    if (request.url === "/api/state") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ appName: "Remote Vibes", cwd: canonicalRepoDir, stateDir }));
      return;
    }

    if (request.url === "/api/terminate" && request.method === "POST") {
      terminateRequested = true;
      response.setHeader("Content-Type", "application/json");
      response.end("{}");
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });

  await new Promise((resolve) => runningServer.listen(port, "127.0.0.1", resolve));

  try {
    const result = await execFile("bash", [path.join(repoDir, "start.sh")], {
      env: installTestEnv({
        REMOTE_VIBES_PORT: String(port),
        REMOTE_VIBES_READY_TIMEOUT_SECONDS: "1",
        REMOTE_VIBES_STATE_DIR: stateDir,
        REMOTE_VIBES_WIKI_DIR: path.join(tempRoot, "mac-brain"),
      }),
      timeout: 15_000,
    });
    const combinedOutput = `${result.stdout}${result.stderr}`;

    assert.equal(terminateRequested, false);
    assert.match(combinedOutput, /Remote Vibes is already running for this workspace/);

    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.appName, "Remote Vibes");
    assert.equal(payload.cwd, canonicalRepoDir);
    assert.equal(payload.stateDir, stateDir);
  } finally {
    await new Promise((resolve) => runningServer.close(() => resolve()));
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
      env: installTestEnv({
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoUrl,
        REMOTE_VIBES_PORT: String(port),
        REMOTE_VIBES_STATE_DIR: path.join(installRoot, "state"),
        REMOTE_VIBES_WIKI_DIR: path.join(installRoot, "mac-brain"),
      }),
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
      env: installTestEnv({
        HOME: homeDir,
        REMOTE_VIBES_PORT: String(port),
        REMOTE_VIBES_READY_TIMEOUT_SECONDS: "30",
      }),
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
