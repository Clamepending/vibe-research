// Wire-format contract for native UI narrative entries.
//
// One source of truth for the shape that flows from the server-side
// narrative shaper / stream session through the WebSocket onto the client
// renderer. Both producers and consumers import from here, so the
// discriminated union below is the schema both sides agree on.
//
// We pin a `NARRATIVE_SCHEMA_VERSION` so the wire format can evolve. The
// initial release was implicit v1 (no field). v2 is the first version with
// structured `imageRefs`, `slashAction`, `thinking`, `mcp`, and `kind:
// "plan"` fields. The validator at the bottom of this file takes a raw
// entry and returns the canonical normalised entry, or throws — used by
// producers to fail loudly when an entry shape drifts out of contract.
//
// Why a hand-rolled validator over Zod or io-ts: this module is loaded by
// both the server and the browser bundle; a third-party schema lib pulls
// in a kilobyte+ and a dependency we don't otherwise need. The validator
// is ~40 lines of JS and gets us the same invariants.

export const NARRATIVE_SCHEMA_VERSION = 2;

// The discriminated union by `kind`. Every kind has a fixed core shape
// (id, kind, text, timestamp, seq) and a kind-specific tail. The
// validator below enforces the contract; the renderer dispatches on `kind`.
export const ENTRY_KINDS = Object.freeze({
  USER: "user",
  ASSISTANT: "assistant",
  TOOL: "tool",
  STATUS: "status",
  SYSTEM: "system",
  PLAN: "plan",
});

const VALID_KINDS = new Set(Object.values(ENTRY_KINDS));

// Status values flow through to renderer CSS classes. Loose union — we
// only enforce the kind discriminant, the rest is lint-not-error.
const KNOWN_STATUSES = new Set(["running", "done", "error", "pending"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function ensureString(value, fieldName, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new Error(`narrative entry: ${fieldName} is required`);
    }
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError(`narrative entry: ${fieldName} must be a string, got ${typeof value}`);
  }
  return value;
}

// Validates and normalises a raw entry from a producer. Returns a fresh
// object with only the schema-known fields, in canonical order. Throws
// on anything that violates the contract — producers should fail loudly
// rather than silently emitting a malformed entry.
export function normaliseNarrativeEntry(rawEntry) {
  if (!isPlainObject(rawEntry)) {
    throw new TypeError("narrative entry must be a plain object");
  }

  const kind = ensureString(rawEntry.kind, "kind", { required: true });
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`narrative entry: unknown kind "${kind}" (valid: ${[...VALID_KINDS].join(", ")})`);
  }

  const id = ensureString(rawEntry.id, "id", { required: true });
  const label = ensureString(rawEntry.label, "label");
  const text = typeof rawEntry.text === "string" ? rawEntry.text : "";
  const timestamp = ensureString(rawEntry.timestamp, "timestamp");
  const seq = Number.isFinite(rawEntry.seq) ? Number(rawEntry.seq) : 0;
  const status = ensureString(rawEntry.status, "status");
  const meta = ensureString(rawEntry.meta, "meta");

  if (status && !KNOWN_STATUSES.has(status)) {
    // Lint, not error — status strings are CSS hooks; an unknown one renders
    // a generic class. Console-warn so producers can fix without breaking
    // the pipeline.
    if (typeof console !== "undefined" && console.warn) {
      console.warn(`[narrative-schema] entry ${id} has unknown status "${status}"`);
    }
  }

  const out = { id, kind, label, text, timestamp, seq };
  if (status) out.status = status;
  if (meta) out.meta = meta;

  // Optional fields, all kind-aware. We don't enforce "this field can only
  // appear on this kind" because the renderer is permissive — but the docs
  // below tell producers which kinds carry which fields.

  // String[] of image paths — assistant text mentioning a saved figure,
  // tool input naming an image path, user attachments via markdown syntax.
  if (rawEntry.imageRefs !== undefined) {
    if (!isStringArray(rawEntry.imageRefs)) {
      throw new TypeError(`narrative entry ${id}: imageRefs must be a string[]`);
    }
    if (rawEntry.imageRefs.length) {
      out.imageRefs = rawEntry.imageRefs.slice();
    }
  }

  // {command, label} — set on status/system entries that ask the user to
  // run a slash command.
  if (rawEntry.slashAction !== undefined && rawEntry.slashAction !== null) {
    if (!isPlainObject(rawEntry.slashAction)) {
      throw new TypeError(`narrative entry ${id}: slashAction must be {command, label}`);
    }
    const command = ensureString(rawEntry.slashAction.command, "slashAction.command", { required: true });
    const slashLabel = ensureString(rawEntry.slashAction.label, "slashAction.label") || command;
    out.slashAction = { command, label: slashLabel };
  }

  // boolean flag for "this is real reasoning content" vs the empty-text
  // pending-placeholder spinner.
  if (rawEntry.thinking === true) {
    out.thinking = true;
  }

  // {server, tool} — set on tool entries whose underlying tool is an MCP
  // call (`mcp__<server>__<tool>`).
  if (rawEntry.mcp !== undefined && rawEntry.mcp !== null) {
    if (!isPlainObject(rawEntry.mcp)) {
      throw new TypeError(`narrative entry ${id}: mcp must be {server, tool}`);
    }
    out.mcp = {
      server: ensureString(rawEntry.mcp.server, "mcp.server", { required: true }),
      tool: ensureString(rawEntry.mcp.tool, "mcp.tool", { required: true }),
    };
  }

  // [{content, activeForm, status}] — present on TodoWrite/TaskUpdate tool
  // entries so the client can render a real checklist.
  if (rawEntry.todos !== undefined) {
    if (!Array.isArray(rawEntry.todos)) {
      throw new TypeError(`narrative entry ${id}: todos must be an array`);
    }
    out.todos = rawEntry.todos.map((todo, index) => {
      if (!isPlainObject(todo)) {
        throw new TypeError(`narrative entry ${id}: todos[${index}] must be a plain object`);
      }
      return {
        content: ensureString(todo.content, `todos[${index}].content`),
        activeForm: ensureString(todo.activeForm, `todos[${index}].activeForm`),
        status: ensureString(todo.status, `todos[${index}].status`) || "pending",
      };
    });
  }

  // Free-form preview text shown under tool entries.
  if (rawEntry.outputPreview !== undefined && rawEntry.outputPreview !== null) {
    out.outputPreview = ensureString(rawEntry.outputPreview, "outputPreview");
  } else {
    out.outputPreview = "";
  }

  return out;
}

// Wire-format frames the WebSocket carries for narrative state. The
// existing `{type: "session"}` meta-broadcast lives alongside these — it
// carries session-level fields (subagents, backgroundActivity, streamMode)
// that aren't entry data.
//
//   narrative-init     full snapshot of the session's entries; sent on
//                      connect and on snapshot-end so the client can warm
//                      its reducer state with a coherent baseline.
//   narrative-event    per-entry upsert/remove. The reducer applies these
//                      to the in-memory state. seq is monotonic per
//                      sessionId so the client can detect dropped frames.
//
// Both shapes are versioned via NARRATIVE_SCHEMA_VERSION so a server
// upgrade can land without bricking older browsers in flight; the client
// reducer falls back to the HTTP narrative fetch when it sees a higher
// schemaVersion than it knows.
export const NARRATIVE_FRAME_TYPES = Object.freeze({
  INIT: "narrative-init",
  EVENT: "narrative-event",
});

export function makeNarrativeInitFrame({ sessionId, entries, lastSeq }) {
  return {
    type: NARRATIVE_FRAME_TYPES.INIT,
    sessionId: String(sessionId || ""),
    schemaVersion: NARRATIVE_SCHEMA_VERSION,
    lastSeq: Number.isFinite(lastSeq) ? Number(lastSeq) : 0,
    entries: Array.isArray(entries) ? entries.map(normaliseNarrativeEntry) : [],
  };
}

export function makeNarrativeEventFrame({ sessionId, op, entry, entryId, seq }) {
  if (op !== "upsert" && op !== "remove") {
    throw new Error(`makeNarrativeEventFrame: op must be "upsert" or "remove", got ${op}`);
  }
  const frame = {
    type: NARRATIVE_FRAME_TYPES.EVENT,
    sessionId: String(sessionId || ""),
    schemaVersion: NARRATIVE_SCHEMA_VERSION,
    op,
    seq: Number.isFinite(seq) ? Number(seq) : 0,
  };
  if (op === "upsert") {
    if (!entry) {
      throw new Error("makeNarrativeEventFrame: upsert requires an entry");
    }
    frame.entry = normaliseNarrativeEntry(entry);
  } else {
    frame.entryId = ensureString(entryId, "entryId", { required: true });
  }
  return frame;
}

// Reducer the client uses to fold narrative frames into UI state. Pure,
// testable, doesn't touch the DOM — the renderer reads from the state
// it produces. Keeps a `lastSeq` so the client can detect a gap and
// resync via the HTTP narrative endpoint.
//
// State shape:
//   { entries: Map<entryId, entry>, order: entryId[], lastSeq, schemaVersion }
//
// We use a Map + ordered id array (rather than a flat array) so upsert
// is O(1) on entryId — the alternative is a linear scan, which gets bad
// when an entry near the top of the buffer mutates while 90 entries below
// it stay put.
export function createInitialNarrativeState() {
  return {
    entries: new Map(),
    order: [],
    lastSeq: 0,
    schemaVersion: NARRATIVE_SCHEMA_VERSION,
  };
}

export function applyNarrativeFrame(state, frame) {
  if (!isPlainObject(frame)) {
    return state;
  }

  if (frame.type === NARRATIVE_FRAME_TYPES.INIT) {
    const next = createInitialNarrativeState();
    next.lastSeq = Number(frame.lastSeq || 0);
    next.schemaVersion = Number(frame.schemaVersion || NARRATIVE_SCHEMA_VERSION);
    for (const entry of frame.entries || []) {
      next.entries.set(entry.id, entry);
      next.order.push(entry.id);
    }
    return next;
  }

  if (frame.type === NARRATIVE_FRAME_TYPES.EVENT) {
    const seq = Number(frame.seq || 0);
    if (seq <= state.lastSeq && seq !== 0) {
      // Out-of-order or duplicate; drop. (seq=0 is "no sequence assigned",
      // accept as a special case — used by some legacy paths.)
      return state;
    }
    const entries = new Map(state.entries);
    const order = state.order.slice();
    if (frame.op === "upsert") {
      const entry = frame.entry;
      if (!entry || !entry.id) return state;
      if (!entries.has(entry.id)) {
        order.push(entry.id);
      }
      entries.set(entry.id, entry);
    } else if (frame.op === "remove") {
      if (entries.delete(frame.entryId)) {
        const idx = order.indexOf(frame.entryId);
        if (idx >= 0) order.splice(idx, 1);
      }
    }
    return {
      entries,
      order,
      lastSeq: Math.max(state.lastSeq, seq),
      schemaVersion: state.schemaVersion,
    };
  }

  return state;
}

// Materialise the current entries in order — what the renderer iterates.
export function selectNarrativeEntries(state) {
  if (!state || !state.order) return [];
  const entries = state.entries instanceof Map ? state.entries : new Map(Object.entries(state.entries || {}));
  return state.order.map((id) => entries.get(id)).filter(Boolean);
}
