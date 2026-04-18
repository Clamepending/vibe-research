import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function getErrorMessage(error) {
  return String(error?.stderr || error?.stdout || error?.message || error || "Unknown error").trim();
}

function isMergeConflictMessage(message) {
  return /CONFLICT|Resolve all conflicts|unmerged|merge conflict|rebase in progress|could not apply/i.test(
    String(message || ""),
  );
}

function formatConflictMessage(conflictFiles) {
  if (!conflictFiles.length) {
    return "The wiki repository has an unresolved merge conflict.";
  }

  return `The wiki repository has unresolved merge conflicts in ${conflictFiles.join(", ")}.`;
}

function normalizeGitRemoteName(value) {
  const remoteName = String(value || "origin").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remoteName) ? remoteName : "origin";
}

function normalizeGitBranchName(value) {
  const branchName = String(value || "main").trim();
  if (
    !branchName ||
    branchName.startsWith("-") ||
    branchName.endsWith("/") ||
    branchName.includes("..") ||
    branchName.includes("@{") ||
    /[\s~^:?*[\]\\]/.test(branchName)
  ) {
    return "main";
  }

  return branchName;
}

function sanitizeRemoteUrl(value) {
  const remoteUrl = String(value || "").trim();
  if (!remoteUrl) {
    return "";
  }

  try {
    const parsedUrl = new URL(remoteUrl);
    if (parsedUrl.username || parsedUrl.password) {
      parsedUrl.username = "***";
      parsedUrl.password = "***";
    }
    return parsedUrl.toString();
  } catch {
    return remoteUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]+)@/i, "$1***@");
  }
}

export class WikiBackupService {
  constructor({
    wikiPath,
    enabled = true,
    intervalMs = 5 * 60 * 1000,
    remoteEnabled = false,
    remoteUrl = "",
    remoteName = "origin",
    remoteBranch = "main",
    execFile: execFileRunner = execFileAsync,
    now = () => new Date(),
  } = {}) {
    this.enabled = Boolean(enabled);
    this.conflictFiles = [];
    this.execFile = execFileRunner;
    this.hasConflicts = false;
    this.lastErrorKind = "";
    this.intervalMs = intervalMs;
    this.lastRunAt = null;
    this.lastStatus = "idle";
    this.lastMessage = "";
    this.lastCommit = "";
    this.lastPullAt = null;
    this.lastPullMessage = "";
    this.lastPullStatus = remoteEnabled ? "idle" : "disabled";
    this.lastPushAt = null;
    this.lastPushMessage = "";
    this.lastPushStatus = remoteEnabled ? "idle" : "disabled";
    this.now = now;
    this.remoteBranch = normalizeGitBranchName(remoteBranch);
    this.remoteEnabled = Boolean(remoteEnabled);
    this.remoteName = normalizeGitRemoteName(remoteName);
    this.remoteUrl = String(remoteUrl || "").trim();
    this.timer = null;
    this.wikiPath = wikiPath;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      conflictFiles: this.conflictFiles,
      hasConflicts: this.hasConflicts,
      intervalMs: this.intervalMs,
      lastCommit: this.lastCommit,
      lastErrorKind: this.lastErrorKind,
      lastMessage: this.lastMessage,
      lastPullAt: this.lastPullAt,
      lastPullMessage: this.lastPullMessage,
      lastPullStatus: this.lastPullStatus,
      lastPushAt: this.lastPushAt,
      lastPushMessage: this.lastPushMessage,
      lastPushStatus: this.lastPushStatus,
      lastRunAt: this.lastRunAt,
      lastStatus: this.lastStatus,
      remoteBranch: this.remoteBranch,
      remoteEnabled: this.remoteEnabled,
      remoteName: this.remoteName,
      remoteUrl: sanitizeRemoteUrl(this.remoteUrl),
      remoteUrlConfigured: Boolean(this.remoteUrl),
      wikiPath: this.wikiPath,
    };
  }

  setConfig({
    wikiPath = this.wikiPath,
    enabled = this.enabled,
    intervalMs = this.intervalMs,
    remoteEnabled = this.remoteEnabled,
    remoteUrl = this.remoteUrl,
    remoteName = this.remoteName,
    remoteBranch = this.remoteBranch,
  } = {}) {
    this.wikiPath = wikiPath;
    this.enabled = Boolean(enabled);
    this.intervalMs = intervalMs;
    this.remoteBranch = normalizeGitBranchName(remoteBranch);
    this.remoteEnabled = Boolean(remoteEnabled);
    this.remoteName = normalizeGitRemoteName(remoteName);
    this.remoteUrl = String(remoteUrl || "").trim();
    if (!this.remoteEnabled) {
      this.lastPullStatus = "disabled";
      this.lastPullMessage = "Private remote pull is disabled.";
      this.lastPushStatus = "disabled";
      this.lastPushMessage = "Private remote push is disabled.";
    }

    if (this.timer) {
      this.stop();
      this.start();
    }

    return this.getStatus();
  }

  start() {
    this.stop();

    if (!this.enabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runBackup({ reason: "scheduled" });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  async git(args, options = {}) {
    return this.execFile("git", ["-C", this.wikiPath, ...args], options);
  }

  async ensureGitRepository() {
    let hasOwnGitRepository = false;

    try {
      const { stdout = "" } = await this.git(["rev-parse", "--show-toplevel"]);
      hasOwnGitRepository = path.resolve(stdout.trim()) === path.resolve(this.wikiPath);
    } catch {
      hasOwnGitRepository = false;
    }

    if (!hasOwnGitRepository) {
      try {
        await this.git(["init", "-b", "main"]);
      } catch {
        await this.git(["init"]);
      }
    }

    await this.ensureGitConfig("user.name", "Remote Vibes");
    await this.ensureGitConfig("user.email", "remote-vibes@local");
  }

  async ensureGitConfig(key, fallbackValue) {
    try {
      const { stdout = "" } = await this.git(["config", "--get", key]);
      if (stdout.trim()) {
        return;
      }
    } catch {
      // Missing local config is normal for freshly initialized wiki repos.
    }

    await this.git(["config", key, fallbackValue]);
  }

  async hasHeadCommit() {
    try {
      await this.git(["rev-parse", "--verify", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  async ensureRemote() {
    try {
      const { stdout = "" } = await this.git(["remote", "get-url", this.remoteName]);
      if (stdout.trim() !== this.remoteUrl) {
        await this.git(["remote", "set-url", this.remoteName, this.remoteUrl]);
      }
    } catch {
      await this.git(["remote", "add", this.remoteName, this.remoteUrl]);
    }
  }

  async refreshLastCommit() {
    try {
      const { stdout = "" } = await this.git(["rev-parse", "--short", "HEAD"]);
      this.lastCommit = stdout.trim();
    } catch {
      this.lastCommit = "";
    }
  }

  clearConflictState() {
    this.conflictFiles = [];
    this.hasConflicts = false;
    if (this.lastErrorKind === "merge-conflict") {
      this.lastErrorKind = "";
    }
  }

  async refreshConflictState(message = "") {
    let conflictFiles = [];

    try {
      const { stdout = "" } = await this.git(["diff", "--name-only", "--diff-filter=U"]);
      conflictFiles = stdout
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    } catch {
      conflictFiles = [];
    }

    const looksLikeConflict = isMergeConflictMessage(message);
    this.conflictFiles = conflictFiles;
    this.hasConflicts = Boolean(conflictFiles.length || looksLikeConflict);
    this.lastErrorKind = this.hasConflicts ? "merge-conflict" : "";

    return this.hasConflicts;
  }

  async pullRemoteBackup({ timestamp } = {}) {
    const pullTimestamp = timestamp || this.now().toISOString();

    if (!this.remoteEnabled) {
      this.lastPullAt = pullTimestamp;
      this.lastPullStatus = "disabled";
      this.lastPullMessage = "Private remote pull is disabled.";
      return false;
    }

    if (!this.remoteUrl) {
      this.lastPullAt = pullTimestamp;
      this.lastPullStatus = "skipped";
      this.lastPullMessage = "Private remote pull is enabled, but no remote URL is configured.";
      return false;
    }

    try {
      await this.ensureRemote();

      if (!(await this.hasHeadCommit())) {
        await this.git(["fetch", this.remoteName, this.remoteBranch]);
        await this.git(["checkout", "-B", this.remoteBranch, "FETCH_HEAD"]);
        await this.refreshLastCommit();
        this.clearConflictState();
        this.lastPullAt = pullTimestamp;
        this.lastPullStatus = "pulled";
        this.lastPullMessage = `Pulled wiki backup from ${this.remoteName}/${this.remoteBranch}.`;
        return true;
      }

      const { stdout = "", stderr = "" } = await this.git([
        "pull",
        "--rebase",
        "--autostash",
        this.remoteName,
        this.remoteBranch,
      ]);
      await this.refreshLastCommit();
      this.clearConflictState();
      this.lastPullAt = pullTimestamp;

      if (/Already up to date\./i.test(`${stdout}\n${stderr}`)) {
        this.lastPullStatus = "current";
        this.lastPullMessage = `Wiki backup is already current with ${this.remoteName}/${this.remoteBranch}.`;
        return false;
      }

      this.lastPullStatus = "pulled";
      this.lastPullMessage = `Pulled wiki backup from ${this.remoteName}/${this.remoteBranch}.`;
      this.clearConflictState();
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      if (/could(?:n't| not) find remote ref|couldn't find remote ref|could not find remote ref|couldn't find remote ref/i.test(message)) {
        this.lastPullAt = pullTimestamp;
        this.lastPullStatus = "skipped";
        this.lastPullMessage = `Remote branch ${this.remoteName}/${this.remoteBranch} does not exist yet.`;
        return false;
      }

      const hasConflicts = await this.refreshConflictState(message);
      this.lastPullAt = pullTimestamp;
      this.lastPullStatus = hasConflicts ? "conflict" : "error";
      this.lastPullMessage = message;
      throw error;
    }
  }

  async pushRemoteBackup({ timestamp } = {}) {
    const pushTimestamp = timestamp || this.now().toISOString();

    if (!this.remoteEnabled) {
      this.lastPushAt = pushTimestamp;
      this.lastPushStatus = "disabled";
      this.lastPushMessage = "Private remote push is disabled.";
      return false;
    }

    if (!this.remoteUrl) {
      this.lastPushAt = pushTimestamp;
      this.lastPushStatus = "skipped";
      this.lastPushMessage = "Private remote push is enabled, but no remote URL is configured.";
      return false;
    }

    if (!(await this.hasHeadCommit())) {
      this.lastPushAt = pushTimestamp;
      this.lastPushStatus = "skipped";
      this.lastPushMessage = "No wiki commits exist yet, so there is nothing to push.";
      return false;
    }

    try {
      await this.ensureRemote();
      await this.git(["push", "-u", this.remoteName, `HEAD:${this.remoteBranch}`]);
      this.clearConflictState();
      this.lastPushAt = pushTimestamp;
      this.lastPushStatus = "pushed";
      this.lastPushMessage = `Pushed wiki backup to ${this.remoteName}/${this.remoteBranch}.`;
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      const hasConflicts = await this.refreshConflictState(message);
      this.lastPushAt = pushTimestamp;
      this.lastPushStatus = hasConflicts ? "conflict" : "error";
      this.lastPushMessage = message;
      throw error;
    }
  }

  async runBackup({ reason = "manual" } = {}) {
    if (!this.enabled) {
      this.lastRunAt = this.now().toISOString();
      this.lastStatus = "skipped";
      this.lastMessage = "Wiki git backup is disabled.";
      return this.getStatus();
    }

    try {
      await mkdir(this.wikiPath, { recursive: true });
      await this.ensureGitRepository();
      await this.refreshConflictState();
      if (this.hasConflicts) {
        throw new Error(formatConflictMessage(this.conflictFiles));
      }

      await this.git(["add", "-A"]);
      const { stdout = "" } = await this.git(["status", "--porcelain"]);
      const timestamp = this.now().toISOString();
      let committedChanges = false;

      if (stdout.trim()) {
        await this.git(["commit", "-m", `Remote Vibes wiki backup ${timestamp}`]);
        committedChanges = true;
      }

      await this.pullRemoteBackup({ timestamp });
      await this.refreshLastCommit();

      if (!committedChanges) {
        this.lastRunAt = timestamp;
        this.lastStatus = "clean";
        this.lastMessage =
          this.lastPullStatus === "pulled"
            ? "Pulled the latest wiki backup."
            : "No wiki changes to back up.";
        await this.pushRemoteBackup({ timestamp });
        return this.getStatus();
      }

      this.lastRunAt = timestamp;
      this.lastStatus = "committed";
      this.lastMessage = reason === "scheduled" ? "Scheduled wiki backup committed." : "Wiki backup committed.";
      await this.pushRemoteBackup({ timestamp });
      return this.getStatus();
    } catch (error) {
      const message = getErrorMessage(error);
      await this.refreshConflictState(message);
      this.lastRunAt = this.now().toISOString();
      this.lastStatus = "error";
      this.lastMessage = message;
      return this.getStatus();
    }
  }
}
