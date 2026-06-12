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

// ─────────────────────────── Extension API (/v1) ───────────────────────────

app.get("/v1/config", (_req, res) => {
  res.json({ ads: configAds(), sites: [], killswitch: false });
});

app.get("/v1/killswitch", (_req, res) => res.json({ disabled: false }));

app.post("/v1/events", (req, res) => {
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
app.get("/r/:adId", (req, res) => {
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
app.post("/api/ads", async (req, res) => {
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
  if (!isStub()) return res.status(404).json({ error: "not available in live mode" });
  const campaignId = String(req.body?.campaignId ?? "");
  applyStripeEvent({
    id: newId("evt_stub"),
    type: "checkout.session.completed",
    data: { object: { id: req.body?.session ?? newId("cs"), metadata: { campaignId } } },
  });
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
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
  dev.userId = req.session.id;
  dev.authorized = true;
  dev.token = token;
  save();
  res.json({ ok: true, deviceId: dev.deviceId });
});

app.post("/api/portal/payout", requireKind("user"), async (req, res) => {
  const db = load();
  const devices = db.devices.filter((d) => d.userId === req.session.id);
  const pending = devices.reduce((s, d) => s + (db.earnings[d.deviceId]?.pendingUsd ?? 0), 0);
  if (pending < config.minPayoutUsd) {
    return res.status(400).json({
      error: `Minimum payout is $${config.minPayoutUsd.toFixed(2)}. You have $${pending.toFixed(2)}.`,
    });
  }
  let result;
  try {
    result = await createPayout({ amountUsd: pending, email: req.session.email });
  } catch (err) {
    return res.status(502).json({ error: `Payout failed: ${err.message}` });
  }
  // Move pending → paid on every linked device.
  for (const dev of devices) {
    const e = db.earnings[dev.deviceId];
    if (e && e.pendingUsd > 0) {
      e.paidUsd += e.pendingUsd;
      e.pendingUsd = 0;
    }
  }
  const payout = {
    id: newId("pay"),
    userId: req.session.id,
    amountUsd: pending,
    status: result.status,
    stripeId: result.id,
    createdAt: Date.now(),
  };
  db.payouts.push(payout);
  save();
  res.json({ ok: true, paidUsd: pending, payout });
});

// Dev helper — reseed the store.
app.post("/api/reset", (_req, res) => {
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
      campaign.status = "active";
      campaign.payment = {
        ...(campaign.payment ?? {}),
        status: "paid",
        checkoutId: obj.id ?? campaign.payment?.checkoutId ?? null,
        paidAt: Date.now(),
      };
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
  const blocks = Number(b.blocks);
  if (!Number.isFinite(blocks) || blocks < 1) errors.push("Buy at least one block of 1,000 impressions.");
  if (b.accent && !/^#[0-9a-fA-F]{6}$/.test(String(b.accent))) errors.push("Accent must be a #rrggbb color.");
  if (b.iconDataUrl && !/^data:image\/(png|jpeg|jpg|webp|svg\+xml);/.test(String(b.iconDataUrl)))
    errors.push("Logo must be a PNG, JPG, WebP, or SVG image.");
  if (b.iconDataUrl && String(b.iconDataUrl).length > 90_000) errors.push("Logo must be under 64KB.");
  return errors;
}

export { app, applyStripeEvent };

// Start the server unless imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  load();
  app.listen(config.port, () => {
    const settled = fmtUsd(leaderboard().reduce((s, c) => s + c.spendUsd, 0));
    console.log(
      `kolex server on http://localhost:${config.port}  ·  Stripe: ${config.stripe.mode.toUpperCase()}  ·  ${settled} settled`,
    );
  });
}
