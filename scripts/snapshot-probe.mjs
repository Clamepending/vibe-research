#!/usr/bin/env node
// Probe the chunked-snapshot WS path against a real session. Connects to a
// session, captures every frame, prints sizes/timings, and reports whether the
// snapshot-start / snapshot-chunk / snapshot-end protocol behaves as expected.
//
// Usage: node scripts/snapshot-probe.mjs <wss-url> <sessionId>

import { WebSocket } from "ws";

const wsUrl = process.argv[2];
const sessionId = process.argv[3];
if (!wsUrl || !sessionId) {
  console.error("Usage: node scripts/snapshot-probe.mjs <wss-url> <sessionId>");
  process.exit(1);
}

const fullUrl = `${wsUrl}?sessionId=${encodeURIComponent(sessionId)}`;
const startMs = Date.now();
const ws = new WebSocket(fullUrl, { perMessageDeflate: false });
const frames = [];
let snapshotStartAt = null;
let snapshotEndAt = null;
let firstChunkAt = null;
let firstOutputAt = null;
let chunkBytes = 0;
let chunkCount = 0;

const finish = (code) => {
  try { ws.close(); } catch {}
  setTimeout(() => process.exit(code), 50);
};

const timeout = setTimeout(() => {
  console.error(JSON.stringify({ error: "timeout", framesSeen: frames.length }, null, 2));
  finish(2);
}, 15_000);

ws.on("open", () => {
  console.error(`[probe] connected at ${Date.now() - startMs}ms`);
});

ws.on("message", (raw) => {
  const at = Date.now() - startMs;
  let payload;
  try {
    payload = JSON.parse(raw.toString());
  } catch (error) {
    frames.push({ at, type: "PARSE-ERROR", size: raw.length });
    return;
  }
  const size = raw.length;
  frames.push({ at, type: payload.type, size });
  if (payload.type === "snapshot-start") {
    snapshotStartAt = at;
  } else if (payload.type === "snapshot-chunk") {
    if (firstChunkAt === null) firstChunkAt = at;
    chunkCount += 1;
    chunkBytes += (payload.data || "").length;
  } else if (payload.type === "snapshot-end") {
    snapshotEndAt = at;
    summarize();
    finish(0);
  } else if (payload.type === "snapshot") {
    // Legacy single-frame snapshot from an unupgraded server.
    snapshotStartAt = at;
    snapshotEndAt = at;
    chunkBytes = (payload.data || "").length;
    chunkCount = 1;
    summarize();
    finish(0);
  } else if (payload.type === "output" && firstOutputAt === null) {
    firstOutputAt = at;
  }
});

ws.on("error", (error) => {
  console.error(`[probe] error: ${error.message}`);
  finish(3);
});

ws.on("close", (code, reason) => {
  console.error(`[probe] closed code=${code} reason=${reason || ""}`);
});

function summarize() {
  clearTimeout(timeout);
  const result = {
    url: fullUrl,
    sessionId,
    snapshotStartAt,
    firstChunkAt,
    snapshotEndAt,
    snapshotEndMinusStartMs: snapshotEndAt - snapshotStartAt,
    chunkCount,
    chunkBytes,
    biggestFrame: Math.max(...frames.map((f) => f.size)),
    averageChunkSize: chunkCount > 0 ? Math.round(chunkBytes / chunkCount) : 0,
    framesSeen: frames.length,
    firstOutputAt,
    frames: frames.slice(0, 6),
    framesTail: frames.slice(-3),
  };
  console.log(JSON.stringify(result, null, 2));
}
