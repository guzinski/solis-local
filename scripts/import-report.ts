// Import SolisCloud "Plant Report" exports (.xls) into the local history.
// A yearly report ("Time" = 2026) gives monthly totals; a monthly report
// ("Time" = 01/2026) gives daily totals. Only the period and energy columns are
// read; the name, address and contact fields in the export are ignored.
//
//   node scripts/import-report.ts ~/Downloads/Plant+Report_*.xls
import { createRequire } from "node:module";
import { loadEnv } from "../src/env.ts";
import { Store } from "../src/store.ts";

const XLSX = createRequire(import.meta.url)("xlsx") as typeof import("xlsx");
type Cell = string | number;

loadEnv();
const store = new Store(process.env.DB_PATH ?? "data/solar.db");
const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node scripts/import-report.ts <report.xls> [...]");
  process.exit(2);
}

for (const file of files) {
  const book = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json<Cell[]>(book.Sheets[book.SheetNames[0]], { header: 1, raw: true, defval: "" });
  const headerAt = rows.findIndex((r) => r[0] === "Time");
  const header = rows[headerAt] ?? [];
  const data = rows.slice(headerAt + 1).find((r) => String(r[0]).trim() !== "");
  if (headerAt < 0 || !data) {
    console.error(`${file}: not a SolisCloud plant report (no "Time" header row)`);
    continue;
  }

  const period = String(data[0]).trim();
  const monthly = /^(\d{2})\/(\d{4})$/.exec(period);  // daily values for one month
  const yearly = /^(\d{4})$/.exec(period);             // monthly values for one year
  if (!monthly && !yearly) {
    console.error(`${file}: unrecognised period "${period}"`);
    continue;
  }
  const table = monthly ? "days" : "months";
  const prefix = monthly ? `${monthly[2]}-${monthly[1]}` : yearly![1];
  const totalColumn = header.findIndex((h) => /^(Monthly|Annual) Yield\(kWh\)$/.test(String(h)));

  let saved = 0, sum = 0;
  header.forEach((h, i) => {
    if (!/^\d{2}$/.test(String(h))) return;
    const value = data[i];
    if (typeof value !== "number") return;   // blank before commissioning or in the future
    store.setTotal(table, `${prefix}-${h}`, value);
    saved++;
    sum += value;
  });
  const reported = typeof data[totalColumn] === "number" ? (data[totalColumn] as number) : null;
  console.log(
    `${period}: saved ${saved} ${monthly ? "days" : "months"}, ${sum.toFixed(1)} kWh` +
      (reported != null ? ` (report total ${reported} kWh${Math.abs(reported - sum) > 1 ? ", MISMATCH" : ""})` : ""),
  );
}
