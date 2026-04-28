#!/usr/bin/env node
// Measure round-trip latency for typed input on a real session.
//
// Sequence:
//  1. connect, drain snapshot (wait for snapshot-end)
//  2. send a unique shell command via {type:"input", data:"echo <token>\r"}
//  3. measure how long until the token bytes appear in an output frame
//
// This isolates "after the snapshot lands, are keystrokes responsive?"
//
// Usage: node scripts/input-latency-probe.mjs <wss-url> <sessionId> [<inputText>]

import { WebSocket } from "ws";

const wsUrl = process.argv[2];
const sessionId = process.argv[3];
if (!wsUrl || !sessionId) {
  console.error("Usage: node scripts/input-latency-probe.mjs <wss-url> <sessionId> [<inputText>]");
  process.exit(1);
}
// Default to a benign no-op so we don't spam any actually-busy session.
// "true" returns 0 immediately and emits no output, so we use a printf
// echoing a unique token instead — visible enough to detect, short enough
// to not pollute scrollback.
const token = `vrlatency-${Math.random().toString(36).slice(2, 10)}`;
const inputText = process.argv[4] || ` printf '${token}\\n'\r`;

const fullUrl = `${wsUrl}?sessionId=${encodeURIComponent(sessionId)}`;
const startMs = Date.now();
const ws = new WebSocket(fullUrl, { perMessageDeflate: false });

let snapshotEndAt = null;
let inputSentAt = null;
let firstTokenSeenAt = null;
let outputBuffer = "";
let snapshotBytesAccum = 0;
let snapshotChunks = 0;

const finish = (code, summary) => {
  if (summary) console.log(JSON.stringify(summary, null, 2));
  try { ws.close(); } catch {}
  setTimeout(() => process.exit(code), 50);
};

const timeout = setTimeout(() => {
  finish(2, {
    error: "timeout",
    snapshotEndAt,
    inputSentAt,
    firstTokenSeenAt,
    snapshotChunks,
    snapshotBytesAccum,
    outputTail: outputBuffer.slice(-200),
  });
}, 15_000);

ws.on("open", () => {
  console.error(`[probe] connected at ${Date.now() - startMs}ms`);
});

ws.on("message", (raw) => {
  const at = Date.now() - startMs;
  let payload;
  try { payload = JSON.parse(raw.toString()); } catch { return; }

  if (payload.type === "snapshot-chunk") {
    snapshotChunks += 1;
    snapshotBytesAccum += (payload.data || "").length;
    return;
  }
  if (payload.type === "snapshot-end" || payload.type === "snapshot") {
    snapshotEndAt = at;
    // Wait one tick to make sure we're not racing the server, then send input.
    setImmediate(() => {
      inputSentAt = Date.now() - startMs;
      ws.send(JSON.stringify({ type: "input", data: inputText }));
      console.error(`[probe] sent input at ${inputSentAt}ms`);
    });
    return;
  }
  if (payload.type === "output") {
    const data = payload.data || "";
    outputBuffer += data;
    if (firstTokenSeenAt === null && outputBuffer.includes(token)) {
      firstTokenSeenAt = at;
      const result = {
        url: fullUrl,
        sessionId,
        token,
        snapshotEndAt,
        snapshotChunks,
        snapshotBytesAccum,
        inputSentAt,
        firstTokenSeenAt,
        roundTripMs: firstTokenSeenAt - inputSentAt,
        outputBufferLen: outputBuffer.length,
      };
      clearTimeout(timeout);
      finish(0, result);
    }
  }
});

ws.on("error", (error) => {
  console.error(`[probe] error: ${error.message}`);
  finish(3);
});
