import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { createResearchBrief, updateResearchState } from "../src/research/brief.js";
import { tickResearchOrchestrator } from "../src/research/orchestrator.js";

const VR_RESEARCH_ORCHESTRATOR = path.resolve("bin/vr-research-orchestrator");

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function runCli(args, { cwd, env = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_RESEARCH_ORCHESTRATOR, ...args], {
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

function makeProject(prefix = "vr-orchestrator", { queueRow = "", logRows = "" } = {}) {
  const dir = tmp(prefix);
  mkdirSync(join(dir, "results"), { recursive: true });
  writeFileSync(join(dir, "README.md"), `# example

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
${queueRow}

## LOG

See [LOG.md](./LOG.md) - append-only event history.
`);
  writeFileSync(join(dir, "LOG.md"), `# example - LOG

| date | event | slug or ref | one-line summary | link |
|------|-------|-------------|------------------|------|
${logRows}
`);
  return dir;
}

function writeResolvedResult(dir, slug, { queueUpdates = "_none_" } = {}) {
  writeFileSync(join(dir, "results", `${slug}.md`), `---
metric: score
metric_higher_is_better: true
seeds: [1, 2, 3]
mean: 0.81
std: 0.01
---
# ${slug}

## TAKEAWAY

Toy result resolved.

## STATUS

resolved

## STARTING POINT

https://github.com/example/widget/tree/main

## BRANCH

https://github.com/example/widget/tree/r/${slug}

## AGENT

0

## Question

Does ${slug} improve score?

## Hypothesis

50% prior; falsifier is no metric improvement.

## Research grounding

Toy fixture.

## Experiment design

Run a toy command.

## Cycles

- cycle 1 @abcdef0: toy command -> score=0.81. qual: completed.

## Results

- score mean 0.81 std 0.01 from toy artifact.

## Agent canvas

_none_

## Analysis

Toy analysis.

## Reproducibility

- commit https://github.com/example/widget/commit/abcdef0; command \`node toy.js\`.

## Leaderboard verdict

Decision: insert at rank 1

## Queue updates

${queueUpdates}
`);
}

function writeRunsTsv(dir, relPath = "runs.tsv") {
  const target = join(dir, relPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, [
    "started_at\tgroup\tname\tcommit\thypothesis\tmean_return\tstd_return\twandb_url\tstatus\tconfig",
    "\tsweep\tlr1e-3-seed0\tabc\ttry lr\t\t\t\tplanned\t{\"lr\":\"1e-3\"}",
    "2026-04-30T00:00:00.000Z\tsweep\tlr1e-4-seed0\tabc\ttry lr\t0.5\t\t\tdone\t{\"lr\":\"1e-4\"}",
    "",
  ].join("\n"));
}

test("tickResearchOrchestrator recommends running QUEUE row 1", async () => {
  const dir = makeProject("vr-orchestrator-queue", {
    queueRow: "| first-move | main | prove the dispatcher can see queued work |\n",
  });
  try {
    const report = await tickResearchOrchestrator({ projectDir: dir, commandText: "node train.js" });
    assert.equal(report.recommendation.action, "run-next");
    assert.equal(report.recommendation.slug, "first-move");
    assert.match(report.nextCommand, /vr-research-runner/);
    assert.match(report.nextCommand, /node train\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickResearchOrchestrator runs planned sweeps before entering review", async () => {
  const dir = makeProject("vr-orchestrator-sweep");
  try {
    writeRunsTsv(dir, "runs/lr.tsv");
    await updateResearchState({ projectDir: dir, phase: "experiment", summary: "sweep planned" });
    const report = await tickResearchOrchestrator({
      projectDir: dir,
      codeCwd: "/tmp/code",
      commandText: "python train.py --lr=${lr}",
    });
    assert.equal(report.recommendation.action, "run-sweep");
    assert.equal(report.recommendation.runnableRows, 1);
    assert.match(report.nextCommand, /vr-rl-sweep run/);
    assert.match(report.nextCommand, /--sweep-name lr/);
    assert.match(report.nextCommand, /python train\.py/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickResearchOrchestrator can apply experiment-to-review when work is exhausted", async () => {
  const dir = makeProject("vr-orchestrator-review");
  try {
    await updateResearchState({ projectDir: dir, phase: "experiment", summary: "compiled queue" });
    const report = await tickResearchOrchestrator({ projectDir: dir, apply: true });
    assert.equal(report.recommendation.action, "enter-review");
    assert.equal(report.phaseUpdate.phase, "review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickResearchOrchestrator judges the latest resolved result in review phase", async () => {
  const dir = makeProject("vr-orchestrator-judge", {
    logRows: "| 2026-04-30 | resolved | first-move | toy result | [first-move](results/first-move.md) |\n",
  });
  try {
    writeResolvedResult(dir, "first-move");
    await updateResearchState({ projectDir: dir, phase: "review", summary: "move resolved" });
    const report = await tickResearchOrchestrator({ projectDir: dir, checkPaper: false });
    assert.equal(report.recommendation.slug, "first-move");
    assert.match(report.recommendation.action, /^judge-/);
    assert.equal(report.recommendation.evaluatorStrength, "weak");
    assert.equal(report.judge.slug, "first-move");
    assert.match(report.nextCommand, /vr-research-judge/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickResearchOrchestrator recommends compiling an existing brief", async () => {
  const dir = makeProject("vr-orchestrator-brief");
  try {
    await createResearchBrief({
      projectDir: dir,
      slug: "plateau-plan",
      question: "What should we test next?",
      candidateMoves: [
        { move: "dropout-rerun", startingPoint: "main", why: "rerun with seeds", hypothesis: "noise explains plateau" },
      ],
    });
    await updateResearchState({ projectDir: dir, phase: "move-design", briefSlug: "plateau-plan", summary: "brief drafted" });
    const report = await tickResearchOrchestrator({ projectDir: dir });
    assert.equal(report.recommendation.action, "review-brief");
    assert.equal(report.recommendation.briefSlug, "plateau-plan");
    assert.match(report.nextCommand, /vr-research-brief/);
    assert.match(report.nextCommand, /compile/);

    const applied = await tickResearchOrchestrator({ projectDir: dir, apply: true });
    assert.equal(applied.briefCompile.briefSlug, "plateau-plan");
    assert.equal(applied.phaseUpdate.phase, "experiment");
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    assert.match(readme, /\| dropout-rerun \| main \| rerun with seeds \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickResearchOrchestrator gates waited brief apply on human approval", async () => {
  async function seedBrief(dir) {
    await createResearchBrief({
      projectDir: dir,
      slug: "plateau-plan",
      question: "What should we test next?",
      candidateMoves: [
        { move: "dropout-rerun", startingPoint: "main", why: "rerun with seeds", hypothesis: "noise explains plateau" },
      ],
    });
    await updateResearchState({ projectDir: dir, phase: "move-design", briefSlug: "plateau-plan", summary: "brief drafted" });
  }

  function fakeAgentTownFetch(resolution) {
    return async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      if (String(url).endsWith("/action-items")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { actionItem: { id: body.id, title: body.title, choices: body.choices } };
          },
        };
      }
      if (String(url).endsWith("/wait")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              satisfied: true,
              state: {
                actionItems: [
                  { id: body.predicateParams.actionItemId, resolution },
                ],
              },
            };
          },
        };
      }
      throw new Error(`unexpected fetch url: ${url}`);
    };
  }

  const approvedDir = makeProject("vr-orchestrator-brief-approved");
  const rejectedDir = makeProject("vr-orchestrator-brief-rejected");
  try {
    await seedBrief(approvedDir);
    const approved = await tickResearchOrchestrator({
      projectDir: approvedDir,
      askHuman: true,
      waitHuman: true,
      apply: true,
      agentTownApi: "http://agent-town.test/api/agent-town",
      fetchImpl: fakeAgentTownFetch("approved"),
    });
    assert.equal(approved.briefReview.resolution, "approved");
    assert.equal(approved.briefCompile.briefSlug, "plateau-plan");
    assert.equal(approved.phaseUpdate.phase, "experiment");
    assert.match(readFileSync(join(approvedDir, "README.md"), "utf8"), /\| dropout-rerun \| main \| rerun with seeds \|/);

    await seedBrief(rejectedDir);
    const rejected = await tickResearchOrchestrator({
      projectDir: rejectedDir,
      askHuman: true,
      waitHuman: true,
      apply: true,
      agentTownApi: "http://agent-town.test/api/agent-town",
      fetchImpl: fakeAgentTownFetch("rejected"),
    });
    assert.equal(rejected.briefReview.resolution, "rejected");
    assert.equal(rejected.briefCompile, null);
    assert.equal(rejected.phaseUpdate, null);
    assert.doesNotMatch(readFileSync(join(rejectedDir, "README.md"), "utf8"), /\| dropout-rerun \|/);
  } finally {
    rmSync(approvedDir, { recursive: true, force: true });
    rmSync(rejectedDir, { recursive: true, force: true });
  }
});

test("tickResearchOrchestrator carries judge next candidates into the recommendation", async () => {
  const dir = makeProject("vr-orchestrator-judge-candidates", {
    logRows: "| 2026-04-30 | resolved | first-move | toy result | [first-move](results/first-move.md) |\n",
  });
  try {
    writeResolvedResult(dir, "first-move", {
      queueUpdates: "ADD: second-move | starting-point main | why inspect the failure mode",
    });
    await updateResearchState({ projectDir: dir, phase: "review", summary: "move resolved" });
    const report = await tickResearchOrchestrator({ projectDir: dir, checkPaper: false });
    assert.equal(report.recommendation.nextCandidates, 1);
    assert.equal(report.judge.queueUpdates[0].slug, "second-move");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-orchestrator CLI help and JSON output work", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /vr-research-orchestrator/);

  const dir = makeProject("vr-orchestrator-cli", {
    queueRow: "| cli-move | main | exercise CLI JSON |\n",
  });
  try {
    const result = await runCli(["tick", dir, "--json", "--command", "node train.js"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.recommendation.action, "run-next");
    assert.match(payload.nextCommand, /node train\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
