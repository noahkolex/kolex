// Auction economics — mirrors src/shared/economics.ts so the server settles
// money the same way the extension estimates it.

export const IMPRESSIONS_PER_BLOCK = 1_000;
export const CLICK_MULTIPLIER = 50;
export const USER_REVENUE_SHARE = 0.5;
export const MIN_BID_PER_BLOCK = 1;

/** What the advertiser is billed for one impression of this campaign. */
export function impressionCost(bidPerBlock) {
  return bidPerBlock / IMPRESSIONS_PER_BLOCK;
}

/** What the advertiser is billed for one click. */
export function clickCost(bidPerBlock) {
  return impressionCost(bidPerBlock) * CLICK_MULTIPLIER;
}

/** Effective CPM (cost per 1,000 impressions) — just the block price. */
export function cpm(bidPerBlock) {
  return bidPerBlock;
}

export function fmtUsd(n) {
  if (!n) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
