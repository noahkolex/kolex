// PostHog analytics — one thin, dependency-free capture helper used across the
// app (server here; the website and extension post to the same endpoint). It is
// fully env-gated: with no POSTHOG_KEY everything is a silent no-op, so it can
// never slow down or break a request.
import { config } from "./config.mjs";

const KEY = config.posthog.key;
const HOST = config.posthog.host;

export const analyticsEnabled = () => !!KEY;

/** Public config the website + extension fetch to init their own capture. */
export const publicAnalyticsConfig = () => ({ key: KEY || null, host: HOST });

/**
 * Capture a server-side event. Fire-and-forget; never awaited on the hot path
 * and never throws. distinctId should be a stable user/device identifier.
 */
export function capture(event, { distinctId, properties } = {}) {
  if (!KEY) return;
  // Don't block the response — send in the background, swallow all errors.
  void fetch(`${HOST}/capture/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: KEY,
      event,
      distinct_id: distinctId || "server",
      properties: { source: "server", ...properties },
      timestamp: new Date().toISOString(),
    }),
  }).catch(() => {});
}
