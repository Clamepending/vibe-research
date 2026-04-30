// vr-research-vacuum — tier project binaries to `.archive/` with a
// manifest, never delete. Reversible via --restore.
//
// Three operations:
//   - planVacuum(projectDir, opts) → { candidates, pinned, total* }
//       Walk the project, classify each file, return a plan. Pure: no
//       filesystem mutations. Used for `--dry-run` (the default).
//   - applyVacuum(projectDir, opts) → { moved, manifestPath }
//       Apply a previously-computed plan: move files into .archive/,
//       append rows to manifest.tsv. Atomic-rename writes per move.
//   - restoreFromArchive(projectDir, originalPath, opts) → { restored }
//       Inverse: move file back, remove manifest row.
//   - readManifest(projectDir) → { rows, headers, manifestPath }
//       For listing / reasoning. Used by paper-lint to follow
//       pointers when checking figure existence.
//
// Default policy (hardcoded; override via opts):
//
//   - Tier candidates: files whose extension matches BINARY_EXTENSIONS
//     AND mtime older than `ageDays` (default 90)
//   - Pin (never tier):
//       * any file under `.archive/`, `benchmark/`, or with a TEXT_EXTENSIONS
//         extension (.md / .tsv / .txt / .json / .yaml / .yml)
//       * any figure referenced by a result doc whose slug appears in the
//         README LOG with a `falsified` event tag (negative-result evidence)
//
// Why string-walk instead of a full project-aware crawl: the doctor +
// project-readme parser already understand README structure; vacuum is
// a separate file-level concern. Keeping it isolated means paper-lint
// adopting "follow manifest pointers" can use readManifest() without
// pulling in the whole vacuum lifecycle.

import { readFile, writeFile, rename, stat, readdir, mkdir, unlink, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseProjectReadme } from "./project-readme.js";

export const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf",
  ".pt", ".ckpt", ".bin", ".safetensors",
  ".npz", ".npy", ".pkl", ".pickle",
  ".tar", ".gz", ".tgz", ".zip", ".bz2", ".xz",
  ".log",
]);

export const TEXT_EXTENSIONS_PINNED = new Set([
  ".md", ".tsv", ".csv", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini",
]);

export const ARCHIVE_DIRNAME = ".archive";
export const MANIFEST_FILENAME = "manifest.tsv";

const MANIFEST_HEADERS = [
  "original_path", "sha256", "original_size", "tier_destination", "tiered_at", "reason",
];

const DEFAULT_AGE_DAYS = 90;

// ----- helpers -----

async function pathExists(absPath) {
  try { await stat(absPath); return true; } catch { return false; }
}

async function sha256OfFile(absPath) {
  const buf = await readFile(absPath);
  const h = createHash("sha256");
  h.update(buf);
  return h.digest("hex");
}

function nowIso() { return new Date().toISOString(); }

async function atomicWriteFile(filePath, body) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, body, "utf8");
  await rename(tmpPath, filePath);
}

// ----- manifest read/write -----

export async function readManifest(projectDir) {
  const archiveDir = path.join(projectDir, ARCHIVE_DIRNAME);
  const manifestPath = path.join(archiveDir, MANIFEST_FILENAME);
  if (!(await pathExists(manifestPath))) {
    return { headers: MANIFEST_HEADERS.slice(), rows: [], manifestPath };
  }
  const text = await readFile(manifestPath, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (!lines.length) return { headers: MANIFEST_HEADERS.slice(), rows: [], manifestPath };
  const headers = lines[0].split("\t");
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i].split("\t");
    const row = {};
    for (let h = 0; h < headers.length; h += 1) row[headers[h]] = cells[h] ?? "";
    rows.push(row);
  }
  return { headers, rows, manifestPath };
}

function serializeManifest({ headers, rows }) {
  const out = [headers.join("\t")];
  for (const row of rows) out.push(headers.map((h) => sanitizeCell(row[h])).join("\t"));
  return `${out.join("\n")}\n`;
}

function sanitizeCell(value) {
  return String(value ?? "").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
}

async function writeManifest(projectDir, manifest) {
  const archiveDir = path.join(projectDir, ARCHIVE_DIRNAME);
  await mkdir(archiveDir, { recursive: true });
  const manifestPath = path.join(archiveDir, MANIFEST_FILENAME);
  await atomicWriteFile(manifestPath, serializeManifest(manifest));
  return manifestPath;
}

// Resolve an `original_path` (which we always store project-relative) to
// its archived location: <projectDir>/.archive/<original_path>.
export function archivedPath(projectDir, originalPath) {
  return path.join(projectDir, ARCHIVE_DIRNAME, originalPath);
}

// ----- file walking -----

async function* walkFiles(rootAbsPath, projectDir) {
  let entries;
  try { entries = await readdir(rootAbsPath, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const childAbs = path.join(rootAbsPath, entry.name);
    const rel = path.relative(projectDir, childAbs);
    // Never descend into our own archive dir.
    if (rel === ARCHIVE_DIRNAME || rel.startsWith(`${ARCHIVE_DIRNAME}${path.sep}`)) continue;
    // Skip dotfiles other than .archive (we don't tier .git, .claude, etc.).
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      yield* walkFiles(childAbs, projectDir);
    } else if (entry.isFile()) {
      yield { absPath: childAbs, relPath: rel };
    }
  }
}

// ----- negative-result figure pinning -----

// Parse the project README for slugs whose LOG event tag contains
// `falsified`. The LOG schema lets the primary tag compound with
// `+admitted` / `+evicted`, e.g. `falsified+admitted`. We match any
// row whose event includes `falsified`.
function falsifiedSlugs(parsedReadme) {
  const slugs = new Set();
  for (const row of parsedReadme.log) {
    const event = String(row.event || "").toLowerCase();
    if (!event.includes("falsified")) continue;
    if (row.slug) slugs.add(String(row.slug).trim());
  }
  return slugs;
}

// Extract `figures/<name>` style references from a result-doc body.
// Conservative: anything that looks like a figure path. The regex
// captures the path AFTER `figures/` but only matches characters
// reasonable for filenames (letters, digits, dot, dash, underscore).
function extractFigureRefs(text) {
  const refs = new Set();
  const re = /(?:^|[^\w/])figures\/([\w.-]+)/g;
  let m;
  while ((m = re.exec(text || ""))) refs.add(m[1]);
  return refs;
}

async function collectFalsifiedFigures(projectDir, parsedReadme) {
  const pinned = new Set();
  const slugs = falsifiedSlugs(parsedReadme);
  for (const slug of slugs) {
    const docPath = path.join(projectDir, "results", `${slug}.md`);
    if (!(await pathExists(docPath))) continue;
    let body;
    try { body = await readFile(docPath, "utf8"); } catch { continue; }
    for (const fname of extractFigureRefs(body)) {
      pinned.add(path.posix.join("figures", fname));
    }
  }
  return pinned;
}

// ----- planning + applying -----

export async function planVacuum(projectDir, {
  ageDays = DEFAULT_AGE_DAYS,
  binaryExtensions = BINARY_EXTENSIONS,
  textExtensions = TEXT_EXTENSIONS_PINNED,
  now = Date.now(),
} = {}) {
  if (!projectDir) throw new TypeError("projectDir is required");
  let parsed;
  try {
    const readmeText = await readFile(path.join(projectDir, "README.md"), "utf8");
    parsed = parseProjectReadme(readmeText);
  } catch {
    parsed = { log: [], leaderboard: [], active: [], queue: [] };
  }
  const pinnedFigures = await collectFalsifiedFigures(projectDir, parsed);

  const candidates = [];
  const pinned = [];
  let totalCandidateBytes = 0;
  let totalScanned = 0;

  const ageMs = ageDays * 24 * 60 * 60 * 1000;
  const cutoff = now - ageMs;

  for await (const file of walkFiles(projectDir, projectDir)) {
    totalScanned += 1;
    const ext = path.extname(file.relPath).toLowerCase();
    let info;
    try { info = await stat(file.absPath); } catch { continue; }

    const reasons = [];
    // Pin TEXT_EXTENSIONS_PINNED entirely.
    if (textExtensions.has(ext)) reasons.push("pinned: text format");
    // Pin everything under benchmark/ (the bench is sacred per the contract).
    const normalisedRel = file.relPath.split(path.sep).join("/");
    if (normalisedRel === "benchmark" || normalisedRel.startsWith("benchmark/")) {
      reasons.push("pinned: benchmark/");
    }
    // Pin figures referenced by falsified result docs (negative-result evidence).
    if (pinnedFigures.has(normalisedRel)) reasons.push("pinned: cited by a falsified result doc");
    // Only consider binary extensions for archival.
    if (!binaryExtensions.has(ext)) {
      if (!reasons.length) reasons.push("not in archive set (extension)");
      pinned.push({ ...file, size: info.size, reasons });
      continue;
    }
    // Age gate.
    if (info.mtimeMs > cutoff) {
      reasons.push(`pinned: mtime ${Math.round((now - info.mtimeMs) / (24 * 60 * 60 * 1000))}d old (< ${ageDays}d threshold)`);
      pinned.push({ ...file, size: info.size, reasons });
      continue;
    }
    if (reasons.length) {
      pinned.push({ ...file, size: info.size, reasons });
      continue;
    }
    candidates.push({
      ...file,
      size: info.size,
      mtimeMs: info.mtimeMs,
      reason: `binary ${ext}; mtime ${Math.round((now - info.mtimeMs) / (24 * 60 * 60 * 1000))}d > ${ageDays}d`,
    });
    totalCandidateBytes += info.size;
  }

  return {
    projectDir,
    ageDays,
    candidates,
    pinned,
    totalScanned,
    totalCandidateBytes,
  };
}

export async function applyVacuum(projectDir, plan, { now = nowIso() } = {}) {
  if (!plan || !Array.isArray(plan.candidates)) throw new TypeError("plan with candidates[] is required");
  const manifest = await readManifest(projectDir);
  const moved = [];

  for (const cand of plan.candidates) {
    const sha = await sha256OfFile(cand.absPath);
    const dest = archivedPath(projectDir, cand.relPath);
    await mkdir(path.dirname(dest), { recursive: true });
    // Skip if already in archive (idempotent re-runs).
    if (await pathExists(dest)) {
      // Treat as "already done": remove the original (since it's
      // duplicative) and update manifest. But be conservative — only
      // unlink the source if its sha matches the destination's.
      const destSha = await sha256OfFile(dest);
      if (destSha === sha) {
        try { await unlink(cand.absPath); } catch {}
      }
      continue;
    }
    await rename(cand.absPath, dest);
    const relForManifest = cand.relPath.split(path.sep).join("/");
    const archiveRel = path.join(ARCHIVE_DIRNAME, cand.relPath).split(path.sep).join("/");
    manifest.rows.push({
      original_path: relForManifest,
      sha256: sha,
      original_size: String(cand.size),
      tier_destination: archiveRel,
      tiered_at: now,
      reason: cand.reason || "default policy",
    });
    moved.push({ originalPath: relForManifest, archivedPath: archiveRel, size: cand.size, sha256: sha });
  }

  const manifestPath = await writeManifest(projectDir, manifest);
  return { moved, manifestPath };
}

export async function restoreFromArchive(projectDir, originalPath) {
  if (!projectDir) throw new TypeError("projectDir is required");
  if (!originalPath) throw new TypeError("originalPath is required");
  const normalised = String(originalPath).split(path.sep).join("/");
  const manifest = await readManifest(projectDir);
  const idx = manifest.rows.findIndex((r) => r.original_path === normalised);
  if (idx < 0) throw new Error(`no manifest row for "${normalised}"`);
  const row = manifest.rows[idx];
  const archived = archivedPath(projectDir, normalised);
  if (!(await pathExists(archived))) {
    throw new Error(`archived file missing on disk: ${archived} (manifest says it should be there)`);
  }
  const original = path.join(projectDir, normalised);
  if (await pathExists(original)) {
    throw new Error(`refusing to overwrite existing file at ${original}; move it aside first`);
  }
  await mkdir(path.dirname(original), { recursive: true });
  await rename(archived, original);
  manifest.rows.splice(idx, 1);
  await writeManifest(projectDir, manifest);
  return { restored: true, originalPath: normalised, sha256: row.sha256 };
}

// Plan a purge: enumerate everything under .archive/ and the manifest
// rows. Pure (no mutations). Used for --purge dry-run.
export async function planPurge(projectDir) {
  if (!projectDir) throw new TypeError("projectDir is required");
  const archiveDir = path.join(projectDir, ARCHIVE_DIRNAME);
  if (!(await pathExists(archiveDir))) {
    return { projectDir, archiveDir, archivedFiles: [], totalBytes: 0, manifestRows: 0 };
  }
  const manifest = await readManifest(projectDir);
  const archivedFiles = [];
  let totalBytes = 0;
  // Walk .archive/ excluding the manifest file itself (we report it separately).
  async function* walk(absRoot) {
    let entries;
    try { entries = await readdir(absRoot, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const child = path.join(absRoot, entry.name);
      if (entry.isDirectory()) yield* walk(child);
      else if (entry.isFile()) yield child;
    }
  }
  for await (const abs of walk(archiveDir)) {
    if (abs === manifest.manifestPath) continue;
    let info;
    try { info = await stat(abs); } catch { continue; }
    archivedFiles.push({ absPath: abs, relPath: path.relative(projectDir, abs), size: info.size });
    totalBytes += info.size;
  }
  return {
    projectDir,
    archiveDir,
    archivedFiles,
    totalBytes,
    manifestRows: manifest.rows.length,
    manifestPath: manifest.manifestPath,
  };
}

// Apply a purge: physically remove the entire .archive/ subtree.
// Destructive — manifest rows are GONE after this. The audit trail
// they preserved is lost; that's the user's deliberate choice when
// they pick option (a) in the design discussion. The alternative
// (manifest survives with a `purged_at` column) is option (b), which
// we don't ship as the default per the design call (the user picked
// `a` — clean slate).
export async function applyPurge(projectDir) {
  if (!projectDir) throw new TypeError("projectDir is required");
  const archiveDir = path.join(projectDir, ARCHIVE_DIRNAME);
  if (!(await pathExists(archiveDir))) {
    return { projectDir, archiveDir, removed: 0, totalBytes: 0 };
  }
  const plan = await planPurge(projectDir);
  // rm -rf the whole subtree (Node's `rm` with `recursive: true`).
  await rm(archiveDir, { recursive: true, force: true });
  return {
    projectDir,
    archiveDir,
    removed: plan.archivedFiles.length,
    totalBytes: plan.totalBytes,
    manifestRowsDropped: plan.manifestRows,
  };
}

// Used by paper-lint and doctor: given a project-relative figure path,
// return the absolute path it currently lives at (original location, or
// the archived location if it's been tiered). null if neither exists.
export async function resolveArtifactPath(projectDir, relativePath) {
  if (!projectDir || !relativePath) return null;
  const normalised = String(relativePath).split(path.sep).join("/");
  const original = path.join(projectDir, normalised);
  if (await pathExists(original)) return original;
  const archived = archivedPath(projectDir, normalised);
  if (await pathExists(archived)) return archived;
  return null;
}

export const __internal = {
  falsifiedSlugs,
  extractFigureRefs,
  collectFalsifiedFigures,
  serializeManifest,
  sanitizeCell,
};
