// Unit + CLI tests for src/research/log-append.js + bin/vr-research-log.
//
// The agent calls vr-research-log once per move resolution to insert a
// LOG row at the top of the project README's LOG table. The contract:
// newest-first ordering, atomic writes, refuse to corrupt the table.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  appendLogRow,
  renderLogRow,
  __internal,
} from "../src/research/log-append.js";

const VR_RESEARCH_LOG = path.resolve("bin/vr-research-log");

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `${prefix}-`)); }

function runCli(args, { cwd, env = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_RESEARCH_LOG, ...args], {
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

const README_BOILERPLATE = `# example

## GOAL

x

## CODE REPO

\`https://github.com/example/x\`

## SUCCESS CRITERIA

- a
- b

## RANKING CRITERION

\`quantitative: m (higher is better)\`

## LEADERBOARD

| rank | result | branch | commit | score |
|------|--------|--------|--------|-------|

## INSIGHTS

## ACTIVE

| move | result doc | branch | agent | started |
|------|-----------|--------|-------|---------|

## QUEUE

| move | starting-point | why |
|------|----------------|-----|

## LOG

| date | event | slug or ref | one-line summary | link |
|------|-------|-------------|-------------------|------|
| 2026-04-26 | resolved+admitted | v0-baseline | initial baseline | [v0-baseline.md](results/v0-baseline.md) |
`;

function makeProject(prefix = "vr-log") {
  const dir = tmp(prefix);
  writeFileSync(join(dir, "README.md"), README_BOILERPLATE);
  return dir;
}

// ---- renderLogRow ----

test("renderLogRow: produces a single-line markdown table row", () => {
  const out = renderLogRow({
    date: "2026-04-29",
    event: "resolved+admitted",
    slug: "v3-deeper-knob",
    summary: "wibble lifted",
    link: "results/v3-deeper-knob.md",
  });
  assert.equal(out, "| 2026-04-29 | resolved+admitted | v3-deeper-knob | wibble lifted | results/v3-deeper-knob.md |");
});

test("renderLogRow: defaults date to today (UTC) if missing", () => {
  const out = renderLogRow({
    event: "resolved",
    slug: "x",
    summary: "y",
  });
  // Must lead with today's UTC date in YYYY-MM-DD form.
  const today = __internal.todayUtc();
  assert.match(out, new RegExp(`^\\| ${today} \\|`));
});

test("renderLogRow: escapes pipes in summary so the table doesn't break", () => {
  const out = renderLogRow({
    event: "resolved",
    slug: "x",
    summary: "a | b",
    link: "",
  });
  assert.match(out, /a \\\| b/);
});

// ---- appendLogRow ----

test("appendLogRow: inserts the new row directly after the table separator", async () => {
  const dir = makeProject("vr-log-insert");
  try {
    const readmePath = join(dir, "README.md");
    const result = await appendLogRow({
      readmePath,
      row: {
        date: "2026-04-29",
        event: "resolved+admitted",
        slug: "v1-newer",
        summary: "lifted by 3σ",
        link: "results/v1-newer.md",
      },
    });
    assert.equal(result.inserted, true);
    const after = readFileSync(readmePath, "utf8");
    // The new row must appear BEFORE the existing v0-baseline row (newest-first).
    const newerIdx = after.indexOf("v1-newer");
    const olderIdx = after.indexOf("v0-baseline");
    assert.ok(newerIdx > 0 && olderIdx > 0);
    assert.ok(newerIdx < olderIdx, "newer row must precede older row");
    // And immediately after the separator line.
    const expectedRow = "| 2026-04-29 | resolved+admitted | v1-newer | lifted by 3σ | results/v1-newer.md |\n";
    assert.ok(after.includes(expectedRow), `expected row in output:\n${after}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendLogRow: defaults date to today UTC", async () => {
  const dir = makeProject("vr-log-date");
  try {
    const readmePath = join(dir, "README.md");
    const result = await appendLogRow({
      readmePath,
      row: { event: "resolved", slug: "auto-date", summary: "x" },
    });
    assert.equal(result.row.date, __internal.todayUtc());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendLogRow: rejects missing required fields", async () => {
  const dir = makeProject("vr-log-bad");
  try {
    const readmePath = join(dir, "README.md");
    await assert.rejects(
      appendLogRow({ readmePath, row: { event: "", slug: "x", summary: "y" } }),
      /event is required/,
    );
    await assert.rejects(
      appendLogRow({ readmePath, row: { event: "x", slug: "", summary: "y" } }),
      /slug is required/,
    );
    await assert.rejects(
      appendLogRow({ readmePath, row: { event: "x", slug: "y", summary: "" } }),
      /summary is required/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendLogRow: rejects pipe / newline in event or slug", async () => {
  const dir = makeProject("vr-log-pipe");
  try {
    const readmePath = join(dir, "README.md");
    await assert.rejects(
      appendLogRow({ readmePath, row: { event: "a|b", slug: "x", summary: "y" } }),
      /event contains pipe/,
    );
    await assert.rejects(
      appendLogRow({ readmePath, row: { event: "a", slug: "x\ny", summary: "y" } }),
      /slug contains pipe or newline/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendLogRow: errors clearly when README has no LOG table", async () => {
  const dir = tmp("vr-log-nolog");
  try {
    writeFileSync(join(dir, "README.md"), "# x\n\nno log section here.\n");
    await assert.rejects(
      appendLogRow({
        readmePath: join(dir, "README.md"),
        row: { event: "x", slug: "y", summary: "z" },
      }),
      /no LOG table/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendLogRow: leaves prose around the LOG section untouched", async () => {
  const dir = makeProject("vr-log-untouched");
  try {
    const readmePath = join(dir, "README.md");
    const before = readFileSync(readmePath, "utf8");
    await appendLogRow({
      readmePath,
      row: { event: "resolved", slug: "test-slug", summary: "test summary" },
    });
    const after = readFileSync(readmePath, "utf8");
    // GOAL section + LEADERBOARD + ACTIVE / QUEUE all unchanged.
    assert.match(after, /## GOAL\n\nx\n/);
    assert.match(after, /## CODE REPO\n\n`https:\/\/github\.com\/example\/x`/);
    assert.match(after, /## RANKING CRITERION\n\n`quantitative: m \(higher is better\)`/);
    // Existing v0-baseline row preserved.
    assert.match(after, /v0-baseline/);
    // README grew (gained a row) but only the LOG section was touched.
    assert.ok(after.length > before.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- bin/vr-research-log ----

test("vr-research-log --help: exits 0", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /vr-research-log/);
  assert.match(result.stdout, /--event/);
});

test("vr-research-log: missing --event / --slug / --summary exits 2", async () => {
  const dir = makeProject("vr-log-cli-missing");
  try {
    const r1 = await runCli([dir, "--slug", "x", "--summary", "y"]);
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /--event is required/);
    const r2 = await runCli([dir, "--event", "x", "--summary", "y"]);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /--slug is required/);
    const r3 = await runCli([dir, "--event", "x", "--slug", "y"]);
    assert.equal(r3.status, 2);
    assert.match(r3.stderr, /--summary is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-log: missing project-dir exits 2", async () => {
  const r = await runCli(["--event", "x", "--slug", "y", "--summary", "z"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /project-dir positional argument is required/);
});

test("vr-research-log: appends row + prints confirmation", async () => {
  const dir = makeProject("vr-log-cli-ok");
  try {
    const r = await runCli([
      dir,
      "--event", "resolved+admitted",
      "--slug", "v9-cli-test",
      "--summary", "round trip",
      "--link", "results/v9-cli-test.md",
      "--date", "2026-05-01",
    ]);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /appended LOG row/);
    const after = readFileSync(join(dir, "README.md"), "utf8");
    assert.match(after, /\| 2026-05-01 \| resolved\+admitted \| v9-cli-test \| round trip \| results\/v9-cli-test\.md \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-log --json: returns machine-readable summary", async () => {
  const dir = makeProject("vr-log-cli-json");
  try {
    const r = await runCli([
      dir,
      "--event", "falsified",
      "--slug", "v6-fail",
      "--summary", "missed falsifier band by 3σ",
      "--json",
    ]);
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.inserted, true);
    assert.equal(body.row.event, "falsified");
    assert.equal(body.row.slug, "v6-fail");
    assert.match(body.readmePath, /README\.md$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-log: missing README errors out cleanly with exit 1", async () => {
  const dir = tmp("vr-log-cli-nofile");
  try {
    const r = await runCli([dir, "--event", "x", "--slug", "y", "--summary", "z"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ENOENT|no such file/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
