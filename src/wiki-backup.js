import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function getErrorMessage(error) {
  return String(error?.stderr || error?.stdout || error?.message || error || "Unknown error").trim();
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
    intervalMs = 10 * 60 * 1000,
    remoteEnabled = false,
    remoteUrl = "",
    remoteName = "origin",
    remoteBranch = "main",
    execFile: execFileRunner = execFileAsync,
    now = () => new Date(),
  } = {}) {
    this.enabled = Boolean(enabled);
    this.execFile = execFileRunner;
    this.intervalMs = intervalMs;
    this.lastRunAt = null;
    this.lastStatus = "idle";
    this.lastMessage = "";
    this.lastCommit = "";
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
      intervalMs: this.intervalMs,
      lastCommit: this.lastCommit,
      lastMessage: this.lastMessage,
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
      this.lastPushAt = pushTimestamp;
      this.lastPushStatus = "pushed";
      this.lastPushMessage = `Pushed wiki backup to ${this.remoteName}/${this.remoteBranch}.`;
      return true;
    } catch (error) {
      this.lastPushAt = pushTimestamp;
      this.lastPushStatus = "error";
      this.lastPushMessage = getErrorMessage(error);
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
      await this.git(["add", "-A"]);
      const { stdout = "" } = await this.git(["status", "--porcelain"]);
      const timestamp = this.now().toISOString();

      if (!stdout.trim()) {
        this.lastRunAt = timestamp;
        this.lastStatus = "clean";
        this.lastMessage = "No wiki changes to back up.";
        await this.pushRemoteBackup({ timestamp });
        return this.getStatus();
      }

      await this.git(["commit", "-m", `Remote Vibes wiki backup ${timestamp}`]);
      const { stdout: commitStdout = "" } = await this.git(["rev-parse", "--short", "HEAD"]);

      this.lastRunAt = timestamp;
      this.lastStatus = "committed";
      this.lastCommit = commitStdout.trim();
      this.lastMessage = reason === "scheduled" ? "Scheduled wiki backup committed." : "Wiki backup committed.";
      await this.pushRemoteBackup({ timestamp });
      return this.getStatus();
    } catch (error) {
      this.lastRunAt = this.now().toISOString();
      this.lastStatus = "error";
      this.lastMessage = getErrorMessage(error);
      return this.getStatus();
    }
  }
}
