import {
  CLICK_MULTIPLIER,
  IMPRESSION_MS,
  TICK_CONTINUITY_MS,
  clickPayout,
  impressionPayout,
  type Ad,
} from "./economics.js";
import { findAd, pickNextAd, sanitizeAds, HOUSE_ADS } from "./inventory.js";
import type { KV } from "./kv.js";

export type Surface = "chatgpt" | "claude" | "other";

export interface LedgerEvent {
  /** Idempotency key — the backend deduplicates on this. */
  id: string;
  ts: number;
  type: "impression" | "click";
  adId: string;
  surface: Surface;
  synced: boolean;
}

interface RotationState {
  currentAdId: string | null;
  /** Milliseconds the current ad has been on screen, toward one impression. */
  accruedMs: number;
  lastTickTs: number | null;
  /** Impressions served per ad — drives the tie round-robin. */
  served: Record<string, number>;
  totalImpressions: number;
  totalClicks: number;
  estEarnedUsd: number;
}

const EMPTY_STATE: RotationState = {
  currentAdId: null,
  accruedMs: 0,
  lastTickTs: null,
  served: {},
  totalImpressions: 0,
  totalClicks: 0,
  estEarnedUsd: 0,
};

/** Local ledger cap. Synced events are pruned first when the cap is hit. */
const LEDGER_CAP = 5_000;

const K_STATE = "rotation";
const K_ADS = "ads";
const K_LEDGER = "ledger";

export interface TickOutcome {
  ad: Ad | undefined;
  impressionRecorded: boolean;
  totalImpressions: number;
  estEarnedUsd: number;
}

/**
 * The rotation engine: accrues on-screen time, settles impressions, orders
 * ads by auction rules, and keeps the local earnings ledger. Lives in the
 * extension service worker; storage and clock are injected for tests.
 */
export class Rotation {
  constructor(
    private kv: KV,
    private now: () => number = Date.now,
    private uuid: () => string = () => crypto.randomUUID(),
  ) {}

  async getAds(): Promise<Ad[]> {
    const ads = await this.kv.get<Ad[]>(K_ADS, []);
    return ads.length > 0 ? ads : HOUSE_ADS;
  }

  /** Replace paid inventory from the backend. House ads always backfill. */
  async setAds(raw: unknown): Promise<void> {
    const paid = sanitizeAds(raw);
    await this.kv.set(K_ADS, [...paid, ...HOUSE_ADS]);
  }

  /**
   * Advance the clock by one tick. Called once a second by a content script
   * while a visible wait state is on screen. Accrual only counts time
   * between adjacent ticks: an impression is 5 contiguous seconds of a real
   * wait, not 5 seconds of wall time.
   */
  async tick(surface: Surface): Promise<TickOutcome> {
    const now = this.now();
    const state = await this.kv.get<RotationState>(K_STATE, { ...EMPTY_STATE, served: {} });
    const ads = await this.getAds();

    if (state.lastTickTs !== null && now > state.lastTickTs) {
      const delta = now - state.lastTickTs;
      if (delta <= TICK_CONTINUITY_MS) state.accruedMs += delta;
    }
    state.lastTickTs = now;

    let ad = findAd(ads, state.currentAdId);
    if (!ad || ad.impressionsRemaining <= 0) {
      ad = pickNextAd(ads, state.served, state.currentAdId);
      state.currentAdId = ad?.id ?? null;
      state.accruedMs = 0;
    }

    let impressionRecorded = false;
    if (ad && state.accruedMs >= IMPRESSION_MS) {
      await this.appendEvent({ type: "impression", adId: ad.id, surface });
      state.served[ad.id] = (state.served[ad.id] ?? 0) + 1;
      state.totalImpressions += 1;
      state.estEarnedUsd += impressionPayout(ad);
      if (!ad.house) {
        ad.impressionsRemaining = Math.max(0, ad.impressionsRemaining - 1);
        await this.kv.set(K_ADS, ads);
      }
      state.accruedMs -= IMPRESSION_MS;

      // Rotate after every settled impression.
      const next = pickNextAd(ads, state.served, ad.id);
      state.currentAdId = next?.id ?? null;
      ad = next ?? ad;
      impressionRecorded = true;
    }

    await this.kv.set(K_STATE, state);
    return {
      ad,
      impressionRecorded,
      totalImpressions: state.totalImpressions,
      estEarnedUsd: state.estEarnedUsd,
    };
  }

  /** Record a click on the currently served ad. Returns the payout. */
  async click(adId: string, surface: Surface): Promise<number> {
    const ads = await this.getAds();
    const ad = findAd(ads, adId);
    if (!ad) return 0;
    await this.appendEvent({ type: "click", adId, surface });
    const state = await this.kv.get<RotationState>(K_STATE, { ...EMPTY_STATE, served: {} });
    state.totalClicks += 1;
    state.estEarnedUsd += clickPayout(ad);
    await this.kv.set(K_STATE, state);
    return clickPayout(ad);
  }

  async summary(): Promise<{
    totalImpressions: number;
    totalClicks: number;
    estEarnedUsd: number;
    pendingEvents: number;
  }> {
    const state = await this.kv.get<RotationState>(K_STATE, { ...EMPTY_STATE, served: {} });
    const ledger = await this.kv.get<LedgerEvent[]>(K_LEDGER, []);
    return {
      totalImpressions: state.totalImpressions,
      totalClicks: state.totalClicks,
      estEarnedUsd: state.estEarnedUsd,
      pendingEvents: ledger.filter((e) => !e.synced).length,
    };
  }

  async unsyncedEvents(): Promise<LedgerEvent[]> {
    const ledger = await this.kv.get<LedgerEvent[]>(K_LEDGER, []);
    return ledger.filter((e) => !e.synced);
  }

  async markSynced(ids: string[]): Promise<void> {
    const set = new Set(ids);
    const ledger = await this.kv.get<LedgerEvent[]>(K_LEDGER, []);
    for (const e of ledger) if (set.has(e.id)) e.synced = true;
    await this.kv.set(K_LEDGER, ledger);
  }

  private async appendEvent(event: Pick<LedgerEvent, "type" | "adId" | "surface">): Promise<void> {
    let ledger = await this.kv.get<LedgerEvent[]>(K_LEDGER, []);
    ledger.push({ ...event, id: this.uuid(), ts: this.now(), synced: false });
    if (ledger.length > LEDGER_CAP) {
      const unsynced = ledger.filter((e) => !e.synced);
      const synced = ledger.filter((e) => e.synced);
      ledger = [...synced.slice(-(LEDGER_CAP - unsynced.length)), ...unsynced].slice(-LEDGER_CAP);
    }
    await this.kv.set(K_LEDGER, ledger);
  }
}

export { CLICK_MULTIPLIER };
