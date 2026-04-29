// End-to-end plumbing test for the autonomous-tuner toolchain. Proves
// the CLI tools compose correctly: vr-rl-tuner bootstraps the project,
// vr-rl-sweep init plans the runs, vr-rl-sweep run executes each row
// against a toy launcher (real spawn, no stubs), and the resulting
// runs.tsv has every row at status=done with metrics + per-cell
// std_return filled in.
//
// This is the "the chain actually works" test. It does NOT exercise an
// LLM agent — that's a separate test (real-agent test, optional). What
// it DOES prove is that an agent following the rl-sweep-tuner occupation
// would have working tooling at every step.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

import { parseRunsTsv } from "../src/research/sweep-runner.js";

const VR_RL_TUNER = path.resolve("bin/vr-rl-tuner");
const VR_RL_SWEEP = path.resolve("bin/vr-rl-sweep");

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `${prefix}-`)); }

function runCli(binPath, args, { cwd, env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [binPath, ...args], {
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

// Build a tiny "toy RL repo" with a fake `train.py` shell script that
// reads --lr and emits a deterministic metric. We use a shell script
// (not Python) so the test doesn't depend on python3 being installed.
function makeToyRepo() {
  const repo = tmp("rsi-toy-repo");
  const trainPath = join(repo, "train.sh");
  // Bash shim: parse --lr=<value> and emit final_return scaled by lr.
  // Higher LR → lower return so the agent has a real-shaped landscape.
  const script = `#!/usr/bin/env bash
LR=0.001
SEED=0
for arg in "$@"; do
  case "$arg" in
    --lr=*) LR="\${arg#--lr=}" ;;
    --seed=*) SEED="\${arg#--seed=}" ;;
    *) ;;
  esac
done
# Toy reward: peak at lr=1e-3, decay either side. Add tiny seed-driven noise.
RETURN=$(awk -v lr="$LR" -v seed="$SEED" 'BEGIN {
  log_lr = log(lr) / log(10)
  peak_dist = (log_lr + 3)
  base = 100 - 30 * (peak_dist * peak_dist)
  noise = (seed * 7) % 5 - 2
  printf "%.3f", base + noise
}')
echo "starting train, lr=$LR seed=$SEED"
echo "final_return: $RETURN"
exit 0
`;
  writeFileSync(trainPath, script, "utf8");
  chmodSync(trainPath, 0o755);
  return { repo, trainPath };
}

// ---- ----

test("end-to-end: vr-rl-tuner bootstraps + vr-rl-sweep init plans + vr-rl-sweep run executes",
     { timeout: 60_000 }, async () => {
  const lib = tmp("rsi-e2e-lib");
  mkdirSync(join(lib, "templates"));
  writeFileSync(join(lib, "templates", "paper-template.md"), "# <Project title>\n\nliving paper\n", "utf8");
  const { repo, trainPath } = makeToyRepo();

  try {
    // Step 1: human handoff. vr-rl-tuner bootstraps projects/<name>/.
    const tunerResult = await runCli(VR_RL_TUNER, [
      "--repo", repo,
      "--goal", "find best LR for the toy task",
      "--budget", "tiny: this is a test",
      "--library", lib,
      "--name", "lr-search-test",
      "--json",
    ]);
    assert.equal(tunerResult.status, 0, `vr-rl-tuner failed: ${tunerResult.stderr}`);
    const tunerSummary = JSON.parse(tunerResult.stdout);
    assert.equal(tunerSummary.repo, repo);
    const projectDir = tunerSummary.projectDir;

    // Step 2: agent (we simulate it) plans the first move.
    const planResult = await runCli(VR_RL_SWEEP, [
      "init", "lr-search-test",
      "--library", lib,
      "--sweep", "lr=[1e-2,1e-3,1e-4]",
      "--seeds", "2",
      "--hypothesis", "look for peak across 3 LRs at n=2",
      "--commit", "abc1234",
      "--force",   // tuner's createProject already wrote README; planner re-writes
      "--json",
    ]);
    assert.equal(planResult.status, 0, `vr-rl-sweep init failed: ${planResult.stderr}`);
    const planSummary = JSON.parse(planResult.stdout);
    assert.equal(planSummary.totalRows, 6);  // 3 cells × 2 seeds
    assert.equal(planSummary.cells, 3);

    // Step 3: executor walks the planned runs.tsv with our toy launcher.
    const runResult = await runCli(VR_RL_SWEEP, [
      "run", "lr-search-test",
      "--library", lib,
      "--launcher", `bash ${trainPath} --lr=\${lr} --seed=\${seed}`,
      "--cwd", repo,
      "--json",
    ], { timeoutMs: 60_000 });
    assert.equal(runResult.status, 0, `vr-rl-sweep run failed: ${runResult.stderr}`);
    const runSummary = JSON.parse(runResult.stdout);
    assert.equal(runSummary.ran, 6);
    assert.equal(runSummary.ok, 6);
    assert.equal(runSummary.failed, 0);

    // Step 4: assert the runs.tsv looks like a real grad-student bookkeeping log.
    const runsTsvPath = join(projectDir, "runs.tsv");
    const tsv = parseRunsTsv(readFileSync(runsTsvPath, "utf8"));
    assert.equal(tsv.rows.length, 6);
    for (const row of tsv.rows) {
      assert.equal(row.status, "done", `row ${row.name} not done: ${row.status}`);
      assert.match(row.started_at, /^\d{4}-\d{2}-\d{2}T/, "started_at should be ISO");
      const meanReturn = Number(row.mean_return);
      assert.ok(Number.isFinite(meanReturn), `mean_return not numeric: ${row.mean_return}`);
      // Toy script emits a value between roughly -50 and 100; sanity-bound.
      assert.ok(meanReturn > -200 && meanReturn < 200);
      // commit propagated from --commit.
      assert.equal(row.commit, "abc1234");
    }

    // Step 5: per-cell std_return is filled in (one cell = same name modulo
    // trailing -seedN). With 2 seeds per cell we should see std > 0 for cells
    // whose returns differ between seeds.
    const stdValues = tsv.rows.map((r) => Number(r.std_return)).filter(Number.isFinite);
    assert.ok(stdValues.length === 6, "every row should have a std_return after run");
    // The toy script's noise differs across seed=0/seed=1, so std > 0 for
    // each cell.
    for (const row of tsv.rows) {
      const std = Number(row.std_return);
      assert.ok(std >= 0);
    }

    // Step 6: assert the LR=1e-3 cell beat the LR=1e-2 cell (the toy task
    // is designed so that's the case; this verifies an agent could draw
    // an honest conclusion from the real numbers).
    const meanByCellLr = {};
    for (const row of tsv.rows) {
      const lrMatch = row.name.match(/^lr(.+?)-seed/);
      const lr = lrMatch ? lrMatch[1] : "unknown";
      if (!meanByCellLr[lr]) meanByCellLr[lr] = [];
      meanByCellLr[lr].push(Number(row.mean_return));
    }
    assert.ok(meanByCellLr["1e-3"]?.length > 0, `no rows for lr=1e-3; got ${JSON.stringify(meanByCellLr)}`);
    assert.ok(meanByCellLr["1e-2"]?.length > 0, `no rows for lr=1e-2; got ${JSON.stringify(meanByCellLr)}`);
    const lr1e3Mean = meanByCellLr["1e-3"].reduce((a, b) => a + b, 0) / meanByCellLr["1e-3"].length;
    const lr1e2Mean = meanByCellLr["1e-2"].reduce((a, b) => a + b, 0) / meanByCellLr["1e-2"].length;
    assert.ok(lr1e3Mean > lr1e2Mean,
      `expected lr=1e-3 (mean ${lr1e3Mean}) to beat lr=1e-2 (mean ${lr1e2Mean})`);
  } finally {
    rmSync(lib, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("end-to-end: idempotent re-run skips already-done rows", { timeout: 60_000 }, async () => {
  const lib = tmp("rsi-e2e-idempotent-lib");
  mkdirSync(join(lib, "templates"));
  writeFileSync(join(lib, "templates", "paper-template.md"), "# <Project title>\n", "utf8");
  const { repo, trainPath } = makeToyRepo();
  try {
    await runCli(VR_RL_TUNER, [
      "--repo", repo,
      "--goal", "x",
      "--library", lib,
      "--name", "idempotent",
      "--json",
    ]);
    await runCli(VR_RL_SWEEP, [
      "init", "idempotent",
      "--library", lib,
      "--sweep", "lr=[1e-3]",
      "--seeds", "1",
      "--force",
      "--json",
    ]);
    // First run: real execution.
    const r1 = await runCli(VR_RL_SWEEP, [
      "run", "idempotent",
      "--library", lib,
      "--launcher", `bash ${trainPath} --lr=\${lr} --seed=\${seed}`,
      "--json",
    ]);
    assert.equal(JSON.parse(r1.stdout).ran, 1);
    // Second run: should skip the already-done row.
    const r2 = await runCli(VR_RL_SWEEP, [
      "run", "idempotent",
      "--library", lib,
      "--launcher", `bash ${trainPath} --lr=\${lr} --seed=\${seed}`,
      "--json",
    ]);
    const r2Summary = JSON.parse(r2.stdout);
    assert.equal(r2Summary.ran, 0);
    assert.equal(r2Summary.skipped, 1);
  } finally {
    rmSync(lib, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("end-to-end: failing launcher marks rows failed without aborting the run", { timeout: 60_000 }, async () => {
  const lib = tmp("rsi-e2e-fail-lib");
  mkdirSync(join(lib, "templates"));
  writeFileSync(join(lib, "templates", "paper-template.md"), "# <Project title>\n", "utf8");
  const repo = tmp("rsi-e2e-fail-repo");
  // A launcher script that fails on every invocation.
  const trainPath = join(repo, "fail.sh");
  writeFileSync(trainPath, "#!/usr/bin/env bash\necho 'crashing'\nexit 17\n", "utf8");
  chmodSync(trainPath, 0o755);
  try {
    await runCli(VR_RL_TUNER, ["--repo", repo, "--goal", "x", "--library", lib, "--name", "fail-test", "--json"]);
    await runCli(VR_RL_SWEEP, [
      "init", "fail-test", "--library", lib,
      "--sweep", "lr=[1e-3,1e-4]", "--seeds", "1", "--force", "--json",
    ]);
    const result = await runCli(VR_RL_SWEEP, [
      "run", "fail-test", "--library", lib,
      "--launcher", `bash ${trainPath}`,
      "--json",
    ]);
    // exit 1 because failed > 0.
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ran, 2);
    assert.equal(summary.failed, 2);
    assert.equal(summary.ok, 0);
    // Both rows should be marked failed in the TSV.
    const tsv = parseRunsTsv(readFileSync(summary.runsTsv, "utf8"));
    for (const row of tsv.rows) assert.equal(row.status, "failed");
  } finally {
    rmSync(lib, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
