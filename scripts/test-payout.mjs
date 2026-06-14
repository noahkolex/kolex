// End-to-end payout walkthrough you can run yourself: `npm run test:payout`.
// Boots the server in stub mode (no Stripe keys needed) and drives the FULL
// earner payout journey over the real HTTP API, printing each step. Use it to
// confirm payouts work, or as a template for testing against a live deploy.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.STRIPE_MODE ??= "stub";
process.env.KOLEX_MIN_PAYOUT_USD ??= "10";
process.env.KOLEX_PAYOUT_MATURATION_DAYS ??= "0"; // this demo drives the full cash-out, not the holding period
process.env.KOLEX_DAILY_CAP_USD ??= "0"; // demo earns past the daily cap
process.env.KOLEX_MAX_IMPRESSIONS_PER_DAY ??= "0";
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-payout-demo-${process.pid}.json`);

const { app } = await import("../server/index.mjs");

const server = await new Promise((r) => {
  const s = app.listen(0, () => r(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

let step = 0;
const log = (msg) => console.log(`  ✓ ${msg}`);
const head = (msg) => console.log(`\n${++step}. ${msg}`);
const J = (r) => r.json().catch(() => ({}));
const POST = (p, body, token) =>
  fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const GET = (p, token) => fetch(`${base}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ FAILED: ${msg}`); server.close(); process.exit(1); }
}

const money = (n) => `$${Number(n).toFixed(2)}`;
const DEVICE = "payout-demo-device";

try {
  console.log(`\nKolex payout walkthrough  (stub mode, server ${base})`);

  head("Earn a balance on a device");
  // In real life this accrues from watching ads; the stub seed gives it instantly.
  const seed = await POST("/api/stub/seed-earnings", { deviceId: DEVICE, amountUsd: 25 }).then(J);
  assert(seed.pendingUsd === 25, "seed earnings");
  log(`device ${DEVICE} now has ${money(seed.pendingUsd)} pending`);

  head("Create an earner account and sign in");
  const auth = await POST("/api/auth", { email: "demo-earner@kolex.ai", password: "demopassword", kind: "user" }).then(J);
  assert(auth.token, "sign in");
  const token = auth.token;
  log(`signed in as demo-earner@kolex.ai`);

  head("Link the browser/device to the account");
  const link = await POST("/api/portal/link-device", { deviceId: DEVICE }, token).then(J);
  assert(link.ok, "link device");
  log(`device linked; earnings now belong to the account`);

  head("Try to withdraw BEFORE connecting a payout account (must be blocked)");
  const early = await POST("/api/portal/payout", undefined, token);
  const earlyBody = await J(early);
  assert(early.status === 400 && earlyBody.needsConnect, "withdraw blocked until payouts are set up");
  log(`blocked as expected: "${earlyBody.error}"`);

  head("Connect a payout account (Stripe Connect onboarding)");
  const connect = await POST("/api/portal/connect", undefined, token).then(J);
  assert(connect.url, "connect returns an onboarding URL");
  log(`onboarding URL: ${connect.url.replace(base, "")}`);
  // The mock onboarding page posts this on "Complete onboarding"; live mode
  // sets it when Stripe confirms the account can receive transfers.
  await POST("/api/stub/complete-connect", undefined, token);
  const ready = await GET("/api/portal/summary", token).then(J);
  assert(ready.payoutsReady === true, "payouts enabled after onboarding");
  log(`payouts enabled (method: ${ready.payoutMethod})`);

  head("Withdraw");
  const payout = await POST("/api/portal/payout", undefined, token).then(J);
  assert(payout.ok && payout.payout?.status === "paid", "payout settles");
  log(`paid out ${money(payout.paidUsd)} (payout ${payout.payout.id}, status ${payout.payout.status})`);

  head("Confirm the balance moved from pending to paid");
  const after = await GET("/api/portal/summary", token).then(J);
  assert(after.pendingUsd === 0, "pending is zero");
  assert(Math.abs(after.paidUsd - 25) < 1e-9, "paid total is $25");
  log(`pending ${money(after.pendingUsd)}, paid ${money(after.paidUsd)}, payouts on record: ${after.payouts.length}`);

  console.log(`\n✅ Payout flow works end to end.\n`);
  server.close();
  fs.rmSync(process.env.KOLEX_DB, { force: true });
} catch (err) {
  console.error("\n✗ Walkthrough crashed:", err);
  server.close();
  process.exit(1);
}
