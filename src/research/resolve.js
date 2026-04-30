// vr-research-resolve — orchestrate loop step 9 in one call.
//
// CLAUDE.md step 9: "Apply everything to the README: edit LEADERBOARD per
// the Decision, remove the row from ACTIVE, apply the Queue updates,
// append a LOG row whose primary tag is `resolved`, `falsified`, or
// `abandoned`, compounded with `+admitted` if this result was inserted
// into the LEADERBOARD or `+evicted` if rank 6 dropped."
//
// The agent has been doing this with the four admin commands in
// sequence (leaderboard insert → active remove → queue verbs → log
// append). This wraps that into one call:
//
//   vr-research-resolve <project> --slug v3-deeper --event resolved
//
// Reads the result doc + project README, parses the Decision line +
// Queue updates section, runs the right admin commands in the right
// order. Returns a `steps` array reporting what happened for the agent
// (or human) to verify.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseProjectReadme } from "./project-readme.js";
import { parseResultDoc } from "./result-doc.js";
import { insertLeaderboardRow } from "./leaderboard-edit.js";
import { removeActiveRow } from "./active-edit.js";
import {
  addQueueRow,
  removeQueueRow,
  reprioritizeQueueRow,
} from "./queue-edit.js";
import { appendLogRow } from "./log-append.js";

const VALID_EVENTS = new Set(["resolved", "falsified", "abandoned"]);

// Parse the "Queue updates" section verbs per the contract:
//   ADD: <slug> | starting-point <url> | why <text>
//   REMOVE: <slug> | why <text>
//   REPRIORITIZE: <slug> -> row <N> | why <text>
//
// Tolerant: stops at the first parse failure per line, doesn't throw.
// Returns an array of { verb, slug, ... } objects.
export function parseQueueUpdates(body) {
  const verbs = [];
  for (const raw of String(body || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    let m = line.match(/^ADD:\s*([^\s|]+)\s*(?:\|(.*))?$/);
    if (m) {
      const slug = m[1].trim();
      const rest = m[2] || "";
      const spMatch = rest.match(/starting-point\s+([^|]+?)(?=\s*\||$)/i);
      const whyMatch = rest.match(/why\s+(.+?)$/i);
      verbs.push({
        verb: "add",
        slug,
        startingPoint: spMatch ? spMatch[1].trim() : "",
        why: whyMatch ? whyMatch[1].trim() : "",
        raw: line,
      });
      continue;
    }
    m = line.match(/^REMOVE:\s*([^\s|]+)/);
    if (m) {
      verbs.push({ verb: "remove", slug: m[1].trim(), raw: line });
      continue;
    }
    m = line.match(/^REPRIORITIZE:\s*([^\s|]+)\s*->\s*row\s+(\d+)/i);
    if (m) {
      verbs.push({
        verb: "reprioritize",
        slug: m[1].trim(),
        toRow: Number(m[2]),
        raw: line,
      });
      continue;
    }
  }
  return verbs;
}

// Parse the decision string for "insert at rank N" or "do not admit".
// Returns { admit: bool, rank: number|null }.
export function parseAdmitDecision(decision) {
  const trimmed = String(decision || "").trim();
  const rankMatch = trimmed.match(/insert\s+at\s+rank\s+(\d+)/i);
  if (rankMatch) return { admit: true, rank: Number(rankMatch[1]) };
  const admitMatch = trimmed.match(/\badmit\s+at\s+rank\s+(\d+)/i);
  if (admitMatch) return { admit: true, rank: Number(admitMatch[1]) };
  if (/do\s+not\s+admit/i.test(trimmed)) return { admit: false, rank: null };
  return { admit: false, rank: null };
}

// Pull the `## <sectionName>` body out of raw markdown. Returns empty
// string if not found. Used for the Queue updates section, which the
// existing parseResultDoc doesn't expose.
export function getSectionBody(text, sectionName) {
  const lines = String(text || "").split("\n");
  const headerRe = new RegExp(`^##\\s+${sectionName}\\s*$`, "i");
  let inSection = false;
  const collected = [];
  for (const line of lines) {
    if (inSection) {
      if (/^##\s+/.test(line)) break;
      collected.push(line);
    } else if (headerRe.test(line)) {
      inSection = true;
    }
  }
  return collected.join("\n");
}

function extractFirstUrl(text) {
  const m = String(text || "").match(/https?:\/\/\S+/);
  return m ? m[0].replace(/[.,;:!?)\]>]+$/, "") : "";
}

function deriveScore(frontmatter) {
  if (!frontmatter) return "";
  const { mean, std, seeds } = frontmatter;
  if (mean == null || std == null) return "";
  const seedsText = Array.isArray(seeds) ? `n=${seeds.length}` : "";
  return seedsText
    ? `${mean} ± ${std} across ${seedsText} seeds`
    : `${mean} ± ${std}`;
}

export async function resolveMove({
  projectDir,
  slug,
  event,
  summary,
  score,
  commit,
  // Dependency-injection points for testing:
  insertImpl = insertLeaderboardRow,
  removeActiveImpl = removeActiveRow,
  addQueueImpl = addQueueRow,
  removeQueueImpl = removeQueueRow,
  reprioritizeImpl = reprioritizeQueueRow,
  appendLogImpl = appendLogRow,
} = {}) {
  if (!projectDir) throw new TypeError("projectDir is required");
  if (!slug) throw new TypeError("slug is required");
  if (!event || !VALID_EVENTS.has(event)) {
    throw new Error(`event must be one of ${[...VALID_EVENTS].join("/")}, got "${event}"`);
  }

  const readmePath = path.join(projectDir, "README.md");
  const logPath = path.join(projectDir, "LOG.md");
  const resultPath = path.join(projectDir, "results", `${slug}.md`);

  const [readmeText, resultText] = await Promise.all([
    readFile(readmePath, "utf8"),
    readFile(resultPath, "utf8"),
  ]);
  parseProjectReadme(readmeText); // validates the README parses; throws otherwise
  const doc = parseResultDoc(resultText);

  if (doc.status === "active") {
    throw new Error(`result doc STATUS is "active"; resolve only fires on resolved/abandoned moves (set STATUS first)`);
  }

  const queueBody = getSectionBody(resultText, "Queue updates");
  const verbs = parseQueueUpdates(queueBody);
  const { admit, rank } = parseAdmitDecision(doc.decision);

  const finalSummary = (summary && summary.trim()) || doc.takeaway.split("\n")[0] || `${event} ${slug}`;
  const branchUrl = extractFirstUrl(doc.branchBody);
  const resultRelative = `results/${slug}.md`;
  const steps = [];
  let evicted = null;

  if (admit) {
    if (!commit) throw new Error(`admitting requires --commit (commit URL of the cycle SHA)`);
    if (!branchUrl) throw new Error(`admitting requires a BRANCH section URL in the result doc`);
    const finalScore = (score && score.trim()) || deriveScore(doc.frontmatter);
    if (!finalScore) {
      throw new Error(`admitting requires --score, or frontmatter mean+std for auto-derivation`);
    }
    const insertResult = await insertImpl({
      readmePath,
      rank,
      row: {
        slug,
        resultPath: resultRelative,
        branchUrl,
        commitUrl: commit,
        score: finalScore,
      },
    });
    steps.push({
      step: "leaderboard.insert",
      rank,
      evicted: insertResult.evicted ? insertResult.evicted.slug : null,
    });
    if (insertResult.evicted) evicted = insertResult.evicted;
  }

  // Always attempt to remove from ACTIVE. Tolerate "not found" — quick fix
  // moves sometimes resolve without ever being claimed.
  try {
    await removeActiveImpl({ readmePath, slug });
    steps.push({ step: "active.remove", slug });
  } catch (err) {
    if (!/no row for slug/.test(err.message)) throw err;
    steps.push({ step: "active.remove", slug, skipped: "no ACTIVE row" });
  }

  // Apply Queue updates verbs.
  for (const v of verbs) {
    if (v.verb === "add") {
      const r = await addQueueImpl({
        readmePath,
        row: { slug: v.slug, startingPoint: v.startingPoint, why: v.why },
      });
      steps.push({
        step: "queue.add",
        slug: v.slug,
        bumped: r.bumped ? r.bumped.slug : null,
      });
    } else if (v.verb === "remove") {
      try {
        await removeQueueImpl({ readmePath, slug: v.slug });
        steps.push({ step: "queue.remove", slug: v.slug });
      } catch (err) {
        if (!/no row for slug/.test(err.message)) throw err;
        steps.push({ step: "queue.remove", slug: v.slug, skipped: "no QUEUE row" });
      }
    } else if (v.verb === "reprioritize") {
      await reprioritizeImpl({ readmePath, slug: v.slug, toRow: v.toRow });
      steps.push({ step: "queue.reprioritize", slug: v.slug, toRow: v.toRow });
    }
  }

  // Eviction LOG row first (chronologically before the resolution).
  if (evicted) {
    await appendLogImpl({
      logPath,
      row: {
        event: "evicted",
        slug: evicted.slug,
        summary: `bumped by ${slug}`,
        link: "",
      },
    });
    steps.push({ step: "log.append", event: "evicted", slug: evicted.slug });
  }

  // Resolution LOG row.
  const eventTag = admit ? `${event}+admitted` : event;
  await appendLogImpl({
    logPath,
    row: {
      event: eventTag,
      slug,
      summary: finalSummary,
      link: resultRelative,
    },
  });
  steps.push({ step: "log.append", event: eventTag, slug });

  return {
    resolved: true,
    slug,
    event: eventTag,
    admitted: admit,
    rank: admit ? rank : null,
    evicted: evicted ? evicted.slug : null,
    steps,
  };
}

export const __internal = {
  parseQueueUpdates,
  parseAdmitDecision,
  getSectionBody,
  extractFirstUrl,
  deriveScore,
  VALID_EVENTS,
};
