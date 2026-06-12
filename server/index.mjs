import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, publicBase } from "./config.mjs";
import { load, save, reset, init, close, flush, dbPath, stats } from "./db.mjs";
import {
  configAds,
  leaderboard,
  ingestEvents,
  liveCampaigns,
} from "./auction.mjs";
import { IMPRESSIONS_PER_BLOCK, MIN_BID_PER_BLOCK, fmtUsd } from "./economics.mjs";
import {
  authenticate,
  validatePassword,
  createSession,
  sessionFromReq,
  requireKind,
  createPasswordReset,
  consumePasswordReset,
  changePassword,
  newId,
} from "./auth.mjs";
import { sendEmail, passwordResetEmail } from "./mailer.mjs";
import { capture, publicAnalyticsConfig } from "./analytics.mjs";
import {
  createCheckout,
  verifyWebhook,
  createPayout,
  createConnectAccount,
  createAccountLink,
  getAccountStatus,
  stripeStatus,
  isStub,
} from "./stripe.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(DIR, "..", "web");

const app = express();
app.disable("x-powered-by");

// The Stripe webhook needs the RAW body for signature verification, so it is
// mounted BEFORE express.json() (which would otherwise consume the stream).
app.post("/webhooks/stripe", express.raw({ type: "*/*" }), async (req, res) => {
  let event;
  try {
    event = verifyWebhook(req.body, req.headers["stripe-signature"]);
  } catch (err) {
    return res.status(400).json({ error: `webhook signature failed: ${err.message}` });
  }
  applyStripeEvent(event);
  await flush(); // make the campaign activation durable before ack'ing Stripe
  res.json({ received: true });
});

app.use(express.json({ limit: "256kb" }));

// Durability seam: make every JSON response wait for pending writes to land in
// the store first. No-op for the file backend (writes are synchronous); for
// Postgres it awaits the ordered write queue, so a client never sees "ok"
// before its mutation is durable. Keeps endpoint code free of await save().
app.use((_req, res, next) => {
  const orig = res.json.bind(res);
  res.json = (body) => {
    Promise.resolve(flush()).then(
      () => orig(body),
      () => orig(body),
    );
    return res;
  };
  next();
});

// CORS — the extension and any origin can hit the public API.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "content-type, authorization, x-kolex-device");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Lightweight in-memory rate limiter (fixed window per IP) — blunts abuse of
// the unauthenticated endpoints. The hard money cap is the per-campaign
// budget (see auction.mjs); this is defense-in-depth.
const rlBuckets = new Map();
// On in production by default; opt in/out anywhere with KOLEX_RATE_LIMIT.
const rateLimitOn = process.env.KOLEX_RATE_LIMIT
  ? /^(1|true|on|yes)$/i.test(process.env.KOLEX_RATE_LIMIT)
  : config.isProd;
function rateLimit({ windowMs, max, key }) {
  if (!rateLimitOn) return (_req, _res, next) => next();
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";
    const bucketKey = `${key}:${ip}`;
    const now = Date.now();
    let b = rlBuckets.get(bucketKey);
    if (!b || now - b.start > windowMs) {
      b = { start: now, count: 0 };
      rlBuckets.set(bucketKey, b);
    }
    if (++b.count > max) return res.status(429).json({ error: "too many requests" });
    next();
  };
}
const eventsLimiter = rateLimit({ windowMs: 60_000, max: 600, key: "events" });
const loginLimiter = rateLimit({ windowMs: 60_000, max: 30, key: "login" });
const adsLimiter = rateLimit({ windowMs: 60_000, max: 30, key: "ads" });
const clickLimiter = rateLimit({ windowMs: 60_000, max: 300, key: "click" });

// ─────────────────────────── Extension API (/v1) ───────────────────────────

app.get("/v1/config", (_req, res) => {
  res.json({ ads: configAds(), sites: [], killswitch: false });
});

app.get("/v1/killswitch", (_req, res) => res.json({ disabled: false }));

// Health check (Railway / uptime probes).
app.get("/healthz", (_req, res) => res.json({ ok: true, stripe: config.stripe.mode }));

/**
 * Balance for a device. If it's linked to an account, returns the ACCOUNT's
 * total across ALL its linked devices — so earnings survive an extension
 * reinstall / new browser (the dollars belong to you, not to one device id).
 * Unlinked devices see just their own accruing balance.
 */
function balanceForDevice(db, deviceId) {
  const dev = typeof deviceId === "string" ? db.devices.find((d) => d.deviceId === deviceId) : null;
  let pendingUsd = 0,
    settledUsd = 0,
    linked = false;
  if (dev?.userId) {
    linked = true;
    for (const d of db.devices) {
      if (d.userId !== dev.userId) continue;
      const e = db.earnings[d.deviceId];
      if (e) {
        pendingUsd += e.pendingUsd || 0;
        settledUsd += e.paidUsd || 0;
      }
    }
  } else {
    const e = (typeof deviceId === "string" && db.earnings[deviceId]) || {};
    pendingUsd = e.pendingUsd || 0;
    settledUsd = e.paidUsd || 0;
  }
  return { pendingUsd, settledUsd, linked, minPayoutUsd: config.minPayoutUsd };
}

app.post("/v1/events", eventsLimiter, (req, res) => {
  const deviceId = req.headers["x-kolex-device"];
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  if (typeof deviceId !== "string" || !deviceId) {
    return res.status(400).json({ error: "missing device" });
  }
  const accepted = ingestEvents(events, deviceId);
  // Return the balance in the SAME response so the extension has one real-time
  // source of truth (no separate round-trip).
  res.json({ accepted, ...balanceForDevice(load(), deviceId) });
});

app.get("/v1/balance", (req, res) => {
  res.json(balanceForDevice(load(), req.headers["x-kolex-device"]));
});

// Whether this device has been linked to an account (so the popup can show
// "connected as …" instead of nagging the user to sign in again).
app.get("/v1/link-status", (req, res) => {
  const deviceId = req.headers["x-kolex-device"];
  const db = load();
  const dev = typeof deviceId === "string"
    ? db.devices.find((d) => d.deviceId === deviceId && d.userId)
    : null;
  const email = dev ? db.users.find((u) => u.id === dev.userId)?.email ?? null : null;
  res.json({ linked: !!email, email });
});

app.post("/v1/auth/device", (req, res) => {
  const db = load();
  const deviceId = req.headers["x-kolex-device"];
  const code = newId("dc").slice(3, 11).toUpperCase();
  db.devices.push({ deviceId, deviceCode: code, authorized: false, userId: null, token: null });
  save();
  res.json({ deviceCode: code, verificationUrl: `${publicBase(req)}/portal?code=${code}`, interval: 3 });
});

app.post("/v1/auth/device/poll", (req, res) => {
  const db = load();
  const dev = db.devices.find((d) => d.deviceCode === req.body?.deviceCode);
  if (dev && dev.authorized && dev.token) return res.json({ token: dev.token });
  res.json({ pending: true });
});

// Click redirect — record the click, then bounce to the advertiser.
app.get("/r/:adId", clickLimiter, (req, res) => {
  const db = load();
  const campaign = db.campaigns.find((c) => c.id === req.params.adId);
  const deviceId = typeof req.query.d === "string" ? req.query.d : "";
  if (campaign) {
    ingestEvents([{ id: newId("clk"), type: "click", adId: campaign.id, surface: "redirect" }], deviceId);
    return res.redirect(302, campaign.url);
  }
  res.redirect(302, config.siteBase || "https://kolex.ai");
});

// ─────────────────────────── Website API (/api) ────────────────────────────

/** Mask an email for the public activity feed: noah@gmail.com → n****@gmail.com */
function anonEmail(email) {
  if (typeof email !== "string" || !email.includes("@")) return "someone";
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}****@${domain}`;
}

app.get("/api/stripe-config", (_req, res) => res.json(stripeStatus()));

// Public PostHog config so the website + extension can capture to the same
// project. Null key → analytics disabled everywhere.
app.get("/api/analytics-config", (_req, res) => res.json(publicAnalyticsConfig()));

// Real activity + totals (no fabricated data). Empty on a fresh deployment.
app.get("/api/activity", (_req, res) => {
  const db = load();
  const paidOutUsd = db.payouts
    .filter((p) => p.status === "paid")
    .reduce((s, p) => s + p.amountUsd, 0);
  const pendingUsd = Object.values(db.earnings).reduce((s, e) => s + (e.pendingUsd || 0), 0);
  const byNewest = (a, b) => (b.at || 0) - (a.at || 0);
  const payoutEvents = db.payouts
    .map((p) => ({
      type: "payout",
      amountUsd: p.amountUsd,
      status: p.status,
      email: anonEmail(db.users.find((u) => u.id === p.userId)?.email),
      at: p.createdAt,
    }))
    .sort(byNewest);
  const launchEvents = db.campaigns
    .filter((c) => c.status === "active")
    .map((c) => ({ type: "launch", brand: c.brand, bidPerBlock: c.bidPerBlock, at: c.payment?.paidAt || c.createdAt }))
    .sort(byNewest);
  // People EARNING (watching ads), not just cashing out.
  const earnEvents = (db.recentEarnings || [])
    .map((e) => ({
      type: "earn",
      amountUsd: e.amountUsd,
      email: anonEmail(
        db.users.find((u) => u.id === db.devices.find((d) => d.deviceId === e.deviceId)?.userId)?.email,
      ),
      at: e.at,
    }))
    .sort(byNewest);
  // Mix all three, newest first — guarantee each kind surfaces (a flood of one
  // can't crowd out the others).
  const recent = [...payoutEvents.slice(0, 8), ...earnEvents.slice(0, 12), ...launchEvents.slice(0, 6)]
    .sort(byNewest)
    .slice(0, 20);
  res.json({
    totals: {
      paidOutUsd,
      pendingUsd,
      earners: Object.keys(db.earnings).length,
      advertisers: db.advertisers.length,
      liveCampaigns: liveCampaigns().length,
    },
    recent,
  });
});

app.get("/api/auction", (_req, res) => {
  const board = leaderboard();
  res.json({
    leaderboard: board,
    stats: {
      campaigns: board.length,
      liveCampaigns: liveCampaigns().length,
      topBid: board[0]?.bidPerBlock ?? 0,
      totalSpendUsd: board.reduce((s, c) => s + c.spendUsd, 0),
    },
  });
});

// Quick ad submission. Creates a PENDING campaign and a Stripe Checkout
// Session for its budget; the campaign goes live when payment completes
// (webhook). Returns the checkout URL the browser should be sent to.
app.post("/api/ads", adsLimiter, async (req, res) => {
  const b = req.body ?? {};
  const errors = validateAd(b);
  if (errors.length) return res.status(400).json({ errors });

  // Authenticate (or create) the advertiser account with email + password.
  let advertiser;
  try {
    advertiser = authenticate("advertiser", String(b.email).toLowerCase().trim(), String(b.password ?? "")).account;
  } catch (e) {
    return res.status(e.status || 401).json({ errors: [e.error || "Sign in failed."] });
  }
  const db = load();
  const blocks = Math.max(1, Math.floor(Number(b.blocks)));
  const bidPerBlock = Number(b.bidPerBlock);
  const amountUsd = blocks * bidPerBlock;
  const campaign = {
    id: newId("cmp"),
    advertiserId: advertiser.id,
    brand: String(b.brand).trim().slice(0, 40),
    text: String(b.text).trim().slice(0, 60),
    url: String(b.url).trim(),
    iconDataUrl: typeof b.iconDataUrl === "string" ? b.iconDataUrl : undefined,
    accent: typeof b.accent === "string" ? b.accent : "#1547F5",
    bidPerBlock,
    blocks,
    impressionsRemaining: blocks * IMPRESSIONS_PER_BLOCK,
    impressions: 0,
    clicks: 0,
    spendUsd: 0,
    status: "pending",
    createdAt: Date.now(),
    payment: { status: "unpaid", amountUsd, checkoutId: null, paidAt: null },
  };
  db.campaigns.push(campaign);
  await save();

  const base = publicBase(req);
  const token = createSession("advertiser", advertiser);
  let checkout;
  try {
    checkout = await createCheckout({
      campaign,
      amountUsd,
      successUrl: `${base}/advertiser?paid=1&campaign=${campaign.id}`,
      cancelUrl: `${base}/advertise?canceled=1`,
    });
  } catch (err) {
    return res.status(502).json({ errors: [`Payment setup failed: ${err.message}`] });
  }
  campaign.payment.checkoutId = checkout.id;
  await save();
  capture("campaign_created", {
    distinctId: advertiser.email,
    properties: { brand: campaign.brand, amountUsd, bidPerBlock, blocks, campaignId: campaign.id },
  });

  res.json({
    campaign,
    checkoutUrl: checkout.url,
    amountUsd,
    impressions: blocks * IMPRESSIONS_PER_BLOCK,
    token,
  });
});

// Stub-only: the mock checkout page calls this to "complete" payment, which
// runs the exact same activation path as a real Stripe webhook.
app.post("/api/stub/complete-checkout", (req, res) => {
  if (!isStub()) return res.status(404).json({ error: "not available" });
  const campaignId = String(req.body?.campaignId ?? "");
  applyStripeEvent({
    id: newId("evt_stub"),
    type: "checkout.session.completed",
    data: { object: { id: req.body?.session ?? newId("cs"), metadata: { campaignId } } },
  });
  res.json({ ok: true });
});

// Sign in or create an account (email + password). One endpoint: existing
// email requires the correct password; a new email creates the account.
app.post("/api/auth", loginLimiter, (req, res) => {
  const email = String(req.body?.email ?? "").toLowerCase().trim();
  const password = String(req.body?.password ?? "");
  const kind = req.body?.kind === "advertiser" ? "advertiser" : "user";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email." });
  }
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  let result;
  try {
    result = authenticate(kind, email, password);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.error || "Authentication failed." });
  }
  capture(result.created ? "account_created" : "signed_in", { distinctId: email, properties: { kind } });
  res.json({ token: createSession(kind, result.account), email, kind, created: result.created });
});

// Request a password reset. Always 200 (never reveals whether the email is
// registered). The reset link is logged server-side; outside production it is
// also returned in the response so the flow is testable without an email
// provider wired up.
app.post("/api/auth/forgot", loginLimiter, async (req, res) => {
  const email = String(req.body?.email ?? "").toLowerCase().trim();
  const kind = req.body?.kind === "advertiser" ? "advertiser" : "user";
  const generic = { ok: true, message: "If that account exists, a reset link is on its way." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.json(generic);
  const reset = createPasswordReset(kind, email);
  if (!reset) return res.json(generic); // unknown email: identical response
  const resetUrl = `${publicBase(req)}/reset?token=${reset.token}&kind=${kind}`;

  // Actually email the link when a provider is configured; otherwise log it.
  let delivered = false;
  try {
    const msg = passwordResetEmail(resetUrl);
    ({ delivered } = await sendEmail({ to: email, ...msg }));
  } catch (err) {
    console.error(`[kolex] reset email failed for ${email}: ${err.message}`);
  }
  if (!delivered) console.log(`[kolex] password reset for ${email} (${kind}): ${resetUrl}`);

  // Only surface the link in the response when it was NOT emailed and we're not
  // in production — i.e. local/stub testing without an email provider.
  res.json(!delivered && !config.isProd ? { ...generic, resetUrl } : generic);
});

// Complete a password reset with the token from the link. Logs the user in.
app.post("/api/auth/reset", loginLimiter, (req, res) => {
  const tokenStr = String(req.body?.token ?? "");
  const password = String(req.body?.password ?? "");
  if (!tokenStr) return res.status(400).json({ error: "Missing reset token." });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  let out;
  try {
    out = consumePasswordReset(tokenStr, password);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.error || "Reset failed." });
  }
  // Auto-login with a fresh session so the user lands signed in.
  const token = createSession(out.kind, out.account);
  res.json({ token, email: out.account.email, kind: out.kind });
});

// Change password while signed in (advertiser or earner). Verifies the current
// password; the active session stays valid.
app.post("/api/auth/change-password", loginLimiter, (req, res) => {
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ error: "not signed in" });
  const current = String(req.body?.currentPassword ?? "");
  const next = String(req.body?.newPassword ?? "");
  const pwErr = validatePassword(next);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    changePassword(s.kind, s.id, current, next);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.error || "Couldn't change password." });
  }
  res.json({ ok: true });
});

// Validate a session (frontend uses this to know who is logged in).
app.get("/api/me", (req, res) => {
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ error: "not signed in" });
  res.json({ email: s.email, kind: s.kind });
});

app.get("/api/advertiser/campaigns", requireKind("advertiser"), (req, res) => {
  const db = load();
  const mine = db.campaigns.filter((c) => c.advertiserId === req.session.id);
  res.json({
    email: req.session.email,
    campaigns: mine,
    totalSpendUsd: mine.reduce((s, c) => s + c.spendUsd, 0),
  });
});

// Re-create a checkout for a still-unpaid campaign.
app.post("/api/advertiser/campaigns/:id/checkout", requireKind("advertiser"), async (req, res) => {
  const db = load();
  const campaign = db.campaigns.find(
    (c) => c.id === req.params.id && c.advertiserId === req.session.id,
  );
  if (!campaign) return res.status(404).json({ error: "campaign not found" });
  if (campaign.status === "active") return res.status(400).json({ error: "already paid" });
  const base = publicBase(req);
  try {
    const checkout = await createCheckout({
      campaign,
      amountUsd: campaign.payment?.amountUsd ?? campaign.blocks * campaign.bidPerBlock,
      successUrl: `${base}/advertiser?paid=1&campaign=${campaign.id}`,
      cancelUrl: `${base}/advertiser?canceled=1`,
    });
    campaign.payment.checkoutId = checkout.id;
    save();
    res.json({ checkoutUrl: checkout.url });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// User portal: earnings summary across the account's linked devices.
app.get("/api/portal/summary", requireKind("user"), async (req, res) => {
  const db = load();
  const me = db.users.find((u) => u.id === req.session.id);
  // Live mode: ALWAYS reflect Stripe's current view of the account, so a
  // restriction (missing bank / ToS / name) shows up immediately and a
  // previously-"ready" account flips back if Stripe pauses it.
  let payout = {
    hasAccount: !!me?.stripeAccountId,
    ready: !!me?.payoutsReady,
    requirements: [],
    disabledReason: null,
  };
  if (me?.stripeAccountId) {
    try {
      const st = await getAccountStatus(me.stripeAccountId);
      payout = {
        hasAccount: true,
        ready: st.payoutsEnabled,
        requirements: st.requirements || [],
        disabledReason: st.disabledReason || null,
      };
      if (me.payoutsReady !== st.payoutsEnabled) {
        me.payoutsReady = st.payoutsEnabled;
        await save();
      }
      if (!st.payoutsEnabled && (st.requirements?.length || st.disabledReason)) {
        capture("payouts_restricted", {
          distinctId: me.email,
          properties: { requirements: st.requirements, disabledReason: st.disabledReason },
        });
      }
    } catch {
      /* Stripe unreachable: keep the stored flag, no requirement detail. */
    }
  }
  const devices = db.devices.filter((d) => d.userId === req.session.id);
  let impressions = 0, clicks = 0, pendingUsd = 0, paidUsd = 0;
  for (const dev of devices) {
    const e = db.earnings[dev.deviceId];
    if (e) {
      impressions += e.impressions;
      clicks += e.clicks;
      pendingUsd += e.pendingUsd;
      paidUsd += e.paidUsd;
    }
  }
  res.json({
    email: req.session.email,
    devices: devices.map((d) => d.deviceId),
    impressions,
    clicks,
    pendingUsd,
    paidUsd,
    minPayoutUsd: config.minPayoutUsd,
    payoutMethod: me?.stripeAccountId ? "stripe" : null,
    payoutsReady: payout.ready,
    payout, // { hasAccount, ready, requirements:[…], disabledReason }
    payouts: db.payouts.filter((p) => p.userId === req.session.id),
  });
});

// Start (or resume) Stripe Connect onboarding so this earner can receive money.
// Returns an onboarding URL to redirect the browser to. Stub → instant mock.
app.post("/api/portal/connect", requireKind("user"), async (req, res) => {
  const db = load();
  const me = db.users.find((u) => u.id === req.session.id);
  if (!me) return res.status(404).json({ error: "account not found" });
  try {
    // Reuse the existing connected account and RESUME its onboarding. (Never
    // mint a new one on retry — that would discard an account the user already
    // finished onboarding and leave them stuck on "Set up payouts".)
    if (!me.stripeAccountId) {
      const acct = await createConnectAccount({ email: me.email });
      me.stripeAccountId = acct.id;
      me.payoutsReady = false;
      await save();
    }
    const base = publicBase(req);
    let returnUrl, refreshUrl;
    try {
      // new URL validates the base — Stripe rejects a return/refresh URL that
      // isn't a proper absolute URL (the cause of "Not a valid URL").
      returnUrl = new URL("/portal?connected=1", base).toString();
      refreshUrl = new URL("/portal?connect=retry", base).toString();
    } catch {
      return res.status(500).json({
        error:
          "Payout setup needs a public site URL. Set SITE_BASE to your full https URL " +
          "(e.g. https://your-app.up.railway.app) and restart.",
      });
    }
    // Stripe Connect onboarding requires a public HTTPS URL (unlike Checkout,
    // which accepts http://localhost) — give a precise hint instead of Stripe's
    // opaque "Not a valid URL".
    if (!isStub() && !returnUrl.startsWith("https://")) {
      return res.status(500).json({
        error:
          "Stripe payout onboarding requires a public HTTPS URL — http://localhost won't work for Connect. " +
          "Deploy (Railway gives you one) or use a tunnel like ngrok, then set SITE_BASE to that https URL.",
      });
    }
    const link = await createAccountLink({ accountId: me.stripeAccountId, returnUrl, refreshUrl });
    capture("payout_connect_started", { distinctId: me.email });
    res.json({ url: link.url });
  } catch (err) {
    res.status(502).json({ error: `Couldn't start payout setup: ${err.message}` });
  }
});

// Stub-only: the mock onboarding page calls this to mark the earner ready,
// mirroring what completing real Stripe Connect onboarding would do.
app.post("/api/stub/complete-connect", requireKind("user"), (req, res) => {
  if (!isStub()) return res.status(404).json({ error: "not available" });
  const db = load();
  const me = db.users.find((u) => u.id === req.session.id);
  if (!me) return res.status(404).json({ error: "account not found" });
  if (!me.stripeAccountId) me.stripeAccountId = newId("acct_stub");
  me.payoutsReady = true;
  save();
  res.json({ ok: true });
});

// Stub-only: give a device a pending balance so payouts are testable instantly
// (no need to sit through real impressions to clear the minimum).
app.post("/api/stub/seed-earnings", (req, res) => {
  if (!isStub()) return res.status(404).json({ error: "not available" });
  const db = load();
  const deviceId = String(req.body?.deviceId ?? "").trim();
  const amountUsd = Math.max(0, Math.min(10_000, Number(req.body?.amountUsd) || 0));
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const e = (db.earnings[deviceId] ??= { impressions: 0, clicks: 0, pendingUsd: 0, paidUsd: 0 });
  e.pendingUsd += amountUsd;
  e.impressions += Math.round(amountUsd * 100); // plausible-looking counters
  save();
  res.json({ ok: true, deviceId, pendingUsd: e.pendingUsd });
});

// Link a device (from the extension "Cash out" flow) to the logged-in user.
app.post("/api/portal/link-device", requireKind("user"), (req, res) => {
  const db = load();
  const token = req.headers.authorization?.slice(7) ?? null;
  const deviceId = String(req.body?.deviceId ?? "").trim();
  const code = String(req.body?.deviceCode ?? "").trim();
  let dev = null;
  if (deviceId) {
    dev = db.devices.find((d) => d.deviceId === deviceId);
    if (!dev) {
      dev = { deviceId, deviceCode: null, authorized: true, userId: null, token: null };
      db.devices.push(dev);
    }
  } else if (code) {
    dev = db.devices.find((d) => d.deviceCode === code);
  }
  if (!dev) return res.status(404).json({ error: "device not found" });
  // A device already claimed by another account cannot be re-linked — that
  // would let anyone absorb a stranger's earnings by guessing a device id.
  if (dev.userId && dev.userId !== req.session.id) {
    return res.status(409).json({ error: "device is already linked to another account" });
  }
  dev.userId = req.session.id;
  dev.authorized = true;
  dev.token = token;
  save();
  res.json({ ok: true, deviceId: dev.deviceId });
});

// Per-user lock so concurrent payout requests can't double-spend the balance
// across the `await` to Stripe.
const payoutsInFlight = new Set();

app.post("/api/portal/payout", requireKind("user"), async (req, res) => {
  const userId = req.session.id;
  if (payoutsInFlight.has(userId)) {
    return res.status(409).json({ error: "a payout is already in progress" });
  }
  payoutsInFlight.add(userId);
  const db = load();
  const devices = db.devices.filter((d) => d.userId === userId);
  // Snapshot each device's pending so we can restore exactly on failure.
  const snapshot = devices
    .map((d) => ({ deviceId: d.deviceId, amt: db.earnings[d.deviceId]?.pendingUsd ?? 0 }))
    .filter((s) => s.amt > 0);
  const total = snapshot.reduce((s, x) => s + x.amt, 0);
  const me = db.users.find((u) => u.id === userId);
  try {
    if (!me?.payoutsReady) {
      return res.status(400).json({
        error: "Set up payouts before withdrawing.",
        needsConnect: true,
      });
    }
    if (total < config.minPayoutUsd) {
      return res.status(400).json({
        error: `Minimum payout is $${config.minPayoutUsd.toFixed(2)}. You have $${total.toFixed(2)}.`,
      });
    }
    // Deduct FIRST (before the await) so a concurrent request sees zero.
    for (const s of snapshot) db.earnings[s.deviceId].pendingUsd = 0;
    await save(); // durably record the deduction BEFORE moving any money

    let result;
    try {
      result = await createPayout({
        amountUsd: total,
        email: req.session.email,
        destination: me.stripeAccountId,
      });
    } catch (err) {
      // Restore the balance — the money never moved.
      for (const s of snapshot) db.earnings[s.deviceId].pendingUsd += s.amt;
      await save();
      let msg = err.message;
      if (err.code === "balance_insufficient" || /insufficient (available )?funds/i.test(err.message || "")) {
        msg =
          "Kolex's own Stripe balance doesn't have enough AVAILABLE funds to send this yet. " +
          "Advertiser payments sit as 'pending' for ~2 days before they're available to pay out. " +
          "(Test mode: add available balance instantly with the 4000000000000077 test card.)";
      }
      return res.status(502).json({ error: `Payout failed: ${msg}` });
    }

    // Only credit paidUsd when the transfer actually settled. A "queued"
    // payout (no Connect destination yet) is recorded as owed.
    if (result.status === "paid") {
      for (const s of snapshot) db.earnings[s.deviceId].paidUsd += s.amt;
    }
    const payout = {
      id: newId("pay"),
      userId,
      amountUsd: total,
      status: result.status,
      stripeId: result.id,
      createdAt: Date.now(),
    };
    db.payouts.push(payout);
    await save();
    capture("payout", {
      distinctId: req.session.email,
      properties: { amountUsd: total, status: result.status, payoutId: payout.id },
    });
    res.json({
      ok: true,
      paidUsd: result.status === "paid" ? total : 0,
      queuedUsd: result.status === "paid" ? 0 : total,
      payout,
    });
  } finally {
    payoutsInFlight.delete(userId);
  }
});

// Dev/demo helper — reseed the store. Disabled in LIVE mode (real money) so
// it can't wipe real data; available in stub/demo deploys.
app.post("/api/reset", async (_req, res) => {
  if (!isStub()) return res.status(404).json({ error: "not available" });
  await reset();
  res.json({ ok: true });
});

// ── Stripe event application (shared by the webhook + the stub completer) ──
function applyStripeEvent(event) {
  const db = load();
  if (!event || typeof event !== "object" || !event.type) return;
  if (event.id && db.processedWebhooks[event.id]) return; // idempotent
  if (event.type === "checkout.session.completed") {
    const obj = event.data?.object ?? {};
    const campaignId = obj.metadata?.campaignId;
    const campaign = db.campaigns.find((c) => c.id === campaignId);
    if (campaign && campaign.status !== "active") {
      // For real Stripe events, verify the session was actually paid and the
      // amount matches the campaign budget before activating. (Stub events
      // omit these fields, so the checks only apply when present.)
      const expectedCents = Math.round((campaign.payment?.amountUsd ?? 0) * 100);
      const paidOk = obj.payment_status === undefined || obj.payment_status === "paid";
      const amountOk =
        obj.amount_total === undefined || obj.amount_total === expectedCents;
      if (paidOk && amountOk) {
        campaign.status = "active";
        campaign.payment = {
          ...(campaign.payment ?? {}),
          status: "paid",
          checkoutId: obj.id ?? campaign.payment?.checkoutId ?? null,
          paidAt: Date.now(),
        };
        const adv = db.advertisers.find((a) => a.id === campaign.advertiserId);
        capture("campaign_activated", {
          distinctId: adv?.email,
          properties: { brand: campaign.brand, amountUsd: campaign.payment?.amountUsd, campaignId: campaign.id },
        });
      }
    }
  }
  if (event.id) db.processedWebhooks[event.id] = true;
  save();
}

// ─────────────────────────────── Website ───────────────────────────────────

const PAGES = {
  "/": "index.html",
  "/advertise": "advertise.html",
  "/advertiser": "advertiser.html",
  "/portal": "portal.html",
  "/reset": "reset.html",
  "/mock-checkout": "mock-checkout.html",
  "/mock-connect": "mock-connect.html",
  "/terms": "terms.html",
  "/privacy": "privacy.html",
  "/logos": "logos.html",
};
for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (_req, res) => res.sendFile(path.join(WEB, file)));
}
app.use(express.static(WEB));

function validateAd(b) {
  const errors = [];
  const email = String(b.email ?? "").toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push("A valid email is required.");
  const pwErr = validatePassword(String(b.password ?? ""));
  if (pwErr) errors.push(pwErr);
  if (!b.brand || String(b.brand).trim().length < 1) errors.push("Brand name is required.");
  const text = String(b.text ?? "").trim();
  if (text.length < 3 || text.length > 60) errors.push("Ad copy must be 3–60 characters.");
  if (!/^https:\/\/.+/.test(String(b.url ?? ""))) errors.push("Destination must be an https:// URL.");
  const bid = Number(b.bidPerBlock);
  if (!Number.isFinite(bid) || bid < MIN_BID_PER_BLOCK)
    errors.push(`Bid must be at least $${MIN_BID_PER_BLOCK} per 1,000 impressions.`);
  else if (bid > 100_000) errors.push("Bid is too large.");
  const blocks = Number(b.blocks);
  if (!Number.isFinite(blocks) || blocks < 1) errors.push("Buy at least one block of 1,000 impressions.");
  else if (blocks > 1_000_000) errors.push("That's more than 1,000,000 blocks — please contact sales.");
  if (b.accent && !/^#[0-9a-fA-F]{6}$/.test(String(b.accent))) errors.push("Accent must be a #rrggbb color.");
  if (b.iconDataUrl && !/^data:image\/(png|jpeg|jpg|webp|svg\+xml);/.test(String(b.iconDataUrl)))
    errors.push("Logo must be a PNG, JPG, WebP, or SVG image.");
  if (b.iconDataUrl && String(b.iconDataUrl).length > 90_000) errors.push("Logo must be under 64KB.");
  return errors;
}

export { app, applyStripeEvent };

// Start the server unless imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (config.isProd && isStub()) {
    console.warn(
      "\n⚠️  Stripe is in STUB mode (no real payments). Great for a demo deploy.\n" +
        "   To take real money, set STRIPE_SECRET_KEY (sk_/rk_…) + STRIPE_WEBHOOK_SECRET.\n",
    );
    // Opt-in hard fail for real production: KOLEX_REQUIRE_STRIPE=1.
    if (/^(1|true|yes|on)$/i.test(process.env.KOLEX_REQUIRE_STRIPE || "")) {
      console.error("KOLEX_REQUIRE_STRIPE is set but Stripe is not configured. Exiting.");
      process.exit(1);
    }
  }

  // The #1 way to lose ALL data: deploy without a database. The JSON-file
  // fallback lives on the platform's EPHEMERAL disk, which Railway wipes on
  // every redeploy/restart — so advertisers, campaigns, earnings and payouts
  // vanish. Scream about it instead of failing silently.
  const onRailway = !!process.env.RAILWAY_PUBLIC_DOMAIN || !!process.env.RAILWAY_ENVIRONMENT;
  if ((config.isProd || onRailway) && !process.env.DATABASE_URL?.trim()) {
    console.warn(
      "\n🛑  NO DATABASE_URL — storing data in an EPHEMERAL JSON file.\n" +
        "   On Railway/production this file is WIPED on every redeploy and restart,\n" +
        "   so your advertisers, campaigns, earnings and payouts WILL DISAPPEAR.\n" +
        "   Fix: add a PostgreSQL database (Railway → New → Database → PostgreSQL).\n" +
        "   DATABASE_URL is then injected automatically — nothing else to configure.\n",
    );
    if (/^(1|true|yes|on)$/i.test(process.env.KOLEX_REQUIRE_DB || "")) {
      console.error("KOLEX_REQUIRE_DB is set but DATABASE_URL is missing. Exiting.");
      process.exit(1);
    }
  }
  (async () => {
    await init(); // connect to Postgres (or load the file) before serving
    // Flush + close the store on shutdown so a redeploy/Ctrl-C never drops the
    // last write (we already persist on every mutation; this is the backstop).
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, async () => {
        await close();
        process.exit(0);
      });
    }
    app.listen(config.port, () => {
      const settled = fmtUsd(leaderboard().reduce((s, c) => s + c.spendUsd, 0));
      const s = stats();
      console.log(
        `kolex server on http://localhost:${config.port}  ·  Stripe: ${config.stripe.mode.toUpperCase()}  ·  ${settled} settled`,
      );
      // So you can SEE where data lives and whether it's durable.
      const durable = !!process.env.DATABASE_URL?.trim();
      console.log(
        `  data: ${dbPath()} ${durable ? "(durable)" : "(⚠️ ephemeral — set DATABASE_URL to persist across restarts)"}`,
      );
      console.log(
        `        ${s.advertisers} advertisers, ${s.campaigns} campaigns, ${s.users} users, ${s.earners} earning devices, ${s.payouts} payouts`,
      );
    });
  })().catch((err) => {
    console.error("kolex: failed to start:", err.message);
    process.exit(1);
  });
}
