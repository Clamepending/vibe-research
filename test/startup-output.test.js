import assert from "node:assert/strict";
import test from "node:test";
import { buildStartupOutput, pickScanUrl, renderQrCode } from "../src/startup-output.js";

test("pickScanUrl prefers the Tailscale address for phone scanning", () => {
  const url = pickScanUrl([
    { label: "Local", url: "http://localhost:4123" },
    { label: "Direct", url: "http://192.168.1.42:4123" },
    { label: "Tailscale", url: "http://100.106.229.117:4123" },
  ]);

  assert.deepEqual(url, { label: "Tailscale", url: "http://100.106.229.117:4123" });
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
  assert.match(output, /[█▄▀]/);
});

test("renderQrCode scales the terminal QR for easier scanning", () => {
  const output = renderQrCode("http://100.106.229.117:4123");
  const lines = output.split("\n");
  const maxWidth = Math.max(...lines.map((line) => line.length));

  assert.ok(lines.length >= 24);
  assert.ok(maxWidth >= 48);
});

test("renderQrCode returns an empty string when no URL is available", () => {
  assert.equal(renderQrCode(""), "");
});
