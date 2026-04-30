import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVibeResearchApp } from "../src/create-app.js";
import { createProject } from "../src/research/init.js";
import { finishMove, runNextMove } from "../src/research/runner.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const WORKSPACE_LIBRARY_RELATIVE = path.join("vibe-research", "buildings", "library");

async function startCanaryApp({ workspaceDir, stateDir, codeDir }) {
  return createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd: workspaceDir,
    stateDir,
    defaultSessionCwd: codeDir,
    persistSessions: false,
    persistentTerminals: false,
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({ enabled: settings.preventSleepEnabled, platform: "test" }),
    systemMetricsSampleIntervalMs: 0,
  });
}

async function waitForActionItem(baseUrl, id, { timeoutMs = 5_000 } = {}) {
  const started = Date.now();
  let lastPayload = null;
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/api/agent-town/action-items`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    lastPayload = payload;
    const item = payload.actionItems.find((entry) => entry.id === id);
    if (item) return item;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for action item ${id}; last payload: ${JSON.stringify(lastPayload)}`);
}

test("research runner completes a real-server Agent Town canary", { timeout: 30_000 }, async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vr-runner-server-canary-"));
  const stateDir = path.join(workspaceDir, ".vibe-research");
  const codeDir = path.join(workspaceDir, "code");
  const libraryRoot = path.join(workspaceDir, WORKSPACE_LIBRARY_RELATIVE);
  const projectName = "runner-server-canary";
  const projectDir = path.join(libraryRoot, "projects", projectName);
  const prevWorkspaceDir = process.env.VIBE_RESEARCH_WORKSPACE_DIR;
  process.env.VIBE_RESEARCH_WORKSPACE_DIR = workspaceDir;
  let app;

  try {
    await mkdir(codeDir, { recursive: true });
    await createProject({
      projectsDir: path.join(libraryRoot, "projects"),
      name: projectName,
      goal: "Verify the real server, shell session, Agent Inbox gate, Agent Canvas, runner finish, paper update, and dashboard API complete one canary loop.",
      codeRepoUrl: "https://github.com/example/runner-server-canary-code",
      successCriteria: [
        "review card carries the originating session id",
        "human wait resumes after the live API resolves the card",
        "dashboard exposes the resolved non-admitted takeaway",
      ],
      ranking: { kind: "quantitative", metric: "score", direction: "higher" },
      queueRows: [
        {
          move: "session-linked-card",
          startingPoint: "main",
          why: "prove real Agent Town review cards, canvas, and dashboard wiring",
        },
      ],
      force: true,
    });

    app = await startCanaryApp({ workspaceDir, stateDir, codeDir });
    const baseUrl = `http://127.0.0.1:${app.config.port}`;
    const agentTownApi = `${baseUrl}/api/agent-town`;

    const runPromise = runNextMove({
      projectDir,
      cwd: codeDir,
      command: "node -e \"console.log('score=0.810')\"",
      metricRegex: "score=([0-9.]+)",
      change: "seed 1 real-server canary",
      seed: "1",
      waitHuman: true,
      humanTimeoutMs: 10_000,
      agentTownApi,
      monitorUrl: `${baseUrl}/research/${projectName}`,
      monitorTitle: "Server canary monitor",
      monitorCaption: "Live monitor URL pinned during the automated canary.",
      agentReviewProvider: "shell",
      agentReviewName: "Canary Shell Reviewer",
      timeoutMs: 5_000,
    });

    const actionItemId = "research-cycle-session-linked-card-1";
    const openItem = await waitForActionItem(baseUrl, actionItemId);
    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const { sessions } = await sessionsResponse.json();
    const reviewerSession = sessions.find((entry) => entry.name === "Canary Shell Reviewer");
    assert.ok(reviewerSession?.id);
    assert.equal(openItem.status, "open");
    assert.equal(openItem.sourceSessionId, reviewerSession.id);
    assert.equal(openItem.sourceAgentId, "shell");
    assert.equal(openItem.target.id, `${projectName}:session-linked-card:cycle-1`);
    assert.deepEqual(openItem.choices, ["continue", "rerun", "synthesize", "brainstorm", "steer"]);

    const resolutionResponse = await fetch(`${baseUrl}/api/agent-town/action-items/${actionItemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resolution: "continued",
        resolutionNote: "Automated canary resolved the human review gate.",
      }),
    });
    assert.equal(resolutionResponse.status, 200);

    const run = await runPromise;
    assert.equal(run.claim.slug, "session-linked-card");
    assert.equal(run.cycle.metric, "0.810");
    assert.equal(run.cycle.reviewWait.satisfied, true);
    assert.equal(run.cycle.agentReviewSession.id, reviewerSession.id);
    assert.equal(run.cycle.monitorCanvas.sourceSessionId, reviewerSession.id);
    assert.equal(run.cycle.monitorCanvas.sourceAgentId, "shell");

    const finish = await finishMove({
      projectDir,
      slug: "session-linked-card",
      takeaway: "Automated real-server canary completed the runner, human gate, canvas, finish, paper, and dashboard path.",
      analysis: "The canary exercises the live app HTTP APIs and a real Shell session; it is intentionally not a cloud deployment or heavy ML workload.",
      decision: "do not admit; this is a plumbing canary rather than a scientific result",
      aggregateMetric: true,
      metricName: "score",
      higherIsBetter: true,
      updatePaper: true,
      publishCanvas: true,
      canvasTitle: "Server canary final result",
      canvasCaption: "Final generated result figure from the automated real-server canary.",
      canvasSessionId: reviewerSession.id,
      canvasAgentId: "shell",
      agentTownApi,
      summary: "automated real-server canary completed",
      apply: true,
    });
    assert.equal(finish.status, "resolved");
    assert.equal(finish.applied, true);
    assert.equal(finish.paper.lint.summary.error, 0);
    assert.equal(finish.canvas.sourceSessionId, reviewerSession.id);
    assert.match(finish.canvas.imagePath, /session-linked-card-summary\.svg$/);

    const stateResponse = await fetch(`${baseUrl}/api/agent-town/state`);
    assert.equal(stateResponse.status, 200);
    const { agentTown } = await stateResponse.json();
    const completedItem = agentTown.actionItems.find((entry) => entry.id === actionItemId);
    assert.equal(completedItem.status, "completed");
    assert.equal(completedItem.resolution, "continued");
    assert.equal(completedItem.sourceSessionId, reviewerSession.id);
    const finalCanvas = agentTown.canvases.find((entry) => entry.id === `${reviewerSession.id}-shell`);
    assert.equal(finalCanvas.title, "Server canary final result");
    assert.equal(finalCanvas.sourceSessionId, reviewerSession.id);
    assert.match(finalCanvas.imagePath, /session-linked-card-summary\.svg$/);

    const projectResponse = await fetch(`${baseUrl}/api/research/projects/${projectName}`);
    assert.equal(projectResponse.status, 200);
    const detail = await projectResponse.json();
    assert.equal(detail.doctor.bucket, "ok");
    assert.equal(detail.active.length, 0);
    assert.equal(detail.queue.length, 0);
    assert.equal(detail.log[0].event, "resolved");
    assert.equal(detail.resultDocs.length, 1);
    assert.equal(detail.resultDocs[0].status, "resolved");
    assert.match(detail.resultDocs[0].takeaway, /Automated real-server canary/);
    assert.equal(detail.paths.paper, "paper.md");
    assert.equal(detail.paths.figures, "figures");
  } finally {
    if (app) await app.close();
    if (prevWorkspaceDir === undefined) delete process.env.VIBE_RESEARCH_WORKSPACE_DIR;
    else process.env.VIBE_RESEARCH_WORKSPACE_DIR = prevWorkspaceDir;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
