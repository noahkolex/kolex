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
// Always normalize to an absolute URL with a scheme — Stripe rejects
// account-link / redirect URLs that lack one (e.g. a bare "kolex.ai").
const withScheme = (u) => (!u ? "" : /^https?:\/\//i.test(u) ? u : `https://${u}`);
const inferredBase = withScheme(
  process.env.SITE_BASE || process.env.PUBLIC_URL || (railwayDomain ? `https://${railwayDomain}` : ""),
);

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

  // ── Abuse / incident controls (all env-toggled, sane defaults) ──
  antiabuse: {
    // Stop crediting (and billing) CLICKS — the 50× vector. KOLEX_DISABLE_CLICKS=1.
    disableClicks: bool(process.env.KOLEX_DISABLE_CLICKS, false),
    // Max a single device can earn per rolling hour (USD). 0 disables the cap.
    hourlyCapUsd: process.env.KOLEX_HOURLY_CAP_USD === undefined ? 5 : Number(process.env.KOLEX_HOURLY_CAP_USD),
    // Max a single device can earn per rolling 24h (USD). 0 disables it.
    dailyCapUsd: process.env.KOLEX_DAILY_CAP_USD === undefined ? 1 : Number(process.env.KOLEX_DAILY_CAP_USD),
    // Max impressions credited to one device per rolling 24h (frequency cap, so a
    // single user can't drain a campaign even at a tiny bid). 0 disables it.
    maxImpressionsPerDay: process.env.KOLEX_MAX_IMPRESSIONS_PER_DAY === undefined ? 500 : Number(process.env.KOLEX_MAX_IMPRESSIONS_PER_DAY),
    // Physically a device can earn ~12 impressions/min (one per 5s); anything
    // well above that is fabricated. Over this/minute → drop + flag → auto-ban.
    maxImpressionsPerMin: Number(process.env.KOLEX_MAX_IMPRESSIONS_PER_MIN) || 20,
    autoBanFlags: Number(process.env.KOLEX_AUTOBAN_FLAGS) || 3,
    // Max events accepted in a single /v1/events POST (a legit client sends ≤100).
    maxEventsPerBatch: Number(process.env.KOLEX_MAX_EVENTS_PER_BATCH) || 200,
    // Bearer token for the /api/admin/* moderation endpoints.
    adminToken: process.env.KOLEX_ADMIN_TOKEN?.trim() || "",
  },
  // Global payout kill-switch — set KOLEX_PAYOUTS_HALTED=1 to pause all cash-outs
  // (balances are kept; turn it back off to resume).
  payoutsHalted: bool(process.env.KOLEX_PAYOUTS_HALTED, false),
  // Only credit (and bill) events from devices linked to an account. The device
  // id is an unauthenticated client header (x-kolex-device), so paying unlinked
  // devices lets an abuser farm unlimited anonymous buckets and link them later
  // to absorb the pile. Default ON. Set KOLEX_REQUIRE_LINKED_TO_EARN=0 to allow
  // pre-signup "try it and earn" accrual (the old behavior).
  requireLinkedToEarn: bool(process.env.KOLEX_REQUIRE_LINKED_TO_EARN, true),
  // Pre-launch mode: drives the "we launch soon" portal messaging. Now that the
  // extension is live on the Chrome Web Store this defaults OFF; set
  // KOLEX_PRELAUNCH=1 to bring the pre-launch banner back. (It no longer gates
  // the welcome bonus — that's its own first-come cap.)
  prelaunch: bool(process.env.KOLEX_PRELAUNCH, false),
  // Early-access welcome bonus credited once when a NEW earner account signs up
  // during pre-launch. It's LOCKED (shown separately, never withdrawable on its
  // own) so mass-signup fraud can't cash it out. 0 disables it.
  signupBonusUsd: process.env.KOLEX_SIGNUP_BONUS_USD === undefined ? 5 : Number(process.env.KOLEX_SIGNUP_BONUS_USD),
  // Only the first N earner accounts get the welcome bonus. After that, signups
  // still work — they just don't receive the $5.
  signupBonusLimit:
    process.env.KOLEX_SIGNUP_BONUS_LIMIT === undefined ? 500 : Number(process.env.KOLEX_SIGNUP_BONUS_LIMIT),
  // Scarcity: the "spots left" number SHOWN on the site (decreases as real
  // accounts claim). Display-only — the real signupBonusLimit still governs who
  // actually gets the $5. Set to "off"/0 to just show the real remaining count.
  signupBonusShownLeft: (() => {
    const v = process.env.KOLEX_SIGNUP_BONUS_SHOWN_LEFT;
    if (v === undefined) return 49;
    return /^(off|false|0)$/i.test(v.trim()) ? null : Number(v);
  })(),
  // Social-proof waitlist headcount shown on the site (we display it as "N+").
  // Bump/replace with the real number at launch via KOLEX_WAITLIST_COUNT.
  waitlistCount:
    process.env.KOLEX_WAITLIST_COUNT === undefined ? 100 : Number(process.env.KOLEX_WAITLIST_COUNT),
  // The welcome bonus only UNLOCKS (becomes withdrawable) after the earner has
  // verified their email, installed the extension, AND accumulated this many
  // minutes of AI waiting time. Stops drive-by signups from cashing the $5
  // without real engagement.
  bonusUnlockMinutes:
    process.env.KOLEX_BONUS_UNLOCK_MINUTES === undefined ? 5 : Number(process.env.KOLEX_BONUS_UNLOCK_MINUTES),
  // New accounts can't cash out until this many days after signup — a standard
  // holding period (also matches Stripe's ~2-day settlement and deters drive-by
  // fraud). 0 disables it.
  payoutMaturationDays:
    process.env.KOLEX_PAYOUT_MATURATION_DAYS === undefined ? 2 : Number(process.env.KOLEX_PAYOUT_MATURATION_DAYS),

  // PostHog analytics (optional). The project API key (phc_…) is safe to expose
  // to the browser/extension, so the same key powers server + client capture.
  posthog: {
    key: process.env.POSTHOG_KEY?.trim() || "",
    host: (process.env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com").replace(/\/$/, ""),
  },

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

/** Resolve the public base URL (absolute, with scheme), falling back to the
 *  request's own origin. Returns "" only if it truly can't be determined. */
export function publicBase(req) {
  if (config.siteBase) return config.siteBase;
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString().split(",")[0];
  const host = req.get("host");
  return host ? `${proto}://${host}` : "";
}
