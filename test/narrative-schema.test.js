import assert from "node:assert/strict";
import test from "node:test";
import {
  NARRATIVE_FRAME_TYPES,
  NARRATIVE_SCHEMA_VERSION,
  applyNarrativeFrame,
  createInitialNarrativeState,
  makeNarrativeEventFrame,
  makeNarrativeInitFrame,
  normaliseNarrativeEntry,
  selectNarrativeEntries,
} from "../src/narrative-schema.js";

// ---------------------------------------------------------------------------
// normaliseNarrativeEntry: producer-side validator + canonicaliser
// ---------------------------------------------------------------------------

test("normaliseNarrativeEntry: requires id and a known kind", () => {
  assert.throws(() => normaliseNarrativeEntry({}), /kind is required/);
  assert.throws(() => normaliseNarrativeEntry({ kind: "potato" }), /unknown kind/);
  assert.throws(() => normaliseNarrativeEntry({ kind: "user" }), /id is required/);
});

test("normaliseNarrativeEntry: keeps the canonical core fields and drops unknown fields", () => {
  const out = normaliseNarrativeEntry({
    id: "u1",
    kind: "user",
    label: "You",
    text: "hi",
    timestamp: "2026-04-29T12:00:00Z",
    seq: 7,
    bogus: "should be dropped",
  });
  assert.deepEqual(out, {
    id: "u1",
    kind: "user",
    label: "You",
    text: "hi",
    timestamp: "2026-04-29T12:00:00Z",
    seq: 7,
    outputPreview: "",
  });
  assert.equal(out.bogus, undefined);
});

test("normaliseNarrativeEntry: imageRefs must be a string[] or absent (not on entry when empty)", () => {
  const out = normaliseNarrativeEntry({
    id: "a1", kind: "assistant", imageRefs: ["figures/x.png"],
  });
  assert.deepEqual(out.imageRefs, ["figures/x.png"]);

  const empty = normaliseNarrativeEntry({ id: "a2", kind: "assistant", imageRefs: [] });
  assert.equal(empty.imageRefs, undefined, "empty array should be omitted");

  assert.throws(() => normaliseNarrativeEntry({
    id: "a3", kind: "assistant", imageRefs: ["ok", 42],
  }), /imageRefs must be a string\[\]/);
});

test("normaliseNarrativeEntry: slashAction shape is enforced; label defaults to command", () => {
  const explicit = normaliseNarrativeEntry({
    id: "s1", kind: "status", slashAction: { command: "/login", label: "Sign in" },
  });
  assert.deepEqual(explicit.slashAction, { command: "/login", label: "Sign in" });

  const defaultedLabel = normaliseNarrativeEntry({
    id: "s2", kind: "status", slashAction: { command: "/login" },
  });
  assert.deepEqual(defaultedLabel.slashAction, { command: "/login", label: "/login" });

  assert.throws(() => normaliseNarrativeEntry({
    id: "s3", kind: "status", slashAction: { label: "no command" },
  }), /slashAction\.command is required/);
});

test("normaliseNarrativeEntry: mcp metadata requires both server and tool", () => {
  const out = normaliseNarrativeEntry({
    id: "t1", kind: "tool", mcp: { server: "filesystem", tool: "read_file" },
  });
  assert.deepEqual(out.mcp, { server: "filesystem", tool: "read_file" });

  assert.throws(() => normaliseNarrativeEntry({
    id: "t2", kind: "tool", mcp: { server: "filesystem" },
  }), /mcp\.tool is required/);
});

test("normaliseNarrativeEntry: todos array carries content/activeForm/status", () => {
  const out = normaliseNarrativeEntry({
    id: "t1", kind: "tool", label: "TodoWrite",
    todos: [
      { content: "Write tests", activeForm: "Writing tests", status: "in_progress" },
      { content: "Ship", activeForm: "Shipping" },
    ],
  });
  assert.equal(out.todos.length, 2);
  assert.equal(out.todos[0].status, "in_progress");
  assert.equal(out.todos[1].status, "pending", "missing status defaults to pending");
});

// ---------------------------------------------------------------------------
// Frame builders
// ---------------------------------------------------------------------------

test("makeNarrativeInitFrame stamps the schema version and accepts an entries snapshot", () => {
  const frame = makeNarrativeInitFrame({
    sessionId: "abc",
    entries: [
      { id: "u1", kind: "user", text: "hi" },
      { id: "a1", kind: "assistant", text: "hello" },
    ],
    lastSeq: 5,
  });
  assert.equal(frame.type, NARRATIVE_FRAME_TYPES.INIT);
  assert.equal(frame.sessionId, "abc");
  assert.equal(frame.schemaVersion, NARRATIVE_SCHEMA_VERSION);
  assert.equal(frame.lastSeq, 5);
  assert.equal(frame.entries.length, 2);
});

test("makeNarrativeEventFrame requires an entry on upsert and an entryId on remove", () => {
  const upsert = makeNarrativeEventFrame({
    sessionId: "abc", op: "upsert", seq: 7,
    entry: { id: "a1", kind: "assistant", text: "hi" },
  });
  assert.equal(upsert.op, "upsert");
  assert.equal(upsert.entry.id, "a1");

  const remove = makeNarrativeEventFrame({
    sessionId: "abc", op: "remove", entryId: "a1", seq: 8,
  });
  assert.equal(remove.op, "remove");
  assert.equal(remove.entryId, "a1");

  assert.throws(() => makeNarrativeEventFrame({ sessionId: "abc", op: "wat" }), /op must be/);
  assert.throws(() => makeNarrativeEventFrame({ sessionId: "abc", op: "upsert" }), /upsert requires an entry/);
  assert.throws(() => makeNarrativeEventFrame({ sessionId: "abc", op: "remove" }), /entryId is required/);
});

// ---------------------------------------------------------------------------
// applyNarrativeFrame: client-side reducer
// ---------------------------------------------------------------------------

test("reducer: init frame replaces state with the snapshot", () => {
  const state = applyNarrativeFrame(createInitialNarrativeState(), makeNarrativeInitFrame({
    sessionId: "s",
    lastSeq: 3,
    entries: [
      { id: "u1", kind: "user", text: "hi" },
      { id: "a1", kind: "assistant", text: "hello" },
    ],
  }));
  assert.equal(state.lastSeq, 3);
  assert.equal(state.order.length, 2);
  assert.deepEqual(state.order, ["u1", "a1"]);
});

test("reducer: upsert appends new entries in order", () => {
  let state = applyNarrativeFrame(createInitialNarrativeState(), makeNarrativeInitFrame({
    sessionId: "s", lastSeq: 0, entries: [{ id: "u1", kind: "user", text: "hi" }],
  }));
  state = applyNarrativeFrame(state, makeNarrativeEventFrame({
    sessionId: "s", op: "upsert", seq: 1,
    entry: { id: "a1", kind: "assistant", text: "" },
  }));
  state = applyNarrativeFrame(state, makeNarrativeEventFrame({
    sessionId: "s", op: "upsert", seq: 2,
    entry: { id: "a1", kind: "assistant", text: "streaming text…" },
  }));
  const entries = selectNarrativeEntries(state);
  assert.equal(entries.length, 2, "upsert on existing id mutates in place");
  assert.equal(entries[1].text, "streaming text…");
  assert.equal(state.lastSeq, 2);
});

test("reducer: out-of-order or duplicate seq is dropped", () => {
  let state = applyNarrativeFrame(createInitialNarrativeState(), makeNarrativeInitFrame({
    sessionId: "s", lastSeq: 5, entries: [],
  }));
  state = applyNarrativeFrame(state, makeNarrativeEventFrame({
    sessionId: "s", op: "upsert", seq: 4,
    entry: { id: "a1", kind: "assistant", text: "stale" },
  }));
  assert.equal(selectNarrativeEntries(state).length, 0, "stale seq dropped");
  assert.equal(state.lastSeq, 5);
});

test("reducer: remove frame deletes the entry and tightens the order", () => {
  let state = applyNarrativeFrame(createInitialNarrativeState(), makeNarrativeInitFrame({
    sessionId: "s", lastSeq: 0,
    entries: [
      { id: "u1", kind: "user", text: "hi" },
      { id: "a1", kind: "assistant", text: "hello" },
      { id: "a2", kind: "assistant", text: "follow-up" },
    ],
  }));
  state = applyNarrativeFrame(state, makeNarrativeEventFrame({
    sessionId: "s", op: "remove", entryId: "a1", seq: 1,
  }));
  const entries = selectNarrativeEntries(state);
  assert.deepEqual(entries.map((e) => e.id), ["u1", "a2"]);
});

test("reducer: schema invariant — selectNarrativeEntries returns canonical entries with structured fields preserved", () => {
  let state = applyNarrativeFrame(createInitialNarrativeState(), makeNarrativeInitFrame({
    sessionId: "s", lastSeq: 0,
    entries: [
      { id: "p1", kind: "plan", text: "Step A\nStep B", label: "Plan" },
      { id: "t1", kind: "tool", label: "filesystem.read_file", text: "/tmp/x", mcp: { server: "filesystem", tool: "read_file" } },
      { id: "s1", kind: "status", text: "auth_failed", slashAction: { command: "/login", label: "Sign in" } },
    ],
  }));
  const entries = selectNarrativeEntries(state);
  assert.equal(entries[0].kind, "plan");
  assert.deepEqual(entries[1].mcp, { server: "filesystem", tool: "read_file" });
  assert.deepEqual(entries[2].slashAction, { command: "/login", label: "Sign in" });
});
