import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";

test("string history averages instantaneous products and keeps absent input distinct from zero", () => {
  const store = new Store(":memory:");
  try {
    const put = store.db.prepare("INSERT INTO readings (ts, day, pv1_v, pv1_a, pv2_v, pv2_a) VALUES (?,?,?,?,?,?)");
    const ts = new Date(2026, 0, 15, 10).getTime();
    put.run(ts, "2026-01-15", 100, 2, null, null);
    put.run(ts + 1000, "2026-01-15", 200, 4, null, null);
    put.run(ts + 60000, "2026-01-15", 300, 0, 250, 4);
    put.run(ts + 86400000, "2026-01-16", 300, 8, 300, 8);
    assert.deepEqual(store.stringCurve("2026-01-15"), [[ts, 500, null], [ts + 60000, 0, 1000]]);
    assert.deepEqual(store.stringCurve("2025-01-01"), []);
  } finally { store.db.close(); }
});
