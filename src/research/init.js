// Project bootstrap for the Vibe Research researcher contract.
//
// Used by `bin/vr-research-init` and any agent that wants to start a new
// research project programmatically (recursive self-improvement: the
// agent identifies a question worth investigating and creates the
// project itself, no human in the loop required).
//
// The project shape follows the contract in CLAUDE.md:
//
//   projects/<name>/
//     README.md          ← project index (GOAL, CODE REPO, SUCCESS,
//                          RANKING CRITERION, LEADERBOARD, INSIGHTS,
//                          ACTIVE, QUEUE; LOG section is a pointer)
//     LOG.md             ← append-only event history (separate file so
//                          the README stays compact in the loop's hot
//                          path; agents only read the LOG when reviewing)
//     paper.md           ← living human-facing paper (copied from
//                          templates/paper-template.md, title filled)
//     results/           ← per-move result docs (created empty)
//     figures/           ← per-move figures (created empty)
//
// API:
//
//   const result = await createProject({
//     projectsDir,             // absolute path to the projects/ dir
//     name,                    // slug (a-z0-9-)
//     goal,                    // one-paragraph what we're trying to learn
//     codeRepoUrl,             // optional github url
//     successCriteria,         // array of bullet strings
//     ranking,                 // { kind: "quantitative"|"qualitative"|"mix",
//                              //   metric?, direction?, dimension?, ... }
//     queueRows,               // optional [{ move, startingPoint, why }]
//     paperTemplatePath,       // optional override of templates/paper-template.md
//     force,                   // overwrite existing project dir
//   });
//   // returns { wrote: [paths], projectDir }

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeMarkdownPipe(value) {
  return String(value).replace(/\|/g, "\\|");
}

function renderRankingLine(ranking) {
  const kind = String(ranking?.kind || "qualitative").toLowerCase();
  if (kind === "quantitative") {
    const metric = trimString(ranking.metric) || "<metric-name>";
    const direction = String(ranking.direction || "higher").toLowerCase() === "lower" ? "lower" : "higher";
    return `quantitative: ${metric} (${direction} is better)`;
  }
  if (kind === "mix") {
    const metric = trimString(ranking.metric) || "<metric-name>";
    const direction = String(ranking.direction || "higher").toLowerCase() === "lower" ? "lower" : "higher";
    const dimension = trimString(ranking.dimension) || "<qualitative-dimension>";
    return `mix: ${metric} (${direction}) + ${dimension}`;
  }
  // qualitative default
  const dimension = trimString(ranking?.dimension) || "<dimension>";
  return `qualitative: ${dimension}`;
}

function renderQueueRow({ move, startingPoint, why }) {
  return `| ${escapeMarkdownPipe(move || "")} | ${escapeMarkdownPipe(startingPoint || "main")} | ${escapeMarkdownPipe(why || "")} |`;
}

export function renderProjectReadme({
  name,
  goal,
  codeRepoUrl,
  successCriteria = [],
  ranking,
  queueRows = [],
}) {
  const successLines = successCriteria.length
    ? successCriteria.map((line) => `- ${line.trim()}`).join("\n")
    : "- _stub: fill in the concrete \"done\" definition_";
  const queueBody = queueRows.length
    ? [
        "| move | starting-point | why |",
        "|------|----------------|-----|",
        ...queueRows.map(renderQueueRow),
      ].join("\n")
    : "| move | starting-point | why |\n|------|----------------|-----|";
  return [
    `# ${name}`,
    "",
    "## GOAL",
    "",
    trimString(goal) || `_one paragraph: what question are we ultimately trying to answer?_`,
    "",
    "## CODE REPO",
    "",
    trimString(codeRepoUrl) || `\`<github-url>\` _(set when the code repo is created and pushed)_`,
    "",
    "## SUCCESS CRITERIA",
    "",
    successLines,
    "",
    "## RANKING CRITERION",
    "",
    renderRankingLine(ranking || {}),
    "",
    "## LEADERBOARD",
    "",
    "| rank | result | branch | commit | score / verdict |",
    "|------|--------|--------|--------|-----------------|",
    "",
    "## INSIGHTS",
    "",
    "_no insights yet — review mode crystallizes these from across moves._",
    "",
    "## ACTIVE",
    "",
    "| move | result doc | branch | agent | started |",
    "|------|------------|--------|-------|---------|",
    "",
    "## QUEUE",
    "",
    queueBody,
    "",
    "## LOG",
    "",
    "See [LOG.md](./LOG.md) — append-only event history.",
    "",
  ].join("\n");
}

export function renderProjectLog({ name }) {
  return [
    `# ${name} — LOG`,
    "",
    "Append-only event log. Newest first. See [README.md](./README.md) for project state (LEADERBOARD, ACTIVE, QUEUE).",
    "",
    "| date | event | slug or ref | one-line summary | link |",
    "|------|-------|-------------|------------------|------|",
    "",
  ].join("\n");
}

async function loadPaperTemplate(paperTemplatePath, repoRoot) {
  const candidates = [];
  if (paperTemplatePath) candidates.push(paperTemplatePath);
  candidates.push(path.join(repoRoot, "templates", "paper-template.md"));
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return null;
}

export function fillPaperTemplate(template, { name, goal }) {
  if (typeof template !== "string") return null;
  let out = template;
  // Replace the first heading line with the project name.
  out = out.replace(/^#\s+<Project title>\s*$/m, `# ${name}`);
  // Soft-fill the Question section's first paragraph if present + a goal
  // was supplied. We insert just before the locked-comment so the lock
  // marker is preserved.
  if (trimString(goal)) {
    out = out.replace(
      /(## 1\. Question\s*\n\s*<!-- locked: pre-registration -->\s*\n\s*\n)([^\n]+)/,
      (_match, header, _placeholder) => `${header}${goal.trim()}`,
    );
  }
  return out;
}

async function pathExists(targetPath) {
  try { await stat(targetPath); return true; } catch { return false; }
}

// Seed the W&B project so the project shortcut links to a real page from
// minute one — analogous to writing paper.md at init time. Best-effort:
// returns { ok, reason } without throwing. Skipped when entity is empty.
export async function seedWandbProject({
  entity,
  project,
  pythonBin = "python3",
  timeoutMs = 15_000,
}) {
  if (!entity || !project) return { ok: false, reason: "no-entity" };
  const py = [
    "import sys",
    "try:",
    "    import wandb",
    "except ImportError:",
    "    sys.exit(2)",
    "try:",
    `    wandb.init(project=${JSON.stringify(project)}, entity=${JSON.stringify(entity)}, name="_init", notes="seeded by vr-research-init", reinit=True)`,
    "    wandb.finish()",
    "except Exception as e:",
    "    print(f'wandb init failed: {e}', file=sys.stderr)",
    "    sys.exit(3)",
  ].join("\n");

  return new Promise((resolve) => {
    // WANDB_SILENT silences progress chatter; closing stdin makes wandb
    // detect a non-interactive shell and fail fast instead of prompting
    // for a login.
    const child = spawn(pythonBin, ["-c", py], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, WANDB_SILENT: "true" },
    });
    let stderr = "";
    let timer = null;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ ok: false, reason: "timeout" });
    }, timeoutMs);
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => settle({ ok: false, reason: "spawn-failed", error: err.message }));
    child.on("close", (code) => {
      if (code === 0) return settle({ ok: true });
      if (code === 2) return settle({ ok: false, reason: "wandb-not-installed" });
      settle({ ok: false, reason: `exit-${code}`, stderr: stderr.trim() });
    });
  });
}

export async function createProject({
  projectsDir,
  name,
  goal = "",
  codeRepoUrl = "",
  successCriteria = [],
  ranking,
  queueRows = [],
  paperTemplatePath,
  repoRoot = path.resolve(projectsDir, ".."),
  force = false,
  wandbEntity = "",
} = {}) {
  if (!projectsDir) throw new TypeError("projectsDir is required");
  const trimmedName = trimString(name);
  if (!trimmedName) throw new TypeError("name is required");
  if (!DEFAULT_PROJECT_NAME_PATTERN.test(trimmedName)) {
    throw new TypeError(`name must match ${DEFAULT_PROJECT_NAME_PATTERN}; got "${trimmedName}"`);
  }

  const projectDir = path.join(projectsDir, trimmedName);
  if (await pathExists(projectDir) && !force) {
    throw new Error(`project already exists at ${projectDir} (pass force: true to overwrite)`);
  }

  const wrote = [];
  await mkdir(path.join(projectDir, "results"), { recursive: true });
  await mkdir(path.join(projectDir, "figures"), { recursive: true });

  const readmePath = path.join(projectDir, "README.md");
  const readmeBody = renderProjectReadme({
    name: trimmedName,
    goal,
    codeRepoUrl,
    successCriteria,
    ranking,
    queueRows,
  });
  await writeFile(readmePath, readmeBody, "utf8");
  wrote.push(readmePath);

  const logPath = path.join(projectDir, "LOG.md");
  await writeFile(logPath, renderProjectLog({ name: trimmedName }), "utf8");
  wrote.push(logPath);

  const paperPath = path.join(projectDir, "paper.md");
  const template = await loadPaperTemplate(paperTemplatePath, repoRoot);
  if (template) {
    const filled = fillPaperTemplate(template, { name: trimmedName, goal });
    await writeFile(paperPath, filled, "utf8");
    wrote.push(paperPath);
  }
  // results/ + figures/ are dirs; nothing to write inside them at init.

  const wandb = wandbEntity
    ? await seedWandbProject({ entity: wandbEntity, project: trimmedName })
    : { ok: false, reason: "no-entity" };

  return { projectDir, wrote, wandb };
}
