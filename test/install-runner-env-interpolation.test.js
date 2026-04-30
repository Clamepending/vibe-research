// Regression tests for `${VAR}` interpolation in install-plan http step
// URLs. Without this feature, an install plan can't reach back into the
// running Vibe Research server (e.g. POST /api/videomemory/install-server)
// because the actual port isn't known at manifest-write time. The runner
// injects VIBE_RESEARCH_SERVER_URL into spawn env; this test pins that
// the http-step URL substitutes it before fetching.

import test from "node:test";
import assert from "node:assert/strict";
import { createInstallJobStore, executeInstallPlan, startInstallJob, waitForJob } from "../src/install-runner.js";

test("executeInstallPlan: ${VAR} in http step URL is interpolated against spawnEnv", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false", label: "force-install" }],
      install: [
        {
          kind: "http",
          method: "POST",
          url: "${SERVER_BASE}/api/videomemory/install-server",
          body: {},
        },
      ],
      verify: [],
    },
    {
      fetchImpl: fakeFetch,
      spawnEnv: { SERVER_BASE: "http://127.0.0.1:4828" },
    },
  );

  assert.equal(result.status, "ok", `expected ok, got: ${result.status} ${result.reason || ""}`);
  assert.deepEqual(calls, ["http://127.0.0.1:4828/api/videomemory/install-server"]);
});

test("executeInstallPlan: unresolved ${VAR} stays literal so the failure is visible", async () => {
  // If a manifest references a variable that the runner doesn't supply,
  // we leave it literal rather than silently sending a request to the
  // wrong URL — the resulting 404 / DNS-error is louder than a coerced
  // empty-string substitution.
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const result = await executeInstallPlan(
    {
      preflight: [{ kind: "command", command: "false" }],
      install: [
        {
          kind: "http",
          method: "POST",
          url: "${MISSING_VAR}/api/whatever",
          body: {},
        },
      ],
      verify: [],
    },
    { fetchImpl: fakeFetch, spawnEnv: {} },
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(calls, ["${MISSING_VAR}/api/whatever"]);
});

test("startInstallJob plumbs serverBaseUrl into VIBE_RESEARCH_SERVER_URL for plan steps", async () => {
  // Higher-level test: the create-app caller passes serverBaseUrl, and
  // shell-command steps see it as an env var. This is what enables
  // VideoMemory's install plan to call its own server's install-server
  // endpoint without hard-coding a port.
  const jobStore = createInstallJobStore();
  const fetchedUrls = [];
  const fakeFetch = async (url) => {
    fetchedUrls.push(url);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const job = startInstallJob({
    jobStore,
    building: {
      id: "fake-building",
      install: {
        plan: {
          preflight: [{ kind: "command", command: "false" }],
          install: [
            { kind: "http", method: "POST", url: "${VIBE_RESEARCH_SERVER_URL}/health", body: {} },
          ],
          verify: [],
        },
      },
    },
    fetchImpl: fakeFetch,
    serverBaseUrl: "http://127.0.0.1:4242",
  });
  const finished = await waitForJob(jobStore, job.id, { timeoutMs: 5000 });
  assert.equal(finished.status, "ok", `expected ok, got: ${finished.status} ${finished.result?.reason || ""}`);
  assert.deepEqual(fetchedUrls, ["http://127.0.0.1:4242/health"]);
});
