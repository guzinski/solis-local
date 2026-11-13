import { readFile } from "node:fs/promises";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { loadEnv } from "../src/env.ts";
import { createBackup } from "../src/backup.ts";

loadEnv(); loadEnv(".env.backup.local");
try {
  const copy = await createBackup(process.env.DB_PATH || "data/solar.db", process.env.BACKUP_DIR || "data/backups", Number(process.env.BACKUP_KEEP || 30));
  console.log(`Local backup verified: ${copy.name}; SHA256 ${copy.sha256}`);
  if (process.env.BACKUP_R2_ENABLED === "true") {
    const { R2_ENDPOINT: endpoint, R2_BUCKET: bucket, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error("R2 backup enabled but configuration is incomplete; local copy retained");
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || !/^[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/.test(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid R2 endpoint");
    const client = new S3Client({ endpoint, region: "auto", credentials: { accessKeyId, secretAccessKey }, maxAttempts: 3 });
    try {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: `solar/${copy.name}`, Body: await readFile(copy.path), ContentType: "application/gzip", Metadata: { sha256: copy.sha256 } }), { abortSignal: AbortSignal.timeout(120_000) });
    } finally { client.destroy(); }
    console.log("R2 upload completed");
  } else console.log("R2 not enabled; local backup only");
} catch (error) {
  // SDK errors can include request details. Never print credentials or config.
  console.error(`Backup failed (${error instanceof Error ? error.name : "unknown error"}). Check local copies and backup configuration.`);
  process.exitCode = 1;
}
