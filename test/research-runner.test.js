// Unit + CLI tests for src/research/runner.js + bin/vr-research-runner.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import {
  claimNextMove,
  finishMove,
  runCycle,
  runNextMove,
  __internal,
} from "../src/research/runner.js";

const VR_RESEARCH_RUNNER = path.resolve("bin/vr-research-runner");

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function runCli(args, { cwd, env = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_RESEARCH_RUNNER, ...args], {
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
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { stderr += `\n[spawn error] ${error.message}`; settle(null); });
    child.on("exit", (code) => settle(code));
  });
}

const README = `# example

## GOAL

Find a better setting.

## CODE REPO

https://github.com/example/widget

## SUCCESS CRITERIA

- score improves.

## RANKING CRITERION

quantitative: score (higher is better)

## LEADERBOARD

| rank | result | branch | commit | score / verdict |
|------|--------|--------|--------|-----------------|

## INSIGHTS

_none_

## ACTIVE

| move | result doc | branch | agent | started |
|------|-----------|--------|-------|---------|

## QUEUE

| move | starting-point | why |
|------|----------------|-----|
| first-move | [main](https://github.com/example/widget/tree/main) | Try the first change. |

## LOG

See [LOG.md](./LOG.md) — append-only event history.
`;

function makeProject(prefix = "vr-runner") {
  const dir = tmp(prefix);
  writeFileSync(join(dir, "README.md"), README);
  writeFileSync(join(dir, "LOG.md"), "# example - LOG\n\n| date | event | slug or ref | one-line summary | link |\n|------|-------|-------------|------------------|------|\n");
  return dir;
}

test("claimNextMove moves QUEUE row to ACTIVE and creates a result doc", async () => {
  const dir = makeProject("vr-runner-claim");
  try {
    const result = await claimNextMove({ projectDir: dir, agent: "0" });
    assert.equal(result.slug, "first-move");
    assert.equal(result.claimed, true);
    assert.equal(result.branchUrl, "https://github.com/example/widget/tree/r/first-move");

    const readme = readFileSync(join(dir, "README.md"), "utf8");
    assert.match(readme, /\| first-move \| \[first-move\]\(results\/first-move\.md\) \| \[r\/first-move\]/);
    const queueSection = readme.split("## QUEUE")[1].split("## LOG")[0];
    assert.doesNotMatch(queueSection, /first-move/);

    const doc = readFileSync(join(dir, "results", "first-move.md"), "utf8");
    assert.match(doc, /## STATUS\s+active/s);
    assert.match(doc, /Try the first change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCycle executes a command, extracts a metric, and appends cycle provenance", async () => {
  const dir = makeProject("vr-runner-cycle");
  try {
    await claimNextMove({ projectDir: dir });
    const result = await runCycle({
      projectDir: dir,
      slug: "first-move",
      command: "node -e \"console.log('score=0.73')\"",
      metricRegex: "score=([0-9.]+)",
      change: "score smoke",
      qual: "toy command emitted a score",
      timeoutMs: 5_000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.metric, "0.73");
    assert.equal(result.cycleIndex, 1);

    const doc = readFileSync(join(dir, "results", "first-move.md"), "utf8");
    assert.match(doc, /cycle 1.*score smoke -> metric=0\.73.*toy command emitted a score/);
    assert.match(doc, /artifacts\/first-move\/cycle-1\.log/);

    const artifact = readFileSync(join(dir, "artifacts", "first-move", "cycle-1.log"), "utf8");
    assert.match(artifact, /score=0\.73/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCycle can commit code changes and records seed-aware git provenance", async () => {
  const dir = makeProject("vr-runner-git-cycle");
  const work = join(dir, "work");
  try {
    await mkdir(work, { recursive: true });
    execFileSync("git", ["init"], { cwd: work });
    execFileSync("git", ["config", "user.email", "agent@example.test"], { cwd: work });
    execFileSync("git", ["config", "user.name", "Research Agent"], { cwd: work });
    writeFileSync(join(work, "note.txt"), "initial\n");
    execFileSync("git", ["add", "note.txt"], { cwd: work });
    execFileSync("git", ["commit", "-m", "seed"], { cwd: work });

    await claimNextMove({ projectDir: dir });
    const result = await runCycle({
      projectDir: dir,
      slug: "first-move",
      cwd: work,
      command: "node -e \"const fs=require('fs'); fs.appendFileSync('note.txt','score=0.75\\n'); console.log('score=0.75')\"",
      metricRegex: "score=([0-9.]+)",
      change: "write score note",
      seed: "0",
      gitCommit: true,
      timeoutMs: 5_000,
    });
    assert.equal(result.git.committed, true);
    assert.match(result.git.shortSha, /^[0-9a-f]{7}/);

    const doc = readFileSync(join(dir, "results", "first-move.md"), "utf8");
    assert.match(doc, new RegExp(`cycle 1 @${result.git.shortSha}`));
    assert.match(doc, /commit https:\/\/github\.com\/example\/widget\/commit\/[0-9a-f]{40}/);

    const artifact = readFileSync(join(dir, "artifacts", "first-move", "cycle-1.log"), "utf8");
    assert.match(artifact, /seed: 0/);
    assert.match(artifact, /git_committed: true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCycle surfaces skipped human review when Agent Town API is missing", async () => {
  const dir = makeProject("vr-runner-review-skip");
  try {
    await claimNextMove({ projectDir: dir });
    const result = await runCycle({
      projectDir: dir,
      slug: "first-move",
      command: "node -e \"console.log('score=0.74')\"",
      metricRegex: "score=([0-9.]+)",
      askHuman: true,
      agentTownApi: "",
      timeoutMs: 5_000,
    });
    assert.equal(result.review, null);
    assert.match(result.reviewSkippedReason, /Agent Town API is not configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runNextMove combines claim and one cycle", async () => {
  const dir = makeProject("vr-runner-run");
  try {
    const result = await runNextMove({
      projectDir: dir,
      question: "Custom runner question?",
      command: "node -e \"console.log('metric=12')\"",
      metricRegex: "metric=([0-9.]+)",
      timeoutMs: 5_000,
    });
    assert.equal(result.claim.slug, "first-move");
    assert.equal(result.cycle.metric, "12");
    const doc = readFileSync(join(dir, "results", "first-move.md"), "utf8");
    assert.match(doc, /Custom runner question\?/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finishMove aggregates cycle metrics and applies README/LOG resolution", async () => {
  const dir = makeProject("vr-runner-finish");
  try {
    await claimNextMove({ projectDir: dir });
    for (const [seed, score] of [["0", "0.80"], ["1", "0.82"], ["2", "0.81"]]) {
      await runCycle({
        projectDir: dir,
        slug: "first-move",
        command: `node -e "console.log('score=${score}')"`,
        metricRegex: "score=([0-9.]+)",
        change: `seed ${seed}`,
        seed,
        timeoutMs: 5_000,
      });
    }

    const result = await finishMove({
      projectDir: dir,
      slug: "first-move",
      takeaway: "The toy score resolved cleanly.",
      analysis: "Three seeds cluster tightly enough for a smoke test.",
      decision: "do not admit",
      aggregateMetric: true,
      metricName: "score",
      higherIsBetter: true,
      apply: true,
      event: "resolved",
    });
    assert.equal(result.applied, true);
    assert.equal(result.aggregate.n, 3);
    assert.equal(Number(result.aggregate.mean.toFixed(2)), 0.81);

    const doc = readFileSync(join(dir, "results", "first-move.md"), "utf8");
    assert.match(doc, /^---\nmetric: score\nmetric_higher_is_better: true\nseeds: \["0", "1", "2"\]\nmean: 0\.81\nstd: 0\.01/m);
    assert.match(doc, /## STATUS\s+resolved/s);
    assert.match(doc, /The toy score resolved cleanly/);

    const readme = readFileSync(join(dir, "README.md"), "utf8");
    const activeSection = readme.split("## ACTIVE")[1].split("## QUEUE")[0];
    assert.doesNotMatch(activeSection, /first-move/);

    const log = readFileSync(join(dir, "LOG.md"), "utf8");
    assert.match(log, /\| \d{4}-\d{2}-\d{2} \| resolved \| first-move \| The toy score resolved cleanly\. \| results\/first-move\.md \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-runner CLI help and run command work", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /vr-research-runner/);

  const dir = makeProject("vr-runner-cli");
  try {
    await mkdir(join(dir, "work"), { recursive: true });
    const result = await runCli([
      dir,
      "run",
      "--command", "node -e \"console.log('score=0.91')\"",
      "--metric-regex", "score=([0-9.]+)",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.claim.slug, "first-move");
    assert.equal(payload.cycle.metric, "0.91");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-runner CLI finish command works", async () => {
  const dir = makeProject("vr-runner-cli-finish");
  try {
    let result = await runCli([
      dir,
      "run",
      "--command", "node -e \"console.log('score=0.90')\"",
      "--metric-regex", "score=([0-9.]+)",
      "--seed", "0",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);

    result = await runCli([
      dir,
      "finish",
      "--slug", "first-move",
      "--takeaway", "CLI finish completed.",
      "--decision", "do not admit",
      "--aggregate-metric",
      "--metric-name", "score",
      "--apply",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "resolved");
    assert.equal(payload.applied, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner section helpers replace placeholders then append chronologically", () => {
  const initial = "## Cycles\n\n_none yet_\n\n## Results\n\n_pending_\n";
  const once = __internal.insertIntoSection(initial, "Cycles", "- cycle 1: a");
  const twice = __internal.insertIntoSection(once, "Cycles", "- cycle 2: b");
  assert.match(twice, /## Cycles\n\n- cycle 1: a\n- cycle 2: b\n\n## Results/);

  const resultOnce = __internal.appendSectionBullet(initial, "Results", "- result 1");
  const resultTwice = __internal.appendSectionBullet(resultOnce, "Results", "- result 2");
  assert.match(resultTwice, /## Results\n\n- result 1\n- result 2\n?$/);
});
