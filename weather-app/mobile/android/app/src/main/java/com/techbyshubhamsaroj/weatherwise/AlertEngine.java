package com.techbyshubhamsaroj.weatherwise;

import android.annotation.SuppressLint;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;

import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The alert engine. Exactly one alarm is ever pending: the next moment something is due
 * (a sunrise/sunset alert, a temperature check, or a delivery test). When it rings — also in
 * deep sleep and with the app closed — we do what is due and set the next one.
 *
 * Rules, places and settings are the ones the app saved (Capacitor Preferences, "CapacitorStorage").
 */
final class AlertEngine {

    static final String ACTION_WAKE = "com.techbyshubhamsaroj.weatherwise.WAKE";
    private static final String STORE = "CapacitorStorage";
    private static final String STATE = "weatherwise_alert_state";
    private static final long MIN = 60_000L;
    private static final long ALARM_MS = 7500;  // Android gives a woken app about 10 s, then kills it
    private static final long APP_MS = 12_000;  // app open, or its hourly job
    private static final ReentrantLock LOCK = new ReentrantLock(); // one run at a time
    private static final int COLOR_SUN = 0xFFFFB021, COLOR_COLD = 0xFF6EC1FF, COLOR_HOT = 0xFFFF8A3D;

    private AlertEngine() {}

    // ------------------------------------------------------------------ entry points

    /** The alarm rang. */
    static void onAlarm(Context c) {
        WeatherApi.Budget budget = new WeatherApi.Budget(ALARM_MS);
        long now = System.currentTimeMillis();
        SharedPreferences st = state(c);
        long planned = st.getLong("wake.at", now);
        String why = st.getString("wake.why", "");
        // If anything below is cut short, try again soon: the chain must never break.
        setAlarm(c, now + 15 * MIN, why);
        boolean mine = false;
        try {
            mine = LOCK.tryLock(1500, TimeUnit.MILLISECONDS);
            if (!mine) { setAlarm(c, now + MIN, why); return; } // the app is checking right now
            boolean idle = PhoneSettings.idle(c);
            String note = process(c, now, budget, false, Double.NaN, false);
            log(c, planned, now, why, note, idle);
            schedule(c);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            if (mine) LOCK.unlock();
        }
    }

    /** Phone restarted, app updated, clock changed. Never waits long: a run in progress re-plans when it ends. */
    static void syncFromReceiver(Context c, boolean noteIfOverdue) {
        boolean mine = false;
        try {
            mine = LOCK.tryLock(2, TimeUnit.SECONDS);
            if (mine) sync(c, noteIfOverdue);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            if (mine) LOCK.unlock();
        }
    }

    /** App opened, settings or alerts changed. No network. */
    static void sync(Context c, boolean noteIfOverdue) {
        LOCK.lock();
        try {
            long now = System.currentTimeMillis();
            if (noteIfOverdue) noteHeldBack(c, now);
            process(c, now, null, false, Double.NaN, false);
            dropRemovedPlaces(c);
            schedule(c);
        } finally {
            LOCK.unlock();
        }
    }

    /** Check temperatures now (network allowed). */
    static void check(Context c, boolean force, double debugTemp, boolean ignoreCooldown) {
        LOCK.lock();
        try {
            process(c, System.currentTimeMillis(), new WeatherApi.Budget(APP_MS), force, debugTemp, ignoreCooldown);
            schedule(c);
        } finally {
            LOCK.unlock();
        }
    }

    /**
     * The alarm is overdue although exact alarms are allowed and the phone has been on for a while: this phone
     * stops apps in the background. No setting tells us that, so remember the evidence. Checked when the app is
     * opened, and on "boot completed", which Android 15+ also sends to a force-stopped app just before it opens.
     */
    private static void noteHeldBack(Context c, long now) {
        SharedPreferences st = state(c);
        long planned = st.getLong("wake.at", 0), started = now - SystemClock.elapsedRealtime();
        if (planned == 0 || now - planned < 2 * MIN || planned < started + 10 * MIN || !PhoneSettings.exactAllowed(c)) return;
        st.edit().putLong("held.at", now).apply();
        log(c, planned, now, st.getString("wake.why", ""), "Held back by the phone", false);
    }

    static void forgetHeldBack(Context c) {
        state(c).edit().remove("held.at").apply();
    }

    static void startTest(Context c, int seconds) {
        LOCK.lock();
        try {
            state(c).edit().putLong("test.at", System.currentTimeMillis() + seconds * 1000L).remove("test.result").apply();
            schedule(c);
        } finally {
            LOCK.unlock();
        }
    }

    // ------------------------------------------------------------------ doing what is due

    /** @param net time left for network use, or null for none */
    private static String process(Context c, long now, WeatherApi.Budget net, boolean forceTemps, double debugTemp, boolean ignoreCooldown) {
        List<String> notes = new ArrayList<>();
        try { runTest(c, now, net, notes); } catch (Exception e) { notes.add("test failed"); }
        try { runSun(c, now, net, notes); } catch (Exception e) { notes.add("sun failed"); }
        if (net != null) {
            try {
                runTemps(c, now, net, forceTemps, debugTemp, ignoreCooldown, notes);
            } catch (Exception e) {
                notes.add("temperature failed");
                SharedPreferences.Editor ed = state(c).edit().putLong("temp.next", now + 30 * MIN);
                for (JSONObject r : activeRules(c)) ed.putLong(r.optString("id") + ".tried", now); // never retry in a tight loop
                ed.apply();
            }
        }
        return String.join(" · ", notes);
    }

    private static WeatherApi.Budget part(WeatherApi.Budget b, long ms) {
        return new WeatherApi.Budget(Math.min(ms, b.left()));
    }

    private static void runTest(Context c, long now, WeatherApi.Budget net, List<String> notes) throws Exception {
        SharedPreferences st = state(c);
        long at = st.getLong("test.at", 0);
        if (at == 0 || now < at - 1000) return;
        long late = Math.max(0, (now - at) / 1000);
        boolean idle = PhoneSettings.idle(c);
        boolean online = false;
        if (net != null) {
            try { WeatherApi.get(WeatherApi.FORECAST + "?latitude=18.5&longitude=73.9&current=temperature_2m", part(net, 5000)); online = true; } catch (IOException e) { /* reported below */ }
        }
        String lateText = late < 60 ? late + " s" : (late / 60) + " min";
        st.edit().remove("test.at").putString("test.result", new JSONObject().put("at", now).put("late", late).put("idle", idle).put("net", online).toString()).apply();
        Notifier.post(c, 7_900_000, Notifier.TEMP, R.drawable.ic_stat_thermo, COLOR_COLD,
            late <= 15 ? "✅ Alerts work on this phone" : "⚠️ Alerts are delayed on this phone",
            "Test alert arrived " + (late <= 15 ? "on time" : lateText + " late") + (idle ? " while the phone was asleep." : ".")
                + (online ? "" : " It couldn't reach the internet, though."), "");
        notes.add("test, " + lateText + " late" + (online ? "" : ", no network"));
    }

    private static final class SunCfg {
        boolean rise, set;
        int lead;
        JSONObject place;
        String pref;
    }

    private static SunCfg sunCfg(Context c) {
        JSONObject s = readObject(c, "v2.settings");
        SunCfg k = new SunCfg();
        k.rise = s.optBoolean("notifySunrise", false);
        k.set = s.optBoolean("notifySunset", false);
        k.lead = "0".equals(s.optString("notifyLead")) ? 0 : "30".equals(s.optString("notifyLead")) ? 30 : 15;
        k.pref = s.optString("time", "auto");
        if (!k.rise && !k.set) return null;
        k.place = alertPlace(c, s.optString("notifyPlaceId", ""));
        return k.place == null ? null : k;
    }

    private static void runSun(Context c, long now, WeatherApi.Budget net, List<String> notes) {
        SunCfg k = sunCfg(c);
        SharedPreferences st = state(c);
        if (k == null) { st.edit().remove("sun.sig").apply(); return; }
        double lat = k.place.optDouble("lat"), lon = k.place.optDouble("lon");
        // Settings changed (or first run): start from now instead of replaying earlier alerts.
        String sig = k.rise + "," + k.set + "," + k.lead + "," + Math.round(lat * 10) + "," + Math.round(lon * 10);
        if (!sig.equals(st.getString("sun.sig", ""))) st.edit().putString("sun.sig", sig).putLong("sun.mark", now).apply();
        long mark = st.getLong("sun.mark", now);
        if (mark > now + 10 * MIN) mark = now; // the phone's clock was moved back
        List<SunPlan.Event> due = SunPlan.due(mark, now, lat, lon, k.rise, k.set, k.lead);
        st.edit().putLong("sun.mark", Math.max(mark, now)).apply();
        if (due.isEmpty()) return;

        String placeId = k.place.optString("id");
        WeatherApi.Mini mini = loadMini(c, placeId);
        if (net != null && (mini == null || Math.abs(now - mini.at) > 180 * MIN)) {
            try {
                List<JSONObject> one = new ArrayList<>();
                one.add(k.place);
                WeatherApi.Mini got = WeatherApi.fetchMini(one, part(net, 3000)).get(placeId);
                if (got != null) { mini = got; saveMini(c, placeId, got); }
            } catch (Exception e) { /* the sky hint is optional */ }
        }
        SunPlan.Event e = due.get(due.size() - 1);
        boolean shown = postSun(c, k, e, mini, now, 7_000_000 + (e.sunrise ? 0 : 1));
        notes.add((e.sunrise ? "sunrise" : "sunset") + (shown ? "" : " (notifications blocked)"));
    }

    private static boolean postSun(Context c, SunCfg k, SunPlan.Event e, WeatherApi.Mini mini, long now, int id) {
        String tz = k.place.optString("tz", "");
        if (tz.isEmpty() && mini != null) tz = mini.tz;
        long mins = Math.round((e.at - now) / (double) MIN);
        String label = e.sunrise ? "🌅 Sunrise" : "🌇 Sunset";
        String clock = Notifier.clock(c, e.at, tz, k.pref);
        String title = mins >= 2 ? label + " in " + mins + " min · " + clock : label + " · " + clock;
        List<String> body = new ArrayList<>();
        body.add(k.place.optString("name", "Your place"));
        String hint = skyHint(mini, e);
        if (!hint.isEmpty()) body.add(hint);
        if (!e.sunrise && mins >= 10) body.add("Golden hour is on.");
        return Notifier.post(c, id, Notifier.SUN, R.drawable.ic_stat_sun, COLOR_SUN, title, String.join(" · ", body), k.place.optString("id"));
    }

    private static String skyHint(WeatherApi.Mini m, SunPlan.Event e) {
        if (m == null || e.at - m.at > 48 * 60 * MIN) return "";
        int i = m.hourIndex(e.at);
        if (i < 0) return "";
        int code = m.code[i];
        if (code >= 51 && m.pop[i] >= 40) {
            String noun = code >= 95 ? "Thunderstorms" : (code >= 71 && code <= 77) || code == 85 || code == 86 ? "Snow" : "Rain";
            return noun + " likely around " + (e.sunrise ? "sunrise" : "sunset") + ".";
        }
        if (m.cloud[i] >= 85) return "Overcast, so the sun may stay hidden.";
        if (m.cloud[i] >= 40) return "Some clouds about, which can make the colours better.";
        return "Clear skies: a good one to catch.";
    }

    static void previewSun(Context c) {
        SunCfg k = sunCfg(c);
        if (k == null) {
            k = new SunCfg();
            k.set = true;
            k.lead = 15;
            k.pref = readObject(c, "v2.settings").optString("time", "auto");
            k.place = alertPlace(c, "");
            if (k.place == null) return;
        }
        long now = System.currentTimeMillis();
        SunPlan.Event e = SunPlan.next(now, k.place.optDouble("lat"), k.place.optDouble("lon"), k.rise, k.set, k.lead);
        if (e != null) postSun(c, k, e, loadMini(c, k.place.optString("id")), e.fireAt, 7_000_009);
    }

    // ------------------------------------------------------------------ temperature

    private static void runTemps(Context c, long now, WeatherApi.Budget net, boolean force, double debugTemp, boolean ignoreCooldown, List<String> notes) throws Exception {
        SharedPreferences st = state(c);
        prune(st, readArray(c, "v2.alerts"));
        Map<String, JSONObject> used = new LinkedHashMap<>();
        for (JSONObject r : activeRules(c)) {
            JSONObject p = places(c).get(r.optString("placeId"));
            used.put(p.optString("id"), p);
        }
        if (used.isEmpty()) { st.edit().remove("temp.next").apply(); return; }
        if (!force && !hasUnchecked(c) && now < st.getLong("temp.next", 0) - 30_000L) return;
        if (!Notifier.allowed(c, Notifier.TEMP)) return; // nothing could be shown: don't spend battery or data

        boolean debug = !Double.isNaN(debugTemp);
        Map<String, WeatherApi.Mini> minis = new HashMap<>();
        boolean live = debug;
        if (!debug) {
            SunCfg k = sunCfg(c);
            if (k != null) used.put(k.place.optString("id"), k.place); // also refreshes the sky hint
            try {
                minis = WeatherApi.fetchMini(new ArrayList<>(used.values()), net);
                for (Map.Entry<String, WeatherApi.Mini> e : minis.entrySet()) saveMini(c, e.getKey(), e.getValue());
                live = true;
            } catch (Exception e) {
                for (String id : used.keySet()) {
                    WeatherApi.Mini m = loadMini(c, id);
                    if (m != null && now - m.at <= 12 * 60 * MIN) minis.put(id, m);
                }
            }
        }

        JSONObject settings = readObject(c, "v2.settings");
        boolean fahrenheit = "f".equals(settings.optString("temp", "c"));
        String pref = settings.optString("time", "auto");
        Map<String, JSONObject> places = places(c);
        SharedPreferences.Editor ed = st.edit();
        Set<String> finished = new HashSet<>();
        long next = now + CheckPlanner.MAX;
        String reading = "";
        // Rules are read again here: they may have been edited in the app during the request.
        for (JSONObject r : activeRules(c)) {
            String id = r.optString("id"), op = r.optString("op");
            boolean feels = "feels".equals(r.optString("metric")), below = "below".equals(op);
            double limit = AlertLogic.limit(op, r.optDouble("value"), fahrenheit);
            JSONObject place = places.get(r.optString("placeId"));
            WeatherApi.Mini m = minis.get(place.optString("id"));
            double value = debug ? debugTemp : m == null ? Double.NaN
                : live ? (feels ? m.feels : m.temp) : CheckPlanner.at(now, m.t, m.series(feels));
            // Offline: use the forecast, but only when it is clearly past the limit.
            double judged = live || Double.isNaN(value) ? value : below ? value + 0.3 : value - 0.3;
            if (Double.isNaN(judged)) {
                ed.putLong(id + ".tried", now);
                next = Math.min(next, now + CheckPlanner.MEDIUM);
                continue;
            }
            long last = st.getLong(id + ".last", 0L);
            if (last > now) last = 0L; // the phone's clock was moved back
            Boolean armed = st.contains(id + ".armed") ? (Boolean) st.getBoolean(id + ".armed", true) : null;
            AlertLogic.Result res = AlertLogic.evaluate(op, limit, r.optString("repeat"), armed, r.optDouble("base", Double.NaN),
                last, judged, now, ignoreCooldown ? 0L : AlertLogic.COOLDOWN_MS);
            ed.putBoolean(id + ".armed", res.armed).putFloat(id + ".value", (float) value).putLong(id + ".checked", now);
            if (res.fire) {
                postTemp(c, r, place, value, m, feels, fahrenheit, pref, live, now);
                ed.putLong(id + ".last", now);
            }
            if (res.disable) finished.add(id);
            reading = Notifier.degrees(value, fahrenheit) + (live ? "" : " (forecast)") + (res.fire ? ", alert sent" : "");
            if (!res.disable) {
                next = Math.min(next, CheckPlanner.next(now, op, limit, res.armed, value,
                    m == null ? new long[0] : m.t, m == null ? new double[0] : m.series(feels)));
            }
        }
        int fails = live ? 0 : st.getInt("net.fail", 0) + 1;
        if (!live) next = Math.min(next, now + (fails <= 3 ? 10 * MIN : 30 * MIN));
        ed.putInt("net.fail", fails).putLong("temp.next", next).apply();
        if (!finished.isEmpty()) switchOff(c, finished);
        notes.add("temperature " + (reading.isEmpty() ? "no data" : reading));
    }

    /** One-time alerts that have fired. Changes only those rules, in the list as it is now. */
    private static void switchOff(Context c, Set<String> ids) throws Exception {
        JSONArray rules = readArray(c, "v2.alerts");
        for (int i = 0; i < rules.length(); i++) {
            JSONObject r = rules.optJSONObject(i);
            if (r != null && ids.contains(r.optString("id"))) r.put("enabled", false);
        }
        prefs(c).edit().putString("v2.alerts", rules.toString()).apply();
    }

    private static void postTemp(Context c, JSONObject r, JSONObject place, double value, WeatherApi.Mini m, boolean feels,
                                 boolean f, String pref, boolean live, long now) {
        boolean below = "below".equals(r.optString("op"));
        String title = (below ? "🥶 " : "🔥 ") + Notifier.degrees(value, f) + (feels ? " feels-like" : "") + " in " + place.optString("name", "your place");
        StringBuilder b = new StringBuilder();
        b.append(feels ? "It feels like " : below ? "The temperature dropped to " : "The temperature rose to ").append(Notifier.degrees(value, f)).append('.');
        b.append(" Your alert: ").append(Notifier.degrees(r.optDouble("value"), f)).append(below ? " or below." : " or above.");
        if (m != null && live) {
            double[] v = m.series(feels);
            int best = -1;
            for (int i = 0; i < m.t.length; i++) {
                if (m.t[i] < now || m.t[i] > now + 12 * 60 * MIN || Double.isNaN(v[i])) continue;
                if (best < 0 || (below ? v[i] < v[best] : v[i] > v[best])) best = i;
            }
            if (best >= 0 && (below ? v[best] <= value - 1 : v[best] >= value + 1)) { // only if it goes further
                b.append(below ? " Expected low: " : " Expected high: ").append(Notifier.degrees(v[best], f))
                    .append(" around ").append(Notifier.clock(c, m.t[best], m.tz, pref)).append('.');
            }
        }
        if (!live) b.append(" Based on the forecast (no internet to confirm).");
        if ("once".equals(r.optString("repeat"))) b.append(" One-time alert, now off.");
        Notifier.post(c, 8_000_000 + (r.optString("id").hashCode() & 0xFFFF), Notifier.TEMP, R.drawable.ic_stat_thermo,
            below ? COLOR_COLD : COLOR_HOT, title, b.toString(), place.optString("id"));
    }

    // ------------------------------------------------------------------ the one alarm

    private static void schedule(Context c) {
        long now = System.currentTimeMillis(), at = Long.MAX_VALUE;
        String why = "";
        SharedPreferences st = state(c);
        SunCfg k = sunCfg(c);
        if (k != null && Notifier.allowed(c, Notifier.SUN)) {
            long mark = st.getLong("sun.mark", now);
            SunPlan.Event e = SunPlan.next(mark > now + 10 * MIN ? now : Math.max(mark, now - SunPlan.GRACE_MS), k.place.optDouble("lat"), k.place.optDouble("lon"), k.rise, k.set, k.lead);
            if (e != null) { at = e.fireAt; why = e.sunrise ? "sunrise" : "sunset"; }
        }
        if (!activeRules(c).isEmpty() && Notifier.allowed(c, Notifier.TEMP)) {
            long t = st.getLong("temp.next", 0);
            if (t <= now || t > now + CheckPlanner.MAX + MIN || hasUnchecked(c)) t = now + 5000;
            if (t < at) { at = t; why = "temperature"; }
        }
        long test = st.getLong("test.at", 0);
        if (test > now + 15 * MIN) { st.edit().remove("test.at").apply(); test = 0; }
        if (test > 0 && test < at) { at = test; why = "test"; }
        if (at == Long.MAX_VALUE) {
            c.getSystemService(AlarmManager.class).cancel(wakeIntent(c));
            st.edit().remove("wake.at").remove("wake.why").apply();
            return;
        }
        setAlarm(c, Math.max(at, now + 1000), why);
    }

    private static void setAlarm(Context c, long at, String why) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        state(c).edit().putLong("wake.at", at).putString("wake.why", why).apply();
        try {
            if (PhoneSettings.exactAllowed(c)) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, wakeIntent(c));
                return;
            }
        } catch (SecurityException e) { /* permission withdrawn in between: fall through */ }
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, wakeIntent(c));
    }

    private static PendingIntent wakeIntent(Context c) {
        Intent i = new Intent(c, AlertReceiver.class).setAction(ACTION_WAKE).addFlags(Intent.FLAG_RECEIVER_FOREGROUND);
        return PendingIntent.getBroadcast(c, 1, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Remove what earlier versions scheduled (29 vague alarms and a background job). Runs once. */
    @SuppressLint("UnspecifiedImmutableFlag")
    static void cleanUpOldVersions(Context c) {
        SharedPreferences st = state(c);
        if (st.getInt("engine", 0) >= 2) return;
        // Android only finds the old alarms by the same flags the old plugin created them with.
        int flags = PendingIntent.FLAG_NO_CREATE | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        AlarmManager am = c.getSystemService(AlarmManager.class);
        ComponentName old = new ComponentName(c.getPackageName(), "com.capacitorjs.plugins.localnotifications.TimedNotificationPublisher");
        for (int id = 6_999_999; id <= 7_000_100; id++) {
            PendingIntent pi = PendingIntent.getBroadcast(c, id, new Intent().setComponent(old), flags);
            if (pi != null) { am.cancel(pi); pi.cancel(); }
        }
        try { WorkManager.getInstance(c).cancelUniqueWork("temp-alerts"); } catch (RuntimeException e) { /* nothing to cancel */ }
        st.edit().putInt("engine", 2).apply();
    }

    // ------------------------------------------------------------------ background forecast for the app's screens

    /** Fetch full forecasts for the places on screen, so the app opens with fresh data. */
    static void refreshForecasts(Context c) {
        long now = System.currentTimeMillis();
        if (now - state(c).getLong("app.opened", 0) > 3 * 24 * 60 * MIN) return; // not opened lately: save battery and data (alerts don't need this)
        JSONObject q = readObject(c, "v2.fetch");
        String fq = q.optString("forecast"), aq = q.optString("air");
        if (!safeQuery(fq)) return;
        Set<String> want = new HashSet<>();
        want.add(prefs(c).getString("v2.active", "").replace("\"", ""));
        want.add("current");
        JSONObject ap = alertPlace(c, readObject(c, "v2.settings").optString("notifyPlaceId", ""));
        if (ap != null) want.add(ap.optString("id"));
        Map<String, JSONObject> places = places(c);
        for (String id : want) {
            JSONObject p = places.get(id);
            if (p == null) continue;
            File f = file(c, "wx-" + safe(id));
            if (f.exists() && now - f.lastModified() < 40 * MIN) continue;
            String where = String.format(java.util.Locale.ROOT, "?latitude=%.4f&longitude=%.4f&", p.optDouble("lat"), p.optDouble("lon"));
            try {
                String wx = WeatherApi.get(WeatherApi.FORECAST + where + fq, new WeatherApi.Budget(20_000));
                if (!wx.trim().startsWith("{") || !wx.contains("\"hourly\"")) continue;
                String air = "null";
                if (safeQuery(aq)) {
                    try { air = WeatherApi.get(WeatherApi.AIR + where + aq, new WeatherApi.Budget(15_000)); } catch (IOException e) { air = "null"; }
                    if (!air.trim().startsWith("{")) air = "null";
                }
                saveRaw(c, "wx-" + safe(id), "{\"fetchedAt\":" + System.currentTimeMillis() + ",\"lat\":" + p.optDouble("lat") + ",\"lon\":" + p.optDouble("lon") + ",\"wx\":" + wx + ",\"aq\":" + air + "}");
            } catch (IOException e) { return; /* offline: next time */ }
        }
    }

    /** Background-fetched forecast for a place if newer than {@code since}, else "". */
    static String backgroundForecast(Context c, String id, long since) {
        File f = file(c, "wx-" + safe(id));
        return f.exists() && f.lastModified() > since + 1000 ? readFile(f) : "";
    }

    // ------------------------------------------------------------------ status

    static JSONObject status(Context c) throws Exception {
        SharedPreferences st = state(c);
        JSONObject alerts = new JSONObject();
        JSONArray rules = readArray(c, "v2.alerts");
        for (int i = 0; i < rules.length(); i++) {
            JSONObject r = rules.optJSONObject(i);
            String id = r == null ? "" : r.optString("id");
            if (!st.contains(id + ".checked")) continue;
            alerts.put(id, new JSONObject().put("armed", st.getBoolean(id + ".armed", true)).put("value", st.getFloat(id + ".value", 0f))
                .put("checked", st.getLong(id + ".checked", 0)).put("last", st.getLong(id + ".last", 0)));
        }
        JSONObject out = new JSONObject();
        out.put("alerts", alerts);
        out.put("notifications", Notifier.allowed(c));
        out.put("channelsBlocked", Notifier.channelBlocked(c, Notifier.SUN) || Notifier.channelBlocked(c, Notifier.TEMP));
        out.put("exact", PhoneSettings.exactAllowed(c));
        out.put("battery", PhoneSettings.battery(c));
        out.put("dataBlocked", PhoneSettings.backgroundDataBlocked(c));
        out.put("brand", PhoneSettings.brand());
        out.put("heldAt", st.getLong("held.at", 0));
        out.put("nextAt", st.getLong("wake.at", 0));
        out.put("nextWhy", st.getString("wake.why", ""));
        out.put("testAt", st.getLong("test.at", 0));
        String t = st.getString("test.result", null);
        if (t != null) out.put("test", new JSONObject(t));
        out.put("log", new JSONArray(st.getString("log", "[]")));
        return out;
    }

    private static void log(Context c, long planned, long actual, String why, String note, boolean idle) {
        try {
            SharedPreferences st = state(c);
            JSONArray old = new JSONArray(st.getString("log", "[]"));
            JSONArray out = new JSONArray();
            out.put(new JSONObject().put("planned", planned).put("at", actual).put("why", why).put("note", note).put("idle", idle));
            for (int i = 0; i < old.length() && i < 11; i++) out.put(old.get(i));
            st.edit().putString("log", out.toString()).apply();
        } catch (Exception e) { /* diagnostics only */ }
    }

    // ------------------------------------------------------------------ storage helpers

    static void opened(Context c) {
        state(c).edit().putLong("app.opened", System.currentTimeMillis()).apply();
    }

    /** Alerts that are on and whose place still exists. */
    private static List<JSONObject> activeRules(Context c) {
        List<JSONObject> out = new ArrayList<>();
        Map<String, JSONObject> places = places(c);
        JSONArray rules = readArray(c, "v2.alerts");
        for (int i = 0; i < rules.length(); i++) {
            JSONObject r = rules.optJSONObject(i);
            if (r != null && r.optBoolean("enabled", false) && places.containsKey(r.optString("placeId"))) out.add(r);
        }
        return out;
    }

    /** A new alert that hasn't had its first look at the temperature yet. */
    private static boolean hasUnchecked(Context c) {
        SharedPreferences st = state(c);
        for (JSONObject r : activeRules(c)) {
            if (!st.contains(r.optString("id") + ".armed") && !st.contains(r.optString("id") + ".tried")) return true;
        }
        return false;
    }

    /** Saved forecasts of places that were removed in the app are deleted. */
    private static void dropRemovedPlaces(Context c) {
        File[] files = new File(c.getFilesDir(), "weather").listFiles();
        if (files == null) return;
        Set<String> keep = new HashSet<>();
        for (String id : places(c).keySet()) {
            keep.add("wx-" + safe(id) + ".json");
            keep.add("mini-" + safe(id) + ".json");
        }
        for (File f : files) if (!keep.contains(f.getName())) f.delete();
    }

    private static Map<String, JSONObject> places(Context c) {
        Map<String, JSONObject> out = new LinkedHashMap<>();
        JSONArray a = readArray(c, "v2.places");
        for (int i = 0; i < a.length(); i++) {
            JSONObject p = a.optJSONObject(i);
            if (p != null && WeatherApi.valid(p.optDouble("lat", Double.NaN), p.optDouble("lon", Double.NaN))) out.put(p.optString("id"), p);
        }
        return out;
    }

    /** Place that sun alerts follow: the chosen one, else My location, else the one on screen, else the first. */
    private static JSONObject alertPlace(Context c, String chosen) {
        Map<String, JSONObject> places = places(c);
        if (places.containsKey(chosen)) return places.get(chosen);
        if (places.containsKey("current")) return places.get("current");
        String active = prefs(c).getString("v2.active", "").replace("\"", "");
        if (places.containsKey(active)) return places.get(active);
        return places.isEmpty() ? null : places.values().iterator().next();
    }

    private static void prune(SharedPreferences st, JSONArray rules) {
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < rules.length(); i++) if (rules.optJSONObject(i) != null) ids.add(rules.optJSONObject(i).optString("id"));
        SharedPreferences.Editor ed = st.edit();
        for (String key : st.getAll().keySet()) {
            for (String suffix : new String[] { ".armed", ".value", ".checked", ".last", ".tried" }) {
                if (key.endsWith(suffix) && !ids.contains(key.substring(0, key.length() - suffix.length()))) ed.remove(key);
            }
        }
        ed.apply();
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(STORE, Context.MODE_PRIVATE);
    }

    private static SharedPreferences state(Context c) {
        return c.getSharedPreferences(STATE, Context.MODE_PRIVATE);
    }

    private static JSONArray readArray(Context c, String key) {
        try { return new JSONArray(prefs(c).getString(key, "[]")); } catch (Exception e) { return new JSONArray(); }
    }

    private static JSONObject readObject(Context c, String key) {
        try { return new JSONObject(prefs(c).getString(key, "{}")); } catch (Exception e) { return new JSONObject(); }
    }

    private static boolean safeQuery(String q) {
        return q.length() > 10 && q.length() < 2500 && q.matches("[a-z0-9_,=&]+");
    }

    private static String safe(String id) {
        return id.replaceAll("[^A-Za-z0-9_-]", "_");
    }

    private static File file(Context c, String name) {
        File dir = new File(c.getFilesDir(), "weather");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, name + ".json");
    }

    private static void saveRaw(Context c, String name, String text) {
        if (text == null) return;
        File f = file(c, name), tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) {
            o.write(text.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            return;
        }
        tmp.renameTo(f);
    }

    private static String readFile(File f) {
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int off = 0, n;
            while (off < b.length && (n = in.read(b, off, b.length - off)) > 0) off += n;
            return new String(b, 0, off, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    private static void saveMini(Context c, String id, WeatherApi.Mini m) {
        try {
            JSONObject h = new JSONObject();
            JSONArray t = new JSONArray(), v = new JSONArray(), a = new JSONArray(), code = new JSONArray(), cloud = new JSONArray(), pop = new JSONArray();
            for (int i = 0; i < m.t.length; i++) {
                t.put(m.t[i] / 1000);
                v.put(Double.isNaN(m.temps[i]) ? JSONObject.NULL : (Object) m.temps[i]);
                a.put(Double.isNaN(m.feelsLike[i]) ? JSONObject.NULL : (Object) m.feelsLike[i]);
                code.put(m.code[i]);
                cloud.put(m.cloud[i]);
                pop.put(m.pop[i]);
            }
            h.put("time", t).put("temperature_2m", v).put("apparent_temperature", a).put("weather_code", code).put("cloud_cover", cloud).put("precipitation_probability", pop);
            saveRaw(c, "mini-" + safe(id), new JSONObject().put("at", m.at).put("timezone", m.tz).put("hourly", h).toString());
        } catch (Exception e) { /* cache only */ }
    }

    private static WeatherApi.Mini loadMini(Context c, String id) {
        File f = file(c, "mini-" + safe(id));
        if (!f.exists()) return null;
        try {
            JSONObject o = new JSONObject(readFile(f));
            return WeatherApi.Mini.parse(o, o.getLong("at"));
        } catch (Exception e) {
            return null;
        }
    }
}
