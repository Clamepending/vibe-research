// ACTIVE table editor for project READMEs. Two operations:
//
//   1. addActiveRow  — insert a new claim at the top of the ACTIVE table
//      (used at loop step 3 when the agent claims a move).
//   2. removeActiveRow — delete the row whose slug matches (used at
//      loop step 9 after a move resolves).
//
// Same string-surgery + atomic-write approach as log-append.js so prose
// and other tables in the README are untouched.
//
// API:
//
//   const r1 = await addActiveRow({
//     readmePath,
//     row: {
//       slug,           // required
//       resultPath,     // required, e.g. "results/v3-cand.md"
//       branchUrl,      // required, e.g. "https://github.com/.../tree/r/v3-cand"
//       agent,          // optional, defaults to "0"
//       started,        // optional, YYYY-MM-DD, defaults to today UTC
//     },
//   });
//   const r2 = await removeActiveRow({ readmePath, slug });
//   //  { readmePath, slug, removed: true }   or  /not found/

import { readFile, writeFile, rename } from "node:fs/promises";

const PIPE_OR_NEWLINE = /[|\n\r]/;

function todayUtc() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function sanitizeCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

async function atomicWrite(filePath, body) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, body, "utf8");
  await rename(tmpPath, filePath);
}

// Find the ACTIVE table separator and return:
//   { headingEnd, separatorEnd, tableEnd }
// where:
//   headingEnd   = index just after the `## ACTIVE` line's trailing newline
//   separatorEnd = index just after the `|------|` separator line
//   tableEnd     = index of the first non-table line (next `## ` or end-of-file)
// or null if the table can't be located.
function locateActiveTable(text) {
  const headingMatch = /^(#{1,6})\s+ACTIVE\s*$/m.exec(text);
  if (!headingMatch) return null;
  const headingEnd = headingMatch.index + headingMatch[0].length;
  const tail = text.slice(headingEnd);
  const headerMatch = /\n+(\|[^\n]+\|)\n(\|[\s|:-]+\|)\n/.exec(tail);
  if (!headerMatch) return null;
  const separatorEnd = headingEnd + headerMatch.index + headerMatch[0].length;
  // tableEnd: scan forward from separatorEnd until a non-row line (blank or
  // a markdown heading or end-of-file).
  let cursor = separatorEnd;
  while (cursor < text.length) {
    const lineEnd = text.indexOf("\n", cursor);
    const line = text.slice(cursor, lineEnd === -1 ? text.length : lineEnd);
    if (!line.startsWith("|")) break;
    cursor = lineEnd === -1 ? text.length : lineEnd + 1;
  }
  return { headingEnd, separatorEnd, tableEnd: cursor };
}

export function renderActiveRow({ slug, resultPath, branchUrl, agent, started }) {
  const slugC = sanitizeCell(slug);
  const result = sanitizeCell(resultPath || "");
  const branch = sanitizeCell(branchUrl || "");
  const agentC = sanitizeCell(agent || "0");
  const startedC = sanitizeCell(started || todayUtc());

  // result column is `[<slug>](<resultPath>)` per the schema.
  const resultCell = result ? `[${slugC}](${result})` : "";
  // branch column is `[r/<slug>](<branchUrl>)` — extract the suffix after
  // `/tree/` for the link text, or fall back to the full URL.
  let branchLabel = branch;
  const treeMatch = branch.match(/\/tree\/([^?#]+)$/);
  if (treeMatch) branchLabel = treeMatch[1];
  const branchCell = branch ? `[${branchLabel}](${branch})` : "";

  return `| ${slugC} | ${resultCell} | ${branchCell} | ${agentC} | ${startedC} |`;
}

function validateAdd(row) {
  const errs = [];
  if (!row?.slug || !String(row.slug).trim()) errs.push("slug is required");
  if (!row?.resultPath || !String(row.resultPath).trim()) errs.push("resultPath is required");
  if (!row?.branchUrl || !String(row.branchUrl).trim()) errs.push("branchUrl is required");
  if (row?.slug && PIPE_OR_NEWLINE.test(String(row.slug))) errs.push("slug contains pipe or newline");
  if (errs.length) throw new Error(`invalid ACTIVE row: ${errs.join("; ")}`);
}

export async function addActiveRow({ readmePath, row } = {}) {
  if (!readmePath) throw new TypeError("readmePath is required");
  validateAdd(row);
  const text = await readFile(readmePath, "utf8");
  const loc = locateActiveTable(text);
  if (!loc) throw new Error(`no ACTIVE table found in ${readmePath} (expected '## ACTIVE' heading + table)`);

  // Refuse to add a duplicate slug — the agent already has this move
  // claimed, so re-claim is a bug.
  const existing = text.slice(loc.separatorEnd, loc.tableEnd);
  const escapedSlug = String(row.slug).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^\\|\\s*${escapedSlug}\\s*\\|`, "m").test(existing)) {
    throw new Error(`ACTIVE already has a row for slug "${row.slug}"`);
  }

  const normalized = {
    slug: String(row.slug).trim(),
    resultPath: String(row.resultPath).trim(),
    branchUrl: String(row.branchUrl).trim(),
    agent: row.agent ? String(row.agent).trim() : "0",
    started: row.started ? String(row.started).trim() : todayUtc(),
  };
  const newRow = `${renderActiveRow(normalized)}\n`;
  const out = text.slice(0, loc.separatorEnd) + newRow + text.slice(loc.separatorEnd);
  await atomicWrite(readmePath, out);
  return { readmePath, row: normalized, added: true };
}

export async function removeActiveRow({ readmePath, slug } = {}) {
  if (!readmePath) throw new TypeError("readmePath is required");
  if (!slug || !String(slug).trim()) throw new Error("slug is required");
  const trimmed = String(slug).trim();
  const text = await readFile(readmePath, "utf8");
  const loc = locateActiveTable(text);
  if (!loc) throw new Error(`no ACTIVE table found in ${readmePath}`);

  // Find a row whose first cell (between leading | and first inner |)
  // trims to the requested slug.
  const tableBody = text.slice(loc.separatorEnd, loc.tableEnd);
  const escapedSlug = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rowMatch = new RegExp(`^\\|\\s*${escapedSlug}\\s*\\|.*\\|\\s*$\\n?`, "m").exec(tableBody);
  if (!rowMatch) throw new Error(`ACTIVE has no row for slug "${trimmed}"`);

  const absoluteIdx = loc.separatorEnd + rowMatch.index;
  const out = text.slice(0, absoluteIdx) + text.slice(absoluteIdx + rowMatch[0].length);
  await atomicWrite(readmePath, out);
  return { readmePath, slug: trimmed, removed: true };
}

export const __internal = {
  locateActiveTable,
  renderActiveRow,
  todayUtc,
  sanitizeCell,
};
