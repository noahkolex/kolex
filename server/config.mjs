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
// present, or when STRIPE_MODE=stub is forced. A real sk_/rk_ key → live.
const forced = (process.env.STRIPE_MODE || "auto").trim().toLowerCase();
const hasRealKey = /^(sk|rk)_(test|live)_/.test(secretKey);
const stripeMode = forced === "stub" ? "stub" : forced === "live" ? "live" : hasRealKey ? "live" : "stub";
const isProd = (process.env.NODE_ENV || "").trim().toLowerCase() === "production";

// On Railway, the public domain is exposed as RAILWAY_PUBLIC_DOMAIN — use it
// so Stripe redirect/webhook URLs are correct without any manual config.
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
const inferredBase =
  process.env.SITE_BASE || process.env.PUBLIC_URL || (railwayDomain ? `https://${railwayDomain}` : "");

export const config = {
  port: Number(process.env.PORT) || 4000,
  isProd,
  // Public base URL of this server (used for Stripe redirect URLs + webhooks).
  siteBase: inferredBase.replace(/\/$/, ""),

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

  // Transactional email (password resets). With a Resend API key, resets are
  // actually emailed; without one, the link is logged + (in dev) returned in
  // the API response so the flow is still testable.
  email: {
    provider: (process.env.KOLEX_EMAIL_PROVIDER || (process.env.RESEND_API_KEY ? "resend" : "none"))
      .trim()
      .toLowerCase(),
    resendApiKey: process.env.RESEND_API_KEY?.trim() || "",
    from: process.env.KOLEX_EMAIL_FROM?.trim() || "Kolex <onboarding@resend.dev>",
  },
};

/** Resolve the public base URL, falling back to the request's own origin. */
export function publicBase(req) {
  if (config.siteBase) return config.siteBase;
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
}
