// Unit tests for src/mcp-launch-registry.js. Pure in-memory module so
// these run in milliseconds with no external dependencies.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMcpLaunchRegistry,
  hasUnresolvedTemplate,
  resolveTemplate,
} from "../src/mcp-launch-registry.js";
import { executeInstallPlan } from "../src/install-runner.js";

// ---- resolveTemplate / hasUnresolvedTemplate ----

test("resolveTemplate: replaces ${key} when settings has the key", () => {
  assert.equal(resolveTemplate("Bearer ${token}", { token: "xyz" }), "Bearer xyz");
});

test("resolveTemplate: leaves ${key} as-is when key missing", () => {
  assert.equal(resolveTemplate("Bearer ${token}", {}), "Bearer ${token}");
});

test("resolveTemplate: leaves ${key} as-is when value is empty string", () => {
  // Empty value is treated as 'unresolved' so the host agent surfaces a
  // missing-credential error rather than launching with a blank token.
  assert.equal(resolveTemplate("Bearer ${token}", { token: "" }), "Bearer ${token}");
});

test("resolveTemplate: handles multiple keys + leaves unrecognized syntax alone", () => {
  assert.equal(
    resolveTemplate("u=${user};p=${pass};raw=$elsewhere", { user: "alice", pass: "secret" }),
    "u=alice;p=secret;raw=$elsewhere",
  );
});

test("hasUnresolvedTemplate: detects remaining ${key} after partial resolution", () => {
  const text = resolveTemplate("u=${user};p=${pass}", { user: "alice" });
  assert.equal(hasUnresolvedTemplate(text), true);
  assert.equal(hasUnresolvedTemplate(resolveTemplate(text, { pass: "z" })), false);
});

// ---- registry.declare ----

test("registry.declare: stores normalized launches per building", () => {
  const r = createMcpLaunchRegistry();
  r.declare("mcp-x", [{ command: "node", args: ["server.js"], env: { PORT: "1" }, label: "x" }]);
  const list = r.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].buildingId, "mcp-x");
  assert.equal(list[0].command, "node");
  assert.deepEqual(list[0].args, ["server.js"]);
  assert.deepEqual(list[0].env, { PORT: "1" });
});

test("registry.declare: an empty array clears the building's launches", () => {
  const r = createMcpLaunchRegistry();
  r.declare("mcp-x", [{ command: "node" }]);
  assert.equal(r.size(), 1);
  r.declare("mcp-x", []);
  assert.equal(r.size(), 0);
});

test("registry.declare: re-declaring REPLACES the building's launches", () => {
  // Re-running an install plan after a token paste needs to overwrite the
  // previous (un-resolved) declaration, not append to it.
  const r = createMcpLaunchRegistry();
  r.declare("mcp-x", [{ command: "old-cmd" }]);
  r.declare("mcp-x", [{ command: "new-cmd", args: ["a"] }]);
  const list = r.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].command, "new-cmd");
});

test("registry.declare: drops malformed launches (no command, wrong shape, etc.)", () => {
  const r = createMcpLaunchRegistry();
  r.declare("mcp-x", [
    { command: "good" },
    { args: ["no-command-field"] },
    null,
    "string-not-object",
    { command: "" },
  ]);
  const list = r.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].command, "good");
});

test("registry.declare: empty buildingId is a no-op", () => {
  const r = createMcpLaunchRegistry();
  assert.deepEqual(r.declare("", [{ command: "x" }]), []);
  assert.deepEqual(r.declare(null, [{ command: "x" }]), []);
  assert.equal(r.size(), 0);
});

// ---- registry.list ----

test("registry.list({ resolved: false }): returns raw declarations with templates", () => {
  const r = createMcpLaunchRegistry();
  r.declare("mcp-x", [
    { command: "node", args: ["server.js"], env: { TOKEN: "${apiToken}" } },
  ]);
  const raw = r.list({ resolved: false });
  assert.equal(raw[0].env.TOKEN, "${apiToken}");
  assert.equal(raw[0].unresolved, true);
});

test("registry.list({ resolved: true, settings }): interpolates templates", () => {
  const r = createMcpLaunchRegistry();
  r.declare("mcp-x", [
    { command: "node", args: ["server.js", "--token", "${apiToken}"], env: { API: "${apiToken}" } },
  ]);
  const live = r.list({ resolved: true, settings: { apiToken: "abc123" } });
  assert.deepEqual(live[0].args, ["server.js", "--token", "abc123"]);
  assert.equal(live[0].env.API, "abc123");
  assert.equal(live[0].unresolved, false);
});

test("registry.list({ resolved: true }): unresolved=true when a referenced setting is missing", () => {
  const r = createMcpLaunchRegistry();
  r.declare("mcp-x", [
    { command: "node", env: { TOKEN: "${absent}" } },
  ]);
  const live = r.list({ resolved: true, settings: {} });
  assert.equal(live[0].unresolved, true);
  assert.equal(live[0].env.TOKEN, "${absent}");
});

test("registry.list: defaults settings via getSettings dependency injection", () => {
  let calls = 0;
  const r = createMcpLaunchRegistry({
    getSettings: () => { calls += 1; return { apiToken: "from-getter" }; },
  });
  r.declare("mcp-x", [{ command: "node", args: ["${apiToken}"] }]);
  const live = r.list({ resolved: true });
  assert.equal(live[0].args[0], "from-getter");
  assert.ok(calls >= 1, "getSettings should be invoked");
});

// ---- registry.remove + has + clear ----

test("registry.remove + has + clear", () => {
  const r = createMcpLaunchRegistry();
  r.declare("a", [{ command: "x" }]);
  r.declare("b", [{ command: "y" }]);
  assert.equal(r.has("a"), true);
  assert.equal(r.remove("a"), true);
  assert.equal(r.has("a"), false);
  assert.equal(r.remove("ghost"), false);
  r.clear();
  assert.equal(r.size(), 0);
});

// ---- registry.toMcpConfig ----

test("registry.toMcpConfig: claude_desktop_config.json shape", () => {
  const r = createMcpLaunchRegistry();
  r.declare("mcp-fs", [{ command: "npx", args: ["-y", "@mcp/fs", "/tmp"] }]);
  r.declare("mcp-gh", [{ command: "npx", args: ["-y", "@mcp/gh"], env: { TOKEN: "${ghToken}" } }]);
  const cfg = r.toMcpConfig({ settings: { ghToken: "tok_AAA" } });
  assert.deepEqual(cfg, {
    mcpServers: {
      "mcp-fs": { command: "npx", args: ["-y", "@mcp/fs", "/tmp"] },
      "mcp-gh": { command: "npx", args: ["-y", "@mcp/gh"], env: { TOKEN: "tok_AAA" } },
    },
  });
});

test("registry.toMcpConfig: multiple launches per building get -1 / -2 suffixes", () => {
  const r = createMcpLaunchRegistry();
  r.declare("mcp-multi", [
    { command: "node", args: ["a"] },
    { command: "node", args: ["b"] },
  ]);
  const cfg = r.toMcpConfig({ settings: {} });
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ["mcp-multi-1", "mcp-multi-2"]);
});

test("registry.toMcpConfig: omits env when env is empty", () => {
  const r = createMcpLaunchRegistry();
  r.declare("mcp-fs", [{ command: "npx", args: ["-y", "@mcp/fs"] }]);
  const cfg = r.toMcpConfig({ settings: {} });
  assert.equal(Object.prototype.hasOwnProperty.call(cfg.mcpServers["mcp-fs"], "env"), false);
});

// ---- integration with executeInstallPlan ----

test("executeInstallPlan: hook into mcpRegistry — successful install declares launches", async () => {
  const r = createMcpLaunchRegistry();
  const plan = {
    preflight: [{ kind: "command", command: "true" }],
    install: [],
    verify: [{ kind: "command", command: "true" }],
    mcp: [
      { kind: "mcp-launch", command: "node", args: ["server.js", "--token", "${myKey}"], env: { K: "${myKey}" }, label: "demo" },
    ],
  };
  const result = await executeInstallPlan(plan, {
    appendLog: () => {},
    mcpRegistry: r,
    buildingId: "demo-building",
  });
  assert.equal(result.status, "ok");
  assert.equal(r.size(), 1);
  // Resolved against an empty settings → unresolved template stays in.
  const list = r.list({ resolved: true, settings: {} });
  assert.equal(list[0].buildingId, "demo-building");
  assert.equal(list[0].unresolved, true);
  // Resolved with the matching setting → templates filled.
  const resolved = r.list({ resolved: true, settings: { myKey: "tok_XYZ" } });
  assert.equal(resolved[0].unresolved, false);
  assert.equal(resolved[0].env.K, "tok_XYZ");
});

test("executeInstallPlan: re-running with new mcp launches replaces old ones for the same buildingId", async () => {
  const r = createMcpLaunchRegistry();
  const plan1 = {
    preflight: [{ kind: "command", command: "true" }],
    verify: [],
    mcp: [{ kind: "mcp-launch", command: "old-cmd" }],
  };
  const plan2 = {
    preflight: [{ kind: "command", command: "true" }],
    verify: [],
    mcp: [{ kind: "mcp-launch", command: "new-cmd-1" }, { kind: "mcp-launch", command: "new-cmd-2" }],
  };
  await executeInstallPlan(plan1, { appendLog: () => {}, mcpRegistry: r, buildingId: "x" });
  await executeInstallPlan(plan2, { appendLog: () => {}, mcpRegistry: r, buildingId: "x" });
  const list = r.list();
  const cmds = list.map((entry) => entry.command).sort();
  assert.deepEqual(cmds, ["new-cmd-1", "new-cmd-2"]);
});

test("executeInstallPlan: failing install does NOT touch the mcp registry", async () => {
  const r = createMcpLaunchRegistry();
  r.declare("x", [{ command: "previous-cmd" }]);
  const plan = {
    preflight: [{ kind: "command", command: "false" }],
    install: [{ kind: "command", command: "false", label: "boom" }],
    verify: [{ kind: "command", command: "true" }],
    mcp: [{ kind: "mcp-launch", command: "should-not-land" }],
  };
  const result = await executeInstallPlan(plan, {
    appendLog: () => {},
    mcpRegistry: r,
    buildingId: "x",
  });
  assert.equal(result.status, "failed");
  // Previous declaration must be preserved; new one must NOT be added.
  const list = r.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].command, "previous-cmd");
});

// ---- Persistence ----

function tmpFile(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return { path: join(dir, "registry.json"), dir };
}

test("persistence: declare writes the file; new registry loads same data", () => {
  const { path: filePath, dir } = tmpFile("persist-declare");
  try {
    const r1 = createMcpLaunchRegistry({ persistencePath: filePath });
    r1.declare("mcp-a", [{ command: "node", args: ["x"], env: { K: "v" }, label: "demo" }]);
    // The file should now exist.
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.buildings["mcp-a"][0].command, "node");

    // A fresh registry constructed with the same path loads the data.
    const r2 = createMcpLaunchRegistry({ persistencePath: filePath });
    assert.equal(r2.size(), 1);
    const list = r2.list();
    assert.equal(list[0].buildingId, "mcp-a");
    assert.deepEqual(list[0].args, ["x"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence: remove writes a smaller file", () => {
  const { path: filePath, dir } = tmpFile("persist-remove");
  try {
    const r = createMcpLaunchRegistry({ persistencePath: filePath });
    r.declare("a", [{ command: "x" }]);
    r.declare("b", [{ command: "y" }]);
    r.remove("a");
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(Object.keys(onDisk.buildings).length, 1);
    assert.ok(onDisk.buildings.b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence: clear() empties the file", () => {
  const { path: filePath, dir } = tmpFile("persist-clear");
  try {
    const r = createMcpLaunchRegistry({ persistencePath: filePath });
    r.declare("a", [{ command: "x" }]);
    r.declare("b", [{ command: "y" }]);
    r.clear();
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    assert.deepEqual(onDisk.buildings, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence: corrupt JSON file is tolerated, registry starts empty", () => {
  const { path: filePath, dir } = tmpFile("persist-corrupt");
  try {
    writeFileSync(filePath, "this is not json {[}");
    const r = createMcpLaunchRegistry({ persistencePath: filePath });
    assert.equal(r.size(), 0);
    // The first declare should overwrite the corrupt file with valid data.
    r.declare("a", [{ command: "x" }]);
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    assert.ok(onDisk.buildings.a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence: missing parent directory is created on first write", () => {
  const { dir } = tmpFile("persist-mkdir");
  const filePath = join(dir, "nested", "deeper", "registry.json");
  try {
    const r = createMcpLaunchRegistry({ persistencePath: filePath });
    r.declare("a", [{ command: "x" }]);
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    assert.ok(onDisk.buildings.a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence: missing file is tolerated, registry starts empty", () => {
  const { dir } = tmpFile("persist-missing");
  const filePath = join(dir, "does-not-exist.json");
  try {
    const r = createMcpLaunchRegistry({ persistencePath: filePath });
    assert.equal(r.size(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence: empty-array declare clears the building from disk", () => {
  const { path: filePath, dir } = tmpFile("persist-clear-one");
  try {
    const r = createMcpLaunchRegistry({ persistencePath: filePath });
    r.declare("a", [{ command: "x" }]);
    r.declare("a", []);
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    assert.deepEqual(onDisk.buildings, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence: declare normalization round-trips through the file", () => {
  const { path: filePath, dir } = tmpFile("persist-roundtrip");
  try {
    const r1 = createMcpLaunchRegistry({ persistencePath: filePath });
    r1.declare("a", [
      { command: "good" },
      { command: "" },                  // dropped
      "string",                         // dropped
      { command: "second", env: { X: "1" } },
    ]);
    const r2 = createMcpLaunchRegistry({ persistencePath: filePath });
    const cmds = r2.list().map((entry) => entry.command).sort();
    assert.deepEqual(cmds, ["good", "second"]);
    assert.deepEqual(r2.list().find((e) => e.command === "second").env, { X: "1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence: file with wrong shape is tolerated", () => {
  const { path: filePath, dir } = tmpFile("persist-wrong-shape");
  try {
    writeFileSync(filePath, JSON.stringify({ version: 1, buildings: "not an object" }));
    const r = createMcpLaunchRegistry({ persistencePath: filePath });
    assert.equal(r.size(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence: persistencePath omitted disables persistence", () => {
  const r = createMcpLaunchRegistry();
  r.declare("a", [{ command: "x" }]);
  // Nothing crashed and the data is in-memory only.
  assert.equal(r.size(), 1);
  assert.equal(r.persistencePath, null);
});

// ---- recordHandshake / lastHandshake ----

test("recordHandshake: writes per-launch result + list() exposes it", () => {
  const r = createMcpLaunchRegistry();
  r.declare("mcp-x", [{ command: "node", label: "primary" }]);
  const wrote = r.recordHandshake("mcp-x", "primary", {
    ok: true,
    status: "tools-listed",
    toolCount: 7,
    serverName: "demo",
    serverVersion: "1.2",
  });
  assert.equal(wrote, true);
  const [entry] = r.list();
  assert.ok(entry.lastHandshake);
  assert.equal(entry.lastHandshake.ok, true);
  assert.equal(entry.lastHandshake.toolCount, 7);
  assert.equal(entry.lastHandshake.serverName, "demo");
  assert.ok(typeof entry.lastHandshake.at === "number");
});

test("recordHandshake: empty buildingId / unknown id is a no-op", () => {
  const r = createMcpLaunchRegistry();
  r.declare("a", [{ command: "x" }]);
  assert.equal(r.recordHandshake("", "", { ok: true, status: "tools-listed" }), false);
  assert.equal(r.recordHandshake("ghost", "any", { ok: true, status: "tools-listed" }), false);
});

test("recordHandshake: matches by label across multiple launches", () => {
  const r = createMcpLaunchRegistry();
  r.declare("multi", [
    { command: "a", label: "primary" },
    { command: "b", label: "secondary" },
  ]);
  r.recordHandshake("multi", "secondary", { ok: false, status: "init-failed", error: "401" });
  r.recordHandshake("multi", "primary", { ok: true, status: "tools-listed", toolCount: 3 });
  const list = r.list();
  const primary = list.find((e) => e.label === "primary");
  const secondary = list.find((e) => e.label === "secondary");
  assert.equal(primary.lastHandshake.ok, true);
  assert.equal(primary.lastHandshake.toolCount, 3);
  assert.equal(secondary.lastHandshake.ok, false);
  assert.equal(secondary.lastHandshake.error, "401");
});

test("recordHandshake: empty label falls back to first launch", () => {
  const r = createMcpLaunchRegistry();
  r.declare("solo", [{ command: "x", label: "" }]);
  r.recordHandshake("solo", "", { ok: true, status: "tools-listed" });
  const [entry] = r.list();
  assert.ok(entry.lastHandshake);
  assert.equal(entry.lastHandshake.ok, true);
});

test("persistence: lastHandshake round-trips through the file", () => {
  const { path: filePath, dir } = tmpFile("persist-handshake");
  try {
    const r1 = createMcpLaunchRegistry({ persistencePath: filePath });
    r1.declare("a", [{ command: "x", label: "primary" }]);
    r1.recordHandshake("a", "primary", {
      ok: true,
      status: "tools-listed",
      toolCount: 4,
      serverName: "persisted",
    });
    const r2 = createMcpLaunchRegistry({ persistencePath: filePath });
    const [entry] = r2.list();
    assert.ok(entry.lastHandshake);
    assert.equal(entry.lastHandshake.toolCount, 4);
    assert.equal(entry.lastHandshake.serverName, "persisted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordHandshake: declare() that REPLACES launches drops old lastHandshake", () => {
  // Re-running an install plan with new launches shouldn't carry over
  // the previous handshake — those results referenced different commands.
  const r = createMcpLaunchRegistry();
  r.declare("x", [{ command: "old" }]);
  r.recordHandshake("x", "", { ok: true, status: "tools-listed", toolCount: 1 });
  r.declare("x", [{ command: "new" }]);
  const [entry] = r.list();
  assert.equal(entry.command, "new");
  assert.equal(entry.lastHandshake, undefined);
});

// ---- recordInstall / lastInstall ----

test("recordInstall: writes the same record to every launch under a building", () => {
  const r = createMcpLaunchRegistry();
  r.declare("multi", [
    { command: "a", label: "primary" },
    { command: "b", label: "secondary" },
  ]);
  const wrote = r.recordInstall("multi", { jobId: "job_42", ok: true, status: "ok" });
  assert.equal(wrote, true);
  const list = r.list();
  for (const entry of list) {
    assert.ok(entry.lastInstall);
    assert.equal(entry.lastInstall.ok, true);
    assert.equal(entry.lastInstall.status, "ok");
    assert.equal(entry.lastInstall.jobId, "job_42");
    assert.ok(typeof entry.lastInstall.at === "number");
  }
});

test("recordInstall: empty buildingId / unknown id is a no-op", () => {
  const r = createMcpLaunchRegistry();
  r.declare("a", [{ command: "x" }]);
  assert.equal(r.recordInstall("", { ok: true, status: "ok" }), false);
  assert.equal(r.recordInstall("ghost", { ok: true, status: "ok" }), false);
});

test("recordInstall: failed install records ok=false + reason", () => {
  const r = createMcpLaunchRegistry();
  r.declare("a", [{ command: "x" }]);
  r.recordInstall("a", { jobId: "job_1", ok: false, status: "failed", reason: "verify-failed" });
  const [entry] = r.list();
  assert.equal(entry.lastInstall.ok, false);
  assert.equal(entry.lastInstall.status, "failed");
  assert.equal(entry.lastInstall.reason, "verify-failed");
});

test("persistence: lastInstall round-trips through the file", () => {
  const { path: filePath, dir } = tmpFile("persist-install");
  try {
    const r1 = createMcpLaunchRegistry({ persistencePath: filePath });
    r1.declare("a", [{ command: "x" }]);
    r1.recordInstall("a", { jobId: "j", ok: true, status: "ok" });
    const r2 = createMcpLaunchRegistry({ persistencePath: filePath });
    const [entry] = r2.list();
    assert.ok(entry.lastInstall);
    assert.equal(entry.lastInstall.jobId, "j");
    assert.equal(entry.lastInstall.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("referencedSettings: returns ${...} keys across command + args + env", () => {
  const r = createMcpLaunchRegistry();
  r.declare("a", [
    { command: "${binPath}", args: ["-y", "${pkgName}", "${rootDir}"], env: { TOK: "${apiToken}", BASE: "static" } },
  ]);
  r.declare("b", [
    { command: "node", args: ["server.js"], env: { K: "${apiToken}" } }, // shared with a
  ]);
  const refs = r.referencedSettings();
  assert.deepEqual([...refs].sort(), ["apiToken", "binPath", "pkgName", "rootDir"]);
});

test("referencedSettings: empty registry returns empty set", () => {
  const r = createMcpLaunchRegistry();
  assert.equal(r.referencedSettings().size, 0);
});

test("referencedSettings: ignores plain strings without ${...}", () => {
  const r = createMcpLaunchRegistry();
  r.declare("a", [{ command: "node", args: ["server.js", "--token", "$NOT_A_TEMPLATE"] }]);
  assert.equal(r.referencedSettings().size, 0);
});

test("buildingsReferencingSettings: returns building ids whose launches reference any given key", () => {
  const r = createMcpLaunchRegistry();
  r.declare("uses-token", [{ command: "node", env: { TOK: "${apiToken}" } }]);
  r.declare("uses-url", [{ command: "node", args: ["${baseUrl}"] }]);
  r.declare("uses-both", [{ command: "${binPath}", env: { K: "${apiToken}" } }]);
  r.declare("uses-neither", [{ command: "node", args: ["server.js"] }]);
  assert.deepEqual(r.buildingsReferencingSettings(["apiToken"]).sort(), ["uses-both", "uses-token"]);
  assert.deepEqual(r.buildingsReferencingSettings(["baseUrl"]).sort(), ["uses-url"]);
  assert.deepEqual(r.buildingsReferencingSettings(["apiToken", "baseUrl"]).sort(), ["uses-both", "uses-token", "uses-url"]);
  assert.deepEqual(r.buildingsReferencingSettings(["unrelatedKey"]), []);
  assert.deepEqual(r.buildingsReferencingSettings([]), []);
});

test("clearLastHandshake: drops the per-launch field across every launch under that building", () => {
  const r = createMcpLaunchRegistry();
  r.declare("multi", [
    { command: "a", label: "primary" },
    { command: "b", label: "secondary" },
  ]);
  r.recordHandshake("multi", "primary", { ok: true, status: "tools-listed", toolCount: 1 });
  r.recordHandshake("multi", "secondary", { ok: true, status: "tools-listed", toolCount: 2 });
  assert.equal(r.clearLastHandshake("multi"), true);
  for (const entry of r.list()) {
    assert.equal(entry.lastHandshake, undefined);
  }
});

test("clearLastHandshake: empty / unknown / no-record → false", () => {
  const r = createMcpLaunchRegistry();
  assert.equal(r.clearLastHandshake(""), false);
  assert.equal(r.clearLastHandshake("ghost"), false);
  // Building exists, but never had a handshake recorded.
  r.declare("a", [{ command: "x" }]);
  assert.equal(r.clearLastHandshake("a"), false);
});

test("clearLastHandshake: persists the change to disk", () => {
  const { path: filePath, dir } = tmpFile("persist-clear-handshake");
  try {
    const r1 = createMcpLaunchRegistry({ persistencePath: filePath });
    r1.declare("a", [{ command: "x" }]);
    r1.recordHandshake("a", "", { ok: true, status: "tools-listed" });
    r1.clearLastHandshake("a");
    const r2 = createMcpLaunchRegistry({ persistencePath: filePath });
    const [entry] = r2.list();
    assert.equal(entry.lastHandshake, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordInstall: declare() replacing launches drops the old lastInstall", () => {
  const r = createMcpLaunchRegistry();
  r.declare("x", [{ command: "old" }]);
  r.recordInstall("x", { jobId: "j1", ok: true, status: "ok" });
  r.declare("x", [{ command: "new" }]);
  const [entry] = r.list();
  assert.equal(entry.command, "new");
  assert.equal(entry.lastInstall, undefined);
});
