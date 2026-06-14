// Diagnose + backfill: copy any rows still stuck in the legacy single-JSONB-row
// (kolex_state) into the normalized tables. Safe + idempotent — it only ADDS
// rows whose key isn't already present (never overwrites newer data).
//
//   node scripts/backfill-from-legacy.mjs            # report only (dry run)
//   node scripts/backfill-from-legacy.mjs --apply    # write the missing rows
//
// Run against prod the same way as the launch script (railway run with the
// public DATABASE_URL).
import pg from "pg";
import { init, load, save, flush, close } from "../server/db.mjs";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
if (!DATABASE_URL) { console.error("✗ DATABASE_URL is required (this only applies to the Postgres backend)."); process.exit(1); }
const APPLY = process.argv.includes("--apply");

// 1) Read the legacy document directly (standalone connection).
const ssl = /@(localhost|127\.0\.0\.1|::1)[:/]/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false };
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl });
let legacy = null;
const reg = await pool.query("SELECT to_regclass('public.kolex_state') IS NOT NULL AS e");
if (reg.rows[0].e) {
  const r = await pool.query("SELECT doc FROM kolex_state WHERE id = 1");
  legacy = r.rows[0]?.doc || null;
}
await pool.end();

// 2) Hydrate the CURRENT normalized state.
await init();
const db = load();

const arr = (a) => (Array.isArray(a) ? a.length : 0);
const map = (m) => (m && typeof m === "object" ? Object.keys(m).length : 0);

console.log("\n               normalized   legacy(kolex_state)");
for (const k of ["users", "advertisers", "campaigns", "devices", "payouts"]) {
  console.log(`  ${k.padEnd(14)} ${String(arr(db[k])).padStart(6)}   ${String(arr(legacy?.[k])).padStart(6)}`);
}
for (const k of ["earnings", "sessions", "banned", "abuse"]) {
  console.log(`  ${k.padEnd(14)} ${String(map(db[k])).padStart(6)}   ${String(map(legacy?.[k])).padStart(6)}`);
}

if (!legacy) {
  console.log("\nNo legacy kolex_state document found — nothing to backfill.\n");
  await close();
  process.exit(0);
}

// 3) Merge in only the rows that are MISSING from the normalized state.
const added = {};
const mergeArr = (coll, key) => {
  const have = new Set((db[coll] || []).map((r) => r[key]));
  let n = 0;
  for (const row of legacy[coll] || []) if (!have.has(row[key])) { db[coll].push(row); n++; }
  if (n) added[coll] = n;
};
const mergeMap = (coll) => {
  let n = 0;
  for (const [k, v] of Object.entries(legacy[coll] || {})) if (!(k in db[coll])) { db[coll][k] = v; n++; }
  if (n) added[coll] = n;
};
mergeArr("users", "id"); mergeArr("advertisers", "id"); mergeArr("campaigns", "id");
mergeArr("devices", "deviceId"); mergeArr("payouts", "id");
for (const m of ["earnings", "sessions", "passwordResets", "emailVerifications", "seenEvents", "processedWebhooks", "banned", "abuse"]) mergeMap(m);

const total = Object.values(added).reduce((s, n) => s + n, 0);
console.log(`\n  missing rows to backfill: ${total ? JSON.stringify(added) : "none — normalized tables already have everything"}`);

if (!total) { await close(); process.exit(0); }
if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply to copy these into the normalized tables.\n");
  await close();
  process.exit(0);
}
await save();
await flush();
console.log("\n✅ Backfilled. Re-run without --apply to confirm the counts match.\n");
await close();
