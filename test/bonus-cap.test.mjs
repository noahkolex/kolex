// The welcome bonus is limited to the first N earner accounts (KOLEX_SIGNUP_
// BONUS_LIMIT). After that, signups still succeed but get no $5. /api/promo
// exposes the live counter + waitlist headcount for the homepage.
import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_SIGNUP_BONUS_LIMIT = "2"; // tiny cap to exercise the limit
process.env.KOLEX_SIGNUP_BONUS_SHOWN_LEFT = "off"; // test the real counts, not the scarcity display
process.env.KOLEX_WAITLIST_COUNT = "1000";
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-cap-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset } = await import("../server/db.mjs");

let server, base;
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const get = (p) => fetch(`${base}${p}`).then(J);
const post = (p, b, h = {}) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) }).then(J);

before(async () => {
  reset();
  await new Promise((r) => (server = app.listen(0, () => ((base = `http://127.0.0.1:${server.address().port}`), r()))));
});
after(() => { server?.close(); fs.rmSync(process.env.KOLEX_DB, { force: true }); });

test("promo endpoint reports the cap, claimed count, and waitlist headcount", async () => {
  const p = await get("/api/promo");
  assert.equal(p.body.spotsTotal, 2);
  assert.equal(p.body.spotsClaimed, 0);
  assert.equal(p.body.spotsLeft, 2);
  assert.equal(p.body.waitlistCount, 1000);
  assert.equal(p.body.bonusAvailable, true);
});

test("the first N accounts get the bonus; the cap is then reported as full", async () => {
  const a = await post("/api/auth", { email: "cap1@x.com", password: "pw-test-12345", kind: "user" });
  assert.equal(a.body.bonusUsd, 5);
  const b = await post("/api/auth", { email: "cap2@x.com", password: "pw-test-12345", kind: "user" });
  assert.equal(b.body.bonusUsd, 5);

  const p = await get("/api/promo");
  assert.equal(p.body.spotsClaimed, 2);
  assert.equal(p.body.spotsLeft, 0);
  assert.equal(p.body.bonusAvailable, false);
});

test("accounts past the cap still sign up, just without the $5", async () => {
  const c = await post("/api/auth", { email: "cap3@x.com", password: "pw-test-12345", kind: "user" });
  assert.equal(c.body.created, true, "account is still created");
  assert.equal(c.body.bonusUsd, 0, "no bonus past the cap");
  const s = await fetch(`${base}/api/portal/summary`, { headers: { authorization: `Bearer ${c.body.token}` } }).then(J);
  assert.equal(s.body.bonusUsd, 0);
});
