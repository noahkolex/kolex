// Authentication tests — real password auth (no more "any email signs in").
import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-auth-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset } = await import("../server/db.mjs");

let server, base;
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const post = (p, body, headers = {}) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(J);
const get = (p, headers) => fetch(`${base}${p}`, { headers }).then(J);

before(async () => {
  reset();
  await new Promise((r) => (server = app.listen(0, () => (base = `http://127.0.0.1:${server.address().port}`, r()))));
});
after(() => {
  server?.close();
  fs.rmSync(process.env.KOLEX_DB, { force: true });
});

test("new email + password creates an account and returns a token", async () => {
  const r = await post("/api/auth", { email: "alice@x.com", password: "hunter2hunter", kind: "user" });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.equal(r.body.created, true);
});

test("returning with the SAME password signs in", async () => {
  const r = await post("/api/auth", { email: "alice@x.com", password: "hunter2hunter", kind: "user" });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, false);
});

test("WRONG password is rejected (no more 'any email signs in')", async () => {
  const r = await post("/api/auth", { email: "alice@x.com", password: "wrongwrong", kind: "user" });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /password/i);
});

test("password shorter than 8 chars is rejected", async () => {
  const r = await post("/api/auth", { email: "bob@x.com", password: "short", kind: "user" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /8 characters/);
});

test("invalid email is rejected", async () => {
  const r = await post("/api/auth", { email: "notanemail", password: "longenough12", kind: "user" });
  assert.equal(r.status, 400);
});

test("user and advertiser namespaces are independent", async () => {
  const u = await post("/api/auth", { email: "dual@x.com", password: "passwordone", kind: "user" });
  const a = await post("/api/auth", { email: "dual@x.com", password: "passwordtwo", kind: "advertiser" });
  assert.equal(u.status, 200);
  assert.equal(a.status, 200);
  assert.equal(a.body.created, true, "advertiser account is separate from the user account");
});

test("/api/me validates a session token and rejects a bad one", async () => {
  const { body } = await post("/api/auth", { email: "carol@x.com", password: "carolcarol", kind: "user" });
  const me = await get("/api/me", { authorization: `Bearer ${body.token}` });
  assert.equal(me.status, 200);
  assert.equal(me.body.email, "carol@x.com");
  assert.equal((await get("/api/me", { authorization: "Bearer garbage" })).status, 401);
  assert.equal((await get("/api/me")).status, 401);
});

test("submitting an ad requires the advertiser's correct password", async () => {
  const adBody = (pw) => ({
    email: "advco@x.com", password: pw, brand: "AdCo", text: "hello world",
    url: "https://adco.com", bidPerBlock: 20, blocks: 3,
  });
  const first = await post("/api/ads", adBody("rightpassword"));
  assert.equal(first.status, 200, "creates advertiser + campaign");
  const wrong = await post("/api/ads", adBody("nottherightone"));
  assert.equal(wrong.status, 401, "wrong password can't submit under that email");
  assert.ok(wrong.body.errors?.[0] && /password/i.test(wrong.body.errors[0]));
});
