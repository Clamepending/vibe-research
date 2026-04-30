// Generic Vibe Research move runner.
//
// This is the thin "QUEUE -> ACTIVE -> cycle log" shell around arbitrary
// experiment commands. It intentionally does not decide what to test; briefs,
// humans, and project-specific agents do that. The runner makes the mechanical
// loop cheap and durable.

import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { addActiveRow } from "./active-edit.js";
import { runAdmit, formatVerdict } from "./admit.js";
import { parseProjectReadme } from "./project-readme.js";
import { parseFrontmatter, parseResultDoc } from "./result-doc.js";
import { removeQueueRow } from "./queue-edit.js";
import { resolveMove } from "./resolve.js";
import { updateResearchState } from "./brief.js";
import { lintPaper } from "./paper-lint.js";
import { budgetCapBreaches, isBudgetCapReached, normalizeBudgetDebits } from "./budget.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_METRIC_REGEX = /(?:metric|score|accuracy|loss|mean_return|final_return)\s*[:=]\s*([+-]?[0-9]*\.?[0-9]+(?:[eE][+-]?\d+)?)/i;
const VALID_CYCLE_KINDS = new Set(["change", "rerun", "analysis"]);

function nowIso() {
  return new Date().toISOString();
}

function todayLocal() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeKind(value) {
  const kind = String(value || "change").trim().toLowerCase();
  return VALID_CYCLE_KINDS.has(kind) ? kind : "change";
}

function normalizeRepoUrl(value) {
  const url = String(value || "").trim().replace(/^`|`$/g, "").replace(/\.git$/, "");
  return /^https?:\/\//i.test(url) ? url : "";
}

function branchUrlForMove(codeRepoUrl, slug) {
  const repo = normalizeRepoUrl(codeRepoUrl);
  return repo ? `${repo}/tree/r/${slug}` : `r/${slug}`;
}

function commitUrlForSha(codeRepoUrl, sha) {
  const repo = normalizeRepoUrl(codeRepoUrl);
  const fullSha = String(sha || "").trim();
  return repo && fullSha ? `${repo}/commit/${fullSha}` : "";
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

function renderResultDoc({
  slug,
  startingPoint,
  branchUrl,
  agent,
  question,
  hypothesis,
  grounding,
  design,
}) {
  return [
    `# ${slug}`,
    "",
    "## TAKEAWAY",
    "",
    "_active: waiting for cycles._",
    "",
    "## STATUS",
    "",
    "active",
    "",
    "## STARTING POINT",
    "",
    startingPoint || "main",
    "",
    "## BRANCH",
    "",
    branchUrl,
    "",
    "## AGENT",
    "",
    agent || "0",
    "",
    "## Question",
    "",
    question || `Run queued move \`${slug}\`.`,
    "",
    "## Hypothesis",
    "",
    hypothesis || "_prior not filled yet; runner claim created the move shell._",
    "",
    "## Research grounding",
    "",
    grounding || "_none recorded in runner claim; add literature/doc support before expensive work._",
    "",
    "## Experiment design",
    "",
    design || "_runner will record one command per cycle._",
    "",
    "## Cycles",
    "",
    "_no cycles yet_",
    "",
    "## Results",
    "",
    "_pending cycles._",
    "",
    "## Agent canvas",
    "",
    "_none yet._",
    "",
    "## Analysis",
    "",
    "_pending._",
    "",
    "## Reproducibility",
    "",
    "_pending cycles._",
    "",
    "## Leaderboard verdict",
    "",
    "Decision: do not admit",
    "",
    "## Queue updates",
    "",
    "_none._",
    "",
  ].join("\n");
}

function insertIntoSection(text, sectionName, line) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const headerIndex = lines.findIndex((entry) => new RegExp(`^##\\s+${sectionName}\\s*$`, "i").test(entry));
  if (headerIndex < 0) {
    return `${text.trimEnd()}\n\n## ${sectionName}\n\n${line}\n`;
  }

  let insertIndex = headerIndex + 1;
  while (insertIndex < lines.length && lines[insertIndex].trim() === "") insertIndex += 1;
  if (insertIndex < lines.length && /^_.*_$/.test(lines[insertIndex].trim())) {
    lines.splice(insertIndex, 1, line);
  } else {
    let end = insertIndex;
    while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
    let insertAt = end;
    while (insertAt > insertIndex && lines[insertAt - 1].trim() === "") insertAt -= 1;
    lines.splice(insertAt, 0, line);
  }
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

function appendSectionBullet(text, sectionName, bullet) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const headerIndex = lines.findIndex((entry) => new RegExp(`^##\\s+${sectionName}\\s*$`, "i").test(entry));
  if (headerIndex < 0) {
    return `${text.trimEnd()}\n\n## ${sectionName}\n\n${bullet}\n`;
  }
  let cursor = headerIndex + 1;
  while (cursor < lines.length && lines[cursor].trim() === "") cursor += 1;
  if (cursor < lines.length && /^_.*_$/.test(lines[cursor].trim())) {
    lines.splice(cursor, 1, bullet);
  } else {
    let end = cursor;
    while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
    let insertAt = end;
    while (insertAt > cursor && lines[insertAt - 1].trim() === "") insertAt -= 1;
    lines.splice(insertAt, 0, bullet);
  }
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

function replaceSectionBody(text, sectionName, body) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const headerRe = new RegExp(`^##\\s+${sectionName}\\s*$`, "i");
  const headerIndex = lines.findIndex((entry) => headerRe.test(entry));
  const replacement = String(body || "").replace(/\r\n/g, "\n").replace(/\n*$/, "").split("\n");

  if (headerIndex < 0) {
    return `${normalized.trimEnd()}\n\n## ${sectionName}\n\n${replacement.join("\n")}\n`;
  }

  let end = headerIndex + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
  const next = [
    ...lines.slice(0, headerIndex + 1),
    "",
    ...replacement,
    "",
    ...lines.slice(end),
  ];
  return `${next.join("\n").replace(/\n*$/, "")}\n`;
}

function paperSectionPattern(sectionTitle) {
  return new RegExp(`^##\\s+(?:\\d+\\.\\s*)?${sectionTitle}\\s*$`, "i");
}

function findPaperSection(lines, sectionTitle) {
  const headerRe = paperSectionPattern(sectionTitle);
  const headerIndex = lines.findIndex((entry) => headerRe.test(entry));
  if (headerIndex < 0) return null;
  let end = headerIndex + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
  return { headerIndex, end };
}

function removePlaceholderLines(lines) {
  const out = [];
  let inComment = false;
  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (trimmed.startsWith("<!--")) {
      inComment = !trimmed.includes("-->");
      continue;
    }
    if (inComment) {
      if (trimmed.includes("-->")) inComment = false;
      continue;
    }
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (/^-?\s*_no .* yet_\.?$/i.test(trimmed)) continue;
    if (/^_No resolved moves yet\._$/i.test(trimmed)) continue;
    if (/^_Stub: not enough evidence yet\._$/i.test(trimmed)) continue;
    out.push(line);
  }
  return out;
}

function appendToPaperSection(text, sectionTitle, addition) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const section = findPaperSection(lines, sectionTitle);
  if (!section) {
    return `${String(text || "").trimEnd()}\n\n## ${sectionTitle}\n\n${addition.trim()}\n`;
  }

  const body = removePlaceholderLines(lines.slice(section.headerIndex + 1, section.end));
  const nextBody = `${body.join("\n").trimEnd()}\n\n${addition.trim()}`.trim();
  const next = [
    ...lines.slice(0, section.headerIndex + 1),
    "",
    ...nextBody.split("\n"),
    "",
    ...lines.slice(section.end),
  ];
  return `${next.join("\n").replace(/\n*$/, "")}\n`;
}

function prependToPaperSection(text, sectionTitle, addition) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const section = findPaperSection(lines, sectionTitle);
  if (!section) {
    return `${String(text || "").trimEnd()}\n\n## ${sectionTitle}\n\n${addition.trim()}\n`;
  }

  const body = removePlaceholderLines(lines.slice(section.headerIndex + 1, section.end));
  const nextBody = `${addition.trim()}\n${body.join("\n").trimEnd() ? `\n${body.join("\n").trimEnd()}` : ""}`.trim();
  const next = [
    ...lines.slice(0, section.headerIndex + 1),
    "",
    ...nextBody.split("\n"),
    "",
    ...lines.slice(section.end),
  ];
  return `${next.join("\n").replace(/\n*$/, "")}\n`;
}

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  return String(Number(numeric.toPrecision(12)));
}

function extractMetric(text, pattern = DEFAULT_METRIC_REGEX) {
  if (!text) return "";
  const match = pattern.exec(text);
  if (!match) return "";
  return match[1] || match[0] || "";
}

function runShellCommand({ command, cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(command, {
      shell: true,
      cwd,
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const startedAt = nowIso();
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      resolve({ startedAt, finishedAt: nowIso(), stdout, stderr, ...payload });
    };
    const timer = setTimeout(() => {
      settle({ exitCode: null, timedOut: true, stderr: `${stderr}\n[vr-research-runner] timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on?.("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on?.("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      settle({ exitCode: -1, timedOut: false, stderr: `${stderr}\n[vr-research-runner] spawn error: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({ exitCode: code, timedOut: false });
    });
  });
}

async function getGitShortSha(cwd) {
  if (!cwd) return "";
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function getGitSha(cwd) {
  if (!cwd) return { full: "", short: "" };
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    const full = stdout.trim();
    return { full, short: full.slice(0, 7) };
  } catch {
    return { full: "", short: "" };
  }
}

async function runGit(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (error) {
    const result = {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
      code: Number.isFinite(error.code) ? error.code : 1,
    };
    if (allowFailure) return result;
    const tail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed${tail ? `: ${tail}` : ""}`);
  }
}

function inferGitRef(startingPoint) {
  const text = String(startingPoint || "").trim();
  if (!text) return "";
  const commitMatch = text.match(/\/commit\/([0-9a-f]{7,40})/i);
  if (commitMatch) return commitMatch[1];
  const treeMatch = text.match(/\/tree\/([^\s)]+)$/i);
  if (treeMatch) {
    const ref = decodeURIComponent(treeMatch[1]).replace(/[.,;:!?)\]>]+$/, "");
    const pinned = ref.match(/@([0-9a-f]{7,40})$/i);
    return pinned ? pinned[1] : ref;
  }
  return text;
}

async function prepareCodeBranch({
  codeCwd,
  slug,
  startingPoint,
  startRef = "",
  branchName = "",
  gitFetch = false,
  gitPush = false,
  gitRemote = "origin",
} = {}) {
  if (!codeCwd) return null;
  const cwd = path.resolve(codeCwd);
  const targetBranch = String(branchName || `r/${slug}`).trim();
  const ref = String(startRef || inferGitRef(startingPoint) || "HEAD").trim();
  const steps = [];
  if (gitFetch) {
    await runGit(cwd, ["fetch", gitRemote]);
    steps.push(`fetch ${gitRemote}`);
  }
  const existing = await runGit(cwd, ["rev-parse", "--verify", targetBranch], { allowFailure: true });
  if (existing.ok) {
    await runGit(cwd, ["switch", targetBranch]);
    steps.push(`switch ${targetBranch}`);
  } else {
    await runGit(cwd, ["switch", "-c", targetBranch, ref]);
    steps.push(`switch -c ${targetBranch} ${ref}`);
  }
  if (gitPush) {
    await runGit(cwd, ["push", "-u", gitRemote, targetBranch]);
    steps.push(`push ${gitRemote} ${targetBranch}`);
  }
  const sha = await getGitSha(cwd);
  return { cwd, branch: targetBranch, startRef: ref, sha: sha.full, shortSha: sha.short, steps };
}

async function currentGitBranch(cwd) {
  const result = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  return result.ok ? result.stdout.trim() : "";
}

async function commitCodeChanges({
  cwd,
  slug,
  cycleIndex,
  kind,
  change,
  outcome,
  message = "",
  allowEmpty = false,
  gitPush = false,
  gitRemote = "origin",
  branchName = "",
} = {}) {
  const runCwd = path.resolve(cwd || ".");
  const finalMessage = String(message || `r/${slug} cycle ${cycleIndex}: ${change} -> ${outcome}`).trim();
  await runGit(runCwd, ["add", "-A"]);
  const diff = await runGit(runCwd, ["diff", "--cached", "--quiet"], { allowFailure: true });
  const hasChanges = !diff.ok;
  const emptyAllowed = allowEmpty || kind === "analysis";
  const out = {
    cwd: runCwd,
    attempted: true,
    committed: false,
    pushed: false,
    skipped: "",
    message: finalMessage,
    sha: "",
    shortSha: "",
    branch: "",
  };
  if (!hasChanges && !emptyAllowed) {
    const sha = await getGitSha(runCwd);
    return { ...out, skipped: "no staged changes", sha: sha.full, shortSha: sha.short, branch: await currentGitBranch(runCwd) };
  }

  const args = ["commit"];
  if (!hasChanges && emptyAllowed) args.push("--allow-empty");
  args.push("-m", finalMessage);
  await runGit(runCwd, args);
  const sha = await getGitSha(runCwd);
  const branch = await currentGitBranch(runCwd);
  out.committed = true;
  out.sha = sha.full;
  out.shortSha = sha.short;
  out.branch = branch;

  if (gitPush) {
    const target = String(branchName || branch || `r/${slug}`).trim();
    if (!target || target === "HEAD") {
      throw new Error("cannot git push from detached HEAD without --git-branch <name>");
    }
    await runGit(runCwd, ["push", "-u", gitRemote, `HEAD:${target}`]);
    out.pushed = true;
  }
  return out;
}

function deriveMetricConfig(project, { metricName = "", higherIsBetter } = {}) {
  const description = String(project?.rankingCriterion?.description || "");
  const metric = String(metricName || description.replace(/\([^)]*\)/g, "").trim() || "metric").trim();
  let higher = higherIsBetter;
  if (higher === undefined || higher === null) {
    higher = !/\blower\s+is\s+better\b/i.test(description);
  }
  return { metric, higherIsBetter: Boolean(higher) };
}

function parseArtifactLog(text) {
  const body = String(text || "");
  const readField = (name) => {
    const m = body.match(new RegExp(`^${name}:\\s*(.*)$`, "mi"));
    return m ? m[1].trim() : "";
  };
  const metric = Number(readField("metric"));
  return {
    cycle: Number(readField("cycle")) || 0,
    kind: readField("kind") || "change",
    seed: readField("seed"),
    metric: Number.isFinite(metric) ? metric : null,
  };
}

async function collectCycleMetrics(projectDir, slug) {
  const artifactDir = path.join(projectDir, "artifacts", slug);
  let names = [];
  try {
    names = await readdir(artifactDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const out = [];
  for (const name of names.filter((entry) => /^cycle-\d+\.log$/.test(entry)).sort()) {
    const filePath = path.join(artifactDir, name);
    const parsed = parseArtifactLog(await readFile(filePath, "utf8"));
    if (parsed.metric === null) continue;
    out.push({
      ...parsed,
      seed: parsed.seed || String(parsed.cycle || out.length),
      artifactRelativePath: path.join("artifacts", slug, name),
    });
  }
  return out.sort((a, b) => a.cycle - b.cycle);
}

function summarizeMetrics(rows) {
  const values = rows.map((row) => row.metric).filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1)
    : 0;
  return {
    mean,
    std: Math.sqrt(variance),
    seeds: rows.map((row) => row.seed),
    n: values.length,
  };
}

function renderFrontmatter(data) {
  const ordered = [
    "metric",
    "metric_higher_is_better",
    "seeds",
    "mean",
    "std",
    "noise_multiplier",
    "benchmark_version",
  ];
  const keys = [
    ...ordered.filter((key) => Object.prototype.hasOwnProperty.call(data, key)),
    ...Object.keys(data).filter((key) => !ordered.includes(key)).sort(),
  ];
  const lines = ["---"];
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((entry) => typeof entry === "number" ? entry : JSON.stringify(String(entry))).join(", ")}]`);
    } else if (typeof value === "boolean") {
      lines.push(`${key}: ${value ? "true" : "false"}`);
    } else if (typeof value === "number") {
      lines.push(`${key}: ${formatNumber(value)}`);
    } else if (value !== undefined && value !== null && String(value).trim() !== "") {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

function upsertFrontmatter(text, patch) {
  const parsed = parseFrontmatter(text);
  const body = parsed.body || text || "";
  const next = { ...(parsed.frontmatter || {}), ...patch };
  return `${renderFrontmatter(next)}${body.replace(/^\n+/, "")}`;
}

async function createReviewCard({
  api,
  projectDir,
  slug,
  cycleIndex,
  metric,
  artifactPath,
  resultPath,
  summary,
  sessionId = "",
  agentId = "",
  waitHuman = false,
  humanTimeoutMs = 30_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const endpoint = String(api || "").trim().replace(/\/$/, "");
  if (!endpoint) return { skipped: true, reason: "Agent Town API is not configured" };
  if (typeof fetchImpl !== "function") return { skipped: true, reason: "fetch is unavailable" };
  const projectName = path.basename(path.resolve(projectDir));
  const resolvedSessionId = trimString(
    sessionId ||
      process.env.VIBE_RESEARCH_SESSION_ID ||
      process.env.REMOTE_VIBES_SESSION_ID ||
      "",
  );
  const body = {
    id: `research-cycle-${slug}-${cycleIndex}`,
    kind: "review",
    priority: "high",
    title: `Review cycle ${cycleIndex}: ${slug}`,
    detail: summary || `Cycle ${cycleIndex} finished${metric ? ` with ${metric}` : ""}.`,
    recommendation: "Choose whether to continue the hillclimb, rerun for noise, synthesize the result, or return to brainstorm.",
    consequence: "Your click steers the next autonomous research step without requiring a long notebook read.",
    source: "research-runner",
    sourceSessionId: resolvedSessionId,
    sourceAgentId: agentId,
    href: "?view=agent-inbox",
    cta: "Review",
    target: {
      type: "file",
      id: `${projectName}:${slug}:cycle-${cycleIndex}`,
      label: path.basename(resultPath),
      projectName,
      action: "review-research-cycle",
    },
    evidence: [
      { label: "result doc", path: resultPath, kind: "result" },
      { label: `cycle ${cycleIndex} log`, path: artifactPath, kind: "artifact" },
    ],
    choices: ["continue", "rerun", "synthesize", "brainstorm", "steer"],
  };

  const response = await fetchImpl(`${endpoint}/action-items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Agent Inbox review failed: ${response.status}`);
  }
  const actionItem = payload.actionItem || payload;
  if (!waitHuman) return actionItem;

  const waitResponse = await fetchImpl(`${endpoint}/wait`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      predicate: "action_item_resolved",
      predicateParams: { actionItemId: actionItem.id || body.id },
      timeoutMs: humanTimeoutMs,
    }),
  });
  const waitPayload = await waitResponse.json().catch(() => ({}));
  if (!waitResponse.ok) {
    throw new Error(waitPayload?.error || `Agent Inbox wait failed: ${waitResponse.status}`);
  }
  return { ...actionItem, wait: waitPayload };
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeMarkdown(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function truncateText(value, maxLength = 140) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function sanitizeFootnoteId(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.includes("-") ? normalized : `${normalized || "result"}-note`;
}

async function loadPaperTemplate() {
  const templateUrl = new URL("../../templates/paper-template.md", import.meta.url);
  return readFile(templateUrl, "utf8");
}

function fillPaperTemplate(template, { projectName, goal, codeRepoUrl } = {}) {
  let out = String(template || "");
  out = out.replace(/^#\s+<Project title>\s*$/m, `# ${projectName || "Research project"}`);
  if (goal) {
    out = out.replace(
      /(## 1\. Question\s*\n\s*<!-- locked: pre-registration -->\s*\n\s*\n)([^\n]+)/,
      (_match, header) => `${header}${goal}`,
    );
  }
  if (codeRepoUrl) {
    out = out.replace("- Code repo: _<github-url>_", `- Code repo: ${codeRepoUrl}`);
  }
  return out;
}

async function readOrCreatePaper(projectDir, project) {
  const paperPath = path.join(projectDir, "paper.md");
  try {
    return { paperPath, text: await readFile(paperPath, "utf8"), created: false };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const template = await loadPaperTemplate();
  const projectName = path.basename(path.resolve(projectDir));
  return {
    paperPath,
    text: fillPaperTemplate(template, {
      projectName,
      goal: project.goal,
      codeRepoUrl: project.codeRepo?.url || "",
    }),
    created: true,
  };
}

function latestCycleSha(doc) {
  const cycles = Array.isArray(doc?.cycles) ? doc.cycles : [];
  const latest = cycles
    .slice()
    .sort((a, b) => (Number(b.index) || 0) - (Number(a.index) || 0))
    .find((cycle) => cycle.sha);
  return latest?.sha || "";
}

function renderSummarySvg({ slug, title, metricLine, decisionLine }) {
  const safeTitle = escapeXml(truncateText(title || slug || "Research result", 70));
  const safeMetric = escapeXml(truncateText(metricLine || "Result recorded", 80));
  const safeDecision = escapeXml(truncateText(decisionLine || "See result doc for provenance", 80));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">`,
    `<rect width="1200" height="630" fill="#f7f5ef"/>`,
    `<rect x="52" y="52" width="1096" height="526" rx="22" fill="#ffffff" stroke="#242424" stroke-width="3"/>`,
    `<text x="92" y="145" font-family="Arial, sans-serif" font-size="48" font-weight="700" fill="#191919">${safeTitle}</text>`,
    `<text x="92" y="248" font-family="Arial, sans-serif" font-size="34" fill="#2f4f4f">${safeMetric}</text>`,
    `<text x="92" y="328" font-family="Arial, sans-serif" font-size="30" fill="#5c4033">${safeDecision}</text>`,
    `<text x="92" y="505" font-family="Arial, sans-serif" font-size="24" fill="#666666">Generated by vr-research-runner finish</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

function normalizeFigureExtension(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return [".apng", ".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"].includes(ext)
    ? ext
    : ".png";
}

async function preparePaperFigure({
  projectDir,
  slug,
  figurePath = "",
  title = "",
  metricLine = "",
  decisionLine = "",
} = {}) {
  await mkdir(path.join(projectDir, "figures"), { recursive: true });
  const rawFigure = String(figurePath || "").trim();
  if (/^https?:\/\//i.test(rawFigure)) {
    return {
      relativePath: rawFigure,
      absolutePath: "",
      sourcePath: rawFigure,
      remote: true,
      generated: false,
    };
  }

  if (rawFigure) {
    let sourcePath = path.resolve(rawFigure);
    if (!path.isAbsolute(rawFigure) && !(await pathExists(sourcePath))) {
      sourcePath = path.resolve(projectDir, rawFigure);
    }
    const sourceRelative = path.relative(projectDir, sourcePath).replace(/\\/g, "/");
    if (sourceRelative.startsWith("figures/") && !sourceRelative.startsWith("../")) {
      return {
        relativePath: sourceRelative,
        absolutePath: sourcePath,
        sourcePath,
        remote: false,
        generated: false,
      };
    }

    const ext = normalizeFigureExtension(sourcePath);
    const filename = `${slug}-figure${ext}`;
    const destination = path.join(projectDir, "figures", filename);
    if (sourcePath !== destination) {
      await copyFile(sourcePath, destination);
    }
    return {
      relativePath: `figures/${filename}`,
      absolutePath: destination,
      sourcePath,
      remote: false,
      generated: false,
    };
  }

  const filename = `${slug}-summary.svg`;
  const destination = path.join(projectDir, "figures", filename);
  await writeFile(destination, renderSummarySvg({ slug, title, metricLine, decisionLine }), "utf8");
  return {
    relativePath: `figures/${filename}`,
    absolutePath: destination,
    sourcePath: "",
    remote: false,
    generated: true,
  };
}

function resultDecision(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^Decision\s*:/i.test(line)) || "";
}

function aggregateMetricLine(aggregate, metricName = "") {
  if (!aggregate) return "";
  const metric = metricName || "metric";
  return `${metric}_mean=${formatNumber(aggregate.mean)} std=${formatNumber(aggregate.std)} n=${aggregate.n}`;
}

function appendFootnote(text, footnoteId, body) {
  const definitionRe = new RegExp(`^\\[\\^${footnoteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]:`, "m");
  if (definitionRe.test(text)) return text;
  return `${String(text || "").replace(/\n*$/, "")}\n\n[^${footnoteId}]: ${body}\n`;
}

async function updatePaperForMove({
  projectDir,
  slug,
  project,
  doc,
  resultText,
  resultPath,
  aggregate,
  metricName = "",
  paperFigure = "",
  paperCaption = "",
  paperLimitations = "",
  paperDiscussion = "",
} = {}) {
  const { paperPath, text: initialText, created } = await readOrCreatePaper(projectDir, project);
  const takeaway = doc.takeaway && !/^_/.test(doc.takeaway.trim()) ? doc.takeaway : "";
  const decisionLine = resultDecision(resultText);
  const metricLine = aggregateMetricLine(aggregate, metricName);
  const caption = truncateText(paperCaption || takeaway || metricLine || `Move ${slug} resolved.`);
  const safeCaption = escapeMarkdown(caption);
  const figure = await preparePaperFigure({
    projectDir,
    slug,
    figurePath: paperFigure,
    title: caption,
    metricLine,
    decisionLine,
  });
  const latestSha = latestCycleSha(doc);
  const footnoteId = sanitizeFootnoteId(`${slug}-runner-finish`);
  const relativeResultPath = path.relative(projectDir, resultPath).replace(/\\/g, "/");
  let text = initialText;

  const sinceLine = `- ${latestSha ? `@${latestSha} ` : ""}${slug}: ${safeCaption}`;
  if (!text.includes(sinceLine)) {
    text = prependToPaperSection(text, "Since last update", sinceLine);
  }

  if (!text.includes(`./${relativeResultPath}`) && !text.includes(`](${relativeResultPath})`)) {
    const subsection = [
      `### ${slug} - ${safeCaption}`,
      "",
      `![Result figure](${figure.relativePath})`,
      "",
      `See [\`${relativeResultPath}\`](./${relativeResultPath}). ${safeCaption}[^${footnoteId}]`,
    ].join("\n");
    text = appendToPaperSection(text, "Results", subsection);
  }

  const discussion = truncateText(
    paperDiscussion || `${slug} is now recorded in the project ledger. The result should be reviewed against the leaderboard and follow-up queue before broadening the claim.`,
    500,
  );
  const discussionMarker = `**Update after \`${slug}\`.**`;
  if (!text.includes(discussionMarker)) {
    text = appendToPaperSection(text, "Discussion", `${discussionMarker} ${discussion}`);
  }

  const limitation = `- ${slug}: ${truncateText(paperLimitations || "This move was recorded through the generic runner; it does not by itself test alternate datasets, broader hyperparameter neighborhoods, or external validity.", 500)}`;
  if (!text.includes(limitation)) {
    text = appendToPaperSection(text, "Limitations", limitation);
  }

  const reproLine = `- ${slug}: see [\`${relativeResultPath}\`](./${relativeResultPath}); figure \`${figure.relativePath}\`.`;
  if (!text.includes(reproLine)) {
    text = appendToPaperSection(text, "Reproducibility appendix", reproLine);
  }

  text = appendFootnote(
    text,
    footnoteId,
    `Generated by \`vr-research-runner finish --slug ${slug} --update-paper\` - result \`${relativeResultPath}\` - figure \`${figure.relativePath}\`.`,
  );

  await atomicWrite(paperPath, text);
  const lint = await lintPaper(projectDir).catch((error) => ({
    error: error.message,
    summary: { error: 1, warning: 0, info: 0 },
    issues: [{ severity: "error", code: "paper_lint_exception", message: error.message }],
  }));
  return { paperPath, created, figure, lint };
}

async function publishAgentCanvas({
  api,
  projectDir,
  slug,
  imagePath = "",
  imageUrl = "",
  href = "",
  title = "",
  caption = "",
  sessionId = "",
  agentId = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  const endpoint = String(api || "").trim().replace(/\/+$/, "");
  if (!endpoint) return { skipped: true, reason: "Agent Town API is not configured" };
  if (typeof fetchImpl !== "function") return { skipped: true, reason: "fetch is unavailable" };
  const resolvedSessionId = String(
    sessionId ||
      process.env.VIBE_RESEARCH_SESSION_ID ||
      process.env.REMOTE_VIBES_SESSION_ID ||
      "",
  ).trim();
  if (!resolvedSessionId) return { skipped: true, reason: "VIBE_RESEARCH_SESSION_ID is not configured" };
  if (!imagePath && !imageUrl && !href) return { skipped: true, reason: "no canvas image, URL, or href provided" };

  const canvasId = agentId ? `${resolvedSessionId}-${agentId}` : resolvedSessionId;
  const body = {
    id: canvasId,
    sourceSessionId: resolvedSessionId,
    sourceAgentId: agentId,
    title: title || `Result: ${slug}`,
    caption,
    alt: title || `Result figure for ${slug}`,
    href: href || imageUrl || "",
    imagePath,
    imageUrl,
  };
  const response = await fetchImpl(`${endpoint}/canvases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Agent Canvas publish failed: ${response.status}`);
  }
  return payload.canvas || payload;
}

export async function claimNextMove({
  projectDir,
  slug = "",
  agent = "0",
  question = "",
  hypothesis = "",
  grounding = "",
  design = "",
  started = "",
  force = false,
  codeCwd = "",
  prepareBranch = false,
  startRef = "",
  gitBranch = "",
  gitFetch = false,
  gitPush = false,
  gitRemote = "origin",
  allowBudgetCap = false,
} = {}) {
  if (!projectDir) throw new TypeError("projectDir is required");
  const readmePath = path.join(projectDir, "README.md");
  const readmeText = await readFile(readmePath, "utf8");
  const project = parseProjectReadme(readmeText);
  const requestedSlug = trimString(slug);
  const existingActive = project.active.find((row) => row.agent === agent && (!requestedSlug || row.slug === requestedSlug));
  if (existingActive) {
    return {
      projectDir,
      readmePath,
      slug: existingActive.slug,
      resultPath: path.join(projectDir, existingActive.resultPath || `results/${existingActive.slug}.md`),
      active: existingActive,
      resumed: true,
      claimed: false,
    };
  }

  if (!allowBudgetCap && isBudgetCapReached(project.budget)) {
    const caps = budgetCapBreaches(project.budget).map((cap) => cap.summary).join("; ");
    throw new Error(`budget cap reached (${caps}); human review is required before claiming a new move (pass --allow-budget-cap after approval)`);
  }

  const queueRow = requestedSlug
    ? project.queue.find((row) => row.slug === requestedSlug)
    : project.queue[0];
  if (!queueRow) {
    throw new Error(requestedSlug ? `QUEUE has no row for slug "${requestedSlug}"` : "QUEUE is empty");
  }

  const moveSlug = queueRow.slug;
  const resultRelativePath = `results/${moveSlug}.md`;
  const resultPath = path.join(projectDir, resultRelativePath);
  if ((await pathExists(resultPath)) && !force) {
    throw new Error(`result doc already exists at ${resultPath} (pass --force to overwrite)`);
  }

  const branchUrl = branchUrlForMove(project.codeRepo.url, moveSlug);
  const startingPoint = queueRow.startingPointUrl || queueRow.startingPointLabel || "main";
  const branchPrep = prepareBranch
    ? await prepareCodeBranch({
      codeCwd: codeCwd || process.cwd(),
      slug: moveSlug,
      startingPoint,
      startRef,
      branchName: gitBranch || `r/${moveSlug}`,
      gitFetch,
      gitPush,
      gitRemote,
    })
    : null;
  const resultDoc = renderResultDoc({
    slug: moveSlug,
    startingPoint,
    branchUrl,
    agent,
    question: question || `Does queued move \`${moveSlug}\` improve the project ranking criterion?`,
    hypothesis: hypothesis || `${queueRow.why || "Move is queued by the project brief."} Falsifier: the measured outcome is worse or within noise versus the current baseline.`,
    grounding,
    design: design || `Run cycles from starting point ${startingPoint}; record each command, metric, and artifact.`,
  });

  await mkdir(path.dirname(resultPath), { recursive: true });
  await mkdir(path.join(projectDir, "artifacts", moveSlug), { recursive: true });
  await atomicWrite(resultPath, resultDoc);
  const active = await addActiveRow({
    readmePath,
    row: {
      slug: moveSlug,
      resultPath: resultRelativePath,
      branchUrl,
      agent,
      started: started || todayLocal(),
    },
  });
  await removeQueueRow({ readmePath, slug: moveSlug });
  await updateResearchState({
    projectDir,
    phase: "experiment",
    briefSlug: "",
    summary: `claimed move ${moveSlug}`,
  }).catch(() => null);

  return {
    projectDir,
    readmePath,
    slug: moveSlug,
    queueRow,
    resultPath,
    resultRelativePath,
    branchUrl,
    startingPoint,
    active: active.row,
    branchPrep,
    resumed: false,
    claimed: true,
  };
}

export async function runCycle({
  projectDir,
  slug,
  command,
  cwd = "",
  kind = "change",
  change = "",
  metric = "",
  metricRegex = "",
  qual = "",
  seed = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  spawnImpl = spawn,
  askHuman = false,
  waitHuman = false,
  humanTimeoutMs = 30_000,
  agentTownApi = "",
  fetchImpl = globalThis.fetch,
  monitorUrl = "",
  monitorTitle = "",
  monitorCaption = "",
  canvasSessionId = "",
  canvasAgentId = "",
  gitCommit = false,
  gitCommitMessage = "",
  gitAllowEmpty = false,
  gitPush = false,
  gitRemote = "origin",
  gitBranch = "",
} = {}) {
  if (!projectDir) throw new TypeError("projectDir is required");
  if (!slug) throw new TypeError("slug is required");
  if (!command) throw new TypeError("command is required");

  const resultPath = path.join(projectDir, "results", `${slug}.md`);
  const before = await readFile(resultPath, "utf8");
  const doc = parseResultDoc(before);
  if (doc.status && doc.status !== "active") {
    throw new Error(`result doc STATUS is "${doc.status}"; cycles can only run on active moves`);
  }

  const cycleIndex = Math.max(0, ...doc.cycles.map((cycle) => Number(cycle.index) || 0)) + 1;
  const runCwd = cwd ? path.resolve(cwd) : projectDir;
  const result = await runShellCommand({
    command,
    cwd: runCwd,
    env: { ...process.env, ...env },
    timeoutMs,
    spawnImpl,
  });

  const artifactRelativePath = `artifacts/${slug}/cycle-${cycleIndex}.log`;
  const artifactPath = path.join(projectDir, artifactRelativePath);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
  const pattern = metricRegex ? new RegExp(metricRegex, "i") : DEFAULT_METRIC_REGEX;
  const metricValue = metric || extractMetric(combinedOutput, pattern);
  const outcome = metricValue
    ? `metric=${metricValue}`
    : result.timedOut
      ? "timeout"
      : `exit=${result.exitCode}`;
  const cycleKind = normalizeKind(kind);
  const changeText = trimString(change) || command;
  const qualText = trimString(qual) || (result.exitCode === 0 ? "command completed" : "command failed or timed out");
  const git = gitCommit
    ? await commitCodeChanges({
      cwd: runCwd,
      slug,
      cycleIndex,
      kind: cycleKind,
      change: changeText,
      outcome,
      message: gitCommitMessage,
      allowEmpty: gitAllowEmpty,
      gitPush,
      gitRemote,
      branchName: gitBranch,
    })
    : { ...(await getGitSha(runCwd)), attempted: false, committed: false, pushed: false, skipped: "" };
  const gitShortSha = git.shortSha || await getGitShortSha(runCwd);
  const readmeText = await readFile(path.join(projectDir, "README.md"), "utf8").catch(() => "");
  const codeRepoUrl = readmeText ? parseProjectReadme(readmeText).codeRepo.url : "";
  const commitUrl = commitUrlForSha(codeRepoUrl, git.sha || git.full || "");
  const kindToken = cycleKind === "change" ? "" : ` ${cycleKind}`;
  const cycleLine = `- cycle ${cycleIndex}${gitShortSha ? ` @${gitShortSha}` : ""}${kindToken}: ${changeText} -> ${outcome}. qual: ${qualText}.`;
  const logBody = [
    `cycle: ${cycleIndex}`,
    `slug: ${slug}`,
    `kind: ${cycleKind}`,
    `seed: ${seed}`,
    `started_at: ${result.startedAt}`,
    `finished_at: ${result.finishedAt}`,
    `cwd: ${runCwd}`,
    `command: ${command}`,
    `exit_code: ${result.exitCode}`,
    `timed_out: ${result.timedOut ? "true" : "false"}`,
    `metric: ${metricValue || ""}`,
    `git_sha: ${git.sha || git.full || ""}`,
    `git_committed: ${git.committed ? "true" : "false"}`,
    `git_pushed: ${git.pushed ? "true" : "false"}`,
    `git_skipped: ${git.skipped || ""}`,
    `monitor_url: ${monitorUrl || ""}`,
    "",
    "## stdout",
    "",
    result.stdout || "",
    "",
    "## stderr",
    "",
    result.stderr || "",
  ].join("\n");
  await atomicWrite(artifactPath, logBody);

  let after = insertIntoSection(before, "Cycles", cycleLine);
  after = appendSectionBullet(after, "Results", `- cycle ${cycleIndex}: ${outcome}; artifact \`${artifactRelativePath}\`; command \`${command.replace(/`/g, "\\`")}\`.`);
  after = appendSectionBullet(after, "Reproducibility", `- cycle ${cycleIndex}: cwd \`${runCwd.replace(/`/g, "\\`")}\`; command \`${command.replace(/`/g, "\\`")}\`; artifact \`${artifactRelativePath}\`${gitShortSha ? `; git \`${gitShortSha}\`` : ""}${commitUrl ? `; commit ${commitUrl}` : ""}.`);
  const liveMonitorUrl = trimString(monitorUrl);
  if (liveMonitorUrl) {
    const liveTitle = escapeMarkdown(monitorTitle || `cycle ${cycleIndex} live monitor`);
    const liveCaption = escapeMarkdown(monitorCaption || `Live monitor for ${slug} cycle ${cycleIndex}`);
    after = appendSectionBullet(after, "Agent canvas", `- live monitor: [${liveTitle}](${liveMonitorUrl}) - ${liveCaption}.`);
  }
  await atomicWrite(resultPath, after);

  const monitorCanvasResult = liveMonitorUrl
    ? await publishAgentCanvas({
      api: agentTownApi || process.env.VIBE_RESEARCH_AGENT_TOWN_API || "",
      projectDir,
      slug,
      href: liveMonitorUrl,
      title: monitorTitle || `Live monitor: ${slug}`,
      caption: monitorCaption || `Cycle ${cycleIndex} ${outcome}`,
      sessionId: canvasSessionId,
      agentId: canvasAgentId,
      fetchImpl,
    })
    : null;
  const monitorCanvasSkippedReason = monitorCanvasResult?.skipped ? monitorCanvasResult.reason : "";
  const monitorCanvas = monitorCanvasResult?.skipped ? null : monitorCanvasResult;

  const reviewResult = (askHuman || waitHuman)
    ? await createReviewCard({
      api: agentTownApi || process.env.VIBE_RESEARCH_AGENT_TOWN_API || "",
      projectDir,
      slug,
      cycleIndex,
      metric: metricValue,
      artifactPath,
      resultPath,
      summary: `Cycle ${cycleIndex} ${outcome}`,
      sessionId: canvasSessionId,
      agentId: canvasAgentId,
      waitHuman,
      humanTimeoutMs,
      fetchImpl,
    })
    : null;
  const reviewSkippedReason = reviewResult?.skipped ? reviewResult.reason : "";
  const review = reviewResult?.skipped ? null : reviewResult;

  return {
    projectDir,
    slug,
    cycleIndex,
    kind: cycleKind,
    command,
    cwd: runCwd,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    metric: metricValue,
    artifactPath,
    artifactRelativePath,
    cycleLine,
    seed,
    git: {
      ...git,
      shortSha: gitShortSha,
      commitUrl,
    },
    review,
    reviewWait: review?.wait || null,
    reviewSkippedReason,
    monitorCanvas,
    monitorCanvasSkippedReason,
  };
}

export async function runNextMove({
  projectDir,
  slug = "",
  agent = "0",
  question = "",
  hypothesis = "",
  grounding = "",
  design = "",
  command,
  cwd = "",
  kind = "change",
  change = "",
  metric = "",
  metricRegex = "",
  qual = "",
  seed = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  askHuman = false,
  waitHuman = false,
  humanTimeoutMs = 30_000,
  agentTownApi = "",
  fetchImpl = globalThis.fetch,
  monitorUrl = "",
  monitorTitle = "",
  monitorCaption = "",
  canvasSessionId = "",
  canvasAgentId = "",
  force = false,
  codeCwd = "",
  prepareBranch = false,
  startRef = "",
  gitBranch = "",
  gitFetch = false,
  gitCommit = false,
  gitCommitMessage = "",
  gitAllowEmpty = false,
  gitPush = false,
  gitRemote = "origin",
  allowBudgetCap = false,
} = {}) {
  const claim = await claimNextMove({
    projectDir,
    slug,
    agent,
    question,
    hypothesis,
    grounding,
    design,
    force,
    codeCwd,
    prepareBranch,
    startRef,
    gitBranch,
    gitFetch,
    gitPush: prepareBranch ? gitPush : false,
    gitRemote,
    allowBudgetCap,
  });
  const cycle = await runCycle({
    projectDir,
    slug: claim.slug,
    command,
    cwd,
    kind,
    change,
    metric,
    metricRegex,
    qual,
    seed,
    timeoutMs,
    askHuman,
    waitHuman,
    humanTimeoutMs,
    agentTownApi,
    fetchImpl,
    monitorUrl,
    monitorTitle,
    monitorCaption,
    canvasSessionId,
    canvasAgentId,
    gitCommit,
    gitCommitMessage,
    gitAllowEmpty,
    gitPush,
    gitRemote,
    gitBranch,
  });
  return { claim, cycle };
}

export async function finishMove({
  projectDir,
  slug,
  status = "resolved",
  event = "resolved",
  takeaway = "",
  analysis = "",
  decision = "",
  queueUpdates = [],
  aggregateMetric = false,
  metricName = "",
  higherIsBetter,
  noiseMultiplier = 2,
  autoAdmit = false,
  allowCrossVersion = false,
  apply = false,
  commit = "",
  score = "",
  summary = "",
  costCompute = "",
  costDollars = "",
  updatePaper = false,
  paperFigure = "",
  paperCaption = "",
  paperLimitations = "",
  paperDiscussion = "",
  publishCanvas = false,
  canvasImage = "",
  canvasUrl = "",
  canvasTitle = "",
  canvasCaption = "",
  canvasSessionId = "",
  canvasAgentId = "",
  agentTownApi = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!projectDir) throw new TypeError("projectDir is required");
  if (!slug) throw new TypeError("slug is required");
  const normalizedStatus = String(status || "resolved").trim().toLowerCase();
  if (!["resolved", "abandoned"].includes(normalizedStatus)) {
    throw new Error(`status must be resolved or abandoned, got "${status}"`);
  }

  const resultPath = path.join(projectDir, "results", `${slug}.md`);
  let text = await readFile(resultPath, "utf8");
  const readmeText = await readFile(path.join(projectDir, "README.md"), "utf8");
  const project = parseProjectReadme(readmeText);
  let aggregate = null;
  let admissionBlocked = false;

  if (aggregateMetric || autoAdmit) {
    const rows = await collectCycleMetrics(projectDir, slug);
    aggregate = summarizeMetrics(rows);
    if (aggregate) {
      const metricConfig = deriveMetricConfig(project, { metricName, higherIsBetter });
      text = upsertFrontmatter(text, {
        metric: metricConfig.metric,
        metric_higher_is_better: metricConfig.higherIsBetter,
        seeds: aggregate.seeds,
        mean: Number(formatNumber(aggregate.mean)),
        std: Number(formatNumber(aggregate.std)),
        noise_multiplier: Number(noiseMultiplier) || 2,
      });
      text = appendSectionBullet(
        text,
        "Results",
        `- aggregate: ${metricConfig.metric}_mean=${formatNumber(aggregate.mean)} std=${formatNumber(aggregate.std)} across n=${aggregate.n} cycles.`,
      );
    } else if (aggregateMetric) {
      throw new Error(`no numeric cycle metrics found under artifacts/${slug}/`);
    }
  }

  text = replaceSectionBody(text, "STATUS", normalizedStatus);
  if (takeaway) text = replaceSectionBody(text, "TAKEAWAY", takeaway);
  if (analysis) text = replaceSectionBody(text, "Analysis", analysis);

  if (autoAdmit) {
    await atomicWrite(resultPath, text);
    const report = await runAdmit({
      projectDir,
      candidateResultPath: path.relative(projectDir, resultPath),
      allowCrossVersion,
    });
    admissionBlocked = Boolean(report.decision?.blocked);
    text = await readFile(resultPath, "utf8");
    text = replaceSectionBody(text, "Leaderboard verdict", formatVerdict(report));
  } else if (decision) {
    text = replaceSectionBody(text, "Leaderboard verdict", `Decision: ${decision}`);
  }

  if (queueUpdates.length) {
    text = replaceSectionBody(text, "Queue updates", queueUpdates.join("\n"));
  }

  const budgetDebits = normalizeBudgetDebits({ compute: costCompute, dollars: costDollars });
  const hasBudgetDebit = budgetDebits.compute > 0 || budgetDebits.dollars > 0;
  if (hasBudgetDebit) {
    const costParts = [];
    if (budgetDebits.compute > 0) costParts.push(`compute=${formatNumber(budgetDebits.compute)}`);
    if (budgetDebits.dollars > 0) costParts.push(`dollars=${formatNumber(budgetDebits.dollars)}`);
    text = appendSectionBullet(text, "Reproducibility", `- cost: ${costParts.join("; ")}.`);
  }

  await atomicWrite(resultPath, text);
  if (apply && admissionBlocked) {
    throw new Error("auto-admission is blocked; wrote the verdict to the result doc but did not apply README/LOG updates");
  }

  let paper = null;
  if (updatePaper || paperFigure) {
    paper = await updatePaperForMove({
      projectDir,
      slug,
      project,
      doc: parseResultDoc(text),
      resultText: text,
      resultPath,
      aggregate,
      metricName,
      paperFigure,
      paperCaption,
      paperLimitations,
      paperDiscussion,
    });
  }

  let canvas = null;
  const shouldPublishCanvas = publishCanvas || canvasImage || canvasUrl;
  if (shouldPublishCanvas) {
    const fallbackImagePath = paper?.figure?.remote ? "" : paper?.figure?.absolutePath || "";
    const fallbackImageUrl = paper?.figure?.remote ? paper.figure.relativePath : "";
    let explicitCanvasImage = "";
    if (canvasImage) {
      explicitCanvasImage = path.resolve(canvasImage);
      if (!path.isAbsolute(canvasImage) && !(await pathExists(explicitCanvasImage))) {
        explicitCanvasImage = path.resolve(projectDir, canvasImage);
      }
    }
    const imagePath = explicitCanvasImage || fallbackImagePath;
    const imageUrl = canvasUrl || fallbackImageUrl;
    canvas = await publishAgentCanvas({
      api: agentTownApi || process.env.VIBE_RESEARCH_AGENT_TOWN_API || "",
      projectDir,
      slug,
      imagePath,
      imageUrl,
      title: canvasTitle || paperCaption || takeaway || `Result: ${slug}`,
      caption: canvasCaption || paperCaption || takeaway || summary,
      sessionId: canvasSessionId,
      agentId: canvasAgentId,
      fetchImpl,
    });
  }

  const resolveResult = apply
    ? await resolveMove({
      projectDir,
      slug,
      event,
      summary,
      score,
      commit,
      budgetDebits,
    })
    : null;

  await updateResearchState({
    projectDir,
    phase: normalizedStatus === "resolved" ? "review" : "brainstorm",
    briefSlug: "",
    summary: `${normalizedStatus} move ${slug}`,
  }).catch(() => null);

  return {
    projectDir,
    slug,
    status: normalizedStatus,
    resultPath,
    aggregate,
    paper,
    canvas: canvas?.skipped ? null : canvas,
    canvasSkippedReason: canvas?.skipped ? canvas.reason : "",
    applied: Boolean(resolveResult),
    resolve: resolveResult,
  };
}

export const __internal = {
  DEFAULT_METRIC_REGEX,
  DEFAULT_TIMEOUT_MS,
  appendSectionBullet,
  branchUrlForMove,
  collectCycleMetrics,
  commitUrlForSha,
  createReviewCard,
  escapeMarkdown,
  preparePaperFigure,
  publishAgentCanvas,
  deriveMetricConfig,
  extractMetric,
  inferGitRef,
  insertIntoSection,
  parseArtifactLog,
  replaceSectionBody,
  renderResultDoc,
  summarizeMetrics,
  upsertFrontmatter,
};
