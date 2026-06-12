import { formatUsd } from "../shared/economics.js";

export interface OverlayAd {
  id: string;
  brand: string;
  text: string;
  /** Advertiser logo as a data: URL. Replaces the default mark when set. */
  iconDataUrl?: string;
  /** Brand accent color (#rrggbb). Tints the dot, tag, arrow, hover. */
  accent?: string;
  house?: boolean;
}

/** Sefra/Kolex brand tokens (meetsefra.com) — used only as the fallback. */
const SEFRA = {
  surface: "#FFFFFF",
  paper: "#F4F4F1",
  ink: "#0F1216",
  muted: "#6E7079",
  rule: "#DBDBD5",
  accent: "#1547F5",
  positive: "#16A34A",
  sans: '"Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: '"Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
};

const SEFRA_BIRD_PATH =
  "M66.616 51.836 L67.015 51.703 L125.47 110.157 L129.997 116.016 L133.193 121.076 L135.59 125.603 L137.987 131.995 L139.851 141.582 L139.851 150.636 L139.318 154.897 L137.72 161.821 L135.856 167.147 L131.595 175.936 L123.872 189.517 L118.812 199.637 L114.818 206.561 L114.152 207.227 L70.078 207.094 L113.353 173.406 L114.285 172.207 L114.551 170.876 L114.551 166.881 L112.954 162.62 L109.625 158.759 L100.038 153.699 L92.581 150.503 L86.19 146.508 L83.526 144.378 L79.132 139.984 L77.268 137.587 L74.339 133.06 L71.942 128.266 L70.344 123.739 L70.344 122.94 L71.01 122.807 L73.14 124.405 L77.934 127.068 L99.771 136.655 L106.163 140.117 L106.562 139.984 L102.168 135.856 L96.309 131.329 L78.2 118.812 L74.206 115.35 L70.344 111.223 L66.083 105.097 L62.621 97.907 L60.757 90.983 L60.224 85.923 L60.358 82.861 L61.689 83.393 L67.814 89.518 L73.407 94.046 L96.842 110.557 L106.163 117.747 L106.695 118.013 L106.828 117.614 L102.301 112.554 L78.6 89.385 L71.409 80.597 L68.214 74.472 L65.817 66.216 L65.284 59.292 L65.551 59.026 L65.551 55.83 L66.483 51.969Z M167.014 89.385 L170.077 89.252 L174.87 90.584 L178.066 92.448 L180.995 95.643 L186.588 95.91 L189.784 96.709 L192.713 98.307 L195.509 101.369 L188.985 103.1 L183.659 106.03 L179.797 109.891 L177.4 114.152 L175.802 119.478 L175.802 137.054 L175.27 141.848 L174.205 146.642 L172.607 151.701 L169.145 159.424 L165.683 164.751 L162.487 168.745 L155.163 175.536 L148.239 180.063 L141.848 183.259 L135.989 185.656 L132.794 186.721 L131.728 186.721 L131.595 186.055 L134.791 180.729 L140.117 170.077 L141.715 166.082 L143.845 159.158 L145.177 150.37 L145.177 142.114 L144.378 136.256 L142.248 128.533 L140.916 125.071 L138.519 120.543 L138.519 119.478 L148.106 104.299 L145.044 103.366 L141.582 101.236 L139.584 98.972 L138.519 96.842 L144.511 96.709 L147.707 96.176 L151.968 94.845 L161.022 90.85 L164.218 89.785 L166.881 89.518Z";

const STYLE = `
  :host { all: initial; --kx-accent: ${SEFRA.accent}; }
  .line {
    position: fixed;
    z-index: 2147483646;
    display: inline-flex;
    align-items: center;
    gap: 9px;
    max-width: min(560px, calc(100vw - 48px));
    padding: 7px 12px;
    background: ${SEFRA.surface};
    border: 1px solid ${SEFRA.rule};
    border-radius: 6px;
    box-shadow: 0 2px 10px rgba(15, 18, 22, 0.12);
    font: 500 13px/1.4 ${SEFRA.sans};
    color: ${SEFRA.ink};
    cursor: pointer;
    white-space: nowrap;
    opacity: 0;
    transition: opacity 120ms ease;
  }
  .line.visible { opacity: 1; }
  .line:hover { border-color: var(--kx-accent); }
  /* Mark: brand logo when supplied, else the Kolex/Sefra bird (fallback). */
  .mark { flex: none; display: inline-flex; align-items: center; }
  .mark .bird { height: 15px; width: auto; display: block; }
  .mark img {
    height: 18px; width: 18px; object-fit: contain;
    border-radius: 4px; display: block;
  }
  .dot {
    flex: none;
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--kx-accent);
    animation: kolexpulse 1.1s ease-in-out infinite;
  }
  @keyframes kolexpulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; transform: scale(0.8); } }
  .tag {
    flex: none;
    font: 500 10px/1 ${SEFRA.mono};
    letter-spacing: 1.2px;
    text-transform: uppercase;
    color: var(--kx-accent);
  }
  .brand { flex: none; font-weight: 600; }
  .copy { overflow: hidden; text-overflow: ellipsis; color: ${SEFRA.muted}; font-weight: 400; }
  .arrow { flex: none; color: var(--kx-accent); }
  .earned {
    flex: none;
    font: 500 11px/1 ${SEFRA.mono};
    color: ${SEFRA.positive};
    font-variant-numeric: tabular-nums;
    padding-left: 9px;
    border-left: 1px solid ${SEFRA.rule};
  }
`;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PlaceOpts {
  /** The indicator's captured rect to sit at, or null to dock near the composer. */
  anchor?: Box | null;
  /** Top edge of the composer/input region — the line never crosses below it. */
  composerTop?: number;
}

/**
 * Compute the line's top-left, given the (stable) anchor rect, the line's
 * measured size, the viewport, and the composer's top edge.
 *
 * Hard rule: the line's bottom is always kept a gap above `composerTop`, so
 * it can never overlap the input box or any text the user is typing. When
 * the anchor itself sits at/over the composer, the line is pushed up above
 * it. Pure function so the geometry is unit-tested without a DOM.
 */
export function placeLine(
  anchor: Box | null,
  lineW: number,
  lineH: number,
  vw: number,
  vh: number,
  composerTop: number,
): { left: number; top: number } {
  const margin = 12;
  const gap = 28; // clearance kept above the composer / input
  const floor = composerTop > 0 && composerTop <= vh ? composerTop : vh - 32;
  const maxTop = floor - gap - lineH; // bottom stays a clear gap above the composer

  let left = anchor ? anchor.left : (vw - lineW) / 2;
  let top = anchor ? anchor.top + anchor.height / 2 - lineH / 2 : maxTop;

  if (top > maxTop) top = maxTop; // never over the input / composer
  left = Math.max(margin, Math.min(left, vw - lineW - margin));
  top = Math.max(margin, top);
  return { left: Math.round(left), top: Math.round(top) };
}

/**
 * The sponsored status line. Rendered in a shadow root (so site CSS can't
 * touch it and ours can't leak) and positioned `fixed`:
 *
 * - anchored: pinned to the native indicator's on-screen rect, so it sits
 *   exactly where the spinner was — centered or indented, whatever the page
 *   does. The content script re-pins every 250ms, so it tracks scroll and
 *   layout. This is the "fully replace the spinner" mode.
 * - floating: bottom-center, only when no indicator can be located.
 *
 * Brand takeover: when the ad carries a logo + accent, the advertiser's
 * brand drives the whole line. The Kolex/Sefra bird appears only as the
 * fallback mark for an ad with no logo of its own.
 */
export class AdView {
  private doc: Document;
  private host: HTMLElement;
  private line: HTMLElement;
  private markEl: HTMLElement;
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

    this.markEl = doc.createElement("span");
    this.markEl.className = "mark";
    const dot = doc.createElement("span");
    dot.className = "dot";
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

    this.line.append(this.markEl, dot, tag, this.brandEl, this.textEl, arrow, this.earnedEl);
    this.line.addEventListener("click", () => {
      if (this.currentAdId) onClick(this.currentAdId);
    });

    root.append(style, this.line);
  }

  /**
   * Render the ad and place it. The caller passes a *stable* anchor rect
   * (captured once, so the line doesn't crawl as text streams) and the
   * composer's top edge; placement clamps the line above the composer so it
   * never covers the input or typed text.
   */
  show(ad: OverlayAd, earnedUsd: number, opts: PlaceOpts = {}): void {
    this.attach();
    // Rebuild the logo/brand only when the ad changes — re-running it every
    // placement tick would reload the <img> and flicker.
    if (ad.id !== this.currentAdId) this.renderContent(ad);
    this.updateEarned(earnedUsd);
    this.line.classList.add("visible");

    const r = this.line.getBoundingClientRect();
    const win = this.doc.defaultView;
    const vw = win?.innerWidth || 1024;
    const vh = win?.innerHeight || 768;
    const { left, top } = placeLine(
      opts.anchor ?? null,
      r.width || 0,
      r.height || 0,
      vw,
      vh,
      opts.composerTop ?? vh,
    );
    this.line.style.left = `${left}px`;
    this.line.style.top = `${top}px`;
    this.line.style.bottom = "";
    this.line.style.transform = "";
  }

  hide(): void {
    this.currentAdId = null;
    this.line.classList.remove("visible");
    this.host.remove();
  }

  destroy(): void {
    this.hide();
  }

  private attach(): void {
    if (!this.host.isConnected) this.doc.documentElement.appendChild(this.host);
  }

  /** Default Kolex/Sefra bird mark, in the active accent color. */
  private birdMark(color: string): SVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const bird = this.doc.createElementNS(ns, "svg");
    bird.setAttribute("viewBox", "59 49 139 160");
    bird.setAttribute("class", "bird");
    bird.setAttribute("aria-hidden", "true");
    const path = this.doc.createElementNS(ns, "path");
    path.setAttribute("d", SEFRA_BIRD_PATH);
    path.setAttribute("fill", color);
    path.setAttribute("fill-rule", "evenodd");
    bird.appendChild(path);
    return bird;
  }

  private renderContent(ad: OverlayAd): void {
    this.currentAdId = ad.id;

    // Brand takeover: the advertiser's accent tints every accent surface,
    // and their logo replaces the fallback bird.
    const hasLogo = !!ad.iconDataUrl && ad.iconDataUrl.startsWith("data:image/");
    const accent = ad.accent && /^#[0-9a-fA-F]{6}$/.test(ad.accent) ? ad.accent : SEFRA.accent;
    this.host.style.setProperty("--kx-accent", accent);

    this.markEl.replaceChildren();
    if (hasLogo) {
      const img = this.doc.createElement("img");
      img.src = ad.iconDataUrl as string;
      img.alt = "";
      this.markEl.appendChild(img);
    } else {
      // Only here — an ad with no brand logo — do we show the Kolex mark.
      this.markEl.appendChild(this.birdMark(accent));
    }

    this.brandEl.textContent = ad.brand;
    this.textEl.textContent = `— ${ad.text}`;
    this.line.title = `Sponsored · ${ad.brand}. You earn 50% of this ad's revenue.`;
  }

  private updateEarned(earnedUsd: number): void {
    this.earnedEl.textContent = earnedUsd > 0 ? `${formatUsd(earnedUsd)} earned` : "";
    this.earnedEl.style.display = earnedUsd > 0 ? "" : "none";
  }
}

type StyledElement = Element & ElementCSSInlineStyle;

/** Indicators are small; anything bigger is content, not a spinner. */
const MAX_INDICATOR_PX = 160;

/** Indicators in the same wait cluster sit within this band vertically. */
const CLUSTER_BAND_PX = 140;

/**
 * Finds the native loading indicator(s) and hides them (visibility:hidden,
 * so the box and page layout are preserved), then the sponsored line is
 * placed at the cluster's left edge. Restored exactly when serving stops.
 * Pure inline styles — the page's DOM is never mutated structurally.
 *
 * The key correctness point: a wait state can render *several* animated
 * nodes next to each other (a starburst SVG plus an empty streaming-text
 * placeholder). Picking one and hiding it leaves the visible spinner on
 * screen. So we gather the whole cluster near the newest indicator and hide
 * all of it, anchoring the ad to the cluster's left edge.
 *
 * Candidates come from three sources so any spinner implementation is found:
 *  - CSS / Web Animations targets (`getAnimations()`)
 *  - SVG SMIL spinners (`<animate*>` children) — invisible to
 *    getAnimations(); the bare rotating starburst on claude.ai
 *  - infinite-CSS small elements in <main>
 * filtered to small, square-ish, visible elements outside the composer and
 * toolbar buttons.
 */
export class SpinnerSuppressor {
  private hidden = new Set<StyledElement>();
  /** Last-seen transform signatures, to detect rAF/JS-driven spinners. */
  private xform = new WeakMap<Element, string>();

  constructor(
    private doc: Document,
    private selectors: string[],
  ) {}

  /** Left-most element of the live indicator cluster — where the ad sits. */
  findAnchor(): StyledElement | null {
    const cluster = this.cluster();
    if (cluster.length === 0) {
      for (const el of this.hidden) if (el.isConnected) return el;
      return null;
    }
    return cluster[0] ?? null;
  }

  /**
   * Hide the whole live indicator cluster (so no native spinner shows) and
   * return it, left-most first. Idempotent; safe to call every tick.
   */
  hideCluster(): StyledElement[] {
    const cluster = this.cluster();
    for (const el of cluster) this.hide(el);
    // Re-assert on anything we hid earlier that's still around (React may
    // re-render the node; keep the previous one hidden too).
    for (const el of this.hidden) {
      if (el.isConnected) el.style.setProperty("visibility", "hidden", "important");
    }
    return cluster;
  }

  /**
   * The live indicator cluster: candidates within a vertical band of the
   * newest (lowest) one, sorted left-most first.
   */
  private cluster(): StyledElement[] {
    const all = this.candidates();
    if (all.length === 0) return [];
    const rect = (el: StyledElement) => el.getBoundingClientRect();
    const newestTop = Math.max(...all.map((el) => rect(el).top));
    return all
      .filter((el) => Math.abs(rect(el).top - newestTop) <= CLUSTER_BAND_PX)
      .sort((a, b) => rect(a).left - rect(b).left);
  }

  /** All plausible indicator elements right now (configured + heuristic). */
  private candidates(): StyledElement[] {
    const out = new Set<StyledElement>();

    // Configured selectors are trusted (author/remote-curated): include them
    // without the size/shape filter, but never the composer or our own ad.
    for (const sel of this.selectors) {
      let nodes: NodeListOf<Element>;
      try {
        nodes = this.doc.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const node of nodes) {
        const el = node as StyledElement;
        if (typeof el.style?.setProperty === "function" && this.isSafe(el)) out.add(el);
      }
    }

    const main = this.doc.querySelector("main");
    const animated = new Set<StyledElement>();

    const doc = this.doc as Document & { getAnimations?: () => Animation[] };
    if (typeof doc.getAnimations === "function") {
      try {
        for (const anim of doc.getAnimations()) {
          const effect = anim.effect as KeyframeEffect | null;
          if (effect?.getTiming?.()?.iterations !== Infinity) continue;
          const el = this.drawableRoot(effect.target as Element | null);
          if (el) animated.add(el);
        }
      } catch {
        // fall through to structural scan
      }
    }

    const scope = main ?? this.doc.body ?? this.doc.documentElement;
    let nodes: NodeListOf<Element>;
    try {
      nodes = scope.querySelectorAll(
        "svg, [class*='spin'], [class*='load'], [class*='think'], [class*='dot'], " +
          "[role='progressbar'], [role='status'], [aria-live='polite'], [aria-live='assertive']",
      );
    } catch {
      nodes = scope.querySelectorAll("svg");
    }
    for (const node of nodes) {
      const el = node as StyledElement;
      if (typeof el.style?.setProperty !== "function") continue;
      // isAnimating: SMIL or infinite CSS. spinningNow: also catches
      // requestAnimationFrame / Lottie spinners by sampling the transform.
      if (this.isAnimating(el) || this.spinningNow(el)) animated.add(el);
    }

    // Each animated element is the *icon*; climb to the small row that also
    // holds its label ("✦ Thinking"), so the whole indicator is replaced.
    const plausible = [...animated].filter((el) => this.isPlausibleIndicator(el));
    const inMain = plausible.filter((el) => main !== null && main.contains(el));
    for (const el of inMain.length > 0 ? inMain : plausible) {
      out.add(this.indicatorContainer(el));
    }

    // Keep already-hidden nodes in the set so the cluster/anchor is stable.
    for (const el of this.hidden) if (el.isConnected) out.add(el);

    return [...out];
  }

  /**
   * The smallest tidy row that contains the spinner icon AND its label.
   * Climbs up while the parent stays a small, non-interactive box with short
   * text. Only climbs when the parent has a real measured size, so it never
   * over-grabs (and stays a no-op in size-less test DOMs).
   */
  private indicatorContainer(el: StyledElement): StyledElement {
    let best = el;
    let p = el.parentElement;
    for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
      const parent = p as StyledElement;
      if (!this.isSafe(parent)) break;
      if (parent.querySelector?.("button, textarea, input, [contenteditable], form, a")) break;
      const r = parent.getBoundingClientRect();
      const text = (parent.textContent ?? "").trim();
      // A loading row is SHORT (one or two lines) with little text — the row
      // may span the full message width, so height (not width) is the guard.
      // This is what makes us hide "✦ Thinking", label and all, not just the
      // icon. Once tokens stream the turn grows tall and is rejected here.
      if (r.height >= 1 && r.height <= 64 && r.width <= 900 && text.length <= 44) best = parent;
      else break;
    }
    return best;
  }

  /**
   * Is this element visibly spinning *right now*? Catches spinners driven by
   * requestAnimationFrame / Lottie / JS (no CSS animation, no SMIL) by
   * sampling the computed transform of the element and its descendants and
   * comparing to the previous tick.
   */
  private spinningNow(el: StyledElement): boolean {
    const win = (el.ownerDocument as Document | null)?.defaultView;
    if (!win?.getComputedStyle) return false;
    let sig = "";
    let n = 0;
    const sample = (node: Element) => {
      try {
        sig += (win.getComputedStyle(node).transform || "") + "|";
      } catch {
        /* ignore */
      }
    };
    sample(el);
    for (const child of el.querySelectorAll("*")) {
      if (n++ >= 32) break;
      sample(child);
    }
    const prev = this.xform.get(el);
    this.xform.set(el, sig);
    return prev !== undefined && prev !== sig && /matrix|rotate|translate|skew/.test(sig);
  }

  /** Climb out of SVG internals so we anchor at the drawable root. */
  private drawableRoot(el: Element | null): StyledElement | null {
    if (!el) return null;
    const svgRoot = (el as { ownerSVGElement?: StyledElement | null }).ownerSVGElement;
    const target = (svgRoot ?? el) as StyledElement;
    return typeof target.style?.setProperty === "function" ? target : null;
  }

  /** SMIL animation children, or an infinite CSS animation. */
  private isAnimating(el: StyledElement): boolean {
    try {
      if (el.querySelector?.("animate, animateTransform, animateMotion, set")) return true;
    } catch {
      // some elements reject querySelector for these names
    }
    const win = (el.ownerDocument as Document | null)?.defaultView;
    if (win?.getComputedStyle) {
      try {
        const cs = win.getComputedStyle(el);
        if (
          cs.animationName &&
          cs.animationName !== "none" &&
          (cs.animationIterationCount || "").split(",").some((v) => v.trim() === "infinite")
        ) {
          return true;
        }
      } catch {
        // jsdom and some realms throw — treat as not-animating
      }
    }
    return false;
  }

  /** Never hide our own ad, the composer, or an interactive control. */
  private isSafe(el: StyledElement): boolean {
    if (el.localName === "kolex-ad") return false;
    if ((el.getRootNode() as ShadowRoot).host?.localName === "kolex-ad") return false;
    if (el.closest?.("form, textarea, [contenteditable], button, [role='button'], a, kolex-ad")) {
      return false;
    }
    return true;
  }

  /** A small, square-ish, visible element that reads as a spinner. */
  private isPlausibleIndicator(el: StyledElement): boolean {
    if (!this.isSafe(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.width > MAX_INDICATOR_PX || rect.height > MAX_INDICATOR_PX) return false;
    const ratio = rect.width / rect.height;
    return ratio >= 0.4 && ratio <= 2.5;
  }

  /** Hide the indicator while keeping its box, so layout doesn't shift. */
  hide(el: StyledElement): void {
    if (!this.hidden.has(el)) {
      el.style.setProperty("visibility", "hidden", "important");
      this.hidden.add(el);
    }
  }

  restore(): void {
    for (const node of this.hidden) node.style.removeProperty("visibility");
    this.hidden.clear();
  }

  /**
   * Busy detection must treat elements *we* hid as still present — otherwise
   * hiding the spinner would end the busy state we detected it by.
   */
  contains(el: Element): boolean {
    return this.hidden.has(el as StyledElement);
  }
}
