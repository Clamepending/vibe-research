// Unit + CLI tests for src/research/judge.js + bin/vr-research-judge.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { judgeMove, __internal } from "../src/research/judge.js";

const VR_RESEARCH_JUDGE = path.resolve("bin/vr-research-judge");

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function runCli(args, { cwd, env = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_RESEARCH_JUDGE, ...args], {
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

function makeProject(prefix = "vr-judge") {
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
| first-move | [first-move](results/first-move.md) | [r/first-move](https://github.com/example/widget/tree/r/first-move) | 0 | 2026-04-30 |

## QUEUE

| move | starting-point | why |
|------|----------------|-----|

## LOG

See [LOG.md](./LOG.md) - append-only event history.
`);
  writeFileSync(join(dir, "LOG.md"), "# example - LOG\n\n| date | event | slug or ref | one-line summary | link |\n|------|-------|-------------|------------------|------|\n");
  return dir;
}

function writeResult(dir, slug, {
  status = "active",
  frontmatter = "",
  decision = "",
  cycles = "",
  results = "- score=0.81 from toy artifact.",
  reproducibility = "- command `node toy.js`.",
  queueUpdates = "_none_",
} = {}) {
  writeFileSync(join(dir, "results", `${slug}.md`), `${frontmatter}# ${slug}

## TAKEAWAY

${status === "resolved" ? "Toy result resolved." : "_pending_"}

## STATUS

${status}

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

${cycles || "- cycle 1 @abcdef0: toy command -> metric=0.81. qual: completed."}

## Results

${results}

## Agent canvas

_none_

## Analysis

Toy analysis.

## Reproducibility

${reproducibility}

## Leaderboard verdict

${decision}

## Queue updates

${queueUpdates}
`);
}

test("judgeMove recommends continue for a healthy active move", async () => {
  const dir = makeProject("vr-judge-active");
  try {
    writeResult(dir, "first-move", { status: "active" });
    const report = await judgeMove({ projectDir: dir, slug: "first-move", checkPaper: false });
    assert.equal(report.recommendation.action, "continue");
    assert.equal(report.status, "active");
    assert.equal(report.cycles.length, 1);
    assert.equal(report.admit, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("judgeMove recommends rerun when quantitative admission is blocked", async () => {
  const dir = makeProject("vr-judge-rerun");
  try {
    writeResult(dir, "first-move", {
      status: "resolved",
      decision: "Decision: do not admit",
    });
    const report = await judgeMove({ projectDir: dir, slug: "first-move", checkPaper: false });
    assert.equal(report.recommendation.action, "rerun");
    assert.equal(report.issueSummary.error >= 1, true);
    assert.match(report.summary, /admit=blocked/);
    assert.ok(report.issues.some((item) => item.code === "result_quant_frontmatter_missing"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("judgeMove flags missing artifact links for fast review", async () => {
  const dir = makeProject("vr-judge-artifact-missing");
  try {
    writeResult(dir, "first-move", {
      status: "active",
      results: "- artifact `artifacts/first-move/missing.log` recorded the run.",
      reproducibility: "- command `node toy.js`; artifact `artifacts/first-move/missing.log`; git `abcdef0`.",
    });
    const report = await judgeMove({ projectDir: dir, slug: "first-move", checkPaper: false });
    assert.ok(report.issues.some((item) => item.code === "artifact_missing"));
    assert.equal(report.evaluatorStrength, "weak");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("judgeMove treats existing artifact provenance as medium-strength evidence", async () => {
  const dir = makeProject("vr-judge-artifact-present");
  try {
    mkdirSync(join(dir, "artifacts", "first-move"), { recursive: true });
    writeFileSync(join(dir, "artifacts", "first-move", "cycle-1.log"), "score=0.81\n");
    writeResult(dir, "first-move", {
      status: "active",
      results: "- artifact `artifacts/first-move/cycle-1.log` recorded the run.",
      reproducibility: "- command `node toy.js`; artifact `artifacts/first-move/cycle-1.log`; git `abcdef0`.",
    });
    const report = await judgeMove({ projectDir: dir, slug: "first-move", checkPaper: false });
    assert.equal(report.issues.some((item) => item.code === "artifact_missing"), false);
    assert.equal(report.evaluatorStrength, "medium");
    assert.match(report.summary, /evaluator=medium/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("judgeMove can create an Agent Inbox review card", async () => {
  const dir = makeProject("vr-judge-card");
  const requests = [];
  try {
    writeResult(dir, "first-move", { status: "active" });
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      return {
        ok: true,
        status: 200,
        async json() {
          return { actionItem: { id: body.id, title: body.title, choices: body.choices } };
        },
      };
    };
    const report = await judgeMove({
      projectDir: dir,
      slug: "first-move",
      checkPaper: false,
      askHuman: true,
      agentTownApi: "http://agent-town.test/api/agent-town",
      fetchImpl,
    });
    assert.equal(report.review.actionItem.id, "research-judge-first-move");
    assert.deepEqual(requests[0].body.choices, __internal.REVIEW_CHOICES);
    assert.match(requests[0].body.recommendation, /continue/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("judgeMove surfaces Queue updates as next-move evidence", async () => {
  const dir = makeProject("vr-judge-queue-updates");
  const requests = [];
  try {
    writeResult(dir, "first-move", {
      status: "active",
      queueUpdates: "ADD: second-move | starting-point main | why vary the prompt scaffold",
    });
    const report = await judgeMove({
      projectDir: dir,
      slug: "first-move",
      checkPaper: false,
      askHuman: true,
      agentTownApi: "http://agent-town.test/api/agent-town",
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return {
          ok: true,
          status: 200,
          async json() {
            return { actionItem: { id: body.id } };
          },
        };
      },
    });
    assert.equal(report.queueUpdates.length, 1);
    assert.equal(report.queueUpdates[0].verb, "add");
    assert.equal(report.queueUpdates[0].slug, "second-move");
    assert.match(report.summary, /1 next candidate/);
    assert.ok(requests[0].evidence.some((item) => item.kind === "queue-update" && /second-move/.test(item.text)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-judge CLI help and JSON output work", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /vr-research-judge/);

  const dir = makeProject("vr-judge-cli");
  try {
    writeResult(dir, "first-move", { status: "active" });
    const result = await runCli([dir, "--slug", "first-move", "--no-paper", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.slug, "first-move");
    assert.equal(payload.recommendation.action, "continue");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
