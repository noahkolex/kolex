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

/** Settle one impression: bill the advertiser, credit the viewer. */
export function settleImpression(campaign, deviceId) {
  const cost = impressionCost(campaign.bidPerBlock);
  campaign.impressions += 1;
  campaign.impressionsRemaining = Math.max(0, campaign.impressionsRemaining - 1);
  campaign.spendUsd += cost;
  if (campaign.impressionsRemaining === 0) campaign.status = "completed";
  const e = earningsFor(deviceId);
  e.impressions += 1;
  e.pendingUsd += cost * USER_REVENUE_SHARE;
}

/** Settle one click: bill 50× the impression rate, credit the viewer. */
export function settleClick(campaign, deviceId) {
  const cost = clickCost(campaign.bidPerBlock);
  campaign.clicks += 1;
  campaign.spendUsd += cost;
  const e = earningsFor(deviceId);
  e.clicks += 1;
  e.pendingUsd += cost * USER_REVENUE_SHARE;
}

/**
 * Ingest a batch of ledger events from the extension. Idempotent on event
 * id, so retried batches never double-bill. Returns how many were accepted.
 */
export function ingestEvents(events, deviceId) {
  const db = load();
  let accepted = 0;
  for (const ev of events) {
    if (!ev || typeof ev.id !== "string" || db.seenEvents[ev.id]) continue;
    const campaign = db.campaigns.find((c) => c.id === ev.adId);
    if (!campaign) {
      db.seenEvents[ev.id] = true; // house ad or unknown — record, skip billing
      continue;
    }
    if (ev.type === "impression") settleImpression(campaign, deviceId);
    else if (ev.type === "click") settleClick(campaign, deviceId);
    else continue;
    db.seenEvents[ev.id] = true;
    accepted += 1;
  }
  if (accepted > 0) save();
  return accepted;
}
