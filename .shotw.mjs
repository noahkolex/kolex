import { chromium } from 'playwright';
const url = process.argv[2];
const widths = [360, 390, 430];
const browser = await chromium.launch();
for (const w of widths) {
  const ctx = await browser.newContext({ viewport:{width:w,height:880}, deviceScaleFactor:2, isMobile:true, hasTouch:true });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil:'load' });
  await page.waitForTimeout(900);
  const m = await page.evaluate(() => ({ sw: document.body.scrollWidth, iw: window.innerWidth }));
  console.log(`width ${w}: bodyScrollWidth=${m.sw} viewport=${m.iw} ${m.sw>m.iw?'OVERFLOW':'ok'}`);
  await page.screenshot({ path:`/tmp/live-${w}.png` });
  await ctx.close();
}
await browser.close();
