import assert from "node:assert/strict";
import test from "node:test";
import { buildStartupOutput, pickScanUrl, renderQrCode, renderTerminalLink } from "../src/startup-output.js";

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

test("pickScanUrl prefers the Tailscale address for phone scanning", () => {
  const url = pickScanUrl([
    { label: "Local", url: "http://localhost:4123" },
    { label: "Direct", url: "http://192.168.1.42:4123" },
    { label: "Tailscale", url: "http://100.106.229.117:4123" },
  ]);

  assert.deepEqual(url, { label: "Tailscale", url: "http://100.106.229.117:4123" });
});

test("pickScanUrl prefers a 100.x address even without a Tailscale label", () => {
  const url = pickScanUrl([
    { label: "Local", url: "http://localhost:4123" },
    { label: "bridge100", url: "http://198.19.249.2:4123" },
    { label: "utun8", url: "http://100.88.77.66:4123" },
  ]);

  assert.deepEqual(url, { label: "utun8", url: "http://100.88.77.66:4123" });
});

test("buildStartupOutput includes a terminal QR block for the preferred phone URL", () => {
  const output = buildStartupOutput({
    cwd: "/tmp/vibe-research",
    urls: [
      { label: "Local", url: "http://localhost:4123" },
      { label: "Tailscale", url: "http://100.106.229.117:4123" },
    ],
    defaultSessionCwd: "/home/friend/vibe-projects",
    providers: [{ label: "Claude Code", available: true }],
  });

  assert.match(output, /Scan on phone: http:\/\/100\.106\.229\.117:4123/);
  assert.match(output, /Open the clickable URL above/);
  assert.match(output, /Tap New Agent/);
  assert.match(output, /default agent folder: \/home\/friend\/vibe-projects/);
  assert.match(output, /If Claude asks you to sign in/);
  assert.match(output, /Remote access is optional/);
  assert.match(output, /\u001b\[47m/);
  assert.match(output, /OPEN VIBE RESEARCH/);
  assert.match(output, /Click this link: \u001b]8;;http:\/\/100\.106\.229\.117:4123\u0007http:\/\/100\.106\.229\.117:4123\u001b]8;;\u0007/);
  assert.match(output, /This laptop: \u001b]8;;http:\/\/localhost:4123\u0007http:\/\/localhost:4123\u001b]8;;\u0007/);
  assert.match(output, /\u001b\[32mrunning\u001b\[0m\n\n/);
  assert.match(output, /\u001b\[1m\u001b\[36m============================================================\u001b\[0m$/);
});

test("renderTerminalLink emits an OSC 8 clickable terminal link", () => {
  assert.equal(
    renderTerminalLink("http://localhost:4123", "Open Vibe Research"),
    "\u001b]8;;http://localhost:4123\u0007Open Vibe Research\u001b]8;;\u0007",
  );
});

test("renderQrCode uses a square ANSI QR that is easier to scan", () => {
  const output = renderQrCode("http://100.106.229.117:4123");
  const visibleLines = stripAnsi(output).split("\n");
  const maxWidth = Math.max(...visibleLines.map((line) => line.length));

  assert.ok(visibleLines.length >= 24);
  assert.ok(maxWidth >= 48);
  assert.match(output, /\u001b\[40m/);
});

test("renderQrCode returns an empty string when no URL is available", () => {
  assert.equal(renderQrCode(""), "");
});
