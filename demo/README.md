# Kolex demo + screen recording

A self-contained demo that runs the **real built extension overlay** (`extension/content.js`)
on faithful local simulations of ChatGPT and Claude, and records it.

> The real chatgpt.com / claude.ai can't be driven in CI/sandbox (login + network
> restrictions), so `chatgpt-demo.html` and `claude-demo.html` recreate those
> layouts and a prompt→thinking→answer flow. The overlay, ad detection, earnings
> meter, and "hide once the answer streams" logic are the actual shipping code;
> `harness-demo.js` stubs the `chrome.*` APIs and serves four rotating test ads
> (Linear, Vercel, Stripe, Raycast).

## Regenerate the recording
```bash
npm run build           # produces extension/content.js
node demo/record.mjs    # → demo/recordings/kolex-extension-demo.webm
```

## What it shows
Four prompts (two on ChatGPT, two on Claude). For each: the prompt is typed and
sent, the site shows its "thinking" spinner, Kolex replaces it with one sponsored
line while the earnings figure counts up, then the answer streams in and the ad
disappears — sponsoring only the wait, never the answer.

## Files
- `chatgpt-demo.html`, `claude-demo.html` — interactive site simulations (expose `window.__ask()`).
- `harness-demo.js` — stubs `chrome.*`, serves rotating test ads + a live earnings meter.
- `record.mjs` — drives the demos and records a 1280×800 `.webm`.
- `recordings/kolex-extension-demo.webm` — the recording.
