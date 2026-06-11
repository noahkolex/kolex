import { formatUsd } from "../shared/economics.js";

export interface OverlayAd {
  id: string;
  brand: string;
  text: string;
  house?: boolean;
}

/** Sefra brand tokens (meetsefra.com) — cool bone, ink black, cobalt accent. */
const SEFRA = {
  surface: "#FFFFFF",
  paper: "#F4F4F1",
  ink: "#0F1216",
  muted: "#6E7079",
  rule: "#DBDBD5",
  accent: "#1547F5",
  accentBg: "#E8EDFF",
  positive: "#16A34A",
  sans: '"Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: '"Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
};

const SEFRA_BIRD_PATH =
  "M66.616 51.836 L67.015 51.703 L125.47 110.157 L129.997 116.016 L133.193 121.076 L135.59 125.603 L137.987 131.995 L139.851 141.582 L139.851 150.636 L139.318 154.897 L137.72 161.821 L135.856 167.147 L131.595 175.936 L123.872 189.517 L118.812 199.637 L114.818 206.561 L114.152 207.227 L70.078 207.094 L113.353 173.406 L114.285 172.207 L114.551 170.876 L114.551 166.881 L112.954 162.62 L109.625 158.759 L100.038 153.699 L92.581 150.503 L86.19 146.508 L83.526 144.378 L79.132 139.984 L77.268 137.587 L74.339 133.06 L71.942 128.266 L70.344 123.739 L70.344 122.94 L71.01 122.807 L73.14 124.405 L77.934 127.068 L99.771 136.655 L106.163 140.117 L106.562 139.984 L102.168 135.856 L96.309 131.329 L78.2 118.812 L74.206 115.35 L70.344 111.223 L66.083 105.097 L62.621 97.907 L60.757 90.983 L60.224 85.923 L60.358 82.861 L61.689 83.393 L67.814 89.518 L73.407 94.046 L96.842 110.557 L106.163 117.747 L106.695 118.013 L106.828 117.614 L102.301 112.554 L78.6 89.385 L71.409 80.597 L68.214 74.472 L65.817 66.216 L65.284 59.292 L65.551 59.026 L65.551 55.83 L66.483 51.969Z M167.014 89.385 L170.077 89.252 L174.87 90.584 L178.066 92.448 L180.995 95.643 L186.588 95.91 L189.784 96.709 L192.713 98.307 L195.509 101.369 L188.985 103.1 L183.659 106.03 L179.797 109.891 L177.4 114.152 L175.802 119.478 L175.802 137.054 L175.27 141.848 L174.205 146.642 L172.607 151.701 L169.145 159.424 L165.683 164.751 L162.487 168.745 L155.163 175.536 L148.239 180.063 L141.848 183.259 L135.989 185.656 L132.794 186.721 L131.728 186.721 L131.595 186.055 L134.791 180.729 L140.117 170.077 L141.715 166.082 L143.845 159.158 L145.177 150.37 L145.177 142.114 L144.378 136.256 L142.248 128.533 L140.916 125.071 L138.519 120.543 L138.519 119.478 L148.106 104.299 L145.044 103.366 L141.582 101.236 L139.584 98.972 L138.519 96.842 L144.511 96.709 L147.707 96.176 L151.968 94.845 L161.022 90.85 L164.218 89.785 L166.881 89.518Z";

const STYLE = `
  :host { all: initial; display: block; }
  .line {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    max-width: min(620px, calc(100vw - 48px));
    padding: 9px 14px;
    background: ${SEFRA.surface};
    border: 1px solid ${SEFRA.rule};
    border-radius: 4px;
    box-shadow: 0 1px 2px rgba(15, 18, 22, 0.06);
    font: 500 13px/1.45 ${SEFRA.sans};
    color: ${SEFRA.ink};
    cursor: pointer;
    white-space: nowrap;
    opacity: 0;
    transition: opacity 140ms ease;
  }
  .line.visible { opacity: 1; }
  .line:hover { border-color: ${SEFRA.accent}; }
  .line.floating {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: 96px;
    z-index: 2147483646;
    box-shadow: 0 4px 16px rgba(15, 18, 22, 0.14);
  }
  .bird { height: 14px; width: auto; flex: none; display: block; }
  .tag {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: 500 10px/1 ${SEFRA.mono};
    letter-spacing: 1.2px;
    text-transform: uppercase;
    color: ${SEFRA.accent};
  }
  .tag::before {
    content: "";
    width: 6px;
    height: 6px;
    background: ${SEFRA.accent};
    animation: kolexpulse 1.1s ease-in-out infinite;
  }
  @keyframes kolexpulse { 50% { opacity: 0.25; } }
  .brand { flex: none; font-weight: 600; }
  .copy { overflow: hidden; text-overflow: ellipsis; color: ${SEFRA.muted}; font-weight: 400; }
  .arrow { flex: none; color: ${SEFRA.accent}; }
  .earned {
    flex: none;
    font: 500 11px/1 ${SEFRA.mono};
    color: ${SEFRA.positive};
    font-variant-numeric: tabular-nums;
    padding-left: 10px;
    border-left: 1px solid ${SEFRA.rule};
  }
`;

/**
 * The sponsored status line, Sefra-branded. Two placements:
 *
 * - inline: inserted directly after the site's loading indicator, taking
 *   its place in document flow once the indicator is collapsed — this is
 *   the "fully replace the spinner" mode.
 * - floating: bottom-center fallback when the page is busy but no spinner
 *   element can be located (e.g. only a stop button is detectable).
 *
 * Rendered in a shadow root so site CSS cannot restyle it and ours cannot
 * leak out.
 */
export class AdView {
  private doc: Document;
  private host: HTMLElement;
  private line: HTMLElement;
  private brandEl: HTMLElement;
  private textEl: HTMLElement;
  private earnedEl: HTMLElement;
  private currentAdId: string | null = null;

  constructor(doc: Document, onClick: (adId: string) => void) {
    this.doc = doc;
    this.host = doc.createElement("kolex-ad");
    const root = this.host.attachShadow({ mode: "open" });

    const style = doc.createElement("style");
    style.textContent = STYLE;

    this.line = doc.createElement("div");
    this.line.className = "line";
    this.line.setAttribute("role", "status");

    const ns = "http://www.w3.org/2000/svg";
    const bird = doc.createElementNS(ns, "svg");
    bird.setAttribute("viewBox", "59 49 139 160");
    bird.setAttribute("class", "bird");
    bird.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS(ns, "path");
    path.setAttribute("d", SEFRA_BIRD_PATH);
    path.setAttribute("fill", SEFRA.accent);
    path.setAttribute("fill-rule", "evenodd");
    bird.appendChild(path);

    const tag = doc.createElement("span");
    tag.className = "tag";
    tag.textContent = "Ad";
    this.brandEl = doc.createElement("span");
    this.brandEl.className = "brand";
    this.textEl = doc.createElement("span");
    this.textEl.className = "copy";
    const arrow = doc.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "↗";
    this.earnedEl = doc.createElement("span");
    this.earnedEl.className = "earned";

    this.line.append(bird, tag, this.brandEl, this.textEl, arrow, this.earnedEl);
    this.line.addEventListener("click", () => {
      if (this.currentAdId) onClick(this.currentAdId);
    });

    root.append(style, this.line);
  }

  /** Place the ad in flow, directly after the (collapsed) spinner. */
  showInline(anchor: Element, ad: OverlayAd, earnedUsd: number): void {
    if (this.host.previousElementSibling !== anchor || !this.host.isConnected) {
      anchor.insertAdjacentElement("afterend", this.host);
    }
    this.line.classList.remove("floating");
    this.render(ad, earnedUsd);
  }

  /** Fallback placement when no spinner element is on screen. */
  showFloating(ad: OverlayAd, earnedUsd: number): void {
    if (!this.host.isConnected || this.host.parentElement !== this.doc.documentElement) {
      this.doc.documentElement.appendChild(this.host);
    }
    this.line.classList.add("floating");
    this.render(ad, earnedUsd);
  }

  hide(): void {
    this.currentAdId = null;
    this.line.classList.remove("visible");
    this.host.remove();
  }

  destroy(): void {
    this.hide();
  }

  private render(ad: OverlayAd, earnedUsd: number): void {
    this.currentAdId = ad.id;
    this.brandEl.textContent = ad.brand;
    this.textEl.textContent = `— ${ad.text}`;
    this.earnedEl.textContent = earnedUsd > 0 ? `${formatUsd(earnedUsd)} earned` : "";
    this.earnedEl.style.display = earnedUsd > 0 ? "" : "none";
    this.line.classList.add("visible");
    this.line.title = `Sponsored · ${ad.brand}. You earn 50% of this ad's revenue.`;
  }
}

type StyledElement = Element & ElementCSSInlineStyle;

/** Indicators are small; anything bigger is content, not a spinner. */
const MAX_INDICATOR_PX = 160;

/**
 * Finds the native loading indicator and collapses it (display:none) so the
 * sponsored line can take its place in flow, restoring it exactly the
 * moment serving stops. Pure inline-style toggles — the page's own DOM is
 * never mutated structurally.
 *
 * Anchor discovery, in order:
 * 1. Configured spinner selectors (remotely updatable).
 * 2. Animation heuristic: the loading indicator is, by definition, the
 *    thing that's animating. `document.getAnimations()` exposes every
 *    running animation's target; the spinner is a small, infinitely
 *    looping one in the content area. This survives UI redeploys that
 *    rename every class.
 *
 * Once an anchor is collapsed it stays the anchor while it remains in the
 * DOM — collapsing it stops its animation, so re-running the heuristic
 * would no longer find it.
 */
export class SpinnerSuppressor {
  private hidden = new Set<StyledElement>();

  constructor(
    private doc: Document,
    private selectors: string[],
  ) {}

  /** The element the sponsored line should replace, if one is on screen. */
  findAnchor(): StyledElement | null {
    for (const el of this.hidden) if (el.isConnected) return el;

    for (const sel of this.selectors) {
      let node: Element | null;
      try {
        node = this.doc.querySelector(sel);
      } catch {
        continue;
      }
      // Duck-typed instead of `instanceof HTMLElement`: elements from
      // iframes (or test DOMs) live in a different realm.
      const el = node as StyledElement | null;
      if (el && typeof el.style?.setProperty === "function") return el;
    }

    return this.findAnimatedIndicator();
  }

  private findAnimatedIndicator(): StyledElement | null {
    const doc = this.doc as Document & { getAnimations?: () => Animation[] };
    if (typeof doc.getAnimations !== "function") return null;
    let animations: Animation[];
    try {
      animations = doc.getAnimations();
    } catch {
      return null;
    }

    const main = this.doc.querySelector("main");
    let best: StyledElement | null = null;
    let bestInMain = false;

    for (const anim of animations) {
      const effect = anim.effect as KeyframeEffect | null;
      let el = effect?.target as StyledElement | null;
      if (!el || typeof el.style?.setProperty !== "function") continue;

      // Climb out of SVG internals so we anchor at the drawable root.
      const svgRoot = (el as { ownerSVGElement?: StyledElement | null }).ownerSVGElement;
      if (svgRoot) el = svgRoot;

      // Never anchor to our own pulse animation.
      if (el.localName === "kolex-ad") continue;
      const root = el.getRootNode();
      if ((root as ShadowRoot).host?.localName === "kolex-ad") continue;

      // Spinners loop forever; one-shot transitions are not wait states.
      const timing = effect?.getTiming?.();
      if (!timing || timing.iterations !== Infinity) continue;

      // The composer caret and input affordances are not loading indicators.
      if (el.closest?.("form, textarea, [contenteditable], kolex-ad")) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.width > MAX_INDICATOR_PX || rect.height > MAX_INDICATOR_PX) continue;

      // Prefer candidates in <main>, then the last one in document order
      // (the indicator rides the end of the conversation).
      const inMain = main !== null && main.contains(el);
      if (bestInMain && !inMain) continue;
      if (
        !best ||
        (inMain && !bestInMain) ||
        !!(best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      ) {
        best = el;
        bestInMain = inMain;
      }
    }
    return best;
  }

  collapse(el: StyledElement): void {
    if (!this.hidden.has(el)) {
      el.style.setProperty("display", "none", "important");
      this.hidden.add(el);
    }
  }

  restore(): void {
    for (const node of this.hidden) node.style.removeProperty("display");
    this.hidden.clear();
  }

  /**
   * Busy detection must treat elements *we* collapsed as still present —
   * otherwise hiding the spinner would end the busy state we detected it by.
   */
  contains(el: Element): boolean {
    return this.hidden.has(el as StyledElement);
  }
}
