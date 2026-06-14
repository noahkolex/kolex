// Pure unit tests for the normalized-Postgres diff engine (computeOps). No DB
// required — these verify that turning one in-memory state into another emits
// exactly the right INSERT/UPDATE/DELETE row operations.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeOps } from "../server/db.mjs";

const blank = () => ({
  advertisers: [], campaigns: [], users: [], devices: [], payouts: [],
  earnings: {}, sessions: {}, passwordResets: {}, emailVerifications: {},
  seenEvents: {}, processedWebhooks: {}, banned: {}, abuse: {}, recentEarnings: [],
});
const find = (arr, table) => arr.filter((o) => o.table === table);

test("inserting a new array row emits one upsert with mapped columns + null extra", () => {
  const base = blank();
  const cur = blank();
  cur.users.push({ id: "usr_1", email: "a@x.com", bonusUsd: 5, emailVerified: false, createdAt: 100 });
  const { upserts, deletes } = computeOps(cur, base);
  const u = find(upserts, "users");
  assert.equal(u.length, 1);
  assert.equal(u[0].onConflict, "update");
  assert.equal(u[0].row.cols[0], "id"); // pk first
  assert.equal(u[0].row.vals[0], "usr_1");
  // mapped column present
  const i = u[0].row.cols.indexOf("bonus_usd");
  assert.equal(u[0].row.vals[i], 5);
  // no unmapped fields → extra is null
  const ei = u[0].row.cols.indexOf("extra");
  assert.equal(u[0].row.vals[ei], null);
  assert.equal(deletes.length, 0);
});

test("unmapped fields are preserved in the extra jsonb column", () => {
  const cur = blank();
  cur.users.push({ id: "usr_x", email: "b@x.com", createdAt: 1, somethingNew: { nested: true }, flag: 7 });
  const { upserts } = computeOps(cur, blank());
  const row = find(upserts, "users")[0].row;
  const extra = row.vals[row.cols.indexOf("extra")];
  assert.deepEqual(extra, { somethingNew: { nested: true }, flag: 7 });
});

test("an unchanged state produces no operations", () => {
  const a = blank();
  a.campaigns.push({ id: "c1", advertiserId: "adv", status: "active", bidPerBlock: 10 });
  const b = structuredClone(a);
  const ops = computeOps(a, b);
  assert.equal(ops.upserts.length, 0);
  assert.equal(ops.deletes.length, 0);
  assert.equal(ops.logs.length, 0);
});

test("changing one field emits exactly one upsert", () => {
  const base = blank();
  base.users.push({ id: "u", email: "e", createdAt: 1, payoutsReady: false });
  const cur = structuredClone(base);
  cur.users[0].payoutsReady = true;
  const ops = computeOps(cur, base);
  assert.equal(find(ops.upserts, "users").length, 1);
  assert.equal(ops.deletes.length, 0);
});

test("removing an array row emits a delete keyed by its pk", () => {
  const base = blank();
  base.campaigns.push({ id: "cmp_gone", advertiserId: "a", status: "pending" });
  const cur = blank();
  const ops = computeOps(cur, base);
  const d = find(ops.deletes, "campaigns");
  assert.equal(d.length, 1);
  assert.equal(d[0].key, "cmp_gone");
});

test("map collections diff by key (earnings)", () => {
  const base = blank();
  const cur = blank();
  cur.earnings["dev1"] = { impressions: 3, clicks: 0, pendingUsd: 0.12, paidUsd: 0 };
  const ops = computeOps(cur, base);
  const u = find(ops.upserts, "earnings")[0];
  assert.equal(u.row.cols[0], "device_id");
  assert.equal(u.row.vals[0], "dev1");
  assert.equal(u.row.vals[u.row.cols.indexOf("pending_usd")], 0.12);
});

test("set collections (idempotency keys) upsert with ON CONFLICT DO NOTHING", () => {
  const cur = blank();
  cur.seenEvents["evt_1"] = true;
  const ops = computeOps(cur, blank());
  const u = find(ops.upserts, "seen_events")[0];
  assert.equal(u.onConflict, "nothing");
  assert.deepEqual(u.row.cols, ["event_id"]);
  assert.deepEqual(u.row.vals, ["evt_1"]);
});

test("the capped log is replaced wholesale when it changes", () => {
  const base = blank();
  const cur = blank();
  cur.recentEarnings.push({ deviceId: "d", amountUsd: 0.04, at: 999 });
  const ops = computeOps(cur, base);
  assert.equal(ops.logs.length, 1);
  assert.equal(ops.logs[0].table, "recent_earnings");
  assert.equal(ops.logs[0].rows.length, 1);
});
