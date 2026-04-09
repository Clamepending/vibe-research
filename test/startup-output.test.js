import assert from "node:assert/strict";
import test from "node:test";
import { buildStartupOutput, pickScanUrl, renderQrCode } from "../src/startup-output.js";

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
    cwd: "/tmp/remote-vibes",
    urls: [
      { label: "Local", url: "http://localhost:4123" },
      { label: "Tailscale", url: "http://100.106.229.117:4123" },
    ],
    providers: [{ label: "Claude Code", available: true }],
  });

  assert.match(output, /Scan on phone: http:\/\/100\.106\.229\.117:4123/);
  assert.match(output, /\u001b\[47m/);
  assert.match(output, /\u001b\[32mrunning\u001b\[0m$/);
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
