// Detail sheets: a day, an hour, and a single metric over the next 48 hours.

import { clamp, clear, h, isNum } from "../lib/dom.js";
import {
  distanceUnit, distanceValue, fmtDayMonth, fmtDuration, fmtHour, fmtLongDate, fmtTime, fmtWeekday,
  precipUnit, precipValue, pressureUnit, pressureValue, temp, tempRaw, toCelsius, wall, windRaw, windUnit, windValue,
} from "../lib/format.js";
import { uiIcon, weatherIcon } from "../lib/icons.js";
import { daySummary, hoursOfDay } from "../lib/model.js";
import { aqiLevel, compass, compassName, describe, uvLevel } from "../lib/weather.js";
import { niceRange, timeChart } from "./charts.js";

const stat = (k, v, sub = null) =>
  h("div", { class: "stat" }, h("span", { class: "stat-k" }, k), h("span", { class: "stat-v" }, v), sub ? h("span", { class: "stat-s" }, sub) : null);

function xLabelsFor(hours, every) {
  const out = [];
  hours.forEach((x, i) => {
    const hr = Number(x.time.slice(11, 13));
    if (hr % every === 0) out.push({ i, text: hr === 0 && i > 0 ? fmtWeekday(wall(x.time)) : fmtHour(wall(x.time)) });
  });
  return out;
}

// ---------------------------------------------------------------------------
export function renderDay(el, view, date, onPick) {
  const days = view.days;
  const day = days.find((d) => d.date === date) || days[0];
  const hours = hoursOfDay(view.data, day.date);
  const isToday = day.date === view.today.date;

  const chips = h("div", { class: "chips", role: "tablist", "aria-label": "Choose day" },
    days.map((d, i) => h("button", {
      class: `chip${d.date === day.date ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(d.date === day.date),
      onclick: () => onPick(d.date),
    },
    h("span", { class: "chip-day" }, i === 0 ? "Today" : fmtWeekday(wall(d.date))),
    h("span", { class: "chip-icon", svg: weatherIcon(d.code, true) }),
    h("span", { class: "chip-t" }, `${temp(d.max)}°`))));

  const tvals = hours.map((x) => tempRaw(x.temp));
  const range = niceRange(tvals, { minSpan: 6, count: 3 });
  const nowIdx = isToday ? hours.findIndex((x) => x.time === view.data.hourly[view.nowIdx].time) : null;
  const chart = timeChart({
    n: hours.length, min: range.min, max: range.max, nowIndex: nowIdx, height: 170,
    series: [{ values: tvals, color: "temp", tempOf: toCelsius, width: 3, area: true }],
    bars: { values: hours.map((x) => (x.pop ?? 0) / 100), color: "#6cb8ff", opacity: 0.55 },
    yTicks: range.ticks.map((v) => ({ v, text: `${Math.round(v)}°` })),
    xLabels: xLabelsFor(hours, window.innerWidth < 560 ? 6 : 3),
    label: `Temperature and chance of precipitation for ${fmtLongDate(wall(day.date))}`,
  });

  const hums = hours.map((x) => x.humidity).filter(isNum);
  const ul = uvLevel(day.uvMax);
  const al = aqiLevel(day.aqi);
  const grid = h("div", { class: "stats" },
    stat("Feels like", `${temp(day.feelsMax)}° / ${temp(day.feelsMin)}°`, "High / low"),
    stat("Precipitation", `${precipValue(day.precipSum)} ${precipUnit()}`, `${day.pop ?? 0}% chance${isNum(day.precipHours) && day.precipHours > 0 ? ` · ${Math.round(day.precipHours)} h` : ""}`),
    stat("Wind", `${windValue(day.windMax)} ${windUnit()}`, `${isNum(day.gustMax) ? `Gusts ${windValue(day.gustMax)} · ` : ""}from ${compass(day.windDir)}`),
    stat("UV index", isNum(day.uvMax) ? String(Math.round(day.uvMax)) : "--", ul ? ul.label : ""),
    stat("Sunrise", day.sunrise ? fmtTime(wall(day.sunrise)) : "--", day.sunset ? `Sunset ${fmtTime(wall(day.sunset))}` : ""),
    stat("Daylight", isNum(day.daylight) ? fmtDuration(day.daylight * 1000) : "--"),
    stat("Humidity", hums.length ? `${Math.round(Math.min(...hums))}–${Math.round(Math.max(...hums))}%` : "--"),
    stat("Air quality", al ? String(day.aqi) : "--", al ? al.label : "No forecast"));

  clear(el).append(
    chips,
    h("div", { class: "detail-hero" },
      h("span", { class: "detail-icon", svg: weatherIcon(day.code, true, "wx-anim") }),
      h("div", null,
        h("h2", { class: "detail-title", id: "day-title" }, isToday ? "Today" : fmtWeekday(wall(day.date), "long")),
        h("p", { class: "detail-sub" }, `${fmtDayMonth(wall(day.date))} · ${describe(day.code)}`)),
      h("div", { class: "detail-temps" }, h("b", null, `${temp(day.max)}°`), h("span", null, `${temp(day.min)}°`))),
    h("p", { class: "detail-summary" }, daySummary(day, hours)),
    h("section", { class: "panel" }, h("h3", { class: "panel-title" }, "Temperature & chance of precipitation"), chart),
    grid);
  el.querySelector(".chip.on")?.scrollIntoView({ inline: "center", block: "nearest" });
}

// ---------------------------------------------------------------------------
export function renderHour(el, hr) {
  const t = wall(hr.time);
  const ul = uvLevel(hr.uv);
  const al = aqiLevel(hr.aqi);
  clear(el).append(
    h("div", { class: "detail-hero" },
      h("span", { class: "detail-icon", svg: weatherIcon(hr.code, hr.isDay, "wx-anim") }),
      h("div", null,
        h("h2", { class: "detail-title", id: "hour-title" }, `${fmtWeekday(t)} ${fmtTime(t)}`),
        h("p", { class: "detail-sub" }, describe(hr.code))),
      h("div", { class: "detail-temps" }, h("b", null, `${temp(hr.temp)}°`))),
    h("div", { class: "stats" },
      stat("Feels like", `${temp(hr.feels)}°`),
      stat("Chance of precipitation", `${hr.pop ?? 0}%`),
      stat("Precipitation", `${precipValue(hr.precip ?? 0)} ${precipUnit()}`),
      stat("Wind", `${windValue(hr.wind)} ${windUnit()}`, `from the ${compassName(hr.windDir)}`),
      stat("Gusts", `${windValue(hr.gusts)} ${windUnit()}`),
      stat("Humidity", isNum(hr.humidity) ? `${Math.round(hr.humidity)}%` : "--", isNum(hr.dew) ? `Dew point ${temp(hr.dew)}°` : ""),
      stat("UV index", isNum(hr.uv) ? String(Math.round(hr.uv)) : "--", ul ? ul.label : ""),
      stat("Cloud cover", isNum(hr.cloud) ? `${Math.round(hr.cloud)}%` : "--"),
      stat("Visibility", `${distanceValue(hr.vis)} ${distanceUnit()}`),
      stat("Pressure", `${pressureValue(hr.pressure)} ${pressureUnit()}`),
      stat("Air quality", al ? String(hr.aqi) : "--", al ? al.label : "")));
}

// ---------------------------------------------------------------------------
const METRICS = {
  uv: {
    title: "UV index", icon: "sun",
    get: (x) => x.uv, floor: 0, ceil: 8, color: "#ffc94d", fmt: (v) => String(Math.round(v)),
    now: (c) => [isNum(c.uv) ? String(Math.round(c.uv)) : "--", uvLevel(c.uv)?.label || ""],
    about: "The UV index measures how strong the sun's ultraviolet radiation is. From 3 upwards, wear sunscreen and a hat around midday; from 8, avoid the midday sun where you can. Clouds reduce UV, but less than you might think.",
  },
  wind: {
    title: "Wind", icon: "wind",
    get: (x) => windRaw(x.wind), get2: (x) => windRaw(x.gusts), floor: 0, color: "#9ad7ff", fmt: (v) => String(Math.round(v)),
    now: (c) => [`${windValue(c.wind)} ${windUnit()}`, `Gusts ${windValue(c.gusts)} · from the ${compassName(c.windDir)}`],
    legend: [["Wind", "#9ad7ff", false], ["Gusts", "#ffffff", true]],
    about: "Wind speed is the average over 10 minutes, measured 10 m above the ground. Gusts are short bursts that can be much stronger than the average, and are what you feel on exposed streets and bridges.",
  },
  precip: {
    title: "Precipitation", icon: "drop",
    get: (x) => x.pop, floor: 0, ceil: 100, color: "#6cb8ff", fmt: (v) => `${Math.round(v)}%`, barsOf: (x) => Math.min(1, Math.sqrt((x.precip ?? 0) / 8)),
    now: (c, v) => [`${precipValue(v.next24)} ${precipUnit()}`, "Expected in the next 24 h"],
    legend: [["Chance", "#6cb8ff", false], ["Amount", "#6cb8ff80", false]],
    about: "The line shows the chance of precipitation each hour; the bars show how much is expected. Light rain is under 2.5 mm per hour, heavy rain over 8 mm per hour.",
  },
  feels: {
    title: "Feels like", icon: "thermo",
    get: (x) => tempRaw(x.feels), get2: (x) => tempRaw(x.temp), color: "temp", fmt: (v) => `${Math.round(v)}°`,
    now: (c) => [`${temp(c.feels)}°`, `Actual ${temp(c.temp)}°`],
    legend: [["Feels like", "#ffd166", false], ["Actual", "#ffffff", true]],
    about: "“Feels like” combines temperature with wind, humidity and sunshine to estimate how warm or cold it feels on your skin. Wind makes it feel colder; humidity makes heat feel more intense.",
  },
  humidity: {
    title: "Humidity", icon: "humidity",
    get: (x) => x.humidity, floor: 0, ceil: 100, color: "#7fd3ff", fmt: (v) => `${Math.round(v)}%`,
    now: (c) => [isNum(c.humidity) ? `${Math.round(c.humidity)}%` : "--", isNum(c.dew) ? `Dew point ${temp(c.dew)}°` : ""],
    about: "Relative humidity is how much water vapour the air holds compared with the most it could hold at that temperature. The dew point is a better guide to how muggy it feels: above about 16° most people notice the stickiness.",
  },
  visibility: {
    title: "Visibility", icon: "eye",
    get: (x) => (isNum(x.vis) ? Math.min(Number(distanceValue(x.vis)), 50) : null), floor: 0, color: "#c9d7ff", fmt: (v) => `${Math.round(v)}`,
    now: (c) => [`${distanceValue(c.vis)} ${distanceUnit()}`, ""],
    about: "Visibility is how far away you can clearly see objects. Fog, mist, haze, heavy rain and snow all reduce it. Under 1 km counts as fog.",
  },
  pressure: {
    title: "Pressure", icon: "gauge",
    get: (x) => (isNum(x.pressure) ? Number(pressureValue(x.pressure)) : null), color: "#d7c4ff", fmt: (v) => String(Math.round(v * 100) / 100),
    now: (c) => [`${pressureValue(c.pressure)} ${pressureUnit()}`, "Sea-level pressure"],
    about: "Air pressure at sea level. Rapidly falling pressure often comes before wind and rain; rising pressure usually means calmer, more settled weather.",
  },
  aqi: {
    title: "Air quality", icon: "leaf",
    get: (x) => x.aqi, floor: 0, color: "#7be3a0", fmt: (v) => String(Math.round(v)),
    now: (c) => [isNum(c.aqi) ? String(Math.round(c.aqi)) : "--", aqiLevel(c.aqi)?.label || ""],
    about: "US Air Quality Index from the Copernicus Atmosphere Monitoring Service. 0–50 is good, 51–100 moderate, and above 100 unhealthy for sensitive groups. Values are model estimates, not readings from a local monitor.",
  },
};

export const METRIC_KEYS = Object.keys(METRICS);

export function renderMetric(el, view, key, extra = {}) {
  const m = METRICS[key];
  if (!m) return;
  const hours = view.data.hourly.slice(view.nowIdx, view.nowIdx + 48);
  const v1 = hours.map(m.get);
  const v2 = m.get2 ? hours.map(m.get2) : null;
  const all = [...v1, ...(v2 || [])].filter(isNum);
  const range = niceRange(all, { floor: m.floor ?? null, ceil: m.ceil ?? null, minSpan: key === "pressure" ? 6 : 4, count: 3 });
  const series = [];
  if (v2) series.push({ values: v2, color: "#ffffff", width: 1.6, dash: "4 4", opacity: 0.7 });
  series.push({ values: v1, color: m.color, tempOf: toCelsius, width: 3, area: true, areaColor: m.color === "temp" ? "#ffffff" : m.color });
  const chart = timeChart({
    n: hours.length, min: range.min, max: range.max, nowIndex: 0, height: 190, series,
    bars: m.barsOf ? { values: hours.map(m.barsOf), color: "#6cb8ff", opacity: 0.45 } : null,
    yTicks: range.ticks.map((v) => ({ v, text: m.fmt(v) })),
    xLabels: xLabelsFor(hours, window.innerWidth < 380 ? 12 : 6),
    label: `${m.title} for the next 48 hours`,
  });
  const [big, sub] = m.now(view.cur, extra);
  const extraBlocks = key === "aqi" ? pollutants(view.data.aq) : null;
  clear(el).append(
    h("div", { class: "metric-head" },
      h("span", { class: "metric-icon", svg: uiIcon(m.icon) }),
      h("div", null, h("h2", { class: "detail-title", id: "metric-title" }, m.title), h("p", { class: "detail-sub" }, "Next 48 hours"))),
    h("div", { class: "metric-now" }, h("b", null, big), sub ? h("span", null, sub) : null),
    h("section", { class: "panel" }, chart,
      m.legend ? h("div", { class: "legend" }, m.legend.map(([n, c, dashed]) => h("span", null, h("i", { class: dashed ? "dashed" : "", style: { background: dashed ? "transparent" : c, borderColor: c } }), n))) : null),
    extraBlocks,
    h("section", { class: "panel about" }, h("h3", { class: "panel-title" }, `About ${m.title.toLowerCase()}`), h("p", null, m.about)));
}

function pollutants(aq) {
  if (!aq) return null;
  const rows = [
    ["PM2.5", "Fine particles", aq.pm25, 15, "µg/m³"],
    ["PM10", "Coarse particles", aq.pm10, 45, "µg/m³"],
    ["O₃", "Ozone", aq.o3, 100, "µg/m³"],
    ["NO₂", "Nitrogen dioxide", aq.no2, 25, "µg/m³"],
    ["SO₂", "Sulphur dioxide", aq.so2, 40, "µg/m³"],
  ].filter((r) => isNum(r[2]));
  if (!rows.length) return null;
  return h("section", { class: "panel" },
    h("h3", { class: "panel-title" }, "Pollutants"),
    h("p", { class: "panel-note" }, "Bars compare each value with the WHO 24-hour guideline (the tick)."),
    h("ul", { class: "pollutants" }, rows.map(([sym, name, v, lim, unit]) => {
      const ratio = v / lim;
      const color = ratio < 0.5 ? "#5ad67d" : ratio < 1 ? "#f6d548" : ratio < 2 ? "#ff9f43" : "#ff5c5c";
      return h("li", null,
        h("span", { class: "pol-name" }, h("b", null, sym), h("small", null, name)),
        h("span", { class: "pol-bar" }, h("i", { style: { width: `${clamp(ratio / 2, 0.02, 1) * 100}%`, background: color } }), h("em", { class: "pol-limit" })),
        h("span", { class: "pol-v" }, `${Math.round(v)}`, h("small", null, unit)));
    })));
}

