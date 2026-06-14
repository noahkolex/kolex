// The "spots left" shown on the site is a scarcity number (KOLEX_SIGNUP_BONUS_
// SHOWN_LEFT) that ticks down as real accounts claim — while the true cap still
// governs who actually gets the $5.
import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_SIGNUP_BONUS_LIMIT = "500"; // real cap
process.env.KOLEX_SIGNUP_BONUS_SHOWN_LEFT = "49"; // but the site says ~49 left
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-scarcity-${process.pid}-${Date.now()}.json`);

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

test("the site shows the scarcity number, decreasing as real accounts claim", async () => {
  let p = await get("/api/promo");
  assert.equal(p.body.spotsLeft, 49, "shown count starts at the scarcity value");
  assert.equal(p.body.spotsTotal, 500);
  assert.equal(p.body.spotsClaimed, 451); // 500 - 49
  assert.equal(p.body.bonusAvailable, true);

  // A real signup grants the bonus AND ticks the shown count to 48.
  const a = await post("/api/auth", { email: "s1@x.com", password: "pw-test-12345", kind: "user" });
  assert.equal(a.body.bonusUsd, 5, "real bonus still granted (real cap is 500)");
  p = await get("/api/promo");
  assert.equal(p.body.spotsLeft, 48);
  assert.equal(p.body.bonusAvailable, true, "still granting — true cap not reached");
});
