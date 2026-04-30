// Parser for projects/<name>/README.md and projects/<name>/LOG.md.
//
// Turns the structured-markdown README into a JavaScript object whose shape
// mirrors the contract in CLAUDE.md ("The Files You Maintain In The Library").
// We deliberately avoid a generic markdown parser dep — the shape is small
// enough that regex + state machine is shorter, faster, and more honest about
// what we accept.
//
// The LOG lives in a sibling LOG.md file (one project, one log). The README's
// `## LOG` section is just a pointer to that file — agents in the loop don't
// need the full event history to act, so we keep it out of the README's
// hot path. `loadProjectLog(projectDir)` reads and parses LOG.md.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseBudgetSection } from "./budget.js";

const SECTION_HEADER = /^##\s+(.+?)\s*$/;
const TABLE_ROW = /^\|(.*)\|\s*$/;
const TABLE_DIVIDER = /^\|\s*[-:]+/;
const LINK_INLINE = /\[([^\]]+)\]\(([^)]+)\)/g;

function splitLines(text) {
  return String(text || "").replace(/\r\n/g, "\n").split("\n");
}

function splitTableRow(line) {
  const match = TABLE_ROW.exec(line);
  if (!match) return null;
  return match[1]
    .split("|")
    .map((cell) => cell.trim());
}

function extractFirstLink(cell) {
  LINK_INLINE.lastIndex = 0;
  const match = LINK_INLINE.exec(cell || "");
  if (!match) {
    return { label: cell || "", url: "" };
  }
  return { label: match[1], url: match[2] };
}

function stripWrappingBackticks(value) {
  return String(value || "").trim().replace(/^`+|`+$/g, "");
}

function extractAllLinks(cell) {
  const links = [];
  let match;
  LINK_INLINE.lastIndex = 0;
  while ((match = LINK_INLINE.exec(cell || ""))) {
    links.push({ label: match[1], url: match[2] });
  }
  return links;
}

function readSections(lines) {
  const sections = new Map();
  let currentName = null;
  let currentBody = [];

  const flush = () => {
    if (currentName !== null) {
      sections.set(currentName, currentBody.join("\n"));
    }
  };

  for (const line of lines) {
    const headerMatch = SECTION_HEADER.exec(line);
    if (headerMatch) {
      flush();
      currentName = headerMatch[1].trim();
      currentBody = [];
      continue;
    }
    if (currentName !== null) {
      currentBody.push(line);
    }
  }
  flush();

  return sections;
}

function isPlaceholderCell(cell) {
  const trimmed = String(cell || "").trim();
  if (!trimmed) return true;
  // em-dash, en-dash, hyphen, italic placeholder comments like *(empty)*.
  if (/^[—–\-]+$/.test(trimmed)) return true;
  if (/^\*?\(\s*empty[^)]*\)\*?$/i.test(trimmed)) return true;
  return false;
}

function isPlaceholderRow(cells) {
  if (!cells.length) return true;
  return cells.every(isPlaceholderCell);
}

function readTable(body) {
  const lines = splitLines(body);
  const rows = [];
  let header = null;

  for (const line of lines) {
    if (TABLE_DIVIDER.test(line)) {
      continue;
    }
    const cells = splitTableRow(line);
    if (!cells) {
      if (rows.length || header) {
        // table ended
      }
      continue;
    }
    if (!header) {
      header = cells;
      continue;
    }
    if (isPlaceholderRow(cells)) continue;
    rows.push(cells);
  }

  return { header: header || [], rows };
}

function plainText(body) {
  return splitLines(body)
    .filter((line) => line.trim().length)
    .join("\n")
    .trim();
}

function parseSuccessCriteria(body) {
  return splitLines(body)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function parseRankingCriterion(body) {
  const text = plainText(body);
  // Strip leading markdown noise: backticks and bullet markers.
  const stripped = text.replace(/^[`*\s-]+/, "");
  const match = stripped.match(/^(quantitative|qualitative|mix)\s*:\s*([^`]*?)(?:\s*[`—–-]\s*|$)/i);
  if (!match) {
    return { kind: "unknown", raw: text };
  }
  return {
    kind: match[1].toLowerCase(),
    description: match[2].trim(),
    raw: text,
  };
}

function parseLeaderboard(body) {
  const { header, rows } = readTable(body);
  return rows.map((cells, index) => {
    const [rankCell, resultCell, branchCell, commitCell, scoreCell] = [
      cells[0] || "",
      cells[1] || "",
      cells[2] || "",
      cells[3] || "",
      cells[4] || "",
    ];
    const result = extractFirstLink(resultCell);
    const branch = extractFirstLink(branchCell);
    const commit = extractFirstLink(commitCell);
    return {
      rank: Number(rankCell.replace(/[^0-9-]/g, "")) || index + 1,
      slug: result.label.trim(),
      resultPath: result.url.trim(),
      branchUrl: branch.url.trim(),
      commitUrl: commit.url.trim(),
      score: scoreCell.trim(),
      header,
    };
  });
}

function parseInsights(body) {
  return splitLines(body)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const stripped = line.slice(2).trim();
      const linkMatch = stripped.match(/^\[([^\]]+)\]\(([^)]+)\)\s*[-—]\s*(.*)$/);
      if (!linkMatch) {
        return { slug: "", path: "", recap: stripped };
      }
      return {
        slug: linkMatch[1].trim(),
        path: linkMatch[2].trim(),
        recap: linkMatch[3].trim(),
      };
    })
    .filter((row) => row.slug || row.recap);
}

function parseActive(body) {
  const { header, rows } = readTable(body);
  return rows.map((cells) => {
    const [moveCell, resultCell, branchCell, agentCell, startedCell] = [
      cells[0] || "",
      cells[1] || "",
      cells[2] || "",
      cells[3] || "",
      cells[4] || "",
    ];
    const result = extractFirstLink(resultCell);
    const branch = extractFirstLink(branchCell);
    return {
      slug: moveCell.trim(),
      resultPath: result.url.trim(),
      branchUrl: branch.url.trim(),
      agent: agentCell.trim(),
      started: startedCell.trim(),
      header,
    };
  });
}

function parseQueue(body) {
  const { header, rows } = readTable(body);
  return rows.map((cells) => {
    const [moveCell, startCell, whyCell] = [
      cells[0] || "",
      cells[1] || "",
      cells[2] || "",
    ];
    const startingPoint = extractFirstLink(startCell);
    return {
      slug: moveCell.trim(),
      startingPointUrl: startingPoint.url.trim() || startCell.trim(),
      startingPointLabel: startingPoint.label.trim() || startCell.trim(),
      why: whyCell.trim(),
      header,
    };
  });
}

function parseLog(body) {
  const { header, rows } = readTable(body);
  return rows.map((cells) => {
    const [date, event, slug, summary, linkCell] = [
      cells[0] || "",
      cells[1] || "",
      cells[2] || "",
      cells[3] || "",
      cells[4] || "",
    ];
    const link = extractFirstLink(linkCell);
    return {
      date: date.trim(),
      event: event.trim(),
      slug: slug.trim(),
      summary: summary.trim(),
      linkLabel: link.label.trim(),
      linkUrl: link.url.trim(),
      header,
    };
  });
}

// Parse a standalone LOG.md body. Same row schema as the legacy in-README
// LOG section, but the table is the only first-class artifact in the file —
// everything else is intro prose.
export function parseLogTable(text) {
  const lines = splitLines(text);
  // Find the first table separator line and treat the line above it as the
  // header. Anything before that is intro prose; anything after stops at the
  // next blank-then-non-table line.
  let headerIdx = -1;
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (TABLE_DIVIDER.test(lines[i + 1]) && TABLE_ROW.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return [];
  const tableBody = lines.slice(headerIdx).join("\n");
  return parseLog(tableBody);
}

export async function loadProjectLog(projectDir) {
  if (!projectDir) throw new TypeError("projectDir is required");
  const logPath = path.join(projectDir, "LOG.md");
  let text;
  try {
    text = await readFile(logPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { path: logPath, exists: false, rows: [] };
    }
    throw err;
  }
  return { path: logPath, exists: true, rows: parseLogTable(text) };
}

export function parseProjectReadme(text) {
  const sections = readSections(splitLines(text));

  const goal = plainText(sections.get("GOAL") || "");
  const codeRepoBody = plainText(sections.get("CODE REPO") || "");
  const codeRepoLink = extractFirstLink(codeRepoBody);
  const successCriteria = parseSuccessCriteria(sections.get("SUCCESS CRITERIA") || "");
  const budget = parseBudgetSection(sections.get("BUDGET") || "");
  const rankingCriterion = parseRankingCriterion(sections.get("RANKING CRITERION") || "");
  const leaderboard = parseLeaderboard(sections.get("LEADERBOARD") || "");
  const insights = parseInsights(sections.get("INSIGHTS") || "");
  const active = parseActive(sections.get("ACTIVE") || "");
  const queue = parseQueue(sections.get("QUEUE") || "");
  // The LOG lives in LOG.md; the README's `## LOG` section is just a pointer.
  // We still parse the section body so the doctor can warn if it finds a
  // populated table there (legacy README, needs migration).
  const legacyLog = parseLog(sections.get("LOG") || "");

  return {
    goal,
    codeRepo: {
      raw: codeRepoBody,
      url: codeRepoLink.url || stripWrappingBackticks(codeRepoBody),
    },
    successCriteria,
    budget,
    rankingCriterion,
    leaderboard,
    insights,
    active,
    queue,
    log: [], // populated by loadProjectLog(projectDir) — see doctor.js
    legacyLog,
    sections: Array.from(sections.keys()),
  };
}

export const __internal = {
  splitLines,
  splitTableRow,
  extractFirstLink,
  extractAllLinks,
  readSections,
  readTable,
  parseRankingCriterion,
  parseLog,
};
