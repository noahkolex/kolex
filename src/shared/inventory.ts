import { isValidAccent, isValidIconDataUrl, type Ad } from "./economics.js";

/** Encode an inline SVG string as a data: URL (works in workers and Node). */
function svgIcon(svg: string): string {
  const g = globalThis as { btoa?: (s: string) => string };
  const b64 = g.btoa ? g.btoa(svg) : "";
  return `data:image/svg+xml;base64,${b64}`;
}

/** A 32×32 rounded app-tile with a brand color and a white glyph. */
function tile(bg: string, glyph: string): string {
  return svgIcon(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
      `<rect width="32" height="32" rx="7" fill="${bg}"/>${glyph}</svg>`,
  );
}

const LOGO = {
  linear: tile(
    "#5E6AD2",
    `<path d="M7 18.5 13.5 25A9 9 0 0 1 7 18.5Z M7 14.2A12.8 12.8 0 0 0 17.8 25 M7.6 10.6A16.4 16.4 0 0 0 21.4 24.4" stroke="#fff" stroke-width="2.1" fill="none" stroke-linecap="round"/>`,
  ),
  vercel: tile("#0F1216", `<path d="M16 8 25 23H7Z" fill="#fff"/>`),
  stripe: tile(
    "#635BFF",
    `<path d="M11 13.5c0-1 1-1.5 2.4-1.5 1.5 0 3 .5 4 1V9.4A9 9 0 0 0 13.4 9C10 9 7.7 10.7 7.7 13.4c0 4.2 5.8 3.5 5.8 5.3 0 .8-.7 1.1-1.9 1.1-1.6 0-3.5-.7-5-1.5v3.4a11 11 0 0 0 5 1c3.6 0 6-1.6 6-4.5 0-4.5-5.8-3.7-5.8-5.2Z" fill="#fff"/>`,
  ),
  notion: tile(
    "#0F1216",
    `<path d="M11 10v12M11 10l10 12M21 10v12" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  raycast: tile(
    "#FF6363",
    `<path d="M16 8l8 8-8 8-8-8z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/>`,
  ),
};

/**
 * Bundled example inventory — what a submitted, branded creative looks like.
 * Each carries the advertiser's own logo and accent color, so the whole
 * loading indicator wears their brand. Serves when the auction backend is
 * unreachable or no paid blocks are queued. House ads pay $0.
 *
 * The last entry intentionally has no logo, to show the Kolex/Sefra
 * fallback mark for an advertiser who submitted no branding.
 */
export const HOUSE_ADS: Ad[] = [
  {
    id: "ex-linear",
    brand: "Linear",
    text: "The issue tracker teams actually enjoy",
    url: "https://linear.app",
    iconDataUrl: LOGO.linear,
    accent: "#5E6AD2",
    bidPerBlock: 0,
    impressionsRemaining: Number.MAX_SAFE_INTEGER,
    house: true,
  },
  {
    id: "ex-vercel",
    brand: "Vercel",
    text: "Ship your AI app to the edge in seconds",
    url: "https://vercel.com",
    iconDataUrl: LOGO.vercel,
    accent: "#0F1216",
    bidPerBlock: 0,
    impressionsRemaining: Number.MAX_SAFE_INTEGER,
    house: true,
  },
  {
    id: "ex-stripe",
    brand: "Stripe",
    text: "Payments infrastructure for the internet",
    url: "https://stripe.com",
    iconDataUrl: LOGO.stripe,
    accent: "#635BFF",
    bidPerBlock: 0,
    impressionsRemaining: Number.MAX_SAFE_INTEGER,
    house: true,
  },
  {
    id: "ex-notion",
    brand: "Notion",
    text: "One workspace for your docs, wiki, and projects",
    url: "https://notion.so",
    iconDataUrl: LOGO.notion,
    accent: "#0F1216",
    bidPerBlock: 0,
    impressionsRemaining: Number.MAX_SAFE_INTEGER,
    house: true,
  },
  {
    id: "ex-raycast",
    brand: "Raycast",
    text: "Your shortcut to everything on the Mac",
    url: "https://raycast.com",
    iconDataUrl: LOGO.raycast,
    accent: "#FF6363",
    bidPerBlock: 0,
    impressionsRemaining: Number.MAX_SAFE_INTEGER,
    house: true,
  },
  {
    id: "ex-indie",
    brand: "Indie Hackers",
    text: "Where founders share what's working",
    url: "https://indiehackers.com",
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
