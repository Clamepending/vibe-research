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
    preferPathHints: true,
    npmPackage: {
      name: "@anthropic-ai/claude-code",
      bin: "claude",
    },
    installCommand:
      '((if command -v timeout >/dev/null 2>&1; then timeout 600s bash -c \'curl -fsSL https://claude.ai/install.sh | bash\'; else bash -c \'curl -fsSL https://claude.ai/install.sh | bash\'; fi) || (mkdir -p "$HOME/.local" && NPM_CONFIG_PREFIX="$HOME/.local" npm install -g @anthropic-ai/claude-code --no-audit --no-fund --fetch-retries=5 --fetch-retry-maxtimeout=120000 --fetch-timeout=300000)) && export PATH="$HOME/.local/bin:$PATH" && hash -r && claude --version',
    authCommand: "claude auth login",
    pathHints: [
      "~/.local/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ],
  },
  {
    id: "claude-ollama",
    label: "Local Claude Code (Ollama)",
    command: "claude",
    launchCommand: "claude",
    defaultName: "Local Claude",
    verifyArgs: ["--version"],
    preferPathHints: true,
    npmPackage: {
      name: "@anthropic-ai/claude-code",
      bin: "claude",
    },
    requiredCommands: [
      {
        command: "ollama",
        verifyArgs: ["--version"],
      },
    ],
    installCommand:
      '(curl -fsSL https://claude.ai/install.sh | bash || (mkdir -p "$HOME/.local" && NPM_CONFIG_PREFIX="$HOME/.local" npm install -g @anthropic-ai/claude-code --no-audit --no-fund)) && (command -v ollama >/dev/null 2>&1 || curl -fsSL https://ollama.com/install.sh | sh) && ollama pull "${VIBE_RESEARCH_CLAUDE_OLLAMA_MODEL:-${REMOTE_VIBES_CLAUDE_OLLAMA_MODEL:-qwen3-coder}}"',
    pathHints: [
      "~/.local/bin/claude",
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
    installCommand: "npm install -g @openai/codex",
    authCommand: "codex login --device-auth",
    pathHints: ["/Applications/Codex.app/Contents/Resources/codex"],
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    command: "openclaw",
    launchCommand: "openclaw",
    defaultName: "OpenClaw",
    verifyArgs: ["--version"],
    installCommand: "npm install -g openclaw@latest",
    authCommand: "openclaw onboard --install-daemon",
    pathHints: [
      "~/.local/bin/openclaw",
      "/opt/homebrew/bin/openclaw",
      "/usr/local/bin/openclaw",
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    launchCommand: "opencode",
    defaultName: "OpenCode",
    installCommand: "curl -fsSL https://opencode.ai/install | bash",
    authCommand: "opencode auth login",
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
    installCommand: "npm install -g @google/gemini-cli",
    authCommand: "gemini",
  },
  {
    id: "ml-intern",
    label: "ML Intern",
    command: "ml-intern",
    launchCommand: "ml-intern",
    defaultName: "ML Intern",
    verifyArgs: ["--help"],
    preferPathHints: true,
    installCommand:
      '(command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh) && export PATH="$HOME/.local/bin:$PATH" && repo="${XDG_DATA_HOME:-$HOME/.local/share}/vibe-research/ml-intern" && (if [ -d "$repo/.git" ]; then git -C "$repo" pull --ff-only; else mkdir -p "$(dirname "$repo")" && git clone https://github.com/huggingface/ml-intern.git "$repo"; fi) && cd "$repo" && uv sync && uv tool install -e .',
    authCommand: "ml-intern",
    pathHints: [
      "~/.local/bin/ml-intern",
      "/opt/homebrew/bin/ml-intern",
      "/usr/local/bin/ml-intern",
    ],
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

function expandPathHint(hint, env = process.env) {
  const value = String(hint || "").trim();
  if (!value) {
    return "";
  }

  if (value === "~") {
    return env.HOME || process.env.HOME || "";
  }

  if (value.startsWith("~/")) {
    const homeDir = env.HOME || process.env.HOME || "";
    return homeDir ? path.join(homeDir, value.slice(2)) : "";
  }

  return value;
}

async function findCommandInHints(pathHints = [], env = process.env) {
  for (const hint of pathHints) {
    const expandedHint = expandPathHint(hint, env);
    if (!expandedHint) {
      continue;
    }

    try {
      await access(expandedHint, fsConstants.X_OK);
      return expandedHint;
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
      String(env?.VIBE_RESEARCH_NPM_ROOT || env?.REMOTE_VIBES_NPM_ROOT || "").trim() ||
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

async function resolveCommandRequirement(requirement, env = process.env) {
  if (!requirement?.command) {
    return true;
  }

  const shellResolved = await findCommandInShell(requirement.command, env);
  if (shellResolved && await verifyResolvedCommand(requirement, shellResolved, env)) {
    return true;
  }

  const hintedCommand = await findCommandInHints(requirement.pathHints, env);
  return Boolean(hintedCommand && await verifyResolvedCommand(requirement, hintedCommand, env));
}

async function buildResolvedProviderCommandResult(provider, resolvedCommand, env = process.env) {
  if (Array.isArray(provider.requiredCommands)) {
    for (const requirement of provider.requiredCommands) {
      if (!await resolveCommandRequirement(requirement, env)) {
        return {
          available: false,
          resolvedCommand: null,
        };
      }
    }
  }

  return {
    available: true,
    resolvedCommand,
  };
}

export async function resolveProviderCommand(provider, env = process.env) {
  if (!provider.command) {
    return {
      available: true,
      resolvedCommand: null,
    };
  }

  if (provider.preferPathHints) {
    const hintedCommand = await findCommandInHints(provider.pathHints, env);
    if (hintedCommand && await verifyResolvedCommand(provider, hintedCommand, env)) {
      return buildResolvedProviderCommandResult(provider, hintedCommand, env);
    }
  }

  const shellResolved = await findCommandInShell(provider.command, env);
  if (shellResolved && await verifyResolvedCommand(provider, shellResolved, env)) {
    return buildResolvedProviderCommandResult(provider, shellResolved, env);
  }

  if (!provider.preferPathHints) {
    const hintedCommand = await findCommandInHints(provider.pathHints, env);
    if (hintedCommand && await verifyResolvedCommand(provider, hintedCommand, env)) {
      return buildResolvedProviderCommandResult(provider, hintedCommand, env);
    }
  }

  const npmPackageCommand = await resolveNpmPackageCommand(provider.npmPackage, env);
  if (npmPackageCommand && await verifyResolvedCommand(provider, npmPackageCommand, env)) {
    return buildResolvedProviderCommandResult(provider, npmPackageCommand, env);
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
        const { pathHints, preferPathHints, ...providerConfig } = provider;
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
  return (
    providers.find((provider) => provider.id === "claude" && provider.available)?.id
    ?? providers.find((provider) => provider.id !== "shell" && provider.available)?.id
    ?? "shell"
  );
}
