// Auction + settlement. Highest live bid serves first; impressions and
// clicks are billed to the advertiser and 50% credited to the viewer.
import { load, save } from "./db.mjs";
import {
  IMPRESSIONS_PER_BLOCK,
  USER_REVENUE_SHARE,
  impressionCost,
  clickCost,
} from "./economics.mjs";

/** Campaigns currently eligible to serve, highest bid first. */
export function liveCampaigns() {
  const db = load();
  return db.campaigns
    .filter((c) => c.status === "active" && c.impressionsRemaining > 0)
    .sort((a, b) => b.bidPerBlock - a.bidPerBlock || a.createdAt - b.createdAt);
}

/** The auction leaderboard — public, drives the landing page. */
export function leaderboard() {
  const db = load();
  return db.campaigns
    .slice()
    .sort((a, b) => b.bidPerBlock - a.bidPerBlock || b.spendUsd - a.spendUsd)
    .map((c, i) => ({
      rank: i + 1,
      id: c.id,
      brand: c.brand,
      iconDataUrl: c.iconDataUrl ?? null,
      accent: c.accent ?? "#1547F5",
      bidPerBlock: c.bidPerBlock,
      cpm: c.bidPerBlock,
      impressions: c.impressions,
      clicks: c.clicks,
      spendUsd: c.spendUsd,
      blocksLeft: Math.ceil(c.impressionsRemaining / IMPRESSIONS_PER_BLOCK),
      status: c.status,
    }));
}

/** Top-N live ads, in the extension's Ad shape, for GET /v1/config. */
export function configAds(limit = 12) {
  return liveCampaigns()
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      brand: c.brand,
      text: c.text,
      url: c.url,
      iconDataUrl: c.iconDataUrl,
      accent: c.accent,
      bidPerBlock: c.bidPerBlock,
      impressionsRemaining: c.impressionsRemaining,
      house: false,
    }));
}

function earningsFor(deviceId) {
  const db = load();
  if (!db.earnings[deviceId]) {
    db.earnings[deviceId] = { impressions: 0, clicks: 0, pendingUsd: 0, paidUsd: 0 };
  }
  return db.earnings[deviceId];
}

/** The advertiser's paid budget — the hard cap on total spend. */
function budgetOf(campaign) {
  return campaign.payment?.amountUsd ?? campaign.blocks * campaign.bidPerBlock;
}

/**
 * Can this campaign be billed `cost` more right now? Only active campaigns
 * that still have budget. This prevents clicks (or anything) from spending
 * past what the advertiser actually paid for.
 */
function canBill(campaign, cost) {
  if (campaign.status !== "active") return false;
  return campaign.spendUsd + cost <= budgetOf(campaign) + 1e-9;
}

/** Mark a campaign completed once it has exhausted its budget or inventory. */
function maybeComplete(campaign) {
  if (
    campaign.status === "active" &&
    (campaign.impressionsRemaining <= 0 || campaign.spendUsd + 1e-9 >= budgetOf(campaign))
  ) {
    campaign.status = "completed";
  }
}

/** Settle one impression: bill the advertiser, credit the viewer. Returns the
 *  USD credited to the viewer (0 if it couldn't be billed). */
export function settleImpression(campaign, deviceId) {
  const cost = impressionCost(campaign.bidPerBlock);
  if (!canBill(campaign, cost)) return 0;
  campaign.impressions += 1;
  campaign.impressionsRemaining = Math.max(0, campaign.impressionsRemaining - 1);
  campaign.spendUsd += cost;
  const e = earningsFor(deviceId);
  e.impressions += 1;
  const credited = cost * USER_REVENUE_SHARE;
  e.pendingUsd += credited;
  maybeComplete(campaign);
  return credited;
}

/** Settle one click: bill 50× the impression rate, credit the viewer. Returns
 *  the USD credited to the viewer (0 if it couldn't be billed). */
export function settleClick(campaign, deviceId) {
  const cost = clickCost(campaign.bidPerBlock);
  if (!canBill(campaign, cost)) return 0;
  campaign.clicks += 1;
  campaign.spendUsd += cost;
  const e = earningsFor(deviceId);
  e.clicks += 1;
  const credited = cost * USER_REVENUE_SHARE;
  e.pendingUsd += credited;
  maybeComplete(campaign);
  return credited;
}

/**
 * Ingest a batch of ledger events from the extension. Idempotent on event
 * id, so retried batches never double-bill. Events for non-active or
 * over-budget campaigns are recorded (so they aren't retried) but not
 * billed. Returns how many were actually settled.
 */
export function ingestEvents(events, deviceId) {
  const db = load();
  let accepted = 0;
  let credited = 0;
  for (const ev of events) {
    if (!ev || typeof ev.id !== "string" || db.seenEvents[ev.id]) continue;
    const campaign = db.campaigns.find((c) => c.id === ev.adId);
    let amt = 0;
    if (campaign) {
      if (ev.type === "impression") amt = settleImpression(campaign, deviceId);
      else if (ev.type === "click") amt = settleClick(campaign, deviceId);
      else continue; // unknown event type — don't even record
    }
    db.seenEvents[ev.id] = true; // record (house/unknown/over-budget) → no retry
    if (amt > 0) {
      accepted += 1;
      credited += amt;
    }
  }
  // Log one "earned" entry per batch for the live feed (capped).
  if (credited > 0) {
    db.recentEarnings.push({ deviceId, amountUsd: credited, at: Date.now() });
    if (db.recentEarnings.length > 100) {
      db.recentEarnings.splice(0, db.recentEarnings.length - 100);
    }
  }
  save();
  return accepted;
}
