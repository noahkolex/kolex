// Integration tests against a REAL Postgres, exercising the normalized backend:
// schema creation, write-through into real tables/columns, the in-memory diff
// (insert/update/delete), hydrate-on-restart, and the legacy-document migration.
//
// Runs only when KOLEX_TEST_DATABASE_URL points at a throwaway database (the
// `test:pg` npm script spins one up in Docker). Skipped otherwise so the normal
// suite needs no database.
import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";

const URL = process.env.KOLEX_TEST_DATABASE_URL;
const RUN = !!URL;

// Configure the backend BEFORE importing db.mjs (it reads DATABASE_URL at load).
if (RUN) {
  process.env.DATABASE_URL = URL;
  process.env.PGSSLMODE = "disable";
}

const db = RUN ? await import("../server/db.mjs") : null;
const pg = RUN ? (await import("pg")).default : null;
let raw; // direct client for asserting raw table contents

before(async () => {
  if (!RUN) return;
  raw = new pg.Pool({ connectionString: URL, ssl: undefined });
  await db.init();
  await db.reset(); // clean slate
});
after(async () => {
  if (!RUN) return;
  await db.close();
  await raw.end();
});

test("normalized tables exist with the expected columns", { skip: !RUN }, async () => {
  const { rows } = await raw.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
  );
  const names = rows.map((r) => r.table_name);
  for (const t of ["advertisers", "campaigns", "users", "devices", "earnings", "payouts", "sessions", "seen_events", "recent_earnings"]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  const { rows: cols } = await raw.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='users'",
  );
  const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
  assert.equal(byName.email, "text");
  assert.equal(byName.bonus_usd, "double precision");
  assert.equal(byName.email_verified, "boolean");
  assert.equal(byName.created_at, "bigint");
});

test("save() writes rows into the correct real columns (not one JSON blob)", { skip: !RUN }, async () => {
  const d = db.load();
  d.advertisers.push({ id: "adv_1", email: "adv@x.com", createdAt: 111 });
  d.campaigns.push({
    id: "cmp_1", advertiserId: "adv_1", brand: "Acme", text: "buy now", url: "https://acme.com",
    accent: "#FF0000", bidPerBlock: 25, blocks: 10, impressionsRemaining: 9999, impressions: 1, clicks: 0,
    spendUsd: 0.0125, status: "active", createdAt: 222, payment: { status: "paid", amountUsd: 250 },
  });
  d.users.push({ id: "usr_1", email: "earn@x.com", emailVerified: false, createdAt: 333, bonusUsd: 5 });
  d.devices.push({ deviceId: "dev_1", userId: "usr_1", deviceCode: null, token: "tok", authorized: true });
  d.earnings["dev_1"] = { impressions: 12, clicks: 1, pendingUsd: 0.54, paidUsd: 0 };
  d.seenEvents["evt_1"] = true;
  d.recentEarnings.push({ deviceId: "dev_1", amountUsd: 0.04, at: 444 });
  await db.save();
  await db.flush();

  const u = (await raw.query("SELECT email, bonus_usd, email_verified, created_at FROM users WHERE id='usr_1'")).rows[0];
  assert.equal(u.email, "earn@x.com");
  assert.equal(Number(u.bonus_usd), 5);
  assert.equal(u.email_verified, false);
  assert.equal(Number(u.created_at), 333);

  const c = (await raw.query("SELECT status, bid_per_block, payment FROM campaigns WHERE id='cmp_1'")).rows[0];
  assert.equal(c.status, "active");
  assert.equal(Number(c.bid_per_block), 25);
  assert.deepEqual(c.payment, { status: "paid", amountUsd: 250 }); // nested value object as jsonb

  const e = (await raw.query("SELECT pending_usd, impressions FROM earnings WHERE device_id='dev_1'")).rows[0];
  assert.equal(Number(e.pending_usd), 0.54);
  assert.equal(Number(e.impressions), 12);

  assert.equal((await raw.query("SELECT 1 FROM seen_events WHERE event_id='evt_1'")).rowCount, 1);
  assert.equal((await raw.query("SELECT count(*)::int n FROM recent_earnings")).rows[0].n, 1);
});

test("hydrate-on-restart reconstructs the in-memory model with correct JS types", { skip: !RUN }, async () => {
  db._clearCache();
  await db.init(); // re-hydrate from the tables (simulates a process restart)
  const d = db.load();
  const u = d.users.find((x) => x.id === "usr_1");
  assert.equal(u.email, "earn@x.com");
  assert.equal(u.bonusUsd, 5); // number, not "5"
  assert.equal(typeof u.bonusUsd, "number");
  assert.equal(u.emailVerified, false); // boolean
  assert.equal(u.createdAt, 333);
  const c = d.campaigns.find((x) => x.id === "cmp_1");
  assert.equal(c.bidPerBlock, 25);
  assert.deepEqual(c.payment, { status: "paid", amountUsd: 250 });
  assert.equal(d.earnings["dev_1"].pendingUsd, 0.54);
  assert.equal(d.seenEvents["evt_1"], true);
  assert.equal(d.recentEarnings.length, 1);
});

test("an in-memory update is written as an UPDATE (diff)", { skip: !RUN }, async () => {
  const d = db.load();
  d.users.find((x) => x.id === "usr_1").bonusUsd = 0;
  d.users.find((x) => x.id === "usr_1").payoutsReady = true;
  await db.save();
  await db.flush();
  const u = (await raw.query("SELECT bonus_usd, payouts_ready FROM users WHERE id='usr_1'")).rows[0];
  assert.equal(Number(u.bonus_usd), 0);
  assert.equal(u.payouts_ready, true);
});

test("deleting an array row is written as a DELETE", { skip: !RUN }, async () => {
  const d = db.load();
  const i = d.campaigns.findIndex((x) => x.id === "cmp_1");
  d.campaigns.splice(i, 1);
  await db.save();
  await db.flush();
  assert.equal((await raw.query("SELECT count(*)::int n FROM campaigns")).rows[0].n, 0);
});

test("unmapped fields survive a round-trip via the extra column", { skip: !RUN }, async () => {
  const d = db.load();
  d.users.find((x) => x.id === "usr_1").experimentalFlag = { tier: "gold", n: 3 };
  await db.save();
  await db.flush();
  db._clearCache();
  await db.init();
  const u = db.load().users.find((x) => x.id === "usr_1");
  assert.deepEqual(u.experimentalFlag, { tier: "gold", n: 3 });
});

test("legacy single-row kolex_state migrates into normalized tables", { skip: !RUN }, async () => {
  // Wipe normalized tables and drop in a legacy document, then re-init.
  await db.close();
  await raw.query("TRUNCATE advertisers, campaigns, users, devices, payouts, earnings, sessions, password_resets, email_verifications, banned, abuse, seen_events, processed_webhooks, recent_earnings RESTART IDENTITY");
  await raw.query("CREATE TABLE IF NOT EXISTS kolex_state (id int PRIMARY KEY, doc jsonb NOT NULL)");
  const legacy = {
    advertisers: [{ id: "adv_legacy", email: "old@x.com", createdAt: 1 }],
    campaigns: [{ id: "cmp_legacy", advertiserId: "adv_legacy", brand: "Old", status: "active", bidPerBlock: 9, createdAt: 2 }],
    users: [{ id: "usr_legacy", email: "olduser@x.com", createdAt: 3, bonusUsd: 5 }],
    earnings: { dev_legacy: { impressions: 5, clicks: 0, pendingUsd: 0.2, paidUsd: 0 } },
  };
  await raw.query("INSERT INTO kolex_state (id, doc) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET doc=EXCLUDED.doc", [legacy]);

  db._clearCache();
  await db.init(); // should detect empty tables + legacy doc and import it
  const d = db.load();
  assert.equal(d.advertisers[0].email, "old@x.com");
  assert.equal(d.users[0].bonusUsd, 5);
  assert.equal(d.earnings["dev_legacy"].pendingUsd, 0.2);
  // And it actually landed in real tables:
  assert.equal((await raw.query("SELECT brand FROM campaigns WHERE id='cmp_legacy'")).rows[0].brand, "Old");
});
