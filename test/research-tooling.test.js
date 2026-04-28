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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(
  HERE,
  "fixtures",
  "research",
  "library",
  "projects",
  "widget-tuning",
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
