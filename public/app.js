// Solar dashboard: live values, a day power curve and energy totals.
// No dependencies and no third-party requests; everything comes from /api/*.
import { barChart, lineChart } from "./charts.js";

const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("en-US");
const SVG = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="color:var(--sun)"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="currentColor" style="color:var(--idle)"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="color:var(--warning)"><path d="M12 3 2 21h20L12 3Z" fill="currentColor" stroke="none"/><path d="M12 10v5M12 18v.01" stroke="#0b0b0b"/></svg>',
  wait: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="none" stroke="var(--idle)" stroke-width="2"/></svg>',
  dot: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="var(--good)"/></svg>',
};
const STATUS_NAMES = { 0: "Waiting", 1: "Open loop", 2: "Soft start", 3: "Generating" };

const state = { day: dayKey(new Date()), period: "days", month: dayKey(new Date()).slice(0, 7), year: String(new Date().getFullYear()), live: null, totals: null };

// ---------- formatting ----------
function dayKey(d) { return d.toLocaleDateString("sv-SE"); }
function parseDay(key) { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); }
function shiftDay(key, by) { const d = parseDay(key); d.setDate(d.getDate() + by); return dayKey(d); }
function time(ts) { return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); }
function power(w) {
  if (w == null) return ["—", ""];
  return w >= 1000 ? [(w / 1000).toFixed(2), "kW"] : [String(Math.round(w)), "W"];
}
function energy(kwh) {
  if (kwh == null) return ["—", ""];
  return [kwh < 100 ? kwh.toFixed(1) : number.format(Math.round(kwh)), "kWh"];
}
// Specific yield: energy per kWp of panels (equivalent full-sun hours).
function perKwp(kwh) {
  const kwp = state.live?.plantKwp;
  if (!kwp || kwh == null) return null;
  const v = kwh / kwp;
  return `${v < 10 ? v.toFixed(2) : number.format(Math.round(v))} kWh/kWp`;
}
function setYield(id, kwh) {
  const value = perKwp(kwh);
  $(id).hidden = !value;
  $(id).textContent = value ?? "";
}
function withUnit([value, unit]) { return unit ? `${value}<span class="unit">${unit}</span>` : value; }
function text([value, unit]) { return unit ? `${value} ${unit}` : value; }
function dayLabel(key) {
  const today = dayKey(new Date());
  if (key === today) return "Today";
  if (key === shiftDay(today, -1)) return "Yesterday";
  return parseDay(key).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// ---------- data ----------
async function get(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// ---------- live ----------
function duration(ms) {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

function linkStatus(live) {
  const { link, reading } = live;
  if (!link.checked) return { icon: SVG.wait, text: "Connecting…" };
  if (!reading) return { icon: SVG.alert, text: link.lastError ? "Can't reach the datalogger" : "Waiting for first reading" };
  if (link.online) {
    const name = STATUS_NAMES[reading.status];
    return reading.status === 3
      ? { icon: SVG.sun, text: "Generating" }
      : { icon: SVG.dot, text: name ?? `Online · status ${reading.status}` };
  }
  // A grid-tied inverter powers the stick from the panels, so it's off at night.
  const hour = new Date().getHours();
  const night = reading.pvW < 300 || hour < 6 || hour >= 19;
  if (night) return { icon: SVG.moon, text: "Asleep · no sun" };
  const since = time(link.lastSeen ?? reading.ts);
  if (link.diagnosis === "busy") return { icon: SVG.wait, text: `Stick busy · retrying (last reading ${since})` };
  if (link.diagnosis === "modbus-down") return { icon: SVG.alert, text: `Stick stopped serving readings at ${since} · unplug it for 10 s` };
  if (link.diagnosis === "unreachable") return { icon: SVG.alert, text: `Stick not on the network since ${since} · searching` };
  return { icon: SVG.alert, text: `Stick not answering since ${since}` };
}

function renderLive(live) {
  state.live = live;
  $("plant-name").textContent = live.plantName;
  document.title = `${live.plantName} · Solar`;
  const status = linkStatus(live);
  $("status").querySelector(".status-icon").innerHTML = status.icon;
  $("status").querySelector(".status-text").textContent = status.text;

  const r = live.reading;
  const online = live.link.online;
  $("now-label").textContent = online ? "Output now" : "Last output";
  document.querySelector(".hero").classList.toggle("stale", !online);
  // Offline at night really is 0 W; offline in daylight means we don't know.
  const asleep = status.text.startsWith("Asleep");
  $("now-power").innerHTML = withUnit(power(r && live.link.checked ? (online ? r.acW : asleep ? 0 : null) : null));
  $("now-sub").textContent = r
    ? online
      ? `Solar input ${text(power(r.pvW))} · updated ${time(r.ts)}`
      : asleep || Date.now() - r.ts < 15 * 60_000
        ? `Last reading ${dayLabel(dayKey(new Date(r.ts))).toLowerCase()} at ${time(r.ts)} (${text(power(r.acW))})`
        : `No readings for ${duration(Date.now() - r.ts)}. Unplug the stick for 10 s and plug it back in.`
    : "No readings yet";
  $("today-kwh").innerHTML = withUnit(energy(r ? live.todayKwh : null));
  $("yesterday").textContent = r ? `Yesterday ${text(energy(r.yesterdayKwh))}` : " ";
  $("month-kwh").innerHTML = withUnit(energy(r?.monthKwh));
  $("last-month").textContent = r ? `Last month ${text(energy(r.lastMonthKwh))}` : " ";
  $("year-kwh").innerHTML = withUnit(energy(r?.yearKwh));
  $("last-year").textContent = r && r.lastYearKwh > 0 ? `Last year ${text(energy(r.lastYearKwh))}` : "First year";
  $("total-kwh").innerHTML = withUnit(energy(r?.totalKwh));
  setYield("today-yield", r ? live.todayKwh : null);
  setYield("month-yield", r?.monthKwh);
  setYield("year-yield", r?.yearKwh);
  setYield("total-yield", r?.totalKwh);
  $("capacity").textContent = live.plantKwp ? `${live.plantKwp} kWp installed` : "since install";
  const showMeter = Boolean(live.plantKwp && r && online);
  $("meter").hidden = !showMeter;
  if (showMeter) {
    const pct = (r.acW / (live.plantKwp * 1000)) * 100;
    $("meter-fill").style.width = `${Math.min(100, pct)}%`;
    $("meter-label").textContent = `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}% of ${live.plantKwp} kWp`;
  }

  const rows = (pairs) => pairs.map(([k, v, note]) =>
    `<tr><th>${k}</th><td>${v}${note ? ` <span class="note">${note}</span>` : ""}</td></tr>`).join("");
  $("strings").tBodies[0].innerHTML = r
    ? rows(r.strings.map((s, i) => [`String ${i + 1}`, `${text(power(s.v * s.a))}`, `${s.v.toFixed(1)} V · ${s.a.toFixed(1)} A`]))
    : rows([["No data yet", "—"]]);
  $("inverter").tBodies[0].innerHTML = r
    ? rows([
        ["Grid voltage", `${r.gridV.toFixed(1)} V`],
        ["Grid frequency", `${r.gridHz.toFixed(2)} Hz`],
        ["Temperature", `${r.tempC.toFixed(1)} °C`],
        ["Inverter status", STATUS_NAMES[r.status] ?? "Unknown", `code ${r.status}`],
        ["Last reading", `${time(r.ts)}`, dayLabel(dayKey(new Date(r.ts))).toLowerCase()],
      ])
    : rows([["No data yet", "—"]]);
  $("foot").textContent = `Local only · read from the datalogger every ${live.pollSeconds} s, no cloud.`;
}

// ---------- power curve ----------
async function renderDay() {
  const today = dayKey(new Date());
  $("day-label").textContent = dayLabel(state.day);
  $("day-next").disabled = state.day >= today;
  const data = await get(`/api/day?date=${state.day}`);
  const start = parseDay(state.day).getTime();
  const gapMs = Math.max(5 * 60_000, 3 * (state.live?.pollSeconds ?? 60) * 1000);
  $("power-sub").textContent = data.kwh != null
    ? `Inverter output · ${text(energy(data.kwh))} produced`
    : "Inverter output through the day";
  lineChart($("power-chart"), {
    points: data.points.map(([ts, ac]) => [ts, ac]),
    // Daylight window by default; widened if the data reaches further.
    xMin: start + 5 * 3_600_000,
    xMax: start + 20 * 3_600_000,
    gapMs,
    yFormat: (w) => (w >= 1000 ? `${number.format(w / 1000)}k` : String(w)),
    tip: ([ts, w]) => `<strong>${text(power(w))}</strong>${time(ts)}`,
    empty: state.day === today
      ? "No readings yet today. The curve fills in as the sun comes up."
      : data.kwh != null
        ? `No power curve for this day; only its total (${text(energy(data.kwh))}) is known. Curves exist from the day this app started recording.`
        : "No readings recorded for this day.",
  });
  // Table: one row per 15 minutes keeps it readable.
  const rows = [];
  let lastSlot = -1;
  for (const [ts, ac] of data.points) {
    const slot = Math.floor(ts / 900_000);
    if (slot !== lastSlot) { rows.push(`<tr><td>${time(ts)}</td><td>${text(power(ac))}</td></tr>`); lastSlot = slot; }
  }
  $("power-table").innerHTML = rows.length
    ? `<div class="scroll"><table><thead><tr><th>Time</th><th>Output</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : "<p>No readings.</p>";
}

// ---------- energy bars ----------
function periodItems(totals, period) {
  const now = new Date();
  const lookup = new Map(totals[period].map((t) => [t.key, t.kwh]));
  const items = [];
  if (period === "days") {
    const [y, m] = state.month.split("-").map(Number);
    const length = new Date(y, m, 0).getDate();
    for (let day = 1; day <= length; day++) {
      const d = new Date(y, m - 1, day);
      const key = dayKey(d);
      items.push({
        key, value: lookup.get(key) ?? null,
        label: String(day),
        title: d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
      });
    }
  } else if (period === "months") {
    for (let month = 0; month < 12; month++) {
      const d = new Date(Number(state.year), month, 1);
      const key = dayKey(d).slice(0, 7);
      items.push({
        key, value: lookup.get(key) ?? null,
        label: d.toLocaleDateString("en-US", { month: "short" }),
        title: d.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      });
    }
  } else {
    const first = Math.min(now.getFullYear(), ...totals.years.map((t) => Number(t.key)));
    for (let y = Math.max(first, now.getFullYear() - 9); y <= now.getFullYear(); y++) {
      items.push({ key: String(y), value: lookup.get(String(y)) ?? null, label: String(y), title: String(y) });
    }
  }
  return items;
}

const PERIOD_SUB = { days: "Daily yield", months: "Monthly yield", years: "Yearly yield" };

// Earliest period that has data, so the back arrow stops there.
function firstKey(period) {
  const keys = state.totals?.[period]?.map((t) => t.key) ?? [];
  return keys.length ? keys[0] : null;
}
function shiftMonth(key, by) { const [y, m] = key.split("-").map(Number); return dayKey(new Date(y, m - 1 + by, 1)).slice(0, 7); }
function renderPeriodNav() {
  const nowMonth = dayKey(new Date()).slice(0, 7), nowYear = String(new Date().getFullYear());
  $("energy-nav").hidden = state.period === "years";
  if (state.period === "days") {
    const [y, m] = state.month.split("-").map(Number);
    $("energy-label").textContent = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    const first = firstKey("days")?.slice(0, 7) ?? nowMonth;
    $("energy-prev").disabled = state.month <= first;
    $("energy-next").disabled = state.month >= nowMonth;
  } else if (state.period === "months") {
    $("energy-label").textContent = state.year;
    const first = [firstKey("months"), firstKey("days")].filter(Boolean).map((k) => k.slice(0, 4)).sort()[0] ?? nowYear;
    $("energy-prev").disabled = state.year <= first;
    $("energy-next").disabled = state.year >= nowYear;
  }
}

function renderEnergy() {
  if (!state.totals) return;
  const items = periodItems(state.totals, state.period);
  $("energy-sub").textContent = PERIOD_SUB[state.period];
  renderPeriodNav();
  $("energy-note").hidden = true;
  const r = state.live?.reading;
  if (state.period === "months" && r && state.year === String(new Date(r.ts).getFullYear())) {
    // The inverter only reports this and last month; show what the year counter
    // says is missing rather than leaving earlier months silently blank.
    const year = String(new Date(r.ts).getFullYear());
    const known = state.totals.months.filter((m) => m.key.startsWith(`${year}-`)).reduce((sum, m) => sum + m.kwh, 0);
    const missing = r.yearKwh - known;
    // The inverter counts whole kWh, so ignore rounding-sized gaps.
    if (missing > Math.max(10, r.yearKwh * 0.005)) {
      const firstKnown = state.totals.months.find((m) => m.key.startsWith(`${year}-`))?.key;
      const until = firstKnown
        ? new Date(Number(year), Number(firstKnown.slice(5)) - 2, 1).toLocaleDateString("en-US", { month: "long" })
        : null;
      $("energy-note").hidden = false;
      $("energy-note").textContent = `${text(energy(missing))} produced earlier in ${year}${until ? ` (January–${until})` : ""} isn't split by month yet. The inverter only reports this month and last month; past months can be copied from its screen with scripts/backfill.ts.`;
    }
  }
  document.querySelectorAll(".segmented button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.period === state.period)));
  barChart($("energy-chart"), {
    items,
    yFormat: (v) => number.format(v),
    valueFormat: (v) => text(energy(v)),
    tip: (item) => item.value == null
      ? `<strong>No data</strong>${item.title}`
      : `<strong>${text(energy(item.value))}</strong>${perKwp(item.value) ? `${perKwp(item.value)}<br>` : ""}${item.title}`,
    empty: "History builds up from the first reading. The inverter also reports yesterday, last month and last year.",
    onSelect: state.period === "days" ? (item) => { state.day = item.key; renderDay(); $("power-title").scrollIntoView({ behavior: "smooth", block: "start" }); } : null,
  });
  const rows = items.filter((i) => i.value != null).reverse()
    .map((i) => `<tr><td>${i.title}</td>${state.live?.plantKwp ? `<td>${perKwp(i.value)}</td>` : ""}<td>${text(energy(i.value))}</td></tr>`).join("");
  $("energy-table").innerHTML = rows
    ? `<div class="scroll"><table><thead><tr><th>Period</th>${state.live?.plantKwp ? "<th>Yield</th>" : ""}<th>Energy</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : "<p>No data yet.</p>";
}

// ---------- wiring ----------
async function refreshLive() {
  try { renderLive(await get("/api/live")); }
  catch { $("status").querySelector(".status-text").textContent = "Dashboard server unreachable"; $("status").querySelector(".status-icon").innerHTML = SVG.alert; }
}
async function refreshHistory() {
  try {
    state.totals = await get("/api/totals");
    renderEnergy();
    await renderDay();
  } catch { /* the live status already reports a dead server */ }
}

$("day-prev").addEventListener("click", () => { state.day = shiftDay(state.day, -1); renderDay(); });
$("day-next").addEventListener("click", () => { state.day = shiftDay(state.day, 1); renderDay(); });
$("energy-prev").addEventListener("click", () => {
  if (state.period === "days") state.month = shiftMonth(state.month, -1); else state.year = String(Number(state.year) - 1);
  renderEnergy();
});
$("energy-next").addEventListener("click", () => {
  if (state.period === "days") state.month = shiftMonth(state.month, 1); else state.year = String(Number(state.year) + 1);
  renderEnergy();
});
document.querySelectorAll(".segmented button").forEach((b) =>
  b.addEventListener("click", () => { state.period = b.dataset.period; renderEnergy(); }));
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { renderEnergy(); renderDay(); }, 150); });

await refreshLive();
await refreshHistory();
const liveEvery = Math.min(30, Math.max(10, state.live?.pollSeconds ?? 30)) * 1000;
setInterval(refreshLive, liveEvery);
setInterval(refreshHistory, 60_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { refreshLive(); refreshHistory(); } });
