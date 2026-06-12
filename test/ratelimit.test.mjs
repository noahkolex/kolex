// Verifies the rate limiter actually throttles when enabled (it is off by
// default in dev/test, on in production or via KOLEX_RATE_LIMIT).
import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.KOLEX_ENV_FILE = "/dev/null";
process.env.STRIPE_MODE = "stub";
process.env.KOLEX_RATE_LIMIT = "on";
process.env.KOLEX_DB = path.join(os.tmpdir(), `kolex-rl-${process.pid}-${Date.now()}.json`);

const { app } = await import("../server/index.mjs");
const { reset } = await import("../server/db.mjs");

let server, base;
before(async () => {
  reset();
  await new Promise((r) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      r();
    });
  });
});
after(() => {
  server?.close();
  fs.rmSync(process.env.KOLEX_DB, { force: true });
});

test("login endpoint is throttled past its window limit (30/min)", async () => {
  let throttled = 0;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `x${i}@y.com`, kind: "user" }),
    });
    if (res.status === 429) throttled++;
  }
  assert.ok(throttled >= 5, `expected throttling, got ${throttled} × 429`);
});
