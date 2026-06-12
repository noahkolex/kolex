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
 * revenue share, so we use an `individual` profile and pre-fill the entire
 * business profile (industry code + url + product description) on Kolex's
 * behalf. That removes the "what do you sell / your website" steps, leaving
 * only the identity + bank details Stripe legally needs to pay someone.
 *
 * NOTE: Stripe's lighter "recipient" service agreement is NOT used — it's only
 * valid for cross-border payouts (platform and recipient in different
 * countries), and a US platform paying US earners must use the standard
 * agreement. Pre-filling the business profile is what trims the flow instead.
 */
export async function createConnectAccount({ email }) {
  if (isStub()) return { id: id("acct_stub") };
  const account = await stripe().accounts.create({
    type: "express",
    email,
    business_type: "individual",
    capabilities: { transfers: { requested: true } },
    // Pre-fill EVERYTHING about "the business" so the earner is never asked:
    // url + product description + an industry code (mcc). Without the mcc,
    // Stripe still shows a "what do you sell?" step.
    business_profile: {
      mcc: "7311", // advertising services
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

/**
 * Map Stripe's machine requirement keys to the plain-English things a person
 * actually has to provide, deduped. (Stripe lists granular fields like
 * `individual.dob.year`; the user just needs to know "Date of birth".)
 */
export function friendlyRequirements(keys = []) {
  const out = new Set();
  for (const k of keys) {
    if (k.startsWith("external_account")) out.add("Bank account or debit card");
    else if (/tos_acceptance/.test(k)) out.add("Accept Stripe's terms of service");
    else if (/(first_name|last_name|representative|relationship)/.test(k)) out.add("Representative's name");
    else if (/\.dob\b|\.dob\./.test(k)) out.add("Date of birth");
    else if (/address/.test(k)) out.add("Home address");
    else if (/(ssn|id_number)/.test(k)) out.add("SSN / tax ID");
    else if (/verification\.document/.test(k)) out.add("Photo ID");
    else if (/verification\.additional_document/.test(k)) out.add("Additional ID document");
    else if (/phone|email/.test(k)) out.add("Contact details");
    else if (/business_profile|company/.test(k)) out.add("Business details");
    else out.add(k.replace(/[._]/g, " ")); // fall back to a readable version
  }
  return [...out];
}

/**
 * Rich status of a connected account (live only). Reports whether payouts are
 * truly enabled, plus the exact info Stripe still needs and any restriction
 * reason — so the portal can show the user precisely what's blocking them.
 */
export async function getAccountStatus(accountId) {
  if (isStub()) {
    return { payoutsEnabled: true, requirements: [], disabledReason: null, detailsSubmitted: true };
  }
  const a = await stripe().accounts.retrieve(accountId);
  const req = a.requirements || {};
  const due = [...new Set([...(req.currently_due || []), ...(req.past_due || []), ...(req.errors?.map((e) => e.requirement) || [])])];
  const transfersActive = a.capabilities?.transfers === "active";
  return {
    // Truly ready only when Stripe will actually release payouts AND we can
    // transfer to the account. (Not loosened — a restricted account is NOT ready.)
    payoutsEnabled: !!a.payouts_enabled && transfersActive,
    requirements: friendlyRequirements(due),
    disabledReason: req.disabled_reason || null,
    detailsSubmitted: !!a.details_submitted,
  };
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
