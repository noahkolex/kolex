import { formatUsd } from "../shared/economics.js";
import type { StatusResponse } from "../shared/messages.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`popup: missing #${id}`);
  return node as T;
}

async function status(): Promise<StatusResponse> {
  return (await chrome.runtime.sendMessage({ type: "kolex:status" })) as StatusResponse;
}

// The last balance we showed, so an offline blip keeps the number instead of
// snapping to $0, and so we can animate the count-up between updates.
let shownUsd = 0;
let lastEarned: number | null = null;

/** Smoothly tween the displayed earnings so you can watch it tick up. */
function setEarned(to: number): void {
  const from = shownUsd;
  if (Math.abs(to - from) < 0.00005) {
    shownUsd = to;
    el("usd").textContent = formatUsd(to);
    return;
  }
  const start = performance.now();
  const dur = 700;
  function frame(t: number): void {
    const k = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    shownUsd = from + (to - from) * eased;
    el("usd").textContent = formatUsd(shownUsd);
    if (k < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function render(s: StatusResponse): void {
  el("consent").classList.toggle("hidden", s.consent);
  el("dash").classList.toggle("hidden", !s.consent);
  el("toggleWrap").classList.toggle("hidden", !s.consent);

  el<HTMLInputElement>("toggle").checked = s.enabled;

  // ONE balance, server-settled — identical to the cash-out portal. On an
  // offline blip (null) we keep the last known number rather than diverge.
  const earned =
    s.serverPendingUsd != null ? s.serverPendingUsd + (s.serverSettledUsd ?? 0) : lastEarned;
  if (earned != null) {
    lastEarned = earned;
    el("usd-label").textContent = "Your earnings";
    setEarned(earned);
    const min = s.minPayoutUsd ?? 0;
    const pend = s.serverPendingUsd ?? earned;
    el("usd-sub").textContent =
      `${formatUsd(pend)} ready to cash out` + (min > 0 ? ` · ${formatUsd(min)} minimum` : "");
  } else {
    el("usd-label").textContent = "Your earnings";
    el("usd-sub").textContent = s.linked ? "Syncing…" : "Sign in to track your balance";
  }

  el("impressions").textContent = String(s.totalImpressions);
  el("clicks").textContent = String(s.totalClicks);
  el("adCount").textContent = String(s.adCount);
  el("kill").classList.toggle("hidden", !s.killswitch);
  el("device").textContent = `device ${s.deviceId.slice(0, 8)}`;

  // Once the device is linked to an account, show that instead of nagging the
  // user to sign in. "Cash out" still opens the portal for withdrawals.
  el("connectWrap").classList.toggle("hidden", s.linked);
  const account = el("account");
  account.classList.toggle("hidden", !s.linked);
  if (s.linked) {
    account.innerHTML = s.accountEmail
      ? `✓ Linked to <b>${escapeHtml(s.accountEmail)}</b>`
      : "✓ This browser is linked to your account";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

async function main(): Promise<void> {
  render(await status());

  el("grant").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "kolex:grant-consent" });
    render(await status());
  });

  el<HTMLInputElement>("toggle").addEventListener("change", async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    await chrome.runtime.sendMessage({ type: "kolex:set-enabled", enabled });
    render(await status());
  });

  el("cashout").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "kolex:open-page", page: "portal" });
    window.close();
  });

  // Same destination as Cash out (the portal links this browser to your account
  // after sign-in), framed for re-logging in on a new computer.
  el("connect").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "kolex:open-page", page: "portal" });
    window.close();
  });

  // Live-refresh while the popup is open so earnings tick in real time.
  setInterval(async () => render(await status()), 1_000);
}

void main();
