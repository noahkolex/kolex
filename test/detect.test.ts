import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isBusy,
  sanitizeSites,
  siteForHost,
  DEFAULT_SITES,
} from "../src/shared/detect.js";

test("hosts map to their surface", () => {
  assert.equal(siteForHost("chatgpt.com")?.surface, "chatgpt");
  assert.equal(siteForHost("chat.openai.com")?.surface, "chatgpt");
  assert.equal(siteForHost("claude.ai")?.surface, "claude");
  assert.equal(siteForHost("gemini.google.com")?.surface, "gemini");
  assert.equal(siteForHost("grok.com")?.surface, "grok");
  assert.equal(siteForHost("x.com")?.surface, "grok");
  assert.equal(siteForHost("example.com"), undefined);
});

test("every default site has busy and spinner selectors", () => {
  for (const site of DEFAULT_SITES) {
    assert.ok(site.busySelectors.length > 0, `${site.surface} has busy selectors`);
    assert.ok(Array.isArray(site.spinnerSelectors), `${site.surface} has spinner selectors`);
  }
});

test("isBusy is true when any selector matches", () => {
  const site = DEFAULT_SITES[0]!;
  assert.equal(isBusy(site, (sel) => sel === 'button[data-testid="stop-button"]'), true);
  assert.equal(isBusy(site, () => false), false);
});

test("a throwing selector never breaks detection", () => {
  const site = DEFAULT_SITES[0]!;
  const busy = isBusy(site, (sel) => {
    if (sel.startsWith("button")) throw new Error("bad selector");
    return sel === ".result-streaming";
  });
  assert.equal(busy, true);
});

test("sanitizeSites rejects malformed remote config", () => {
  const sites = sanitizeSites([
    { surface: "chatgpt", hosts: ["chatgpt.com"], busySelectors: [".x"] },
    { surface: "evil", hosts: ["chatgpt.com"], busySelectors: [".x"] },
    { surface: "claude", hosts: "claude.ai", busySelectors: [".x"] },
    null,
  ]);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.surface, "chatgpt");
  assert.deepEqual(sites[0]?.spinnerSelectors, []);
});
