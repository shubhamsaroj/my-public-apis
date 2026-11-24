import { CapacitorHttp } from "@capacitor/core";

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const PHOTON_URL = "https://photon.komoot.io/api/";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "Weatherwise/1.0 (Android app; com.techbyshubhamsaroj.weatherwise)";
const TIMEOUT_MS = 15000;

export const SCHEMA = 2;

export class ApiError extends Error {}

export function validCoords(lat, lon) {
  return (
    typeof lat === "number" && typeof lon === "number" &&
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
  );
}

export function cleanText(value, max = 80) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, max) : "";
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int01 = (v) => v === 1;

async function getJson(url, params, signal) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)));
    else u.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(u.toString(), { signal: ctrl.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    if (!res.ok) throw new ApiError(res.status === 429 ? "Too many requests, try again shortly" : `Weather service error (${res.status})`);
    return await res.json();
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof ApiError) throw err;
    throw new ApiError(err?.name === "AbortError" ? "The request timed out" : "No internet connection");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Search & reverse geocoding

/**
 * Place search. Photon (OpenStreetMap data) knows villages that Open-Meteo's
 * GeoNames index lacks, so a same-named village hundreds of km away could be picked
 * instead. Falls back to Open-Meteo if Photon fails.
 * `near` ({lat, lon}) biases results towards the user; it is rounded to ~10 km.
 */
export async function searchPlaces(query, signal, near = null) {
  const q = cleanText(query, 100);
  if (q.length < 2) return [];
  try {
    const params = { q, limit: 12, lang: "en", layer: ["city", "district", "locality"] };
    if (near && validCoords(near.lat, near.lon)) {
      params.lat = near.lat.toFixed(1);
      params.lon = near.lon.toFixed(1);
    }
    const res = parsePhoton(await getJson(PHOTON_URL, params, signal));
    if (res.length) return res.slice(0, 10);
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  const data = await getJson(GEOCODE_URL, { name: q, count: 10, language: "en", format: "json" }, signal);
  return parseOpenMeteoGeo(data);
}

/** Pure: Photon GeoJSON → places. */
export function parsePhoton(data) {
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(data?.features) ? data.features : []) {
    const p = f?.properties || {};
    const [lon, lat] = Array.isArray(f?.geometry?.coordinates) ? f.geometry.coordinates : [];
    const name = cleanText(p.name);
    if (!name || !validCoords(lat, lon)) continue;
    const osm = /^[NWR]$/.test(p.osm_type) && Number.isInteger(p.osm_id) ? `${p.osm_type}${p.osm_id}` : `${lat.toFixed(3)},${lon.toFixed(3)}`;
    const id = `p${osm}`;
    // The same place can appear as node + relation; keep the first of each name+area.
    const key = `${name}|${cleanText(p.county)}|${cleanText(p.state)}|${cleanText(p.country)}`;
    if (seen.has(id) || seen.has(key)) continue;
    seen.add(id);
    seen.add(key);
    const parent = cleanText(p.county || p.district || (p.city && p.city !== p.name ? p.city : ""));
    out.push({ id, name, admin2: parent, admin1: cleanText(p.state), country: cleanText(p.country), lat, lon });
  }
  return out;
}

/** Pure: Open-Meteo geocoding → places. */
export function parseOpenMeteoGeo(data) {
  const seen = new Set();
  return (Array.isArray(data?.results) ? data.results : [])
    .filter((r) => validCoords(r?.latitude, r?.longitude))
    .map((r) => ({
      id: `g${Number.isInteger(r.id) ? r.id : `${r.latitude.toFixed(3)},${r.longitude.toFixed(3)}`}`,
      name: cleanText(r.name) || "Unknown place",
      admin2: cleanText(r.admin2),
      admin1: cleanText(r.admin1),
      country: cleanText(r.country),
      lat: r.latitude,
      lon: r.longitude,
    }))
    .filter((p) => (seen.has(p.id) ? false : seen.add(p.id)));
}

export async function reverseGeocode(lat, lon) {
  if (!validCoords(lat, lon)) throw new ApiError("Invalid coordinates");
  let data;
  try {
    // Native HTTP so we can send an identifying User-Agent, as Nominatim's policy requires.
    // zoom 14 = village / suburb level (zoom 12 only returned the taluka).
    const res = await CapacitorHttp.get({
      url: REVERSE_URL,
      params: { format: "jsonv2", lat: lat.toFixed(4), lon: lon.toFixed(4), zoom: "14", "accept-language": "en" },
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      connectTimeout: TIMEOUT_MS,
      readTimeout: TIMEOUT_MS,
      responseType: "json",
    });
    if (res.status < 200 || res.status >= 300) throw new Error("status");
    data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
  } catch {
    throw new ApiError("Could not look up the place name");
  }
  return placeFromNominatim(data);
}

/** Pure: Nominatim reverse result → the most local useful name + its parent area. */
export function placeFromNominatim(data) {
  const a = (data && data.address) || {};
  const name = cleanText(a.village || a.hamlet || a.suburb || a.neighbourhood || a.quarter || a.town ||
    a.city_district || a.city || a.municipality || a.county || data?.name) || "My location";
  let admin2 = cleanText(a.county || a.state_district || "");
  if (a.city && cleanText(a.city) !== name && (a.suburb || a.neighbourhood || a.quarter)) admin2 = cleanText(a.city);
  return { name, admin2: admin2 === name ? "" : admin2, admin1: cleanText(a.state || a.region), country: cleanText(a.country) };
}

// ---------------------------------------------------------------------------
// Forecast

const CURRENT = "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,visibility,dew_point_2m";
const HOURLY = "temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,is_day,relative_humidity_2m,dew_point_2m,pressure_msl";
const DAILY = "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,daylight_duration,uv_index_max,precipitation_sum,precipitation_probability_max,precipitation_hours,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant";
const AQ_CURRENT = "us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide";
const FORECAST_PARAMS = {
  current: CURRENT, hourly: HOURLY, daily: DAILY, minutely_15: "precipitation,weather_code", forecast_minutely_15: 9,
  timezone: "auto", past_days: 1, forecast_days: 10,
};
const AIR_PARAMS = { current: AQ_CURRENT, hourly: "us_aqi", timezone: "auto", forecast_days: 5 };
const query = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("&");
/** The same requests, for the native background refresh. */
export const BACKGROUND_QUERY = { forecast: query(FORECAST_PARAMS), air: query(AIR_PARAMS) };

export async function fetchForecast(lat, lon, signal) {
  if (!validCoords(lat, lon)) throw new ApiError("Invalid coordinates");
  const coord = { latitude: lat.toFixed(4), longitude: lon.toFixed(4) };
  const [wx, aq] = await Promise.all([
    getJson(FORECAST_URL, { ...coord, ...FORECAST_PARAMS }, signal),
    getJson(AIR_QUALITY_URL, { ...coord, ...AIR_PARAMS }, signal)
      .catch((err) => { if (signal?.aborted) throw err; return null; }), // air quality is optional
  ]);
  return normalize(wx, aq, Date.now());
}

/** Pure: turn raw API responses into the app's model. Throws on unusable data. */
export function normalize(wx, aq, fetchedAt) {
  const c = wx?.current, h = wx?.hourly, d = wx?.daily;
  if (!c || !h || !d || !Array.isArray(h.time) || !Array.isArray(d.time) || !h.time.length || !d.time.length) {
    throw new ApiError("Unexpected weather response");
  }
  const at = (obj, key, i) => num(obj?.[key]?.[i]);

  const aqByTime = new Map();
  if (Array.isArray(aq?.hourly?.time)) aq.hourly.time.forEach((t, i) => aqByTime.set(t, num(aq.hourly.us_aqi?.[i])));

  const hourly = h.time.map((t, i) => ({
    time: String(t),
    temp: at(h, "temperature_2m", i),
    feels: at(h, "apparent_temperature", i),
    pop: at(h, "precipitation_probability", i),
    precip: at(h, "precipitation", i),
    code: at(h, "weather_code", i) ?? 3,
    cloud: at(h, "cloud_cover", i),
    vis: at(h, "visibility", i),
    wind: at(h, "wind_speed_10m", i),
    windDir: at(h, "wind_direction_10m", i),
    gusts: at(h, "wind_gusts_10m", i),
    uv: at(h, "uv_index", i),
    isDay: int01(h.is_day?.[i]),
    humidity: at(h, "relative_humidity_2m", i),
    dew: at(h, "dew_point_2m", i),
    pressure: at(h, "pressure_msl", i),
    aqi: aqByTime.get(t) ?? null,
  }));

  const daily = d.time.map((date, i) => {
    const aqis = hourly.filter((x) => x.time.startsWith(date) && x.aqi != null).map((x) => x.aqi);
    return {
      date: String(date),
      code: at(d, "weather_code", i) ?? 3,
      max: at(d, "temperature_2m_max", i),
      min: at(d, "temperature_2m_min", i),
      feelsMax: at(d, "apparent_temperature_max", i),
      feelsMin: at(d, "apparent_temperature_min", i),
      sunrise: typeof d.sunrise?.[i] === "string" ? d.sunrise[i] : null,
      sunset: typeof d.sunset?.[i] === "string" ? d.sunset[i] : null,
      daylight: at(d, "daylight_duration", i),
      uvMax: at(d, "uv_index_max", i),
      precipSum: at(d, "precipitation_sum", i),
      pop: at(d, "precipitation_probability_max", i),
      precipHours: at(d, "precipitation_hours", i),
      windMax: at(d, "wind_speed_10m_max", i),
      gustMax: at(d, "wind_gusts_10m_max", i),
      windDir: at(d, "wind_direction_10m_dominant", i),
      aqi: aqis.length >= 6 ? Math.round(aqis.reduce((a, b) => a + b, 0) / aqis.length) : null,
    };
  });

  const m = wx.minutely_15;
  const minutely = Array.isArray(m?.time)
    ? m.time.map((t, i) => ({ time: String(t), precip: num(m.precipitation?.[i]) ?? 0, code: num(m.weather_code?.[i]) ?? 0 }))
    : [];

  const a = aq?.current;
  return {
    v: SCHEMA,
    fetchedAt,
    tz: cleanText(wx.timezone, 60),
    tzAbbr: cleanText(wx.timezone_abbreviation, 12),
    utcOffset: num(wx.utc_offset_seconds) ?? 0,
    current: {
      time: String(c.time),
      temp: num(c.temperature_2m),
      feels: num(c.apparent_temperature),
      humidity: num(c.relative_humidity_2m),
      dew: num(c.dew_point_2m),
      isDay: int01(c.is_day),
      code: num(c.weather_code) ?? 3,
      cloud: num(c.cloud_cover),
      pressure: num(c.pressure_msl),
      wind: num(c.wind_speed_10m),
      windDir: num(c.wind_direction_10m),
      gusts: num(c.wind_gusts_10m),
      uv: num(c.uv_index),
      vis: num(c.visibility),
      precip: num(c.precipitation),
    },
    aq: a ? {
      aqi: num(a.us_aqi), pm25: num(a.pm2_5), pm10: num(a.pm10), o3: num(a.ozone),
      no2: num(a.nitrogen_dioxide), so2: num(a.sulphur_dioxide), co: num(a.carbon_monoxide),
    } : null,
    minutely,
    hourly,
    daily,
  };
}

/** Light-weight current conditions for many places in one request (Locations list). */
export async function fetchSummaries(places, signal) {
  const valid = places.filter((p) => validCoords(p.lat, p.lon));
  if (!valid.length) return {};
  const data = await getJson(FORECAST_URL, {
    latitude: valid.map((p) => p.lat.toFixed(4)).join(","),
    longitude: valid.map((p) => p.lon.toFixed(4)).join(","),
    current: "temperature_2m,weather_code,is_day",
    daily: "temperature_2m_max,temperature_2m_min",
    forecast_days: 1,
    timezone: "auto",
  }, signal);
  const list = Array.isArray(data) ? data : [data];
  const out = {};
  valid.forEach((p, i) => {
    const r = list[i];
    if (!r?.current) return;
    out[p.id] = {
      temp: num(r.current.temperature_2m),
      code: num(r.current.weather_code) ?? 3,
      isDay: int01(r.current.is_day),
      max: num(r.daily?.temperature_2m_max?.[0]),
      min: num(r.daily?.temperature_2m_min?.[0]),
      utcOffset: num(r.utc_offset_seconds) ?? 0,
      at: Date.now(),
    };
  });
  return out;
}
