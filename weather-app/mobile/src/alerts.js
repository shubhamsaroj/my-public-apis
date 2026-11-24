// Bridge to the native alert engine (AlertsPlugin.java / AlertEngine.java), which runs with
// the app closed. It reads the settings, places and alert rules this app saves in Preferences.

import { Capacitor, registerPlugin } from "@capacitor/core";
import { temp, tempUnit } from "./lib/format.js";

const native = Capacitor.isNativePlatform();
const Alerts = registerPlugin("Alerts");

async function call(name, args = {}, fallback = null) {
  if (!native) return fallback;
  try { return await Alerts[name](args); } catch { return fallback; }
}

/** Settings, places or alerts changed: re-plan the next wake-up (cheap, no network). */
export const syncEngine = () => call("sync");
export const checkTemperatures = (opts) => call("check", opts);
export const engineStatus = () => call("status", {}, null);
export const requestNotifications = async () => (await call("requestNotifications", {}, {}))?.granted === true;
export const openPhoneSettings = (which) => call("openSettings", { which });
export const previewSunAlert = () => call("preview");
export const startDeliveryTest = (seconds = 60) => call("test", { seconds });
export const backgroundForecast = async (id, since) => (await call("background", { id, since }, {}))?.data || "";

export function onAlertTapped(fn) {
  if (native) Alerts.addListener("alertTapped", (e) => fn(e || {}));
}

export const newAlertId = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** "London · drops to 10°C · every time" */
export function alertSummary(a, place) {
  const where = !place ? "Removed place" : place.current ? "My location" : place.name;
  const what = `${a.op === "below" ? "drops to" : "rises to"} ${temp(a.value)}${tempUnit()}${a.metric === "feels" ? " (feels like)" : ""}`;
  return `${where} · ${what} · ${a.repeat === "once" ? "once" : "every time"}`;
}

// ---------------------------------------------------------------------------
// What this phone needs for alerts to arrive on time

const BRANDS = { xiaomi: "Xiaomi", redmi: "Redmi", poco: "POCO", realme: "realme", oppo: "OPPO", vivo: "vivo", iqoo: "iQOO", oneplus: "OnePlus", samsung: "Samsung", huawei: "Huawei", honor: "HONOR", infinix: "Infinix", tecno: "TECNO", itel: "itel", asus: "ASUS" };
const MIUI = "Turn on Autostart for Weatherwise. Then in App info › Battery saver choose No restrictions.";
const COLOR = "Allow Auto launch for Weatherwise. Then in App info › Battery usage turn on Allow background activity.";
const VIVO = "Allow Autostart for Weatherwise, and set Background power consumption to Don't restrict.";
const HUAWEI = "Set Weatherwise to Manage manually, then allow Auto-launch and Run in background.";
const TRANSSION = "Allow Auto-start for Weatherwise in Phone Master.";
const BRAND_HELP = {
  xiaomi: MIUI, redmi: MIUI, poco: MIUI, realme: COLOR, oppo: COLOR, oneplus: COLOR, vivo: VIVO, iqoo: VIVO,
  samsung: "In Background usage limits, add Weatherwise to Never sleeping apps.",
  huawei: HUAWEI, honor: HUAWEI, infinix: TRANSSION, tecno: TRANSSION, itel: TRANSSION, asus: "Allow Auto-start for Weatherwise in Mobile Manager.",
};

/** Pure: checklist for the reliability screen. ok: true, false, or null when Android can't tell us. */
export function reliabilityItems(s) {
  if (!s) return [];
  const items = [
    { key: "notifications", title: "Notifications", ok: s.notifications === true && !s.channelsBlocked, text: s.notifications && !s.channelsBlocked ? "Allowed" : "Blocked, so alerts can't be shown.", action: "Allow" },
    { key: "exact", title: "Exact timing", ok: s.exact === true, text: s.exact ? "Allowed" : "Not allowed. Alerts can arrive up to an hour late.", action: "Allow" },
    {
      key: "battery", title: "Running in the background", ok: s.battery === "unrestricted" ? true : s.battery === "restricted" ? false : null, action: "Allow",
      text: s.battery === "unrestricted" ? "Allowed at all times" : s.battery === "restricted" ? "Restricted: alerts can't arrive while the app is closed." : "Optional. Alerts work without it; allow it only if yours ever arrive late.",
    },
  ];
  if (s.dataBlocked) items.push({ key: "data", title: "Background data", ok: false, text: "Data Saver is blocking it, so temperatures can't be checked on mobile data. Allow unrestricted data.", action: "Allow" });
  if (BRAND_HELP[s.brand]) {
    const why = s.heldAt ? "An alert didn't arrive until you opened the app. " : "";
    items.push({ key: "autostart", title: `Autostart on ${BRANDS[s.brand]}`, ok: s.heldAt ? false : null, text: why + BRAND_HELP[s.brand], action: "Open" });
  } else if (s.heldAt) {
    items.push({ key: "app", title: "Stopped by your phone", ok: false, text: "An alert didn't arrive until you opened the app. In App info, allow background use, and avoid Force stop.", action: "Open" });
  }
  return items;
}
/** Pure: one-line verdict for Settings. Never claims more than Android, or a test on this phone, can tell us. */
export function reliabilitySummary(s) {
  if (!s) return null;
  const items = reliabilityItems(s);
  const problems = items.filter((i) => i.ok === false).length;
  if (problems) return { warn: true, title: `${problems} ${problems === 1 ? "setting" : "settings"} can delay alerts`, text: "Tap to fix, and to test it on your phone." };
  const passed = s.test && s.test.late <= 15;
  if (passed) return { warn: false, title: "Alerts arrive on time", text: "The last test arrived on time. Tap to see recent activity." };
  return { warn: false, title: "Nothing is blocking alerts", text: BRANDS[s.brand] ? `${BRANDS[s.brand]} phones can stop background apps. Tap to run a 1-minute test.` : "Tap to run a 1-minute test or see recent activity." };
}
