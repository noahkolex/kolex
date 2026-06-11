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

  assert.equal(suppressor.findSpinner(), spinner);

  suppressor.suppress();
  assert.equal(spinner.style.getPropertyValue("display"), "none");
  assert.equal(spinner.style.getPropertyPriority("display"), "important");
  assert.ok(suppressor.contains(spinner), "collapsed elements still count as present");

  suppressor.suppress(); // idempotent
  suppressor.restore();
  assert.equal(spinner.style.getPropertyValue("display"), "");
  assert.equal(suppressor.contains(spinner), false);

  suppressor.restore(); // double-restore is a no-op
  assert.equal(spinner.style.getPropertyValue("display"), "");
});
