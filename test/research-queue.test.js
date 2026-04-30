// Unit + CLI tests for src/research/queue-edit.js + bin/vr-research-queue.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  addQueueRow,
  listQueueRows,
  removeQueueRow,
  reprioritizeQueueRow,
  __internal,
} from "../src/research/queue-edit.js";

const VR_RESEARCH_QUEUE = path.resolve("bin/vr-research-queue");

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `${prefix}-`)); }

function runCli(args, { cwd, env = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [VR_RESEARCH_QUEUE, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} settle(null); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { stderr += `\n[spawn error] ${error.message}`; settle(null); });
    child.on("exit", (code) => settle(code));
  });
}

const README_BOILERPLATE = `# example

## GOAL

x

## ACTIVE

| move | result doc | branch | agent | started |
|------|-----------|--------|-------|---------|

## QUEUE

| move | starting-point | why |
|------|----------------|-----|
| v1-first | main | first move |
| v2-second | [r/v1-first](https://github.com/example/x/tree/r/v1-first) | build on first |

## LOG

| date | event | slug or ref | one-line summary | link |
|------|-------|-------------|-------------------|------|
`;

function makeProject(prefix = "vr-queue") {
  const dir = tmp(prefix);
  writeFileSync(join(dir, "README.md"), README_BOILERPLATE);
  return dir;
}

test("renderQueueRow: renders URL starting points as markdown links", () => {
  const row = __internal.renderQueueRow({
    slug: "v3",
    startingPoint: "https://github.com/example/x/tree/r/v2-second",
    why: "next",
  });
  assert.equal(row, "| v3 | [r/v2-second](https://github.com/example/x/tree/r/v2-second) | next |");
});

test("listQueueRows: parses existing QUEUE rows", async () => {
  const dir = makeProject("vr-queue-list");
  try {
    const result = await listQueueRows({ readmePath: join(dir, "README.md") });
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].slug, "v1-first");
    assert.equal(result.rows[1].startingPoint, "https://github.com/example/x/tree/r/v1-first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addQueueRow: inserts at requested 1-based position", async () => {
  const dir = makeProject("vr-queue-add");
  try {
    const readmePath = join(dir, "README.md");
    const result = await addQueueRow({
      readmePath,
      position: 1,
      row: {
        slug: "v0-preflight",
        startingPoint: "main",
        why: "inspect data first",
      },
    });
    assert.equal(result.added, true);
    assert.equal(result.position, 1);
    const after = readFileSync(readmePath, "utf8");
    assert.ok(after.indexOf("v0-preflight") < after.indexOf("v1-first"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addQueueRow: rejects duplicate slugs and queue overflow", async () => {
  const dir = makeProject("vr-queue-reject");
  try {
    const readmePath = join(dir, "README.md");
    await assert.rejects(
      addQueueRow({
        readmePath,
        row: { slug: "v1-first", startingPoint: "main", why: "duplicate" },
      }),
      /already has a row/,
    );

    await addQueueRow({ readmePath, row: { slug: "v3", startingPoint: "main", why: "x" } });
    await addQueueRow({ readmePath, row: { slug: "v4", startingPoint: "main", why: "x" } });
    await addQueueRow({ readmePath, row: { slug: "v5", startingPoint: "main", why: "x" } });
    await assert.rejects(
      addQueueRow({ readmePath, row: { slug: "v6", startingPoint: "main", why: "x" } }),
      /already has 5 rows/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeQueueRow: deletes only the QUEUE row", async () => {
  const dir = makeProject("vr-queue-rm");
  try {
    const readmePath = join(dir, "README.md");
    const result = await removeQueueRow({ readmePath, slug: "v1-first" });
    assert.equal(result.removed, true);
    const after = readFileSync(readmePath, "utf8");
    assert.equal(/\|\s*v1-first\s*\|\s*main\s*\|/.test(after), false);
    assert.match(after, /v2-second/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reprioritizeQueueRow: moves row to requested position", async () => {
  const dir = makeProject("vr-queue-move");
  try {
    const readmePath = join(dir, "README.md");
    const result = await reprioritizeQueueRow({ readmePath, slug: "v2-second", position: 1 });
    assert.equal(result.reprioritized, true);
    assert.equal(result.position, 1);
    const after = readFileSync(readmePath, "utf8");
    assert.ok(after.indexOf("v2-second") < after.indexOf("v1-first"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-queue --help: exits 0", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /vr-research-queue/);
});

test("vr-research-queue list: prints rows", async () => {
  const dir = makeProject("vr-queue-cli-list");
  try {
    const result = await runCli([dir, "list"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /1\. v1-first/);
    assert.match(result.stdout, /2\. v2-second/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-queue add/remove/reprioritize: edits README and supports JSON", async () => {
  const dir = makeProject("vr-queue-cli-edit");
  try {
    const add = await runCli([
      dir, "add",
      "--slug", "v0-cli",
      "--starting-point", "main",
      "--why", "from cli",
      "--position", "1",
      "--json",
    ]);
    assert.equal(add.status, 0, add.stderr);
    assert.equal(JSON.parse(add.stdout).row.slug, "v0-cli");

    const move = await runCli([dir, "reprioritize", "--slug", "v2-second", "--position", "1"]);
    assert.equal(move.status, 0, move.stderr);
    assert.match(move.stdout, /moved QUEUE row "v2-second"/);

    const remove = await runCli([dir, "remove", "--slug", "v0-cli"]);
    assert.equal(remove.status, 0, remove.stderr);
    assert.match(remove.stdout, /removed QUEUE row "v0-cli"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vr-research-queue: missing flags exit 2", async () => {
  const dir = makeProject("vr-queue-cli-missing");
  try {
    const result = await runCli([dir, "add", "--slug", "x"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--starting-point is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
