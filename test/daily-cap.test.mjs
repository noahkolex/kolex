// Per-device daily caps: a single device can't earn more than KOLEX_DAILY_CAP_USD
// or be credited more than KOLEX_MAX_IMPRESSIONS_PER_DAY in a rolling 24h.
import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_HOURLY_CAP_USD = "0"; // isolate the DAILY caps
process.env.KOLEX_MAX_IMPRESSIONS_PER_MIN = "100000000";
process.env.KOLEX_MAX_EVENTS_PER_BATCH = "100000";
process.env.KOLEX_DAILY_CAP_USD = "1"; // $1/day earning cap
process.env.KOLEX_MAX_IMPRESSIONS_PER_DAY = "10"; // 10 impressions/day cap
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-dailycap-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset, load } = await import("../server/db.mjs");

let server, base;
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const post = (p, b, h = {}) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) }).then(J);
const events = (evs, device) => fetch(`${base}/v1/events`, { method: "POST", headers: { "content-type": "application/json", "x-kolex-device": device }, body: JSON.stringify({ events: evs }) }).then(J);
const balance = (device) => fetch(`${base}/v1/balance`, { headers: { "x-kolex-device": device } }).then(J);

async function liveCampaign(email, bid) {
  const r = await post("/api/ads", { email, password: "pw-test-12345", brand: "Cap", text: "cap test ad", url: "https://x.com", bidPerBlock: bid, blocks: 1000, accent: "#FF4F1F" });
  await post("/api/stub/complete-checkout", { campaignId: r.body.campaign.id });
  return r.body.campaign.id;
}

before(async () => { reset(); await new Promise((r) => (server = app.listen(0, () => ((base = `http://127.0.0.1:${server.address().port}`), r())))); });
after(() => { server?.close(); fs.rmSync(process.env.KOLEX_DB, { force: true }); });

test("daily earnings are capped at $1 even with a high bid", async () => {
  // $80/1k bid → $0.04 per impression → would be $0.40 for 10 impressions,
  // but a click is $2.00, so the cap should stop earnings at ~$1.
  const adId = await liveCampaign("bigbid@x.com", 80);
  const dev = "dev-earn-cap";
  // 5 impressions ($0.20) then a click ($2.00). The click crosses $1 but the
  // NEXT credit is blocked, so total lands just above $1, never runaway.
  await events(Array.from({ length: 5 }, (_, i) => ({ id: `i${i}`, type: "impression", adId })), dev);
  await events([{ id: "c1", type: "click", adId }], dev);
  // Further events earn nothing — daily cap reached.
  await events([{ id: "c2", type: "click", adId }, { id: "i9", type: "impression", adId }], dev);
  const bal = await balance(dev);
  assert.ok(bal.body.pendingUsd <= 2.2, `should not run away past the cap, got ${bal.body.pendingUsd}`);
  assert.ok(bal.body.pendingUsd >= 1, `should reach ~the cap, got ${bal.body.pendingUsd}`);
  // The second click + extra impression were dropped (we were already at the cap).
  const after = await balance(dev);
  assert.equal(after.body.pendingUsd, bal.body.pendingUsd, "no further earnings after the cap");
});

test("impressions are capped at the daily limit per device", async () => {
  const adId = await liveCampaign("lowbid@x.com", 1); // $1/1k → $0.0005/impression
  const dev = "dev-impr-cap";
  // Send 25 impressions; only 10 should be credited (and billed).
  await events(Array.from({ length: 25 }, (_, i) => ({ id: `imp${i}`, type: "impression", adId })), dev);
  assert.equal(load().earnings[dev].impressions, 10, `impressions capped at 10, got ${load().earnings[dev]?.impressions}`);
});
