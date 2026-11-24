// Visual QA for the sky renderer: rewrites the app's cached forecast for the active
// place (weather + sunrise/sunset around "now"), reloads, and screenshots each scene.
// Uses only the app's normal data path — no debug hooks ship in the app.
// Usage: node e2e/scenes.mjs --shots DIR

import { SHOTS, connect, js, screenshot, sleep, waitFor } from "./lib.mjs";

const H = 3600e3;
const ONLY_SCENE = process.argv.includes("--scene") ? process.argv[process.argv.indexOf("--scene") + 1] : null;
const SCENES = [
  { name: "clear-noon", code: 0, cloud: 4, precip: 0, rise: -6, set: 6 },
  { name: "partly-morning", code: 2, cloud: 45, precip: 0, rise: -1.6, set: 9 },
  { name: "golden-hour", code: 1, cloud: 18, precip: 0, rise: -9.6, set: 0.4 },
  { name: "clear-night", code: 0, cloud: 0, precip: 0, rise: -14, set: -4, nextRise: 8 },
  { name: "cloudy-day", code: 3, cloud: 96, precip: 0, rise: -3, set: 6 },
  { name: "rain-day", code: 63, cloud: 98, precip: 3.2, rise: -4, set: 5 },
  { name: "storm-night", code: 95, cloud: 100, precip: 7, rise: -15, set: -3, nextRise: 9 },
  { name: "snow-day", code: 73, cloud: 95, precip: 1.4, rise: -3, set: 5 },
  { name: "fog-morning", code: 45, cloud: 92, precip: 0, rise: -0.9, set: 9 },
];

await connect();
for (const sc of SCENES.filter((x) => !ONLY_SCENE || x.name === ONLY_SCENE)) {
  await js(`(async () => {
    const P = Capacitor.Plugins.Preferences;
    const id = JSON.parse((await P.get({ key: "v2.active" })).value);
    const d = JSON.parse((await P.get({ key: "v2.wx." + id })).value);
    const now = Date.now() + d.utcOffset * 1000;
    const iso = (ms) => new Date(ms).toISOString().slice(0, 16);
    const sc = ${JSON.stringify(sc)};
    const rise = now + sc.rise * ${H}, set = now + sc.set * ${H};
    const nextRise = now + (sc.nextRise ?? sc.rise + 24) * ${H};
    const isDay = (t) => (t >= rise && t <= set) || t >= nextRise;
    const today = d.daily.findIndex((x) => x.date === iso(now).slice(0, 10));
    d.daily[today].sunrise = iso(rise);
    d.daily[today].sunset = iso(set);
    d.daily[today].code = sc.code;
    if (d.daily[today + 1]) d.daily[today + 1].sunrise = iso(nextRise);
    Object.assign(d.current, { time: iso(now), code: sc.code, cloud: sc.cloud, precip: sc.precip, isDay: isDay(now), wind: 18, windDir: 250 });
    const i = d.hourly.findIndex((h) => h.time === iso(now).slice(0, 13) + ":00");
    for (let j = Math.max(0, i - 2); j < Math.min(d.hourly.length, i + 30); j++) {
      const t = Date.parse(d.hourly[j].time + ":00Z");
      Object.assign(d.hourly[j], { code: sc.code, cloud: sc.cloud, precip: sc.precip, pop: sc.precip > 0 ? 85 : 5, isDay: isDay(t) });
    }
    d.minutely = d.minutely.map((m) => ({ ...m, precip: sc.precip / 4, code: sc.code }));
    d.fetchedAt = Date.now();
    await P.set({ key: "v2.wx." + id, value: JSON.stringify(d) });
    location.reload();
    return true;
  })()`).catch(() => {}); // the reload tears down this evaluation
  await sleep(1500);
  await connect();
  await waitFor(`!document.getElementById("view-main").classList.contains("hidden")`, 10000, "main view");
  await sleep(2500); // let clouds/particles move and palette settle
  screenshot(`scene-${sc.name}`);
  const info = await js(`({ cond: document.querySelector(".hero-cond").textContent, lite: document.documentElement.classList.contains("lite") })`);
  console.log(`  ${sc.name.padEnd(15)} ${info.cond}${info.lite ? " (lite)" : ""}`);
}
console.log(SHOTS ? `\nScreenshots in ${SHOTS}` : "\n(no --shots dir given)");
process.exit(0);
