import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, publicBase } from "./config.mjs";
import { load, save, reset } from "./db.mjs";
import {
  configAds,
  leaderboard,
  ingestEvents,
  liveCampaigns,
} from "./auction.mjs";
import { IMPRESSIONS_PER_BLOCK, MIN_BID_PER_BLOCK, fmtUsd } from "./economics.mjs";
import {
  findOrCreateUser,
  findOrCreateAdvertiser,
  createSession,
  requireKind,
  newId,
} from "./auth.mjs";
import {
  createCheckout,
  verifyWebhook,
  createPayout,
  stripeStatus,
  isStub,
} from "./stripe.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(DIR, "..", "web");

const app = express();
app.disable("x-powered-by");

// The Stripe webhook needs the RAW body for signature verification, so it is
// mounted BEFORE express.json() (which would otherwise consume the stream).
app.post("/webhooks/stripe", express.raw({ type: "*/*" }), (req, res) => {
  let event;
  try {
    event = verifyWebhook(req.body, req.headers["stripe-signature"]);
  } catch (err) {
    return res.status(400).json({ error: `webhook signature failed: ${err.message}` });
  }
  applyStripeEvent(event);
  res.json({ received: true });
});

app.use(express.json({ limit: "256kb" }));

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

app.post("/v1/events", eventsLimiter, (req, res) => {
  const deviceId = req.headers["x-kolex-device"];
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  if (typeof deviceId !== "string" || !deviceId) {
    return res.status(400).json({ error: "missing device" });
  }
  const accepted = ingestEvents(events, deviceId);
  res.json({ accepted });
});

app.get("/v1/balance", (req, res) => {
  const deviceId = req.headers["x-kolex-device"];
  const db = load();
  const e = (typeof deviceId === "string" && db.earnings[deviceId]) || {
    impressions: 0,
    clicks: 0,
    pendingUsd: 0,
    paidUsd: 0,
  };
  res.json({ settledUsd: e.paidUsd, pendingUsd: e.pendingUsd });
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

app.get("/api/stripe-config", (_req, res) => res.json(stripeStatus()));

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

  const advertiser = findOrCreateAdvertiser(String(b.email).toLowerCase().trim());
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
  save();

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
  save();

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
  if (!isStub() || config.isProd) return res.status(404).json({ error: "not available" });
  const campaignId = String(req.body?.campaignId ?? "");
  applyStripeEvent({
    id: newId("evt_stub"),
    type: "checkout.session.completed",
    data: { object: { id: req.body?.session ?? newId("cs"), metadata: { campaignId } } },
  });
  res.json({ ok: true });
});

app.post("/api/login", loginLimiter, (req, res) => {
  const email = String(req.body?.email ?? "").toLowerCase().trim();
  const kind = req.body?.kind === "advertiser" ? "advertiser" : "user";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "valid email required" });
  }
  const account = kind === "advertiser" ? findOrCreateAdvertiser(email) : findOrCreateUser(email);
  res.json({ token: createSession(kind, account), email, kind });
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
app.get("/api/portal/summary", requireKind("user"), (req, res) => {
  const db = load();
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
    payouts: db.payouts.filter((p) => p.userId === req.session.id),
  });
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
  try {
    if (total < config.minPayoutUsd) {
      return res.status(400).json({
        error: `Minimum payout is $${config.minPayoutUsd.toFixed(2)}. You have $${total.toFixed(2)}.`,
      });
    }
    // Deduct FIRST (before the await) so a concurrent request sees zero.
    for (const s of snapshot) db.earnings[s.deviceId].pendingUsd = 0;
    save();

    let result;
    try {
      result = await createPayout({ amountUsd: total, email: req.session.email });
    } catch (err) {
      // Restore the balance — the money never moved.
      for (const s of snapshot) db.earnings[s.deviceId].pendingUsd += s.amt;
      save();
      return res.status(502).json({ error: `Payout failed: ${err.message}` });
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
    save();
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

// Dev helper — reseed the store. Disabled in production / live mode so it
// can't be used to wipe real data.
app.post("/api/reset", (_req, res) => {
  if (config.isProd || !isStub()) return res.status(404).json({ error: "not available" });
  reset();
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
  "/mock-checkout": "mock-checkout.html",
};
for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (_req, res) => res.sendFile(path.join(WEB, file)));
}
app.use(express.static(WEB));

function validateAd(b) {
  const errors = [];
  const email = String(b.email ?? "").toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push("A valid email is required.");
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
    console.error(
      "\n⚠️  REFUSING TO START: NODE_ENV=production but Stripe is in STUB mode.\n" +
        "   Set a real STRIPE_SECRET_KEY (sk_/rk_…) and STRIPE_WEBHOOK_SECRET, or set\n" +
        "   STRIPE_MODE=stub explicitly to acknowledge running without real payments.\n",
    );
    if ((process.env.STRIPE_MODE || "").toLowerCase() !== "stub") process.exit(1);
  }
  load();
  app.listen(config.port, () => {
    const settled = fmtUsd(leaderboard().reduce((s, c) => s + c.spendUsd, 0));
    console.log(
      `kolex server on http://localhost:${config.port}  ·  Stripe: ${config.stripe.mode.toUpperCase()}  ·  ${settled} settled`,
    );
  });
}
