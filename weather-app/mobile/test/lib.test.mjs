import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { normalize, parseOpenMeteoGeo, parsePhoton, placeFromNominatim } from "../src/api.js";
import * as F from "../src/lib/format.js";
import { moonPhaseIcon, uiIcon, weatherIcon } from "../src/lib/icons.js";
import * as M from "../src/lib/model.js";
import { sanitizePlace, sanitizeSettings } from "../src/lib/store.js";
import * as W from "../src/lib/weather.js";
import { deriveScene } from "../src/sky.js";

const wx = JSON.parse(readFileSync(new URL("./fixtures/forecast-london.json", import.meta.url)));
const aq = JSON.parse(readFileSync(new URL("./fixtures/aq-london.json", import.meta.url)));
// The fixture's "current" time is local London time (UTC+0); pretend we fetched it then.
const FETCHED = F.wall(wx.current.time) - wx.utc_offset_seconds * 1000;
const data = normalize(wx, aq, FETCHED);

// ---------------------------------------------------------------------------
test("wall times are never shifted by the device timezone", () => {
  const ms = F.wall("2026-11-20T21:15");
  assert.equal(F.isoHour(ms), "2026-11-20T21:00");
  assert.equal(F.isoDate(ms), "2026-11-20");
  assert.equal(F.wall("2026-01-05"), Date.UTC(2026, 0, 5));
  assert.equal(F.isoHour(F.locationNow(9 * 3600, Date.UTC(2026, 0, 1, 20, 30))), "2026-01-02T05:00");
});

test("unit conversions", () => {
  F.setUnits({ temp: "c", wind: "kmh", pressure: "hpa", precip: "mm" });
  assert.equal(F.temp(21.6), 22);
  assert.equal(F.temp(-0.4), 0); // never "-0"
  assert.equal(F.temp(null), "--");
  assert.equal(F.windValue(36), 36);
  assert.equal(F.precipValue(0.04), "<0.1");
  assert.equal(F.precipValue(12.4), "12");
  F.setUnits({ temp: "f", wind: "mph", pressure: "inhg", precip: "in" });
  assert.equal(F.temp(0), 32);
  assert.equal(F.temp(100), 212);
  assert.equal(F.tempDelta(5), 9);
  assert.equal(F.windValue(100), 62);
  assert.equal(F.pressureValue(1013.25), "29.92");
  assert.equal(F.precipValue(25.4), "1.00");
  assert.equal(F.distanceUnit(), "mi");
  F.setUnits({ temp: "c", wind: "ms", pressure: "hpa", precip: "mm" });
  assert.equal(F.windValue(18), 5);
  F.setUnits({ temp: "bogus", wind: "kmh" }); // invalid values are ignored
  assert.equal(F.tempUnit(), "°C");
});

test("time format preference", () => {
  F.setTimePref("12");
  const p12 = F.fmtTimeParts(F.wall("2026-11-20T23:22"));
  assert.equal(p12.main, "11:22");
  assert.match(p12.suffix, /pm/i);
  F.setTimePref("24");
  const p24 = F.fmtTimeParts(F.wall("2026-11-20T23:22"));
  assert.equal(p24.main, "23:22");
  assert.equal(p24.suffix, "");
  assert.match(F.fmtHour(F.wall("2026-11-20T15:00")), /15/);
  F.setTimePref("12");
  assert.match(F.fmtHour(F.wall("2026-11-20T15:00")), /3/);
  F.setTimePref("auto");
});

// ---------------------------------------------------------------------------
test("weather codes, scales and compass", () => {
  assert.equal(W.describe(0), "Clear");
  assert.equal(W.kindOf(95), "storm");
  assert.equal(W.describe(12345), "Cloudy"); // unknown codes degrade gracefully
  assert.ok(W.isWet(61) && W.isSnowy(73) && !W.isPrecip(2));
  assert.equal(W.aqiLevel(50).label, "Good");
  assert.equal(W.aqiLevel(51).label, "Moderate");
  assert.equal(W.aqiLevel(500).label, "Hazardous");
  assert.equal(W.aqiLevel(null), null);
  assert.equal(W.uvLevel(2).label, "Low");
  assert.equal(W.uvLevel(11).label, "Extreme");
  assert.equal(W.compass(0), "N");
  assert.equal(W.compass(359), "N");
  assert.equal(W.compass(-10), "N");
  assert.equal(W.compass(90), "E");
  assert.equal(W.compass(225), "SW");
  assert.equal(W.beaufort(0), "Calm");
  assert.equal(W.beaufort(130), "Hurricane force");
  assert.match(W.tempColor(20), /^rgb\(\d+,\d+,\d+\)$/);
});

test("moon phase matches known new and full moons", () => {
  const newMoon = W.moonInfo(Date.UTC(2025, 0, 29, 12, 36));
  assert.ok(newMoon.phase < 0.02 || newMoon.phase > 0.98, `new moon phase ${newMoon.phase}`);
  assert.ok(newMoon.illumination < 0.01);
  const fullMoon = W.moonInfo(Date.UTC(2025, 0, 13, 22, 27));
  assert.ok(Math.abs(fullMoon.phase - 0.5) < 0.02, `full moon phase ${fullMoon.phase}`);
  assert.equal(fullMoon.name, "Full moon");
  assert.ok(fullMoon.illumination > 0.99);
});

// ---------------------------------------------------------------------------
test("normalize() turns the real API response into a clean model", () => {
  assert.equal(data.v, 2);
  assert.equal(data.hourly.length, wx.hourly.time.length);
  assert.equal(data.daily.length, wx.daily.time.length);
  assert.equal(data.minutely.length, wx.minutely_15.time.length);
  assert.equal(typeof data.current.temp, "number");
  assert.equal(data.tz, "Europe/London");
  assert.ok(data.aq && typeof data.aq.aqi === "number");
  const withAqi = data.hourly.filter((h) => h.aqi != null);
  assert.ok(withAqi.length > 24, "air quality merged into hourly data");
  for (const h of data.hourly) {
    for (const [k, v] of Object.entries(h)) {
      assert.ok(v === null || typeof v !== "number" || Number.isFinite(v), `hourly.${k} is finite`);
    }
  }
});

test("normalize() rejects unusable responses", () => {
  assert.throws(() => normalize({}, null, 0));
  assert.throws(() => normalize({ current: {}, hourly: { time: [] }, daily: { time: [] } }, null, 0));
  const noAq = normalize(wx, null, FETCHED);
  assert.equal(noAq.aq, null);
  assert.ok(noAq.hourly.every((h) => h.aqi === null));
});

test("buildView() finds now/today and handles stale or expired data", () => {
  const now = FETCHED + 5 * 60000;
  const v = M.buildView(data, now);
  assert.ok(v);
  assert.equal(v.data.hourly[v.nowIdx].time, "2026-11-20T21:00");
  assert.equal(v.today.date, "2026-11-20");
  assert.equal(v.yesterday.date, "2026-11-19");
  assert.equal(v.hours24.length, 25);
  assert.equal(v.days.length, 10);
  assert.equal(v.cur.estimated, false);
  assert.equal(v.cur.temp, wx.current.temperature_2m);

  const later = M.buildView(data, FETCHED + 3 * 3600000);
  assert.equal(later.cur.estimated, true, "old observations are replaced by the hourly forecast");
  assert.equal(later.data.hourly[later.nowIdx].time, "2026-11-21T00:00");
  assert.equal(later.today.date, "2026-11-21");

  assert.equal(M.buildView(data, FETCHED + 30 * 86400000), null, "expired data must be refetched");
  assert.equal(M.buildView(null), null);
});

test("summaries produce readable sentences", () => {
  const v = M.buildView(data, FETCHED + 60000);
  const s = M.hourlySummary(v);
  assert.match(s, /^[A-Z].+\.$/);
  assert.ok(!/undefined|NaN|null/.test(s));
  const ds = M.daySummary(v.today, M.hoursOfDay(data, v.today.date));
  assert.match(ds, /high of -?\d+° and a low of -?\d+°/);
  assert.match(M.uvWindow(v), /\.$/);
  assert.ok(["Rising", "Falling", "Steady"].includes(M.pressureTrend(v).text));
  const tot = M.precipTotals(v);
  assert.ok(tot.next24 >= 0 && tot.last24 >= 0);
  assert.equal(typeof M.feelsReason(v.cur), "string");
});

test("nowcast: starting, stopping and nothing", () => {
  const base = M.buildView(data, FETCHED + 60000);
  const slots = (arr, code = 61) => arr.map((p, i) => ({ time: new Date(FETCHED + i * 15 * 60000).toISOString().slice(0, 16), precip: p, code }));
  const mk = (arr, code) => ({ ...base, data: { ...base.data, minutely: slots(arr, code) } });
  assert.equal(M.nowcast(mk([0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  const start = M.nowcast(mk([0, 0, 0.3, 0.5, 0.5, 0.2, 0, 0, 0]));
  assert.match(start.title, /^Rain starting in about 30 min$/);
  const stop = M.nowcast(mk([0.4, 0.4, 0.4, 0, 0, 0, 0, 0, 0]));
  assert.match(stop.title, /^Rain stopping in about 45 min$/);
  const snow = M.nowcast(mk([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2], 73));
  assert.equal(snow.title, "Snow for at least the next 2 hours");
  assert.equal(M.nowcast({ ...mk([0.4, 0.4, 0.4, 0, 0, 0, 0, 0, 0]), ageMin: 40 }), null, "too old to trust");
});

test("sunState() for day, night and polar days", () => {
  const v = M.buildView(data, FETCHED + 60000); // 21:15 in London in November: night
  const night = M.sunState(v);
  assert.equal(night.day, false);
  assert.ok(night.alt < 0 && night.p > 0 && night.p < 1);
  const noon = M.buildView(data, Date.UTC(2026, 10, 20, 12, 0));
  const day = M.sunState(noon);
  assert.equal(day.day, true);
  assert.ok(day.alt > 0.8);
  const polar = M.sunState({ ...v, today: { ...v.today, sunrise: null, sunset: null }, cur: { ...v.cur, isDay: true } });
  assert.equal(polar.day, true);
});

// ---------------------------------------------------------------------------
test("icons render for every code without NaN", () => {
  const codes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99, 7];
  for (const c of codes) {
    for (const day of [true, false]) {
      const svg = weatherIcon(c, day);
      assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
      assert.ok(!/NaN|undefined/.test(svg), `icon ${c}/${day}`);
    }
  }
  for (let p = 0; p <= 1; p += 0.05) assert.ok(!/NaN/.test(moonPhaseIcon(p)));
  assert.ok(!/undefined/.test(uiIcon("sunset")));
});

test("sky scene parameters stay in range", () => {
  for (const code of [0, 2, 3, 45, 61, 65, 75, 95, 99]) {
    for (const alt of [-1, -0.1, 0, 0.3, 1]) {
      const s = deriveScene({ code, cloud: 50, precip: 3, wind: 30, windDir: 90, sun: { day: alt > 0, p: 0.4, alt }, moonPhase: 0.3 });
      for (const k of ["alt", "p", "overcast", "cover", "rain", "snow", "windX", "slant"]) {
        assert.ok(Number.isFinite(s[k]), `${k} for ${code}`);
      }
      assert.ok(s.cover >= 0 && s.cover <= 1);
    }
  }
  assert.ok(deriveScene({ code: 95, sun: null }).lightning);
  assert.ok(deriveScene({ code: 73, sun: null }).snow > 0);
});

// ---------------------------------------------------------------------------
test("stored data is validated before use", () => {
  assert.equal(sanitizePlace({ name: "X", lat: 91, lon: 0 }), null);
  assert.equal(sanitizePlace({ name: "X", lat: "1", lon: 0 }), null);
  const p = sanitizePlace({ id: "g123", name: "  Pune\u0000 ", lat: 18.5, lon: 73.8, admin1: "MH", country: "India" });
  assert.equal(p.name, "Pune");
  assert.equal(p.id, "g123");
  const weird = sanitizePlace({ id: "<img src=x>", name: "A", lat: 1, lon: 2 });
  assert.match(weird.id, /^c1\.000,2\.000$/, "unsafe ids are replaced");
  const legacy = sanitizePlace({ name: "Mumbai", latitude: 19.07, longitude: 72.88 });
  assert.equal(legacy.lat, 19.07, "v1 places migrate");
  const s = sanitizeSettings({ temp: "f", wind: "lightyears", effects: "ultra", animate: "yes", useLocation: true });
  assert.equal(s.temp, "f");
  assert.equal(s.wind, "kmh");
  assert.equal(s.effects, "auto");
  assert.equal(s.animate, true);
  assert.equal(s.useLocation, true);
});

// ---------------------------------------------------------------------------
test("no network data can reach an HTML sink", () => {
  const src = new URL("../src/", import.meta.url).pathname;
  const files = [];
  const walk = (d) => readdirSync(d).forEach((f) => {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) files.push(p);
  });
  walk(src);
  const allowed = /innerHTML = (uiIcon|weatherIcon)\(|el\.innerHTML = v; \/\/ static icon markup only/;
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/\b(eval|Function)\s*\(|document\.write|insertAdjacentHTML|outerHTML/.test(line) && !/new Path2D|typeof .* === "function"/.test(line)) {
        assert.fail(`${f}:${i + 1} uses a dangerous API: ${line.trim()}`);
      }
      if (/innerHTML/.test(line) && !allowed.test(line)) assert.fail(`${f}:${i + 1} unexpected innerHTML: ${line.trim()}`);
      if (/setAttribute\(\s*["']style/.test(line)) assert.fail(`${f}:${i + 1} inline style attribute would be blocked by the CSP`);
    });
  }
});

// ---------------------------------------------------------------------------
const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));

test("search finds the right village and labels same-named places by district", () => {
  const res = parsePhoton(fx("photon-devpur.json"));
  const devpurs = res.filter((r) => r.name === "Devpur" && r.admin1 === "Maharashtra");
  assert.equal(devpurs.length, 2, "both Devpurs in Maharashtra are found");
  assert.equal(devpurs[0].admin2, "Sample Subdistrict", "the nearer one ranks first");
  assert.ok(Math.abs(devpurs[0].lat - 19.60) < 0.01 && Math.abs(devpurs[0].lon - 75.20) < 0.01);
  assert.equal(devpurs[1].admin2, "Other Taluka");
  assert.ok(res.every((r) => /^p[\w.,-]+$/.test(r.id) && r.id.length <= 40), "ids are storage-safe");
  const london = parsePhoton(fx("photon-london.json"));
  assert.equal(london[0].country, "United Kingdom");
  assert.deepEqual(parsePhoton(null), []);
  assert.deepEqual(parsePhoton({ features: [{ properties: { name: "X" }, geometry: { coordinates: [500, 2] } }] }), [], "bad coordinates are dropped");
});

test("Open-Meteo fallback search keeps the district", () => {
  const res = parseOpenMeteoGeo({ results: [{ id: 1, name: "Devpur", admin1: "Maharashtra", admin2: "Other District", country: "India", latitude: 20.28, longitude: 78.72 }] });
  assert.equal(res[0].admin2, "Other District");
});

test("my location shows the village, not the taluka", () => {
  const z14 = placeFromNominatim(fx("nominatim-reverse-devpur-z14.json"));
  assert.equal(z14.name, "Devpur");
  assert.equal(z14.admin2, "Sample Subdistrict");
  assert.equal(z14.admin1, "Maharashtra");
  const city = placeFromNominatim({ address: { suburb: "Kothrud", city: "Pune", state: "Maharashtra", country: "India" } });
  assert.equal(city.name, "Kothrud");
  assert.equal(city.admin2, "Pune");
  assert.equal(placeFromNominatim({}).name, "My location");
});

test("saved places keep their district", () => {
  const p = sanitizePlace({ id: "pN1000000001", name: "Devpur", admin2: "Sample Subdistrict", admin1: "Maharashtra", country: "India", lat: 19.6, lon: 75.2 });
  assert.equal(p.admin2, "Sample Subdistrict");
  assert.equal(p.id, "pN1000000001");
});

// ---------------------------------------------------------------------------
import { alertSummary, reliabilityItems, reliabilitySummary } from "../src/alerts.js";
import { BACKGROUND_QUERY } from "../src/api.js";
import { lateText, logText } from "../src/ui/reliability.js";
import { sanitizeAlert } from "../src/lib/store.js";

test("temperature alert rules are validated and described clearly", () => {
  const ok = sanitizeAlert({ id: "a1x", placeId: "pN1000000001", op: "below", value: 10, metric: "temp", repeat: "always", enabled: true });
  assert.equal(ok.op, "below");
  assert.equal(sanitizeAlert({ ...ok, op: "sideways" }), null);
  assert.equal(sanitizeAlert({ ...ok, value: 999 }), null);
  assert.equal(sanitizeAlert({ ...ok, value: "10" }), null);
  assert.equal(sanitizeAlert({ ...ok, id: "<x>" }), null);
  assert.equal(sanitizeAlert({ ...ok, enabled: "yes" }).enabled, false);
  F.setUnits({ temp: "c" });
  assert.equal(alertSummary(ok, { name: "Devpur" }), "Devpur · drops to 10°C · every time");
  assert.equal(alertSummary({ ...ok, op: "above", value: 35, metric: "feels", repeat: "once" }, { current: true, name: "Devpur" }), "My location · rises to 35°C (feels like) · once");
  F.setUnits({ temp: "f" });
  assert.equal(alertSummary(ok, { name: "Devpur" }), "Devpur · drops to 50°F · every time");
  F.setUnits({ temp: "c" });
  assert.match(alertSummary(ok, null), /^Removed place/);
});

test("reliability checklist explains exactly what can delay alerts", () => {
  const good = { notifications: true, channelsBlocked: false, exact: true, battery: "unrestricted", brand: "" };
  const reliabilityProblems = (x) => reliabilityItems(x).filter((i) => i.ok === false).length;
  assert.equal(reliabilityProblems(good), 0);
  assert.deepEqual([reliabilitySummary(good).warn, reliabilitySummary(good).title], [false, "Nothing is blocking alerts"]);
  assert.match(reliabilitySummary({ ...good, brand: "vivo" }).text, /can stop background apps/);
  assert.equal(reliabilitySummary({ ...good, brand: "vivo", test: { late: 1 } }).title, "Alerts arrive on time");
  assert.equal(reliabilitySummary({ ...good, battery: "optimized" }).warn, false, "background running is optional");
  assert.equal(reliabilityItems(good).length, 3);
  assert.equal(reliabilityProblems({ ...good, battery: "optimized" }), 0);
  assert.equal(reliabilityProblems({ ...good, exact: false, battery: "restricted", channelsBlocked: true }), 3);
  const xiaomi = reliabilityItems({ ...good, brand: "xiaomi" });
  assert.match(xiaomi[3].text, /Autostart/);
  assert.equal(xiaomi[3].ok, null, "Android can't tell us, so it is never shown as done or failed");
  assert.equal(reliabilityItems({ ...good, brand: "xiaomi", heldAt: 5 })[3].ok, false, "evidence that the phone held an alert back");
  assert.match(reliabilityItems({ ...good, heldAt: 5 })[3].text, /didn't arrive until you opened the app/);
  assert.equal(reliabilityItems({ ...good, dataBlocked: true })[3].key, "data");
  assert.deepEqual(reliabilityItems(null), []);
  assert.equal(logText({ why: "sunset", note: "sunset", idle: true }), "Sunset alert, phone asleep");
  assert.equal(logText({ why: "sunset", note: "Held back by the phone" }), "Sunset alert: held back by your phone");
  assert.equal(logText({ why: "sunrise", note: "sunrise (notifications blocked)" }), "Sunrise (notifications blocked)");
  assert.equal(logText({ why: "temperature", note: "temperature 22°C, alert sent" }), "Temperature 22°C, alert sent");
  assert.equal(logText({ why: "temperature" }), "Temperature check");
  assert.equal(lateText(3000), "on time");
  assert.equal(lateText(45000), "45 s late");
  assert.equal(lateText(16 * 60000), "16 min late");
});

test("the background refresh asks for the same data as the app", () => {
  for (const q of Object.values(BACKGROUND_QUERY)) assert.match(q, /^[a-z0-9_,=&]+$/, "accepted by the native side's safety check");
  assert.match(BACKGROUND_QUERY.forecast, /past_days=1&forecast_days=10/);
});

test("alerts remember the temperature they were created at", () => {
  const a = sanitizeAlert({ id: "a1", placeId: "current", op: "below", value: 10, base: 17.256, enabled: true });
  assert.equal(a.base, 17.26);
  assert.ok(!("base" in sanitizeAlert({ ...a, base: "x" })));
  assert.equal(sanitizePlace({ id: "x", name: "A", lat: 1, lon: 2, tz: "Asia/Kolkata" }).tz, "Asia/Kolkata");
  assert.equal(sanitizePlace({ id: "x", name: "A", lat: 1, lon: 2, tz: "<b>" }).tz, "");
});

import { compassHint, readingText, turn } from "../src/ui/compass.js";

test("compass turns the short way round and reads directions", () => {
  assert.equal(turn(350, 10), 20);
  assert.equal(turn(10, 350), -20);
  assert.equal(turn(725, 10), 5, "works after several full turns");
  assert.equal(readingText(359.7), "0° N");
  assert.equal(readingText(-90), "270° W");
  assert.equal(readingText(72), "72° E");
  assert.match(compassHint(1, 45), /figure 8/);
  assert.match(compassHint(3, 120), /magnet/);
  assert.equal(compassHint(3, 45), "");
  assert.equal(compassHint(-1, 0), "", "nothing known yet is not a problem");
});
