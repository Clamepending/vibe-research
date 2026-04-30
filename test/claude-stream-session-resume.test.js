// Stream-mode sessions need to survive a server restart so users don't
// lose conversation history every time Vibe Research updates. Claude CLI
// stores the JSONL transcript at ~/.claude/projects/<cwd>/<id>.jsonl;
// passing `--resume <id>` reloads it into a fresh child process. These
// tests pin the launch-arg construction so a future refactor cannot
// silently regress to the old "--session-id only" behavior.

import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeStreamSession } from "../src/claude-stream-session.js";

test("buildLaunchArgs: fresh session uses --session-id (stamps the id on a new transcript)", () => {
  const stream = new ClaudeStreamSession({ sessionId: "fresh-abc" });
  const args = stream.buildLaunchArgs();
  assert.ok(args.includes("--session-id"), "fresh session must pass --session-id");
  assert.ok(!args.includes("--resume"), "fresh session must NOT pass --resume");
  const idIdx = args.indexOf("--session-id");
  assert.equal(args[idIdx + 1], "fresh-abc");
});

test("buildLaunchArgs: resume:true swaps to --resume (loads the prior JSONL)", () => {
  const stream = new ClaudeStreamSession({ sessionId: "resumed-abc", resume: true });
  const args = stream.buildLaunchArgs();
  assert.ok(args.includes("--resume"), "restored session must pass --resume");
  assert.ok(!args.includes("--session-id"), "restored session must NOT pass --session-id (Claude CLI rejects both)");
  const idIdx = args.indexOf("--resume");
  assert.equal(args[idIdx + 1], "resumed-abc");
});

test("buildLaunchArgs: stream-json input/output and verbose flags are always present", () => {
  const stream = new ClaudeStreamSession({ sessionId: "x" });
  const args = stream.buildLaunchArgs();
  assert.ok(args.includes("--input-format") && args[args.indexOf("--input-format") + 1] === "stream-json");
  assert.ok(args.includes("--output-format") && args[args.indexOf("--output-format") + 1] === "stream-json");
  assert.ok(args.includes("--verbose"));
  assert.ok(args.includes("--include-partial-messages"));
});

test("buildLaunchArgs: bypassPermissions=false omits --dangerously-skip-permissions", () => {
  const stream = new ClaudeStreamSession({ sessionId: "x", bypassPermissions: false });
  const args = stream.buildLaunchArgs();
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

test("buildLaunchArgs: extraArgs are appended verbatim", () => {
  const stream = new ClaudeStreamSession({ sessionId: "x", extraArgs: ["--model", "claude-haiku-4-5-20251001"] });
  const args = stream.buildLaunchArgs();
  const modelIdx = args.indexOf("--model");
  assert.ok(modelIdx > 0, "--model present");
  assert.equal(args[modelIdx + 1], "claude-haiku-4-5-20251001");
});
