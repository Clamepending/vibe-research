import assert from "node:assert/strict";
import test from "node:test";
import {
  getTailscaleDnsNameFromStatus,
  getTailscaleHttpsUrlFromServeStatus,
  hasTailscaleHttpsRootServe,
  looksLikeTailscaleUrl,
  pickPreferredUrl,
} from "../src/access-url.js";

test("preferred access URL uses Tailscale HTTPS over raw tailnet HTTP", () => {
  const preferred = pickPreferredUrl([
    { label: "Local", url: "http://localhost:4123" },
    { label: "Tailscale", url: "http://100.87.72.76:4123" },
    { label: "Tailscale HTTPS", url: "https://home-raspi.tail8dd042.ts.net/" },
  ]);

  assert.deepEqual(preferred, {
    label: "Tailscale HTTPS",
    url: "https://home-raspi.tail8dd042.ts.net/",
  });
});

test("preferred access URL ignores non-Tailscale carrier-grade NAT interfaces", () => {
  const preferred = pickPreferredUrl([
    { label: "Local", url: "http://localhost:4123" },
    { label: "ibp134s0.8001", url: "http://100.64.10.154:4123" },
    { label: "Tailscale", url: "http://100.89.173.62:4123" },
  ]);

  assert.deepEqual(preferred, {
    label: "Tailscale",
    url: "http://100.89.173.62:4123",
  });
});

test("plain 100.x interface addresses are not enough to count as Tailscale", () => {
  assert.equal(looksLikeTailscaleUrl({ label: "ibp134s0.8001", url: "http://100.64.10.154:4123" }), false);
  assert.equal(looksLikeTailscaleUrl({ label: "utun8", url: "http://100.88.77.66:4123" }), true);
  assert.equal(looksLikeTailscaleUrl({ label: "Tailscale", url: "http://100.89.173.62:4123" }), true);
});

test("extracts the current machine MagicDNS name from Tailscale status", () => {
  assert.equal(
    getTailscaleDnsNameFromStatus({
      Self: {
        DNSName: "home-raspi.tail8dd042.ts.net.",
      },
    }),
    "home-raspi.tail8dd042.ts.net",
  );
});

test("detects Tailscale Serve HTTPS root for the current Remote Vibes port", () => {
  const serveStatus = {
    Web: {
      "home-raspi.tail8dd042.ts.net:443": {
        Handlers: {
          "/": {
            Proxy: "http://127.0.0.1:4123",
          },
        },
      },
    },
  };

  assert.equal(
    getTailscaleHttpsUrlFromServeStatus(serveStatus, 4123, "home-raspi.tail8dd042.ts.net"),
    "https://home-raspi.tail8dd042.ts.net/",
  );
  assert.equal(hasTailscaleHttpsRootServe(serveStatus, "home-raspi.tail8dd042.ts.net"), true);
});

test("does not treat another HTTPS root service as Remote Vibes", () => {
  const serveStatus = {
    Web: {
      "home-raspi.tail8dd042.ts.net:443": {
        Handlers: {
          "/": {
            Proxy: "http://127.0.0.1:19080",
          },
        },
      },
    },
  };

  assert.equal(
    getTailscaleHttpsUrlFromServeStatus(serveStatus, 4123, "home-raspi.tail8dd042.ts.net"),
    "",
  );
  assert.equal(hasTailscaleHttpsRootServe(serveStatus, "home-raspi.tail8dd042.ts.net"), true);
});
