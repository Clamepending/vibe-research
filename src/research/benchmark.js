// Parser + validator for projects/<name>/benchmark.md.
//
// The benchmark spec is the versioned eval contract for a project. Quantitative
// projects can live without one (numbers + a noise rule are enough). Qualitative
// and mix projects MUST declare one — that is where rubrics, judge prompts, and
// golden-set provenance get pinned so leaderboard comparisons are well-defined.
//
// Shape mirrors `projects/<name>/README.md` parsing: frontmatter + headed sections,
// regex-driven rather than reaching for a markdown parser.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./result-doc.js";

const SECTION_HEADER = /^##\s+(.+?)\s*$/;
const TABLE_ROW = /^\|(.*)\|\s*$/;
const TABLE_DIVIDER = /^\|\s*[-:]+/;
const LINK_INLINE = /\[([^\]]+)\]\(([^)]+)\)/g;

const REQUIRED_SECTIONS = ["PURPOSE", "METRICS", "DATASETS", "RUBRICS", "CALIBRATION", "CONTAMINATION CHECKS", "HISTORY"];
const VALID_METRIC_KINDS = new Set(["numeric", "rubric", "judge", "preference"]);
const VALID_DIRECTIONS = new Set(["higher", "lower", "n/a"]);

function splitLines(text) {
  return String(text || "").replace(/\r\n/g, "\n").split("\n");
}

function splitTableRow(line) {
  const match = TABLE_ROW.exec(line);
  if (!match) return null;
  return match[1].split("|").map((cell) => cell.trim());
}

function extractFirstLink(cell) {
  LINK_INLINE.lastIndex = 0;
  const match = LINK_INLINE.exec(cell || "");
  if (!match) return { label: cell || "", url: "" };
  return { label: match[1], url: match[2] };
}

function readSections(lines) {
  const sections = new Map();
  let currentName = null;
  let currentBody = [];
  const flush = () => {
    if (currentName !== null) sections.set(currentName, currentBody.join("\n"));
  };
  for (const line of lines) {
    const headerMatch = SECTION_HEADER.exec(line);
    if (headerMatch) {
      flush();
      currentName = headerMatch[1].trim();
      currentBody = [];
      continue;
    }
    if (currentName !== null) currentBody.push(line);
  }
  flush();
  return sections;
}

function isPlaceholderCell(cell) {
  const trimmed = String(cell || "").trim();
  if (!trimmed) return true;
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
    if (TABLE_DIVIDER.test(line)) continue;
    const cells = splitTableRow(line);
    if (!cells) continue;
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

function parseMetrics(body) {
  const { rows } = readTable(body);
  return rows.map((cells) => ({
    name: (cells[0] || "").trim(),
    kind: (cells[1] || "").trim().toLowerCase(),
    direction: (cells[2] || "").trim().toLowerCase(),
    computedBy: (cells[3] || "").trim(),
  }));
}

function parseDatasets(body) {
  const { rows } = readTable(body);
  return rows.map((cells) => ({
    split: (cells[0] || "").trim(),
    path: (cells[1] || "").trim(),
    size: (cells[2] || "").trim(),
    provenance: (cells[3] || "").trim(),
  }));
}

function parseRubrics(body) {
  return splitLines(body)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const stripped = line.slice(2).trim();
      const linkMatch = stripped.match(/^\[([^\]]+)\]\(([^)]+)\)\s*[-—]?\s*(.*)$/);
      if (!linkMatch) return { label: "", path: "", recap: stripped };
      return { label: linkMatch[1].trim(), path: linkMatch[2].trim(), recap: linkMatch[3].trim() };
    })
    .filter((row) => row.label || row.recap);
}

function parseCalibration(body) {
  const { rows } = readTable(body);
  return rows.map((cells) => ({
    metric: (cells[0] || "").trim(),
    target: (cells[1] || "").trim(),
    measured: (cells[2] || "").trim(),
    when: (cells[3] || "").trim(),
    by: (cells[4] || "").trim(),
  }));
}

function parseContaminationChecks(body) {
  return splitLines(body)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function parseHistory(body) {
  const { rows } = readTable(body);
  return rows.map((cells) => ({
    version: (cells[0] || "").trim(),
    date: (cells[1] || "").trim(),
    change: (cells[2] || "").trim(),
    reason: (cells[3] || "").trim(),
    superseded: (cells[4] || "").trim(),
  }));
}

export function parseBenchmark(text) {
  const { frontmatter, body } = parseFrontmatter(text);
  const lines = splitLines(body);
  const sections = readSections(lines);

  const titleMatch = lines.find((line) => /^#\s+/.test(line));
  const title = titleMatch ? titleMatch.replace(/^#\s+/, "").trim() : "";

  return {
    title,
    frontmatter: frontmatter || null,
    purpose: plainText(sections.get("PURPOSE") || ""),
    metrics: parseMetrics(sections.get("METRICS") || ""),
    datasets: parseDatasets(sections.get("DATASETS") || ""),
    rubrics: parseRubrics(sections.get("RUBRICS") || ""),
    calibration: parseCalibration(sections.get("CALIBRATION") || ""),
    contaminationChecks: parseContaminationChecks(sections.get("CONTAMINATION CHECKS") || ""),
    history: parseHistory(sections.get("HISTORY") || ""),
    sections: Array.from(sections.keys()),
  };
}

async function pathExists(absolutePath) {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function makeIssue(severity, code, where, message) {
  return { severity, code, where, message };
}

export async function validateBenchmark(projectDir, benchmark) {
  const issues = [];
  const where = "benchmark.md";

  // Frontmatter checks. Note: YAML coerces bare `2` to a number, so we read
  // `version` via String() throughout (see benchmarkVersionString below) and
  // only complain here if it is missing or empty after coercion.
  if (!benchmark.frontmatter) {
    issues.push(makeIssue("error", "benchmark_missing_frontmatter", where, "benchmark.md must open with YAML frontmatter (version, last_updated, status)"));
  } else {
    const version = benchmarkVersionString(benchmark);
    if (!version) {
      issues.push(makeIssue("error", "benchmark_missing_version", where, "frontmatter is missing `version`"));
    }
    if (!benchmark.frontmatter.last_updated) {
      issues.push(makeIssue("warning", "benchmark_missing_last_updated", where, "frontmatter is missing `last_updated`"));
    }
    if (benchmark.frontmatter.status && !["active", "draft", "frozen"].includes(String(benchmark.frontmatter.status))) {
      issues.push(makeIssue("warning", "benchmark_unknown_status", where, `unknown status "${benchmark.frontmatter.status}" (expected active|draft|frozen)`));
    }
  }

  for (const required of REQUIRED_SECTIONS) {
    if (!benchmark.sections.includes(required)) {
      issues.push(makeIssue("error", "benchmark_missing_section", where, `required section "${required}" is missing`));
    }
  }

  if (!benchmark.purpose) {
    issues.push(makeIssue("warning", "benchmark_empty_purpose", where, "PURPOSE section is empty"));
  }

  if (!benchmark.metrics.length) {
    issues.push(makeIssue("error", "benchmark_no_metrics", where, "METRICS table has no rows; at least one metric is required"));
  }

  for (const metric of benchmark.metrics) {
    const metricWhere = `${where} METRICS row "${metric.name || "(unnamed)"}"`;
    if (!metric.name) {
      issues.push(makeIssue("error", "benchmark_metric_unnamed", metricWhere, "metric row has no name"));
    }
    if (!VALID_METRIC_KINDS.has(metric.kind)) {
      issues.push(makeIssue("error", "benchmark_metric_kind", metricWhere, `kind "${metric.kind}" is not one of ${[...VALID_METRIC_KINDS].join("|")}`));
    }
    if (!VALID_DIRECTIONS.has(metric.direction)) {
      issues.push(makeIssue("error", "benchmark_metric_direction", metricWhere, `direction "${metric.direction}" is not one of ${[...VALID_DIRECTIONS].join("|")}`));
    }
    if (!metric.computedBy) {
      issues.push(makeIssue("warning", "benchmark_metric_no_command", metricWhere, "metric row has no `computed by` command"));
    }
  }

  for (const dataset of benchmark.datasets) {
    const datasetWhere = `${where} DATASETS row "${dataset.split || "(unnamed)"}"`;
    if (!dataset.path) continue;
    const linkedPath = extractFirstLink(dataset.path).url || dataset.path;
    if (/^https?:\/\//.test(linkedPath)) continue;
    const resolved = path.resolve(projectDir, linkedPath);
    if (!(await pathExists(resolved))) {
      issues.push(makeIssue("warning", "benchmark_dataset_missing_file", datasetWhere, `dataset file not found at ${linkedPath}`));
    }
  }

  for (const rubric of benchmark.rubrics) {
    if (!rubric.path) continue;
    if (/^https?:\/\//.test(rubric.path)) continue;
    const resolved = path.resolve(projectDir, rubric.path);
    if (!(await pathExists(resolved))) {
      issues.push(makeIssue("warning", "benchmark_rubric_missing_file", `${where} RUBRICS "${rubric.label}"`, `rubric file not found at ${rubric.path}`));
    }
  }

  // Cross-check: every metric named in calibration must appear in METRICS.
  const metricNames = new Set(benchmark.metrics.map((m) => m.name));
  for (const cal of benchmark.calibration) {
    if (!cal.metric) continue;
    if (!metricNames.has(cal.metric)) {
      issues.push(makeIssue("warning", "benchmark_calibration_unknown_metric", `${where} CALIBRATION "${cal.metric}"`, `calibration row references metric "${cal.metric}" not declared in METRICS`));
    }
  }

  // Every rubric/judge metric needs a calibration row. Without a measured rater
  // agreement, the metric's noise floor is undeclared and admission is hand-wavy.
  // For an `active` bench, we treat this as an error; for `draft`, a warning.
  const calibrationMetrics = new Set(benchmark.calibration.map((c) => c.metric));
  const benchStatus = String(benchmark.frontmatter?.status || "active").toLowerCase();
  const calibrationSeverity = benchStatus === "draft" ? "warning" : "error";
  for (const metric of benchmark.metrics) {
    if (!metric.name) continue;
    if (metric.kind === "rubric" || metric.kind === "judge") {
      if (!calibrationMetrics.has(metric.name)) {
        issues.push(makeIssue(calibrationSeverity, "benchmark_metric_no_calibration", `${where} METRICS "${metric.name}"`, `${metric.kind} metric "${metric.name}" has no CALIBRATION row — rater agreement is undeclared`));
      }
    }
  }

  // History must contain the current version (with the same draft/active relaxation).
  const currentVersion = benchmarkVersionString(benchmark);
  if (currentVersion) {
    const versionInHistory = benchmark.history.some((h) => String(h.version) === currentVersion);
    if (!versionInHistory) {
      const severity = benchStatus === "draft" ? "warning" : "error";
      issues.push(makeIssue(severity, "benchmark_history_missing_current", `${where} HISTORY`, `current version ${currentVersion} is not in HISTORY`));
    }
  }

  return issues;
}

export function benchmarkVersionString(benchmark) {
  if (!benchmark || !benchmark.frontmatter) return "";
  const v = benchmark.frontmatter.version;
  if (v === null || v === undefined || v === "") return "";
  return String(v);
}

export function benchmarkKnownVersions(benchmark) {
  if (!benchmark) return new Set();
  const versions = new Set();
  const current = benchmarkVersionString(benchmark);
  if (current) versions.add(current);
  for (const row of benchmark.history || []) {
    if (row.version) versions.add(String(row.version));
  }
  return versions;
}

export function benchmarkMetricNames(benchmark) {
  if (!benchmark) return new Set();
  return new Set(
    (benchmark.metrics || [])
      .map((m) => (m.name ? String(m.name) : ""))
      .filter(Boolean),
  );
}

export async function loadBenchmark(projectDir) {
  const benchmarkPath = path.join(projectDir, "benchmark.md");
  try {
    const text = await readFile(benchmarkPath, "utf8");
    return { path: benchmarkPath, ...parseBenchmark(text) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export const __internal = {
  parseMetrics,
  parseDatasets,
  parseRubrics,
  parseCalibration,
  parseContaminationChecks,
  parseHistory,
  REQUIRED_SECTIONS,
  VALID_METRIC_KINDS,
  VALID_DIRECTIONS,
};
