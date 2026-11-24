// SVG charts built with DOM APIs (no HTML strings).

import { h, s } from "../lib/dom.js";
import { tempColor } from "../lib/weather.js";

let uid = 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (n) => Math.round(n * 100) / 100;

/** Monotone cubic path through points (never overshoots, e.g. UV can't dip below 0). */
export function monotonePath(pts) {
  const n = pts.length;
  if (!n) return "";
  if (n === 1) return `M${r2(pts[0][0])},${r2(pts[0][1])}`;
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0] || 1e-6;
    m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  t[n - 1] = m[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], q = a * a + b * b;
    if (q > 9) { const tau = 3 / Math.sqrt(q); t[i] = tau * a * m[i]; t[i + 1] = tau * b * m[i]; }
  }
  let d = `M${r2(pts[0][0])},${r2(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const k = dx[i] / 3;
    d += `C${r2(pts[i][0] + k)},${r2(pts[i][1] + t[i] * k)} ${r2(pts[i + 1][0] - k)},${r2(pts[i + 1][1] - t[i + 1] * k)} ${r2(pts[i + 1][0])},${r2(pts[i + 1][1])}`;
  }
  return d;
}

/** Split into runs of finite values, so gaps in data don't draw misleading lines. */
function runs(values, xOf, yOf) {
  const out = [];
  let cur = [];
  values.forEach((v, i) => {
    if (isNum(v)) cur.push([xOf(i), yOf(v)]);
    else if (cur.length) { out.push(cur); cur = []; }
  });
  if (cur.length) out.push(cur);
  return out;
}

/**
 * A time-series chart.
 * series: [{ values, color | "temp", width, dash, area }]
 * bars:   { values (0..1), color }
 * xLabels: [{ i, text }]; yTicks: [{ v, text }]
 */
export function timeChart({ series = [], bars = null, n, min, max, nowIndex = null, xLabels = [], yTicks = [], height = 160, label = "" }) {
  const id = `c${++uid}`;
  const pad = 8;
  const xOf = (i) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const yOf = (v) => 100 - pad - ((v - min) / Math.max(1e-9, max - min)) * (100 - 2 * pad);

  const defs = s("defs");
  const svg = s("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "none", class: "chart-svg", "aria-hidden": "true" }, defs);

  for (const t of yTicks) {
    const y = r2(yOf(t.v));
    svg.appendChild(s("line", { x1: 0, x2: 100, y1: y, y2: y, class: "chart-grid", "vector-effect": "non-scaling-stroke" }));
  }

  if (bars) {
    const w = Math.max(0.6, (100 / n) * 0.62);
    bars.values.forEach((v, i) => {
      if (!isNum(v) || v <= 0) return;
      const hgt = Math.max(1.2, v * (100 - 2 * pad));
      svg.appendChild(s("rect", { x: r2(xOf(i) - w / 2), y: r2(100 - pad - hgt), width: r2(w), height: r2(hgt), rx: 0.4, fill: bars.color, opacity: bars.opacity ?? 0.85 }));
    });
  }

  series.forEach((se, si) => {
    let stroke = se.color;
    if (se.color === "temp") {
      const gid = `${id}t${si}`;
      const grad = s("linearGradient", { id: gid, gradientUnits: "userSpaceOnUse", x1: 0, y1: 0, x2: 100, y2: 0 });
      const step = Math.max(1, Math.floor(n / 24));
      se.values.forEach((v, i) => {
        if (isNum(v) && (i % step === 0 || i === n - 1)) grad.appendChild(s("stop", { offset: r2(xOf(i) / 100), "stop-color": tempColor(se.tempOf ? se.tempOf(v) : v) }));
      });
      defs.appendChild(grad);
      stroke = `url(#${gid})`;
    }
    for (const run of runs(se.values, xOf, yOf)) {
      const d = monotonePath(run);
      if (se.area) {
        const aid = `${id}a${si}`;
        defs.appendChild(s("linearGradient", { id: aid, x1: 0, y1: 0, x2: 0, y2: 1 },
          s("stop", { offset: 0, "stop-color": se.areaColor || "#ffffff", "stop-opacity": 0.28 }),
          s("stop", { offset: 1, "stop-color": se.areaColor || "#ffffff", "stop-opacity": 0 })));
        svg.appendChild(s("path", { d: `${d}L${r2(run[run.length - 1][0])},100L${r2(run[0][0])},100Z`, fill: `url(#${aid})` }));
      }
      svg.appendChild(s("path", {
        d, fill: "none", stroke, "stroke-width": se.width || 2.5, "stroke-linecap": "round", "stroke-linejoin": "round",
        "stroke-dasharray": se.dash || null, "vector-effect": "non-scaling-stroke", opacity: se.opacity ?? 1,
      }));
    }
  });

  if (nowIndex != null && nowIndex >= 0 && nowIndex < n) {
    const x = r2(xOf(nowIndex));
    svg.appendChild(s("line", { x1: x, x2: x, y1: 0, y2: 100, class: "chart-now", "vector-effect": "non-scaling-stroke" }));
  }

  const plot = h("div", { class: "chart-plot", style: { height: `${height}px` } }, svg,
    ...yTicks.map((t) => h("span", { class: "chart-y", style: { top: `${yOf(t.v)}%` } }, t.text)));
  const axis = h("div", { class: "chart-x" }, ...xLabels.map((l) => h("span", { style: { left: `${xOf(l.i)}%` } }, l.text)));
  return h("div", { class: "chart", role: "img", "aria-label": label }, plot, axis);
}

/** Nice-ish axis bounds and ticks for a value range. */
export function niceRange(values, { floor = null, ceil = null, minSpan = 1, count = 3 } = {}) {
  const v = values.filter(isNum);
  let lo = v.length ? Math.min(...v) : 0;
  let hi = v.length ? Math.max(...v) : 1;
  if (floor != null) lo = Math.min(lo, floor);
  if (ceil != null) hi = Math.max(hi, ceil);
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s2) => s2 >= raw) || raw;
  const min = floor != null && lo >= floor ? Math.max(floor, Math.floor(lo / step) * step) : Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let t = min; t <= max + step / 2; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return { min, max, ticks };
}
