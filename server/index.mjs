import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load, save, reset } from "./db.mjs";
import {
  configAds,
  leaderboard,
  ingestEvents,
  liveCampaigns,
} from "./auction.mjs";
import {
  IMPRESSIONS_PER_BLOCK,
  MIN_BID_PER_BLOCK,
  fmtUsd,
} from "./economics.mjs";
import {
  findOrCreateUser,
  findOrCreateAdvertiser,
  createSession,
  requireKind,
  newId,
} from "./auth.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(DIR, "..", "web");
const PORT = process.env.PORT ?? 4000;

const app = express();
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

// Device-code login (alternative to the device-id-in-URL flow).
app.post("/v1/auth/device", (req, res) => {
  const db = load();
  const deviceId = req.headers["x-kolex-device"];
  const code = newId("dc").slice(3, 11).toUpperCase();
  db.devices.push({ deviceId, deviceCode: code, authorized: false, userId: null, token: null });
  save();
  res.json({
    deviceCode: code,
    verificationUrl: `${publicSite(req)}/portal?code=${code}`,
    interval: 3,
  });
});

app.post("/v1/auth/device/poll", (req, res) => {
  const db = load();
  const code = req.body?.deviceCode;
  const dev = db.devices.find((d) => d.deviceCode === code);
  if (dev && dev.authorized && dev.token) return res.json({ token: dev.token });
  res.json({ pending: true });
});

// Click redirect — record the click, then bounce to the advertiser.
app.get("/r/:adId", (req, res) => {
  const db = load();
  const campaign = db.campaigns.find((c) => c.id === req.params.adId);
  const deviceId = typeof req.query.d === "string" ? req.query.d : "";
  if (campaign) {
    ingestEvents(
      [{ id: newId("clk"), type: "click", adId: campaign.id, surface: "redirect" }],
      deviceId,
    );
    return res.redirect(302, campaign.url);
  }
  res.redirect(302, "https://kolex.ai");
});

// ─────────────────────────── Website API (/api) ────────────────────────────

app.get("/api/auction", (_req, res) => {
  const board = leaderboard();
  const totalSpend = board.reduce((s, c) => s + c.spendUsd, 0);
  const live = liveCampaigns().length;
  res.json({
    leaderboard: board,
    stats: {
      campaigns: board.length,
      liveCampaigns: live,
      topBid: board[0]?.bidPerBlock ?? 0,
      totalSpendUsd: totalSpend,
    },
  });
});

// Quick ad submission (kickbacks-style: no prior login required).
app.post("/api/ads", (req, res) => {
  const b = req.body ?? {};
  const errors = validateAd(b);
  if (errors.length) return res.status(400).json({ errors });

  const advertiser = findOrCreateAdvertiser(String(b.email).toLowerCase().trim());
  const db = load();
  const blocks = Math.max(1, Math.floor(Number(b.blocks)));
  const campaign = {
    id: newId("cmp"),
    advertiserId: advertiser.id,
    brand: String(b.brand).trim().slice(0, 40),
    text: String(b.text).trim().slice(0, 60),
    url: String(b.url).trim(),
    iconDataUrl: typeof b.iconDataUrl === "string" ? b.iconDataUrl : undefined,
    accent: typeof b.accent === "string" ? b.accent : "#1547F5",
    bidPerBlock: Number(b.bidPerBlock),
    blocks,
    impressionsRemaining: blocks * IMPRESSIONS_PER_BLOCK,
    impressions: 0,
    clicks: 0,
    spendUsd: 0,
    status: "active",
    createdAt: Date.now(),
  };
  db.campaigns.push(campaign);
  save();

  const rank = liveCampaigns().findIndex((c) => c.id === campaign.id) + 1;
  const token = createSession("advertiser", advertiser);
  res.json({
    campaign,
    rank,
    budgetUsd: blocks * campaign.bidPerBlock,
    impressions: blocks * IMPRESSIONS_PER_BLOCK,
    token, // log the advertiser straight into their portal
  });
});

app.post("/api/login", (req, res) => {
  const email = String(req.body?.email ?? "").toLowerCase().trim();
  const kind = req.body?.kind === "advertiser" ? "advertiser" : "user";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "valid email required" });
  }
  const account = kind === "advertiser" ? findOrCreateAdvertiser(email) : findOrCreateUser(email);
  const token = createSession(kind, account);
  res.json({ token, email, kind });
});

app.get("/api/advertiser/campaigns", requireKind("advertiser"), (req, res) => {
  const db = load();
  const mine = db.campaigns.filter((c) => c.advertiserId === req.session.id);
  const totalSpend = mine.reduce((s, c) => s + c.spendUsd, 0);
  res.json({ email: req.session.email, campaigns: mine, totalSpendUsd: totalSpend });
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

app.post("/api/portal/payout", requireKind("user"), (req, res) => {
  const db = load();
  const devices = db.devices.filter((d) => d.userId === req.session.id);
  let paid = 0;
  for (const dev of devices) {
    const e = db.earnings[dev.deviceId];
    if (e && e.pendingUsd > 0) {
      paid += e.pendingUsd;
      e.paidUsd += e.pendingUsd;
      e.pendingUsd = 0;
    }
  }
  save();
  res.json({ ok: true, paidUsd: paid });
});

// Dev helper — reseed the store.
app.post("/api/reset", (_req, res) => {
  reset();
  res.json({ ok: true });
});

// ─────────────────────────────── Website ───────────────────────────────────

const PAGES = { "/": "index.html", "/advertise": "advertise.html", "/advertiser": "advertiser.html", "/portal": "portal.html" };
for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (_req, res) => res.sendFile(path.join(WEB, file)));
}
app.use(express.static(WEB));

function publicSite(req) {
  return process.env.SITE_BASE ?? `${req.protocol}://${req.get("host")}`;
}

function validateAd(b) {
  const errors = [];
  const email = String(b.email ?? "").toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push("A valid email is required.");
  if (!b.brand || String(b.brand).trim().length < 1) errors.push("Brand name is required.");
  const text = String(b.text ?? "").trim();
  if (text.length < 3 || text.length > 60) errors.push("Ad copy must be 3–60 characters.");
  if (!/^https:\/\/.+/.test(String(b.url ?? ""))) errors.push("Destination must be an https:// URL.");
  const bid = Number(b.bidPerBlock);
  if (!Number.isFinite(bid) || bid < MIN_BID_PER_BLOCK) errors.push(`Bid must be at least $${MIN_BID_PER_BLOCK} per 1,000 impressions.`);
  const blocks = Number(b.blocks);
  if (!Number.isFinite(blocks) || blocks < 1) errors.push("Buy at least one block of 1,000 impressions.");
  if (b.accent && !/^#[0-9a-fA-F]{6}$/.test(String(b.accent))) errors.push("Accent must be a #rrggbb color.");
  if (b.iconDataUrl && !/^data:image\/(png|jpeg|jpg|webp|svg\+xml);/.test(String(b.iconDataUrl))) {
    errors.push("Logo must be a PNG, JPG, WebP, or SVG image.");
  }
  if (b.iconDataUrl && String(b.iconDataUrl).length > 90_000) errors.push("Logo must be under 64KB.");
  return errors;
}

load();
app.listen(PORT, () => {
  console.log(`kolex server on http://localhost:${PORT}  (${fmtUsd(leaderboard().reduce((s, c) => s + c.spendUsd, 0))} settled so far)`);
});
