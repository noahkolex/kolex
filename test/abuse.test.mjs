// Abuse-control tests: click suspension, hourly earnings cap, impossible-rate
// auto-ban, banning, and the admin moderation endpoints. Configure the controls
// BEFORE importing the app (config reads env at import).
import { strict as assert } from "node:assert";
import { test, before, after, beforeEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_REQUIRE_LINKED_TO_EARN = "0"; // these exercise per-device rate/cap mechanics on throwaway devices; the link gate is covered in account-cap.test
process.env.KOLEX_MIN_PAYOUT_USD = "0.10";
process.env.KOLEX_DISABLE_CLICKS = "1";
process.env.KOLEX_HOURLY_CAP_USD = "5";
process.env.KOLEX_MAX_IMPRESSIONS_PER_MIN = "20";
process.env.KOLEX_AUTOBAN_FLAGS = "2";
process.env.KOLEX_DAILY_CAP_USD = "0"; // disable daily caps for earnings-math tests
process.env.KOLEX_MAX_IMPRESSIONS_PER_DAY = "0";
process.env.KOLEX_ADMIN_TOKEN = "secret-admin";
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-abuse-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset, load } = await import("../server/db.mjs");

let server, base;
const url = (p) => `${base}${p}`;
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const post = (p, body, headers = {}) =>
  fetch(url(p), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(J);
const events = (evs, device) =>
  fetch(url("/v1/events"), { method: "POST", headers: { "content-type": "application/json", "x-kolex-device": device }, body: JSON.stringify({ events: evs }) }).then(J);
const balance = (device) => fetch(url("/v1/balance"), { headers: { "x-kolex-device": device } }).then(J);

async function campaign(bid, blocks) {
  const r = await post("/api/ads", { email: "adv@x.com", password: "pw-test-12345", brand: "Brand", text: "future of widgets", url: "https://example.com", bidPerBlock: bid, blocks });
  await post("/api/stub/complete-checkout", { campaignId: r.body.campaign.id });
  return r.body.campaign.id;
}
let evSeq = 0;
const imps = (cid, n, dev) => events(Array.from({ length: n }, () => ({ id: `e${evSeq++}`, type: "impression", adId: cid })), dev);

before(async () => { await new Promise((r) => (server = app.listen(0, () => (base = `http://127.0.0.1:${server.address().port}`, r())))); });
beforeEach(() => reset());
after(() => { server?.close(); fs.rmSync(process.env.KOLEX_DB, { force: true }); });

test("clicks are suspended: a click earns nothing and bills nothing", async () => {
  const cid = await campaign(80, 10);
  await events([{ id: "c1", type: "click", adId: cid }], "dev-click");
  assert.equal((await balance("dev-click")).body.pendingUsd, 0);
  assert.equal(load().campaigns.find((c) => c.id === cid).spendUsd, 0, "advertiser not billed for the suspended click");
});

test("hourly cap limits a device to $5 of earnings per hour", async () => {
  const cid = await campaign(1000, 1); // $0.50 user share per impression
  await imps(cid, 12, "dev-cap"); // 12 × $0.50 = $6 would-be → capped at $5
  assert.ok(Math.abs((await balance("dev-cap")).body.pendingUsd - 5) < 1e-6, "credited exactly the $5/hr cap");
});

test("an impossible impression rate is dropped and auto-bans the device", async () => {
  const cid = await campaign(1, 1); // tiny payout so the rate cap (not the $ cap) trips
  await imps(cid, 25, "dev-fast"); // > 20/min → overflow dropped + flagged → banned
  const db = load();
  assert.ok(db.banned["dev-fast"], "device auto-banned for impossible rate");
  // Only the first 20 (at most) were credited; the flood was dropped.
  assert.ok((await balance("dev-fast")).body.pendingUsd <= 20 * 0.0005 + 1e-9);
  // A banned device earns nothing further.
  const before = (await balance("dev-fast")).body.pendingUsd;
  await imps(cid, 1, "dev-fast");
  assert.equal((await balance("dev-fast")).body.pendingUsd, before, "banned device earns nothing more");
});

test("admin endpoints require the token; ban stops earning and cash-out", async () => {
  const cid = await campaign(80, 10);
  // No token → looks like it doesn't exist.
  assert.equal((await post("/api/admin/ban", { id: "dev-x" })).status, 404);
  const A = { authorization: "Bearer secret-admin" };
  assert.equal((await post("/api/admin/ban", { id: "dev-banned", reason: "test" }, A)).status, 200);
  await imps(cid, 3, "dev-banned");
  assert.equal((await balance("dev-banned")).body.pendingUsd, 0, "banned device earns nothing");
  // Unban restores earning.
  assert.equal((await post("/api/admin/unban", { id: "dev-banned" }, A)).status, 200);
  await imps(cid, 1, "dev-banned");
  assert.ok((await balance("dev-banned")).body.pendingUsd > 0, "earns again after unban");
});

test("a banned account cannot cash out", async () => {
  const auth = await post("/api/auth", { email: "earner@x.com", password: "pw-test-12345", kind: "user" });
  const userId = load().users.find((u) => u.email === "earner@x.com").id;
  await post("/api/admin/ban", { id: userId, reason: "fraud" }, { authorization: "Bearer secret-admin" });
  const r = await post("/api/portal/payout", undefined, { authorization: `Bearer ${auth.body.token}` });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /suspended/i);
});

test("/api/admin/suspicious lists banned + flagged for triage", async () => {
  const cid = await campaign(1, 1);
  await imps(cid, 25, "dev-flag"); // trips the rate cap → flagged + banned
  const r = await fetch(url("/api/admin/suspicious"), { headers: { authorization: "Bearer secret-admin" } }).then(J);
  assert.equal(r.status, 200);
  assert.ok(r.body.banned["dev-flag"], "shows the banned device");
  assert.ok(Array.isArray(r.body.flagged));
});
