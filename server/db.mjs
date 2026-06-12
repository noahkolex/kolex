// Tiny JSON-file store — no native deps, atomic writes. Fine for a
// prototype/single-node deployment; swap for Postgres when it grows up.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMPRESSIONS_PER_BLOCK } from "./economics.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.KOLEX_DB ?? path.join(DIR, "data", "db.json");

const EMPTY = {
  advertisers: [], // { id, email, createdAt }
  campaigns: [], // { id, advertiserId, brand, text, url, iconDataUrl, accent,
  //                    bidPerBlock, blocks, impressionsRemaining, impressions,
  //                    clicks, spendUsd, status, createdAt,
  //                    payment: { checkoutId, status, amountUsd, paidAt } }
  // status: "pending" (awaiting payment) | "active" (paid, serving) | "completed"
  users: [], // { id, email, createdAt }
  devices: [], // { deviceId, userId, deviceCode, token, authorized }
  earnings: {}, // deviceId -> { impressions, clicks, pendingUsd, paidUsd }
  sessions: {}, // token -> { kind: 'user'|'advertiser', id, email }
  passwordResets: {}, // sha256(token) -> { kind, accountId, email, createdAt }
  seenEvents: {}, // eventId -> true (idempotency)
  processedWebhooks: {}, // stripe event id -> true (idempotency)
  payouts: [], // { id, userId, amountUsd, status, stripeId, createdAt }
};

let db = null;

export function load() {
  if (db) return db;
  try {
    db = { ...EMPTY, ...JSON.parse(fs.readFileSync(DB_PATH, "utf8")) };
  } catch {
    db = structuredClone(EMPTY);
    if (wantSeed()) seed(db);
    save();
  }
  return db;
}

export function save() {
  if (!db) return;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

// Blank by default — real data only. Set KOLEX_SEED=1 to populate demo
// campaigns for a showcase deployment.
const wantSeed = () => /^(1|true|yes|on|demo)$/i.test(process.env.KOLEX_SEED || "");

export function reset() {
  db = structuredClone(EMPTY);
  if (wantSeed()) seed(db);
  save();
  return db;
}

// ─── Seed inventory so the auction/leaderboard is alive on first boot ──

function tile(bg, glyph) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="${bg}"/>${glyph}</svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

const LOGOS = {
  linear: tile(
    "#5E6AD2",
    `<path d="M7 18.5 13.5 25A9 9 0 0 1 7 18.5Z M7 14.2A12.8 12.8 0 0 0 17.8 25 M7.6 10.6A16.4 16.4 0 0 0 21.4 24.4" stroke="#fff" stroke-width="2.1" fill="none" stroke-linecap="round"/>`,
  ),
  vercel: tile("#0F1216", `<path d="M16 8 25 23H7Z" fill="#fff"/>`),
  stripe: tile(
    "#635BFF",
    `<path d="M11 13.5c0-1 1-1.5 2.4-1.5 1.5 0 3 .5 4 1V9.4A9 9 0 0 0 13.4 9C10 9 7.7 10.7 7.7 13.4c0 4.2 5.8 3.5 5.8 5.3 0 .8-.7 1.1-1.9 1.1-1.6 0-3.5-.7-5-1.5v3.4a11 11 0 0 0 5 1c3.6 0 6-1.6 6-4.5 0-4.5-5.8-3.7-5.8-5.2Z" fill="#fff"/>`,
  ),
  raycast: tile(
    "#FF6363",
    `<path d="M16 8l8 8-8 8-8-8z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/>`,
  ),
  retool: tile(
    "#3D5AFE",
    `<rect x="9" y="9" width="6" height="6" rx="1" fill="#fff"/><rect x="17" y="9" width="6" height="6" rx="1" fill="#fff" opacity="0.7"/><rect x="9" y="17" width="6" height="6" rx="1" fill="#fff" opacity="0.7"/>`,
  ),
  posthog: tile(
    "#1D1F27",
    `<circle cx="13" cy="13" r="3" fill="#F9BD2B"/><circle cx="20" cy="13" r="3" fill="#fff"/><rect x="9" y="18" width="14" height="5" rx="2" fill="#1BB394"/>`,
  ),
};

function seed(d) {
  const now = Date.UTC(2026, 5, 1);
  const mk = (i, email) => {
    const id = `adv_seed_${i}`;
    d.advertisers.push({ id, email, createdAt: now });
    return id;
  };
  const campaigns = [
    { brand: "Linear", text: "The issue tracker teams actually enjoy", url: "https://linear.app", icon: LOGOS.linear, accent: "#5E6AD2", bid: 42, blocks: 800, email: "ads@linear.app" },
    { brand: "Vercel", text: "Ship your AI app to the edge in seconds", url: "https://vercel.com", icon: LOGOS.vercel, accent: "#0F1216", bid: 38, blocks: 1200, email: "growth@vercel.com" },
    { brand: "Stripe", text: "Payments infrastructure for the internet", url: "https://stripe.com", icon: LOGOS.stripe, accent: "#635BFF", bid: 31, blocks: 600, email: "ads@stripe.com" },
    { brand: "Raycast", text: "Your shortcut to everything on the Mac", url: "https://raycast.com", icon: LOGOS.raycast, accent: "#FF6363", bid: 24, blocks: 400, email: "team@raycast.com" },
    { brand: "Retool", text: "Build internal tools remarkably fast", url: "https://retool.com", icon: LOGOS.retool, accent: "#3D5AFE", bid: 18, blocks: 500, email: "ads@retool.com" },
    { brand: "PostHog", text: "The open-source product analytics suite", url: "https://posthog.com", icon: LOGOS.posthog, accent: "#1D1F27", bid: 12, blocks: 300, email: "hey@posthog.com" },
  ];
  campaigns.forEach((c, i) => {
    const advertiserId = mk(i, c.email);
    // Pretend some delivery has already happened so spend/stats look real.
    const impressions = Math.round(c.blocks * IMPRESSIONS_PER_BLOCK * (0.15 + 0.1 * (6 - i)) / 6);
    const clicks = Math.round(impressions * 0.012);
    const spendUsd = (impressions * c.bid) / IMPRESSIONS_PER_BLOCK + (clicks * c.bid * 50) / IMPRESSIONS_PER_BLOCK;
    d.campaigns.push({
      id: `cmp_seed_${i}`,
      advertiserId,
      brand: c.brand,
      text: c.text,
      url: c.url,
      iconDataUrl: c.icon,
      accent: c.accent,
      bidPerBlock: c.bid,
      blocks: c.blocks,
      impressionsRemaining: c.blocks * IMPRESSIONS_PER_BLOCK - impressions,
      impressions,
      clicks,
      spendUsd,
      status: "active",
      createdAt: now + i * 3600_000,
    });
  });
}
