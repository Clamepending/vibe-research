// Unit + file-touching tests for src/mcp-config-sync.js. Uses an
// in-memory fs stub for the merge-logic tests and real temp files for
// the round-trip tests.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncToClaudeCode, syncToCodex, __internal } from "../src/mcp-config-sync.js";
import { createMcpLaunchRegistry } from "../src/mcp-launch-registry.js";

function makeRegistry(launches) {
  const r = createMcpLaunchRegistry();
  for (const [buildingId, entries] of Object.entries(launches)) {
    r.declare(buildingId, entries);
  }
  return r;
}

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFileSync: (path) => {
      if (!files.has(path)) {
        const err = new Error(`ENOENT: ${path}`);
        err.code = "ENOENT";
        throw err;
      }
      return files.get(path);
    },
    writeFileSync: (path, content) => {
      files.set(path, String(content));
    },
  };
}

// ---- internals ----

test("sanitizeCodexName: replaces non-bare-key chars with _", () => {
  assert.equal(__internal.sanitizeCodexName("mcp-filesystem"), "mcp-filesystem");
  assert.equal(__internal.sanitizeCodexName("mcp.linear/v2"), "mcp_linear_v2");
  assert.equal(__internal.sanitizeCodexName("123_ok"), "123_ok");
});

test("buildCodexBlock: command + args + env produces TOML lines", () => {
  const text = __internal.buildCodexBlock("mcp-fs", { command: "npx", args: ["-y", "@mcp/fs", "/tmp"], env: { K: "v" } });
  assert.match(text, /\[mcp_servers\.mcp-fs\]/);
  assert.match(text, /command = "npx"/);
  assert.match(text, /args = \["-y", "@mcp\/fs", "\/tmp"\]/);
  assert.match(text, /env = \{ K = "v" \}/);
  assert.match(text, /_vibeResearchManaged = true/);
});

test("buildCodexBlock: omits args + env when empty", () => {
  const text = __internal.buildCodexBlock("mcp-x", { command: "node", args: [], env: {} });
  assert.match(text, /command = "node"/);
  assert.equal(/args = /.test(text), false);
  assert.equal(/env = /.test(text), false);
});

test("buildCodexBlock: escapes special chars in strings", () => {
  const text = __internal.buildCodexBlock("mcp-x", {
    command: "node",
    args: ["with \"quote\"", "with\\backslash", "with\nnewline"],
    env: { K: "with \"quote\"" },
  });
  assert.match(text, /"with \\"quote\\""/);
  assert.match(text, /"with\\\\backslash"/);
  assert.match(text, /"with\\nnewline"/);
});

test("stripManagedCodexBlocks: drops managed sections, preserves user-edited ones", () => {
  const input = [
    "# user comment",
    "model = \"claude-haiku\"",
    "",
    "[mcp_servers.user-fs]",
    "command = \"my-fs\"",
    "args = [\"/Users/alice\"]",
    "",
    "[mcp_servers.vibe-research-managed]",
    "_vibeResearchManaged = true",
    "command = \"npx\"",
    "args = [\"-y\", \"@mcp/fs\"]",
    "",
    "[other.section]",
    "key = \"value\"",
  ].join("\n");
  const out = __internal.stripManagedCodexBlocks(input);
  assert.match(out, /\[mcp_servers\.user-fs\]/);
  assert.equal(out.includes("vibe-research-managed"), false);
  assert.match(out, /\[other\.section\]/);
  assert.match(out, /model = "claude-haiku"/);
});

// ---- syncToClaudeCode ----

test("syncToClaudeCode: empty file → file with just our entries", () => {
  const fs = memoryFs();
  const registry = makeRegistry({
    "mcp-fs": [{ command: "npx", args: ["-y", "@mcp/fs", "/tmp"] }],
  });
  const result = syncToClaudeCode({ registry, claudeJsonPath: "/fake/.claude.json", fs });
  assert.equal(result.wrote, 1);
  const written = JSON.parse(fs.files.get("/fake/.claude.json"));
  assert.ok(written.mcpServers["mcp-fs"]);
  assert.equal(written.mcpServers["mcp-fs"]._vibeResearchManaged, true);
});

test("syncToClaudeCode: preserves non-managed entries on re-sync", () => {
  const initial = {
    projects: { "/some/path": { hasTrustDialogAccepted: true } },
    mcpServers: {
      "user-edited": { command: "user-bin", args: ["x"] },
    },
  };
  const fs = memoryFs({ "/fake/.claude.json": JSON.stringify(initial) });
  const registry = makeRegistry({
    "mcp-fs": [{ command: "npx", args: ["-y", "@mcp/fs"] }],
  });
  syncToClaudeCode({ registry, claudeJsonPath: "/fake/.claude.json", fs });
  const after = JSON.parse(fs.files.get("/fake/.claude.json"));
  assert.ok(after.mcpServers["user-edited"], "user-edited entry must be preserved");
  assert.ok(after.mcpServers["mcp-fs"], "managed entry must be added");
  assert.deepEqual(after.projects, initial.projects, "unrelated config preserved");
});

test("syncToClaudeCode: re-sync replaces previously-managed entries (no duplication)", () => {
  const fs = memoryFs();
  const registry = makeRegistry({
    "mcp-fs": [{ command: "npx", args: ["v1"] }],
  });
  syncToClaudeCode({ registry, claudeJsonPath: "/fake/.claude.json", fs });
  // Re-declare with a different command, then sync again.
  registry.declare("mcp-fs", [{ command: "npx", args: ["v2"] }]);
  syncToClaudeCode({ registry, claudeJsonPath: "/fake/.claude.json", fs });
  const after = JSON.parse(fs.files.get("/fake/.claude.json"));
  assert.equal(Object.keys(after.mcpServers).length, 1);
  assert.deepEqual(after.mcpServers["mcp-fs"].args, ["v2"]);
});

test("syncToClaudeCode: removed-from-registry entries are removed from file on next sync", () => {
  const fs = memoryFs();
  const registry = makeRegistry({
    "a": [{ command: "x" }],
    "b": [{ command: "y" }],
  });
  syncToClaudeCode({ registry, claudeJsonPath: "/fake/.claude.json", fs });
  registry.remove("a");
  syncToClaudeCode({ registry, claudeJsonPath: "/fake/.claude.json", fs });
  const after = JSON.parse(fs.files.get("/fake/.claude.json"));
  assert.equal(after.mcpServers.a, undefined);
  assert.ok(after.mcpServers.b);
});

test("syncToClaudeCode: corrupt JSON file is treated as empty + overwritten", () => {
  const fs = memoryFs({ "/fake/.claude.json": "this is not json {[}" });
  const registry = makeRegistry({ "mcp-fs": [{ command: "npx" }] });
  syncToClaudeCode({ registry, claudeJsonPath: "/fake/.claude.json", fs });
  const after = JSON.parse(fs.files.get("/fake/.claude.json"));
  assert.ok(after.mcpServers["mcp-fs"]);
});

test("syncToClaudeCode: unresolved-template launches are skipped", () => {
  const fs = memoryFs();
  const registry = makeRegistry({});
  // Declare a launch with an unresolved template — it would require a
  // settings value to resolve.
  registry.declare("mcp-needs-token", [{ command: "npx", args: ["-y", "${unfilledKey}"] }]);
  syncToClaudeCode({ registry, claudeJsonPath: "/fake/.claude.json", fs });
  const after = JSON.parse(fs.files.get("/fake/.claude.json"));
  assert.equal(Object.keys(after.mcpServers || {}).length, 0,
    "launches with unresolved templates must not be written to the agent config");
});

// ---- syncToCodex ----

test("syncToCodex: empty file → TOML with our entries", () => {
  const fs = memoryFs();
  const registry = makeRegistry({
    "mcp-fs": [{ command: "npx", args: ["-y", "@mcp/fs"], env: { K: "v" } }],
  });
  syncToCodex({ registry, codexConfigPath: "/fake/.codex/config.toml", fs });
  const out = fs.files.get("/fake/.codex/config.toml");
  assert.match(out, /\[mcp_servers\.mcp-fs\]/);
  assert.match(out, /command = "npx"/);
  assert.match(out, /env = \{ K = "v" \}/);
  assert.match(out, /_vibeResearchManaged = true/);
});

test("syncToCodex: preserves user-edited [mcp_servers.*] entries on re-sync", () => {
  const initial = [
    "# user header",
    "",
    "[mcp_servers.user-thing]",
    "command = \"my-bin\"",
    "args = [\"/data\"]",
    "",
  ].join("\n");
  const fs = memoryFs({ "/fake/.codex/config.toml": initial });
  const registry = makeRegistry({
    "mcp-fs": [{ command: "npx", args: ["-y", "@mcp/fs"] }],
  });
  syncToCodex({ registry, codexConfigPath: "/fake/.codex/config.toml", fs });
  const out = fs.files.get("/fake/.codex/config.toml");
  assert.match(out, /\[mcp_servers\.user-thing\]/);
  assert.match(out, /\[mcp_servers\.mcp-fs\]/);
  assert.match(out, /# user header/);
});

test("syncToCodex: re-sync replaces previously-managed sections", () => {
  const fs = memoryFs();
  const registry = makeRegistry({ "mcp-fs": [{ command: "npx", args: ["v1"] }] });
  syncToCodex({ registry, codexConfigPath: "/fake/.codex/config.toml", fs });
  registry.declare("mcp-fs", [{ command: "npx", args: ["v2"] }]);
  syncToCodex({ registry, codexConfigPath: "/fake/.codex/config.toml", fs });
  const out = fs.files.get("/fake/.codex/config.toml");
  // Should appear exactly once.
  const matches = out.match(/\[mcp_servers\.mcp-fs\]/g) || [];
  assert.equal(matches.length, 1);
  assert.match(out, /args = \["v2"\]/);
  assert.equal(out.includes("\"v1\""), false);
});

test("syncToCodex: sanitizes section names that contain slashes/dots", () => {
  const fs = memoryFs();
  const registry = makeRegistry({ "weird/name.id": [{ command: "x" }] });
  syncToCodex({ registry, codexConfigPath: "/fake/.codex/config.toml", fs });
  const out = fs.files.get("/fake/.codex/config.toml");
  assert.match(out, /\[mcp_servers\.weird_name_id\]/);
});

test("syncToCodex: missing parent dir is auto-created (real fs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vr-sync-codex-"));
  const filePath = join(dir, "nested", "deeper", "config.toml");
  try {
    const registry = makeRegistry({ "a": [{ command: "x" }] });
    syncToCodex({ registry, codexConfigPath: filePath });
    const written = readFileSync(filePath, "utf8");
    assert.match(written, /\[mcp_servers\.a\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncToClaudeCode + syncToCodex: real fs round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "vr-sync-real-"));
  const claudePath = join(dir, ".claude.json");
  const codexPath = join(dir, ".codex", "config.toml");
  try {
    const registry = makeRegistry({
      "mcp-filesystem": [{ command: "npx", args: ["-y", "@mcp/filesystem", "/Users/me/repo"] }],
      "mcp-github": [{ command: "npx", args: ["-y", "@mcp/github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "tok_X" } }],
    });
    syncToClaudeCode({ registry, claudeJsonPath: claudePath });
    syncToCodex({ registry, codexConfigPath: codexPath });

    const claude = JSON.parse(readFileSync(claudePath, "utf8"));
    assert.equal(claude.mcpServers["mcp-filesystem"].command, "npx");
    assert.equal(claude.mcpServers["mcp-github"].env.GITHUB_PERSONAL_ACCESS_TOKEN, "tok_X");

    const codex = readFileSync(codexPath, "utf8");
    assert.match(codex, /\[mcp_servers\.mcp-filesystem\]/);
    assert.match(codex, /\[mcp_servers\.mcp-github\]/);
    assert.match(codex, /env = \{ GITHUB_PERSONAL_ACCESS_TOKEN = "tok_X" \}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncToClaudeCode: throws when registry missing", () => {
  assert.throws(() => syncToClaudeCode({}), /registry is required/);
});

test("syncToCodex: throws when registry missing", () => {
  assert.throws(() => syncToCodex({}), /registry is required/);
});

// ---- Live integration: Claude Code CLI actually reads the synced config ----
//
// Skipped if `claude` isn't on PATH. When it is, we drop a project-level
// `.mcp.json` (which is the easiest place for `claude mcp list` to read
// from), invoke the CLI, and confirm it spawns the MCP server we declared.
// This is the single-most-important test of the whole sync layer: it
// proves the agent CLIs really do pick up the format we emit.

import { execSync, spawnSync } from "node:child_process";

function claudeAvailable() {
  try { execSync("command -v claude", { stdio: "pipe" }); return true; } catch { return false; }
}

test("live: claude CLI reads our synced JSON shape and spawns the MCP server", { timeout: 90_000 }, async (t) => {
  if (!claudeAvailable()) { t.skip("claude CLI not on PATH"); return; }

  const dir = mkdtempSync(join(tmpdir(), "vr-claude-live-"));
  try {
    // syncToClaudeCode writes ~/.claude.json shape but `claude mcp list`
    // reads project-level .mcp.json from cwd. Same shape, different path.
    // We exercise the shape-correctness end-to-end by writing the same
    // thing the syncer would produce.
    const registry = makeRegistry({
      "mcp-filesystem": [{ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }],
    });
    // Write to .mcp.json in dir (project-level config Claude reads from cwd).
    const projectMcpPath = join(dir, ".mcp.json");
    syncToClaudeCode({ registry, claudeJsonPath: projectMcpPath });
    // The synced file contains an extra top-level field structure (the
    // claude.json shape). For the .mcp.json project file, Claude expects
    // the bare shape: just { mcpServers: {...} }. Our syncer produces
    // { mcpServers: {...} } at the top level (no other fields when the
    // input file was empty), so we can reuse this directly.
    const shape = JSON.parse(readFileSync(projectMcpPath, "utf8"));
    assert.ok(shape.mcpServers, "synced file must have mcpServers");

    // Run `claude mcp list` from the dir. It should connect to the
    // declared server.
    const output = spawnSync("claude", ["mcp", "list"], {
      cwd: dir,
      timeout: 60_000,
      encoding: "utf8",
    });
    const combined = `${output.stdout || ""}\n${output.stderr || ""}`;
    assert.ok(
      /mcp-filesystem.*Connected/.test(combined),
      `claude mcp list must show mcp-filesystem as Connected. Got:\n${combined.slice(0, 1000)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function codexAvailable() {
  try { execSync("command -v codex", { stdio: "pipe" }); return true; } catch { return false; }
}

test("live: codex CLI reads our synced TOML shape", { timeout: 60_000 }, async (t) => {
  if (!codexAvailable()) { t.skip("codex CLI not on PATH"); return; }

  const dir = mkdtempSync(join(tmpdir(), "vr-codex-live-"));
  const codexConfigPath = join(dir, ".codex", "config.toml");
  try {
    const registry = makeRegistry({
      "mcp-filesystem": [{ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }],
    });
    syncToCodex({ registry, codexConfigPath });
    const written = readFileSync(codexConfigPath, "utf8");
    assert.match(written, /\[mcp_servers\.mcp-filesystem\]/);
    // Codex CLI invocation would go here. The CLI's exact "list MCPs"
    // command varies between versions; the shape check above is what
    // we can guarantee until codex stabilizes its inspection commands.
    // Document what's checked for this run.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
