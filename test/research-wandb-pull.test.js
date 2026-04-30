// Unit + CLI tests for src/research/wandb-pull.js + bin/vr-rl-sweep wandb-pull.
//
// We never hit the real wandb API in tests — the fetcher is dependency-injected.
// This validates the URL parser, the metric back-fill logic, idempotency, and
// the CLI surface area.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

import { pullWandbMetrics, parseWandbRunUrl } from "../src/research/wandb-pull.js";

const VR_RL_SWEEP = path.resolve("bin/vr-rl-sweep");

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `${prefix}-`)); }

function runCli(args, { cwd, env = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_RL_SWEEP, ...args], {
      cwd, env: { ...process.env, ...env },
    });
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

const HEADER = [
  "started_at", "group", "name", "commit", "hypothesis",
  "mean_return", "std_return", "wandb_url", "status", "config",
].join("\t");

function row({ name, mean_return = "", wandb_url = "", status = "done" } = {}) {
  return [
    "2026-04-30T00:00:00Z", "g", name, "abc1234", "h",
    mean_return, "", wandb_url, status, "{}",
  ].join("\t");
}

function makeTsv(rows) {
  return `${HEADER}\n${rows.join("\n")}\n`;
}

// ---- parseWandbRunUrl ----

test("parseWandbRunUrl: extracts entity / project / runId from canonical URL", () => {
  const r = parseWandbRunUrl("https://wandb.ai/acme/experiments/runs/abc123");
  assert.deepEqual(r, { entity: "acme", project: "experiments", runId: "abc123" });
});

test("parseWandbRunUrl: trims trailing query/fragment + accepts subdomain", () => {
  const r = parseWandbRunUrl("https://api.wandb.ai/acme/proj/runs/r-X_y9?foo=bar");
  assert.deepEqual(r, { entity: "acme", project: "proj", runId: "r-X_y9" });
});

test("parseWandbRunUrl: returns null for non-run URLs / empties", () => {
  assert.equal(parseWandbRunUrl(""), null);
  assert.equal(parseWandbRunUrl(null), null);
  assert.equal(parseWandbRunUrl("https://example.com"), null);
  assert.equal(parseWandbRunUrl("https://wandb.ai/me/proj"), null); // project URL, no /runs/
});

// ---- pullWandbMetrics ----

test("pullWandbMetrics: fills empty mean_return rows from injected fetcher", async () => {
  const dir = tmp("vr-wandb-fill");
  try {
    const tsvPath = join(dir, "runs.tsv");
    writeFileSync(tsvPath, makeTsv([
      row({ name: "g-cell-seed0", mean_return: "", wandb_url: "https://wandb.ai/acme/p/runs/aaa" }),
      row({ name: "g-cell-seed1", mean_return: "", wandb_url: "https://wandb.ai/acme/p/runs/bbb" }),
    ]));
    const fetchImpl = async ({ runId }) => {
      if (runId === "aaa") return { mean_return: 0.81, other: 99 };
      if (runId === "bbb") return { mean_return: 0.79, other: 99 };
      return null;
    };
    const result = await pullWandbMetrics({ runsTsvPath: tsvPath, fetchImpl });
    assert.equal(result.pulled, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.failed, 0);
    const after = readFileSync(tsvPath, "utf8");
    assert.match(after, /\t0\.81\t/);
    assert.match(after, /\t0\.79\t/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pullWandbMetrics: skips rows that already have mean_return", async () => {
  const dir = tmp("vr-wandb-skip");
  try {
    const tsvPath = join(dir, "runs.tsv");
    writeFileSync(tsvPath, makeTsv([
      row({ name: "g-cell-seed0", mean_return: "0.5", wandb_url: "https://wandb.ai/x/y/runs/aaa" }),
      row({ name: "g-cell-seed1", mean_return: "",    wandb_url: "https://wandb.ai/x/y/runs/bbb" }),
    ]));
    let calls = 0;
    const fetchImpl = async ({ runId }) => {
      calls += 1;
      if (runId === "bbb") return { mean_return: 0.7 };
      return null;
    };
    const result = await pullWandbMetrics({ runsTsvPath: tsvPath, fetchImpl });
    assert.equal(result.pulled, 1);
    assert.equal(result.skipped, 1);
    assert.equal(calls, 1, "fetcher should NOT be called for the already-filled row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pullWandbMetrics: --overwrite refills already-filled rows", async () => {
  const dir = tmp("vr-wandb-over");
  try {
    const tsvPath = join(dir, "runs.tsv");
    writeFileSync(tsvPath, makeTsv([
      row({ name: "g-cell-seed0", mean_return: "0.5", wandb_url: "https://wandb.ai/x/y/runs/aaa" }),
    ]));
    const fetchImpl = async () => ({ mean_return: 0.99 });
    const result = await pullWandbMetrics({ runsTsvPath: tsvPath, fetchImpl, overwrite: true });
    assert.equal(result.pulled, 1);
    assert.equal(result.skipped, 0);
    assert.match(readFileSync(tsvPath, "utf8"), /\t0\.99\t/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pullWandbMetrics: skips rows missing wandb_url", async () => {
  const dir = tmp("vr-wandb-no-url");
  try {
    const tsvPath = join(dir, "runs.tsv");
    writeFileSync(tsvPath, makeTsv([
      row({ name: "g-no-url", mean_return: "", wandb_url: "" }),
    ]));
    const fetchImpl = async () => { throw new Error("should not be called"); };
    const result = await pullWandbMetrics({ runsTsvPath: tsvPath, fetchImpl });
    assert.equal(result.skipped, 1);
    assert.equal(result.pulled, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pullWandbMetrics: skips rows where summary lacks the requested metric", async () => {
  const dir = tmp("vr-wandb-no-metric");
  try {
    const tsvPath = join(dir, "runs.tsv");
    writeFileSync(tsvPath, makeTsv([
      row({ name: "g-cell-seed0", mean_return: "", wandb_url: "https://wandb.ai/x/y/runs/aaa" }),
    ]));
    const fetchImpl = async () => ({ other_metric: 99 });
    const result = await pullWandbMetrics({ runsTsvPath: tsvPath, fetchImpl });
    assert.equal(result.pulled, 0);
    assert.equal(result.skipped, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pullWandbMetrics: counts fetcher errors as failed (with reason)", async () => {
  const dir = tmp("vr-wandb-err");
  try {
    const tsvPath = join(dir, "runs.tsv");
    writeFileSync(tsvPath, makeTsv([
      row({ name: "g-cell-seed0", mean_return: "", wandb_url: "https://wandb.ai/x/y/runs/aaa" }),
    ]));
    const fetchImpl = async () => { throw new Error("403 forbidden"); };
    const result = await pullWandbMetrics({ runsTsvPath: tsvPath, fetchImpl });
    assert.equal(result.pulled, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.failures[0].error, "403 forbidden");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pullWandbMetrics: --metric reads a non-default summary key", async () => {
  const dir = tmp("vr-wandb-custom-metric");
  try {
    const tsvPath = join(dir, "runs.tsv");
    writeFileSync(tsvPath, makeTsv([
      row({ name: "g-cell-seed0", mean_return: "", wandb_url: "https://wandb.ai/x/y/runs/aaa" }),
    ]));
    const fetchImpl = async () => ({ "eval/return": 1.23, "loss": 0.1 });
    const result = await pullWandbMetrics({
      runsTsvPath: tsvPath,
      fetchImpl,
      metric: "eval/return",
    });
    assert.equal(result.pulled, 1);
    assert.match(readFileSync(tsvPath, "utf8"), /\t1\.23\t/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pullWandbMetrics: rejects when runs.tsv has no header", async () => {
  const dir = tmp("vr-wandb-empty");
  try {
    const tsvPath = join(dir, "runs.tsv");
    writeFileSync(tsvPath, "");
    await assert.rejects(
      pullWandbMetrics({ runsTsvPath: tsvPath, fetchImpl: async () => ({}) }),
      /no header/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- bin/vr-rl-sweep wandb-pull ----

test("vr-rl-sweep wandb-pull: missing project errors clearly", async () => {
  const dir = tmp("vr-wandb-cli-missing");
  try {
    const r = await runCli(["wandb-pull", "ghost", "--library", dir]);
    assert.equal(r.status, 1);
    // Errors out because runs.tsv doesn't exist for the ghost project.
    assert.match(r.stderr, /ENOENT|no such file/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-rl-sweep --help advertises wandb-pull subcommand", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /wandb-pull <name>/);
});

// We don't end-to-end test the CLI's wandb call (requires real auth); the
// lib-level dep-injection tests above cover the behaviour. The CLI tests
// here just confirm wiring exists and error paths surface cleanly.
