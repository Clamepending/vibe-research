// Regression tests for resolveVideoMemoryOpenUrl — the function that
// rewrites the configured VideoMemory base URL when the user is browsing
// Vibe Research from a different host than the one running the server.
//
// The bug it prevents: VideoMemory's default base URL is
// `http://127.0.0.1:5050`. When the human reaches Vibe Research over a
// tailnet IP (e.g. `http://100.106.229.117:4828`), clicking "Open
// VideoMemory" with the literal `127.0.0.1` host would hit the *user's*
// machine, not the server's — and reliably 404. This resolver rewrites
// the host to whatever the user is currently using to talk to Vibe
// Research, so the link survives Tailscale, LAN IPs, and remote
// workspaces.
//
// These tests run the actual function in a sandbox with a fake `window`
// (mirroring the source-extract approach in
// test/plugin-install-already-placed.test.js).

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS_PATH = path.join(HERE, "..", "src", "client", "main.js");

function extractFunctionSource(source, functionName) {
  const signature = `function ${functionName}(`;
  const headIdx = source.indexOf(signature);
  assert.ok(headIdx >= 0, `function ${functionName} not found in main.js`);
  // Walk past the parameter list.
  const parenStart = headIdx + signature.length - 1;
  let parenDepth = 0;
  let cursor = parenStart;
  for (; cursor < source.length; cursor += 1) {
    const ch = source[cursor];
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        cursor += 1;
        break;
      }
    }
  }
  // Walk past the body braces.
  const openIdx = source.indexOf("{", cursor);
  let depth = 0;
  for (let i = openIdx; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(headIdx, i + 1);
    }
  }
  throw new Error(`unterminated body for ${functionName}`);
}

async function loadResolver({ baseUrl, statusBaseUrl, pageHost }) {
  const source = await readFile(MAIN_JS_PATH, "utf8");
  const fnSource = extractFunctionSource(source, "resolveVideoMemoryOpenUrl");

  const factorySource = `
    return function (env) {
      const { state, window } = env;
      ${fnSource}
      return resolveVideoMemoryOpenUrl;
    };
  `;
  // eslint-disable-next-line no-new-func
  const factory = new Function(factorySource)();

  const env = {
    state: {
      settings: {
        videoMemoryBaseUrl: baseUrl,
        videoMemoryStatus: { baseUrl: statusBaseUrl },
      },
    },
    window: pageHost === undefined
      ? { location: undefined }
      : { location: { hostname: pageHost } },
  };
  return factory(env);
}

test("returns empty string when no base URL is configured", async () => {
  const fn = await loadResolver({ baseUrl: "", statusBaseUrl: "", pageHost: "100.1.2.3" });
  assert.equal(fn(), "");
});

test("returns the configured URL verbatim when accessed from the same machine", async () => {
  // Browsing locally → no rewrite. The literal 127.0.0.1 still resolves
  // to the right box because it IS the same box.
  const fn = await loadResolver({
    baseUrl: "http://127.0.0.1:5050",
    statusBaseUrl: "",
    pageHost: "127.0.0.1",
  });
  assert.equal(fn(), "http://127.0.0.1:5050/");
});

test("rewrites 127.0.0.1 to the page host when accessed remotely (Tailscale tailnet IP)", async () => {
  // Real-world scenario from /tmp/vr-server.log: server prints
  // "utun4: http://100.106.229.117:4828". User clicks the tailnet URL
  // on their laptop. Clicking "Open VideoMemory" must hit
  // 100.106.229.117:5050, NOT 127.0.0.1:5050.
  const fn = await loadResolver({
    baseUrl: "http://127.0.0.1:5050",
    statusBaseUrl: "",
    pageHost: "100.106.229.117",
  });
  assert.equal(fn(), "http://100.106.229.117:5050/");
});

test("rewrites localhost and 0.0.0.0 the same way as 127.0.0.1", async () => {
  // The resolver explicitly checks {127.0.0.1, localhost, ::1, 0.0.0.0}.
  // Note: `http://::1:5050` doesn't parse as a valid URL (IPv6 needs
  // brackets), so that form falls through to the raw-string return —
  // an acceptable edge case since users practically never configure it.
  for (const local of ["localhost", "0.0.0.0"]) {
    const fn = await loadResolver({
      baseUrl: `http://${local}:5050`,
      statusBaseUrl: "",
      pageHost: "100.106.229.117",
    });
    const got = fn();
    assert.match(
      got,
      /100\.106\.229\.117:5050/,
      `expected ${local} → page host rewrite; got: ${got}`,
    );
  }
});

test("preserves the configured port + protocol during rewrite", async () => {
  // If the user runs VideoMemory on a non-default port (or HTTPS),
  // the rewrite must not silently change those.
  const fn = await loadResolver({
    baseUrl: "https://127.0.0.1:5443",
    statusBaseUrl: "",
    pageHost: "100.106.229.117",
  });
  const got = fn();
  assert.match(got, /^https:\/\//, `protocol must be preserved, got: ${got}`);
  assert.match(got, /:5443/, `port must be preserved, got: ${got}`);
  assert.match(got, /100\.106\.229\.117/, `host must be rewritten, got: ${got}`);
});

test("does NOT rewrite when the configured URL is already non-local", async () => {
  // If the user has explicitly pointed VideoMemory at a remote host
  // (e.g. their Modal-hosted instance), don't second-guess them.
  const fn = await loadResolver({
    baseUrl: "https://videomemory.example.com:5050",
    statusBaseUrl: "",
    pageHost: "100.106.229.117",
  });
  assert.equal(fn(), "https://videomemory.example.com:5050/");
});

test("falls back to the status.baseUrl when state.settings.videoMemoryBaseUrl is empty", async () => {
  // The runtime status from /api/settings can carry a discovered
  // VideoMemory URL when the user hasn't configured one explicitly. The
  // resolver must use that fallback.
  const fn = await loadResolver({
    baseUrl: "",
    statusBaseUrl: "http://127.0.0.1:5050",
    pageHost: "100.106.229.117",
  });
  assert.equal(fn(), "http://100.106.229.117:5050/");
});

test("returns the raw configured URL if URL parsing fails (defensive — never throws)", async () => {
  const fn = await loadResolver({
    baseUrl: "not-a-valid-url",
    statusBaseUrl: "",
    pageHost: "100.106.229.117",
  });
  // The function intentionally swallows URL-parse failures and returns
  // the raw input rather than throwing — clicking the link will fail
  // visibly, which is better than the panel silently breaking.
  assert.equal(fn(), "not-a-valid-url");
});
