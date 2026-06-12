// Demo harness: stubs the chrome.* APIs the REAL extension/content.js uses, and
// serves a rotating set of test ads with a live earnings meter — so the actual
// shipping overlay/detection code runs on the demo pages. A new sponsored brand
// is shown each time a fresh "thinking" session begins.
(function () {
  const tile = (bg, glyph) =>
    "data:image/svg+xml;base64," +
    btoa(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${bg}"/>${glyph}</svg>`,
    );

  const ADS = [
    { id: "linear", brand: "Linear", text: "The issue tracker teams actually enjoy", accent: "#5E6AD2",
      iconDataUrl: tile("#5E6AD2", '<path d="M7 18.5 13.5 25A9 9 0 0 1 7 18.5Z M7 14.2A12.8 12.8 0 0 0 17.8 25 M7.6 10.6A16.4 16.4 0 0 0 21.4 24.4" stroke="#fff" stroke-width="2.1" fill="none" stroke-linecap="round"/>') },
    { id: "vercel", brand: "Vercel", text: "Ship your AI app to the edge in seconds", accent: "#0F1216",
      iconDataUrl: tile("#0F1216", '<path d="M16 8 25 23H7Z" fill="#fff"/>') },
    { id: "stripe", brand: "Stripe", text: "Payments infrastructure for the internet", accent: "#635BFF",
      iconDataUrl: tile("#635BFF", '<path d="M11 13.5c0-1 1-1.5 2.4-1.5 1.5 0 3 .5 4 1V9.4A9 9 0 0 0 13.4 9C10 9 7.7 10.7 7.7 13.4c0 4.2 5.8 3.5 5.8 5.3 0 .8-.7 1.1-1.9 1.1-1.6 0-3.5-.7-5-1.5v3.4a11 11 0 0 0 5 1c3.6 0 6-1.6 6-4.5 0-4.5-5.8-3.7-5.8-5.2Z" fill="#fff"/>') },
    { id: "raycast", brand: "Raycast", text: "Your shortcut to everything on the Mac", accent: "#FF6363",
      iconDataUrl: tile("#FF6363", '<path d="M16 8l8 8-8 8-8-8z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/>') },
  ];

  const site = window.__KOLEX_SITE || {
    surface: "chatgpt",
    busySelectors: ['.spinner.on'],
    spinnerSelectors: ['.spinner.on'],
  };
  site.hosts = [location.hostname];

  const RATE = 0.02; // $/impression (≈ a $40/1k bid)
  let accrued = 0, last = null, earned = 0, adIndex = 0;

  window.chrome = {
    storage: { local: { get: async () => ({ sites: [site] }) } },
    runtime: {
      sendMessage: async (msg) => {
        if (msg.type === "kolex:tick") {
          const now = Date.now();
          // A gap > 4s means a new thinking session → rotate to the next brand.
          if (last === null || now - last > 4000) adIndex = (adIndex + 1) % ADS.length;
          else accrued += now - last;
          last = now;
          let impressionRecorded = false;
          if (accrued >= 5000) { accrued -= 5000; earned += RATE; impressionRecorded = true; }
          return {
            serving: true,
            ad: ADS[adIndex],
            balanceUsd: earned,
            impressionRecorded,
            ratePerImpressionUsd: RATE,
            msIntoImpression: accrued,
          };
        }
        return { ok: true };
      },
    },
  };
})();
