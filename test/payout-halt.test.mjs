// Verifies the global payout kill-switch (KOLEX_PAYOUTS_HALTED). Separate file
// so the flag is set for this process only.
import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_PAYOUTS_HALTED = "1";
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-halt-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset } = await import("../server/db.mjs");

let server, base;
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const post = (p, body, headers = {}) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(J);

before(async () => { reset(); await new Promise((r) => (server = app.listen(0, () => (base = `http://127.0.0.1:${server.address().port}`, r())))); });
after(() => { server?.close(); fs.rmSync(process.env.KOLEX_DB, { force: true }); });

test("payouts are halted globally: cash-out returns 503 with a clear message", async () => {
  const auth = await post("/api/auth", { email: "u@x.com", password: "pw-test-12345", kind: "user" });
  const r = await post("/api/portal/payout", undefined, { authorization: `Bearer ${auth.body.token}` });
  assert.equal(r.status, 503);
  assert.equal(r.body.halted, true);
  assert.match(r.body.error, /paused/i);
});

test("the portal summary reports payoutsHalted so the UI can show a banner", async () => {
  const auth = await post("/api/auth", { email: "u2@x.com", password: "pw-test-12345", kind: "user" });
  const s = await fetch(`${base}/api/portal/summary`, { headers: { authorization: `Bearer ${auth.body.token}` } }).then(J);
  assert.equal(s.body.payoutsHalted, true);
});
