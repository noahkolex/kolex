import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Ad } from "../src/shared/economics.js";
import { pickNextAd, sanitizeAds, HOUSE_ADS } from "../src/shared/inventory.js";

const ad = (id: string, bid: number, remaining = 1000): Ad => ({
  id,
  brand: id,
  text: "ten chars!",
  url: "https://example.com",
  bidPerBlock: bid,
  impressionsRemaining: remaining,
});

test("highest bid serves first", () => {
  const picked = pickNextAd([ad("low", 1), ad("high", 5), ad("mid", 3)], {});
  assert.equal(picked?.id, "high");
});

test("exhausted blocks drop out of the auction", () => {
  const picked = pickNextAd([ad("high", 5, 0), ad("mid", 3)], {});
  assert.equal(picked?.id, "mid");
});

test("tied bids round-robin by least served and avoid repeats", () => {
  const ads = [ad("a", 2), ad("b", 2)];
  const first = pickNextAd(ads, { a: 3, b: 1 });
  assert.equal(first?.id, "b");
  const next = pickNextAd(ads, { a: 1, b: 1 }, "b");
  assert.equal(next?.id, "a", "should not serve the same ad twice in a row");
});

test("single live ad keeps serving even back-to-back", () => {
  const picked = pickNextAd([ad("only", 2)], {}, "only");
  assert.equal(picked?.id, "only");
});

test("no live ads returns undefined", () => {
  assert.equal(pickNextAd([ad("a", 5, 0)], {}), undefined);
});

test("sanitizeAds drops malformed and non-https entries", () => {
  const good = ad("ok", 2);
  const ads = sanitizeAds([
    good,
    { ...ad("http", 2), url: "http://insecure.example" },
    { ...ad("short", 2), text: "ab" },
    { ...ad("neg", -1) },
    "garbage",
    null,
  ]);
  assert.deepEqual(ads.map((a) => a.id), ["ok"]);
});

test("house ads are always live", () => {
  for (const h of HOUSE_ADS) {
    assert.ok(h.house);
    assert.equal(h.bidPerBlock, 0);
    assert.ok(h.impressionsRemaining > 0);
    assert.ok(h.text.length >= 3 && h.text.length <= 60);
  }
});
