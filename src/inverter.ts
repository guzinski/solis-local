// Decodes the live block of a Solis grid-tied string inverter (FC04, 0-based
// wire addresses, as used by the solis_modbus Home Assistant integration).
// Addresses marked "inferred" were placed by matching live values, not taken
// from the published map.
export const BLOCK_START = 2999;
export const BLOCK_COUNT = 46;

export type Reading = {
  ts: number;
  acW: number;          // output to the house/grid
  pvW: number;          // solar input (DC)
  todayKwh: number;
  yesterdayKwh: number;
  monthKwh: number;
  lastMonthKwh: number;
  yearKwh: number;
  lastYearKwh: number;
  totalKwh: number;
  strings: Array<{ v: number; a: number }>;
  gridV: number;        // inferred address
  gridHz: number;
  tempC: number;
  status: number;
};

export function decode(regs: number[], ts = Date.now()): Reading {
  const at = (addr: number) => regs[addr - BLOCK_START];
  const u32 = (addr: number) => at(addr) * 65536 + at(addr + 1);
  const s16 = (addr: number) => (at(addr) > 0x7fff ? at(addr) - 0x10000 : at(addr));
  const tenth = (n: number) => Math.round(n) / 10;
  return {
    ts,
    acW: u32(3004),
    pvW: u32(3006),
    totalKwh: u32(3008),
    monthKwh: u32(3010),
    lastMonthKwh: u32(3012),
    todayKwh: tenth(at(3014)),
    yesterdayKwh: tenth(at(3015)),
    yearKwh: u32(3016),
    lastYearKwh: u32(3018),
    strings: [
      { v: tenth(at(3021)), a: tenth(at(3022)) },
      { v: tenth(at(3023)), a: tenth(at(3024)) },
    ],
    gridV: tenth(at(3035)),
    tempC: tenth(s16(3041)),
    gridHz: at(3042) / 100,
    status: at(3043),
  };
}

// Rejects frames that decode to impossible values (a garbled or misaligned read).
export function plausible(r: Reading): boolean {
  return (
    r.acW <= 100_000 && r.pvW <= 120_000 && r.todayKwh <= 1_000 &&
    r.totalKwh < 10_000_000 && r.gridHz < 70 && r.tempC > -40 && r.tempC < 120
  );
}
