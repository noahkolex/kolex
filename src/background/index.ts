import { ChromeKV } from "../shared/kv.js";
import { Rotation } from "../shared/rotation.js";
import { sanitizeSites, DEFAULT_SITES } from "../shared/detect.js";
import type {
  KolexRequest,
  StatusResponse,
  TickResponse,
} from "../shared/messages.js";

// Injected at build time from KOLEX_API_BASE / KOLEX_SITE_BASE (see build.mjs).
declare const __KOLEX_API_BASE__: string;
declare const __KOLEX_SITE_BASE__: string;
const BUILD_API_BASE = __KOLEX_API_BASE__;
const BUILD_SITE_BASE = __KOLEX_SITE_BASE__;

const kv = new ChromeKV(chrome.storage.local);
const rotation = new Rotation(kv);

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
    s = { deviceId: crypto.randomUUID(), consent: false, enabled: true, killswitch: false };
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

chrome.runtime.onInstalled.addListener(() => {
  // 3 min so a freshly-paid campaign appears quickly (the popup also pulls a
  // fresh copy on open, below).
  chrome.alarms.create("kolex:refresh", { periodInMinutes: 3, delayInMinutes: 0 });
  chrome.alarms.create("kolex:flush", { periodInMinutes: 5, delayInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "kolex:refresh") void refreshRemoteConfig();
  if (alarm.name === "kolex:flush") void flushLedger();
});

async function handle(req: KolexRequest): Promise<unknown> {
  const s = await settings();

  switch (req.type) {
    case "kolex:tick": {
      if (!s.consent || !s.enabled || s.killswitch) {
        return { serving: false, balanceUsd: 0, impressionRecorded: false } satisfies TickResponse;
      }
      const out = await rotation.tick(req.surface);
      // Push the new impression to the server immediately (real-time) and read
      // back the authoritative balance. When no event was recorded this beat,
      // flushLedger returns the cached balance without a network call.
      const bal = await flushLedger();
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
        balanceUsd: earnedUsd(bal),
        impressionRecorded: out.impressionRecorded,
      } satisfies TickResponse;
    }

    case "kolex:click": {
      if (!s.consent || !s.enabled) return { ok: false };
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
