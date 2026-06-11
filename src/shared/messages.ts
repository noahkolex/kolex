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
  estEarnedUsd: number;
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
  estEarnedUsd: number;
  pendingEvents: number;
  adCount: number;
}

export interface SetEnabledRequest {
  type: "kolex:set-enabled";
  enabled: boolean;
}

export interface GrantConsentRequest {
  type: "kolex:grant-consent";
}

export type KolexRequest =
  | TickRequest
  | ClickRequest
  | StatusRequest
  | SetEnabledRequest
  | GrantConsentRequest;
