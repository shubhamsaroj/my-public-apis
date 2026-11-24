// Editor for one temperature alert (bottom sheet).

import { clear, h } from "../lib/dom.js";
import { temp, tempUnit } from "../lib/format.js";

function seg(label, options, value, onPick) {
  return h("div", { class: "set-row" },
    h("span", { class: "set-label" }, label),
    h("div", { class: `seg seg-${options.length}`, role: "radiogroup", "aria-label": label },
      options.map(([v, text]) => h("button", {
        type: "button", role: "radio", "aria-checked": String(v === value), class: v === value ? "on" : "",
        onclick: () => v !== value && onPick(v),
      }, text))));
}

/** ctx: { draft, places, now: {temp, feels} | null, onChange(patch), onStep(dir), onSave() } */
export function renderAlertEditor(el, ctx) {
  const d = ctx.draft;
  const place = ctx.places.find((p) => p.id === d.placeId);
  const placeLabel = place ? (place.current ? "at your location" : `in ${place.name}`) : "";
  const shown = ctx.now ? (d.metric === "feels" ? ctx.now.feels : ctx.now.temp) : null;
  const unit = tempUnit(), limit = temp(d.value);
  const already = shown != null && (d.op === "below" ? Number(temp(shown)) <= Number(limit) : Number(temp(shown)) >= Number(limit));
  clear(el).append(
    h("div", { class: "set-row" },
      h("span", { class: "set-label" }, "Place"),
      h("div", { class: "pick-row", role: "radiogroup", "aria-label": "Place" },
        ctx.places.map((p) => h("button", {
          type: "button", role: "radio", class: `pick${p.id === d.placeId ? " on" : ""}`, "aria-checked": String(p.id === d.placeId),
          onclick: () => p.id !== d.placeId && ctx.onChange({ placeId: p.id }),
        }, p.current ? "📍 My location" : p.name)))),
    seg("Alert me when it", [["below", "Drops to"], ["above", "Rises to"]], d.op, (op) => ctx.onChange({ op })),
    h("div", { class: "stepper", role: "group", "aria-label": "Temperature" },
      h("button", { class: "step", type: "button", "aria-label": "One degree lower", onclick: () => ctx.onStep(-1) }, "−"),
      h("span", { class: "step-value", "aria-live": "polite" }, `${temp(d.value)}`, h("small", null, tempUnit())),
      h("button", { class: "step", type: "button", "aria-label": "One degree higher", onclick: () => ctx.onStep(1) }, "+")),
    seg("Temperature", [["temp", "Actual"], ["feels", "Feels like"]], d.metric, (metric) => ctx.onChange({ metric })),
    seg("Repeat", [["once", "Once"], ["always", "Every time"]], d.repeat, (repeat) => ctx.onChange({ repeat })),
    already ? h("p", { class: "alert-already", role: "status" },
      `It's already ${temp(shown)}${unit}. You'll be alerted the next time it ${d.op === "below" ? "drops" : "rises"} to ${limit}${unit}, after it has been ${d.op === "below" ? "warmer" : "cooler"}.`) : null,
    h("p", { class: "set-note" },
      shown != null ? `Now ${temp(shown)}${tempUnit()} ${placeLabel}. ` : "",
      d.repeat === "once" ? "You'll get one notification, then the alert switches off. " : "You'll be notified each time it happens (at most every 3 hours). ",
      "Works with the app closed, usually within 15 to 30 minutes of the temperature being reached.",
      place && place.current ? " Uses where you were when you last opened the app." : ""),
    h("button", { class: "btn btn-primary alert-save", type: "button", onclick: ctx.onSave }, "Save alert"));
}
