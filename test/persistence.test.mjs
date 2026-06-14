// Durability: data written through the API must survive a restart (i.e. land
// on disk), and a corrupt data file must be backed up rather than wiped.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolate from any local .env (which may point DATABASE_URL at Postgres) so the
// file-backend tests below actually exercise the file backend.
process.env.KOLEX_ENV_FILE = "/dev/null";
delete process.env.DATABASE_URL;

test("a mutation is durably written to disk (survives a restart)", async () => {
  const dbFile = path.join(os.tmpdir(), `kolex-persist-${process.pid}-${Date.now()}.json`);
  process.env.KOLEX_DB = dbFile;
  process.env.STRIPE_MODE = "stub";

  const { app } = await import("../server/index.mjs");
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${base}/api/ads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "persist@adv.com", password: "pw-test-12345", brand: "Persisto",
      text: "hello world", url: "https://example.com", bidPerBlock: 20, blocks: 3,
    }),
  }).then((r) => r.json());
  server.close();

  // Read straight from disk — exactly what the next boot would load().
  const onDisk = JSON.parse(fs.readFileSync(dbFile, "utf8"));
  assert.equal(onDisk.advertisers.length, 1, "advertiser persisted");
  assert.equal(onDisk.campaigns.length, 1, "campaign persisted");
  assert.equal(onDisk.campaigns[0].brand, "Persisto");
  fs.rmSync(dbFile, { force: true });
});

// Opt-in: exercises the real Postgres backend across a simulated restart.
// Run with KOLEX_TEST_DATABASE_URL=postgres://… (a throwaway DB).
test("postgres backend persists across a restart", {
  skip: process.env.KOLEX_TEST_DATABASE_URL ? false : "set KOLEX_TEST_DATABASE_URL to run",
}, async () => {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.KOLEX_TEST_DATABASE_URL;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  try {
    const boot = async () => {
      const m = await import(`../server/db.mjs?pg=${Date.now()}-${Math.random()}`);
      await m.init(); // connect the pool before any read/write
      return m;
    };
    // Run 1: write, then close the pool (simulate a stop).
    let db = await boot();
    await db.reset(); // start clean
    db.load().advertisers.push({ id: "adv_pg_test", email: "pg@test.com", createdAt: 1 });
    await db.save();
    await db.close();
    // Run 2: fresh boot reads it back.
    db = await boot();
    assert.ok(db.load().advertisers.some((a) => a.id === "adv_pg_test"), "data survived restart");
    await db.reset(); // leave the table clean
    await db.close();
  } finally {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  }
});

test("a corrupt data file is backed up, never silently wiped", async () => {
  const dbFile = path.join(os.tmpdir(), `kolex-corrupt-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(dbFile, "{ this is : not valid json ");
  process.env.KOLEX_DB = dbFile;

  // Fresh module instance (cache-bust) so it re-reads KOLEX_DB at eval time.
  const dbmod = await import(`../server/db.mjs?corrupt=${Date.now()}`);
  const d = dbmod.load(); // must NOT throw; backs up + starts empty
  assert.ok(Array.isArray(d.advertisers), "starts with a valid empty DB");

  const dir = path.dirname(dbFile);
  const base = path.basename(dbFile);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`));
  assert.ok(backups.length >= 1, "the corrupt file was backed up, not lost");

  fs.rmSync(dbFile, { force: true });
  for (const b of backups) fs.rmSync(path.join(dir, b), { force: true });
});
