// Unit + CLI tests for src/research/brief.js + bin/vr-research-brief.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  compileBriefToQueue,
  createResearchBrief,
  parseCandidateMoveSpec,
  parseResearchBriefMarkdown,
  readResearchState,
  renderResearchBriefMarkdown,
  updateResearchState,
} from "../src/research/brief.js";

const VR_RESEARCH_BRIEF = path.resolve("bin/vr-research-brief");

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `${prefix}-`)); }

function runCli(args, { cwd, env = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_RESEARCH_BRIEF, ...args], {
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

const README_BOILERPLATE = `# example

## GOAL

x

## ACTIVE

| move | result doc | branch | agent | started |
|------|-----------|--------|-------|---------|

## QUEUE

| move | starting-point | why |
|------|----------------|-----|

## LOG

| date | event | slug or ref | one-line summary | link |
|------|-------|-------------|-------------------|------|
`;

function makeProject(prefix = "vr-brief") {
  const dir = tmp(prefix);
  writeFileSync(join(dir, "README.md"), README_BOILERPLATE);
  return dir;
}

test("parseCandidateMoveSpec: parses pipe-delimited move specs", () => {
  assert.deepEqual(
    parseCandidateMoveSpec("dropout-rerun | main | tighten noise | dropout reduces variance"),
    {
      move: "dropout-rerun",
      startingPoint: "main",
      why: "tighten noise",
      hypothesis: "dropout reduces variance",
    },
  );
});

test("renderResearchBriefMarkdown + parseResearchBriefMarkdown round-trip candidate moves", () => {
  const markdown = renderResearchBriefMarkdown({
    slug: "dropout-mechanism",
    question: "Is the plateau capacity or regularization?",
    currentTheory: "Validation diverges after epoch 8.",
    grounding: ["v2 ruled out augmentation"],
    candidateMoves: [
      {
        move: "dropout-rerun",
        startingPoint: "main",
        why: "test regularization",
        hypothesis: "dropout helps",
      },
    ],
    recommendedMove: "dropout-rerun",
    budget: "compute: 3 GPU-hours",
    returnTriggers: ["3 seeds remain within noise"],
  });
  const parsed = parseResearchBriefMarkdown(markdown);
  assert.equal(parsed.slug, "dropout-mechanism");
  assert.equal(parsed.recommendedMove, "dropout-rerun");
  assert.equal(parsed.candidateMoves.length, 1);
  assert.equal(parsed.candidateMoves[0].hypothesis, "dropout helps");
  assert.deepEqual(parsed.returnTriggers, ["3 seeds remain within noise"]);
});

test("createResearchBrief writes briefs/<slug>.md and updateResearchState records phase history", async () => {
  const dir = makeProject("vr-brief-create");
  try {
    const result = await createResearchBrief({
      projectDir: dir,
      slug: "mechanism",
      question: "What broke?",
      currentTheory: "Probably noise.",
      candidateMoves: [{ move: "rerun", startingPoint: "main", why: "estimate noise" }],
    });
    assert.match(result.briefPath, /briefs\/mechanism\.md$/);
    assert.equal(result.brief.slug, "mechanism");
    assert.match(readFileSync(result.briefPath, "utf8"), /## Candidate Moves/);

    const stateResult = await updateResearchState({
      projectDir: dir,
      phase: "move-design",
      briefSlug: "mechanism",
      summary: "created brief",
    });
    assert.equal(stateResult.state.phase, "move-design");
    assert.equal(stateResult.state.history.length, 1);

    const state = await readResearchState({ projectDir: dir });
    assert.equal(state.briefSlug, "mechanism");
    assert.equal(state.summary, "created brief");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compileBriefToQueue compiles the recommended candidate into QUEUE", async () => {
  const dir = makeProject("vr-brief-compile");
  try {
    await createResearchBrief({
      projectDir: dir,
      slug: "mechanism",
      question: "What next?",
      candidateMoves: [
        { move: "first", startingPoint: "main", why: "first why" },
        { move: "second", startingPoint: "main", why: "second why" },
      ],
      recommendedMove: "second",
    });
    const result = await compileBriefToQueue({ projectDir: dir, slug: "mechanism" });
    assert.equal(result.compiled, true);
    assert.deepEqual(result.queueRows.map((row) => row.slug), ["second"]);
    const after = readFileSync(join(dir, "README.md"), "utf8");
    assert.match(after, /\|\s*second\s*\|\s*main\s*\|\s*second why\s*\|/);
    assert.doesNotMatch(after, /\|\s*first\s*\|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compileBriefToQueue --all equivalent rejects queue overflow before editing", async () => {
  const dir = makeProject("vr-brief-overflow");
  try {
    await createResearchBrief({
      projectDir: dir,
      slug: "many",
      question: "Many?",
      candidateMoves: [
        { move: "a", startingPoint: "main", why: "a" },
        { move: "b", startingPoint: "main", why: "b" },
        { move: "c", startingPoint: "main", why: "c" },
        { move: "d", startingPoint: "main", why: "d" },
        { move: "e", startingPoint: "main", why: "e" },
        { move: "f", startingPoint: "main", why: "f" },
      ],
    });
    await assert.rejects(
      compileBriefToQueue({ projectDir: dir, slug: "many", all: true }),
      /exceed cap 5/,
    );
    const after = readFileSync(join(dir, "README.md"), "utf8");
    assert.doesNotMatch(after, /\|\s*a\s*\|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-brief --help exits 0", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /vr-research-brief/);
});

test("vr-research-brief create + compile + phase work from the CLI", async () => {
  const dir = makeProject("vr-brief-cli");
  try {
    const create = await runCli([
      dir, "create",
      "--slug", "plateau",
      "--question", "Why did the run plateau?",
      "--theory", "Noise estimate is too weak.",
      "--grounding", "v1 and v2 are within noise",
      "--move", "rerun-baseline | main | improve noise estimate | variance explains plateau",
      "--recommend", "rerun-baseline",
      "--return-trigger", "rerun is still null",
      "--json",
    ]);
    assert.equal(create.status, 0, create.stderr);
    const created = JSON.parse(create.stdout);
    assert.equal(created.brief.slug, "plateau");
    assert.equal(created.phase.phase, "move-design");

    const compile = await runCli([dir, "compile", "--slug", "plateau", "--json"]);
    assert.equal(compile.status, 0, compile.stderr);
    const compiled = JSON.parse(compile.stdout);
    assert.equal(compiled.queueRows[0].slug, "rerun-baseline");
    assert.equal(compiled.phase.phase, "experiment");

    const phase = await runCli([dir, "phase", "--phase", "ideation", "--brief", "plateau", "--summary", "return to brainstorm", "--json"]);
    assert.equal(phase.status, 0, phase.stderr);
    assert.equal(JSON.parse(phase.stdout).state.phase, "ideation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-brief create: missing required flags exits 1 cleanly", async () => {
  const dir = makeProject("vr-brief-cli-missing");
  try {
    const result = await runCli([dir, "create", "--slug", "x"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--question is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
