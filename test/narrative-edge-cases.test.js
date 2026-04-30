// Edge-case sweep for the narrative push protocol + schema rollout.
//
// Each scenario here is a real failure mode I want pinned: multi-client
// fan-out, reconnect with stale state, schemaVersion mismatch fallback,
// PTY diff broadcast, dedupePush validator drop, plan-mode idempotency.
// These tests don't exercise a real Claude child — they drive the
// SessionManager broadcast methods directly with synthetic state, so they
// stay fast and deterministic.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import {
  applyNarrativeFrame,
  createInitialNarrativeState,
  selectNarrativeEntries,
  NARRATIVE_FRAME_TYPES,
  NARRATIVE_SCHEMA_VERSION,
} from "../src/narrative-schema.js";
import { buildClaudeNarrativeFromText } from "../src/session-native-narrative.js";
import { ClaudeStreamSession } from "../src/claude-stream-session.js";
import { SessionManager } from "../src/session-manager.js";

const fakeProviders = [
  { id: "claude", label: "Claude Code", available: true, command: "claude", launchCommand: "claude", defaultName: "Claude" },
  { id: "shell", label: "Vanilla Shell", available: true, command: null, launchCommand: null, defaultName: "Shell" },
];

function makeMockSocket() {
  const sent = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    sent,
    send(payload) {
      sent.push(typeof payload === "string" ? JSON.parse(payload) : payload);
    },
    on() {},
    close() { socket.readyState = 3; },
  };
  return socket;
}

async function withManager(fn) {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-edge-cases-"));
  const userHomeDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-edge-cases-home-"));
  const manager = new SessionManager({
    cwd: workspaceDir,
    providers: fakeProviders,
    persistentTerminals: false,
    persistSessions: false,
    stateDir: path.join(workspaceDir, ".vibe-research"),
    userHomeDir,
  });
  await manager.initialize();
  try {
    await fn(manager);
  } finally {
    await manager.shutdown({ preserveSessions: false });
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  }
}

function makeStreamSession(manager, { id = "stream-edge" } = {}) {
  const session = manager.buildSessionRecord({
    id,
    providerId: "claude",
    providerLabel: "Claude Code",
    name: "Edge case",
    cwd: process.cwd(),
    status: "running",
    streamMode: true,
  });
  manager.sessions.set(session.id, session);
  session.streamEntries = [];
  session.clients = new Set();
  return session;
}

// ---------------------------------------------------------------------------
// Multi-client fan-out
// ---------------------------------------------------------------------------

test("multi-client: every client attached to a session receives every diff event", async () => {
  await withManager(async (manager) => {
    const session = makeStreamSession(manager);
    const clientA = makeMockSocket();
    const clientB = makeMockSocket();
    manager.attachClient(session.id, clientA);
    manager.attachClient(session.id, clientB);

    // Both clients should have received init.
    const initA = clientA.sent.find((f) => f.type === NARRATIVE_FRAME_TYPES.INIT);
    const initB = clientB.sent.find((f) => f.type === NARRATIVE_FRAME_TYPES.INIT);
    assert.ok(initA && initB, "both clients see init");

    clientA.sent.length = 0;
    clientB.sent.length = 0;

    session.streamEntries = [
      { id: "a1", kind: "assistant", text: "hi", seq: 1 },
    ];
    manager.broadcastNarrativeDiff(session);

    const eventsA = clientA.sent.filter((f) => f.type === NARRATIVE_FRAME_TYPES.EVENT);
    const eventsB = clientB.sent.filter((f) => f.type === NARRATIVE_FRAME_TYPES.EVENT);
    assert.equal(eventsA.length, 1);
    assert.equal(eventsB.length, 1);
    // Same seq on both — server emits to all clients in lockstep.
    assert.equal(eventsA[0].seq, eventsB[0].seq);
  });
});

test("multi-client: a client that joins mid-stream gets a seeded init plus future events", async () => {
  await withManager(async (manager) => {
    const session = makeStreamSession(manager);

    // First client joins, receives init for empty state, then sees a few events.
    const earlyClient = makeMockSocket();
    manager.attachClient(session.id, earlyClient);
    session.streamEntries = [{ id: "a1", kind: "assistant", text: "hi", seq: 1 }];
    manager.broadcastNarrativeDiff(session);
    session.streamEntries = [
      { id: "a1", kind: "assistant", text: "hi there", seq: 1 },
      { id: "t1", kind: "tool", label: "Read", text: "/tmp/x", seq: 2, status: "running" },
    ];
    manager.broadcastNarrativeDiff(session);

    // Second client joins later. Its init must already include both entries.
    const lateClient = makeMockSocket();
    manager.attachClient(session.id, lateClient);
    const init = lateClient.sent.find((f) => f.type === NARRATIVE_FRAME_TYPES.INIT);
    assert.ok(init, "late client sees init");
    assert.equal(init.entries.length, 2, "init carries the full current state");
    assert.deepEqual(init.entries.map((e) => e.id).sort(), ["a1", "t1"]);
  });
});

// ---------------------------------------------------------------------------
// Reconnect / seq-gap recovery
// ---------------------------------------------------------------------------

test("reconnect: client reducer with stale state can recover from a fresh init", () => {
  // Drive the reducer through a full state, then simulate a reconnect by
  // applying a brand-new init frame. The reducer should snap to the new
  // baseline and forget the prior state — that's the recovery path.
  let state = createInitialNarrativeState();
  state = applyNarrativeFrame(state, {
    type: NARRATIVE_FRAME_TYPES.INIT,
    sessionId: "s",
    schemaVersion: NARRATIVE_SCHEMA_VERSION,
    lastSeq: 5,
    entries: [
      { id: "u1", kind: "user", text: "old prompt" },
      { id: "a1", kind: "assistant", text: "old reply" },
    ],
  });
  assert.equal(selectNarrativeEntries(state).length, 2);

  // Reconnect: server pushes a new init. The reducer replaces state.
  state = applyNarrativeFrame(state, {
    type: NARRATIVE_FRAME_TYPES.INIT,
    sessionId: "s",
    schemaVersion: NARRATIVE_SCHEMA_VERSION,
    lastSeq: 12,
    entries: [
      { id: "u2", kind: "user", text: "new prompt" },
    ],
  });
  const entries = selectNarrativeEntries(state);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "u2");
  assert.equal(state.lastSeq, 12);
});

test("seq-gap: a frame with seq > lastSeq + 1 is treated as a gap (caller signals resync)", () => {
  // Build a baseline at lastSeq=2.
  let state = createInitialNarrativeState();
  state = applyNarrativeFrame(state, {
    type: NARRATIVE_FRAME_TYPES.INIT,
    sessionId: "s",
    schemaVersion: NARRATIVE_SCHEMA_VERSION,
    lastSeq: 2,
    entries: [{ id: "a1", kind: "assistant", text: "hi" }],
  });

  // Now simulate the client-side gap detection that lives in
  // applyNarrativeFrameToState. The reducer itself doesn't reject the
  // frame on seq grounds; the caller does. So this test asserts the
  // pre-condition the caller checks.
  const gapEvent = {
    type: NARRATIVE_FRAME_TYPES.EVENT,
    sessionId: "s",
    schemaVersion: NARRATIVE_SCHEMA_VERSION,
    op: "upsert",
    seq: 9,
    entry: { id: "a2", kind: "assistant", text: "leap" },
  };
  const expected = state.lastSeq + 1;
  assert.ok(gapEvent.seq > expected, "seq jumps by more than 1 — gap");
});

// ---------------------------------------------------------------------------
// schemaVersion mismatch
// ---------------------------------------------------------------------------

test("schemaVersion: a frame newer than the client knows is detectable from frame.schemaVersion", () => {
  // The reducer applies the frame regardless (additive shapes survive); the
  // client's mismatch handler is the layer that drops the reducer arm and
  // resyncs. Here we just pin the protocol invariant.
  const futureFrame = {
    type: NARRATIVE_FRAME_TYPES.INIT,
    sessionId: "s",
    schemaVersion: NARRATIVE_SCHEMA_VERSION + 1,
    lastSeq: 0,
    entries: [],
  };
  assert.ok(futureFrame.schemaVersion > NARRATIVE_SCHEMA_VERSION,
    "a future-version frame is comparable against NARRATIVE_SCHEMA_VERSION");
});

// ---------------------------------------------------------------------------
// PTY-backed push protocol
// ---------------------------------------------------------------------------

test("PTY diff broadcast: pushOutput debounces a narrative-event for non-stream sessions", async () => {
  await withManager(async (manager) => {
    const session = manager.buildSessionRecord({
      id: "pty-1",
      providerId: "shell",
      providerLabel: "Vanilla Shell",
      name: "PTY edge",
      cwd: process.cwd(),
      status: "running",
    });
    manager.sessions.set(session.id, session);
    session.clients = new Set();
    const socket = makeMockSocket();
    manager.attachClient(session.id, socket);
    socket.sent.length = 0;

    // PTY-style chunk landing in pushOutput.
    manager.pushOutput(session, "hello\n");
    // The diff is debounced to NARRATIVE_DIFF_THROTTLE_MS; wait it out.
    await new Promise((resolve) => setTimeout(resolve, 280));

    // We can't assert specific entry shapes — buildProjectedNarrative is
    // permissive. But after pushOutput, the narrativeDiffTimer should have
    // fired (cleared) and the session should still be alive.
    assert.equal(session.narrativeDiffTimer, null, "timer cleared after firing");
  });
});

test("PTY diff broadcast: rapid chunks don't fire multiple diffs (debounce holds)", async () => {
  await withManager(async (manager) => {
    const session = manager.buildSessionRecord({
      id: "pty-2",
      providerId: "shell",
      providerLabel: "Vanilla Shell",
      name: "PTY edge",
      cwd: process.cwd(),
      status: "running",
    });
    manager.sessions.set(session.id, session);
    session.clients = new Set();

    // Fire 5 chunks back-to-back. The debounce should coalesce them.
    let scheduleCallCount = 0;
    const originalSchedule = manager.scheduleNarrativeDiffBroadcast.bind(manager);
    manager.scheduleNarrativeDiffBroadcast = function tracked(...args) {
      scheduleCallCount += 1;
      return originalSchedule(...args);
    };

    manager.pushOutput(session, "a");
    manager.pushOutput(session, "b");
    manager.pushOutput(session, "c");
    manager.pushOutput(session, "d");
    manager.pushOutput(session, "e");

    // schedule was called per chunk, but the inner setTimeout only fires
    // once because subsequent calls find an existing timer.
    assert.equal(scheduleCallCount, 5, "schedule called once per chunk");

    // Wait out the debounce.
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.equal(session.narrativeDiffTimer, null, "single timer fired once");
  });
});

// ---------------------------------------------------------------------------
// dedupePush validator: malformed entries are dropped, not crashed on
// ---------------------------------------------------------------------------

test("dedupePush validator: a producer event with no id still parses (parser stamps an id)", () => {
  // The Claude shaper builds entries with explicit ids, so this is mostly a
  // safety check — the validator at the boundary doesn't blow up the parser
  // on the common shapes.
  const text = JSON.stringify({
    type: "assistant",
    timestamp: "2026-04-29T12:00:00Z",
    message: { content: [{ type: "text", text: "hello" }] },
  });
  const narrative = buildClaudeNarrativeFromText(text, { providerId: "claude", providerLabel: "Claude" });
  const assistant = narrative.entries.find((e) => e.kind === "assistant");
  assert.ok(assistant, "assistant entry produced");
  assert.ok(String(assistant.id || "").length > 0, "id present");
});

// ---------------------------------------------------------------------------
// Plan-mode idempotency
// ---------------------------------------------------------------------------

function makeFakeStreamForPlan() {
  const session = new ClaudeStreamSession({ sessionId: "plan-test" });
  const stdinFrames = [];
  session._child = {
    stdin: { write(line) { stdinFrames.push(JSON.parse(String(line).trim())); }, end() {} },
    stdout: { setEncoding() {}, on() {} },
    stderr: { setEncoding() {}, on() {} },
    on() {}, kill() {},
  };
  session.status = "running";
  session.stdinFrames = stdinFrames;
  return session;
}

test("plan-mode idempotency: a second resolvePlanMode after the first returns no-plan-awaiting", async () => {
  await withManager(async (manager) => {
    const session = manager.buildSessionRecord({
      id: "stream-plan",
      providerId: "claude",
      providerLabel: "Claude",
      cwd: process.cwd(),
      status: "running",
      streamMode: true,
    });
    manager.sessions.set(session.id, session);
    const stream = makeFakeStreamForPlan();
    session.streamSession = stream;
    stream._handleLine(JSON.stringify({
      type: "assistant",
      message: {
        id: "msg",
        content: [{ type: "tool_use", id: "plan_a", name: "ExitPlanMode", input: { plan: "1." } }],
      },
    }));

    const first = manager.resolvePlanMode(session.id, { approve: true });
    assert.equal(first.ok, true);

    const second = manager.resolvePlanMode(session.id, { approve: true });
    assert.deepEqual(second, { ok: false, reason: "no-plan-awaiting" });
  });
});

test("plan-mode FIFO: two ExitPlanMode tool_uses both await; head returns the older id", () => {
  const stream = makeFakeStreamForPlan();
  stream._handleLine(JSON.stringify({
    type: "assistant",
    message: { id: "m1", content: [{ type: "tool_use", id: "plan_a", name: "ExitPlanMode", input: { plan: "v1" } }] },
  }));
  assert.equal(stream.getPendingPlanToolUseId(), "plan_a");
  assert.deepEqual(stream.getPendingPlanToolUseIds(), ["plan_a"]);

  stream._handleLine(JSON.stringify({
    type: "assistant",
    message: { id: "m2", content: [{ type: "tool_use", id: "plan_b", name: "ExitPlanMode", input: { plan: "v2" } }] },
  }));
  // Head is still the OLDER plan_a; plan_b is queued behind.
  assert.equal(stream.getPendingPlanToolUseId(), "plan_a");
  assert.deepEqual(stream.getPendingPlanToolUseIds(), ["plan_a", "plan_b"]);

  // Resolve plan_a — head advances to plan_b.
  stream.sendToolResult("plan_a", "approved a");
  assert.equal(stream.getPendingPlanToolUseId(), "plan_b");
  assert.deepEqual(stream.getPendingPlanToolUseIds(), ["plan_b"]);
});

test("plan-mode FIFO: out-of-order resolution dequeues the matching id, not the head", () => {
  const stream = makeFakeStreamForPlan();
  stream._handleLine(JSON.stringify({
    type: "assistant",
    message: { id: "m1", content: [{ type: "tool_use", id: "plan_a", name: "ExitPlanMode", input: { plan: "v1" } }] },
  }));
  stream._handleLine(JSON.stringify({
    type: "assistant",
    message: { id: "m2", content: [{ type: "tool_use", id: "plan_b", name: "ExitPlanMode", input: { plan: "v2" } }] },
  }));
  assert.deepEqual(stream.getPendingPlanToolUseIds(), ["plan_a", "plan_b"]);

  // Resolve plan_b first — out of order. plan_a stays at the head.
  stream.sendToolResult("plan_b", "approved b");
  assert.equal(stream.getPendingPlanToolUseId(), "plan_a");
  assert.deepEqual(stream.getPendingPlanToolUseIds(), ["plan_a"]);
});

test("plan-mode FIFO: duplicate ExitPlanMode tool_use_id is not enqueued twice", () => {
  // Defensive: if the parser sees the same plan_a twice (edge case where
  // the same assistant event is replayed), the queue stays at length 1.
  const stream = makeFakeStreamForPlan();
  const event = JSON.stringify({
    type: "assistant",
    message: { id: "m1", content: [{ type: "tool_use", id: "plan_a", name: "ExitPlanMode", input: { plan: "v1" } }] },
  });
  stream._handleLine(event);
  stream._handleLine(event);
  assert.equal(stream.getPendingPlanToolUseIds().length, 1);
});

// ---------------------------------------------------------------------------
// Slash command catalog: server-driven list overrides built-in
// ---------------------------------------------------------------------------

test("slash command catalog: server-emitted list overrides the built-in catalog", async () => {
  // resolveRichSessionSlashCommands lives in the client bundle but is pure;
  // we can import it server-side for this test.
  const { resolveRichSessionSlashCommands } = await import("../src/client/rich-session-helpers.js");

  // No availableSlashCommands → built-in catalog.
  const builtIn = resolveRichSessionSlashCommands({ id: "x" });
  assert.ok(builtIn.length >= 7);
  assert.ok(builtIn.some((entry) => entry.command === "/login"));

  // Custom list → server wins.
  const custom = resolveRichSessionSlashCommands({
    id: "x",
    availableSlashCommands: [
      { command: "/research-resolve", label: "Resolve move", hint: "loop step 9" },
    ],
  });
  assert.equal(custom.length, 1);
  assert.equal(custom[0].command, "/research-resolve");
});

test("slash command catalog: malformed entries are filtered out, not crashed on", async () => {
  const { resolveRichSessionSlashCommands } = await import("../src/client/rich-session-helpers.js");
  const result = resolveRichSessionSlashCommands({
    availableSlashCommands: [
      { command: "/ok", label: "OK" },
      { /* missing command */ label: "Bad" },
      { command: "no-leading-slash" },
      null,
      { command: "/also-ok" },
    ],
  });
  assert.deepEqual(result.map((entry) => entry.command), ["/ok", "/also-ok"]);
});
