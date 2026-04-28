// Parser for projects/<name>/results/<slug>.md.
//
// Optional YAML frontmatter (between two `---` fences at the top) carries the
// machine-checkable noise rule for quantitative criteria. We accept a tiny
// subset of YAML — flat key/value pairs, scalars, and one-line arrays —
// because adding a YAML lib for a six-key block isn't worth the dep.

const FRONTMATTER_FENCE = /^---\s*$/;
const SECTION_HEADER = /^##\s+(.+?)\s*$/;
// Captures: index, optional sha, optional kind (change|rerun|analysis|bench),
// descriptor. The kind tag must come right after the @sha (if any) and before
// the colon. Cycle lines without an explicit kind default to `change`.
const CYCLE_LINE = /^[-\s*]*`?cycle\s+(\d+)(?:\s+@([0-9a-f]+))?(?:\s+(change|rerun|analysis|bench))?\s*:?\s*(.*?)`?\s*$/i;
const STATUS_VALUE = /^([a-z][a-z\-]+)/i;
const VALID_CYCLE_KINDS = new Set(["change", "rerun", "analysis", "bench"]);

function splitLines(text) {
  return String(text || "").replace(/\r\n/g, "\n").split("\n");
}

function parseScalar(raw) {
  const trimmed = String(raw || "").trim();
  if (trimmed === "") return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineArray(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }
  const inside = trimmed.slice(1, -1).trim();
  if (!inside) return [];
  return inside
    .split(",")
    .map((item) => parseScalar(item))
    .filter((item) => item !== "");
}

export function parseFrontmatter(text) {
  const lines = splitLines(text);
  if (!lines.length || !FRONTMATTER_FENCE.test(lines[0])) {
    return { frontmatter: null, body: text || "", endLine: 0 };
  }
  const out = {};
  let endLine = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FRONTMATTER_FENCE.test(lines[i])) {
      endLine = i;
      break;
    }
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx === -1) continue;
    const key = lines[i].slice(0, colonIdx).trim();
    const valueRaw = lines[i].slice(colonIdx + 1).trim();
    if (!key) continue;
    const arr = parseInlineArray(valueRaw);
    out[key] = arr !== null ? arr : parseScalar(valueRaw);
  }
  if (endLine === -1) {
    return { frontmatter: null, body: text || "", endLine: 0 };
  }
  return {
    frontmatter: out,
    body: lines.slice(endLine + 1).join("\n"),
    endLine,
  };
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

function plainText(body) {
  return splitLines(body)
    .filter((line) => line.trim().length)
    .join("\n")
    .trim();
}

function parseStatus(body) {
  const text = plainText(body);
  const match = STATUS_VALUE.exec(text);
  return match ? match[1].toLowerCase() : text.toLowerCase();
}

function parseCycles(body) {
  return splitLines(body)
    .map((line) => line.trim())
    .filter((line) => /cycle\s+\d+/i.test(line))
    .map((line) => {
      const match = CYCLE_LINE.exec(line);
      if (!match) {
        return { raw: line, kind: "change" };
      }
      const [, indexStr, sha, kindMatch, descriptor] = match;
      const kind = kindMatch ? kindMatch.toLowerCase() : "change";
      return {
        index: Number(indexStr),
        sha: sha || "",
        kind,
        descriptor: (descriptor || "").trim(),
        raw: line,
      };
    });
}

function parseDecision(body) {
  const decisionLine = splitLines(body)
    .map((line) => line.trim())
    .find((line) => /^Decision\s*:/i.test(line));
  if (!decisionLine) return "";
  return decisionLine.replace(/^Decision\s*:/i, "").trim();
}

export function parseResultDoc(text) {
  const { frontmatter, body } = parseFrontmatter(text);
  const lines = splitLines(body);
  const sections = readSections(lines);

  const titleMatch = lines.find((line) => /^#\s+/.test(line));
  const title = titleMatch ? titleMatch.replace(/^#\s+/, "").trim() : "";

  const takeaway = plainText(sections.get("TAKEAWAY") || "");
  const status = parseStatus(sections.get("STATUS") || "");
  const branchBody = plainText(sections.get("BRANCH") || "");
  const startingPointBody = plainText(sections.get("STARTING POINT") || "");
  const agentBody = plainText(sections.get("AGENT") || "");
  const question = plainText(sections.get("Question") || "");
  const hypothesis = plainText(sections.get("Hypothesis") || "");
  const cycles = parseCycles(sections.get("Cycles") || "");
  const leaderboardVerdict = sections.get("Leaderboard verdict") || "";
  const decision = parseDecision(leaderboardVerdict);

  // Derived: true if any cycle is `bench` kind. Bench moves modify
  // benchmark.md / rubrics / golden set rather than running an experiment;
  // admit gives them a special carve-out (no leaderboard touch).
  const isBenchMove = cycles.some((c) => c.kind === "bench");

  return {
    title,
    frontmatter: frontmatter || null,
    takeaway,
    status,
    branchBody,
    startingPointBody,
    agent: agentBody,
    question,
    hypothesis,
    cycles,
    isBenchMove,
    decision,
    sections: Array.from(sections.keys()),
  };
}

export const __internal = {
  parseFrontmatter,
  parseInlineArray,
  parseScalar,
  parseCycles,
  parseDecision,
  VALID_CYCLE_KINDS,
};
