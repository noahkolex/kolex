# Chrome Web Store submission assets

Ready-to-upload images for the Kolex extension listing.

## Store icon
- **`store-icon-128.png`** — 128×128 PNG (the extension's icon, green tile + bird).
  Also present at `extension/icons/icon128.png`.

## Screenshots (1280×800, 24-bit PNG, no alpha — store-compliant)
Upload up to 5. Suggested order:

1. **`screenshot-1-how-it-works.png`** — the core mechanic: the "thinking…"
   spinner replaced by one sponsored line on a Claude chat, with live earnings.
2. **`screenshot-2-earnings.png`** — hero + the extension popup showing a
   balance, live "earning now", and Cash out.
3. **`screenshot-3-landing.png`** — the kolex.ai landing page.
4. **`screenshot-4-cashout.png`** — the earnings / cash-out portal (dummy data).
5. **`screenshot-5-advertise.png`** — the advertiser flow with the live ad preview.

All screenshots use dummy data. Regenerate the promo shots by editing
`promo-overlay.html` / `promo-popup.html` and re-running the capture (Playwright
at 1280×800 → `Image.convert("RGB")` to drop alpha).

> Tip: Chrome accepts 1280×800 **or** 640×400, JPEG or 24-bit PNG. These are the
> larger 1280×800 PNGs for crisper listings.
