// Tests for the rl-sweep-tuner skill + bin/vr-rl-tuner bootstrap helper.
//
// Conceptual reframe vs the previous version: the autonomous tuner is the
// USER's existing coding agent (Claude Code) loading the skill, NOT a
// separately spawned sub-agent. So:
//
//   - The skill at skills/rl-sweep-tuner/SKILL.md is the playbook the
//     existing coding agent loads on demand. Tested for the contract
//     it must declare.
//   - bin/vr-rl-tuner is now a thin bootstrap CLI: it writes the
//     project + kickoff.json so the coding agent has a target to take
//     over. No agent spawning, no allowedTools wiring, no occupation
//     argv generation — those are the existing session's concern.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

const VR_RL_TUNER = path.resolve("bin/vr-rl-tuner");
const SKILL_PATH = path.resolve("skills/rl-sweep-tuner/SKILL.md");

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

// ---- skill ----

test("rl-sweep-tuner skill: lives at the conventional path with proper frontmatter", () => {
  assert.ok(existsSync(SKILL_PATH), "skill must exist at skills/rl-sweep-tuner/SKILL.md");
  const text = readFileSync(SKILL_PATH, "utf8");
  // YAML frontmatter so Claude Code's skill loader picks it up.
  assert.match(text, /^---\nname:\s*"?rl-sweep-tuner"?\s*\ndescription:\s*"[^"]+"\s*\n---/m);
});

test("rl-sweep-tuner skill: declares the autonomous-loop contract", () => {
  const text = readFileSync(SKILL_PATH, "utf8");
  // The agent OWNS the loop. This is the key reframe vs ml-intern-template.
  assert.match(text, /You own the loop/);
  // Must reference the existing tools the agent uses.
  assert.match(text, /vr-rl-sweep init/);
  assert.match(text, /vr-rl-sweep run/);
  assert.match(text, /vr-research-init/);
  assert.match(text, /vr-research-admit/);
  assert.match(text, /vr-research-doctor/);
  // Must enforce the 3-seed + 2σ noise rule.
  assert.match(text, /n ≥ 3 seeds/);
  assert.match(text, /2 × std/);
});

test("rl-sweep-tuner skill: gives explicit decision-discipline order", () => {
  const text = readFileSync(SKILL_PATH, "utf8");
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

test("rl-sweep-tuner skill: tells the agent to use --sweep-name on follow-up moves", () => {
  const text = readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /--sweep-name/);
  assert.match(text, /follow-up moves/i);
});

// ---- bin/vr-rl-tuner (now bootstrap-only, no spawn) ----

test("vr-rl-tuner --help: exits 0 + tells user to ask their agent to take over", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /vr-rl-tuner/);
  assert.match(result.stdout, /rl-sweep-tuner skill/);
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

test("vr-rl-tuner: bootstraps project + writes kickoff.json + prints next-step hint", async () => {
  const lib = tmp("vr-tuner-lib");
  const repo = tmp("vr-tuner-repo");
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
    assert.match(result.stdout, /bootstrapped /);
    assert.match(result.stdout, /kickoff: /);
    // Crucially: the help/output now points the user at their EXISTING
    // coding agent, not at a spawn command.
    assert.match(result.stdout, /tell your coding agent/i);
    assert.match(result.stdout, /rl-sweep-tuner skill/);
    // Should NOT print any spawn command or env-var dump.
    assert.equal(/VIBE_RESEARCH_AGENT_PROMPT_PATH/.test(result.stdout), false,
      "removed: no agent spawning anymore");
    assert.equal(/--allowedTools/.test(result.stdout), false,
      "removed: no spawn argv anymore");

    // The kickoff.json should physically exist + contain the goal.
    const projectDir = result.stdout.match(/bootstrapped (\S+)/)[1];
    const kickoff = JSON.parse(readFileSync(join(projectDir, "kickoff.json"), "utf8"));
    assert.equal(kickoff.repo, repo);
    assert.equal(kickoff.goal, "find best LR/batch combo for PPO on Atari");
    assert.equal(kickoff.budget, "20 GPU-hours, $50");
    assert.ok(kickoff.spawnedAt);
    // No occupationPath field anymore — that was tied to the spawn.
    assert.equal(kickoff.occupationPath, undefined);

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

test("vr-rl-tuner --json: returns machine-readable summary with nextStep hint", async () => {
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
    assert.match(body.nextStep, /rl-sweep-tuner skill/);
    // No spawnCommand field anymore.
    assert.equal(body.spawnCommand, undefined);
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
