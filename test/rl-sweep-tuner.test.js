// Tests for the rl-sweep-tuner occupation template + bin/vr-rl-tuner
// helper. Both are static / orchestrational — no real agent spawn here;
// the spawn is just a printed command (or a process exec under --exec).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

const VR_RL_TUNER = path.resolve("bin/vr-rl-tuner");
const TEMPLATE_PATH = path.resolve("templates/rl-sweep-tuner.md");

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `${prefix}-`)); }

function runCli(args, { cwd, env = {}, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_RL_TUNER, ...args], {
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

// ---- occupation template ----

test("rl-sweep-tuner.md exists and contains the occupation contract", () => {
  assert.ok(existsSync(TEMPLATE_PATH), "template must exist");
  const text = readFileSync(TEMPLATE_PATH, "utf8");
  // Must declare the agent owns the loop (key reframe vs ml-intern).
  assert.match(text, /You own this loop/);
  // Must reference the existing tools the agent uses.
  assert.match(text, /vr-rl-sweep init/);
  assert.match(text, /vr-research-init/);
  assert.match(text, /vr-research-admit/);
  assert.match(text, /vr-research-doctor/);
  // Must enforce the 3-seed + 2σ noise rule.
  assert.match(text, /n ≥ 3 seeds/);
  assert.match(text, /2 × std/);
  // Must mention budget guard + Agent Inbox approval.
  assert.match(text, /budget/i);
  assert.match(text, /Agent Inbox/);
});

test("rl-sweep-tuner.md gives explicit decision-discipline order", () => {
  const text = readFileSync(TEMPLATE_PATH, "utf8");
  // The order matters; check the headings appear in this sequence.
  const ablate = text.indexOf("Ablate");
  const replicate = text.indexOf("Replicate");
  const sensitivity = text.indexOf("Sensitivity");
  const architecture = text.indexOf("Architecture only after");
  const stop = text.indexOf("Stop hammering");
  assert.ok(ablate >= 0, "Ablate first");
  assert.ok(replicate > ablate, "Replicate after Ablate");
  assert.ok(sensitivity > replicate, "Sensitivity after Replicate");
  assert.ok(architecture > sensitivity, "Architecture after Sensitivity");
  assert.ok(stop > architecture, "Stop hammering last");
});

// ---- bin/vr-rl-tuner ----

test("vr-rl-tuner --help: exits 0 + prints usage", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /vr-rl-tuner/);
});

test("vr-rl-tuner: missing --repo / --goal exits 2", async () => {
  const r1 = await runCli(["--goal", "x"]);
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /--repo is required/);
  const r2 = await runCli(["--repo", process.cwd()]);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /--goal is required/);
});

test("vr-rl-tuner: --repo path that doesn't exist exits 2", async () => {
  const r = await runCli(["--repo", "/no/such/path/here", "--goal", "x"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--repo path not found/);
});

test("vr-rl-tuner: --provider must be claude or codex", async () => {
  const repo = tmp("vr-tuner-repo");
  try {
    const r = await runCli(["--repo", repo, "--goal", "x", "--provider", "made-up"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--provider must be claude\|codex/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("vr-rl-tuner: bootstraps project + writes kickoff.json + prints spawn command", async () => {
  const lib = tmp("vr-tuner-lib");
  const repo = tmp("vr-tuner-repo");
  // The vr-research-init backend looks for templates/paper-template.md
  // alongside the library; ship a stub.
  mkdirSync(join(lib, "templates"));
  writeFileSync(join(lib, "templates", "paper-template.md"), "# <Project title>\n", "utf8");
  try {
    const result = await runCli([
      "--repo", repo,
      "--goal", "find best LR/batch combo for PPO on Atari",
      "--budget", "20 GPU-hours, $50",
      "--library", lib,
    ]);
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    // The repo's basename is something like "vr-tuner-repo-<rand>"; the
    // derived project slug should match that.
    assert.match(result.stdout, /bootstrapped /);
    assert.match(result.stdout, /kickoff: /);
    assert.match(result.stdout, /To hand the project to the autonomous agent, run:/);
    assert.match(result.stdout, /VIBE_RESEARCH_AGENT_PROMPT_PATH=/);

    // The kickoff.json should physically exist + contain the goal.
    const projects = readFileSync;  // just to keep imports tidy
    const projectDir = result.stdout.match(/bootstrapped (\S+)/)[1];
    const kickoffText = readFileSync(join(projectDir, "kickoff.json"), "utf8");
    const kickoff = JSON.parse(kickoffText);
    assert.equal(kickoff.repo, repo);
    assert.equal(kickoff.goal, "find best LR/batch combo for PPO on Atari");
    assert.equal(kickoff.budget, "20 GPU-hours, $50");
    assert.ok(kickoff.spawnedAt);

    // README + paper bootstrapped.
    assert.ok(existsSync(join(projectDir, "README.md")));
    assert.ok(existsSync(join(projectDir, "paper.md")));
    assert.ok(existsSync(join(projectDir, "results")));
    assert.ok(existsSync(join(projectDir, "figures")));
  } finally {
    rmSync(lib, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("vr-rl-tuner --json: returns machine-readable summary with spawn command", async () => {
  const lib = tmp("vr-tuner-json-lib");
  const repo = tmp("vr-tuner-json-repo");
  mkdirSync(join(lib, "templates"));
  writeFileSync(join(lib, "templates", "paper-template.md"), "# <Project title>\n", "utf8");
  try {
    const result = await runCli([
      "--repo", repo,
      "--goal", "x",
      "--library", lib,
      "--json",
    ]);
    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.ok(body.projectDir);
    assert.ok(body.kickoff);
    assert.equal(body.repo, repo);
    assert.deepEqual(body.spawnCommand.argv, ["claude"]);
    assert.equal(body.spawnCommand.cwd, body.projectDir);
    assert.equal(body.spawnCommand.env.VIBE_RESEARCH_PROJECT_REPO, repo);
    assert.match(body.spawnCommand.env.VIBE_RESEARCH_AGENT_PROMPT_PATH, /rl-sweep-tuner\.md$/);
  } finally {
    rmSync(lib, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("vr-rl-tuner: respects --name override", async () => {
  const lib = tmp("vr-tuner-name-lib");
  const repo = tmp("vr-tuner-name-repo");
  mkdirSync(join(lib, "templates"));
  writeFileSync(join(lib, "templates", "paper-template.md"), "# <Project title>\n", "utf8");
  try {
    const result = await runCli([
      "--repo", repo,
      "--goal", "x",
      "--library", lib,
      "--name", "ppo-tuning-2026",
      "--json",
    ]);
    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.match(body.projectDir, /ppo-tuning-2026$/);
  } finally {
    rmSync(lib, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("vr-rl-tuner: existing project without --force exits 1", async () => {
  const lib = tmp("vr-tuner-exist-lib");
  const repo = tmp("vr-tuner-exist-repo");
  mkdirSync(join(lib, "templates"));
  writeFileSync(join(lib, "templates", "paper-template.md"), "# <Project title>\n", "utf8");
  // Pre-create the project dir so vr-research-init refuses without --force.
  const slugBase = path.basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  mkdirSync(join(lib, "projects", slugBase), { recursive: true });
  try {
    const result = await runCli([
      "--repo", repo,
      "--goal", "x",
      "--library", lib,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already exists/);
  } finally {
    rmSync(lib, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
