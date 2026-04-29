// Tests for src/research/sweep-runner.js + the `run` subcommand of
// bin/vr-rl-sweep. The runner's spawn is dependency-injected so tests
// drive every code path with stub responses.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  parseRunsTsv,
  serializeRunsTsv,
  expandLauncher,
  extractMetric,
  extractWandbUrl,
  runPlannedRows,
  __internal,
} from "../src/research/sweep-runner.js";

const VR_RL_SWEEP = path.resolve("bin/vr-rl-sweep");

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `${prefix}-`)); }

// ---- TSV parser/serializer ----

test("parseRunsTsv: empty or whitespace-only returns empty headers + rows", () => {
  assert.deepEqual(parseRunsTsv(""), { headers: [], rows: [] });
  assert.deepEqual(parseRunsTsv("\n\n"), { headers: [], rows: [] });
});

test("parseRunsTsv + serializeRunsTsv: round-trip preserves headers + rows", () => {
  const text = "started_at\tgroup\tname\tstatus\n\t\trow-1\tplanned\n2026-04-28\tg1\trow-2\tdone\n";
  const parsed = parseRunsTsv(text);
  assert.deepEqual(parsed.headers, ["started_at", "group", "name", "status"]);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].name, "row-1");
  assert.equal(parsed.rows[1].status, "done");
  const re = serializeRunsTsv(parsed);
  assert.equal(re, text);
});

test("parseRunsTsv: skips blank lines between rows", () => {
  const text = "a\tb\n1\t2\n\n3\t4\n";
  const { rows } = parseRunsTsv(text);
  assert.equal(rows.length, 2);
});

// ---- expandLauncher ----

test("expandLauncher: substitutes ${key} from config map", () => {
  assert.equal(expandLauncher("python train.py --lr=${lr} --batch=${batch}", { lr: "1e-3", batch: "256" }),
    "python train.py --lr=1e-3 --batch=256");
});

test("expandLauncher: leaves ${key} alone when value missing or empty", () => {
  assert.equal(expandLauncher("X=${unfilled}", {}), "X=${unfilled}");
  assert.equal(expandLauncher("X=${unfilled}", { unfilled: "" }), "X=${unfilled}");
});

// ---- defaultLauncher ----

test("defaultLauncher: extracts seed from row.name + emits --key=value flags", () => {
  const cmd = __internal.defaultLauncher(
    { name: "lr1e-3-batch256-seed2" },
    { lr: "1e-3", batch: "256" },
  );
  assert.match(cmd, /python train\.py/);
  assert.match(cmd, /--lr=1e-3/);
  assert.match(cmd, /--batch=256/);
  assert.match(cmd, /--seed=2/);
});

test("defaultLauncher: shell-quotes config values that need it", () => {
  const cmd = __internal.defaultLauncher(
    { name: "x-seed0" },
    { note: "hello world" },
  );
  assert.match(cmd, /--note='hello world'/);
});

// ---- extractMetric ----

test("extractMetric: pulls out final_return: 1.23 forms", () => {
  assert.equal(extractMetric("Episode 100\nfinal_return: 12.5\nDone."), 12.5);
  assert.equal(extractMetric("mean_return = -0.3 something"), -0.3);
  assert.equal(extractMetric("final_return: 1.5e2"), 150);
});

test("extractMetric: returns null on no match", () => {
  assert.equal(extractMetric("nothing here"), null);
  assert.equal(extractMetric(""), null);
  assert.equal(extractMetric(null), null);
});

test("extractMetric: custom regex", () => {
  assert.equal(extractMetric("score=42.5 elsewhere", /score=([0-9.]+)/), 42.5);
});

// ---- extractWandbUrl ----

test("extractWandbUrl: standard wandb 'View run at <url>' line", () => {
  const stdout = "wandb: 🚀 View run at https://wandb.ai/alice/proj-x/runs/abc123";
  assert.equal(extractWandbUrl(stdout), "https://wandb.ai/alice/proj-x/runs/abc123");
});

test("extractWandbUrl: prefers /runs/<id> URL when both run + project URLs present", () => {
  const stdout = [
    "wandb: View project at https://wandb.ai/alice/proj-x",
    "wandb: View run at https://wandb.ai/alice/proj-x/runs/abc123",
  ].join("\n");
  assert.equal(extractWandbUrl(stdout), "https://wandb.ai/alice/proj-x/runs/abc123");
});

test("extractWandbUrl: falls back to project URL when no run URL", () => {
  const stdout = "Synced 3 W&B file(s) https://wandb.ai/alice/proj-x";
  assert.equal(extractWandbUrl(stdout), "https://wandb.ai/alice/proj-x");
});

test("extractWandbUrl: strips trailing punctuation", () => {
  const stdout = "View run at https://wandb.ai/alice/proj-x/runs/abc123.";
  assert.equal(extractWandbUrl(stdout), "https://wandb.ai/alice/proj-x/runs/abc123");
});

test("extractWandbUrl: returns empty string when no wandb URL present", () => {
  assert.equal(extractWandbUrl("nothing wandb here"), "");
  assert.equal(extractWandbUrl(""), "");
  assert.equal(extractWandbUrl(null), "");
});

test("extractWandbUrl: handles JSON-quoted URL forms", () => {
  const stdout = '{"wandb":"https://wandb.ai/alice/proj/runs/xyz"}';
  assert.equal(extractWandbUrl(stdout), "https://wandb.ai/alice/proj/runs/xyz");
});

test("runPlannedRows: fills wandb_url when launcher prints a wandb URL", async () => {
  const dir = tmp("runner-wandb");
  const tsv = join(dir, "runs.tsv");
  writeFileSync(tsv, plannedTsv(1), "utf8");
  try {
    const result = await runPlannedRows({
      runsTsvPath: tsv,
      spawnImpl: async () => ({
        exitCode: 0,
        stdout: "starting...\nwandb: 🚀 View run at https://wandb.ai/me/sweep/runs/jq8x\nfinal_return: 12.5\n",
        stderr: "",
        timedOut: false,
      }),
    });
    assert.equal(result.ok, 1);
    const after = parseRunsTsv(readFileSync(tsv, "utf8"));
    assert.equal(after.rows[0].wandb_url, "https://wandb.ai/me/sweep/runs/jq8x");
    assert.equal(after.rows[0].mean_return, "12.5");
    assert.equal(after.rows[0].status, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPlannedRows: leaves wandb_url empty when no URL in stdout", async () => {
  const dir = tmp("runner-no-wandb");
  const tsv = join(dir, "runs.tsv");
  writeFileSync(tsv, plannedTsv(1), "utf8");
  try {
    await runPlannedRows({
      runsTsvPath: tsv,
      spawnImpl: async () => ({ exitCode: 0, stdout: "final_return: 1.0\n", stderr: "", timedOut: false }),
    });
    const after = parseRunsTsv(readFileSync(tsv, "utf8"));
    assert.equal(after.rows[0].wandb_url, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- runPlannedRows: stubbed spawn ----

function plannedTsv(rows = 1) {
  const headers = "started_at\tgroup\tname\tcommit\thypothesis\tmean_return\tstd_return\twandb_url\tstatus\tconfig\n";
  const out = [headers];
  for (let i = 0; i < rows; i += 1) {
    out.push(`\tdemo\tlr1e-${i + 3}-seed0\tabc1234\t\t\t\t\tplanned\t${JSON.stringify({ lr: `1e-${i + 3}` })}\n`);
  }
  return out.join("");
}

test("runPlannedRows: marks ok + fills metric when launcher exits 0 with metric", async () => {
  const dir = tmp("runner-ok");
  const tsv = join(dir, "runs.tsv");
  writeFileSync(tsv, plannedTsv(1), "utf8");
  try {
    const result = await runPlannedRows({
      runsTsvPath: tsv,
      launcherTemplate: "echo final_return: 88.5",
      spawnImpl: async () => ({ exitCode: 0, stdout: "final_return: 88.5\n", stderr: "", timedOut: false }),
    });
    assert.equal(result.ran, 1);
    assert.equal(result.ok, 1);
    assert.equal(result.failed, 0);
    const after = parseRunsTsv(readFileSync(tsv, "utf8"));
    assert.equal(after.rows[0].status, "done");
    assert.equal(after.rows[0].mean_return, "88.5");
    assert.match(after.rows[0].started_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPlannedRows: marks failed when exit != 0", async () => {
  const dir = tmp("runner-fail");
  const tsv = join(dir, "runs.tsv");
  writeFileSync(tsv, plannedTsv(1), "utf8");
  try {
    const result = await runPlannedRows({
      runsTsvPath: tsv,
      spawnImpl: async () => ({ exitCode: 1, stdout: "", stderr: "boom", timedOut: false }),
    });
    assert.equal(result.failed, 1);
    const after = parseRunsTsv(readFileSync(tsv, "utf8"));
    assert.equal(after.rows[0].status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPlannedRows: skips already-done rows + retries failed/running", async () => {
  const dir = tmp("runner-mixed");
  const tsv = join(dir, "runs.tsv");
  const rows = [
    "headers",
  ];
  // Build the TSV directly.
  const headers = "name\tstatus\tmean_return\tconfig";
  const body = [
    headers,
    "a-seed0\tdone\t1.0\t{}",
    "b-seed0\tplanned\t\t{}",
    "c-seed0\tfailed\t\t{}",
    "d-seed0\tskipped\t\t{}",
    "",
  ].join("\n");
  writeFileSync(tsv, body, "utf8");
  try {
    let calls = 0;
    const result = await runPlannedRows({
      runsTsvPath: tsv,
      spawnImpl: async () => { calls += 1; return { exitCode: 0, stdout: "final_return: 5", stderr: "", timedOut: false }; },
    });
    // a (done) + d (skipped) skipped; b (planned) + c (failed) re-run
    assert.equal(calls, 2);
    assert.equal(result.ran, 2);
    assert.equal(result.skipped, 2);
    const after = parseRunsTsv(readFileSync(tsv, "utf8"));
    assert.equal(after.rows[0].status, "done");
    assert.equal(after.rows[1].status, "done");
    assert.equal(after.rows[2].status, "done");
    assert.equal(after.rows[3].status, "skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPlannedRows: --max-rows caps ran count", async () => {
  const dir = tmp("runner-max");
  const tsv = join(dir, "runs.tsv");
  writeFileSync(tsv, plannedTsv(5), "utf8");
  try {
    const result = await runPlannedRows({
      runsTsvPath: tsv,
      maxRows: 2,
      spawnImpl: async () => ({ exitCode: 0, stdout: "final_return: 1", stderr: "", timedOut: false }),
    });
    assert.equal(result.ran, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPlannedRows: aggregates std across seeds of the same cell", async () => {
  const dir = tmp("runner-std");
  const tsv = join(dir, "runs.tsv");
  // 1 cell, 3 seeds.
  const headers = "name\tmean_return\tstd_return\tstatus\tconfig";
  const body = [
    headers,
    "lr1e-3-seed0\t\t\tplanned\t{}",
    "lr1e-3-seed1\t\t\tplanned\t{}",
    "lr1e-3-seed2\t\t\tplanned\t{}",
    "",
  ].join("\n");
  writeFileSync(tsv, body, "utf8");
  try {
    let n = 0;
    const returns = [10, 12, 14];  // mean=12, std≈1.633
    await runPlannedRows({
      runsTsvPath: tsv,
      spawnImpl: async () => ({ exitCode: 0, stdout: `final_return: ${returns[n++]}`, stderr: "", timedOut: false }),
    });
    const after = parseRunsTsv(readFileSync(tsv, "utf8"));
    for (const row of after.rows) {
      assert.equal(row.status, "done");
      const std = Number(row.std_return);
      assert.ok(std > 1.6 && std < 1.7, `expected std~1.633, got ${row.std_return}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPlannedRows: persists 'running' BEFORE spawn so a crash doesn't lose state", async () => {
  const dir = tmp("runner-running");
  const tsv = join(dir, "runs.tsv");
  writeFileSync(tsv, plannedTsv(1), "utf8");
  let observed = null;
  try {
    await runPlannedRows({
      runsTsvPath: tsv,
      spawnImpl: async () => {
        // Read the TSV state DURING the spawn — should be "running".
        observed = parseRunsTsv(readFileSync(tsv, "utf8")).rows[0].status;
        return { exitCode: 0, stdout: "final_return: 1", stderr: "", timedOut: false };
      },
    });
    assert.equal(observed, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- bin/vr-rl-sweep run ----

function runCli(args, { cwd, env = {}, timeoutMs = 30_000 } = {}) {
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

test("vr-rl-sweep run: end-to-end with a real launcher (echo + grep)", async () => {
  const lib = tmp("vr-rl-sweep-run");
  mkdirSync(join(lib, "templates"));
  writeFileSync(join(lib, "templates", "paper-template.md"), "# <Project title>\n", "utf8");
  // Plan first.
  let planResult = await runCli([
    "init", "echo-test",
    "--library", lib,
    "--sweep", "lr=[1e-3,1e-4]",
    "--seeds", "1",
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed: ${planResult.stderr}`);
  // Run with a launcher that echoes a metric (so spawn is real but cheap).
  // Each cell prints "final_return: <its lr in scientific notation>".
  // Easiest: just print a constant — we just want to verify the run loop.
  const result = await runCli([
    "run", "echo-test",
    "--library", lib,
    "--launcher", "echo 'final_return: 7.5'",
    "--json",
  ]);
  assert.equal(result.status, 0, `run failed: ${result.stderr}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ran, 2);
  assert.equal(summary.ok, 2);
  assert.equal(summary.failed, 0);
  const tsv = parseRunsTsv(readFileSync(summary.runsTsv, "utf8"));
  for (const row of tsv.rows) {
    assert.equal(row.status, "done");
    assert.equal(row.mean_return, "7.5");
  }
});

test("vr-rl-sweep run: missing project errors", async () => {
  const lib = tmp("vr-rl-sweep-missing");
  try {
    const result = await runCli(["run", "no-such-project", "--library", lib]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT|no such file/i);
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("vr-rl-sweep run: bad --metric regex exits 1 with message", async () => {
  const lib = tmp("vr-rl-sweep-regex");
  mkdirSync(join(lib, "templates"));
  writeFileSync(join(lib, "templates", "paper-template.md"), "# <Project title>\n", "utf8");
  await runCli([
    "init", "regex-test",
    "--library", lib,
    "--sweep", "lr=[1]",
    "--json",
  ]);
  try {
    const result = await runCli(["run", "regex-test", "--library", lib, "--metric", "[invalid("]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid --metric regex/);
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});
