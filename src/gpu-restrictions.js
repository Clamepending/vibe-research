import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Two files cooperate to make GPU restrictions work:
//
//   ~/.claude/gpu-manual-reservations.txt
//     Truth for the user's *manual* off-limits choices (right-click → Reserve).
//     Format: comma-separated GPU indices. Empty = no manual reservations.
//
//   ~/.claude/visible-gpus.txt
//     The DERIVED file the Claude Code Bash hook reads on every command.
//     Computed as: (all GPUs) − (manual reservations) − (auto-detected GPUs
//     occupied by another OS user). Format: comma-separated visible indices,
//     or "none" when every GPU is off-limits, or empty when nothing is.

const NONE_SENTINEL = "none";

function visibleFilePath() {
  return path.join(homedir(), ".claude", "visible-gpus.txt");
}

function manualFilePath() {
  return path.join(homedir(), ".claude", "gpu-manual-reservations.txt");
}

function parseVisibleSpec(spec) {
  const trimmed = String(spec ?? "").trim();
  if (!trimmed) {
    return { kind: "passthrough" };
  }
  if (trimmed.toLowerCase() === NONE_SENTINEL) {
    return { kind: "none" };
  }
  const indices = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((value) => Number.isInteger(value) && value >= 0);
  return { kind: "list", visible: indices };
}

function parseIndexList(spec) {
  return String(spec ?? "")
    .trim()
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((value) => Number.isInteger(value) && value >= 0);
}

async function readFileOrEmpty(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  // Atomic write so the Claude Code hook never sees a half-written file.
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, value, "utf8");
  await rename(tmp, file);
}

function dedupeSorted(indices) {
  return [...new Set(indices.filter((value) => Number.isInteger(value)))].sort(
    (a, b) => a - b,
  );
}

function unionIndices(...lists) {
  const set = new Set();
  for (const list of lists) {
    for (const value of list || []) {
      if (Number.isInteger(value)) set.add(value);
    }
  }
  return [...set].sort((a, b) => a - b);
}

// ----- Manual reservations ----------------------------------------------------

export async function readManualReservations(allIndices) {
  const all = new Set(
    (Array.isArray(allIndices) ? allIndices : []).filter((value) =>
      Number.isInteger(value),
    ),
  );
  const indices = parseIndexList(await readFileOrEmpty(manualFilePath()));
  // Drop indices that no longer correspond to a real GPU on this host.
  return all.size === 0
    ? dedupeSorted(indices)
    : dedupeSorted(indices.filter((value) => all.has(value)));
}

export async function writeManualReservations(offLimitsIndices, allIndices) {
  const all = new Set(
    (Array.isArray(allIndices) ? allIndices : []).filter((value) =>
      Number.isInteger(value),
    ),
  );
  const filtered = (Array.isArray(offLimitsIndices) ? offLimitsIndices : [])
    .filter((value) => Number.isInteger(value))
    .filter((value) => all.size === 0 || all.has(value));
  const sorted = dedupeSorted(filtered);
  await atomicWrite(manualFilePath(), sorted.length ? `${sorted.join(",")}\n` : "");
  return sorted;
}

// ----- Derived visible-gpus.txt ----------------------------------------------

// Writes the derived "visible" file based on the union of manual + foreign
// off-limits. The Bash hook reads this file. Returns the union (off-limits
// indices) the file represents.
export async function writeDerivedVisibleFile({
  allIndices,
  manualOffLimits = [],
  foreignOffLimits = [],
}) {
  const all = dedupeSorted(allIndices || []);
  const off = new Set(unionIndices(manualOffLimits, foreignOffLimits).filter(
    (value) => all.includes(value),
  ));

  if (off.size === 0) {
    await atomicWrite(visibleFilePath(), "");
    return [];
  }

  if (off.size === all.length && all.length > 0) {
    await atomicWrite(visibleFilePath(), `${NONE_SENTINEL}\n`);
    return [...all];
  }

  const visible = all.filter((index) => !off.has(index)).join(",");
  await atomicWrite(visibleFilePath(), `${visible}\n`);
  return [...off].sort((a, b) => a - b);
}

// Reads visible-gpus.txt (the DERIVED file) and returns the off-limits set
// it represents. Useful for surfacing the current effective union to the UI.
export async function readOffLimitsIndices(allIndices) {
  const all = (Array.isArray(allIndices) ? allIndices : []).filter((value) =>
    Number.isInteger(value),
  );
  const parsed = parseVisibleSpec(await readFileOrEmpty(visibleFilePath()));
  if (parsed.kind === "passthrough") return [];
  if (parsed.kind === "none") return dedupeSorted(all);
  const visible = new Set(parsed.visible);
  return all.filter((index) => !visible.has(index)).sort((a, b) => a - b);
}

// Backward-compat: callers that used to write the derived file directly. Now
// it interprets the input as the manual set and recomputes the derived file
// with no foreign reservations. The new POST endpoint should use
// writeManualReservations + writeDerivedVisibleFile explicitly.
export async function writeOffLimitsIndices(offLimitsIndices, allIndices) {
  const manual = await writeManualReservations(offLimitsIndices, allIndices);
  return writeDerivedVisibleFile({
    allIndices,
    manualOffLimits: manual,
    foreignOffLimits: [],
  });
}

export {
  visibleFilePath as getGpuRestrictionsControlFile,
  manualFilePath as getGpuManualReservationsFile,
};
