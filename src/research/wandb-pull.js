// vr-rl-sweep wandb-pull — back-fill mean_return from wandb summaries.
//
// The sweep-runner extracts the wandb run URL from launcher stdout (PR
// #62) but only captures `mean_return` if the launcher itself prints
// `final_return: <num>` or `mean_return=<num>` to stdout. Real
// training scripts often `wandb.log({"return": ...})` per step but
// never print the final summary metric in a stdout-regex-able form.
//
// This module pulls the FINAL summary metric for each row's wandb run
// via wandb's GraphQL API and writes it back into runs.tsv's
// `mean_return` column. Idempotent: only fills in rows where
// mean_return is empty (or where --overwrite is passed).
//
// Auth: WANDB_API_KEY env var. The wandb client also writes to ~/.netrc;
// we don't shell out to it — straight HTTP fetch + bearer-via-basic-auth.
//
// API:
//
//   const r = await pullWandbMetrics({
//     runsTsvPath,
//     metric = "mean_return",     // wandb summary key to read
//     fetchImpl = defaultFetch,   // dependency-injectable
//     apiKey = process.env.WANDB_API_KEY,
//     overwrite = false,
//   });
//   // → { pulled, skipped, failed, rows }

import { readFile, writeFile, rename } from "node:fs/promises";
import { parseRunsTsv, serializeRunsTsv } from "./sweep-runner.js";

const WANDB_GRAPHQL = "https://api.wandb.ai/graphql";

// Parse a wandb run URL into its parts:
//   https://wandb.ai/<entity>/<project>/runs/<run_id>
// Returns null if the URL doesn't match.
export function parseWandbRunUrl(url) {
  if (!url) return null;
  const m = String(url).match(
    /https?:\/\/(?:[\w.-]+\.)?wandb\.ai\/([^/?#]+)\/([^/?#]+)\/runs\/([A-Za-z0-9_-]+)/,
  );
  if (!m) return null;
  return { entity: m[1], project: m[2], runId: m[3] };
}

// Default fetcher: POST to wandb's GraphQL endpoint with HTTP basic auth.
// wandb accepts either an API token in basic auth (user="api", pass=key)
// or a Bearer header — basic auth is the older, more stable form.
async function defaultFetch({ entity, project, runId, apiKey }) {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("global fetch unavailable; Node 18+ required");
  }
  const query = `
    query Run($entity: String!, $project: String!, $name: String!) {
      project(entityName: $entity, name: $project) {
        run(name: $name) {
          summaryMetrics
        }
      }
    }
  `;
  const auth = Buffer.from(`api:${apiKey || ""}`).toString("base64");
  const res = await globalThis.fetch(WANDB_GRAPHQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "vr-rl-sweep wandb-pull",
      "authorization": `Basic ${auth}`,
    },
    body: JSON.stringify({
      query,
      variables: { entity, project, name: runId },
    }),
  });
  if (!res.ok) {
    throw new Error(`wandb GraphQL ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = await res.json();
  if (body?.errors?.length) {
    const msg = body.errors.map((e) => e.message || "?").join("; ");
    throw new Error(`wandb GraphQL errors: ${msg}`);
  }
  const summary = body?.data?.project?.run?.summaryMetrics;
  if (!summary) return null;
  // wandb returns summaryMetrics as a JSON string, not parsed.
  if (typeof summary === "string") {
    try { return JSON.parse(summary); } catch { return null; }
  }
  return summary;
}

async function atomicWriteFile(filePath, body) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, body, "utf8");
  await rename(tmpPath, filePath);
}

export async function pullWandbMetrics({
  runsTsvPath,
  metric = "mean_return",
  fetchImpl = defaultFetch,
  apiKey,
  overwrite = false,
} = {}) {
  if (!runsTsvPath) throw new TypeError("runsTsvPath is required");
  const text = await readFile(runsTsvPath, "utf8");
  const { headers, rows } = parseRunsTsv(text);
  if (!headers.length) throw new Error(`runs.tsv at ${runsTsvPath} has no header`);
  if (!headers.includes("mean_return")) {
    throw new Error(`runs.tsv missing mean_return column`);
  }

  let pulled = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];
  const usingDefault = !apiKey ? !!(process.env && process.env.WANDB_API_KEY) : true;
  const finalKey = apiKey ?? (process.env ? process.env.WANDB_API_KEY : "");

  for (const row of rows) {
    const url = String(row.wandb_url || "").trim();
    const parsed = parseWandbRunUrl(url);
    if (!parsed) {
      skipped += 1;
      row._wandb_pull_status = "no run URL";
      continue;
    }
    const haveValue = String(row.mean_return || "").trim().length > 0;
    if (haveValue && !overwrite) {
      skipped += 1;
      row._wandb_pull_status = "already filled (pass overwrite to refresh)";
      continue;
    }
    let summary;
    try {
      summary = await fetchImpl({ ...parsed, apiKey: finalKey });
    } catch (err) {
      failed += 1;
      failures.push({ name: row.name, url, error: err.message });
      row._wandb_pull_status = `error: ${err.message}`;
      continue;
    }
    if (!summary || summary[metric] == null) {
      skipped += 1;
      row._wandb_pull_status = `no "${metric}" in summary`;
      continue;
    }
    const value = Number(summary[metric]);
    if (!Number.isFinite(value)) {
      failed += 1;
      failures.push({ name: row.name, url, error: `non-finite metric: ${summary[metric]}` });
      row._wandb_pull_status = `non-finite metric`;
      continue;
    }
    row.mean_return = String(value);
    row._wandb_pull_status = "filled";
    pulled += 1;
  }

  // Strip transient _wandb_pull_status fields before serializing.
  for (const row of rows) delete row._wandb_pull_status;
  await atomicWriteFile(runsTsvPath, serializeRunsTsv({ headers, rows }));

  return {
    runsTsvPath,
    metric,
    apiKeyConfigured: usingDefault,
    pulled,
    skipped,
    failed,
    failures,
  };
}

export const __internal = {
  parseWandbRunUrl,
  defaultFetch,
};
