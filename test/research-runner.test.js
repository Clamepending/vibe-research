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
  readResearchState,
} from "../src/research/brief.js";
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

test("claimNextMove blocks new claims after a budget cap until explicitly allowed", async () => {
  const dir = makeProject("vr-runner-budget-cap");
  try {
    const readmePath = join(dir, "README.md");
    const readme = readFileSync(readmePath, "utf8");
    writeFileSync(readmePath, readme.replace(
      "## RANKING CRITERION",
      "## BUDGET\n\ncompute: 80/80 GPU-hours\ndollars: 4.20/20 USD\ncalendar: 2099-01-01\n\n## RANKING CRITERION",
    ));

    await assert.rejects(
      claimNextMove({ projectDir: dir }),
      /budget cap reached.*human review is required/,
    );

    const allowed = await claimNextMove({ projectDir: dir, allowBudgetCap: true });
    assert.equal(allowed.slug, "first-move");
    assert.equal(allowed.claimed, true);
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

test("runCycle closes stdin for noninteractive commands", async () => {
  const dir = makeProject("vr-runner-stdin");
  try {
    await claimNextMove({ projectDir: dir });
    const result = await runCycle({
      projectDir: dir,
      slug: "first-move",
      command: "node -e \"process.stdin.on('end',()=>console.log('score=0.91')); process.stdin.resume();\"",
      metricRegex: "score=([0-9.]+)",
      change: "stdin closure smoke",
      qual: "command observed EOF and exited",
      timeoutMs: 2_000,
    });
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.metric, "0.91");
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

test("runCycle can wait on the Agent Inbox review card", async () => {
  const dir = makeProject("vr-runner-review-wait");
  const calls = [];
  try {
    await claimNextMove({ projectDir: dir });
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      return {
        ok: true,
        status: 200,
        async json() {
          if (url.endsWith("/wait")) {
            return {
              predicate: body.predicate,
              predicateParams: body.predicateParams,
              satisfied: true,
              state: {
                actionItems: [
                  {
                    id: body.predicateParams.actionItemId,
                    status: "completed",
                    resolution: "rerun",
                    resolutionNote: "Need one more seed before synthesis.",
                  },
                ],
              },
            };
          }
          return { actionItem: { id: body.id, title: body.title } };
        },
      };
    };
    const result = await runCycle({
      projectDir: dir,
      slug: "first-move",
      command: "node -e \"console.log('score=0.76')\"",
      metricRegex: "score=([0-9.]+)",
      waitHuman: true,
      humanTimeoutMs: 1234,
      canvasSessionId: "session-1",
      canvasAgentId: "agent-a",
      agentTownApi: "http://agent-town.test/api/agent-town",
      fetchImpl,
      timeoutMs: 5_000,
    });
    assert.equal(result.review.id, "research-cycle-first-move-1");
    assert.equal(result.reviewWait.satisfied, true);
    assert.equal(result.reviewDecision.action, "rerun");
    assert.equal(result.reviewDecision.resolution, "rerun");
    assert.match(result.reviewDecision.resolutionNote, /one more seed/);
    assert.match(result.reviewDecisionLine, /cycle 1 review: rerun/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.sourceSessionId, "session-1");
    assert.equal(calls[0].body.sourceAgentId, "agent-a");
    assert.match(calls[0].body.target.id, /first-move:cycle-1/);
    assert.equal(calls[1].body.predicate, "action_item_resolved");
    assert.equal(calls[1].body.timeoutMs, 1234);
    const doc = readFileSync(join(dir, "results", "first-move.md"), "utf8");
    assert.match(doc, /cycle 1 review: rerun; resolution=rerun; note=Need one more seed before synthesis/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCycle can launch a reviewer agent session for a review card", async () => {
  const dir = makeProject("vr-runner-review-agent");
  const calls = [];
  try {
    await claimNextMove({ projectDir: dir });
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      return {
        ok: true,
        status: 200,
        async json() {
          if (url.endsWith("/api/sessions")) {
            return { session: { id: "review-session-1", providerId: body.providerId, name: body.name } };
          }
          if (url.endsWith("/wait")) {
            return {
              predicate: body.predicate,
              predicateParams: body.predicateParams,
              satisfied: true,
            };
          }
          return { actionItem: { id: body.id, title: body.title } };
        },
      };
    };

    const result = await runCycle({
      projectDir: dir,
      slug: "first-move",
      command: "node -e \"console.log('score=0.77')\"",
      metricRegex: "score=([0-9.]+)",
      waitHuman: true,
      humanTimeoutMs: 1234,
      agentTownApi: "http://agent-town.test/api/agent-town",
      agentReviewProvider: "codex",
      agentReviewName: "Canary reviewer",
      fetchImpl,
      timeoutMs: 5_000,
    });

    assert.equal(result.agentReviewSession.id, "review-session-1");
    assert.equal(result.review.id, "research-cycle-first-move-1");
    assert.equal(result.reviewWait.satisfied, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, "http://agent-town.test/api/sessions");
    assert.equal(calls[0].body.providerId, "codex");
    assert.equal(calls[0].body.name, "Canary reviewer");
    assert.match(calls[0].body.initialPrompt, /Action item id: research-cycle-first-move-1/);
    assert.match(calls[0].body.initialPrompt, /Result doc:/);
    assert.match(calls[0].body.initialPrompt, /Cycle log:/);
    assert.equal(calls[1].url, "http://agent-town.test/api/agent-town/action-items");
    assert.equal(calls[1].body.sourceSessionId, "review-session-1");
    assert.equal(calls[1].body.sourceAgentId, "codex");
    assert.match(calls[1].body.target.id, /first-move:cycle-1/);
    assert.equal(calls[2].body.predicate, "action_item_resolved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCycle can pin a live monitor URL to Agent Canvas", async () => {
  const dir = makeProject("vr-runner-monitor");
  const calls = [];
  try {
    await claimNextMove({ projectDir: dir });
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      return {
        ok: true,
        status: 200,
        async json() {
          return { canvas: { id: body.id, title: body.title, href: body.href, imageUrl: body.imageUrl } };
        },
      };
    };

    const result = await runCycle({
      projectDir: dir,
      slug: "first-move",
      command: "node -e \"console.log('score=0.84')\"",
      metricRegex: "score=([0-9.]+)",
      timeoutMs: 5_000,
      monitorUrl: "https://wandb.example.test/run/abc",
      monitorTitle: "W&B live run",
      monitorCaption: "Training curve is still moving.",
      canvasSessionId: "session-1",
      agentTownApi: "http://agent-town.test/api/agent-town",
      fetchImpl,
    });
    assert.equal(result.monitorCanvas.id, "session-1");
    assert.equal(calls[0].url, "http://agent-town.test/api/agent-town/canvases");
    assert.equal(calls[0].body.href, "https://wandb.example.test/run/abc");
    assert.equal(calls[0].body.imageUrl, "");

    const doc = readFileSync(join(dir, "results", "first-move.md"), "utf8");
    assert.match(doc, /live monitor: \[W&B live run\]\(https:\/\/wandb\.example\.test\/run\/abc\)/);
    const artifact = readFileSync(result.artifactPath, "utf8");
    assert.match(artifact, /monitor_url: https:\/\/wandb\.example\.test\/run\/abc/);
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

test("finishMove records move cost and debits project budget when applying", async () => {
  const dir = makeProject("vr-runner-finish-budget");
  try {
    const readmePath = join(dir, "README.md");
    writeFileSync(readmePath, readFileSync(readmePath, "utf8").replace(
      "## RANKING CRITERION",
      "## BUDGET\n\ncompute: 1.5/2 GPU-hours\ndollars: 1.00/10 USD\ncalendar: 2099-01-01\n\n## RANKING CRITERION",
    ));

    await claimNextMove({ projectDir: dir });
    await runCycle({
      projectDir: dir,
      slug: "first-move",
      command: "node -e \"console.log('score=0.81')\"",
      metricRegex: "score=([0-9.]+)",
      timeoutMs: 5_000,
    });
    const result = await finishMove({
      projectDir: dir,
      slug: "first-move",
      takeaway: "Budgeted move resolved.",
      decision: "do not admit",
      apply: true,
      costCompute: 0.5,
      costDollars: 1.25,
    });

    assert.equal(result.resolve.budget.applied, true);
    assert.deepEqual(result.resolve.budget.caps.map((cap) => cap.axis), ["compute"]);
    const readme = readFileSync(readmePath, "utf8");
    assert.match(readme, /compute: 2\/2 GPU-hours/);
    assert.match(readme, /dollars: 2\.25\/10 USD/);
    const resultDoc = readFileSync(join(dir, "results", "first-move.md"), "utf8");
    assert.match(resultDoc, /- cost: compute=0\.5; dollars=1\.25\./);
    const log = readFileSync(join(dir, "LOG.md"), "utf8");
    assert.match(log, /\| budget-cap \| first-move \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finishMove returns abandoned moves to ideation phase", async () => {
  const dir = makeProject("vr-runner-finish-abandoned");
  try {
    await claimNextMove({ projectDir: dir });
    await runCycle({
      projectDir: dir,
      slug: "first-move",
      command: "node -e \"console.log('blocked')\"",
      timeoutMs: 5_000,
    });
    const result = await finishMove({
      projectDir: dir,
      slug: "first-move",
      status: "abandoned",
      event: "abandoned",
      takeaway: "Blocked by missing data.",
      analysis: "No durable dataset was available, so return to ideation.",
      decision: "do not admit",
      apply: true,
    });
    assert.equal(result.status, "abandoned");
    const state = await readResearchState({ projectDir: dir });
    assert.equal(state.phase, "ideation");
    assert.equal(state.summary, "abandoned move first-move");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finishMove can update paper.md with a generated figure", async () => {
  const dir = makeProject("vr-runner-paper");
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
      decision: "do not admit",
      aggregateMetric: true,
      metricName: "score",
      updatePaper: true,
      paperCaption: "Toy score resolved cleanly.",
    });
    assert.equal(result.paper.created, true);
    assert.equal(result.paper.figure.generated, true);
    assert.equal(result.paper.lint.summary.error, 0);

    const paper = readFileSync(join(dir, "paper.md"), "utf8");
    assert.match(paper, /## Since last update[\s\S]*first-move: Toy score resolved cleanly\./);
    assert.match(paper, /## 4\. Results[\s\S]*!\[Result figure\]\(figures\/first-move-summary\.svg\)/);
    assert.match(paper, /\[\^first-move-runner-finish\]: Generated by `vr-research-runner finish --slug first-move --update-paper`/);

    const figure = readFileSync(join(dir, "figures", "first-move-summary.svg"), "utf8");
    assert.match(figure, /Generated by vr-research-runner finish/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finishMove can publish the paper figure to Agent Canvas", async () => {
  const dir = makeProject("vr-runner-canvas");
  const calls = [];
  try {
    await claimNextMove({ projectDir: dir });
    await runCycle({
      projectDir: dir,
      slug: "first-move",
      command: "node -e \"console.log('score=0.83')\"",
      metricRegex: "score=([0-9.]+)",
      timeoutMs: 5_000,
    });
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      return {
        ok: true,
        status: 200,
        async json() {
          return { canvas: { id: body.id, title: body.title, imagePath: body.imagePath } };
        },
      };
    };

    const result = await finishMove({
      projectDir: dir,
      slug: "first-move",
      takeaway: "Canvas publish completed.",
      decision: "do not admit",
      updatePaper: true,
      publishCanvas: true,
      canvasSessionId: "session-1",
      agentTownApi: "http://agent-town.test/api/agent-town",
      fetchImpl,
    });
    assert.equal(result.canvas.id, "session-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://agent-town.test/api/agent-town/canvases");
    assert.match(calls[0].body.imagePath, /first-move-summary\.svg$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-runner CLI help and run command work", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /vr-research-runner/);
  assert.match(help.stdout, /--wait-human/);
  assert.match(help.stdout, /--monitor-url/);
  assert.match(help.stdout, /--agent-review-provider/);
  assert.match(help.stdout, /--allow-budget-cap/);
  assert.match(help.stdout, /--update-paper/);
  assert.match(help.stdout, /--cost-compute/);

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
