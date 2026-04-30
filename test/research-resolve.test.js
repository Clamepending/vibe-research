// Unit + CLI tests for src/research/resolve.js + bin/vr-research-resolve.
//
// resolve = orchestrator that reads a result doc + project README and runs
// the four admin commands (leaderboard, active, queue, log) in the right
// order. End-to-end test: write a project + result doc, call resolve, check
// the README ended up correct.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  resolveMove,
  parseQueueUpdates,
  parseAdmitDecision,
  getSectionBody,
  __internal,
} from "../src/research/resolve.js";

const VR_RESOLVE = path.resolve("bin/vr-research-resolve");

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `${prefix}-`)); }

function runCli(args, { cwd, env = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_RESOLVE, ...args], {
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

// Project fixture: README with 5 leaderboard rows so an insert-at-rank-1
// triggers eviction; ACTIVE has the move slug claimed; QUEUE has 2 rows.
function makeProject(prefix, { slug, decision, queueUpdates, status = "resolved", frontmatter = "", takeaway = "Move resolved cleanly." } = {}) {
  const dir = tmp(prefix);
  const lbRows = [];
  for (let i = 1; i <= 5; i += 1) {
    lbRows.push(`| ${i} | [v${i}-existing](results/v${i}-existing.md) | [r/v${i}-existing](https://github.com/example/x/tree/r/v${i}-existing) | [aaaaaa${i}](https://github.com/example/x/commit/aaaaaa${i}) | 0.${90 - i * 5} mean |`);
  }
  writeFileSync(join(dir, "README.md"), [
    "# example",
    "",
    "## GOAL",
    "",
    "x",
    "",
    "## CODE REPO",
    "",
    "`https://github.com/example/x`",
    "",
    "## SUCCESS CRITERIA",
    "- a",
    "",
    "## RANKING CRITERION",
    "",
    "`quantitative: m (higher is better)`",
    "",
    "## LEADERBOARD",
    "",
    "| rank | result | branch | commit | score |",
    "|------|--------|--------|--------|-------|",
    lbRows.join("\n"),
    "",
    "## ACTIVE",
    "",
    "| move | result doc | branch | agent | started |",
    "|------|-----------|--------|-------|---------|",
    `| ${slug} | [${slug}](results/${slug}.md) | [r/${slug}](https://github.com/example/x/tree/r/${slug}) | 0 | TODAY |`,
    "",
    "## QUEUE",
    "",
    "| move | starting-point | why |",
    "|------|----------------|-----|",
    "| q1-existing | main | seed move |",
    "| q2-existing | main | seed move 2 |",
    "",
    "## LOG",
    "",
    "| date | event | slug or ref | one-line summary | link |",
    "|------|-------|-------------|-------------------|------|",
    "",
  ].join("\n"));

  // Result doc.
  mkdirSync(join(dir, "results"), { recursive: true });
  writeFileSync(join(dir, "results", `${slug}.md`), [
    frontmatter || "",
    `# ${slug}`,
    "",
    "## TAKEAWAY",
    "",
    takeaway,
    "",
    "## STATUS",
    "",
    status,
    "",
    "## BRANCH",
    "",
    `https://github.com/example/x/tree/r/${slug}`,
    "",
    "## STARTING POINT",
    "",
    `https://github.com/example/x/tree/main@aaaaaaa`,
    "",
    "## Leaderboard verdict",
    "",
    `Decision: ${decision}`,
    "",
    "## Queue updates",
    "",
    queueUpdates || "",
    "",
  ].join("\n"));

  return dir;
}

const FRONTMATTER_OK = `---\nmetric: m\nmetric_higher_is_better: true\nseeds: [0, 1, 2]\nmean: 0.99\nstd: 0.01\n---\n`;

// ---- parseQueueUpdates ----

test("parseQueueUpdates: ADD with starting-point + why", () => {
  const verbs = parseQueueUpdates(
    "ADD: v3-narrow | starting-point https://github.com/x/x/tree/r/v2-tuned | why narrow around peak",
  );
  assert.equal(verbs.length, 1);
  assert.deepEqual(verbs[0], {
    verb: "add",
    slug: "v3-narrow",
    startingPoint: "https://github.com/x/x/tree/r/v2-tuned",
    why: "narrow around peak",
    raw: verbs[0].raw,
  });
});

test("parseQueueUpdates: REMOVE", () => {
  const verbs = parseQueueUpdates("REMOVE: old-slug | why no longer relevant");
  assert.equal(verbs.length, 1);
  assert.equal(verbs[0].verb, "remove");
  assert.equal(verbs[0].slug, "old-slug");
});

test("parseQueueUpdates: REPRIORITIZE", () => {
  const verbs = parseQueueUpdates("REPRIORITIZE: v3-narrow -> row 1 | why most promising");
  assert.equal(verbs.length, 1);
  assert.equal(verbs[0].verb, "reprioritize");
  assert.equal(verbs[0].slug, "v3-narrow");
  assert.equal(verbs[0].toRow, 1);
});

test("parseQueueUpdates: skips non-verb lines", () => {
  const verbs = parseQueueUpdates(
    [
      "Some prose here.",
      "ADD: v3 | starting-point main | why x",
      "(another note)",
      "REMOVE: old | why y",
    ].join("\n"),
  );
  assert.equal(verbs.length, 2);
});

test("parseQueueUpdates: empty body returns []", () => {
  assert.deepEqual(parseQueueUpdates(""), []);
});

// ---- parseAdmitDecision ----

test("parseAdmitDecision: insert at rank N", () => {
  assert.deepEqual(parseAdmitDecision("insert at rank 1"), { admit: true, rank: 1 });
  assert.deepEqual(parseAdmitDecision("Insert at rank 3."), { admit: true, rank: 3 });
});

test("parseAdmitDecision: do not admit", () => {
  assert.deepEqual(parseAdmitDecision("do not admit"), { admit: false, rank: null });
  assert.deepEqual(parseAdmitDecision("Do not admit; within noise"), { admit: false, rank: null });
});

test("parseAdmitDecision: empty / unrecognised", () => {
  assert.deepEqual(parseAdmitDecision(""), { admit: false, rank: null });
  assert.deepEqual(parseAdmitDecision("???"), { admit: false, rank: null });
});

// ---- getSectionBody ----

test("getSectionBody: extracts the body until the next header", () => {
  const body = "## Foo\n\nfoo body\n\n## Bar\n\nbar body\n";
  assert.match(getSectionBody(body, "Foo"), /foo body/);
  assert.equal(/bar body/.test(getSectionBody(body, "Foo")), false);
});

test("getSectionBody: returns '' when section missing", () => {
  assert.equal(getSectionBody("## Other\n\ntext\n", "Foo"), "");
});

// ---- resolveMove (admit path) ----

test("resolveMove: admit + insert + active remove + queue add + eviction LOG + resolution LOG", async () => {
  const dir = makeProject("vr-resolve-admit", {
    slug: "v9-newest",
    decision: "insert at rank 1",
    queueUpdates: "ADD: v10-followup | starting-point main | why next",
    frontmatter: FRONTMATTER_OK,
    takeaway: "v9 lifted m to 0.99 with simpler config.",
  });
  try {
    const result = await resolveMove({
      projectDir: dir,
      slug: "v9-newest",
      event: "resolved",
      commit: "https://github.com/example/x/commit/abc1234",
    });
    assert.equal(result.resolved, true);
    assert.equal(result.event, "resolved+admitted");
    assert.equal(result.admitted, true);
    assert.equal(result.rank, 1);
    assert.equal(result.evicted, "v5-existing");

    const after = readFileSync(join(dir, "README.md"), "utf8");
    const leaderboardSection = after.split("## LEADERBOARD")[1].split("##")[0];
    const activeSection = after.split("## ACTIVE")[1].split("##")[0];
    const logSection = after.split("## LOG")[1] || "";
    // v9 at rank 1 in LEADERBOARD.
    assert.match(leaderboardSection, /\| 1 \| \[v9-newest\]/);
    // v5 evicted from LEADERBOARD (still appears in LOG eviction row, that's fine).
    assert.equal(/v5-existing/.test(leaderboardSection), false);
    // ACTIVE row for v9 gone.
    assert.equal(/v9-newest/.test(activeSection), false,
      `v9-newest should be removed from ACTIVE, got: ${activeSection}`);
    // LOG mentions both eviction + resolution.
    assert.match(logSection, /\| evicted \| v5-existing \|/);
    assert.match(logSection, /\| resolved\+admitted \| v9-newest \|/);
    // QUEUE has v10-followup.
    assert.match(after, /v10-followup/);
    // Resolution summary derived from TAKEAWAY.
    assert.match(logSection, /v9 lifted m to 0\.99/);

    // Steps array has the right order.
    const stepNames = result.steps.map((s) => s.step);
    assert.deepEqual(stepNames, [
      "leaderboard.insert",
      "active.remove",
      "queue.add",
      "log.append", // eviction
      "log.append", // resolution
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveMove: do not admit + falsified event", async () => {
  const dir = makeProject("vr-resolve-falsified", {
    slug: "v6-failed",
    decision: "do not admit; missed falsifier band by 3σ",
    queueUpdates: "REMOVE: q1-existing | why no longer relevant",
    frontmatter: FRONTMATTER_OK,
    takeaway: "Augmentation hypothesis falsified at 3σ.",
  });
  try {
    const result = await resolveMove({
      projectDir: dir,
      slug: "v6-failed",
      event: "falsified",
    });
    assert.equal(result.event, "falsified");
    assert.equal(result.admitted, false);
    assert.equal(result.rank, null);
    assert.equal(result.evicted, null);

    const after = readFileSync(join(dir, "README.md"), "utf8");
    // Leaderboard untouched.
    assert.match(after, /\| 1 \| \[v1-existing\]/);
    // q1-existing was removed.
    assert.equal(/\|\s*q1-existing\s*\|/.test(after), false);
    // LOG has falsified entry.
    assert.match(after, /\| falsified \| v6-failed \|/);
    assert.match(after, /Augmentation hypothesis falsified/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveMove: rejects STATUS:active result doc", async () => {
  const dir = makeProject("vr-resolve-active", {
    slug: "v9-still-running",
    decision: "insert at rank 1",
    status: "active",
  });
  try {
    await assert.rejects(
      resolveMove({ projectDir: dir, slug: "v9-still-running", event: "resolved" }),
      /STATUS is "active"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveMove: rejects bad event", async () => {
  const dir = makeProject("vr-resolve-bad-event", {
    slug: "v9",
    decision: "insert at rank 1",
  });
  try {
    await assert.rejects(
      resolveMove({ projectDir: dir, slug: "v9", event: "bogus" }),
      /event must be one of/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveMove: admit without --commit errors clearly", async () => {
  const dir = makeProject("vr-resolve-no-commit", {
    slug: "v9",
    decision: "insert at rank 1",
    frontmatter: FRONTMATTER_OK,
  });
  try {
    await assert.rejects(
      resolveMove({ projectDir: dir, slug: "v9", event: "resolved" }),
      /admitting requires --commit/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveMove: admit without frontmatter mean/std errors on score derivation", async () => {
  const dir = makeProject("vr-resolve-no-fm", {
    slug: "v9",
    decision: "insert at rank 1",
    frontmatter: "", // no YAML
  });
  try {
    await assert.rejects(
      resolveMove({
        projectDir: dir,
        slug: "v9",
        event: "resolved",
        commit: "https://github.com/example/x/commit/abc",
      }),
      /score/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveMove: --score override skips frontmatter derivation", async () => {
  const dir = makeProject("vr-resolve-score-override", {
    slug: "v9",
    decision: "insert at rank 5",  // tail insert, no eviction
    frontmatter: "",
  });
  try {
    const result = await resolveMove({
      projectDir: dir,
      slug: "v9",
      event: "resolved",
      commit: "https://github.com/example/x/commit/abc",
      score: "manual score string",
    });
    assert.equal(result.admitted, true);
    const after = readFileSync(join(dir, "README.md"), "utf8");
    assert.match(after, /manual score string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveMove: tolerates ACTIVE row that doesn't exist (was never claimed)", async () => {
  const dir = makeProject("vr-resolve-no-active", {
    slug: "v9-quickfix",
    decision: "do not admit",
  });
  // Manually clear the ACTIVE table.
  const readmePath = join(dir, "README.md");
  let readme = readFileSync(readmePath, "utf8");
  readme = readme.replace(/\| v9-quickfix \|.*\|\n/, "");
  writeFileSync(readmePath, readme);
  try {
    const result = await resolveMove({
      projectDir: dir,
      slug: "v9-quickfix",
      event: "resolved",
    });
    const activeStep = result.steps.find((s) => s.step === "active.remove");
    assert.match(activeStep.skipped, /no ACTIVE row/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- bin/vr-research-resolve CLI ----

test("vr-research-resolve --help: exits 0", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /vr-research-resolve/);
  assert.match(r.stdout, /--commit/);
});

test("vr-research-resolve: missing flags exit 2", async () => {
  const dir = makeProject("vr-resolve-cli-missing", {
    slug: "v9", decision: "do not admit", frontmatter: FRONTMATTER_OK,
  });
  try {
    const r = await runCli([dir, "--slug", "v9"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--event is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-resolve: end-to-end CLI run + JSON output", async () => {
  const dir = makeProject("vr-resolve-cli-e2e", {
    slug: "v9-cli",
    decision: "insert at rank 1",
    queueUpdates: "ADD: v10 | starting-point main | why next",
    frontmatter: FRONTMATTER_OK,
    takeaway: "Big lift",
  });
  try {
    const r = await runCli([
      dir,
      "--slug", "v9-cli",
      "--event", "resolved",
      "--commit", "https://github.com/example/x/commit/abc",
      "--json",
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.event, "resolved+admitted");
    assert.equal(body.admitted, true);
    assert.equal(body.evicted, "v5-existing");
    const after = readFileSync(join(dir, "README.md"), "utf8");
    assert.match(after, /\| 1 \| \[v9-cli\]/);
    assert.match(after, /v10/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
