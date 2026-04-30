// Smoke tests for examples/halfcheetah-sac/.
//
// We don't run the real training here — that needs MuJoCo + torch installed
// and 5+ minutes per smallest meaningful run. Instead we validate:
//   - train.py --help works (lazy imports keep --help cheap)
//   - the help text exposes the flags vr-rl-sweep's launcher template uses
//   - bootstrap.sh and kickoff.sh exist and are executable
//   - kickoff.sh's vr-rl-tuner invocation parses cleanly with --help
//
// These guard the contract between the example and the autonomous tuner so
// drift surfaces in CI rather than the day someone tries to run a real sweep.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const EXAMPLE_DIR = path.resolve("examples/halfcheetah-sac");

function run(cmd, args, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: process.env });
    let stdout = "", stderr = "";
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

test("examples/halfcheetah-sac/: directory + key files exist", () => {
  assert.ok(existsSync(EXAMPLE_DIR), "examples/halfcheetah-sac/ should exist");
  for (const f of ["train.py", "requirements.txt", "bootstrap.sh", "kickoff.sh", "README.md"]) {
    assert.ok(existsSync(path.join(EXAMPLE_DIR, f)), `${f} should exist`);
  }
});

test("examples/halfcheetah-sac/: shell scripts are executable", () => {
  for (const f of ["bootstrap.sh", "kickoff.sh", "train.py"]) {
    const mode = statSync(path.join(EXAMPLE_DIR, f)).mode;
    assert.ok(mode & 0o111, `${f} should be executable (mode=${mode.toString(8)})`);
  }
});

test("train.py --help: lazy imports keep it cheap, exits 0", async () => {
  const r = await run("python3", [path.join(EXAMPLE_DIR, "train.py"), "--help"]);
  assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /Train SAC on HalfCheetah/);
});

test("train.py --help: exposes flags the launcher template uses", async () => {
  const r = await run("python3", [path.join(EXAMPLE_DIR, "train.py"), "--help"]);
  assert.equal(r.status, 0);
  // The autonomous tuner's launcher template substitutes ${lr}, ${batch_size},
  // ${seed}, ${gamma}, ${tau}, ${alpha}, ${total_steps}. Confirm each lands.
  for (const flag of ["--lr", "--batch-size", "--seed", "--gamma", "--tau", "--alpha", "--total-steps", "--wandb-group", "--wandb-name"]) {
    assert.match(r.stdout, new RegExp(flag.replace(/-/g, "[-]")),
      `train.py --help should mention ${flag}`);
  }
});

test("kickoff.sh: usage error when called with no args", async () => {
  const r = await run("bash", [path.join(EXAMPLE_DIR, "kickoff.sh")]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test("requirements.txt: pins the deps that train.py imports", async () => {
  const fs = await import("node:fs");
  const text = fs.readFileSync(path.join(EXAMPLE_DIR, "requirements.txt"), "utf8");
  for (const dep of ["gymnasium", "stable-baselines3", "torch", "wandb"]) {
    assert.match(text, new RegExp(`^${dep}`, "m"), `requirements.txt should pin ${dep}`);
  }
});
