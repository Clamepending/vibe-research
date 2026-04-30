import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVibeResearchApp } from "../src/create-app.js";
import { createResearchBrief, updateResearchState } from "../src/research/brief.js";
import { createProject } from "../src/research/init.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const WORKSPACE_LIBRARY_RELATIVE = path.join("vibe-research", "buildings", "library");

async function startCanaryApp({ workspaceDir, stateDir, codeDir }) {
  return createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd: workspaceDir,
    stateDir,
    defaultSessionCwd: codeDir,
    persistSessions: false,
    persistentTerminals: false,
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({ enabled: settings.preventSleepEnabled, platform: "test" }),
    systemMetricsSampleIntervalMs: 0,
  });
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

async function readActionItem(baseUrl, id) {
  const response = await fetch(`${baseUrl}/api/agent-town/action-items`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  return payload.actionItems.find((item) => item.id === id) || null;
}

async function seedBriefProject({ projectsDir, projectName }) {
  const project = await createProject({
    projectsDir,
    name: projectName,
    goal: "Verify the brainstorm-to-experiment handoff remains human-reviewable through the live server.",
    codeRepoUrl: "https://github.com/example/orchestrator-brief-canary-code",
    successCriteria: [
      "orchestrator opens a brief Agent Inbox card",
      "approval compiles the recommended move into QUEUE",
      "the next tick recommends running that queued move",
    ],
    ranking: { kind: "quantitative", metric: "workflow_score", direction: "higher" },
    queueRows: [],
    force: true,
  });
  await createResearchBrief({
    projectDir: project.projectDir,
    slug: "plateau-plan",
    question: "Should we leave brainstorming and test a concrete contrastive prompt?",
    currentTheory: "The current plateau is likely caused by missing contrast examples rather than model capacity.",
    grounding: ["Server canary fixture grounding."],
    candidateMoves: [
      {
        move: "contrastive-prompt",
        startingPoint: "https://github.com/example/orchestrator-brief-canary-code/tree/main",
        why: "Compare a contrastive prompt scaffold against the current baseline.",
        hypothesis: "Contrast examples make human review faster and clearer.",
      },
    ],
    recommendedMove: "contrastive-prompt",
  });
  await updateResearchState({
    projectDir: project.projectDir,
    phase: "move-design",
    briefSlug: "plateau-plan",
    summary: "brief ready for human review",
  });
  return project.projectDir;
}

async function seedSweepProject({ projectsDir, projectName }) {
  const project = await createProject({
    projectsDir,
    name: projectName,
    goal: "Verify planned sweep rows route before review.",
    codeRepoUrl: "https://github.com/example/orchestrator-sweep-canary-code",
    successCriteria: ["planned sweep row is runnable from the orchestrator"],
    ranking: { kind: "quantitative", metric: "score", direction: "higher" },
    queueRows: [],
    force: true,
  });
  await mkdir(path.join(project.projectDir, "runs"), { recursive: true });
  await writeFile(path.join(project.projectDir, "runs", "lr.tsv"), [
    "started_at\tgroup\tname\tcommit\thypothesis\tmean_return\tstd_return\twandb_url\tstatus\tconfig",
    "\tsweep\tlr1e-3-seed0\tabc\ttry lr\t\t\t\tplanned\t{\"lr\":\"1e-3\"}",
    "2026-04-30T00:00:00.000Z\tsweep\tlr1e-4-seed0\tabc\ttry lr\t0.5\t\t\tdone\t{\"lr\":\"1e-4\"}",
    "",
  ].join("\n"));
  await updateResearchState({
    projectDir: project.projectDir,
    phase: "experiment",
    summary: "sweep planned",
  });
  return project.projectDir;
}

async function seedJudgeProject({ projectsDir, projectName }) {
  const project = await createProject({
    projectsDir,
    name: projectName,
    goal: "Verify review phase opens a judge card with next-candidate evidence.",
    codeRepoUrl: "https://github.com/example/orchestrator-judge-canary-code",
    successCriteria: ["judge card appears in the live Agent Inbox"],
    ranking: { kind: "quantitative", metric: "score", direction: "higher" },
    queueRows: [],
    force: true,
  });
  const resultPath = path.join(project.projectDir, "results", "baseline-check.md");
  await writeFile(resultPath, `---
metric: score
metric_higher_is_better: true
seeds: [1, 2, 3]
mean: 0.81
std: 0.01
---
# baseline-check

## TAKEAWAY

Baseline check resolved and recommends one targeted follow-up.

## STATUS

resolved

## STARTING POINT

https://github.com/example/orchestrator-judge-canary-code/tree/main

## BRANCH

https://github.com/example/orchestrator-judge-canary-code/tree/r/baseline-check

## AGENT

0

## Question

Does the baseline route produce usable review evidence?

## Hypothesis

50% prior; falsifier is no metric or artifact.

## Research grounding

Server canary fixture.

## Experiment design

Run a deterministic toy command.

## Cycles

- cycle 1 @abcdef0: toy command -> score=0.81. qual: completed.

## Results

- score mean 0.81 std 0.01 from toy artifact.

## Agent canvas

_none_

## Analysis

The fixture result is sufficient for plumbing review.

## Reproducibility

- commit https://github.com/example/orchestrator-judge-canary-code/commit/abcdef0; command \`node toy.js\`.

## Leaderboard verdict

Decision: insert at rank 1

## Queue updates

ADD: sharper-followup | starting-point https://github.com/example/orchestrator-judge-canary-code/tree/r/baseline-check | why inspect the failure mode
`);
  await writeFile(path.join(project.projectDir, "LOG.md"), `# ${projectName} - LOG

| date | event | slug or ref | one-line summary | link |
|------|-------|-------------|------------------|------|
| 2026-04-30 | resolved | baseline-check | toy result | [baseline-check](results/baseline-check.md) |
`);
  await updateResearchState({
    projectDir: project.projectDir,
    phase: "review",
    summary: "move resolved",
  });
  return project.projectDir;
}

test("research orchestrator drives brief review, sweep routing, and judge cards through a real server", { timeout: 30_000 }, async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vr-orchestrator-server-canary-"));
  const stateDir = path.join(workspaceDir, ".vibe-research");
  const codeDir = path.join(workspaceDir, "code");
  const libraryRoot = path.join(workspaceDir, WORKSPACE_LIBRARY_RELATIVE);
  const projectsDir = path.join(libraryRoot, "projects");
  const prevWorkspaceDir = process.env.VIBE_RESEARCH_WORKSPACE_DIR;
  process.env.VIBE_RESEARCH_WORKSPACE_DIR = workspaceDir;
  let app;

  try {
    await mkdir(codeDir, { recursive: true });
    const briefProjectName = "orchestrator-brief-canary";
    const sweepProjectName = "orchestrator-sweep-canary";
    const judgeProjectName = "orchestrator-judge-canary";
    const briefProjectDir = await seedBriefProject({ projectsDir, projectName: briefProjectName });
    await seedSweepProject({ projectsDir, projectName: sweepProjectName });
    await seedJudgeProject({ projectsDir, projectName: judgeProjectName });

    app = await startCanaryApp({ workspaceDir, stateDir, codeDir });
    const baseUrl = `http://127.0.0.1:${app.config.port}`;

    const briefTick = await postJson(`${baseUrl}/api/research/projects/${briefProjectName}/orchestrator/tick`, {
      askHuman: true,
      checkPaper: false,
    });
    assert.equal(briefTick.report.recommendation.action, "review-brief");
    assert.equal(briefTick.report.briefReview.actionItem.id, "research-brief-plateau-plan");

    const briefCard = await readActionItem(baseUrl, "research-brief-plateau-plan");
    assert.equal(briefCard.source, "research-brief");
    assert.equal(briefCard.target.projectName, briefProjectName);
    assert.equal(briefCard.target.briefSlug, "plateau-plan");
    assert.equal(briefCard.target.action, "compile-research-brief");
    assert.deepEqual(briefCard.choices, ["approve", "steer", "reject"]);

    const compile = await postJson(`${baseUrl}/api/research/projects/${briefProjectName}/briefs/plateau-plan/compile`, {});
    assert.equal(compile.compiled, true);
    assert.equal(compile.queueRows[0].slug, "contrastive-prompt");
    assert.equal(compile.phase.phase, "experiment");
    await patchJson(`${baseUrl}/api/agent-town/action-items/research-brief-plateau-plan`, {
      resolution: "approved",
      resolutionNote: "Canary approved and queued the recommended move.",
    });

    const approvedBriefCard = await readActionItem(baseUrl, "research-brief-plateau-plan");
    assert.equal(approvedBriefCard.status, "completed");
    assert.equal(approvedBriefCard.resolution, "approved");

    const readme = await readFile(path.join(briefProjectDir, "README.md"), "utf8");
    assert.match(readme, /\|\s*contrastive-prompt\s*\|/);

    const runNext = await postJson(`${baseUrl}/api/research/projects/${briefProjectName}/orchestrator/tick`, {
      commandText: "node eval.js",
      checkPaper: false,
    });
    assert.equal(runNext.report.recommendation.action, "run-next");
    assert.equal(runNext.report.recommendation.slug, "contrastive-prompt");
    assert.match(runNext.report.nextCommand, /node eval\.js/);

    const sweepTick = await postJson(`${baseUrl}/api/research/projects/${sweepProjectName}/orchestrator/tick`, {
      commandText: "python train.py --lr=${lr}",
      checkPaper: false,
    });
    assert.equal(sweepTick.report.recommendation.action, "run-sweep");
    assert.equal(sweepTick.report.recommendation.sweepPath, "runs/lr.tsv");
    assert.match(sweepTick.report.nextCommand, /vr-rl-sweep run/);
    assert.match(sweepTick.report.nextCommand, /--sweep-name lr/);

    const judgeTick = await postJson(`${baseUrl}/api/research/projects/${judgeProjectName}/orchestrator/tick`, {
      askHuman: true,
      checkPaper: false,
    });
    assert.equal(judgeTick.report.recommendation.slug, "baseline-check");
    assert.equal(judgeTick.report.recommendation.nextCandidates, 1);
    assert.equal(judgeTick.report.judge.review.actionItem.id, "research-judge-baseline-check");

    const judgeCard = await readActionItem(baseUrl, "research-judge-baseline-check");
    assert.equal(judgeCard.source, "research-judge");
    assert.deepEqual(judgeCard.choices, ["continue", "rerun", "synthesize", "brainstorm", "steer"]);
    assert.ok(judgeCard.evidence.some((item) => item.kind === "queue-update" && /sharper-followup/.test(item.label)));
  } finally {
    if (app) await app.close();
    if (prevWorkspaceDir === undefined) delete process.env.VIBE_RESEARCH_WORKSPACE_DIR;
    else process.env.VIBE_RESEARCH_WORKSPACE_DIR = prevWorkspaceDir;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
