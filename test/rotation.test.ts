import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Ad } from "../src/shared/economics.js";
import { MemoryKV } from "../src/shared/kv.js";
import { Rotation } from "../src/shared/rotation.js";

const paidAd = (id: string, bid: number, remaining = 1000): Ad => ({
  id,
  brand: id,
  text: "ten chars!",
  url: "https://example.com",
  bidPerBlock: bid,
  impressionsRemaining: remaining,
});

function makeRotation(startTs = 1_000_000) {
  let ts = startTs;
  let n = 0;
  const kv = new MemoryKV();
  const rotation = new Rotation(kv, () => ts, () => `evt-${n++}`);
  return { rotation, kv, advance: (ms: number) => (ts += ms) };
}

test("five contiguous seconds of ticks settles one impression", async () => {
  const { rotation, advance } = makeRotation();
  await rotation.setAds([paidAd("acme", 10)]);

  let impressions = 0;
  for (let i = 0; i < 6; i++) {
    const out = await rotation.tick("chatgpt");
    if (out.impressionRecorded) impressions++;
    advance(1_000);
  }
  assert.equal(impressions, 1);

  const summary = await rotation.summary();
  assert.equal(summary.totalImpressions, 1);
  // $10/block → $0.01 billed → $0.005 user share.
  assert.ok(Math.abs(summary.estEarnedUsd - 0.005) < 1e-9);
});

test("a gap in ticks stops the clock — no impression from idle time", async () => {
  const { rotation, advance } = makeRotation();
  await rotation.setAds([paidAd("acme", 10)]);

  await rotation.tick("chatgpt");
  advance(60_000); // user walked away / model finished
  await rotation.tick("chatgpt");
  advance(1_000);
  const out = await rotation.tick("chatgpt");
  assert.equal(out.impressionRecorded, false);
  assert.equal((await rotation.summary()).totalImpressions, 0);
});

test("impressions consume the purchased block and rotate the ad", async () => {
  const { rotation, advance } = makeRotation();
  await rotation.setAds([paidAd("solo", 10, 1)]);

  // Burn through the single remaining impression.
  for (let i = 0; i < 7; i++) {
    await rotation.tick("chatgpt");
    advance(1_000);
  }
  const ads = await rotation.getAds();
  const solo = ads.find((a) => a.id === "solo");
  assert.equal(solo?.impressionsRemaining, 0);

  // Next pick falls back to house inventory.
  const out = await rotation.tick("chatgpt");
  assert.ok(out.ad?.house, "exhausted paid ad should hand off to house ads");
});

test("clicks pay 50x and land in the ledger", async () => {
  const { rotation } = makeRotation();
  await rotation.setAds([paidAd("acme", 10)]);

  const payout = await rotation.click("acme", "claude");
  assert.equal(payout, 0.25);

  const summary = await rotation.summary();
  assert.equal(summary.totalClicks, 1);
  assert.equal(summary.pendingEvents, 1);
});

test("markSynced drains the pending queue idempotently", async () => {
  const { rotation } = makeRotation();
  await rotation.setAds([paidAd("acme", 10)]);
  await rotation.click("acme", "chatgpt");
  await rotation.click("acme", "chatgpt");

  const pending = await rotation.unsyncedEvents();
  assert.equal(pending.length, 2);
  await rotation.markSynced(pending.map((e) => e.id));
  assert.equal((await rotation.unsyncedEvents()).length, 0);
  await rotation.markSynced(pending.map((e) => e.id)); // no-op
  assert.equal((await rotation.unsyncedEvents()).length, 0);
});

test("empty backend inventory still serves house ads", async () => {
  const { rotation, advance } = makeRotation();
  await rotation.setAds([]);
  advance(1_000);
  const out = await rotation.tick("claude");
  assert.ok(out.ad?.house);
});
