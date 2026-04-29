// Surgical insert of a new LOG row at the top of the project README's LOG
// table (newest-first, per CLAUDE.md). The agent calls this once per move
// resolution instead of hand-editing markdown.
//
// We work via string surgery on the existing README rather than a full
// parse + rebuild because:
//   1. The README has prose around the tables (GOAL, SUCCESS CRITERIA, etc.)
//      that the parser doesn't model.
//   2. The current writer (init.js renderProjectReadme) only builds from
//      scratch and would clobber any human edits.
//
// API:
//
//   const result = await appendLogRow({
//     readmePath,        // absolute path to README.md
//     row: {
//       date,            // YYYY-MM-DD; defaults to today
//       event,           // required, e.g. "resolved+admitted"
//       slug,            // required
//       summary,         // required
//       link,            // optional
//     },
//   });
//   // → { readmePath, row, inserted: true }

import { readFile, writeFile, rename } from "node:fs/promises";

// The CLAUDE.md schema for LOG row events. The "primary tag" is one of
// these; admission outcomes are appended as `+admitted` or `+evicted`.
// We don't enforce a strict whitelist — the agent might encode novel
// events — but we do reject obviously malformed inputs (empty strings,
// pipe characters that would break the table, newlines).
const PIPE_OR_NEWLINE = /[|\n\r]/;

function todayUtc() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function sanitizeCell(value) {
  // Markdown table cells: backslash-escape pipes, replace newlines with
  // spaces. The agent rarely wants a literal pipe in a summary, but if it
  // happens, this preserves the table's structural integrity.
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function validateRow(row) {
  if (!row) throw new Error("row is required");
  const errs = [];
  if (!row.event || !String(row.event).trim()) errs.push("event is required");
  if (!row.slug || !String(row.slug).trim()) errs.push("slug is required");
  if (!row.summary || !String(row.summary).trim()) errs.push("summary is required");
  if (row.event && PIPE_OR_NEWLINE.test(String(row.event))) errs.push("event contains pipe or newline");
  if (row.slug && PIPE_OR_NEWLINE.test(String(row.slug))) errs.push("slug contains pipe or newline");
  if (errs.length) throw new Error(`invalid LOG row: ${errs.join("; ")}`);
}

// Atomic write: tmp + rename. A Ctrl-C between writes can't leave the
// README half-edited.
async function atomicWrite(filePath, body) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, body, "utf8");
  await rename(tmpPath, filePath);
}

// Locate the LOG section's table separator line (the `|------|...` line
// directly after the header). Returns the index immediately after the
// separator's trailing newline, or -1 if not found.
function findLogTableInsertPoint(text) {
  // Anchor on a `## LOG` heading. The heading might be `# LOG` (rare) or
  // `## LOG` (canonical); we anchor on the canonical form.
  const headingMatch = /^(#{1,6})\s+LOG\s*$/m.exec(text);
  if (!headingMatch) return -1;
  const headingEnd = headingMatch.index + headingMatch[0].length;

  // From the heading, scan forward looking for the table header
  // (`| date | event | ...|`) followed by the separator (`|------|...`).
  // We allow 1-2 blank lines between the heading and the table.
  const tail = text.slice(headingEnd);
  const headerMatch = /\n+(\|[^\n]+\|)\n(\|[\s|:-]+\|)\n/.exec(tail);
  if (!headerMatch) return -1;

  // Insertion point = right after the separator's trailing newline.
  const separatorEndOffset = headerMatch.index + headerMatch[0].length;
  return headingEnd + separatorEndOffset;
}

export function renderLogRow(row) {
  const date = String(row.date || todayUtc());
  const event = sanitizeCell(row.event);
  const slug = sanitizeCell(row.slug);
  const summary = sanitizeCell(row.summary);
  const link = sanitizeCell(row.link || "");
  return `| ${date} | ${event} | ${slug} | ${summary} | ${link} |`;
}

export async function appendLogRow({ readmePath, row } = {}) {
  if (!readmePath) throw new TypeError("readmePath is required");
  validateRow(row);
  const text = await readFile(readmePath, "utf8");
  const insertOffset = findLogTableInsertPoint(text);
  if (insertOffset < 0) {
    throw new Error(`no LOG table found in ${readmePath} (expected '## LOG' heading + table)`);
  }
  const normalized = {
    date: row.date || todayUtc(),
    event: String(row.event).trim(),
    slug: String(row.slug).trim(),
    summary: String(row.summary).trim(),
    link: row.link ? String(row.link).trim() : "",
  };
  const newRow = `${renderLogRow(normalized)}\n`;
  const out = text.slice(0, insertOffset) + newRow + text.slice(insertOffset);
  await atomicWrite(readmePath, out);
  return { readmePath, row: normalized, inserted: true };
}

export const __internal = {
  findLogTableInsertPoint,
  sanitizeCell,
  todayUtc,
  validateRow,
};
