import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const providerDefinitions = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    launchCommand: "claude",
    defaultName: "Claude",
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

export async function resolveProviderCommand(provider, env = process.env) {
  if (!provider.command) {
    return {
      available: true,
      resolvedCommand: null,
    };
  }

  const shellResolved = await findCommandInShell(provider.command, env);
  if (shellResolved) {
    return {
      available: true,
      resolvedCommand: shellResolved,
    };
  }

  const hintedCommand = await findCommandInHints(provider.pathHints);
  if (hintedCommand) {
    return {
      available: true,
      resolvedCommand: hintedCommand,
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
