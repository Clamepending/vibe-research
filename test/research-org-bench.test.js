import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import {
  createPosttrainLiteScenario,
  evaluatePosttrainLiteScenario,
  runOrgBench,
} from "../src/research/org-bench.js";

const VR_RESEARCH_ORG_BENCH = path.resolve("bin/vr-research-org-bench");

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function runCli(args, { cwd = process.cwd(), timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_RESEARCH_ORG_BENCH, ...args], {
      cwd,
      env: process.env,
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

test("posttrain-lite scenario evaluates protected recipe edits", async () => {
  const dir = tmp("vr-org-bench-scenario");
  try {
    await createPosttrainLiteScenario({ scenarioDir: dir, seed: 2 });
    const baseline = await evaluatePosttrainLiteScenario({ scenarioDir: dir });
    assert.equal(baseline.integrityOk, true);
    assert.ok(baseline.holdoutScore > 0);
    assert.equal(baseline.recipe.method, "grpo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runOrgBench compares baseline, single proxy, and org-autopilot proxy", async () => {
  const dir = tmp("vr-org-bench-run");
  try {
    const report = await runOrgBench({
      outputDir: dir,
      seeds: [0, 1],
      timeoutMs: 10_000,
    });
    const byStrategy = new Map(report.summary.map((row) => [row.strategy, row]));
    assert.equal(byStrategy.get("baseline")?.runs, 2);
    assert.equal(byStrategy.get("single-proxy")?.integrityPassRate, 1);
    assert.equal(byStrategy.get("org-autopilot-proxy")?.integrityPassRate, 1);
    assert.ok(
      byStrategy.get("single-proxy").holdoutMean > byStrategy.get("baseline").holdoutMean,
      "single proxy should improve over baseline",
    );
    assert.ok(
      byStrategy.get("org-autopilot-proxy").holdoutMean > byStrategy.get("single-proxy").holdoutMean,
      "org proxy should beat the single-pass dev optimizer on holdout",
    );
    const reportJson = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    assert.equal(reportJson.results.length, 6);
    assert.ok(reportJson.results.some((row) => row.execution.kind === "org-autopilot-proxy"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runOrgBench can compare provider-backed single-agent and org strategies", async () => {
  const dir = tmp("vr-org-bench-provider");
  try {
    const providerCommand = `${process.execPath} scripts/provider-agent-proxy.mjs`;
    const reviewerCommand = `${process.execPath} scripts/provider-reviewer-proxy.mjs`;
    const report = await runOrgBench({
      outputDir: dir,
      strategies: ["single-agent-provider", "org-provider", "org-provider-reviewed"],
      seeds: [0, 1],
      timeoutMs: 10_000,
      providerCommand,
      providerId: "require-env",
      reviewerCommand,
      reviewerProviderId: "mock-reviewer",
    });
    const byStrategy = new Map(report.summary.map((row) => [row.strategy, row]));
    assert.equal(report.providerId, "require-env");
    assert.equal(report.reviewerProviderId, "mock-reviewer");
    assert.equal(byStrategy.get("single-agent-provider")?.integrityPassRate, 1);
    assert.equal(byStrategy.get("org-provider")?.integrityPassRate, 1);
    assert.equal(byStrategy.get("org-provider-reviewed")?.integrityPassRate, 1);
    assert.ok(
      byStrategy.get("org-provider").holdoutMean > byStrategy.get("single-agent-provider").holdoutMean,
      "provider-backed org strategy should beat the provider single-pass baseline in the proxy",
    );
    assert.ok(
      byStrategy.get("org-provider-reviewed").holdoutMean > byStrategy.get("single-agent-provider").holdoutMean,
      "provider-backed reviewed org strategy should beat the provider single-pass baseline in the proxy",
    );
    const orgRun = report.results.find((row) => row.strategy === "org-provider");
    assert.equal(orgRun.execution.providerId, "require-env");
    assert.ok(orgRun.execution.reports?.length >= 2);
    const reviewedRun = report.results.find((row) => row.strategy === "org-provider-reviewed");
    assert.equal(reviewedRun.execution.reviewerProviderId, "mock-reviewer");
    assert.ok(reviewedRun.execution.reviews?.length >= 1);
    const review = readFileSync(reviewedRun.execution.reviews[0].reviewFile, "utf8");
    assert.match(review, /OVERFIT_RISK=high/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-org-bench CLI writes a report", async () => {
  const dir = tmp("vr-org-bench-cli");
  try {
    const result = await runCli(["run", dir, "--seeds", "0", "--strategy", "baseline", "--strategy", "single-proxy"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Org bench: posttrain-lite/);
    assert.match(result.stdout, /single-proxy/);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    assert.deepEqual(report.strategies, ["baseline", "single-proxy"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-org-bench CLI accepts provider command templates", async () => {
  const dir = tmp("vr-org-bench-cli-provider");
  try {
    const providerCommand = `${process.execPath} scripts/provider-agent-proxy.mjs`;
    const reviewerCommand = `${process.execPath} scripts/provider-reviewer-proxy.mjs`;
    const result = await runCli([
      "run",
      dir,
      "--seeds",
      "0",
      "--strategy",
      "org-provider-reviewed",
      "--agent-provider",
      "require-env",
      "--provider-command",
      providerCommand,
      "--reviewer-provider",
      "mock-reviewer",
      "--reviewer-command",
      reviewerCommand,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /org-provider-reviewed/);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    assert.equal(report.providerId, "require-env");
    assert.equal(report.reviewerProviderId, "mock-reviewer");
    assert.equal(report.results[0].execution.kind, "org-provider-reviewed");
    assert.ok(report.results[0].execution.reviews?.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
