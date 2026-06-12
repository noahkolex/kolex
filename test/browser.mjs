// Real-browser test: loads each fixture in headless Chromium, runs the actual
// built extension/content.js, waits through a 5s "busy" wait state, and
// asserts the on-screen result — the native spinner is hidden, the kolex ad
// is shown, and it never overlaps the composer/input. Screenshots each.
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SHOT_DIR || "/tmp/claude";
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

async function geometry(page) {
  // Read the rendered state from inside the page: spinner visibility, the
  // kolex ad line's box, and the composer/input box.
  return page.evaluate(() => {
    const host = document.querySelector("kolex-ad");
    const line = host && host.shadowRoot && host.shadowRoot.querySelector(".line");
    const lineBox = line ? line.getBoundingClientRect() : null;
    const adVisible = line ? getComputedStyle(line).opacity !== "0" && line.classList.contains("visible") : false;
    const adText = line ? line.textContent : "";
    const hasLogo = !!(line && line.querySelector(".mark img"));

    // Any natively-visible spinner GRAPHIC left on screen? (Check the actual
    // visuals, not wrapper divs — an empty hidden-children wrapper is fine.)
    const spinnerEls = [...document.querySelectorAll("#starburst, #star, .spinner, .placeholder")];
    const isVisible = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.visibility !== "hidden" && cs.display !== "none" && r.width > 0 && r.height > 0;
    };
    const visibleSpinner = spinnerEls.find(isVisible);
    // The literal "Thinking" label must be gone too — check leaf elements
    // only (an ancestor's textContent includes hidden descendants).
    const visibleThinking = [...document.querySelectorAll("main *")].some(
      (el) => el.children.length === 0 && (el.textContent || "").trim() === "Thinking" && isVisible(el),
    );

    const input = document.querySelector("textarea, [contenteditable='true']");
    const inputBox = input ? input.getBoundingClientRect() : null;
    const composer = document.querySelector(".composer");
    const composerBox = composer ? composer.getBoundingClientRect() : null;

    return {
      hasHost: !!host,
      adVisible,
      adText,
      hasLogo,
      lineBox: lineBox && { left: lineBox.left, top: lineBox.top, right: lineBox.right, bottom: lineBox.bottom, width: lineBox.width, height: lineBox.height },
      visibleSpinnerId: visibleSpinner ? visibleSpinner.id || visibleSpinner.className : null,
      visibleThinking,
      inputBox: inputBox && { left: inputBox.left, top: inputBox.top, right: inputBox.right, bottom: inputBox.bottom },
      composerBox: composerBox && { top: composerBox.top },
    };
  });
}

function intersects(a, b) {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

async function run(name, file, opts = {}) {
  console.log(`\n▶ ${name}  (${file})`);
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(pathToFileURL(path.join(DIR, "fixtures", file)).href);
  // The content script ticks every 1s; an impression settles after 5s of
  // continuous busy. Wait through it so the ad is serving.
  await page.waitForTimeout(6500);

  const g = await geometry(page);
  await page.screenshot({ path: path.join(OUT, `kolex-${name}.png`) });

  ok("no page errors", errors.length === 0, errors[0] || "");

  // Once the model's answer streams in, the ad must get OUT OF THE WAY entirely
  // (not dock, not linger) — it only sponsors the wait, never the answer.
  if (opts.streamingHides) {
    ok("ad is hidden once the answer streams in", !g.hasHost || !g.adVisible, `hasHost=${g.hasHost} visible=${g.adVisible}`);
    const paras = await page.$$("p.para");
    ok("answer text is showing unobstructed", paras.length > 0, `${paras.length} paragraphs`);
    console.log(`  📸 ${path.join(OUT, `kolex-${name}.png`)}`);
    await browser.close();
    return;
  }

  ok("kolex ad host mounted", g.hasHost);
  ok("ad line is visible", g.adVisible);
  ok("ad shows the brand logo (Notion)", g.hasLogo);
  ok("ad copy present", /Notion/.test(g.adText), JSON.stringify(g.adText).slice(0, 60));
  ok("NO native spinner left visible", g.visibleSpinnerId === null, g.visibleSpinnerId ? `still visible: ${g.visibleSpinnerId}` : "");
  ok("NO loading label ('Thinking') left visible", g.visibleThinking === false);

  if (g.lineBox && g.inputBox) {
    ok(
      "ad does NOT overlap the input box",
      !intersects(g.lineBox, g.inputBox),
      `ad.bottom=${Math.round(g.lineBox.bottom)} input.top=${Math.round(g.inputBox.top)}`,
    );
  }
  if (g.lineBox && g.inputBox) {
    ok(
      "ad sits clearly above the input",
      g.lineBox.bottom <= g.inputBox.top - 8,
      `ad.bottom=${Math.round(g.lineBox.bottom)} input.top=${Math.round(g.inputBox.top)}`,
    );
  }

  // While the model streams answer text, the ad must not sit over it.
  const overlapText = await page.evaluate(() => {
    const line = document.querySelector("kolex-ad")?.shadowRoot?.querySelector(".line");
    if (!line) return 0;
    const lb = line.getBoundingClientRect();
    let hits = 0;
    for (const el of document.querySelectorAll("p.para")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && !(r.right <= lb.left || r.left >= lb.right || r.bottom <= lb.top || r.top >= lb.bottom)) hits++;
    }
    return hits;
  });
  if (await page.$("p.para")) {
    ok("ad does NOT overlap streaming answer text", overlapText === 0, `${overlapText} paragraph(s) overlapped`);
  }

  // Stability: settle past any thinking→streaming transition, then sample
  // the steady state twice — it must not drift (no crawl).
  await page.waitForTimeout(1200);
  const first = (await geometry(page)).lineBox;
  await page.waitForTimeout(1200);
  const second = (await geometry(page)).lineBox;
  if (first && second) {
    const drift = Math.abs(first.left - second.left) + Math.abs(first.top - second.top);
    ok("ad position is stable (no crawl)", drift <= 1, `drift=${drift.toFixed(1)}px`);
  }

  console.log(`  📸 ${path.join(OUT, `kolex-${name}.png`)}`);
  await browser.close();
}

await run("claude", "claude.html");
await run("claude-thinking", "claude-thinking.html");
await run("claude-shimmer", "claude-shimmer.html");
await run("claude-filmstrip", "claude-filmstrip.html");
await run("claude-streaming", "claude-streaming.html", { streamingHides: true });
await run("chatgpt", "chatgpt.html");

// Image-loader exception: the ad must NOT cover a big image-generation
// placeholder. Here the native spinner STAYS (we don't replace it); the ad
// docks above the composer, clear of the image.
async function runImageLoader() {
  console.log(`\n▶ gemini-image  (gemini-image.html)`);
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(pathToFileURL(path.join(DIR, "fixtures", "gemini-image.html")).href);
  await page.waitForTimeout(6500);

  const g = await page.evaluate(() => {
    const line = document.querySelector("kolex-ad")?.shadowRoot?.querySelector(".line");
    const lb = line?.getBoundingClientRect();
    const img = document.querySelector(".image-area")?.getBoundingClientRect();
    const spinner = document.querySelector(".img-spinner");
    const spinnerVisible = spinner
      ? getComputedStyle(spinner).visibility !== "hidden" && spinner.getBoundingClientRect().width > 0
      : false;
    const input = document.querySelector("[contenteditable], textarea")?.getBoundingClientRect();
    const intersects = (a, b) => a && b && !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    return {
      adVisible: !!line && line.classList.contains("visible"),
      overlapsImage: intersects(lb && { left: lb.left, right: lb.right, top: lb.top, bottom: lb.bottom }, img && { left: img.left, right: img.right, top: img.top, bottom: img.bottom }),
      overlapsInput: intersects(lb, input),
      imageSpinnerStillVisible: spinnerVisible,
    };
  });
  await page.screenshot({ path: path.join(OUT, "kolex-gemini-image.png") });

  ok("no page errors", errors.length === 0, errors[0] || "");
  ok("ad still serves (docked, not blank)", g.adVisible);
  ok("ad does NOT cover the image placeholder", g.overlapsImage === false);
  ok("ad does NOT cover the input", g.overlapsInput === false);
  ok("the image's own spinner is left UNTOUCHED", g.imageSpinnerStillVisible === true);
  console.log(`  📸 ${path.join(OUT, "kolex-gemini-image.png")}`);
  await browser.close();
}
await runImageLoader();

// Long-status row: the whole loading row (icon + the long status text) must be
// hidden — no leftover text peeking out beside the ad.
async function runLongStatus() {
  console.log(`\n▶ claude-longstatus  (claude-longstatus.html)`);
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(pathToFileURL(path.join(DIR, "fixtures", "claude-longstatus.html")).href);
  await page.waitForTimeout(6500);
  const g = await page.evaluate(() => {
    const label = document.querySelector("#label");
    const vis = label
      ? getComputedStyle(label).visibility !== "hidden" && label.getBoundingClientRect().width > 0
      : false;
    const line = document.querySelector("kolex-ad")?.shadowRoot?.querySelector(".line");
    return { labelVisible: vis, adVisible: !!line && line.classList.contains("visible") };
  });
  await page.screenshot({ path: path.join(OUT, "kolex-claude-longstatus.png") });
  ok("ad serves", g.adVisible);
  ok("the long status text is fully hidden (no leftover text)", g.labelVisible === false);
  await browser.close();
}
await runLongStatus();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
