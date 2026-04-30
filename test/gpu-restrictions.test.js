import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

let tmpHome;
let originalHome;
let mod;

test.before(async () => {
  tmpHome = await mkdtemp(path.join(os.tmpdir(), "gpu-restrictions-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  mod = await import("../src/gpu-restrictions.js");
});

test.after(async () => {
  process.env.HOME = originalHome;
  if (tmpHome) {
    await rm(tmpHome, { recursive: true, force: true });
  }
});

const ALL = [0, 1, 2, 3, 4, 5];

async function setSpec(value) {
  const file = mod.getGpuRestrictionsControlFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

async function readSpecFile() {
  const file = mod.getGpuRestrictionsControlFile();
  return readFile(file, "utf8");
}

test("missing file is treated as no restriction", async () => {
  const file = mod.getGpuRestrictionsControlFile();
  await rm(file, { force: true });
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), []);
});

test("empty file is treated as no restriction", async () => {
  await setSpec("");
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), []);
});

test("explicit visible-list yields complement as off-limits", async () => {
  await setSpec("0,1,2,3");
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), [4, 5]);
});

test("the 'none' sentinel marks every GPU off-limits", async () => {
  await setSpec("none");
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), [0, 1, 2, 3, 4, 5]);
});

test("whitespace and case in the spec are tolerated", async () => {
  await setSpec(" 1, 3 ,5 \n");
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), [0, 2, 4]);
  await setSpec("  NONE  ");
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), [0, 1, 2, 3, 4, 5]);
});

test("writing an empty off-limits set produces an empty file", async () => {
  await mod.writeOffLimitsIndices([], ALL);
  assert.equal(await readSpecFile(), "");
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), []);
});

test("writing a partial off-limits set produces a comma-separated visible list", async () => {
  await mod.writeOffLimitsIndices([4, 5], ALL);
  assert.equal(await readSpecFile(), "0,1,2,3\n");
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), [4, 5]);
});

test("writing every index yields the 'none' sentinel", async () => {
  await mod.writeOffLimitsIndices(ALL, ALL);
  assert.equal(await readSpecFile(), "none\n");
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), [0, 1, 2, 3, 4, 5]);
});

test("indices outside the known GPU set are silently dropped on write", async () => {
  await mod.writeOffLimitsIndices([0, 99], ALL);
  assert.equal(await readSpecFile(), "1,2,3,4,5\n");
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), [0]);
});

test("write/read round-trip preserves the off-limits set", async () => {
  for (const set of [[], [0], [2, 4], [0, 1, 2, 3, 4, 5]]) {
    await mod.writeOffLimitsIndices(set, ALL);
    assert.deepEqual(await mod.readOffLimitsIndices(ALL), set);
  }
});

// ----- Manual reservations + derived-file split (new contract) ----------------

async function readManualFile() {
  return readFile(mod.getGpuManualReservationsFile(), "utf8").catch(() => "");
}

test("manual reservations file: round-trip", async () => {
  await mod.writeManualReservations([4, 5], ALL);
  assert.equal((await readManualFile()).trim(), "4,5");
  assert.deepEqual(await mod.readManualReservations(ALL), [4, 5]);

  await mod.writeManualReservations([], ALL);
  assert.equal(await readManualFile(), "");
  assert.deepEqual(await mod.readManualReservations(ALL), []);
});

test("manual reservations: indices outside known GPUs are dropped", async () => {
  await mod.writeManualReservations([2, 99, -1, 1.5], ALL);
  assert.deepEqual(await mod.readManualReservations(ALL), [2]);
});

test("derived file: union of manual + foreign", async () => {
  // No manual, foreign on [4]: off-limits = [4]
  await mod.writeManualReservations([], ALL);
  await mod.writeDerivedVisibleFile({
    allIndices: ALL,
    manualOffLimits: [],
    foreignOffLimits: [4],
  });
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), [4]);

  // Manual on [5], foreign on [4]: off-limits = [4, 5]
  await mod.writeDerivedVisibleFile({
    allIndices: ALL,
    manualOffLimits: [5],
    foreignOffLimits: [4],
  });
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), [4, 5]);

  // Same GPU manual AND foreign: counted once.
  await mod.writeDerivedVisibleFile({
    allIndices: ALL,
    manualOffLimits: [4],
    foreignOffLimits: [4],
  });
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), [4]);

  // All GPUs covered → "none" sentinel
  await mod.writeDerivedVisibleFile({
    allIndices: ALL,
    manualOffLimits: [0, 1, 2],
    foreignOffLimits: [3, 4, 5],
  });
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), [0, 1, 2, 3, 4, 5]);

  // Empty union → empty file (passthrough)
  await mod.writeDerivedVisibleFile({
    allIndices: ALL,
    manualOffLimits: [],
    foreignOffLimits: [],
  });
  assert.deepEqual(await mod.readOffLimitsIndices(ALL), []);
});

test("derived file does not include indices outside allIndices (stale GPUs)", async () => {
  await mod.writeDerivedVisibleFile({
    allIndices: [0, 1],
    manualOffLimits: [99],
    foreignOffLimits: [42],
  });
  assert.deepEqual(await mod.readOffLimitsIndices([0, 1]), []);
});

test("manual and derived files live at different paths", async () => {
  assert.notEqual(
    mod.getGpuRestrictionsControlFile(),
    mod.getGpuManualReservationsFile(),
  );
});
