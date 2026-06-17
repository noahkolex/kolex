import { ChromeKV } from "../shared/kv.js";
import { Rotation } from "../shared/rotation.js";
import { SIGN_IN_AD } from "../shared/inventory.js";
import { sanitizeSites, DEFAULT_SITES } from "../shared/detect.js";
import type {
  KolexRequest,
  StatusResponse,
  TickResponse,
} from "../shared/messages.js";

// Injected at build time from KOLEX_API_BASE / KOLEX_SITE_BASE (see build.mjs).
declare const __KOLEX_API_BASE__: string;
declare const __KOLEX_SITE_BASE__: string;
declare const __KOLEX_DEMO__: boolean;
const BUILD_API_BASE = __KOLEX_API_BASE__;
const BUILD_SITE_BASE = __KOLEX_SITE_BASE__;
/** Demo build: baked-in fake ads + earnings, no backend (for screen recordings). */
const DEMO = __KOLEX_DEMO__;

const kv = new ChromeKV(chrome.storage.local);
const rotation = new Rotation(kv);

// ─────────────────────────── Demo mode ───────────────────────────
const demoTile = (bg: string, glyph: string): string =>
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${bg}"/>${glyph}</svg>`,
  );
const DEMO_ADS = [
  { id: "demo-linear", brand: "Linear", text: "The issue tracker teams actually enjoy", url: "https://linear.app", bidPerBlock: 42, impressionsRemaining: 1e9, house: false, accent: "#5E6AD2", iconDataUrl: demoTile("#5E6AD2", '<path d="M7 18.5 13.5 25A9 9 0 0 1 7 18.5Z M7 14.2A12.8 12.8 0 0 0 17.8 25 M7.6 10.6A16.4 16.4 0 0 0 21.4 24.4" stroke="#fff" stroke-width="2.1" fill="none" stroke-linecap="round"/>') },
  { id: "demo-vercel", brand: "Vercel", text: "Ship your AI app to the edge in seconds", url: "https://vercel.com", bidPerBlock: 38, impressionsRemaining: 1e9, house: false, accent: "#0F1216", iconDataUrl: demoTile("#0F1216", '<path d="M16 8 25 23H7Z" fill="#fff"/>') },
  { id: "demo-stripe", brand: "Stripe", text: "Payments infrastructure for the internet", url: "https://stripe.com", bidPerBlock: 31, impressionsRemaining: 1e9, house: false, accent: "#635BFF", iconDataUrl: demoTile("#635BFF", '<path d="M11 13.5c0-1 1-1.5 2.4-1.5 1.5 0 3 .5 4 1V9.4A9 9 0 0 0 13.4 9C10 9 7.7 10.7 7.7 13.4c0 4.2 5.8 3.5 5.8 5.3 0 .8-.7 1.1-1.9 1.1-1.6 0-3.5-.7-5-1.5v3.4a11 11 0 0 0 5 1c3.6 0 6-1.6 6-4.5 0-4.5-5.8-3.7-5.8-5.2Z" fill="#fff"/>') },
  { id: "demo-raycast", brand: "Raycast", text: "Your shortcut to everything on the Mac", url: "https://raycast.com", bidPerBlock: 24, impressionsRemaining: 1e9, house: false, accent: "#FF6363", iconDataUrl: demoTile("#FF6363", '<path d="M16 8l8 8-8 8-8-8z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/>') },
];
const DEMO_START_USD = 12.84;
async function demoBalanceUsd(): Promise<number> {
  const sum = await rotation.summary();
  return DEMO_START_USD + sum.estEarnedUsd;
}
if (DEMO) void rotation.setAds(DEMO_ADS); // load demo inventory on every worker start

/**
 * Resolve the backend endpoints. A storage `override` (set by tooling/dev)
 * wins over the build-time default, so the same build can be pointed at a
 * local server without rebuilding.
 */
async function bases(): Promise<{ api: string; site: string }> {
  const o = await kv.get<{ apiBase?: string; siteBase?: string }>("override", {});
  return { api: o.apiBase || BUILD_API_BASE, site: o.siteBase || BUILD_SITE_BASE };
}

interface Settings {
  deviceId: string;
  consent: boolean;
  enabled: boolean;
  killswitch: boolean;
}

async function settings(): Promise<Settings> {
  let s = await kv.get<Settings | null>("settings", null);
  if (!s) {
    // Demo builds auto-consent so it "just works" the moment you load it.
    s = { deviceId: crypto.randomUUID(), consent: DEMO, enabled: true, killswitch: false };
    await kv.set("settings", s);
  }
  return s;
}

async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const merged = { ...(await settings()), ...patch };
  await kv.set("settings", merged);
  return merged;
}

/** Short-timeout fetch — an unreachable ad server must never block the UI. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const s = await settings();
  const { api: apiBase } = await bases();
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-kolex-device": s.deviceId,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(4_000),
  });
  if (!res.ok) throw new Error(`kolex api ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

type LinkState = { linked: boolean; email: string | null };

/** Ask the backend whether this device has been linked to an account yet. */
async function refreshLinkStatus(): Promise<LinkState> {
  try {
    const r = await api<LinkState>("/link-status");
    const link: LinkState = { linked: !!r.linked, email: r.email ?? null };
    await kv.set("link", link);
    return link;
  } catch {
    return kv.get<LinkState>("link", { linked: false, email: null });
  }
}

// While the sign-in prompt is showing, re-check link status at most every 30s
// so the spinner flips to real ads shortly after the user connects (without
// hammering the endpoint on every 1s tick).
let lastLinkRefreshTs = 0;
async function throttledLinkRefresh(): Promise<void> {
  const now = Date.now();
  if (now - lastLinkRefreshTs < 30_000) return;
  lastLinkRefreshTs = now;
  await refreshLinkStatus();
}

type ServerBalance = { pendingUsd: number; settledUsd: number; minPayoutUsd: number };

/**
 * The device's SERVER-settled balance — the source of truth the cash-out
 * portal uses. Shown in the popup instead of the local estimate so the two
 * never disagree (the local tally can drift from budget caps, un-synced
 * events, or reinstalls).
 */
async function fetchServerBalance(): Promise<ServerBalance | null> {
  try {
    const r = await api<Partial<ServerBalance>>("/balance");
    return {
      pendingUsd: Number(r.pendingUsd) || 0,
      settledUsd: Number(r.settledUsd) || 0,
      minPayoutUsd: Number(r.minPayoutUsd) || 0,
    };
  } catch {
    return null;
  }
}

/** Pull auction winners, remote selector config, and the killswitch. */
async function refreshRemoteConfig(): Promise<void> {
  if (DEMO) {
    // No backend: serve the baked-in demo ads and default site selectors.
    await rotation.setAds(DEMO_ADS);
    await kv.set("sites", DEFAULT_SITES);
    return;
  }
  try {
    const remote = await api<{ ads?: unknown; sites?: unknown; killswitch?: boolean }>("/config");
    await rotation.setAds(remote.ads ?? []);
    const sites = sanitizeSites(remote.sites);
    await kv.set("sites", sites.length > 0 ? sites : DEFAULT_SITES);
    await saveSettings({ killswitch: !!remote.killswitch });
  } catch {
    // Offline or backend down: keep cached config, house ads backfill.
  }
}

type Balance = { pendingUsd: number; settledUsd: number; minPayoutUsd: number };

/**
 * Upload unsynced ledger events and return the device's server-settled balance
 * (the single source of truth shown everywhere). Idempotent on event id. When
 * there's nothing to flush, returns the last cached balance so reads are cheap
 * and never block on the network.
 */
async function flushLedger(): Promise<Balance | null> {
  const pending = await rotation.unsyncedEvents();
  if (pending.length === 0) return kv.get<Balance | null>("balance", null);
  let bal: Balance | null = null;
  try {
    for (let i = 0; i < pending.length; i += 100) {
      const batch = pending.slice(i, i + 100);
      const r = await api<Partial<Balance>>("/events", {
        method: "POST",
        body: JSON.stringify({ events: batch }),
      });
      await rotation.markSynced(batch.map((e) => e.id));
      bal = {
        pendingUsd: Number(r.pendingUsd) || 0,
        settledUsd: Number(r.settledUsd) || 0,
        minPayoutUsd: Number(r.minPayoutUsd) || 0,
      };
    }
    if (bal) await kv.set("balance", bal);
    return bal;
  } catch {
    // Offline: keep the queue, return the last known server balance.
    return kv.get<Balance | null>("balance", null);
  }
}

/** Total earned on this device, server-truth: $pending + $already-paid. */
const earnedUsd = (b: Balance | null) => (b ? b.pendingUsd + b.settledUsd : 0);

// ─── Analytics (PostHog) — env-gated, fetched from the site; no-op without a key ───
type PhCfg = { key: string | null; host: string };
let phCfg: PhCfg | null | undefined;
async function analyticsCfg(): Promise<PhCfg | null> {
  if (phCfg !== undefined) return phCfg;
  try {
    const { site } = await bases();
    const r = await fetch(`${site}/api/analytics-config`, { signal: AbortSignal.timeout(4_000) });
    const c = (await r.json()) as PhCfg;
    phCfg = c && c.key ? c : null;
  } catch {
    phCfg = null;
  }
  return phCfg;
}
async function track(event: string, properties: Record<string, unknown> = {}): Promise<void> {
  const cfg = await analyticsCfg();
  if (!cfg) return;
  try {
    const s = await settings();
    await fetch(`${cfg.host}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: cfg.key,
        event,
        distinct_id: s.deviceId,
        properties: { source: "extension", ...properties },
      }),
    });
  } catch {
    /* analytics must never break the worker */
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  // 3 min so a freshly-paid campaign appears quickly (the popup also pulls a
  // fresh copy on open, below).
  chrome.alarms.create("kolex:refresh", { periodInMinutes: 3, delayInMinutes: 0 });
  chrome.alarms.create("kolex:flush", { periodInMinutes: 5, delayInMinutes: 1 });
  // On a FRESH install (not an update or browser refresh), open the portal so
  // the user signs in and links this browser right away — only linked accounts
  // earn. Demo builds skip this (they auto-run for screen recordings).
  if (details.reason === "install" && !DEMO) void openSignIn();
});

/** Open the portal's sign-in / connect flow in a new tab, carrying this
 *  device's id so it links to the account the moment they log in. */
async function openSignIn(): Promise<void> {
  try {
    const s = await settings();
    const { site } = await bases();
    await chrome.tabs.create({
      url: `${site}/portal?device=${encodeURIComponent(s.deviceId)}&connect=1&welcome=1`,
      active: true,
    });
    void track("extension_installed");
  } catch {
    /* never let onboarding break the worker */
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "kolex:refresh") { void refreshRemoteConfig(); void refreshLinkStatus(); }
  if (alarm.name === "kolex:flush") void flushLedger();
});

async function handle(req: KolexRequest): Promise<unknown> {
  const s = await settings();

  switch (req.type) {
    case "kolex:tick": {
      if (!s.consent || !s.enabled || s.killswitch) {
        return { serving: false, balanceUsd: 0, impressionRecorded: false, ratePerImpressionUsd: 0, msIntoImpression: 0 } satisfies TickResponse;
      }
      // Until this device is linked to an account it can't earn — show a
      // sign-in prompt instead of paid ads (which would reward nobody and the
      // backend now drops). Real ads return as soon as the account is linked.
      if (!DEMO) {
        const link = await kv.get<LinkState>("link", { linked: false, email: null });
        if (!link.linked) {
          void throttledLinkRefresh(); // flip to real ads soon after they connect
          return {
            serving: true,
            ad: {
              id: SIGN_IN_AD.id,
              brand: SIGN_IN_AD.brand,
              text: SIGN_IN_AD.text,
              house: true,
              iconDataUrl: SIGN_IN_AD.iconDataUrl,
              accent: SIGN_IN_AD.accent,
            },
            balanceUsd: 0,
            impressionRecorded: false,
            ratePerImpressionUsd: 0,
            msIntoImpression: 0,
          } satisfies TickResponse;
        }
      }
      const out = await rotation.tick(req.surface);
      // Demo: fake locally-accruing balance, no backend. Otherwise push the new
      // impression to the server and read back the authoritative balance.
      const balanceUsd = DEMO ? await demoBalanceUsd() : earnedUsd(await flushLedger());
      return {
        serving: !!out.ad,
        ad: out.ad
          ? {
              id: out.ad.id,
              brand: out.ad.brand,
              text: out.ad.text,
              house: out.ad.house,
              iconDataUrl: out.ad.iconDataUrl,
              accent: out.ad.accent,
            }
          : undefined,
        balanceUsd,
        impressionRecorded: out.impressionRecorded,
        ratePerImpressionUsd: out.ratePerImpressionUsd,
        msIntoImpression: out.msIntoImpression,
      } satisfies TickResponse;
    }

    case "kolex:click": {
      if (!s.consent || !s.enabled) return { ok: false };
      // The sign-in prompt opens the portal connect flow (it carries the device
      // id so the portal links this browser to the account after login).
      if (req.adId === SIGN_IN_AD.id) {
        const { site } = await bases();
        await chrome.tabs.create({ url: `${site}/portal?device=${encodeURIComponent(s.deviceId)}&connect=1`, active: true });
        void track("signin_prompt_clicked", { surface: req.surface });
        return { ok: true };
      }
      await rotation.click(req.adId, req.surface);
      const ads = await rotation.getAds();
      const ad = ads.find((a) => a.id === req.adId);
      const { site } = await bases();
      const url = ad?.house
        ? ad.url
        : `${site}/r/${encodeURIComponent(req.adId)}?d=${encodeURIComponent(s.deviceId)}`;
      await chrome.tabs.create({ url, active: true });
      void flushLedger();
      void track("ad_clicked", { adId: req.adId, surface: req.surface, house: !!ad?.house });
      return { ok: true };
    }

    case "kolex:status": {
      if (DEMO) {
        await refreshRemoteConfig(); // ensure demo ads are loaded
        const sum = await rotation.summary();
        const ads = await rotation.getAds();
        const balance = await demoBalanceUsd();
        return {
          consent: true,
          enabled: s.enabled,
          killswitch: false,
          deviceId: s.deviceId,
          totalImpressions: 1240 + sum.totalImpressions,
          totalClicks: 37 + sum.totalClicks,
          adCount: ads.filter((a) => !a.house).length,
          linked: true,
          accountEmail: "you@email.com",
          serverPendingUsd: balance,
          serverSettledUsd: 0,
          minPayoutUsd: 10,
          pendingNowUsd: await rotation.inProgressUsd(),
        } satisfies StatusResponse;
      }
      // Pull fresh inventory + link state on popup open so a just-activated
      // campaign (and a just-linked account) show up right away instead of
      // waiting for the 3-minute refresh alarm.
      let link: LinkState = { linked: false, email: null };
      let bal: Balance | null = null;
      if (s.consent) {
        await refreshRemoteConfig();
        link = await refreshLinkStatus();
        await flushLedger(); // push pending events so the balance is current
        bal = await fetchServerBalance(); // authoritative read (same source as the portal)
      }
      const sum = await rotation.summary();
      const ads = await rotation.getAds();
      return {
        consent: s.consent,
        enabled: s.enabled,
        killswitch: s.killswitch,
        deviceId: s.deviceId,
        totalImpressions: sum.totalImpressions,
        totalClicks: sum.totalClicks,
        // "Live ads" means real paid campaigns in rotation — Kolex's own $0
        // house ads (the blank-inventory fallback) are not counted.
        adCount: ads.filter((a) => !a.house).length,
        linked: link.linked,
        accountEmail: link.email,
        // The ONE balance: server-settled, identical to the cash-out portal.
        serverPendingUsd: bal ? bal.pendingUsd : null,
        serverSettledUsd: bal ? bal.settledUsd : null,
        minPayoutUsd: bal ? bal.minPayoutUsd : null,
        // Live in-progress impression (not yet settled) so the popup shows the
        // same "+ pending" as the overlay.
        pendingNowUsd: await rotation.inProgressUsd(),
      } satisfies StatusResponse;
    }

    case "kolex:set-enabled":
      await saveSettings({ enabled: req.enabled });
      return { ok: true };

    case "kolex:grant-consent":
      await saveSettings({ consent: true });
      void refreshRemoteConfig();
      void track("extension_consent_granted");
      return { ok: true };

    case "kolex:open-page": {
      // Carry the device id so the portal can link earnings to the account
      // after the user logs in (the "cash out" flow from the popup).
      const { site } = await bases();
      const path = req.page === "home" ? "/" : `/${req.page}`;
      const url = `${site}${path}?device=${encodeURIComponent(s.deviceId)}&connect=1`;
      await chrome.tabs.create({ url, active: true });
      void track("extension_open_portal", { page: req.page });
      return { ok: true };
    }

    default:
      return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((req: KolexRequest, _sender, sendResponse) => {
  handle(req)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false }));
  return true; // async response
});
