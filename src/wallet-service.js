import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const LEDGER_FILENAME = "wallet-ledger.json";
const LEDGER_VERSION = 1;
const DEFAULT_CURRENCY = "USD";

function buildHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeCents(value, { allowZero = false, fieldName = "amountCents" } = {}) {
  if (value === null || value === undefined || value === "") {
    throw buildHttpError(`${fieldName} is required.`, 400);
  }

  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw buildHttpError(`${fieldName} must be an integer number of cents.`, 400);
  }

  return parsed;
}

function normalizeLedger(payload) {
  const ledger = payload && typeof payload === "object" ? payload : {};
  const events = Array.isArray(ledger.events) ? ledger.events.filter((event) => event?.id && event?.type) : [];
  const holds = Array.isArray(ledger.holds) ? ledger.holds.filter((hold) => hold?.id) : [];

  return {
    version: LEDGER_VERSION,
    currency: String(ledger.currency || DEFAULT_CURRENCY).trim().toUpperCase() || DEFAULT_CURRENCY,
    events,
    holds,
  };
}

function compactMetadata(value, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 1200);
  }

  if (Array.isArray(value)) {
    if (depth >= 4) {
      return `[${value.length} items]`;
    }
    return value.slice(0, 30).map((entry) => compactMetadata(entry, depth + 1));
  }

  if (typeof value !== "object") {
    return String(value).slice(0, 1200);
  }

  if (depth >= 4) {
    return "[object omitted]";
  }

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([key, entry]) => [
        key,
        /private[_-]?key|password|secret|token|auth/i.test(key) ? "[redacted]" : compactMetadata(entry, depth + 1),
      ]),
  );
}

function centsToDollars(amountCents) {
  return Number((Number(amountCents || 0) / 100).toFixed(2));
}

export class WalletService {
  constructor({
    currency = DEFAULT_CURRENCY,
    stateDir,
    nowImpl = () => new Date().toISOString(),
  } = {}) {
    this.currency = String(currency || DEFAULT_CURRENCY).trim().toUpperCase() || DEFAULT_CURRENCY;
    this.ledgerPath = stateDir ? path.join(stateDir, LEDGER_FILENAME) : "";
    this.now = nowImpl;
    this.ledger = normalizeLedger({ currency: this.currency });
    this.initialized = false;
    this.initializePromise = null;
    this.mutationPromise = Promise.resolve();
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    this.initializePromise = (async () => {
      try {
        if (this.ledgerPath) {
          const raw = await readFile(this.ledgerPath, "utf8");
          this.ledger = normalizeLedger(JSON.parse(raw));
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw buildHttpError(error.message || "Could not load wallet ledger.", 500);
        }
        this.ledger = normalizeLedger({ currency: this.currency });
        await this.persist();
      } finally {
        this.initialized = true;
        this.initializePromise = null;
      }
    })();

    await this.initializePromise;
  }

  async ensureInitialized() {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  async persist() {
    if (!this.ledgerPath) {
      return;
    }

    await mkdir(path.dirname(this.ledgerPath), { recursive: true });
    const tempPath = `${this.ledgerPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.ledger, null, 2)}\n`, "utf8");
    await rename(tempPath, this.ledgerPath);
  }

  async mutate(callback) {
    const run = this.mutationPromise.then(async () => {
      await this.ensureInitialized();
      const result = await callback();
      await this.persist();
      return result;
    });
    this.mutationPromise = run.catch(() => {});
    return run;
  }

  createEvent(type, payload = {}) {
    const event = {
      id: `wallet_evt_${randomUUID()}`,
      type,
      createdAt: this.now(),
      currency: this.ledger.currency || this.currency,
      ...payload,
    };
    this.ledger.events.push(event);
    return event;
  }

  getTotals() {
    let creditedCents = 0;
    let spentCents = 0;

    for (const event of this.ledger.events) {
      if (event.type === "credit.granted") {
        creditedCents += Number(event.amountCents || 0);
      }
      if (event.type === "spend.captured") {
        spentCents += Number(event.amountCents || 0);
      }
    }

    const heldCents = this.ledger.holds
      .filter((hold) => hold.status === "held")
      .reduce((sum, hold) => sum + Number(hold.remainingCents ?? hold.amountCents ?? 0), 0);
    const balanceCents = creditedCents - spentCents;
    const availableCents = balanceCents - heldCents;

    return {
      availableCents,
      balanceCents,
      creditedCents,
      heldCents,
      spentCents,
    };
  }

  getStatus() {
    const totals = this.getTotals();
    return {
      ...totals,
      availableDollars: centsToDollars(totals.availableCents),
      balanceDollars: centsToDollars(totals.balanceCents),
      currency: this.ledger.currency || this.currency,
      eventCount: this.ledger.events.length,
      holdCount: this.ledger.holds.length,
      ready: true,
    };
  }

  getSummary({ limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return {
      ...this.getStatus(),
      holds: [...this.ledger.holds].slice(-safeLimit).reverse(),
      events: [...this.ledger.events].slice(-safeLimit).reverse(),
    };
  }

  async grantCredits({ amountCents, actor = "human", description = "", idempotencyKey = "", metadata = {}, source = "manual" } = {}) {
    return this.mutate(async () => {
      const normalizedAmountCents = normalizeCents(amountCents);
      const normalizedIdempotencyKey = String(idempotencyKey || "").trim();
      if (normalizedIdempotencyKey) {
        const existing = this.ledger.events.find(
          (event) => event.type === "credit.granted" && event.idempotencyKey === normalizedIdempotencyKey,
        );
        if (existing) {
          return { event: existing, summary: this.getSummary() };
        }
      }

      const event = this.createEvent("credit.granted", {
        actor: String(actor || "human").trim() || "human",
        amountCents: normalizedAmountCents,
        description: String(description || "").trim(),
        idempotencyKey: normalizedIdempotencyKey,
        metadata: compactMetadata(metadata || {}),
        source: String(source || "manual").trim() || "manual",
      });

      return { event, summary: this.getSummary() };
    });
  }

  async createSpendHold({
    action = "",
    amountCents,
    buildingId = "",
    description = "",
    idempotencyKey = "",
    metadata = {},
  } = {}) {
    return this.mutate(async () => {
      const normalizedAmountCents = normalizeCents(amountCents);
      const normalizedIdempotencyKey = String(idempotencyKey || "").trim();
      if (normalizedIdempotencyKey) {
        const existing = this.ledger.holds.find((hold) => hold.idempotencyKey === normalizedIdempotencyKey);
        if (existing) {
          return { hold: existing, summary: this.getSummary() };
        }
      }

      const totals = this.getTotals();
      if (totals.availableCents < normalizedAmountCents) {
        throw buildHttpError(
          `Insufficient wallet credits: ${totals.availableCents} cents available, ${normalizedAmountCents} required.`,
          402,
        );
      }

      const hold = {
        id: `wallet_hold_${randomUUID()}`,
        action: String(action || "").trim(),
        amountCents: normalizedAmountCents,
        buildingId: String(buildingId || "").trim(),
        capturedCents: 0,
        createdAt: this.now(),
        description: String(description || "").trim(),
        idempotencyKey: normalizedIdempotencyKey,
        metadata: compactMetadata(metadata || {}),
        remainingCents: normalizedAmountCents,
        status: "held",
        updatedAt: this.now(),
      };
      this.ledger.holds.push(hold);
      this.createEvent("spend.held", {
        action: hold.action,
        amountCents: normalizedAmountCents,
        buildingId: hold.buildingId,
        description: hold.description,
        holdId: hold.id,
        idempotencyKey: normalizedIdempotencyKey,
        metadata: hold.metadata,
      });

      return { hold, summary: this.getSummary() };
    });
  }

  async captureSpend({ amountCents = null, description = "", holdId, metadata = {} } = {}) {
    return this.mutate(async () => {
      const normalizedHoldId = String(holdId || "").trim();
      if (!normalizedHoldId) {
        throw buildHttpError("holdId is required.", 400);
      }

      const hold = this.ledger.holds.find((entry) => entry.id === normalizedHoldId);
      if (!hold) {
        throw buildHttpError("Wallet hold was not found.", 404);
      }

      if (hold.status === "captured") {
        return { hold, summary: this.getSummary() };
      }

      if (hold.status !== "held") {
        throw buildHttpError(`Wallet hold cannot be captured from status ${hold.status}.`, 400);
      }

      const remainingCents = normalizeCents(hold.remainingCents ?? hold.amountCents, { fieldName: "remainingCents" });
      const normalizedAmountCents =
        amountCents === null || amountCents === undefined || amountCents === ""
          ? remainingCents
          : normalizeCents(amountCents, { allowZero: true });
      if (normalizedAmountCents > remainingCents) {
        throw buildHttpError("Captured amount cannot exceed the held amount.", 400);
      }

      hold.capturedCents = Number(hold.capturedCents || 0) + normalizedAmountCents;
      hold.remainingCents = Math.max(0, remainingCents - normalizedAmountCents);
      hold.status = "captured";
      hold.capturedAt = this.now();
      hold.updatedAt = hold.capturedAt;
      hold.captureDescription = String(description || "").trim();
      this.createEvent("spend.captured", {
        action: hold.action,
        amountCents: normalizedAmountCents,
        buildingId: hold.buildingId,
        description: String(description || hold.description || "").trim(),
        holdId: hold.id,
        metadata: compactMetadata(metadata || {}),
      });

      return { hold, summary: this.getSummary() };
    });
  }

  async releaseSpend({ holdId, reason = "", metadata = {} } = {}) {
    return this.mutate(async () => {
      const normalizedHoldId = String(holdId || "").trim();
      if (!normalizedHoldId) {
        throw buildHttpError("holdId is required.", 400);
      }

      const hold = this.ledger.holds.find((entry) => entry.id === normalizedHoldId);
      if (!hold) {
        throw buildHttpError("Wallet hold was not found.", 404);
      }

      if (hold.status === "released") {
        return { hold, summary: this.getSummary() };
      }

      if (hold.status !== "held") {
        throw buildHttpError(`Wallet hold cannot be released from status ${hold.status}.`, 400);
      }

      const releasedCents = Number(hold.remainingCents ?? hold.amountCents ?? 0);
      hold.remainingCents = 0;
      hold.status = "released";
      hold.releasedAt = this.now();
      hold.updatedAt = hold.releasedAt;
      hold.releaseReason = String(reason || "").trim();
      this.createEvent("spend.released", {
        action: hold.action,
        amountCents: releasedCents,
        buildingId: hold.buildingId,
        description: hold.description,
        holdId: hold.id,
        metadata: compactMetadata(metadata || {}),
        reason: hold.releaseReason,
      });

      return { hold, summary: this.getSummary() };
    });
  }
}

export const testInternals = {
  compactMetadata,
  normalizeCents,
};
