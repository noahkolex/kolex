import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { AdView, SpinnerSuppressor } from "../src/content/overlay.js";

function page() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div class="chat">
        <div class="spinner">Thinking…</div>
      </div>
      <button data-testid="stop-button">stop</button>
    </body></html>`,
  );
  return { dom, doc: dom.window.document };
}

const AD = { id: "ex-indie", brand: "Indie Hackers", text: "Where founders share what's working" };

const RECT = { left: 240, top: 300, width: 24, height: 24 };

test("anchored mode pins the line to the indicator's rect", () => {
  const { doc } = page();
  const view = new AdView(doc, () => {});

  view.showAnchored(RECT, AD, 0.0123);

  const host = doc.querySelector("kolex-ad");
  assert.ok(host, "host mounted");
  assert.equal(host.parentElement, doc.documentElement, "host attached to the root");

  const line = host.shadowRoot?.querySelector<HTMLElement>(".line");
  assert.ok(line, "line rendered in shadow root");
  assert.ok(line.classList.contains("visible"));
  // Left-aligned to the indicator, vertically centered on it.
  assert.equal(line.style.left, "240px");
  assert.equal(line.style.top, "312px");
  assert.equal(line.style.transform, "translateY(-50%)");
  assert.ok(line.querySelector(".mark .bird"), "house ad with no logo uses the Kolex bird");
  assert.match(line.textContent ?? "", /Ad/);
  assert.match(line.textContent ?? "", /Indie Hackers/);
  assert.match(line.textContent ?? "", /\$0\.01 earned/);

  // Re-pinning to a new rect is stable (no duplicate hosts).
  view.showAnchored({ left: 50, top: 80, width: 20, height: 20 }, AD, 0.02);
  assert.equal(doc.querySelectorAll("kolex-ad").length, 1);
  assert.equal(line.style.left, "50px");

  view.hide();
  assert.equal(doc.querySelector("kolex-ad"), null, "hide detaches the host");
});

test("brand takeover: advertiser logo and accent replace the defaults", () => {
  const { doc } = page();
  const view = new AdView(doc, () => {});
  const icon =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  view.showFloating(
    { id: "acme", brand: "Acme", text: "Ship faster", iconDataUrl: icon, accent: "#FF4F1F" },
    0,
  );

  const host = doc.querySelector<HTMLElement>("kolex-ad")!;
  const line = host.shadowRoot!.querySelector<HTMLElement>(".line")!;
  const img = line.querySelector<HTMLImageElement>(".mark img");
  assert.ok(img, "brand logo rendered as <img>");
  assert.equal(img.getAttribute("src"), icon);
  assert.equal(line.querySelector(".mark .bird"), null, "no default bird when brand logo is set");
  assert.equal(host.style.getPropertyValue("--kx-accent"), "#FF4F1F", "accent tints the line");

  // Switching to an ad with no icon falls back to the Kolex bird.
  view.showFloating({ id: "ex-indie", brand: "Indie", text: "Founders share", house: true }, 0);
  assert.ok(line.querySelector(".mark .bird"), "logo-less ad uses the bird");
  assert.equal(line.querySelector(".mark img"), null);
  assert.equal(host.style.getPropertyValue("--kx-accent"), "#1547F5", "accent resets to cobalt");
});

test("floating fallback pins to the bottom center", () => {
  const { doc } = page();
  const view = new AdView(doc, () => {});
  view.showFloating(AD, 0);

  const host = doc.querySelector("kolex-ad")!;
  assert.equal(host.parentElement, doc.documentElement);
  const line = host.shadowRoot!.querySelector<HTMLElement>(".line")!;
  assert.equal(line.style.left, "50%");
  assert.equal(line.style.bottom, "96px");
  assert.equal(line.style.transform, "translateX(-50%)");
});

test("clicking the line reports the served ad id", () => {
  const { dom, doc } = page();
  let clicked: string | null = null;
  const view = new AdView(doc, (id) => (clicked = id));
  view.showFloating({ id: "acme-1", brand: "Acme", text: "ten chars!" }, 0);

  const line = doc.querySelector("kolex-ad")!.shadowRoot!.querySelector(".line")!;
  line.dispatchEvent(new dom.window.Event("click"));
  assert.equal(clicked, "acme-1");

  // After hide, clicks are inert.
  clicked = null;
  view.hide();
  line.dispatchEvent(new dom.window.Event("click"));
  assert.equal(clicked, null);
});

test("suppressor collapses the native indicator and restores it exactly", () => {
  const { doc } = page();
  const spinner = doc.querySelector<HTMLElement>(".spinner")!;
  const suppressor = new SpinnerSuppressor(doc, [".spinner", "%%bad-selector%%"]);

  assert.equal(suppressor.findAnchor(), spinner);

  suppressor.hide(spinner);
  assert.equal(spinner.style.getPropertyValue("visibility"), "hidden");
  assert.equal(spinner.style.getPropertyPriority("visibility"), "important");
  assert.ok(suppressor.contains(spinner), "hidden elements still count as present");

  suppressor.hide(spinner); // idempotent
  suppressor.restore();
  assert.equal(spinner.style.getPropertyValue("visibility"), "");
  assert.equal(suppressor.contains(spinner), false);

  suppressor.restore(); // double-restore is a no-op
  assert.equal(spinner.style.getPropertyValue("visibility"), "");
});

// ---- Animation heuristic: find the indicator with no selector at all ----

function rectOf(width: number, height: number) {
  return () =>
    ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 }) as DOMRect;
}

function loopingAnim(target: Element, iterations: number = Infinity) {
  return { effect: { target, getTiming: () => ({ iterations }) } } as unknown as Animation;
}

function heuristicPage() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <main>
        <div class="msg">streamed text</div>
        <div id="starburst"></div>
      </main>
      <form><div contenteditable="true"><span id="caret"></span></div></form>
      <div id="sidebar-dot"></div>
    </body></html>`,
  );
  const doc = dom.window.document;
  const star = doc.querySelector<HTMLElement>("#starburst")!;
  const caret = doc.querySelector<HTMLElement>("#caret")!;
  const dot = doc.querySelector<HTMLElement>("#sidebar-dot")!;
  star.getBoundingClientRect = rectOf(48, 48);
  caret.getBoundingClientRect = rectOf(2, 18);
  dot.getBoundingClientRect = rectOf(8, 8);
  return { doc, star, caret, dot };
}

test("animation heuristic picks the looping indicator, not the caret or chrome", () => {
  const { doc, star, caret, dot } = heuristicPage();
  (doc as unknown as { getAnimations: () => Animation[] }).getAnimations = () => [
    loopingAnim(caret), // inside the composer → excluded
    loopingAnim(dot), // outside <main> → loses to in-main candidate
    loopingAnim(star),
  ];
  const suppressor = new SpinnerSuppressor(doc, ["%%no-such-selector%%"]);
  assert.equal(suppressor.findAnchor(), star);
});

test("one-shot transitions and oversized animations are not indicators", () => {
  const { doc, star } = heuristicPage();
  const msg = doc.querySelector<HTMLElement>(".msg")!;
  msg.getBoundingClientRect = rectOf(600, 24); // shimmering text — too wide
  (doc as unknown as { getAnimations: () => Animation[] }).getAnimations = () => [
    loopingAnim(star, 1), // finite → excluded
    loopingAnim(msg),
  ];
  const suppressor = new SpinnerSuppressor(doc, []);
  assert.equal(suppressor.findAnchor(), null);
});

test("standalone SMIL starburst is found with no animation API and no text", () => {
  // The claude.ai case: a bare rotating spinner with no sibling text.
  // getAnimations() is blind to SMIL, so detection must scan the DOM.
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <main>
        <div class="msg">previous answer</div>
        <div class="toolbar">
          <button><svg class="icon" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg></button>
        </div>
        <svg id="starburst" viewBox="0 0 24 24">
          <g><animateTransform attributeName="transform" type="rotate"
             from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></g>
        </svg>
      </main>
    </body></html>`,
  );
  const doc = dom.window.document;
  const star = doc.querySelector<HTMLElement>("#starburst")!;
  const toolbarIcon = doc.querySelector<HTMLElement>(".icon")!;
  star.getBoundingClientRect = rectOf(40, 40);
  toolbarIcon.getBoundingClientRect = rectOf(20, 20);
  // No getAnimations() at all → must rely on the SMIL structural scan.
  delete (doc as unknown as { getAnimations?: unknown }).getAnimations;

  const suppressor = new SpinnerSuppressor(doc, ["%%no-match%%"]);
  const anchor = suppressor.findAnchor();
  assert.equal(anchor, star, "the SMIL-animated starburst is the anchor");
  assert.notEqual(anchor, toolbarIcon, "the toolbar button icon is never picked");
});

test("collapsed anchor stays the anchor even after its animation stops", () => {
  const { doc, star } = heuristicPage();
  const docAnims = doc as unknown as { getAnimations: () => Animation[] };
  docAnims.getAnimations = () => [loopingAnim(star)];
  const suppressor = new SpinnerSuppressor(doc, []);

  const anchor = suppressor.findAnchor()!;
  suppressor.hide(anchor);
  // hiding stops the animation — the heuristic alone would lose it.
  docAnims.getAnimations = () => [];
  assert.equal(suppressor.findAnchor(), anchor, "anchor persists while hidden");

  // Site re-render removes the node → anchor is released.
  anchor.remove();
  assert.equal(suppressor.findAnchor(), null);
});
