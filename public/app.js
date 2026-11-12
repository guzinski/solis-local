// Solar dashboard: live values, a day power curve and energy totals.
// No dependencies and no third-party requests; everything comes from /api/*.
import { barChart, lineChart } from "./charts.js";
import { locale, t, decimal, intervalLabel } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat(locale);
document.documentElement.lang = locale;
for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
for (const element of document.querySelectorAll("[data-i18n-aria]")) element.setAttribute("aria-label", t(element.dataset.i18nAria));
const languageSelect = $("language-select");
languageSelect.value = locale;
languageSelect.addEventListener("change", () => {
  try { localStorage.setItem("solar-locale", languageSelect.value); } catch { }
  const url = new URL(location.href); url.searchParams.set("lang", languageSelect.value); location.href = url.href;
});
async function showBuild() {
  try {
    const installed = /SolarMonitor\/([\d.]+)\s+Build\/(\d+)/.exec(navigator.userAgent);
    const version = installed ? {version:installed[1],build:installed[2]} : await get("/build-info.json");
    $("build-version").textContent = t(installed ? "appBuild" : "panelBuild", version);
  } catch { $("build-version").textContent = "Solar Monitor"; }
}
void showBuild();
const SVG = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="color:var(--sun)"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="currentColor" style="color:var(--idle)"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="color:var(--warning)"><path d="M12 3 2 21h20L12 3Z" fill="currentColor" stroke="none"/><path d="M12 10v5M12 18v.01" stroke="#0b0b0b"/></svg>',
  wait: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="none" stroke="var(--idle)" stroke-width="2"/></svg>',
  dot: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="var(--good)"/></svg>',
};
const STATUS_NAMES = { 0: t("waiting"), 1: t("openLoop"), 2: t("softStart"), 3: t("generating") };

const state = { day: dayKey(new Date()), period: "days", month: dayKey(new Date()).slice(0, 7), year: String(new Date().getFullYear()), live: null, totals: null };

// ---------- formatting ----------
function dayKey(d) { return d.toLocaleDateString("sv-SE"); }
function parseDay(key) { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); }
function shiftDay(key, by) { const d = parseDay(key); d.setDate(d.getDate() + by); return dayKey(d); }
function time(ts) { return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }); }
function power(w) {
  if (w == null) return ["—", ""];
  return w >= 1000 ? [decimal(w / 1000,2), "kW"] : [String(Math.round(w)), "W"];
}
function energy(kwh) {
  if (kwh == null) return ["—", ""];
  return [kwh < 100 ? decimal(kwh,1) : number.format(Math.round(kwh)), "kWh"];
}
// Specific yield: energy per kWp of panels (equivalent full-sun hours).
function perKwp(kwh) {
  const kwp = state.live?.plantKwp;
  if (!kwp || kwh == null) return null;
  const v = kwh / kwp;
  return `${v < 10 ? decimal(v,2) : number.format(Math.round(v))} kWh/kWp`;
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
  if (key === today) return t("today");
  if (key === shiftDay(today, -1)) return t("yesterday");
  return parseDay(key).toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" });
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
  if (!link.checked) return { icon: SVG.wait, text: t("connecting") };
  if (!reading) return { icon: SVG.alert, text: link.lastError ? t("cantReach") : t("firstReading") };
  if (link.online) {
    const name = STATUS_NAMES[reading.status];
    return reading.status === 3
      ? { icon: SVG.sun, text: t("generating") }
      : { icon: SVG.dot, text: name ?? t("onlineStatus", {code: reading.status}) };
  }
  // A grid-tied inverter powers the stick from the panels, so it's off at night.
  const hour = new Date().getHours();
  const night = reading.pvW < 300 || hour < 6 || hour >= 19;
  if (night) return { icon: SVG.moon, text: t("asleep"), asleep: true };
  const since = time(link.lastSeen ?? reading.ts);
  if (link.diagnosis === "busy") return { icon: SVG.wait, text: t("busy", {time: since}) };
  if (link.diagnosis === "modbus-down") return { icon: SVG.alert, text: t("modbusDown", {time: since}) };
  if (link.diagnosis === "unreachable") return { icon: SVG.alert, text: t("unreachable", {time: since}) };
  return { icon: SVG.alert, text: t("noAnswer", {time: since}) };
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
  $("now-label").textContent = online ? t("outputNow") : t("lastOutput");
  document.querySelector(".hero").classList.toggle("stale", !online);
  // Offline at night really is 0 W; offline in daylight means we don't know.
  const asleep = Boolean(status.asleep);
  $("now-power").innerHTML = withUnit(power(r && live.link.checked ? (online ? r.acW : asleep ? 0 : null) : null));
  $("now-sub").textContent = r
    ? online
      ? t("solarInput", {power: text(power(r.pvW)), time: time(r.ts)})
      : asleep || Date.now() - r.ts < 15 * 60_000
        ? t("lastReadingAt", {day:dayLabel(dayKey(new Date(r.ts))).toLocaleLowerCase(locale), time:time(r.ts), power:text(power(r.acW))})
        : t("outage", {duration:duration(Date.now() - r.ts)})
    : t("noReadingsYet");
  $("today-kwh").innerHTML = withUnit(energy(r ? live.todayKwh : null));
  $("yesterday").textContent = r ? t("yesterdayValue", {value:text(energy(r.yesterdayKwh))}) : " ";
  $("month-kwh").innerHTML = withUnit(energy(r?.monthKwh));
  $("last-month").textContent = r ? t("lastMonthValue", {value:text(energy(r.lastMonthKwh))}) : " ";
  $("year-kwh").innerHTML = withUnit(energy(r?.yearKwh));
  $("last-year").textContent = r && r.lastYearKwh > 0 ? t("lastYearValue", {value:text(energy(r.lastYearKwh))}) : t("firstYear");
  $("total-kwh").innerHTML = withUnit(energy(r?.totalKwh));
  setYield("today-yield", r ? live.todayKwh : null);
  setYield("month-yield", r?.monthKwh);
  setYield("year-yield", r?.yearKwh);
  setYield("total-yield", r?.totalKwh);
  $("capacity").textContent = live.plantKwp ? t("installed", {value:number.format(live.plantKwp)}) : t("sinceInstall");
  const showMeter = Boolean(live.plantKwp && r && online);
  $("meter").hidden = !showMeter;
  if (showMeter) {
    const pct = (r.acW / (live.plantKwp * 1000)) * 100;
    $("meter-fill").style.width = `${Math.min(100, pct)}%`;
    $("meter-label").textContent = t("capacityPercent", {percent:pct < 10 ? decimal(pct,1) : number.format(Math.round(pct)), capacity:number.format(live.plantKwp)});
  }

  const rows = (pairs) => pairs.map(([k, v, note]) =>
    `<tr><th>${k}</th><td>${v}${note ? ` <span class="note">${note}</span>` : ""}</td></tr>`).join("");
  $("strings").tBodies[0].innerHTML = r
    ? rows(r.strings.map((s, i) => [t("string", {number:i+1}), `${text(power(s.v * s.a))}`, `${decimal(s.v,1)} V · ${decimal(s.a,1)} A`]))
    : rows([[t("noDataYet"), "—"]]);
  $("inverter").tBodies[0].innerHTML = r
    ? rows([
        [t("gridVoltage"), `${decimal(r.gridV,1)} V`],
        [t("gridFrequency"), `${decimal(r.gridHz,2)} Hz`],
        [t("temperature"), `${decimal(r.tempC,1)} °C`],
        [t("inverterStatus"), STATUS_NAMES[r.status] ?? t("unknown"), t("code", {code:r.status})],
        [t("lastReading"), `${time(r.ts)}`, dayLabel(dayKey(new Date(r.ts))).toLowerCase()],
      ])
    : rows([[t("noDataYet"), "—"]]);
  $("foot").textContent = t("footer", {interval:intervalLabel(live.pollSeconds)});
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
    ? t("produced", {value:text(energy(data.kwh))})
    : t("powerDay");
  lineChart($("power-chart"), {
    points: data.points.map(([ts, ac]) => [ts, ac]),
    // Daylight window by default; widened if the data reaches further.
    xMin: start + 5 * 3_600_000,
    xMax: start + 20 * 3_600_000,
    gapMs,
    yFormat: (w) => (w >= 1000 ? `${number.format(w / 1000)}k` : String(w)),
    tip: ([ts, w]) => `<strong>${text(power(w))}</strong>${time(ts)}`,
    empty: state.day === today
      ? t("emptyToday")
      : data.kwh != null
        ? t("noCurve", {value:text(energy(data.kwh))})
        : t("emptyDay"),
  });
  // Table: one row per 15 minutes keeps it readable.
  const rows = [];
  let lastSlot = -1;
  for (const [ts, ac] of data.points) {
    const slot = Math.floor(ts / 900_000);
    if (slot !== lastSlot) { rows.push(`<tr><td>${time(ts)}</td><td>${text(power(ac))}</td></tr>`); lastSlot = slot; }
  }
  $("power-table").innerHTML = rows.length
    ? `<div class="scroll"><table><thead><tr><th>${t("time")}</th><th>${t("output")}</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<p>${t("noReadings")}</p>`;
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
        title: d.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
      });
    }
  } else if (period === "months") {
    for (let month = 0; month < 12; month++) {
      const d = new Date(Number(state.year), month, 1);
      const key = dayKey(d).slice(0, 7);
      items.push({
        key, value: lookup.get(key) ?? null,
        label: d.toLocaleDateString(locale, { month: "short" }),
        title: d.toLocaleDateString(locale, { month: "long", year: "numeric" }),
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

const PERIOD_SUB = { days:t("dailyYield"), months:t("monthlyYield"), years:t("yearlyYield") };

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
    $("energy-label").textContent = new Date(y, m - 1, 1).toLocaleDateString(locale, { month: "long", year: "numeric" });
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
        ? new Date(Number(year), Number(firstKnown.slice(5)) - 2, 1).toLocaleDateString(locale, { month: "long" })
        : null;
      $("energy-note").hidden = false;
      $("energy-note").textContent = t("earlierEnergy", {value:text(energy(missing)), year, range:until ? t("monthRange", {month:until}) : ""});
    }
  }
  document.querySelectorAll(".segmented button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.period === state.period)));
  barChart($("energy-chart"), {
    items,
    yFormat: (v) => number.format(v),
    valueFormat: (v) => text(energy(v)),
    tip: (item) => item.value == null
      ? `<strong>${t("noData")}</strong>${item.title}`
      : `<strong>${text(energy(item.value))}</strong>${perKwp(item.value) ? `${perKwp(item.value)}<br>` : ""}${item.title}`,
    empty: t("historyEmpty"),
    onSelect: state.period === "days" ? (item) => { state.day = item.key; renderDay(); $("power-title").scrollIntoView({ behavior: "smooth", block: "start" }); } : null,
  });
  const rows = items.filter((i) => i.value != null).reverse()
    .map((i) => `<tr><td>${i.title}</td>${state.live?.plantKwp ? `<td>${perKwp(i.value)}</td>` : ""}<td>${text(energy(i.value))}</td></tr>`).join("");
  $("energy-table").innerHTML = rows
    ? `<div class="scroll"><table><thead><tr><th>${t("period")}</th>${state.live?.plantKwp ? `<th>${t("yield")}</th>` : ""}<th>${t("energy")}</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p>${t("noDataYet")}</p>`;
}

// ---------- wiring ----------
// The existing mobile gateway serves the APK on the same home computer.
// Show the installer in the local browser; the HTTPS Android app doesn't need it.
const hostParts = location.hostname.split(".").map(Number);
const privateHost = hostParts.length === 4 && hostParts.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) &&
  (hostParts[0] === 10 || hostParts[0] === 127 ||
   (hostParts[0] === 192 && hostParts[1] === 168) ||
   (hostParts[0] === 172 && hostParts[1] >= 16 && hostParts[1] <= 31));
if (location.protocol === "http:" && (privateHost || location.hostname === "localhost" || location.hostname === "[::1]")) {
  const apk = new URL(location.origin);
  apk.port = "3101";
  apk.pathname = "/app.apk";
  $("android-apk").href = apk.href;
  $("app-download").hidden = false;
}

async function refreshLive() {
  try { renderLive(await get("/api/live")); }
  catch { $("status").querySelector(".status-text").textContent = t("serverUnreachable"); $("status").querySelector(".status-icon").innerHTML = SVG.alert; }
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
