import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { detectProviders, providerDefinitions, resolveProviderCommand } from "../src/providers.js";

test("resolveProviderCommand falls back to executable path hints", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-provider-"));
  const fakeCodexPath = path.join(tempDir, "codex");

  try {
    await writeFile(fakeCodexPath, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(fakeCodexPath, 0o755);

    const result = await resolveProviderCommand(
      {
        id: "codex",
        label: "Codex",
        command: "codex",
        launchCommand: "codex",
        pathHints: [fakeCodexPath],
      },
      { HOME: tempDir, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
    );

    assert.deepEqual(result, {
      available: true,
      resolvedCommand: fakeCodexPath,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detectProviders promotes a hinted executable into the launch command", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-provider-"));
  const fakeCodexPath = path.join(tempDir, "codex");

  try {
    await writeFile(fakeCodexPath, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(fakeCodexPath, 0o755);

    const [provider] = await detectProviders(
      [
        {
          id: "codex",
          label: "Codex",
          command: "codex",
          launchCommand: "codex",
          defaultName: "Codex",
          pathHints: [fakeCodexPath],
        },
      ],
      { HOME: tempDir, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
    );

    assert.equal(provider.available, true);
    assert.equal(provider.launchCommand, fakeCodexPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveProviderCommand falls back to a globally installed npm package bin", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-provider-npm-"));
  const fakeNpmRoot = path.join(tempDir, "npm-root");
  const packageDir = path.join(fakeNpmRoot, "@anthropic-ai", "claude-code");
  const fakeCliPath = path.join(packageDir, "cli.js");
  const fakePackageJsonPath = path.join(packageDir, "package.json");

  try {
    await mkdir(packageDir, { recursive: true });
    await writeFile(fakeCliPath, "#!/usr/bin/env node\nprocess.exit(0)\n");
    await chmod(fakeCliPath, 0o755);
    await writeFile(
      fakePackageJsonPath,
      JSON.stringify({
        name: "@anthropic-ai/claude-code",
        bin: {
          claude: "cli.js",
        },
      }),
    );

    const result = await resolveProviderCommand(
      {
        id: "claude",
        label: "Claude Code",
        command: "claude",
        launchCommand: "claude",
        npmPackage: {
          name: "@anthropic-ai/claude-code",
          bin: "claude",
        },
      },
      {
        HOME: tempDir,
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/zsh",
        REMOTE_VIBES_NPM_ROOT: fakeNpmRoot,
      },
    );

    assert.deepEqual(result, {
      available: true,
      resolvedCommand: fakeCliPath,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("providerDefinitions includes OpenCode with desktop and common CLI path hints", () => {
  const provider = providerDefinitions.find((entry) => entry.id === "opencode");

  assert.ok(provider);
  assert.equal(provider.label, "OpenCode");
  assert.equal(provider.command, "opencode");
  assert.deepEqual(provider.pathHints, [
    "/Applications/OpenCode.app/Contents/MacOS/opencode-cli",
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ]);
});

test("providerDefinitions includes Claude npm package fallback metadata", () => {
  const provider = providerDefinitions.find((entry) => entry.id === "claude");

  assert.ok(provider);
  assert.deepEqual(provider.verifyArgs, ["--version"]);
  assert.deepEqual(provider.npmPackage, {
    name: "@anthropic-ai/claude-code",
    bin: "claude",
  });
});

test("resolveProviderCommand rejects a discovered command that fails provider verification", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remote-vibes-provider-verify-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const fakeClaudePath = path.join(fakeBinDir, "claude");

  try {
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(fakeClaudePath, "#!/usr/bin/env bash\nexit 1\n");
    await chmod(fakeClaudePath, 0o755);

    const result = await resolveProviderCommand(
      {
        id: "claude",
        label: "Claude Code",
        command: "claude",
        launchCommand: "claude",
        verifyArgs: ["--version"],
      },
      {
        HOME: tempDir,
        PATH: `${fakeBinDir}:/usr/bin:/bin`,
        SHELL: "/bin/zsh",
      },
    );

    assert.deepEqual(result, {
      available: false,
      resolvedCommand: null,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("providerDefinitions includes Claude path hints for common installs", () => {
  const provider = providerDefinitions.find((entry) => entry.id === "claude");

  assert.ok(provider);
  assert.deepEqual(provider.pathHints, [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]);
});
