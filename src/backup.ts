import { DatabaseSync, backup } from "node:sqlite";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

// Online SQLite backup includes committed WAL data without stopping the reader.
export async function createBackup(source: string, directory: string, keep = 30) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("BACKUP_KEEP must be a positive integer");
  if (resolve(source) === resolve(directory)) throw new Error("Backup directory must differ from the database");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = await mkdtemp(join(directory, ".backup-"));
  try {
    const snapshot = join(temporary, "solar.db");
    const sourceDb = new DatabaseSync(source, { readOnly: true });
    try { sourceDb.exec("PRAGMA busy_timeout = 30000"); await backup(sourceDb, snapshot); }
    finally { sourceDb.close(); }
    const check = new DatabaseSync(snapshot, { readOnly: true });
    try {
      const result = check.prepare("PRAGMA quick_check").all();
      if (result.length !== 1 || Object.values(result[0])[0] !== "ok") throw new Error("SQLite backup integrity check failed");
    } finally { check.close(); }
    const name = `solar-${new Date().toISOString().replaceAll(":", "-")}.db.gz`;
    const archive = join(temporary, name);
    await pipeline(createReadStream(snapshot), createGzip(), createWriteStream(archive, { mode: 0o600, flags: "wx" }));
    const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
    const path = join(directory, name);
    await rename(archive, path);
    // Prune only files produced by this routine, after the new copy is complete.
    const copies = (await readdir(directory)).filter(n => /^solar-\d{4}-\d{2}-\d{2}T[\d.-]+Z\.db\.gz$/.test(n)).sort().reverse();
    for (const old of copies.slice(keep)) await rm(join(directory, old));
    return { path, name, sha256 };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
