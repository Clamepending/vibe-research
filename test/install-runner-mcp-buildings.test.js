// Live integration test for the MCP-server building install plans. The
// plans are intentionally cheap to verify: each one runs `npm view
// <package> version` against the live npm registry. Skipped when offline
// or when npm isn't on PATH.
//
// We test 8 buildings here. For Filesystem (which has no auth step) we
// expect status "ok". For the seven that declare an auth-paste step, we
// expect "auth-required" because no token is configured in this run —
// that's the contract: install runs, package is verified, install pauses
// at auth.

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

import { BUILDING_CATALOG } from "../src/client/building-registry.js";
import { executeInstallPlan } from "../src/install-runner.js";

function npmAvailable() {
  try { execSync("command -v npm", { stdio: "pipe" }); return true; } catch { return false; }
}

const expectOk = [
  "mcp-filesystem",
  "mcp-puppeteer",
  "mcp-memory",
  "mcp-everything",
  "mcp-playwright",
  // No-auth-needed: kubernetes uses kubectl context from ~/.kube/config.
  "mcp-kubernetes",
];
const expectAuthRequired = [
  "mcp-github",
  "mcp-postgres",
  "mcp-sqlite",
  "mcp-brave-search",
  "mcp-slack",
  "mcp-sentry",
  "mcp-notion",
  "mcp-linear",
  "mcp-redis",
  "mcp-gitlab",
  "mcp-google-maps",
  "mcp-stripe",
  "mcp-mongodb",
  "mcp-cloudflare",
  "mcp-tavily",
  "mcp-exa",
  "mcp-firecrawl",
  "mcp-hubspot",
  "mcp-apify",
  "mcp-pinecone",
  "mcp-supabase",
  "mcp-twilio",
  "mcp-confluence",
  "mcp-e2b",
  "mcp-perplexity",
  "mcp-neon",
  "mcp-replicate",
  "mcp-vercel",
  "mcp-axiom",
  "mcp-upstash",
  "mcp-spotify",
  // Auth-paste-gated: AWS Knowledge Base ID + Obsidian API key.
  "mcp-aws-kb-retrieval",
  "mcp-obsidian",
  // CircleCI/Airtable/Datadog batch.
  "mcp-circleci",
  "mcp-airtable",
  "mcp-datadog",
];

for (const id of [...expectOk, ...expectAuthRequired]) {
  test(`${id} install plan runs and lands at expected status`, async (t) => {
    if (!npmAvailable()) { t.skip("npm not on PATH"); return; }
    const building = BUILDING_CATALOG.find((entry) => entry.id === id);
    assert.ok(building, `${id} must exist`);
    assert.ok(building.install?.plan, `${id} must declare an install plan`);
    const log = [];
    const result = await executeInstallPlan(building.install.plan, {
      appendLog: (entry) => log.push(entry),
    });
    if (expectOk.includes(id)) {
      assert.equal(result.status, "ok", `${id}: expected ok, got ${result.status} (${result.reason || ""})`);
    } else {
      assert.equal(
        result.status,
        "auth-required",
        `${id}: expected auth-required (no token configured in this run), got ${result.status} (${result.reason || ""})`,
      );
    }
    // Sanity: the verify command must have actually run (npm view) for both branches.
    const verifyRan = log.some((entry) => entry.phase === "verify");
    assert.equal(verifyRan, true, `${id}: verify phase must run`);
    // mcp launch must always be declared in the log so the runtime can pick it up.
    const mcpDeclared = log.some((entry) => entry.phase === "mcp");
    if (result.status === "ok") {
      assert.equal(mcpDeclared, true, `${id}: mcp launch should be declared on success`);
    }
  });
}
