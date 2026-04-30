import path from "node:path";
import {
  normalizeAgentTownApi,
  postAgentTownJson,
  waitForAgentTownActionItemResolved,
} from "./agent-town-api.js";

export function buildBriefReviewActionItem({ projectDir, brief, briefPath } = {}) {
  const recommended = brief?.recommendedMove || brief?.candidateMoves?.[0]?.move || "";
  const projectName = path.basename(path.resolve(projectDir || "."));
  return {
    id: `research-brief-${brief?.slug || "next-brief"}`,
    kind: "review",
    priority: "high",
    title: `Review research brief: ${brief?.slug || "next-brief"}`,
    detail: brief?.question || "Review the proposed research brief before experiments start.",
    recommendation: recommended
      ? `Approve compiling \`${recommended}\` into QUEUE, or steer with edits/splits/more literature.`
      : "Steer this brief until it has a concrete first move.",
    consequence: "Approval gives the agent permission to leave brainstorm mode and start the selected experiment path.",
    source: "research-brief",
    href: "?view=agent-inbox",
    cta: "Review",
    target: {
      type: "file",
      id: briefPath,
      label: path.basename(briefPath || "brief.md"),
      projectName,
      briefSlug: brief?.slug || "",
      action: "compile-research-brief",
      href: `/research/${encodeURIComponent(projectName)}`,
    },
    evidence: [
      { label: "brief", path: briefPath, kind: "brief" },
      ...(brief?.candidateMoves || []).slice(0, 3).map((move) => ({
        label: move.move,
        kind: "candidate",
      })),
    ],
    choices: ["approve", "steer", "reject"],
  };
}

export async function createBriefReviewCard({
  agentTownApi,
  projectDir,
  brief,
  briefPath,
  fetchImpl = globalThis.fetch,
} = {}) {
  const endpoint = normalizeAgentTownApi(agentTownApi);
  if (!endpoint) throw new Error("Agent Town API is not configured");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const body = buildBriefReviewActionItem({ projectDir, brief, briefPath });
  return postAgentTownJson(fetchImpl, `${endpoint}/action-items`, body);
}

export async function waitForBriefReview({
  agentTownApi,
  actionItemId,
  timeoutMs,
  fetchImpl = globalThis.fetch,
} = {}) {
  return waitForAgentTownActionItemResolved({
    api: agentTownApi,
    actionItemId,
    timeoutMs,
    fetchImpl,
  });
}

export function getActionItemFromWait(waitResult, actionItemId) {
  const items = Array.isArray(waitResult?.state?.actionItems) ? waitResult.state.actionItems : [];
  return items.find((item) => item.id === actionItemId) || null;
}
