// Full extension ↔ backend E2E. Loads the REAL built extension into Chrome
// (headed, under xvfb), points it at a live local server via the storage
// override, and drives the actual background code paths:
//   grant consent → background fetches /v1/config from the server →
//   send a click → background flushes events to /v1/events → server settles →
//   the device's balance is non-zero.
import { chromium } from "playwright";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(DIR, "..", "extension");

process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-ext-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset } = await import("../server/db.mjs");
reset();
const server = await new Promise((r) => {
  const s = app.listen(0, () => r(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

// Blank DB by default — create + pay one campaign so there's a real server ad
// for the extension to fetch and settle against.
const adRes = await fetch(`${base}/api/ads`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: "ext-adv@x.com", password: "pw-test-12345", brand: "ExtTest",
    text: "Hello from the extension test", url: "https://example.com", bidPerBlock: 42, blocks: 10,
  }),
}).then((r) => r.json());
await fetch(`${base}/api/stub/complete-checkout`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ campaignId: adRes.campaign.id }),
});

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kolex-ext-profile-"));
let ctx;
try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--no-sandbox",
    ],
  });

  // Get the extension's service worker (background).
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  ok("extension loaded (service worker present)", !!extId, extId);

  // Point the extension at our local server via the storage override.
  await sw.evaluate(
    (cfg) => chrome.storage.local.set({ override: cfg }),
    { apiBase: `${base}/v1`, siteBase: base },
  );

  // Open the popup and grant consent — this triggers the background's real
  // refreshRemoteConfig(), which fetches /v1/config from our server.
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "kolex:grant-consent" }));

  // Poll until the extension has pulled the server's ads (not house ads).
  let ads = [];
  for (let i = 0; i < 25; i++) {
    ads = await sw.evaluate(async () => (await chrome.storage.local.get("ads")).ads || []);
    if (ads.some((a) => !a.house && a.id?.startsWith("cmp"))) break;
    await sleep(400);
  }
  const serverAd = ads.find((a) => !a.house && a.id?.startsWith("cmp"));
  ok("extension fetched the server's live ads (read path)", !!serverAd, `${ads.length} ads`);

  // Device id the extension is using.
  const status = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: "kolex:status" }),
  );
  ok("extension reports consent granted", status.consent === true);
  const deviceId = status.deviceId;
  ok("extension has a device id", !!deviceId, deviceId?.slice(0, 8));

  // Send a click for a real server ad → background records it and flushes the
  // ledger to /v1/events (write path).
  if (serverAd) {
    await popup.evaluate(
      (id) => chrome.runtime.sendMessage({ type: "kolex:click", adId: id, surface: "claude" }),
      serverAd.id,
    );
  }

  // Poll the server until the device's balance reflects the click.
  let bal = { pendingUsd: 0 };
  for (let i = 0; i < 25; i++) {
    bal = await fetch(`${base}/v1/balance`, { headers: { "x-kolex-device": deviceId } }).then((r) =>
      r.json(),
    );
    if (bal.pendingUsd > 0) break;
    await sleep(400);
  }
  ok("server settled the extension's event (write path)", bal.pendingUsd > 0, `pending=${bal.pendingUsd}`);

  // The click should have opened the advertiser destination in a new tab
  // (the extension routes clicks through {siteBase}/r/{adId} → 302 to the ad).
  await sleep(800);
  const urls = ctx.pages().map((p) => p.url());
  const opened = urls.some(
    (u) => u.includes("/r/") || (!u.startsWith("chrome-extension://") && u !== "about:blank" && u !== ""),
  );
  ok("click opened the advertiser destination tab", opened, urls.join(" | "));
} catch (err) {
  ok(`extension flow threw: ${err.message}`, false);
} finally {
  if (ctx) await ctx.close();
  server.close();
  fs.rmSync(process.env.KOLEX_DB, { force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL EXTENSION E2E CHECKS PASSED" : failures + " EXTENSION CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
