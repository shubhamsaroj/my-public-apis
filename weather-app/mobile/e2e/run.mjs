// End-to-end test on a real Android device/emulator.
//
// Touches go through Android's input pipeline (adb shell input), exactly like a
// finger. Chrome DevTools (debug builds only) is used to find elements and to
// assert on state. Usage: node e2e/run.mjs [--shots DIR] [--only name,name]
//
// Requires: the debug APK installed, adb on the default SDK path, network access.

import { ONLY, PKG, SHOTS, back, center, connect, geometry, js, logs, noOverflow, relaunch, retries, screenshot, sh, sleep, swipe, tap, tapFor, typeText, waitFor } from "./lib.mjs";

// ---------------------------------------------------------------------------
// Test runner

const results = [];
async function step(name, fn) {
  if (ONLY && !ONLY.some((o) => name.toLowerCase().includes(o))) return;
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, note });
    console.log(`  ✔ ${name}${note ? `  — ${note}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, note: e.message });
    console.log(`  ✖ ${name}\n      ${e.message.split("\n").join("\n      ")}`);
    screenshot(`FAIL-${name.replace(/[^a-z0-9]+/gi, "-")}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function scrollToTop() {
  await js(`window.scrollTo(0, 0)`);
  await sleep(300);
}

// ---------------------------------------------------------------------------
console.log("Weatherwise end-to-end test\n");

await relaunch({ clear: !process.argv.includes("--keep") });

await step("first launch shows the welcome screen", async () => {
  await waitFor(`!document.getElementById("view-welcome").classList.contains("hidden")`, 10000, "welcome visible");
  assert(await noOverflow(), "page overflows horizontally");
  screenshot("01-welcome");
});

await step("search for a city from the welcome screen", async () => {
  await tap("#welcome-search");
  await waitFor(`document.getElementById("sheet-places").classList.contains("open")`, 5000, "locations sheet open");
  await waitFor(`document.activeElement && document.activeElement.id === "place-search"`, 3000, "search focused");
  typeText("London");
  await waitFor(`document.querySelectorAll("#places-body .result").length > 0`, 15000, "search results");
  screenshot("02-search");
  await tap("#places-body .result", 0);
  await waitFor(`!document.getElementById("view-main").classList.contains("hidden") && document.querySelector(".hero-name")?.textContent.includes("London")`, 20000, "London forecast shown");
  await waitFor(`!document.documentElement.classList.contains("sheet-open")`, 3000, "scroll lock released");
  await sleep(800);
  screenshot("03-main");
  return await js(`document.querySelector(".hero-num").textContent + "° " + document.querySelector(".hero-cond").textContent`);
});

await step("main screen scrolls all the way down and back up with real swipes", async () => {
  const g = await geometry();
  const total = await js(`document.documentElement.scrollHeight`);
  assert(total > g.h * 1.5, `page too short to test (${total} vs ${g.h})`);
  const before = await js(`scrollY`);
  await swipe(g.w / 2, g.h * 0.8, g.w / 2, g.h * 0.25, 260);
  await sleep(700);
  const after = await js(`scrollY`);
  assert(after > before + 100, `scroll did not move (scrollY ${before} → ${after})`);
  for (let i = 0; i < 12; i++) {
    const atEnd = await js(`innerHeight + scrollY >= document.documentElement.scrollHeight - 4`);
    if (atEnd) break;
    await swipe(g.w / 2, g.h * 0.85, g.w / 2, g.h * 0.15, 200);
    await sleep(500);
  }
  await waitFor(`(() => { const r = document.querySelector(".footer").getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; })()`, 4000, "footer visible");
  assert(await js(`document.getElementById("topbar").classList.contains("solid")`), "compact header did not appear");
  screenshot("04-bottom");
  for (let i = 0; i < 14 && (await js(`scrollY`)) > 0; i++) {
    await swipe(g.w / 2, g.h * 0.2, g.w / 2, g.h * 0.85, 200);
    await sleep(450);
  }
  await waitFor(`scrollY === 0`, 4000, "back at the top");
  return `page ${total}px tall, reached the footer`;
});

await step("hourly forecast scrolls sideways", async () => {
  await scrollToTop();
  const r = await center(".hr-scroll");
  await swipe(r.x + r.w * 0.35, r.y, r.x - r.w * 0.35, r.y, 250);
  await sleep(600);
  const left = await js(`document.querySelector(".hr-scroll").scrollLeft`);
  assert(left > 60, `hourly strip did not scroll (scrollLeft ${left})`);
  const y = await js(`scrollY`);
  assert(y < 40, "horizontal swipe scrolled the page vertically");
  return `scrollLeft ${Math.round(left)}`;
});

await step("tapping an hour opens its details; swipe down dismisses", async () => {
  await js(`document.querySelector(".hr-scroll").scrollLeft = 0`);
  await js(`document.querySelector(".hourly-card").scrollIntoView({ block: "center" })`);
  await sleep(400);
  await tap("button.hr-col", 2);
  await waitFor(`document.getElementById("sheet-hour").classList.contains("open")`, 4000, "hour sheet open");
  await sleep(450);
  screenshot("05-hour");
  const h = await center("#sheet-hour .sheet-handle");
  await swipe(h.x, h.y, h.x, h.y + 420, 250);
  await waitFor(`!document.getElementById("sheet-hour").classList.contains("open")`, 4000, "hour sheet closed");
  await waitFor(`!document.documentElement.classList.contains("sheet-open")`, 2000, "scroll unlocked");
});

await step("10-day row opens the day view; day chips switch days; back closes", async () => {
  await js(`document.querySelector(".daily-card").scrollIntoView({ block: "center" })`);
  await sleep(400);
  await tap(".day-row", 2);
  await waitFor(`document.getElementById("sheet-day").classList.contains("open")`, 4000, "day sheet open");
  await sleep(450);
  const t1 = await js(`document.getElementById("day-title").textContent`);
  screenshot("06-day");
  await tap("#day-body .chip", 4);
  await waitFor(`document.getElementById("day-title").textContent !== ${JSON.stringify(t1)}`, 3000, "day changed");
  const t2 = await js(`document.getElementById("day-title").textContent`);
  back();
  await waitFor(`!document.getElementById("sheet-day").classList.contains("open")`, 3000, "day sheet closed by back");
  await waitFor(`!document.documentElement.classList.contains("sheet-open")`, 2000, "scroll unlocked");
  const g = await geometry();
  const y0 = await js(`scrollY`);
  await swipe(g.w / 2, g.h * 0.75, g.w / 2, g.h * 0.35, 250);
  await sleep(600);
  assert((await js(`scrollY`)) !== y0, "page does not scroll after closing a sheet");
  return `${t1} → ${t2}`;
});

await step("a tap right after closing a sheet is not swallowed", async () => {
  await js(`document.querySelector(".daily-card").scrollIntoView({ block: "center" })`);
  await sleep(300);
  await tap(".day-row", 1);
  await waitFor(`document.getElementById("sheet-day").classList.contains("open")`, 4000, "day sheet open");
  await sleep(500);
  back();
  await sleep(100); // well inside the 300 ms closing animation
  await tap(".day-row", 3);
  await waitFor(`document.getElementById("sheet-day").classList.contains("open")`, 2500, "second tap opened the day view");
  back();
  await sleep(500);
});

await step("every detail tile opens a 48-hour chart", async () => {
  const n = await js(`document.querySelectorAll(".tile.tappable").length`);
  assert(n >= 7, `only ${n} tappable tiles`);
  const titles = [];
  for (let i = 0; i < n; i++) {
    await js(`document.querySelectorAll(".tile.tappable")[${i}].scrollIntoView({ block: "center" })`);
    await sleep(250);
    await tap(".tile.tappable", i);
    await waitFor(`document.getElementById("sheet-metric").classList.contains("open") && document.querySelector("#metric-body .chart-svg path")`, 4000, `metric sheet ${i}`);
    titles.push(await js(`document.getElementById("metric-title").textContent`));
    if (i === 0) { await sleep(400); screenshot("07-metric"); }
    back();
    await waitFor(`!document.getElementById("sheet-metric").classList.contains("open")`, 3000, "metric closed");
    await sleep(350);
  }
  return titles.join(", ");
});

await step("add a second city from Locations and swipe between cities", async () => {
  await scrollToTop();
  await tapFor("#btn-places", `document.getElementById("sheet-places").classList.contains("open")`, "locations open");
  await sleep(400);
  await tap("#place-search");
  await sleep(300);
  typeText("Tokyo");
  await waitFor(`[...document.querySelectorAll("#places-body .result b")].some((b) => b.textContent === "Tokyo")`, 15000, "Tokyo result");
  await tap("#places-body .result", 0);
  await waitFor(`document.querySelector(".hero-name")?.textContent.includes("Tokyo")`, 20000, "Tokyo shown");
  await waitFor(`document.querySelectorAll(".dots .dot").length === 2`, 4000, "two location dots");
  await sleep(500);
  screenshot("08-tokyo");
  const g = await geometry();
  const hero = await center("#hero");
  await swipe(g.w * 0.2, hero.y, g.w * 0.85, hero.y, 220);
  await waitFor(`document.querySelector(".hero-name")?.textContent.includes("London")`, 8000, "swiped to London");
  await sleep(400);
  await swipe(g.w * 0.85, hero.y, g.w * 0.15, hero.y, 220);
  await waitFor(`document.querySelector(".hero-name")?.textContent.includes("Tokyo")`, 8000, "swiped back to Tokyo");
});

await step("Locations list shows live cards; Edit removes a city", async () => {
  await tapFor("#btn-places", `document.querySelectorAll("#places-body .loc").length === 2`, "locations with two cards");
  await waitFor(`[...document.querySelectorAll("#places-body .loc-temp")].every((t) => /\\d/.test(t.textContent))`, 15000, "temperatures on cards");
  await sleep(300);
  screenshot("09-locations");
  await tap("#places-edit");
  await waitFor(`document.querySelectorAll("#places-body .loc-remove").length === 2`, 3000, "remove buttons");
  await tap("#places-body .loc-remove", 1);
  await waitFor(`document.querySelectorAll("#places-body .loc").length === 1`, 3000, "one card left");
  await tap("#places-edit");
  back();
  await waitFor(`!document.getElementById("sheet-places").classList.contains("open")`, 3000, "closed");
  await waitFor(`document.querySelector(".hero-name")?.textContent.includes("London")`, 8000, "London active again");
  assert(!(await js(`document.querySelector(".dots")`)), "dots should disappear with one place");
});

await step("units switch to °F instantly and persist across restarts", async () => {
  const c = Number(await js(`document.querySelector(".hero-num").textContent`));
  await tapFor("#btn-settings", `document.getElementById("sheet-settings").classList.contains("open")`, "settings open");
  await sleep(400);
  screenshot("10-settings");
  await js(`[...document.querySelectorAll("#settings-body .seg button")].find((b) => b.textContent === "°F").scrollIntoView({ block: "center" })`);
  const idx = await js(`[...document.querySelectorAll("#settings-body .seg button")].findIndex((b) => b.textContent === "°F")`);
  await tap("#settings-body .seg button", idx);
  await waitFor(`[...document.querySelectorAll("#settings-body .seg button")][${idx}].getAttribute("aria-checked") === "true"`, 3000, "°F selected");
  back();
  const f = Number(await js(`document.querySelector(".hero-num").textContent`));
  assert(Math.abs(f - (c * 9 / 5 + 32)) <= 1.5, `°F value looks wrong: ${c}°C → ${f}°F`);
  await relaunch();
  await waitFor(`!document.getElementById("view-main").classList.contains("hidden")`, 10000, "main after restart");
  const f2 = Number(await js(`document.querySelector(".hero-num").textContent`));
  assert(Math.abs(f2 - f) <= 2, `unit not persisted (${f} vs ${f2})`);
  await tapFor("#btn-settings", `document.getElementById("sheet-settings").classList.contains("open")`, "settings open");
  await sleep(350);
  const ci = await js(`[...document.querySelectorAll("#settings-body .seg button")].findIndex((b) => b.textContent === "°C")`);
  await tap("#settings-body .seg button", ci);
  back();
  await sleep(300);
  return `${c}°C ⇄ ${f}°F`;
});

await step("pull down at the top refreshes the forecast", async () => {
  await scrollToTop();
  await js(`(window.__ptrSeen = false, new MutationObserver(() => { if (document.getElementById("ptr").classList.contains("loading")) window.__ptrSeen = true; }).observe(document.getElementById("ptr"), { attributes: true }), true)`);
  const g = await geometry();
  await swipe(g.w / 2, g.h * 0.3, g.w / 2, g.h * 0.75, 450);
  await waitFor(`window.__ptrSeen`, 4000, "refresh spinner");
  await waitFor(`!document.getElementById("ptr").classList.contains("loading")`, 15000, "refresh finished");
  return await js(`document.getElementById("footer-updated").textContent`);
});

await step("Android back: scrolled page goes to top first, then the app minimises", async () => {
  const g = await geometry();
  await swipe(g.w / 2, g.h * 0.85, g.w / 2, g.h * 0.15, 200);
  await sleep(500);
  await swipe(g.w / 2, g.h * 0.85, g.w / 2, g.h * 0.15, 200);
  await sleep(600);
  assert((await js(`scrollY`)) > 80, "could not scroll down");
  back();
  await waitFor(`scrollY < 5`, 4000, "back scrolled to top");
  back();
  await sleep(1200);
  const resumed = sh("dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity' | head -2");
  assert(!resumed.includes(PKG), "app still in foreground after back at top");
  sh(`am start -W -n ${PKG}/.MainActivity`);
  await sleep(1200);
  await connect();
  await waitFor(`!document.getElementById("view-main").classList.contains("hidden")`, 8000, "restored");
});

await step("offline: cached forecast still opens, then refreshes when back online", async () => {
  sh("cmd connectivity airplane-mode enable");
  await sleep(2500);
  await relaunch();
  await waitFor(`!document.getElementById("view-main").classList.contains("hidden")`, 10000, "cached forecast shown offline");
  await waitFor(`document.getElementById("footer-updated")?.textContent.startsWith("Offline")`, 6000, "offline label");
  screenshot("11-offline");
  sh("cmd connectivity airplane-mode disable");
  await waitFor(`document.getElementById("footer-updated")?.textContent.startsWith("Updated")`, 30000, "back online");
});

await step("approximate-only location never nags for precise access", async () => {
  sh(`pm revoke ${PKG} android.permission.ACCESS_FINE_LOCATION`);
  sh(`pm grant ${PKG} android.permission.ACCESS_COARSE_LOCATION`);
  await sleep(500);
  await connect();
  await tapFor("#btn-places", `document.querySelector("#places-body .locate-row")`, "use-location row");
  await sleep(300);
  await tap("#places-body .locate-row");
  // Either outcome is fine (some devices have no network location); nagging for precise is not.
  for (let i = 0; i < 30; i++) {
    const ui = sh("uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml");
    assert(!/precise/i.test(ui), "Android asked to upgrade to precise location");
    const r = await js(`({ located: document.querySelector(".hero-sub")?.textContent === "My location" && !document.getElementById("sheet-places").classList.contains("open"), failed: /Couldn't|denied|turned off/.test(document.getElementById("toast").textContent) && !document.querySelector("#places-body .locate-row")?.disabled })`);
    if (r.located) return `located with approximate access: ${await js(`document.querySelector(".hero-name").textContent`)}`;
    if (r.failed) { const msg = await js(`document.getElementById("toast").textContent`); back(); await sleep(500); return `graceful: ${msg}`; }
    await sleep(1000);
  }
  throw new Error("location neither succeeded nor failed within 30 s");
});

await step("use my location (precise permission); remove it again", async () => {
  if (await js(`document.querySelector(".hero-sub")?.textContent === "My location"`)) {
    // Already located: remove "My location" first so the precise path is exercised from scratch.
    await tapFor("#btn-places", `document.querySelectorAll("#places-body .loc").length >= 1`, "locations open");
    await sleep(450); // let the sheet finish sliding in before tapping inside it
    await tap("#places-edit");
    await waitFor(`document.querySelector("#places-body .loc-remove")`, 3000, "remove buttons");
    await tap("#places-body .loc-remove", 0);
    await waitFor(`document.querySelector("#places-body .locate-row")`, 4000, "use-location row back");
    await tap("#places-edit");
    back();
    await waitFor(`!document.getElementById("sheet-places").classList.contains("open")`, 3000, "closed");
    await sleep(400);
  }
  sh(`pm grant ${PKG} android.permission.ACCESS_FINE_LOCATION`);
  await sleep(500);
  await connect();
  await tapFor("#btn-places", `document.querySelector("#places-body .locate-row")`, "use-location row");
  await sleep(300);
  await tap("#places-body .locate-row");
  await waitFor(`document.querySelector(".hero-sub")?.textContent === "My location"`, 45000, "current location shown");
  await waitFor(`document.querySelector(".dots .dot.loc")`, 4000, "location dot");
  await waitFor(`!document.documentElement.classList.contains("sheet-open")`, 3000, "scroll unlocked");
  screenshot("12-my-location");
  return await js(`document.querySelector(".hero-name").textContent`);
});

await step("no JavaScript errors or CSP violations", async () => {
  const bad = logs.filter((l) => !/net::ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|Failed to fetch/i.test(l));
  assert(!bad.length, bad.slice(0, 8).join("\n"));
  return `${logs.length} benign network messages while offline`;
});

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
if (retries.length) console.log(`\nTaps retried on a slow device: ${retries.join("; ")}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
try { ws.close(); } catch { /* ignore */ }
process.exit(failed.length ? 1 : 0);
