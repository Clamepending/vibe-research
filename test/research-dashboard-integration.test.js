// Integration test for the /research dashboard:
//   - GET /api/research/projects                 → list with summary fields
//   - GET /api/research/projects/<name>          → full structured detail
//   - GET /research                              → static index page
//   - GET /research/<name>                       → static project page

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createVibeResearchApp } from "../src/create-app.js";
import { createResearchBrief } from "../src/research/brief.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_LIBRARY = path.join(HERE, "fixtures", "research", "library");

// Mirror src/settings-store.js: workspace root + "vibe-research/buildings/library".
const WORKSPACE_LIBRARY_RELATIVE = path.join("vibe-research", "buildings", "library");

async function copyDir(src, dest) {
  const fs = await import("node:fs");
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await copyFile(from, to);
  }
}

async function startApp(options) {
  const cwd = options.cwd;
  const stateDir = path.join(cwd, ".vibe-research");
  const app = await createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd,
    stateDir,
    persistSessions: false,
    persistentTerminals: false,
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({ enabled: settings.preventSleepEnabled, platform: "test" }),
    ...options,
  });
  return { app, baseUrl: `http://127.0.0.1:${app.config.port}` };
}

async function withLibraryServer(fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-dashboard-"));
  const cwd = tmp;
  const libraryRoot = path.join(cwd, WORKSPACE_LIBRARY_RELATIVE);
  await copyDir(FIXTURE_LIBRARY, libraryRoot);

  // SettingsStore reads VIBE_RESEARCH_WORKSPACE_DIR from process.env at app
  // construction time. Patch it temporarily.
  const prevEnv = process.env.VIBE_RESEARCH_WORKSPACE_DIR;
  process.env.VIBE_RESEARCH_WORKSPACE_DIR = cwd;
  let app;
  try {
    const started = await startApp({ cwd });
    app = started.app;
    await fn({ baseUrl: started.baseUrl, libraryRoot });
  } finally {
    if (app) await app.close();
    if (prevEnv === undefined) delete process.env.VIBE_RESEARCH_WORKSPACE_DIR;
    else process.env.VIBE_RESEARCH_WORKSPACE_DIR = prevEnv;
    await rm(tmp, { recursive: true, force: true });
  }
}

test("GET /api/research/projects returns the list with summary fields", async () => {
  await withLibraryServer(async ({ baseUrl, libraryRoot }) => {
    const res = await fetch(`${baseUrl}/api/research/projects`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.libraryRoot, libraryRoot);
    const names = body.projects.map((p) => p.name).sort();
    assert.deepEqual(names, ["prose-style", "widget-tuning"]);

    const prose = body.projects.find((p) => p.name === "prose-style");
    assert.equal(prose.criterionKind, "qualitative");
    assert.equal(prose.hasBenchmark, true);
    assert.equal(prose.benchmarkVersion, "v1");
    assert.equal(prose.leaderboardSize, 2);
  });
});

test("GET /api/research/projects/<name> returns full detail with doctor result", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/research/projects/prose-style`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, "prose-style");
    assert.equal(body.rankingCriterion.kind, "qualitative");
    assert.equal(body.benchmark.version, "v1");
    assert.equal(body.benchmark.metrics[0].name, "readability");
    assert.equal(body.leaderboard.length, 2);
    assert.equal(body.sweeps.length, 1);
    assert.equal(body.sweeps[0].statusCounts.done, 2);
    assert.equal(body.sweeps[0].statusCounts.planned, 1);
    assert.equal(body.doctor.bucket, "ok");
    assert.equal(body.doctor.counts.error, 0);
    assert.ok(Array.isArray(body.resultDocs));
    assert.equal(body.resultDocs.length, 2);
  });
});

test("GET /api/research/projects/<missing> returns 404", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/research/projects/no-such`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /not found/i);
  });
});

test("GET /api/research/projects/<bad-name> returns 400", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    // Path-traversal style: should be caught by regex in research-api.js,
    // surfaced as 400 by the route handler.
    // (Note: Express normalizes some traversal in URLs; we test the regex
    // rejection via a name with a slash forced via encodeURIComponent.)
    const res = await fetch(`${baseUrl}/api/research/projects/${encodeURIComponent("../escape")}`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /invalid project name/);
  });
});

test("POST /api/research/projects/<name>/briefs/<slug>/compile adds brief move to QUEUE", async () => {
  await withLibraryServer(async ({ baseUrl, libraryRoot }) => {
    const projectDir = path.join(libraryRoot, "projects", "prose-style");
    await createResearchBrief({
      projectDir,
      slug: "branch-plan",
      question: "Should the next research phase test a diagnostic few-shot branch?",
      currentTheory: "The prompt scaffold may need an explicit contrastive example.",
      grounding: ["Fixture test grounding."],
      candidateMoves: [
        {
          move: "v3-diagnostic",
          startingPoint: "https://github.com/example/prose-style/tree/r/v2-scaffold",
          why: "Compare a diagnostic few-shot prompt against the current scaffold.",
          hypothesis: "A contrastive exemplar improves readability review clarity.",
        },
      ],
      recommendedMove: "v3-diagnostic",
    });

    const res = await fetch(`${baseUrl}/api/research/projects/prose-style/briefs/branch-plan/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.compiled, true);
    assert.equal(body.queueRows[0].slug, "v3-diagnostic");
    assert.equal(body.phase.phase, "experiment");
    assert.equal(body.phase.briefSlug, "branch-plan");

    const readme = await readFile(path.join(projectDir, "README.md"), "utf8");
    assert.match(readme, /\| v3-diagnostic \| \[r\/v2-scaffold\]\(https:\/\/github\.com\/example\/prose-style\/tree\/r\/v2-scaffold\) \| Compare a diagnostic few-shot prompt/);
  });
});

test("POST /api/research/projects/<name>/orchestrator/tick returns next phase action", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/research/projects/prose-style/orchestrator/tick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandText: "node eval.js", checkPaper: false }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.projectName, "prose-style");
    assert.equal(body.report.recommendation.action, "run-next");
    assert.equal(body.report.recommendation.slug, "v3-fewshot");
    assert.match(body.report.nextCommand, /vr-research-runner/);
    assert.match(body.report.nextCommand, /node eval\.js/);
  });
});

test("GET /research returns the static index page", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/research`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /<title>Vibe Research — Projects<\/title>/);
    assert.match(text, /id="project-list"/);
    assert.match(text, /\/research\/research\.js/);
  });
});

test("GET /research/<name> returns the static project page", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/research/prose-style`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /<title>Vibe Research — Project<\/title>/);
    assert.match(text, /id="dashboard"/);
    assert.match(text, /id="next-card"/);
    assert.match(text, /id="sweeps-card"/);
  });
});

test("GET /research/<bad-name> rejects invalid names with 400", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    // Spaces and other URL-safe-but-name-invalid chars hit the regex gate.
    // (`../` style traversal gets normalized away by Express before the route
    // sees it, so we test a different invalid character here.)
    const res = await fetch(`${baseUrl}/research/bad%20name`);
    assert.equal(res.status, 400);
  });
});

test("GET /research/research.js + research.css are served", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const js = await fetch(`${baseUrl}/research/research.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") || "", /javascript/);
    const jsText = await js.text();
    assert.match(jsText, /orchestrator\/tick/);
    assert.match(jsText, /briefs\/.*compile/);
    assert.match(jsText, /vr-next-candidates/);
    assert.match(jsText, /renderSweepsCard/);
    const css = await fetch(`${baseUrl}/research/research.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /css/);
    assert.match(await css.text(), /vr-action-button/);
  });
});
