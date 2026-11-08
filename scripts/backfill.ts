// Enter past totals the inverter no longer reports over Modbus, e.g. months
// copied from its screen (Advanced Info -> Energy Records). Safe to re-run;
// an entry for the same period is replaced. The inverter's own counters still
// win for today, yesterday, this/last month and this/last year.
//
//   node scripts/backfill.ts 2026-01=812 2026-02=745 ...     (months, kWh)
//   node scripts/backfill.ts 2026-10-15=48.2                  (a single day)
//   node scripts/backfill.ts --list                           (show what's stored)
import { loadEnv } from "../src/env.ts";
import { Store } from "../src/store.ts";

loadEnv();
const store = new Store(process.env.DB_PATH ?? "data/solar.db");
const args = process.argv.slice(2);

if (!args.length) {
  console.error("usage: node scripts/backfill.ts YYYY-MM=kWh [YYYY-MM-DD=kWh ...] | --list");
  process.exit(2);
}

if (args[0] !== "--list") {
  for (const arg of args) {
    const match = /^(\d{4}-(0[1-9]|1[0-2])(-\d{2})?)=(\d+(\.\d+)?)$/.exec(arg);
    if (!match) {
      console.error(`skipped "${arg}": expected YYYY-MM=kWh or YYYY-MM-DD=kWh`);
      continue;
    }
    const [, key, , day, kwh] = match;
    store.setTotal(day ? "days" : "months", key, Number(kwh));
    console.log(`saved ${key} = ${kwh} kWh`);
  }
}

const months = store.totals("months");
console.log("\nMonths stored:");
for (const m of months) console.log(`  ${m.key}  ${m.kwh} kWh`);
const latest = store.latest();
if (latest) {
  const year = new Date(latest.ts).getFullYear();
  const known = months.filter((m) => m.key.startsWith(`${year}-`)).reduce((sum, m) => sum + m.kwh, 0);
  console.log(`\n${year}: months add up to ${Math.round(known)} kWh; the inverter's year counter says ${latest.yearKwh} kWh` +
    (latest.yearKwh - known > Math.max(10, latest.yearKwh * 0.005) ? ` (${Math.round(latest.yearKwh - known)} kWh not split by month yet).` : "."));
}
