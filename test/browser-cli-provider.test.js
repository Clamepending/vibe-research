import assert from "node:assert/strict";
import test from "node:test";
import { inferVisionProviderFromCommandText } from "../src/browser-cli.js";

test("inferVisionProviderFromCommandText recognizes Claude executables", () => {
  assert.equal(inferVisionProviderFromCommandText("/opt/homebrew/bin/claude -p hello"), "claude");
  assert.equal(
    inferVisionProviderFromCommandText("/Users/mark/Desktop/projects/remote-vibes/bin/claude --print hello"),
    "claude",
  );
});

test("inferVisionProviderFromCommandText recognizes Codex executables", () => {
  assert.equal(
    inferVisionProviderFromCommandText("/Applications/Codex.app/Contents/Resources/codex exec hello"),
    "codex",
  );
  assert.equal(
    inferVisionProviderFromCommandText("/Users/mark/Desktop/projects/remote-vibes/bin/codex exec hello"),
    "codex",
  );
});

test("inferVisionProviderFromCommandText ignores unrelated command text", () => {
  assert.equal(
    inferVisionProviderFromCommandText("/bin/zsh -lc rv-browser describe-file eval/final.png"),
    null,
  );
  assert.equal(
    inferVisionProviderFromCommandText("/private/tmp/remote-vibes-live-codex-123/eval/report.md"),
    null,
  );
});
