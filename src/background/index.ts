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

/** Upload unsynced ledger events. Idempotent on event id. */
async function flushLedger(): Promise<void> {
  const pending = await rotation.unsyncedEvents();
  if (pending.length === 0) return;
  try {
    for (let i = 0; i < pending.length; i += 100) {
      const batch = pending.slice(i, i + 100);
      await api("/events", { method: "POST", body: JSON.stringify({ events: batch }) });
      await rotation.markSynced(batch.map((e) => e.id));
    }
  } catch {
    // Stays queued; the backend dedupes on event id.
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
        return { serving: false, estEarnedUsd: 0, impressionRecorded: false } satisfies TickResponse;
      }
      const out = await rotation.tick(req.surface);
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
        estEarnedUsd: out.estEarnedUsd,
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
      return { ok: true };
    }

    case "kolex:status": {
      // Pull fresh inventory on popup open so a just-activated campaign shows
      // up right away instead of waiting for the 3-minute refresh alarm.
      if (s.consent) await refreshRemoteConfig();
      const sum = await rotation.summary();
      const ads = await rotation.getAds();
      return {
        consent: s.consent,
        enabled: s.enabled,
        killswitch: s.killswitch,
        deviceId: s.deviceId,
        totalImpressions: sum.totalImpressions,
        totalClicks: sum.totalClicks,
        estEarnedUsd: sum.estEarnedUsd,
        pendingEvents: sum.pendingEvents,
        // "Live ads" means real paid campaigns in rotation — Kolex's own $0
        // house ads (the blank-inventory fallback) are not counted.
        adCount: ads.filter((a) => !a.house).length,
      } satisfies StatusResponse;
    }

    case "kolex:set-enabled":
      await saveSettings({ enabled: req.enabled });
      return { ok: true };

    case "kolex:grant-consent":
      await saveSettings({ consent: true });
      void refreshRemoteConfig();
      return { ok: true };

    case "kolex:open-page": {
      // Carry the device id so the portal can link earnings to the account
      // after the user logs in (the "cash out" flow from the popup).
      const { site } = await bases();
      const path = req.page === "home" ? "/" : `/${req.page}`;
      const url = `${site}${path}?device=${encodeURIComponent(s.deviceId)}&connect=1`;
      await chrome.tabs.create({ url, active: true });
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
