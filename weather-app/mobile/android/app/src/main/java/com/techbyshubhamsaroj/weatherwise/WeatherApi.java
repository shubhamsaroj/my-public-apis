package com.techbyshubhamsaroj.weatherwise;

import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Small HTTPS client for Open-Meteo, used by the background alert engine. */
final class WeatherApi {

    static final String FORECAST = "https://api.open-meteo.com/v1/forecast";
    static final String AIR = "https://air-quality-api.open-meteo.com/v1/air-quality";
    private static final String UA = "Weatherwise/1.0 (Android app; com.techbyshubhamsaroj.weatherwise)";
    private static final int MAX_BYTES = 1024 * 1024;
    private static final ExecutorService NET = Executors.newCachedThreadPool((r) -> {
        Thread t = new Thread(r, "weather-net");
        t.setDaemon(true);
        return t;
    });

    /** A time limit for everything one wake-up does. Monotonic, so clock changes can't stretch it. */
    static final class Budget {
        private final long end = SystemClock.elapsedRealtime();
        private final long ms;

        Budget(long ms) {
            this.ms = ms;
        }

        long left() {
            return end + ms - SystemClock.elapsedRealtime();
        }
    }

    /** The server answered, but not with data: trying again right away won't help. */
    static final class HttpError extends IOException {
        HttpError(int code) {
            super("HTTP " + code);
        }
    }

    /** Compact forecast for one place: what alerts need and nothing more. */
    static final class Mini {
        long at;
        String tz = "";
        double temp = Double.NaN;
        double feels = Double.NaN;
        long[] t = {};
        double[] temps = {};
        double[] feelsLike = {};
        int[] code = {};
        int[] cloud = {};
        int[] pop = {};

        double[] series(boolean useFeels) {
            return useFeels ? feelsLike : temps;
        }

        int hourIndex(long when) {
            for (int i = 0; i < t.length; i++) if (when >= t[i] && when < t[i] + 3600_000L) return i;
            return -1;
        }

        static Mini parse(JSONObject r, long at) throws JSONException {
            Mini m = new Mini();
            m.at = at;
            m.tz = r.optString("timezone", "");
            JSONObject cur = r.optJSONObject("current");
            if (cur != null) {
                m.temp = cur.optDouble("temperature_2m", Double.NaN);
                m.feels = cur.optDouble("apparent_temperature", Double.NaN);
            }
            JSONObject h = r.getJSONObject("hourly");
            JSONArray time = h.getJSONArray("time");
            int n = Math.min(time.length(), 24 * 8);
            m.t = new long[n];
            for (int i = 0; i < n; i++) m.t[i] = time.getLong(i) * 1000L;
            m.temps = doubles(h.optJSONArray("temperature_2m"), n);
            m.feelsLike = doubles(h.optJSONArray("apparent_temperature"), n);
            m.code = ints(h.optJSONArray("weather_code"), n);
            m.cloud = ints(h.optJSONArray("cloud_cover"), n);
            m.pop = ints(h.optJSONArray("precipitation_probability"), n);
            return m;
        }
    }

    private WeatherApi() {}

    static boolean valid(double lat, double lon) {
        return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180; // false for NaN
    }

    /** One batched request for all places. */
    static Map<String, Mini> fetchMini(List<JSONObject> places, Budget budget) throws IOException, JSONException {
        Map<String, Mini> out = new HashMap<>();
        if (places.isEmpty()) return out;
        StringBuilder lat = new StringBuilder(), lon = new StringBuilder();
        for (JSONObject p : places) {
            if (lat.length() > 0) { lat.append(','); lon.append(','); }
            lat.append(String.format(Locale.ROOT, "%.4f", p.getDouble("lat")));
            lon.append(String.format(Locale.ROOT, "%.4f", p.getDouble("lon")));
        }
        String body = get(FORECAST + "?latitude=" + lat + "&longitude=" + lon
            + "&current=temperature_2m,apparent_temperature"
            + "&hourly=temperature_2m,apparent_temperature,weather_code,cloud_cover,precipitation_probability"
            + "&forecast_days=3&timezone=auto&timeformat=unixtime", budget);
        JSONArray results = body.trim().startsWith("[") ? new JSONArray(body) : new JSONArray().put(new JSONObject(body));
        long now = System.currentTimeMillis();
        for (int i = 0; i < places.size() && i < results.length(); i++) {
            out.put(places.get(i).getString("id"), Mini.parse(results.getJSONObject(i), now));
        }
        return out;
    }

    /**
     * GET within a hard time limit. Right after a deep-sleep wake-up the network can need a few seconds,
     * so quick failures are retried until time runs out. Runs on its own thread because Java can't
     * time-limit a DNS lookup, and a woken app that overstays gets killed by Android.
     */
    static String get(String url, Budget budget) throws IOException {
        IOException last = null;
        while (budget.left() > 700) {
            final int left = (int) budget.left();
            Future<String> f = NET.submit(() -> once(url, left));
            try {
                return f.get(left, TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                f.cancel(true);
                break;
            } catch (ExecutionException e) {
                Throwable why = e.getCause();
                if (why instanceof HttpError) throw (HttpError) why;
                last = why instanceof IOException ? (IOException) why : new IOException(String.valueOf(why));
                SystemClock.sleep(Math.min(700, Math.max(0, budget.left())));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        throw last != null ? last : new IOException("timed out");
    }

    private static String once(String url, int timeoutMs) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(Math.max(1500, timeoutMs / 2));
        c.setReadTimeout(Math.max(1500, timeoutMs));
        c.setInstanceFollowRedirects(false);
        c.setUseCaches(false);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept", "application/json");
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new HttpError(code);
            try (InputStream in = c.getInputStream(); ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
                byte[] b = new byte[8192];
                int n;
                while ((n = in.read(b)) != -1) {
                    buf.write(b, 0, n);
                    if (buf.size() > MAX_BYTES) throw new IOException("response too large");
                }
                return buf.toString("UTF-8");
            }
        } finally {
            c.disconnect();
        }
    }

    private static double[] doubles(JSONArray a, int n) {
        double[] out = new double[n];
        for (int i = 0; i < n; i++) out[i] = a == null ? Double.NaN : a.optDouble(i, Double.NaN);
        return out;
    }

    private static int[] ints(JSONArray a, int n) {
        int[] out = new int[n];
        for (int i = 0; i < n; i++) out[i] = a == null ? 0 : a.optInt(i, 0);
        return out;
    }
}
