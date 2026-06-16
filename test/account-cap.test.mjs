// Account-wide earning caps: the daily/hourly $ caps count against the linked
// ACCOUNT, not each device — so registering many devices can't multiply them.
// (Regression test for the "one account, ~100 devices, each under its own
// $1/day cap" abuse.)
import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_HOURLY_CAP_USD = "0"; // isolate the DAILY $ cap
process.env.KOLEX_DAILY_CAP_USD = "1"; // $1/day per ACCOUNT
process.env.KOLEX_MAX_IMPRESSIONS_PER_MIN = "100000000";
process.env.KOLEX_MAX_IMPRESSIONS_PER_DAY = "0"; // isolate the $ cap (not the impression cap)
process.env.KOLEX_MAX_EVENTS_PER_BATCH = "100000";
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-acctcap-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset, load } = await import("../server/db.mjs");

let server, base;
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const post = (p, b, h = {}) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: b === undefined ? undefined : JSON.stringify(b) }).then(J);
const events = (evs, device) => fetch(`${base}/v1/events`, { method: "POST", headers: { "content-type": "application/json", "x-kolex-device": device }, body: JSON.stringify({ events: evs }) }).then(J);

async function liveCampaign(email, bid) {
  const r = await post("/api/ads", { email, password: "pw-test-12345", brand: "Cap", text: "cap test ad", url: "https://x.com", bidPerBlock: bid, blocks: 1000, accent: "#FF4F1F" });
  await post("/api/stub/complete-checkout", { campaignId: r.body.campaign.id });
  return r.body.campaign.id;
}

before(async () => { reset(); await new Promise((r) => (server = app.listen(0, () => ((base = `http://127.0.0.1:${server.address().port}`), r())))); });
after(() => { server?.close(); fs.rmSync(process.env.KOLEX_DB, { force: true }); });

test("the daily cap is shared across every device linked to one account", async () => {
  // One earner account with TWO linked devices.
  const auth = await post("/api/auth", { email: "earner@x.com", password: "pw-test-12345", kind: "user" });
  const A = { authorization: `Bearer ${auth.body.token}` };
  await post("/api/portal/link-device", { deviceId: "dev-A" }, A);
  await post("/api/portal/link-device", { deviceId: "dev-B" }, A);

  // bid 80 → a click credits the viewer $2.00 (> the $1/day cap).
  const adId = await liveCampaign("bigbid@x.com", 80);

  // Device A clicks once → $2, which trips the account's daily cap.
  await events([{ id: "a1", type: "click", adId }], "dev-A");
  // Device B then tries to earn — the cap is ALREADY spent at the account level.
  await events([{ id: "b1", type: "click", adId }, { id: "b2", type: "impression", adId }], "dev-B");

  const db = load();
  const a = db.earnings["dev-A"]?.pendingUsd ?? 0;
  const b = db.earnings["dev-B"]?.pendingUsd ?? 0;
  assert.ok(a >= 2, `device A earned the first click, got ${a}`);
  assert.equal(b, 0, `device B earned nothing — the account cap was already spent, got ${b}`);

  // The whole account is at one cap's worth, NOT one-per-device.
  assert.ok(a + b <= 2.0001, `account total stays at ~one cap, got ${a + b}`);
});

test("an UNLINKED device earns nothing; linking it starts crediting", async () => {
  const adId = await liveCampaign("gate@x.com", 80);
  const dev = "dev-unlinked";

  // Unlinked: x-kolex-device is just a client header — no account, no credit.
  await events([{ id: "u1", type: "impression", adId }, { id: "u2", type: "click", adId }], dev);
  assert.equal(load().earnings[dev]?.pendingUsd ?? 0, 0, "unlinked device must not earn");
  // And the advertiser was not billed for the dropped events.
  assert.equal(load().campaigns.find((c) => c.id === adId).spendUsd, 0, "no advertiser bill for unlinked traffic");

  // Link it to an account, then it earns normally.
  const auth = await post("/api/auth", { email: "gateuser@x.com", password: "pw-test-12345", kind: "user" });
  await post("/api/portal/link-device", { deviceId: dev }, { authorization: `Bearer ${auth.body.token}` });
  await events([{ id: "u3", type: "impression", adId }], dev);
  assert.ok((load().earnings[dev]?.pendingUsd ?? 0) > 0, "linked device earns");
});
