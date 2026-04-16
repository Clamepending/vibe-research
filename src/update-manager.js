import { execFile as execFileCallback, spawn as spawnCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);
const DEFAULT_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;

function trim(value) {
  return String(value ?? "").trim();
}

function shortCommit(commit) {
  return commit ? commit.slice(0, 7) : "";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function parseLsRemoteHead(stdout) {
  const [commit] = trim(stdout).split(/\s+/);
  return /^[0-9a-f]{40}$/i.test(commit) ? commit : "";
}

export function getGitHubHttpsRemoteUrl(remoteUrl) {
  const value = trim(remoteUrl);

  if (!value) {
    return "";
  }

  if (/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/i.test(value)) {
    return value.endsWith(".git") ? value : `${value}.git`;
  }

  const scpLikeMatch = value.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (scpLikeMatch) {
    return `https://github.com/${scpLikeMatch[1]}.git`;
  }

  const sshMatch = value.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}.git`;
  }

  return "";
}

function getStatusLabel({ updateAvailable, canUpdate, reason }) {
  if (!updateAvailable) {
    return "current";
  }

  return canUpdate ? "available" : reason ? "blocked" : "available";
}

export class UpdateManager {
  constructor({
    cwd = process.cwd(),
    stateDir = path.join(cwd, ".remote-vibes"),
    remote = process.env.REMOTE_VIBES_UPDATE_REMOTE || "origin",
    branch = process.env.REMOTE_VIBES_UPDATE_BRANCH || process.env.REMOTE_VIBES_REF || "main",
    cacheMs = DEFAULT_CACHE_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    execFile = execFileAsync,
    spawn = spawnCallback,
    env = process.env,
    port = Number(process.env.REMOTE_VIBES_PORT || 4123),
  } = {}) {
    this.cwd = cwd;
    this.stateDir = stateDir;
    this.remote = remote;
    this.branch = branch;
    this.cacheMs = cacheMs;
    this.timeoutMs = timeoutMs;
    this.execFile = execFile;
    this.spawn = spawn;
    this.env = env;
    this.port = port;
    this.cachedStatus = null;
    this.cachedAt = 0;
  }

  setRuntime({ port } = {}) {
    if (Number.isInteger(port) && port > 0) {
      this.port = port;
    }
  }

  async git(args, options = {}) {
    return this.execFile("git", ["-C", this.cwd, ...args], {
      timeout: this.timeoutMs,
      maxBuffer: 1024 * 1024,
      ...options,
      env: {
        ...this.env,
        ...(options.env || {}),
      },
    });
  }

  async getStatus({ force = false } = {}) {
    const now = Date.now();

    if (!force && this.cachedStatus && now - this.cachedAt < this.cacheMs) {
      return this.cachedStatus;
    }

    const status = await this.computeStatus();
    this.cachedStatus = status;
    this.cachedAt = now;
    return status;
  }

  async computeStatus() {
    const checkedAt = new Date().toISOString();

    try {
      const inside = await this.git(["rev-parse", "--is-inside-work-tree"]);
      if (trim(inside.stdout) !== "true") {
        return {
          supported: false,
          status: "unsupported",
          updateAvailable: false,
          canUpdate: false,
          checkedAt,
          reason: "Remote Vibes is not running from a git checkout.",
        };
      }

      const [currentCommitResult, branchResult, remoteUrlResult, dirtyResult] =
        await Promise.all([
          this.git(["rev-parse", "HEAD"]),
          this.git(["branch", "--show-current"]).catch(() => ({ stdout: "" })),
          this.git(["config", "--get", `remote.${this.remote}.url`]).catch(() => ({ stdout: "" })),
          this.git(["status", "--porcelain"]),
        ]);

      const currentCommit = trim(currentCommitResult.stdout);
      const currentBranch = trim(branchResult.stdout);
      const remoteUrl = trim(remoteUrlResult.stdout);
      const latest = await this.readLatestCommit(remoteUrl);
      const latestCommit = latest.commit;
      const dirty = Boolean(trim(dirtyResult.stdout));

      if (!latestCommit) {
        return {
          supported: true,
          status: "error",
          updateAvailable: false,
          canUpdate: false,
          checkedAt,
          remote: this.remote,
          branch: this.branch,
          remoteUrl,
          updateSource: latest.source,
          currentBranch,
          currentCommit,
          currentShort: shortCommit(currentCommit),
          reason: `Could not find ${this.remote}/${this.branch}.`,
        };
      }

      const updateAvailable = Boolean(currentCommit && latestCommit && currentCommit !== latestCommit);
      let reason = "";

      if (updateAvailable && dirty) {
        reason = "Local changes are present, so the updater will not overwrite this checkout.";
      } else if (updateAvailable && !currentBranch) {
        reason = `This checkout is detached; the updater only updates ${this.branch}.`;
      } else if (updateAvailable && currentBranch && currentBranch !== this.branch) {
        reason = `This checkout is on ${currentBranch}; the updater only updates ${this.branch}.`;
      }

      const canUpdate = updateAvailable && !reason;

      return {
        supported: true,
        status: getStatusLabel({ updateAvailable, canUpdate, reason }),
        updateAvailable,
        canUpdate,
        checkedAt,
        remote: this.remote,
        branch: this.branch,
        remoteUrl,
        updateSource: latest.source,
        currentBranch,
        currentCommit,
        currentShort: shortCommit(currentCommit),
        latestCommit,
        latestShort: shortCommit(latestCommit),
        dirty,
        reason,
      };
    } catch (error) {
      return {
        supported: false,
        status: "error",
        updateAvailable: false,
        canUpdate: false,
        checkedAt,
        remote: this.remote,
        branch: this.branch,
        reason: error.message || "Could not check for updates.",
      };
    }
  }

  async readLatestCommit(remoteUrl) {
    const candidates = [this.remote];
    const githubHttpsRemoteUrl = getGitHubHttpsRemoteUrl(remoteUrl);

    if (githubHttpsRemoteUrl && githubHttpsRemoteUrl !== this.remote) {
      candidates.push(githubHttpsRemoteUrl);
    }

    let lastError = null;
    for (const candidate of candidates) {
      try {
        const result = await this.git(["ls-remote", candidate, `refs/heads/${this.branch}`]);
        const commit = parseLsRemoteHead(result.stdout);

        if (commit) {
          return { commit, source: candidate };
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    return { commit: "", source: candidates.at(-1) || this.remote };
  }

  async scheduleUpdateAndRestart() {
    const status = await this.getStatus({ force: true });

    if (!status.updateAvailable) {
      const error = new Error("Remote Vibes is already up to date.");
      error.statusCode = 409;
      error.update = status;
      throw error;
    }

    if (!status.canUpdate) {
      const error = new Error(status.reason || "This checkout cannot be updated automatically.");
      error.statusCode = 409;
      error.update = status;
      throw error;
    }

    fs.mkdirSync(this.stateDir, { recursive: true });
    const logPath = path.join(this.stateDir, "update.log");
    const logFd = fs.openSync(logPath, "a");
    const script = this.buildUpdateScript({ updateSource: status.updateSource || this.remote });
    const shell = this.env.SHELL || "/bin/sh";
    const child = this.spawn(shell, ["-lc", script], {
      cwd: this.cwd,
      detached: true,
      env: {
        ...this.env,
        REMOTE_VIBES_PORT: String(this.port),
        REMOTE_VIBES_STATE_DIR: this.stateDir,
      },
      stdio: ["ignore", logFd, logFd],
    });

    child.unref();
    fs.closeSync(logFd);

    return {
      ok: true,
      scheduled: true,
      logPath,
      update: status,
    };
  }

  buildUpdateScript({ updateSource = this.remote } = {}) {
    const cwd = shellQuote(this.cwd);
    const remote = shellQuote(updateSource);
    const branch = shellQuote(this.branch);
    const stateUrl = shellQuote(`http://127.0.0.1:${this.port}/api/state`);
    const terminateUrl = shellQuote(`http://127.0.0.1:${this.port}/api/terminate`);

    return `
set -euo pipefail
echo "[remote-vibes-update] starting $(date)"
cd ${cwd}
git pull --ff-only ${remote} ${branch}
echo "[remote-vibes-update] update pulled; stopping current server"
curl -fsS -X POST ${terminateUrl} >/dev/null 2>&1 || true
for attempt in $(seq 1 100); do
  if ! curl -fsS ${stateUrl} >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
echo "[remote-vibes-update] restarting"
exec ./start.sh
`;
  }
}
