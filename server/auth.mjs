// Minimal session + account helpers. Dev-mode email login (no magic-link
// delivery yet) — the email is the identity; a token is the session.
import crypto from "node:crypto";
import { load, save } from "./db.mjs";

const token = () => crypto.randomBytes(24).toString("hex");
const id = (p) => `${p}_${crypto.randomBytes(8).toString("hex")}`;

export function findOrCreateUser(email) {
  const db = load();
  let u = db.users.find((x) => x.email === email);
  if (!u) {
    u = { id: id("usr"), email, createdAt: Date.now() };
    db.users.push(u);
    save();
  }
  return u;
}

export function findOrCreateAdvertiser(email) {
  const db = load();
  let a = db.advertisers.find((x) => x.email === email);
  if (!a) {
    a = { id: id("adv"), email, createdAt: Date.now() };
    db.advertisers.push(a);
    save();
  }
  return a;
}

export function createSession(kind, account) {
  const db = load();
  const t = token();
  db.sessions[t] = { kind, id: account.id, email: account.email };
  save();
  return t;
}

export function sessionFromReq(req) {
  const db = load();
  const header = req.headers.authorization || "";
  const t = header.startsWith("Bearer ") ? header.slice(7) : "";
  return t && db.sessions[t] ? db.sessions[t] : null;
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
