import type { Ad } from "./economics.js";
import type { Surface } from "./rotation.js";

/** Typed messages between content scripts / popup and the service worker. */

export interface TickRequest {
  type: "kolex:tick";
  surface: Surface;
}

export interface TickResponse {
  serving: boolean;
  ad?: Pick<Ad, "id" | "brand" | "text" | "house" | "iconDataUrl" | "accent">;
  /** Server-settled total earned on this device (the single source of truth). */
  balanceUsd: number;
  impressionRecorded: boolean;
}

export interface ClickRequest {
  type: "kolex:click";
  adId: string;
  surface: Surface;
}

export interface StatusRequest {
  type: "kolex:status";
}

export interface StatusResponse {
  consent: boolean;
  enabled: boolean;
  killswitch: boolean;
  deviceId: string;
  totalImpressions: number;
  totalClicks: number;
  adCount: number;
  /** True once this device has been linked to an account (cash-out ready). */
  linked: boolean;
  /** The linked account's email, when known. */
  accountEmail: string | null;
  /** Server-settled balance for this device (null when offline). */
  serverPendingUsd: number | null;
  serverSettledUsd: number | null;
  /** Minimum balance required to cash out (USD), from the server. */
  minPayoutUsd: number | null;
}

export interface SetEnabledRequest {
  type: "kolex:set-enabled";
  enabled: boolean;
}

export interface GrantConsentRequest {
  type: "kolex:grant-consent";
}

/** Open a kolex.ai page (portal, advertise) in a new tab, with device id. */
export interface OpenPageRequest {
  type: "kolex:open-page";
  page: "portal" | "advertise" | "home";
}

export type KolexRequest =
  | TickRequest
  | ClickRequest
  | StatusRequest
  | SetEnabledRequest
  | GrantConsentRequest
  | OpenPageRequest;
