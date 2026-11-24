// Locations sheet: saved places as live weather cards + search to add more.

import { clear, h, isNum } from "../lib/dom.js";
import { fmtTime, locationNow, temp } from "../lib/format.js";
import { uiIcon, weatherIcon } from "../lib/icons.js";
import { describe, themeOf } from "../lib/weather.js";

/**
 * ctx: { places, activeId, summaries, editing, query, results, status, useLocation, locating,
 *        onSelect(place), onRemove(place), onAdd(result), onLocate() }
 */
export function renderPlaces(el, ctx) {
  clear(el);
  if (ctx.query.trim().length >= 2) {
    if (ctx.status) el.append(h("p", { class: "list-status", role: "status" }, ctx.status));
    el.append(h("ul", { class: "results" }, ctx.results.map((r) => {
      const saved = ctx.places.some((p) => !p.current && p.id === r.id);
      return h("li", null, h("button", { class: "result", type: "button", onclick: () => ctx.onAdd(r) },
        h("span", { class: "result-icon", svg: uiIcon(saved ? "check" : "plus") }),
        h("span", { class: "result-text" }, h("b", null, r.name), h("small", null, [r.admin2, r.admin1, r.country].filter(Boolean).join(", ") || " "))));
    })));
    return;
  }

  const cards = ctx.places.map((p) => placeCard(p, ctx));
  if (ctx.approximate && ctx.places.some((p) => p.current)) {
    cards.splice(1, 0, h("li", null, h("button", { class: "locate-row precise-row", type: "button", onclick: ctx.onPrecise },
      h("span", { class: "result-icon accent", svg: uiIcon("locate") }),
      h("span", { class: "result-text" }, h("b", null, "Using approximate location"),
        h("small", null, "Android blurs it by about 2 km. Tap to allow precise location for the right village or area.")))));
  }
  if (!ctx.useLocation) {
    cards.unshift(h("li", null, h("button", { class: "locate-row", type: "button", onclick: ctx.onLocate, disabled: ctx.locating || null },
      h("span", { class: "result-icon accent", svg: uiIcon("locate") }),
      h("span", { class: "result-text" }, h("b", null, ctx.locating ? "Finding your location…" : "Use my current location"),
        h("small", null, "Weather where you are, updated automatically")))));
  }
  el.append(h("ul", { class: "loc-list" }, cards));
  if (!ctx.places.length) el.append(h("p", { class: "list-status" }, "Search for a city to add it here."));
}

function placeCard(p, ctx) {
  const sm = ctx.summaries[p.id];
  const theme = sm ? themeOf(sm.code, sm.isDay) : "cloudy-night";
  const active = p.id === ctx.activeId;
  const region = [p.admin2, p.admin1, p.country].filter(Boolean).slice(0, 2).join(", ");
  const local = sm && isNum(sm.utcOffset) ? fmtTime(locationNow(sm.utcOffset)) : "";
  return h("li", { class: `loc th-${theme}${active ? " active" : ""}${ctx.editing ? " editing" : ""}` },
    h("button", {
      class: "loc-main", type: "button", onclick: () => ctx.onSelect(p),
      "aria-label": `${p.current ? "My location, " : ""}${p.name}${sm ? `, ${temp(sm.temp)} degrees, ${describe(sm.code)}` : ""}`,
      "aria-current": active ? "true" : null,
    },
    h("span", { class: "loc-top" },
      h("span", { class: "loc-title" },
        h("span", { class: "loc-name" }, p.current ? h("span", { class: "loc-pin", svg: uiIcon("locate") }) : null, p.current ? "My location" : p.name),
        h("span", { class: "loc-sub" }, p.current ? [p.name, p.admin2].filter(Boolean).join(" · ") : [local, region].filter(Boolean).join(" · "))),
      h("span", { class: "loc-temp" }, sm ? `${temp(sm.temp)}°` : "--")),
    h("span", { class: "loc-bottom" },
      h("span", { class: "loc-cond" }, sm ? h("span", { class: "loc-wx", svg: weatherIcon(sm.code, sm.isDay) }) : null, sm ? describe(sm.code) : "Loading…"),
      h("span", { class: "loc-hl" }, sm ? `H:${temp(sm.max)}°  L:${temp(sm.min)}°` : ""))),
    ctx.editing ? h("button", { class: "loc-remove", type: "button", "aria-label": `Remove ${p.current ? "my location" : p.name}`, onclick: () => ctx.onRemove(p), svg: uiIcon("trash") }) : null);
}
