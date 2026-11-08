// History on disk. Every reading is kept; day, month and year totals come from
// the inverter's own counters, so they stay right even when polls are missed.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Reading } from "./inverter.ts";
import { dayKey, monthKey, previousDay, previousMonth, previousYear, yearKey } from "./time.ts";

export type Total = { key: string; kwh: number };

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS readings (
        ts INTEGER PRIMARY KEY, day TEXT NOT NULL,
        ac_w REAL, pv_w REAL, today_kwh REAL, total_kwh REAL,
        pv1_v REAL, pv1_a REAL, pv2_v REAL, pv2_a REAL,
        grid_v REAL, grid_hz REAL, temp_c REAL, status INTEGER
      );
      CREATE INDEX IF NOT EXISTS readings_day ON readings(day);
      CREATE TABLE IF NOT EXISTS days   (key TEXT PRIMARY KEY, kwh REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS months (key TEXT PRIMARY KEY, kwh REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS years  (key TEXT PRIMARY KEY, kwh REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS meta   (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  save(r: Reading): void {
    this.db.prepare(`INSERT OR REPLACE INTO readings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      r.ts, dayKey(r.ts), r.acW, r.pvW, r.todayKwh, r.totalKwh,
      r.strings[0].v, r.strings[0].a, r.strings[1].v, r.strings[1].a,
      r.gridV, r.gridHz, r.tempC, r.status,
    );
    const put = (table: string, key: string, kwh: number) =>
      this.db.prepare(`INSERT OR REPLACE INTO ${table} (key, kwh) VALUES (?, ?)`).run(key, kwh);
    put("days", dayKey(r.ts), r.todayKwh);
    put("days", previousDay(r.ts), r.yesterdayKwh);
    put("months", monthKey(r.ts), r.monthKwh);
    put("months", previousMonth(r.ts), r.lastMonthKwh);
    put("years", yearKey(r.ts), r.yearKwh);
    // A zero last year just means the plant is newer than that; don't invent a bar.
    if (r.lastYearKwh > 0) put("years", previousYear(r.ts), r.lastYearKwh);
    this.db.prepare(`INSERT OR REPLACE INTO meta VALUES ('latest', ?)`).run(JSON.stringify(r));
  }

  // Manual entry of a past total (e.g. copied from the inverter's energy records).
  setTotal(table: "days" | "months" | "years", key: string, kwh: number): void {
    this.db.prepare(`INSERT OR REPLACE INTO ${table} (key, kwh) VALUES (?, ?)`).run(key, kwh);
  }

  latest(): Reading | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'latest'`).get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Reading) : null;
  }

  // One point per minute: [ts, acW, pvW].
  dayCurve(day: string): Array<[number, number, number]> {
    const rows = this.db.prepare(`
      SELECT MIN(ts) AS ts, AVG(ac_w) AS ac, AVG(pv_w) AS pv FROM readings
      WHERE day = ? GROUP BY ts / 60000 ORDER BY ts`).all(day) as Array<{ ts: number; ac: number; pv: number }>;
    return rows.map((r) => [r.ts, Math.round(r.ac), Math.round(r.pv)]);
  }

  totals(table: "days" | "months" | "years", from = ""): Total[] {
    return this.db.prepare(`SELECT key, kwh FROM ${table} WHERE key >= ? ORDER BY key`).all(from) as Total[];
  }
}
