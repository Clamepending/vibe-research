import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseProjectReadme } from "../src/research/project-readme.js";
import { parseResultDoc, parseFrontmatter } from "../src/research/result-doc.js";
import { runDoctor } from "../src/research/doctor.js";
import { runAdmit, formatVerdict } from "../src/research/admit.js";
import { lintPaper } from "../src/research/paper-lint.js";
import { parseBenchmark, validateBenchmark, loadBenchmark } from "../src/research/benchmark.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(
  HERE,
  "fixtures",
  "research",
  "library",
  "projects",
  "widget-tuning",
);
const FIXTURE_BENCHED_PROJECT = path.join(
  HERE,
  "fixtures",
  "research",
  "library",
  "projects",
  "prose-style",
);

async function copyDir(src, dest) {
  const entries = await import("node:fs").then((m) => m.promises.readdir(src, { withFileTypes: true }));
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else {
      await copyFile(from, to);
    }
  }
}

test("parseProjectReadme: parses leaderboard / queue / log / ranking criterion", async () => {
  const text = await readFile(path.join(FIXTURE_PROJECT, "README.md"), "utf8");
  const project = parseProjectReadme(text);

  assert.equal(project.rankingCriterion.kind, "quantitative");
  assert.match(project.rankingCriterion.description, /wibble/i);

  assert.equal(project.leaderboard.length, 2);
  assert.equal(project.leaderboard[0].rank, 1);
  assert.equal(project.leaderboard[0].slug, "v2-tuned");
  assert.equal(project.leaderboard[0].resultPath, "results/v2-tuned.md");
  assert.match(project.leaderboard[0].branchUrl, /\/tree\/r\/v2-tuned$/);
  assert.match(project.leaderboard[0].commitUrl, /\/commit\/[a-f0-9]+$/);

  assert.equal(project.queue.length, 1);
  assert.equal(project.queue[0].slug, "v3-deeper-knob");
  assert.match(project.queue[0].startingPointUrl, /\/tree\/r\/v2-tuned/);

  assert.equal(project.log[0].event, "resolved+admitted");
  assert.equal(project.log[0].slug, "v2-tuned");

  assert.equal(project.insights.length, 1);
  assert.equal(project.insights[0].slug, "widget-knob-load-bearing");
});

test("parseProjectReadme: skips placeholder rows like '—' and '*(empty ...)*'", () => {
  const text = `## LEADERBOARD\n\n| rank | result | branch | commit | score |\n|------|--------|--------|--------|-------|\n| —    | —      | —      | —      | —     |\n\n## QUEUE\n\n| move | starting-point | why |\n|------|----------------|-----|\n| *(empty — enter review mode)* | — | — |\n\n## RANKING CRITERION\n\nqualitative: foo\n`;
  const project = parseProjectReadme(text);
  assert.equal(project.leaderboard.length, 0);
  assert.equal(project.queue.length, 0);
  assert.equal(project.rankingCriterion.kind, "qualitative");
});

test("parseProjectReadme: handles backtick-wrapped ranking criterion with em-dash continuation", () => {
  const text = "## RANKING CRITERION\n\n`qualitative: flash horror craft` — composite read of …\n";
  const project = parseProjectReadme(text);
  assert.equal(project.rankingCriterion.kind, "qualitative");
  assert.equal(project.rankingCriterion.description, "flash horror craft");
});

test("parseFrontmatter: parses scalars and inline arrays", () => {
  const text = "---\nmetric: wibble\nmetric_higher_is_better: true\nseeds: [0, 1, 2]\nmean: 0.84\nstd: 0.012\n---\n# v2-tuned\n";
  const { frontmatter, body } = parseFrontmatter(text);
  assert.deepEqual(frontmatter, {
    metric: "wibble",
    metric_higher_is_better: true,
    seeds: [0, 1, 2],
    mean: 0.84,
    std: 0.012,
  });
  assert.match(body, /^# v2-tuned/);
});

test("parseFrontmatter: returns null frontmatter when fences are missing", () => {
  const text = "# no frontmatter\n\nbody here";
  const { frontmatter, body } = parseFrontmatter(text);
  assert.equal(frontmatter, null);
  assert.equal(body, text);
});

test("parseResultDoc: extracts STATUS / cycles / decision", async () => {
  const text = await readFile(path.join(FIXTURE_PROJECT, "results", "v2-tuned.md"), "utf8");
  const doc = parseResultDoc(text);
  assert.equal(doc.status, "resolved");
  assert.equal(doc.frontmatter.mean, 0.84);
  assert.equal(doc.cycles.length, 1);
  assert.equal(doc.cycles[0].index, 1);
  assert.equal(doc.cycles[0].sha, "aaaaaaa");
  assert.match(doc.decision, /insert at rank 1/i);
});

test("runDoctor: clean fixture has no errors or warnings", async () => {
  const report = await runDoctor(FIXTURE_PROJECT);
  assert.equal(report.summary.error, 0);
  assert.equal(report.summary.warning, 0);
});

test("runDoctor: catches missing result-doc, status mismatch, and missing insight file", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-doctor-"));
  try {
    const project = path.join(tmp, "library", "projects", "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    await mkdir(path.join(tmp, "library", "insights"), { recursive: true });
    await copyFile(
      path.join(HERE, "fixtures", "research", "library", "insights", "widget-knob-load-bearing.md"),
      path.join(tmp, "library", "insights", "widget-knob-load-bearing.md"),
    );

    // Break the v1-baseline result by removing the file.
    await rm(path.join(project, "results", "v1-baseline.md"));

    // Break the active row by referencing v3-candidate but flipping its STATUS.
    const readmePath = path.join(project, "README.md");
    let readme = await readFile(readmePath, "utf8");
    readme = readme.replace(
      "## ACTIVE\n\n| move | result doc | branch | agent | started |\n|------|-----------|--------|-------|---------|",
      `## ACTIVE\n\n| move | result doc | branch | agent | started |\n|------|-----------|--------|-------|---------|\n| v3-candidate | [v3-candidate](results/v3-candidate.md) | [r/v3-candidate](https://github.com/example/widget-tuning/tree/r/v3-candidate) | 0 | 2026-04-28 |`,
    );
    await writeFile(readmePath, readme);

    // Make v3 candidate STATUS:resolved instead of active so the doctor flags it.
    const v3Path = path.join(project, "results", "v3-candidate.md");
    let v3 = await readFile(v3Path, "utf8");
    v3 = v3.replace("## STATUS\n\nactive", "## STATUS\n\nresolved");
    await writeFile(v3Path, v3);

    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("leaderboard_result_missing"), `expected leaderboard_result_missing in ${codes.join(",")}`);
    assert.ok(codes.includes("active_result_status"), `expected active_result_status in ${codes.join(",")}`);
    assert.ok(report.summary.error >= 2);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runAdmit: better-than-rank-1 returns admit", async () => {
  const report = await runAdmit({
    projectDir: FIXTURE_PROJECT,
    candidateResultPath: "results/v3-candidate.md",
  });
  assert.equal(report.decision.admit, true);
  assert.equal(report.decision.atRank, 1);
  assert.equal(report.verdictRows[0].comparison, "better");
});

test("runAdmit: missing frontmatter on quantitative criterion blocks admission", async () => {
  const report = await runAdmit({
    projectDir: FIXTURE_PROJECT,
    candidateResultPath: "results/v4-noisy.md",
  });
  assert.equal(report.decision.admit, false);
  assert.equal(report.decision.blocked, true);
});

test("runAdmit: within-noise vs rank 1 still admits at rank 2 if it beats rank 2", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-admit-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    // candidate mean 0.852 vs rank-1 0.84 ± 2*0.012=0.024 → within-noise of rank 1.
    // But 0.852 vs rank-2 0.72 ± 2*0.015=0.030 → clearly better than rank 2.
    await writeFile(
      path.join(project, "results", "v3-noise.md"),
      `---\nmetric: wibble\nmetric_higher_is_better: true\nseeds: [0, 1, 2]\nmean: 0.852\nstd: 0.018\n---\n# v3-noise\n\n## STATUS\n\nresolved\n`,
    );
    const report = await runAdmit({ projectDir: project, candidateResultPath: "results/v3-noise.md" });
    assert.equal(report.verdictRows[0].comparison, "within-noise");
    assert.equal(report.verdictRows[1].comparison, "better");
    assert.equal(report.decision.admit, true);
    assert.equal(report.decision.atRank, 2);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runAdmit: within-noise of every incumbent does not admit", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-admit-allnoise-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    // candidate mean 0.733 ± 0.020 → within-noise of v1-baseline (0.72 ± 0.030),
    // worse-than-noise vs v2-tuned (0.84 ± 0.024).
    await writeFile(
      path.join(project, "results", "v3-flat.md"),
      `---\nmetric: wibble\nmetric_higher_is_better: true\nseeds: [0, 1, 2]\nmean: 0.733\nstd: 0.020\n---\n# v3-flat\n\n## STATUS\n\nresolved\n`,
    );
    const report = await runAdmit({ projectDir: project, candidateResultPath: "results/v3-flat.md" });
    assert.equal(report.decision.admit, false);
    assert.equal(report.decision.blocked, false);
    assert.ok(report.verdictRows.every((r) => r.comparison !== "better"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("formatVerdict: renders verdict rows and the Decision line", async () => {
  const report = await runAdmit({
    projectDir: FIXTURE_PROJECT,
    candidateResultPath: "results/v3-candidate.md",
  });
  const text = formatVerdict(report);
  assert.match(text, /candidate: wibble=0\.91/);
  assert.match(text, /vs rank 1 \(v2-tuned\): better/);
  assert.match(text, /Decision: admit at rank 1/);
});

test("lintPaper: clean fixture passes", async () => {
  const report = await lintPaper(FIXTURE_PROJECT);
  assert.equal(report.summary.error, 0);
  assert.equal(report.summary.warning, 0);
});

test("lintPaper: flags missing figures and bare numbers without footnotes", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-lint-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, "paper.md"),
      `# bad-paper\n\n## 4. Results\n\n### v1-section\n\n![not on disk](figures/missing.png)\n\nThe wibble was 0.84 across 12 seeds.\n`,
    );
    const report = await lintPaper(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("figure_missing"), `expected figure_missing in ${codes.join(",")}`);
    assert.ok(codes.includes("results_bare_number"), `expected results_bare_number in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// benchmark.md: parser, validator, doctor, admit cross-version checks.
// ---------------------------------------------------------------------------

test("parseBenchmark: parses frontmatter, metrics, datasets, rubrics, calibration, history", async () => {
  const text = await readFile(path.join(FIXTURE_BENCHED_PROJECT, "benchmark.md"), "utf8");
  const bench = parseBenchmark(text);

  assert.equal(bench.frontmatter.version, "v1");
  assert.equal(bench.frontmatter.status, "active");
  assert.match(bench.purpose, /readability/i);

  assert.equal(bench.metrics.length, 1);
  assert.equal(bench.metrics[0].name, "readability");
  assert.equal(bench.metrics[0].kind, "rubric");
  assert.equal(bench.metrics[0].direction, "higher");
  assert.match(bench.metrics[0].computedBy, /python eval\/judge\.py/);

  assert.equal(bench.datasets.length, 2);
  assert.equal(bench.datasets[0].split, "golden");
  assert.equal(bench.datasets[1].split, "dev");

  assert.equal(bench.rubrics.length, 1);
  assert.equal(bench.rubrics[0].path, "benchmark/judge-rubric.md");

  assert.equal(bench.calibration.length, 1);
  assert.equal(bench.calibration[0].metric, "readability");

  assert.equal(bench.history.length, 1);
  assert.equal(bench.history[0].version, "v1");
});

test("validateBenchmark: clean fixture passes with no errors", async () => {
  const bench = await loadBenchmark(FIXTURE_BENCHED_PROJECT);
  const issues = await validateBenchmark(FIXTURE_BENCHED_PROJECT, bench);
  const errors = issues.filter((i) => i.severity === "error");
  assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
});

test("validateBenchmark: flags missing required sections, invalid metric kind, missing rubric file", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-bench-bad-"));
  try {
    await writeFile(
      path.join(tmp, "benchmark.md"),
      `---\nversion: v1\n---\n# bad-bench\n\n## METRICS\n\n| name | kind | direction | computed by |\n|------|------|-----------|-------------|\n| foo | banana | sideways | echo hi |\n\n## RUBRICS\n\n- [missing](benchmark/missing.md) — does not exist\n`,
    );
    const bench = await loadBenchmark(tmp);
    const issues = await validateBenchmark(tmp, bench);
    const codes = issues.map((i) => i.code);
    assert.ok(codes.includes("benchmark_missing_section"), `expected benchmark_missing_section in ${codes.join(",")}`);
    assert.ok(codes.includes("benchmark_metric_kind"), `expected benchmark_metric_kind in ${codes.join(",")}`);
    assert.ok(codes.includes("benchmark_metric_direction"), `expected benchmark_metric_direction in ${codes.join(",")}`);
    assert.ok(codes.includes("benchmark_rubric_missing_file"), `expected benchmark_rubric_missing_file in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("validateBenchmark: rubric/judge metrics without calibration row are flagged", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-bench-cal-"));
  try {
    await writeFile(
      path.join(tmp, "benchmark.md"),
      `---\nversion: v1\nlast_updated: 2026-04-28\n---\n# x\n\n## PURPOSE\n\nfoo\n\n## METRICS\n\n| name | kind | direction | computed by |\n|------|------|-----------|-------------|\n| readability | rubric | higher | echo |\n\n## DATASETS\n\n| split | path | size | provenance |\n|------|------|------|-----|\n\n## RUBRICS\n\n## CALIBRATION\n\n## CONTAMINATION CHECKS\n\n## HISTORY\n\n| version | date | change | reason | superseded |\n|---|---|---|---|---|\n| v1 | 2026-04-28 | initial | first cut | - |\n`,
    );
    const bench = await loadBenchmark(tmp);
    const issues = await validateBenchmark(tmp, bench);
    const codes = issues.map((i) => i.code);
    assert.ok(codes.includes("benchmark_metric_no_calibration"), `expected benchmark_metric_no_calibration in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: clean qualitative fixture with benchmark.md has no errors", async () => {
  const report = await runDoctor(FIXTURE_BENCHED_PROJECT);
  const errors = report.issues.filter((i) => i.severity === "error");
  assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
});

test("runDoctor: qualitative project without benchmark.md errors", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-doctor-noBench-"));
  try {
    await writeFile(
      path.join(tmp, "README.md"),
      `# x\n\n## GOAL\n\ntest\n\n## CODE REPO\n\nhttps://example.com\n\n## SUCCESS CRITERIA\n\n- foo\n\n## RANKING CRITERION\n\n\`qualitative: prose quality\`\n\n## LEADERBOARD\n\n| rank | result | branch | commit | score |\n|------|--------|--------|--------|-------|\n\n## INSIGHTS\n\n## ACTIVE\n\n| move | result doc | branch | agent | started |\n|------|-----------|--------|-------|---------|\n\n## QUEUE\n\n| move | starting-point | why |\n|------|----------------|-----|\n\n## LOG\n\n| date | event | slug or ref | one-line summary | link |\n|------|-------|-------------|-------------------|------|\n`,
    );
    const report = await runDoctor(tmp);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("benchmark_required"), `expected benchmark_required in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: result doc missing benchmark_version when bench exists -> error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-doctor-badResult-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    // Strip benchmark_version from v1-baseline.
    const v1Path = path.join(project, "results", "v1-baseline.md");
    let v1 = await readFile(v1Path, "utf8");
    v1 = v1.replace("benchmark_version: v1\n", "");
    await writeFile(v1Path, v1);
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("result_missing_benchmark_version"), `expected result_missing_benchmark_version in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: result doc citing unknown benchmark version -> warning", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-doctor-unknownVersion-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    const v1Path = path.join(project, "results", "v1-baseline.md");
    let v1 = await readFile(v1Path, "utf8");
    v1 = v1.replace("benchmark_version: v1", "benchmark_version: v999");
    await writeFile(v1Path, v1);
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("result_unknown_benchmark_version"), `expected result_unknown_benchmark_version in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: result doc citing stale (older) bench version -> info", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-doctor-staleVersion-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    // Bump benchmark to v2 with v1 in history.
    const benchPath = path.join(project, "benchmark.md");
    let bench = await readFile(benchPath, "utf8");
    bench = bench.replace("version: v1", "version: v2");
    bench = bench.replace(
      "| v1 | 2026-04-27 | initial | first cut | - |",
      "| v2 | 2026-04-28 | tightened rubric | clarity dim collapsed two levels | - |\n| v1 | 2026-04-27 | initial | first cut | v2 |",
    );
    await writeFile(benchPath, bench);
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("result_stale_benchmark_version"), `expected result_stale_benchmark_version in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runAdmit: cross-version comparison is blocked by default", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-admit-crossVer-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    // Bump bench to v2.
    const benchPath = path.join(project, "benchmark.md");
    let bench = await readFile(benchPath, "utf8");
    bench = bench.replace("version: v1", "version: v2");
    bench = bench.replace(
      "| v1 | 2026-04-27 | initial | first cut | - |",
      "| v2 | 2026-04-28 | tightened rubric | second cut | - |\n| v1 | 2026-04-27 | initial | first cut | v2 |",
    );
    await writeFile(benchPath, bench);
    // Add a candidate citing v2 — incumbents are still on v1.
    await writeFile(
      path.join(project, "results", "v3-candidate.md"),
      `---\nmetric: readability\nbenchmark_version: v2\n---\n# v3-candidate\n\n## STATUS\n\nresolved\n`,
    );
    const report = await runAdmit({ projectDir: project, candidateResultPath: "results/v3-candidate.md" });
    assert.equal(report.decision.admit, false);
    assert.equal(report.decision.blocked, true);
    assert.match(report.decision.reason, /cross-version|benchmark_version/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runAdmit: --allow-cross-version unblocks cross-version comparison", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-admit-allowCross-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    const benchPath = path.join(project, "benchmark.md");
    let bench = await readFile(benchPath, "utf8");
    bench = bench.replace("version: v1", "version: v2");
    bench = bench.replace(
      "| v1 | 2026-04-27 | initial | first cut | - |",
      "| v2 | 2026-04-28 | tightened rubric | second cut | - |\n| v1 | 2026-04-27 | initial | first cut | v2 |",
    );
    await writeFile(benchPath, bench);
    await writeFile(
      path.join(project, "results", "v3-candidate.md"),
      `---\nmetric: readability\nbenchmark_version: v2\n---\n# v3-candidate\n\n## STATUS\n\nresolved\n`,
    );
    const report = await runAdmit({
      projectDir: project,
      candidateResultPath: "results/v3-candidate.md",
      allowCrossVersion: true,
    });
    // Qualitative criterion → manual verdicts; not blocked.
    assert.notEqual(report.decision.blocked, true);
    assert.ok(report.verdictRows.every((r) => r.comparison !== "cross-version"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runAdmit: candidate missing benchmark_version (project has bench) -> blocked", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-admit-missingVer-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    await writeFile(
      path.join(project, "results", "v3-candidate.md"),
      `---\nmetric: readability\n---\n# v3-candidate\n\n## STATUS\n\nresolved\n`,
    );
    const report = await runAdmit({ projectDir: project, candidateResultPath: "results/v3-candidate.md" });
    assert.equal(report.decision.blocked, true);
    assert.match(report.decision.reason, /benchmark_version/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runAdmit: quantitative project without bench still works (back-compat)", async () => {
  const report = await runAdmit({
    projectDir: FIXTURE_PROJECT,
    candidateResultPath: "results/v3-candidate.md",
  });
  assert.equal(report.decision.admit, true);
  assert.equal(report.decision.atRank, 1);
});

test("runDoctor: result doc citing metric not in METRICS -> error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-doctor-badMetric-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    const v1Path = path.join(project, "results", "v1-baseline.md");
    let v1 = await readFile(v1Path, "utf8");
    v1 = v1.replace("metric: readability", "metric: reaadability"); // typo
    await writeFile(v1Path, v1);
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("result_metric_unknown"), `expected result_metric_unknown in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: frozen benchmark with ACTIVE rows -> error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-doctor-frozen-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    // Freeze the bench.
    const benchPath = path.join(project, "benchmark.md");
    const bench = (await readFile(benchPath, "utf8")).replace("status: active", "status: frozen");
    await writeFile(benchPath, bench);
    // Add an active row + active result doc.
    const readmePath = path.join(project, "README.md");
    let readme = await readFile(readmePath, "utf8");
    readme = readme.replace(
      "## ACTIVE\n\n| move | result doc | branch | agent | started |\n|------|-----------|--------|-------|---------|",
      "## ACTIVE\n\n| move | result doc | branch | agent | started |\n|------|-----------|--------|-------|---------|\n| v3-fewshot | [v3-fewshot](results/v3-fewshot.md) | [r/v3-fewshot](https://github.com/example/prose-style/tree/r/v3-fewshot) | 0 | 2026-04-28 |",
    );
    await writeFile(readmePath, readme);
    await writeFile(
      path.join(project, "results", "v3-fewshot.md"),
      `---\nmetric: readability\nbenchmark_version: v1\n---\n# v3-fewshot\n\n## STATUS\n\nactive\n`,
    );
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("benchmark_frozen_with_active_moves"), `expected benchmark_frozen_with_active_moves in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runAdmit: legacy incumbent (no benchmark_version) blocks admission", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-admit-legacy-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    // Strip benchmark_version from incumbent (rank 1).
    const v2Path = path.join(project, "results", "v2-scaffold.md");
    let v2 = await readFile(v2Path, "utf8");
    v2 = v2.replace("benchmark_version: v1\n", "");
    await writeFile(v2Path, v2);
    // Add a candidate with valid version.
    await writeFile(
      path.join(project, "results", "v3-candidate.md"),
      `---\nmetric: readability\nbenchmark_version: v1\n---\n# v3-candidate\n\n## STATUS\n\nresolved\n`,
    );
    const report = await runAdmit({ projectDir: project, candidateResultPath: "results/v3-candidate.md" });
    assert.equal(report.decision.blocked, true);
    assert.match(report.decision.reason, /legacy|no benchmark_version/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runAdmit: candidate metric not in METRICS blocks admission", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-admit-badMetric-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    await writeFile(
      path.join(project, "results", "v3-candidate.md"),
      `---\nmetric: clarity\nbenchmark_version: v1\n---\n# v3-candidate\n\n## STATUS\n\nresolved\n`,
    );
    const report = await runAdmit({ projectDir: project, candidateResultPath: "results/v3-candidate.md" });
    assert.equal(report.decision.blocked, true);
    assert.match(report.decision.reason, /not declared in benchmark\.md METRICS|metric=/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runAdmit: frozen bench blocks admission entirely", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-admit-frozen-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    const benchPath = path.join(project, "benchmark.md");
    const bench = (await readFile(benchPath, "utf8")).replace("status: active", "status: frozen");
    await writeFile(benchPath, bench);
    await writeFile(
      path.join(project, "results", "v3-candidate.md"),
      `---\nmetric: readability\nbenchmark_version: v1\n---\n# v3-candidate\n\n## STATUS\n\nresolved\n`,
    );
    const report = await runAdmit({ projectDir: project, candidateResultPath: "results/v3-candidate.md" });
    assert.equal(report.decision.blocked, true);
    assert.match(report.decision.reason, /frozen/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("validateBenchmark: numeric YAML version (status: active) is treated as a string", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-bench-numericVer-"));
  try {
    await writeFile(
      path.join(tmp, "benchmark.md"),
      `---\nversion: 2\nlast_updated: 2026-04-28\nstatus: active\n---\n# x\n\n## PURPOSE\n\nfoo\n\n## METRICS\n\n| name | kind | direction | computed by |\n|------|------|-----------|-------------|\n| acc | numeric | higher | echo hi |\n\n## DATASETS\n\n| split | path | size | provenance |\n|------|------|------|-----|\n\n## RUBRICS\n\n## CALIBRATION\n\n## CONTAMINATION CHECKS\n\n## HISTORY\n\n| version | date | change | reason | superseded |\n|---|---|---|---|---|\n| 2 | 2026-04-28 | initial | first | - |\n`,
    );
    const bench = await loadBenchmark(tmp);
    const issues = await validateBenchmark(tmp, bench);
    const errorCodes = issues.filter((i) => i.severity === "error").map((i) => i.code);
    assert.ok(!errorCodes.includes("benchmark_missing_version"), `did not expect benchmark_missing_version when YAML coerced numeric: ${errorCodes.join(",")}`);
    assert.ok(!errorCodes.includes("benchmark_history_missing_current"), `numeric version should match history: ${errorCodes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("validateBenchmark: active bench without rubric calibration -> error (was warning)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-bench-activeCal-"));
  try {
    await writeFile(
      path.join(tmp, "benchmark.md"),
      `---\nversion: v1\nlast_updated: 2026-04-28\nstatus: active\n---\n# x\n\n## PURPOSE\n\nfoo\n\n## METRICS\n\n| name | kind | direction | computed by |\n|------|------|-----------|-------------|\n| readability | rubric | higher | echo |\n\n## DATASETS\n\n## RUBRICS\n\n## CALIBRATION\n\n## CONTAMINATION CHECKS\n\n## HISTORY\n\n| version | date | change | reason | superseded |\n|---|---|---|---|---|\n| v1 | 2026-04-28 | initial | first | - |\n`,
    );
    const bench = await loadBenchmark(tmp);
    const issues = await validateBenchmark(tmp, bench);
    const calibration = issues.find((i) => i.code === "benchmark_metric_no_calibration");
    assert.ok(calibration, "expected benchmark_metric_no_calibration");
    assert.equal(calibration.severity, "error", "active bench should error, not warn");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("validateBenchmark: draft bench without calibration is warning, not error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-bench-draftCal-"));
  try {
    await writeFile(
      path.join(tmp, "benchmark.md"),
      `---\nversion: v1\nlast_updated: 2026-04-28\nstatus: draft\n---\n# x\n\n## PURPOSE\n\nfoo\n\n## METRICS\n\n| name | kind | direction | computed by |\n|------|------|-----------|-------------|\n| readability | rubric | higher | echo |\n\n## DATASETS\n\n## RUBRICS\n\n## CALIBRATION\n\n## CONTAMINATION CHECKS\n\n## HISTORY\n\n| version | date | change | reason | superseded |\n|---|---|---|---|---|\n| v1 | 2026-04-28 | initial | first | - |\n`,
    );
    const bench = await loadBenchmark(tmp);
    const issues = await validateBenchmark(tmp, bench);
    const calibration = issues.find((i) => i.code === "benchmark_metric_no_calibration");
    assert.ok(calibration, "expected benchmark_metric_no_calibration");
    assert.equal(calibration.severity, "warning", "draft bench should warn, not error");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// bench cycle kind: parsing, admit carve-out, doctor check
// ---------------------------------------------------------------------------

test("parseResultDoc: cycle kinds parse (change default, rerun, analysis, bench)", () => {
  const text = `# foo

## STATUS

resolved

## Cycles

- \`cycle 1 @aaaaaaa: baseline -> 0.72.\`
- \`cycle 2 @bbbbbbb rerun: same config more seeds -> 0.74 std=0.01.\`
- \`cycle 3 @ccccccc analysis: per-class breakdown -> classes 3,7,9 fail.\`
- \`cycle 4 @ddddddd bench: bumped rubric to v2 -> readability rubric tightened.\`
`;
  const doc = parseResultDoc(text);
  assert.equal(doc.cycles.length, 4);
  assert.equal(doc.cycles[0].kind, "change", "default kind is change");
  assert.equal(doc.cycles[1].kind, "rerun");
  assert.equal(doc.cycles[2].kind, "analysis");
  assert.equal(doc.cycles[3].kind, "bench");
  assert.equal(doc.isBenchMove, true);
});

test("parseResultDoc: result doc without bench cycles is not flagged as bench move", () => {
  const text = `# foo

## STATUS

resolved

## Cycles

- \`cycle 1 @aaaaaaa: baseline -> 0.72.\`
- \`cycle 2 @bbbbbbb rerun: more seeds -> 0.73.\`
`;
  const doc = parseResultDoc(text);
  assert.equal(doc.isBenchMove, false);
});

test("runAdmit: bench-move result doc returns clean bench-bump verdict (no leaderboard touch)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-admit-bench-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    await writeFile(
      path.join(project, "results", "v3-bench-v2.md"),
      `---\nmetric: readability\nbenchmark_version: v1\n---\n# v3-bench-v2\n\n## STATUS\n\nresolved\n\n## Cycles\n\n- \`cycle 1 @ddddddd bench: tighten rubric to v2 -> rubric.md updated.\`\n`,
    );
    const report = await runAdmit({ projectDir: project, candidateResultPath: "results/v3-bench-v2.md" });
    assert.equal(report.decision.admit, false);
    assert.equal(report.decision.blocked, false);
    assert.equal(report.decision.bench, true);
    assert.match(report.decision.reason, /bench-bump|coverage and rater agreement/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("formatVerdict: bench-bump decision prints clean bench-bump line", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-format-bench-bump-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    await writeFile(
      path.join(project, "results", "v3-bench-v2.md"),
      `---\nmetric: readability\nbenchmark_version: v1\n---\n# v3-bench-v2\n\n## STATUS\n\nresolved\n\n## Cycles\n\n- \`cycle 1 @ddddddd bench: bumped rubric -> v2.\`\n`,
    );
    const report = await runAdmit({ projectDir: project, candidateResultPath: "results/v3-bench-v2.md" });
    const text = formatVerdict(report);
    assert.match(text, /Decision: bench-bump \(no leaderboard admission\)/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: bench move whose benchmark_version doesn't match current bench -> error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-doctor-benchMismatch-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    // Bump bench to v2.
    const benchPath = path.join(project, "benchmark.md");
    let bench = await readFile(benchPath, "utf8");
    bench = bench.replace("version: v1", "version: v2");
    bench = bench.replace(
      "| v1 | 2026-04-27 | initial | first cut | - |",
      "| v2 | 2026-04-28 | tightened rubric | second cut | - |\n| v1 | 2026-04-27 | initial | first cut | v2 |",
    );
    await writeFile(benchPath, bench);
    // A bench move whose result doc still cites v1 (the old version) — it
    // should have cited v2 since its purpose was to install v2.
    const readmePath = path.join(project, "README.md");
    let readme = await readFile(readmePath, "utf8");
    readme = readme.replace(
      "## ACTIVE\n\n| move | result doc | branch | agent | started |\n|------|-----------|--------|-------|---------|",
      "## ACTIVE\n\n| move | result doc | branch | agent | started |\n|------|-----------|--------|-------|---------|\n| v3-bench | [v3-bench](results/v3-bench.md) | [r/v3-bench](https://github.com/example/prose-style/tree/r/v3-bench) | 0 | 2026-04-28 |",
    );
    await writeFile(readmePath, readme);
    await writeFile(
      path.join(project, "results", "v3-bench.md"),
      `---\nmetric: readability\nbenchmark_version: v1\n---\n# v3-bench\n\n## STATUS\n\nactive\n\n## Cycles\n\n- \`cycle 1 @ddddddd bench: tightened rubric.\`\n`,
    );
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("bench_move_version_mismatch"), `expected bench_move_version_mismatch in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

test("formatVerdict: includes benchmark line when project has bench", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-format-bench-"));
  try {
    const project = path.join(tmp, "prose-style");
    await copyDir(FIXTURE_BENCHED_PROJECT, project);
    await writeFile(
      path.join(project, "results", "v3-candidate.md"),
      `---\nmetric: readability\nbenchmark_version: v1\n---\n# v3-candidate\n\n## STATUS\n\nresolved\n`,
    );
    const report = await runAdmit({ projectDir: project, candidateResultPath: "results/v3-candidate.md" });
    const text = formatVerdict(report);
    assert.match(text, /benchmark: v1/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// runs.tsv validation — sweep-runner artifact integrity from the doctor's
// perspective. The doctor walks projects/<name>/runs.tsv and
// projects/<name>/runs/<slug>.tsv so a stale "running" row, a malformed
// config JSON, or a runs.tsv with missing columns surfaces up to the loop
// rather than silently corrupting the leaderboard.

const RUNS_HEADER = [
  "started_at", "group", "name", "commit", "hypothesis",
  "mean_return", "std_return", "wandb_url", "status", "config",
].join("\t");

function runsRow({ started_at = "", group = "g", name = "g-cell-seed0", commit = "abc1234", hypothesis = "h", mean_return = "", std_return = "", wandb_url = "", status = "planned", config = "{}" } = {}) {
  return [started_at, group, name, commit, hypothesis, mean_return, std_return, wandb_url, status, config].join("\t");
}

test("runDoctor: clean runs.tsv (status=done) produces no new issues", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-runs-clean-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    const tsv = `${RUNS_HEADER}\n${runsRow({
      started_at: new Date().toISOString(),
      status: "done",
      mean_return: "0.81",
      wandb_url: "https://wandb.ai/me/proj/runs/abc123",
    })}\n`;
    await writeFile(path.join(project, "runs.tsv"), tsv);
    const report = await runDoctor(project);
    const newCodes = report.issues.map((i) => i.code).filter((c) => c.startsWith("runs_"));
    assert.deepEqual(newCodes, [], `expected no runs_* issues, got: ${newCodes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: stale 'running' row + no ACTIVE row -> two warnings", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-runs-stale-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    // Clear the fixture's ACTIVE row so the runs_running_without_active
    // warning has nothing to match against.
    const readmePath = path.join(project, "README.md");
    let readme = await readFile(readmePath, "utf8");
    readme = readme.replace(
      /(\n## ACTIVE\n\n\| move \| result doc \| branch \| agent \| started \|\n\|------\|-----------\|--------\|-------\|---------\|)\n\| v3-candidate \|[^\n]+\|\n/,
      "$1\n",
    );
    await writeFile(readmePath, readme);
    // 48h ago = stale.
    const staleIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const tsv = `${RUNS_HEADER}\n${runsRow({
      started_at: staleIso,
      status: "running",
    })}\n`;
    await writeFile(path.join(project, "runs.tsv"), tsv);
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("runs_stale_running"),
      `expected runs_stale_running in ${codes.join(",")}`);
    assert.ok(codes.includes("runs_running_without_active"),
      `expected runs_running_without_active in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: bad JSON in config column -> runs_config_unparseable error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-runs-cfg-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    const tsv = `${RUNS_HEADER}\n${runsRow({
      status: "done",
      mean_return: "0.5",
      config: "{not json",
    })}\n`;
    await writeFile(path.join(project, "runs.tsv"), tsv);
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("runs_config_unparseable"),
      `expected runs_config_unparseable in ${codes.join(",")}`);
    assert.ok(report.summary.error >= 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: runs.tsv missing required columns -> runs_missing_columns error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-runs-cols-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    // Drop status + config.
    const reducedHeader = ["started_at", "group", "name", "commit", "hypothesis", "mean_return", "std_return", "wandb_url"].join("\t");
    const reducedRow = ["2026-04-28T00:00:00Z", "g", "g-cell-seed0", "abc", "h", "", "", ""].join("\t");
    const tsv = `${reducedHeader}\n${reducedRow}\n`;
    await writeFile(path.join(project, "runs.tsv"), tsv);
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("runs_missing_columns"),
      `expected runs_missing_columns in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: walks runs/<slug>.tsv subdirectory too", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-runs-sub-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    await mkdir(path.join(project, "runs"), { recursive: true });
    const staleIso = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    const tsv = `${RUNS_HEADER}\n${runsRow({
      started_at: staleIso,
      status: "running",
      name: "ablate-foo-cell-seed0",
    })}\n`;
    await writeFile(path.join(project, "runs", "ablate-foo.tsv"), tsv);
    const report = await runDoctor(project);
    const stale = report.issues.find((i) => i.code === "runs_stale_running");
    assert.ok(stale, "expected runs_stale_running issue");
    assert.match(stale.where, /runs\/ablate-foo\.tsv/,
      `expected 'where' to mention runs/ablate-foo.tsv, got: ${stale.where}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: bad wandb_url shape -> runs_bad_wandb_url warning", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-runs-wb-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    const tsv = `${RUNS_HEADER}\n${runsRow({
      started_at: new Date().toISOString(),
      status: "done",
      mean_return: "0.5",
      wandb_url: "https://example.com/not-wandb/run/123",
    })}\n`;
    await writeFile(path.join(project, "runs.tsv"), tsv);
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("runs_bad_wandb_url"),
      `expected runs_bad_wandb_url in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// orphan result-doc check — result docs that exist on disk but aren't
// referenced by any README section. Catches the bug class "agent
// finished a move but forgot to update LEADERBOARD/LOG."

test("runDoctor: STATUS:resolved result doc with no LEADERBOARD/LOG entry -> result_doc_orphan warning", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-orphan-resolved-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    // Drop the v4-noisy LOG row so the v4-noisy doc becomes orphaned.
    const readmePath = path.join(project, "README.md");
    let readme = await readFile(readmePath, "utf8");
    readme = readme.replace(/\n\| 2026-04-28 \| resolved \| v4-noisy \|[^\n]+\|/, "");
    await writeFile(readmePath, readme);
    const report = await runDoctor(project);
    const orphan = report.issues.find((i) => i.code === "result_doc_orphan");
    assert.ok(orphan, `expected result_doc_orphan in ${report.issues.map((i) => i.code).join(",")}`);
    assert.match(orphan.where, /v4-noisy/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: STATUS:active result doc with no ACTIVE row -> result_doc_active_unclaimed warning", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-active-unclaimed-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    // Drop the v3-candidate ACTIVE row so the active v3-candidate doc orphans.
    const readmePath = path.join(project, "README.md");
    let readme = await readFile(readmePath, "utf8");
    readme = readme.replace(/\n\| v3-candidate \|[^\n]+\|/, "");
    await writeFile(readmePath, readme);
    const report = await runDoctor(project);
    const orphan = report.issues.find((i) => i.code === "result_doc_active_unclaimed");
    assert.ok(orphan, `expected result_doc_active_unclaimed in ${report.issues.map((i) => i.code).join(",")}`);
    assert.match(orphan.where, /v3-candidate/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: STATUS:resolved doc whose slug is in LEADERBOARD only (no LOG row) -> no orphan", async () => {
  // The fixture has v2-tuned in LEADERBOARD AND LOG. Remove the LOG row
  // and confirm that LEADERBOARD presence alone is sufficient.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-orphan-leaderboard-only-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    const readmePath = path.join(project, "README.md");
    let readme = await readFile(readmePath, "utf8");
    readme = readme.replace(/\n\| 2026-04-28 \| resolved\+admitted \| v2-tuned \|[^\n]+\|/, "");
    await writeFile(readmePath, readme);
    const report = await runDoctor(project);
    const orphans = report.issues.filter((i) =>
      i.code === "result_doc_orphan" && i.where.includes("v2-tuned")
    );
    assert.equal(orphans.length, 0, "v2-tuned should not be flagged — leaderboard reference is sufficient");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: result doc with empty/missing STATUS -> no orphan flag (different bug class)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-orphan-noStatus-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    // Write a brand new result doc with no STATUS section, no README ref.
    await writeFile(path.join(project, "results", "ghost.md"), "# ghost\n\nno status here.\n");
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code).filter((c) =>
      (c === "result_doc_orphan" || c === "result_doc_active_unclaimed")
    );
    // Either codes empty (preferred) or doesn't include ghost — verify ghost specifically isn't flagged.
    const ghostFlagged = report.issues.some((i) =>
      (i.code === "result_doc_orphan" || i.code === "result_doc_active_unclaimed")
      && i.where.includes("ghost")
    );
    assert.equal(ghostFlagged, false, "missing STATUS is a separate bug class — should not orphan");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// stale-ACTIVE check — CLAUDE.md says ACTIVE rows older than 7 days should
// be treated as abandoned and surfaced for cleanup. Doctor warns so the
// loop's stale-recovery procedure kicks in.

async function activeFixture(tmp, startedDate) {
  const project = path.join(tmp, "widget-tuning");
  await copyDir(FIXTURE_PROJECT, project);

  // Add an ACTIVE row + matching active result doc.
  const readmePath = path.join(project, "README.md");
  let readme = await readFile(readmePath, "utf8");
  readme = readme.replace(
    "## ACTIVE\n\n| move | result doc | branch | agent | started |\n|------|-----------|--------|-------|---------|",
    `## ACTIVE\n\n| move | result doc | branch | agent | started |\n|------|-----------|--------|-------|---------|\n| v3-candidate | [v3-candidate](results/v3-candidate.md) | [r/v3-candidate](https://github.com/example/widget-tuning/tree/r/v3-candidate) | 0 | ${startedDate} |`,
  );
  await writeFile(readmePath, readme);
  return project;
}

test("runDoctor: ACTIVE row started >7 days ago -> active_stale_row warning", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-active-stale-"));
  try {
    // Pick a date 10 days before today.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const project = await activeFixture(tmp, tenDaysAgo);
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("active_stale_row"),
      `expected active_stale_row, got: ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: ACTIVE row started recently -> no active_stale_row", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-active-fresh-"));
  try {
    const today = new Date().toISOString().slice(0, 10);
    const project = await activeFixture(tmp, today);
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.equal(codes.includes("active_stale_row"), false,
      `unexpected active_stale_row in ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: ACTIVE row with empty/malformed `started` -> no active_stale_row (different bug class)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-active-malformed-"));
  try {
    const project = await activeFixture(tmp, "not-a-date");
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.equal(codes.includes("active_stale_row"), false,
      "stale-row check should ignore unparseable dates");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// kickoff.json validation — the agent re-reads kickoff.json on every loop
// entry. If it's missing-when-expected, malformed, or points at a repo
// that no longer exists, the doctor surfaces it before the agent runs blind.

async function installSkillStub(projectDir) {
  const skillDir = path.join(projectDir, ".claude", "skills", "rl-sweep-tuner");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "stub\n");
}

test("runDoctor: no kickoff.json + no skill = no kickoff issues", async () => {
  // The vanilla fixture has no kickoff.json and no skill installed —
  // shouldn't be flagged. Acts as a regression check.
  const report = await runDoctor(FIXTURE_PROJECT);
  const codes = report.issues.map((i) => i.code).filter((c) => c.startsWith("kickoff_"));
  assert.deepEqual(codes, []);
});

test("runDoctor: skill installed but kickoff.json missing -> kickoff_missing warning", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-kickoff-noJson-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    await installSkillStub(project);
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("kickoff_missing"),
      `expected kickoff_missing, got: ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: kickoff.json with invalid JSON -> kickoff_unparseable error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-kickoff-bad-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    await writeFile(path.join(project, "kickoff.json"), "{not json");
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("kickoff_unparseable"),
      `expected kickoff_unparseable, got: ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: kickoff.json missing goal -> kickoff_missing_goal error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-kickoff-noGoal-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    await writeFile(path.join(project, "kickoff.json"),
      JSON.stringify({ repo: tmp, library: "/x", projectDir: project }));
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("kickoff_missing_goal"),
      `expected kickoff_missing_goal, got: ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: kickoff.json missing repo -> kickoff_missing_repo error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-kickoff-noRepo-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    await writeFile(path.join(project, "kickoff.json"),
      JSON.stringify({ goal: "x", library: "/x" }));
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("kickoff_missing_repo"),
      `expected kickoff_missing_repo, got: ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: kickoff.json repo path doesn't exist -> kickoff_repo_missing warning", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-kickoff-noRepoPath-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    await writeFile(path.join(project, "kickoff.json"),
      JSON.stringify({ goal: "x", repo: "/nonexistent/path/here-please" }));
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("kickoff_repo_missing"),
      `expected kickoff_repo_missing, got: ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: valid kickoff.json with existing repo path -> no kickoff_* issues", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-doctor-kickoff-ok-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await copyDir(FIXTURE_PROJECT, project);
    // Use the project dir itself as a stand-in for an "existing repo".
    await writeFile(path.join(project, "kickoff.json"),
      JSON.stringify({ goal: "find best LR", repo: project, library: tmp }));
    const report = await runDoctor(project);
    const codes = report.issues.map((i) => i.code).filter((c) => c.startsWith("kickoff_"));
    assert.deepEqual(codes, [], `expected no kickoff_* issues, got: ${codes.join(",")}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

test("lintPaper: flags non-slug-prefixed footnote IDs and missing definitions", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-lint-fn-"));
  try {
    const project = path.join(tmp, "widget-tuning");
    await mkdir(path.join(project, "figures"), { recursive: true });
    await writeFile(path.join(project, "figures", "x.png"), "");
    await writeFile(
      path.join(project, "paper.md"),
      `# foo\n\n## 4. Results\n\n### sub\n\n![ok](figures/x.png)\n\nClaim[^c1] here[^undefined-id].\n\n[^c1]: https://example.com/commit/abc · cmd · path\n`,
    );
    const report = await lintPaper(project);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("footnote_id_not_slug_prefixed"));
    assert.ok(codes.includes("footnote_reference_undefined"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
