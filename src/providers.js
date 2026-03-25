import { execFile } from "node:child_process";
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

async function commandExists(command) {
  if (!command) {
    return true;
  }

  try {
    await execFileAsync(process.env.SHELL || "/bin/zsh", ["-lc", `command -v ${command}`], {
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

export async function detectProviders() {
  const detected = await Promise.all(
    providerDefinitions.map(async (provider) => ({
      ...provider,
      available: await commandExists(provider.command),
    })),
  );

  return detected;
}

export function getDefaultProviderId(providers) {
  return providers.find((provider) => provider.id === "claude" && provider.available)?.id ?? "shell";
}
