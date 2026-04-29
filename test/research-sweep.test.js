// Unit + CLI tests for src/research/sweep.js + bin/vr-rl-sweep.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  parseSweepEntry,
  expandCells,
  cellSlug,
  planSweep,
  renderRunsTsv,
  RUNS_TSV_COLUMNS,
} from "../src/research/sweep.js";

const VR_RL_SWEEP = path.resolve("bin/vr-rl-sweep");

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `${prefix}-`)); }

function runCli(args, { cwd, env = {}, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_RL_SWEEP, ...args], {
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

// ---- parseSweepEntry ----

test("parseSweepEntry: simple key=value", () => {
  assert.deepEqual(parseSweepEntry("lr=1e-3"), { key: "lr", values: ["1e-3"] });
});

test("parseSweepEntry: bracketed list", () => {
  assert.deepEqual(parseSweepEntry("lr=[1e-4,1e-3,1e-2]"), { key: "lr", values: ["1e-4", "1e-3", "1e-2"] });
});

test("parseSweepEntry: comma list without brackets", () => {
  assert.deepEqual(parseSweepEntry("batch=256,512,1024"), { key: "batch", values: ["256", "512", "1024"] });
});

test("parseSweepEntry: range(start, stop, step)", () => {
  const { values } = parseSweepEntry("k=range(1,5,1)");
  assert.deepEqual(values, ["1", "2", "3", "4", "5"]);
});

test("parseSweepEntry: range with float step", () => {
  const { values } = parseSweepEntry("k=range(0,1,0.25)");
  assert.deepEqual(values, ["0", "0.25", "0.5", "0.75", "1"]);
});

test("parseSweepEntry: logspace(a,b,n) returns n log-spaced values", () => {
  const { values } = parseSweepEntry("lr=logspace(1e-5,1e-2,4)");
  assert.equal(values.length, 4);
  // First/last should hit the endpoints (modulo display rounding).
  assert.match(values[0], /^1e-?5$|^0\.00001$/);
  assert.match(values[values.length - 1], /^0\.01$|^1e-?2$/);
});

test("parseSweepEntry: missing key throws", () => {
  assert.throws(() => parseSweepEntry("=foo"), /missing key/);
});

test("parseSweepEntry: missing value throws", () => {
  assert.throws(() => parseSweepEntry("key="), /missing value/);
});

test("parseSweepEntry: malformed range throws", () => {
  assert.throws(() => parseSweepEntry("k=range(1,abc,1)"), /three finite numbers/);
});

// ---- expandCells ----

test("expandCells: empty map returns single empty cell", () => {
  assert.deepEqual(expandCells({}), [{}]);
});

test("expandCells: single dimension", () => {
  assert.deepEqual(expandCells({ a: [1, 2, 3] }), [{ a: 1 }, { a: 2 }, { a: 3 }]);
});

test("expandCells: Cartesian product over multi dimensions", () => {
  const cells = expandCells({ a: ["x", "y"], b: [1, 2], c: ["t"] });
  assert.equal(cells.length, 4);
  assert.deepEqual(cells, [
    { a: "x", b: 1, c: "t" },
    { a: "x", b: 2, c: "t" },
    { a: "y", b: 1, c: "t" },
    { a: "y", b: 2, c: "t" },
  ]);
});

test("expandCells: empty values throw", () => {
  assert.throws(() => expandCells({ a: [] }), /no values/);
});

// ---- cellSlug ----

test("cellSlug: deterministic + filename-safe", () => {
  assert.equal(cellSlug({ lr: "1e-3", batch: "256" }), "lr1e-3-batch256");
  assert.equal(cellSlug({ name: "foo bar/v2" }), "namefoo_bar_v2");
});

test("cellSlug: empty cell returns 'default'", () => {
  assert.equal(cellSlug({}), "default");
});

// ---- planSweep ----

test("planSweep: cells × seeds rows", () => {
  const plan = planSweep({
    name: "demo",
    base: { lr: "1e-3" },
    sweep: { lr: ["1e-4", "1e-3"], batch: ["256", "512"] },
    seeds: 3,
    hypothesis: "knob study",
    commit: "deadbeef",
    now: () => "2026-04-28T20:00:00Z",
  });
  assert.equal(plan.rows.length, 2 * 2 * 3); // 4 cells × 3 seeds
  assert.equal(plan.rows[0].group, "demo");
  assert.equal(plan.rows[0].commit, "deadbeef");
  assert.equal(plan.rows[0].hypothesis, "knob study");
  assert.equal(plan.rows[0].status, "planned");
  assert.equal(plan.rows[0].started_at, "2026-04-28T20:00:00Z");
  // seed names in expected order.
  const names = plan.rows.map((r) => r.name);
  for (const name of names) assert.match(name, /-seed[0-2]$/);
});

test("planSweep: config column merges base + cell overrides as JSON", () => {
  const plan = planSweep({
    name: "demo",
    base: { lr: "default", batch: "32" },
    sweep: { lr: ["1e-4", "1e-3"] },
    seeds: 1,
  });
  const cfgs = plan.rows.map((r) => JSON.parse(r.config));
  assert.deepEqual(cfgs[0], { lr: "1e-4", batch: "32" });
  assert.deepEqual(cfgs[1], { lr: "1e-3", batch: "32" });
});

test("planSweep: seeds clamped to >= 1", () => {
  const plan = planSweep({ name: "x", sweep: { a: ["v"] }, seeds: 0 });
  assert.equal(plan.rows.length, 1);
});

test("planSweep: missing name throws", () => {
  assert.throws(() => planSweep({ sweep: { a: ["v"] } }), /name is required/);
});

// ---- renderRunsTsv ----

test("renderRunsTsv: header line uses RUNS_TSV_COLUMNS in order", () => {
  const tsv = renderRunsTsv([]);
  const header = tsv.trimEnd().split("\n")[0].split("\t");
  assert.deepEqual(header, RUNS_TSV_COLUMNS);
});

test("renderRunsTsv: rows produce one TSV line each", () => {
  const plan = planSweep({
    name: "demo",
    sweep: { a: ["x", "y"] },
    seeds: 2,
  });
  const tsv = renderRunsTsv(plan.rows);
  const lines = tsv.trimEnd().split("\n");
  assert.equal(lines.length, 1 + 2 * 2);
});

test("renderRunsTsv: tabs and newlines inside cells get escaped", () => {
  const plan = planSweep({
    name: "x",
    sweep: { a: ["v"] },
    seeds: 1,
    hypothesis: "line1\tline2\nline3",
  });
  const tsv = renderRunsTsv(plan.rows);
  assert.match(tsv, /line1\\tline2\\nline3/);
});

// ---- bin/vr-rl-sweep ----

test("vr-rl-sweep --help: exits 0", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /vr-rl-sweep init/);
});

test("vr-rl-sweep no args: exits 2", async () => {
  const result = await runCli([]);
  assert.equal(result.status, 2);
});

test("vr-rl-sweep init: bootstraps project + writes runs.tsv", async () => {
  const dir = tmp("vr-rl-sweep");
  // Ship templates so init can fill paper.md.
  mkdirSync(join(dir, "templates"));
  writeFileSync(join(dir, "templates", "paper-template.md"), "# <Project title>\n", "utf8");
  try {
    const result = await runCli([
      "init", "lr-bs-grid",
      "--library", dir,
      "--base", "lr=1e-3,batch=256,frames=4",
      "--sweep", "lr=[1e-4,1e-3,1e-2]",
      "--sweep", "batch=[256,512]",
      "--seeds", "3",
      "--hypothesis", "lr/batch interaction",
      "--commit", "abc1234",
      "--json",
    ]);
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.projectDir, join(dir, "projects", "lr-bs-grid"));
    assert.equal(summary.cells, 6);   // 3 lr × 2 batch
    assert.equal(summary.seeds, 3);
    assert.equal(summary.totalRows, 18);
    assert.equal(summary.commit, "abc1234");

    const tsv = readFileSync(summary.runsTsv, "utf8");
    const lines = tsv.trimEnd().split("\n");
    assert.equal(lines.length, 1 + 18);  // header + 18 rows
    const header = lines[0].split("\t");
    assert.ok(header.includes("group"));
    assert.ok(header.includes("commit"));
    assert.ok(header.includes("status"));

    // Project README + paper exist.
    assert.ok(existsSync(join(summary.projectDir, "README.md")));
    assert.ok(existsSync(join(summary.projectDir, "paper.md")));
    assert.ok(existsSync(join(summary.projectDir, "results")));
    assert.ok(existsSync(join(summary.projectDir, "figures")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-rl-sweep init: human-readable output with no --json", async () => {
  const dir = tmp("vr-rl-sweep-human");
  mkdirSync(join(dir, "templates"));
  writeFileSync(join(dir, "templates", "paper-template.md"), "# <Project title>\n", "utf8");
  try {
    const result = await runCli([
      "init", "human-fmt",
      "--library", dir,
      "--sweep", "lr=[1e-3,1e-4]",
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /planned 2 rows/);
    assert.match(result.stdout, /runs.tsv:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-rl-sweep init: malformed --sweep exits 1", async () => {
  const dir = tmp("vr-rl-sweep-bad");
  try {
    const result = await runCli([
      "init", "x",
      "--library", dir,
      "--sweep", "no-equals-sign",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sweep spec/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-rl-sweep init: existing project without --force exits 1", async () => {
  const dir = tmp("vr-rl-sweep-collide");
  mkdirSync(join(dir, "templates"));
  writeFileSync(join(dir, "templates", "paper-template.md"), "# <Project title>\n", "utf8");
  mkdirSync(join(dir, "projects", "exists"), { recursive: true });
  try {
    const result = await runCli([
      "init", "exists",
      "--library", dir,
      "--sweep", "lr=[1e-3]",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
