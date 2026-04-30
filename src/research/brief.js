// Research briefs bridge open-ended brainstorming and disciplined moves.
//
// A brief is a durable project artifact:
//
//   projects/<name>/briefs/<slug>.md
//
// It captures the current theory, grounding, candidate moves, recommendation,
// budget, and triggers that should send the project back to ideation.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { addQueueRow, listQueueRows } from "./queue-edit.js";

export const VALID_RESEARCH_PHASES = new Set([
  "ideation",
  "research-grounding",
  "move-design",
  "experiment",
  "hillclimb",
  "synthesis",
  "review",
]);

const BRIEF_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_QUEUE_ROWS = 5;
const TABLE_ROW = /^\|(.*)\|\s*$/;
const TABLE_DIVIDER = /^\|\s*[-:]+/;

function nowIso() {
  return new Date().toISOString();
}

function trimString(value) {
  return String(value ?? "").trim();
}

function escapeMarkdownTableCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function normalizeSlug(value, fallback = "") {
  const slug = trimString(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map(trimString).filter(Boolean);
  }
  const text = trimString(value);
  return text ? [text] : [];
}

function normalizePhase(value, fallback = "move-design") {
  const phase = trimString(value || fallback).toLowerCase();
  return VALID_RESEARCH_PHASES.has(phase) ? phase : fallback;
}

function normalizeCandidateMove(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const move = normalizeSlug(source.move || source.slug || source.name);
  const startingPoint = trimString(source.startingPoint || source.startingPointUrl || source.start || "main") || "main";
  const why = trimString(source.why || source.reason);
  const hypothesis = trimString(source.hypothesis || source.question);
  if (!move) {
    return null;
  }
  return { move, startingPoint, why, hypothesis };
}

export function parseCandidateMoveSpec(value) {
  const parts = String(value ?? "")
    .split("|")
    .map((part) => part.trim());
  if (!parts[0]) {
    return null;
  }
  return normalizeCandidateMove({
    move: parts[0],
    startingPoint: parts[1] || "main",
    why: parts[2] || "",
    hypothesis: parts[3] || "",
  });
}

function renderList(lines, fallback = "_none yet_") {
  const entries = normalizeList(lines);
  if (!entries.length) {
    return fallback;
  }
  return entries.map((line) => `- ${line}`).join("\n");
}

function renderCandidateMovesTable(moves) {
  const normalized = moves.map(normalizeCandidateMove).filter(Boolean);
  const lines = [
    "| move | starting-point | why | hypothesis |",
    "|------|----------------|-----|------------|",
  ];
  for (const move of normalized) {
    lines.push(`| ${escapeMarkdownTableCell(move.move)} | ${escapeMarkdownTableCell(move.startingPoint || "main")} | ${escapeMarkdownTableCell(move.why)} | ${escapeMarkdownTableCell(move.hypothesis)} |`);
  }
  return lines.join("\n");
}

function renderYamlScalar(key, value) {
  const text = trimString(value);
  if (!text) {
    return `${key}: ""`;
  }
  return `${key}: ${JSON.stringify(text)}`;
}

export function renderResearchBriefMarkdown(input = {}) {
  const slug = normalizeSlug(input.slug);
  if (!slug || !BRIEF_SLUG_PATTERN.test(slug)) {
    throw new Error(`brief slug must match ${BRIEF_SLUG_PATTERN}; got "${input.slug || ""}"`);
  }

  const phase = normalizePhase(input.phase, "move-design");
  const status = trimString(input.status || "draft") || "draft";
  const createdAt = trimString(input.createdAt) || nowIso();
  const updatedAt = trimString(input.updatedAt) || createdAt;
  const candidateMoves = (input.candidateMoves || []).map(normalizeCandidateMove).filter(Boolean);
  const recommendedMove = normalizeSlug(input.recommendedMove || candidateMoves[0]?.move || "");
  const title = trimString(input.title || slug);
  const question = trimString(input.question) || "_what are we trying to decide?_";
  const currentTheory = trimString(input.currentTheory || input.theory) || "_current model of the problem_";
  const sourceText = trimString(input.sourceText || input.source || "");

  return [
    "---",
    renderYamlScalar("slug", slug),
    renderYamlScalar("phase", phase),
    renderYamlScalar("status", status),
    renderYamlScalar("created_at", createdAt),
    renderYamlScalar("updated_at", updatedAt),
    renderYamlScalar("recommended_move", recommendedMove),
    "---",
    "",
    `# Research Brief: ${title}`,
    "",
    "## Question",
    "",
    question,
    "",
    "## Current Theory",
    "",
    currentTheory,
    "",
    "## Research Grounding",
    "",
    renderList(input.grounding, "_no grounding recorded yet_"),
    "",
    "## Candidate Moves",
    "",
    renderCandidateMovesTable(candidateMoves),
    "",
    "## Recommended First Move",
    "",
    recommendedMove
      ? `\`${recommendedMove}\``
      : "_no recommendation yet_",
    "",
    "## Rejected Moves",
    "",
    renderList(input.rejectedMoves, "_none rejected yet_"),
    "",
    "## Budget",
    "",
    trimString(input.budget) || "_budget not declared_",
    "",
    "## Return To Brainstorm Triggers",
    "",
    renderList(input.returnTriggers, "- plateau without explanation\n- falsifier fires\n- metric stops matching the human question"),
    "",
    "## Human Review",
    "",
    trimString(input.humanReview) || "_pending_",
    "",
    "## Source Notes",
    "",
    sourceText || "_none_",
    "",
  ].join("\n");
}

function splitLines(text) {
  return String(text || "").replace(/\r\n/g, "\n").split("\n");
}

function parseFrontmatter(text) {
  const lines = splitLines(text);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, bodyStartLine: 0 };
  }
  const frontmatter = {};
  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      endIndex = index;
      break;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const raw = match[2].trim();
    try {
      frontmatter[match[1]] = raw ? JSON.parse(raw) : "";
    } catch {
      frontmatter[match[1]] = raw.replace(/^"|"$/g, "");
    }
  }
  return {
    frontmatter,
    bodyStartLine: endIndex >= 0 ? endIndex + 1 : 0,
  };
}

function readSections(text) {
  const lines = splitLines(text);
  const sections = new Map();
  let currentName = "";
  let currentBody = [];
  const flush = () => {
    if (currentName) {
      sections.set(currentName, currentBody.join("\n").trim());
    }
  };

  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      currentName = match[1].trim();
      currentBody = [];
      continue;
    }
    if (currentName) {
      currentBody.push(line);
    }
  }
  flush();
  return sections;
}

function splitTableRow(line) {
  const match = TABLE_ROW.exec(line);
  if (!match) return null;
  return match[1].split("|").map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function parseCandidateMovesTable(body) {
  const rows = [];
  let sawHeader = false;
  for (const line of splitLines(body)) {
    if (!line.trim()) continue;
    if (TABLE_DIVIDER.test(line)) continue;
    const cells = splitTableRow(line);
    if (!cells) continue;
    if (!sawHeader) {
      sawHeader = true;
      continue;
    }
    const [move, startingPoint, why, hypothesis] = cells;
    const normalized = normalizeCandidateMove({ move, startingPoint, why, hypothesis });
    if (normalized) rows.push(normalized);
  }
  return rows;
}

function parseBulletList(body) {
  return splitLines(body)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

export function parseResearchBriefMarkdown(text) {
  const { frontmatter } = parseFrontmatter(text);
  const sections = readSections(text);
  const candidateMoves = parseCandidateMovesTable(sections.get("Candidate Moves") || "");
  const recommendedFromSection = (sections.get("Recommended First Move") || "")
    .replace(/`/g, "")
    .replace(/^_.*_$/g, "")
    .trim();

  return {
    slug: normalizeSlug(frontmatter.slug || ""),
    phase: normalizePhase(frontmatter.phase, "move-design"),
    status: trimString(frontmatter.status || "draft"),
    createdAt: trimString(frontmatter.created_at || frontmatter.createdAt),
    updatedAt: trimString(frontmatter.updated_at || frontmatter.updatedAt),
    recommendedMove: normalizeSlug(frontmatter.recommended_move || frontmatter.recommendedMove || recommendedFromSection),
    question: sections.get("Question") || "",
    currentTheory: sections.get("Current Theory") || "",
    grounding: parseBulletList(sections.get("Research Grounding") || ""),
    candidateMoves,
    rejectedMoves: parseBulletList(sections.get("Rejected Moves") || ""),
    budget: sections.get("Budget") || "",
    returnTriggers: parseBulletList(sections.get("Return To Brainstorm Triggers") || ""),
    humanReview: sections.get("Human Review") || "",
    sourceText: sections.get("Source Notes") || "",
  };
}

async function atomicWrite(filePath, body) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, body, "utf8");
  await rename(tmpPath, filePath);
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function getBriefPath(projectDir, slug) {
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug || !BRIEF_SLUG_PATTERN.test(normalizedSlug)) {
    throw new Error(`brief slug must match ${BRIEF_SLUG_PATTERN}; got "${slug || ""}"`);
  }
  return path.join(projectDir, "briefs", `${normalizedSlug}.md`);
}

export function getResearchStatePath(projectDir) {
  return path.join(projectDir, ".vibe-research", "research-state.json");
}

export async function createResearchBrief({
  projectDir,
  force = false,
  ...brief
} = {}) {
  if (!projectDir) throw new TypeError("projectDir is required");
  const slug = normalizeSlug(brief.slug);
  const briefPath = getBriefPath(projectDir, slug);
  if ((await pathExists(briefPath)) && !force) {
    throw new Error(`brief already exists at ${briefPath} (pass --force to overwrite)`);
  }

  const body = renderResearchBriefMarkdown({ ...brief, slug });
  await mkdir(path.dirname(briefPath), { recursive: true });
  await atomicWrite(briefPath, body);
  return {
    projectDir,
    briefPath,
    brief: parseResearchBriefMarkdown(body),
    wrote: [briefPath],
  };
}

export async function readResearchBrief({ projectDir, slug, briefPath } = {}) {
  const targetPath = briefPath
    ? path.resolve(briefPath)
    : getBriefPath(projectDir, slug);
  const text = await readFile(targetPath, "utf8");
  return {
    briefPath: targetPath,
    text,
    brief: parseResearchBriefMarkdown(text),
  };
}

export async function readResearchState({ projectDir } = {}) {
  if (!projectDir) throw new TypeError("projectDir is required");
  const statePath = getResearchStatePath(projectDir);
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      phase: normalizePhase(parsed.phase, "ideation"),
      briefSlug: trimString(parsed.briefSlug || parsed.brief || ""),
      summary: trimString(parsed.summary || ""),
      updatedAt: trimString(parsed.updatedAt || ""),
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { phase: "ideation", briefSlug: "", summary: "", updatedAt: "", history: [] };
  }
}

export async function updateResearchState({
  projectDir,
  phase,
  briefSlug = "",
  summary = "",
} = {}) {
  if (!projectDir) throw new TypeError("projectDir is required");
  const nextPhase = normalizePhase(phase, "");
  if (!nextPhase) {
    throw new Error(`phase must be one of: ${Array.from(VALID_RESEARCH_PHASES).join(", ")}`);
  }

  const previous = await readResearchState({ projectDir });
  const updatedAt = nowIso();
  const entry = {
    phase: nextPhase,
    briefSlug: normalizeSlug(briefSlug || previous.briefSlug || ""),
    summary: trimString(summary),
    at: updatedAt,
  };
  const next = {
    phase: nextPhase,
    briefSlug: entry.briefSlug,
    summary: entry.summary,
    updatedAt,
    history: [...previous.history, entry].slice(-100),
  };
  const statePath = getResearchStatePath(projectDir);
  await mkdir(path.dirname(statePath), { recursive: true });
  await atomicWrite(statePath, `${JSON.stringify(next, null, 2)}\n`);
  return { projectDir, statePath, state: next };
}

function chooseCandidateMoves(brief, { all = false, moveSlugs = [] } = {}) {
  const candidates = Array.isArray(brief.candidateMoves) ? brief.candidateMoves : [];
  if (!candidates.length) {
    throw new Error("brief has no candidate moves to compile");
  }

  const requested = normalizeList(moveSlugs).map((slug) => normalizeSlug(slug));
  if (requested.length) {
    const bySlug = new Map(candidates.map((move) => [move.move, move]));
    const missing = requested.filter((slug) => !bySlug.has(slug));
    if (missing.length) {
      throw new Error(`brief has no candidate move(s): ${missing.join(", ")}`);
    }
    return requested.map((slug) => bySlug.get(slug));
  }

  if (all) {
    return candidates;
  }

  const recommended = normalizeSlug(brief.recommendedMove);
  return candidates.filter((move) => move.move === recommended).slice(0, 1)
    || candidates.slice(0, 1);
}

export async function compileBriefToQueue({
  projectDir,
  slug,
  briefPath,
  all = false,
  moveSlugs = [],
  position,
  dryRun = false,
} = {}) {
  if (!projectDir) throw new TypeError("projectDir is required");
  const { briefPath: resolvedBriefPath, brief } = await readResearchBrief({ projectDir, slug, briefPath });
  let selectedMoves = chooseCandidateMoves(brief, { all, moveSlugs });
  if (!selectedMoves.length) {
    selectedMoves = brief.candidateMoves.slice(0, 1);
  }

  const queue = await listQueueRows({ readmePath: path.join(projectDir, "README.md") });
  const duplicate = selectedMoves.find((move) => queue.rows.some((row) => row.slug === move.move));
  if (duplicate) {
    throw new Error(`QUEUE already has a row for slug "${duplicate.move}"`);
  }
  if (queue.rows.length + selectedMoves.length > MAX_QUEUE_ROWS) {
    throw new Error(`QUEUE has ${queue.rows.length} row(s); compiling ${selectedMoves.length} would exceed cap ${MAX_QUEUE_ROWS}`);
  }

  const queueRows = selectedMoves.map((move) => ({
    slug: move.move,
    startingPoint: move.startingPoint || "main",
    why: move.why || move.hypothesis || `from brief ${brief.slug}`,
  }));

  if (dryRun) {
    return {
      projectDir,
      briefPath: resolvedBriefPath,
      brief,
      queueRows,
      dryRun: true,
      compiled: false,
    };
  }

  const added = [];
  for (let index = 0; index < queueRows.length; index += 1) {
    const row = queueRows[index];
    const insertPosition = position ? Number(position) + index : undefined;
    const result = await addQueueRow({
      readmePath: path.join(projectDir, "README.md"),
      row,
      position: insertPosition,
    });
    added.push(result.row);
  }

  return {
    projectDir,
    briefPath: resolvedBriefPath,
    brief,
    queueRows: added,
    dryRun: false,
    compiled: true,
  };
}

export const __internal = {
  BRIEF_SLUG_PATTERN,
  chooseCandidateMoves,
  normalizeCandidateMove,
  normalizePhase,
  normalizeSlug,
  parseCandidateMovesTable,
  renderCandidateMovesTable,
};
