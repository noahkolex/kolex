// Persistence with two interchangeable backends, chosen at boot:
//   • Postgres  — when DATABASE_URL is set (production / Railway). State lives in
//                 real, normalized tables (advertisers, campaigns, users,
//                 devices, earnings, …) with primary keys, foreign keys and
//                 indexes. The in-memory object model is hydrated from those
//                 tables on boot; save() writes back a DIFF (only changed rows),
//                 so the load()/save() API every endpoint uses is unchanged.
//   • JSON file — otherwise (local dev + tests). No DB needed, fast, atomic.
// Both expose the same API: init() (async, once at boot), load() (sync, returns
// the cached object), save() (persists), flush(), reset(), close().
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMPRESSIONS_PER_BLOCK } from "./economics.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.KOLEX_DB ?? path.join(DIR, "data", "db.json");
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "";
const usePg = !!DATABASE_URL;

/** Human-readable location of the store (for startup diagnostics). */
export const dbPath = () =>
  usePg ? `postgres (${DATABASE_URL.replace(/:\/\/[^@]*@/, "://***@")})` : path.resolve(DB_PATH);

const EMPTY = {
  advertisers: [], // { id, email, passwordHash, emailVerified, createdAt }
  campaigns: [], // { id, advertiserId, brand, text, url, iconDataUrl, accent,
  //                    bidPerBlock, blocks, impressionsRemaining, impressions,
  //                    clicks, spendUsd, status, createdAt,
  //                    payment: { checkoutId, status, amountUsd, paidAt } }
  // status: "pending" (awaiting payment) | "active" (paid, serving) | "completed"
  users: [], // { id, email, passwordHash, emailVerified, createdAt, payoutsReady,
  //               stripeAccountId, bonusUsd, bonusReason, bonusGrantedAt, bonusPaidAt }
  devices: [], // { deviceId, userId, deviceCode, token, authorized }
  earnings: {}, // deviceId -> { impressions, clicks, pendingUsd, paidUsd }
  sessions: {}, // token -> { kind: 'user'|'advertiser', id, email, createdAt }
  passwordResets: {}, // sha256(token) -> { kind, accountId, email, createdAt }
  emailVerifications: {}, // sha256(token) -> { kind, accountId, email, createdAt }
  seenEvents: {}, // eventId -> true (idempotency)
  processedWebhooks: {}, // stripe event id -> true (idempotency)
  payouts: [], // { id, userId, amountUsd, bonusUsd, status, stripeId, createdAt }
  recentEarnings: [], // capped log for the live feed: { deviceId, amountUsd, at }
  banned: {}, // deviceId|userId -> { reason, at } (no earning, no cash-out)
  abuse: {}, // deviceId -> { hourStart, hourUsd, minStart, minImpr, flags } (rate/cap state)
};

let db = null;

// Blank by default — real data only. Set KOLEX_SEED=1 to populate demo
// campaigns for a showcase deployment.
const wantSeed = () => /^(1|true|yes|on|demo)$/i.test(process.env.KOLEX_SEED || "");

// ─────────────────────────── File backend ───────────────────────────

function fileLoad() {
  let raw;
  try {
    raw = fs.readFileSync(DB_PATH, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      // Exists but unreadable (permissions, etc.). Do NOT overwrite it.
      throw new Error(
        `kolex: cannot read data file ${path.resolve(DB_PATH)}: ${err.message}. ` +
          `Refusing to start empty so your data isn't clobbered.`,
      );
    }
    db = structuredClone(EMPTY); // genuinely first boot
    if (wantSeed()) seed(db);
    fileSave();
    return;
  }
  try {
    db = { ...structuredClone(EMPTY), ...JSON.parse(raw) };
  } catch (err) {
    // Corrupt file: back it up before starting fresh, never silently wipe.
    const backup = `${DB_PATH}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(DB_PATH, backup);
      console.error(`[kolex] data file corrupt (${err.message}). Backed up to ${backup}.`);
    } catch {
      throw new Error(
        `kolex: data file ${path.resolve(DB_PATH)} is corrupt and couldn't be backed up. ` +
          `Refusing to overwrite it. Move the file, then restart.`,
      );
    }
    db = structuredClone(EMPTY);
    if (wantSeed()) seed(db);
    fileSave();
  }
}

function fileSave() {
  if (!db) return;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

// ───────────────────── Normalized Postgres schema ─────────────────────
// Each entry maps one in-memory collection to one real table. `kind`:
//   array — list of row objects keyed by a field (jsKey → pk column)
//   map   — object keyed by string; each value is a row object
//   set   — object keyed by string with a `true` value (idempotency keys)
//   log   — append-only capped list with no natural id (replaced wholesale)
// Any object field NOT listed in `cols` is preserved in an `extra jsonb` column,
// so adding a field in code never silently drops data.

const BIGINT = "bigint", REAL = "double precision", INT = "integer", BOOL = "boolean", TEXT = "text", JSON_ = "jsonb";

const SCHEMA = [
  {
    name: "advertisers", kind: "array", jsKey: "id", pk: "id", pkType: TEXT,
    cols: [["email", "email", TEXT], ["password_hash", "passwordHash", TEXT], ["email_verified", "emailVerified", BOOL], ["created_at", "createdAt", BIGINT]],
    unique: ["email"],
  },
  {
    name: "users", kind: "array", jsKey: "id", pk: "id", pkType: TEXT,
    cols: [
      ["email", "email", TEXT], ["password_hash", "passwordHash", TEXT], ["email_verified", "emailVerified", BOOL],
      ["created_at", "createdAt", BIGINT], ["payouts_ready", "payoutsReady", BOOL], ["stripe_account_id", "stripeAccountId", TEXT],
      ["bonus_usd", "bonusUsd", REAL], ["bonus_reason", "bonusReason", TEXT], ["bonus_granted_at", "bonusGrantedAt", BIGINT], ["bonus_paid_at", "bonusPaidAt", BIGINT],
    ],
    unique: ["email"],
  },
  {
    name: "campaigns", kind: "array", jsKey: "id", pk: "id", pkType: TEXT,
    cols: [
      ["advertiser_id", "advertiserId", TEXT], ["brand", "brand", TEXT], ["text", "text", TEXT], ["url", "url", TEXT],
      ["icon_data_url", "iconDataUrl", TEXT], ["accent", "accent", TEXT], ["bid_per_block", "bidPerBlock", REAL], ["blocks", "blocks", INT],
      ["impressions_remaining", "impressionsRemaining", BIGINT], ["impressions", "impressions", BIGINT], ["clicks", "clicks", BIGINT],
      ["spend_usd", "spendUsd", REAL], ["status", "status", TEXT], ["created_at", "createdAt", BIGINT], ["payment", "payment", JSON_],
    ],
    fkCol: "advertiser_id", fkRef: "advertisers(id)",
    indexes: ["status", "advertiser_id"],
  },
  {
    name: "devices", kind: "array", jsKey: "deviceId", pk: "device_id", pkType: TEXT,
    cols: [["user_id", "userId", TEXT], ["device_code", "deviceCode", TEXT], ["token", "token", TEXT], ["authorized", "authorized", BOOL]],
    indexes: ["user_id"],
  },
  {
    name: "payouts", kind: "array", jsKey: "id", pk: "id", pkType: TEXT,
    cols: [["user_id", "userId", TEXT], ["amount_usd", "amountUsd", REAL], ["bonus_usd", "bonusUsd", REAL], ["status", "status", TEXT], ["stripe_id", "stripeId", TEXT], ["created_at", "createdAt", BIGINT]],
    indexes: ["user_id"],
  },
  {
    name: "earnings", kind: "map", pk: "device_id", pkType: TEXT,
    cols: [["impressions", "impressions", BIGINT], ["clicks", "clicks", BIGINT], ["pending_usd", "pendingUsd", REAL], ["paid_usd", "paidUsd", REAL]],
  },
  {
    name: "sessions", kind: "map", pk: "token", pkType: TEXT,
    cols: [["kind", "kind", TEXT], ["account_id", "id", TEXT], ["email", "email", TEXT], ["created_at", "createdAt", BIGINT]],
    indexes: ["account_id"],
  },
  {
    name: "password_resets", kind: "map", pk: "token_hash", pkType: TEXT,
    cols: [["kind", "kind", TEXT], ["account_id", "accountId", TEXT], ["email", "email", TEXT], ["created_at", "createdAt", BIGINT]],
  },
  {
    name: "email_verifications", kind: "map", pk: "token_hash", pkType: TEXT,
    cols: [["kind", "kind", TEXT], ["account_id", "accountId", TEXT], ["email", "email", TEXT], ["created_at", "createdAt", BIGINT]],
  },
  {
    name: "banned", kind: "map", pk: "id", pkType: TEXT,
    cols: [["reason", "reason", TEXT], ["at", "at", BIGINT]],
  },
  {
    name: "abuse", kind: "map", pk: "device_id", pkType: TEXT,
    cols: [["hour_start", "hourStart", BIGINT], ["hour_usd", "hourUsd", REAL], ["min_start", "minStart", BIGINT], ["min_impr", "minImpr", INT], ["flags", "flags", INT]],
  },
  { name: "seen_events", kind: "set", pk: "event_id", pkType: TEXT, coll: "seenEvents" },
  { name: "processed_webhooks", kind: "set", pk: "event_id", pkType: TEXT, coll: "processedWebhooks" },
  {
    name: "recent_earnings", kind: "log", coll: "recentEarnings",
    cols: [["device_id", "deviceId", TEXT], ["amount_usd", "amountUsd", REAL], ["at", "at", BIGINT]],
  },
];

// in-memory collection name for a table (defaults to the table name).
const collOf = (t) => t.coll || t.name;

// ── value coercion ──
function fromCol(type, val) {
  if (val === null || val === undefined) return undefined;
  if (type === BIGINT || type === REAL || type === INT) return Number(val);
  if (type === BOOL) return !!val;
  return val; // TEXT, JSON_ (pg already parses jsonb)
}
function toParam(type, val) {
  if (val === undefined || val === null) return null;
  return val; // node-pg serializes objects for jsonb automatically
}

// ── pure diff: what rows must change to turn `baseline` into `cur` ──
// Returns { upserts:[{table,row,onConflict}], deletes:[{table,pk,key}], logs:[{table,rows}] }.
// Exported for unit testing without a database.
export function computeOps(cur, baseline) {
  const upserts = [], deletes = [], logs = [];
  const json = (v) => JSON.stringify(v ?? null);

  for (const t of SCHEMA) {
    const coll = collOf(t);
    if (t.kind === "log") {
      if (json(cur[coll]) !== json(baseline[coll])) {
        logs.push({ table: t.name, rows: (cur[coll] || []).map((e) => buildRow(t, null, e)) });
      }
      continue;
    }
    const curMap = collMap(t, cur), baseMap = collMap(t, baseline);
    for (const [k, v] of curMap) {
      const bv = baseMap.get(k);
      if (bv === undefined || json(bv) !== json(v)) upserts.push({ table: t.name, ...buildUpsert(t, k, v) });
    }
    for (const k of baseMap.keys()) if (!curMap.has(k)) deletes.push({ table: t.name, key: k });
  }
  // Children before parents on delete (FK-safe); deletes collected forward, so reverse.
  deletes.reverse();
  return { upserts, deletes, logs };
}

// key -> value(object) for a collection.
function collMap(t, state) {
  const coll = collOf(t);
  const m = new Map();
  if (t.kind === "array") for (const row of state[coll] || []) m.set(row[t.jsKey], row);
  else if (t.kind === "map") for (const [k, v] of Object.entries(state[coll] || {})) m.set(k, v);
  else if (t.kind === "set") for (const k of Object.keys(state[coll] || {})) m.set(k, true);
  return m;
}

// Build the column/value payload for one row (key + mapped cols + extra jsonb).
function buildRow(t, key, value) {
  const cols = [], vals = [];
  if (t.pk && key !== null) { cols.push(t.pk); vals.push(key); }
  const mapped = new Set();
  for (const [sql, js, type] of t.cols || []) {
    cols.push(sql); vals.push(toParam(type, value?.[js]));
    mapped.add(js);
  }
  if (t.kind !== "set" && t.kind !== "log") {
    // Preserve any unmapped fields so future code additions aren't dropped.
    const extra = {};
    for (const [k, v] of Object.entries(value || {})) {
      if (k === t.jsKey || mapped.has(k)) continue;
      extra[k] = v;
    }
    cols.push("extra"); vals.push(Object.keys(extra).length ? extra : null);
  }
  return { cols, vals };
}

function buildUpsert(t, key, value) {
  if (t.kind === "set") return { row: { cols: [t.pk], vals: [key] }, onConflict: "nothing" };
  return { row: buildRow(t, key, value), onConflict: "update" };
}

// ─────────────────────────── Postgres backend ───────────────────────────

let pool = null;
let baseline = null; // deep snapshot of the last successfully-persisted state
let writeChain = Promise.resolve();

const pgNeedsSsl = () =>
  process.env.PGSSLMODE !== "disable" && !/@(localhost|127\.0\.0\.1|::1)[:/]/.test(DATABASE_URL);

function ddl(t) {
  const lines = [];
  lines.push(`${t.pk} ${t.pkType} PRIMARY KEY`);
  for (const [sql, , type] of t.cols || []) lines.push(`${sql} ${type}`);
  if (t.kind !== "set" && t.kind !== "log") lines.push("extra jsonb");
  if (t.fkCol) lines.push(`FOREIGN KEY (${t.fkCol}) REFERENCES ${t.fkRef}`);
  for (const u of t.unique || []) lines.push(`UNIQUE (${u})`);
  return `CREATE TABLE IF NOT EXISTS ${t.name} (${lines.join(", ")})`;
}

async function createSchema() {
  // recent_earnings needs an ordering column (no natural id).
  for (const t of SCHEMA) {
    if (t.kind === "log") {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${t.name} (seq bigserial PRIMARY KEY, ${(t.cols || []).map(([s, , ty]) => `${s} ${ty}`).join(", ")})`,
      );
      continue;
    }
    await pool.query(ddl(t));
    for (const col of t.indexes || []) {
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_${t.name}_${col} ON ${t.name}(${col})`);
    }
  }
}

async function hydrate() {
  const out = structuredClone(EMPTY);
  for (const t of SCHEMA) {
    const coll = collOf(t);
    if (t.kind === "log") {
      const { rows } = await pool.query(`SELECT * FROM ${t.name} ORDER BY seq ASC`);
      out[coll] = rows.map((r) => rowToObj(t, r));
      continue;
    }
    const { rows } = await pool.query(`SELECT * FROM ${t.name}`);
    if (t.kind === "array") out[coll] = rows.map((r) => ({ [t.jsKey]: r[t.pk], ...rowToObj(t, r) }));
    else if (t.kind === "map") { out[coll] = {}; for (const r of rows) out[coll][r[t.pk]] = rowToObj(t, r); }
    else if (t.kind === "set") { out[coll] = {}; for (const r of rows) out[coll][r[t.pk]] = true; }
  }
  return out;
}

// One DB row → a lean in-memory object (mapped cols + spread extra, nulls dropped).
function rowToObj(t, r) {
  const obj = {};
  for (const [sql, js, type] of t.cols || []) {
    const v = fromCol(type, r[sql]);
    if (v !== undefined) obj[js] = v;
  }
  if (r.extra && typeof r.extra === "object") Object.assign(obj, r.extra);
  return obj;
}

async function pgInit() {
  if (!pool) {
    const { default: pg } = await import("pg");
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: pgNeedsSsl() ? { rejectUnauthorized: false } : undefined,
      max: 8,
    });
  }
  await createSchema();

  // One-time migration from the legacy single-JSONB-row layout, if present and
  // the normalized tables are still empty. Never drops the old row (kept as a
  // backup); just imports it.
  const migrated = await migrateLegacyIfNeeded();
  if (migrated) {
    db = migrated;
    baseline = structuredClone(EMPTY); // write the whole document into the new tables
    await pgWrite();
    return;
  }
  db = await hydrate();
  const empty = SCHEMA.every((t) => {
    const c = db[collOf(t)];
    return Array.isArray(c) ? c.length === 0 : Object.keys(c).length === 0;
  });
  if (empty && wantSeed()) {
    seed(db);
    baseline = structuredClone(EMPTY);
    await pgWrite();
  } else {
    // Tables already match the hydrated state — no rewrite needed at boot.
    baseline = structuredClone(db);
  }
}

/** Test hook: drop the in-memory cache so the next init() re-hydrates from the
 *  tables (simulates a process restart). Not used in production. */
export function _clearCache() {
  db = null;
  baseline = null;
}

async function migrateLegacyIfNeeded() {
  const { rows: has } = await pool.query(
    "SELECT to_regclass('public.kolex_state') IS NOT NULL AS exists",
  );
  if (!has[0].exists) return null;
  // Only migrate into empty tables (don't clobber a normalized DB).
  const { rows: cnt } = await pool.query("SELECT count(*)::int AS n FROM users");
  const { rows: cnt2 } = await pool.query("SELECT count(*)::int AS n FROM campaigns");
  if (cnt[0].n > 0 || cnt2[0].n > 0) return null;
  const { rows } = await pool.query("SELECT doc FROM kolex_state WHERE id = 1");
  if (!rows.length) return null;
  console.log("[kolex] migrating legacy kolex_state document into normalized tables…");
  return { ...structuredClone(EMPTY), ...rows[0].doc };
}

/** Ordered, diff-based write-through: each save queues behind the previous one
 *  and writes only the rows that changed since the last persist. */
function pgWrite() {
  if (!db) return Promise.resolve();
  const cur = structuredClone(db); // snapshot state as of THIS save() call
  const ops = computeOps(cur, baseline);
  writeChain = writeChain
    .then(async () => {
      if (!ops.upserts.length && !ops.deletes.length && !ops.logs.length) {
        baseline = cur;
        return;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const u of ops.upserts) await client.query(...upsertSql(u));
        for (const lg of ops.logs) {
          await client.query(`DELETE FROM ${lg.table}`);
          for (const row of lg.rows) await client.query(...insertSql(lg.table, row));
        }
        for (const d of ops.deletes) {
          const t = SCHEMA.find((x) => x.name === d.table);
          await client.query(`DELETE FROM ${d.table} WHERE ${t.pk} = $1`, [d.key]);
        }
        await client.query("COMMIT");
        baseline = cur; // only advance the baseline once the write is durable
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    })
    .catch((err) => console.error(`[kolex] postgres write failed: ${err.message}`));
  return writeChain;
}

function insertSql(table, row) {
  const ph = row.cols.map((_, i) => `$${i + 1}`);
  return [`INSERT INTO ${table} (${row.cols.join(", ")}) VALUES (${ph.join(", ")})`, row.vals];
}
function upsertSql(u) {
  const { table, row, onConflict } = u;
  const ph = row.cols.map((_, i) => `$${i + 1}`);
  const pk = row.cols[0];
  let sql = `INSERT INTO ${table} (${row.cols.join(", ")}) VALUES (${ph.join(", ")})`;
  if (onConflict === "nothing") {
    sql += ` ON CONFLICT (${pk}) DO NOTHING`;
  } else {
    const set = row.cols.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(", ");
    sql += ` ON CONFLICT (${pk}) DO UPDATE SET ${set}`;
  }
  return [sql, row.vals];
}

// ─────────────────────────── Unified API ───────────────────────────

/** Initialize the store once, at server startup (must be awaited). */
export async function init() {
  if (db) return db;
  if (usePg) await pgInit();
  else fileLoad();
  return db;
}

/** Synchronous accessor used everywhere. Returns the cached document. */
export function load() {
  if (db) return db;
  if (usePg) {
    throw new Error("kolex: database not initialized — await init() before serving requests");
  }
  fileLoad(); // file backend can load lazily/synchronously (keeps tests simple)
  return db;
}

/**
 * Persist the current state. Returns a Promise that resolves once the write is
 * durable (awaited by money-critical paths; fire-and-forget elsewhere, with a
 * flush on shutdown). The file backend writes synchronously.
 */
export function save() {
  if (!db) return Promise.resolve();
  if (usePg) return pgWrite();
  fileSave();
  return Promise.resolve();
}

/** Await all pending Postgres writes (no-op for the file backend). */
export async function flush() {
  if (usePg) await writeChain;
}

export async function reset() {
  db = structuredClone(EMPTY);
  if (wantSeed()) seed(db);
  if (usePg && pool) {
    await flush();
    await pool.query(`TRUNCATE ${SCHEMA.map((t) => t.name).join(", ")} RESTART IDENTITY`);
    baseline = structuredClone(EMPTY);
    await pgWrite();
  } else {
    await save();
  }
  return db;
}

/** Close the connection pool (after flushing). */
export async function close() {
  await flush();
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Snapshot of record counts, for the startup diagnostic line. */
export function stats() {
  const d = load();
  return {
    advertisers: d.advertisers.length,
    campaigns: d.campaigns.length,
    users: d.users.length,
    devices: d.devices.length,
    earners: Object.keys(d.earnings).length,
    payouts: d.payouts.length,
  };
}

// ─── Seed inventory so the auction/leaderboard is alive on first boot ──

function tile(bg, glyph) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="${bg}"/>${glyph}</svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

const LOGOS = {
  linear: tile(
    "#5E6AD2",
    `<path d="M7 18.5 13.5 25A9 9 0 0 1 7 18.5Z M7 14.2A12.8 12.8 0 0 0 17.8 25 M7.6 10.6A16.4 16.4 0 0 0 21.4 24.4" stroke="#fff" stroke-width="2.1" fill="none" stroke-linecap="round"/>`,
  ),
  vercel: tile("#0F1216", `<path d="M16 8 25 23H7Z" fill="#fff"/>`),
  stripe: tile(
    "#635BFF",
    `<path d="M11 13.5c0-1 1-1.5 2.4-1.5 1.5 0 3 .5 4 1V9.4A9 9 0 0 0 13.4 9C10 9 7.7 10.7 7.7 13.4c0 4.2 5.8 3.5 5.8 5.3 0 .8-.7 1.1-1.9 1.1-1.6 0-3.5-.7-5-1.5v3.4a11 11 0 0 0 5 1c3.6 0 6-1.6 6-4.5 0-4.5-5.8-3.7-5.8-5.2Z" fill="#fff"/>`,
  ),
  raycast: tile(
    "#FF6363",
    `<path d="M16 8l8 8-8 8-8-8z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/>`,
  ),
  retool: tile(
    "#3D5AFE",
    `<rect x="9" y="9" width="6" height="6" rx="1" fill="#fff"/><rect x="17" y="9" width="6" height="6" rx="1" fill="#fff" opacity="0.7"/><rect x="9" y="17" width="6" height="6" rx="1" fill="#fff" opacity="0.7"/>`,
  ),
  posthog: tile(
    "#1D1F27",
    `<circle cx="13" cy="13" r="3" fill="#F9BD2B"/><circle cx="20" cy="13" r="3" fill="#fff"/><rect x="9" y="18" width="14" height="5" rx="2" fill="#1BB394"/>`,
  ),
};

function seed(d) {
  const now = Date.UTC(2026, 5, 1);
  const mk = (i, email) => {
    const id = `adv_seed_${i}`;
    d.advertisers.push({ id, email, createdAt: now });
    return id;
  };
  const campaigns = [
    { brand: "Linear", text: "The issue tracker teams actually enjoy", url: "https://linear.app", icon: LOGOS.linear, accent: "#5E6AD2", bid: 42, blocks: 800, email: "ads@linear.app" },
    { brand: "Vercel", text: "Ship your AI app to the edge in seconds", url: "https://vercel.com", icon: LOGOS.vercel, accent: "#0F1216", bid: 38, blocks: 1200, email: "growth@vercel.com" },
    { brand: "Stripe", text: "Payments infrastructure for the internet", url: "https://stripe.com", icon: LOGOS.stripe, accent: "#635BFF", bid: 31, blocks: 600, email: "ads@stripe.com" },
    { brand: "Raycast", text: "Your shortcut to everything on the Mac", url: "https://raycast.com", icon: LOGOS.raycast, accent: "#FF6363", bid: 24, blocks: 400, email: "team@raycast.com" },
    { brand: "Retool", text: "Build internal tools remarkably fast", url: "https://retool.com", icon: LOGOS.retool, accent: "#3D5AFE", bid: 18, blocks: 500, email: "ads@retool.com" },
    { brand: "PostHog", text: "The open-source product analytics suite", url: "https://posthog.com", icon: LOGOS.posthog, accent: "#1D1F27", bid: 12, blocks: 300, email: "hey@posthog.com" },
  ];
  campaigns.forEach((c, i) => {
    const advertiserId = mk(i, c.email);
    // Pretend some delivery has already happened so spend/stats look real.
    const impressions = Math.round(c.blocks * IMPRESSIONS_PER_BLOCK * (0.15 + 0.1 * (6 - i)) / 6);
    const clicks = Math.round(impressions * 0.012);
    const spendUsd = (impressions * c.bid) / IMPRESSIONS_PER_BLOCK + (clicks * c.bid * 50) / IMPRESSIONS_PER_BLOCK;
    d.campaigns.push({
      id: `cmp_seed_${i}`,
      advertiserId,
      brand: c.brand,
      text: c.text,
      url: c.url,
      iconDataUrl: c.icon,
      accent: c.accent,
      bidPerBlock: c.bid,
      blocks: c.blocks,
      impressionsRemaining: c.blocks * IMPRESSIONS_PER_BLOCK - impressions,
      impressions,
      clicks,
      spendUsd,
      status: "active",
      createdAt: now + i * 3600_000,
    });
  });
}
