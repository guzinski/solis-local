// Tiny SVG charts: a single-series line/area and a single-series bar chart.
// Marks follow fixed specs: 2px line with a 10% wash, bars <= 24px with a 4px
// rounded data end, hairline solid gridlines, one direct label, hover tooltips.

const NS = "http://www.w3.org/2000/svg";
const tooltip = document.getElementById("tooltip");

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (parent) parent.appendChild(node);
  return node;
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

function yScale(max, minTop) {
  const step = niceStep(Math.max(max, minTop) / 4);
  const top = Math.ceil(Math.max(max, minTop) / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { top, ticks };
}

export function showTip(html, x, y) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const { width, height } = tooltip.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - width / 2), window.innerWidth - width - 8);
  const top = y - height - 14 < 8 ? y + 18 : y - height - 14;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}
export function hideTip() { tooltip.hidden = true; }

function frame(container, margin) {
  container.innerHTML = "";
  const width = Math.max(240, container.clientWidth);
  const height = container.clientHeight || 220;
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" }, container);
  return { svg, width, height, inner: { x0: margin.left, x1: width - margin.right, y0: margin.top, y1: height - margin.bottom } };
}

function yAxis(svg, inner, ticks, top, format) {
  const y = (v) => inner.y1 - (v / top) * (inner.y1 - inner.y0);
  for (const v of ticks) {
    el("line", { class: v === 0 ? "baseline" : "gridline", x1: inner.x0, x2: inner.x1, y1: y(v), y2: y(v) }, svg);
    const label = el("text", { class: "tick", x: inner.x0 - 8, y: y(v) + 4, "text-anchor": "end" }, svg);
    label.textContent = format(v);
  }
  return y;
}

function emptyNote(container, message) {
  const note = document.createElement("div");
  note.className = "empty";
  const label = document.createElement("span");
  label.textContent = message;
  note.appendChild(label);
  container.appendChild(note);
}

export function lineChart(container, { points, xMin, xMax, gapMs, yFormat, tip, empty }) {
  const { svg, inner } = frame(container, { top: 18, right: 10, bottom: 24, left: 40 });
  if (points.length) {
    xMin = Math.min(xMin, points[0][0]);
    xMax = Math.max(xMax, points[points.length - 1][0]);
  }
  const peak = points.reduce((best, p) => (p[1] > best[1] ? p : best), [0, -1]);
  const { top, ticks } = yScale(Math.max(0, peak[1]) * 1.12, 500);
  const y = yAxis(svg, inner, ticks, top, yFormat);
  const x = (ts) => inner.x0 + ((ts - xMin) / (xMax - xMin)) * (inner.x1 - inner.x0);

  // Hour ticks every 3 hours, in local time.
  const t = new Date(xMin);
  t.setMinutes(0, 0, 0);
  if (t.getTime() < xMin) t.setHours(t.getHours() + 1);
  for (; t.getTime() <= xMax; t.setHours(t.getHours() + 1)) {
    if (t.getHours() % 3) continue;
    const label = el("text", { class: "tick", x: x(t.getTime()), y: inner.y1 + 17, "text-anchor": "middle" }, svg);
    label.textContent = `${String(t.getHours()).padStart(2, "0")}:00`;
  }

  if (!points.length) return emptyNote(container, empty);

  // Break the line where readings are missing (stick offline) rather than bridging.
  const segments = [];
  let current = [];
  for (let i = 0; i < points.length; i++) {
    if (i && points[i][0] - points[i - 1][0] > gapMs) { segments.push(current); current = []; }
    current.push(points[i]);
  }
  segments.push(current);
  for (const seg of segments) {
    const d = seg.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    el("path", { class: "area", d: `${d}L${x(seg[seg.length - 1][0]).toFixed(1)},${inner.y1}L${x(seg[0][0]).toFixed(1)},${inner.y1}Z` }, svg);
    el("path", { class: "line", d: seg.length > 1 ? d : `${d}l0.01,0` }, svg);
  }

  // One direct label: the day's peak.
  if (peak[1] > 0) {
    const px = x(peak[0]);
    el("circle", { class: "dot", cx: px, cy: y(peak[1]), r: 4 }, svg);
    const label = el("text", { class: "label", x: px, y: y(peak[1]) - 9, "text-anchor": px < inner.x0 + 40 ? "start" : px > inner.x1 - 40 ? "end" : "middle" }, svg);
    label.textContent = `Peak ${peak[1] >= 1000 ? (peak[1] / 1000).toFixed(2) + " kW" : peak[1] + " W"}`;
  }

  // Hover: crosshair + dot + tooltip on the nearest reading.
  const cross = el("line", { class: "crosshair", y1: inner.y0, y2: inner.y1, visibility: "hidden" }, svg);
  const dot = el("circle", { class: "dot", r: 5, visibility: "hidden" }, svg);
  const hit = el("rect", { x: inner.x0, y: 0, width: inner.x1 - inner.x0, height: inner.y1, fill: "transparent" }, svg);
  const move = (ev) => {
    const box = svg.getBoundingClientRect();
    const ts = xMin + ((ev.clientX - box.left) * (svg.viewBox.baseVal.width / box.width) - inner.x0) / (inner.x1 - inner.x0) * (xMax - xMin);
    let lo = 0, hi = points.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid][0] < ts) lo = mid + 1; else hi = mid; }
    const p = lo > 0 && Math.abs(points[lo - 1][0] - ts) < Math.abs(points[lo][0] - ts) ? points[lo - 1] : points[lo];
    if (Math.abs(p[0] - ts) > gapMs) return leave();
    const px = x(p[0]), py = y(p[1]);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.setAttribute("visibility", "visible");
    const k = box.width / svg.viewBox.baseVal.width;
    showTip(tip(p), box.left + px * k, box.top + py * k);
  };
  const leave = () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(); };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", leave);
}

export function barChart(container, { items, yFormat, valueFormat, tip, empty, onSelect }) {
  const { svg, inner } = frame(container, { top: 22, right: 6, bottom: 24, left: 40 });
  const values = items.map((i) => i.value).filter((v) => v != null);
  const max = values.length ? Math.max(...values) : 0;
  const { top, ticks } = yScale(max * 1.1, 1);
  const y = yAxis(svg, inner, ticks, top, yFormat);
  const band = (inner.x1 - inner.x0) / items.length;
  const barWidth = Math.max(3, Math.min(24, band * 0.62));
  const every = Math.ceil(items.length / Math.max(1, Math.floor((inner.x1 - inner.x0) / 34)));
  const peakIndex = items.findIndex((i) => i.value === max && max > 0);

  items.forEach((item, i) => {
    const cx = inner.x0 + band * (i + 0.5);
    if (i % every === 0 || i === items.length - 1) {
      if (!(i === items.length - 1 && i % every !== 0 && i % every < every / 2)) {
        const label = el("text", { class: "tick", x: cx, y: inner.y1 + 17, "text-anchor": "middle" }, svg);
        label.textContent = item.label;
      }
    }
    if (item.value != null && item.value > 0) {
      const h = Math.max(1, inner.y1 - y(item.value));
      const r = Math.min(4, h, barWidth / 2);
      const x0 = cx - barWidth / 2, x1 = cx + barWidth / 2, yt = inner.y1 - h;
      el("path", {
        class: "bar",
        d: `M${x0},${inner.y1}V${yt + r}Q${x0},${yt} ${x0 + r},${yt}H${x1 - r}Q${x1},${yt} ${x1},${yt + r}V${inner.y1}Z`,
      }, svg);
      if (i === peakIndex) {
        const label = el("text", { class: "label", x: cx, y: yt - 6, "text-anchor": i < 2 ? "start" : i > items.length - 3 ? "end" : "middle" }, svg);
        label.textContent = valueFormat(item.value);
      }
    }
    const hit = el("rect", { x: cx - band / 2, y: inner.y0 - 10, width: band, height: inner.y1 - inner.y0 + 10, fill: "transparent", style: onSelect && item.value != null ? "cursor:pointer" : "" }, svg);
    const show = () => {
      const box = svg.getBoundingClientRect();
      const k = box.width / svg.viewBox.baseVal.width;
      const barTop = item.value ? y(item.value) : inner.y1;
      showTip(tip(item), box.left + cx * k, box.top + barTop * k);
    };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", hideTip);
    if (onSelect && item.value != null) hit.addEventListener("click", () => { hideTip(); onSelect(item); });
  });

  if (!values.length) emptyNote(container, empty);
}
