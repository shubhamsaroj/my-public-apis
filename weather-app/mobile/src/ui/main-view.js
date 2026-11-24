// Main screen: hero, hourly strip, next-2-hours, 10-day list and detail tiles.

import { clamp, h, isNum, s } from "../lib/dom.js";
import {
  HOUR, distanceUnit, distanceValue, fmtAgo, fmtHour, fmtTime, fmtTimeParts, fmtWeekday, precipUnit, precipValue,
  pressureUnit, pressureValue, temp, wall, windUnit, windValue,
} from "../lib/format.js";
import { moonPhaseIcon, uiIcon, weatherIcon } from "../lib/icons.js";
import { feelsReason, heroInsight, hourlySummary, nowcast, precipTotals, pressureTrend, sunEvents, uvWindow } from "../lib/model.js";
import { aqiLevel, beaufort, compass, describe, dewComfort, moonInfo, tempColor, uvLevel, visibilityText } from "../lib/weather.js";
import { monotonePath } from "./charts.js";
import { buildCompass } from "./compass.js";

export const COL_W = 58; // hourly column width in px (matches --col in CSS)

const label = (icon, text) =>
  h("h2", { class: "card-label" }, h("span", { class: "label-icon", svg: uiIcon(icon) }), text);

/**
 * ctx: { view, place, places, index, deviceOffset, online, onDay, onHour, onMetric }
 * Returns the pieces; main.js places them into the responsive layout.
 */
export function buildMain(ctx) {
  const nc = nowcast(ctx.view);
  return {
    hero: hero(ctx, nc),
    cards: [hourlyCard(ctx), nc ? nowcastCard(nc) : null, dailyCard(ctx)].filter(Boolean),
    tiles: tiles(ctx),
    footer: footer(ctx),
  };
}

// ---------------------------------------------------------------------------
function hero(ctx, nc) {
  const { view, place, places, index } = ctx;
  const { cur, today } = view;
  const insight = heroInsight(view, nc);
  const otherZone = Math.abs(view.data.utcOffset - ctx.deviceOffset) >= 60;
  let sub = "";
  if (place.current) sub = "My location";
  else if (otherZone) sub = `${fmtTime(view.now)} local time`;
  else sub = [place.admin2, place.admin1, place.country].filter(Boolean).slice(0, 2).join(", ");

  const now = String(temp(cur.temp));
  const center = [
    h("div", { class: `hero-temp${now.length > 2 ? " long" : ""}`, "aria-label": `${now} degrees` },
      h("span", { class: "hero-num" }, now), h("span", { class: "hero-deg" }, "°")),
    h("p", { class: "hero-cond" }, describe(cur.code)),
    h("p", { class: "hero-hilo" }, h("span", null, `H:${temp(today.max)}°`), h("span", null, `L:${temp(today.min)}°`)),
  ];
  const wind = isNum(cur.wind) && isNum(cur.windDir) && cur.wind >= 1 ? { from: cur.windDir, speed: `${windValue(cur.wind)} ${windUnit()}` } : null;

  return h("section", { class: "hero", id: "hero", "aria-label": `Weather in ${place.name}` },
    h("div", { class: "hero-inner", id: "hero-inner" },
      h("h1", { class: "hero-name" }, place.current ? h("span", { class: "hero-pin", svg: uiIcon("locate") }) : null, place.name),
      sub ? h("p", { class: "hero-sub" }, sub) : null,
      places.length > 1
        ? h("div", { class: "dots", role: "img", "aria-label": `Location ${index + 1} of ${places.length}. Swipe to change.` },
          places.map((p, i) => h("span", { class: `dot${i === index ? " on" : ""}${p.current ? " loc" : ""}`, svg: p.current ? uiIcon("locate") : null })))
        : null,
      ctx.compass ? buildCompass(center, wind) : center,
      insight ? h("p", { class: "hero-insight" }, insight) : null,
    ));
}

// ---------------------------------------------------------------------------
function hourlyCard(ctx) {
  const { view } = ctx;
  const hrs = view.hours24;
  const start = wall(hrs[0].time);
  const end = wall(hrs[hrs.length - 1].time);
  const events = sunEvents(view.data, start, end);

  const cols = [];
  hrs.forEach((hr, i) => {
    const t = wall(hr.time);
    cols.push({ kind: "hour", hr, t, i });
    for (const e of events) if (e.t > t && e.t <= t + HOUR) cols.push({ kind: e.type, t: e.t });
  });

  const W = cols.length * COL_W;
  const CH = 66;
  const temps = hrs.map((x) => x.temp).filter(isNum);
  const lo = Math.min(...temps), hi = Math.max(...temps);
  const span = Math.max(hi - lo, 1);
  const yOf = (v) => 26 + (1 - (v - lo) / span) * (CH - 36);

  const pts = [];
  const items = cols.map((col, ci) => {
    const x = ci * COL_W + COL_W / 2;
    if (col.kind !== "hour") {
      return h("div", { class: "hr-col marker", "aria-label": `${col.kind === "sunrise" ? "Sunrise" : "Sunset"} at ${fmtTime(col.t)}` },
        h("span", { class: "hr-time" }, fmtTime(col.t)),
        h("span", { class: "hr-icon ui-wx", svg: uiIcon(col.kind) }),
        h("span", { class: "hr-pop mk" }, col.kind === "sunrise" ? "Sunrise" : "Sunset"));
    }
    const { hr, i } = col;
    if (isNum(hr.temp)) pts.push([x, yOf(hr.temp), hr.temp]);
    const pop = hr.pop ?? 0;
    const name = i === 0 ? "Now" : fmtHour(col.t);
    return h("button", {
      class: `hr-col${i === 0 ? " now" : ""}`, type: "button",
      "aria-label": `${name}: ${temp(hr.temp)} degrees, ${describe(hr.code)}${pop >= 10 ? `, ${pop}% chance of precipitation` : ""}`,
      onclick: () => ctx.onHour(hr),
    },
    h("span", { class: "hr-time" }, name),
    h("span", { class: "hr-icon", svg: weatherIcon(hr.code, hr.isDay) }),
    h("span", { class: `hr-pop${pop >= 10 ? "" : " none"}` }, pop >= 10 ? `${pop}%` : ""));
  });

  const gid = "hr-grad";
  const grad = s("linearGradient", { id: gid, gradientUnits: "userSpaceOnUse", x1: 0, y1: 0, x2: W, y2: 0 },
    ...pts.map(([x, , v]) => s("stop", { offset: (x / W).toFixed(4), "stop-color": tempColor(v) })));
  const areaGrad = s("linearGradient", { id: "hr-area", x1: 0, y1: 0, x2: 0, y2: 1 },
    s("stop", { offset: 0, "stop-color": "#fff", "stop-opacity": 0.22 }), s("stop", { offset: 1, "stop-color": "#fff", "stop-opacity": 0 }));
  const d = monotonePath(pts.map(([x, y]) => [x, y]));
  const svg = s("svg", { class: "hr-curve", width: W, height: CH, viewBox: `0 0 ${W} ${CH}`, "aria-hidden": "true" },
    s("defs", null, grad, areaGrad),
    pts.length > 1 ? s("path", { d: `${d}L${pts[pts.length - 1][0]},${CH}L${pts[0][0]},${CH}Z`, fill: "url(#hr-area)" }) : null,
    s("path", { d, fill: "none", stroke: `url(#${gid})`, "stroke-width": 3, "stroke-linecap": "round" }),
    ...pts.map(([x, y], i) => s("circle", { cx: x, cy: y.toFixed(1), r: i === 0 ? 4.5 : 3, class: i === 0 ? "hr-dot now" : "hr-dot" })));
  const labels = pts.map(([x, y, v]) => h("span", { class: "hr-temp", style: { left: `${x}px`, top: `${Math.round(y - 24)}px` } }, `${temp(v)}°`));

  return h("section", { class: "card hourly-card" },
    h("p", { class: "card-summary" }, hourlySummary(view)),
    h("div", { class: "hr-scroll", tabindex: "0", "aria-label": "Hourly forecast, scroll sideways" },
      h("div", { class: "hr-track", style: { width: `${W}px` } },
        h("div", { class: "hr-items" }, items),
        h("div", { class: "hr-chart", style: { height: `${CH}px` } }, svg, ...labels))));
}

// ---------------------------------------------------------------------------
function nowcastCard(nc) {
  const bars = nc.slots.map((sl) => {
    const mmh = sl.precip * 4;
    const v = mmh <= 0.02 ? 0.04 : clamp(Math.sqrt(mmh / 8), 0.1, 1);
    return h("span", { class: `nc-bar${mmh > 0.02 ? " wet" : ""}`, style: { height: `${Math.round(v * 100)}%` } });
  });
  return h("section", { class: "card nowcast-card" },
    label("umbrella", "Next 2 hours"),
    h("p", { class: "nc-title" }, nc.title),
    h("div", { class: "nc-plot", role: "img", "aria-label": nc.title },
      h("span", { class: "nc-grid g1" }, "Heavy"), h("span", { class: "nc-grid g2" }, "Moderate"), h("span", { class: "nc-grid g3" }, "Light"),
      h("div", { class: "nc-bars" }, bars)),
    h("div", { class: "nc-axis" }, ["Now", "30 min", "1 h", "1.5 h", "2 h"].map((t) => h("span", null, t))));
}

// ---------------------------------------------------------------------------
function dailyCard(ctx) {
  const { view } = ctx;
  const days = view.days;
  const lo = Math.min(...days.map((d) => d.min).filter(isNum));
  const hi = Math.max(...days.map((d) => d.max).filter(isNum));
  const span = Math.max(hi - lo, 1);
  const rows = days.map((d, i) => {
    const left = isNum(d.min) ? ((d.min - lo) / span) * 100 : 0;
    const width = isNum(d.max) && isNum(d.min) ? Math.max(((d.max - d.min) / span) * 100, 4) : 0;
    const name = i === 0 ? "Today" : fmtWeekday(wall(d.date));
    const pop = d.pop ?? 0;
    return h("li", null, h("button", {
      class: "day-row", type: "button", onclick: () => ctx.onDay(d.date),
      "aria-label": `${i === 0 ? "Today" : fmtWeekday(wall(d.date), "long")}: ${describe(d.code)}, high ${temp(d.max)}, low ${temp(d.min)}${pop >= 20 ? `, ${pop}% chance of precipitation` : ""}`,
    },
    h("span", { class: "day-name" }, name),
    h("span", { class: "day-icon" }, h("span", { class: "day-wx", svg: weatherIcon(d.code, true) }), pop >= 20 ? h("small", { class: "day-pop" }, `${pop}%`) : null),
    h("span", { class: "day-lo" }, `${temp(d.min)}°`),
    h("span", { class: "rng" },
      h("i", { class: "rng-fill", style: { left: `${left}%`, width: `${width}%`, backgroundImage: `linear-gradient(90deg, ${tempColor(d.min)}, ${tempColor(d.max)})` } }),
      i === 0 && isNum(view.cur.temp) ? h("i", { class: "rng-now", style: { left: `${clamp(((view.cur.temp - lo) / span) * 100, 0, 100)}%` } }) : null),
    h("span", { class: "day-hi" }, `${temp(d.max)}°`)));
  });
  return h("section", { class: "card daily-card" }, label("calendar", `${days.length}-day forecast`), h("ol", { class: "day-list" }, rows));
}

// ---------------------------------------------------------------------------
// Tiles

function tile({ icon, title, wide = false, onTap = null, aria = null }, ...children) {
  return h(onTap ? "button" : "div", {
    class: `card tile${wide ? " wide" : ""}${onTap ? " tappable" : ""}`, type: onTap ? "button" : null,
    onclick: onTap, "aria-label": aria,
  }, h("span", { class: "card-label" }, h("span", { class: "label-icon", svg: uiIcon(icon) }), title), ...children);
}
const value = (v, unit = null) => h("span", { class: "tile-value" }, String(v), unit ? h("span", { class: "tile-unit" }, unit) : null);
const level = (t) => h("span", { class: "tile-level" }, t);
const foot = (t) => h("span", { class: "tile-foot" }, t);

function mainPollutant(aq) {
  if (!aq) return null;
  const list = [["PM2.5", aq.pm25, 15], ["PM10", aq.pm10, 45], ["ozone", aq.o3, 100], ["NO₂", aq.no2, 25], ["SO₂", aq.so2, 40]];
  let best = null;
  for (const [n, v, lim] of list) if (isNum(v) && (!best || v / lim > best.r)) best = { n, r: v / lim };
  return best && best.r > 0.6 ? best.n : null;
}

function tiles(ctx) {
  const { view } = ctx;
  const cur = view.cur;
  const out = [];

  // Air quality (wide)
  const aqi = cur.aqi;
  const al = aqiLevel(aqi);
  if (al) {
    const main = mainPollutant(view.data.aq);
    out.push(tile({ icon: "leaf", title: "Air quality", wide: true, onTap: () => ctx.onMetric("aqi"), aria: `Air quality ${Math.round(aqi)}, ${al.label}. Show details.` },
      h("span", { class: "tile-row" }, value(Math.round(aqi)), level(al.label)),
      h("span", { class: "meter meter-aqi" }, h("i", { class: "meter-dot", style: { left: `${clamp(aqi / 300, 0, 1) * 100}%` } })),
      foot(`${al.advice}${main ? ` Main pollutant: ${main}.` : ""}`)));
  } else {
    out.push(tile({ icon: "leaf", title: "Air quality", wide: true }, foot("Air quality data isn't available for this location right now.")));
  }

  // UV
  const ul = uvLevel(cur.uv);
  out.push(tile({ icon: "sun", title: "UV index", onTap: () => ctx.onMetric("uv"), aria: `UV index ${isNum(cur.uv) ? Math.round(cur.uv) : "unknown"}. Show details.` },
    value(isNum(cur.uv) ? Math.round(cur.uv) : "--"), level(ul ? ul.label : ""),
    h("span", { class: "meter meter-uv" }, h("i", { class: "meter-dot", style: { left: `${clamp((cur.uv ?? 0) / 11, 0, 1) * 100}%` } })),
    foot(uvWindow(view))));

  out.push(sunTile(ctx));

  // Wind
  const dir = cur.windDir ?? 0;
  out.push(tile({ icon: "wind", title: "Wind", onTap: () => ctx.onMetric("wind"), aria: `Wind ${windValue(cur.wind)} ${windUnit()} from the ${compass(dir)}. Show details.` },
    compassSvg(cur.wind, dir),
    foot(`${beaufort(cur.wind)}${isNum(cur.gusts) ? ` · gusts ${windValue(cur.gusts)} ${windUnit()}` : ""}`)));

  // Precipitation
  const tot = precipTotals(view);
  out.push(tile({ icon: "drop", title: "Precipitation", onTap: () => ctx.onMetric("precip"), aria: "Precipitation. Show details." },
    value(precipValue(tot.next24), precipUnit()), level("in the next 24 h"),
    foot(tot.last24 >= 0.1 ? `${precipValue(tot.last24)} ${precipUnit()} fell in the last 24 h.` : "None fell in the last 24 h.")));

  // Feels like
  out.push(tile({ icon: "thermo", title: "Feels like", onTap: () => ctx.onMetric("feels"), aria: `Feels like ${temp(cur.feels)} degrees. Show details.` },
    value(`${temp(cur.feels)}°`), level(`Actual ${temp(cur.temp)}°`), foot(feelsReason(cur))));

  // Humidity
  out.push(tile({ icon: "humidity", title: "Humidity", onTap: () => ctx.onMetric("humidity"), aria: `Humidity ${Math.round(cur.humidity ?? 0)} percent. Show details.` },
    value(isNum(cur.humidity) ? `${Math.round(cur.humidity)}%` : "--"), level(dewComfort(cur.dew)),
    foot(isNum(cur.dew) ? `The dew point is ${temp(cur.dew)}° right now.` : "")));

  // Visibility
  out.push(tile({ icon: "eye", title: "Visibility", onTap: () => ctx.onMetric("visibility"), aria: `Visibility ${distanceValue(cur.vis)} ${distanceUnit()}. Show details.` },
    value(distanceValue(cur.vis), distanceUnit()), level(visibilityText(cur.vis)),
    foot(isNum(cur.vis) && cur.vis < 5000 ? "Take care on the roads." : "Good conditions for views.")));

  // Pressure
  const tr = pressureTrend(view);
  out.push(tile({ icon: "gauge", title: "Pressure", onTap: () => ctx.onMetric("pressure"), aria: `Pressure ${pressureValue(cur.pressure)} ${pressureUnit()}, ${tr.text}. Show details.` },
    pressureDial(cur.pressure, tr),
    foot(tr.dir > 0 ? "Rising pressure often brings settled weather." : tr.dir < 0 ? "Falling pressure can signal unsettled weather." : "Pressure has been steady over the last 3 hours.")));

  // Moon (wide)
  const m = moonInfo(Date.now());
  const nextFull = Math.round(m.daysToFull);
  out.push(tile({ icon: "moon", title: "Moon", wide: true },
    h("span", { class: "moon-row" },
      h("span", { class: "moon-art", svg: moonPhaseIcon(m.phase) }),
      h("span", { class: "moon-text" },
        h("span", { class: "moon-name" }, m.name),
        h("span", { class: "moon-line" }, h("span", null, "Illumination"), h("b", null, `${Math.round(m.illumination * 100)}%`)),
        h("span", { class: "moon-line" }, h("span", null, "Next full moon"), h("b", null, nextFull <= 0 ? "Tonight" : nextFull === 1 ? "Tomorrow" : `In ${nextFull} days`)),
        h("span", { class: "moon-line" }, h("span", null, "Next new moon"), h("b", null, `In ${Math.max(1, Math.round(m.daysToNew))} days`))))));
  return out;
}

function sunTile(ctx) {
  const { view } = ctx;
  const { today, tomorrow, now, cur } = view;
  const rise = today.sunrise ? wall(today.sunrise) : null;
  const set = today.sunset ? wall(today.sunset) : null;
  let title = "Sunrise", at = null, sub = "";
  if (!rise || !set) {
    sub = cur.isDay ? "The sun stays up all day." : "The sun stays below the horizon.";
  } else if (now < rise) {
    title = "Sunrise"; at = rise; sub = `Sunset: ${fmtTime(set)}`;
  } else if (now < set) {
    title = "Sunset"; at = set; sub = `Sunrise: ${fmtTime(rise)}`;
  } else {
    title = "Sunrise"; at = tomorrow?.sunrise ? wall(tomorrow.sunrise) : null; sub = `Sunset: ${fmtTime(set)}`;
  }
  const t = at != null ? fmtTimeParts(at) : { main: "--", suffix: "" };
  const p = rise && set ? clamp((now - rise) / (set - rise), 0, 1) : 0;
  const up = rise && set && now >= rise && now <= set;
  const q = (t) => [(1 - t) ** 2 * 8 + 2 * (1 - t) * t * 80 + t * t * 152, (1 - t) ** 2 * 60 + 2 * (1 - t) * t * -12 + t * t * 60];
  const [sx, sy] = q(p);
  const arc = s("svg", { class: "sun-arc", viewBox: "0 0 160 70", "aria-hidden": "true" },
    s("path", { d: "M8 60Q80 -12 152 60", class: "sun-path" }),
    s("path", { d: "M8 60Q80 -12 152 60", class: "sun-done", pathLength: 1, "stroke-dasharray": `${up ? p : now > (set || 0) ? 1 : 0} 1` }),
    s("line", { x1: 0, x2: 160, y1: 60, y2: 60, class: "sun-horizon" }),
    up ? s("circle", { cx: sx.toFixed(1), cy: sy.toFixed(1), r: 6, class: "sun-dot" }) : null);
  return tile({ icon: title === "Sunset" ? "sunset" : "sunrise", title },
    value(t.main, t.suffix || null), arc, foot(sub));
}

function compassSvg(kmh, dir) {
  const ticks = [];
  for (let i = 0; i < 36; i++) {
    const a = (i * 10 * Math.PI) / 180;
    const r1 = i % 9 === 0 ? 40 : 43;
    ticks.push(`M${(50 + Math.sin(a) * r1).toFixed(1)} ${(50 - Math.cos(a) * r1).toFixed(1)}L${(50 + Math.sin(a) * 47).toFixed(1)} ${(50 - Math.cos(a) * 47).toFixed(1)}`);
  }
  const rot = ((dir + 180) % 360).toFixed(0);
  return s("svg", { class: "compass", viewBox: "0 0 100 100", "aria-hidden": "true" },
    s("path", { d: ticks.join(""), class: "compass-ticks" }),
    s("text", { x: 50, y: 22, class: "compass-l" }, "N"), s("text", { x: 80, y: 53.5, class: "compass-l" }, "E"),
    s("text", { x: 50, y: 85, class: "compass-l" }, "S"), s("text", { x: 20, y: 53.5, class: "compass-l" }, "W"),
    s("g", { transform: `rotate(${rot} 50 50)` },
      s("path", { d: "M50 8 56 20 50 17 44 20Z", class: "compass-head" }),
      s("line", { x1: 50, y1: 18, x2: 50, y2: 31, class: "compass-shaft" }),
      s("line", { x1: 50, y1: 69, x2: 50, y2: 90, class: "compass-shaft" }),
      s("circle", { cx: 50, cy: 90, r: 3, class: "compass-tail" })),
    s("circle", { cx: 50, cy: 50, r: 19, class: "compass-hub" }),
    s("text", { x: 50, y: 52, class: "compass-v" }, String(windValue(kmh))),
    s("text", { x: 50, y: 63, class: "compass-u" }, windUnit()));
}

function pressureDial(hpa, tr) {
  const min = 960, max = 1050;
  const t = isNum(hpa) ? clamp((hpa - min) / (max - min), 0, 1) : 0.5;
  const ang = -120 + t * 240;
  const ticks = [];
  for (let i = 0; i <= 40; i++) {
    const a = ((-120 + i * 6) * Math.PI) / 180;
    const r1 = i % 10 === 0 ? 38 : 42;
    ticks.push(`M${(50 + Math.sin(a) * r1).toFixed(1)} ${(52 - Math.cos(a) * r1).toFixed(1)}L${(50 + Math.sin(a) * 46).toFixed(1)} ${(52 - Math.cos(a) * 46).toFixed(1)}`);
  }
  const arrow = tr.dir > 0 ? "▲" : tr.dir < 0 ? "▼" : "=";
  return s("svg", { class: "dial", viewBox: "0 0 100 92", "aria-hidden": "true" },
    s("path", { d: ticks.join(""), class: "dial-ticks" }),
    s("g", { transform: `rotate(${ang.toFixed(1)} 50 52)` }, s("path", { d: "M50 8 53.5 18 46.5 18Z", class: "dial-needle" })),
    s("text", { x: 50, y: 54, class: "dial-v" }, String(pressureValue(hpa))),
    s("text", { x: 50, y: 66, class: "dial-u" }, pressureUnit()),
    s("text", { x: 50, y: 84, class: "dial-t" }, `${arrow} ${tr.text}`));
}

// ---------------------------------------------------------------------------
function footer(ctx) {
  const age = Date.now() - ctx.view.data.fetchedAt;
  return h("footer", { class: "footer" },
    h("p", { class: "footer-updated", id: "footer-updated" }, ctx.online ? `Updated ${fmtAgo(age)}` : `Offline · updated ${fmtAgo(age)}`),
    h("p", null, "Weather: ", h("a", { href: "https://open-meteo.com/" }, "Open-Meteo"), " · Air quality: CAMS · Places © ",
      h("a", { href: "https://www.openstreetmap.org/copyright" }, "OpenStreetMap")),
    h("p", null, "Built by ", h("a", { href: "https://www.linkedin.com/in/shubham-saroj-devops-engineer/" }, "Shubham Saroj")));
}
