// Send the "Kolex is live" launch email to everyone in the database.
//
//   node scripts/send-launch-email.mjs                 # DRY RUN (default): counts + a sample, sends nothing
//   node scripts/send-launch-email.mjs --to you@x.com  # send ONE test to yourself
//   node scripts/send-launch-email.mjs --send          # actually send to everyone (throttled, idempotent)
//   flags: --resend (re-send to already-emailed), --verified-only, --limit N
//
// Safe to re-run: each recipient is marked (launchEmailedAt) and skipped next
// time. Requires a verified Resend domain + KOLEX_EMAIL_FROM on that domain,
// and DATABASE_URL (prod) — run it on Railway or locally with prod env.
import { init, load, save, flush, close } from "../server/db.mjs";
import { sendEmail, emailConfigured, launchEmail, unsubscribeUrl } from "../server/mailer.mjs";
import { config } from "../server/config.mjs";

const STORE_URL = "https://chromewebstore.google.com/detail/Kolex%20%E2%80%94%20get%20paid%20for%20waiting/kgkdlcbcgcncnchcmdjhhpdphofdcfki";
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const SEND = has("--send");
const RESEND = has("--resend");
const VERIFIED_ONLY = has("--verified-only");
const LIMIT = val("--limit") ? Number(val("--limit")) : Infinity;
const ONE = val("--to");
const base = (config.siteBase || "https://kolex.ai").replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || "");

await init();
const db = load();

// One-off test send to a single address (doesn't touch the DB).
if (ONE) {
  if (!emailConfigured()) { console.error("✗ No email provider configured (set RESEND_API_KEY + KOLEX_EMAIL_FROM)."); process.exit(1); }
  const msg = launchEmail({ storeUrl: STORE_URL, unsubUrl: unsubscribeUrl(base, ONE), bonusUsd: config.signupBonusUsd });
  await sendEmail({ to: ONE, ...msg, headers: unsubHeaders(unsubscribeUrl(base, ONE)) });
  console.log(`✓ Sent a test launch email to ${ONE} (from "${config.email.from}").`);
  await close(); process.exit(0);
}

// Build the recipient list: unique, valid, not unsubscribed, not already emailed.
const seen = new Set();
let skippedUnsub = 0, skippedDone = 0, skippedBad = 0, skippedUnverified = 0;
const recipients = [];
for (const u of db.users) {
  const email = String(u.email || "").toLowerCase().trim();
  if (!validEmail(email)) { skippedBad++; continue; }
  if (seen.has(email)) continue;
  seen.add(email);
  if (u.unsubscribed) { skippedUnsub++; continue; }
  if (VERIFIED_ONLY && !u.emailVerified) { skippedUnverified++; continue; }
  if (u.launchEmailedAt && !RESEND) { skippedDone++; continue; }
  recipients.push(u);
}
const targets = recipients.slice(0, LIMIT);

console.log(`\nLaunch email — ${SEND ? "SEND" : "DRY RUN"}`);
console.log(`  from:        ${config.email.from}${emailConfigured() ? "" : "  ⚠️ NO PROVIDER (won't deliver)"}`);
console.log(`  base url:    ${base}`);
console.log(`  total users: ${db.users.length}`);
console.log(`  recipients:  ${targets.length}${targets.length < recipients.length ? ` (capped from ${recipients.length} by --limit)` : ""}`);
console.log(`  skipped:     ${skippedDone} already-emailed, ${skippedUnsub} unsubscribed, ${skippedUnverified} unverified, ${skippedBad} invalid`);

function unsubHeaders(url) {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

if (!SEND) {
  const sample = launchEmail({ storeUrl: STORE_URL, unsubUrl: unsubscribeUrl(base, "sample@example.com"), bonusUsd: config.signupBonusUsd });
  const fs = await import("node:fs");
  fs.writeFileSync("launch-email-sample.html", sample.html);
  console.log(`\n  subject:     "${sample.subject}"`);
  console.log(`  sample HTML: ./launch-email-sample.html (open it to preview)`);
  console.log(`  first few:   ${targets.slice(0, 8).map((u) => u.email).join(", ") || "(none)"}`);
  console.log(`\nDry run only — nothing sent. Re-run with --send to actually send.\n`);
  await close(); process.exit(0);
}

if (!emailConfigured()) { console.error("\n✗ Refusing to --send: no email provider configured. Set RESEND_API_KEY + a verified KOLEX_EMAIL_FROM.\n"); await close(); process.exit(1); }

let sent = 0, failed = 0;
for (const u of targets) {
  const url = unsubscribeUrl(base, u.email);
  const msg = launchEmail({ storeUrl: STORE_URL, unsubUrl: url, bonusUsd: config.signupBonusUsd });
  try {
    await sendEmail({ to: u.email, ...msg, headers: unsubHeaders(url) });
    u.launchEmailedAt = Date.now();
    sent++;
    if (sent % 25 === 0) { await save(); console.log(`  …${sent}/${targets.length} sent`); }
  } catch (err) {
    failed++;
    console.error(`  ✗ ${u.email}: ${err.message}`);
  }
  await sleep(160); // ~6/sec — stays under Resend's rate limit
}
await save();
await flush();
console.log(`\n✅ Done: ${sent} sent, ${failed} failed. Re-running will skip the ${sent} already emailed.\n`);
await close();
