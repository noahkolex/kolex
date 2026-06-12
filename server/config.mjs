// Central server configuration, all from environment variables so the user
// can supply everything (Stripe keys, URLs, currency) via a .env file.
import { loadEnv } from "./env.mjs";

loadEnv();

function bool(v, dflt = false) {
  if (v === undefined) return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

const secretKey = process.env.STRIPE_SECRET_KEY?.trim() || "";
// Stub mode runs the full payment flow locally with NO real Stripe calls, so
// everything is testable without keys. It activates when no real secret key is
// present, or when STRIPE_MODE=stub is forced. A real `sk_...` key → live.
const forced = (process.env.STRIPE_MODE || "auto").trim().toLowerCase();
const hasRealKey = /^sk_(test|live)_/.test(secretKey);
const stripeMode = forced === "stub" ? "stub" : forced === "live" ? "live" : hasRealKey ? "live" : "stub";

export const config = {
  port: Number(process.env.PORT) || 4000,
  // Public base URL of this server (used for Stripe redirect URLs + webhooks).
  siteBase: (process.env.SITE_BASE || process.env.PUBLIC_URL || "").replace(/\/$/, ""),

  stripe: {
    mode: stripeMode, // "live" | "stub"
    secretKey,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY?.trim() || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || "",
    currency: (process.env.STRIPE_CURRENCY || "usd").trim().toLowerCase(),
    enablePayouts: bool(process.env.STRIPE_ENABLE_PAYOUTS, false),
    apiVersion: process.env.STRIPE_API_VERSION?.trim() || undefined,
  },

  // Minimum payout the user must accrue before cashing out (USD).
  minPayoutUsd: Number(process.env.KOLEX_MIN_PAYOUT_USD) || 10,
};

/** Resolve the public base URL, falling back to the request's own origin. */
export function publicBase(req) {
  if (config.siteBase) return config.siteBase;
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
}
