// The $5 welcome bonus only UNLOCKS after the earner (a) verifies their email
// AND (b) watches 15 minutes of ads (= 180 impressions). Until both are true the
// bonus is shown but excluded from the withdrawable balance; once unlocked it
// folds in and a payout sweeps it (one-time).
import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Configure BEFORE importing the app (config reads env at import).
process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_MIN_PAYOUT_USD = "0.10";
process.env.KOLEX_PAYOUT_MATURATION_DAYS = "0"; // isolate the bonus gates from the holding period
process.env.KOLEX_BONUS_UNLOCK_MINUTES = "5"; // 5 min × 12 imp/min = 60 impressions
// Disable the abuse caps so we can post the impressions in one go (the rate
// limiter is covered in its own suite).
process.env.KOLEX_HOURLY_CAP_USD = "0";
process.env.KOLEX_MAX_IMPRESSIONS_PER_MIN = "100000000";
process.env.KOLEX_MAX_EVENTS_PER_BATCH = "100000";
process.env.KOLEX_DAILY_CAP_USD = "0"; // disable daily caps for earnings-math tests
process.env.KOLEX_MAX_IMPRESSIONS_PER_DAY = "0";
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-bonus-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset } = await import("../server/db.mjs");

let server, base;
const url = (p) => `${base}${p}`;
const J = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });
const get = (p, headers) => fetch(url(p), { headers }).then(J);
const post = (p, body, headers = {}) =>
  fetch(url(p), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(J);

before(async () => {
  reset();
  await new Promise((r) => (server = app.listen(0, () => ((base = `http://127.0.0.1:${server.address().port}`), r()))));
});
after(() => { server?.close(); fs.rmSync(process.env.KOLEX_DB, { force: true }); });

const tokenFromVerifyUrl = (u) => (String(u).match(/token=([a-f0-9]+)/) || [])[1];

// Make a paid, serving campaign and return its id (for billing impressions).
async function liveCampaign(email) {
  const r = await post("/api/ads", {
    email, password: "pw-test-12345", brand: "WatchCo", text: "watch and earn now",
    url: "https://watchco.com", bidPerBlock: 80, blocks: 100, accent: "#FF4F1F",
  });
  await post("/api/stub/complete-checkout", { campaignId: r.body.campaign.id });
  return r.body.campaign.id;
}
async function watch(deviceId, adId, n) {
  const events = Array.from({ length: n }, (_, i) => ({ id: `${deviceId}-${i}`, type: "impression", adId }));
  await fetch(url("/v1/events"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-kolex-device": deviceId },
    body: JSON.stringify({ events }),
  });
}

test("new earner: bonus is granted, unverified, and locked out of the balance", async () => {
  const r = await post("/api/auth", { email: "u1@x.com", password: "pw-test-12345", kind: "user" });
  assert.equal(r.body.bonusUsd, 5);
  assert.ok(r.body.verifyUrl, "dev mode returns the verify link");
  const auth = { authorization: `Bearer ${r.body.token}` };
  const s = await get("/api/portal/summary", auth);
  assert.equal(s.body.emailVerified, false);
  assert.equal(s.body.bonusUnlocked, false);
  assert.equal(s.body.bonusRequirements.emailVerified, false);
  assert.equal(s.body.bonusRequirements.extensionInstalled, false);
  assert.equal(s.body.bonusRequirements.watchedEnough, false);
  assert.equal(s.body.withdrawableUsd, 0, "locked bonus is not withdrawable");
});

test("installing (linking a device) flips the extension step before enough watching", async () => {
  const r = await post("/api/auth", { email: "u-install@x.com", password: "pw-test-12345", kind: "user" });
  const auth = { authorization: `Bearer ${r.body.token}` };
  await post("/api/portal/link-device", { deviceId: "dev-install" }, auth); // no impressions yet
  const s = await get("/api/portal/summary", auth);
  assert.equal(s.body.bonusRequirements.extensionInstalled, true, "linked device = extension installed");
  assert.equal(s.body.bonusRequirements.watchedEnough, false, "but nothing watched yet");
  assert.equal(s.body.bonusUnlocked, false);
});

test("watching 5 min alone does NOT unlock (email still unverified)", async () => {
  const adId = await liveCampaign("adv1@x.com");
  const r = await post("/api/auth", { email: "u2@x.com", password: "pw-test-12345", kind: "user" });
  const auth = { authorization: `Bearer ${r.body.token}` };
  await post("/api/portal/link-device", { deviceId: "dev-watch-u2" }, auth);
  await watch("dev-watch-u2", adId, 60); // exactly 5 minutes

  const s = await get("/api/portal/summary", auth);
  assert.equal(s.body.bonusRequirements.extensionInstalled, true);
  assert.equal(s.body.bonusRequirements.watchedEnough, true);
  assert.ok(s.body.bonusRequirements.minutesWatched >= 5);
  assert.equal(s.body.emailVerified, false);
  assert.equal(s.body.bonusUnlocked, false, "still needs email verified");
  assert.ok(s.body.withdrawableUsd > 0 && s.body.withdrawableUsd === s.body.pendingUsd, "bonus excluded");
});

test("verifying email alone does NOT unlock (not enough watching)", async () => {
  const adId = await liveCampaign("adv2@x.com");
  const r = await post("/api/auth", { email: "u3@x.com", password: "pw-test-12345", kind: "user" });
  const auth = { authorization: `Bearer ${r.body.token}` };
  await post("/api/portal/link-device", { deviceId: "dev-watch-u3" }, auth);
  await watch("dev-watch-u3", adId, 24); // only 2 minutes

  const v = await post("/api/auth/verify", { token: tokenFromVerifyUrl(r.body.verifyUrl) });
  assert.equal(v.status, 200);

  const s = await get("/api/portal/summary", auth);
  assert.equal(s.body.emailVerified, true);
  assert.equal(s.body.bonusRequirements.extensionInstalled, true);
  assert.equal(s.body.bonusRequirements.watchedEnough, false);
  assert.equal(s.body.bonusUnlocked, false);
});

test("all three gates met → bonus unlocks, folds into the balance, and a payout sweeps it", async () => {
  const adId = await liveCampaign("adv3@x.com");
  const r = await post("/api/auth", { email: "u4@x.com", password: "pw-test-12345", kind: "user" });
  const auth = { authorization: `Bearer ${r.body.token}` };
  await post("/api/portal/link-device", { deviceId: "dev-watch-u4" }, auth);
  await watch("dev-watch-u4", adId, 60); // 5 minutes
  await post("/api/auth/verify", { token: tokenFromVerifyUrl(r.body.verifyUrl) });

  const s = await get("/api/portal/summary", auth);
  assert.equal(s.body.bonusRequirements.emailVerified, true);
  assert.equal(s.body.bonusRequirements.extensionInstalled, true);
  assert.equal(s.body.bonusRequirements.watchedEnough, true);
  assert.equal(s.body.bonusUnlocked, true);
  // 60 imps × $80/1000 × 0.5 = $2.40 device + $5 bonus = $7.40 withdrawable.
  assert.ok(Math.abs(s.body.withdrawableUsd - (s.body.pendingUsd + 5)) < 1e-6);
  assert.ok(Math.abs(s.body.withdrawableUsd - 7.4) < 1e-6, `withdrawable=${s.body.withdrawableUsd}`);

  await post("/api/stub/complete-connect", undefined, auth);
  const payout = await post("/api/portal/payout", undefined, auth);
  assert.equal(payout.status, 200, JSON.stringify(payout.body));
  assert.ok(Math.abs(payout.body.payout.amountUsd - 7.4) < 1e-6, "payout includes the bonus");
  assert.ok(Math.abs(payout.body.payout.bonusUsd - 5) < 1e-6);

  // Bonus is one-time: it's gone afterwards.
  const after = await get("/api/portal/summary", auth);
  assert.equal(after.body.bonusUsd, 0);
  assert.equal(after.body.bonusUnlocked, false);
});

test("resend-verification works and reports already-verified", async () => {
  const r = await post("/api/auth", { email: "u5@x.com", password: "pw-test-12345", kind: "user" });
  const auth = { authorization: `Bearer ${r.body.token}` };
  const resent = await post("/api/auth/resend-verification", undefined, auth);
  assert.equal(resent.status, 200);
  assert.ok(resent.body.verifyUrl, "dev mode returns a fresh link");

  await post("/api/auth/verify", { token: tokenFromVerifyUrl(resent.body.verifyUrl) });
  const again = await post("/api/auth/resend-verification", undefined, auth);
  assert.equal(again.body.alreadyVerified, true);
});
