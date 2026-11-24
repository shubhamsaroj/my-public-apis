// Settings sheet.

import { clear, h } from "../lib/dom.js";
import { UNIT_OPTIONS } from "../lib/format.js";
import { uiIcon } from "../lib/icons.js";

let n = 0;

function segmented(label, key, options, value, onChange) {
  const id = `set-${key}-${++n}`;
  return h("div", { class: "set-row" },
    h("span", { class: "set-label", id }, label),
    h("div", { class: `seg seg-${options.length}`, role: "radiogroup", "aria-labelledby": id },
      options.map(([v, text]) => h("button", {
        type: "button", role: "radio", "aria-checked": String(v === value), class: v === value ? "on" : "",
        onclick: () => v !== value && onChange({ [key]: v }),
      }, text))));
}

function toggle(label, desc, key, on, onChange) {
  return h("button", { class: "set-switch", type: "button", role: "switch", "aria-checked": String(on), onclick: () => onChange({ [key]: !on }) },
    h("span", { class: "set-text" }, h("b", null, label), desc ? h("small", null, desc) : null),
    h("span", { class: `switch${on ? " on" : ""}`, "aria-hidden": "true" }, h("i")));
}

/** ctx: { settings, tier, version, onChange(patch), alertPlace, viewingName, canSwitchAlertPlace, onAlertHere, onPreview } */
export function renderSettings(el, ctx) {
  const s = ctx.settings;
  const tierText = ctx.tier === "lite" ? "Lite (smoother on this phone)" : "Full glass";
  clear(el).append(
    h("section", { class: "set-group" },
      h("h3", { class: "set-title" }, "Units"),
      segmented("Temperature", "temp", UNIT_OPTIONS.temp, s.temp, ctx.onChange),
      segmented("Wind speed", "wind", UNIT_OPTIONS.wind, s.wind, ctx.onChange),
      segmented("Pressure", "pressure", UNIT_OPTIONS.pressure, s.pressure, ctx.onChange),
      segmented("Precipitation", "precip", UNIT_OPTIONS.precip, s.precip, ctx.onChange),
      segmented("Time format", "time", UNIT_OPTIONS.time, s.time, ctx.onChange)),
    h("section", { class: "set-group" },
      h("h3", { class: "set-title" }, "Location"),
      toggle("Use my location", "Shows weather where you are. Your location is only sent to the weather service to get a forecast.", "useLocation", s.useLocation, ctx.onChange)),
    h("section", { class: "set-group" },
      h("h3", { class: "set-title" }, "Sunrise & sunset alerts"),
      toggle("Sunrise", "A notification before the sun comes up.", "notifySunrise", s.notifySunrise, ctx.onChange),
      toggle("Sunset", "Catch golden hour and the sunset.", "notifySunset", s.notifySunset, ctx.onChange),
      s.notifySunrise || s.notifySunset ? [
        segmented("When", "notifyLead", [["0", "At the time"], ["15", "15 min before"], ["30", "30 min before"]], s.notifyLead, ctx.onChange),
        h("p", { class: "set-note" }, `For ${ctx.alertPlace || "your first place"}. Calculated on your phone, so alerts also come when the app is closed or you're offline.`),
        ctx.canSwitchAlertPlace ? h("button", { class: "set-btn", type: "button", onclick: ctx.onAlertHere }, `Use ${ctx.viewingName} instead`) : null,
        h("button", { class: "set-btn", type: "button", onclick: ctx.onPreview }, "Send a preview"),
      ] : null),
    h("section", { class: "set-group" },
      h("h3", { class: "set-title" }, "Temperature alerts"),
      (ctx.alerts || []).map((a) => h("div", { class: `alert-row${a.enabled ? "" : " off"}` },
        h("span", { class: "alert-text" }, h("b", null, a.summary), h("small", null, a.status)),
        h("button", {
          class: `switch${a.enabled ? " on" : ""}`, type: "button", role: "switch", "aria-checked": String(a.enabled),
          "aria-label": `${a.summary}: ${a.enabled ? "on" : "off"}`, onclick: () => ctx.onToggleAlert(a.id),
        }, h("i")),
        h("button", { class: "icon-btn small alert-del", type: "button", "aria-label": `Delete alert: ${a.summary}`, svg: uiIcon("trash"), onclick: () => ctx.onDeleteAlert(a.id) }))),
      (ctx.alerts || []).length < ctx.maxAlerts
        ? h("button", { class: "set-btn", type: "button", onclick: ctx.onAddAlert }, "+ Add a temperature alert")
        : h("p", { class: "set-note" }, `You can have up to ${ctx.maxAlerts} alerts.`),
      h("p", { class: "set-note" }, "Checked in the background: every few hours while the temperature is far from your limit, and every 15 to 30 minutes as it gets close.")),
    ctx.reliability ? h("section", { class: "set-group" },
      h("h3", { class: "set-title" }, "Alert reliability"),
      h("button", { class: `set-switch rel-open${ctx.reliability.warn ? " warn" : ""}`, type: "button", onclick: ctx.onReliability },
        h("span", { class: "set-text" },
          h("b", null, ctx.reliability.title), h("small", null, ctx.reliability.text)),
        h("span", { class: "rel-chev", svg: uiIcon("chevron") }))) : null,
    h("section", { class: "set-group" },
      h("h3", { class: "set-title" }, "Appearance"),
      segmented("Visual effects", "effects", [["auto", "Auto"], ["full", "Full"], ["lite", "Lite"]], s.effects, ctx.onChange),
      h("p", { class: "set-note" }, s.effects === "auto" ? `Auto picks the richest look your phone can draw smoothly. Now using: ${tierText}.` : s.effects === "lite" ? "Lite skips the frosted-glass blur and draws the sky at lower resolution. Best for older phones and battery saving." : "Full frosted glass and a high-resolution sky."),
      toggle("Animated sky", "Moving clouds, rain, snow and stars.", "animate", s.animate, ctx.onChange),
      ctx.compassAvailable ? toggle("Compass", "Shows which way you're facing around the temperature, and where the wind comes from.", "compass", s.compass, ctx.onChange) : null),
    h("section", { class: "set-group about" },
      h("h3", { class: "set-title" }, "About"),
      h("p", null, `Weatherwise ${ctx.version}. No ads, no accounts, no tracking. Saved places and settings stay on this phone.`),
      h("p", null, "Forecasts by ", h("a", { href: "https://open-meteo.com/" }, "Open-Meteo"),
        " (ECMWF, DWD, NOAA and other national weather services). Air quality from the Copernicus Atmosphere Monitoring Service. Place search by Photon (komoot) and place names © ",
        h("a", { href: "https://www.openstreetmap.org/copyright" }, "OpenStreetMap"), " contributors."),
      h("p", null, "Built by ", h("a", { href: "https://www.linkedin.com/in/shubham-saroj-devops-engineer/" }, "Shubham Saroj"), ".")));
}
