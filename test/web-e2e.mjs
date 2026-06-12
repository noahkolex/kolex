// Browser-driven web flow: the real website pages against the real server in
// stub Stripe mode. Drives a human path: landing leaderboard → advertise form
// → mock checkout → pay → advertiser portal shows the campaign LIVE.
import { chromium } from "playwright";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.SITE_BASE = ""; // infer from request
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-web-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset } = await import("../server/db.mjs");
reset();

const server = await new Promise((r) => {
  const s = app.listen(0, () => r(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  console.log("\n▶ Landing page + live leaderboard");
  await page.goto(`${base}/`);
  await page.waitForSelector("#board-body tr", { timeout: 5000 });
  const rows = await page.locator("#board-body tr").count();
  ok("leaderboard renders seeded campaigns", rows >= 6, `${rows} rows`);
  ok("hero ad line renders", await page.locator("#hero-ad .bn, #hero-ad").first().isVisible());

  console.log("\n▶ Advertise → Stripe mock checkout → pay");
  await page.goto(`${base}/advertise`);
  await page.fill("#brand", "Acme Rockets");
  await page.fill("#email", "ceo@acme.com");
  await page.fill("#text", "We make great widgets fast");
  await page.fill("#url", "https://acme.com");
  await page.fill("#bid", "120");
  await page.fill("#blocks", "5");
  ok("live ad preview shows the brand", (await page.locator("#preview .bn").textContent())?.includes("Acme"));
  await Promise.all([
    page.waitForURL(/\/mock-checkout/, { timeout: 8000 }),
    page.click("#submit"),
  ]);
  ok("redirected to Stripe (mock) checkout", page.url().includes("/mock-checkout"));
  const amount = await page.locator("#amount").textContent();
  ok("checkout shows the correct budget ($600)", amount?.includes("600"), amount ?? "");

  await Promise.all([
    page.waitForURL(/\/advertiser\?paid=1/, { timeout: 8000 }),
    page.click("#pay"),
  ]);
  ok("returned to advertiser portal after payment", page.url().includes("paid=1"));

  console.log("\n▶ Advertiser portal shows the campaign LIVE");
  await page.waitForSelector("#adv-body tr", { timeout: 5000 });
  ok("paid banner visible", await page.locator("#paid-banner").isVisible());
  const liveCount = await page.locator("#adv-body .pill.live").count();
  ok("campaign shows as Live", liveCount >= 1, `${liveCount} live`);
  const bodyText = await page.locator("#adv-body").textContent();
  ok("the new campaign is listed", bodyText.includes("Acme Rockets"));

  console.log("\n▶ Server confirms the paid campaign now serves");
  const cfg = await fetch(`${base}/v1/config`).then((r) => r.json());
  const served = cfg.ads.find((a) => a.brand === "Acme Rockets");
  ok("paid campaign serves in /v1/config", !!served);
  ok("served ad carries its bid", served?.bidPerBlock === 120);

  console.log("\n▶ Earner portal: login + connect prompt");
  await page.goto(`${base}/portal?device=web-test-device&connect=1`);
  await page.fill("#email", "earner@web.com");
  await page.click("#signin");
  await page.waitForSelector("#dash:not(.hide)", { timeout: 5000 });
  ok("earner portal opens after login", await page.locator("#dash").isVisible());
  ok("device auto-linked banner shows", await page.locator("#linked").isVisible());

  ok("no page errors across the flow", errors.length === 0, errors[0] || "");

  await page.screenshot({ path: "/tmp/claude/kolex-web-advertiser.png" });
} catch (err) {
  ok(`flow threw: ${err.message}`, false);
} finally {
  await browser.close();
  server.close();
  fs.rmSync(process.env.KOLEX_DB, { force: true });
}

console.log(`\n${failures === 0 ? "ALL WEB CHECKS PASSED" : failures + " WEB CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
