import type { Surface } from "./rotation.js";

/**
 * Wait-state detection is selector-driven so it can be updated remotely
 * when ChatGPT or Claude ship a UI change — the same way every ad network
 * ships creative/placement config without a client release.
 */
export interface SiteConfig {
  surface: Surface;
  hosts: string[];
  /** Any visible match means "the model is working". */
  busySelectors: string[];
  /** Native loading indicators to swap for the sponsored line. */
  spinnerSelectors: string[];
}

export const DEFAULT_SITES: SiteConfig[] = [
  {
    surface: "chatgpt",
    hosts: ["chatgpt.com", "chat.openai.com"],
    busySelectors: [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label*="Stop" i]',
      ".result-streaming",
      ".result-thinking",
    ],
    spinnerSelectors: [
      ".result-thinking",
      '[class*="loading-shimmer"]',
      ".text-token-text-secondary .animate-pulse",
    ],
  },
  {
    surface: "claude",
    hosts: ["claude.ai"],
    busySelectors: [
      '[data-is-streaming="true"]',
      'button[aria-label="Stop response"]',
      'button[aria-label*="Stop" i]',
    ],
    spinnerSelectors: ['[data-is-streaming="true"] [class*="shimmer"]', '[class*="thinking"]'],
  },
  {
    surface: "gemini",
    hosts: ["gemini.google.com"],
    busySelectors: [
      'button[aria-label*="Stop" i]',
      ".stop-icon",
      "model-response .blinking-cursor",
      ".response-container.is-streaming",
    ],
    spinnerSelectors: [".blinking-cursor", "[class*='loading']", "[class*='thinking']"],
  },
  {
    surface: "grok",
    hosts: ["grok.com", "x.com", "twitter.com"],
    busySelectors: [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Stop model response" i]',
      "[class*='streaming']",
    ],
    spinnerSelectors: ["[class*='loading']", "[class*='spinner']", "[class*='thinking']"],
  },
];

export function siteForHost(host: string, sites: SiteConfig[] = DEFAULT_SITES): SiteConfig | undefined {
  return sites.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
}

/**
 * Evaluate busy state through an injected query function so the logic is
 * testable without a DOM. `query` returns true when the selector matches a
 * visible element.
 */
export function isBusy(site: SiteConfig, query: (selector: string) => boolean): boolean {
  return site.busySelectors.some((sel) => {
    try {
      return query(sel);
    } catch {
      return false; // Bad remote selector must never break the page.
    }
  });
}

/** Validate remote site configs before they replace the defaults. */
export function sanitizeSites(raw: unknown): SiteConfig[] {
  if (!Array.isArray(raw)) return [];
  const sites: SiteConfig[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const s = item as Partial<SiteConfig>;
    const surfaces = ["chatgpt", "claude", "gemini", "grok", "other"];
    if (
      typeof s.surface === "string" &&
      surfaces.includes(s.surface) &&
      Array.isArray(s.hosts) &&
      s.hosts.every((h) => typeof h === "string") &&
      Array.isArray(s.busySelectors) &&
      s.busySelectors.every((sel) => typeof sel === "string")
    ) {
      sites.push({
        surface: s.surface as SiteConfig["surface"],
        hosts: s.hosts,
        busySelectors: s.busySelectors,
        spinnerSelectors: Array.isArray(s.spinnerSelectors)
          ? s.spinnerSelectors.filter((sel): sel is string => typeof sel === "string")
          : [],
      });
    }
  }
  return sites;
}
