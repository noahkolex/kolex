import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  clickPayout,
  formatUsd,
  impressionPayout,
  type Ad,
} from "../src/shared/economics.js";

const ad = (bid: number): Ad => ({
  id: "a",
  brand: "B",
  text: "ten chars!",
  url: "https://example.com",
  bidPerBlock: bid,
  impressionsRemaining: 1000,
});

test("impression payout is half the per-impression bid", () => {
  // $10 per 1,000-impression block → $0.01/impression billed → $0.005 to user.
  assert.equal(impressionPayout(ad(10)), 0.005);
});

test("click pays 50x the impression rate", () => {
  assert.equal(clickPayout(ad(10)), 0.25);
});

test("house ads pay nothing", () => {
  assert.equal(impressionPayout(ad(0)), 0);
  assert.equal(clickPayout(ad(0)), 0);
});

test("formatUsd switches precision for sub-cent amounts", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.005), "$0.0050");
  assert.equal(formatUsd(1.5), "$1.50");
});
