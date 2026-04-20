import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const MANAGED_MARKER = "<!-- remote-vibes:managed-agent-prompt -->";
const WIKI_V2_MARKER = "<!-- remote-vibes:wiki-v2-protocol:v2 -->";
const BUILT_IN_SECTION_MARKER_PATTERN =
  /<!-- remote-vibes:(wiki-v2-protocol|agent-mailbox-protocol):v\d+ -->/;
export const AGENT_PROMPT_FILENAME = "agent-prompt.md";
const PROMPT_FILENAME = AGENT_PROMPT_FILENAME;
const TARGET_FILES = [
  { filename: "AGENTS.md", label: "AGENTS.md" },
  { filename: "CLAUDE.md", label: "CLAUDE.md" },
  { filename: "GEMINI.md", label: "GEMINI.md" },
];

function normalizePrompt(prompt) {
  const trimmed = String(prompt ?? "").trim();
  return trimmed ? `${trimmed}\n` : "";
}

function stripBuiltInPromptSections(prompt) {
  const normalized = normalizePrompt(prompt);

  if (!normalized) {
    return "";
  }

  const match = BUILT_IN_SECTION_MARKER_PATTERN.exec(normalized);

  if (!match) {
    return normalized;
  }

  return normalizePrompt(normalized.slice(0, match.index));
}

function getWikiV2Section({ wikiRootLabel = ".remote-vibes/wiki" } = {}) {
  return normalizePrompt(`
${WIKI_V2_MARKER}

## Knowledge Model

Use \`${wikiRootLabel}\` as the workspace memory system. Treat it as a living wiki that helps future agents avoid rediscovering the same things.

- \`${wikiRootLabel}/\` is the synthesized knowledge layer for durable notes.
- \`${wikiRootLabel}/index.md\` is the entrypoint, not the entire knowledge system.
- \`${wikiRootLabel}/log.md\` is chronological and append-only.
- Use \`${wikiRootLabel}/raw/sources/\` for exact source manifests, commands, commits, paths, and artifact pointers when provenance matters.

Prefer promoting useful findings into durable notes over leaving them trapped in terminal output.

## Knowledge Lifecycle

Not all information is equally durable.

- Keep immediate session findings lightweight at first.
- Crystallize reusable conclusions into durable notes after meaningful work.
- Prefer updating canonical notes over creating near-duplicates.
- Preserve exact provenance in \`${wikiRootLabel}/raw/sources/\` when it matters.
- Keep session-local scratch local unless it becomes useful to other agents.

## Note Shapes

When useful, think in these note shapes:

- observation: a concrete finding tied to evidence
- episode: a short session digest or handoff
- topic: stable cross-session knowledge
- procedure: a reusable workflow or checklist
- entity: a page for a file, dependency, experiment family, system, or concept

You do not need rigid schemas everywhere, but write notes intentionally.

## Writing Rules

- Distinguish observation from interpretation.
- Prefer one page per experiment family under \`${wikiRootLabel}/experiments/\`.
- Use \`${wikiRootLabel}/topics/\` for cross-cutting knowledge.
- Record relevant commits, branches, run ids, output directories, artifact paths, and commands when they matter.
- Link graphs, images, logs, notebooks, and outputs instead of pasting bulky data.
- Prefer fewer, better notes.

When useful, include lightweight metadata or clearly labeled bullets for:
- sources
- confidence
- updated_at
- supersedes
- scope

## Search And Traversal

Do not rely only on \`index.md\` once the wiki grows.

- Start with the directly named files, notes, messages, or artifacts for the current task before widening the search.
- Use search over markdown filenames, headings, bodies, run ids, commits, and exact terms.
- Follow \`[[wikilinks]]\` and normal markdown links when they look relevant.
- Treat links as traversal hints, not decoration.
- For narrowly scoped tasks, stay anchored to the specific exchange or artifact unless the direct evidence is insufficient.
- If the task already names the evidence files to use, do not roam into older related notes unless those exact files are missing, contradictory, or clearly insufficient.
- When notes disagree, prefer the newest and best-supported understanding.
- Make uncertainty explicit when the wiki is incomplete or contradictory.

If dedicated wiki search or traversal tools exist, use them.
If not, approximate the same behavior with exact search and manual link-following.

## Crystallization And Supersession

When a session produces something reusable:

- write a short digest of the question, evidence, result, and takeaway
- update the relevant canonical page instead of leaving isolated scratch notes
- mark older claims as revised, stale, or superseded when new evidence changes them
- keep the current best understanding easy to find

Do not leave contradictory notes side by side without explanation.

## Shared Knowledge Rules

- Shared project knowledge belongs in canonical wiki pages.
- Private scratch and tentative thoughts should stay lightweight unless they become reusable.
- Do not write secrets, tokens, passwords, or sensitive material into the wiki.
- Optimize for another agent being able to pick up the work later with minimal confusion.
`);
}

const WIKI_PLACEHOLDER_PATTERN = /\{\{\s*WIKI\s*\}\}/g;

function substitutePromptPlaceholders(prompt, { wikiRootLabel = ".remote-vibes/wiki" } = {}) {
  return String(prompt ?? "").replace(WIKI_PLACEHOLDER_PATTERN, wikiRootLabel);
}

function ensureBuiltInPromptSections(prompt, options = {}) {
  const normalized = stripBuiltInPromptSections(prompt);

  if (!normalized) {
    return "";
  }

  return normalizePrompt(`${normalized}\n${getWikiV2Section(options)}`);
}

function getDefaultPrompt(options = {}) {
  return ensureBuiltInPromptSections(`
# Remote Vibes Agent Prompt

Use the configured Remote Vibes wiki as your persistent shared knowledge layer. Treat it as a living wiki, not a dump of notes.
`, options);
}

function renderManagedFile(prompt, sourcePath) {
  return `${MANAGED_MARKER}
<!-- Edit this from Remote Vibes or ${sourcePath}. -->

${normalizePrompt(prompt)}`;
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeAtomic(filePath, nextContent) {
  const tempFilePath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tempFilePath, nextContent, "utf8");
  await rename(tempFilePath, filePath);
}

async function ensureFile(filePath, nextContent) {
  const currentContent = await readTextIfExists(filePath);

  if (currentContent !== null && currentContent.trim() && !currentContent.includes(MANAGED_MARKER)) {
    return {
      path: filePath,
      status: "conflict",
    };
  }

  if (currentContent === nextContent) {
    return {
      path: filePath,
      status: "unchanged",
    };
  }

  await writeAtomic(filePath, nextContent);
  return {
    path: filePath,
    status: currentContent === null ? "created" : "updated",
  };
}

export class AgentPromptStore {
  constructor({ cwd, stateDir, wikiRootPath = path.join(stateDir, "wiki") }) {
    this.cwd = cwd;
    this.stateDir = stateDir;
    this.promptFilePath = path.join(stateDir, PROMPT_FILENAME);
    this.prompt = "";
    this.targets = [];
    this.wikiRootPath = wikiRootPath;
  }

  getWikiRootLabel() {
    const relativePath = path.relative(this.cwd, this.wikiRootPath);

    if (!relativePath) {
      return ".";
    }

    if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
      return relativePath;
    }

    return this.wikiRootPath;
  }

  setWikiRootPath(wikiRootPath) {
    this.wikiRootPath = wikiRootPath;
  }

  async initialize() {
    const prompt =
      (await readTextIfExists(this.promptFilePath)) ??
      getDefaultPrompt({ wikiRootLabel: this.getWikiRootLabel() });
    await this.persistPrompt(prompt);
    await this.ensureWikiScaffold();
    this.targets = await this.syncManagedFiles();
  }

  async getState() {
    return {
      prompt: this.prompt,
      promptPath: path.relative(this.cwd, this.promptFilePath) || PROMPT_FILENAME,
      wikiRoot: this.getWikiRootLabel(),
      wikiRootPath: this.wikiRootPath,
      targets: this.targets,
    };
  }

  async save(prompt) {
    await this.persistPrompt(prompt);
    await this.ensureWikiScaffold();
    this.targets = await this.syncManagedFiles();
    return this.getState();
  }

  async reload() {
    const prompt =
      (await readTextIfExists(this.promptFilePath)) ??
      getDefaultPrompt({ wikiRootLabel: this.getWikiRootLabel() });
    await this.persistPrompt(prompt);
    await this.ensureWikiScaffold();
    this.targets = await this.syncManagedFiles();
    return this.getState();
  }

  async persistPrompt(prompt) {
    const options = { wikiRootLabel: this.getWikiRootLabel() };
    this.prompt = ensureBuiltInPromptSections(prompt, options) || getDefaultPrompt(options);
    await writeAtomic(this.promptFilePath, this.prompt);
  }

  async syncManagedFiles() {
    const sourcePath = path.relative(this.cwd, this.promptFilePath) || PROMPT_FILENAME;
    const expanded = substitutePromptPlaceholders(this.prompt, {
      wikiRootLabel: this.getWikiRootLabel(),
    });
    const rendered = renderManagedFile(expanded, sourcePath);

    return Promise.all(
      TARGET_FILES.map(async ({ filename, label }) => ({
        label,
        ...(await ensureFile(path.join(this.cwd, filename), rendered)),
      })),
    );
  }

  async ensureWikiScaffold() {
    const scaffold = [
      {
        filePath: path.join(this.wikiRootPath, "raw", "sources", ".gitkeep"),
        content: "",
      },
      {
        filePath: path.join(this.wikiRootPath, "experiments", ".gitkeep"),
        content: "",
      },
      {
        filePath: path.join(this.wikiRootPath, "topics", ".gitkeep"),
        content: "",
      },
      {
        filePath: path.join(this.wikiRootPath, "index.md"),
        content: "# Wiki Index\n\n- Add experiment pages under `experiments/`.\n- Add cross-cutting pages under `topics/`.\n- Append major updates to `log.md`.\n",
      },
      {
        filePath: path.join(this.wikiRootPath, "log.md"),
        content: "# Wiki Log\n\n",
      },
    ];

    await Promise.all(
      scaffold.map(async ({ filePath, content }) => {
        const currentContent = await readTextIfExists(filePath);
        if (currentContent !== null) {
          return;
        }

        await writeAtomic(filePath, content);
      }),
    );
  }
}
