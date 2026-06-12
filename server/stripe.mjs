// Stripe integration with two modes:
//   - "live": real Stripe Checkout + webhook signature verification, used when
//     a real sk_test_/sk_live_ key is provided.
//   - "stub": no network — Checkout resolves to a local mock page and webhooks
//     are accepted as plain JSON, so the FULL payment flow is testable end to
//     end without any keys. Switches automatically (see config.mjs).
import crypto from "node:crypto";
import StripeLib from "stripe";
import { config } from "./config.mjs";

let client = null;
function stripe() {
  if (!client) {
    client = new StripeLib(config.stripe.secretKey, {
      apiVersion: config.stripe.apiVersion,
      maxNetworkRetries: 1,
      timeout: 15_000,
    });
  }
  return client;
}

export const isStub = () => config.stripe.mode !== "live";
const id = (p) => `${p}_${crypto.randomBytes(12).toString("hex")}`;

/**
 * Create a Checkout Session to charge an advertiser for a campaign's budget.
 * Returns { id, url } — the URL the browser is sent to.
 */
export async function createCheckout({ campaign, amountUsd, successUrl, cancelUrl }) {
  const amountCents = Math.round(Number(amountUsd) * 100);
  if (isStub()) {
    const sessionId = id("cs_stub");
    return {
      id: sessionId,
      url: `${successUrl.split("?")[0].replace(/\/[^/]*$/, "")}/mock-checkout?session=${sessionId}&campaign=${encodeURIComponent(campaign.id)}&amount=${amountCents}&success=${encodeURIComponent(successUrl)}&cancel=${encodeURIComponent(cancelUrl)}`,
    };
  }
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: config.stripe.currency,
          product_data: {
            name: `Kolex ad: ${campaign.brand}`,
            description: `${campaign.blocks} block(s) × $${campaign.bidPerBlock}/1,000 impressions`,
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    metadata: { campaignId: campaign.id, kind: "ad_budget" },
    payment_intent_data: { metadata: { campaignId: campaign.id } },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return { id: session.id, url: session.url };
}

/**
 * Verify and parse an incoming webhook. Live mode checks the Stripe signature;
 * stub mode accepts local JSON. Returns the event object or throws.
 */
export function verifyWebhook(rawBody, signature) {
  if (isStub()) {
    const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    return JSON.parse(body);
  }
  if (!config.stripe.webhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  }
  return stripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

/**
 * Pay out a user's accrued balance. Stub mode records it as paid. Live mode
 * requires Stripe Connect (a connected account / external destination); when
 * that isn't configured we record the request as "queued" rather than
 * silently dropping it.
 */
export async function createPayout({ amountUsd, email, destination }) {
  const amountCents = Math.round(Number(amountUsd) * 100);
  if (isStub()) {
    return { id: id("po_stub"), status: "paid", amountCents };
  }
  if (config.stripe.enablePayouts && destination) {
    // Move funds from the platform balance to the earner's connected account.
    // Their Express account then auto-pays out to their bank.
    const transfer = await stripe().transfers.create({
      amount: amountCents,
      currency: config.stripe.currency,
      destination,
      metadata: { email },
    });
    return { id: transfer.id, status: "paid", amountCents };
  }
  // No Connect destination configured — record for manual/queued settlement.
  return { id: id("po_queued"), status: "queued", amountCents };
}

// ── Stripe Connect (Express) onboarding so earners can actually receive money ──

/**
 * Create a connected account for an earner. Earners only *receive* their ad
 * revenue share — they're not merchants — so we use the lightweight Stripe
 * **recipient** service agreement and an `individual` profile. That strips the
 * onboarding down to the identity check Stripe legally needs to pay someone
 * (name, DOB, address, bank), with no "business website / what do you sell?"
 * questions. We also pre-fill the business profile to Kolex so even the
 * minimal flow never prompts the earner for a website.
 */
export async function createConnectAccount({ email }) {
  if (isStub()) return { id: id("acct_stub") };
  const account = await stripe().accounts.create({
    type: "express",
    email,
    business_type: "individual",
    capabilities: { transfers: { requested: true } },
    // Receive-only: no charges, lighter KYC than a full merchant.
    tos_acceptance: { service_agreement: "recipient" },
    business_profile: {
      url: config.siteBase || "https://kolex.ai",
      product_description: "Ad revenue share payouts from Kolex.",
    },
    metadata: { kolex: "earner" },
  });
  return { id: account.id };
}

/** Onboarding link the earner completes to enable payouts. Stub → mock page. */
export async function createAccountLink({ accountId, returnUrl, refreshUrl }) {
  if (isStub()) {
    const root = returnUrl.split("?")[0].replace(/\/[^/]*$/, "");
    return {
      url: `${root}/mock-connect?account=${encodeURIComponent(accountId)}&return=${encodeURIComponent(returnUrl)}`,
    };
  }
  const link = await stripe().accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    return_url: returnUrl,
    refresh_url: refreshUrl,
    // Only ask for what's needed to enable payouts right now — don't front-load
    // "eventually due" fields the earner doesn't need yet.
    collection_options: { fields: "currently_due", future_requirements: "omit" },
  });
  return { url: link.url };
}

/** Whether a connected account can receive transfers yet (live only). */
export async function getAccountStatus(accountId) {
  if (isStub()) return { payoutsEnabled: true };
  const a = await stripe().accounts.retrieve(accountId);
  return { payoutsEnabled: !!a.payouts_enabled && a.capabilities?.transfers === "active" };
}

export function stripeStatus() {
  return {
    mode: config.stripe.mode,
    currency: config.stripe.currency,
    publishableKey: config.stripe.publishableKey || null,
    payoutsEnabled: config.stripe.enablePayouts,
    webhookConfigured: isStub() ? true : !!config.stripe.webhookSecret,
  };
}
