// Tests for the install-runner's spawn-env helpers — the layer that makes
// shipping scripts under bin/ usable from building manifests, and that
// surfaces stderr in failure reasons so the UI tells the user WHY install
// failed (not just "step X failed").

import assert from "node:assert/strict";
import test from "node:test";
import { __internal } from "../src/install-runner.js";

const { buildSpawnEnv, formatStepFailureReason, resolveVibeResearchLocalBin } = __internal;

test("resolveVibeResearchLocalBin: prefers VIBE_RESEARCH_HOME when set", () => {
  const result = resolveVibeResearchLocalBin({
    VIBE_RESEARCH_HOME: "/custom/vr-home",
    HOME: "/home/ogata",
  });
  assert.equal(result, "/custom/vr-home/bin");
});

test("resolveVibeResearchLocalBin: falls back to $HOME/.vibe-research/bin", () => {
  const result = resolveVibeResearchLocalBin({ HOME: "/home/ogata" });
  assert.equal(result, "/home/ogata/.vibe-research/bin");
});

test("resolveVibeResearchLocalBin: returns null when neither is set", () => {
  // Pass an env without HOME or VIBE_RESEARCH_HOME — null result lets the
  // caller skip the PATH-prepend step rather than poisoning PATH with a
  // bogus value.
  assert.equal(resolveVibeResearchLocalBin({}), null);
});

test("buildSpawnEnv: prepends ~/.vibe-research/bin to PATH", () => {
  // Stub HOME so the helper resolves a deterministic local-bin path.
  const prevHome = process.env.HOME;
  const prevVrHome = process.env.VIBE_RESEARCH_HOME;
  const prevPath = process.env.PATH;
  try {
    process.env.HOME = "/tmp/vrtest-spawn-env";
    delete process.env.VIBE_RESEARCH_HOME;
    process.env.PATH = "/usr/bin:/bin";
    const merged = buildSpawnEnv({ FOO: "bar" });
    assert.equal(merged.FOO, "bar");
    assert.equal(merged.PATH, "/tmp/vrtest-spawn-env/.vibe-research/bin:/usr/bin:/bin");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevVrHome === undefined) delete process.env.VIBE_RESEARCH_HOME;
    else process.env.VIBE_RESEARCH_HOME = prevVrHome;
    process.env.PATH = prevPath;
  }
});

test("buildSpawnEnv: idempotent when local bin is already on PATH", () => {
  const prevHome = process.env.HOME;
  const prevPath = process.env.PATH;
  try {
    process.env.HOME = "/h";
    process.env.PATH = "/h/.vibe-research/bin:/usr/bin";
    const merged = buildSpawnEnv();
    // Should NOT prepend a duplicate "/h/.vibe-research/bin:" segment.
    assert.equal(merged.PATH, "/h/.vibe-research/bin:/usr/bin");
  } finally {
    process.env.HOME = prevHome;
    process.env.PATH = prevPath;
  }
});

test("buildSpawnEnv: extraEnv overrides process.env values", () => {
  const prev = process.env.MY_OVERRIDE_TEST_VAR;
  try {
    process.env.MY_OVERRIDE_TEST_VAR = "from-process";
    const merged = buildSpawnEnv({ MY_OVERRIDE_TEST_VAR: "from-extra" });
    assert.equal(merged.MY_OVERRIDE_TEST_VAR, "from-extra");
  } finally {
    if (prev === undefined) delete process.env.MY_OVERRIDE_TEST_VAR;
    else process.env.MY_OVERRIDE_TEST_VAR = prev;
  }
});

test("formatStepFailureReason: surfaces stderr tail (PEP 668 case)", () => {
  // The actual error message we hit on cthulhu1. The UI chip should show
  // enough of this for the user to understand the problem at a glance.
  const stderr = `error: externally-managed-environment

× This environment is externally managed
╰─> To install Python packages system-wide, try apt install
    python3-xyz, where xyz is the package you are trying to
    install.

note: If you believe this is a mistake, please contact your Python installation or OS distribution provider. You can override this, at the risk of breaking your Python installation or OS, by passing --break-system-packages.
hint: See PEP 668 for the detailed specification.`;
  const reason = formatStepFailureReason(
    { label: "Install Modal Python package" },
    { stderr, stdout: "", exitCode: 1 },
  );
  // Header carries the label.
  assert.match(reason, /install step "Install Modal Python package" failed/);
  // Hints carry the exit code.
  assert.match(reason, /exit=1/);
  // The actual error text is in there so users can grep for "PEP 668" / "externally-managed".
  assert.ok(/PEP 668|externally-managed|break-system-packages/.test(reason), `expected useful error text, got: ${reason}`);
});

test("formatStepFailureReason: trims long stderr to 240 chars", () => {
  const huge = "x".repeat(2000);
  const reason = formatStepFailureReason(
    { command: "true" },
    { stderr: huge, stdout: "", exitCode: 1 },
  );
  // Header + parens + colon + 3 dots + 240 chars max. Total < 320 chars.
  assert.ok(reason.length < 350, `reason should be capped, got ${reason.length} chars`);
});

test("formatStepFailureReason: falls back to stdout when stderr is empty", () => {
  // Some pip / npm errors print to stdout — without this fallback the
  // UI would show a useless naked "step X failed" with no signal.
  const reason = formatStepFailureReason(
    { command: "false" },
    { stderr: "", stdout: "Error: something useful went wrong\n", exitCode: 2 },
  );
  assert.match(reason, /something useful went wrong/);
});

test("formatStepFailureReason: includes timeout reason when set", () => {
  const reason = formatStepFailureReason(
    { label: "Long install" },
    { stderr: "", stdout: "", exitCode: null, reason: "timeout" },
  );
  assert.match(reason, /timeout/);
});

test("formatStepFailureReason: handles step with neither label nor command", () => {
  const reason = formatStepFailureReason({}, { stderr: "x", stdout: "", exitCode: 1 });
  // Should not throw; should produce a coherent message.
  assert.match(reason, /install step "command" failed/);
});
