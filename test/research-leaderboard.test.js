// Unit + CLI tests for src/research/leaderboard-edit.js + bin/vr-research-leaderboard.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  insertLeaderboardRow,
  removeLeaderboardRow,
  __internal,
} from "../src/research/leaderboard-edit.js";

const VR_LEADERBOARD = path.resolve("bin/vr-research-leaderboard");

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `${prefix}-`)); }

function runCli(args, { cwd, env = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_LEADERBOARD, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} settle(null); }, timeoutMs);
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (err) => { stderr += `\n[spawn error] ${err.message}`; settle(null); });
    child.on("exit", (code) => settle(code));
  });
}

// README with N pre-filled rows.
function makeProject(prefix, rowCount = 0) {
  const dir = tmp(prefix);
  const rows = [];
  for (let i = 1; i <= rowCount; i += 1) {
    rows.push(`| ${i} | [v${i}-existing](results/v${i}-existing.md) | [r/v${i}-existing](https://github.com/example/x/tree/r/v${i}-existing) | [aaaaaa${i}](https://github.com/example/x/commit/aaaaaa${i}) | 0.${90 - i * 5} mean |`);
  }
  const tableBody = rows.length ? rows.join("\n") + "\n" : "";
  writeFileSync(join(dir, "README.md"), [
    "# example",
    "",
    "## LEADERBOARD",
    "",
    "| rank | result | branch | commit | score / verdict |",
    "|------|--------|--------|--------|-----------------|",
    tableBody,
    "## QUEUE",
    "",
    "| move | starting-point | why |",
    "|------|----------------|-----|",
    "",
    "## LOG",
    "",
    "| date | event | slug or ref | one-line summary | link |",
    "|------|-------|-------------|-------------------|------|",
    "",
  ].join("\n"));
  return dir;
}

const NEW_ROW = {
  slug: "v9-newest",
  resultPath: "results/v9-newest.md",
  branchUrl: "https://github.com/example/x/tree/r/v9-newest",
  commitUrl: "https://github.com/example/x/commit/abc1234567",
  score: "0.95 mean across n=3 seeds",
};

// ---- renderLeaderboardRow + helpers ----

test("renderResultCell + renderBranchCell + renderCommitCell shape match the schema", () => {
  assert.equal(
    __internal.renderResultCell("v3", "results/v3.md"),
    "[v3](results/v3.md)",
  );
  assert.equal(
    __internal.renderBranchCell("https://github.com/example/x/tree/r/v3"),
    "[r/v3](https://github.com/example/x/tree/r/v3)",
  );
  assert.equal(
    __internal.renderCommitCell("https://github.com/example/x/commit/abcdef1234567"),
    "[abcdef1](https://github.com/example/x/commit/abcdef1234567)",
  );
});

// ---- insertLeaderboardRow ----

test("insert at rank 1 on empty leaderboard: lands as the only row", async () => {
  const dir = makeProject("vr-lb-empty", 0);
  try {
    const readmePath = join(dir, "README.md");
    const result = await insertLeaderboardRow({ readmePath, rank: 1, row: NEW_ROW });
    assert.equal(result.inserted.slug, "v9-newest");
    assert.equal(result.evicted, null);
    const after = readFileSync(readmePath, "utf8");
    assert.match(after, /\| 1 \| \[v9-newest\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insert at rank 1 with existing rows: shifts everything down by 1", async () => {
  const dir = makeProject("vr-lb-shift", 3);
  try {
    const readmePath = join(dir, "README.md");
    await insertLeaderboardRow({ readmePath, rank: 1, row: NEW_ROW });
    const after = readFileSync(readmePath, "utf8");
    // v9-newest at rank 1, v1-existing at rank 2, etc.
    assert.match(after, /\| 1 \| \[v9-newest\]/);
    assert.match(after, /\| 2 \| \[v1-existing\]/);
    assert.match(after, /\| 3 \| \[v2-existing\]/);
    assert.match(after, /\| 4 \| \[v3-existing\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insert at rank 1 with 5 existing rows: rank-6 gets evicted", async () => {
  const dir = makeProject("vr-lb-evict", 5);
  try {
    const readmePath = join(dir, "README.md");
    const result = await insertLeaderboardRow({ readmePath, rank: 1, row: NEW_ROW });
    assert.ok(result.evicted, "expected eviction when inserting at rank 1 with 5 rows");
    assert.equal(result.evicted.slug, "v5-existing");
    const after = readFileSync(readmePath, "utf8");
    assert.equal(/v5-existing/.test(after), false, "evicted row should be gone");
    // Ranks 1-5 are filled with v9 + v1..v4.
    assert.match(after, /\| 5 \| \[v4-existing\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insert at the tail rank (existing.length + 1) without eviction", async () => {
  const dir = makeProject("vr-lb-tail", 2);
  try {
    const readmePath = join(dir, "README.md");
    const result = await insertLeaderboardRow({ readmePath, rank: 3, row: NEW_ROW });
    assert.equal(result.evicted, null);
    const after = readFileSync(readmePath, "utf8");
    assert.match(after, /\| 1 \| \[v1-existing\]/);
    assert.match(after, /\| 2 \| \[v2-existing\]/);
    assert.match(after, /\| 3 \| \[v9-newest\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insert with a rank that would leave a gap rejects", async () => {
  const dir = makeProject("vr-lb-gap", 2);
  try {
    const readmePath = join(dir, "README.md");
    await assert.rejects(
      insertLeaderboardRow({ readmePath, rank: 5, row: NEW_ROW }),
      /would leave a gap/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insert refuses duplicate slug", async () => {
  const dir = makeProject("vr-lb-dup", 2);
  try {
    const readmePath = join(dir, "README.md");
    await assert.rejects(
      insertLeaderboardRow({
        readmePath,
        rank: 1,
        row: { ...NEW_ROW, slug: "v1-existing" },
      }),
      /already has a row for slug "v1-existing"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insert validates required fields", async () => {
  const dir = makeProject("vr-lb-validate", 0);
  try {
    const readmePath = join(dir, "README.md");
    await assert.rejects(
      insertLeaderboardRow({ readmePath, rank: 1, row: { ...NEW_ROW, score: "" } }),
      /score is required/,
    );
    await assert.rejects(
      insertLeaderboardRow({ readmePath, rank: 0, row: NEW_ROW }),
      /rank must be an integer >= 1/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insert errors when no LEADERBOARD section exists", async () => {
  const dir = tmp("vr-lb-no-section");
  try {
    writeFileSync(join(dir, "README.md"), "# x\n\nno leaderboard here.\n");
    await assert.rejects(
      insertLeaderboardRow({ readmePath: join(dir, "README.md"), rank: 1, row: NEW_ROW }),
      /no LEADERBOARD table/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- removeLeaderboardRow ----

test("remove: drops row + shifts lower ranks up", async () => {
  const dir = makeProject("vr-lb-remove", 4);
  try {
    const readmePath = join(dir, "README.md");
    const result = await removeLeaderboardRow({ readmePath, slug: "v2-existing" });
    assert.equal(result.removed, true);
    const after = readFileSync(readmePath, "utf8");
    assert.equal(/v2-existing/.test(after), false);
    // v3 was rank 3, now rank 2.
    assert.match(after, /\| 1 \| \[v1-existing\]/);
    assert.match(after, /\| 2 \| \[v3-existing\]/);
    assert.match(after, /\| 3 \| \[v4-existing\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove: errors when slug not found", async () => {
  const dir = makeProject("vr-lb-remove-miss", 2);
  try {
    await assert.rejects(
      removeLeaderboardRow({ readmePath: join(dir, "README.md"), slug: "nope" }),
      /no row for slug "nope"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insert + remove: round-trip leaves leaderboard at original state", async () => {
  const dir = makeProject("vr-lb-round-trip", 2);
  try {
    const readmePath = join(dir, "README.md");
    const before = readFileSync(readmePath, "utf8");
    await insertLeaderboardRow({ readmePath, rank: 1, row: NEW_ROW });
    await removeLeaderboardRow({ readmePath, slug: "v9-newest" });
    const after = readFileSync(readmePath, "utf8");
    assert.equal(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- bin/vr-research-leaderboard ----

test("vr-research-leaderboard --help: exits 0", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /vr-research-leaderboard/);
});

test("vr-research-leaderboard insert: missing flags exit 2", async () => {
  const dir = makeProject("vr-lb-cli-missing", 0);
  try {
    const r = await runCli([dir, "insert", "--slug", "x"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--rank N \(>= 1\) is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-leaderboard insert: appends + prints confirmation", async () => {
  const dir = makeProject("vr-lb-cli-insert", 2);
  try {
    const r = await runCli([
      dir, "insert",
      "--rank", "1",
      "--slug", "vk-cli",
      "--result", "results/vk-cli.md",
      "--branch", "https://github.com/example/x/tree/r/vk-cli",
      "--commit", "https://github.com/example/x/commit/aaaaaa9",
      "--score", "0.99 mean across n=3 seeds",
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /inserted vk-cli at rank 1/);
    const after = readFileSync(join(dir, "README.md"), "utf8");
    assert.match(after, /\| 1 \| \[vk-cli\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-leaderboard insert with eviction: prints next-step LOG hint", async () => {
  const dir = makeProject("vr-lb-cli-evict", 5);
  try {
    const r = await runCli([
      dir, "insert",
      "--rank", "1",
      "--slug", "vk-cli",
      "--result", "results/vk-cli.md",
      "--branch", "https://github.com/example/x/tree/r/vk-cli",
      "--commit", "https://github.com/example/x/commit/aaaaaa9",
      "--score", "0.99",
    ]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /evicted: v5-existing/);
    assert.match(r.stdout, /vr-research-log .* --event evicted --slug v5-existing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-leaderboard remove: drops row + prints confirmation", async () => {
  const dir = makeProject("vr-lb-cli-remove", 3);
  try {
    const r = await runCli([dir, "remove", "--slug", "v2-existing"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /removed v2-existing from LEADERBOARD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-leaderboard --json: structured insert result includes evicted", async () => {
  const dir = makeProject("vr-lb-cli-json", 5);
  try {
    const r = await runCli([
      dir, "insert",
      "--rank", "1",
      "--slug", "vj",
      "--result", "results/vj.md",
      "--branch", "https://github.com/example/x/tree/r/vj",
      "--commit", "https://github.com/example/x/commit/aaaaaa9",
      "--score", "0.99",
      "--json",
    ]);
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.inserted.slug, "vj");
    assert.equal(body.inserted.rank, 1);
    assert.equal(body.evicted.slug, "v5-existing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
