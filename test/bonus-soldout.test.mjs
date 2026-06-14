// When the shown "spots left" counter reaches 0, the $5 bonus must stop being
// granted — the displayed number is the real gate, not just decoration.
import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_SIGNUP_BONUS_LIMIT = "500";       // pool shown for framing
process.env.KOLEX_SIGNUP_BONUS_SHOWN_LEFT = "1";    // only 1 actually available
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-soldout-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset } = await import("../server/db.mjs");

let server, base;
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const get = (p) => fetch(`${base}${p}`).then(J);
const post = (p, b) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(J);

before(async () => {
  reset();
  await new Promise((r) => (server = app.listen(0, () => ((base = `http://127.0.0.1:${server.address().port}`), r()))));
});
after(() => { server?.close(); fs.rmSync(process.env.KOLEX_DB, { force: true }); });

test("the last spot is granted, then the bonus stops once the counter hits 0", async () => {
  let p = await get("/api/promo");
  assert.equal(p.body.spotsLeft, 1);
  assert.equal(p.body.bonusAvailable, true);

  // Claim the final spot.
  const a = await post("/api/auth", { email: "last@x.com", password: "pw-test-12345", kind: "user" });
  assert.equal(a.body.bonusUsd, 5, "the last spot still gets the $5");

  // Counter is now 0 and the offer is closed.
  p = await get("/api/promo");
  assert.equal(p.body.spotsLeft, 0);
  assert.equal(p.body.spotsClaimed, 500);
  assert.equal(p.body.bonusAvailable, false);

  // Further signups still work, but get NO bonus.
  const b = await post("/api/auth", { email: "toolate@x.com", password: "pw-test-12345", kind: "user" });
  assert.equal(b.body.created, true);
  assert.equal(b.body.bonusUsd, 0, "no $5 once spots are gone");
  const s = await fetch(`${base}/api/portal/summary`, { headers: { authorization: `Bearer ${b.body.token}` } }).then(J);
  assert.equal(s.body.bonusUsd, 0);
});
