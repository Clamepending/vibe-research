import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { createVibeResearchApp } from "../src/create-app.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

const execFile = promisify(execFileCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const browserHelperPath = path.join(rootDir, "bin", "vr-browser");
const playwrightHelperPath = path.join(rootDir, "bin", "vr-playwright");
const browserTestEnv = {
  ...process.env,
  PATH: ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].filter(Boolean).join(path.delimiter),
};
const PNG_FIXTURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92,
  0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function parseJsonPayload(text) {
  const rawText = String(text ?? "");
  const jsonStart = rawText.indexOf("{");
  if (jsonStart < 0) {
    throw new Error(`No JSON payload found in:\n${rawText}`);
  }

  return JSON.parse(rawText.slice(jsonStart));
}

async function waitForFile(filePath, timeoutMs = 20_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await stat(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}

async function createFakeVisionProvider(workspaceDir, providerId) {
  const scriptPath = path.join(workspaceDir, `${providerId}-provider.sh`);

  if (providerId === "codex") {
    await writeFile(
      scriptPath,
      `#!/usr/bin/env bash
set -euo pipefail
output_file=""
image_path=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-last-message)
      output_file="$2"
      shift 2
      ;;
    -i)
      image_path="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
cat >/dev/null
printf 'codex saw %s\\n' "$(basename "$image_path")" > "$output_file"
`,
      "utf8",
    );
  } else {
    await writeFile(
      scriptPath,
      `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
printf 'claude analyzed local image successfully\\n'
`,
      "utf8",
    );
  }

  await chmod(scriptPath, 0o755);
  return scriptPath;
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
    <title>Model Lab</title>
    <style>
      body { font-family: sans-serif; padding: 24px; }
      textarea { width: 100%; min-height: 100px; }
      .stack { display: grid; gap: 12px; max-width: 680px; }
      #result, #upload-result, #status { padding: 12px; border: 1px solid #d0d7de; }
    </style>
  </head>
  <body>
    <div class="stack">
      <h1>Localhost Eval Harness</h1>
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
      <label>
        <input id="accept" type="checkbox" />
        Approve result
      </label>
      <label>
        Upload
        <input id="upload" type="file" />
      </label>
      <div id="upload-result">Uploaded: none</div>
      <button id="generate" type="button">Generate</button>
      <div id="status">idle</div>
      <div id="result">Generated: none</div>
    </div>
    <script>
      const prompt = document.querySelector("#prompt");
      const mode = document.querySelector("#mode");
      const accept = document.querySelector("#accept");
      const upload = document.querySelector("#upload");
      const uploadResult = document.querySelector("#upload-result");
      const status = document.querySelector("#status");
      const result = document.querySelector("#result");
      const generate = document.querySelector("#generate");

      upload.addEventListener("change", () => {
        const [file] = upload.files;
        uploadResult.textContent = file ? "Uploaded: " + file.name : "Uploaded: none";
      });

      generate.addEventListener("click", () => {
        status.textContent = "running";
        result.textContent = "Generated: pending";

        window.setTimeout(() => {
          const promptValue = prompt.value.trim() || "empty";
          const modeValue = mode.value;
          const approvalValue = accept.checked ? "approved" : "pending";
          status.textContent = "ready";
          result.textContent = "Generated (" + modeValue + ", " + approvalValue + "): " + promptValue;
        }, 180);
      });
    </script>
  </body>
</html>`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function startVibeResearch(options = {}) {
  const appCwd = options.cwd ?? process.cwd();
  const app = await createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd: appCwd,
    stateDir: options.stateDir ?? path.join(appCwd, ".vibe-research"),
    persistSessions: false,
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({
        enabled: settings.preventSleepEnabled,
        platform: "test",
      }),
    ...options,
  });

  return {
    app,
    baseUrl: `http://127.0.0.1:${app.config.port}`,
  };
}

test("vr-browser doctor resolves a usable local browser", async () => {
  const result = await execFile(browserHelperPath, ["doctor"], {
    cwd: rootDir,
    env: browserTestEnv,
  });
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.ok, true);
  assert.equal(payload.command, "doctor");
  assert.equal(typeof payload.browser.executablePath, "string");
  assert.ok(payload.browser.executablePath.length > 0);
});

test("vr-browser doctor ignores detour wrappers when repo bin is first on PATH", async () => {
  const result = await execFile(browserHelperPath, ["doctor"], {
    cwd: rootDir,
    env: {
      ...browserTestEnv,
      PATH: [path.join(rootDir, "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH]
        .filter(Boolean)
        .join(path.delimiter),
    },
  });
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.ok, true);
  assert.notEqual(payload.browser.executablePath, path.join(rootDir, "bin", "google-chrome"));
});

test("vr-playwright wraps playwright-cli through npx with per-session isolation", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-playwright-wrapper-"));

  try {
    const fakeBinDir = await mkdtemp(path.join(workspaceDir, "bin-"));
    const fakeNpxPath = path.join(fakeBinDir, "npx");
    const capturedArgsPath = path.join(workspaceDir, "npx-args.txt");

    await writeFile(
      fakeNpxPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$CAPTURED_ARGS_PATH"
printf 'fake playwright cli\\n'
`,
      "utf8",
    );
    await chmod(fakeNpxPath, 0o755);

    const result = await execFile(playwrightHelperPath, ["snapshot"], {
      cwd: workspaceDir,
      env: {
        ...browserTestEnv,
        CAPTURED_ARGS_PATH: capturedArgsPath,
        PATH: [fakeBinDir, "/usr/bin", "/bin"].join(path.delimiter),
        VIBE_RESEARCH_SESSION_ID: "session:abc",
      },
    });
    const capturedArgs = (await readFile(capturedArgsPath, "utf8")).trim().split("\n");

    assert.match(result.stdout, /fake playwright cli/);
    assert.deepEqual(capturedArgs, [
      "--yes",
      "--package",
      "@playwright/cli",
      "playwright-cli",
      "-s=vr-476412420-sessio",
      "snapshot",
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("vr-browser run can drive a localhost app, upload files, and save screenshots", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-browser-"));
  const demoServer = await startDemoServer();
  const demoPort = demoServer.address().port;

  try {
    const uploadFilePath = path.join(workspaceDir, "sample.txt");
    const stepsFilePath = path.join(workspaceDir, "steps.json");
    const finalShotPath = path.join(workspaceDir, "artifacts", "final.png");
    const stepShotPath = path.join(workspaceDir, "artifacts", "step.png");

    await writeFile(uploadFilePath, "sample artifact\n", "utf8");
    await writeFile(
      stepsFilePath,
      `${JSON.stringify(
        [
          { action: "type", selector: "#prompt", text: "a cinematic fox" },
          { action: "select", selector: "#mode", option: "qa" },
          { action: "check", selector: "#accept" },
          { action: "setInputFiles", selector: "#upload", path: "sample.txt" },
          { action: "wait", text: "Uploaded: sample.txt" },
          { action: "click", selector: "#generate" },
          { action: "wait", text: "Generated (qa, approved): a cinematic fox" },
          { action: "screenshot", path: "artifacts/step.png", fullPage: true },
        ],
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await execFile(
      browserHelperPath,
      ["run", String(demoPort), "--steps-file", path.basename(stepsFilePath), "--output", "artifacts/final.png"],
      {
        cwd: workspaceDir,
        env: browserTestEnv,
      },
    );
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.command, "run");
    assert.match(payload.title, /Model Lab/);
    assert.match(payload.text, /Uploaded: sample\.txt/);
    assert.match(payload.text, /Generated \(qa, approved\): a cinematic fox/);
    assert.equal(await realpath(payload.outputPath), await realpath(finalShotPath));
    assert.equal(await realpath(payload.stepResults.at(-1).path), await realpath(stepShotPath));
    assert.ok((await stat(finalShotPath)).size > 0);
    assert.ok((await stat(stepShotPath)).size > 0);
  } finally {
    await new Promise((resolve) => demoServer.close(resolve));
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("vr-browser rejects non-local targets", async () => {
  await assert.rejects(
    execFile(browserHelperPath, ["screenshot", "https://example.com"], {
      cwd: rootDir,
      env: browserTestEnv,
    }),
    (error) => {
      const payload = parseJsonPayload(error.stderr);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, "TARGET_NOT_LOCAL");
      return true;
    },
  );
});

test("vr-browser describe can capture a localhost page and pass it through a codex-style vision provider", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-describe-"));
  const demoServer = await startDemoServer();
  const demoPort = demoServer.address().port;

  try {
    const fakeCodexPath = await createFakeVisionProvider(workspaceDir, "codex");
    const screenshotPath = path.join(workspaceDir, "described.png");
    const result = await execFile(
      browserHelperPath,
      [
        "describe",
        String(demoPort),
        screenshotPath,
        "--provider",
        "codex",
        "--prompt",
        "Describe the page briefly.",
      ],
      {
        cwd: workspaceDir,
        env: {
          ...browserTestEnv,
          VIBE_RESEARCH_REAL_CODEX_COMMAND: fakeCodexPath,
        },
      },
    );
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.command, "describe");
    assert.equal(payload.visionProvider, "codex");
    assert.match(payload.analysis, /codex saw described\.png/);
    assert.ok((await stat(screenshotPath)).size > 0);
  } finally {
    await new Promise((resolve) => demoServer.close(resolve));
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("vr-browser describe-file can use a claude-style vision provider", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-describe-file-"));

  try {
    const imagePath = path.join(workspaceDir, "fixture.png");
    const fakeClaudePath = await createFakeVisionProvider(workspaceDir, "claude");
    await writeFile(imagePath, PNG_FIXTURE);

    const result = await execFile(
      browserHelperPath,
      [
        "describe-file",
        path.basename(imagePath),
        "--provider",
        "claude",
        "--prompt",
        "Describe the image.",
      ],
      {
        cwd: workspaceDir,
        env: {
          ...browserTestEnv,
          VIBE_RESEARCH_REAL_CLAUDE_COMMAND: fakeClaudePath,
        },
      },
    );
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.command, "describe-file");
    assert.equal(payload.visionProvider, "claude");
    assert.match(payload.analysis, /claude analyzed local image successfully/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("browser detour wrappers redirect agents toward the Playwright skill", async () => {
  await assert.rejects(
    execFile(path.join(rootDir, "bin", "google-chrome"), ["--headless=new", "http://127.0.0.1:4173"], {
      cwd: rootDir,
      env: browserTestEnv,
    }),
    (error) => {
      assert.equal(error.code, 64);
      assert.match(error.stderr, /Use vr-playwright open <port-or-url>/);
      assert.match(error.stderr, /click\/fill\/type\/press/);
      return true;
    },
  );

  await assert.rejects(
    execFile(path.join(rootDir, "bin", "open"), ["http://127.0.0.1:4173"], {
      cwd: rootDir,
      env: browserTestEnv,
    }),
    (error) => {
      assert.equal(error.code, 64);
      assert.match(error.stderr, /Use vr-playwright open <port-or-url>/);
      return true;
    },
  );
});

test("shell sessions can invoke vr-browser against localhost apps", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-session-browser-"));
  const demoServer = await startDemoServer();
  const vibeResearch = await startVibeResearch({
    cwd: workspaceDir,
  });

  try {
    const demoPort = demoServer.address().port;
    const createResponse = await fetch(`${vibeResearch.baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "shell",
        name: "Browser Shell",
        cwd: workspaceDir,
      }),
    });
    assert.equal(createResponse.status, 201);

    const { session } = await createResponse.json();
    const websocket = new WebSocket(`${vibeResearch.baseUrl.replace("http", "ws")}/ws?sessionId=${session.id}`);
    const commandPath = path.join(workspaceDir, "vr-browser-command.txt");
    const jsonPath = path.join(workspaceDir, "vr-browser-session.json");
    const screenshotPath = path.join(workspaceDir, "vr-browser-session.png");
    const stepsFilePath = path.join(workspaceDir, "session-steps.json");
    const donePath = path.join(workspaceDir, "vr-browser-session.done");

    await writeFile(
      stepsFilePath,
      `${JSON.stringify(
        [
          { action: "type", selector: "#prompt", text: "session eval prompt" },
          { action: "select", selector: "#mode", option: "qa" },
          { action: "click", selector: "#generate" },
          { action: "wait", text: "Generated (qa, pending): session eval prompt" },
          { action: "screenshot", path: path.basename(screenshotPath), fullPage: true },
        ],
        null,
        2,
      )}\n`,
      "utf8",
    );

    const snapshot = await new Promise((resolve, reject) => {
      let combined = "";
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for the shell snapshot.\n${combined}`));
      }, 20_000);

      websocket.on("message", (chunk) => {
        const payload = JSON.parse(String(chunk));
        const data = payload.data || "";
        combined += data;

        if (payload.type === "snapshot") {
          clearTimeout(timeout);
          resolve(payload);
        }
      });
    });

    assert.equal(snapshot.type, "snapshot");
    websocket.send(
      JSON.stringify({
        type: "resize",
        cols: 120,
        rows: 34,
      }),
    );
    websocket.send(
      JSON.stringify({
        type: "input",
        data:
          [
            `command -v vr-browser > ${shellQuote(commandPath)}`,
            `vr-browser run ${demoPort} --steps-file ${shellQuote(path.basename(stepsFilePath))} --output ${shellQuote(
              path.basename(screenshotPath),
            )} > ${shellQuote(jsonPath)}`,
            `touch ${shellQuote(donePath)}`,
          ].join(" && ") + "\r",
      }),
    );

    await waitForFile(commandPath);
    await waitForFile(jsonPath);
    await waitForFile(screenshotPath);
    await waitForFile(donePath);
    websocket.close();
    await once(websocket, "close");

    const resolvedCommand = (await readFile(commandPath, "utf8")).trim();
    assert.match(resolvedCommand, /vr-browser$/);

    const payload = JSON.parse(await readFile(jsonPath, "utf8"));
    assert.equal(payload.ok, true);
    assert.equal(payload.command, "run");
    assert.match(payload.text, /Generated \(qa, pending\): session eval prompt/);
    assert.equal(await realpath(payload.outputPath), await realpath(screenshotPath));
    assert.ok((await stat(screenshotPath)).size > 0);
  } finally {
    await vibeResearch.app.close();
    await new Promise((resolve) => demoServer.close(resolve));
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("agent wrappers inject Playwright skill guidance and the managed agent prompt for Codex and Claude", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-agent-wrapper-"));

  try {
    const captureScriptPath = path.join(workspaceDir, "capture-argv.sh");
    const capturedArgsPath = path.join(workspaceDir, "captured-args.txt");
    const capturedProviderPath = path.join(workspaceDir, "captured-provider.txt");
    const agentPromptPath = path.join(workspaceDir, "agent-prompt.md");

    await writeFile(
      agentPromptPath,
      `# Vibe Research Agent Prompt

Vibe Research provides \`vr-session-name\` on your session \`PATH\`.
- Run \`vr-session-name "<short task label>"\` at the start of meaningful work.
`,
      "utf8",
    );

    await writeFile(
      captureScriptPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$VIBE_RESEARCH_PROVIDER" > "$CAPTURED_PROVIDER_PATH"
printf '%s\n' "$@" > "$CAPTURED_ARGS_PATH"
`,
      "utf8",
    );
    await chmod(captureScriptPath, 0o755);

    await execFile(path.join(rootDir, "bin", "codex"), ["exec", "hello"], {
      cwd: workspaceDir,
      env: {
        ...browserTestEnv,
        CAPTURED_ARGS_PATH: capturedArgsPath,
        CAPTURED_PROVIDER_PATH: capturedProviderPath,
        VIBE_RESEARCH_AGENT_PROMPT_PATH: agentPromptPath,
        VIBE_RESEARCH_REAL_CODEX_COMMAND: captureScriptPath,
      },
    });
    const codexArgs = await readFile(capturedArgsPath, "utf8");
    const codexProvider = await readFile(capturedProviderPath, "utf8");
    assert.match(codexArgs, /developer_instructions=/);
    assert.match(codexArgs, /Browser Use plugin/);
    assert.match(codexArgs, /vr-browser-use --task/);
    assert.match(codexArgs, /--max-steps <n>/);
    assert.match(codexArgs, /do not spawn an internal Agent/);
    assert.match(codexArgs, /Playwright CLI browser skill/);
    assert.match(codexArgs, /skills\/playwright\/SKILL\.md/);
    assert.match(codexArgs, /vr-playwright/);
    assert.match(codexArgs, /snapshot/);
    assert.match(codexArgs, /click\/fill\/type\/press/);
    assert.match(codexArgs, /vr-browser describe-file/);
    assert.match(codexArgs, /--provider codex/);
    assert.match(codexArgs, /vr-session-name/);
    assert.equal(codexProvider.trim(), "codex");

    await execFile(path.join(rootDir, "bin", "claude"), ["--print", "hello"], {
      cwd: workspaceDir,
      env: {
        ...browserTestEnv,
        CAPTURED_ARGS_PATH: capturedArgsPath,
        CAPTURED_PROVIDER_PATH: capturedProviderPath,
        VIBE_RESEARCH_AGENT_PROMPT_PATH: agentPromptPath,
        VIBE_RESEARCH_REAL_CLAUDE_COMMAND: captureScriptPath,
      },
    });
    const claudeArgs = await readFile(capturedArgsPath, "utf8");
    const claudeProvider = await readFile(capturedProviderPath, "utf8");
    assert.match(claudeArgs, /--append-system-prompt/);
    assert.match(claudeArgs, /Browser Use plugin/);
    assert.match(claudeArgs, /vr-browser-use --task/);
    assert.match(claudeArgs, /--max-steps <n>/);
    assert.match(claudeArgs, /do not spawn an internal Agent/);
    assert.match(claudeArgs, /Playwright CLI browser skill/);
    assert.match(claudeArgs, /skills\/playwright\/SKILL\.md/);
    assert.match(claudeArgs, /vr-playwright/);
    assert.match(claudeArgs, /snapshot/);
    assert.match(claudeArgs, /click\/fill\/type\/press/);
    assert.match(claudeArgs, /vr-browser describe-file/);
    assert.match(claudeArgs, /--provider claude/);
    assert.match(claudeArgs, /vr-session-name/);
    assert.equal(claudeProvider.trim(), "claude");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
