// Adversarial / edge-case E2E test. Boots the real Express app in STUB Stripe
// mode against a fresh temp DB and aggressively probes idempotency, settlement
// math, payout safety, cross-account authz, and input abuse.
import { strict as assert } from "node:assert";
import { test, before, after, beforeEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Configure BEFORE importing the app (config reads env at import time).
process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_MIN_PAYOUT_USD = "0.10";
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-adv-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset, load } = await import("../server/db.mjs");

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
// Raw post that lets us send malformed (non-JSON) bodies.
const postRaw = (p, rawBody, headers = {}) =>
  fetch(url(p), { method: "POST", headers, body: rawBody }).then(J);

const events = (evs, device) =>
  fetch(url("/v1/events"), {
    method: "POST",
    headers: { "content-type": "application/json", ...(device ? { "x-kolex-device": device } : {}) },
    body: JSON.stringify({ events: evs }),
  }).then(J);
const balance = (device) =>
  fetch(url("/v1/balance"), { headers: device ? { "x-kolex-device": device } : {} }).then(J);

// Create a fresh PAID, active campaign with a given bid/blocks. Returns campaign + advertiser token.
async function makeActiveCampaign({ email = "adv@x.com", bidPerBlock = 80, blocks = 10 } = {}) {
  const res = await post("/api/ads", {
    email,
    password: "pw-test-12345",
    brand: "Brand",
    text: "The future of widgets is here",
    url: "https://example.com",
    bidPerBlock,
    blocks,
    accent: "#FF4F1F",
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const campaignId = res.body.campaign.id;
  const token = res.body.token;
  await post("/api/stub/complete-checkout", { campaignId });
  return { campaignId, token, amountUsd: res.body.amountUsd };
}

before(async () => {
  await new Promise((r) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      r();
    });
  });
});

beforeEach(() => reset());

after(() => {
  server?.close();
  fs.rmSync(process.env.KOLEX_DB, { force: true });
});

// ───────────────────────── Webhook / event idempotency ─────────────────────

test("ADV: duplicate /webhooks/stripe with same event id only activates once", async () => {
  const r = await post("/api/ads", {
    email: "idem@x.com", password: "pw-test-12345", brand: "B", text: "abcdef", url: "https://x.com", bidPerBlock: 10, blocks: 5,
  });
  const campaignId = r.body.campaign.id;
  const evt = {
    id: "evt_dup_1",
    type: "checkout.session.completed",
    data: { object: { id: "cs_dup", metadata: { campaignId } } },
  };
  // Fire 20 in parallel.
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      fetch(url("/webhooks/stripe"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(evt),
      }).then(J),
    ),
  );
  assert.ok(results.every((x) => x.body.received === true));
  const db = load();
  const c = db.campaigns.find((x) => x.id === campaignId);
  assert.equal(c.status, "active");
  assert.equal(db.processedWebhooks["evt_dup_1"], true);
});

test("ADV: concurrent /v1/events with same id never double-settle", async () => {
  const { campaignId } = await makeActiveCampaign({ bidPerBlock: 80, blocks: 10 });
  const DEV = "dev-concurrent";
  // Fire 30 identical event batches (same impression id + same click id) in parallel.
  const batch = [
    { id: "imp-same", type: "impression", adId: campaignId },
    { id: "clk-same", type: "click", adId: campaignId },
  ];
  await Promise.all(Array.from({ length: 30 }, () => events(batch, DEV)));
  const bal = await balance(DEV);
  // Exactly one impression ($80/1000*0.5 = 0.04) + one click (2.00) = 2.04.
  assert.ok(
    Math.abs(bal.body.pendingUsd - 2.04) < 1e-9,
    `expected 2.04 pending, got ${bal.body.pendingUsd}`,
  );
  const db = load();
  const c = db.campaigns.find((x) => x.id === campaignId);
  assert.equal(c.impressions, 1, "exactly one impression billed");
  assert.equal(c.clicks, 1, "exactly one click billed");
});

// ───────────────────────────── Payment gating ──────────────────────────────

test("ADV: pending campaign never appears in /v1/config", async () => {
  const r = await post("/api/ads", {
    email: "pend@x.com", password: "pw-test-12345", brand: "B", text: "abcdef", url: "https://x.com", bidPerBlock: 99, blocks: 5,
  });
  const campaignId = r.body.campaign.id;
  const cfg = await get("/v1/config");
  assert.ok(!cfg.body.ads.some((a) => a.id === campaignId), "pending must not serve");
  const db = load();
  const c = db.campaigns.find((x) => x.id === campaignId);
  assert.equal(c.status, "pending");
});

test("ADV: completing checkout for non-existent campaign is a safe no-op", async () => {
  const res = await post("/api/stub/complete-checkout", { campaignId: "cmp_does_not_exist" });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test("ADV: completing checkout for an already-active campaign does not change paidAt", async () => {
  const { campaignId } = await makeActiveCampaign();
  const db1 = load();
  const c1 = db1.campaigns.find((x) => x.id === campaignId);
  const firstPaidAt = c1.payment.paidAt;
  await post("/api/stub/complete-checkout", { campaignId });
  const db2 = load();
  const c2 = db2.campaigns.find((x) => x.id === campaignId);
  assert.equal(c2.status, "active");
  assert.equal(c2.payment.paidAt, firstPaidAt, "paidAt must not change on re-completion");
});

// ───────────────────────────── Settlement math ─────────────────────────────

test("ADV: settlement cents are exact for various bids (impression, click 50x, 50% share)", async () => {
  const cases = [
    { bid: 1, imp: 0.0005, clk: 0.025 },
    { bid: 2, imp: 0.001, clk: 0.05 },
    { bid: 31, imp: 0.0155, clk: 0.775 },
    { bid: 80, imp: 0.04, clk: 2.0 },
    { bid: 1000, imp: 0.5, clk: 25.0 },
  ];
  for (const { bid, imp, clk } of cases) {
    reset();
    const { campaignId } = await makeActiveCampaign({ email: `s${bid}@x.com`, bidPerBlock: bid, blocks: 100 });
    const DEV = `dev-${bid}`;
    await events([{ id: `i-${bid}`, type: "impression", adId: campaignId }], DEV);
    let bal = await balance(DEV);
    assert.ok(Math.abs(bal.body.pendingUsd - imp) < 1e-12, `bid ${bid}: imp expected ${imp}, got ${bal.body.pendingUsd}`);
    await events([{ id: `c-${bid}`, type: "click", adId: campaignId }], DEV);
    bal = await balance(DEV);
    assert.ok(Math.abs(bal.body.pendingUsd - (imp + clk)) < 1e-12, `bid ${bid}: total expected ${imp + clk}, got ${bal.body.pendingUsd}`);
    assert.ok(bal.body.pendingUsd >= 0, "pending never negative");
  }
});

test("ADV: advertiser spend equals 2x user pending (50% share) exactly", async () => {
  const { campaignId } = await makeActiveCampaign({ bidPerBlock: 31, blocks: 100 });
  const DEV = "dev-share";
  const evs = [];
  for (let i = 0; i < 10; i++) evs.push({ id: `imp-${i}`, type: "impression", adId: campaignId });
  for (let i = 0; i < 3; i++) evs.push({ id: `clk-${i}`, type: "click", adId: campaignId });
  await events(evs, DEV);
  const bal = await balance(DEV);
  const db = load();
  const c = db.campaigns.find((x) => x.id === campaignId);
  assert.ok(Math.abs(c.spendUsd - bal.body.pendingUsd * 2) < 1e-9, `spend ${c.spendUsd} vs 2x pending ${bal.body.pendingUsd * 2}`);
});

// ──────────────────────────────── Payout ───────────────────────────────────

test("ADV: payout below minimum is rejected", async () => {
  const { campaignId } = await makeActiveCampaign({ bidPerBlock: 1, blocks: 100 });
  const DEV = "dev-below";
  await events([{ id: "i1", type: "impression", adId: campaignId }], DEV); // 0.0005
  const login = await post("/api/auth", { email: "below@me.com", password: "pw-test-12345", kind: "user" });
  const auth = { authorization: `Bearer ${login.body.token}` };
  await post("/api/portal/link-device", { deviceId: DEV }, auth);
  const payout = await post("/api/portal/payout", undefined, auth);
  assert.equal(payout.status, 400);
  assert.match(payout.body.error, /Minimum payout/);
});

test("ADV: exact pending->paid transfer on payout", async () => {
  const { campaignId } = await makeActiveCampaign({ bidPerBlock: 80, blocks: 100 });
  const DEV = "dev-exact";
  await events([
    { id: "i1", type: "impression", adId: campaignId },
    { id: "c1", type: "click", adId: campaignId },
  ], DEV); // 0.04 + 2.00 = 2.04
  const login = await post("/api/auth", { email: "exact@me.com", password: "pw-test-12345", kind: "user" });
  const auth = { authorization: `Bearer ${login.body.token}` };
  await post("/api/portal/link-device", { deviceId: DEV }, auth);
  const payout = await post("/api/portal/payout", undefined, auth);
  assert.equal(payout.status, 200, JSON.stringify(payout.body));
  assert.ok(Math.abs(payout.body.paidUsd - 2.04) < 1e-9);
  const sum = await get("/api/portal/summary", auth);
  assert.equal(sum.body.pendingUsd, 0);
  assert.ok(Math.abs(sum.body.paidUsd - 2.04) < 1e-9);
});

test("ADV: double-payout (sequential) does not pay twice", async () => {
  const { campaignId } = await makeActiveCampaign({ bidPerBlock: 80, blocks: 100 });
  const DEV = "dev-double";
  await events([
    { id: "i1", type: "impression", adId: campaignId },
    { id: "c1", type: "click", adId: campaignId },
  ], DEV);
  const login = await post("/api/auth", { email: "double@me.com", password: "pw-test-12345", kind: "user" });
  const auth = { authorization: `Bearer ${login.body.token}` };
  await post("/api/portal/link-device", { deviceId: DEV }, auth);
  const first = await post("/api/portal/payout", undefined, auth);
  assert.equal(first.status, 200);
  const second = await post("/api/portal/payout", undefined, auth);
  assert.equal(second.status, 400, "second payout must be rejected (nothing pending)");
  const db = load();
  const userId = db.users.find((u) => u.email === "double@me.com").id;
  const payouts = db.payouts.filter((p) => p.userId === userId);
  assert.equal(payouts.length, 1, "exactly one payout recorded");
});

test("ADV: concurrent double-payout must not pay twice (race condition probe)", async () => {
  const { campaignId } = await makeActiveCampaign({ bidPerBlock: 80, blocks: 100 });
  const DEV = "dev-race";
  await events([
    { id: "i1", type: "impression", adId: campaignId },
    { id: "c1", type: "click", adId: campaignId },
  ], DEV); // 2.04
  const login = await post("/api/auth", { email: "race@me.com", password: "pw-test-12345", kind: "user" });
  const auth = { authorization: `Bearer ${login.body.token}` };
  await post("/api/portal/link-device", { deviceId: DEV }, auth);
  // Fire many payouts concurrently.
  await Promise.all(Array.from({ length: 10 }, () => post("/api/portal/payout", undefined, auth)));
  const db = load();
  const userId = db.users.find((u) => u.email === "race@me.com").id;
  const totalPaid = db.payouts.filter((p) => p.userId === userId).reduce((s, p) => s + p.amountUsd, 0);
  assert.ok(totalPaid <= 2.04 + 1e-9, `BUG: total paid ${totalPaid} exceeds 2.04 (paid twice)`);
  const sum = await get("/api/portal/summary", auth);
  assert.ok(Math.abs(sum.body.paidUsd - 2.04) < 1e-9, `paidUsd should be 2.04, got ${sum.body.paidUsd}`);
  assert.equal(sum.body.pendingUsd, 0);
});

// ──────────────────────────── Cross-account authz ──────────────────────────

test("ADV: advertiser A cannot view advertiser B's campaigns", async () => {
  const a = await makeActiveCampaign({ email: "a-adv@x.com", bidPerBlock: 10, blocks: 5 });
  const b = await makeActiveCampaign({ email: "b-adv@x.com", bidPerBlock: 10, blocks: 5 });
  const aCamps = await get("/api/advertiser/campaigns", { authorization: `Bearer ${a.token}` });
  assert.ok(aCamps.body.campaigns.some((c) => c.id === a.campaignId));
  assert.ok(!aCamps.body.campaigns.some((c) => c.id === b.campaignId), "A must not see B's campaign");
});

test("ADV: advertiser A cannot re-checkout advertiser B's campaign", async () => {
  const a = await makeActiveCampaign({ email: "a2-adv@x.com", bidPerBlock: 10, blocks: 5 });
  const bRes = await post("/api/ads", {
    email: "b2-adv@x.com", password: "pw-test-12345", brand: "B", text: "abcdef", url: "https://x.com", bidPerBlock: 10, blocks: 5,
  });
  const bCampaignId = bRes.body.campaign.id;
  const attempt = await post(
    `/api/advertiser/campaigns/${bCampaignId}/checkout`,
    {},
    { authorization: `Bearer ${a.token}` },
  );
  assert.equal(attempt.status, 404, "A must get 404 for B's campaign");
});

test("ADV: user A cannot see user B's earnings via summary", async () => {
  const { campaignId } = await makeActiveCampaign({ bidPerBlock: 80, blocks: 100 });
  const DEV_B = "dev-userB";
  await events([{ id: "ib", type: "impression", adId: campaignId }], DEV_B);
  const loginB = await post("/api/auth", { email: "userB@me.com", password: "pw-test-12345", kind: "user" });
  await post("/api/portal/link-device", { deviceId: DEV_B }, { authorization: `Bearer ${loginB.body.token}` });
  const loginA = await post("/api/auth", { email: "userA@me.com", password: "pw-test-12345", kind: "user" });
  const sumA = await get("/api/portal/summary", { authorization: `Bearer ${loginA.body.token}` });
  assert.equal(sumA.body.pendingUsd, 0, "A must not see B's earnings");
  assert.equal(sumA.body.impressions, 0);
});

test("ADV: user A re-linking user B's already-linked device must not hijack earnings", async () => {
  const { campaignId } = await makeActiveCampaign({ bidPerBlock: 80, blocks: 100 });
  const DEV = "dev-victim";
  await events([{ id: "iv", type: "impression", adId: campaignId }, { id: "cv", type: "click", adId: campaignId }], DEV);
  // Victim B links the device.
  const loginB = await post("/api/auth", { email: "victimB@me.com", password: "pw-test-12345", kind: "user" });
  await post("/api/portal/link-device", { deviceId: DEV }, { authorization: `Bearer ${loginB.body.token}` });
  // Attacker A links the SAME device id.
  const loginA = await post("/api/auth", { email: "attackerA@me.com", password: "pw-test-12345", kind: "user" });
  const link = await post("/api/portal/link-device", { deviceId: DEV }, { authorization: `Bearer ${loginA.body.token}` });
  const sumA = await get("/api/portal/summary", { authorization: `Bearer ${loginA.body.token}` });
  const sumB = await get("/api/portal/summary", { authorization: `Bearer ${loginB.body.token}` });
  // SECURE behavior: either the re-link is rejected (409), or it succeeds but
  // does NOT reassign — either way B keeps earnings and A gets nothing.
  assert.ok([200, 409].includes(link.status), `unexpected status ${link.status}`);
  assert.ok(
    sumB.body.pendingUsd > 0,
    `BUG: victim B lost their earnings after attacker re-linked (B pending=${sumB.body.pendingUsd}, A pending=${sumA.body.pendingUsd})`,
  );
  assert.ok(sumA.body.pendingUsd === 0, `BUG: attacker A absorbed earnings (A pending=${sumA.body.pendingUsd})`);
});

// ───────────────────────────────── Input abuse ─────────────────────────────

test("ADV: /v1/events without device header is rejected", async () => {
  const res = await fetch(url("/v1/events"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ id: "x", type: "impression", adId: "cmp_seed_0" }] }),
  }).then(J);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /missing device/);
});

test("ADV: /v1/events with missing/malformed body does not throw", async () => {
  const r1 = await fetch(url("/v1/events"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-kolex-device": "d1" },
  }).then(J);
  assert.ok(r1.status === 200 || r1.status === 400);
  const r2 = await post("/v1/events", { events: "not-an-array" }, { "x-kolex-device": "d2" });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.accepted, 0);
  const r3 = await fetch(url("/v1/events"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-kolex-device": "d3" },
    body: JSON.stringify({ events: [null, 123, { type: "impression" }, { id: "ok", type: "weird", adId: "cmp_seed_0" }] }),
  }).then(J);
  assert.equal(r3.status, 200);
  assert.equal(r3.body.accepted, 0, "garbage events accepted=0");
});

test("ADV: malformed JSON body returns 400 not 500", async () => {
  const r = await postRaw("/api/ads", "{not valid json", { "content-type": "application/json" });
  assert.ok(r.status === 400, `expected 400 for malformed JSON, got ${r.status}`);
});

test("ADV: /api/ads rejects NaN, negative, and string bid/blocks", async () => {
  const bad = [
    { bidPerBlock: NaN, blocks: 5 },
    { bidPerBlock: -10, blocks: 5 },
    { bidPerBlock: 10, blocks: -5 },
    { bidPerBlock: 10, blocks: NaN },
    { bidPerBlock: "abc", blocks: 5 },
    { bidPerBlock: 0, blocks: 0 },
  ];
  for (const params of bad) {
    const res = await post("/api/ads", {
      email: "abuse@x.com", password: "pw-test-12345", brand: "B", text: "abcdef", url: "https://x.com", ...params,
    });
    assert.equal(res.status, 400, `params ${JSON.stringify(params)} should be rejected`);
    assert.ok(Array.isArray(res.body.errors) && res.body.errors.length >= 1);
  }
});

test("ADV: absurd bid/blocks are rejected (or produce a finite, bounded amount)", async () => {
  const res = await post("/api/ads", {
    email: "huge@x.com", password: "pw-test-12345", brand: "B", text: "abcdef", url: "https://x.com",
    bidPerBlock: 1e9, blocks: 1e6,
  });
  // SECURE behavior: reject absurd values, or accept with a finite amount.
  if (res.status === 200) {
    assert.ok(Number.isFinite(res.body.amountUsd), "amountUsd must be finite");
  } else {
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body.errors) && res.body.errors.length >= 1);
  }
});

test("ADV: oversized iconDataUrl is rejected", async () => {
  const bigIcon = "data:image/png;base64," + "A".repeat(95_000);
  const res = await post("/api/ads", {
    email: "icon@x.com", password: "pw-test-12345", brand: "B", text: "abcdef", url: "https://x.com",
    bidPerBlock: 10, blocks: 5, iconDataUrl: bigIcon,
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.errors.some((e) => /64KB/.test(e)));
});

test("ADV: non-https url is rejected", async () => {
  for (const u of ["http://insecure.com", "ftp://x.com", "javascript:alert(1)", "//x.com", "x.com"]) {
    const res = await post("/api/ads", {
      email: "url@x.com", password: "pw-test-12345", brand: "B", text: "abcdef", url: u, bidPerBlock: 10, blocks: 5,
    });
    assert.equal(res.status, 400, `url ${u} should be rejected`);
  }
});

test("ADV: event for house/unknown adId is ignored (not billed)", async () => {
  const DEV = "dev-house";
  const res = await events([
    { id: "house-1", type: "impression", adId: "cmp_house_unknown" },
    { id: "house-2", type: "click", adId: undefined },
  ], DEV);
  assert.equal(res.body.accepted, 0, "unknown adId not billed");
  const bal = await balance(DEV);
  assert.equal(bal.body.pendingUsd, 0);
  const db = load();
  assert.equal(db.seenEvents["house-1"], true);
});

test("ADV: duplicate event ids across batches are deduped", async () => {
  const { campaignId } = await makeActiveCampaign({ bidPerBlock: 80, blocks: 100 });
  const DEV = "dev-dedup";
  const r1 = await events([{ id: "dup-x", type: "impression", adId: campaignId }], DEV);
  const r2 = await events([{ id: "dup-x", type: "impression", adId: campaignId }], DEV);
  assert.equal(r1.body.accepted, 1);
  assert.equal(r2.body.accepted, 0, "second occurrence of same id deduped");
  const bal = await balance(DEV);
  assert.ok(Math.abs(bal.body.pendingUsd - 0.04) < 1e-12);
});

// ────────────────────── Status / completion edge cases ─────────────────────

test("ADV: completed campaign (impressions exhausted) stops serving; click must not over-bill", async () => {
  const { campaignId } = await makeActiveCampaign({ bidPerBlock: 1000, blocks: 1 });
  const DEV = "dev-exhaust";
  const evs = Array.from({ length: 1000 }, (_, i) => ({ id: `e-${i}`, type: "impression", adId: campaignId }));
  await events(evs, DEV);
  const db = load();
  const c = db.campaigns.find((x) => x.id === campaignId);
  assert.equal(c.impressionsRemaining, 0);
  assert.equal(c.status, "completed", "exhausted campaign becomes completed");
  const cfg = await get("/v1/config");
  assert.ok(!cfg.body.ads.some((a) => a.id === campaignId), "completed campaign must not serve");
  const before = c.spendUsd;
  await events([{ id: "post-click", type: "click", adId: campaignId }], DEV);
  const db2 = load();
  const c2 = db2.campaigns.find((x) => x.id === campaignId);
  // SECURE behavior: a click after exhaustion must NOT bill more than the paid budget.
  assert.equal(c2.spendUsd, before, `BUG: click billed after budget exhausted (was ${before}, now ${c2.spendUsd})`);
});

test("ADV: total advertiser spend never exceeds paid budget (overspend probe)", async () => {
  const blocks = 2;
  const bid = 1000;
  const { campaignId, amountUsd } = await makeActiveCampaign({ bidPerBlock: bid, blocks });
  const DEV = "dev-overspend";
  const impEvs = Array.from({ length: blocks * 1000 }, (_, i) => ({ id: `oi-${i}`, type: "impression", adId: campaignId }));
  await events(impEvs, DEV);
  const clickEvs = Array.from({ length: 100 }, (_, i) => ({ id: `oc-${i}`, type: "click", adId: campaignId }));
  await events(clickEvs, DEV);
  const db = load();
  const c = db.campaigns.find((x) => x.id === campaignId);
  assert.ok(
    c.spendUsd <= amountUsd + 1e-9,
    `BUG: spend ${c.spendUsd} exceeds paid budget ${amountUsd}`,
  );
});
