import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiagnosticLog } from "../src/diagnostics.ts";

test("diagnostics rotate bounded files and retain correlation and private permissions", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "solar-trace-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "trace.jsonl");
  const log = new DiagnosticLog(path, 500, 2);
  for (let i = 0; i < 20; i++) log.write({ event: "request", transaction: i, connection: "test" });
  assert.equal(readdirSync(dir).length, 3);
  const last = JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!);
  assert.equal(last.transaction, 19);
  assert.equal(last.run, log.run);
  assert.equal(last.connection, "test");
  assert.equal(typeof last.elapsedMs, "number");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
