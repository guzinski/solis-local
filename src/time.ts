// Calendar keys in the server's local time zone (the plant's), e.g. "2026-11-07".
export const dayKey = (ts: number) => new Date(ts).toLocaleDateString("sv-SE");
export const monthKey = (ts: number) => dayKey(ts).slice(0, 7);
export const yearKey = (ts: number) => dayKey(ts).slice(0, 4);

export function previousDay(ts: number): string {
  const d = new Date(ts);
  d.setDate(d.getDate() - 1);
  return dayKey(d.getTime());
}

export function previousMonth(ts: number): string {
  const d = new Date(ts);
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return monthKey(d.getTime());
}

export const previousYear = (ts: number) => String(Number(yearKey(ts)) - 1);
