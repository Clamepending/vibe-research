import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAgentTownApi,
  normalizeWaitTimeoutMs,
  waitForAgentTownActionItemResolved,
} from "../src/research/agent-town-api.js";

test("normalizeAgentTownApi trims trailing slashes", () => {
  assert.equal(normalizeAgentTownApi(" http://example.test/api/agent-town/// "), "http://example.test/api/agent-town");
});

test("normalizeWaitTimeoutMs preserves zero and falls back for blanks", () => {
  assert.equal(normalizeWaitTimeoutMs("", 123), 123);
  assert.equal(normalizeWaitTimeoutMs("0", 123), 0);
  assert.equal(normalizeWaitTimeoutMs("42", 123), 42);
  assert.equal(normalizeWaitTimeoutMs("-1", 123), 123);
});

test("waitForAgentTownActionItemResolved chunks long waits until resolved", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          predicate: body.predicate,
          predicateParams: body.predicateParams,
          satisfied: calls.length >= 3,
        };
      },
    };
  };

  const result = await waitForAgentTownActionItemResolved({
    api: "http://agent-town.test/api/agent-town/",
    actionItemId: "review-1",
    timeoutMs: 50,
    chunkMs: 10,
    fetchImpl,
  });

  assert.equal(result.satisfied, true);
  assert.equal(result.waitAttempts, 3);
  assert.equal(result.waitChunked, true);
  assert.equal(result.requestedTimeoutMs, 50);
  assert.equal(result.waitChunkMs, 10);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "http://agent-town.test/api/agent-town/wait");
  assert.equal(calls[0].body.timeoutMs <= 10, true);
  assert.equal(calls[0].body.predicate, "action_item_resolved");
  assert.deepEqual(calls[0].body.predicateParams, { actionItemId: "review-1" });
});
