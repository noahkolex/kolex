// Shared test harness: stubs the chrome.* extension APIs the content script
// uses, so the REAL built extension/content.js runs against a fixture page in
// a real browser. A query param controls which surface config is served.

(function () {
  const HOST = location.hostname; // file:// → "" ; we match on that
  const ADS = [
    {
      id: "ex-notion",
      brand: "Notion",
      text: "One workspace for your docs, wiki, and projects",
      house: true,
      iconDataUrl:
        "data:image/svg+xml;base64," +
        btoa(
          '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="#0F1216"/><path d="M11 10v12M11 10l10 12M21 10v12" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        ),
      accent: "#0F1216",
    },
  ];

  // busy/spinner selectors come from the page via window.__KOLEX_SITE.
  const site = window.__KOLEX_SITE || {
    surface: "chatgpt",
    hosts: [HOST],
    busySelectors: ['button[data-testid="stop-button"]', ".spinner.on"],
    spinnerSelectors: [],
  };
  site.hosts = [HOST];

  let accrued = 0,
    last = null,
    earned = 0;

  window.chrome = {
    storage: { local: { get: async () => ({ sites: [site] }) } },
    runtime: {
      sendMessage: async (msg) => {
        if (msg.type === "kolex:tick") {
          const now = Date.now();
          if (last && now - last <= 4000) accrued += now - last;
          last = now;
          let impressionRecorded = false;
          if (accrued >= 5000) {
            accrued -= 5000;
            earned += 0.005;
            impressionRecorded = true;
          }
          return {
            serving: true,
            ad: ADS[0],
            balanceUsd: earned,
            impressionRecorded,
            ratePerImpressionUsd: 0.005, // the in-progress impression's payout
            msIntoImpression: accrued,
          };
        }
        return { ok: true };
      },
    },
  };
})();
