import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WikiBackupService } from "../src/wiki-backup.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync("git", ["-C", cwd, ...args]);
}

async function gitBare(gitDir, args) {
  return execFileAsync("git", ["--git-dir", gitDir, ...args]);
}

test("wiki backup creates an isolated git repo even inside another checkout", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-wiki-backup-nested-"));
  const wikiDir = path.join(rootDir, "wiki");

  try {
    await git(rootDir, ["init", "-b", "main"]);
    await git(rootDir, ["config", "user.name", "Remote Vibes Test"]);
    await git(rootDir, ["config", "user.email", "test@example.com"]);
    await writeFile(path.join(rootDir, "README.md"), "# Parent\n", "utf8");
    await git(rootDir, ["add", "README.md"]);
    await git(rootDir, ["commit", "-m", "Parent initial"]);

    await mkdir(wikiDir, { recursive: true });
    const canonicalWikiDir = await realpath(wikiDir);
    await writeFile(path.join(wikiDir, "index.md"), "# Wiki\n", "utf8");

    const backup = new WikiBackupService({ wikiPath: wikiDir, enabled: true });
    const status = await backup.runBackup();

    assert.equal(status.lastStatus, "committed");
    assert.match(status.lastCommit, /^[0-9a-f]+$/);

    const { stdout: wikiTopLevel } = await git(wikiDir, ["rev-parse", "--show-toplevel"]);
    assert.equal(wikiTopLevel.trim(), canonicalWikiDir);

    const { stdout: parentLog } = await git(rootDir, ["log", "--oneline"]);
    assert.match(parentLog, /Parent initial/);
    assert.doesNotMatch(parentLog, /Remote Vibes wiki backup/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("wiki backup pushes commits to a configured private remote", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-wiki-backup-remote-"));
  const wikiDir = path.join(rootDir, "wiki");
  const remoteDir = path.join(rootDir, "private-wiki.git");

  try {
    await mkdir(wikiDir, { recursive: true });
    await execFileAsync("git", ["init", "--bare", remoteDir]);
    await writeFile(path.join(wikiDir, "index.md"), "# Private Wiki\n", "utf8");

    const backup = new WikiBackupService({
      wikiPath: wikiDir,
      enabled: true,
      remoteBranch: "main",
      remoteEnabled: true,
      remoteUrl: remoteDir,
    });
    const status = await backup.runBackup();

    assert.equal(status.lastStatus, "committed");
    assert.equal(status.lastPushStatus, "pushed");
    assert.equal(status.remoteUrlConfigured, true);
    assert.match(status.lastCommit, /^[0-9a-f]+$/);

    const { stdout: remoteUrl } = await git(wikiDir, ["remote", "get-url", "origin"]);
    assert.equal(remoteUrl.trim(), remoteDir);

    const { stdout: remoteLog } = await gitBare(remoteDir, ["log", "--oneline", "refs/heads/main"]);
    assert.match(remoteLog, /Remote Vibes wiki backup/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("wiki backup pushes existing clean commits when a private remote is added later", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-wiki-backup-late-remote-"));
  const wikiDir = path.join(rootDir, "wiki");
  const remoteDir = path.join(rootDir, "private-wiki.git");

  try {
    await mkdir(wikiDir, { recursive: true });
    await writeFile(path.join(wikiDir, "index.md"), "# Private Wiki\n", "utf8");

    const backup = new WikiBackupService({ wikiPath: wikiDir, enabled: true });
    const localStatus = await backup.runBackup();
    assert.equal(localStatus.lastStatus, "committed");

    await execFileAsync("git", ["init", "--bare", remoteDir]);
    backup.setConfig({
      remoteBranch: "main",
      remoteEnabled: true,
      remoteUrl: remoteDir,
    });
    const pushStatus = await backup.runBackup();

    assert.equal(pushStatus.lastStatus, "clean");
    assert.equal(pushStatus.lastPushStatus, "pushed");

    const { stdout: remoteLog } = await gitBare(remoteDir, ["log", "--oneline", "refs/heads/main"]);
    assert.match(remoteLog, /Remote Vibes wiki backup/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("wiki backup pulls new commits from a configured private remote", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-wiki-backup-pull-"));
  const remoteDir = path.join(rootDir, "private-wiki.git");
  const seedDir = path.join(rootDir, "seed");
  const wikiDir = path.join(rootDir, "wiki");

  try {
    await execFileAsync("git", ["init", "--bare", remoteDir]);
    await gitBare(remoteDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await execFileAsync("git", ["clone", remoteDir, seedDir]);
    await git(seedDir, ["checkout", "-b", "main"]);
    await git(seedDir, ["config", "user.name", "Remote Vibes Test"]);
    await git(seedDir, ["config", "user.email", "test@example.com"]);
    await writeFile(path.join(seedDir, "index.md"), "# Private Wiki\n", "utf8");
    await git(seedDir, ["add", "index.md"]);
    await git(seedDir, ["commit", "-m", "Initial wiki"]);
    await git(seedDir, ["push", "-u", "origin", "main"]);

    await execFileAsync("git", ["clone", remoteDir, wikiDir]);
    await git(wikiDir, ["config", "user.name", "Remote Vibes Test"]);
    await git(wikiDir, ["config", "user.email", "test@example.com"]);

    await writeFile(path.join(seedDir, "log.md"), "# Remote log\n", "utf8");
    await git(seedDir, ["add", "log.md"]);
    await git(seedDir, ["commit", "-m", "Remote update"]);
    await git(seedDir, ["push"]);

    const backup = new WikiBackupService({
      wikiPath: wikiDir,
      enabled: true,
      remoteBranch: "main",
      remoteEnabled: true,
      remoteUrl: remoteDir,
    });
    const status = await backup.runBackup();

    assert.equal(status.lastStatus, "clean");
    assert.equal(status.lastPullStatus, "pulled");
    assert.equal(status.lastPushStatus, "pushed");
    assert.equal(await readFile(path.join(wikiDir, "log.md"), "utf8"), "# Remote log\n");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("wiki backup reports merge conflicts from private remote sync", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-wiki-backup-conflict-"));
  const remoteDir = path.join(rootDir, "private-wiki.git");
  const seedDir = path.join(rootDir, "seed");
  const wikiDir = path.join(rootDir, "wiki");

  try {
    await execFileAsync("git", ["init", "--bare", remoteDir]);
    await gitBare(remoteDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await execFileAsync("git", ["clone", remoteDir, seedDir]);
    await git(seedDir, ["checkout", "-b", "main"]);
    await git(seedDir, ["config", "user.name", "Remote Vibes Test"]);
    await git(seedDir, ["config", "user.email", "test@example.com"]);
    await writeFile(path.join(seedDir, "index.md"), "# Private Wiki\n\nbase\n", "utf8");
    await git(seedDir, ["add", "index.md"]);
    await git(seedDir, ["commit", "-m", "Initial wiki"]);
    await git(seedDir, ["push", "-u", "origin", "main"]);

    await execFileAsync("git", ["clone", remoteDir, wikiDir]);
    await git(wikiDir, ["config", "user.name", "Remote Vibes Test"]);
    await git(wikiDir, ["config", "user.email", "test@example.com"]);

    await writeFile(path.join(wikiDir, "index.md"), "# Private Wiki\n\nlocal\n", "utf8");
    await writeFile(path.join(seedDir, "index.md"), "# Private Wiki\n\nremote\n", "utf8");
    await git(seedDir, ["add", "index.md"]);
    await git(seedDir, ["commit", "-m", "Remote conflicting update"]);
    await git(seedDir, ["push"]);

    const backup = new WikiBackupService({
      wikiPath: wikiDir,
      enabled: true,
      remoteBranch: "main",
      remoteEnabled: true,
      remoteUrl: remoteDir,
    });
    const status = await backup.runBackup();

    assert.equal(status.lastStatus, "error");
    assert.equal(status.lastPullStatus, "conflict");
    assert.equal(status.lastErrorKind, "merge-conflict");
    assert.equal(status.hasConflicts, true);
    assert.deepEqual(status.conflictFiles, ["index.md"]);
    assert.match(status.lastPullMessage, /CONFLICT|could not apply|Resolve all conflicts/i);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("disabled wiki backup does not initialize git", async () => {
  const wikiDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-wiki-backup-disabled-"));

  try {
    await writeFile(path.join(wikiDir, "index.md"), "# Wiki\n", "utf8");
    const backup = new WikiBackupService({ wikiPath: wikiDir, enabled: false });
    const status = await backup.runBackup();

    assert.equal(status.lastStatus, "skipped");
    await assert.rejects(readFile(path.join(wikiDir, ".git", "HEAD"), "utf8"));
  } finally {
    await rm(wikiDir, { recursive: true, force: true });
  }
});
