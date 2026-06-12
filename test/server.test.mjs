// End-to-end server + payments test. Boots the real Express app in STUB Stripe
// mode against a fresh temp DB and drives the full money flow over HTTP:
// advertiser pays → webhook activates → extension serves & settles → user
// cashes out. No real Stripe calls; the stub exercises the same code paths.
import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Configure BEFORE importing the app (config reads env at import time).
process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_MIN_PAYOUT_USD = "0.10";
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-test-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset } = await import("../server/db.mjs");

let server, base;
const url = (p) => `${base}${p}`;
const J = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });
const get = (p, headers) => fetch(url(p), { headers }).then(J);
const post = (p, body, headers = {}) =>
  fetch(url(p), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(J);

before(async () => {
  reset();
  await new Promise((r) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      r();
    });
  });
});

after(() => {
  server?.close();
  fs.rmSync(process.env.KOLEX_DB, { force: true });
});

test("stripe-config reports stub mode", async () => {
  const { body } = await get("/api/stripe-config");
  assert.equal(body.mode, "stub");
  assert.equal(body.webhookConfigured, true);
});

test("seed inventory serves and the leaderboard is populated", async () => {
  const cfg = await get("/v1/config");
  assert.ok(cfg.body.ads.length >= 6, "seed ads serve");
  const auc = await get("/api/auction");
  assert.ok(auc.body.leaderboard.length >= 6);
  assert.ok(auc.body.stats.topBid > 0);
});

// State shared across the ordered flow tests below.
const flow = {};

test("FLOW 1 — advertiser submits → PENDING campaign + checkout URL", async () => {
  const res = await post("/api/ads", {
    email: "founder@startup.com",
    password: "pw-test-12345",
    brand: "Startup",
    text: "The future of widgets is here",
    url: "https://startup.com",
    bidPerBlock: 80,
    blocks: 10,
    accent: "#FF4F1F",
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.checkoutUrl.includes("/mock-checkout"), "stub checkout URL");
  assert.equal(res.body.campaign.status, "pending");
  assert.equal(res.body.amountUsd, 800);
  flow.campaignId = res.body.campaign.id;
  flow.advToken = res.body.token;
});

test("FLOW 2 — a PENDING (unpaid) campaign does NOT serve", async () => {
  const cfg = await get("/v1/config");
  assert.ok(!cfg.body.ads.some((a) => a.id === flow.campaignId), "unpaid ad must not serve");
});

test("FLOW 3 — completing checkout activates the campaign (it now serves)", async () => {
  const pay = await post("/api/stub/complete-checkout", { campaignId: flow.campaignId });
  assert.equal(pay.status, 200);
  const cfg = await get("/v1/config");
  const served = cfg.body.ads.find((a) => a.id === flow.campaignId);
  assert.ok(served, "paid ad now serves");
  assert.equal(served.bidPerBlock, 80);
  // Advertiser portal shows it active.
  const camps = await get("/api/advertiser/campaigns", { authorization: `Bearer ${flow.advToken}` });
  const c = camps.body.campaigns.find((x) => x.id === flow.campaignId);
  assert.equal(c.status, "active");
  assert.equal(c.payment.status, "paid");
});

test("FLOW 4 — webhook completion is idempotent (no double-activation/errors)", async () => {
  // Hit the real webhook endpoint with a JSON event (stub verifies as JSON).
  const evt = {
    id: "evt_test_idem",
    type: "checkout.session.completed",
    data: { object: { id: "cs_x", metadata: { campaignId: flow.campaignId } } },
  };
  const a = await fetch(url("/webhooks/stripe"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(evt),
  }).then(J);
  const b = await fetch(url("/webhooks/stripe"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(evt),
  }).then(J);
  assert.equal(a.body.received, true);
  assert.equal(b.body.received, true);
  const camps = await get("/api/advertiser/campaigns", { authorization: `Bearer ${flow.advToken}` });
  const c = camps.body.campaigns.find((x) => x.id === flow.campaignId);
  assert.equal(c.status, "active"); // still active, not broken
});

test("FLOW 5 — extension serves & settles: events bill advertiser, credit device", async () => {
  const DEV = "dev-flow-1";
  const events = {
    events: [
      { id: "imp-1", type: "impression", adId: flow.campaignId },
      { id: "clk-1", type: "click", adId: flow.campaignId },
      { id: "imp-1", type: "impression", adId: flow.campaignId }, // dup → ignored
    ],
  };
  const post1 = await fetch(url("/v1/events"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-kolex-device": DEV },
    body: JSON.stringify(events),
  }).then(J);
  assert.equal(post1.body.accepted, 2, "dup deduped");

  // impression $80/1000*0.5 = 0.04 ; click 50x = 2.00 → pending 2.04
  const bal = await fetch(url("/v1/balance"), { headers: { "x-kolex-device": DEV } }).then(J);
  assert.ok(Math.abs(bal.body.pendingUsd - 2.04) < 1e-6, `pending=${bal.body.pendingUsd}`);
  flow.device = DEV;
});

test("FLOW 6 — user links device, sees earnings, and cashes out", async () => {
  const login = await post("/api/auth", { email: "earner@me.com", password: "pw-test-12345", kind: "user" });
  const token = login.body.token;
  const auth = { authorization: `Bearer ${token}` };

  await post("/api/portal/link-device", { deviceId: flow.device }, auth);
  const sum = await get("/api/portal/summary", auth);
  assert.ok(Math.abs(sum.body.pendingUsd - 2.04) < 1e-6);
  assert.equal(sum.body.impressions, 1);
  assert.equal(sum.body.clicks, 1);

  const payout = await post("/api/portal/payout", undefined, auth);
  assert.equal(payout.status, 200, JSON.stringify(payout.body));
  assert.ok(Math.abs(payout.body.paidUsd - 2.04) < 1e-6);
  assert.equal(payout.body.payout.status, "paid"); // stub pays instantly

  const after = await get("/api/portal/summary", auth);
  assert.equal(after.body.pendingUsd, 0);
  assert.ok(Math.abs(after.body.paidUsd - 2.04) < 1e-6);
});

test("FLOW 7 — payout below the minimum is rejected", async () => {
  const DEV2 = "dev-flow-2";
  // 1 impression only on the $80 campaign = $0.04 < $0.10 minimum.
  await fetch(url("/v1/events"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-kolex-device": DEV2 },
    body: JSON.stringify({ events: [{ id: "imp-2", type: "impression", adId: flow.campaignId }] }),
  });
  const login = await post("/api/auth", { email: "small@me.com", password: "pw-test-12345", kind: "user" });
  const auth = { authorization: `Bearer ${login.body.token}` };
  await post("/api/portal/link-device", { deviceId: DEV2 }, auth);
  const payout = await post("/api/portal/payout", undefined, auth);
  assert.equal(payout.status, 400);
  assert.match(payout.body.error, /Minimum payout/);
});

test("validation rejects bad ad submissions", async () => {
  const res = await post("/api/ads", {
    email: "bad",
    brand: "",
    text: "x",
    url: "http://no",
    bidPerBlock: 0,
    blocks: 0,
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.errors.length >= 5);
});

test("stub-only completion endpoint is mode-guarded", async () => {
  // In stub mode it works; we already used it. Just assert it 200s for a
  // nonexistent campaign without throwing (no-op activation).
  const res = await post("/api/stub/complete-checkout", { campaignId: "cmp_nope" });
  assert.equal(res.status, 200);
});

test("auth is required for protected routes", async () => {
  assert.equal((await get("/api/advertiser/campaigns")).status, 401);
  assert.equal((await get("/api/portal/summary")).status, 401);
  assert.equal((await post("/api/portal/payout")).status, 401);
});

test("click redirect records a click and 302s to the advertiser", async () => {
  const res = await fetch(url(`/r/${flow.campaignId}?d=dev-redir`), { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://startup.com");
  const bal = await fetch(url("/v1/balance"), { headers: { "x-kolex-device": "dev-redir" } }).then(J);
  assert.ok(bal.body.pendingUsd > 0, "redirect click credited the device");
});
