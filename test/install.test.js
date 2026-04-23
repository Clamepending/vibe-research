import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cp, lstat, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import http from "node:http";

const execFile = promisify(execFileCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const installScript = path.join(rootDir, "install.sh");
const fakeSudoScript = "#!/usr/bin/env sh\nif [ \"${1:-}\" = \"-n\" ]; then shift; fi\nexec \"$@\"\n";

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

async function createWorkingTreeRepoSnapshot() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-working-tree-"));
  const repoDir = path.join(tempRoot, "repo");

  await cp(rootDir, repoDir, {
    recursive: true,
    filter(source) {
      const relativePath = path.relative(rootDir, source);
      if (!relativePath) {
        return true;
      }

      const topLevelName = relativePath.split(path.sep)[0];
      return (
        topLevelName !== ".git" &&
        topLevelName !== "node_modules" &&
        topLevelName !== ".vibe-research" &&
        topLevelName !== ".remote-vibes"
      );
    },
  });

  await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFile("git", ["config", "user.name", "Vibe Research Test"], { cwd: repoDir });
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
    VIBE_RESEARCH_INSTALL_SYSTEM_DEPS: "0",
    VIBE_RESEARCH_INSTALL_TAILSCALE: "0",
    VIBE_RESEARCH_INSTALL_CLAUDE_CODE: "0",
    VIBE_RESEARCH_INSTALL_SERVICE: "0",
    VIBE_RESEARCH_UNINSTALL_SERVICE: "0",
    ...overrides,
  };
}

async function createUninstallableApp(appDir) {
  await mkdir(path.join(appDir, "bin"), { recursive: true });
  await mkdir(path.join(appDir, "src"), { recursive: true });
  await writeFile(path.join(appDir, "package.json"), '{"name":"vibe-research"}\n');
  await writeFile(path.join(appDir, "start.sh"), "#!/usr/bin/env bash\nexit 0\n");
  await writeFile(path.join(appDir, "src", "server.js"), "");
  await cp(path.join(rootDir, "bin", "vibe-research"), path.join(appDir, "bin", "vibe-research"));
  await execFile("chmod", ["+x", path.join(appDir, "start.sh"), path.join(appDir, "bin", "vibe-research")]);
}

test("package lock uses prebuilt node-pty packages on Linux", async () => {
  const lock = JSON.parse(await readFile(path.join(rootDir, "package-lock.json"), "utf8"));
  const nodePty = lock.packages["node_modules/node-pty"];

  assert.equal(nodePty.name, "@lydell/node-pty");
  assert.equal(nodePty.hasInstallScript, undefined);
  assert.equal(
    lock.packages["node_modules/@lydell/node-pty-linux-x64"]?.resolved,
    "https://registry.npmjs.org/@lydell/node-pty-linux-x64/-/node-pty-linux-x64-1.2.0-beta.12.tgz",
  );
});

async function createLinuxNodeInstallFakes({
  fakeBin,
  realNode = "",
  realCurl = "",
  nodeModulesDir = "",
} = {}) {
  const nodeVersion = "v22.99.0";
  const npmVersion = "10.9.8";
  const nodeMajor = nodeVersion.replace(/^v/, "").split(".")[0];
  const tarballBase = "node-v22.99.0-linux-x64";
  const tarballName = `${tarballBase}.tar.xz`;

  await writeFile(
    path.join(fakeBin, "uname"),
    "#!/usr/bin/env sh\nif [ \"${1:-}\" = \"-m\" ]; then printf 'x86_64\\n'; else printf 'Linux\\n'; fi\n",
  );
  await writeFile(path.join(fakeBin, "node"), "#!/usr/bin/env sh\nexit 127\n");
  await writeFile(path.join(fakeBin, "npm"), "#!/usr/bin/env sh\nexit 127\n");
  await writeFile(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
original_args=("$@")
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
    printf 'abc  ${tarballName}\\n'
    ;;
  *${tarballName})
    printf 'node tarball' > "$output"
    ;;
  *)
    ${realCurl ? `exec ${JSON.stringify(realCurl)} "\${original_args[@]}"` : "printf 'unexpected curl URL: %s\\n' \"$url\" >&2\n    exit 1"}
    ;;
esac
`,
  );
  await writeFile(
    path.join(fakeBin, "tar"),
    `#!/usr/bin/env bash
set -euo pipefail
target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -C)
      target="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [ -z "$target" ]; then
  printf 'missing tar target\\n' >&2
  exit 64
fi
mkdir -p "$target/${tarballBase}/bin"
cat > "$target/${tarballBase}/bin/node" <<'NODE_BIN'
#!/usr/bin/env sh
case "\${1:-}" in
  -p)
    printf '${nodeMajor}\\n'
    exit 0
    ;;
  -v|--version)
    printf '${nodeVersion}\\n'
    exit 0
    ;;
esac
${realNode ? `exec ${JSON.stringify(realNode)} "$@"` : "exit 0"}
NODE_BIN
cat > "$target/${tarballBase}/bin/npm" <<'NPM_BIN'
#!/usr/bin/env sh
case "\${1:-}" in
  -v|--version)
    printf '${npmVersion}\\n'
    exit 0
    ;;
  ci|install)
    ${
      nodeModulesDir
        ? `if [ -d ${JSON.stringify(nodeModulesDir)} ]; then
      ln -sfn ${JSON.stringify(nodeModulesDir)} node_modules
    else
      mkdir -p node_modules/playwright-core node_modules/esbuild node_modules/node-pty
      printf '{}\\n' > node_modules/playwright-core/package.json
      printf '{}\\n' > node_modules/esbuild/package.json
      printf '{}\\n' > node_modules/node-pty/package.json
    fi`
        : `mkdir -p node_modules/playwright-core node_modules/esbuild node_modules/node-pty
    printf '{}\\n' > node_modules/playwright-core/package.json
    printf '{}\\n' > node_modules/esbuild/package.json
    printf '{}\\n' > node_modules/node-pty/package.json`
    }
    exit 0
    ;;
esac
exit 0
NPM_BIN
cat > "$target/${tarballBase}/bin/npx" <<'NPX_BIN'
#!/usr/bin/env sh
exit 0
NPX_BIN
chmod +x "$target/${tarballBase}/bin/node" "$target/${tarballBase}/bin/npm" "$target/${tarballBase}/bin/npx"
`,
  );

  await execFile("chmod", ["+x", ...["uname", "node", "npm", "curl", "tar"].map((name) => path.join(fakeBin, name))]);

  return { nodeVersion, npmVersion, tarballBase, tarballName };
}

test("install.sh clones and updates a checkout in one command", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-install-"));
  const installDir = path.join(installRoot, "vibe-research");

  try {
    const firstRun = await execFile("bash", [installScript], {
      env: installTestEnv({
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_SKIP_RUN: "1",
      }),
    });

    assert.match(firstRun.stdout, /Skipping launch/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
    assert.equal(await readFile(path.join(installDir, "VERSION"), "utf8"), "v1\n");

    await writeFile(path.join(installDir, "VERSION"), "local edit\n");
    await writeFile(path.join(repoDir, "VERSION"), "v2\n");
    await execFile("git", ["add", "VERSION"], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "Update"], { cwd: repoDir });

    const secondRun = await execFile("bash", [installScript], {
      env: installTestEnv({
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_SKIP_RUN: "1",
      }),
    });

    assert.match(secondRun.stdout, /Updating existing checkout/);
    assert.match(secondRun.stdout, /Discarding local app checkout changes before update/);
    assert.equal(await readFile(path.join(installDir, "VERSION"), "utf8"), "v2\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh restores generated package-lock churn before updating a checkout", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-lockfile-update-"));
  const installDir = path.join(installRoot, "vibe-research");

  try {
    await writeFile(path.join(repoDir, "package-lock.json"), '{"lockfileVersion":3}\n');
    await execFile("git", ["add", "package-lock.json"], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "Add lockfile"], { cwd: repoDir });

    await execFile("bash", [installScript], {
      env: installTestEnv({
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_SKIP_RUN: "1",
      }),
    });

    await writeFile(path.join(installDir, "package-lock.json"), '{"lockfileVersion":3,"packages":{"node_modules/xterm":{"peer":true}}}\n');
    await writeFile(path.join(repoDir, "VERSION"), "v2\n");
    await execFile("git", ["add", "VERSION"], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "Update"], { cwd: repoDir });

    const secondRun = await execFile("bash", [installScript], {
      env: installTestEnv({
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_SKIP_RUN: "1",
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

test("install.sh defaults to an app checkout under the home Vibe Research directory", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const homeDir = path.join(tempRoot, "home");
  const installDir = path.join(homeDir, ".vibe-research", "app");

  try {
    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        HOME: homeDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_SKIP_RUN: "1",
      }),
    });

    assert.match(result.stdout, new RegExp(`Cloning into ${escapeRegExp(installDir)}`));
    assert.match(result.stdout, /Skipping launch/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("install.sh forces a managed restart when launching from the installer", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-force-restart-"));
  const installDir = path.join(installRoot, "vibe-research");

  try {
    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
      }),
    });

    assert.match(result.stdout, /SOURCE_VERSION=v1/);
    assert.match(result.stdout, /FORCE_RESTART=1/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh defers Claude Code install to onboarding by default", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-claude-defer-"));
  const installDir = path.join(installRoot, "vibe-research");
  const fakeBin = path.join(installRoot, "bin");
  const homeDir = path.join(installRoot, "home");

  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(
      path.join(fakeBin, "claude"),
      "#!/usr/bin/env sh\nprintf 'not installed yet\\n' >&2\nexit 127\n",
    );
    await writeFile(
      path.join(fakeBin, "curl"),
      "#!/usr/bin/env sh\nprintf 'installer should not call curl for Claude by default\\n' >&2\nexit 99\n",
    );
    await execFile("chmod", ["+x", path.join(fakeBin, "claude"), path.join(fakeBin, "curl")]);

    const env = installTestEnv({
      HOME: homeDir,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      VIBE_RESEARCH_HOME: installDir,
      VIBE_RESEARCH_REPO_URL: repoDir,
      VIBE_RESEARCH_SKIP_RUN: "1",
    });
    delete env.VIBE_RESEARCH_INSTALL_CLAUDE_CODE;
    delete env.REMOTE_VIBES_INSTALL_CLAUDE_CODE;

    const result = await execFile("bash", [installScript], { env });

    assert.match(result.stdout, /Claude Code is not installed yet; continuing so onboarding can install or choose a coding agent/);
    assert.doesNotMatch(result.stdout, /Installing Claude Code using Anthropic's native installer/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh installs Claude Code when explicitly requested", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-claude-install-"));
  const homeDir = path.join(installRoot, "home");
  const installDir = path.join(installRoot, "vibe-research");
  const fakeBin = path.join(installRoot, "bin");
  const claudeInstallLog = path.join(installRoot, "claude-install.log");

  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(
      path.join(fakeBin, "claude"),
      "#!/usr/bin/env sh\nprintf 'not installed yet\\n' >&2\nexit 127\n",
    );
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Darwin\\n'\n");
    await writeFile(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
if [ "$url" != "https://claude.ai/install.sh" ]; then
  printf 'unexpected curl URL: %s\\n' "$url" >&2
  exit 1
fi
cat <<'CLAUDE_INSTALLER'
#!/usr/bin/env bash
set -euo pipefail
if [ "\${LC_ALL:-}" != "en_US.UTF-8" ] || [ "\${LC_CTYPE:-}" != "en_US.UTF-8" ] || [ "\${LANG:-}" != "en_US.UTF-8" ]; then
  printf 'bad installer locale: LC_ALL=%s LC_CTYPE=%s LANG=%s\\n' "\${LC_ALL:-}" "\${LC_CTYPE:-}" "\${LANG:-}" >&2
  exit 64
fi
printf 'installed via native installer\\n' >> ${JSON.stringify(claudeInstallLog)}
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/claude" <<'CLAUDE_BIN'
#!/usr/bin/env sh
if [ "\${1:-}" = "--version" ]; then
  printf 'Claude Code 2.1.99\\n'
  exit 0
fi
exit 0
CLAUDE_BIN
chmod +x "$HOME/.local/bin/claude"
CLAUDE_INSTALLER
`,
    );
    await execFile("chmod", ["+x", path.join(fakeBin, "claude"), path.join(fakeBin, "curl"), path.join(fakeBin, "uname")]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        HOME: homeDir,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        LC_CTYPE: "C.UTF-8",
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_INSTALL_CLAUDE_CODE: "1",
        VIBE_RESEARCH_SKIP_RUN: "1",
      }),
    });

    assert.match(result.stdout, /Installing Claude Code using Anthropic's native installer/);
    assert.match(result.stdout, /Using macOS locale en_US\.UTF-8 instead of unsupported C\.UTF-8/);
    assert.match(result.stdout, /Using Claude Code Claude Code 2\.1\.99/);
    assert.equal((await readFile(claudeInstallLog, "utf8")).trim(), "installed via native installer");
    assert.ok(await stat(path.join(homeDir, ".local", "bin", "claude")));
    assert.ok(await stat(path.join(installDir, "start.sh")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh falls back to user-local npm when the Claude Code native installer times out", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-claude-npm-fallback-"));
  const homeDir = path.join(installRoot, "home");
  const installDir = path.join(installRoot, "vibe-research");
  const fakeBin = path.join(installRoot, "bin");
  const timeoutLog = path.join(installRoot, "timeout.log");
  const npmLog = path.join(installRoot, "npm.log");

  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(
      path.join(fakeBin, "claude"),
      "#!/usr/bin/env sh\nprintf 'not installed yet\\n' >&2\nexit 127\n",
    );
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Linux\\n'\n");
    await writeFile(path.join(fakeBin, "curl"), "#!/usr/bin/env sh\nprintf 'native installer should be wrapped by timeout\\n' >&2\nexit 99\n");
    await writeFile(
      path.join(fakeBin, "timeout"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(timeoutLog)}
exit 124
`,
    );
    await writeFile(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-v" ] || [ "\${1:-}" = "--version" ]; then
  printf '10.9.7\\n'
  exit 0
fi
printf '%s\\n' "$*" >> ${JSON.stringify(npmLog)}
if [ "\${NPM_CONFIG_PREFIX:-}" != "$HOME/.local" ]; then
  printf 'bad npm prefix: %s\\n' "\${NPM_CONFIG_PREFIX:-}" >&2
  exit 65
fi
mkdir -p "$NPM_CONFIG_PREFIX/bin"
cat > "$NPM_CONFIG_PREFIX/bin/claude" <<'CLAUDE_BIN'
#!/usr/bin/env sh
if [ "\${1:-}" = "--version" ]; then
  printf 'Claude Code 2.1.100\\n'
  exit 0
fi
exit 0
CLAUDE_BIN
chmod +x "$NPM_CONFIG_PREFIX/bin/claude"
`,
    );
    await execFile("chmod", [
      "+x",
      path.join(fakeBin, "claude"),
      path.join(fakeBin, "curl"),
      path.join(fakeBin, "npm"),
      path.join(fakeBin, "timeout"),
      path.join(fakeBin, "uname"),
    ]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        HOME: homeDir,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_INSTALL_CLAUDE_CODE: "1",
        VIBE_RESEARCH_CLAUDE_CODE_INSTALL_TIMEOUT_SECONDS: "1",
        VIBE_RESEARCH_SKIP_RUN: "1",
      }),
    });

    assert.match(result.stdout, /Installing Claude Code using Anthropic's native installer \(timeout 1s\)/);
    assert.match(result.stdout, /Claude Code native installer did not complete \(exit 124\); trying npm fallback/);
    assert.match(result.stdout, new RegExp(`Installing Claude Code using npm fallback under ${escapeRegExp(path.join(homeDir, ".local"))}`));
    assert.match(result.stdout, /Using Claude Code Claude Code 2\.1\.100/);
    assert.match(await readFile(timeoutLog, "utf8"), /1s bash -c/);
    assert.equal((await readFile(npmLog, "utf8")).trim(), "install -g @anthropic-ai/claude-code --no-audit --no-fund");
    assert.ok(await stat(path.join(homeDir, ".local", "bin", "claude")));
    assert.ok(await stat(path.join(installDir, "start.sh")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh accepts Remote Vibes environment aliases during migration", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-remote-vibes-env-"));
  const installDir = path.join(installRoot, "vibe-research");

  try {
    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        REMOTE_VIBES_HOME: installDir,
        REMOTE_VIBES_REPO_URL: repoDir,
        REMOTE_VIBES_SKIP_RUN: "1",
      }),
    });

    assert.match(result.stdout, /Skipping launch/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
    assert.equal(await readFile(path.join(installDir, "VERSION"), "utf8"), "v1\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh installs Node.js on fresh macOS hosts before cloning", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-macos-node-install-"));
  const installDir = path.join(installRoot, "vibe-research");
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
    await writeFile(path.join(fakeBin, "sudo"), fakeSudoScript);
    await execFile("chmod", ["+x", ...["uname", "node", "npm", "curl", "installer", "sudo"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_SKIP_RUN: "1",
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

test("install.sh installs user-local Node.js on Linux hosts without apt", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-linux-node-install-"));
  const installDir = path.join(installRoot, "vibe-research");
  const fakeBin = path.join(installRoot, "bin");
  const nodeInstallRoot = path.join(installRoot, "managed-node");
  const nodeBinDir = path.join(installRoot, "local-bin");

  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(nodeBinDir, { recursive: true });
    await writeFile(path.join(nodeBinDir, "node"), "existing node\n");
    const { nodeVersion, npmVersion, tarballBase } = await createLinuxNodeInstallFakes({ fakeBin });

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_NODE_INSTALL_ROOT: nodeInstallRoot,
        VIBE_RESEARCH_NODE_BIN_DIR: nodeBinDir,
        VIBE_RESEARCH_SKIP_RUN: "1",
      }),
    });

    assert.match(result.stdout, new RegExp(`Installing Node\\.js 22\\.x for Linux under ${escapeRegExp(nodeInstallRoot)}`));
    assert.match(result.stdout, new RegExp(`Using Node ${escapeRegExp(nodeVersion)} and npm ${escapeRegExp(npmVersion)}`));
    assert.ok(await stat(path.join(installDir, "start.sh")));
    assert.equal(
      await realpath(path.join(nodeInstallRoot, "current", "bin", "node")),
      await realpath(path.join(nodeInstallRoot, tarballBase, "bin", "node")),
    );
    assert.equal(await readFile(path.join(nodeBinDir, "node"), "utf8"), "existing node\n");
    assert.equal(
      await realpath(path.join(nodeBinDir, "npm")),
      await realpath(path.join(nodeInstallRoot, "current", "bin", "npm")),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("start.sh bootstraps Node.js through the installer when launched from a checkout", async () => {
  const { tempRoot, repoDir } = await createWorkingTreeRepoSnapshot();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-start-node-install-"));
  const fakeBin = path.join(installRoot, "bin");
  const nodeInstalledState = path.join(installRoot, "node-installed");
  const nodePkg = "node-v22.99.0.pkg";
  const port = await getFreePort();
  const realNode = process.execPath;
  const realCurl = (await execFile("bash", ["-lc", "command -v curl"])).stdout.trim();

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Darwin\\n'\n");
    await writeFile(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env sh
if [ ! -f ${JSON.stringify(nodeInstalledState)} ]; then
  exit 127
fi
case "\${1:-}" in
  -p)
    printf '22\\n'
    exit 0
    ;;
  -v|--version)
    printf 'v22.99.0\\n'
    exit 0
    ;;
esac
exec ${JSON.stringify(realNode)} "$@"
`,
    );
    await writeFile(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env sh
if [ ! -f ${JSON.stringify(nodeInstalledState)} ]; then
  exit 127
fi
case "\${1:-}" in
  -v|--version)
    printf '10.9.9\\n'
    exit 0
    ;;
  ci|install)
    ln -sfn ${JSON.stringify(path.join(rootDir, "node_modules"))} node_modules
    exit 0
    ;;
esac
exit 0
`,
    );
    await writeFile(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
original_args=("$@")
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
    exec ${JSON.stringify(realCurl)} "\${original_args[@]}"
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
    await writeFile(path.join(fakeBin, "sudo"), fakeSudoScript);
    await execFile("chmod", ["+x", ...["uname", "node", "npm", "curl", "installer", "sudo"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [path.join(repoDir, "start.sh")], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_PORT: String(port),
        VIBE_RESEARCH_READY_TIMEOUT_SECONDS: "30",
        VIBE_RESEARCH_STATE_DIR: path.join(installRoot, "state"),
        VIBE_RESEARCH_WIKI_DIR: path.join(installRoot, "mac-brain"),
      }),
      timeout: 60_000,
    });
    const combinedOutput = `${result.stdout}${result.stderr}`;

    assert.match(combinedOutput, /running the installer Node\.js step/);
    assert.match(combinedOutput, /Installing Node\.js 22\.x for macOS/);
    assert.match(combinedOutput, /Using Node v22\.99\.0 and npm 10\.9\.9/);

    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.appName, "Vibe Research");
  } finally {
    try {
      await fetch(`http://127.0.0.1:${port}/api/terminate`, {
        method: "POST",
      });
      await waitForShutdown(`http://127.0.0.1:${port}/api/state`);
    } catch {
      // Server may not have started.
    }

    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("start.sh refreshes PATH after the installer adds managed Linux Node.js", async () => {
  const { tempRoot, repoDir } = await createWorkingTreeRepoSnapshot();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-start-linux-node-install-"));
  const fakeBin = path.join(installRoot, "bin");
  const nodeInstallRoot = path.join(installRoot, "managed-node");
  const nodeBinDir = path.join(installRoot, "local-bin");
  const port = await getFreePort();
  const realNode = process.execPath;
  const realCurl = (await execFile("bash", ["-lc", "command -v curl"])).stdout.trim();

  try {
    await mkdir(fakeBin, { recursive: true });
    const { nodeVersion, npmVersion } = await createLinuxNodeInstallFakes({
      fakeBin,
      realNode,
      realCurl,
      nodeModulesDir: path.join(rootDir, "node_modules"),
    });

    const result = await execFile("bash", [path.join(repoDir, "start.sh")], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_PORT: String(port),
        VIBE_RESEARCH_READY_TIMEOUT_SECONDS: "30",
        VIBE_RESEARCH_STATE_DIR: path.join(installRoot, "state"),
        VIBE_RESEARCH_WIKI_DIR: path.join(installRoot, "linux-brain"),
        VIBE_RESEARCH_NODE_INSTALL_ROOT: nodeInstallRoot,
        VIBE_RESEARCH_NODE_BIN_DIR: nodeBinDir,
      }),
      timeout: 60_000,
    });
    const combinedOutput = `${result.stdout}${result.stderr}`;

    assert.match(combinedOutput, /running the installer Node\.js step/);
    assert.match(combinedOutput, new RegExp(`Installing Node\\.js 22\\.x for Linux under ${escapeRegExp(nodeInstallRoot)}`));
    assert.match(combinedOutput, new RegExp(`Using Node ${escapeRegExp(nodeVersion)} and npm ${escapeRegExp(npmVersion)}`));

    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.appName, "Vibe Research");
  } finally {
    try {
      await fetch(`http://127.0.0.1:${port}/api/terminate`, {
        method: "POST",
      });
      await waitForShutdown(`http://127.0.0.1:${port}/api/state`);
    } catch {
      // Server may not have started.
    }

    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh installs a vibe-research launcher command", async () => {
  const { tempRoot, repoDir } = await createWorkingTreeRepoSnapshot();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-launcher-install-"));
  const installDir = path.join(installRoot, "vibe-research");
  const userBinDir = path.join(installRoot, "bin");

  try {
    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_BIN_DIR: userBinDir,
        VIBE_RESEARCH_SKIP_RUN: "1",
      }),
    });

    assert.match(result.stdout, /Installed terminal command:/);
    assert.match(result.stdout, /If 'vibe-research' is not found yet/);
    const launcherPath = path.join(userBinDir, "vibe-research");
    const launcherStat = await lstat(launcherPath);
    assert.equal(launcherStat.isSymbolicLink(), true);
    assert.equal(await realpath(launcherPath), await realpath(path.join(installDir, "bin", "vibe-research")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("vibe-research uninstall removes the launcher and app checkout while keeping state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-uninstall-"));
  const appDir = path.join(tempRoot, "app");
  const stateDir = path.join(tempRoot, "state");
  const userBinDir = path.join(tempRoot, "bin");
  const launcherPath = path.join(userBinDir, "vibe-research");

  try {
    await createUninstallableApp(appDir);
    await mkdir(stateDir, { recursive: true });
    await mkdir(userBinDir, { recursive: true });
    await writeFile(path.join(stateDir, "settings.json"), "{}\n");
    await symlink(path.join(appDir, "bin", "vibe-research"), launcherPath);

    const result = await execFile("bash", [path.join(rootDir, "bin", "vibe-research"), "uninstall", "--yes"], {
      env: installTestEnv({
        VIBE_RESEARCH_HOME: appDir,
        VIBE_RESEARCH_STATE_DIR: stateDir,
        VIBE_RESEARCH_BIN_DIR: userBinDir,
        PATH: `${userBinDir}${path.delimiter}${process.env.PATH || ""}`,
      }),
    });

    assert.match(result.stdout, /Removing terminal command:/);
    assert.match(result.stdout, /Removing app checkout:/);
    assert.match(result.stdout, /Keeping local state:/);
    assert.match(result.stdout, /Uninstall complete/);
    await assert.rejects(() => lstat(launcherPath));
    await assert.rejects(() => stat(appDir));
    assert.equal(await readFile(path.join(stateDir, "settings.json"), "utf8"), "{}\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("vibe-research uninstall --purge removes local state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-uninstall-purge-"));
  const appDir = path.join(tempRoot, "state", "app");
  const stateDir = path.join(tempRoot, "state");

  try {
    await createUninstallableApp(appDir);
    await writeFile(path.join(stateDir, "settings.json"), "{}\n");

    const result = await execFile("bash", [path.join(rootDir, "bin", "vibe-research"), "uninstall", "--yes", "--purge"], {
      env: installTestEnv({
        VIBE_RESEARCH_HOME: appDir,
        VIBE_RESEARCH_STATE_DIR: stateDir,
      }),
    });

    assert.match(result.stdout, /Removing app checkout:/);
    assert.match(result.stdout, /Removing local state:/);
    await assert.rejects(() => stat(stateDir));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("vibe-research uninstall removes an installed systemd unit", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-uninstall-systemd-"));
  const appDir = path.join(tempRoot, "app");
  const stateDir = path.join(tempRoot, "state");
  const fakeBin = path.join(tempRoot, "bin");
  const serviceDir = path.join(tempRoot, "systemd");
  const systemctlLog = path.join(tempRoot, "systemctl.log");
  const servicePath = path.join(serviceDir, "vibe-research-test.service");

  try {
    await createUninstallableApp(appDir);
    await mkdir(stateDir, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await mkdir(serviceDir, { recursive: true });
    await writeFile(servicePath, "[Unit]\nDescription=Vibe Research\n");
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Linux\\n'\n");
    await writeFile(
      path.join(fakeBin, "systemctl"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}
if [ "\${1:-}" = "cat" ]; then
  if [ -f ${JSON.stringify(servicePath)} ]; then
    cat ${JSON.stringify(servicePath)}
    exit 0
  fi
  exit 1
fi
exit 0
`,
    );
    await writeFile(path.join(fakeBin, "sudo"), "#!/usr/bin/env sh\nexec \"$@\"\n");
    await execFile("chmod", ["+x", path.join(fakeBin, "uname"), path.join(fakeBin, "systemctl"), path.join(fakeBin, "sudo")]);

    const result = await execFile("bash", [path.join(rootDir, "bin", "vibe-research"), "uninstall", "--yes"], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: appDir,
        VIBE_RESEARCH_STATE_DIR: stateDir,
        VIBE_RESEARCH_SYSTEMD_SERVICE_DIR: serviceDir,
        VIBE_RESEARCH_SERVICE_NAME: "vibe-research-test",
        VIBE_RESEARCH_UNINSTALL_SERVICE: "1",
      }),
    });

    assert.match(result.stdout, /Disabling systemd service vibe-research-test\.service/);
    assert.match(result.stdout, /Removing systemd unit:/);
    await assert.rejects(() => stat(servicePath));
    assert.deepEqual((await readFile(systemctlLog, "utf8")).trim().split("\n"), [
      "cat vibe-research-test.service",
      "stop vibe-research-test.service",
      "disable vibe-research-test.service",
      "daemon-reload",
      "reset-failed vibe-research-test.service",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("vibe-research command starts the app and opens the browser URL", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-command-"));
  const appDir = path.join(tempRoot, "app");
  const openLog = path.join(tempRoot, "open.log");
  const startLog = path.join(tempRoot, "start.log");
  const opener = path.join(tempRoot, "open-browser");
  const port = await getFreePort();

  try {
    await mkdir(appDir, { recursive: true });
    await writeFile(
      path.join(appDir, "start.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf 'started with port=%s\\n' "\${VIBE_RESEARCH_PORT:-}" >> ${JSON.stringify(startLog)}
`,
    );
    await writeFile(
      opener,
      `#!/usr/bin/env bash
printf '%s\\n' "$1" >> ${JSON.stringify(openLog)}
`,
    );
    await execFile("chmod", ["+x", path.join(appDir, "start.sh"), opener]);

    const result = await execFile("bash", [path.join(rootDir, "bin", "vibe-research")], {
      env: installTestEnv({
        VIBE_RESEARCH_HOME: appDir,
        VIBE_RESEARCH_PORT: String(port),
        VIBE_RESEARCH_OPEN_COMMAND: opener,
      }),
    });

    assert.match(result.stdout, new RegExp(`Opened Vibe Research: http://localhost:${port}/`));
    assert.equal(await readFile(startLog, "utf8"), `started with port=${port}\n`);
    assert.equal(await readFile(openLog, "utf8"), `http://localhost:${port}/\n`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("install.sh starts Tailscale onboarding when Tailscale is installed but logged out", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-tailscale-install-"));
  const installDir = path.join(installRoot, "vibe-research");
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
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_INSTALL_TAILSCALE: "1",
        VIBE_RESEARCH_TAILSCALE_USE_SUDO: "0",
        VIBE_RESEARCH_SKIP_RUN: "1",
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

test("install.sh does not require Tailscale login by default", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-tailscale-optional-"));
  const installDir = path.join(installRoot, "vibe-research");
  const fakeBin = path.join(installRoot, "bin");
  const tailscaleLog = path.join(installRoot, "tailscale.log");

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      path.join(fakeBin, "tailscale"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(tailscaleLog)}
if [ "\${1:-}" = "ip" ]; then
  exit 1
fi
if [ "\${1:-}" = "up" ]; then
  printf 'tailscale up should not run in auto mode\\n' >&2
  exit 42
fi
exit 0
`,
    );
    await execFile("chmod", ["+x", path.join(fakeBin, "tailscale")]);

    const env = installTestEnv({
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      VIBE_RESEARCH_HOME: installDir,
      VIBE_RESEARCH_REPO_URL: repoDir,
      VIBE_RESEARCH_SKIP_RUN: "1",
    });
    delete env.VIBE_RESEARCH_INSTALL_TAILSCALE;
    delete env.REMOTE_VIBES_INSTALL_TAILSCALE;

    const result = await execFile("bash", [installScript], { env });

    assert.match(result.stdout, /Tailscale is installed but not connected; continuing with local\/LAN URLs/);
    assert.doesNotMatch(result.stdout, /Starting Tailscale/);
    assert.ok(await stat(path.join(installDir, "start.sh")));
    assert.deepEqual((await readFile(tailscaleLog, "utf8")).trim().split("\n"), ["ip -4"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh starts tailscaled before Tailscale login on Linux", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-tailscaled-install-"));
  const installDir = path.join(installRoot, "vibe-research");
  const fakeBin = path.join(installRoot, "bin");
  const tailscaleLog = path.join(installRoot, "tailscale.log");
  const systemctlLog = path.join(installRoot, "systemctl.log");
  const tailscaleDaemonState = path.join(installRoot, "tailscaled-running");
  const tailscaleConnectedState = path.join(installRoot, "tailscale-connected");

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Linux\\n'\n");
    await writeFile(path.join(fakeBin, "sudo"), fakeSudoScript);
    await writeFile(path.join(fakeBin, "service"), "#!/usr/bin/env sh\nexit 1\n");
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
    await execFile("chmod", [
      "+x",
      ...["uname", "sudo", "service", "systemctl", "tailscale"].map((name) => path.join(fakeBin, name)),
    ]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_INSTALL_TAILSCALE: "1",
        VIBE_RESEARCH_SKIP_RUN: "1",
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
    const tailscaleCommands = (await readFile(tailscaleLog, "utf8")).trim().split("\n");
    const daemonPolls = tailscaleCommands.slice(0, -4);
    assert.ok(daemonPolls.length >= 1);
    assert.ok(daemonPolls.every((command) => command === "status --json"));
    assert.deepEqual(tailscaleCommands.slice(-4), [
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
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-tailscaled-race-"));
  const installDir = path.join(installRoot, "vibe-research");
  const fakeBin = path.join(installRoot, "bin");
  const tailscaleLog = path.join(installRoot, "tailscale.log");
  const systemctlLog = path.join(installRoot, "systemctl.log");
  const startAttemptState = path.join(installRoot, "tailscaled-start-attempted");
  const tailscaleDaemonState = path.join(installRoot, "tailscaled-running");
  const tailscaleConnectedState = path.join(installRoot, "tailscale-connected");

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Linux\\n'\n");
    await writeFile(path.join(fakeBin, "sudo"), fakeSudoScript);
    await writeFile(path.join(fakeBin, "service"), "#!/usr/bin/env sh\nexit 1\n");
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
    await execFile("chmod", [
      "+x",
      ...["uname", "sudo", "service", "systemctl", "tailscale"].map((name) => path.join(fakeBin, name)),
    ]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_INSTALL_TAILSCALE: "1",
        VIBE_RESEARCH_TAILSCALE_DAEMON_WAIT_SECONDS: "1",
        VIBE_RESEARCH_SKIP_RUN: "1",
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
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-tailscaled-userspace-"));
  const installDir = path.join(installRoot, "vibe-research");
  const fakeBin = path.join(installRoot, "bin");
  const tailscaleLog = path.join(installRoot, "tailscale.log");
  const tailscaledLog = path.join(installRoot, "tailscaled.log");
  const systemctlLog = path.join(installRoot, "systemctl.log");
  const tailscaleDaemonState = path.join(installRoot, "tailscaled-running");
  const tailscaleConnectedState = path.join(installRoot, "tailscale-connected");

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Linux\\n'\n");
    await writeFile(path.join(fakeBin, "service"), "#!/usr/bin/env sh\nexit 1\n");
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
    await execFile("chmod", [
      "+x",
      ...["uname", "sudo", "service", "systemctl", "tailscaled", "tailscale"].map((name) => path.join(fakeBin, name)),
    ]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_INSTALL_TAILSCALE: "1",
        VIBE_RESEARCH_TAILSCALE_DAEMON_WAIT_SECONDS: "2",
        VIBE_RESEARCH_SKIP_RUN: "1",
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
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-systemd-install-"));
  const installDir = path.join(installRoot, "vibe-research");
  const fakeBin = path.join(installRoot, "bin");
  const serviceDir = path.join(installRoot, "systemd");
  const systemctlLog = path.join(installRoot, "systemctl.log");
  const stateDir = path.join(installRoot, "state");
  const workspaceDir = path.join(installRoot, "workspace");
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
    await writeFile(path.join(fakeBin, "sudo"), fakeSudoScript);
    await execFile("chmod", ["+x", ...["uname", "ps", "systemctl", "sudo"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_INSTALL_SERVICE: "1",
        VIBE_RESEARCH_SYSTEMD_SERVICE_DIR: serviceDir,
        VIBE_RESEARCH_SERVICE_NAME: "vibe-research-test",
        VIBE_RESEARCH_STATE_DIR: stateDir,
        VIBE_RESEARCH_WORKSPACE_DIR: workspaceDir,
        VIBE_RESEARCH_WIKI_DIR: wikiDir,
        VIBE_RESEARCH_PORT: "4999",
      }),
    });

    assert.match(result.stdout, /SOURCE_VERSION=v1/);
    assert.match(result.stdout, /Stopping existing systemd service vibe-research-test\.service before update/);
    assert.match(result.stdout, /Installing systemd service vibe-research-test\.service/);
    assert.match(result.stdout, /Enabled vibe-research-test\.service/);

    const unit = await readFile(path.join(serviceDir, "vibe-research-test.service"), "utf8");
    assert.match(unit, new RegExp(`WorkingDirectory=${escapeRegExp(installDir)}`));
    assert.match(unit, new RegExp(`ExecStart=${escapeRegExp(path.join(installDir, "start.sh"))}`));
    assert.match(unit, new RegExp(`Environment=VIBE_RESEARCH_STATE_DIR=${escapeRegExp(stateDir)}`));
    assert.match(unit, new RegExp(`Environment=VIBE_RESEARCH_WORKSPACE_DIR=${escapeRegExp(workspaceDir)}`));
    assert.match(unit, new RegExp(`Environment=VIBE_RESEARCH_WIKI_DIR=${escapeRegExp(wikiDir)}`));
    assert.match(unit, /Environment=VIBE_RESEARCH_PORT=4999/);
    assert.match(unit, /Environment=VIBE_RESEARCH_FORCE_RESTART=1/);
    assert.match(unit, new RegExp(`PIDFile=${escapeRegExp(path.join(stateDir, "server.pid"))}`));
    assert.match(unit, /Restart=always/);
    assert.match(unit, /KillMode=process/);

    assert.deepEqual((await readFile(systemctlLog, "utf8")).trim().split("\n"), [
      "cat vibe-research-test.service",
      "stop vibe-research-test.service",
      "is-system-running",
      "daemon-reload",
      "enable vibe-research-test.service",
      "restart vibe-research-test.service",
      "is-active --quiet vibe-research-test.service",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh accepts a transient systemd restart failure when the service becomes active", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-systemd-retry-"));
  const installDir = path.join(installRoot, "vibe-research");
  const fakeBin = path.join(installRoot, "bin");
  const serviceDir = path.join(installRoot, "systemd");
  const systemctlLog = path.join(installRoot, "systemctl.log");

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
if [ "\${1:-}" = "restart" ]; then
  exit 1
fi
if [ "\${1:-}" = "is-active" ]; then
  exit 0
fi
exit 0
`,
    );
    await writeFile(path.join(fakeBin, "sudo"), fakeSudoScript);
    await execFile("chmod", ["+x", ...["uname", "ps", "systemctl", "sudo"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_INSTALL_SERVICE: "1",
        VIBE_RESEARCH_SYSTEMD_SERVICE_DIR: serviceDir,
        VIBE_RESEARCH_SERVICE_NAME: "vibe-research-test",
      }),
    });

    assert.match(result.stdout, /systemd restart did not report success; checking vibe-research-test\.service status/);
    assert.match(result.stdout, /Enabled vibe-research-test\.service/);
    assert.doesNotMatch(result.stdout, /Could not start systemd service/);
    assert.deepEqual((await readFile(systemctlLog, "utf8")).trim().split("\n"), [
      "cat vibe-research-test.service",
      "stop vibe-research-test.service",
      "is-system-running",
      "daemon-reload",
      "enable vibe-research-test.service",
      "restart vibe-research-test.service",
      "is-active --quiet vibe-research-test.service",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh accepts a running app when systemd status lags behind", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-systemd-server-running-"));
  const installDir = path.join(installRoot, "vibe-research");
  const fakeBin = path.join(installRoot, "bin");
  const serviceDir = path.join(installRoot, "systemd");
  const systemctlLog = path.join(installRoot, "systemctl.log");

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
if [ "\${1:-}" = "restart" ] || [ "\${1:-}" = "is-active" ]; then
  exit 1
fi
exit 0
`,
    );
    await writeFile(path.join(fakeBin, "curl"), "#!/usr/bin/env sh\nprintf '{\"appName\":\"Vibe Research\"}\\n'\n");
    await writeFile(path.join(fakeBin, "sudo"), fakeSudoScript);
    await execFile("chmod", ["+x", ...["uname", "ps", "systemctl", "curl", "sudo"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_INSTALL_SERVICE: "1",
        VIBE_RESEARCH_SYSTEMD_SERVICE_DIR: serviceDir,
        VIBE_RESEARCH_SERVICE_NAME: "vibe-research-test",
        VIBE_RESEARCH_SYSTEMD_START_ATTEMPTS: "1",
        VIBE_RESEARCH_SERVER_START_ATTEMPTS: "1",
      }),
    });

    assert.match(result.stdout, /systemd restart did not report success; checking vibe-research-test\.service status/);
    assert.match(result.stdout, /Vibe Research is running; vibe-research-test\.service is enabled but still settling/);
    assert.doesNotMatch(result.stdout, /Could not start systemd service/);
    assert.deepEqual((await readFile(systemctlLog, "utf8")).trim().split("\n"), [
      "cat vibe-research-test.service",
      "stop vibe-research-test.service",
      "is-system-running",
      "daemon-reload",
      "enable vibe-research-test.service",
      "restart vibe-research-test.service",
      "is-active --quiet vibe-research-test.service",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh skips service install when systemctl reports offline", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-systemd-offline-"));
  const installDir = path.join(installRoot, "vibe-research");
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
    await writeFile(path.join(fakeBin, "sudo"), fakeSudoScript);
    await execFile("chmod", ["+x", ...["uname", "systemctl", "sudo"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_INSTALL_SERVICE: "1",
        VIBE_RESEARCH_SYSTEMD_SERVICE_DIR: serviceDir,
      }),
    });

    assert.match(result.stdout, /SOURCE_VERSION=v1/);
    assert.match(result.stdout, /Skipping service install because systemd is not available/);
    await assert.rejects(() => stat(path.join(serviceDir, "vibe-research.service")));
    assert.deepEqual((await readFile(systemctlLog, "utf8")).trim().split("\n"), [
      "cat vibe-research.service",
      "is-system-running",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh does not ask sudo while checking for an absent systemd service", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-systemd-no-sudo-prompt-"));
  const installDir = path.join(installRoot, "vibe-research");
  const fakeBin = path.join(installRoot, "bin");
  const serviceDir = path.join(installRoot, "systemd");
  const systemctlLog = path.join(installRoot, "systemctl.log");
  const sudoLog = path.join(installRoot, "sudo.log");

  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(serviceDir, { recursive: true });
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Linux\\n'\n");
    await writeFile(
      path.join(fakeBin, "systemctl"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}
if [ "\${1:-}" = "cat" ]; then
  exit 1
fi
if [ "\${1:-}" = "is-system-running" ]; then
  printf 'offline\\n'
  exit 1
fi
exit 1
`,
    );
    await writeFile(
      path.join(fakeBin, "sudo"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${JSON.stringify(sudoLog)}
exit 99
`,
    );
    await execFile("chmod", ["+x", ...["uname", "systemctl", "sudo"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_INSTALL_SERVICE: "1",
        VIBE_RESEARCH_SKIP_RUN: "1",
        VIBE_RESEARCH_SYSTEMD_SERVICE_DIR: serviceDir,
      }),
    });

    assert.doesNotMatch(result.stdout, /Stopping existing systemd service/);
    assert.match(result.stdout, /Skipping service install because systemd is not available/);
    assert.deepEqual((await readFile(systemctlLog, "utf8")).trim().split("\n"), [
      "cat vibe-research.service",
      "is-system-running",
    ]);
    await assert.rejects(() => stat(sudoLog));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("install.sh skips service setup when sudo would require a password", async () => {
  const { tempRoot, repoDir } = await createSourceRepo();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-systemd-sudo-password-"));
  const installDir = path.join(installRoot, "vibe-research");
  const fakeBin = path.join(installRoot, "bin");
  const serviceDir = path.join(installRoot, "systemd");
  const systemctlLog = path.join(installRoot, "systemctl.log");
  const sudoLog = path.join(installRoot, "sudo.log");

  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(serviceDir, { recursive: true });
    await writeFile(path.join(fakeBin, "uname"), "#!/usr/bin/env sh\nprintf 'Linux\\n'\n");
    await writeFile(
      path.join(fakeBin, "systemctl"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}
if [ "\${1:-}" = "cat" ]; then
  exit 1
fi
if [ "\${1:-}" = "is-system-running" ]; then
  printf 'running\\n'
  exit 0
fi
exit 1
`,
    );
    await writeFile(
      path.join(fakeBin, "sudo"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${JSON.stringify(sudoLog)}
if [ "\${1:-}" = "-n" ]; then
  exit 1
fi
exit 99
`,
    );
    await execFile("chmod", ["+x", ...["uname", "systemctl", "sudo"].map((name) => path.join(fakeBin, name))]);

    const result = await execFile("bash", [installScript], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoDir,
        VIBE_RESEARCH_INSTALL_SERVICE: "1",
        VIBE_RESEARCH_SKIP_RUN: "1",
        VIBE_RESEARCH_SYSTEMD_SERVICE_DIR: serviceDir,
      }),
    });

    assert.match(result.stdout, /Skipping service install because sudo is not available without a password/);
    await assert.rejects(() => stat(path.join(serviceDir, "vibe-research.service")));
    assert.deepEqual((await readFile(systemctlLog, "utf8")).trim().split("\n"), [
      "cat vibe-research.service",
      "is-system-running",
    ]);
    assert.deepEqual((await readFile(sudoLog, "utf8")).trim().split("\n"), ["-n true"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("start.sh refuses to reuse a different workspace already running on the requested port", async () => {
  const { tempRoot, repoDir } = await createWorkingTreeRepoSnapshot();
  const port = await getFreePort();
  const foreignWorkspace = path.join(os.tmpdir(), "vibe-research-foreign-workspace");
  const foreignServer = http.createServer((request, response) => {
    if (request.url === "/api/state") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ appName: "Vibe Research", cwd: foreignWorkspace }));
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
            VIBE_RESEARCH_PORT: String(port),
            VIBE_RESEARCH_READY_TIMEOUT_SECONDS: "1",
            VIBE_RESEARCH_STATE_DIR: path.join(tempRoot, "state"),
            VIBE_RESEARCH_WIKI_DIR: path.join(tempRoot, "mac-brain"),
          }),
        }),
      (error) => {
        const combinedOutput = `${error.stdout || ""}${error.stderr || ""}`;
        assert.match(
          combinedOutput,
          new RegExp(
            `Port ${port} is already serving Vibe Research from ${escapeRegExp(foreignWorkspace)}`,
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
      response.end(JSON.stringify({ appName: "Vibe Research", cwd: canonicalRepoDir, stateDir: oldStateDir }));
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
        VIBE_RESEARCH_PORT: String(port),
        VIBE_RESEARCH_READY_TIMEOUT_SECONDS: "30",
        VIBE_RESEARCH_STATE_DIR: newStateDir,
        VIBE_RESEARCH_WIKI_DIR: path.join(tempRoot, "mac-brain"),
      }),
      timeout: 60_000,
    });
    const combinedOutput = `${result.stdout}${result.stderr}`;

    assert.equal(terminateRequested, true);
    assert.match(combinedOutput, new RegExp(`relaunching with ${escapeRegExp(newStateDir)}`));

    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.appName, "Vibe Research");
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
      response.end(JSON.stringify({ appName: "Vibe Research", cwd: canonicalRepoDir, stateDir }));
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
        VIBE_RESEARCH_PORT: String(port),
        VIBE_RESEARCH_READY_TIMEOUT_SECONDS: "1",
        VIBE_RESEARCH_STATE_DIR: stateDir,
        VIBE_RESEARCH_WIKI_DIR: path.join(tempRoot, "mac-brain"),
      }),
      timeout: 15_000,
    });
    const combinedOutput = `${result.stdout}${result.stderr}`;

    assert.equal(terminateRequested, false);
    assert.match(combinedOutput, /Vibe Research is already running for this workspace/);

    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.appName, "Vibe Research");
    assert.equal(payload.cwd, canonicalRepoDir);
    assert.equal(payload.stateDir, stateDir);
  } finally {
    await new Promise((resolve) => runningServer.close(() => resolve()));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("start.sh retries dependency install after a transient npm network failure", async () => {
  const { tempRoot, repoDir } = await createWorkingTreeRepoSnapshot();
  const canonicalRepoDir = await realpath(repoDir);
  const port = await getFreePort();
  const fakeBin = path.join(tempRoot, "bin");
  const npmLog = path.join(tempRoot, "npm.log");
  const curlLog = path.join(tempRoot, "curl.log");
  const npmAttemptState = path.join(tempRoot, "npm-attempts");
  const npmCacheState = path.join(tempRoot, "npm-cache-warmed");
  const stateDir = path.join(tempRoot, "state");
  const realCurl = (await execFile("bash", ["-lc", "command -v curl"])).stdout.trim();

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(repoDir, "scripts", "build-client.mjs"), "console.log('build skipped for npm retry test');\n");
    await writeFile(
      path.join(repoDir, "src", "server.js"),
      `import http from "node:http";

const port = Number(process.env.VIBE_RESEARCH_PORT || process.env.REMOTE_VIBES_PORT || 4123);
const server = http.createServer((request, response) => {
  if (request.url === "/api/state") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      appName: "Vibe Research",
      cwd: process.cwd(),
      stateDir: process.env.VIBE_RESEARCH_STATE_DIR,
    }));
    return;
  }

  if (request.url === "/api/terminate" && request.method === "POST") {
    response.setHeader("Content-Type", "application/json");
    response.end("{}");
    setImmediate(() => server.close(() => process.exit(0)));
    return;
  }

  response.statusCode = 404;
  response.end("not found");
});

server.listen(port, "127.0.0.1");
`,
    );
    await writeFile(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-v" ] || [ "\${1:-}" = "--version" ]; then
  printf '10.9.7\\n'
  exit 0
fi
printf '%s\\n' "$*" >> ${JSON.stringify(npmLog)}
if [ "\${1:-}" = "cache" ] && [ "\${2:-}" = "add" ]; then
  case "\${3:-}" in
    *node-pty*)
      : > ${JSON.stringify(npmCacheState)}
      ;;
  esac
  exit 0
fi
if [ "\${1:-}" != "ci" ]; then
  printf 'unexpected npm command: %s\\n' "$*" >&2
  exit 64
fi
attempt=0
if [ -f ${JSON.stringify(npmAttemptState)} ]; then
  attempt="$(cat ${JSON.stringify(npmAttemptState)})"
fi
attempt=$((attempt + 1))
printf '%s\\n' "$attempt" > ${JSON.stringify(npmAttemptState)}
if [ "$attempt" -eq 1 ]; then
  printf 'npm error code ETIMEDOUT\\n' >&2
  printf 'npm error network read ETIMEDOUT\\n' >&2
  exit 110
fi
if [ ! -f ${JSON.stringify(npmCacheState)} ]; then
  printf 'expected node-pty tarball to be warmed before retry\\n' >&2
  exit 65
fi
mkdir -p node_modules/playwright-core
printf '{}\\n' > node_modules/playwright-core/package.json
mkdir -p node_modules/esbuild
printf '{}\\n' > node_modules/esbuild/package.json
mkdir -p node_modules/node-pty
printf '{}\\n' > node_modules/node-pty/package.json
`,
    );
    await writeFile(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--help" ]; then
  printf '%s\\n' '--retry-all-errors'
  exit 0
fi
for arg in "$@"; do
  case "$arg" in
    http://127.0.0.1*|http://localhost*)
      exec ${JSON.stringify(realCurl)} "$@"
      ;;
  esac
done
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    --retry|--connect-timeout|--max-time)
      shift 2
      ;;
    -fL|--retry-all-errors)
      shift
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
  https://registry.npmjs.org/*)
    printf '%s\\n' "$url" >> ${JSON.stringify(curlLog)}
    mkdir -p "$(dirname "$output")"
    printf 'fake tarball for %s\\n' "$url" > "$output"
    ;;
  *)
    printf 'unexpected curl URL: %s\\n' "$url" >&2
    exit 64
    ;;
esac
`,
    );
    await execFile("chmod", ["+x", path.join(fakeBin, "npm"), path.join(fakeBin, "curl")]);

    const result = await execFile("bash", [path.join(repoDir, "start.sh")], {
      env: installTestEnv({
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        VIBE_RESEARCH_PORT: String(port),
        VIBE_RESEARCH_READY_TIMEOUT_SECONDS: "30",
        VIBE_RESEARCH_STATE_DIR: stateDir,
        VIBE_RESEARCH_WIKI_DIR: path.join(tempRoot, "mac-brain"),
        VIBE_RESEARCH_NPM_INSTALL_ATTEMPTS: "2",
        VIBE_RESEARCH_NPM_INSTALL_RETRY_DELAY_SECONDS: "0",
        VIBE_RESEARCH_NPM_TARBALL_PREFETCH_PACKAGES: "node-pty",
      }),
      timeout: 60_000,
    });
    const combinedOutput = `${result.stdout}${result.stderr}`;

    assert.match(combinedOutput, /Installing dependencies/);
    assert.match(combinedOutput, /npm error network read ETIMEDOUT/);
    assert.match(combinedOutput, /Warming npm cache for large dependency tarballs/);
    assert.match(combinedOutput, /Fetching node-pty tarball with curl/);
    assert.match(combinedOutput, /Dependency install failed; retrying \(2\/2\)/);

    const npmCommands = (await readFile(npmLog, "utf8")).trim().split("\n");
    const npmCiCommands = npmCommands.filter((command) => command.startsWith("ci "));
    assert.equal(npmCiCommands.length, 2);
    assert.ok(npmCiCommands.every((command) => command.startsWith("ci --prefer-offline --no-audit --no-fund --fetch-retries 5 ")));
    assert.ok(npmCiCommands.every((command) => command.includes("--fetch-retry-mintimeout 20000")));
    assert.ok(npmCiCommands.every((command) => command.includes("--fetch-retry-maxtimeout 120000")));
    assert.ok(npmCiCommands.every((command) => command.includes("--fetch-timeout 300000")));
    assert.ok(npmCommands.some((command) => /cache add .*node-pty.*\.tgz/.test(command)));
    assert.match(await readFile(curlLog, "utf8"), /https:\/\/registry\.npmjs\.org\/@lydell\/node-pty\/-\/node-pty-1\.2\.0-beta\.12\.tgz/);

    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.appName, "Vibe Research");
    assert.equal(payload.cwd, canonicalRepoDir);
    assert.equal(payload.stateDir, stateDir);
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

test("install.sh can launch vibe research in one command", async () => {
  const { tempRoot, repoDir } = await createWorkingTreeRepoSnapshot();
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "vibe-research-launch-"));
  const installDir = path.join(installRoot, "vibe-research");
  const port = await getFreePort();
  const repoUrl = repoDir;
  let child;
  let combinedOutput = "";

  try {
    child = spawn("bash", [installScript], {
      cwd: rootDir,
      env: installTestEnv({
        VIBE_RESEARCH_HOME: installDir,
        VIBE_RESEARCH_REPO_URL: repoUrl,
        VIBE_RESEARCH_BIN_DIR: path.join(installRoot, "bin"),
        VIBE_RESEARCH_PORT: String(port),
        VIBE_RESEARCH_STATE_DIR: path.join(installRoot, "state"),
        VIBE_RESEARCH_WIKI_DIR: path.join(installRoot, "mac-brain"),
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
    assert.match(combinedOutput, /OPEN VIBE RESEARCH/);
    assert.match(combinedOutput, new RegExp(`http://localhost:${port}`));
    assert.match(combinedOutput, /\u001b]8;;http:\/\//);
    assert.ok(
      combinedOutput.lastIndexOf("OPEN VIBE RESEARCH") > combinedOutput.lastIndexOf("Background server pid:"),
    );
    assert.match(combinedOutput, new RegExp(`State directory: ${escapeRegExp(path.join(installRoot, "state"))}`));
    assert.match(combinedOutput, new RegExp(`Library directory: ${escapeRegExp(path.join(installRoot, "mac-brain"))}`));
    assert.ok(await stat(path.join(installRoot, "state", ".git")));
    assert.ok(await stat(path.join(installRoot, "mac-brain", ".git")));

    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.appName, "Vibe Research");
    assert.equal(payload.stateDir, path.join(installRoot, "state"));
    assert.equal(payload.settings.wikiPathConfigured, true);
    assert.equal(payload.settings.wikiPath, path.join(installRoot, "mac-brain"));

    const pidMatch = combinedOutput.match(/Background server pid: (\d+)/);
    assert.ok(pidMatch);
    process.kill(Number(pidMatch[1]), "SIGHUP");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const afterHangupResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(afterHangupResponse.status, 200);
    const afterHangupPayload = await afterHangupResponse.json();
    assert.equal(afterHangupPayload.appName, "Vibe Research");
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
  const homeVibeResearchDir = path.join(homeDir, ".vibe-research");
  const port = await getFreePort();

  try {
    await mkdir(path.join(homeVibeResearchDir, "src"), { recursive: true });
    await writeFile(path.join(homeVibeResearchDir, "package.json"), "{}\n");
    await writeFile(path.join(homeVibeResearchDir, "start.sh"), "#!/usr/bin/env bash\n");
    await writeFile(path.join(homeVibeResearchDir, "src", "server.js"), "console.log('old checkout');\n");

    await mkdir(path.join(homeVibeResearchDir, "state"), { recursive: true });
    await writeFile(path.join(homeVibeResearchDir, "state", "agent-prompt.md"), "remember root state\n");
    await mkdir(path.join(homeVibeResearchDir, ".vibe-research"), { recursive: true });
    await writeFile(path.join(homeVibeResearchDir, ".vibe-research", "sessions.json"), "{\"sessions\":[]}\n");
    await mkdir(path.join(repoDir, ".vibe-research"), { recursive: true });
    await writeFile(path.join(repoDir, ".vibe-research", "port-aliases.json"), "{\"aliases\":{}}\n");

    const result = await execFile("bash", [path.join(repoDir, "start.sh")], {
      env: installTestEnv({
        HOME: homeDir,
        VIBE_RESEARCH_PORT: String(port),
        VIBE_RESEARCH_READY_TIMEOUT_SECONDS: "30",
      }),
      timeout: 60_000,
    });
    const combinedOutput = `${result.stdout}${result.stderr}`;

    assert.match(combinedOutput, /Moving old Vibe Research checkout/);
    assert.match(
      combinedOutput,
      new RegExp(`State directory: ${escapeRegExp(homeVibeResearchDir)}`),
    );
    assert.ok(await stat(path.join(homeVibeResearchDir, "app", "package.json")));
    assert.ok(await stat(path.join(homeVibeResearchDir, "app", "src", "server.js")));
    assert.ok(await stat(path.join(homeVibeResearchDir, ".git")));
    const migratedPrompt = await readFile(path.join(homeVibeResearchDir, "agent-prompt.md"), "utf8");
    assert.match(migratedPrompt, /^remember root state\n/);
    assert.match(migratedPrompt, /vibe-research:library-v2-protocol:v2/);
    const sessionsPayload = JSON.parse(await readFile(path.join(homeVibeResearchDir, "sessions.json"), "utf8"));
    assert.deepEqual(sessionsPayload.sessions, []);
    assert.equal(
      await readFile(path.join(homeVibeResearchDir, "port-aliases.json"), "utf8"),
      "{\"aliases\":{}}\n",
    );
    assert.match(await readFile(path.join(homeVibeResearchDir, ".gitignore"), "utf8"), /^app\/$/m);
    assert.match(await readFile(path.join(homeVibeResearchDir, ".gitignore"), "utf8"), /^state\/$/m);

    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.appName, "Vibe Research");
    assert.equal(payload.stateDir, homeVibeResearchDir);
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

test("start.sh migrates a Remote Vibes home checkout and state into Vibe Research", async () => {
  const { tempRoot, repoDir } = await createWorkingTreeRepoSnapshot();
  const homeDir = path.join(tempRoot, "home");
  const legacyRemoteVibesDir = path.join(homeDir, ".remote-vibes");
  const homeVibeResearchDir = path.join(homeDir, ".vibe-research");
  const port = await getFreePort();

  try {
    await mkdir(path.join(legacyRemoteVibesDir, "src"), { recursive: true });
    await writeFile(path.join(legacyRemoteVibesDir, "package.json"), "{}\n");
    await writeFile(path.join(legacyRemoteVibesDir, "start.sh"), "#!/usr/bin/env bash\n");
    await writeFile(path.join(legacyRemoteVibesDir, "src", "server.js"), "console.log('old checkout');\n");
    await writeFile(path.join(legacyRemoteVibesDir, "agent-prompt.md"), "# Old Remote Vibes Prompt\n");
    await writeFile(path.join(legacyRemoteVibesDir, "sessions.json"), "{\"sessions\":[]}\n");
    await mkdir(path.join(legacyRemoteVibesDir, ".remote-vibes"), { recursive: true });
    await writeFile(path.join(legacyRemoteVibesDir, ".remote-vibes", "port-aliases.json"), "{\"aliases\":{\"api\":4123}}\n");

    const result = await execFile("bash", [path.join(repoDir, "start.sh")], {
      env: installTestEnv({
        HOME: homeDir,
        VIBE_RESEARCH_PORT: String(port),
        VIBE_RESEARCH_READY_TIMEOUT_SECONDS: "30",
      }),
      timeout: 60_000,
    });
    const combinedOutput = `${result.stdout}${result.stderr}`;

    assert.match(combinedOutput, /Moving old Remote Vibes checkout/);
    assert.match(
      combinedOutput,
      new RegExp(`State directory: ${escapeRegExp(homeVibeResearchDir)}`),
    );
    assert.ok(await stat(path.join(homeVibeResearchDir, "app", "package.json")));
    assert.ok(await stat(path.join(homeVibeResearchDir, "app", "src", "server.js")));
    const migratedPrompt = await readFile(path.join(homeVibeResearchDir, "agent-prompt.md"), "utf8");
    assert.match(migratedPrompt, /^# Old Remote Vibes Prompt\n/);
    assert.match(migratedPrompt, /vibe-research:library-v2-protocol:v2/);
    assert.equal(
      await readFile(path.join(homeVibeResearchDir, "port-aliases.json"), "utf8"),
      "{\"aliases\":{\"api\":4123}}\n",
    );
    const sessionsPayload = JSON.parse(await readFile(path.join(homeVibeResearchDir, "sessions.json"), "utf8"));
    assert.deepEqual(sessionsPayload.sessions, []);

    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.appName, "Vibe Research");
    assert.equal(payload.stateDir, homeVibeResearchDir);
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
