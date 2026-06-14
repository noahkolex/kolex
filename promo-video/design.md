# Kolex — Brand Design System (from web/assets/brand.css)

Money/casino theme. Dark, loud, alive. Irreverent fintech energy — "your AI's
loading screen now collects checks."

## Colors

| Token      | Hex                      | Use                                  |
| ---------- | ------------------------ | ------------------------------------ |
| bg         | #0a0e0c                  | Canvas                               |
| bg2        | #0d1310                  | Alternate panel bg                   |
| surface    | #131a16                  | Cards                                |
| elev       | #1a241e                  | Elevated cards                       |
| ink        | #eaf6ef                  | Primary text                         |
| muted      | #8a9a91                  | Secondary text                       |
| muted2     | #5e6e65                  | Tertiary text                        |
| green      | #16e0a3                  | Primary accent — money green         |
| green-hi   | #1cf2b1 / #5cffc8        | Gradient top / hover green           |
| green-deep | #0fb783                  | Gradient bottom                      |
| green-glow | rgba(22,224,163,0.35)    | Glows, shadows                       |
| gold       | #ffc53d (#ffd96b–#f0a800)| Clicks, money moments, rank          |
| purple     | #9b6bff                  | Tertiary accent                      |
| red        | #ff5c5c                  | Signal/error only                    |
| rule       | rgba(255,255,255,0.09)   | Hairlines                            |

Hero gradient ("pop" text): `linear-gradient(120deg, #1cf2b1, #ffd96b 60%, #9b6bff)`.
Primary button: `linear-gradient(180deg, #1cf2b1, #0fb783)`, text `#052016`.

## Typography

- Sans: **Geist** — weights 400–800. Headlines 800, letter-spacing -0.035em.
- Mono: **Geist Mono** — all money amounts, labels, metadata. `tabular-nums`.
- Eyebrow labels: mono 600, uppercase, letter-spacing 1.6px+, green, with a
  pulsing green dot.
- Money amounts: mono 800, green, `text-shadow: 0 0 28px green-glow`.

## Components (recreate, don't screenshot)

- **Adline** (the in-chat sponsored pill): white (#fff) rounded pill (10px),
  green pulsing dot, mono `AD` tag in accent color, bold brand name, muted
  copy, earnings in green mono.
- **Ticker**: green-bordered rounded card, glow inside and out, uppercase mono
  label, huge green mono amount.
- **Extension popup**: dark surface card, "YOUR EARNINGS" label, giant green
  amount, 3 stat cells (impressions/clicks/live ads), full-width green
  "Cash out →" button.

## Depth & texture

Radial glows (green top-right, purple low-left) on the dark canvas. Glow
shadows on money elements. Cards: surface bg + 1px rule border, radius 16px.

## What NOT to do

- No light mode, no flat dead-gray neutrals — tint toward green.
- No em-dashes in product copy (brand rule from manifest commit).
- Red only as signal, never decorative.
- Don't substitute fonts; Geist + Geist Mono only.
