import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

// Persistent (pid -> session) ledger for GPU compute processes we've previously
// attributed to a vibe-research session. Lets the UI keep its agent label after
// a server restart, when the live PTY pid is gone but the GPU process (e.g. a
// detached training job, or anything spawned through a tmux pane that survived
// the restart) is still on the card.
//
// Lifecycle: every metrics tick, we replace the stored claim set with the
// currently-attributed GPU processes. A pid that's no longer using a GPU
// quietly drops off — the ledger only ever holds processes worth labelling.
//
// Pid recycling guard: at read time we skip claims whose pid is no longer
// alive *for this OS user* (process.kill(pid, 0) returns ESRCH or EPERM).
// EPERM means the pid was recycled to a different user, so the ledger entry
// is stale and must not be re-attributed.

const FILE_VERSION = 1;
const DEFAULT_MAX_CLAIMS = 256;

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function normalizeClaim(entry, fallbackTimestamp) {
  const pid = normalizePid(entry?.pid);
  const sessionId = String(entry?.sessionId || "").trim();
  if (!pid || !sessionId) return null;
  return {
    pid,
    sessionId,
    providerId: String(entry?.providerId || "").trim(),
    ownerUser: String(entry?.ownerUser || "").trim(),
    firstSeen: String(entry?.firstSeen || fallbackTimestamp),
    lastConfirmed: String(entry?.lastConfirmed || fallbackTimestamp),
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomicJson(filePath, payload) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function defaultIsPidOwned(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function claimsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [pid, claim] of left) {
    const other = right.get(pid);
    if (!other) return false;
    if (other.sessionId !== claim.sessionId) return false;
    if (other.providerId !== claim.providerId) return false;
    if (other.ownerUser !== claim.ownerUser) return false;
  }
  return true;
}

export class GpuOwnershipStore {
  constructor({
    stateDir,
    maxClaims = DEFAULT_MAX_CLAIMS,
    isPidOwned = defaultIsPidOwned,
    now = () => new Date().toISOString(),
  } = {}) {
    this.stateDir = stateDir;
    this.filePath = path.join(stateDir, "gpu-ownership.json");
    this.maxClaims = Math.max(1, Number(maxClaims) || DEFAULT_MAX_CLAIMS);
    this.isPidOwned = typeof isPidOwned === "function" ? isPidOwned : defaultIsPidOwned;
    this.now = typeof now === "function" ? now : () => new Date().toISOString();
    this.claims = new Map();
  }

  async initialize() {
    const payload = await readJsonIfExists(this.filePath);
    const entries = payload?.version === FILE_VERSION && Array.isArray(payload?.claims)
      ? payload.claims
      : [];
    const fallback = this.now();
    this.claims = new Map();
    for (const raw of entries) {
      const claim = normalizeClaim(raw, fallback);
      if (claim && !this.claims.has(claim.pid)) {
        this.claims.set(claim.pid, claim);
      }
    }
  }

  // Returns the ledger as agent-process-root entries, ready to be merged with
  // the live roots from session-manager. The system-metrics resolver matches
  // these by pid directly, so a label survives even when the parent walk
  // can't reach the session (e.g. nohup'd training, or a tmux pane that died
  // but the GPU job is still running under init).
  getRootsForKnownSessions(knownSessionIds) {
    const known = new Set(
      (Array.isArray(knownSessionIds) ? knownSessionIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    );
    const roots = [];
    for (const claim of this.claims.values()) {
      if (known.size && !known.has(claim.sessionId)) continue;
      if (!this.isPidOwned(claim.pid)) continue;
      roots.push({
        pid: claim.pid,
        sessionId: claim.sessionId,
        providerId: claim.providerId,
        source: "ledger",
      });
    }
    return roots;
  }

  // Replaces the ledger with the latest set of observations. Pids no longer
  // observed are dropped — the lifecycle is "if it's still on a GPU and we
  // own it, it's claimed; otherwise nothing to label."
  async recordObservations(observations) {
    const now = this.now();
    const next = new Map();
    for (const entry of Array.isArray(observations) ? observations : []) {
      const pid = normalizePid(entry?.pid);
      const sessionId = String(entry?.sessionId || "").trim();
      if (!pid || !sessionId || next.has(pid)) continue;
      const previous = this.claims.get(pid);
      next.set(pid, {
        pid,
        sessionId,
        providerId: String(entry?.providerId || previous?.providerId || "").trim(),
        ownerUser: String(entry?.ownerUser || previous?.ownerUser || "").trim(),
        firstSeen: previous?.firstSeen || now,
        lastConfirmed: now,
      });
      if (next.size >= this.maxClaims) break;
    }

    // The in-memory map always reflects the latest tick — that includes
    // bumping lastConfirmed on every re-observation. The disk write is
    // skipped on quiet ticks (no change to the meaningful fields) so a
    // running training job doesn't generate a write per metrics sample.
    const meaningfulChange = !claimsEqual(this.claims, next);
    this.claims = next;
    if (!meaningfulChange) {
      return false;
    }
    await writeAtomicJson(this.filePath, {
      version: FILE_VERSION,
      savedAt: now,
      claims: Array.from(this.claims.values()),
    });
    return true;
  }

  // Test helper.
  getClaimsSnapshot() {
    return Array.from(this.claims.values()).map((claim) => ({ ...claim }));
  }
}

// Pull (pid, sessionId, providerId, ownerUser) tuples for owned GPU compute
// processes out of a system-metrics response. Used by create-app.js to feed
// observations back into the store after each metrics tick.
export function extractGpuOwnershipObservations(system) {
  const observations = [];
  const seen = new Set();
  const gpus = Array.isArray(system?.gpus) ? system.gpus : [];
  for (const gpu of gpus) {
    const processes = Array.isArray(gpu?.processes) ? gpu.processes : [];
    for (const process of processes) {
      if (!process?.ownedByUs) continue;
      const pid = Number(process.pid);
      const sessionId = String(process.sessionId || "").trim();
      if (!Number.isInteger(pid) || pid <= 0 || !sessionId) continue;
      if (seen.has(pid)) continue;
      seen.add(pid);
      observations.push({
        pid,
        sessionId,
        providerId: String(process.providerId || "").trim(),
        ownerUser: String(process.ownerUser || "").trim(),
      });
    }
  }
  return observations;
}
