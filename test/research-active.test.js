// Unit + CLI tests for src/research/active-edit.js + bin/vr-research-active.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  addActiveRow,
  removeActiveRow,
  __internal,
} from "../src/research/active-edit.js";

const VR_RESEARCH_ACTIVE = path.resolve("bin/vr-research-active");

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `${prefix}-`)); }

function runCli(args, { cwd, env = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_RESEARCH_ACTIVE, ...args], {
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

## ACTIVE

| move | result doc | branch | agent | started |
|------|-----------|--------|-------|---------|
| v0-existing | [v0-existing](results/v0-existing.md) | [r/v0-existing](https://github.com/example/x/tree/r/v0-existing) | 0 | 2026-04-25 |

## QUEUE

| move | starting-point | why |
|------|----------------|-----|
| v1-next | main | first move |

## LOG

| date | event | slug or ref | one-line summary | link |
|------|-------|-------------|-------------------|------|
`;

function makeProject(prefix = "vr-active") {
  const dir = tmp(prefix);
  writeFileSync(join(dir, "README.md"), README_BOILERPLATE);
  return dir;
}

// ---- renderActiveRow ----

test("renderActiveRow: builds the canonical row format with branch label extracted from URL", () => {
  const out = __internal.renderActiveRow({
    slug: "v3-cand",
    resultPath: "results/v3-cand.md",
    branchUrl: "https://github.com/example/x/tree/r/v3-cand",
    agent: "0",
    started: "2026-04-29",
  });
  assert.equal(
    out,
    "| v3-cand | [v3-cand](results/v3-cand.md) | [r/v3-cand](https://github.com/example/x/tree/r/v3-cand) | 0 | 2026-04-29 |",
  );
});

test("renderActiveRow: defaults agent='0' and started=today UTC", () => {
  const out = __internal.renderActiveRow({
    slug: "x",
    resultPath: "results/x.md",
    branchUrl: "https://github.com/example/x/tree/r/x",
  });
  const today = __internal.todayUtc();
  assert.match(out, new RegExp(`\\| 0 \\| ${today} \\|$`));
});

// ---- addActiveRow ----

test("addActiveRow: inserts at the top of the ACTIVE table", async () => {
  const dir = makeProject("vr-active-add");
  try {
    const readmePath = join(dir, "README.md");
    const result = await addActiveRow({
      readmePath,
      row: {
        slug: "v1-newer",
        resultPath: "results/v1-newer.md",
        branchUrl: "https://github.com/example/x/tree/r/v1-newer",
        agent: "0",
        started: "2026-04-29",
      },
    });
    assert.equal(result.added, true);
    const after = readFileSync(readmePath, "utf8");
    const newerIdx = after.indexOf("v1-newer");
    const olderIdx = after.indexOf("v0-existing");
    assert.ok(newerIdx > 0 && olderIdx > 0);
    assert.ok(newerIdx < olderIdx, "newer row must precede older row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addActiveRow: rejects duplicate slug", async () => {
  const dir = makeProject("vr-active-dup");
  try {
    const readmePath = join(dir, "README.md");
    await assert.rejects(
      addActiveRow({
        readmePath,
        row: {
          slug: "v0-existing",
          resultPath: "results/v0-existing.md",
          branchUrl: "https://github.com/example/x/tree/r/v0-existing",
        },
      }),
      /already has a row for slug "v0-existing"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addActiveRow: errors when README has no ACTIVE table", async () => {
  const dir = tmp("vr-active-no-table");
  try {
    writeFileSync(join(dir, "README.md"), "# x\n\nno active here.\n");
    await assert.rejects(
      addActiveRow({
        readmePath: join(dir, "README.md"),
        row: {
          slug: "x",
          resultPath: "results/x.md",
          branchUrl: "https://github.com/example/x/tree/r/x",
        },
      }),
      /no ACTIVE table/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addActiveRow: rejects missing required fields", async () => {
  const dir = makeProject("vr-active-missing");
  try {
    const readmePath = join(dir, "README.md");
    await assert.rejects(
      addActiveRow({ readmePath, row: { slug: "x", resultPath: "r" } }),
      /branchUrl is required/,
    );
    await assert.rejects(
      addActiveRow({ readmePath, row: { slug: "", resultPath: "r", branchUrl: "u" } }),
      /slug is required/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- removeActiveRow ----

test("removeActiveRow: deletes the row whose slug matches", async () => {
  const dir = makeProject("vr-active-rm");
  try {
    const readmePath = join(dir, "README.md");
    const result = await removeActiveRow({ readmePath, slug: "v0-existing" });
    assert.equal(result.removed, true);
    assert.equal(result.slug, "v0-existing");
    const after = readFileSync(readmePath, "utf8");
    assert.equal(after.includes("v0-existing"), false, "row should be gone");
    // QUEUE row "v1-next" must still be there.
    assert.match(after, /v1-next/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeActiveRow: errors when slug not found", async () => {
  const dir = makeProject("vr-active-rm-miss");
  try {
    const readmePath = join(dir, "README.md");
    await assert.rejects(
      removeActiveRow({ readmePath, slug: "nope" }),
      /no row for slug "nope"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeActiveRow: only removes from ACTIVE, not QUEUE / LOG with same slug", async () => {
  // Edge case: imagine ACTIVE and QUEUE both mention "v1-next" (they
  // shouldn't, but a malformed README might). Confirm we only delete
  // the ACTIVE row.
  const dir = tmp("vr-active-only");
  try {
    const readme = `# x

## ACTIVE

| move | result doc | branch | agent | started |
|------|-----------|--------|-------|---------|
| v1-next | a | b | 0 | 2026-04-29 |

## QUEUE

| move | starting-point | why |
|------|----------------|-----|
| v1-next | main | first |

## LOG

| date | event | slug or ref | one-line summary | link |
|------|-------|-------------|-------------------|------|
`;
    writeFileSync(join(dir, "README.md"), readme);
    await removeActiveRow({ readmePath: join(dir, "README.md"), slug: "v1-next" });
    const after = readFileSync(join(dir, "README.md"), "utf8");
    // QUEUE row preserved.
    assert.match(after, /\|\s*v1-next\s*\|\s*main\s*\|/);
    // ACTIVE row gone (the one with agent column).
    assert.equal(/\|\s*v1-next\s*\|\s*a\s*\|/.test(after), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- bin/vr-research-active ----

test("vr-research-active --help: exits 0", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /vr-research-active/);
});

test("vr-research-active: missing project-dir or subcommand exits 2", async () => {
  const r1 = await runCli(["add", "--slug", "x", "--result", "r", "--branch", "b"]);
  assert.equal(r1.status, 2);
  // Either missing project-dir OR malformed subcommand — either is fine.
});

test("vr-research-active add: missing flags exit 2", async () => {
  const dir = makeProject("vr-active-cli-missing");
  try {
    const r = await runCli([dir, "add", "--slug", "x"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--result is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-active add: appends row + prints confirmation", async () => {
  const dir = makeProject("vr-active-cli-add");
  try {
    const r = await runCli([
      dir, "add",
      "--slug", "v9-cli",
      "--result", "results/v9-cli.md",
      "--branch", "https://github.com/example/x/tree/r/v9-cli",
    ]);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /added ACTIVE row/);
    const after = readFileSync(join(dir, "README.md"), "utf8");
    assert.match(after, /\|\s*v9-cli\s*\|\s*\[v9-cli\]\(results\/v9-cli\.md\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-active remove: drops the row + prints confirmation", async () => {
  const dir = makeProject("vr-active-cli-rm");
  try {
    const r = await runCli([dir, "remove", "--slug", "v0-existing"]);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /removed ACTIVE row/);
    const after = readFileSync(join(dir, "README.md"), "utf8");
    assert.equal(after.includes("v0-existing"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-active --json: returns structured result", async () => {
  const dir = makeProject("vr-active-cli-json");
  try {
    const r = await runCli([
      dir, "add",
      "--slug", "vj",
      "--result", "results/vj.md",
      "--branch", "https://github.com/example/x/tree/r/vj",
      "--json",
    ]);
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.added, true);
    assert.equal(body.row.slug, "vj");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-active remove on missing slug exits 1 cleanly", async () => {
  const dir = makeProject("vr-active-cli-rm-miss");
  try {
    const r = await runCli([dir, "remove", "--slug", "nope"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no row for slug "nope"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
