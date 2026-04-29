// vr-research lint-paper — enforce paper.md conventions mechanically.
//
// Rules implemented:
//   1. Footnote IDs must be slug-prefixed (`[^slug-name]`) and unique.
//   2. Every footnote reference resolves to a definition, and every definition
//      is referenced at least once.
//   3. Each `### ` subsection inside the Results section starts with a markdown
//      image (`![alt](figures/...)`) within its first three non-blank lines.
//   4. Image paths inside Results subsections resolve to a real file under
//      the project's `figures/` directory.
//   5. Within Results subsections, any number ≥ 2 chars (digits/decimals/
//      percent) must be followed in the same paragraph by a footnote
//      reference. Numbers inside a fenced code block are exempt.

import { readFile, stat } from "node:fs/promises";
import { resolveArtifactPath } from "./vacuum.js";
import path from "node:path";

const FOOTNOTE_DEF_RE = /^\[\^([^\]]+)\]:\s*(.*)$/;
const FOOTNOTE_REF_RE = /\[\^([^\]]+)\]/g;
const SLUG_PREFIX_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+/i;
const IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/;
const NUMBER_RE = /(?<![\w.])(\d{2,}(?:[.,]\d+)?%?|\d+\.\d+%?)(?![\w.])/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^\s*```/;

function splitLines(text) {
  return String(text || "").replace(/\r\n/g, "\n").split("\n");
}

function makeIssue(severity, code, line, message) {
  return { severity, code, line, message };
}

async function pathExists(absolutePath) {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function findHeadingRanges(lines) {
  const ranges = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = HEADING_RE.exec(lines[i]);
    if (!match) continue;
    ranges.push({
      level: match[1].length,
      title: match[2].trim(),
      startLine: i,
      endLine: lines.length - 1,
    });
  }
  // Set each range's endLine to the line before the next same-or-higher-level
  // heading; lower-level (deeper) headings nest inside.
  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = i + 1; j < ranges.length; j += 1) {
      if (ranges[j].level <= ranges[i].level) {
        ranges[i].endLine = ranges[j].startLine - 1;
        break;
      }
    }
  }
  return ranges;
}

function findResultsSection(headingRanges) {
  return headingRanges.find((h) => h.level === 2 && /^[0-9]+\.?\s*Results$/i.test(h.title))
    || headingRanges.find((h) => h.level === 2 && /^Results$/i.test(h.title))
    || null;
}

function findResultsSubsections(headingRanges, resultsSection) {
  if (!resultsSection) return [];
  const out = [];
  let inSection = false;
  for (const heading of headingRanges) {
    if (heading === resultsSection) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (heading.level <= 2) break;
    if (heading.level === 3) out.push(heading);
  }
  return out;
}

function isInsideFence(lines, lineIndex) {
  let inside = false;
  for (let i = 0; i <= lineIndex; i += 1) {
    if (FENCE_RE.test(lines[i])) inside = !inside;
  }
  return inside;
}

function paragraphSpan(lines, startLine, endLine) {
  let start = startLine;
  while (start > 0 && lines[start - 1] && lines[start - 1].trim() !== "") start -= 1;
  let end = startLine;
  while (end + 1 <= endLine && lines[end + 1] && lines[end + 1].trim() !== "") end += 1;
  return { start, end };
}

async function checkFigure(projectDir, imagePath, lineNumber, issues) {
  if (/^https?:\/\//.test(imagePath)) {
    issues.push(makeIssue(
      "info",
      "figure_remote",
      lineNumber,
      `figure references a remote URL (${imagePath}); local figures under figures/ are preferred`,
    ));
    return;
  }
  // Follow vacuum manifest pointers: a figure that's been tiered to
  // .archive/ is still "present" — paper-lint should not flag it. The
  // resolveArtifactPath helper checks both the original location and
  // the archived location.
  const found = await resolveArtifactPath(projectDir, imagePath);
  if (!found) {
    issues.push(makeIssue(
      "error",
      "figure_missing",
      lineNumber,
      `figure file does not exist: ${imagePath} (also checked .archive/)`,
    ));
  }
}

async function lintResultsSubsection(lines, projectDir, subsection, issues) {
  let firstNonBlank = null;
  let firstNonBlankLineNumber = -1;
  for (let i = subsection.startLine + 1; i <= subsection.endLine && i - (subsection.startLine + 1) < 4; i += 1) {
    const stripped = lines[i] ? lines[i].trim() : "";
    if (!stripped) continue;
    firstNonBlank = stripped;
    firstNonBlankLineNumber = i + 1;
    break;
  }

  const imageMatch = firstNonBlank ? IMAGE_RE.exec(firstNonBlank) : null;
  if (!imageMatch) {
    issues.push(makeIssue(
      "warning",
      "results_subsection_missing_figure",
      subsection.startLine + 1,
      `Results subsection "${subsection.title}" does not lead with a markdown image`,
    ));
  } else {
    await checkFigure(projectDir, imageMatch[1].trim(), firstNonBlankLineNumber, issues);
  }
}

function checkBareNumbers(lines, subsection, issues) {
  const start = subsection.startLine + 1;
  const end = subsection.endLine;
  for (let i = start; i <= end; i += 1) {
    if (isInsideFence(lines, i)) continue;
    const line = lines[i] || "";
    if (!line.trim()) continue;

    NUMBER_RE.lastIndex = 0;
    let match;
    while ((match = NUMBER_RE.exec(line))) {
      const span = paragraphSpan(lines, i, end);
      let footnoteFound = false;
      for (let j = span.start; j <= span.end; j += 1) {
        const lineToCheck = lines[j] || "";
        FOOTNOTE_REF_RE.lastIndex = 0;
        if (FOOTNOTE_REF_RE.exec(lineToCheck)) {
          footnoteFound = true;
          break;
        }
      }
      if (!footnoteFound) {
        issues.push(makeIssue(
          "warning",
          "results_bare_number",
          i + 1,
          `bare number "${match[1]}" in Results paragraph has no footnote citation`,
        ));
        break;
      }
    }
  }
}

function checkFootnotes(lines, slugFromTitle) {
  const issues = [];
  const definitions = new Map();
  const references = new Map();

  for (let i = 0; i < lines.length; i += 1) {
    if (isInsideFence(lines, i)) continue;
    const defMatch = FOOTNOTE_DEF_RE.exec(lines[i] || "");
    if (defMatch) {
      const id = defMatch[1];
      if (definitions.has(id)) {
        issues.push(makeIssue(
          "error",
          "footnote_duplicate_definition",
          i + 1,
          `footnote [^${id}] is defined more than once`,
        ));
      }
      definitions.set(id, i + 1);
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (isInsideFence(lines, i)) continue;
    const line = lines[i] || "";
    FOOTNOTE_REF_RE.lastIndex = 0;
    let m;
    while ((m = FOOTNOTE_REF_RE.exec(line))) {
      const id = m[1];
      if (FOOTNOTE_DEF_RE.exec(line)) {
        // skip — this is a definition line, not a reference
        continue;
      }
      if (!references.has(id)) references.set(id, []);
      references.get(id).push(i + 1);
    }
  }

  for (const id of references.keys()) {
    if (!SLUG_PREFIX_RE.test(id)) {
      issues.push(makeIssue(
        "warning",
        "footnote_id_not_slug_prefixed",
        references.get(id)[0],
        `footnote [^${id}] is not slug-prefixed (use [^${slugFromTitle || "<slug>"}-...])`,
      ));
    }
    if (!definitions.has(id)) {
      issues.push(makeIssue(
        "error",
        "footnote_reference_undefined",
        references.get(id)[0],
        `footnote [^${id}] referenced but never defined`,
      ));
    }
  }
  for (const id of definitions.keys()) {
    if (!references.has(id)) {
      issues.push(makeIssue(
        "warning",
        "footnote_definition_unused",
        definitions.get(id),
        `footnote [^${id}] defined but never referenced`,
      ));
    }
  }

  return issues;
}

export async function lintPaper(projectDir, { paperText } = {}) {
  const paperPath = path.join(projectDir, "paper.md");
  let text = paperText;
  if (text === undefined) {
    text = await readFile(paperPath, "utf8");
  }
  const lines = splitLines(text);
  const issues = [];
  const headingRanges = findHeadingRanges(lines);
  const titleHeading = headingRanges.find((h) => h.level === 1);
  const slugFromTitle = titleHeading
    ? titleHeading.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    : "";

  const resultsSection = findResultsSection(headingRanges);
  if (!resultsSection) {
    issues.push(makeIssue(
      "warning",
      "results_section_missing",
      1,
      "no Results section (## Results) found",
    ));
  } else {
    const subsections = findResultsSubsections(headingRanges, resultsSection);
    if (!subsections.length) {
      issues.push(makeIssue(
        "info",
        "results_no_subsections",
        resultsSection.startLine + 1,
        "Results section has no ### subsections — fine for a single-move paper but unusual",
      ));
    }
    for (const subsection of subsections) {
      await lintResultsSubsection(lines, projectDir, subsection, issues);
      checkBareNumbers(lines, subsection, issues);
    }
  }

  issues.push(...checkFootnotes(lines, slugFromTitle));

  return {
    issues,
    summary: summarize(issues),
  };
}

function summarize(issues) {
  const out = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) {
    out[issue.severity] = (out[issue.severity] || 0) + 1;
  }
  return out;
}

export function formatPaperIssue(issue) {
  return `[${issue.severity.toUpperCase()}] paper.md:${issue.line} — ${issue.message} (${issue.code})`;
}
