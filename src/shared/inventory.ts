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

/** The Kolex bird mark on a money-green tile — used by the house ads. */
const KOLEX_BIRD =
  "M66.616 51.836 L67.015 51.703 L125.47 110.157 L129.997 116.016 L133.193 121.076 L135.59 125.603 L137.987 131.995 L139.851 141.582 L139.851 150.636 L139.318 154.897 L137.72 161.821 L135.856 167.147 L131.595 175.936 L123.872 189.517 L118.812 199.637 L114.818 206.561 L114.152 207.227 L70.078 207.094 L113.353 173.406 L114.285 172.207 L114.551 170.876 L114.551 166.881 L112.954 162.62 L109.625 158.759 L100.038 153.699 L92.581 150.503 L86.19 146.508 L83.526 144.378 L79.132 139.984 L77.268 137.587 L74.339 133.06 L71.942 128.266 L70.344 123.739 L70.344 122.94 L71.01 122.807 L73.14 124.405 L77.934 127.068 L99.771 136.655 L106.163 140.117 L106.562 139.984 L102.168 135.856 L96.309 131.329 L78.2 118.812 L74.206 115.35 L70.344 111.223 L66.083 105.097 L62.621 97.907 L60.757 90.983 L60.224 85.923 L60.358 82.861 L61.689 83.393 L67.814 89.518 L73.407 94.046 L96.842 110.557 L106.163 117.747 L106.695 118.013 L106.828 117.614 L102.301 112.554 L78.6 89.385 L71.409 80.597 L68.214 74.472 L65.817 66.216 L65.284 59.292 L65.551 59.026 L65.551 55.83 L66.483 51.969Z M167.014 89.385 L170.077 89.252 L174.87 90.584 L178.066 92.448 L180.995 95.643 L186.588 95.91 L189.784 96.709 L192.713 98.307 L195.509 101.369 L188.985 103.1 L183.659 106.03 L179.797 109.891 L177.4 114.152 L175.802 119.478 L175.802 137.054 L175.27 141.848 L174.205 146.642 L172.607 151.701 L169.145 159.424 L165.683 164.751 L162.487 168.745 L155.163 175.536 L148.239 180.063 L141.848 183.259 L135.989 185.656 L132.794 186.721 L131.728 186.721 L131.595 186.055 L134.791 180.729 L140.117 170.077 L141.715 166.082 L143.845 159.158 L145.177 150.37 L145.177 142.114 L144.378 136.256 L142.248 128.533 L140.916 125.071 L138.519 120.543 L138.519 119.478 L148.106 104.299 L145.044 103.366 L141.582 101.236 L139.584 98.972 L138.519 96.842 L144.511 96.709 L147.707 96.176 L151.968 94.845 L161.022 90.85 L164.218 89.785 L166.881 89.518Z";
const KOLEX_LOGO = svgIcon(
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="#16E0A3"/>` +
    `<g transform="translate(5.5 4.6) scale(0.105)"><path fill="#0F1216" fill-rule="evenodd" d="${KOLEX_BIRD}"/></g></svg>`,
);

const kolexAd = (id: string, text: string): Ad => ({
  id,
  brand: "Kolex",
  text,
  url: "https://kolex.ai",
  iconDataUrl: KOLEX_LOGO,
  accent: "#16E0A3",
  bidPerBlock: 0,
  impressionsRemaining: Number.MAX_SAFE_INTEGER,
  house: true,
});

/**
 * Kolex's OWN house ads. These are the default the spinner shows when there
 * are no paid campaigns in the auction — so a fresh/blank deployment promotes
 * Kolex itself rather than any third party. House ads pay $0.
 */
export const HOUSE_ADS: Ad[] = [
  kolexAd("kolex-getpaid", "Get paid while your AI thinks — add Kolex free"),
  kolexAd("kolex-advertise", "Your brand, in the spinner. Advertise on Kolex"),
  kolexAd("kolex-cashout", "Your wait time is worth money. Cash out on Kolex"),
  kolexAd("kolex-50", "Keep 50% of the ad money. That's the deal."),
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
