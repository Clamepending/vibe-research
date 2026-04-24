---
id: connect-stripe
title: Connect Stripe for payments
buildingId: wallet
summary: Wire up Stripe so agents can authorize spend from the Wallet building.
priority: normal
order: 30
---

# Connect Stripe for payments

The Wallet building uses Stripe to hold a payment method agents can draw against. You can run entirely in test mode while you are figuring things out — no real money moves until you swap the keys.

## 1. Create a Stripe account (or open test mode)

Sign up at [stripe.com](https://stripe.com). If you already have an account, open the **Developers** section of the dashboard and toggle to **Test mode** while you experiment. Test keys are clearly labeled `sk_test_...` and `whsec_...`.

## 2. Copy the secret key and webhook secret

In the Stripe dashboard open **Developers → API keys** and copy the **Secret key**. Then open **Developers → Webhooks**, create (or reveal) an endpoint, and copy the **Signing secret**. Keep both values in a password manager — never paste them into the Library or a chat.

## 3. Send them to Vibe Research

Either POST them to the setup endpoint:

```
POST /api/wallet/setup
{ "stripeSecretKey": "sk_test_...", "stripeWebhookSecret": "whsec_..." }
```

Or open Settings and paste the values into the **Stripe secret key** and **Stripe webhook secret** fields. The corresponding settings keys are `walletStripeSecretKey` and `walletStripeWebhookSecret`.

## 4. Point your webhook at this host

In the Stripe dashboard, set the webhook endpoint URL to your Vibe Research host (for example `https://<your-tailscale-host>/api/wallet/webhook`). Pick the `payment_intent.*` and `charge.*` events at minimum.

## 5. Switch to live when you are ready

When you are ready for real charges, repeat steps 2–4 with live-mode keys. Everything else stays the same.
