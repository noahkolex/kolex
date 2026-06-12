// Shared client helpers for the Kolex website.

const BIRD_PATH =
  "M66.616 51.836 L67.015 51.703 L125.47 110.157 L129.997 116.016 L133.193 121.076 L135.59 125.603 L137.987 131.995 L139.851 141.582 L139.851 150.636 L139.318 154.897 L137.72 161.821 L135.856 167.147 L131.595 175.936 L123.872 189.517 L118.812 199.637 L114.818 206.561 L114.152 207.227 L70.078 207.094 L113.353 173.406 L114.285 172.207 L114.551 170.876 L114.551 166.881 L112.954 162.62 L109.625 158.759 L100.038 153.699 L92.581 150.503 L86.19 146.508 L83.526 144.378 L79.132 139.984 L77.268 137.587 L74.339 133.06 L71.942 128.266 L70.344 123.739 L70.344 122.94 L71.01 122.807 L73.14 124.405 L77.934 127.068 L99.771 136.655 L106.163 140.117 L106.562 139.984 L102.168 135.856 L96.309 131.329 L78.2 118.812 L74.206 115.35 L70.344 111.223 L66.083 105.097 L62.621 97.907 L60.757 90.983 L60.224 85.923 L60.358 82.861 L61.689 83.393 L67.814 89.518 L73.407 94.046 L96.842 110.557 L106.163 117.747 L106.695 118.013 L106.828 117.614 L102.301 112.554 L78.6 89.385 L71.409 80.597 L68.214 74.472 L65.817 66.216 L65.284 59.292 L65.551 59.026 L65.551 55.83 L66.483 51.969Z M167.014 89.385 L170.077 89.252 L174.87 90.584 L178.066 92.448 L180.995 95.643 L186.588 95.91 L189.784 96.709 L192.713 98.307 L195.509 101.369 L188.985 103.1 L183.659 106.03 L179.797 109.891 L177.4 114.152 L175.802 119.478 L175.802 137.054 L175.27 141.848 L174.205 146.642 L172.607 151.701 L169.145 159.424 L165.683 164.751 L162.487 168.745 L155.163 175.536 L148.239 180.063 L141.848 183.259 L135.989 185.656 L132.794 186.721 L131.728 186.721 L131.595 186.055 L134.791 180.729 L140.117 170.077 L141.715 166.082 L143.845 159.158 L145.177 150.37 L145.177 142.114 L144.378 136.256 L142.248 128.533 L140.916 125.071 L138.519 120.543 L138.519 119.478 L148.106 104.299 L145.044 103.366 L141.582 101.236 L139.584 98.972 L138.519 96.842 L144.511 96.709 L147.707 96.176 L151.968 94.845 L161.022 90.85 L164.218 89.785 L166.881 89.518Z";

/** An ALWAYS-sized bird mark (px). Never renders unconstrained. */
export function bird(size = 20, color = "#16E0A3") {
  return `<svg width="${size}" height="${size}" viewBox="59 49 139 160" aria-hidden="true" style="display:block;flex:none"><path fill="${color}" fill-rule="evenodd" d="${BIRD_PATH}"/></svg>`;
}

export function money(n, cents = true) {
  n = Number(n) || 0;
  if (!cents && n >= 1000) return "$" + Math.round(n).toLocaleString("en-US");
  if (n !== 0 && Math.abs(n) < 0.01) return "$" + n.toFixed(4);
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export const num = (n) => (Number(n) || 0).toLocaleString("en-US");

export async function api(path, { method = "GET", body, token } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "request failed"), { data, status: res.status });
  return data;
}

export const store = {
  get: (k) => localStorage.getItem("kolex:" + k),
  set: (k, v) => localStorage.setItem("kolex:" + k, v),
  del: (k) => localStorage.removeItem("kolex:" + k),
};

export const qp = (name) => new URLSearchParams(location.search).get(name);

// ─────────────────────────── Analytics (PostHog) ───────────────────────────
// Thin, env-gated capture. Fetches the public config once; with no key it's a
// no-op. distinct_id is a stable anonymous id in localStorage. Never throws.
let _phCfg; // undefined = unknown, null = disabled, {key,host} = enabled
async function phCfg() {
  if (_phCfg !== undefined) return _phCfg;
  try {
    const c = await api("/api/analytics-config");
    _phCfg = c && c.key ? c : null;
  } catch {
    _phCfg = null;
  }
  return _phCfg;
}
function anonId() {
  let id = store.get("anon");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `a-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    store.set("anon", id);
  }
  return id;
}
export async function track(event, properties = {}) {
  const cfg = await phCfg();
  if (!cfg) return;
  try {
    await fetch(`${cfg.host}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        api_key: cfg.key,
        event,
        distinct_id: anonId(),
        properties: { source: "web", $current_url: location.href, path: location.pathname, ...properties },
      }),
    });
  } catch {
    /* analytics must never break the page */
  }
}
/** Tie the anonymous id to a known person (e.g. after login). */
export async function identify(email) {
  if (email) await track("$identify", { $set: { email } });
}
// Auto pageview on every page load.
track("$pageview");

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Perceived brightness (YIQ) of a #rrggbb color. > 145 reads as "light". */
export function isBright(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || "");
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (((n >> 16) & 0xff) * 299 + ((n >> 8) & 0xff) * 587 + (n & 0xff) * 114) / 1000 > 145;
}

/** Render an ad preview line. The mark is always pixel-sized (no giant bird). */
export function renderAdline(el, { brand, text, iconDataUrl, accent }) {
  const a = /^#[0-9a-fA-F]{6}$/.test(accent || "") ? accent : "#16E0A3";
  const mark = iconDataUrl
    ? `<span class="mk"><img src="${iconDataUrl}" alt="" width="20" height="20"></span>`
    : `<span class="mk">${bird(18, a)}</span>`;
  el.style.setProperty("--a", a);
  // Bright accent → dark card, dark accent → white card (so the accent reads).
  el.classList.toggle("is-dark", isBright(a));
  el.innerHTML =
    mark +
    '<span class="dot"></span><span class="tag">AD</span>' +
    `<span class="bn">${escapeHtml(brand || "Your brand")}</span>` +
    `<span class="cp">${escapeHtml(text || "Your message here")}</span>` +
    '<span class="ar">↗</span>';
}

/** Header nav. "Cash out" for earners, "Launch an ad" for advertisers. */
export function mountNav(active) {
  const el = document.querySelector("[data-nav]");
  if (!el) return;
  const links = [
    ["/portal", "Cash out"],
    ["/advertiser", "Advertiser portal"],
  ];
  el.innerHTML =
    `<div class="wrap"><a class="brandmark" href="/">${bird(24)}<span>kolex</span></a><span class="spacer"></span>` +
    links.map(([h, t]) => `<a class="navlink${h === active ? " on" : ""}" href="${h}">${t}</a>`).join("") +
    `<a class="btn btn-primary" href="/advertise">Launch an ad ⚡</a></div>`;
}

// ─────────────────────────── Sound (synthesized) ───────────────────────────
// No audio files: a Web Audio "cha-ching" coin ding. Browsers require a user
// gesture before audio; we lazily create + resume the context on first click.

let actx = null;
let soundOn = store.get("sound") !== "off";
function ctx() {
  if (!actx) {
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      actx = null;
    }
  }
  if (actx && actx.state === "suspended") actx.resume();
  return actx;
}
window.addEventListener("pointerdown", () => ctx(), { once: true });

function tone(freq, start, dur, gain = 0.18, type = "sine") {
  const c = ctx();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, c.currentTime + start);
  g.gain.setValueAtTime(0, c.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + start);
  o.stop(c.currentTime + start + dur + 0.02);
}

/** Coin "ding": two quick bright notes. */
export function ding() {
  if (!soundOn) return;
  tone(1318, 0, 0.12, 0.14, "triangle"); // E6
  tone(1760, 0.07, 0.18, 0.13, "triangle"); // A6
}
/** Bigger "cha-ching" for a real payout. */
export function chaching() {
  if (!soundOn) return;
  tone(988, 0, 0.1, 0.16, "triangle");
  tone(1318, 0.08, 0.1, 0.16, "triangle");
  tone(1760, 0.16, 0.28, 0.16, "triangle");
}
export function setSound(on) {
  soundOn = on;
  store.set("sound", on ? "on" : "off");
}
export const isSoundOn = () => soundOn;

// ────────────────────── Counting / money animations ────────────────────────

/** Tween a number into an element (with $ + commas). */
export function animateCount(el, from, to, ms = 900, prefix = "$") {
  const start = performance.now();
  const fmt = (v) => prefix + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function frame(t) {
    const k = Math.min(1, (t - start) / ms);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * eased);
    if (k < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** Relative time like "2m ago" for the real activity feed. */
export function ago(ts) {
  const s = Math.max(0, (Date.now() - (Number(ts) || 0)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Fire confetti coins from a point (no deps). */
export function coinBurst(x, y, n = 14) {
  for (let i = 0; i < n; i++) {
    const c = document.createElement("div");
    c.className = "coin-particle";
    c.textContent = "🪙";
    c.style.left = x + "px";
    c.style.top = y + "px";
    const ang = Math.random() * Math.PI - Math.PI / 2;
    const dist = 60 + Math.random() * 120;
    c.style.setProperty("--dx", Math.cos(ang) * dist + "px");
    c.style.setProperty("--dy", -Math.abs(Math.sin(ang) * dist) - 40 + "px");
    c.style.fontSize = 12 + Math.random() * 12 + "px";
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 1100);
  }
}
