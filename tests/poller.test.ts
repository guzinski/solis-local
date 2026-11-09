import assert from "node:assert/strict";
import { test } from "node:test";
import { Poller } from "../src/poller.ts";
import { Store } from "../src/store.ts";
import { newTrace } from "../src/modbus.ts";
import type { Config } from "../src/env.ts";

const config: Config = { stickHost: "test.invalid", stickPort: 502, stickUnit: 1,
  pollSeconds: 300, replyTimeoutMs: 120_000, diagnosticPath: null, alertMinutes: 0,
  plantName: "test", plantKwp: null, httpHost: "127.0.0.1", httpPort: 3100, dbPath: ":memory:" };

test("experiment makes only one attempt per tick and passes the longer reply deadline", async (t) => {
  const store = new Store(":memory:");
  const poller = new Poller(config, store);
  t.after(async () => { await poller.stop(); store.db.close(); });
  let reads = 0;
  t.mock.method(poller.conn, "read", async (req: { replyTimeoutMs: number }) => {
    reads++; assert.equal(req.replyTimeoutMs, 120_000); throw new Error("timed out");
  });
  t.mock.method(poller, "failed", async () => {});
  await poller.tick();
  assert.equal(reads, 1);
});

test("stop cancels a pending normal-mode retry", async (t) => {
  const store = new Store(":memory:");
  const poller = new Poller({ ...config, replyTimeoutMs: 10_000 }, store);
  t.after(async () => { await poller.stop(); store.db.close(); });
  let attempts = 0;
  t.mock.method(poller, "attempt", async () => {
    attempts++;
    return { err: new Error("refused"), code: "ECONNREFUSED", trace: newTrace() };
  });
  const tick = poller.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await poller.stop();
  await tick;
  assert.equal(attempts, 1);
  await poller.tick();
  assert.equal(attempts, 1);
});
