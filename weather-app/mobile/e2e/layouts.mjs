// Responsive layout checks across screen sizes, orientation and font scale.
// Usage: node e2e/layouts.mjs --shots DIR

import { connect, js, relaunch, screenshot, sh, sleep, waitFor } from "./lib.mjs";

const CONFIGS = [
  { name: "320dp-small-phone", size: "840x1680", density: 420 },
  { name: "360dp-phone", size: "945x2000", density: 420 },
  { name: "412dp-phone", size: null, density: null },
  { name: "600dp-foldable", size: "1575x2100", density: 420 },
  { name: "800dp-tablet", size: "1600x2560", density: 320 },
  { name: "landscape-phone", rotate: true },
  { name: "font-scale-130", fontScale: "1.3" },
  { name: "320dp-font-130", size: "840x1680", density: 420, fontScale: "1.3" },
];

const CHECK = `(() => {
  const W = innerWidth, problems = [];
  if (document.documentElement.scrollWidth > W + 1) problems.push("page scrolls sideways (" + document.documentElement.scrollWidth + " > " + W + ")");
  for (const sel of [".card", ".tile", ".day-row", ".hero-inner", ".footer", ".topbar"]) {
    document.querySelectorAll(sel).forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.width && (r.left < -1 || r.right > W + 1)) problems.push(sel + "[" + i + "] off-screen " + Math.round(r.left) + ".." + Math.round(r.right));
    });
  }
  // Text that is cut off inside its box (excluding intentional ellipsis on place names).
  document.querySelectorAll(".tile-value, .tile-level, .day-row > span, .card-label, .stat-v, .hero-cond, .hero-temp").forEach((el) => {
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).textOverflow !== "ellipsis") problems.push("clipped text: " + el.className + " '" + el.textContent.slice(0, 30) + "'");
  });
  const cols = getComputedStyle(document.querySelector(".layout")).gridTemplateColumns.split(" ").length;
  const tileCols = getComputedStyle(document.querySelector(".tiles")).gridTemplateColumns.split(" ").length;
  return { W, H: innerHeight, cols, tileCols, problems };
})()`;

// The alert screens with everything that can be wrong on a phone, so the longest texts are tested.
const WORST = { alerts: {}, notifications: false, channelsBlocked: true, exact: false, battery: "restricted", dataBlocked: true, brand: "xiaomi", heldAt: 1,
  nextAt: Date.now() + 3600000, nextWhy: "temperature", testAt: 0, test: { at: Date.now(), late: 3720, idle: true, net: false },
  log: [["sunset", "Held back by the phone", 2820000], ["temperature", "temperature 22°C (forecast), alert sent", 0], ["sunrise", "sunrise (notifications blocked)", 1000], ["test", "", 60000]].map(([why, note, late], i) => ({ planned: Date.now() - i * 3600000 - late, at: Date.now() - i * 3600000, why, note, idle: i % 2 === 1 })) };
const SHEET_CHECK = (id) => `(() => {
  const sheet = document.querySelector("#${id} .sheet"), body = document.querySelector("#${id} .sheet-body"), problems = [];
  if (!document.getElementById("${id}").classList.contains("open")) return ["${id} did not open"];
  const b = sheet.getBoundingClientRect();
  if (b.left < -1 || b.right > innerWidth + 1) problems.push("${id} wider than the screen");
  if (body.scrollWidth > body.clientWidth + 1) problems.push("${id} scrolls sideways (" + body.scrollWidth + " > " + body.clientWidth + ")");
  body.querySelectorAll("button, .rel-row, .alert-already, .log-row, .set-note, h3, b, small").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width && (r.left < b.left - 1 || r.right > b.right + 1)) problems.push("${id}: off-screen " + el.className + " '" + el.textContent.slice(0, 30) + "'");
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).display !== "inline") problems.push("${id}: clipped " + el.className + " '" + el.textContent.slice(0, 30) + "'");
    if (el.matches(".rel-btn, .set-btn, .alert-save") && r.height < 44) problems.push("${id}: button only " + Math.round(r.height) + "px tall");
  });
  return problems;
})()`;
const clickText = (sel, text) => js(`(() => { const el = [...document.querySelectorAll("${sel}")].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`);

async function checkAlertScreens(name) {
  await js(`(() => { const o = Capacitor.nativePromise; Capacitor.nativePromise = (p, m, a) => p === "Alerts" && m === "status" ? Promise.resolve(${JSON.stringify(WORST)}) : o.call(Capacitor, p, m, a); })()`);
  const problems = [];
  await js(`document.getElementById("btn-settings").click()`);
  await sleep(900);
  problems.push(...await js(SHEET_CHECK("sheet-settings")));
  await clickText("#settings-body .set-btn", "Add a temperature alert");
  await sleep(900);
  for (let i = 0; i < 5; i++) await js(`document.querySelectorAll("#alert-body .step")[1].click()`); // past the current temperature
  await sleep(400);
  if (!(await js(`!!document.querySelector(".alert-already")`))) problems.push("no 'already past it' note");
  problems.push(...await js(SHEET_CHECK("sheet-alert")));
  await js(`document.querySelector(".alert-already")?.scrollIntoView({ block: "center" })`);
  await sleep(300);
  screenshot(`${name}-editor`);
  await js(`document.querySelector("#sheet-alert [data-close]").click()`);
  await sleep(600);
  await clickText("#settings-body .rel-open", "");
  await sleep(1000);
  problems.push(...await js(SHEET_CHECK("sheet-reliability")));
  screenshot(`${name}-reliability`);
  return problems;
}

function reset() {
  sh("wm size reset");
  sh("wm density reset");
  sh("settings put system font_scale 1.0");
  sh("settings put system accelerometer_rotation 0");
  sh("settings put system user_rotation 0");
}

let failures = 0;
for (const c of CONFIGS) {
  reset();
  if (c.size) sh(`wm size ${c.size}`);
  if (c.density) sh(`wm density ${c.density}`);
  if (c.rotate) sh("settings put system user_rotation 1");
  if (c.fontScale) sh(`settings put system font_scale ${c.fontScale}`);
  await sleep(1500);
  await relaunch();
  await waitFor(`!document.getElementById("view-main").classList.contains("hidden")`, 15000, "main view");
  await sleep(1500);
  screenshot(`${c.name}-top`);
  const r = await js(CHECK);
  await js(`window.scrollTo(0, document.documentElement.scrollHeight * 0.45)`);
  await sleep(900);
  screenshot(`${c.name}-middle`);
  const r2 = await js(CHECK);
  const problems = [...new Set([...r.problems, ...r2.problems, ...await checkAlertScreens(c.name)])];
  if (problems.length) failures++;
  console.log(`  ${problems.length ? "✖" : "✔"} ${c.name.padEnd(20)} ${r.W}×${r.H} css px · ${r.cols} column${r.cols > 1 ? "s" : ""} · ${r.tileCols} tile columns${problems.length ? "\n      " + problems.slice(0, 6).join("\n      ") : ""}`);
}
reset();
await sleep(1000);
console.log(failures ? `\n${failures} layout(s) with problems` : "\nAll layouts OK");
process.exit(failures ? 1 : 0);
