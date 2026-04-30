// LEADERBOARD table editor for project READMEs. Two operations:
//
//   insertLeaderboardRow({ readmePath, rank, row })
//     Insert at the given rank (1-indexed). Existing rows at >= rank
//     shift down. The leaderboard is capped at 5; if a row would land
//     at rank 6, it's returned as `evicted` so the caller (the agent)
//     can write the corresponding LOG row.
//
//   removeLeaderboardRow({ readmePath, slug })
//     Delete the row matching slug. Lower ranks shift up to fill.
//
// Same string-surgery + atomic-rename writes as log-append.js +
// active-edit.js. The README's leaderboard markdown table:
//
//   | rank | result | branch | commit | score / verdict |
//   |------|--------|--------|--------|-----------------|
//   | 1    | [<slug>](results/<slug>.md) | [r/<slug>](<branch_url>) | [<sha7>](<commit_url>) | <score> |
//
// The render emits links exactly that way; rank numbering is handled by
// the editor (so callers don't have to recompute on shift).

import { readFile, writeFile, rename } from "node:fs/promises";

const PIPE_OR_NEWLINE = /[|\n\r]/;
const LEADERBOARD_CAP = 5;

function sanitizeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
}

async function atomicWrite(filePath, body) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, body, "utf8");
  await rename(tmpPath, filePath);
}

// Locate the LEADERBOARD section: returns indices and the cleaned data
// rows (excluding header + separator). null if no table found.
function locateLeaderboardTable(text) {
  const headingMatch = /^(#{1,6})\s+LEADERBOARD\s*$/m.exec(text);
  if (!headingMatch) return null;
  const headingEnd = headingMatch.index + headingMatch[0].length;
  const tail = text.slice(headingEnd);
  const headerMatch = /\n+(\|[^\n]+\|)\n(\|[\s|:-]+\|)\n/.exec(tail);
  if (!headerMatch) return null;
  const separatorEnd = headingEnd + headerMatch.index + headerMatch[0].length;
  let cursor = separatorEnd;
  while (cursor < text.length) {
    const lineEnd = text.indexOf("\n", cursor);
    const line = text.slice(cursor, lineEnd === -1 ? text.length : lineEnd);
    if (!line.startsWith("|")) break;
    cursor = lineEnd === -1 ? text.length : lineEnd + 1;
  }
  // Parse the data rows.
  const tableBody = text.slice(separatorEnd, cursor);
  const dataLines = tableBody.split("\n").filter((l) => l.startsWith("|"));
  return {
    separatorEnd,
    tableEnd: cursor,
    dataLines,
    headerLine: headerMatch[1],
  };
}

// Parse one data line into { rank, slug, raw }. We keep the raw cells
// for everything except rank — the editor only needs to know the slug
// (for duplicate detection) and the original cell content (for shifting
// rows without losing their links).
function parseDataLine(line) {
  // Strip leading and trailing pipe, split, trim each.
  const inner = line.replace(/^\|/, "").replace(/\|\s*$/, "");
  const cells = inner.split("|").map((c) => c.trim());
  // Cell[0] = rank, Cell[1] = result link, Cell[2] = branch, Cell[3] = commit, Cell[4] = score.
  const rank = Number(cells[0]);
  // Extract slug from result column: matches `[<slug>](...)` or bare `<slug>`.
  let slug = cells[1] || "";
  const linkMatch = slug.match(/^\[([^\]]+)\]/);
  if (linkMatch) slug = linkMatch[1];
  return {
    rank: Number.isFinite(rank) ? rank : null,
    slug: slug.trim(),
    cells,
  };
}

function renderDataLine(rank, cells) {
  const out = [String(rank), ...cells.slice(1)];
  return `| ${out.map(sanitizeCell).join(" | ")} |`;
}

// Build the result-doc cell string `[<slug>](<resultPath>)`.
function renderResultCell(slug, resultPath) {
  const slugC = sanitizeCell(slug);
  const path = sanitizeCell(resultPath || "");
  return path ? `[${slugC}](${path})` : slugC;
}

// Build the branch cell `[r/<slug>](<branchUrl>)` (label extracted from /tree/<x>).
function renderBranchCell(branchUrl) {
  const url = sanitizeCell(branchUrl || "");
  if (!url) return "";
  const m = url.match(/\/tree\/([^?#]+)$/);
  return `[${m ? m[1] : url}](${url})`;
}

// Build the commit cell `[<sha7>](<commitUrl>)` (sha7 extracted from /commit/<sha>).
function renderCommitCell(commitUrl) {
  const url = sanitizeCell(commitUrl || "");
  if (!url) return "";
  const m = url.match(/\/commit\/([0-9a-f]+)/);
  const label = m ? m[1].slice(0, 7) : url;
  return `[${label}](${url})`;
}

export function renderLeaderboardRow({ rank, slug, resultPath, branchUrl, commitUrl, score }) {
  const cells = [
    String(rank),
    renderResultCell(slug, resultPath),
    renderBranchCell(branchUrl),
    renderCommitCell(commitUrl),
    sanitizeCell(score || ""),
  ];
  return `| ${cells.join(" | ")} |`;
}

function validateInsert(row, rank) {
  const errs = [];
  if (!Number.isInteger(rank) || rank < 1) errs.push("rank must be an integer >= 1");
  if (!row?.slug || !String(row.slug).trim()) errs.push("slug is required");
  if (row?.slug && PIPE_OR_NEWLINE.test(String(row.slug))) errs.push("slug contains pipe or newline");
  if (!row?.resultPath || !String(row.resultPath).trim()) errs.push("resultPath is required");
  if (!row?.branchUrl || !String(row.branchUrl).trim()) errs.push("branchUrl is required");
  if (!row?.commitUrl || !String(row.commitUrl).trim()) errs.push("commitUrl is required");
  if (!row?.score || !String(row.score).trim()) errs.push("score is required");
  if (errs.length) throw new Error(`invalid LEADERBOARD row: ${errs.join("; ")}`);
}

export async function insertLeaderboardRow({ readmePath, rank, row } = {}) {
  if (!readmePath) throw new TypeError("readmePath is required");
  validateInsert(row, rank);
  const text = await readFile(readmePath, "utf8");
  const loc = locateLeaderboardTable(text);
  if (!loc) throw new Error(`no LEADERBOARD table found in ${readmePath}`);

  const existing = loc.dataLines.map(parseDataLine);
  const slug = String(row.slug).trim();
  if (existing.some((r) => r.slug === slug)) {
    throw new Error(`LEADERBOARD already has a row for slug "${slug}"`);
  }
  if (rank > existing.length + 1) {
    throw new Error(`rank ${rank} would leave a gap (current leaderboard has ${existing.length} rows)`);
  }

  // Build new ordered list of (slug-or-newRow, resolvedCells).
  const inserted = {
    isNew: true,
    slug,
    cells: [
      String(rank),
      renderResultCell(slug, row.resultPath),
      renderBranchCell(row.branchUrl),
      renderCommitCell(row.commitUrl),
      sanitizeCell(row.score),
    ],
  };
  const merged = [];
  for (let i = 0; i < existing.length; i += 1) {
    const targetRank = merged.length + 1;
    if (targetRank === rank) merged.push(inserted);
    merged.push({ isNew: false, slug: existing[i].slug, cells: existing[i].cells });
  }
  if (merged.length < rank) merged.push(inserted); // append at the tail

  // Shift ranks: every row's rank is its position + 1.
  let evicted = null;
  const out = [];
  for (let i = 0; i < merged.length; i += 1) {
    const newRank = i + 1;
    if (newRank > LEADERBOARD_CAP) {
      // Pop the row that fell off the end.
      const fallen = merged[i];
      evicted = {
        slug: fallen.slug,
        previousRank: Number(fallen.cells[0]) || (newRank), // best-effort
        cells: fallen.cells,
      };
      continue;
    }
    out.push(renderDataLine(newRank, merged[i].cells));
  }

  const newTable = out.join("\n") + (out.length ? "\n" : "");
  const updated = text.slice(0, loc.separatorEnd) + newTable + text.slice(loc.tableEnd);
  await atomicWrite(readmePath, updated);
  return { readmePath, inserted: { ...row, rank, slug }, evicted };
}

export async function removeLeaderboardRow({ readmePath, slug } = {}) {
  if (!readmePath) throw new TypeError("readmePath is required");
  if (!slug || !String(slug).trim()) throw new Error("slug is required");
  const trimmed = String(slug).trim();
  const text = await readFile(readmePath, "utf8");
  const loc = locateLeaderboardTable(text);
  if (!loc) throw new Error(`no LEADERBOARD table found in ${readmePath}`);

  const existing = loc.dataLines.map(parseDataLine);
  const idx = existing.findIndex((r) => r.slug === trimmed);
  if (idx < 0) throw new Error(`LEADERBOARD has no row for slug "${trimmed}"`);

  existing.splice(idx, 1);
  const out = existing.map((r, i) => renderDataLine(i + 1, r.cells));
  const newTable = out.join("\n") + (out.length ? "\n" : "");
  const updated = text.slice(0, loc.separatorEnd) + newTable + text.slice(loc.tableEnd);
  await atomicWrite(readmePath, updated);
  return { readmePath, removed: true, slug: trimmed };
}

export const __internal = {
  locateLeaderboardTable,
  parseDataLine,
  renderDataLine,
  renderResultCell,
  renderBranchCell,
  renderCommitCell,
  LEADERBOARD_CAP,
};
