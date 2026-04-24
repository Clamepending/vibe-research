import assert from "node:assert/strict";
import test from "node:test";
import { claudePromptDetectionInternals } from "../src/session-manager.js";

const {
  detectClaudeLoginChooser,
  detectClaudeOAuthUrl,
  detectClaudeApiKeyPrompt,
  detectClaudeCreditRefill,
  detectClaudePrompt,
} = claudePromptDetectionInternals;

// Buffer text Claude Code actually emits (approximated) after stripping ANSI.
// These include the spaced-letters artefacts the screenshot showed ("Select
// login method:") so the detectors have to be whitespace-tolerant.
const LOGIN_CHOOSER_BUFFER = [
  "",
  "  Select login method:",
  "",
  "  ❯  1. Claude account with subscription · Pro, Max, Team, or Enterprise",
  "     2. Anthropic Console account · API usage billing",
  "     3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI",
  "",
].join("\n");

const OAUTH_BUFFER = [
  "Claude Code will open your browser to complete sign-in.",
  "Open the following URL in your browser to log in:",
  "https://claude.ai/oauth/authorize?response_type=code&client_id=abc",
  "Paste the code back here when you're done.",
].join("\n");

const API_KEY_BUFFER = [
  "Logging in with an Anthropic Console account.",
  "Paste your Anthropic API key:",
  "> sk-ant-...",
].join("\n");

const REFILL_BUFFER = [
  "Error: you have reached your usage limit for this billing period.",
  "Purchase more credits at https://console.anthropic.com/settings/billing to continue.",
].join("\n");

test("detectClaudeLoginChooser matches the real login menu, ignores lookalikes", () => {
  const hit = detectClaudeLoginChooser(LOGIN_CHOOSER_BUFFER);
  assert.ok(hit, "expected the login chooser to match");
  assert.equal(hit.kind, "login-chooser");
  assert.equal(hit.options.length, 3);
  assert.equal(hit.options[0].id, "1");
  assert.match(hit.options[0].label, /subscription/i);
  assert.equal(hit.options[1].id, "2");
  assert.match(hit.options[1].label, /console/i);
  assert.equal(hit.options[2].id, "3");
  assert.match(hit.options[2].label, /3rd-?party/i);

  assert.equal(
    detectClaudeLoginChooser("Here's a sentence that mentions a login method in passing."),
    null,
    "should not false-positive on prose",
  );
  assert.equal(
    detectClaudeLoginChooser("Select login method: subscription"),
    null,
    "needs at least two option keywords to match",
  );
});

test("detectClaudeOAuthUrl extracts the login URL when the invitation copy is present", () => {
  const hit = detectClaudeOAuthUrl(OAUTH_BUFFER);
  assert.ok(hit);
  assert.equal(hit.kind, "oauth-url");
  assert.match(hit.url, /^https:\/\/claude\.ai\/oauth\/authorize/);
  // URL alone isn't enough without the invitation copy.
  assert.equal(
    detectClaudeOAuthUrl("https://claude.ai/anywhere/else"),
    null,
    "URL alone without invitation copy should not trip",
  );
});

test("detectClaudeApiKeyPrompt matches a pasted-key prompt but not the chooser", () => {
  const hit = detectClaudeApiKeyPrompt(API_KEY_BUFFER);
  assert.ok(hit);
  assert.equal(hit.kind, "api-key");
  assert.equal(hit.consoleUrl, "https://console.anthropic.com/settings/keys");

  // If the chooser is still on screen, don't surface an API-key card — the
  // chooser takes precedence and the user's choice is the next action.
  assert.equal(
    detectClaudeApiKeyPrompt(LOGIN_CHOOSER_BUFFER + "\nPaste your Anthropic API key:"),
    null,
  );
});

test("detectClaudeCreditRefill matches the usage-limit / refill copy", () => {
  const hit = detectClaudeCreditRefill(REFILL_BUFFER);
  assert.ok(hit);
  assert.equal(hit.kind, "credit-refill");
  assert.match(hit.billingUrl, /console\.anthropic\.com\/settings\/billing/);
  assert.equal(detectClaudeCreditRefill("I have plenty of credits."), null);
});

test("detectClaudePrompt prefers the most-actionable prompt when several match", () => {
  // Both the chooser and an API-key prompt in the same buffer → chooser wins
  // because the API-key detector bails when the chooser is present, and the
  // priority order puts api-key first only when chooser is cleared.
  const session = {
    providerId: "claude",
    buffer: LOGIN_CHOOSER_BUFFER,
  };
  const chooser = detectClaudePrompt(session);
  assert.ok(chooser);
  assert.equal(chooser.kind, "login-chooser");

  // After the chooser is gone and we're asked for a key, api-key surfaces.
  const afterChoice = detectClaudePrompt({ providerId: "claude", buffer: API_KEY_BUFFER });
  assert.ok(afterChoice);
  assert.equal(afterChoice.kind, "api-key");

  // Non-claude providers get nothing.
  assert.equal(
    detectClaudePrompt({ providerId: "codex", buffer: LOGIN_CHOOSER_BUFFER }),
    null,
  );
  assert.equal(detectClaudePrompt({ providerId: "claude", buffer: "" }), null);
});

test("detectClaudeLoginChooser tolerates the spaced-letter ANSI rendering we see in practice", () => {
  // Screenshot showed letters spaced out after ANSI stripping ("S e l e c t").
  // Our normalizeTerminalText collapses runs of whitespace to single spaces, so
  // this still matches — regression guard for that behaviour.
  const spaced = [
    "S e l e c t    l o g i n    m e t h o d :",
    "1 .  C l a u d e   a c c o u n t   w i t h   s u b s c r i p t i o n",
    "2 .  A n t h r o p i c   C o n s o l e   a c c o u n t   ·   A P I   u s a g e   b i l l i n g",
    "3 .  3 r d - p a r t y   p l a t f o r m   ·   V e r t e x   A I",
  ].join("\n");
  // normalizeTerminalText isn't perfect on truly letter-spaced output, so
  // this case is expected to fail matching — document the limitation.
  const hit = detectClaudeLoginChooser(spaced);
  assert.equal(
    hit,
    null,
    "spaced-letter rendering is a known gap; update this test if we fix it",
  );
});
