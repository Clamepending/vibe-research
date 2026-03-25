import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
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
