// "Make alerts reliable" sheet: what the phone allows, a real delivery test, and recent activity.

import { clear, h } from "../lib/dom.js";
import { fmtTime } from "../lib/format.js";
import { uiIcon } from "../lib/icons.js";
import { reliabilityItems } from "../alerts.js";

const clock = (ms) => fmtTime(ms - new Date(ms).getTimezoneOffset() * 60000); // this phone's time, in the chosen format
const WHAT = { sunrise: "Sunrise alert", sunset: "Sunset alert", temperature: "Temperature check", test: "Test alert" };

export function lateText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s <= 15 ? "on time" : s < 90 ? `${s} s late` : `${Math.round(s / 60)} min late`;
}

/** One line of the activity list. */
export function logText(l) {
  const what = WHAT[l.why] || "Check";
  const note = String(l.note || "");
  if (/^Held back/.test(note)) return `${what}: held back by your phone`;
  if (l.why === "temperature" ? note : /blocked|failed|no network|no data/.test(note)) return note[0].toUpperCase() + note.slice(1);
  return what + (l.idle ? ", phone asleep" : "");
}

function testText(s, now) {
  if (s.testAt && s.testAt > now - 20000) // the test also checks the internet, which takes a moment
    return `Now lock your phone and put it down. The test alert should arrive at ${clock(s.testAt)}.`;
  if (s.testAt) return `The test alert was due at ${clock(s.testAt)} and hasn't arrived yet. Your phone is holding alerts back: check the settings above.`;
  if (!s.test) return "Sends a real alert the same way your alarms are sent, so you can see whether your phone lets it through.";
  const t = s.test;
  return `Last test: ${lateText(t.late * 1000)}${t.idle ? " while the phone was asleep" : ""}${t.net ? "" : ", but it couldn't reach the internet"}.`;
}

/** ctx: { status, now, onFix(key), onTest() } */
export function renderReliability(el, ctx) {
  const s = ctx.status;
  clear(el);
  if (!s) { el.append(h("p", { class: "list-status" }, "Checking your phone…")); return; }
  el.append(
    h("section", { class: "set-group" }, reliabilityItems(s).map((i) => h("div", { class: `rel-row ${i.ok === true ? "ok" : i.ok === false ? "bad" : "info"}` },
      h("span", { class: "rel-icon", svg: uiIcon(i.ok === true ? "check" : i.ok === false ? "close" : "sliders") }),
      h("span", { class: "alert-text" }, h("b", null, i.title), h("small", null, i.text)),
      i.ok === true ? null : h("button", { class: "rel-btn", type: "button", onclick: () => ctx.onFix(i.key) }, i.action)))),
    h("section", { class: "set-group" },
      h("h3", { class: "set-title" }, "Test on this phone"),
      h("p", { class: "set-note", role: "status" }, testText(s, ctx.now)),
      h("button", { class: "set-btn", type: "button", onclick: ctx.onTest }, "Start 1-minute test")),
    h("section", { class: "set-group" },
      h("h3", { class: "set-title" }, "Background activity"),
      h("p", { class: "set-note" }, s.nextAt ? `Next: ${(WHAT[s.nextWhy] || "check").toLowerCase()} at ${clock(s.nextAt)}.` : "Nothing scheduled: no alerts are switched on."),
      (s.log || []).slice(0, 6).map((l) => h("div", { class: "log-row" },
        h("span", null, clock(l.at)), h("span", { class: "log-what" }, logText(l)),
        h("span", { class: "log-late" }, lateText(l.at - l.planned))))));
}
