// Unit + CLI tests for src/research/vacuum.js + bin/vr-research-vacuum.
//
// Invariants tested:
//  - Default policy moves binary extensions only (PNG / PT / etc.)
//  - .md / .tsv / .json / .yaml are pinned no matter how old
//  - benchmark/ subtree is pinned no matter the contents
//  - Figures referenced by a `falsified` LOG-event result doc are pinned
//    (the negative-result invariant)
//  - Age threshold respected: file younger than ageDays is pinned
//  - Manifest captures sha256 + size + path; restore is the inverse
//  - paper-lint follows manifest pointers — a figure that's been tiered
//    is not flagged as missing

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  planVacuum,
  applyVacuum,
  restoreFromArchive,
  readManifest,
  resolveArtifactPath,
  planPurge,
  applyPurge,
  BINARY_EXTENSIONS,
  TEXT_EXTENSIONS_PINNED,
  ARCHIVE_DIRNAME,
  __internal,
} from "../src/research/vacuum.js";
import { lintPaper } from "../src/research/paper-lint.js";

const VR_VACUUM = path.resolve("bin/vr-research-vacuum");

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `${prefix}-`)); }

function runCli(args, { cwd, env = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_VACUUM, ...args], {
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

// Make a project with a real-ish layout. README has a falsified row in
// LOG so we can exercise the negative-result invariant.
function makeProject(prefix = "vr-vacuum") {
  const dir = tmp(prefix);
  writeFileSync(join(dir, "README.md"), [
    "# example",
    "",
    "## GOAL",
    "",
    "x",
    "",
    "## ACTIVE",
    "",
    "| move | result doc | branch | agent | started |",
    "|------|-----------|--------|-------|---------|",
    "",
    "## QUEUE",
    "",
    "| move | starting-point | why |",
    "|------|----------------|-----|",
    "",
    "## LOG",
    "",
    "| date | event | slug or ref | one-line summary | link |",
    "|------|-------|-------------|-------------------|------|",
    "| 2026-04-25 | falsified | v0-bad-idea | augmentation made wibble worse | [v0-bad-idea.md](results/v0-bad-idea.md) |",
    "| 2026-04-26 | resolved+admitted | v1-good | wibble lifted | [v1-good.md](results/v1-good.md) |",
    "",
  ].join("\n"));
  mkdirSync(join(dir, "results"), { recursive: true });
  // Falsified result doc cites figures/v0-falsifier.png — that should
  // be pinned even though it's a binary.
  writeFileSync(join(dir, "results", "v0-bad-idea.md"), [
    "# v0-bad-idea",
    "",
    "## STATUS",
    "",
    "resolved",
    "",
    "## Falsifier",
    "",
    "The augmentation hypothesis missed by 3σ; see ![the falsifier](figures/v0-falsifier.png).",
    "",
  ].join("\n"));
  writeFileSync(join(dir, "results", "v1-good.md"), [
    "# v1-good",
    "",
    "## STATUS",
    "",
    "resolved",
    "",
  ].join("\n"));
  return dir;
}

// Touch files with a specific age (mtime offset in days).
function setAgeDays(absPath, days) {
  const t = (Date.now() - days * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(absPath, t, t);
}

// ---- planVacuum ----

test("planVacuum: tiers old PNGs, pins fresh PNGs", async () => {
  const dir = makeProject("vr-vacuum-plan-png");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.alloc(1024, 1));
    writeFileSync(join(dir, "figures", "young.png"), Buffer.alloc(1024, 2));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    setAgeDays(join(dir, "figures", "young.png"), 2);
    const plan = await planVacuum(dir, { ageDays: 90 });
    const candidatePaths = plan.candidates.map((c) => c.relPath);
    assert.ok(candidatePaths.some((p) => p.endsWith("old.png")), "old.png should be a candidate");
    assert.equal(candidatePaths.some((p) => p.endsWith("young.png")), false,
      `young.png should NOT be a candidate, got: ${candidatePaths.join(",")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planVacuum: pins .md and .tsv even if old", async () => {
  const dir = makeProject("vr-vacuum-plan-md");
  try {
    writeFileSync(join(dir, "ancient.md"), "# old prose\n");
    writeFileSync(join(dir, "runs.tsv"), "header\tonly\n");
    setAgeDays(join(dir, "ancient.md"), 1000);
    setAgeDays(join(dir, "runs.tsv"), 1000);
    const plan = await planVacuum(dir, { ageDays: 30 });
    const candidatePaths = plan.candidates.map((c) => c.relPath);
    assert.equal(candidatePaths.includes("ancient.md"), false);
    assert.equal(candidatePaths.includes("runs.tsv"), false);
    // And they appear in `pinned` with a "text format" reason.
    const pinned = plan.pinned.find((p) => p.relPath === "ancient.md");
    assert.ok(pinned);
    assert.ok(pinned.reasons.some((r) => /text format/.test(r)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planVacuum: pins everything under benchmark/", async () => {
  const dir = makeProject("vr-vacuum-plan-bench");
  try {
    mkdirSync(join(dir, "benchmark"), { recursive: true });
    writeFileSync(join(dir, "benchmark", "rubric.png"), Buffer.alloc(2048, 5));
    setAgeDays(join(dir, "benchmark", "rubric.png"), 365);
    const plan = await planVacuum(dir, { ageDays: 30 });
    const candidatePaths = plan.candidates.map((c) => c.relPath);
    assert.equal(candidatePaths.some((p) => p.includes("benchmark")), false,
      "benchmark/* should not be archived");
    const pinned = plan.pinned.find((p) => p.relPath.includes("benchmark"));
    assert.ok(pinned);
    assert.ok(pinned.reasons.some((r) => /benchmark/.test(r)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planVacuum: pins figures cited by a falsified result doc (negative-result invariant)", async () => {
  const dir = makeProject("vr-vacuum-plan-falsified");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "v0-falsifier.png"), Buffer.alloc(4096, 7)); // cited by v0-bad-idea
    writeFileSync(join(dir, "figures", "v0-other.png"), Buffer.alloc(4096, 8));      // NOT cited
    setAgeDays(join(dir, "figures", "v0-falsifier.png"), 300);
    setAgeDays(join(dir, "figures", "v0-other.png"), 300);
    const plan = await planVacuum(dir, { ageDays: 90 });
    const candidatePaths = plan.candidates.map((c) => c.relPath);
    assert.equal(candidatePaths.some((p) => p.endsWith("v0-falsifier.png")), false,
      "falsifier figure should be pinned");
    assert.ok(candidatePaths.some((p) => p.endsWith("v0-other.png")),
      `non-falsifier figure should be tier candidate, got: ${candidatePaths.join(",")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planVacuum: dotfiles + .archive/ never walked", async () => {
  const dir = makeProject("vr-vacuum-plan-dotfiles");
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "trash.png"), Buffer.alloc(1024));
    setAgeDays(join(dir, ".git", "trash.png"), 1000);
    mkdirSync(join(dir, ARCHIVE_DIRNAME));
    writeFileSync(join(dir, ARCHIVE_DIRNAME, "already-tiered.png"), Buffer.alloc(1024));
    setAgeDays(join(dir, ARCHIVE_DIRNAME, "already-tiered.png"), 1000);
    const plan = await planVacuum(dir, { ageDays: 30 });
    const allRelPaths = [...plan.candidates, ...plan.pinned].map((f) => f.relPath);
    assert.equal(allRelPaths.some((p) => p.includes(".git")), false);
    assert.equal(allRelPaths.some((p) => p.includes(ARCHIVE_DIRNAME)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- applyVacuum ----

test("applyVacuum: moves files to .archive/ + writes manifest", async () => {
  const dir = makeProject("vr-vacuum-apply");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.from("hello world"));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    const plan = await planVacuum(dir, { ageDays: 90 });
    const result = await applyVacuum(dir, plan);
    assert.equal(result.moved.length, 1);
    // Original gone.
    assert.equal(existsSync(join(dir, "figures", "old.png")), false);
    // Archived present.
    assert.equal(existsSync(join(dir, ARCHIVE_DIRNAME, "figures", "old.png")), true);
    // Manifest written.
    const manifest = await readManifest(dir);
    assert.equal(manifest.rows.length, 1);
    assert.equal(manifest.rows[0].original_path, "figures/old.png");
    assert.equal(manifest.rows[0].sha256.length, 64);
    assert.equal(Number(manifest.rows[0].original_size), Buffer.from("hello world").length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyVacuum: idempotent — re-running skips already-tiered files", async () => {
  const dir = makeProject("vr-vacuum-idempotent");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.from("xxx"));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    let plan = await planVacuum(dir, { ageDays: 90 });
    await applyVacuum(dir, plan);
    // Second run: nothing to plan.
    plan = await planVacuum(dir, { ageDays: 90 });
    assert.equal(plan.candidates.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- restore ----

test("restoreFromArchive: brings file back + drops manifest row", async () => {
  const dir = makeProject("vr-vacuum-restore");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.from("data"));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    const plan = await planVacuum(dir, { ageDays: 90 });
    await applyVacuum(dir, plan);
    assert.equal(existsSync(join(dir, "figures", "old.png")), false);
    const result = await restoreFromArchive(dir, "figures/old.png");
    assert.equal(result.restored, true);
    assert.equal(existsSync(join(dir, "figures", "old.png")), true);
    const manifest = await readManifest(dir);
    assert.equal(manifest.rows.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoreFromArchive: refuses to overwrite existing original", async () => {
  const dir = makeProject("vr-vacuum-restore-overwrite");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.from("v1"));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    const plan = await planVacuum(dir, { ageDays: 90 });
    await applyVacuum(dir, plan);
    // User puts a new file at the original path.
    writeFileSync(join(dir, "figures", "old.png"), Buffer.from("v2 collision"));
    await assert.rejects(
      restoreFromArchive(dir, "figures/old.png"),
      /refusing to overwrite/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoreFromArchive: errors when path not in manifest", async () => {
  const dir = makeProject("vr-vacuum-restore-missing");
  try {
    await assert.rejects(
      restoreFromArchive(dir, "figures/nope.png"),
      /no manifest row/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- resolveArtifactPath / paper-lint integration ----

test("resolveArtifactPath: returns archived path after tiering", async () => {
  const dir = makeProject("vr-vacuum-resolve");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "x.png"), Buffer.from("d"));
    setAgeDays(join(dir, "figures", "x.png"), 200);
    let resolved = await resolveArtifactPath(dir, "figures/x.png");
    assert.match(resolved, /figures\/x\.png$/);
    assert.equal(resolved.includes(ARCHIVE_DIRNAME), false);
    const plan = await planVacuum(dir, { ageDays: 90 });
    await applyVacuum(dir, plan);
    resolved = await resolveArtifactPath(dir, "figures/x.png");
    assert.ok(resolved.includes(ARCHIVE_DIRNAME), `expected archive path, got ${resolved}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("paper-lint: figure_missing does NOT fire when figure is tiered", async () => {
  const dir = makeProject("vr-vacuum-paperlint");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "panel.png"), Buffer.from("d"));
    setAgeDays(join(dir, "figures", "panel.png"), 200);
    // paper.md that references the figure.
    writeFileSync(join(dir, "paper.md"), [
      "# x",
      "",
      "## 4. Results",
      "",
      "### My Sub",
      "",
      "![alt](figures/panel.png)",
      "",
      "Claim[^my-sub-c1] here.",
      "",
      "[^my-sub-c1]: https://example.com/commit/abc · cmd · path",
      "",
    ].join("\n"));

    // Before tiering: paper-lint sees the figure on disk, no error.
    let report = await lintPaper(dir);
    let codes = report.issues.map((i) => i.code);
    assert.equal(codes.includes("figure_missing"), false,
      `unexpected figure_missing pre-vacuum: ${codes.join(",")}`);

    // After tiering: figure moved to .archive/figures/panel.png. paper-lint
    // should still NOT fire figure_missing — it follows manifest pointers.
    const plan = await planVacuum(dir, { ageDays: 90 });
    await applyVacuum(dir, plan);
    assert.equal(existsSync(join(dir, "figures", "panel.png")), false, "should be tiered");
    report = await lintPaper(dir);
    codes = report.issues.map((i) => i.code);
    assert.equal(codes.includes("figure_missing"), false,
      `figure_missing fired post-vacuum: ${codes.join(",")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- internal helpers ----

test("__internal.extractFigureRefs: extracts figure paths from markdown", () => {
  const text = "see ![fig](figures/baseline.png) and figures/extra-stuff.pdf in the appendix";
  const refs = __internal.extractFigureRefs(text);
  assert.ok(refs.has("baseline.png"));
  assert.ok(refs.has("extra-stuff.pdf"));
});

test("__internal.falsifiedSlugs: matches simple + compound events", () => {
  const parsed = {
    log: [
      { event: "falsified", slug: "a" },
      { event: "falsified+admitted", slug: "b" },
      { event: "resolved", slug: "c" },
      { event: "Falsified", slug: "d" }, // case-insensitive
    ],
  };
  const slugs = __internal.falsifiedSlugs(parsed);
  assert.deepEqual([...slugs].sort(), ["a", "b", "d"]);
});

// ---- planPurge / applyPurge ----

test("planPurge: enumerates archived files + manifest rows without mutating", async () => {
  const dir = makeProject("vr-vacuum-purge-plan");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.from("aaaa"));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    const plan = await planVacuum(dir, { ageDays: 90 });
    await applyVacuum(dir, plan);
    const purgePlan = await planPurge(dir);
    assert.equal(purgePlan.archivedFiles.length, 1);
    assert.equal(purgePlan.archivedFiles[0].relPath.split(/[/\\]/).pop(), "old.png");
    assert.equal(purgePlan.manifestRows, 1);
    // Dry-run mutates nothing.
    assert.equal(existsSync(join(dir, ARCHIVE_DIRNAME, "figures", "old.png")), true);
    assert.equal(existsSync(join(dir, ARCHIVE_DIRNAME, "manifest.tsv")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planPurge: returns empty plan when no .archive/", async () => {
  const dir = makeProject("vr-vacuum-purge-empty");
  try {
    const plan = await planPurge(dir);
    assert.equal(plan.archivedFiles.length, 0);
    assert.equal(plan.totalBytes, 0);
    assert.equal(plan.manifestRows, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyPurge: wipes .archive/ entirely (files + manifest)", async () => {
  const dir = makeProject("vr-vacuum-purge-apply");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old1.png"), Buffer.from("aaaa"));
    writeFileSync(join(dir, "figures", "old2.png"), Buffer.from("bbbbcc"));
    setAgeDays(join(dir, "figures", "old1.png"), 200);
    setAgeDays(join(dir, "figures", "old2.png"), 200);
    const plan = await planVacuum(dir, { ageDays: 90 });
    await applyVacuum(dir, plan);
    const result = await applyPurge(dir);
    assert.equal(result.removed, 2);
    assert.equal(result.totalBytes, 4 + 6);
    assert.equal(result.manifestRowsDropped, 2);
    assert.equal(existsSync(join(dir, ARCHIVE_DIRNAME)), false, ".archive/ dir gone");
    // Original files are still gone (vacuum had moved them).
    assert.equal(existsSync(join(dir, "figures", "old1.png")), false);
    assert.equal(existsSync(join(dir, "figures", "old2.png")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyPurge: idempotent (no-op when no .archive/)", async () => {
  const dir = makeProject("vr-vacuum-purge-idempotent");
  try {
    const result = await applyPurge(dir);
    assert.equal(result.removed, 0);
    assert.equal(result.totalBytes, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- bin/vr-research-vacuum CLI ----

test("vr-research-vacuum --help: exits 0", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /vr-research-vacuum/);
  assert.match(r.stdout, /--apply/);
  assert.match(r.stdout, /--restore/);
});

test("vr-research-vacuum: missing project-dir exits 2", async () => {
  const r = await runCli([]);
  assert.equal(r.status, 2);
});

test("vr-research-vacuum: dry-run prints summary, mutates nothing", async () => {
  const dir = makeProject("vr-vacuum-cli-dry");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.alloc(2048));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    const r = await runCli([dir, "--age-days", "90"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /dry-run/);
    assert.match(r.stdout, /candidates: 1/);
    // File still in original location.
    assert.equal(existsSync(join(dir, "figures", "old.png")), true);
    assert.equal(existsSync(join(dir, ARCHIVE_DIRNAME, "manifest.tsv")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-vacuum --apply: moves files + writes manifest", async () => {
  const dir = makeProject("vr-vacuum-cli-apply");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.alloc(2048));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    const r = await runCli([dir, "--apply", "--age-days", "90"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /moved:\s+1 files/);
    assert.equal(existsSync(join(dir, "figures", "old.png")), false);
    assert.equal(existsSync(join(dir, ARCHIVE_DIRNAME, "manifest.tsv")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-vacuum --list: dumps manifest", async () => {
  const dir = makeProject("vr-vacuum-cli-list");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.alloc(2048));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    await runCli([dir, "--apply", "--age-days", "90"]);
    const r = await runCli([dir, "--list"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /figures\/old\.png/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-vacuum --restore: round-trips a tiered file", async () => {
  const dir = makeProject("vr-vacuum-cli-restore");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.from("payload"));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    await runCli([dir, "--apply", "--age-days", "90"]);
    assert.equal(existsSync(join(dir, "figures", "old.png")), false);
    const r = await runCli([dir, "--restore", "figures/old.png"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(existsSync(join(dir, "figures", "old.png")), true);
    assert.equal(readFileSync(join(dir, "figures", "old.png"), "utf8"), "payload");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-vacuum --apply --restore: mutually exclusive", async () => {
  const r = await runCli(["/tmp/whatever", "--apply", "--restore", "x"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mutually exclusive/);
});

test("vr-research-vacuum --purge (dry-run): prints plan + mutates nothing", async () => {
  const dir = makeProject("vr-vacuum-cli-purge-dry");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.alloc(2048));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    await runCli([dir, "--apply", "--age-days", "90"]);
    const r = await runCli([dir, "--purge"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--purge dry-run/);
    assert.match(r.stdout, /files:\s+1/);
    assert.match(r.stdout, /destructive and irreversible/);
    // Mutates nothing.
    assert.equal(existsSync(join(dir, ARCHIVE_DIRNAME, "manifest.tsv")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-vacuum --purge --apply: wipes archive", async () => {
  const dir = makeProject("vr-vacuum-cli-purge-apply");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.alloc(2048));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    await runCli([dir, "--apply", "--age-days", "90"]);
    const r = await runCli([dir, "--purge", "--apply"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /purged/);
    assert.match(r.stdout, /removed:\s+1 files/);
    assert.equal(existsSync(join(dir, ARCHIVE_DIRNAME)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-vacuum --purge --json: structured plan", async () => {
  const dir = makeProject("vr-vacuum-cli-purge-json");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.alloc(1024));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    await runCli([dir, "--apply", "--age-days", "90"]);
    const r = await runCli([dir, "--purge", "--json"]);
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.mode, "purge-dry-run");
    assert.equal(body.plan.archivedFiles.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-vacuum --purge --list: mutually exclusive", async () => {
  const r = await runCli(["/tmp/whatever", "--purge", "--list"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mutually exclusive/);
});

test("vr-research-vacuum --json: machine-readable summary", async () => {
  const dir = makeProject("vr-vacuum-cli-json");
  try {
    mkdirSync(join(dir, "figures"));
    writeFileSync(join(dir, "figures", "old.png"), Buffer.alloc(1024));
    setAgeDays(join(dir, "figures", "old.png"), 200);
    const r = await runCli([dir, "--json", "--age-days", "90"]);
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.mode, "dry-run");
    assert.ok(Array.isArray(body.plan.candidates));
    assert.ok(body.plan.candidates.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
