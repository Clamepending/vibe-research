import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { WebSocket } from "ws";
import { createRemoteVibesApp } from "../src/create-app.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function parseArgs(argv) {
  const flags = {
    cleanup: false,
    provider: "codex",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--cleanup") {
      flags.cleanup = true;
      continue;
    }

    if (argument === "--timeout-ms") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("--timeout-ms requires a value.");
      }

      const timeoutMs = Number(argv[index]);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive number.");
      }
      flags.timeoutMs = timeoutMs;
      continue;
    }

    if (argument === "--provider") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("--provider requires a value.");
      }

      const provider = String(argv[index]).trim().toLowerCase();
      if (!["codex", "claude"].includes(provider)) {
        throw new Error("--provider must be codex or claude.");
      }
      flags.provider = provider;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return flags;
}

async function waitForFile(filePath, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await stat(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForCliLogPattern(filePath, pattern, timeoutMs = 15_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const content = await readFile(filePath, "utf8");
      if (pattern.test(content)) {
        return true;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

function buildVisionProviderPattern(provider) {
  return new RegExp(
    String.raw`(?:\\")?visionProvider(?:\\")?\s*:\s*(?:\\")?${provider}(?:\\")?`,
  );
}

async function startDemoServer() {
  const server = http.createServer((request, response) => {
    if (request.url !== "/") {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Agent Eval Lab</title>
    <style>
      body { font-family: sans-serif; padding: 24px; }
      textarea { width: 100%; min-height: 100px; }
      .stack { display: grid; gap: 12px; max-width: 680px; }
      #result, #status { padding: 12px; border: 1px solid #d0d7de; }
    </style>
  </head>
  <body>
    <div class="stack">
      <h1>Localhost Agent Eval</h1>
      <label>
        Prompt
        <textarea id="prompt"></textarea>
      </label>
      <label>
        Mode
        <select id="mode">
          <option value="fast">fast</option>
          <option value="qa">qa</option>
        </select>
      </label>
      <button id="generate" type="button">Generate</button>
      <div id="status">idle</div>
      <div id="result">Generated: none</div>
    </div>
    <script>
      const prompt = document.querySelector("#prompt");
      const mode = document.querySelector("#mode");
      const status = document.querySelector("#status");
      const result = document.querySelector("#result");
      const generate = document.querySelector("#generate");

      generate.addEventListener("click", () => {
        status.textContent = "running";
        result.textContent = "Generated: pending";

        window.setTimeout(() => {
          const promptValue = prompt.value.trim() || "empty";
          const modeValue = mode.value;
          status.textContent = "ready";
          result.textContent = "Generated (" + modeValue + ", pending): " + promptValue;
        }, 180);
      });
    </script>
  </body>
</html>`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function assertProviderAvailable(provider) {
  const providerPathHints = {
    codex: ["/Applications/Codex.app/Contents/Resources/codex"],
    claude: ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
  };

  for (const candidate of providerPathHints[provider] || []) {
    try {
      await access(candidate, fsConstants.X_OK);
      return;
    } catch {
      // Try the next hint.
    }
  }

  throw new Error(`${provider} CLI is not installed at a known path.`);
}

async function waitForSnapshot(websocket, timeoutMs) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for the initial shell snapshot."));
    }, timeoutMs);

    websocket.on("message", (chunk) => {
      const payload = JSON.parse(String(chunk));

      if (payload.type === "snapshot") {
        clearTimeout(timeout);
        resolve();
      }
    });

    websocket.on("error", reject);
  });
}

function buildPrompt(demoPort, provider) {
  return [
    `A test UI is running at http://127.0.0.1:${demoPort}.`,
    "Use ONLY rv-browser for browser work. Do not use curl, open, osascript, Chrome, Playwright, or HTML inspection.",
    "Create eval/steps.json with a JSON array that uses only these rv-browser run actions: type, click, select, wait, screenshot.",
    "Use rv-browser run with that steps file to do this exact flow:",
    '- type "session eval prompt" into the prompt textarea',
    '- select mode "qa"',
    "- click Generate",
    '- wait until the page shows "Generated (qa, pending): session eval prompt"',
    "- save a screenshot to eval/final.png",
    `Then run rv-browser describe-file eval/final.png --provider ${provider} --prompt "Briefly say whether the UI interaction succeeded and what is visible."`,
    "Write eval/report.md with these exact headings:",
    "Used rv-browser:",
    "Used step actions:",
    "Result text:",
    "Visual summary:",
    "Exact command:",
    "Only write files under eval/.",
  ].join("\n");
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  await assertProviderAvailable(flags.provider);

  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-live-codex-"));
  const evalDir = path.join(workspaceDir, "eval");
  await mkdir(evalDir, { recursive: true });

  const promptPath = path.join(evalDir, "prompt.txt");
  const reportPath = path.join(evalDir, "report.md");
  const stepsPath = path.join(evalDir, "steps.json");
  const screenshotPath = path.join(evalDir, "final.png");
  const cliLogPath = path.join(evalDir, "codex-cli.txt");

  const demoServer = await startDemoServer();
  const demoPort = demoServer.address().port;
  const remoteVibes = await createRemoteVibesApp({
    host: "127.0.0.1",
    port: 0,
    cwd: workspaceDir,
    stateDir: path.join(workspaceDir, ".remote-vibes"),
    persistSessions: false,
  });
  const baseUrl = `http://127.0.0.1:${remoteVibes.config.port}`;

  await writeFile(promptPath, `${buildPrompt(demoPort, flags.provider)}\n`, "utf8");

  let shouldCleanup = flags.cleanup;

  try {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Live Codex Eval",
        cwd: workspaceDir,
      }),
    });

    if (createResponse.status !== 201) {
      throw new Error(`Could not create shell session: ${createResponse.status} ${await createResponse.text()}`);
    }

    const { session } = await createResponse.json();
    const websocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?sessionId=${session.id}`);
    await waitForSnapshot(websocket, flags.timeoutMs);

    websocket.send(
      JSON.stringify({
        type: "resize",
        cols: 140,
        rows: 40,
      }),
    );
    websocket.send(
      JSON.stringify({
        type: "input",
        data:
          [
            `cd ${shellQuote(workspaceDir)}`,
            flags.provider === "codex"
              ? `codex exec --dangerously-bypass-approvals-and-sandbox -C . "$(cat ${shellQuote(path.relative(workspaceDir, promptPath))})" > ${shellQuote(path.relative(workspaceDir, cliLogPath))} 2>&1`
              : `claude -p --verbose --output-format stream-json --dangerously-skip-permissions "$(cat ${shellQuote(path.relative(workspaceDir, promptPath))})" > ${shellQuote(path.relative(workspaceDir, cliLogPath))} 2>&1`,
          ].join("; ") + "\r",
      }),
    );

    await Promise.all([
      waitForFile(stepsPath, flags.timeoutMs),
      waitForFile(screenshotPath, flags.timeoutMs),
      waitForFile(reportPath, flags.timeoutMs),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    websocket.close();
    await Promise.race([
      once(websocket, "close"),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);

    const cliLog = await readFile(cliLogPath, "utf8");

    const [report, stepsRaw, screenshotStats] = await Promise.all([
      readFile(reportPath, "utf8"),
      readFile(stepsPath, "utf8"),
      stat(screenshotPath),
    ]);
    const steps = JSON.parse(stepsRaw);

    const summary = {
      ok: true,
      workspaceDir,
      demoPort,
      provider: flags.provider,
      screenshotBytes: screenshotStats.size,
      cliLogHasRvBrowser: /rv-browser/.test(cliLog),
      visionProviderMatchesAgent: await waitForCliLogPattern(
        cliLogPath,
        buildVisionProviderPattern(flags.provider),
      ),
      steps,
      report,
    };

    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    shouldCleanup = false;
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    await remoteVibes.close();
    await new Promise((resolve) => demoServer.close(resolve));

    if (shouldCleanup) {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }
}

await main();
