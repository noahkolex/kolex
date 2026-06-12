// Records a screen capture of the REAL Kolex overlay working on faithful local
// simulations of ChatGPT and Claude, across several prompts. Output: a .webm in
// demo/recordings/.
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const OUT = path.resolve("demo/recordings");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
});
const p = await ctx.newPage();
const fileURL = (rel) => pathToFileURL(path.resolve(rel)).href;
const ask = (prompt, answer, think = 6500) =>
  p.evaluate(({ prompt, answer, think }) => window.__ask(prompt, answer, think), { prompt, answer, think });

// ── ChatGPT ──
await p.goto(fileURL("demo/chatgpt-demo.html"));
await p.waitForTimeout(1300);
await ask(
  "Write me a detailed launch plan for our new product.",
  "Here's a phased launch plan. Phase 1: lock positioning, pricing, and the waitlist. Phase 2: seed early users and gather testimonials. Phase 3: public launch across Product Hunt, X, and email. Each phase has an owner and a clear success metric.",
);
await p.waitForTimeout(700);
await ask(
  "Now turn that into a one-week content calendar.",
  "Monday: teaser post and waitlist open. Tuesday: founder thread on the problem. Wednesday: a short demo video. Thursday: customer quote. Friday: launch-day countdown and CTA.",
);
await p.waitForTimeout(1100);

// ── Claude ──
await p.goto(fileURL("demo/claude-demo.html"));
await p.waitForTimeout(1300);
await ask(
  "Summarize this 40-page contract into the key risks.",
  "Three risks stand out. First, the auto-renewal clause locks you in for another year unless you cancel 90 days early. Second, liability is capped at one month of fees. Third, the IP assignment is broader than typical. I'd push back on all three.",
);
await p.waitForTimeout(700);
await ask(
  "Draft a polite email to renegotiate the renewal terms.",
  "Subject: Quick question on our renewal. Hi Sam, thanks for the great year. Before we renew, could we adjust two terms: a 30-day cancellation window and a higher liability cap? Happy to hop on a call this week.",
);
await p.waitForTimeout(1400);

await ctx.close(); // finalizes the recording
await browser.close();

const vids = fs.readdirSync(OUT).filter((f) => f.endsWith(".webm"));
const latest = vids.map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
if (latest) {
  const dst = path.join(OUT, "kolex-extension-demo.webm");
  fs.renameSync(path.join(OUT, latest.f), dst);
  console.log("saved:", dst, "(" + Math.round(fs.statSync(dst).size / 1024) + " KB)");
}
