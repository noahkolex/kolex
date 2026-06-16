// Covers two recently added features:
//  1) Advertisers can edit a campaign's copy/colors/icon after the fact, and
//     delete UNPAID drafts (but not live campaigns).
//  2) The new-account payout holding period (KOLEX_PAYOUT_MATURATION_DAYS):
//     new accounts can't cash out until N days after signup; the portal summary
//     surfaces `matured` + `payoutUnlocksAt` so the UI can explain when.
import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Configure BEFORE importing the app (config reads env at import).
process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_MIN_PAYOUT_USD = "0.10";
process.env.KOLEX_PAYOUT_MATURATION_DAYS = "2"; // the default; assert the gate explicitly
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-mat-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset, load, save } = await import("../server/db.mjs");

let server, base;
const url = (p) => `${base}${p}`;
const J = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });
const get = (p, headers) => fetch(url(p), { headers }).then(J);
const send = (method, p, body, headers = {}) =>
  fetch(url(p), {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(J);
const post = (p, body, headers) => send("POST", p, body, headers);
const patch = (p, body, headers) => send("PATCH", p, body, headers);
const del = (p, headers) => send("DELETE", p, undefined, headers);

before(async () => {
  reset();
  await new Promise((r) => {
    server = app.listen(0, () => ((base = `http://127.0.0.1:${server.address().port}`), r()));
  });
});
after(() => {
  server?.close();
  fs.rmSync(process.env.KOLEX_DB, { force: true });
});

// Register an advertiser + one campaign; returns { token, campaignId }.
async function newCampaign(email) {
  const res = await post("/api/ads", {
    email,
    password: "pw-test-12345",
    brand: "EditMe",
    text: "Original copy here",
    url: "https://original.com",
    bidPerBlock: 80,
    blocks: 10,
    accent: "#FF4F1F",
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { token: res.body.token, campaignId: res.body.campaign.id, auth: { authorization: `Bearer ${res.body.token}` } };
}

test("advertiser can edit copy, url, accent, and icon of an existing campaign", async () => {
  const { campaignId, auth } = await newCampaign("editor@startup.com");
  const icon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const r = await patch(`/api/advertiser/campaigns/${campaignId}`, {
    text: "Brand new shiny copy",
    url: "https://updated.com",
    accent: "#00C2FF",
    iconDataUrl: icon,
  }, auth);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.campaign.text, "Brand new shiny copy");
  assert.equal(r.body.campaign.url, "https://updated.com");
  assert.equal(r.body.campaign.accent, "#00C2FF");
  assert.equal(r.body.campaign.iconDataUrl, icon);

  // Clearing the icon with an explicit null.
  const r2 = await patch(`/api/advertiser/campaigns/${campaignId}`, {
    text: "Brand new shiny copy",
    url: "https://updated.com",
    iconDataUrl: null,
  }, auth);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.campaign.iconDataUrl, undefined);
});

test("edit validates copy length and https url", async () => {
  const { campaignId, auth } = await newCampaign("badeditor@startup.com");
  const r = await patch(`/api/advertiser/campaigns/${campaignId}`, { text: "x", url: "http://insecure.com" }, auth);
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.length >= 2, JSON.stringify(r.body));
});

test("editing someone else's campaign 404s", async () => {
  const a = await newCampaign("owner@startup.com");
  const b = await newCampaign("intruder@startup.com");
  const r = await patch(`/api/advertiser/campaigns/${a.campaignId}`, { text: "hijacked copy", url: "https://x.com" }, b.auth);
  assert.equal(r.status, 404);
});

test("unpaid draft campaigns are deletable; live campaigns are not", async () => {
  const { campaignId, auth } = await newCampaign("deleter@startup.com");
  // Still a pending/unpaid draft → deletable.
  const d = await del(`/api/advertiser/campaigns/${campaignId}`, auth);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const camps = await get("/api/advertiser/campaigns", auth);
  assert.ok(!camps.body.campaigns.some((c) => c.id === campaignId), "campaign removed");

  // A second campaign, this time activated via stub checkout → NOT deletable.
  const live = await newCampaign("deleter2@startup.com");
  await post("/api/stub/complete-checkout", { campaignId: live.campaignId });
  const d2 = await del(`/api/advertiser/campaigns/${live.campaignId}`, live.auth);
  assert.equal(d2.status, 400);
  assert.match(d2.body.error, /Live campaigns can't be deleted/i);
  // ...but it can still be edited.
  const e = await patch(`/api/advertiser/campaigns/${live.campaignId}`, { text: "live edit works", url: "https://live.com" }, live.auth);
  assert.equal(e.status, 200);
});

test("a brand-new account cannot cash out until the holding period passes", async () => {
  // Reuse the live campaign's billing to give a device real earnings.
  const camp = await newCampaign("adv-for-earn@startup.com");
  await post("/api/stub/complete-checkout", { campaignId: camp.campaignId });
  const DEV = "dev-mat-1";
  // Link the device to the account FIRST — only linked devices earn.
  const login = await post("/api/auth", { email: "fresh@me.com", password: "pw-test-12345", kind: "user" });
  const auth = { authorization: `Bearer ${login.body.token}` };
  await post("/api/portal/link-device", { deviceId: DEV }, auth);
  // 1000 impressions = $80/1000 * 0.5 * 1000 = $40 pending (clears the minimum).
  const evs = Array.from({ length: 1000 }, (_, i) => ({ id: `m${i}`, type: "impression", adId: camp.campaignId }));
  await fetch(url("/v1/events"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-kolex-device": DEV },
    body: JSON.stringify({ events: evs }),
  });
  await post("/api/stub/complete-connect", undefined, auth);

  // Summary tells the UI the account isn't matured yet, and when it unlocks.
  const sum = await get("/api/portal/summary", auth);
  assert.equal(sum.body.matured, false);
  assert.ok(sum.body.payoutUnlocksAt > Date.now(), "unlock is in the future");
  assert.ok(sum.body.pendingUsd >= 0.1, `pending=${sum.body.pendingUsd}`);

  // The cash-out itself is blocked with a clear, dated message.
  const blocked = await post("/api/portal/payout", undefined, auth);
  assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
  assert.match(blocked.body.error, /Payouts begin 2 days/i);
  assert.ok(blocked.body.unlocksAt > Date.now());

  // Backdate signup past the window → now matured → cash-out succeeds.
  const db = load();
  db.users.find((u) => u.email === "fresh@me.com").createdAt = Date.now() - 3 * 86_400_000;
  await save();

  const matured = await get("/api/portal/summary", auth);
  assert.equal(matured.body.matured, true);
  const payout = await post("/api/portal/payout", undefined, auth);
  assert.equal(payout.status, 200, JSON.stringify(payout.body));
  assert.equal(payout.body.payout.status, "paid");
});
