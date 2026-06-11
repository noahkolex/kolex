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

const AD = { id: "house-ramp", brand: "Ramp", text: "Close your books 8x faster" };

test("inline mode mounts the ad directly after the spinner", () => {
  const { doc } = page();
  const view = new AdView(doc, () => {});
  const spinner = doc.querySelector(".spinner")!;

  view.showInline(spinner, AD, 0.0123);

  const host = doc.querySelector("kolex-ad");
  assert.ok(host, "host mounted");
  assert.equal(spinner.nextElementSibling, host, "ad sits in the spinner's place in flow");

  const line = host.shadowRoot?.querySelector(".line");
  assert.ok(line, "line rendered in shadow root");
  assert.ok(line.classList.contains("visible"));
  assert.equal(line.classList.contains("floating"), false, "inline mode is not floating");
  assert.ok(line.querySelector(".bird"), "sefra bird mark present");
  assert.match(line.textContent ?? "", /Ad/);
  assert.match(line.textContent ?? "", /Ramp/);
  assert.match(line.textContent ?? "", /Close your books 8x faster/);
  assert.match(line.textContent ?? "", /\$0\.01 earned/);

  // Re-show on the same anchor is stable (no duplicate hosts).
  view.showInline(spinner, AD, 0.02);
  assert.equal(doc.querySelectorAll("kolex-ad").length, 1);

  view.hide();
  assert.equal(doc.querySelector("kolex-ad"), null, "hide detaches the host");
});

test("inline mode follows the spinner when the site re-renders", () => {
  const { doc } = page();
  const view = new AdView(doc, () => {});
  const first = doc.querySelector(".spinner")!;
  view.showInline(first, AD, 0);

  // Stream re-render: old spinner gone, new one appears elsewhere.
  first.remove();
  const next = doc.createElement("div");
  next.className = "spinner";
  doc.querySelector(".chat")!.appendChild(next);

  view.showInline(next, AD, 0);
  assert.equal(next.nextElementSibling, doc.querySelector("kolex-ad"));
  assert.equal(doc.querySelectorAll("kolex-ad").length, 1);
});

test("floating fallback attaches to the document root", () => {
  const { doc } = page();
  const view = new AdView(doc, () => {});
  view.showFloating(AD, 0);

  const host = doc.querySelector("kolex-ad")!;
  assert.equal(host.parentElement, doc.documentElement);
  assert.ok(host.shadowRoot!.querySelector(".line")!.classList.contains("floating"));
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

  suppressor.collapse(spinner);
  assert.equal(spinner.style.getPropertyValue("display"), "none");
  assert.equal(spinner.style.getPropertyPriority("display"), "important");
  assert.ok(suppressor.contains(spinner), "collapsed elements still count as present");

  suppressor.collapse(spinner); // idempotent
  suppressor.restore();
  assert.equal(spinner.style.getPropertyValue("display"), "");
  assert.equal(suppressor.contains(spinner), false);

  suppressor.restore(); // double-restore is a no-op
  assert.equal(spinner.style.getPropertyValue("display"), "");
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

test("collapsed anchor stays the anchor even after its animation stops", () => {
  const { doc, star } = heuristicPage();
  const docAnims = doc as unknown as { getAnimations: () => Animation[] };
  docAnims.getAnimations = () => [loopingAnim(star)];
  const suppressor = new SpinnerSuppressor(doc, []);

  const anchor = suppressor.findAnchor()!;
  suppressor.collapse(anchor);
  // display:none stops the animation — the heuristic alone would lose it.
  docAnims.getAnimations = () => [];
  assert.equal(suppressor.findAnchor(), anchor, "anchor persists while collapsed");

  // Site re-render removes the node → anchor is released.
  anchor.remove();
  assert.equal(suppressor.findAnchor(), null);
});
