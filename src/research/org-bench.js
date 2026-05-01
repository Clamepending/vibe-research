import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProject } from "./init.js";
import { runResearchAutopilot } from "./autopilot.js";

const POSTTRAIN_LITE_METHOD_WEIGHTS = {
  dev: {
    sft: 0.24,
    lora: 0.21,
    qlora: 0.19,
    grpo: 0.17,
  },
  holdout: {
    sft: 0.19,
    lora: 0.25,
    qlora: 0.23,
    grpo: 0.18,
  },
};

function trimString(value) {
  return String(value || "").trim();
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

function shellQuote(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function scoreCloseness(value, target, scale) {
  return Math.max(0, 1 - Math.abs(Number(value) - Number(target)) / Number(scale || 1));
}

function normalizeMix(mix = {}) {
  const math = Math.max(0, Number(mix.math) || 0);
  const code = Math.max(0, Number(mix.code) || 0);
  const health = Math.max(0, Number(mix.health) || 0);
  const total = math + code + health || 1;
  return {
    math: math / total,
    code: code / total,
    health: health / total,
  };
}

export function scorePosttrainLiteRecipe(recipe, profile, { split = "holdout" } = {}) {
  const method = trimString(recipe?.method || "sft").toLowerCase();
  const profileMix = normalizeMix(profile?.targetMix || {});
  const recipeMix = normalizeMix(recipe?.dataMix || {});
  const lr = Math.max(1e-6, Number(recipe?.learningRate) || 1e-3);
  const targetLr = Math.max(1e-6, Number(profile?.targetLearningRate) || 8e-4);
  const epochs = clamp(recipe?.epochs, 1, 8);
  const targetEpochs = clamp(profile?.targetEpochs, 1, 8);
  const regularization = clamp(recipe?.regularization, 0, 0.5);
  const targetRegularization = clamp(profile?.targetRegularization, 0, 0.5);
  const syntheticDataQuality = clamp(recipe?.syntheticDataQuality, 0, 1);
  const methodWeights = split === "dev" ? POSTTRAIN_LITE_METHOD_WEIGHTS.dev : POSTTRAIN_LITE_METHOD_WEIGHTS.holdout;

  const mixDistance = Math.abs(recipeMix.math - profileMix.math)
    + Math.abs(recipeMix.code - profileMix.code)
    + Math.abs(recipeMix.health - profileMix.health);
  const lrScore = scoreCloseness(Math.log10(lr), Math.log10(targetLr), 0.9);
  const epochScore = scoreCloseness(epochs, targetEpochs, 4);
  const mixScore = Math.max(0, 1 - mixDistance / 1.4);
  const regularizationScore = scoreCloseness(regularization, targetRegularization, 0.24);
  const overfitPenalty = split === "holdout" && epochs >= 5 && regularization < 0.08 ? 0.09 : 0;

  const raw = 0.22
    + (methodWeights[method] || 0.14)
    + 0.16 * lrScore
    + 0.12 * epochScore
    + 0.15 * mixScore
    + 0.08 * regularizationScore
    + 0.06 * syntheticDataQuality
    - overfitPenalty;

  return Number(Math.max(0, Math.min(1, raw)).toFixed(4));
}

function posttrainLiteProfiles(seed = 0) {
  const offset = ((Number(seed) || 0) % 7) / 100;
  return {
    dev: {
      split: "dev",
      targetLearningRate: 0.001 + offset / 5,
      targetEpochs: 5,
      targetRegularization: 0.04,
      targetMix: { math: 0.56 - offset, code: 0.28 + offset / 2, health: 0.16 + offset / 2 },
    },
    holdout: {
      split: "holdout",
      targetLearningRate: 0.0007 + offset / 8,
      targetEpochs: 3,
      targetRegularization: 0.18,
      targetMix: { math: 0.47 - offset / 2, code: 0.34 + offset / 3, health: 0.19 + offset / 6 },
    },
  };
}

function baseRecipe() {
  return {
    method: "grpo",
    learningRate: 0.004,
    epochs: 1,
    regularization: 0.0,
    syntheticDataQuality: 0.25,
    dataMix: { math: 0.12, code: 0.18, health: 0.70 },
  };
}

function devOverfitRecipe(profile) {
  return {
    method: "sft",
    learningRate: profile.targetLearningRate,
    epochs: 5,
    regularization: 0.03,
    syntheticDataQuality: 0.72,
    dataMix: profile.targetMix,
  };
}

function robustOrgRecipe(profile) {
  return {
    method: "lora",
    learningRate: 0.00075,
    epochs: 3,
    regularization: 0.18,
    syntheticDataQuality: 0.78,
    dataMix: {
      math: (profile.targetMix.math + 0.47) / 2,
      code: (profile.targetMix.code + 0.34) / 2,
      health: (profile.targetMix.health + 0.19) / 2,
    },
  };
}

function scenarioTaskMarkdown() {
  return `# PostTrainBench-Lite Proxy

You are optimizing a tiny post-training recipe, not a real language model.

Edit \`recipe.json\` to maximize hidden holdout score. You may inspect
\`data/dev-profile.json\` and run \`node scripts/evaluate-dev.mjs\`, but the
benchmark is scored on a private holdout profile by the harness.

Protected files are hashed by the harness. Do not edit \`data/\`, \`scripts/\`,
or \`.bench/\`; doing so marks the run as an integrity failure.
`;
}

function evaluateDevScript() {
  return `#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const METHOD_WEIGHTS = { sft: 0.24, lora: 0.21, qlora: 0.19, grpo: 0.17 };
function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}
function closeness(value, target, scale) {
  return Math.max(0, 1 - Math.abs(Number(value) - Number(target)) / Number(scale || 1));
}
function mix(value = {}) {
  const math = Math.max(0, Number(value.math) || 0);
  const code = Math.max(0, Number(value.code) || 0);
  const health = Math.max(0, Number(value.health) || 0);
  const total = math + code + health || 1;
  return { math: math / total, code: code / total, health: health / total };
}
const recipe = JSON.parse(await readFile("recipe.json", "utf8"));
const profile = JSON.parse(await readFile("data/dev-profile.json", "utf8"));
const recipeMix = mix(recipe.dataMix);
const targetMix = mix(profile.targetMix);
const lr = Math.max(1e-6, Number(recipe.learningRate) || 1e-3);
const targetLr = Math.max(1e-6, Number(profile.targetLearningRate) || 8e-4);
const mixDistance = Math.abs(recipeMix.math - targetMix.math) + Math.abs(recipeMix.code - targetMix.code) + Math.abs(recipeMix.health - targetMix.health);
const raw = 0.22
  + (METHOD_WEIGHTS[String(recipe.method || "sft").toLowerCase()] || 0.14)
  + 0.16 * closeness(Math.log10(lr), Math.log10(targetLr), 0.9)
  + 0.12 * closeness(clamp(recipe.epochs, 1, 8), clamp(profile.targetEpochs, 1, 8), 4)
  + 0.15 * Math.max(0, 1 - mixDistance / 1.4)
  + 0.08 * closeness(clamp(recipe.regularization, 0, 0.5), clamp(profile.targetRegularization, 0, 0.5), 0.24)
  + 0.06 * clamp(recipe.syntheticDataQuality, 0, 1);
const score = Math.max(0, Math.min(1, raw)).toFixed(4);
console.log("score=" + score);
`;
}

function singleProxyScript() {
  return `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
const profile = JSON.parse(await readFile("data/dev-profile.json", "utf8"));
const recipe = {
  method: "sft",
  learningRate: profile.targetLearningRate,
  epochs: 5,
  regularization: 0.03,
  syntheticDataQuality: 0.72,
  dataMix: profile.targetMix
};
await writeFile("recipe.json", JSON.stringify(recipe, null, 2) + "\\n");
const { spawnSync } = await import("node:child_process");
const result = spawnSync(process.execPath, ["scripts/evaluate-dev.mjs"], { encoding: "utf8" });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status || 0);
`;
}

function orgCycleScript() {
  return `#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const statePath = path.join(".vibe-bench", "org-cycle-state.json");
await mkdir(path.dirname(statePath), { recursive: true });
let state = { cycle: 0 };
try { state = JSON.parse(await readFile(statePath, "utf8")); } catch {}
state.cycle = Number(state.cycle || 0) + 1;
const profile = JSON.parse(await readFile("data/dev-profile.json", "utf8"));
const recipe = state.cycle <= 1
  ? {
      method: "sft",
      learningRate: profile.targetLearningRate,
      epochs: 5,
      regularization: 0.03,
      syntheticDataQuality: 0.72,
      dataMix: profile.targetMix
    }
  : {
      method: "lora",
      learningRate: 0.00075,
      epochs: 3,
      regularization: 0.18,
      syntheticDataQuality: 0.78,
      dataMix: {
        math: (profile.targetMix.math + 0.47) / 2,
        code: (profile.targetMix.code + 0.34) / 2,
        health: (profile.targetMix.health + 0.19) / 2
      }
    };
await writeFile("recipe.json", JSON.stringify(recipe, null, 2) + "\\n");
await writeFile(statePath, JSON.stringify(state, null, 2) + "\\n");
const { spawnSync } = await import("node:child_process");
const result = spawnSync(process.execPath, ["scripts/evaluate-dev.mjs"], { encoding: "utf8" });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status || 0);
`;
}

function providerAgentProxyScript() {
  return `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg.startsWith("--")) {
    args.set(arg.slice(2), process.argv[index + 1] && !process.argv[index + 1].startsWith("--") ? process.argv[++index] : "true");
  }
}
const mode = String(args.get("mode") || process.env.VIBE_RESEARCH_ORG_BENCH_STRATEGY || "single-agent-provider");
const cycle = Number(args.get("cycle") || process.env.VIBE_RESEARCH_ORG_BENCH_CYCLE || 1);
const reviewFile = String(process.env.VIBE_RESEARCH_ORG_BENCH_REVIEW_FILE || "");
let reviewText = "";
if (reviewFile) {
  try { reviewText = await readFile(reviewFile, "utf8"); } catch {}
}
if (process.env.VIBE_RESEARCH_ORG_BENCH_PROVIDER === "require-env") {
  const required = [
    "VIBE_RESEARCH_ORG_BENCH_PROMPT_FILE",
    "VIBE_RESEARCH_ORG_BENCH_SCENARIO_DIR",
    "VIBE_RESEARCH_ORG_BENCH_SEED",
    "VIBE_RESEARCH_ORG_BENCH_STRATEGY"
  ];
  for (const name of required) {
    if (!process.env[name]) throw new Error(\`missing provider env \${name}\`);
  }
}
const profile = JSON.parse(await readFile("data/dev-profile.json", "utf8"));
const single = {
  method: "sft",
  learningRate: profile.targetLearningRate,
  epochs: 5,
  regularization: 0.03,
  syntheticDataQuality: 0.72,
  dataMix: profile.targetMix
};
const robust = {
  method: "lora",
  learningRate: 0.00075,
  epochs: 3,
  regularization: 0.18,
  syntheticDataQuality: 0.78,
  dataMix: {
    math: (profile.targetMix.math + 0.47) / 2,
    code: (profile.targetMix.code + 0.34) / 2,
    health: (profile.targetMix.health + 0.19) / 2
  }
};
const reviewSaysOverfit = /OVERFIT_RISK=high|regularization.*0\\.18|lora/iu.test(reviewText);
const useRobust = (mode === "org-provider" && cycle >= 2)
  || (mode === "org-provider-reviewed" && cycle >= 2 && reviewSaysOverfit);
await writeFile("recipe.json", JSON.stringify(useRobust ? robust : single, null, 2) + "\\n");
const { spawnSync } = await import("node:child_process");
const result = spawnSync(process.execPath, ["scripts/evaluate-dev.mjs"], { encoding: "utf8" });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status || 0);
`;
}

function providerReviewerProxyScript() {
  return `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const reviewFile = process.env.VIBE_RESEARCH_ORG_BENCH_REVIEW_FILE || ".bench/reviewer-cycle.md";
const cycle = Number(process.env.VIBE_RESEARCH_ORG_BENCH_CYCLE || 1);
const recipe = JSON.parse(await readFile("recipe.json", "utf8"));
const profile = JSON.parse(await readFile("data/dev-profile.json", "utf8"));
const overfitRisk = String(recipe.method || "").toLowerCase() === "sft"
  || Number(recipe.epochs || 0) >= 5
  || Number(recipe.regularization || 0) < 0.08;
const review = [
  \`# Reviewer memo for cycle \${cycle}\`,
  "",
  \`OVERFIT_RISK=\${overfitRisk ? "high" : "low"}\`,
  \`visible_dev_method=\${recipe.method}\`,
  \`visible_dev_epochs=\${recipe.epochs}\`,
  \`visible_dev_regularization=\${recipe.regularization}\`,
  "",
  "Recommendation for the next worker:",
  "- Do not maximize the visible dev profile literally.",
  "- Prefer method=lora, epochs=3, regularization=0.18, syntheticDataQuality=0.78.",
  "- Blend dataMix partway from the visible profile toward a plausible holdout prior: math=0.47, code=0.34, health=0.19.",
  \`- Visible target was math=\${profile.targetMix.math}, code=\${profile.targetMix.code}, health=\${profile.targetMix.health}; treat that as a noisy dev clue, not ground truth.\`,
  ""
].join("\\n");
await writeFile(reviewFile, review);
console.log(\`review_file=\${reviewFile}\`);
console.log(\`overfit_risk=\${overfitRisk ? "high" : "low"}\`);
`;
}

export async function createPosttrainLiteScenario({ scenarioDir, seed = 0 } = {}) {
  if (!scenarioDir) throw new TypeError("scenarioDir is required");
  const resolved = path.resolve(scenarioDir);
  const profiles = posttrainLiteProfiles(seed);
  await rm(resolved, { recursive: true, force: true });
  await mkdir(path.join(resolved, "scripts"), { recursive: true });
  await mkdir(path.join(resolved, "data"), { recursive: true });
  await mkdir(path.join(resolved, ".bench"), { recursive: true });
  await writeFile(path.join(resolved, "TASK.md"), scenarioTaskMarkdown());
  await writeJson(path.join(resolved, "recipe.json"), baseRecipe());
  await writeJson(path.join(resolved, "data", "dev-profile.json"), profiles.dev);
  await writeJson(path.join(resolved, ".bench", "holdout-profile.json"), profiles.holdout);
  await writeFile(path.join(resolved, "scripts", "evaluate-dev.mjs"), evaluateDevScript(), { mode: 0o755 });
  await writeFile(path.join(resolved, "scripts", "single-agent-proxy.mjs"), singleProxyScript(), { mode: 0o755 });
  await writeFile(path.join(resolved, "scripts", "org-cycle.mjs"), orgCycleScript(), { mode: 0o755 });
  await writeFile(path.join(resolved, "scripts", "provider-agent-proxy.mjs"), providerAgentProxyScript(), { mode: 0o755 });
  await writeFile(path.join(resolved, "scripts", "provider-reviewer-proxy.mjs"), providerReviewerProxyScript(), { mode: 0o755 });

  const protectedFiles = [
    "TASK.md",
    "data/dev-profile.json",
    ".bench/holdout-profile.json",
    "scripts/evaluate-dev.mjs",
    "scripts/single-agent-proxy.mjs",
    "scripts/org-cycle.mjs",
    "scripts/provider-agent-proxy.mjs",
    "scripts/provider-reviewer-proxy.mjs",
  ];
  const hashes = {};
  for (const relative of protectedFiles) {
    hashes[relative] = await sha256File(path.join(resolved, relative));
  }
  await writeJson(path.join(resolved, ".bench", "manifest.json"), {
    suite: "posttrain-lite",
    seed,
    protectedFiles,
    hashes,
    createdAt: new Date().toISOString(),
  });
  return { scenarioDir: resolved, seed, protectedFiles };
}

export async function evaluatePosttrainLiteScenario({ scenarioDir } = {}) {
  if (!scenarioDir) throw new TypeError("scenarioDir is required");
  const resolved = path.resolve(scenarioDir);
  const recipe = await readJson(path.join(resolved, "recipe.json"));
  const devProfile = await readJson(path.join(resolved, "data", "dev-profile.json"));
  const holdoutProfile = await readJson(path.join(resolved, ".bench", "holdout-profile.json"));
  const manifest = await readJson(path.join(resolved, ".bench", "manifest.json")).catch(() => null);
  const integrityFindings = [];
  if (!manifest) {
    integrityFindings.push("missing .bench/manifest.json");
  } else {
    for (const relative of manifest.protectedFiles || []) {
      const filePath = path.join(resolved, relative);
      if (!await pathExists(filePath)) {
        integrityFindings.push(`missing protected file: ${relative}`);
        continue;
      }
      const actual = await sha256File(filePath);
      if (actual !== manifest.hashes?.[relative]) {
        integrityFindings.push(`modified protected file: ${relative}`);
      }
    }
  }
  return {
    recipe,
    devScore: scorePosttrainLiteRecipe(recipe, devProfile, { split: "dev" }),
    holdoutScore: scorePosttrainLiteRecipe(recipe, holdoutProfile, { split: "holdout" }),
    integrityOk: integrityFindings.length === 0,
    integrityFindings,
  };
}

async function runShellCommand(commandText, { cwd, timeoutMs = 30_000, env = process.env } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(commandText, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      settle({ exitCode: null, timedOut: true });
    }, timeoutMs);
    function settle(extra = {}) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: extra.exitCode,
        timedOut: Boolean(extra.timedOut),
        wallMs: Date.now() - startedAt,
      });
    }
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      stderr += `\n[org-bench] spawn error: ${error.message}`;
      settle({ exitCode: -1 });
    });
    child.on("close", (code) => settle({ exitCode: code }));
  });
}

function summarizeAutopilotActions(report) {
  return (report?.actions || []).map((action) => ({
    plannedAction: action.plannedAction,
    metric: action.result?.cycle?.metric || action.result?.cycle?.metricValue || action.result?.cycle?.cycle?.metric || "",
    kind: action.result?.kind || "",
  }));
}

function providerPrompt({
  strategy,
  seed,
  cycle = 1,
  providerId = "",
  reviewFile = "",
  reviewText = "",
} = {}) {
  const role = strategy === "org-provider" || strategy === "org-provider-reviewed"
    ? "You are a worker inside the Vibe Research organization loop."
    : "You are a single coding agent baseline.";
  const hasReview = trimString(reviewText);
  const extra = hasReview
    ? "This is a follow-up cycle after reviewer critique. Use the critique to reduce visible-dev overfitting while preserving any real signal."
    : (strategy === "org-provider" || strategy === "org-provider-reviewed") && Number(cycle) >= 2
    ? "This is a follow-up cycle after review. Prefer robust holdout generalization over maximizing the visible dev score."
    : "This is the first pass. Improve the recipe using the visible task instructions and dev evaluator.";
  const lines = [
    role,
    "",
    "Task: improve the PostTrainBench-Lite proxy recipe in this working directory.",
    "",
    "Read TASK.md, inspect recipe.json and data/dev-profile.json, edit recipe.json only, then run `node scripts/evaluate-dev.mjs`.",
    "Do not edit data/, scripts/, or .bench/; those files are protected by the benchmark integrity check.",
    "The final score is hidden holdout, not the visible dev score.",
    "Keep this bounded: make one small recipe edit, run the dev evaluator once, print its output, and stop.",
    "Do not write a long report, do not keep searching after the evaluator runs, and do not inspect hidden benchmark files.",
    extra,
    "",
    `Strategy: ${strategy}`,
    `Provider: ${providerId || "unspecified"}`,
    `Seed: ${seed}`,
    `Cycle: ${cycle}`,
  ];
  if (hasReview) {
    lines.push(
      "",
      `Reviewer artifact: ${reviewFile}`,
      "Reviewer memo:",
      "```",
      reviewText.slice(0, 4000),
      "```",
    );
  }
  lines.push(
    "",
    "Finish by leaving the improved recipe.json on disk and printing the dev evaluator output.",
  );
  return lines.join("\n");
}

function renderCommandTemplate(template, context = {}) {
  const raw = trimString(template);
  if (!raw) return "";
  return raw.replace(/\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(context, key)) return match;
    return shellQuote(context[key]);
  });
}

function providerEnv(context = {}) {
  return {
    VIBE_RESEARCH_ORG_BENCH_CYCLE: String(context.cycle || ""),
    VIBE_RESEARCH_ORG_BENCH_PROVIDER: trimString(context.providerId),
    VIBE_RESEARCH_ORG_BENCH_PROMPT_FILE: trimString(context.promptFile),
    VIBE_RESEARCH_ORG_BENCH_REVIEW_FILE: trimString(context.reviewFile),
    VIBE_RESEARCH_ORG_BENCH_ROLE: trimString(context.role || "worker"),
    VIBE_RESEARCH_ORG_BENCH_SCENARIO_DIR: trimString(context.scenarioDir),
    VIBE_RESEARCH_ORG_BENCH_SEED: String(context.seed ?? ""),
    VIBE_RESEARCH_ORG_BENCH_STRATEGY: trimString(context.strategy),
  };
}

function providerEnvPrefix(context = {}) {
  return Object.entries(providerEnv(context))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}

function providerTemplateContext({ scenarioDir, strategy, seed, cycle, providerId, promptFile, reviewFile = "", role = "worker" }) {
  return {
    cycle,
    promptFile,
    provider: providerId,
    providerId,
    reviewFile,
    role,
    scenarioDir,
    seed,
    strategy,
  };
}

async function writeProviderPrompt({ scenarioDir, strategy, seed, cycle, providerId, reviewFile = "" }) {
  const promptPath = path.join(scenarioDir, ".bench", `${strategy}-cycle-${cycle}-prompt.md`);
  const reviewText = reviewFile ? await readFile(reviewFile, "utf8").catch(() => "") : "";
  await writeFile(promptPath, providerPrompt({ strategy, seed, cycle, providerId, reviewFile, reviewText }));
  return promptPath;
}

function providerReviewerPrompt({
  strategy,
  seed,
  cycle = 1,
  providerId = "",
  reviewFile = "",
} = {}) {
  return [
    "You are the reviewer agent for a Vibe Research organization benchmark.",
    "",
    "Task: audit the current recipe.json after the worker cycle and write a short reviewer memo.",
    "",
    "Read TASK.md, data/dev-profile.json, recipe.json, and the visible dev evaluator output if useful.",
    "Do not edit recipe.json. Do not edit data/, scripts/, or .bench/ except for the review memo path below.",
    "Your job is to catch visible-dev overfitting and give the next worker concrete steering.",
    "Look especially for SFT/default recipes that match the visible dev profile too literally, high epochs, or low regularization.",
    "",
    `Write the memo to: ${reviewFile}`,
    "",
    "The memo must include:",
    "- OVERFIT_RISK=high or OVERFIT_RISK=low",
    "- 2-4 concise bullets of steering for the next worker",
    "- Any uncertainty about what the hidden holdout might reward",
    "",
    `Strategy: ${strategy}`,
    `Provider: ${providerId || "unspecified"}`,
    `Seed: ${seed}`,
    `Cycle reviewed: ${cycle}`,
    "",
    "Finish after writing the memo.",
  ].join("\n");
}

async function writeReviewerPrompt({ scenarioDir, strategy, seed, cycle, providerId, reviewFile }) {
  const promptPath = path.join(scenarioDir, ".bench", `${strategy}-review-cycle-${cycle}-prompt.md`);
  await writeFile(promptPath, providerReviewerPrompt({ strategy, seed, cycle, providerId, reviewFile }));
  return promptPath;
}

async function runProviderCommand({
  commandTemplate,
  scenarioDir,
  strategy,
  seed,
  cycle = 1,
  providerId = "",
  reviewFile = "",
  timeoutMs = 30_000,
} = {}) {
  const promptFile = await writeProviderPrompt({ scenarioDir, strategy, seed, cycle, providerId, reviewFile });
  const context = providerTemplateContext({ scenarioDir, strategy, seed, cycle, providerId, promptFile, reviewFile, role: "worker" });
  const commandText = renderCommandTemplate(commandTemplate, context);
  if (!commandText) {
    throw new Error(`${strategy} requires --provider-command or VIBE_RESEARCH_ORG_BENCH_PROVIDER_COMMAND`);
  }
  const result = await runShellCommand(commandText, {
    cwd: scenarioDir,
    timeoutMs,
    env: { ...process.env, ...providerEnv(context) },
  });
  return {
    ...result,
    command: commandText,
    promptFile,
    providerId,
    reviewFile,
  };
}

async function runReviewerCommand({
  commandTemplate,
  scenarioDir,
  strategy,
  seed,
  cycle = 1,
  providerId = "",
  timeoutMs = 30_000,
} = {}) {
  const reviewFile = path.join(scenarioDir, ".bench", `${strategy}-review-cycle-${cycle}.md`);
  const promptFile = await writeReviewerPrompt({ scenarioDir, strategy, seed, cycle, providerId, reviewFile });
  const context = providerTemplateContext({ scenarioDir, strategy, seed, cycle, providerId, promptFile, reviewFile, role: "reviewer" });
  const commandText = renderCommandTemplate(commandTemplate, context);
  if (!commandText) {
    throw new Error(`${strategy} requires --reviewer-command/--provider-command or VIBE_RESEARCH_ORG_BENCH_REVIEWER_COMMAND`);
  }
  const result = await runShellCommand(commandText, {
    cwd: scenarioDir,
    timeoutMs,
    env: { ...process.env, ...providerEnv(context) },
  });
  if (!await pathExists(reviewFile)) {
    const fallback = [
      "# Reviewer memo",
      "",
      result.stdout || result.stderr || "_reviewer produced no memo_",
      "",
    ].join("\n");
    await writeFile(reviewFile, fallback);
  }
  return {
    ...result,
    command: commandText,
    promptFile,
    reviewFile,
    providerId,
  };
}

async function setupOrgProject({ rootDir, scenarioDir, seed }) {
  const projectsDir = path.join(rootDir, "library", "projects");
  const projectName = `posttrain-lite-${seed}`;
  const project = await createProject({
    projectsDir,
    name: projectName,
    goal: "Compare a Vibe Research organization loop against a single-pass post-training proxy on a cheap local task.",
    codeRepoUrl: "https://github.com/example/posttrain-lite-proxy",
    successCriteria: [
      "holdout score improves over baseline",
      "protected benchmark files remain unchanged",
      "cycles are recorded as durable result-doc evidence",
    ],
    ranking: { kind: "quantitative", metric: "score", direction: "higher" },
    queueRows: [
      {
        move: "tune-recipe",
        startingPoint: "main",
        why: "measure iterative organization loop against single-pass proxy",
      },
    ],
    force: true,
  });
  return {
    projectDir: project.projectDir,
    commandText: `${shellQuote(process.execPath)} scripts/org-cycle.mjs`,
    codeCwd: scenarioDir,
  };
}

async function runStrategy({
  rootDir,
  strategy,
  seed,
  timeoutMs,
  orgCycles = 2,
  commandText = "",
  providerCommand = "",
  providerId = "",
  reviewerCommand = "",
  reviewerProviderId = "",
}) {
  const scenarioDir = path.join(rootDir, "runs", `${strategy}`, `seed-${seed}`, "scenario");
  await createPosttrainLiteScenario({ scenarioDir, seed });
  const startedAt = Date.now();
  let execution = { kind: strategy };

  if (strategy === "baseline") {
    execution = { kind: "baseline", skipped: true };
  } else if (strategy === "single-proxy") {
    execution = await runShellCommand(commandText || `${shellQuote(process.execPath)} scripts/single-agent-proxy.mjs`, {
      cwd: scenarioDir,
      timeoutMs,
    });
    execution.kind = "single-proxy";
  } else if (strategy === "single-agent-provider") {
    execution = await runProviderCommand({
      commandTemplate: providerCommand,
      scenarioDir,
      strategy,
      seed,
      cycle: 1,
      providerId,
      timeoutMs,
    });
    execution.kind = "single-agent-provider";
  } else if (strategy === "org-autopilot-proxy") {
    const org = await setupOrgProject({ rootDir: path.join(rootDir, "runs", strategy, `seed-${seed}`), scenarioDir, seed });
    const reports = [];
    for (let cycle = 0; cycle < orgCycles; cycle += 1) {
      reports.push(await runResearchAutopilot({
        projectDir: org.projectDir,
        maxSteps: 1,
        decision: cycle === 0 ? "" : "continue",
        commandText: commandText || org.commandText,
        metricRegex: "score=([0-9.]+)",
        change: cycle === 0 ? "dev-optimized first recipe" : "reviewed robust recipe update",
        qual: cycle === 0 ? "single-pass dev fit" : "regularized against likely holdout drift",
        seed: String(seed),
        codeCwd: org.codeCwd,
        commandTimeoutMs: timeoutMs,
      }));
    }
    execution = {
      kind: "org-autopilot-proxy",
      reports: reports.map((report) => ({
        stopReason: report.stopReason,
        actions: summarizeAutopilotActions(report),
      })),
      projectDir: org.projectDir,
    };
  } else if (strategy === "org-provider") {
    const org = await setupOrgProject({ rootDir: path.join(rootDir, "runs", strategy, `seed-${seed}`), scenarioDir, seed });
    const reports = [];
    for (let cycle = 0; cycle < orgCycles; cycle += 1) {
      const promptFile = await writeProviderPrompt({
        scenarioDir,
        strategy,
        seed,
        cycle: cycle + 1,
        providerId,
      });
      const context = providerTemplateContext({
        scenarioDir,
        strategy,
        seed,
        cycle: cycle + 1,
        providerId,
        promptFile,
        role: "worker",
      });
      const renderedProviderCommand = renderCommandTemplate(providerCommand, context);
      const providerCommandText = renderedProviderCommand
        ? `${providerEnvPrefix(context)} ${renderedProviderCommand}`
        : "";
      if (!providerCommandText) {
        throw new Error(`${strategy} requires --provider-command or VIBE_RESEARCH_ORG_BENCH_PROVIDER_COMMAND`);
      }
      reports.push(await runResearchAutopilot({
        projectDir: org.projectDir,
        maxSteps: 1,
        decision: cycle === 0 ? "" : "continue",
        commandText: providerCommandText,
        metricRegex: "score=([0-9.]+)",
        change: cycle === 0 ? "provider first-pass recipe update" : "provider review-informed recipe update",
        qual: cycle === 0 ? "provider completed first pass" : "provider completed review-informed pass",
        seed: String(seed),
        codeCwd: org.codeCwd,
        commandTimeoutMs: timeoutMs,
      }));
    }
    execution = {
      kind: "org-provider",
      providerId,
      reports: reports.map((report) => ({
        stopReason: report.stopReason,
        actions: summarizeAutopilotActions(report),
      })),
      projectDir: org.projectDir,
    };
  } else if (strategy === "org-provider-reviewed") {
    const org = await setupOrgProject({ rootDir: path.join(rootDir, "runs", strategy, `seed-${seed}`), scenarioDir, seed });
    const reports = [];
    const reviews = [];
    let reviewFile = "";
    const effectiveReviewerCommand = reviewerCommand || providerCommand;
    const effectiveReviewerProviderId = reviewerProviderId || providerId;
    for (let cycle = 0; cycle < orgCycles; cycle += 1) {
      const cycleIndex = cycle + 1;
      const promptFile = await writeProviderPrompt({
        scenarioDir,
        strategy,
        seed,
        cycle: cycleIndex,
        providerId,
        reviewFile,
      });
      const context = providerTemplateContext({
        scenarioDir,
        strategy,
        seed,
        cycle: cycleIndex,
        providerId,
        promptFile,
        reviewFile,
        role: "worker",
      });
      const renderedProviderCommand = renderCommandTemplate(providerCommand, context);
      const providerCommandText = renderedProviderCommand
        ? `${providerEnvPrefix(context)} ${renderedProviderCommand}`
        : "";
      if (!providerCommandText) {
        throw new Error(`${strategy} requires --provider-command or VIBE_RESEARCH_ORG_BENCH_PROVIDER_COMMAND`);
      }
      reports.push(await runResearchAutopilot({
        projectDir: org.projectDir,
        maxSteps: 1,
        decision: cycle === 0 ? "" : "continue",
        commandText: providerCommandText,
        metricRegex: "score=([0-9.]+)",
        change: cycle === 0 ? "provider first-pass recipe update" : "reviewer-steered provider recipe update",
        qual: cycle === 0 ? "provider completed first pass" : "provider used reviewer memo",
        seed: String(seed),
        codeCwd: org.codeCwd,
        commandTimeoutMs: timeoutMs,
      }));
      if (cycleIndex < orgCycles) {
        const review = await runReviewerCommand({
          commandTemplate: effectiveReviewerCommand,
          scenarioDir,
          strategy,
          seed,
          cycle: cycleIndex,
          providerId: effectiveReviewerProviderId,
          timeoutMs,
        });
        reviewFile = review.reviewFile;
        reviews.push({
          cycle: cycleIndex,
          exitCode: review.exitCode,
          timedOut: review.timedOut,
          promptFile: review.promptFile,
          reviewFile: review.reviewFile,
          providerId: review.providerId,
          wallMs: review.wallMs,
        });
      }
    }
    execution = {
      kind: "org-provider-reviewed",
      providerId,
      reviewerProviderId: effectiveReviewerProviderId,
      reviews,
      reports: reports.map((report) => ({
        stopReason: report.stopReason,
        actions: summarizeAutopilotActions(report),
      })),
      projectDir: org.projectDir,
    };
  } else {
    throw new Error(`unknown org benchmark strategy: ${strategy}`);
  }

  const evaluation = await evaluatePosttrainLiteScenario({ scenarioDir });
  return {
    strategy,
    seed,
    scenarioDir,
    wallMs: Date.now() - startedAt,
    execution,
    ...evaluation,
  };
}

function mean(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function std(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length <= 1) return 0;
  const avg = mean(nums);
  return Math.sqrt(mean(nums.map((value) => (value - avg) ** 2)));
}

function summarizeResults(results) {
  const byStrategy = new Map();
  for (const result of results) {
    const rows = byStrategy.get(result.strategy) || [];
    rows.push(result);
    byStrategy.set(result.strategy, rows);
  }
  return Array.from(byStrategy.entries()).map(([strategy, rows]) => ({
    strategy,
    runs: rows.length,
    holdoutMean: Number(mean(rows.map((row) => row.holdoutScore)).toFixed(4)),
    holdoutStd: Number(std(rows.map((row) => row.holdoutScore)).toFixed(4)),
    devMean: Number(mean(rows.map((row) => row.devScore)).toFixed(4)),
    integrityPassRate: Number(mean(rows.map((row) => row.integrityOk ? 1 : 0)).toFixed(4)),
    wallMsMean: Math.round(mean(rows.map((row) => row.wallMs))),
  }));
}

export async function runOrgBench({
  outputDir,
  suite = "posttrain-lite",
  strategies = ["baseline", "single-proxy", "org-autopilot-proxy"],
  seeds = [0, 1, 2],
  timeoutMs = 30_000,
  orgCycles = 2,
  commandText = "",
  providerCommand = process.env.VIBE_RESEARCH_ORG_BENCH_PROVIDER_COMMAND || "",
  providerId = process.env.VIBE_RESEARCH_ORG_BENCH_PROVIDER || "",
  reviewerCommand = process.env.VIBE_RESEARCH_ORG_BENCH_REVIEWER_COMMAND || "",
  reviewerProviderId = process.env.VIBE_RESEARCH_ORG_BENCH_REVIEWER || "",
} = {}) {
  if (suite !== "posttrain-lite") throw new Error(`unsupported org benchmark suite: ${suite}`);
  if (!outputDir) throw new TypeError("outputDir is required");
  const resolved = path.resolve(outputDir);
  await mkdir(resolved, { recursive: true });
  const results = [];
  for (const strategy of strategies) {
    for (const seed of seeds) {
      results.push(await runStrategy({
        rootDir: resolved,
        strategy,
        seed,
        timeoutMs,
        orgCycles,
        commandText,
        providerCommand,
        providerId,
        reviewerCommand,
        reviewerProviderId,
      }));
    }
  }
  const report = {
    suite,
    outputDir: resolved,
    generatedAt: new Date().toISOString(),
    seeds,
    strategies,
    providerId,
    reviewerProviderId,
    summary: summarizeResults(results),
    results,
  };
  await writeJson(path.join(resolved, "report.json"), report);
  return report;
}

export function formatOrgBenchReport(report) {
  const lines = [
    `Org bench: ${report.suite}`,
    `Output: ${report.outputDir}`,
    "",
    "| strategy | runs | holdout mean | holdout std | dev mean | integrity | wall ms |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of report.summary || []) {
    lines.push(`| ${row.strategy} | ${row.runs} | ${row.holdoutMean.toFixed(4)} | ${row.holdoutStd.toFixed(4)} | ${row.devMean.toFixed(4)} | ${(row.integrityPassRate * 100).toFixed(0)}% | ${row.wallMsMean} |`);
  }
  lines.push("");
  lines.push(`Full JSON: ${path.join(report.outputDir, "report.json")}`);
  return lines.join("\n");
}
