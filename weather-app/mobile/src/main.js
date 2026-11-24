import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Geolocation } from "@capacitor/geolocation";
import { Network } from "@capacitor/network";
import { SplashScreen } from "@capacitor/splash-screen";
import { ApiError, BACKGROUND_QUERY, fetchForecast, fetchSummaries, normalize, reverseGeocode, searchPlaces, validCoords } from "./api.js";
import { $, clamp, h, rafThrottle } from "./lib/dom.js";
import { fmtAgo, setTimePref, setUnits, temp, tempUnit } from "./lib/format.js";
import { uiIcon, weatherIcon } from "./lib/icons.js";
import { buildView, precipTotals, sunState } from "./lib/model.js";
import * as store from "./lib/store.js";
import { describe, moonInfo } from "./lib/weather.js";
import { createSky, deriveScene } from "./sky.js";
import { renderDay, renderHour, renderMetric } from "./ui/details.js";
import { buildMain } from "./ui/main-view.js";
import { renderPlaces } from "./ui/places.js";
import { renderReliability } from "./ui/reliability.js";
import { renderSettings } from "./ui/settings.js";
import { anySheetOpen, closeAll, closeSheet, closeTop, initSheets, isSheetOpen, onSheetsChange, openSheet, tap, tick, toast } from "./ui/sheets.js";
import {
  alertSummary, backgroundForecast, checkTemperatures, engineStatus, newAlertId, onAlertTapped, openPhoneSettings,
  previewSunAlert, reliabilityItems, reliabilitySummary, requestNotifications, startDeliveryTest, syncEngine,
} from "./alerts.js";
import { renderAlertEditor } from "./ui/alert-editor.js";
import { compassAvailable, initCompass, setCompass } from "./ui/compass.js";

const VERSION = "1.0";
const native = Capacitor.isNativePlatform();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const STALE_MIN = 15;

const state = {
  settings: { ...store.DEFAULT_SETTINGS },
  places: [],
  activeId: null,
  viewId: null,
  view: null,
  weather: new Map(),
  inflight: new Map(),
  summaries: {},
  online: true,
  tierAuto: "full",
  locating: false,
  precise: true,
  lastLocateAt: 0,
  editing: false,
  query: "",
  results: [],
  searchStatus: "",
  dayDate: null,
  metricKey: null,
  heroH: 320,
  alerts: [],
  alertStatus: {},
  engine: null, // native alert engine status
  ready: false, // places are loaded
  tapPlace: null, // place of the notification that opened the app
  draft: null,
};

const sky = createSky($("sky"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const activePlace = () => state.places.find((p) => p.id === state.activeId) || null;
const indexOf = (id) => state.places.findIndex((p) => p.id === id);

// ---------------------------------------------------------------------------
// Views

function showView(name) {
  for (const v of ["welcome", "loading", "error", "main"]) $(`view-${v}`).classList.toggle("hidden", v !== name);
  document.body.dataset.view = name;
  syncCompass();
  if (name !== "main") {
    $("topbar").classList.remove("solid");
    topbarSolid = false;
  }
}

let splashHidden = false;
function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  SplashScreen.hide({ fadeOutDuration: 300 }).catch(() => {});
}

function showError(message) {
  $("error-text").textContent = state.online ? `${message}. Please try again.` : "You're offline. Connect to the internet and try again.";
  showView("error");
}

// ---------------------------------------------------------------------------
// Rendering the main screen

function render(view, { dir = 0 } = {}) {
  const place = activePlace();
  if (!place) return;
  state.view = view;
  state.viewId = place.id;
  const parts = buildMain({
    view, place, places: state.places, index: indexOf(place.id),
    deviceOffset: -new Date().getTimezoneOffset() * 60, online: state.online,
    compass: state.settings.compass && compassAvailable(),
    onDay: openDay, onHour: openHour, onMetric: openMetric,
  });
  const main = $("view-main");
  main.replaceChildren(h("div", { class: "layout" },
    h("div", { class: "col-main" }, parts.hero, ...parts.cards),
    h("div", { class: "col-side" }, h("div", { class: "tiles" }, parts.tiles), parts.footer)));
  showView("main");
  main.classList.remove("leave-left", "leave-right");
  if (dir && !reducedMotion) {
    main.classList.add(dir > 0 ? "from-right" : "from-left");
    void main.offsetWidth;
    main.classList.remove("from-right", "from-left");
  }
  $("tb-name").textContent = place.name;
  $("tb-temp").textContent = `${temp(view.cur.temp)}° · ${describe(view.cur.code)}`;
  state.heroH = $("hero")?.offsetHeight || 320;
  updateSky(view);
  attachHeroSwipe();
  onScroll();
  syncCompass();
  if (isSheetOpen("sheet-day") && state.dayDate) renderDay($("day-body"), view, state.dayDate, pickDay);
  if (isSheetOpen("sheet-metric") && state.metricKey) renderMetric($("metric-body"), view, state.metricKey, precipTotals(view));
}

/** Compass sensors run only while the dial can be seen. */
function syncCompass() {
  const seen = document.body.dataset.view === "main" && !document.hidden && !anySheetOpen() && window.scrollY < state.heroH * 0.8;
  setCompass(state.settings.compass && seen, state.places.find((p) => p.current));
}

function updateSky(view) {
  const c = view.cur;
  sky.setScene(deriveScene({
    code: c.code, cloud: c.cloud, precip: c.precip, wind: c.wind, windDir: c.windDir,
    sun: sunState(view), moonPhase: moonInfo(Date.now()).phase,
  }));
  applyTint();
}

/** Glass takes its tint from the sky; brighter skies get denser glass so text stays readable. */
function applyTint() {
  const [r, g, b] = sky.tint();
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const root = document.documentElement;
  root.style.setProperty("--tint", `${r},${g},${b}`);
  root.style.setProperty("--tint-a", lum > 0.3 ? "0.44" : lum > 0.2 ? "0.32" : "0.24");
  root.classList.toggle("bright-sky", lum > 0.22);
}

function updateFreshness() {
  const el = $("footer-updated");
  const data = state.viewId && state.weather.get(state.viewId);
  if (!el || !data) return;
  const ago = fmtAgo(Date.now() - data.fetchedAt);
  el.textContent = state.online ? `Updated ${ago}` : `Offline · updated ${ago}`;
}

/** A pleasant default sky before any data exists (welcome screen). */
function defaultSky() {
  const now = new Date();
  const hr = now.getHours() + now.getMinutes() / 60;
  const day = hr >= 6.5 && hr <= 18.5;
  const p = day ? (hr - 6.5) / 12 : (((hr + 24 - 18.5) % 24) / 12);
  const fromHorizonMin = Math.min(p, 1 - p) * 12 * 60;
  sky.setScene(deriveScene({
    code: 1, cloud: 30, precip: 0, wind: 12, windDir: 260,
    sun: { day, p: clamp(p, 0, 1), alt: day ? Math.sin(p * Math.PI) : -Math.min(1, fromHorizonMin / 100) },
    moonPhase: moonInfo(Date.now()).phase,
  }));
  applyTint();
}

// ---------------------------------------------------------------------------
// Data

async function getData(id) {
  let d = state.weather.get(id) || await store.loadWeather(id);
  if (!d || Date.now() - d.fetchedAt > 10 * 60000) d = (await pickUpBackground(id, d ? d.fetchedAt : 0)) || d;
  if (d) state.weather.set(id, d);
  return d;
}

/** A newer forecast that the phone fetched while the app was closed, or null. */
async function pickUpBackground(id, since) {
  const raw = await backgroundForecast(id, since);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    const place = state.places.find((p) => p.id === id);
    if (!place || !(o.fetchedAt > since) || distanceKm(place, o) > 2) return null;
    const data = normalize(o.wx, o.aq, o.fetchedAt);
    state.weather.set(id, data);
    store.saveWeather(id, data);
    summaryFromData(id, data);
    return data;
  } catch {
    return null;
  }
}

async function showPlace(id, { dir = 0 } = {}) {
  const place = state.places.find((p) => p.id === id);
  if (!place) return;
  state.activeId = id;
  store.saveActive(id);
  const data = await getData(id);
  if (state.activeId !== id) return;
  const view = data ? buildView(data) : null;
  if (view) {
    render(view, { dir });
    hideSplash();
  } else {
    state.viewId = null;
    $("view-main").classList.remove("leave-left", "leave-right");
    showView("loading");
  }
  const ageMin = data ? (Date.now() - data.fetchedAt) / 60000 : Infinity;
  if (!view || ageMin > STALE_MIN) await refresh(id, { quiet: !!view });
}

function refresh(id = state.activeId, { quiet = false } = {}) {
  const place = state.places.find((p) => p.id === id);
  if (!place) return Promise.resolve(false);
  if (state.inflight.has(id)) return state.inflight.get(id);
  const job = (async () => {
    try {
      const data = await fetchForecast(place.lat, place.lon);
      state.weather.set(id, data);
      store.saveWeather(id, data);
      summaryFromData(id, data);
      if (data.tz && place.tz !== data.tz) {
        place.tz = data.tz; // alert times are shown in the place's own time zone
        store.savePlaces(state.places);
      }
      if (id === state.activeId) {
        const view = buildView(data);
        if (view) render(view);
        else showError("The forecast couldn't be read");
      }
      return true;
    } catch (err) {
      if (id === state.activeId) {
        const msg = err instanceof ApiError ? err.message : "Something went wrong";
        if (state.viewId === id) {
          if (!quiet) toast(`${msg}. Showing the forecast from ${fmtAgo(Date.now() - state.weather.get(id).fetchedAt)}.`);
          updateFreshness();
        } else {
          showError(msg);
        }
      }
      return false;
    } finally {
      state.inflight.delete(id);
      hideSplash();
    }
  })();
  state.inflight.set(id, job);
  return job;
}

/** Warm the cache for neighbouring places so swiping is instant. */
async function prefetchNeighbours() {
  const i = indexOf(state.activeId);
  for (const j of [i + 1, i - 1]) {
    const p = state.places[j];
    if (!p || !state.online) continue;
    const d = await getData(p.id);
    if (!d || (Date.now() - d.fetchedAt) / 60000 > STALE_MIN) await refresh(p.id, { quiet: true });
  }
}

function summaryFromData(id, data) {
  const v = buildView(data);
  if (!v) return;
  state.summaries[id] = { temp: v.cur.temp, code: v.cur.code, isDay: v.cur.isDay, max: v.today.max, min: v.today.min, utcOffset: data.utcOffset, at: data.fetchedAt };
  store.saveSummaries(state.summaries);
}

let summariesCtrl = null;
async function refreshSummaries() {
  const stale = state.places.filter((p) => !state.summaries[p.id] || Date.now() - state.summaries[p.id].at > 10 * 60000);
  if (!stale.length || !state.online) return;
  summariesCtrl?.abort();
  const ctrl = (summariesCtrl = new AbortController());
  try {
    const res = await fetchSummaries(stale, ctrl.signal);
    Object.assign(state.summaries, res);
    store.saveSummaries(state.summaries);
    if (isSheetOpen("sheet-places")) renderPlacesSheet();
  } catch { /* the list still shows cached values */ }
}

// ---------------------------------------------------------------------------
// Places

function addPlace(r) {
  const existing = state.places.find((p) => !p.current && p.id === r.id);
  if (existing) return existing;
  const place = store.sanitizePlace({ ...r, current: false });
  if (!place) return null;
  if (state.places.filter((p) => !p.current).length >= store.MAX_PLACES) {
    toast(`You can save up to ${store.MAX_PLACES} places. Remove one first.`);
    return null;
  }
  state.places.push(place);
  store.savePlaces(state.places);
  return place;
}

function removePlace(p) {
  tap();
  state.places = state.places.filter((x) => x.id !== p.id);
  state.weather.delete(p.id);
  store.removeWeather(p.id);
  delete state.summaries[p.id];
  store.saveSummaries(state.summaries);
  if (p.current) setUseLocation(false);
  store.savePlaces(state.places);
  if (state.alerts.some((a) => a.placeId === p.id)) editAlerts((list) => list.filter((a) => a.placeId !== p.id));
  syncAlerts();
  if (!state.places.length) state.editing = false;
  if (state.activeId === p.id) {
    const next = state.places[0];
    if (next) showPlace(next.id);
    else {
      state.activeId = null;
      state.viewId = null;
      store.saveActive(null);
      defaultSky();
      showView("welcome");
    }
  } else if (state.view && state.viewId) {
    render(state.view);
  }
  renderPlacesSheet();
}

function switchToIndex(i, dir) {
  const p = state.places[i];
  if (!p || p.id === state.activeId) return;
  $("view-main").classList.add(dir > 0 ? "leave-left" : "leave-right");
  setTimeout(() => {
    window.scrollTo(0, 0);
    showPlace(p.id, { dir }).then(prefetchNeighbours);
  }, reducedMotion ? 0 : 150);
}

// ---------------------------------------------------------------------------
// Location

const distanceKm = (a, b) => {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
};

async function getPosition(precise) {
  try {
    // Battery-friendly network fix first (all that "approximate" permission allows)…
    return await Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: precise ? 8000 : 20000, maximumAge: 15 * 60000 });
  } catch (first) {
    // …then GPS, but only if the user already granted precise location. Asking for
    // high accuracy otherwise makes Android prompt them to upgrade, which is pushy.
    if (!precise || /denied|permission|disabled|not enabled/i.test(String(first?.message))) throw first;
    return await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 15 * 60000 });
  }
}

const UNNAMED = "My location";

async function locate({ fromUser = false } = {}) {
  if (state.locating) {
    // A background refresh is already running: finish it as if the user had asked.
    if (fromUser) { state.locateWanted = true; toast("Finding your location…", { ms: 2500 }); }
    return false;
  }
  state.locating = true;
  renderPlacesSheet();
  try {
    let precise = true;
    if (native) {
      const granted = (p) => p.location === "granted" || p.coarseLocation === "granted";
      let perm = await Geolocation.checkPermissions();
      if (!granted(perm)) {
        if (!fromUser) return false;
        perm = await Geolocation.requestPermissions({ permissions: ["location", "coarseLocation"] });
        if (!granted(perm)) {
          setUseLocation(false);
          toast("Location access is off. Allow it in Android Settings › Apps › Weatherwise, or search for a city.", { ms: 5000 });
          return false;
        }
      }
      precise = perm.location === "granted";
    }
    state.precise = precise;
    if (fromUser) toast("Finding your location…", { ms: 2500 });
    const pos = await getPosition(precise);
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    if (!validCoords(lat, lon)) throw new Error("Invalid position");
    state.lastLocateAt = Date.now();
    const old = state.places.find((p) => p.current);
    const moved = !old || distanceKm(old, { lat, lon }) > 1.5;
    let names = old;
    if (moved || old.name === UNNAMED) {
      // If the name can't be looked up now, show none (and try again next time) rather than the old place's name.
      try { names = { ...(moved ? null : old), ...await reverseGeocode(lat, lon) }; } catch { if (moved) names = { name: UNNAMED }; }
    }
    const place = store.sanitizePlace({ ...names, lat: moved ? lat : old.lat, lon: moved ? lon : old.lon, current: true });
    state.places = [place, ...state.places.filter((p) => !p.current)];
    store.savePlaces(state.places);
    setUseLocation(true);
    if (moved) {
      state.weather.delete("current");
      store.removeWeather("current");
      delete state.summaries.current;
      syncAlerts();
    }
    const userAsked = fromUser || state.locateWanted;
    state.locateWanted = false;
    if (userAsked) {
      closeSheet("sheet-places");
      window.scrollTo(0, 0);
      await showPlace("current");
    } else if (state.activeId === "current") {
      if (moved) await refresh("current", { quiet: true });
      else if (state.view && state.viewId) render(state.view);
    } else if (state.view && state.viewId) {
      render(state.view); // update the location dots
    }
    return true;
  } catch (err) {
    if (fromUser || state.locateWanted) {
      state.locateWanted = false;
      const msg = String(err?.message || "");
      toast(/disabled|not enabled|services/i.test(msg) ? "Location services are turned off. Turn them on, or search for a city."
        : /denied|permission/i.test(msg) ? "Location permission was denied. Search for a city instead."
          : "Couldn't find your location. Try again, or search for a city.", { ms: 4500 });
    }
    return false;
  } finally {
    state.locating = false;
    renderPlacesSheet();
  }
}

function setUseLocation(on) {
  if (state.settings.useLocation === on) return;
  state.settings = { ...state.settings, useLocation: on };
  store.saveSettings(state.settings);
  if (isSheetOpen("sheet-settings")) renderSettingsSheet();
}

// ---------------------------------------------------------------------------
// Sheets

function openDay(date) {
  tap();
  state.dayDate = date;
  renderDay($("day-body"), state.view, date, pickDay);
  openSheet("sheet-day");
}
function pickDay(date) {
  tick();
  state.dayDate = date;
  renderDay($("day-body"), state.view, date, pickDay);
}
function openHour(hr) {
  tap();
  renderHour($("hour-body"), hr);
  openSheet("sheet-hour");
}
function openMetric(key) {
  tap();
  state.metricKey = key;
  renderMetric($("metric-body"), state.view, key, precipTotals(state.view));
  openSheet("sheet-metric");
}

function renderPlacesSheet() {
  renderPlaces($("places-body"), {
    places: state.places, activeId: state.activeId, summaries: state.summaries, editing: state.editing,
    query: state.query, results: state.results, status: state.searchStatus,
    useLocation: state.settings.useLocation && state.places.some((p) => p.current), locating: state.locating,
    approximate: native && !state.precise,
    onPrecise: async () => {
      tap();
      try {
        const perm = await Geolocation.requestPermissions({ permissions: ["location"] });
        if (perm.location === "granted") { state.precise = true; await locate({ fromUser: true }); }
        else toast("Still using approximate location. You can change this in Android Settings › Apps › Weatherwise › Location.", { ms: 5000 });
      } catch { /* dialog dismissed */ }
      renderPlacesSheet();
    },
    onSelect: (p) => {
      tap();
      closeSheet("sheet-places");
      if (p.id !== state.activeId) {
        const from = indexOf(state.activeId);
        const to = indexOf(p.id);
        if (state.viewId) switchToIndex(to, to > from ? 1 : -1);
        else showPlace(p.id);
      }
    },
    onRemove: removePlace,
    onAdd: (r) => {
      tap();
      const place = addPlace(r);
      if (!place) return;
      state.query = "";
      $("place-search").value = "";
      closeSheet("sheet-places");
      window.scrollTo(0, 0);
      showPlace(place.id, { dir: 1 }).then(refreshSummaries);
    },
    onLocate: () => { tap(); locate({ fromUser: true }); },
  });
  const edit = $("places-edit");
  edit.textContent = state.editing ? "Done" : "Edit";
  edit.classList.toggle("hidden", !state.places.length || state.query.trim().length >= 2);
}

function openPlaces() {
  tap();
  state.editing = false;
  state.query = "";
  state.results = [];
  state.searchStatus = "";
  $("place-search").value = "";
  $("place-search-clear").classList.add("invisible");
  renderPlacesSheet();
  openSheet("sheet-places");
  refreshSummaries();
}

let searchTimer = 0, searchCtrl = null;
function onSearchInput() {
  const q = $("place-search").value;
  state.query = q;
  $("place-search-clear").classList.toggle("invisible", !q);
  clearTimeout(searchTimer);
  searchCtrl?.abort();
  if (q.trim().length < 2) {
    state.results = [];
    state.searchStatus = "";
    renderPlacesSheet();
    return;
  }
  state.searchStatus = "Searching…";
  renderPlacesSheet();
  searchTimer = setTimeout(async () => {
    const ctrl = (searchCtrl = new AbortController());
    try {
      const me = state.places.find((p) => p.current);
      const res = await searchPlaces(q, ctrl.signal, me ? { lat: me.lat, lon: me.lon } : null);
      if (ctrl.signal.aborted) return;
      state.results = res;
      state.searchStatus = res.length ? "" : `No places found for “${q.trim()}”.`;
    } catch (err) {
      if (ctrl.signal.aborted) return;
      state.results = [];
      state.searchStatus = err instanceof ApiError ? `${err.message}.` : "Search failed.";
    }
    renderPlacesSheet();
  }, 300);
}

function renderSettingsSheet() {
  const ap = alertPlace();
  const viewing = activePlace();
  renderSettings($("settings-body"), {
    settings: state.settings, tier: effectiveTier(), version: VERSION, onChange: onSettingsChange,
    alertPlace: ap ? (ap.current ? `My location (${ap.name})` : ap.name) : null,
    viewingName: viewing ? (viewing.current ? "My location" : viewing.name) : "",
    canSwitchAlertPlace: !!(ap && viewing && ap.id !== viewing.id),
    alerts: alertsView(), maxAlerts: store.MAX_ALERTS,
    onAddAlert: openAlertEditor, onToggleAlert: toggleAlert, onDeleteAlert: deleteAlert,
    onAlertHere: () => {
      tick();
      state.settings = { ...state.settings, notifyPlaceId: state.activeId };
      store.saveSettings(state.settings);
      syncAlerts();
      renderSettingsSheet();
      toast(`Alerts now follow ${viewing.current ? "My location" : viewing.name}.`);
    },
    onPreview: async () => {
      tap();
      if (!alertPlace() || !(await requestNotifications())) { toast(NOTIFICATIONS_OFF, { ms: 5000 }); return; }
      await previewSunAlert();
    },
    reliability: reliabilitySummary(state.engine), compassAvailable: compassAvailable(),
    onReliability: openReliability,
  });
}

function onSettingsChange(patch) {
  tick();
  const prev = state.settings;
  state.settings = store.sanitizeSettings({ ...prev, ...patch });
  if ("useLocation" in patch) {
    state.settings.useLocation = prev.useLocation; // changes once we actually have (or drop) a fix
    if (patch.useLocation) {
      closeSheet("sheet-settings");
      locate({ fromUser: true });
    } else {
      const cur = state.places.find((p) => p.current);
      if (cur) removePlace(cur);
      else setUseLocation(false);
    }
  }
  store.saveSettings(state.settings);
  if (["temp", "wind", "pressure", "precip", "time"].some((k) => k in patch)) {
    applyUnits();
    if (state.view && state.viewId) render(state.view);
  }
  if ("effects" in patch || "animate" in patch) applyEffects();
  if ("compass" in patch && state.view && state.viewId) render(state.view);
  if (patch.notifySunrise === true || patch.notifySunset === true) {
    // Turning an alert on: ask for notification permission (Android 13+) first.
    requestNotifications().then((ok) => {
      if (!ok) {
        state.settings = { ...state.settings, notifySunrise: prev.notifySunrise, notifySunset: prev.notifySunset };
        store.saveSettings(state.settings);
        renderSettingsSheet();
        toast(NOTIFICATIONS_OFF, { ms: 5000 });
        return;
      }
      if (!state.places.some((p) => p.id === state.settings.notifyPlaceId)) {
        state.settings = { ...state.settings, notifyPlaceId: alertPlace()?.id ?? null };
        store.saveSettings(state.settings);
      }
      syncAlerts();
      renderSettingsSheet();
      const ap = alertPlace();
      if (ap) toast(`${patch.notifySunrise ? "Sunrise" : "Sunset"} alerts on for ${ap.current ? "My location" : ap.name}.`);
      offerReliability();
    });
  } else if (["notifySunrise", "notifySunset", "notifyLead", "time"].some((k) => k in patch)) {
    syncAlerts();
  }
  renderSettingsSheet();
}

// ---------------------------------------------------------------------------
// Sunrise / sunset alerts

/** The place alerts follow: the one picked in Settings, else My location, else the one being viewed. */
function alertPlace() {
  const s = state.settings;
  return state.places.find((p) => p.id === s.notifyPlaceId) || state.places.find((p) => p.current) || activePlace() || state.places[0] || null;
}

const NOTIFICATIONS_OFF = "Notifications are off for Weatherwise. Allow them in Android Settings › Apps › Weatherwise › Notifications.";

/** Tell the native alert engine that settings, places or alerts changed. */
let alertsTimer = 0;
function syncAlerts() {
  clearTimeout(alertsTimer);
  alertsTimer = setTimeout(async () => {
    await alertsJob;
    await syncEngine();
    refreshEngine();
  }, 400);
}

async function refreshEngine() {
  const s = await engineStatus();
  if (!s) return;
  await reloadAlerts(); // a one-time alert may have switched itself off
  state.engine = s;
  state.alertStatus = s.alerts || {};
  if (isSheetOpen("sheet-settings")) renderSettingsSheet();
  if (isSheetOpen("sheet-reliability")) renderReliabilitySheet();
}

function renderReliabilitySheet() {
  renderReliability($("reliability-body"), {
    status: state.engine, now: Date.now(),
    onFix: async (key) => {
      tap();
      if (key === "notifications" && !state.engine.notifications && (await requestNotifications())) { refreshEngine(); return; }
      openPhoneSettings(key); // the list refreshes when the user comes back
    },
    onTest: async () => {
      tap();
      if (!(await requestNotifications())) { toast(NOTIFICATIONS_OFF, { ms: 5000 }); return; }
      await startDeliveryTest(60);
      await refreshEngine();
      setTimeout(refreshEngine, 66000);
    },
  });
}

function openReliability() {
  tap();
  renderReliabilitySheet();
  openSheet("sheet-reliability");
  refreshEngine();
}

/** Show what can delay alerts: once per problem (and again if a solved one comes back), so it doesn't nag. */
async function offerReliability() {
  await refreshEngine();
  if (!state.engine || isSheetOpen("sheet-reliability")) return;
  const problems = reliabilityItems(state.engine).filter((i) => i.ok === false).map((i) => i.key); // not the optional ones
  const seen = await store.loadSeenProblems();
  store.saveSeenProblems(problems);
  if (problems.some((k) => !seen.includes(k))) openReliability();
}

/** The app was opened with alerts on, for example after an update or after the phone held an alert back. */
async function offerReliabilityOnOpen() {
  const s = state.settings;
  if (!s.notifySunrise && !s.notifySunset && !state.alerts.some((a) => a.enabled)) return;
  await wait(1200);
  if (!document.hidden && !anySheetOpen()) offerReliability();
}

function applyUnits() {
  setUnits(state.settings);
  setTimePref(state.settings.time);
}

// ---------------------------------------------------------------------------
// Visual effects & adaptive performance

const effectiveTier = () => (state.settings.effects === "auto" ? state.tierAuto : state.settings.effects);

function applyEffects() {
  const tier = effectiveTier();
  document.documentElement.classList.toggle("lite", tier === "lite");
  sky.setQuality(tier);
  sky.setAnimate(state.settings.animate && !reducedMotion);
}

function measureFrames(ms) {
  return new Promise((resolve) => {
    const gaps = [];
    let last = 0;
    const end = performance.now() + ms;
    const step = (t) => {
      if (last) gaps.push(t - last);
      last = t;
      if (t < end) requestAnimationFrame(step);
      else {
        gaps.sort((a, b) => a - b);
        resolve({ median: gaps[Math.floor(gaps.length / 2)] || 16, p90: gaps[Math.floor(gaps.length * 0.9)] || 16, n: gaps.length });
      }
    };
    requestAnimationFrame(step);
  });
}

function downgrade(reason) {
  if (state.settings.effects !== "auto" || state.tierAuto === "lite") return;
  state.tierAuto = "lite";
  store.savePerf("lite");
  applyEffects();
  document.documentElement.dataset.perf = reason;
  if (isSheetOpen("sheet-settings")) renderSettingsSheet();
}

async function autoTune() {
  if (state.settings.effects !== "auto" || state.tierAuto !== "full" || document.hidden) return;
  await wait(1200);
  const r = await measureFrames(1500);
  document.documentElement.dataset.probe = `${r.median.toFixed(1)}/${r.p90.toFixed(1)}`;
  if (r.median > 24 || r.p90 > 45) downgrade("idle");
  else store.savePerf("full");
}

// Watch real scrolling too: frosted glass costs most while content moves.
const scrollWatch = { active: false, gaps: [], last: 0, idle: 0, checked: false };
function watchScrollPerf() {
  if (scrollWatch.checked || state.tierAuto !== "full" || state.settings.effects !== "auto") return;
  clearTimeout(scrollWatch.idle);
  scrollWatch.idle = setTimeout(() => { scrollWatch.active = false; }, 300);
  if (scrollWatch.active) return;
  scrollWatch.active = true;
  scrollWatch.last = 0;
  const step = (t) => {
    if (!scrollWatch.active) return;
    if (scrollWatch.last) scrollWatch.gaps.push(t - scrollWatch.last);
    scrollWatch.last = t;
    if (scrollWatch.gaps.length >= 60) {
      const g = [...scrollWatch.gaps].sort((a, b) => a - b);
      scrollWatch.checked = true;
      scrollWatch.active = false;
      document.documentElement.dataset.scrollProbe = g[Math.floor(g.length / 2)].toFixed(1);
      if (g[Math.floor(g.length / 2)] > 28) downgrade("scroll");
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// Scrolling: collapsing hero, top bar, sky pause

let scrollIdleTimer = 0;
let topbarSolid = false;
const onScroll = rafThrottle(() => {
  const y = Math.max(0, window.scrollY);
  const inner = $("hero-inner");
  if (inner && !inner.dataset.swiping) {
    const p = clamp(y / (state.heroH * 0.75), 0, 1);
    inner.style.opacity = String(1 - p);
    inner.style.transform = y > 0 ? `translate3d(0,${(y * 0.35).toFixed(1)}px,0) scale(${(1 - p * 0.06).toFixed(3)})` : "";
  }
  const solid = document.body.dataset.view === "main" && y > state.heroH * 0.6;
  if (solid !== topbarSolid) {
    topbarSolid = solid;
    $("topbar").classList.toggle("solid", solid);
  }
  syncCompass();
  if (effectiveTier() !== "lite") $("sky-shade").style.opacity = String(clamp(y / 900, 0, 0.5));
});

window.addEventListener("scroll", () => {
  onScroll();
  sky.pause("scroll");
  clearTimeout(scrollIdleTimer);
  scrollIdleTimer = setTimeout(() => sky.resume("scroll"), 220);
  watchScrollPerf();
}, { passive: true });

window.addEventListener("resize", () => {
  state.heroH = $("hero")?.offsetHeight || state.heroH;
  onScroll();
});

// ---------------------------------------------------------------------------
// Gestures: swipe between places on the hero, pull to refresh at the top

function attachHeroSwipe() {
  const el = $("hero");
  const inner = $("hero-inner");
  if (!el || !inner || state.places.length < 2) return;
  let x0 = null, y0 = 0, dx = 0, mode = null;
  el.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    dx = 0;
    mode = null;
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (x0 == null) return;
    const mx = e.touches[0].clientX - x0;
    const my = e.touches[0].clientY - y0;
    if (!mode && (Math.abs(mx) > 10 || Math.abs(my) > 10)) mode = Math.abs(mx) > Math.abs(my) * 1.2 ? "h" : "v";
    if (mode !== "h") return;
    // Own horizontal swipes completely so Chrome never treats them as a fling
    // (which would swallow the user's next tap). Vertical scrolling stays native.
    if (e.cancelable) e.preventDefault();
    dx = mx;
    const i = indexOf(state.activeId);
    const edge = (dx > 0 && i === 0) || (dx < 0 && i === state.places.length - 1);
    const shown = edge ? dx * 0.25 : dx;
    inner.dataset.swiping = "1";
    inner.style.transition = "none";
    inner.style.transform = `translate3d(${shown.toFixed(1)}px,0,0)`;
    inner.style.opacity = String(1 - Math.min(Math.abs(shown) / 320, 0.6));
  }, { passive: false });
  const end = () => {
    if (mode === "h") {
      const i = indexOf(state.activeId);
      const next = dx < -60 ? i + 1 : dx > 60 ? i - 1 : i;
      if (next !== i && next >= 0 && next < state.places.length) {
        tick();
        switchToIndex(next, dx < 0 ? 1 : -1);
      } else {
        inner.style.transition = "transform .25s ease, opacity .25s ease";
        inner.style.transform = "";
        inner.style.opacity = "";
        setTimeout(() => { inner.style.transition = ""; delete inner.dataset.swiping; onScroll(); }, 260);
      }
    }
    x0 = null;
    mode = null;
  };
  el.addEventListener("touchend", end);
  el.addEventListener("touchcancel", end);
}

(function pullToRefresh() {
  const ptr = $("ptr");
  const arc = $("ptr-arc");
  const THRESHOLD = 76;
  let y0 = null, x0 = 0, dist = 0, armed = false, busy = false, dir = null;
  const set = (d) => {
    ptr.style.transform = `translate3d(0,${(d - 64).toFixed(1)}px,0)`;
    ptr.style.opacity = String(clamp(d / 40, 0, 1));
    arc.style.strokeDasharray = `${clamp((d / THRESHOLD) * 80, 0, 80).toFixed(1)} 100`;
  };
  document.addEventListener("touchstart", (e) => {
    if (busy || anySheetOpen() || window.scrollY > 0 || document.body.dataset.view !== "main" || e.touches.length !== 1) return;
    y0 = e.touches[0].clientY;
    x0 = e.touches[0].clientX;
    dist = 0;
    armed = false;
    dir = null;
    ptr.classList.remove("settle");
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0;
    const dx = e.touches[0].clientX - x0;
    if (!dir && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) dir = Math.abs(dy) > Math.abs(dx) ? "v" : "h";
    if (dir !== "v" || dy <= 0 || window.scrollY > 0) {
      if (dist) { dist = 0; set(0); }
      return;
    }
    dist = Math.min(dy * 0.5, 130);
    set(dist);
    if (!armed && dist >= THRESHOLD) { armed = true; tick(); }
    else if (armed && dist < THRESHOLD) armed = false;
  }, { passive: true });
  const end = async () => {
    if (y0 == null) return;
    y0 = null;
    ptr.classList.add("settle");
    if (armed && !busy) {
      busy = true;
      ptr.classList.add("loading");
      set(THRESHOLD);
      const id = state.activeId;
      if (id === "current" && state.settings.useLocation) await locate();
      await refresh(id);
      busy = false;
      ptr.classList.remove("loading");
    }
    set(0);
    armed = false;
  };
  document.addEventListener("touchend", end);
  document.addEventListener("touchcancel", end);
})();

// ---------------------------------------------------------------------------
// Wiring

function wire() {
  $("btn-places").innerHTML = uiIcon("list");
  $("btn-settings").innerHTML = uiIcon("sliders");
  $("search-icon").innerHTML = uiIcon("search");
  $("place-search-clear").innerHTML = uiIcon("close");
  document.querySelectorAll("[data-close]").forEach((b) => { if (!b.firstElementChild) b.innerHTML = uiIcon("close"); });
  const hr = new Date().getHours();
  $("welcome-mark").innerHTML = weatherIcon(2, hr >= 7 && hr < 19, "wx-anim");
  $("error-icon").innerHTML = uiIcon("offline");

  $("btn-places").addEventListener("click", openPlaces);
  $("btn-settings").addEventListener("click", () => {
    tap();
    renderSettingsSheet();
    openSheet("sheet-settings");
    refreshEngine();
  });
  $("welcome-search").addEventListener("click", () => {
    openPlaces();
    setTimeout(() => $("place-search").focus(), 320);
  });
  $("welcome-locate").addEventListener("click", () => { tap(); locate({ fromUser: true }); });
  $("error-retry").addEventListener("click", () => { tap(); showView("loading"); refresh(state.activeId); });
  $("places-edit").addEventListener("click", () => { tick(); state.editing = !state.editing; renderPlacesSheet(); });
  $("place-search").addEventListener("input", onSearchInput);
  $("place-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("places-body").querySelector(".result")?.click();
    }
  });
  $("place-search-clear").addEventListener("click", () => {
    $("place-search").value = "";
    onSearchInput();
    $("place-search").focus();
  });

  initSheets();
  onSheetsChange((n) => { n ? sky.pause("sheet") : sky.resume("sheet"); syncCompass(); });
  document.addEventListener("visibilitychange", syncCompass);
  onAlertTapped(({ placeId }) => {
    if (!state.ready) { state.tapPlace = placeId; return; } // the tap started the app: boot() opens this place
    if (placeId && state.places.some((p) => p.id === placeId) && placeId !== state.activeId) {
      closeAll();
      window.scrollTo(0, 0);
      showPlace(placeId);
    }
  });

  App.addListener("backButton", () => {
    if (closeTop()) return;
    if (document.body.dataset.view === "main" && window.scrollY > 80) {
      window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
      return;
    }
    App.minimizeApp().catch(() => App.exitApp());
  }).catch(() => {});

  App.addListener("resume", async () => {
    if (state.settings.useLocation && Date.now() - state.lastLocateAt > 15 * 60000) locate();
    autoTune();
    syncAlerts(); // also delivers anything the phone held back while asleep
    const id = state.activeId;
    const data = id && state.weather.get(id);
    if (data && Date.now() - data.fetchedAt > 10 * 60000) {
      const newer = await pickUpBackground(id, data.fetchedAt);
      const view = newer && id === state.activeId ? buildView(newer) : null;
      if (view) render(view);
    }
    tickMinute(STALE_MIN);
    offerReliabilityOnOpen();
  }).catch(() => {});

  Network.addListener("networkStatusChange", (s) => {
    const was = state.online;
    state.online = s.connected;
    updateFreshness();
    if (!s.connected) toast("You're offline. Showing saved forecasts.");
    else if (!was && state.activeId) refresh(state.activeId, { quiet: true });
  }).catch(() => {});

  setInterval(() => tickMinute(), 60000);
}

function tickMinute(staleMin = 30) {
  if (document.hidden || !state.viewId) return;
  const data = state.weather.get(state.viewId);
  if (!data) return;
  const v = buildView(data);
  if (!v) { refresh(state.viewId); return; }
  if (v.nowIdx !== state.view.nowIdx || v.todayIdx !== state.view.todayIdx) render(v);
  else { state.view = v; updateSky(v); updateFreshness(); }
  if ((Date.now() - data.fetchedAt) / 60000 > staleMin && state.online) refresh(state.viewId, { quiet: true });
}

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  setTimeout(hideSplash, 2500);
  wire();
  store.saveFetchSpec(BACKGROUND_QUERY);

  let [settings, places, active, summaries, perf] = await Promise.all([
    store.loadSettings(), store.loadPlaces(), store.loadActive(), store.loadSummaries(), store.loadPerf(),
  ]);
  if (!places.length) {
    const mig = await store.migrateV1();
    if (mig) {
      places = mig.places;
      settings = store.sanitizeSettings({ ...settings, ...mig.settings });
      active = mig.active && places.some((p) => p.id === mig.active) ? mig.active : places[0]?.id ?? null;
      store.savePlaces(places);
      store.saveSettings(settings);
    }
  }
  state.settings = settings;
  state.places = places;
  state.summaries = summaries;
  state.alerts = await store.loadAlerts();
  applyUnits();

  const memory = navigator.deviceMemory || 4;
  if (perf) state.tierAuto = perf.tier === "lite" && Date.now() - perf.at > 3 * 86400000 ? "full" : perf.tier;
  else state.tierAuto = memory <= 2 ? "lite" : "full";
  applyEffects();

  await Promise.race([initCompass(), wait(500)]);
  try { state.online = (await Network.getStatus()).connected; } catch { /* assume online */ }

  state.activeId = [state.tapPlace, active].find((id) => places.some((p) => p.id === id)) ?? places[0]?.id ?? null;
  state.ready = true;
  syncAlerts();
  if (!state.activeId) {
    defaultSky();
    showView("welcome");
    hideSplash();
    autoTune();
    if (settings.useLocation) locate();
    return;
  }
  await showPlace(state.activeId);
  offerReliabilityOnOpen();
  autoTune();
  if (settings.useLocation) await locate();
  prefetchNeighbours();
  backfillRegions();
}

// ---------------------------------------------------------------------------
// Temperature alerts (checked natively in the background: see alerts.js / AlertEngine.java)

let alertsJob = Promise.resolve();

function reloadAlerts() {
  alertsJob = alertsJob.then(async () => { state.alerts = await store.loadAlerts(); }).catch(() => {});
  return alertsJob;
}

/** Change the saved alerts. Reads them first: the engine may have switched a one-time alert off meanwhile. */
function editAlerts(change) {
  alertsJob = alertsJob.then(async () => {
    state.alerts = change(await store.loadAlerts()).filter(Boolean).slice(0, store.MAX_ALERTS);
    await store.saveAlerts(state.alerts);
  }).catch(() => {});
  return alertsJob;
}

async function alertsChanged() {
  if (isSheetOpen("sheet-settings")) renderSettingsSheet();
  await syncEngine();
  await checkTemperatures();
  refreshEngine();
}

function alertsView() {
  return state.alerts.map((a) => {
    const place = state.places.find((p) => p.id === a.placeId);
    const st = state.alertStatus[a.id];
    let status;
    if (!a.enabled) status = a.repeat === "once" && st && st.last ? "Triggered and switched off. Turn on to watch again." : "Off";
    else if (!st || typeof st.value !== "number") status = "Watching. Waiting for the first reading.";
    else {
      const now = `${temp(st.value)}${tempUnit()} ${fmtAgo(Date.now() - st.checked)}`;
      status = st.armed === false ? `Already past it (${now}); watching for the next time.` : `Watching · ${now}`;
    }
    return { id: a.id, enabled: a.enabled, summary: alertSummary(a, place), status };
  });
}

function nowTemps(placeId) {
  const data = state.weather.get(placeId);
  const v = data ? buildView(data) : null;
  if (v) return { temp: v.cur.temp, feels: v.cur.feels };
  const sm = state.summaries[placeId];
  return sm && typeof sm.temp === "number" ? { temp: sm.temp, feels: sm.temp } : null;
}

function openAlertEditor() {
  tap();
  const place = activePlace() || state.places.find((p) => p.current) || state.places[0];
  if (!place) { toast("Add a place first, then set an alert for it."); return; }
  const now = nowTemps(place.id);
  state.draft = { placeId: place.id, op: "below", value: now ? Math.round(now.temp) - 3 : 10, metric: "temp", repeat: "always" };
  renderAlertEditorSheet();
  openSheet("sheet-alert");
}

function renderAlertEditorSheet() {
  renderAlertEditor($("alert-body"), {
    draft: state.draft, places: state.places, now: nowTemps(state.draft.placeId),
    onChange: (patch) => { tick(); state.draft = { ...state.draft, ...patch }; renderAlertEditorSheet(); },
    onStep: (dir) => {
      tick();
      // Step in whole degrees of the user's unit; stored in °C.
      const shown = Number(temp(state.draft.value)) + dir;
      const c = state.settings.temp === "f" ? ((shown - 32) * 5) / 9 : shown;
      state.draft = { ...state.draft, value: Math.max(-50, Math.min(55, Math.round(c * 100) / 100)) };
      renderAlertEditorSheet();
    },
    onSave: saveDraftAlert,
  });
}

async function saveDraftAlert() {
  tap();
  const now = nowTemps(state.draft.placeId);
  const base = now ? (state.draft.metric === "feels" ? now.feels : now.temp) : null;
  const rule = store.sanitizeAlert({ ...state.draft, base, id: newAlertId(), enabled: true, createdAt: Date.now() });
  if (!rule || state.alerts.length >= store.MAX_ALERTS) return;
  closeSheet("sheet-alert");
  await editAlerts((list) => [...list, rule]);
  renderSettingsSheet();
  const ok = await requestNotifications();
  const place = state.places.find((p) => p.id === rule.placeId);
  toast(ok ? `Alert set: ${alertSummary(rule, place)}.` : `Alert saved, but: ${NOTIFICATIONS_OFF}`, { ms: ok ? 4000 : 6000 });
  await alertsChanged();
  if (ok) offerReliability();
}

async function toggleAlert(id) {
  tick();
  // Turning an alert back on gives it a new id, so it starts fresh from the current temperature.
  const turnOn = !state.alerts.find((a) => a.id === id)?.enabled;
  await editAlerts((list) => list.map((a) => {
    if (a.id !== id) return a;
    if (!turnOn) return { ...a, enabled: false };
    const now = nowTemps(a.placeId);
    return store.sanitizeAlert({ ...a, id: newAlertId(), enabled: true, base: now ? (a.metric === "feels" ? now.feels : now.temp) : null });
  }));
  await alertsChanged();
  if (turnOn && (await requestNotifications())) offerReliability();
}

async function deleteAlert(id) {
  tap();
  await editAlerts((list) => list.filter((a) => a.id !== id));
  await alertsChanged();
}

/**
 * Places saved before districts were stored (just "name, state") get their
 * taluka/district filled in once, so two places with the same name can't be confused.
 * Sequential with a pause: Nominatim allows at most one request per second.
 */
async function backfillRegions() {
  for (const p of state.places.filter((x) => !x.current && !x.admin2)) {
    if (!state.online) return;
    try {
      const info = await reverseGeocode(p.lat, p.lon);
      const place = state.places.find((x) => x.id === p.id);
      if (!place || !info.admin2) continue;
      place.admin2 = info.admin2;
      store.savePlaces(state.places);
      if (state.viewId === p.id && state.view) render(state.view);
      if (isSheetOpen("sheet-places")) renderPlacesSheet();
    } catch { /* try again next launch */ }
    await wait(1200);
  }
}

boot();
