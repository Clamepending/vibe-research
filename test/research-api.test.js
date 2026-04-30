import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listProjects, getProjectDetail } from "../src/research-api.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_LIBRARY = path.join(HERE, "fixtures", "research", "library");

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

test("listProjects: discovers projects under library/projects/ with summary fields", async () => {
  const projects = await listProjects(FIXTURE_LIBRARY);
  const names = projects.map((p) => p.name).sort();
  assert.deepEqual(names, ["prose-style", "widget-tuning"]);

  const widget = projects.find((p) => p.name === "widget-tuning");
  assert.equal(widget.criterionKind, "quantitative");
  assert.equal(widget.leaderboardSize, 2);
  assert.equal(widget.queueSize, 1);
  assert.equal(widget.activeCount, 1); // v3-candidate is in flight
  assert.equal(widget.hasBenchmark, false);

  const prose = projects.find((p) => p.name === "prose-style");
  assert.equal(prose.criterionKind, "qualitative");
  assert.equal(prose.hasBenchmark, true);
  assert.equal(prose.benchmarkVersion, "v1");
  assert.equal(prose.benchmarkStatus, "active");
});

test("listProjects: returns empty array when library has no projects/ directory", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-api-noproj-"));
  try {
    const projects = await listProjects(tmp);
    assert.deepEqual(projects, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("listProjects: skips directories without README.md", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-api-noreadme-"));
  try {
    await mkdir(path.join(tmp, "projects", "no-readme"), { recursive: true });
    await writeFile(path.join(tmp, "projects", "no-readme", "other.md"), "# noop\n");
    const projects = await listProjects(tmp);
    assert.deepEqual(projects, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("listProjects: tolerates malformed README without crashing", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-api-bad-"));
  try {
    await mkdir(path.join(tmp, "projects", "ok"), { recursive: true });
    await writeFile(
      path.join(tmp, "projects", "ok", "README.md"),
      `# ok\n\n## GOAL\n\nfoo\n\n## CODE REPO\n\nhttps://x\n\n## SUCCESS CRITERIA\n\n- bar\n\n## RANKING CRITERION\n\n\`quantitative: f (higher is better)\`\n\n## LEADERBOARD\n\n| rank | result | branch | commit | score |\n|------|--------|--------|--------|-------|\n\n## INSIGHTS\n\n## ACTIVE\n\n| move | result doc | branch | agent | started |\n|------|-----------|--------|-------|---------|\n\n## QUEUE\n\n| move | starting-point | why |\n|------|----------------|-----|\n\n## LOG\n\n| date | event | slug or ref | one-line summary | link |\n|------|-------|-------------|-------------------|------|\n`,
    );
    // Sibling project with truly malformed content: not even a README header.
    await mkdir(path.join(tmp, "projects", "broken"), { recursive: true });
    await writeFile(path.join(tmp, "projects", "broken", "README.md"), "");
    const projects = await listProjects(tmp);
    const names = projects.map((p) => p.name);
    assert.ok(names.includes("ok"), "expected ok project");
    // Empty README still parses (returns empty fields), so it's allowed —
    // just confirm we didn't crash.
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("getProjectDetail: returns full structured state for clean qualitative project", async () => {
  const detail = await getProjectDetail(FIXTURE_LIBRARY, "prose-style");
  assert.ok(detail, "expected non-null detail");
  assert.equal(detail.name, "prose-style");
  assert.equal(detail.rankingCriterion.kind, "qualitative");

  assert.equal(detail.leaderboard.length, 2);
  assert.equal(detail.leaderboard[0].slug, "v2-scaffold");

  assert.ok(detail.benchmark, "expected benchmark");
  assert.equal(detail.benchmark.version, "v1");
  assert.equal(detail.benchmark.metrics.length, 1);
  assert.equal(detail.benchmark.metrics[0].name, "readability");

  assert.equal(detail.resultDocs.length, 2);
  const v2 = detail.resultDocs.find((d) => d.slug === "v2-scaffold");
  assert.ok(v2);
  assert.equal(v2.status, "resolved");
  assert.match(v2.takeaway, /readability|3\.4|4\.1/);

  assert.equal(detail.sweeps.length, 1);
  assert.equal(detail.sweeps[0].name, "top-level");
  assert.equal(detail.sweeps[0].rows, 3);
  assert.equal(detail.sweeps[0].cells, 2);
  assert.equal(detail.sweeps[0].statusCounts.done, 2);
  assert.equal(detail.sweeps[0].statusCounts.planned, 1);
  assert.equal(detail.sweeps[0].bestMean, 4.1);

  assert.equal(detail.doctor.bucket, "ok");
  assert.equal(detail.doctor.counts.error, 0);

  assert.equal(detail.paths.benchmark, "benchmark.md");
  assert.equal(detail.paths.figures, "figures");
});

test("getProjectDetail: includes resolved docs that are only linked from LOG", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-api-log-docs-"));
  try {
    const project = path.join(tmp, "projects", "log-only");
    await mkdir(path.join(project, "results"), { recursive: true });
    await writeFile(
      path.join(project, "README.md"),
      `# log-only

## GOAL

Keep negative and non-admitted research results visible to reviewers.

## CODE REPO

https://github.com/example/log-only

## SUCCESS CRITERIA

- resolved result docs appear in the dashboard

## RANKING CRITERION

qualitative: reviewability

## LEADERBOARD

| rank | result | branch | commit | score / verdict |
|------|--------|--------|--------|-----------------|

## INSIGHTS

_no insights yet — review mode crystallizes these from across moves._

## ACTIVE

| move | result doc | branch | agent | started |
|------|------------|--------|-------|---------|

## QUEUE

| move | starting-point | why |
|------|----------------|-----|

## LOG

See [LOG.md](./LOG.md) — append-only event history.
`,
    );
    await writeFile(
      path.join(project, "LOG.md"),
      `# log-only — LOG

| date | event | slug or ref | one-line summary | link |
|------|-------|-------------|------------------|------|
| 2026-04-30 | resolved | session-linked-card | session link canary resolved | [session-linked-card.md](results/session-linked-card.md) |
`,
    );
    await writeFile(
      path.join(project, "results", "session-linked-card.md"),
      `# session-linked-card

## TAKEAWAY

Session-linked card reached human review without joining the leaderboard.

## STATUS

resolved

## STARTING POINT

main

## BRANCH

https://github.com/example/log-only/tree/r/session-linked-card

## AGENT

0

## Question

Can the dashboard show a resolved non-admitted result?

## Hypothesis

80% confident the LOG-linked result doc should be enough.

## Research grounding

Local dashboard canary.

## Experiment design

Create a resolved result linked from LOG only.

## Cycles

- cycle 1 @abc123: log-only result -> visible. qual: result is not admitted.

## Results

- Dashboard API should include this result doc.

## Agent canvas

_none._

## Analysis

LOG-only results are important negative evidence.

## Reproducibility

- local fixture.

## Leaderboard verdict

Decision: do not admit.

## Queue updates

_none._
`,
    );

    const detail = await getProjectDetail(tmp, "log-only");
    assert.ok(detail, "expected non-null detail");
    assert.equal(detail.leaderboard.length, 0);
    assert.equal(detail.resultDocs.length, 1);
    assert.equal(detail.resultDocs[0].slug, "session-linked-card");
    assert.equal(detail.resultDocs[0].status, "resolved");
    assert.match(detail.resultDocs[0].takeaway, /human review/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("getProjectDetail: surfaces doctor errors when project has issues", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-api-doctor-"));
  try {
    const project = path.join(tmp, "projects", "prose-style");
    await copyDir(path.join(FIXTURE_LIBRARY, "projects", "prose-style"), project);
    // Strip benchmark_version from a result doc → doctor errors.
    const v1Path = path.join(project, "results", "v1-baseline.md");
    let v1 = await readFile(v1Path, "utf8");
    v1 = v1.replace("benchmark_version: v1\n", "");
    await writeFile(v1Path, v1);

    const detail = await getProjectDetail(tmp, "prose-style");
    assert.equal(detail.doctor.bucket, "error");
    const codes = detail.doctor.issues.map((i) => i.code);
    assert.ok(codes.includes("result_missing_benchmark_version"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("getProjectDetail: returns null for unknown project", async () => {
  const detail = await getProjectDetail(FIXTURE_LIBRARY, "no-such-project");
  assert.equal(detail, null);
});

test("getProjectDetail: rejects path-traversal in project name", async () => {
  await assert.rejects(
    () => getProjectDetail(FIXTURE_LIBRARY, "../escape"),
    /invalid project name/,
  );
  await assert.rejects(
    () => getProjectDetail(FIXTURE_LIBRARY, "foo/../bar"),
    /invalid project name/,
  );
  await assert.rejects(
    () => getProjectDetail(FIXTURE_LIBRARY, ""),
    /invalid project name/,
  );
});

test("getProjectDetail: leaderboard rows are annotated with bench staleness + mean/std", async () => {
  const detail = await getProjectDetail(FIXTURE_LIBRARY, "prose-style");
  // prose-style is qualitative — no mean/std on result docs, so mean/std are null
  // but bench staleness should be 'current' since result docs cite v1 == bench v1.
  for (const row of detail.leaderboard) {
    assert.equal(row.benchStaleness, "current", `expected 'current' for ${row.slug}`);
    assert.equal(row.benchmarkVersionCited, "v1");
  }
});

test("getProjectDetail: bench-staleness flags stale leaderboard rows when bench bumps", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-api-stale-"));
  try {
    const project = path.join(tmp, "projects", "prose-style");
    await copyDir(path.join(FIXTURE_LIBRARY, "projects", "prose-style"), project);
    // Bump the bench to v2 (with v1 still in history).
    const benchPath = path.join(project, "benchmark.md");
    let bench = await readFile(benchPath, "utf8");
    bench = bench.replace("version: v1", "version: v2");
    bench = bench.replace(
      "| v1 | 2026-04-27 | initial | first cut | - |",
      "| v2 | 2026-04-28 | tightened | second cut | - |\n| v1 | 2026-04-27 | initial | first cut | v2 |",
    );
    await writeFile(benchPath, bench);
    const detail = await getProjectDetail(tmp, "prose-style");
    // All existing leaderboard rows cite v1 → stale relative to current v2.
    for (const row of detail.leaderboard) {
      assert.equal(row.benchStaleness, "stale", `expected 'stale' for ${row.slug}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("getProjectDetail: result-doc summaries expose hypothesis + question for active-move rendering", async () => {
  const detail = await getProjectDetail(FIXTURE_LIBRARY, "prose-style");
  for (const doc of detail.resultDocs) {
    // The fixture v1-baseline / v2-scaffold both have hypothesis + question
    // sections — check they survived the API mapping.
    assert.equal(typeof doc.hypothesis, "string");
    assert.equal(typeof doc.question, "string");
    assert.ok(doc.hypothesis.length > 0, `expected hypothesis on ${doc.slug}`);
    assert.ok(doc.question.length > 0, `expected question on ${doc.slug}`);
  }
});

test("listProjects: sort prefers active rows, then most-recent LOG date", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-api-sort-"));
  try {
    await mkdir(path.join(tmp, "projects"), { recursive: true });
    // Three projects: A has active row (newest), B has recent log, C is empty.
    const mkReadme = (extras) => `# x\n\n## GOAL\n\ng\n\n## CODE REPO\n\nhttps://x\n\n## SUCCESS CRITERIA\n\n- y\n\n## RANKING CRITERION\n\n\`quantitative: f (higher is better)\`\n\n## LEADERBOARD\n\n| rank | result | branch | commit | score |\n|------|--------|--------|--------|-------|\n\n## INSIGHTS\n\n${extras.active || ""}## ACTIVE\n\n| move | result doc | branch | agent | started |\n|------|-----------|--------|-------|---------|\n${extras.activeRow || ""}\n## QUEUE\n\n| move | starting-point | why |\n|------|----------------|-----|\n\n## LOG\n\nSee [LOG.md](./LOG.md) — append-only event history.\n`;
    const mkLog = (logRow) => `# x — LOG\n\nAppend-only event log.\n\n| date | event | slug or ref | one-line summary | link |\n|------|-------|-------------|------------------|------|\n${logRow || ""}`;
    await mkdir(path.join(tmp, "projects", "alpha"), { recursive: true });
    await writeFile(path.join(tmp, "projects", "alpha", "README.md"), mkReadme({}));
    await writeFile(path.join(tmp, "projects", "alpha", "LOG.md"), mkLog());
    await mkdir(path.join(tmp, "projects", "beta"), { recursive: true });
    await writeFile(path.join(tmp, "projects", "beta", "README.md"), mkReadme({}));
    await writeFile(
      path.join(tmp, "projects", "beta", "LOG.md"),
      mkLog("| 2026-05-01 | resolved | b1 | recent | r.md |\n"),
    );
    await mkdir(path.join(tmp, "projects", "active-one"), { recursive: true });
    await writeFile(
      path.join(tmp, "projects", "active-one", "README.md"),
      mkReadme({ activeRow: "| s1 | [s1](results/s1.md) | [r/s1](https://github.com/x/y/tree/r/s1) | 0 | 2026-04-28 |\n" }),
    );
    await writeFile(path.join(tmp, "projects", "active-one", "LOG.md"), mkLog());
    const projects = await listProjects(tmp);
    const names = projects.map((p) => p.name);
    assert.equal(names[0], "active-one", "active-one should be first (has active row)");
    assert.equal(names[1], "beta", "beta should be second (recent log)");
    assert.equal(names[2], "alpha", "alpha should be last (no activity)");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("getProjectDetail: parses cycle kinds including bench", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-api-bench-"));
  try {
    const project = path.join(tmp, "projects", "prose-style");
    await copyDir(path.join(FIXTURE_LIBRARY, "projects", "prose-style"), project);
    // Replace v1-baseline cycles with a bench cycle.
    const v1Path = path.join(project, "results", "v1-baseline.md");
    let v1 = await readFile(v1Path, "utf8");
    v1 = v1.replace(
      /## Cycles[^#]*/m,
      "## Cycles\n\n- `cycle 1 @aaaaaaa bench: built v1 rubric -> readability rubric installed.`\n\n",
    );
    await writeFile(v1Path, v1);

    const detail = await getProjectDetail(tmp, "prose-style");
    const v1Doc = detail.resultDocs.find((d) => d.slug === "v1-baseline");
    assert.ok(v1Doc);
    assert.equal(v1Doc.cycles[0].kind, "bench");
    assert.equal(v1Doc.isBenchMove, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
