# Kolex — 20s Promo: "Get paid for waiting"

1920x1080 · 20.0s · 4 scenes · CSS transitions only.
Palette and type cited from design.md: canvas #0a0e0c, ink #eaf6ef, green
#16e0a3 (hi #1cf2b1/#5cffc8, deep #0fb783), gold #ffc53d, purple #9b6bff,
surface #131a16, rule rgba(255,255,255,0.09). Geist (display, 800) +
Geist Mono (money, labels, tabular-nums).

## Rhythm

hook–PUNCH–proof–CTA. Scene 2 is the centerpiece (the product moment).
S1 brooding-slow, S2 alive and ticking, S3 confident count-up, S4 slam + hold.

## Global rules

- Every scene: BG decorative layer (radial green/purple glows, ghost mono
  type, hairline rules, corner registration marks) + MG content + FG accents.
- Every money number: Geist Mono, tabular-nums, green, glow text-shadow.
- Ambient motion everywhere, attached to tl (never bare gsap.to). Vary per
  scene: S1 glow breath, S2 counter ticks + dot pulse, S3 coin drift + button
  pulse, S4 logo glow breath.
- Transitions: zoom-through (S1→S2, "falling into the product"), vertical
  push (S2→S3, "next point"), overexposure burn to green-white (S3→S4, the
  money flash — boldest accent on the CTA reveal). No exit animations except
  final scene fade.
- fromTo everywhere; hard tl.set kills at boundaries where needed.

## Scene 1 — THE WAIT (0–4.6s)

Concept: the universally recognized dead moment. A void. You're staring at
"Thinking…" again. Time is leaking. The viewer should feel the itch of the
spinner before we name the fix.
Mood: cinematic title sequence, OLED black, a single breathing light.
BG: #0a0e0c. Faint green radial glow center (breathes scale 1→1.06). Ghost
oversized Geist Mono "$ 0.00" at 3% → wait, video floor is 12% — ghost type
at 12% opacity #5e6e65, 280px, bleeding off right edge. Hairline rules top
and bottom (scaleX draw-in). Corner registration marks + mono metadata
"EVERY AI · EVERY PROMPT · EVERY DAY".
MG: Giant "Thinking" + three dots (140px Geist 800, ink). The dots PULSE in
sequence (the universal spinner). Under it, mono timer "0:00"→"0:14" COUNTS
UP in muted, with label "TIME YOU'RE NOT GETTING BACK".
FG: bottom-left eyebrow "KOLEX · /kə'lɛks/ · see also: collects" with pulsing
green dot, floats in late.
Choreography: rules DRAW (scaleX 0→1, expo.out). "Thinking" FADES+RISES
(power2.out, slow 0.9s). Dots pulse on loop (sine, finite repeats). Timer
COUNTS UP (snap). Ghost type DRIFTS left 40px over scene (none ease).
Eyebrow SLIDES from left (power3.out).
Transition out: zoom-through, 0.45s — camera falls through the void into the
product.

## Scene 2 — THE FLIP (4.6–11.0s) [centerpiece]

Concept: same wait, but now it pays. A recreated dark chat window: prompt
lands, AI starts thinking, and the spinner line is replaced by a sponsored
pill whose earnings counter ticks up in real time. Money where boredom was.
Mood: product-real but heightened. The white adline pill glows like a chip
on a felt table.
Layout: split frame. Left 40%: headline stack. Right 60%: chat window card.
BG: green radial glow upper-right 18%, purple lower-left 12%, dotted grid
texture 14%, ghost "+$0.0007" mono strings drifting up slowly (3 of them,
staggered, 16-20% opacity).
MG-left: eyebrow "THE SPINNER, REPLACED"; headline Geist 800 84px:
"The wait" / "now pays." ("pays." in brand gradient pop). Mono sub
"50% of the winning bid is yours".
MG-right: chat card (#131a16, rule border, 20px radius, deep shadow,
perspective tilt rotationY -6 via gsap.set transformPerspective): fake
window chrome dots, user bubble (elev bg) "Write me a 10 page report on the
Wizard of Oz", then the ADLINE pill: white bg, pulsing green dot, "AD" mono
tag green, "Linear" bold dark, muted copy "The issue tracker teams actually
love", then green mono "$12.97 earned" + "+$0.0210 pending" — the earned
amount TICKS UP $12.97→$13.05 during the scene with little "+$0.0007"
floaters rising off it (gold/green, on tl).
FG: thin green progress line under the adline FILLS (scaleX, the 5s
impression timer), mono caption "1 IMPRESSION = 5s OF WAITING".
Choreography: chat card SWINGS in from right with tilt (power3.out 0.8s),
bubble DROPS (back.out(1.4)), adline pill SNAPS in with a scale pop
(back.out(2), 0.5s) + glow flare, counter TICKS (snap, steps), floaters
RISE+FADE (power1.out, staggered), headline words CASCADE from left
(expo.out, 90ms stagger), gradient word arrives last with slight overshoot.
Transition out: vertical push, 0.5s power3.inOut — slide up to the receipts.

## Scene 3 — THE PROOF (11.0–15.4s)

Concept: open the extension and the meter is real. Count-up to $13.07,
stats lock in, the Cash out button begs to be pressed. The viewer should
feel "that's actual money."
Mood: casino cashier window. Gold enters the palette here.
Layout: split. Right 45%: extension popup card. Left 55%: claim headline.
BG: gold radial glow lower-right 15% + green upper-left, ghost "$" Geist 800
at 420px 12% opacity behind popup, drifting. 6 coin dots (gold, blurred
edges) DRIFT upward at varying speeds (on tl, finite).
MG-left: eyebrow "YOUR CUT"; headline 96px "You keep" / "50%." (50% in gold
gradient #ffd96b→#f0a800, glow). Mono sub "of every ad dollar. Cash out from
$10."
MG-right: popup card (#131a16, rule border, radius 18, glow shadow): header
logo dot + "kolex" + green toggle; "YOUR EARNINGS" mono label; $13.07 mono
800 64px green with glow COUNTS UP from $0.00 (1.4s, power1.out snap);
"+$0.0166 earning now" green pill; 3 stat cells: 1,251 IMPRESSIONS /
37 CLICKS / 4 LIVE ADS (count up, staggered); full-width Cash out → button
(green gradient, dark text) that PULSES scale 1→1.03 (sine, finite).
FG: mono footer "LINKED · PAID VIA STRIPE" hairline above it.
Choreography: popup RISES from below with overshoot (back.out(1.2), 0.7s),
amount COUNTS UP, stat cells STAMP in (scale 1.15→1, power4.out, 110ms
stagger), headline SLIDES from left (expo.out), "50%." STAMPS (scale 1.6→1
power4.out + glow flare), coins FLOAT (sine.inOut).
Transition out: overexposure burn tinted #eafff4, 0.55s — the money flash
into the brand card.

## Scene 4 — THE CTA (15.4–20.0s)

Concept: the brand card. Logo mark slams down like a chip on the table,
name, one-line promise, CTA. Hold, breathe, fade to black.
Mood: title-card finality. Everything centered for the only time.
BG: deep green-black radial vignette, two glows (green top, purple bottom)
at 16%, hairline ring around logo (scale draw), corner marks + mono
"CHROME · CHATGPT · CLAUDE · GEMINI · GROK".
MG: Kolex mark (favicon SVG, green rounded square, 168px) SLAMS in (scale
2.2→1, power4.out, with glow flare ring ripple). Wordmark "kolex" Geist 800
112px. Headline 72px: "Get paid for waiting." (paid in gradient pop).
CTA pill button "Add to Chrome, free" (green gradient) + mono "kolex.ai".
FG: ambient logo glow breath.
Choreography: mark SLAMS (power4.out 0.5s) + ring RIPPLES outward, wordmark
letters RISE staggered 40ms (expo.out), headline FADES+RISES (power2.out),
CTA POPS (back.out(1.7)) then pulses subtly, url TYPES on. Final scene only:
everything FADES to black 19.2→19.9s (power1.in) with tl.set kills.

## Recurring motifs

Pulsing green dot (eyebrow S1, adline S2, popup header S3, button S4).
Mono money strings. Hairline rules. Green glow breathing.

## Negative prompt

No light mode. No em-dashes in copy. No red except never. No flat gray. No
web-scale type. No screenshots of the real recording — recreate UI. No
infinite repeats. No bare gsap.to ambient motion.
