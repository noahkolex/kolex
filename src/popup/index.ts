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

function render(s: StatusResponse): void {
  el("consent").classList.toggle("hidden", s.consent);
  el("dash").classList.toggle("hidden", !s.consent);
  el("toggleWrap").classList.toggle("hidden", !s.consent);

  el<HTMLInputElement>("toggle").checked = s.enabled;
  el("usd").textContent = formatUsd(s.estEarnedUsd);
  el("impressions").textContent = String(s.totalImpressions);
  el("clicks").textContent = String(s.totalClicks);
  el("adCount").textContent = String(s.adCount);
  el("pending").textContent = `${s.pendingEvents} events`;
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
