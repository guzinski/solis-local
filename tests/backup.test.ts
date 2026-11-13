import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { createBackup } from "../src/backup.ts";

test("backup restores committed WAL data while writer stays open; pruning preserves unrelated files", async t => {
  const dir = await mkdtemp(join(tmpdir(), "solar-backup-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "source.db"), output = join(dir, "copies");
  const writer = new DatabaseSync(source);
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE readings(ts INTEGER, pv1_v REAL); INSERT INTO readings VALUES (1, 285)");
    const first = await createBackup(source, output, 1);
    await writeFile(join(output, "unrelated.txt"), "keep");
    await writeFile(join(output, "solar-2000-01-01T00-00-00.000Z.db.gz"), "old copy");
    writer.exec("INSERT INTO readings VALUES (2, 290)");
    const latest = await createBackup(source, output, 1);
    const restoredPath = join(dir, "restored.db");
    await writeFile(restoredPath, gunzipSync(await readFile(latest.path)));
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    try { assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM readings").get()!.n, 2); }
    finally { restored.close(); }
    assert.deepEqual((await readdir(output)).sort(), [latest.name, "unrelated.txt"].sort());
    assert.equal(latest.sha256.length, 64);
    assert.ok(first.name);
  } finally { writer.close(); }
});
