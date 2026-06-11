/** One impression = the ad held the status line for 5 contiguous seconds. */
export const IMPRESSION_MS = 5_000;
/** Advertisers buy blocks of 1,000 impressions at their bid price. */
export const IMPRESSIONS_PER_BLOCK = 1_000;
/** A click bills the advertiser at 50x the impression rate. */
export const CLICK_MULTIPLIER = 50;
/** Share of every settled dollar that goes to the person who saw the ad. */
export const USER_REVENUE_SHARE = 0.5;
/** Gaps longer than this mean the model went quiet — time does not accrue. */
export const TICK_CONTINUITY_MS = 4_000;
/** Content scripts tick once a second while a wait state is on screen. */
export const TICK_INTERVAL_MS = 1_000;

export interface Ad {
  id: string;
  brand: string;
  /** 3–60 chars, plain text. */
  text: string;
  /** HTTPS destination. Paid clicks route through the kolex.ai redirect. */
  url: string;
  /** USD bid per block of 1,000 five-second impressions. */
  bidPerBlock: number;
  /** Impressions left across all purchased blocks. */
  impressionsRemaining: number;
  /**
   * Advertiser logo as a `data:image/*` URL (delivered inline by the
   * backend, ≤64KB like kickbacks). When present the whole loading
   * indicator wears the brand: this mark replaces the Sefra bird.
   */
  iconDataUrl?: string;
  /** Brand accent color (`#rrggbb`) — tints the dot, tag, and arrow. */
  accent?: string;
  /** House ads fill unsold space and pay $0. */
  house?: boolean;
}

/** Max length of an inline icon data URL (~64KB after base64 + prefix). */
export const MAX_ICON_DATA_URL = 90_000;

export function isValidAccent(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export function isValidIconDataUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^data:image\/(png|jpeg|jpg|webp|svg\+xml);/.test(value) &&
    value.length <= MAX_ICON_DATA_URL
  );
}

/** User payout for one impression of this ad, in USD. */
export function impressionPayout(ad: Ad): number {
  return (ad.bidPerBlock / IMPRESSIONS_PER_BLOCK) * USER_REVENUE_SHARE;
}

/** User payout for one click on this ad, in USD. */
export function clickPayout(ad: Ad): number {
  return impressionPayout(ad) * CLICK_MULTIPLIER;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
