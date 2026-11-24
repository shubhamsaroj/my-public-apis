// System test of background alerts: deep sleep, killed app, reboot, update, no internet.
//
// Works on debug AND release builds: it drives the screen through Android's accessibility tree and
// checks Android's own records (alarms, notifications) and the app's saved state, never DevTools.
// Needs an emulator image with root (google_apis) and network. It moves the emulator's clock.
// With --no-ui (old WebViews hide their sheets from screen dumps) alerts are set up in the saved state
// instead, and checks of what the screen says are skipped.
//
//   node e2e/alerts.mjs [--apk path] [--only name,name] [--shots DIR] [--keep]

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const ADB = `${process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
const PKG = "com.techbyshubhamsaroj.weatherwise";
const CITY = "Nagpur";
const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const UI = !process.argv.includes("--no-ui");
const APK = arg("--apk"), ONLY = arg("--only")?.split(","), SHOTS = arg("--shots");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync(ADB, a, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const sh = (c) => { try { return adb("shell", c); } catch (e) { return String(e.stdout || ""); } };
const shot = (n) => SHOTS && writeFileSync(`${SHOTS}/${n}.png`, execFileSync(ADB, ["exec-out", "screencap", "-p"], { maxBuffer: 64 << 20 }));
const assert = (c, m) => { if (!c) throw new Error(m); };
const SDK = Number(sh("getprop ro.build.version.sdk"));
const now = () => Number(sh("date +%s%3N"));
const hm = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: sh("getprop persist.sys.timezone").trim() || "UTC" });
async function until(what, ms, fn) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(1000);
  }
}

// ---------------------------------------------------------------------------------- the phone
const decode = (s) => s.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&#10;", "\n").replaceAll("&amp;", "&");
const encode = (s) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const prefsFile = (n) => `/data/data/${PKG}/shared_prefs/${n}.xml`;
function prefs(n) {
  const out = {};
  for (const m of sh(`cat ${prefsFile(n)}`).matchAll(/<(string|long|int|float|boolean) name="([^"]+)"(?: value="([^"]*)")?\s*(?:\/>|>([^<]*)<\/string>)/g)) {
    out[m[2]] = m[1] === "string" ? decode(m[4] || "") : m[1] === "boolean" ? m[3] === "true" : Number(m[3]);
  }
  return out;
}
const state = () => prefs("weatherwise_alert_state");
const rules = () => JSON.parse(prefs("CapacitorStorage")["v2.alerts"] || "[]");
const log = () => JSON.parse(state().log || "[]");

/** Edit saved state while the app isn't running (keeps the file's owner). */
function edit(n, change) {
  assert(!sh(`pidof ${PKG}`).trim(), "app must be stopped before editing its files");
  const xml = change(sh(`cat ${prefsFile(n)}`));
  writeFileSync(`/tmp/ww-${process.pid}.xml`, xml);
  adb("push", `/tmp/ww-${process.pid}.xml`, "/data/local/tmp/ww.xml");
  sh(`cat /data/local/tmp/ww.xml > ${prefsFile(n)}; rm /data/local/tmp/ww.xml`);
}
const setState = (o) => edit("weatherwise_alert_state", (xml) => {
  for (const [k, v] of Object.entries(o)) {
    xml = xml.replace(new RegExp(`\\s*<(long|boolean|float|int) name="${k}" value="[^"]*" />`), "");
    if (v !== null) xml = xml.replace("</map>", `    <${typeof v === "boolean" ? "boolean" : "long"} name="${k}" value="${v}" />\n</map>`);
  }
  return xml;
});
/** Write app storage directly (--no-ui). */
const setStore = (o) => edit("CapacitorStorage", (xml) => {
  for (const [k, v] of Object.entries(o)) {
    xml = xml.replace(new RegExp(`\\s*<string name="${k.replaceAll(".", "\\.")}">[^<]*</string>`), "");
    xml = xml.replace("</map>", `    <string name="${k}">${encode(JSON.stringify(v))}</string>\n</map>`);
  }
  return xml;
});
const PLACE = { id: "pTest1", name: CITY, admin2: "", admin1: "Maharashtra", country: "India", tz: "Asia/Kolkata", lat: 21.1498, lon: 79.0821, current: false };
const setRules = (change) => edit("CapacitorStorage", (xml) => xml.replace(/(<string name="v2\.alerts">)([^<]*)(<\/string>)/,
  (_, a, j, b) => a + encode(JSON.stringify(change(JSON.parse(decode(j))))) + b));

/** Our one pending alarm as Android sees it (not the history of removed ones, which lacks origWhen). */
function alarm() {
  const d = sh("dumpsys alarm");
  const i = d.search(new RegExp(`tag=\\*walarm\\*:${PKG.replaceAll(".", "\\.")}\\.WAKE\\s+type=RTC_WAKEUP origWhen`));
  if (i < 0) return null;
  const text = d.slice(i, i + 900);
  return { exact: /window=0\s/.test(text.replace(/window=\+?0(ms)?\s/, "window=0 ")), text };
}
let since = 0; // only notifications posted after the step cleared the shade count
function notifications() {
  return sh("dumpsys notification --noredact").split(/NotificationRecord\(/).slice(1).filter((r) => r.slice(0, 200).includes(`pkg=${PKG} `)).map((r) => ({
    title: (r.match(/android\.title=String \(([\s\S]*?)\)\n/) || [])[1] || "",
    text: (r.match(/android\.text=String \(([\s\S]*?)\)\n/) || [])[1] || "",
    at: Number((r.match(/mUpdateTimeMs=(\d+)/) || [])[1]),
  })).filter((n) => n.at >= since);
}
const clearNotifications = () => { since = now(); };
const doze = () => sh("dumpsys deviceidle get deep").trim();
/** Screen off, on battery, deep Doze, app process dead: a phone on the bedside table. */
async function deepSleep() {
  home();
  await sleep(1500);
  kill();
  sh("input keyevent KEYCODE_SLEEP");
  await sleep(1500);
  sh("dumpsys battery unplug; dumpsys deviceidle force-idle deep");
  await sleep(500);
  // A system broadcast (clock change, network change) may have started it again for a moment.
  for (let i = 0; i < 5 && sh(`pidof ${PKG}`).trim(); i++) { kill(); await sleep(700); }
  assert(doze() === "IDLE", `could not enter deep Doze (${doze()})`);
  assert(!sh(`pidof ${PKG}`).trim(), "app process is still alive");
}
async function wake() {
  sh("dumpsys deviceidle unforce; dumpsys battery reset; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard");
  await sleep(1200);
}
const home = () => sh("input keyevent KEYCODE_HOME");
function kill() {
  const pid = sh(`pidof ${PKG}`).trim();
  if (pid) sh(`kill -9 ${pid}`);
}
const open = async (ms = 4500) => { sh(`am start -W -n ${PKG}/.MainActivity`); await sleep(ms); };
const openFresh = async (ms = 5000) => { home(); await sleep(1200); kill(); await sleep(500); await open(ms); };
const setClock = async (ms) => { sh(`cmd alarm set-time ${Math.round(ms)}`); await sleep(3500); };
const airplane = (on) => sh(`cmd connectivity airplane-mode ${on ? "enable" : "disable"}`);
const online = () => until("network", 45000, () => /VALIDATED/.test(sh("dumpsys connectivity | grep -m3 -E 'NetworkAgentInfo.*CONNECTED'")) || sh("ping -c1 -W2 8.8.8.8 | grep -c '1 received'").trim() === "1");

// ---------------------------------------------------------------------------------- the screen
function nodes() {
  let xml = "";
  for (let i = 0; i < 5 && !xml.includes("<node"); i++) xml = sh("rm -f /sdcard/u.xml; uiautomator dump /sdcard/u.xml >/dev/null 2>&1; cat /sdcard/u.xml 2>/dev/null");
  return [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
    const g = (k) => decode((m[0].match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || "");
    const b = g("bounds").match(/\d+/g)?.map(Number) || [0, 0, 0, 0];
    return { t: g("text") || g("content-desc") || (g("class").endsWith("EditText") ? "«text field»" : ""), x: (b[0] + b[2]) >> 1, y: (b[1] + b[3]) >> 1, h: b[3] - b[1] };
  }).filter((n) => n.t && n.h > 4);
}
const screen = () => nodes().map((n) => n.t).join(" | ");
async function find(re, tries = 14) {
  for (let i = 0; i < tries; i++) {
    const n = nodes().find((x) => re.test(x.t));
    if (n) return n;
    await sleep(700);
  }
  throw new Error(`not on screen: ${re}\n  ${screen().slice(0, 400)}`);
}
async function tap(re, tries) { const n = await find(re, tries); sh(`input tap ${n.x} ${n.y}`); await sleep(900); }
async function scrollTap(re) {
  const [w, hgt] = sh("wm size").match(/(\d+)x(\d+)\s*$/m).slice(1).map(Number);
  for (let i = 0; i < 14; i++) {
    const n = nodes().find((x) => re.test(x.t) && x.y > hgt * 0.2 && x.y < hgt * 0.88);
    if (n) { sh(`input tap ${n.x} ${n.y}`); await sleep(1200); return; }
    sh(`input swipe ${w / 2} ${hgt * 0.72 | 0} ${w / 2} ${hgt * 0.42 | 0} 350`);
    await sleep(700);
  }
  throw new Error(`could not scroll to ${re}`);
}
const back = async () => { sh("input keyevent KEYCODE_BACK"); await sleep(800); };
async function allowIfAsked() { try { await tap(/^Allow$/, 4); } catch { /* not asked */ } }

// ---------------------------------------------------------------------------------- runner
const results = [];
async function step(name, fn) {
  if (ONLY && !ONLY.some((o) => name.includes(o))) return;
  try {
    const note = await fn();
    results.push(true);
    console.log(`  ✔ ${name}${note ? `\n      ${note}` : ""}`);
  } catch (e) {
    results.push(false);
    console.log(`  ✖ ${name}\n      ${e.message}`);
    try { shot(`FAIL-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}`); } catch { /* no screen */ }
  } finally {
    airplane(false);
    await wake();
  }
}

// The hardest settings Android allows: not exempt from battery saving, rarely used app.
function hardMode() {
  sh(`dumpsys deviceidle whitelist -${PKG}; am set-standby-bucket ${PKG} rare`);
}
const inDoze = () => { const d = doze(); assert(d === "IDLE" || d === "IDLE_MAINTENANCE", `phone was not asleep when the alert came (${d})`); };

console.log(`Background alert test · Android API ${SDK}\n`);
try { adb("root"); } catch { /* already */ }
await sleep(2500);
assert(sh("whoami").trim() === "root", "needs an emulator image with root");
sh("settings put global auto_time 0; settings put global stay_on_while_plugged_in 0");
// Older Android's screen dump waits for a still picture, which the animated sky never is.
if (SDK < 33) sh("settings put global animator_duration_scale 0; settings put global transition_animation_scale 0; settings put global window_animation_scale 0");
if (APK) { adb("install", "-r", "-g", APK); sh(`pm revoke ${PKG} android.permission.POST_NOTIFICATIONS`); }
if (!process.argv.includes("--keep")) sh(`pm clear ${PKG}`);
await wake();
airplane(false);
await online();

await step("setup: add a city, switch on the sunset alert through the app", async () => {
  await open();
  if (!UI) {
    home(); await sleep(1500); kill();
    setStore({ "v2.places": [PLACE], "v2.active": PLACE.id, "v2.settings": { ...JSON.parse(prefs("CapacitorStorage")["v2.settings"] || "{}"), notifySunset: true, notifyLead: "15", notifyPlaceId: PLACE.id } });
    await open(6000);
    const st = state(), a = alarm();
    assert(st["wake.why"] === "sunset" && a && a.exact, `alarm: ${JSON.stringify(st)} ${a?.text}`);
    return `one exact alarm, set for ${hm(st["wake.at"])} (set up without the screen)`;
  }
  await tap(/^Search for a city$/);
  await sleep(1200);
  sh(`input text ${CITY}`);
  await sleep(4500);
  await tap(new RegExp(`^${CITY} .*India`));
  await sleep(6000);
  await tap(/^Settings$/);
  await sleep(800);
  await scrollTap(/^Sunset/);
  await allowIfAsked();
  assert(!/Make alerts reliable/.test(screen()), "nothing is wrong, so nothing should pop up");
  const st = state(), a = alarm();
  assert(st["wake.why"] === "sunset" && a && a.exact, `alarm: ${JSON.stringify(st)} ${a?.text}`);
  return `one exact alarm, set for ${hm(st["wake.at"])}`;
});

await step("sunset alert: deep sleep, app killed, rarely used app, no battery exemption", async () => {
  hardMode();
  const t = state()["wake.at"];
  assert(state()["wake.why"] === "sunset", state()["wake.why"]);
  await setClock(t - 60000);
  clearNotifications();
  await deepSleep();
  hardMode();
  const n = await until("sunset notification", 110000, () => notifications().find((x) => /Sunset/.test(x.title)));
  inDoze();
  const late = (n.at - t) / 1000;
  assert(late >= -1 && late < 10, `${late.toFixed(1)} s late`);
  assert(/Sunset in 15 min/.test(n.title) && n.text.startsWith(CITY), `${n.title} / ${n.text}`);
  await sleep(4000);
  const next = state()["wake.at"];
  assert(Math.abs(next - t - 86400000) < 5 * 60000, `next alarm ${new Date(next).toISOString()}`);
  return `due ${hm(t)}, shown ${late.toFixed(1)} s later, phone still asleep: "${n.title}" / "${n.text}"`;
});

await step("sunset alert: also when Android had no internet at all", async () => {
  const t = state()["wake.at"];
  airplane(true);
  await setClock(t - 45000);
  clearNotifications();
  await deepSleep();
  const n = await until("sunset notification", 100000, () => notifications().find((x) => /Sunset/.test(x.title)));
  const late = (n.at - t) / 1000;
  assert(late >= -1 && late < 12, `${late.toFixed(1)} s late`);
  return `${late.toFixed(1)} s after its time, offline: "${n.title}"`;
});

await step("temperature alert: deep sleep, app killed, real internet request", async () => {
  await online();
  if (UI) {
    await open();
    await tap(/^Settings$/);
    await sleep(800);
    await scrollTap(/Add a temperature alert/);
    await tap(/^Save alert$/);
    await allowIfAsked();
    await sleep(5000);
  } else {
    home(); await sleep(1500); kill();
    setStore({ "v2.alerts": [{ id: "aTest1", placeId: PLACE.id, op: "below", value: -20, base: 20, metric: "temp", repeat: "always", enabled: true, createdAt: now() }] });
    await open(3000);
    await until("first reading", 25000, () => typeof state()["aTest1.value"] === "number");
  }
  const [r] = rules();
  const first = state();
  assert(typeof first[`${r.id}.value`] === "number" && first[`${r.id}.armed`] === true, `first reading: ${JSON.stringify(first)}`);
  // Pretend the limit is 1° above the real current temperature, as if it had just dropped past it.
  home(); await sleep(1500); kill();
  setRules((list) => list.map((x) => ({ ...x, value: Math.round((first[`${r.id}.value`] + 1) * 10) / 10 })));
  const due = now() + 75000;
  setState({ "temp.next": due });
  await open(5000);
  assert(state()["wake.why"] === "temperature" && Math.abs(state()["wake.at"] - due) < 2000, `alarm for ${state()["wake.why"]}`);
  clearNotifications();
  hardMode();
  await deepSleep();
  hardMode();
  const n = await until("temperature notification", 130000, () => notifications().find((x) => /°C in /.test(x.title)));
  inDoze();
  assert(/dropped to/.test(n.text) && !/forecast/.test(n.text), `used live data: ${n.text}`);
  const low = n.text.match(/Expected low: (-?\d+)/), is = n.text.match(/dropped to (-?\d+)/);
  assert(!low || Number(low[1]) < Number(is[1]), `expected low is not lower: ${n.text}`);
  await sleep(3000);
  const st = state();
  assert(st[`${r.id}.armed`] === false, "disarmed after firing");
  assert(st["wake.at"] > now(), "next alarm is set");
  return `due ${hm(due)}, shown ${((n.at - due) / 1000).toFixed(1)} s later, phone still asleep: "${n.title}" / "${n.text}"`;
});

await step("temperature alert: no internet, uses the saved forecast and says so", async () => {
  home(); await sleep(1000); kill();
  const [r] = rules();
  setRules((list) => list.map((x) => ({ ...x, value: 45 })));
  const due = now() + 70000;
  setState({ "temp.next": due, [`${r.id}.armed`]: true, [`${r.id}.last`]: 0 });
  await open(5000);
  airplane(true);
  clearNotifications();
  await deepSleep();
  const n = await until("temperature notification", 130000, () => notifications().find((x) => /°C in /.test(x.title)));
  assert(/Based on the forecast/.test(n.text), n.text);
  return `"${n.text}"`;
});

await step("one-time alert fires once, then switches itself off", async () => {
  await online();
  home(); await sleep(1000); kill();
  const [r] = rules();
  setRules((list) => list.map((x) => ({ ...x, value: 46, repeat: "once" })));
  const due = now() + 50000;
  setState({ "temp.next": due, [`${r.id}.armed`]: true, [`${r.id}.last`]: 0 });
  await open(4000);
  clearNotifications();
  await deepSleep();
  const n = await until("temperature notification", 110000, () => notifications().find((x) => /One-time alert, now off/.test(x.text)));
  await sleep(3000);
  assert(rules()[0].enabled === false, "rule still on");
  assert(state()["wake.why"] === "sunset", `still checking temperatures: ${state()["wake.why"]}`);
  if (!UI) return n.text;
  await wake();
  await open();
  await tap(/^Settings$/);
  await sleep(1500);
  await scrollTap(/ALERT RELIABILITY/i);
  assert(/Triggered and switched off/.test(screen()), screen().slice(0, 500));
  await back();
  return n.text;
});

await step("an alert the phone held back is delivered when the app opens, and the app says why", async () => {
  await openFresh();
  const t = state()["wake.at"];
  assert(state()["wake.why"] === "sunset", state()["wake.why"]);
  await until("uptime", 900000, () => Number(sh("cat /proc/uptime").split(" ")[0]) > 860); // a phone that was just off isn't to blame
  sh(`am force-stop ${PKG}`); // what aggressive phones do to background apps
  assert(!alarm(), "force-stop should have removed the alarm");
  await setClock(t + 4 * 60000);
  clearNotifications();
  await open(5000);
  const n = await until("late sunset notification", 8000, () => notifications().find((x) => /Sunset in 1[01] min/.test(x.title)));
  assert(state()["held.at"] > 0, "not remembered");
  assert(/Held back/.test(log()[0].note), JSON.stringify(log()[0]));
  const count = notifications().length;
  await open(3000);
  assert(notifications().length === count, "shown twice");
  if (!UI) return `"${n.title}"`;
  await find(/Stopped by your phone|Autostart on/); // the explanation opens by itself, once
  shot("02-held-back");
  await back();
  await openFresh();
  await sleep(2500);
  assert(!/Make alerts reliable/.test(screen()), "shown again although already seen");
  return `"${n.title}", and the app explained it once`;
});

if (UI) await step("1-minute test: app closed, screen off", async () => {
  await online();
  await openFresh();
  await tap(/^Settings$/);
  await sleep(1000);
  await scrollTap(/can delay alerts|Nothing is blocking alerts|Alerts arrive on time/);
  await tap(/^Start 1-minute test$/);
  await sleep(1500);
  assert(/Now lock your phone/.test(screen()), screen().slice(0, 400));
  clearNotifications();
  await deepSleep();
  const n = await until("test notification", 100000, () => notifications().find((x) => /Alerts work|Alerts are delayed/.test(x.title)));
  const r = JSON.parse(state()["test.result"]);
  assert(r.late <= 5 && r.net && r.idle, JSON.stringify(r));
  await wake();
  await open(4000);
  await tap(/^Settings$/);
  await sleep(1000);
  await scrollTap(/can delay alerts|Nothing is blocking alerts|Alerts arrive on time/);
  await sleep(1200);
  assert(/Last test: on time while the phone was asleep/.test(screen()), screen().slice(0, 500));
  shot("03-test-passed");
  await back(); await back();
  return `${n.title}: ${n.text}`;
});

await step("background refresh: the app opens with newer data than it was closed with, even offline", async () => {
  await online();
  await open(6000);
  home(); await sleep(1500); kill();
  const file = sh(`ls /data/data/${PKG}/files/weather/ | grep ^wx- | head -1`).trim();
  if (file) sh(`rm /data/data/${PKG}/files/weather/${file}`);
  await setClock(now() + 130 * 60000); // the job is due about hourly; forcing it earlier does nothing
  const id = (sh(`dumpsys jobscheduler`).match(new RegExp(`JOB (?:androidx\\.work\\.systemjobscheduler:)?#?u0a\\d+/(\\d+):[^\\n]*${PKG.replaceAll(".", "\\.")}/androidx\\.work`)) || [])[1];
  assert(id, "hourly job is not scheduled");
  const run = sh(`cmd jobscheduler run -f -n androidx.work.systemjobscheduler ${PKG} ${id} 2>&1 || cmd jobscheduler run -f ${PKG} ${id}`);
  const path = await until("background forecast file", 40000, () => sh(`ls /data/data/${PKG}/files/weather/ | grep ^wx- | head -1`).trim());
  const o = JSON.parse(sh(`cat /data/data/${PKG}/files/weather/${path}`));
  assert(now() - o.fetchedAt < 120000 && o.wx.hourly && o.aq, `file: fetched ${o.fetchedAt}`);
  await sleep(1500);
  airplane(true);
  await sleep(2500);
  await open(6000);
  let seen = "";
  for (let i = 0; i < 8 && !seen; i++) {
    sh("input swipe 500 1800 500 500 120");
    await sleep(500);
    seen = (screen().match(/Offline · updated[^|]*/) || [])[0] || "";
  }
  assert(/just now|[1-4] min/.test(seen), `footer: ${seen || screen().slice(-300)}`);
  return `${run.trim().split("\n").pop()} · footer offline: "${seen.trim()}"`;
});

if (APK) await step("app updated: the alarm survives without opening the app", async () => {
  home(); await sleep(1000);
  adb("install", "-r", APK);
  const a = await until("alarm after update", 30000, () => alarm());
  assert(a.exact, a.text);
  return `${state()["wake.why"]} alarm for ${hm(state()["wake.at"])}`;
});

if (UI) await step("tapping a notification opens its city, also when the app wasn't running", async () => {
  await online();
  await openFresh();
  await tap(/^Locations$/);
  await sleep(1200);
  await tap(/«text field»/);
  sh("input text Tokyo");
  await sleep(4500);
  await tap(/^Tokyo .*Japan/);
  await sleep(6000);
  assert(/Tokyo/.test(screen()), "Tokyo not shown");
  await tap(/^Settings$/);
  await sleep(1000);
  clearNotifications();
  await scrollTap(/^Send a preview$/);
  await until("preview", 8000, () => notifications().find((x) => /Sun/.test(x.title)));
  home(); await sleep(1200); kill(); await sleep(800);
  sh("cmd statusbar expand-notifications");
  await sleep(1800);
  shot("04-notification");
  await tap(/Sun(set|rise) in 15 min/);
  await find(new RegExp(`^${CITY}$`), 20);
  await find(/^Location 1 of 2/);
  return `opened ${CITY} while Tokyo was the last city viewed`;
});

await step("phone restarted: the alarm is back before the app is opened", async () => {
  const before = state()["wake.at"];
  adb("reboot");
  await sleep(8000);
  adb("wait-for-device");
  for (let i = 0; i < 90 && sh("getprop sys.boot_completed").trim() !== "1"; i++) await sleep(1000);
  try { adb("root"); } catch { /* retry below */ }
  await sleep(4000);
  adb("wait-for-device");
  await wake();
  const a = await until("alarm after restart", 90000, () => alarm());
  const st = state();
  assert(a.exact && (Math.abs(st["wake.at"] - before) < 300000 || st["wake.at"] > now()), `${st["wake.why"]} at ${hm(st["wake.at"])}`);
  return `${st["wake.why"]} alarm set again for ${hm(st["wake.at"])}`;
});

if (UI) await step("removing a place deletes its saved background forecast", async () => {
  await openFresh();
  await tap(/^Locations$/);
  await sleep(1200);
  await tap(/^Edit$/);
  await tap(new RegExp(`^Remove ${CITY}`));
  await sleep(2500);
  const left = sh(`ls /data/data/${PKG}/files/weather/`).trim().split(/\s+/).filter(Boolean);
  const ids = JSON.parse(prefs("CapacitorStorage")["v2.places"]).map((p) => p.id.replace(/[^\w-]/g, "_"));
  assert(left.every((f) => ids.some((id) => f.includes(id))), `left: ${left} for ${ids}`);
  assert(rules().length === 0, "its alerts are gone too");
  return `left on disk: ${left.length ? left.join(", ") : "nothing"}`;
});

const crash = sh(`logcat -d -b crash | grep -A3 ${PKG} | head -12`).trim();
if (crash) { results.push(false); console.log(`  ✖ crashes in the log:\n${crash}`); }
sh("settings put global auto_time 1; dumpsys battery reset; dumpsys deviceidle unforce");
if (SDK < 33) sh("settings put global animator_duration_scale 1; settings put global transition_animation_scale 1; settings put global window_animation_scale 1");
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
