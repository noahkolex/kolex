import { TICK_INTERVAL_MS } from "../shared/economics.js";
import { isBusy, siteForHost, type SiteConfig } from "../shared/detect.js";
import type { TickResponse } from "../shared/messages.js";
import { AdView, SpinnerSuppressor, type Box, type OverlayAd } from "./overlay.js";

/**
 * Content script. Watches the page for a wait state (model streaming or
 * thinking) and, while one is on screen *and the tab is visible*, ticks the
 * service worker once a second. The worker accrues time toward impressions
 * and answers with the ad to serve; we hide the native loading indicator
 * and put the sponsored line in its place. Nothing on the page is read
 * beyond the busy/spinner selectors — prompts and conversations are never
 * touched.
 *
 * Two loops:
 * - accounting (1s): busy detection + impression ticks to the worker.
 * - placement (250ms): keeps the sponsored line shown. The anchor position
 *   is captured ONCE per indicator (so the line stays put instead of
 *   crawling as text streams), and is always clamped above the composer so
 *   it never covers the input or any text.
 */

const PLACEMENT_INTERVAL_MS = 250;
/** Serve a beat past the busy state so 4.9s waits still feel sponsored. */
const LINGER_MS = 1_500;

/** Composer / input selectors — the line is always kept above the topmost. */
const COMPOSER_SELECTORS = [
  "form",
  "textarea",
  '[contenteditable="true"]',
  '[data-testid="composer"]',
  '[data-testid="composer-trailing-actions"]',
];

let site: SiteConfig | undefined;
let adView: AdView | undefined;
let suppressor: SpinnerSuppressor | undefined;
let currentAd: OverlayAd | null = null;
let currentEarnedUsd = 0;
let lingerUntil = 0;

/** Anchor pinned once so the line is stable, not re-read every tick. */
let pinnedAnchor: Element | null = null;
let pinnedRect: Box | null = null;

function visibleMatch(selector: string): boolean {
  const el = document.querySelector(selector);
  if (!el) return false;
  // Elements we collapsed ourselves still count as "on screen".
  if (suppressor?.contains(el)) return true;
  if (typeof el.getBoundingClientRect !== "function") return true;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

async function loadSites(): Promise<SiteConfig | undefined> {
  try {
    const stored = await chrome.storage.local.get("sites");
    const sites = stored.sites as SiteConfig[] | undefined;
    return siteForHost(location.hostname, sites && sites.length > 0 ? sites : undefined);
  } catch {
    return siteForHost(location.hostname);
  }
}

function serving(): boolean {
  return currentAd !== null && Date.now() < lingerUntil;
}

/** Accounting loop: detect the wait state and tick the service worker. */
async function accountingTick(): Promise<void> {
  if (!site) return;

  const busy = isBusy(site, visibleMatch);
  if (busy && document.visibilityState === "visible") {
    lingerUntil = Date.now() + LINGER_MS;
  }

  if (Date.now() >= lingerUntil) {
    currentAd = null;
    return;
  }

  try {
    const res = (await chrome.runtime.sendMessage({
      type: "kolex:tick",
      surface: site.surface,
    })) as TickResponse;
    if (res?.serving && res.ad) {
      currentAd = res.ad;
      currentEarnedUsd = res.estEarnedUsd;
    } else {
      currentAd = null;
    }
  } catch {
    // Worker asleep or extension updating — skip this beat.
  }
}

/**
 * Top edge of the composer / input region. The line is always kept above
 * this, so it can never overlap the input box or text being typed.
 */
function composerTop(): number {
  let top = window.innerHeight;
  const half = window.innerHeight * 0.4; // ignore headers/forms up top
  for (const sel of COMPOSER_SELECTORS) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const node of nodes) {
      const r = node.getBoundingClientRect?.();
      if (r && r.height > 0 && r.top > half && r.top < top) top = r.top;
    }
  }
  return top;
}

/** Placement loop: show the sponsored line where the spinner was, safely. */
function placementTick(): void {
  if (!adView || !suppressor) return;

  if (!serving() || !currentAd) {
    adView.hide();
    suppressor.restore();
    pinnedAnchor = null;
    pinnedRect = null;
    return;
  }

  const anchor = suppressor.findAnchor();
  if (anchor) {
    // Capture the rect ONCE per indicator, before hiding it, so the line
    // stays put instead of drifting as the response streams.
    if (anchor !== pinnedAnchor) {
      const r = anchor.getBoundingClientRect();
      pinnedRect = { left: r.left, top: r.top, width: r.width, height: r.height };
      pinnedAnchor = anchor;
    }
    suppressor.hide(anchor);
  } else {
    pinnedAnchor = null;
    pinnedRect = null;
  }

  adView.show(currentAd, currentEarnedUsd, { anchor: pinnedRect, composerTop: composerTop() });
}

function onAdClick(adId: string): void {
  if (!site) return;
  void chrome.runtime.sendMessage({ type: "kolex:click", adId, surface: site.surface });
}

async function main(): Promise<void> {
  site = await loadSites();
  if (!site) return;

  adView = new AdView(document, onAdClick);
  suppressor = new SpinnerSuppressor(document, site.spinnerSelectors);

  const accounting = window.setInterval(() => void accountingTick(), TICK_INTERVAL_MS);
  const placement = window.setInterval(placementTick, PLACEMENT_INTERVAL_MS);

  window.addEventListener("pagehide", () => {
    window.clearInterval(accounting);
    window.clearInterval(placement);
    adView?.destroy();
    suppressor?.restore();
  });
}

void main();
