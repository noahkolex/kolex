// Accounts, password auth (scrypt), and sessions.
import crypto from "node:crypto";
import { load, save } from "./db.mjs";

const token = () => crypto.randomBytes(24).toString("hex");
const id = (p) => `${p}_${crypto.randomBytes(8).toString("hex")}`;

// ── Password hashing (scrypt — no external dependency) ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, "hex");
  return test.length === expected.length && crypto.timingSafeEqual(test, expected);
}

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  if (password.length > 200) return "Password is too long.";
  return null;
}

const collection = (kind) => (kind === "advertiser" ? "advertisers" : "users");
const prefix = (kind) => (kind === "advertiser" ? "adv" : "usr");

export function findAccount(kind, email) {
  const db = load();
  return db[collection(kind)].find((x) => x.email === email) || null;
}

/**
 * Sign in or create an account in one step: if the email exists, the password
 * must match (else 401); if not, a new account is created with that password.
 * Returns { account, created } or throws { status, error }.
 */
export function authenticate(kind, email, password) {
  const db = load();
  const list = db[collection(kind)];
  let account = list.find((x) => x.email === email);
  if (account) {
    if (!verifyPassword(password, account.passwordHash)) {
      throw { status: 401, error: "Incorrect password for this email." };
    }
    return { account, created: false };
  }
  account = {
    id: id(prefix(kind)),
    email,
    passwordHash: hashPassword(password),
    createdAt: Date.now(),
  };
  list.push(account);
  save();
  return { account, created: true };
}

export function createSession(kind, account) {
  const db = load();
  const t = token();
  db.sessions[t] = { kind, id: account.id, email: account.email, createdAt: Date.now() };
  save();
  return t;
}

export function sessionFromReq(req) {
  const db = load();
  const header = req.headers.authorization || "";
  const t = header.startsWith("Bearer ") ? header.slice(7) : "";
  const s = t && db.sessions[t] ? db.sessions[t] : null;
  if (!s) return null;
  // Sessions expire after 30 days.
  if (s.createdAt && Date.now() - s.createdAt > 30 * 24 * 3600_000) {
    delete db.sessions[t];
    save();
    return null;
  }
  return s;
}

// ── Password reset (token-based, no email dependency) ──
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function accountById(kind, accountId) {
  const db = load();
  return db[collection(kind)].find((x) => x.id === accountId) || null;
}

/** Invalidate every active session for an account (used after a reset). */
function dropSessionsFor(kind, accountId) {
  const db = load();
  for (const [t, s] of Object.entries(db.sessions)) {
    if (s.kind === kind && s.id === accountId) delete db.sessions[t];
  }
}

/**
 * Begin a reset. Returns the RAW token (deliver it out of band) if the account
 * exists, else null. The token is stored hashed, so a DB leak can't be replayed.
 * Callers must respond identically whether or not an account was found, so the
 * endpoint never reveals which emails are registered.
 */
export function createPasswordReset(kind, email) {
  const account = findAccount(kind, email);
  if (!account) return null;
  const db = load();
  const raw = token();
  // One outstanding reset per account: clear any older ones first.
  for (const [h, r] of Object.entries(db.passwordResets)) {
    if (r.kind === kind && r.accountId === account.id) delete db.passwordResets[h];
  }
  db.passwordResets[sha256(raw)] = {
    kind,
    accountId: account.id,
    email: account.email,
    createdAt: Date.now(),
  };
  save();
  return { token: raw, account };
}

/**
 * Finish a reset: set the new password, consume the token (single use),
 * invalidate old sessions, and return the account. Throws { status, error }.
 */
export function consumePasswordReset(rawToken, newPassword) {
  const db = load();
  const h = sha256(rawToken);
  const record = db.passwordResets[h];
  if (!record) throw { status: 400, error: "This reset link is invalid or has already been used." };
  if (Date.now() - record.createdAt > RESET_TTL_MS) {
    delete db.passwordResets[h];
    save();
    throw { status: 400, error: "This reset link has expired. Request a new one." };
  }
  const account = accountById(record.kind, record.accountId);
  if (!account) {
    delete db.passwordResets[h];
    save();
    throw { status: 400, error: "Account no longer exists." };
  }
  account.passwordHash = hashPassword(newPassword);
  delete db.passwordResets[h];
  dropSessionsFor(record.kind, record.accountId);
  save();
  return { account, kind: record.kind };
}

/**
 * Change a signed-in account's password. Verifies the current password first.
 * Throws { status, error } on a mismatch. The caller's session stays valid.
 */
export function changePassword(kind, accountId, currentPassword, newPassword) {
  const account = accountById(kind, accountId);
  if (!account) throw { status: 404, error: "Account not found." };
  if (!verifyPassword(currentPassword, account.passwordHash)) {
    throw { status: 401, error: "Your current password is incorrect." };
  }
  account.passwordHash = hashPassword(newPassword);
  save();
  return account;
}

export function requireKind(kind) {
  return (req, res, next) => {
    const s = sessionFromReq(req);
    if (!s || s.kind !== kind) return res.status(401).json({ error: "login required" });
    req.session = s;
    next();
  };
}

export { id as newId };
