import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVibeResearchApp } from "../src/create-app.js";
import { WalletService } from "../src/wallet-service.js";

test("WalletService grants credits, reserves spend, captures, and releases holds", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-wallet-"));
  const wallet = new WalletService({ stateDir });

  try {
    await wallet.initialize();
    await wallet.grantCredits({ amountCents: 1000, description: "test credit" });
    const held = await wallet.createSpendHold({
      action: "send-sms",
      amountCents: 250,
      buildingId: "twilio",
      description: "SMS estimate",
    });

    assert.equal(held.summary.availableCents, 750);
    assert.equal(held.summary.heldCents, 250);

    const captured = await wallet.captureSpend({
      amountCents: 180,
      description: "actual SMS spend",
      holdId: held.hold.id,
    });
    assert.equal(captured.summary.availableCents, 820);
    assert.equal(captured.summary.spentCents, 180);
    assert.equal(captured.summary.heldCents, 0);

    const secondHold = await wallet.createSpendHold({
      amountCents: 100,
      buildingId: "twilio",
      idempotencyKey: "same-sms",
    });
    const idempotentHold = await wallet.createSpendHold({
      amountCents: 100,
      buildingId: "twilio",
      idempotencyKey: "same-sms",
    });
    assert.equal(idempotentHold.hold.id, secondHold.hold.id);

    const released = await wallet.releaseSpend({ holdId: secondHold.hold.id, reason: "send failed" });
    assert.equal(released.summary.availableCents, 820);
    assert.equal(released.summary.heldCents, 0);

    await assert.rejects(
      () => wallet.createSpendHold({ amountCents: 10_000, buildingId: "twilio" }),
      /Insufficient wallet credits/,
    );

    const stored = JSON.parse(await readFile(path.join(stateDir, "wallet-ledger.json"), "utf8"));
    assert.equal(stored.version, 1);
    assert.ok(stored.events.some((event) => event.type === "spend.captured"));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("wallet API exposes grant, hold, capture, and release operations", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-wallet-api-"));
  let appContext = null;

  try {
    appContext = await createVibeResearchApp({
      cwd: workspaceDir,
      port: 0,
      persistSessions: false,
      persistentTerminals: false,
      stateDir: path.join(workspaceDir, ".vibe-research"),
      providers: [
        {
          id: "shell",
          label: "Shell",
          available: true,
          defaultName: "Shell",
        },
      ],
      systemMetricsSampleIntervalMs: 0,
    });
    const baseUrl = `http://127.0.0.1:${appContext.config.port}`;

    const grantResponse = await fetch(`${baseUrl}/api/wallet/credits/grant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: 500, description: "test" }),
    });
    assert.equal(grantResponse.status, 201);
    const grantPayload = await grantResponse.json();
    assert.equal(grantPayload.summary.availableCents, 500);

    const holdResponse = await fetch(`${baseUrl}/api/wallet/spend/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: 125, buildingId: "twilio", action: "send-sms" }),
    });
    assert.equal(holdResponse.status, 201);
    const holdPayload = await holdResponse.json();
    assert.equal(holdPayload.summary.heldCents, 125);

    const captureResponse = await fetch(`${baseUrl}/api/wallet/spend/holds/${holdPayload.hold.id}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: 125 }),
    });
    assert.equal(captureResponse.status, 200);
    const capturePayload = await captureResponse.json();
    assert.equal(capturePayload.summary.spentCents, 125);
    assert.equal(capturePayload.settings.walletStatus.availableCents, 375);
  } finally {
    await appContext?.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("wallet Stripe checkout endpoint creates sessions and webhook grants credits", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-wallet-stripe-"));
  const stripeCalls = [];
  let appContext = null;

  try {
    appContext = await createVibeResearchApp({
      cwd: workspaceDir,
      port: 0,
      persistSessions: false,
      persistentTerminals: false,
      stateDir: path.join(workspaceDir, ".vibe-research"),
      providers: [
        {
          id: "shell",
          label: "Shell",
          available: true,
          defaultName: "Shell",
        },
      ],
      stripeFetchImpl: async (url, options = {}) => {
        stripeCalls.push({ url: String(url), options });
        return new Response(JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.test/session" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      },
      systemMetricsSampleIntervalMs: 0,
    });
    const baseUrl = `http://127.0.0.1:${appContext.config.port}`;

    const setupResponse = await fetch(`${baseUrl}/api/wallet/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stripeSecretKey: "sk_test_secret",
        stripeWebhookSecret: "whsec_test",
      }),
    });
    assert.equal(setupResponse.status, 200);
    const setupPayload = await setupResponse.json();
    assert.equal(setupPayload.settings.walletStripeSecretKey, "");
    assert.equal(setupPayload.settings.walletStripeSecretKeyConfigured, true);
    assert.equal(setupPayload.settings.walletStripeWebhookSecret, "");
    assert.equal(setupPayload.settings.walletStripeWebhookSecretConfigured, true);

    const checkoutResponse = await fetch(`${baseUrl}/api/wallet/checkout-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: 1500 }),
    });
    assert.equal(checkoutResponse.status, 201);
    const checkoutPayload = await checkoutResponse.json();
    assert.equal(checkoutPayload.checkoutSession.url, "https://checkout.stripe.test/session");
    assert.equal(stripeCalls[0].url, "https://api.stripe.com/v1/checkout/sessions");
    assert.equal(stripeCalls[0].options.headers.Authorization, "Bearer sk_test_secret");
    assert.equal(stripeCalls[0].options.headers["Stripe-Version"], "2026-02-25.clover");
    const stripeBody = new URLSearchParams(stripeCalls[0].options.body);
    assert.equal(stripeBody.get("mode"), "payment");
    assert.equal(stripeBody.get("line_items[0][price_data][unit_amount]"), "1500");
    assert.equal(stripeBody.get("metadata[walletCreditCents]"), "1500");

    const event = {
      id: "evt_checkout_completed",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          amount_total: 1500,
          metadata: { walletCreditCents: "1500" },
          payment_status: "paid",
        },
      },
    };
    const rawEvent = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", "whsec_test").update(`${timestamp}.${rawEvent}`).digest("hex");
    const webhookResponse = await fetch(`${baseUrl}/api/wallet/stripe/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": `t=${timestamp},v1=${signature}`,
      },
      body: rawEvent,
    });
    assert.equal(webhookResponse.status, 200);

    const summaryResponse = await fetch(`${baseUrl}/api/wallet/summary`);
    const summaryPayload = await summaryResponse.json();
    assert.equal(summaryPayload.wallet.availableCents, 1500);
    assert.ok(summaryPayload.wallet.events.some((entry) => entry.source === "stripe_checkout"));
  } finally {
    await appContext?.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
