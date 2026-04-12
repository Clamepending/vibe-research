import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const providerDefinitions = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    launchCommand: "claude",
    defaultName: "Claude",
    verifyArgs: ["--version"],
    npmPackage: {
      name: "@anthropic-ai/claude-code",
      bin: "claude",
    },
    pathHints: [
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ],
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    launchCommand: "codex",
    defaultName: "Codex",
    pathHints: ["/Applications/Codex.app/Contents/Resources/codex"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    launchCommand: "opencode",
    defaultName: "OpenCode",
    pathHints: [
      "/Applications/OpenCode.app/Contents/MacOS/opencode-cli",
      "/opt/homebrew/bin/opencode",
      "/usr/local/bin/opencode",
    ],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    launchCommand: "gemini",
    defaultName: "Gemini",
  },
  {
    id: "shell",
    label: "Vanilla Shell",
    command: null,
    launchCommand: null,
    defaultName: "Shell",
  },
];

async function findCommandInShell(command, env = process.env) {
  try {
    const { stdout } = await execFileAsync(process.env.SHELL || "/bin/zsh", ["-lc", `command -v -- ${command}`], {
      env,
    });
    const resolved = stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .pop();

    return resolved || null;
  } catch {
    return null;
  }
}

async function findCommandInHints(pathHints = []) {
  for (const hint of pathHints) {
    try {
      await access(hint, fsConstants.X_OK);
      return hint;
    } catch {
      // Ignore missing or non-executable hints.
    }
  }

  return null;
}

async function resolveNpmPackageCommand(npmPackage, env = process.env) {
  if (!npmPackage?.name || !npmPackage?.bin) {
    return null;
  }

  try {
    const npmRoot =
      String(env?.REMOTE_VIBES_NPM_ROOT || "").trim() ||
      (
        await (async () => {
          const npmCommand = await findCommandInShell("npm", env);
          if (!npmCommand) {
            return "";
          }

          const { stdout } = await execFileAsync(npmCommand, ["root", "-g"], { env });
          return stdout.trim();
        })()
      );

    if (!npmRoot) {
      return null;
    }

    const packageDir = path.join(npmRoot, npmPackage.name);
    const packageJsonPath = path.join(packageDir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const binEntry = packageJson?.bin?.[npmPackage.bin];

    if (!binEntry) {
      return null;
    }

    const resolvedBinPath = path.join(packageDir, binEntry);
    await access(resolvedBinPath, fsConstants.X_OK);
    return resolvedBinPath;
  } catch {
    return null;
  }
}

async function verifyResolvedCommand(provider, resolvedCommand, env = process.env) {
  if (!resolvedCommand || !provider?.verifyArgs?.length) {
    return true;
  }

  try {
    await execFileAsync(resolvedCommand, provider.verifyArgs, {
      env,
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function resolveProviderCommand(provider, env = process.env) {
  if (!provider.command) {
    return {
      available: true,
      resolvedCommand: null,
    };
  }

  const shellResolved = await findCommandInShell(provider.command, env);
  if (shellResolved && await verifyResolvedCommand(provider, shellResolved, env)) {
    return {
      available: true,
      resolvedCommand: shellResolved,
    };
  }

  const hintedCommand = await findCommandInHints(provider.pathHints);
  if (hintedCommand && await verifyResolvedCommand(provider, hintedCommand, env)) {
    return {
      available: true,
      resolvedCommand: hintedCommand,
    };
  }

  const npmPackageCommand = await resolveNpmPackageCommand(provider.npmPackage, env);
  if (npmPackageCommand && await verifyResolvedCommand(provider, npmPackageCommand, env)) {
    return {
      available: true,
      resolvedCommand: npmPackageCommand,
    };
  }

  return {
    available: false,
    resolvedCommand: null,
  };
}

export async function detectProviders(definitions = providerDefinitions, env = process.env) {
  try {
    const detected = await Promise.all(
      definitions.map(async (provider) => {
        const { pathHints, ...providerConfig } = provider;
        const { available, resolvedCommand } = await resolveProviderCommand(provider, env);
        return {
          ...providerConfig,
          available,
          launchCommand:
            available && resolvedCommand?.includes("/")
              ? resolvedCommand
              : providerConfig.launchCommand,
        };
      }),
    );

    return detected;
  } catch {
    return definitions.map((provider) => ({ ...provider, available: provider.command === null }));
  }
}

export function getDefaultProviderId(providers) {
  return providers.find((provider) => provider.id === "claude" && provider.available)?.id ?? "shell";
}
