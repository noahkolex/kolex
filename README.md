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
3. A separate 250ms placement loop collapses the native loading indicator
   (`display:none`, fully restored the moment serving stops) and mounts the
   sponsored line **in its place in document flow** — a true replacement,
   not a floating toast. The indicator is found by configured selectors
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

## Backend + website

The `server/` is a single Express app (file-backed store, no native deps)
that serves both the JSON API and the static `web/` site.

```bash
npm run server         # http://localhost:4000  (seeds a live auction)
npm run server:reset   # wipe + reseed the store
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
| `POST /api/login` | public | email login (user or advertiser) |
| `GET /api/advertiser/campaigns` | advertiser | campaign stats |
| `GET /api/portal/summary` | user | earnings across linked devices |
| `POST /api/portal/link-device` | user | link an extension device to the account |
| `POST /api/portal/payout` | user | withdraw pending balance |

Settlement mirrors the extension's economics exactly: an impression bills
`bid/1000`, a click bills `50×` that, and **50% of every billed dollar** is
credited to the device that showed the ad. Point the extension at a local
server by setting its API base to `http://localhost:4000/v1` during dev.

## Develop

```bash
npm install
npm test          # typecheck the core + run the unit suite
npm run build     # typecheck + bundle into extension/
npm run package   # → kolex-extension.zip
```

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
