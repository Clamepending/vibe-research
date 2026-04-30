import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

function controlFilePath() {
  return path.join(homedir(), ".claude", "visible-gpus.txt");
}

const NONE_SENTINEL = "none";

function parseSpec(spec) {
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

async function readSpec() {
  try {
    return await readFile(controlFilePath(), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeSpec(value) {
  const dir = path.dirname(controlFilePath());
  await mkdir(dir, { recursive: true });
  // Atomic write so a partial file never confuses the Claude Code hook.
  const tmp = `${controlFilePath()}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, value, "utf8");
  await rename(tmp, controlFilePath());
}

export async function readOffLimitsIndices(allIndices) {
  const all = (Array.isArray(allIndices) ? allIndices : []).filter((value) =>
    Number.isInteger(value),
  );
  const parsed = parseSpec(await readSpec());
  if (parsed.kind === "passthrough") {
    return [];
  }
  if (parsed.kind === "none") {
    return [...all].sort((a, b) => a - b);
  }
  const visible = new Set(parsed.visible);
  return all.filter((index) => !visible.has(index)).sort((a, b) => a - b);
}

export async function writeOffLimitsIndices(offLimitsIndices, allIndices) {
  const all = (Array.isArray(allIndices) ? allIndices : []).filter((value) =>
    Number.isInteger(value),
  );
  const off = new Set(
    (Array.isArray(offLimitsIndices) ? offLimitsIndices : [])
      .filter((value) => Number.isInteger(value))
      .filter((value) => all.includes(value)),
  );

  if (off.size === 0) {
    // No restriction → empty file → hook passes through.
    await writeSpec("");
    return [];
  }

  if (off.size === all.length && all.length > 0) {
    // All GPUs reserved → "none" sentinel hides them all.
    await writeSpec(`${NONE_SENTINEL}\n`);
    return [...all].sort((a, b) => a - b);
  }

  const visible = all
    .filter((index) => !off.has(index))
    .sort((a, b) => a - b)
    .join(",");
  await writeSpec(`${visible}\n`);
  return [...off].sort((a, b) => a - b);
}

export { controlFilePath as getGpuRestrictionsControlFile };
