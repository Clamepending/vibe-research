import { execFile as execFileCallback, spawn as spawnCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);
const DEFAULT_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_UPDATE_CHANNEL = "release";
const MANAGED_PROMPT_MARKER = "<!-- vibe-research:managed-agent-prompt -->";
const LEGACY_MANAGED_PROMPT_MARKER = "<!-- remote-vibes:managed-agent-prompt -->";
const MANAGED_PROMPT_MARKERS = [MANAGED_PROMPT_MARKER, LEGACY_MANAGED_PROMPT_MARKER];
const MANAGED_PROMPT_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];
const MANAGED_PROMPT_FILE_SET = new Set(MANAGED_PROMPT_FILES);
const GENERATED_DIRTY_PATHS = new Set([".playwright-cli", ".playwright-cli/", "output", "output/"]);
const NON_GIT_CHECKOUT_REASON =
  "Automatic updates are unavailable because Vibe Research is not running from a git checkout.";

function trim(value) {
  return String(value ?? "").trim();
}

function shortCommit(commit) {
  return commit ? commit.slice(0, 7) : "";
}

function normalizeVersionTag(version) {
  const value = trim(version);
  if (!value) {
    return "";
  }

  return value.startsWith("v") ? value : `v${value}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function parseLsRemoteHead(stdout) {
  const [commit] = trim(stdout).split(/\s+/);
  return /^[0-9a-f]{40}$/i.test(commit) ? commit : "";
}

function parseLsRemoteRef(stdout, preferredRef) {
  const lines = trim(stdout).split(/\r?\n/).filter(Boolean);
  const parsed = lines
    .map((line) => {
      const [commit, ref] = line.split(/\s+/);
      return /^[0-9a-f]{40}$/i.test(commit) && ref ? { commit, ref } : null;
    })
    .filter(Boolean);

  return (
    parsed.find((entry) => entry.ref === `${preferredRef}^{}`)?.commit ||
    parsed.find((entry) => entry.ref === preferredRef)?.commit ||
    parsed[0]?.commit ||
    ""
  );
}

function parseVersionTag(tag) {
  const match = trim(tag).match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map((part) => Number(part)) : null;
}

function compareVersionParts(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function parseLsRemoteTags(stdout) {
  const tags = new Map();
  for (const line of trim(stdout).split(/\r?\n/).filter(Boolean)) {
    const [commit, rawRef] = line.split(/\s+/);
    if (!/^[0-9a-f]{40}$/i.test(commit) || !rawRef?.startsWith("refs/tags/")) {
      continue;
    }

    const peeled = rawRef.endsWith("^{}");
    const ref = peeled ? rawRef.slice(0, -3) : rawRef;
    const tag = ref.replace(/^refs\/tags\//, "");
    const versionParts = parseVersionTag(tag);
    if (!versionParts) {
      continue;
    }

    const entry = tags.get(tag) || { tag, versionParts, commit: "", peeledCommit: "" };
    if (peeled) {
      entry.peeledCommit = commit;
    } else {
      entry.commit = commit;
    }
    tags.set(tag, entry);
  }

  return [...tags.values()]
    .map((entry) => ({ ...entry, commit: entry.peeledCommit || entry.commit }))
    .filter((entry) => entry.commit)
    .sort((left, right) => compareVersionParts(right.versionParts, left.versionParts))[0];
}

function parseStatusPath(line) {
  const rawPath = line.slice(3).trim();
  const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1).trim() : rawPath;

  if (renamedPath.startsWith('"') && renamedPath.endsWith('"')) {
    try {
      return JSON.parse(renamedPath);
    } catch {
      return renamedPath.slice(1, -1);
    }
  }

  return renamedPath;
}

function parseGitStatusPorcelain(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2),
      path: parseStatusPath(line),
    }))
    .filter((entry) => entry.path);
}

function isGeneratedDirtyPath(filePath) {
  const normalized = String(filePath ?? "").replaceAll("\\", "/");
  return GENERATED_DIRTY_PATHS.has(normalized) || normalized.startsWith(".playwright-cli/") || normalized.startsWith("output/");
}

function parseGitHubRepo(remoteUrl) {
  const httpsUrl = getGitHubHttpsRemoteUrl(remoteUrl);
  const match = httpsUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);

  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    httpsUrl,
  };
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

function isNotGitRepositoryError(error) {
  const message = `${error?.stderr || ""}\n${error?.message || ""}`;
  return /not a git repository|not a git work tree/i.test(message);
}

export class UpdateManager {
  constructor({
    cwd = process.cwd(),
    stateDir = path.join(cwd, ".vibe-research"),
    remote = process.env.VIBE_RESEARCH_UPDATE_REMOTE || process.env.REMOTE_VIBES_UPDATE_REMOTE || "origin",
    branch =
      process.env.VIBE_RESEARCH_UPDATE_BRANCH ||
      process.env.REMOTE_VIBES_UPDATE_BRANCH ||
      process.env.VIBE_RESEARCH_REF ||
      process.env.REMOTE_VIBES_REF ||
      "main",
    cacheMs = DEFAULT_CACHE_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    execFile = execFileAsync,
    spawn = spawnCallback,
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    env = process.env,
    port = Number(process.env.VIBE_RESEARCH_PORT || process.env.REMOTE_VIBES_PORT || 4123),
    channel = env.VIBE_RESEARCH_UPDATE_CHANNEL || env.REMOTE_VIBES_UPDATE_CHANNEL || DEFAULT_UPDATE_CHANNEL,
  } = {}) {
    this.cwd = cwd;
    this.stateDir = stateDir;
    this.remote = remote;
    this.branch = branch;
    this.channel = channel;
    this.cacheMs = cacheMs;
    this.timeoutMs = timeoutMs;
    this.execFile = execFile;
    this.spawn = spawn;
    this.fetch = fetchImpl;
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
      let inside;
      try {
        inside = await this.git(["rev-parse", "--is-inside-work-tree"]);
      } catch (error) {
        if (isNotGitRepositoryError(error)) {
          return this.createUnsupportedStatus(checkedAt);
        }
        throw error;
      }

      if (trim(inside.stdout) !== "true") {
        return this.createUnsupportedStatus(checkedAt);
      }

      const [currentCommitResult, branchResult, remoteUrlResult] =
        await Promise.all([
          this.git(["rev-parse", "HEAD"]),
          this.git(["branch", "--show-current"]).catch(() => ({ stdout: "" })),
          this.git(["config", "--get", `remote.${this.remote}.url`]).catch(() => ({ stdout: "" })),
        ]);

      const currentCommit = trim(currentCommitResult.stdout);
      const currentBranch = trim(branchResult.stdout);
      const remoteUrl = trim(remoteUrlResult.stdout);
      const [latest, currentTagResult] = await Promise.all([
        this.readLatestTarget(remoteUrl),
        this.git(["describe", "--tags", "--exact-match", "HEAD"]).catch(() => ({ stdout: "" })),
      ]);
      const latestCommit = latest.commit;
      const currentTag = trim(currentTagResult.stdout);
      const currentVersion = this.readCurrentVersion();

      if (!latestCommit) {
        return {
          supported: true,
          status: "error",
          updateAvailable: false,
          canUpdate: false,
          checkedAt,
          remote: this.remote,
          branch: this.branch,
          channel: this.channel,
          remoteUrl,
          updateSource: latest.source,
          targetType: latest.targetType,
          currentBranch,
          currentCommit,
          currentShort: shortCommit(currentCommit),
          currentTag,
          currentVersion,
          reason: `Could not find a GitHub Release or ${this.remote}/${this.branch}.`,
        };
      }

      let updateAvailable = Boolean(currentCommit && latestCommit && currentCommit !== latestCommit);
      const aheadOfTarget =
        updateAvailable && latest.targetType === "release"
          ? await this.isCommitAncestor(latestCommit, currentCommit)
          : false;
      if (aheadOfTarget) {
        updateAvailable = false;
      }
      const restoredManagedPromptFiles = updateAvailable ? await this.restoreManagedPromptFiles() : [];
      const dirtyResult = await this.git(["status", "--porcelain"]);
      const dirtyState = await this.readDirtyState(dirtyResult.stdout);
      let reason = "";

      if (latest.targetType === "branch" && updateAvailable && !currentBranch) {
        reason = `This checkout is detached; the updater only updates ${this.branch}.`;
      } else if (latest.targetType === "branch" && updateAvailable && currentBranch && currentBranch !== this.branch) {
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
        channel: this.channel,
        remoteUrl,
        updateSource: latest.source,
        targetType: latest.targetType,
        currentBranch,
        currentCommit,
        currentShort: shortCommit(currentCommit),
        currentTag,
        currentVersion,
        latestCommit,
        latestShort: shortCommit(latestCommit),
        latestTag: latest.tag,
        latestVersion: latest.version,
        latestName: latest.name,
        releaseUrl: latest.releaseUrl,
        releasePublishedAt: latest.publishedAt,
        releaseCheck: latest.releaseCheck,
        aheadOfTarget,
        dirty: dirtyState.dirty,
        blockingDirty: false,
        dirtyFiles: dirtyState.dirtyFiles,
        ignoredDirtyFiles: dirtyState.ignoredDirtyFiles,
        restoredManagedPromptFiles,
        reason,
      };
    } catch (error) {
      const notGitCheckout = isNotGitRepositoryError(error);

      return {
        supported: false,
        status: notGitCheckout ? "unsupported" : "error",
        updateAvailable: false,
        canUpdate: false,
        checkedAt,
        remote: this.remote,
        branch: this.branch,
        channel: this.channel,
        cwd: this.cwd,
        reason: notGitCheckout ? NON_GIT_CHECKOUT_REASON : error.message || "Could not check for updates.",
      };
    }
  }

  createUnsupportedStatus(checkedAt) {
    return {
      supported: false,
      status: "unsupported",
      updateAvailable: false,
      canUpdate: false,
      checkedAt,
      remote: this.remote,
      branch: this.branch,
      channel: this.channel,
      cwd: this.cwd,
      reason: NON_GIT_CHECKOUT_REASON,
    };
  }

  readCurrentVersion() {
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(this.cwd, "package.json"), "utf8"));
      return normalizeVersionTag(packageJson.version);
    } catch {
      return "";
    }
  }

  async readDirtyState(statusStdout) {
    const entries = parseGitStatusPorcelain(statusStdout);
    const dirtyFiles = [];
    const ignoredDirtyFiles = [];

    for (const entry of entries) {
      if (isGeneratedDirtyPath(entry.path)) {
        ignoredDirtyFiles.push(entry.path);
        continue;
      }

      if (MANAGED_PROMPT_FILE_SET.has(entry.path) && (await this.hasManagedPromptMarker(entry.path))) {
        ignoredDirtyFiles.push(entry.path);
        continue;
      }

      dirtyFiles.push(entry.path);
    }

    return {
      dirty: entries.length > 0,
      blockingDirty: dirtyFiles.length > 0,
      dirtyFiles,
      ignoredDirtyFiles,
    };
  }

  async restoreManagedPromptFiles() {
    const restoredFiles = [];

    for (const filePath of MANAGED_PROMPT_FILES) {
      if (!(await this.hasManagedPromptMarker(filePath))) {
        continue;
      }

      const status = await this.git(["status", "--porcelain", "--", filePath]).catch(() => ({ stdout: "" }));
      if (!trim(status.stdout)) {
        continue;
      }

      try {
        await this.git(["checkout", "--", filePath]);
        restoredFiles.push(filePath);
      } catch {
        // Best-effort: readDirtyState still treats managed prompt churn as non-blocking.
      }
    }

    return restoredFiles;
  }

  async hasManagedPromptMarker(filePath) {
    const absolutePath = path.join(this.cwd, filePath);

    try {
      const content = fs.readFileSync(absolutePath, "utf8");
      if (MANAGED_PROMPT_MARKERS.some((marker) => content.includes(marker))) {
        return true;
      }
    } catch {
      // Deleted managed prompt files can still be restored from HEAD.
    }

    try {
      const result = await this.git(["show", `HEAD:${filePath}`]);
      return MANAGED_PROMPT_MARKERS.some((marker) => result.stdout.includes(marker));
    } catch {
      return false;
    }
  }

  async readLatestTarget(remoteUrl) {
    let releaseCheck = "skipped";

    if (this.channel !== "branch") {
      try {
        const channelTarget = await this.readLatestReleaseChannel(remoteUrl);
        if (channelTarget?.commit) {
          return channelTarget;
        }
        releaseCheck = "channel none";
      } catch (error) {
        releaseCheck = error.message || "release channel lookup failed.";
      }

      try {
        const releaseTarget = await this.readLatestGitHubRelease(remoteUrl);
        if (releaseTarget?.commit) {
          return releaseTarget;
        }
        releaseCheck = releaseCheck === "skipped" ? "none" : `${releaseCheck}; GitHub release none`;
      } catch (error) {
        const releaseError = error.message || "GitHub release lookup failed.";
        releaseCheck = releaseCheck && releaseCheck !== "skipped" ? `${releaseCheck}; ${releaseError}` : releaseError;
      }

      try {
        const tagTarget = await this.readLatestGitTagRelease(remoteUrl, releaseCheck);
        if (tagTarget?.commit) {
          return tagTarget;
        }
      } catch (error) {
        const tagError = error.message || "git tag lookup failed.";
        releaseCheck = releaseCheck ? `${releaseCheck}; ${tagError}` : tagError;
      }
    }

    const branchTarget = await this.readLatestBranchCommit(remoteUrl);
    return {
      ...branchTarget,
      targetType: "branch",
      tag: "",
      version: "",
      name: "",
      releaseUrl: "",
      publishedAt: "",
      releaseCheck,
    };
  }

  async readLatestGitTagRelease(remoteUrl, releaseCheck = "skipped") {
    const candidates = [];
    const githubHttpsRemoteUrl = getGitHubHttpsRemoteUrl(remoteUrl);

    if (githubHttpsRemoteUrl) {
      candidates.push(githubHttpsRemoteUrl);
    }

    candidates.push(this.remote);

    let lastError = null;
    for (const candidate of [...new Set(candidates)]) {
      try {
        const result = await this.git(["ls-remote", "--tags", candidate, "refs/tags/v*"]);
        const latestTag = parseLsRemoteTags(result.stdout);

        if (latestTag?.commit) {
          const repo = parseGitHubRepo(candidate);
          return {
            commit: latestTag.commit,
            source: candidate,
            targetType: "release",
            tag: latestTag.tag,
            version: normalizeVersionTag(latestTag.tag),
            name: latestTag.tag,
            releaseUrl: repo
              ? `https://github.com/${repo.owner}/${repo.repo}/releases/tag/${encodeURIComponent(latestTag.tag)}`
              : "",
            publishedAt: "",
            releaseCheck:
              releaseCheck && releaseCheck !== "skipped"
                ? `git-tags fallback after ${releaseCheck}`
                : "git-tags",
          };
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    return null;
  }

  async readLatestReleaseChannel(remoteUrl) {
    const repo = parseGitHubRepo(remoteUrl);
    if (!repo || !this.fetch) {
      return null;
    }

    const response = await this.fetch(
      `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(this.branch)}/release-channel.json`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "vibe-research-updater",
        },
        signal:
          typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(this.timeoutMs)
            : undefined,
      },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`release channel lookup failed with HTTP ${response.status}.`);
    }

    const channel = await response.json();
    const tag = trim(channel?.tag);
    if (!tag || !parseVersionTag(tag)) {
      return null;
    }

    const commit = await this.readRemoteRefCommit(remoteUrl, `refs/tags/${tag}`);
    if (!commit) {
      return null;
    }

    return {
      commit,
      source: repo.httpsUrl,
      targetType: "release",
      tag,
      version: normalizeVersionTag(channel?.version || tag),
      name: trim(channel?.name) || tag,
      releaseUrl: trim(channel?.releaseUrl) || `https://github.com/${repo.owner}/${repo.repo}/releases/tag/${encodeURIComponent(tag)}`,
      publishedAt: trim(channel?.publishedAt),
      releaseCheck: "channel",
    };
  }

  async readLatestGitHubRelease(remoteUrl) {
    const repo = parseGitHubRepo(remoteUrl);
    if (!repo || !this.fetch) {
      return null;
    }

    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "vibe-research-updater",
    };
    const token = this.env.GITHUB_TOKEN || this.env.GH_TOKEN;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await this.fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, {
      headers,
      signal:
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(this.timeoutMs)
          : undefined,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`GitHub release lookup failed with HTTP ${response.status}.`);
    }

    const release = await response.json();
    const tag = trim(release?.tag_name);
    if (!tag) {
      return null;
    }

    const commit = await this.readRemoteRefCommit(remoteUrl, `refs/tags/${tag}`);
    if (!commit) {
      return null;
    }

    return {
      commit,
      source: repo.httpsUrl,
      targetType: "release",
      tag,
      version: normalizeVersionTag(tag),
      name: trim(release?.name) || tag,
      releaseUrl: trim(release?.html_url),
      publishedAt: trim(release?.published_at),
      releaseCheck: "latest",
    };
  }

  async readLatestBranchCommit(remoteUrl) {
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

  async readRemoteRefCommit(remoteUrl, ref) {
    const candidates = [];
    const githubHttpsRemoteUrl = getGitHubHttpsRemoteUrl(remoteUrl);

    if (githubHttpsRemoteUrl) {
      candidates.push(githubHttpsRemoteUrl);
    }

    candidates.push(this.remote);

    let lastError = null;
    for (const candidate of [...new Set(candidates)]) {
      try {
        const result = await this.git(["ls-remote", candidate, ref, `${ref}^{}`]);
        const commit = parseLsRemoteRef(result.stdout, ref);

        if (commit) {
          return commit;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    return "";
  }

  async isCommitAncestor(ancestorCommit, descendantCommit) {
    if (!ancestorCommit || !descendantCommit) {
      return false;
    }

    try {
      await this.git(["merge-base", "--is-ancestor", ancestorCommit, descendantCommit]);
      return true;
    } catch {
      return false;
    }
  }

  async scheduleUpdateAndRestart() {
    const status = await this.getStatus({ force: true });

    if (!status.supported || status.status === "error") {
      const error = new Error(status.reason || "Automatic updates are unavailable for this checkout.");
      error.statusCode = 409;
      error.update = status;
      throw error;
    }

    if (!status.updateAvailable) {
      const error = new Error("Vibe Research is already up to date.");
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
    const script = this.buildUpdateScript({
      updateSource: status.updateSource || this.remote,
      targetType: status.targetType,
      latestTag: status.latestTag,
    });
    const shell = this.env.SHELL || "/bin/sh";
    const child = this.spawn(shell, ["-lc", script], {
      cwd: this.cwd,
      detached: true,
      env: {
        ...this.env,
        VIBE_RESEARCH_PORT: String(this.port),
        VIBE_RESEARCH_STATE_DIR: this.stateDir,
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

  buildUpdateScript({ updateSource = this.remote, targetType = "branch", latestTag = "" } = {}) {
    const cwd = shellQuote(this.cwd);
    const remote = shellQuote(updateSource);
    const branch = shellQuote(this.branch);
    const managedPromptMarkers = MANAGED_PROMPT_MARKERS.map((marker) => shellQuote(marker)).join(" ");
    const managedPromptFiles = MANAGED_PROMPT_FILES.map((filePath) => shellQuote(filePath)).join(" ");
    const stateUrl = shellQuote(`http://127.0.0.1:${this.port}/api/state`);
    const terminateUrl = shellQuote(`http://127.0.0.1:${this.port}/api/terminate`);
    const updateCommand =
      targetType === "release" && latestTag
        ? [
            `echo "[vibe-research-update] fetching release ${latestTag}"`,
            `git fetch --force --depth 1 ${remote} ${shellQuote(`refs/tags/${latestTag}:refs/tags/${latestTag}`)}`,
            `git checkout --detach ${shellQuote(`refs/tags/${latestTag}`)}`,
          ].join("\n")
        : `git pull --ff-only ${remote} ${branch}`;

    return `
set -euo pipefail
echo "[vibe-research-update] starting $(date)"
cd ${cwd}
reset_checkout_changes() {
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "[vibe-research-update] discarding local app checkout changes before update"
    git reset --hard HEAD
    git clean -fd
  fi
}
has_managed_prompt_marker() {
  local source="$1"
  local marker
  for marker in ${managedPromptMarkers}; do
    if printf '%s' "$source" | grep -Fq "$marker"; then
      return 0
    fi
  done
  return 1
}
restore_managed_prompt_file() {
  local file="$1"
  if [ -f "$file" ] && has_managed_prompt_marker "$(cat "$file")"; then
    git checkout -- "$file" >/dev/null 2>&1 || true
    return
  fi

  if has_managed_prompt_marker "$(git show "HEAD:$file" 2>/dev/null || true)"; then
    git checkout -- "$file" >/dev/null 2>&1 || true
  fi
}
for file in ${managedPromptFiles}; do
  restore_managed_prompt_file "$file"
done
reset_checkout_changes
${updateCommand}
echo "[vibe-research-update] update pulled; stopping current server"
curl -fsS -X POST ${terminateUrl} >/dev/null 2>&1 || true
for attempt in $(seq 1 100); do
  if ! curl -fsS ${stateUrl} >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
echo "[vibe-research-update] restarting"
exec ./start.sh
`;
  }
}
