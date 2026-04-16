import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import {
  browserCommandHints,
  browserExecutableHints,
  createBrowserError,
  ensureLocalBrowserTarget,
  findCommandInPath,
  inspectBrowserRuntime,
  resolveBrowserOutputPath,
  truncateBrowserText,
} from "./browser-runtime.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const PROCESS_PROVIDER_LOOKUP_DEPTH = 6;
const DEFAULT_VIEWPORT = {
  width: 1440,
  height: 960,
};
const execFileAsync = promisify(execFile);
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.code = "USAGE";
  }
}

function usageText() {
  return [
    "rv-browser lets coding agents inspect localhost web apps with a real browser.",
    "",
    "Usage:",
    "  rv-browser doctor",
    "  rv-browser screenshot <port-or-url> [output.png] [--wait-for-selector <selector>] [--wait-for-text <text>] [--timeout <ms>] [--full-page]",
    "  rv-browser run <port-or-url> --steps <json> [--output output.png] [--timeout <ms>] [--wait-until load|domcontentloaded|networkidle] [--width <px>] [--height <px>]",
    "  rv-browser describe <port-or-url> [output.png] [--prompt <text>] [--provider auto|codex|claude]",
    "  rv-browser describe-file <image-path> [--prompt <text>] [--provider auto|codex|claude]",
    "",
    "Recommended simple `run` actions for agents:",
    "  type, click, select, wait, screenshot",
    "  Additional supported actions: press, check, uncheck, setInputFiles, goto, waitForSelector, waitForText, waitForLoadState, waitForTimeout",
    "",
    "Examples:",
    "  rv-browser screenshot 7860",
    "  rv-browser screenshot http://127.0.0.1:3000/ out.png --wait-for-text Ready",
    "  rv-browser run 7860 --steps-file eval-steps.json --output final.png",
    `  rv-browser run 7860 --steps '[{"action":"type","selector":"textarea","text":"make it cinematic"},{"action":"click","selector":"text=Generate"},{"action":"wait","text":"Done"},{"action":"screenshot","path":"result.png"}]'`,
    "  rv-browser describe 7860 --prompt \"What visual issues do you see?\"",
    "  rv-browser describe-file results/chart.png --prompt \"Critique this chart's readability.\"",
    "",
    "The target must be localhost, 127.0.0.1, ::1, 0.0.0.0, or a bare port number.",
  ].join("\n");
}

function parseNumberOption(rawValue, flagName) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${flagName} must be a positive number.`);
  }

  return value;
}

function parseFlags(argv) {
  const flags = {
    headless: true,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const [rawFlagName, inlineValue] = argument.split("=", 2);
    const consumeValue = () => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }

      index += 1;
      if (index >= argv.length) {
        throw new UsageError(`${rawFlagName} requires a value.`);
      }

      return argv[index];
    };

    switch (rawFlagName) {
      case "--help":
        flags.help = true;
        break;
      case "--steps":
        flags.steps = consumeValue();
        break;
      case "--steps-file":
        flags.stepsFile = consumeValue();
        break;
      case "--output":
        flags.output = consumeValue();
        break;
      case "--prompt":
        flags.prompt = consumeValue();
        break;
      case "--provider":
        flags.provider = consumeValue();
        break;
      case "--timeout":
        flags.timeoutMs = parseNumberOption(consumeValue(), "--timeout");
        break;
      case "--wait-until":
        flags.waitUntil = consumeValue();
        break;
      case "--wait-for-selector":
        flags.waitForSelector = consumeValue();
        break;
      case "--wait-for-text":
        flags.waitForText = consumeValue();
        break;
      case "--width":
        flags.width = parseNumberOption(consumeValue(), "--width");
        break;
      case "--height":
        flags.height = parseNumberOption(consumeValue(), "--height");
        break;
      case "--full-page":
        flags.fullPage = true;
        break;
      case "--headful":
        flags.headless = false;
        break;
      default:
        throw new UsageError(`Unknown flag: ${rawFlagName}`);
    }
  }

  return {
    flags,
    positionals,
  };
}

function normalizeActionName(action) {
  const normalized = String(action ?? "")
    .trim()
    .replaceAll(/[-_]/g, "")
    .toLowerCase();

  switch (normalized) {
    case "goto":
      return "goto";
    case "click":
      return "click";
    case "fill":
    case "type":
      return "fill";
    case "press":
      return "press";
    case "check":
      return "check";
    case "uncheck":
      return "uncheck";
    case "select":
    case "selectoption":
      return "select";
    case "setinputfiles":
    case "upload":
      return "setInputFiles";
    case "waitfor":
    case "wait":
    case "waitforselector":
    case "waitforvisible":
      return "waitForSelector";
    case "waitfortext":
      return "waitForText";
    case "waitforloadstate":
      return "waitForLoadState";
    case "waitfortimeout":
    case "sleep":
      return "waitForTimeout";
    case "screenshot":
      return "screenshot";
    default:
      throw new UsageError(`Unsupported step action: ${action}`);
  }
}

function getStepTimeout(step, defaultTimeoutMs) {
  if (step.timeoutMs === undefined) {
    return defaultTimeoutMs;
  }

  return parseNumberOption(step.timeoutMs, "step.timeoutMs");
}

async function loadSteps(flags, cwd) {
  let source = null;

  if (flags.steps !== undefined) {
    source = flags.steps;
  } else if (flags.stepsFile !== undefined) {
    source = await readFile(path.resolve(cwd, flags.stepsFile), "utf8");
  } else {
    throw new UsageError("The run command requires --steps or --steps-file.");
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new UsageError("Could not parse browser steps JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new UsageError("Browser steps must be a JSON array.");
  }

  return parsed;
}

async function getPageSummary(page) {
  const [title, text] = await Promise.all([
    page.title().catch(() => ""),
    page
      .evaluate(() => document.body?.innerText || "")
      .catch(() => ""),
  ]);

  return {
    url: page.url(),
    title,
    text: truncateBrowserText(text),
  };
}

async function performAction(page, step, cwd, env, defaultTimeoutMs) {
  const action = normalizeActionName(step.action);
  const timeout = getStepTimeout(step, defaultTimeoutMs);

  switch (action) {
    case "goto": {
      const target = ensureLocalBrowserTarget(step.target ?? step.url);
      await page.goto(target, {
        waitUntil: step.waitUntil || "load",
        timeout,
      });
      return { action, target };
    }

    case "click": {
      if (!step.selector) {
        throw new UsageError("click steps require a selector.");
      }

      await page.locator(step.selector).click({
        timeout,
      });
      return {
        action,
        selector: step.selector,
      };
    }

    case "fill": {
      if (!step.selector) {
        throw new UsageError("type/fill steps require a selector.");
      }

      const nextValue = step.text ?? step.value ?? "";
      await page.locator(step.selector).fill(String(nextValue), {
        timeout,
      });
      return {
        action,
        selector: step.selector,
        value: String(nextValue),
      };
    }

    case "press": {
      if (!step.key) {
        throw new UsageError("press steps require a key.");
      }

      if (step.selector) {
        await page.locator(step.selector).press(String(step.key), { timeout });
      } else {
        await page.keyboard.press(String(step.key));
      }

      return {
        action,
        key: String(step.key),
        selector: step.selector || null,
      };
    }

    case "check": {
      if (!step.selector) {
        throw new UsageError("check steps require a selector.");
      }

      await page.locator(step.selector).check({ timeout });
      return { action, selector: step.selector };
    }

    case "uncheck": {
      if (!step.selector) {
        throw new UsageError("uncheck steps require a selector.");
      }

      await page.locator(step.selector).uncheck({ timeout });
      return { action, selector: step.selector };
    }

    case "select": {
      if (!step.selector) {
        throw new UsageError("select steps require a selector.");
      }

      const option = step.option ?? step.value;
      if (option === undefined || option === null || option === "") {
        throw new UsageError("select steps require an option or value.");
      }

      await page.locator(step.selector).selectOption(option);
      return {
        action,
        selector: step.selector,
        value: option,
      };
    }

    case "setInputFiles": {
      if (!step.selector) {
        throw new UsageError("setInputFiles steps require a selector.");
      }

      const rawPaths = step.paths ?? step.files ?? step.path;
      const fileList = Array.isArray(rawPaths) ? rawPaths : [rawPaths];
      if (!fileList[0]) {
        throw new UsageError("setInputFiles steps require at least one file path.");
      }

      const resolvedPaths = fileList.map((entry) => path.resolve(cwd, String(entry)));

      await page.locator(step.selector).setInputFiles(resolvedPaths, {
        timeout,
      });
      return {
        action,
        selector: step.selector,
        files: resolvedPaths,
      };
    }

    case "waitForSelector": {
      if (!step.selector && step.text) {
        await page
          .getByText(String(step.text), {
            exact: step.exact === true,
          })
          .first()
          .waitFor({
            state: "visible",
            timeout,
          });
        return {
          action: step.action === "wait" ? "wait" : "waitForText",
          text: String(step.text),
        };
      }

      if (!step.selector && (step.ms !== undefined || step.timeoutMs !== undefined)) {
        const delayMs = parseNumberOption(step.ms ?? step.timeoutMs ?? 250, "step.ms");
        await page.waitForTimeout(delayMs);
        return {
          action: step.action === "wait" ? "wait" : "waitForTimeout",
          delayMs,
        };
      }

      if (!step.selector && step.state) {
        await page.waitForLoadState(step.state, {
          timeout,
        });
        return {
          action: step.action === "wait" ? "wait" : "waitForLoadState",
          state: step.state,
        };
      }

      if (!step.selector) {
        throw new UsageError(
          "wait steps require a selector, text, state, or ms timeout.",
        );
      }

      await page.locator(step.selector).waitFor({
        state: step.state || "visible",
        timeout,
      });
      return {
        action: step.action === "wait" ? "wait" : action,
        selector: step.selector,
        state: step.state || "visible",
      };
    }

    case "waitForText": {
      if (!step.text) {
        throw new UsageError("waitForText steps require text.");
      }

      await page
        .getByText(String(step.text), {
          exact: step.exact === true,
        })
        .first()
        .waitFor({
          state: "visible",
          timeout,
        });
      return {
        action,
        text: String(step.text),
      };
    }

    case "waitForLoadState": {
      await page.waitForLoadState(step.state || "networkidle", {
        timeout,
      });
      return {
        action,
        state: step.state || "networkidle",
      };
    }

    case "waitForTimeout": {
      const delayMs = parseNumberOption(step.ms ?? step.timeoutMs ?? 250, "step.ms");
      await page.waitForTimeout(delayMs);
      return {
        action,
        delayMs,
      };
    }

    case "screenshot": {
      const outputPath = await resolveBrowserOutputPath(step.path, {
        cwd,
        env,
        prefix: "step-shot",
      });

      if (step.selector) {
        await page.locator(step.selector).screenshot({
          path: outputPath,
          timeout,
        });
      } else {
        await page.screenshot({
          path: outputPath,
          fullPage: step.fullPage === true,
          timeout,
        });
      }

      return {
        action,
        path: outputPath,
        selector: step.selector || null,
      };
    }

    default:
      throw new UsageError(`Unsupported step action: ${step.action}`);
  }
}

async function executeSteps(page, steps, cwd, env, defaultTimeoutMs) {
  const results = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step || typeof step !== "object") {
      throw new UsageError(`Step ${index + 1} must be an object.`);
    }

    const result = await performAction(page, step, cwd, env, defaultTimeoutMs);
    results.push({
      index,
      ...result,
    });
  }

  return results;
}

async function withBrowserSession(flags, env, callback) {
  const browserRuntime = await inspectBrowserRuntime({ env });

  if (!browserRuntime.available || !browserRuntime.executablePath) {
    throw createBrowserError(
      "BROWSER_NOT_FOUND",
      [
        "rv-browser could not find a Chrome/Chromium-style browser executable.",
        "Set REMOTE_VIBES_BROWSER_EXECUTABLE_PATH to your browser binary if needed.",
        `Looked for PATH commands: ${browserCommandHints.join(", ")}`,
        `and app bundles such as: ${browserExecutableHints.slice(0, 5).join(", ")}`,
      ].join(" "),
    );
  }

  const browser = await chromium.launch({
    executablePath: browserRuntime.executablePath,
    headless: flags.headless !== false,
  });

  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: {
        width: flags.width || DEFAULT_VIEWPORT.width,
        height: flags.height || DEFAULT_VIEWPORT.height,
      },
    });

    const page = await context.newPage();
    const result = await callback({
      browser,
      browserRuntime,
      context,
      page,
    });

    await context.close();
    return result;
  } finally {
    await browser.close();
  }
}

function writeJson(stream, payload) {
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function getRequestedVisionProvider(flags) {
  const requestedProvider = String(flags.provider || "auto").trim().toLowerCase();
  if (!["auto", "codex", "claude"].includes(requestedProvider)) {
    throw new UsageError("--provider must be one of auto, codex, or claude.");
  }

  return requestedProvider;
}

export function inferVisionProviderFromCommandText(commandText) {
  const executable = path.basename(String(commandText || "").trim().split(/\s+/, 1)[0] || "").toLowerCase();

  if (executable === "claude") {
    return "claude";
  }

  if (executable === "codex") {
    return "codex";
  }

  return null;
}

async function inferVisionProviderFromProcessTree(startPid = process.ppid) {
  let nextPid = Number(startPid);

  for (let depth = 0; depth < PROCESS_PROVIDER_LOOKUP_DEPTH; depth += 1) {
    if (!Number.isInteger(nextPid) || nextPid <= 1) {
      return null;
    }

    try {
      const { stdout } = await execFileAsync("ps", [
        "-o",
        "ppid=",
        "-o",
        "command=",
        "-p",
        String(nextPid),
      ]);
      const line = stdout.trim();
      if (!line) {
        return null;
      }

      const match = line.match(/^(\d+)\s+([\s\S]+)$/);
      if (!match) {
        return null;
      }

      const provider = inferVisionProviderFromCommandText(match[2]);
      if (provider) {
        return provider;
      }

      nextPid = Number(match[1]);
    } catch {
      return null;
    }
  }

  return null;
}

async function resolveVisionProvider({ requestedProvider = "auto", env }) {
  const providerCandidates = {
    codex:
      env.REMOTE_VIBES_REAL_CODEX_COMMAND ||
      (await findCommandInPath("codex", env.PATH || process.env.PATH || "")),
    claude:
      env.REMOTE_VIBES_REAL_CLAUDE_COMMAND ||
      (await findCommandInPath("claude", env.PATH || process.env.PATH || "")),
  };

  if (requestedProvider !== "auto") {
    const command = providerCandidates[requestedProvider];
    if (!command) {
      throw createBrowserError(
        "VISION_PROVIDER_NOT_FOUND",
        `rv-browser could not find the requested ${requestedProvider} command.`,
      );
    }

    return {
      id: requestedProvider,
      command,
    };
  }

  const preferredFromSession = String(env.REMOTE_VIBES_PROVIDER || "").trim().toLowerCase();
  if (preferredFromSession === "codex" && providerCandidates.codex) {
    return { id: "codex", command: providerCandidates.codex };
  }

  if (preferredFromSession === "claude" && providerCandidates.claude) {
    return { id: "claude", command: providerCandidates.claude };
  }

  const preferredFromProcess = await inferVisionProviderFromProcessTree();
  if (preferredFromProcess === "claude" && providerCandidates.claude) {
    return { id: "claude", command: providerCandidates.claude };
  }

  if (preferredFromProcess === "codex" && providerCandidates.codex) {
    return { id: "codex", command: providerCandidates.codex };
  }

  if (providerCandidates.codex) {
    return { id: "codex", command: providerCandidates.codex };
  }

  if (providerCandidates.claude) {
    return { id: "claude", command: providerCandidates.claude };
  }

  throw createBrowserError(
    "VISION_PROVIDER_NOT_FOUND",
    "rv-browser could not find a Codex or Claude CLI for visual description.",
  );
}

async function spawnCommandWithStdin(command, args, input, { cwd, env }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }

      const error = createBrowserError(
        "VISION_COMMAND_FAILED",
        `${path.basename(command)} exited with code ${code}.`,
      );
      error.stdout = stdout;
      error.stderr = stderr;
      error.exitCode = code;
      reject(error);
    });

    child.stdin.end(input);
  });
}

async function describeImageWithProvider(imagePath, flags, cwd, env) {
  const requestedProvider = getRequestedVisionProvider(flags);
  const provider = await resolveVisionProvider({
    requestedProvider,
    env,
  });
  const prompt =
    String(flags.prompt || "").trim() ||
    "Describe what is visible in this image and call out any obvious visual issues or strengths.";

  if (provider.id === "codex") {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "rv-browser-codex-"));
    const outputFile = path.join(tempDir, "last-message.txt");

    try {
      await spawnCommandWithStdin(
        provider.command,
        [
          "exec",
          "--skip-git-repo-check",
          "--cd",
          cwd,
          "--dangerously-bypass-approvals-and-sandbox",
          "--output-last-message",
          outputFile,
          "-i",
          imagePath,
          "-",
        ],
        `${prompt}\n`,
        { cwd, env },
      );

      const analysis = (await readFile(outputFile, "utf8")).trim();
      return {
        provider: provider.id,
        analysis,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  if (provider.id === "claude") {
    const { stdout } = await spawnCommandWithStdin(
      provider.command,
      [
        "-p",
        "--permission-mode",
        "bypassPermissions",
        "--add-dir",
        path.dirname(imagePath),
      ],
      `${prompt}\nImage path: ${imagePath}\n`,
      { cwd, env },
    );

    return {
      provider: provider.id,
      analysis: stdout.trim(),
    };
  }

  throw createBrowserError(
    "VISION_PROVIDER_NOT_SUPPORTED",
    `Unsupported vision provider: ${provider.id}`,
  );
}

async function runDoctor(stdout, env) {
  const browserRuntime = await inspectBrowserRuntime({ env });
  writeJson(stdout, {
    ok: browserRuntime.available,
    command: "doctor",
    browser: browserRuntime,
  });

  return browserRuntime.available ? 0 : 1;
}

async function runScreenshot(positionals, flags, cwd, env, stdout) {
  if (!positionals[1]) {
    throw new UsageError("screenshot requires a localhost URL or port.");
  }

  const target = ensureLocalBrowserTarget(positionals[1]);
  const requestedOutputPath = positionals[2] || flags.output;
  const defaultTimeoutMs = flags.timeoutMs || DEFAULT_TIMEOUT_MS;

  return withBrowserSession(flags, env, async ({ browserRuntime, page }) => {
    await page.goto(target, {
      waitUntil: flags.waitUntil || "load",
      timeout: defaultTimeoutMs,
    });

    if (flags.waitForSelector) {
      await page.locator(flags.waitForSelector).waitFor({
        state: "visible",
        timeout: defaultTimeoutMs,
      });
    }

    if (flags.waitForText) {
      await page.getByText(flags.waitForText).first().waitFor({
        state: "visible",
        timeout: defaultTimeoutMs,
      });
    }

    const outputPath = await resolveBrowserOutputPath(requestedOutputPath, {
      cwd,
      env,
      prefix: "capture",
    });

    await page.screenshot({
      path: outputPath,
      fullPage: flags.fullPage === true,
      timeout: defaultTimeoutMs,
    });

    writeJson(stdout, {
      ok: true,
      command: "screenshot",
      browser: browserRuntime,
      target,
      outputPath,
      ...(await getPageSummary(page)),
    });

    return 0;
  });
}

async function runPlan(positionals, flags, cwd, env, stdout) {
  if (!positionals[1]) {
    throw new UsageError("run requires a localhost URL or port.");
  }

  const target = ensureLocalBrowserTarget(positionals[1]);
  const steps = await loadSteps(flags, cwd);
  const defaultTimeoutMs = flags.timeoutMs || DEFAULT_TIMEOUT_MS;

  return withBrowserSession(flags, env, async ({ browserRuntime, page }) => {
    await page.goto(target, {
      waitUntil: flags.waitUntil || "load",
      timeout: defaultTimeoutMs,
    });

    const stepResults = await executeSteps(page, steps, cwd, env, defaultTimeoutMs);
    const outputPath = flags.output
      ? await resolveBrowserOutputPath(flags.output, {
          cwd,
          env,
          prefix: "run",
        })
      : null;

    if (outputPath) {
      await page.screenshot({
        path: outputPath,
        timeout: defaultTimeoutMs,
      });
    }

    writeJson(stdout, {
      ok: true,
      command: "run",
      browser: browserRuntime,
      target,
      outputPath,
      stepResults,
      ...(await getPageSummary(page)),
    });

    return 0;
  });
}

async function runDescribe(positionals, flags, cwd, env, stdout) {
  if (!positionals[1]) {
    throw new UsageError("describe requires a localhost URL or port.");
  }

  const target = ensureLocalBrowserTarget(positionals[1]);
  const requestedOutputPath = positionals[2] || flags.output;
  const defaultTimeoutMs = flags.timeoutMs || DEFAULT_TIMEOUT_MS;

  return withBrowserSession(flags, env, async ({ browserRuntime, page }) => {
    await page.goto(target, {
      waitUntil: flags.waitUntil || "load",
      timeout: defaultTimeoutMs,
    });

    if (flags.waitForSelector) {
      await page.locator(flags.waitForSelector).waitFor({
        state: "visible",
        timeout: defaultTimeoutMs,
      });
    }

    if (flags.waitForText) {
      await page.getByText(flags.waitForText).first().waitFor({
        state: "visible",
        timeout: defaultTimeoutMs,
      });
    }

    const outputPath = await resolveBrowserOutputPath(requestedOutputPath, {
      cwd,
      env,
      prefix: "describe",
    });

    await page.screenshot({
      path: outputPath,
      fullPage: flags.fullPage === true,
      timeout: defaultTimeoutMs,
    });

    const description = await describeImageWithProvider(outputPath, flags, cwd, env);

    writeJson(stdout, {
      ok: true,
      command: "describe",
      browser: browserRuntime,
      target,
      outputPath,
      visionProvider: description.provider,
      analysis: description.analysis,
      ...(await getPageSummary(page)),
    });

    return 0;
  });
}

async function runDescribeFile(positionals, flags, cwd, env, stdout) {
  if (!positionals[1]) {
    throw new UsageError("describe-file requires a local image path.");
  }

  const imagePath = path.resolve(cwd, positionals[1]);
  const description = await describeImageWithProvider(imagePath, flags, cwd, env);

  writeJson(stdout, {
    ok: true,
    command: "describe-file",
    imagePath,
    visionProvider: description.provider,
    analysis: description.analysis,
  });

  return 0;
}

export async function runBrowserCli(
  argv,
  {
    cwd = process.cwd(),
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  try {
    const { flags, positionals } = parseFlags(argv);
    const command = positionals[0] || (flags.help ? "help" : "");

    if (flags.help || !command || command === "help") {
      stdout.write(`${usageText()}\n`);
      return 0;
    }

    if (command === "doctor") {
      return await runDoctor(stdout, env);
    }

    if (command === "screenshot") {
      return await runScreenshot(positionals, flags, cwd, env, stdout);
    }

    if (command === "run") {
      return await runPlan(positionals, flags, cwd, env, stdout);
    }

    if (command === "describe") {
      return await runDescribe(positionals, flags, cwd, env, stdout);
    }

    if (command === "describe-file") {
      return await runDescribeFile(positionals, flags, cwd, env, stdout);
    }

    throw new UsageError(`Unknown command: ${command}`);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n\n${usageText()}\n`);
      return 1;
    }

    writeJson(stderr, {
      ok: false,
      error: {
        code: error.code || "BROWSER_COMMAND_FAILED",
        message: error.message || String(error),
      },
    });
    return 1;
  }
}
