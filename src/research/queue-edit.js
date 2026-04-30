// QUEUE table editor for project READMEs.
//
// This keeps the agent loop's next-move queue mechanically editable without
// rewriting the whole README. The table schema is:
//
//   | move | starting-point | why |
//
// API:
//   listQueueRows({ readmePath })
//   addQueueRow({ readmePath, row, position })
//   removeQueueRow({ readmePath, slug })
//   reprioritizeQueueRow({ readmePath, slug, position })

import { readFile, rename, writeFile } from "node:fs/promises";
import { parseProjectReadme } from "./project-readme.js";

const MAX_QUEUE_ROWS = 5;
const PIPE_OR_NEWLINE = /[|\n\r]/;

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

function locateQueueTable(text) {
  const headingMatch = /^(#{1,6})\s+QUEUE\s*$/m.exec(text);
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
  return { headingEnd, separatorEnd, tableEnd: cursor };
}

function deriveStartingPointLabel(startingPoint) {
  const text = String(startingPoint || "").trim();
  if (!text) return "";
  const treeMatch = text.match(/\/tree\/([^?#]+)$/);
  if (treeMatch) return treeMatch[1];
  const commitMatch = text.match(/\/commit\/([a-f0-9]{7,40})/i);
  if (commitMatch) return commitMatch[1].slice(0, 12);
  return text.length > 56 ? "starting point" : text;
}

export function renderQueueRow(row) {
  const slug = sanitizeCell(row.slug);
  const startingPoint = sanitizeCell(row.startingPoint || row.startingPointUrl || "");
  const startingPointLabel = sanitizeCell(row.startingPointLabel || deriveStartingPointLabel(startingPoint));
  const why = sanitizeCell(row.why);
  const startCell = /^https?:\/\//i.test(startingPoint)
    ? `[${startingPointLabel || "starting point"}](${startingPoint})`
    : startingPoint;
  return `| ${slug} | ${startCell} | ${why} |`;
}

function validateQueueRow(row) {
  const errs = [];
  if (!row?.slug || !String(row.slug).trim()) errs.push("slug is required");
  if (!row?.startingPoint && !row?.startingPointUrl) errs.push("startingPoint is required");
  if (!row?.why || !String(row.why).trim()) errs.push("why is required");
  if (row?.slug && PIPE_OR_NEWLINE.test(String(row.slug))) errs.push("slug contains pipe or newline");
  if (errs.length) throw new Error(`invalid QUEUE row: ${errs.join("; ")}`);
}

function normalizeQueueRow(row) {
  return {
    slug: String(row.slug || "").trim(),
    startingPoint: String(row.startingPoint || row.startingPointUrl || "").trim(),
    startingPointLabel: String(row.startingPointLabel || "").trim(),
    why: String(row.why || "").trim(),
  };
}

function normalizeExistingQueueRows(text) {
  return parseProjectReadme(text).queue.map((row) => ({
    slug: row.slug,
    startingPoint: row.startingPointUrl || row.startingPointLabel,
    startingPointLabel: row.startingPointLabel,
    why: row.why,
  }));
}

function clampInsertPosition(position, length) {
  const numeric = Math.floor(Number(position));
  if (!Number.isFinite(numeric) || numeric < 1) {
    return length;
  }
  return Math.min(Math.max(numeric - 1, 0), length);
}

function replaceQueueRows(text, loc, rows) {
  const body = rows.length ? `${rows.map(renderQueueRow).join("\n")}\n` : "";
  return text.slice(0, loc.separatorEnd) + body + text.slice(loc.tableEnd);
}

export async function listQueueRows({ readmePath } = {}) {
  if (!readmePath) throw new TypeError("readmePath is required");
  const text = await readFile(readmePath, "utf8");
  const loc = locateQueueTable(text);
  if (!loc) throw new Error(`no QUEUE table found in ${readmePath} (expected '## QUEUE' heading + table)`);
  return { readmePath, rows: normalizeExistingQueueRows(text) };
}

export async function addQueueRow({ readmePath, row, position } = {}) {
  if (!readmePath) throw new TypeError("readmePath is required");
  validateQueueRow(row);
  const text = await readFile(readmePath, "utf8");
  const loc = locateQueueTable(text);
  if (!loc) throw new Error(`no QUEUE table found in ${readmePath} (expected '## QUEUE' heading + table)`);

  const rows = normalizeExistingQueueRows(text);
  const normalized = normalizeQueueRow(row);
  if (rows.some((entry) => entry.slug === normalized.slug)) {
    throw new Error(`QUEUE already has a row for slug "${normalized.slug}"`);
  }
  if (rows.length >= MAX_QUEUE_ROWS) {
    throw new Error(`QUEUE already has ${MAX_QUEUE_ROWS} rows; remove or reprioritize before adding "${normalized.slug}"`);
  }

  rows.splice(clampInsertPosition(position, rows.length), 0, normalized);
  await atomicWrite(readmePath, replaceQueueRows(text, loc, rows));
  return { readmePath, row: normalized, position: rows.findIndex((entry) => entry.slug === normalized.slug) + 1, added: true };
}

export async function removeQueueRow({ readmePath, slug } = {}) {
  if (!readmePath) throw new TypeError("readmePath is required");
  if (!slug || !String(slug).trim()) throw new Error("slug is required");
  const text = await readFile(readmePath, "utf8");
  const loc = locateQueueTable(text);
  if (!loc) throw new Error(`no QUEUE table found in ${readmePath}`);

  const trimmed = String(slug).trim();
  const rows = normalizeExistingQueueRows(text);
  const index = rows.findIndex((entry) => entry.slug === trimmed);
  if (index < 0) throw new Error(`QUEUE has no row for slug "${trimmed}"`);
  const [removedRow] = rows.splice(index, 1);

  await atomicWrite(readmePath, replaceQueueRows(text, loc, rows));
  return { readmePath, slug: trimmed, row: removedRow, removed: true };
}

export async function reprioritizeQueueRow({ readmePath, slug, position, toRow } = {}) {
  if (!readmePath) throw new TypeError("readmePath is required");
  if (!slug || !String(slug).trim()) throw new Error("slug is required");
  const text = await readFile(readmePath, "utf8");
  const loc = locateQueueTable(text);
  if (!loc) throw new Error(`no QUEUE table found in ${readmePath}`);

  const trimmed = String(slug).trim();
  const rows = normalizeExistingQueueRows(text);
  const index = rows.findIndex((entry) => entry.slug === trimmed);
  if (index < 0) throw new Error(`QUEUE has no row for slug "${trimmed}"`);
  const [row] = rows.splice(index, 1);
  rows.splice(clampInsertPosition(position ?? toRow, rows.length), 0, row);

  await atomicWrite(readmePath, replaceQueueRows(text, loc, rows));
  return { readmePath, slug: trimmed, row, position: rows.findIndex((entry) => entry.slug === trimmed) + 1, reprioritized: true };
}

export const __internal = {
  MAX_QUEUE_ROWS,
  deriveStartingPointLabel,
  locateQueueTable,
  renderQueueRow,
  sanitizeCell,
};
