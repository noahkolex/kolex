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

export function requireKind(kind) {
  return (req, res, next) => {
    const s = sessionFromReq(req);
    if (!s || s.kind !== kind) return res.status(401).json({ error: "login required" });
    req.session = s;
    next();
  };
}

export { id as newId };
