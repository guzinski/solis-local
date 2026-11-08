// Timeline of Modbus connection attempts for one day, for diagnosing the stick.
// Read-only: it only reads the local database.
//
//   node scripts/attempts.ts [YYYY-MM-DD] [--all]   (default: today; --all includes successes)
import { DatabaseSync } from "node:sqlite";
import { loadEnv } from "../src/env.ts";

loadEnv();
const args = process.argv.slice(2);
const all = args.includes("--all");
const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? new Date().toLocaleDateString("sv");
const db = new DatabaseSync(process.env.DB_PATH ?? "data/solar.db", { readOnly: true });

if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attempts'`).get()) {
  console.log("no attempts table yet: start the server once (npm start) and it will be created");
  process.exit(0);
}

const from = new Date(`${day}T00:00:00`).getTime();
const to = from + 86_400_000;
type Row = {
  ts: number; attempt: number; ok: number; phase: string; code: string | null; error: string | null;
  connect_ms: number | null; total_ms: number | null; local_port: number | null; bytes: number;
  reused?: number | null; conn_reads?: number | null; conn_age_ms?: number | null; host?: string | null;
};
const rows = db.prepare(`SELECT * FROM attempts WHERE ts >= ? AND ts < ? ORDER BY ts`).all(from, to) as Row[];
const time = (ts: number) => new Date(ts).toLocaleTimeString("sv");

if (rows.length === 0) {
  console.log(`no attempts logged on ${day}`);
  process.exit(0);
}

const ok = rows.filter((r) => r.ok).length;
console.log(`${day}: ${rows.length} attempts, ${ok} ok, ${rows.length - ok} failed`);
const byCode = new Map<string, number>();
for (const r of rows) if (!r.ok) byCode.set(`${r.code ?? r.error} @${r.phase}`, (byCode.get(`${r.code ?? r.error} @${r.phase}`) ?? 0) + 1);
for (const [k, n] of byCode) console.log(`  ${n}x ${k}`);
const connects = rows.filter((r) => r.connect_ms !== null).map((r) => r.connect_ms as number).sort((a, b) => a - b);
if (connects.length) console.log(`  connect ms: median ${connects[connects.length >> 1]}, max ${connects[connects.length - 1]}`);
console.log("");

// Connection opens/closes, merged into the timeline (table exists from the persistent-connection version on).
type Ev = { ts: number; kind: string; detail: string };
const hasEvents = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'link_events'`).get();
const events = hasEvents ? (db.prepare(`SELECT ts, kind, detail FROM link_events WHERE ts >= ? AND ts < ? ORDER BY ts`).all(from, to) as Ev[]) : [];
const kinds = new Map<string, number>();
for (const e of events) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
if (kinds.size) console.log(`  connections: ${[...kinds].map(([k, n]) => `${n}x ${k}`).join(", ")}\n`);
const timeline: Array<{ ts: number; row?: Row; ev?: Ev }> = [
  ...rows.map((row) => ({ ts: row.ts, row })),
  ...events.map((ev) => ({ ts: ev.ts, ev })),
].sort((a, b) => a.ts - b.ts);

let lastOk: number | null = null;
for (const item of timeline) {
  if (item.ev) {
    console.log(`${time(item.ev.ts)}  ---- connection ${item.ev.kind}: ${item.ev.detail}`);
    continue;
  }
  const r = item.row as Row;
  if (r.ok) {
    lastOk = r.ts;
    const conn = r.reused ? `reused (read ${r.conn_reads}, open ${Math.round((r.conn_age_ms ?? 0) / 1000)} s)` : `new conn ${r.connect_ms} ms`;
    if (all) console.log(`${time(r.ts)}  ok   #${r.attempt} ${conn}, total ${r.total_ms} ms, port ${r.local_port}`);
    continue;
  }
  const since = lastOk ? ` (${Math.round((r.ts - lastOk) / 1000)} s after last ok)` : "";
  console.log(`${time(r.ts)}  FAIL #${r.attempt} at ${r.phase}: ${r.error} [${r.total_ms ?? "?"} ms, ${r.bytes} B]${since}`);
}
