// End-to-end smoke of the REAL Express app running on Postgres: the full money
// flow (advertiser pays → serves → settles → earner cashes out), then a
// simulated restart to prove everything persisted into the normalized tables.
// Gated on KOLEX_TEST_DATABASE_URL (the `test:pg` script provides one).
import { strict as assert } from "node:assert";

const URL = process.env.KOLEX_TEST_DATABASE_URL;
if (!URL) {
  console.log("postgres-e2e: KOLEX_TEST_DATABASE_URL not set — skipping");
  process.exit(0);
}
process.env.DATABASE_URL = URL;
process.env.PGSSLMODE = "disable";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_MIN_PAYOUT_USD = "0.10";
process.env.KOLEX_PAYOUT_MATURATION_DAYS = "0";
process.env.KOLEX_PRELAUNCH = "0";
process.env.KOLEX_DAILY_CAP_USD = "0"; // disable daily caps for earnings-math tests
process.env.KOLEX_MAX_IMPRESSIONS_PER_DAY = "0";

const db = await import("../server/db.mjs");
const { app } = await import("../server/index.mjs");

await db.init();
await db.reset();

let server, base;
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const get = (p, h) => fetch(`${base}${p}`, { headers: h }).then(J);
const post = (p, b, h = {}) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: b === undefined ? undefined : JSON.stringify(b) }).then(J);

let pass = 0;
const ok = (cond, label, extra = "") => {
  if (!cond) { console.error(`  ✗ ${label} ${extra}`); throw new Error(`FAILED: ${label}`); }
  console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ""}`);
  pass++;
};

try {
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  console.log("\n▶ Advertiser pays, campaign goes live");
  const ad = await post("/api/ads", {
    email: "adv@pg.com", password: "pw-test-12345", brand: "PgCo", text: "postgres powered",
    url: "https://pg.com", bidPerBlock: 80, blocks: 10, accent: "#FF4F1F",
  });
  ok(ad.status === 200 && ad.body.campaign, "campaign created", ad.body.campaign?.id);
  const campaignId = ad.body.campaign.id;
  await post("/api/stub/complete-checkout", { campaignId });
  const cfg = await get("/v1/config");
  ok(cfg.body.ads.some((a) => a.id === campaignId), "paid campaign serves");

  console.log("\n▶ Extension settles impressions");
  const imps = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, type: "impression", adId: campaignId }));
  await fetch(`${base}/v1/events`, {
    method: "POST", headers: { "content-type": "application/json", "x-kolex-device": "dev_pg" },
    body: JSON.stringify({ events: imps }),
  });
  const bal = await get("/v1/balance", { "x-kolex-device": "dev_pg" });
  ok(Math.abs(bal.body.pendingUsd - 0.2) < 1e-6, "device pending credited", `$${bal.body.pendingUsd}`); // 5 × $0.04

  console.log("\n▶ Earner links device + cashes out");
  const login = await post("/api/auth", { email: "earn@pg.com", password: "pw-test-12345", kind: "user" });
  const auth = { authorization: `Bearer ${login.body.token}` };
  await post("/api/portal/link-device", { deviceId: "dev_pg" }, auth);
  await post("/api/stub/complete-connect", undefined, auth);
  const payout = await post("/api/portal/payout", undefined, auth);
  ok(payout.status === 200 && payout.body.payout.status === "paid", "payout settled", `$${payout.body.paidUsd}`);
  await db.flush();

  console.log("\n▶ Simulated restart — data must survive in normalized tables");
  await new Promise((r) => server.close(r));
  db._clearCache();
  await db.init(); // re-hydrate from Postgres
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  const cfg2 = await get("/v1/config");
  ok(cfg2.body.ads.some((a) => a.id === campaignId), "campaign still serves after restart");
  const login2 = await post("/api/auth", { email: "earn@pg.com", password: "pw-test-12345", kind: "user" });
  ok(login2.body.created === false, "earner account persisted (login, not re-create)");
  const sum = await get("/api/portal/summary", { authorization: `Bearer ${login2.body.token}` });
  ok(Math.abs(sum.body.paidUsd - 0.2) < 1e-6, "paid earnings survived restart", `$${sum.body.paidUsd}`);

  console.log(`\n✅ Postgres e2e passed (${pass} checks).`);
} finally {
  await new Promise((r) => (server ? server.close(r) : r()));
  await db.close();
}
