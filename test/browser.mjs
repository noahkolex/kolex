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

    // Any natively-visible spinner left on screen?
    const spinnerEls = [...document.querySelectorAll("#starburst, .spinner, .placeholder")];
    const visibleSpinner = spinnerEls.find((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.visibility !== "hidden" && cs.display !== "none" && r.width > 0 && r.height > 0;
    });

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
      inputBox: inputBox && { left: inputBox.left, top: inputBox.top, right: inputBox.right, bottom: inputBox.bottom },
      composerBox: composerBox && { top: composerBox.top },
    };
  });
}

function intersects(a, b) {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

async function run(name, file) {
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
  ok("kolex ad host mounted", g.hasHost);
  ok("ad line is visible", g.adVisible);
  ok("ad shows the brand logo (Notion)", g.hasLogo);
  ok("ad copy present", /Notion/.test(g.adText), JSON.stringify(g.adText).slice(0, 60));
  ok("NO native spinner left visible", g.visibleSpinnerId === null, g.visibleSpinnerId ? `still visible: ${g.visibleSpinnerId}` : "");

  if (g.lineBox && g.inputBox) {
    ok(
      "ad does NOT overlap the input box",
      !intersects(g.lineBox, g.inputBox),
      `ad.bottom=${Math.round(g.lineBox.bottom)} input.top=${Math.round(g.inputBox.top)}`,
    );
  }
  if (g.lineBox && g.composerBox) {
    ok(
      "ad sits above the composer with clearance",
      g.lineBox.bottom <= g.composerBox.top - 10,
      `ad.bottom=${Math.round(g.lineBox.bottom)} composer.top=${Math.round(g.composerBox.top)}`,
    );
  }

  // Stability: capture position, wait, capture again — must not drift.
  const first = (await geometry(page)).lineBox;
  await page.waitForTimeout(1500);
  const second = (await geometry(page)).lineBox;
  if (first && second) {
    const drift = Math.abs(first.left - second.left) + Math.abs(first.top - second.top);
    ok("ad position is stable (no crawl)", drift <= 1, `drift=${drift.toFixed(1)}px`);
  }

  console.log(`  📸 ${path.join(OUT, `kolex-${name}.png`)}`);
  await browser.close();
}

await run("claude", "claude.html");
await run("chatgpt", "chatgpt.html");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
