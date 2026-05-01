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

test("POST /api/research/projects/<name>/autopilot/step returns routed next action", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/research/projects/prose-style/autopilot/step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandText: "node eval.js", checkPaper: false }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.projectName, "prose-style");
    assert.equal(body.report.delegated, "orchestrator");
    assert.equal(body.report.recommendation.action, "orchestrator-run-next");
    assert.equal(body.report.orchestrator.recommendation.slug, "v3-fewshot");
    assert.match(body.report.nextCommand, /vr-research-runner/);
    assert.match(body.report.nextCommand, /node eval\.js/);
  });
});

test("POST /api/research/projects/<name>/autopilot/run executes one bounded step", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/research/projects/prose-style/autopilot/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandText: "node -e \"console.log('score=0.55')\"",
        metricRegex: "score=([0-9.]+)",
        maxSteps: 1,
        checkPaper: false,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.report.stopReason, "max-steps");
    assert.equal(body.report.actions[0].plannedAction, "orchestrator-run-next");
    assert.equal(body.report.actions[0].result.kind, "run-next");
    assert.equal(body.report.actions[0].result.claim.slug, "v3-fewshot");
    assert.equal(body.report.actions[0].result.cycle.metric, "0.55");

    const detailRes = await fetch(`${baseUrl}/api/research/projects/prose-style`);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.active[0].slug, "v3-fewshot");
  });
});

test("POST /api/research/projects/<name>/autopilot/jobs runs background loop", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const start = await fetch(`${baseUrl}/api/research/projects/prose-style/autopilot/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objective: "keep testing concise prose improvements until interrupted",
        mode: "experiment",
        commandText: "node -e \"console.log('score=0.61')\"",
        metricRegex: "score=([0-9.]+)",
        maxSteps: 1,
        intervalMs: 0,
        checkPaper: false,
      }),
    });
    assert.equal(start.status, 202);
    const started = await start.json();
    assert.equal(started.ok, true);
    assert.equal(started.job.projectName, "prose-style");
    assert.equal(started.job.objective, "keep testing concise prose improvements until interrupted");

    let job = started.job;
    for (let attempt = 0; attempt < 40 && !["succeeded", "failed", "stopped"].includes(job.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poll = await fetch(`${baseUrl}/api/research/autopilot/jobs/${job.id}`);
      assert.equal(poll.status, 200);
      job = (await poll.json()).job;
    }
    assert.equal(job.status, "succeeded", job.error || job.stopSummary);
    assert.equal(job.stepCount, 1);
    assert.equal(job.lastReport.actions[0].plannedAction, "orchestrator-run-next");
    assert.equal(job.lastReport.actions[0].result.cycle.metric, "0.61");
    assert.ok(job.events.some((event) => event.type === "step"));

    const jobs = await fetch(`${baseUrl}/api/research/autopilot/jobs?limit=5`);
    assert.equal(jobs.status, 200);
    const history = await jobs.json();
    assert.equal(history.ok, true);
    assert.equal(history.jobs.some((entry) => entry.id === job.id), true);
  });
});

test("POST /api/research/autopilot/jobs/<id>/stop interrupts background loop", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const start = await fetch(`${baseUrl}/api/research/projects/prose-style/autopilot/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "experiment",
        commandText: "node -e \"setTimeout(() => console.log('score=0.62'), 200)\"",
        metricRegex: "score=([0-9.]+)",
        maxSteps: 5,
        intervalMs: 1000,
        checkPaper: false,
      }),
    });
    assert.equal(start.status, 202);
    const started = await start.json();
    const stop = await fetch(`${baseUrl}/api/research/autopilot/jobs/${started.job.id}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(stop.status, 200);
    const stopped = await stop.json();
    assert.equal(stopped.ok, true);
    assert.equal(stopped.job.stopRequested, true);

    let job = stopped.job;
    for (let attempt = 0; attempt < 40 && !["succeeded", "failed", "stopped"].includes(job.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poll = await fetch(`${baseUrl}/api/research/autopilot/jobs/${job.id}`);
      assert.equal(poll.status, 200);
      job = (await poll.json()).job;
    }
    assert.equal(job.status, "stopped");
    assert.equal(job.stopReason, "user-stop");
  });
});

test("POST /api/research/autopilot/jobs/<id>/steer queues human steering", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const start = await fetch(`${baseUrl}/api/research/projects/prose-style/autopilot/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objective: "keep testing concise prose improvements until interrupted",
        mode: "experiment",
        commandText: "node -e \"console.log('score=0.63')\"",
        metricRegex: "score=([0-9.]+)",
        maxSteps: 3,
        intervalMs: 10_000,
        checkPaper: false,
      }),
    });
    assert.equal(start.status, 202);
    const started = await start.json();
    let job = started.job;

    for (let attempt = 0; attempt < 60 && !(job.status === "running" && job.stepCount >= 1); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poll = await fetch(`${baseUrl}/api/research/autopilot/jobs/${job.id}`);
      assert.equal(poll.status, 200);
      job = (await poll.json()).job;
    }
    assert.equal(job.status, "running", job.error || job.stopSummary);
    assert.equal(job.stepCount, 1);

    const steer = await fetch(`${baseUrl}/api/research/autopilot/jobs/${job.id}/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Switch to synthesis and explain whether the current cycle is worth admitting.",
        mode: "synthesize",
        objective: "synthesize the concise prose experiment for human review",
        source: "test-chat",
      }),
    });
    assert.equal(steer.status, 200);
    const steered = await steer.json();
    assert.equal(steered.ok, true);
    assert.equal(steered.job.mode, "synthesize");
    assert.equal(steered.job.objective, "synthesize the concise prose experiment for human review");
    assert.equal(steered.job.lastSteering.source, "test-chat");
    assert.equal(steered.job.lastSteering.decision, "synthesize");
    assert.match(steered.job.lastSteering.message, /Switch to synthesis/);
    assert.ok(steered.job.events.some((event) => event.type === "steering"));

    const stop = await fetch(`${baseUrl}/api/research/autopilot/jobs/${job.id}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(stop.status, 200);
    job = (await stop.json()).job;
    for (let attempt = 0; attempt < 40 && !["succeeded", "failed", "stopped"].includes(job.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poll = await fetch(`${baseUrl}/api/research/autopilot/jobs/${job.id}`);
      assert.equal(poll.status, 200);
      job = (await poll.json()).job;
    }
    assert.equal(job.status, "stopped");
  });
});

test("session research autopilot attachment persists chat-native control state", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const sessionRes = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "shell", name: "Research chat" }),
    });
    assert.equal(sessionRes.status, 201);
    const session = (await sessionRes.json()).session;
    assert.ok(session.id);

    const save = await fetch(`${baseUrl}/api/sessions/${session.id}/research-autopilot`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        projectName: "prose-style",
        mode: "brainstorm",
        statusText: "send an objective to start autopilot",
      }),
    });
    assert.equal(save.status, 200);
    const saved = await save.json();
    assert.equal(saved.ok, true);
    assert.equal(saved.attachment.enabled, true);
    assert.equal(saved.attachment.projectName, "prose-style");
    assert.equal(saved.attachment.mode, "brainstorm");

    const getSaved = await fetch(`${baseUrl}/api/sessions/${session.id}/research-autopilot`);
    assert.equal(getSaved.status, 200);
    const loaded = await getSaved.json();
    assert.equal(loaded.attachment.projectName, "prose-style");
    assert.equal(loaded.attachment.job, null);

    const start = await fetch(`${baseUrl}/api/sessions/${session.id}/research-autopilot/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectName: "prose-style",
        objective: "keep testing concise prose improvements until interrupted",
        mode: "experiment",
        commandText: "node -e \"console.log('score=0.64')\"",
        metricRegex: "score=([0-9.]+)",
        maxSteps: 3,
        intervalMs: 10_000,
        checkPaper: false,
      }),
    });
    assert.equal(start.status, 202);
    const started = await start.json();
    assert.equal(started.ok, true);
    assert.equal(started.attachment.sessionId, session.id);
    assert.equal(started.attachment.enabled, true);
    assert.equal(started.attachment.jobId, started.job.id);
    assert.equal(started.attachment.job.id, started.job.id);

    let job = started.job;
    for (let attempt = 0; attempt < 60 && !(job.status === "running" && job.stepCount >= 1); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poll = await fetch(`${baseUrl}/api/research/autopilot/jobs/${job.id}`);
      assert.equal(poll.status, 200);
      job = (await poll.json()).job;
    }
    assert.equal(job.status, "running", job.error || job.stopSummary);

    const steer = await fetch(`${baseUrl}/api/sessions/${session.id}/research-autopilot/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Switch to synthesis from the chat control strip.",
        mode: "synthesize",
        source: "chat",
      }),
    });
    assert.equal(steer.status, 200);
    const steered = await steer.json();
    assert.equal(steered.ok, true);
    assert.equal(steered.attachment.mode, "synthesize");
    assert.equal(steered.job.lastSteering.source, "chat");
    assert.match(steered.job.lastSteering.message, /Switch to synthesis/);

    const stop = await fetch(`${baseUrl}/api/sessions/${session.id}/research-autopilot/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "chat" }),
    });
    assert.equal(stop.status, 200);
    const stopped = await stop.json();
    assert.equal(stopped.ok, true);
    assert.equal(stopped.attachment.enabled, false);
    assert.equal(stopped.job.stopRequested, true);

    const finalGet = await fetch(`${baseUrl}/api/sessions/${session.id}/research-autopilot`);
    assert.equal(finalGet.status, 200);
    const finalLoaded = await finalGet.json();
    assert.equal(finalLoaded.attachment.enabled, false);
    assert.equal(finalLoaded.attachment.jobId, started.job.id);
  });
});

test("session research autopilot job resumes after app restart", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-research-dashboard-restart-"));
  const cwd = tmp;
  const libraryRoot = path.join(cwd, WORKSPACE_LIBRARY_RELATIVE);
  await copyDir(FIXTURE_LIBRARY, libraryRoot);

  const prevEnv = process.env.VIBE_RESEARCH_WORKSPACE_DIR;
  process.env.VIBE_RESEARCH_WORKSPACE_DIR = cwd;
  let app;
  try {
    let started = await startApp({ cwd, persistSessions: true });
    app = started.app;
    let baseUrl = started.baseUrl;

    const sessionRes = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "shell", name: "Durable research chat" }),
    });
    assert.equal(sessionRes.status, 201);
    const session = (await sessionRes.json()).session;

    const start = await fetch(`${baseUrl}/api/sessions/${session.id}/research-autopilot/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectName: "prose-style",
        objective: "resume this concise prose experiment after restart",
        mode: "experiment",
        commandText: "node -e \"console.log('score=0.65')\"",
        metricRegex: "score=([0-9.]+)",
        maxSteps: 3,
        intervalMs: 10_000,
        checkPaper: false,
      }),
    });
    assert.equal(start.status, 202);
    const startedJob = (await start.json()).job;
    let job = startedJob;
    for (let attempt = 0; attempt < 60 && !(job.status === "running" && job.stepCount >= 1); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poll = await fetch(`${baseUrl}/api/research/autopilot/jobs/${job.id}`);
      assert.equal(poll.status, 200);
      job = (await poll.json()).job;
    }
    assert.equal(job.status, "running", job.error || job.stopSummary);
    assert.equal(job.stepCount, 1);

    await app.close();
    app = null;

    started = await startApp({ cwd, persistSessions: true });
    app = started.app;
    baseUrl = started.baseUrl;

    const sessions = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(sessions.status, 200);
    assert.equal((await sessions.json()).sessions.some((entry) => entry.id === session.id), true);

    const attached = await fetch(`${baseUrl}/api/sessions/${session.id}/research-autopilot`);
    assert.equal(attached.status, 200);
    const attachedBody = await attached.json();
    assert.equal(attachedBody.attachment.jobId, startedJob.id);
    assert.equal(attachedBody.attachment.job.id, startedJob.id);

    job = attachedBody.job;
    for (let attempt = 0; attempt < 80 && !(job.stepCount >= 2 && job.status === "running"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poll = await fetch(`${baseUrl}/api/research/autopilot/jobs/${startedJob.id}`);
      assert.equal(poll.status, 200);
      job = (await poll.json()).job;
    }
    assert.equal(job.status, "running", job.error || job.stopSummary);
    assert.ok(job.stepCount >= 2);
    assert.ok(job.resumeCount >= 1);
    assert.ok(job.events.some((event) => event.type === "resumed"));

    const stop = await fetch(`${baseUrl}/api/sessions/${session.id}/research-autopilot/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "chat" }),
    });
    assert.equal(stop.status, 200);
    job = (await stop.json()).job;
    for (let attempt = 0; attempt < 40 && !["succeeded", "failed", "stopped"].includes(job.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poll = await fetch(`${baseUrl}/api/research/autopilot/jobs/${startedJob.id}`);
      assert.equal(poll.status, 200);
      job = (await poll.json()).job;
    }
    assert.equal(job.status, "stopped");
  } finally {
    if (app) await app.close();
    if (prevEnv === undefined) delete process.env.VIBE_RESEARCH_WORKSPACE_DIR;
    else process.env.VIBE_RESEARCH_WORKSPACE_DIR = prevEnv;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("POST /api/research/org-bench/run executes local benchmark smoke", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/research/org-bench/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "local-smoke", seeds: [0] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    try {
      assert.equal(body.ok, true);
      assert.equal(body.preset, "local-smoke");
      assert.match(body.text, /Org bench: posttrain-lite/);
      const byStrategy = new Map(body.report.summary.map((row) => [row.strategy, row]));
      assert.equal(byStrategy.get("single-agent-provider").runs, 1);
      assert.equal(byStrategy.get("org-provider-reviewed").reviewCountMean, 1);
      assert.equal(byStrategy.get("org-provider-reviewed").timeoutRate, 0);
    } finally {
      if (body.report?.outputDir) {
        await rm(body.report.outputDir, { recursive: true, force: true });
      }
    }
  });
});

test("POST /api/research/org-bench/jobs runs benchmark asynchronously", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const start = await fetch(`${baseUrl}/api/research/org-bench/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "local-smoke", seeds: "0" }),
    });
    assert.equal(start.status, 202);
    const started = await start.json();
    assert.equal(started.ok, true);
    assert.equal(started.job.preset, "local-smoke");

    let job = started.job;
    try {
      for (let attempt = 0; attempt < 20 && !["succeeded", "failed"].includes(job.status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const poll = await fetch(`${baseUrl}/api/research/org-bench/jobs/${job.id}`);
        assert.equal(poll.status, 200);
        job = (await poll.json()).job;
      }
      assert.equal(job.status, "succeeded", job.error || "job did not complete");
      assert.equal(job.report.summary.some((row) => row.strategy === "org-provider-reviewed"), true);

      const runs = await fetch(`${baseUrl}/api/research/org-bench/runs?limit=3`);
      assert.equal(runs.status, 200);
      const history = await runs.json();
      assert.equal(history.ok, true);
      assert.equal(history.reports.some((row) => row.outputDir === job.report.outputDir), true);
    } finally {
      if (job.report?.outputDir) {
        await rm(job.report.outputDir, { recursive: true, force: true });
      }
    }
  });
});

test("GET /research returns the static index page", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/research`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /<title>Vibe Research — Projects<\/title>/);
    assert.match(text, /id="org-bench-section"/);
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
    assert.match(jsText, /autopilot\/step/);
    assert.match(jsText, /orchestrator\/tick/);
    assert.match(jsText, /briefs\/.*compile/);
    assert.match(jsText, /org-bench\/jobs/);
    assert.match(jsText, /org-bench\/runs/);
    assert.match(jsText, /vr-next-candidates/);
    assert.match(jsText, /renderSweepsCard/);
    const css = await fetch(`${baseUrl}/research/research.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /css/);
    assert.match(await css.text(), /vr-action-button/);
  });
});

test("main app bundle exposes the native research workspace", async () => {
  await withLibraryServer(async ({ baseUrl }) => {
    const js = await fetch(`${baseUrl}/app.js`);
    assert.equal(js.status, 200);
    const jsText = await js.text();
    assert.match(jsText, /renderResearchView/);
    assert.match(jsText, /view: "research"/);
    assert.match(jsText, /renderResearchAutopilotPanel/);
    assert.match(jsText, /renderRichSessionAutopilotPanel/);
    assert.match(jsText, /\/api\/research\/autopilot\/jobs/);
    assert.match(jsText, /\/research-autopilot\/start/);
    assert.match(jsText, /\/research-autopilot\/steer/);
    assert.match(jsText, /\/research-autopilot\/stop/);
    assert.match(jsText, /research-autopilot-steer-form/);
    assert.match(jsText, /data-chat-autopilot-toggle/);
    assert.match(jsText, /getChatAutopilotInferredProjectName/);
    assert.match(jsText, /data-chat-autopilot-change-project/);
    assert.match(jsText, /Plan next/);
    assert.match(jsText, /Summarize/);
    assert.match(jsText, /\/api\/research\/org-bench\/jobs/);

    const css = await fetch(`${baseUrl}/styles.css`);
    assert.equal(css.status, 200);
    const cssText = await css.text();
    assert.match(cssText, /research-autopilot-card/);
    assert.match(cssText, /research-autopilot-steer/);
    assert.match(cssText, /rich-session-autopilot/);
    assert.match(cssText, /rich-session-autopilot-project-pill/);
    assert.match(cssText, /research-org-bench-card/);
    assert.match(cssText, /research-bench-table/);
  });
});
