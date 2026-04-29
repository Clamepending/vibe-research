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
  assert.match(result.stdout, /vr-rl-sweep <subcommand>/);
  assert.match(result.stdout, /init <name>/);
  assert.match(result.stdout, /run <name>/);
  assert.match(result.stdout, /summary <name>/);
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

test("vr-rl-sweep init --sweep-name: writes runs/<slug>.tsv inside existing project", async () => {
  const dir = tmp("vr-rl-sweep-subsweep");
  mkdirSync(join(dir, "templates"));
  writeFileSync(join(dir, "templates", "paper-template.md"), "# <Project title>\n", "utf8");
  try {
    // Bootstrap parent project first.
    await runCli([
      "init", "parent",
      "--library", dir,
      "--sweep", "lr=[1e-3]",
      "--seeds", "1",
    ]);
    // Plan a follow-up sweep WITHOUT --force, but WITH --sweep-name. Must succeed.
    const result = await runCli([
      "init", "parent",
      "--library", dir,
      "--sweep", "lr=[5e-4,1e-3,2e-3]",
      "--seeds", "2",
      "--sweep-name", "sensitivity",
      "--json",
    ]);
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.sweepName, "sensitivity");
    assert.match(summary.runsTsv, /\/runs\/sensitivity\.tsv$/);
    assert.equal(summary.totalRows, 6); // 3 cells × 2 seeds
    assert.ok(existsSync(join(summary.projectDir, "runs.tsv")), "top-level runs.tsv preserved");
    assert.ok(existsSync(summary.runsTsv));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-rl-sweep run --sweep-name: reads runs/<slug>.tsv only", async () => {
  const dir = tmp("vr-rl-sweep-subrun");
  mkdirSync(join(dir, "templates"));
  writeFileSync(join(dir, "templates", "paper-template.md"), "# <Project title>\n", "utf8");
  try {
    await runCli(["init", "parent", "--library", dir, "--sweep", "lr=[1e-3]", "--seeds", "1"]);
    await runCli([
      "init", "parent", "--library", dir,
      "--sweep", "lr=[1e-2,1e-3]", "--seeds", "1",
      "--sweep-name", "ablate-lr",
    ]);
    const result = await runCli([
      "run", "parent", "--library", dir,
      "--sweep-name", "ablate-lr",
      "--launcher", "echo 'final_return: 42'",
      "--json",
    ]);
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ran, 2);
    assert.equal(summary.ok, 2);
    assert.match(summary.runsTsv, /\/runs\/ablate-lr\.tsv$/);
    // Top-level runs.tsv preserved with status=planned.
    const topTsv = readFileSync(join(dir, "projects", "parent", "runs.tsv"), "utf8");
    assert.match(topTsv, /\tplanned\t/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- bin/vr-rl-sweep summary ----

const SUMMARY_TSV_HEADER = [
  "started_at", "group", "name", "commit", "hypothesis",
  "mean_return", "std_return", "wandb_url", "status", "config",
].join("\t");

function summaryTsvRow({
  started_at = "2026-04-29T00:00:00Z",
  group = "ablate-lr",
  name = "ablate-lr-lr1e-3-seed0",
  commit = "abc1234",
  hypothesis = "lower lr improves return",
  mean_return = "",
  std_return = "",
  wandb_url = "",
  status = "planned",
  config = "{}",
} = {}) {
  return [started_at, group, name, commit, hypothesis, mean_return, std_return, wandb_url, status, config].join("\t");
}

function writeSummaryFixture(dir, projectName, { rows, sweepName } = {}) {
  const projectDir = join(dir, "projects", projectName);
  let tsvPath;
  if (sweepName) {
    mkdirSync(join(projectDir, "runs"), { recursive: true });
    tsvPath = join(projectDir, "runs", `${sweepName}.tsv`);
  } else {
    mkdirSync(projectDir, { recursive: true });
    tsvPath = join(projectDir, "runs.tsv");
  }
  const body = [SUMMARY_TSV_HEADER, ...rows.map(summaryTsvRow)].join("\n") + "\n";
  writeFileSync(tsvPath, body, "utf8");
  return tsvPath;
}

test("vr-rl-sweep summary: aggregates per-cell mean/std and ranks higher-is-better", async () => {
  const dir = tmp("vr-rl-sweep-summary");
  try {
    // Two cells, three seeds each, all done. Cell A is better.
    writeSummaryFixture(dir, "ppo", {
      rows: [
        { name: "ppo-lrA-seed0", status: "done", mean_return: "0.80" },
        { name: "ppo-lrA-seed1", status: "done", mean_return: "0.82" },
        { name: "ppo-lrA-seed2", status: "done", mean_return: "0.81" },
        { name: "ppo-lrB-seed0", status: "done", mean_return: "0.70" },
        { name: "ppo-lrB-seed1", status: "done", mean_return: "0.69" },
        { name: "ppo-lrB-seed2", status: "done", mean_return: "0.71" },
      ],
    });
    const result = await runCli(["summary", "ppo", "--library", dir, "--json"]);
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.totalRows, 6);
    assert.equal(body.statusCounts.done, 6);
    assert.equal(body.cellCount, 2);
    assert.equal(body.topCells[0].name, "ppo-lrA");
    assert.ok(Math.abs(body.topCells[0].mean_return - 0.81) < 0.001,
      `top mean ≈ 0.81; got ${body.topCells[0].mean_return}`);
    assert.ok(body.topCells[0].std_return > 0);
    assert.equal(body.topCells[0].seeds, 3);
    assert.equal(body.topCells[1].name, "ppo-lrB");
    assert.equal(body.direction, "higher");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-rl-sweep summary: --direction-lower flips ranking", async () => {
  const dir = tmp("vr-rl-sweep-summary-low");
  try {
    writeSummaryFixture(dir, "ppo", {
      rows: [
        { name: "ppo-lrA-seed0", status: "done", mean_return: "0.80" },
        { name: "ppo-lrB-seed0", status: "done", mean_return: "0.50" },
      ],
    });
    const result = await runCli(["summary", "ppo", "--library", dir, "--direction-lower", "--json"]);
    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.direction, "lower");
    assert.equal(body.topCells[0].name, "ppo-lrB");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-rl-sweep summary: counts mixed statuses (done/failed/running/planned)", async () => {
  const dir = tmp("vr-rl-sweep-summary-mixed");
  try {
    writeSummaryFixture(dir, "mixed", {
      rows: [
        { name: "mixed-a-seed0", status: "done", mean_return: "0.5" },
        { name: "mixed-a-seed1", status: "failed" },
        { name: "mixed-b-seed0", status: "running", started_at: new Date().toISOString() },
        { name: "mixed-c-seed0", status: "planned" },
      ],
    });
    const result = await runCli(["summary", "mixed", "--library", dir, "--json"]);
    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.totalRows, 4);
    assert.equal(body.statusCounts.done, 1);
    assert.equal(body.statusCounts.failed, 1);
    assert.equal(body.statusCounts.running, 1);
    assert.equal(body.statusCounts.planned, 1);
    assert.equal(body.cellCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-rl-sweep summary: --sweep-name reads runs/<slug>.tsv", async () => {
  const dir = tmp("vr-rl-sweep-summary-named");
  try {
    writeSummaryFixture(dir, "parent", {
      sweepName: "ablate-foo",
      rows: [
        { name: "ablate-foo-aA-seed0", status: "done", mean_return: "0.9" },
      ],
    });
    const result = await runCli([
      "summary", "parent", "--library", dir, "--sweep-name", "ablate-foo", "--json",
    ]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.sweep, "ablate-foo");
    assert.match(body.runsTsv, /runs\/ablate-foo\.tsv$/);
    assert.equal(body.cellCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-rl-sweep summary: --top limits topCells output", async () => {
  const dir = tmp("vr-rl-sweep-summary-top");
  try {
    writeSummaryFixture(dir, "many", {
      rows: [
        { name: "many-a-seed0", status: "done", mean_return: "0.9" },
        { name: "many-b-seed0", status: "done", mean_return: "0.8" },
        { name: "many-c-seed0", status: "done", mean_return: "0.7" },
        { name: "many-d-seed0", status: "done", mean_return: "0.6" },
        { name: "many-e-seed0", status: "done", mean_return: "0.5" },
        { name: "many-f-seed0", status: "done", mean_return: "0.4" },
      ],
    });
    const result = await runCli(["summary", "many", "--library", dir, "--top", "2", "--json"]);
    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.topCells.length, 2);
    assert.equal(body.allCells.length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-rl-sweep summary: missing runs.tsv exits 1 with clear error", async () => {
  const dir = tmp("vr-rl-sweep-summary-missing");
  try {
    mkdirSync(join(dir, "projects", "ghost"), { recursive: true });
    const result = await runCli(["summary", "ghost", "--library", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /runs\.tsv not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-rl-sweep summary (text mode): prints top cells with mean/std formatted", async () => {
  const dir = tmp("vr-rl-sweep-summary-text");
  try {
    writeSummaryFixture(dir, "ppo", {
      rows: [
        { name: "ppo-lrA-seed0", status: "done", mean_return: "0.80", wandb_url: "https://wandb.ai/me/proj/runs/abc" },
        { name: "ppo-lrA-seed1", status: "done", mean_return: "0.82" },
      ],
    });
    const result = await runCli(["summary", "ppo", "--library", dir]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /project: ppo/);
    assert.match(result.stdout, /status:.*2 total/);
    assert.match(result.stdout, /top cells/);
    assert.match(result.stdout, /ppo-lrA/);
    assert.match(result.stdout, /https:\/\/wandb\.ai/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----

test("vr-rl-sweep init: existing project without --force / --sweep-name exits 1", async () => {
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
