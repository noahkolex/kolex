# Kolex — get paid for waiting

**kolex.ai** replaces the most-stared-at pixels on the internet — the loading
indicators on **ChatGPT** and **Claude** — with one sponsored status line.
While the model thinks, the spinner becomes an ad. **50% of the ad revenue
goes to you.**

[Kickbacks.ai](https://kickbacks.ai) proved the model for developers inside
Claude Code and Codex. Kolex is the same market, two orders of magnitude
wider: the hundreds of millions of non-engineers who watch a shimmer for
10–60 seconds every time they ask a chatbot anything. No IDE, no terminal —
a Chrome extension.

```
   Assistant
   ┌──────────────────────────────────────────────────────────────────┐
   │ ⬩ AD · Ramp — Close your books 8x faster ↗ │ $0.0042 earned      │
   └──────────────────────────────────────────────────────────────────┘
   (rendered in place of "Thinking…" — restored the instant text streams)
```

Branding follows the [Sefra](https://meetsefra.com/) design language: cool
bone `#F4F4F1`, ink `#0F1216`, cobalt accent `#1547F5`, hairline rules,
Geist + Geist Mono, square 4px corners, and the Sefra bird mark.

## How it works

1. A content script watches chatgpt.com / claude.ai for a **wait state**
   (model streaming or thinking), using a remotely updatable selector set.
2. While a wait state is on screen **and the tab is visible**, it pings the
   service worker once a second. Five contiguous seconds = one impression.
3. A separate 250ms placement loop hides the native loading indicator and
   shows the sponsored line where it was. A wait state can render several
   animated nodes next to each other (a starburst plus an empty
   streaming-text placeholder), so it hides the **whole cluster** of live
   indicators near the newest one (`visibility:hidden`, box and layout
   preserved, fully restored when serving stops) and anchors the line to the
   cluster's left edge. The position is **captured once** (so the line stays
   put instead of crawling as text streams) and is **always clamped a clear
   gap above the composer**, so it can never cover the input box or any text
   being typed. The cluster is found by configured selectors
   first, then by a **selector-free animation heuristic** that catches it
   regardless of markup: CSS/Web-Animation targets, **SVG SMIL spinners**
   (`<animateTransform>`, which `getAnimations()` can't see — this is the
   bare rotating starburst on claude.ai), and infinite-CSS small elements
   in `<main>`. Composer carets, toolbar icons, and shimmering text are
   filtered out. Only if nothing is found does a bottom-center fallback
   serve.
4. The service worker runs the auction locally: the highest live bid serves
   first, ties round-robin, exhausted blocks fall out, and $0 house ads
   backfill when no paid inventory is queued. Clicks route through the
   kolex.ai redirect so the backend can settle them.
5. Impressions and clicks land in a local idempotent ledger and sync in
   batches whenever the backend is reachable. Offline never loses an event.

## The market

- Advertisers buy **blocks of 1,000 five-second impressions**, bidding any
  amount from $1. Highest bid serves first — outbid the top to take #1, or
  queue behind it.
- **Clicks bill at 50× the impression rate.**
- **50% of every settled dollar** goes to the person whose screen showed the
  ad. Balance and payouts live at kolex.ai; the extension popup shows a
  live estimate.

## Brand takeover

An ad is more than a line of text — the whole loading indicator wears the
advertiser's brand. Each creative carries:

- `text` — 3–60 chars of copy
- `iconDataUrl` — the brand logo, delivered inline as a `data:image/*` URL
  (≤64KB, like kickbacks). It replaces the default Sefra bird mark.
- `accent` — a `#rrggbb` brand color that tints the pulsing dot, the `AD`
  tag, the arrow, and the hover border.

So while a Linear-sponsored block is serving, the spinner becomes the Linear
logo in Linear's indigo; a Ramp block, Ramp's mark and color. Icons arrive
as data URLs (not external `<img src>`) so the extension still makes **zero
requests that could reveal what you're browsing**, and page CSP can't block
the creative. Unsold time falls back to house ads, which use the Sefra mark.

## Privacy, by construction

- The content script queries a handful of CSS selectors to know "is the
  model working?" — it **never reads prompts, conversations, or files**.
- Telemetry is an anonymous device id plus impression/click counts. Nothing
  else leaves the machine.
- No site code is patched. The page's spinner element is collapsed with an
  inline style while an ad serves and restored exactly afterward.
- Consent-gated: the extension serves nothing until you opt in from the
  popup, and one toggle turns it off instantly. A server-side killswitch can
  halt all serving remotely (bad creative, billing incident).

Supported surfaces: **ChatGPT** (chatgpt.com, chat.openai.com), **Claude**
(claude.ai), **Gemini** (gemini.google.com), and **Grok** (grok.com,
x.com/i/grok). Each has its own detection config; the animation heuristic
covers the rest.

## Repo layout

```
extension/          MV3 extension (manifest, popup, built bundles, icons)
src/shared/         Chrome-free core: economics, auction, rotation, ledger,
                    wait-state detection — fully unit-tested in Node
src/background/     Service worker: settings, remote config, event sync
src/content/        Wait-state watcher + pin-to-rect ad placement (shadow DOM)
src/popup/          Consent gate + live earnings dashboard + Cash out CTA
server/             Express backend: auction, settlement, accounts, API
web/                Website: landing, advertise, advertiser portal, earner portal
demo/               Local harness that fakes a chat UI for visual testing
scripts/            esbuild bundling + zero-dependency PNG icon generator
test/               node:test suite (core logic + jsdom DOM-glue tests)
```

## Backend + website + payments

The `server/` is a single Express app (file-backed store, no native deps)
that serves the JSON API, the static `web/` site, and Stripe payments.

```bash
cp .env.example .env    # then fill in (everything is optional)
npm run server          # http://localhost:4000  (blank — real data only)
KOLEX_SEED=1 npm run server   # populate demo campaigns for a showcase
```

The DB starts **blank** — no fake campaigns, no fabricated activity. The
landing's totals/feed are real (empty until people actually earn), and when
there are no paid ads the extension spinner shows **Kolex's own** house ad.

### Deploy to Railway (one click)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

It's a single Node service — no database to provision. Either:

1. **From GitHub:** push this repo, then on [railway.app](https://railway.app)
   → New Project → Deploy from GitHub repo. Railway auto-detects Node, runs
   `node server/index.mjs` (see `railway.json`), and health-checks `/healthz`.
2. **From the CLI:** `npm i -g @railway/cli && railway init && railway up`.

Railway sets `PORT` and `RAILWAY_PUBLIC_DOMAIN` automatically — the server
uses both, so it just works. With **no env vars** it runs in Stripe **stub**
mode (a working demo). To take real money, add in the Railway dashboard:
`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` (and
point a Stripe webhook at `https://<your-app>.up.railway.app/webhooks/stripe`).
Data is file-backed and ephemeral on redeploy; mount a Railway volume and set
`KOLEX_DB=/data/db.json` to persist it.

After deploying, rebuild the extension pointed at your URL:
`KOLEX_API_BASE=https://<your-app>.up.railway.app/v1 KOLEX_SITE_BASE=https://<your-app>.up.railway.app npm run build`.

### Configuration (all via `.env` — see `.env.example`)

Every knob is an environment variable. With **no Stripe keys** the server
runs in **stub mode**: the entire payment flow works locally (a mock checkout
page stands in for Stripe), so you can test end to end immediately. Add real
keys to go live:

| Var | Purpose |
|-----|---------|
| `PORT`, `SITE_BASE` | server port; public base URL for Stripe redirects/webhooks |
| `STRIPE_SECRET_KEY` | `sk_test_…`/`sk_live_…` (or `rk_…`). Present → **live** mode |
| `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | from the Stripe dashboard / `stripe listen` |
| `STRIPE_CURRENCY`, `STRIPE_MODE` | `usd…`; `auto`/`stub`/`live` |
| `STRIPE_ENABLE_PAYOUTS` | real user payouts (needs Stripe Connect) |
| `KOLEX_MIN_PAYOUT_USD` | minimum balance before cash-out |
| `RESEND_API_KEY`, `KOLEX_EMAIL_FROM` | send password-reset emails (Resend). Without a key, the link is logged + returned in dev |
| `KOLEX_RATE_LIMIT` | force the per-IP limiter on/off (on by default in prod) |
| `KOLEX_API_BASE`, `KOLEX_SITE_BASE` | **extension** build targets (see below) |

### Payment flow

Advertiser submits an ad → server creates a **pending** campaign + a Stripe
Checkout Session and returns its URL → browser pays on Stripe (or the mock
checkout in stub mode) → `checkout.session.completed` webhook (signature
verified; amount + paid-status checked) flips the campaign to **active** so
it serves. Earnings settle as the extension posts impression/click events,
**capped at each campaign's paid budget**, and users cash out (minimum
enforced; real payouts via Connect when configured).

### Payout flow (and how to test it)

Earners are paid via **Stripe Connect (Express)**. An earner links their
browser to their account, completes one-time Connect onboarding (a connected
account that can receive transfers), then withdraws — which moves their share
from the platform balance to their connected account via a Stripe **Transfer**.
Withdrawals are blocked until a payout account is connected, locked per-user so
a balance can't be paid twice, and only credited as `paid` once the transfer
settles (otherwise recorded as `queued`).

**Test it in one command** (stub mode, no Stripe keys):

```bash
npm run test:payout
```

It drives the whole journey over the real API and prints each step: earn →
link device → withdraw-is-blocked → connect → withdraw → balance moves to paid.

**Test it by hand in the browser** (stub mode):

```bash
STRIPE_MODE=stub npm start                 # no keys needed
# give a device a balance so you don't have to wait for real impressions:
curl -X POST localhost:4000/api/stub/seed-earnings \
  -H 'content-type: application/json' -d '{"deviceId":"my-test-device","amountUsd":25}'
# then open the portal pre-linked to that device:
open 'http://localhost:4000/portal?device=my-test-device&connect=1'
```

Sign in (any email + an 8+ char password creates the account), click **Set up
payouts** (the mock onboarding completes instantly), then **Withdraw**.

**Live test mode** (real Stripe): set a `sk_test_…` key and
`STRIPE_ENABLE_PAYOUTS=1`. Two prerequisites on the Stripe side: enable
**Connect** in the dashboard (otherwise `Set up payouts` returns *"You can only
create new accounts if you've signed up for Connect"*), and keep some test
balance available for transfers. Onboarding uses Stripe's test data; the
connected account is stored on the user and used as the transfer destination.

### Connecting the extension to a backend

The extension's endpoints are injected at build time and overridable at
runtime:

```bash
# Build pointed at a local server:
KOLEX_API_BASE=http://localhost:4000/v1 KOLEX_SITE_BASE=http://localhost:4000 npm run build
# …or leave the production default and set a chrome.storage `override` at runtime.
```

### Tests

```bash
npm test            # 38 extension-core unit tests (jsdom)
npm run test:server # 52 payment-flow + auth/reset + adversarial + rate-limit tests
npm run test:web    # browser drives advertise → pay → live, and earn → connect → cash out
npm run test:browser# 8 real-Chromium spinner-replacement fixtures
npm run test:ext    # REAL extension in Chrome (xvfb) talks to a live server
npm run test:payout # end-to-end payout walkthrough (prints each step)
npm run test:all    # everything
```

Pages (Sefra-branded, vanilla JS, no build step):

- **`/` landing** — hero, 3-step install, and the **live auction
  leaderboard** showing each brand, its bid per 1,000 impressions, spend,
  and status (what they're paying).
- **`/advertise`** — kickbacks-style quick submit: brand, copy, URL, logo
  upload (→ data URL), accent color, bid, blocks, with a **live preview of
  the exact ad line** and a real-time "you'd rank #N" against the auction.
  Submitting drops you straight into your portal.
- **`/advertiser`** — campaign dashboard: spend, impressions, clicks, status
  per campaign. Email login.
- **`/portal`** — earner portal. The extension's **Cash out →** button opens
  `/portal?device=<id>&connect=1`, which forces a login and **auto-links the
  browser** to the account, then shows the live balance and a withdraw
  button.

API surface:

| Route | Who | Purpose |
|-------|-----|---------|
| `GET /v1/config` | extension | current auction winners as ads (+ remote selectors, killswitch) |
| `POST /v1/events` | extension | ingest impressions/clicks; idempotent on event id; settles money |
| `GET /v1/balance` | extension | device's pending/settled earnings |
| `GET /r/:adId?d=device` | browser | record click, 302 to advertiser |
| `GET /api/auction` | public | leaderboard + stats for the landing page |
| `POST /api/ads` | public | quick ad submission (creates advertiser, enters auction) |
| `POST /api/auth` | public | email + password sign-in/create (user or advertiser) |
| `POST /api/auth/forgot` · `/reset` | public | request a reset link · set a new password |
| `GET /api/advertiser/campaigns` | advertiser | campaign stats |
| `GET /api/portal/summary` | user | earnings + payout readiness across linked devices |
| `POST /api/portal/link-device` | user | link an extension device to the account |
| `POST /api/portal/connect` | user | start Stripe Connect onboarding (enables payouts) |
| `POST /api/portal/payout` | user | withdraw pending balance to the connected account |

Settlement mirrors the extension's economics exactly: an impression bills
`bid/1000`, a click bills `50×` that, and **50% of every billed dollar** is
credited to the device that showed the ad. Point the extension at a local
server by setting its API base to `http://localhost:4000/v1` during dev.

## Develop

```bash
npm install
npm test           # typecheck the core + run the unit suite
npm run build      # typecheck + bundle into extension/
npm run test:browser   # real headless Chromium test (see below)
npm run package    # → kolex-extension.zip
```

### Real-browser test

`npm run test:browser` runs the **built** `extension/content.js` against
fixture pages in headless Chromium (Playwright) and asserts the on-screen
result, then screenshots each to `/tmp/claude/kolex-*.png`:

- `test/fixtures/claude.html` — the claude.ai case: a SMIL starburst *and* an
  empty streaming-text placeholder side by side (the cluster). Asserts both
  native spinners end up hidden and the ad replaces them.
- `test/fixtures/chatgpt.html` — the indicator placed low, right above the
  composer. Asserts the ad never overlaps the input and keeps clearance.

Both fixtures assert: the ad mounts and is visible, shows the brand logo, no
native spinner is left visible, the ad box does not intersect the input box,
and the position is stable across time (no crawl). First run needs the
browser: `npx playwright install --with-deps chromium`.

Load it: `chrome://extensions` → Developer mode → **Load unpacked** → select
the `extension/` directory. Open ChatGPT or Claude, ask something slow, and
watch the wait state start paying rent.

To poke at the placement without an account, open `demo/harness.html` in any
browser — it fakes a chat UI, stubs the extension APIs, and toggles a wait
state every few seconds so you can watch the spinner get replaced inline.

## Architecture notes

- **Selectors are config, not code.** ChatGPT and Claude ship UI changes
  weekly; busy/spinner selectors come from `/v1/config` and fall back to
  bundled defaults. A breakage is a config push, not a release.
- **Two loops on purpose.** Accounting (1s) talks to the worker and is the
  source of truth for impressions; placement (250ms) only moves DOM, so the
  swap is instant even as the site re-renders mid-stream.
- **The economics are pure functions** (`src/shared/economics.ts`), the
  rotation engine takes an injected clock and storage, and detection takes
  an injected DOM query — which is why the interesting logic has tests and
  the chrome glue is thin.
- **Backend optional.** Every network call has a short timeout and a cached
  or bundled fallback. The extension is fully functional offline; it just
  serves house inventory and queues events.

## Status

Client is real; the auction backend (`api.kolex.ai`) is stubbed — the
extension degrades to house ads until it ships. MIT licensed.
