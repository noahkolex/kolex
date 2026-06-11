import { isValidAccent, isValidIconDataUrl, type Ad } from "./economics.js";

/**
 * Bundled house inventory. Serves when the auction backend is unreachable
 * or no paid blocks are queued, so the wait state never renders an empty
 * sponsored line. House ads pay $0 and link directly to the brand.
 */
export const HOUSE_ADS: Ad[] = [
  {
    id: "house-ramp",
    brand: "Ramp",
    text: "Close your books 8x faster — finance built for builders",
    url: "https://ramp.com",
    bidPerBlock: 0,
    impressionsRemaining: Number.MAX_SAFE_INTEGER,
    house: true,
  },
  {
    id: "house-jellyfish",
    brand: "Jellyfish",
    text: "See how your engineering org really ships",
    url: "https://jellyfish.co",
    bidPerBlock: 0,
    impressionsRemaining: Number.MAX_SAFE_INTEGER,
    house: true,
  },
  {
    id: "house-foundersnetwork",
    brand: "Founders Network",
    text: "Peer mentorship for tech founders, since 2011",
    url: "https://foundersnetwork.com",
    bidPerBlock: 0,
    impressionsRemaining: Number.MAX_SAFE_INTEGER,
    house: true,
  },
  {
    id: "house-euvc",
    brand: "eu.vc",
    text: "Inside Europe's venture ecosystem, every week",
    url: "https://www.eu.vc",
    bidPerBlock: 0,
    impressionsRemaining: Number.MAX_SAFE_INTEGER,
    house: true,
  },
  {
    id: "house-vendep",
    brand: "Vendep Capital",
    text: "Backing SaaS founders from day one",
    url: "https://www.vendep.com",
    bidPerBlock: 0,
    impressionsRemaining: Number.MAX_SAFE_INTEGER,
    house: true,
  },
  {
    id: "house-silna",
    brand: "Silna Health Eng",
    text: "How we build healthcare infrastructure — eng blog",
    url: "https://engineering.silnahealth.com",
    bidPerBlock: 0,
    impressionsRemaining: Number.MAX_SAFE_INTEGER,
    house: true,
  },
];

export function findAd(ads: Ad[], id: string | null | undefined): Ad | undefined {
  if (!id) return undefined;
  return ads.find((a) => a.id === id);
}

/**
 * English-ascending auction order: the highest live bid serves first.
 * Ties (including the $0 house ads) round-robin by least-recently-served
 * so a long wait does not pin one brand on screen for minutes.
 */
export function pickNextAd(
  ads: Ad[],
  served: Record<string, number>,
  lastAdId?: string | null,
): Ad | undefined {
  const live = ads.filter((a) => a.impressionsRemaining > 0);
  if (live.length === 0) return undefined;
  const topBid = Math.max(...live.map((a) => a.bidPerBlock));
  const tier = live.filter((a) => a.bidPerBlock === topBid);
  if (tier.length === 1) return tier[0];
  const fresh = tier.filter((a) => a.id !== lastAdId);
  const pool = fresh.length > 0 ? fresh : tier;
  pool.sort((a, b) => (served[a.id] ?? 0) - (served[b.id] ?? 0) || a.id.localeCompare(b.id));
  return pool[0];
}

/** Validate ads coming from the backend before they enter the rotation. */
export function sanitizeAds(raw: unknown): Ad[] {
  if (!Array.isArray(raw)) return [];
  const ads: Ad[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const a = item as Partial<Ad>;
    if (
      typeof a.id === "string" &&
      typeof a.brand === "string" &&
      typeof a.text === "string" &&
      a.text.length >= 3 &&
      a.text.length <= 60 &&
      typeof a.url === "string" &&
      a.url.startsWith("https://") &&
      typeof a.bidPerBlock === "number" &&
      a.bidPerBlock >= 0 &&
      typeof a.impressionsRemaining === "number"
    ) {
      ads.push({
        id: a.id,
        brand: a.brand.slice(0, 40),
        text: a.text,
        url: a.url,
        bidPerBlock: a.bidPerBlock,
        impressionsRemaining: Math.max(0, a.impressionsRemaining),
        ...(isValidIconDataUrl(a.iconDataUrl) ? { iconDataUrl: a.iconDataUrl } : {}),
        ...(isValidAccent(a.accent) ? { accent: a.accent } : {}),
        house: !!a.house,
      });
    }
  }
  return ads;
}
