const DEFAULT_ACTION_ITEM_WAIT_MS = 30_000;
const DEFAULT_ACTION_ITEM_WAIT_CHUNK_MS = 25_000;

export function normalizeAgentTownApi(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function normalizeWaitTimeoutMs(value, fallback = DEFAULT_ACTION_ITEM_WAIT_MS) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

export async function postAgentTownJson(fetchImpl, url, body) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `${response.status} ${response.statusText}`.trim());
  }
  return payload;
}

export async function waitForAgentTownActionItemResolved({
  api,
  actionItemId,
  timeoutMs = DEFAULT_ACTION_ITEM_WAIT_MS,
  chunkMs = DEFAULT_ACTION_ITEM_WAIT_CHUNK_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const endpoint = normalizeAgentTownApi(api);
  if (!endpoint) throw new Error("Agent Town API is not configured");
  if (!actionItemId) throw new Error("actionItemId is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  const requestedTimeoutMs = normalizeWaitTimeoutMs(timeoutMs, DEFAULT_ACTION_ITEM_WAIT_MS);
  const waitChunkMs = Math.max(1, normalizeWaitTimeoutMs(chunkMs, DEFAULT_ACTION_ITEM_WAIT_CHUNK_MS));
  const deadline = Date.now() + requestedTimeoutMs;
  let attempts = 0;
  let lastPayload = null;

  while (true) {
    const remainingMs = Math.max(0, deadline - Date.now());
    const requestTimeoutMs = Math.min(waitChunkMs, remainingMs);
    lastPayload = await postAgentTownJson(fetchImpl, `${endpoint}/wait`, {
      predicate: "action_item_resolved",
      predicateParams: { actionItemId },
      timeoutMs: requestTimeoutMs,
    });
    attempts += 1;

    if (lastPayload?.satisfied || requestTimeoutMs <= 0 || remainingMs <= waitChunkMs) {
      return {
        ...lastPayload,
        waitAttempts: attempts,
        requestedTimeoutMs,
        waitChunkMs,
        waitChunked: requestedTimeoutMs > waitChunkMs,
      };
    }
  }
}

export const __internal = {
  DEFAULT_ACTION_ITEM_WAIT_CHUNK_MS,
  DEFAULT_ACTION_ITEM_WAIT_MS,
};
