// A compass around the temperature. The dial turns with the phone; native sensors (CompassPlugin.java)
// run only while it is on screen.

import { Capacitor, registerPlugin } from "@capacitor/core";
import { h, s } from "../lib/dom.js";
import { uiIcon } from "../lib/icons.js";
import { compass as cardinal } from "../lib/weather.js";

const Compass = registerPlugin("Compass");
let available = false, active = false;
let target = null, shown = 0, raf = 0, hint = "";
let el = null; // the compass currently on screen

export async function initCompass() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    available = (await Compass.available()).available === true;
    if (available) Compass.addListener("heading", onHeading);
  } catch { available = false; }
}
export const compassAvailable = () => available;

/** Switch the sensors on or off. `here` ({lat, lon}) is where the phone is, for true north. */
export function setCompass(on, here) {
  if (!available || on === active) return;
  active = on;
  if (on) Compass.start(here ? { lat: here.lat, lon: here.lon } : {}).catch(() => {});
  else { Compass.stop().catch(() => {}); cancelAnimationFrame(raf); raf = 0; }
}

/** Signed difference between two directions, -180 to 180 (so 350° to 10° turns 20°, not 340°). */
export const turn = (from, to) => ((((to - from) % 360) + 540) % 360) - 180;
export function readingText(deg) {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return `${d}° ${["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(d / 45) % 8]}`;
}
/** What to tell the user when the direction can't be trusted (accuracy: Android's 0-3, field in µT). */
export function compassHint(acc, field) {
  if (acc === 0 || acc === 1) return "Compass needs calibrating: move your phone in a figure 8";
  if (field > 0 && (field < 18 || field > 85)) return "Metal or a magnet nearby: direction may be off";
  return "";
}

function onHeading(e) {
  if (typeof e?.h !== "number" || !Number.isFinite(e.h)) return;
  if (target == null) target = shown = e.h;
  else target += turn(target, e.h);
  const next = compassHint(e.acc, e.field);
  if (next !== hint) { hint = next; showNote(); }
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame() {
  raf = 0;
  const d = target - shown;
  shown = Math.abs(d) < 0.08 ? target : shown + d * 0.2;
  paint();
  if (shown !== target && active) raf = requestAnimationFrame(frame);
}

function paint() {
  if (!el) return;
  el.dial.style.transform = `rotate(${(-shown).toFixed(2)}deg)`;
  const text = target == null ? "" : readingText(shown);
  if (el.reading.textContent !== text) el.reading.textContent = text;
}

function showNote() {
  if (!el) return;
  el.note.classList.toggle("warn", !!hint);
  el.note.replaceChildren(...(hint ? [hint] : el.wind));
}

const at = (deg, r) => [200 + r * Math.sin((deg * Math.PI) / 180), 200 - r * Math.cos((deg * Math.PI) / 180)].map((v) => v.toFixed(1)).join(" ");

function dialSvg(windFrom) {
  const ticks = { minor: [], mid: [], major: [] };
  for (let d = 0; d < 360; d += 5) ticks[d % 30 === 0 ? "major" : d % 10 === 0 ? "mid" : "minor"].push(`M${at(d, 190)}L${at(d, d % 30 === 0 ? 172 : d % 10 === 0 ? 178 : 183)}`);
  const labels = [];
  for (let d = 0; d < 360; d += 30) {
    const letter = { 0: "N", 90: "E", 180: "S", 270: "W" }[d];
    labels.push(s("text", { x: 200, y: letter ? 62 : 55, class: letter ? `cmp-c${d === 0 ? " cmp-n" : ""}` : "cmp-d", transform: `rotate(${d} 200 200)` }, letter || String(d)));
  }
  // Compass rose behind the temperature: each point has a lit and a shaded half.
  const rose = [];
  for (const [first, reach, waist, cls] of [[45, 92, 26, "b"], [0, 132, 34, "a"]]) {
    for (let d = first; d < 360; d += 90) {
      rose.push(s("path", { d: `M200 200L${at(d - 45, waist)}L${at(d, reach)}Z`, class: `cmp-r${cls} lit${d === 0 ? " cmp-n" : ""}` }),
        s("path", { d: `M200 200L${at(d + 45, waist)}L${at(d, reach)}Z`, class: `cmp-r${cls}${d === 0 ? " cmp-n" : ""}` }));
    }
  }
  return s("svg", { class: "cmp-dial", viewBox: "0 0 400 400", "aria-hidden": "true" },
    rose,
    s("circle", { cx: 200, cy: 200, r: 194, class: "cmp-ring" }),
    s("path", { d: ticks.minor.join(""), class: "cmp-t0" }), s("path", { d: ticks.mid.join(""), class: "cmp-t1" }), s("path", { d: ticks.major.join(""), class: "cmp-t2" }),
    labels,
    windFrom == null ? null : s("path", { d: "M200 30 188 2 200 9 212 2Z", class: "cmp-wind", transform: `rotate(${windFrom} 200 200)` }));
}

/** @param center what goes in the middle (temperature…); wind: { from: degrees, speed: "9 km/h" } or null when calm */
export function buildCompass(center, wind) {
  const dial = dialSvg(wind ? wind.from : null);
  const reading = h("p", { class: "cmp-reading" });
  const note = h("p", { class: "cmp-note" });
  const windNote = wind ? [h("span", { class: "cmp-key", svg: uiIcon("wind"), "aria-hidden": "true" }), `Wind from ${cardinal(wind.from)}, ${wind.speed}`] : ["Calm, no wind"];
  el = { dial, reading, note, wind: windNote };
  paint();
  showNote();
  return h("div", { class: "cmp" }, reading,
    h("div", { class: "cmp-face" }, dial, h("span", { class: "cmp-index", "aria-hidden": "true" }), h("div", { class: "cmp-center" }, center)),
    note);
}
