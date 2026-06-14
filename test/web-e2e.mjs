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
process.env.KOLEX_MIN_PAYOUT_USD = "0.10";
process.env.KOLEX_PAYOUT_MATURATION_DAYS = "0"; // drive the real cash-out UX without the holding period
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
  // Blank deployment: leaderboard shows the honest empty state mentioning Kolex.
  const boardText = await page.locator("#board-body").textContent();
  ok("blank leaderboard shows the Kolex/empty state", /Kolex|first to bid/i.test(boardText), boardText.slice(0, 60));
  // The hero ticker is the PROJECTED monthly earnings per active user. With no
  // live bids it's derived from a clearly-labelled SAMPLE bid (not fabricated
  // paid-out money), so it shows a positive figure + a "sample bid" subtitle.
  await page.waitForTimeout(1500);
  const tickerTxt = await page.locator("#ticker-amount").textContent();
  ok("projected-earnings ticker shows a real figure", /\$\d/.test(tickerTxt), tickerTxt);
  const tickerSub = await page.locator("#ticker-sub").textContent();
  ok("ticker labels the blank-board number as a sample bid", /sample bid/i.test(tickerSub), tickerSub);
  ok("activity feed shows the honest empty state", await page.locator("#feed-empty").isVisible());
  // No giant bird: every svg/img on the page is reasonably sized.
  const oversized = await page.evaluate(() =>
    [...document.querySelectorAll("svg,img")].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 80 || r.height > 80;
    }).length,
  );
  ok("no oversized marks (no giant bird)", oversized === 0, `${oversized} oversized`);

  console.log("\n▶ Advertise → Stripe mock checkout → pay");
  await page.goto(`${base}/advertise`);
  await page.fill("#brand", "Acme Rockets");
  await page.fill("#email", "ceo@acme.com");
  await page.fill("#password", "supersecret123");
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

  console.log("\n▶ Earner earns, then cashes out (full from scratch)");
  // The device watches the live ad and earns (a click on the $120 campaign).
  const DEVICE = "web-test-device";
  await fetch(`${base}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kolex-device": DEVICE },
    body: JSON.stringify({ events: [{ id: "web-clk-1", type: "click", adId: served.id }] }),
  });
  await page.goto(`${base}/portal?device=${DEVICE}&connect=1`);
  await page.fill("#email", "earner@web.com");
  await page.fill("#password", "earnerpass123");
  await page.click("#signin");
  await page.waitForSelector("#dash:not(.hide)", { timeout: 5000 });
  ok("earner portal opens after login", await page.locator("#dash").isVisible());
  ok("device auto-linked banner shows", await page.locator("#linked").isVisible());
  await page.waitForTimeout(500);
  const pendingTxt = await page.locator("#pending").textContent();
  ok("earned balance shows in the portal", /\$[1-9]/.test(pendingTxt), pendingTxt);

  // Payouts require connecting an account first: Withdraw is gated until then.
  ok("withdraw is disabled before connecting a payout account", await page.locator("#payout").isDisabled());
  ok("a 'Set up payouts' button is shown", await page.locator("#connect").isVisible());

  // Complete (mock) Stripe Connect onboarding.
  await page.click("#connect");
  await page.waitForSelector("#finish", { timeout: 5000 });
  ok("mock Stripe Connect onboarding opens", await page.locator("#finish").isVisible());
  await page.click("#finish");
  await page.waitForSelector("#dash:not(.hide)", { timeout: 5000 });
  await page.waitForTimeout(400);
  ok("payouts enabled after onboarding", (await page.locator("#payout-method").textContent()).includes("enabled"));

  await page.click("#payout");
  await page.waitForTimeout(800);
  const note = await page.locator("#payout-note").textContent();
  ok("withdrawal succeeds with payout message", /Paid out|queued/.test(note), note);
  const afterPending = await page.locator("#pending").textContent();
  ok("balance is zero after withdrawing", /\$0\.00/.test(afterPending), afterPending);

  // Wrong password must be rejected (no more "any email signs in").
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/portal`);
  await page.waitForSelector("#login:not(.hide)", { timeout: 5000 });
  await page.fill("#email", "earner@web.com");
  await page.fill("#password", "totally-wrong-pw");
  await page.click("#signin");
  await page.waitForTimeout(500);
  ok("wrong password is rejected at login", await page.locator("#login-err").isVisible());

  console.log("\n▶ Advertiser re-login + pay a cancelled (pending) campaign");
  // New advertiser submits, then CANCELS at checkout → campaign stays pending.
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/advertise`);
  await page.fill("#brand", "Globex");
  await page.fill("#email", "owner@globex.com");
  await page.fill("#password", "globexpass123");
  await page.fill("#text", "Globex powers tomorrow");
  await page.fill("#url", "https://globex.com");
  await page.fill("#bid", "40");
  await page.fill("#blocks", "3");
  await Promise.all([page.waitForURL(/\/mock-checkout/, { timeout: 8000 }), page.click("#submit")]);
  await Promise.all([page.waitForURL(/\/advertise/, { timeout: 8000 }), page.click("#cancel")]);
  ok("cancelling checkout returns to advertise", page.url().includes("/advertise"));

  // Re-login to the advertiser portal with the password set during submission.
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/advertiser`);
  await page.waitForSelector("#login:not(.hide)", { timeout: 5000 });
  await page.fill("#email", "owner@globex.com");
  await page.fill("#password", "globexpass123");
  await page.click("#signin");
  await page.waitForSelector("#dash:not(.hide)", { timeout: 5000 });
  ok("advertiser re-login with their password works", await page.locator("#dash").isVisible());
  await page.waitForSelector("#adv-body tr", { timeout: 5000 });
  ok("the pending campaign shows as Unpaid", (await page.locator("#adv-body").textContent()).includes("Globex"));
  const unpaidPills = await page.locator("#adv-body .pill.unpaid").count();
  ok("Unpaid status pill is shown", unpaidPills >= 1, `${unpaidPills}`);

  // Pay it from the portal (re-checkout) → it goes live.
  await Promise.all([page.waitForURL(/\/mock-checkout/, { timeout: 8000 }), page.click("[data-pay]")]);
  await Promise.all([page.waitForURL(/\/advertiser\?paid=1/, { timeout: 8000 }), page.click("#pay")]);
  await page.waitForSelector("#adv-body .pill.live", { timeout: 5000 });
  ok("paying the pending campaign makes it Live", (await page.locator("#adv-body .pill.live").count()) >= 1);

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
