// Unit + smoke tests for src/research/init.js + bin/vr-research-init.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  createProject,
  fillPaperTemplate,
  renderProjectReadme,
  DEFAULT_PROJECT_NAME_PATTERN,
} from "../src/research/init.js";

const VR_INIT = path.resolve("bin/vr-research-init");

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function runCli(args, { cwd, env = {}, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_INIT, ...args], {
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

// ---- pure helpers ----

test("DEFAULT_PROJECT_NAME_PATTERN: accepts slug forms, rejects bad", () => {
  for (const ok of ["foo", "foo-bar", "abc123", "1abc"]) {
    assert.equal(DEFAULT_PROJECT_NAME_PATTERN.test(ok), true, `${ok} should match`);
  }
  for (const bad of ["", "Foo", "foo bar", "_foo", "foo/bar", "foo.bar", "-foo"]) {
    assert.equal(DEFAULT_PROJECT_NAME_PATTERN.test(bad), false, `${bad} should NOT match`);
  }
});

test("renderProjectReadme: includes all required sections in order", () => {
  const md = renderProjectReadme({
    name: "demo",
    goal: "Find best widget config.",
    successCriteria: ["beats baseline by 2σ"],
    ranking: { kind: "quantitative", metric: "accuracy", direction: "higher" },
  });
  for (const heading of [
    "# demo",
    "## GOAL",
    "## CODE REPO",
    "## SUCCESS CRITERIA",
    "## RANKING CRITERION",
    "## LEADERBOARD",
    "## INSIGHTS",
    "## ACTIVE",
    "## QUEUE",
    "## LOG",
  ]) {
    assert.ok(md.includes(heading), `missing ${heading}`);
  }
  assert.match(md, /Find best widget config\./);
  assert.match(md, /quantitative: accuracy \(higher is better\)/);
  assert.match(md, /- beats baseline by 2σ/);
});

test("renderProjectReadme: ranking defaults to qualitative when missing", () => {
  const md = renderProjectReadme({ name: "demo" });
  assert.match(md, /qualitative: <dimension>/);
});

test("renderProjectReadme: queue rows render as a markdown table", () => {
  const md = renderProjectReadme({
    name: "demo",
    queueRows: [{ move: "first-sweep", startingPoint: "main", why: "establish baseline" }],
  });
  assert.match(md, /\| first-sweep \| main \| establish baseline \|/);
});

test("fillPaperTemplate: replaces title + first-paragraph goal", () => {
  const template = [
    "# <Project title>",
    "",
    "stuff",
    "",
    "## 1. Question",
    "",
    "<!-- locked: pre-registration -->",
    "",
    "Original placeholder paragraph.",
  ].join("\n");
  const out = fillPaperTemplate(template, { name: "my-proj", goal: "Test if X works" });
  assert.match(out, /^# my-proj/);
  assert.match(out, /Test if X works/);
  assert.equal(out.includes("Original placeholder paragraph."), false);
});

test("fillPaperTemplate: leaves placeholder intact when no goal", () => {
  const template = [
    "# <Project title>",
    "",
    "## 1. Question",
    "",
    "<!-- locked: pre-registration -->",
    "",
    "Placeholder.",
  ].join("\n");
  const out = fillPaperTemplate(template, { name: "my-proj" });
  assert.match(out, /Placeholder\./);
});

// ---- createProject (real fs) ----

test("createProject: writes README + paper.md + results/ + figures/", async () => {
  const dir = tmp("research-init");
  // Provide a paper template alongside a fake repo root so the loader
  // finds it.
  const repoRoot = dir;
  const templatesDir = join(dir, "templates");
  mkdirSync(templatesDir);
  writeFileSync(join(templatesDir, "paper-template.md"),
    "# <Project title>\n\nliving paper",
    "utf8",
  );
  const projectsDir = join(dir, "projects");
  mkdirSync(projectsDir);
  try {
    const result = await createProject({
      projectsDir,
      name: "alpha",
      goal: "Investigate something.",
      successCriteria: ["criterion 1"],
      ranking: { kind: "qualitative", dimension: "quality" },
      repoRoot,
    });
    assert.equal(result.projectDir, join(projectsDir, "alpha"));
    assert.ok(result.wrote.length >= 1);
    const readme = readFileSync(join(projectsDir, "alpha", "README.md"), "utf8");
    assert.match(readme, /# alpha/);
    assert.match(readme, /Investigate something\./);
    assert.match(readme, /qualitative: quality/);
    const paper = readFileSync(join(projectsDir, "alpha", "paper.md"), "utf8");
    assert.match(paper, /^# alpha/);
    assert.ok(existsSync(join(projectsDir, "alpha", "results")));
    assert.ok(existsSync(join(projectsDir, "alpha", "figures")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createProject: throws when project exists + force=false", async () => {
  const dir = tmp("research-init-exists");
  const projectsDir = join(dir, "projects");
  mkdirSync(join(projectsDir, "beta"), { recursive: true });
  try {
    await assert.rejects(
      createProject({ projectsDir, name: "beta", repoRoot: dir }),
      /already exists/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createProject: force=true overwrites", async () => {
  const dir = tmp("research-init-force");
  const projectsDir = join(dir, "projects");
  mkdirSync(join(projectsDir, "gamma"), { recursive: true });
  // Pre-existing file we expect to still be there (createProject doesn't
  // wipe; it just no-longer-throws).
  writeFileSync(join(projectsDir, "gamma", "old-marker.txt"), "preserved", "utf8");
  try {
    const result = await createProject({
      projectsDir,
      name: "gamma",
      force: true,
      repoRoot: dir,
    });
    assert.ok(result.wrote.length >= 1);
    assert.ok(existsSync(join(projectsDir, "gamma", "README.md")));
    // Existing file still there — we don't aggressively wipe.
    assert.ok(existsSync(join(projectsDir, "gamma", "old-marker.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createProject: rejects bad name", async () => {
  const dir = tmp("research-init-badname");
  const projectsDir = join(dir, "projects");
  mkdirSync(projectsDir);
  try {
    await assert.rejects(
      createProject({ projectsDir, name: "Bad Name" }),
      /must match/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- bin/vr-research-init ----

test("vr-research-init CLI: --help exits 0", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /vr-research-init/);
});

test("vr-research-init CLI: no name exits 2 with help", async () => {
  const result = await runCli([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /project-name is required/);
});

test("vr-research-init CLI: bad ranking spec exits 2", async () => {
  const dir = tmp("vr-init-badrank");
  try {
    const result = await runCli(["x", "--library", dir, "--ranking", "wat:abc"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown ranking kind/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-init CLI: --json round-trip writes README + paper", async () => {
  const dir = tmp("vr-init-cli");
  // Fake template alongside the library so the bin script finds it.
  const templatesDir = join(dir, "templates");
  mkdirSync(templatesDir);
  writeFileSync(join(templatesDir, "paper-template.md"), "# <Project title>\n", "utf8");
  try {
    const result = await runCli([
      "delta-experiment",
      "--library", dir,
      "--goal", "Test if delta works.",
      "--success", "n>=3 seeds",
      "--ranking", "quantitative:reward:higher",
      "--queue", "baseline | main | establish baseline",
      "--json",
    ]);
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.projectDir, join(dir, "projects", "delta-experiment"));
    assert.ok(body.wrote.length >= 1);
    const readme = readFileSync(join(body.projectDir, "README.md"), "utf8");
    assert.match(readme, /Test if delta works/);
    assert.match(readme, /quantitative: reward \(higher is better\)/);
    assert.match(readme, /\| baseline \| main \| establish baseline \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
