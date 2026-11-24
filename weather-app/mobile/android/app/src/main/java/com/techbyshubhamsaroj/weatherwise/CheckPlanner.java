package com.techbyshubhamsaroj.weatherwise;

/**
 * Decides when to look at the temperature next. Pure, unit-tested (including a simulated month).
 *
 * Far from the limit we check rarely (up to every 3 hours); as the temperature, or the
 * forecast, gets close we check every 15-30 minutes. Open-Meteo's "current" value only
 * changes every 15 minutes, so checking more often would just waste battery.
 */
final class CheckPlanner {

    static final long MIN = 60_000L;
    static final long FAST = 15 * MIN;
    static final long MEDIUM = 30 * MIN;
    static final long MAX = 180 * MIN;
    static final double CLOSE_C = 0.7;
    static final double NEAR_C = 1.5;
    static final double FASTEST_CHANGE_C_PER_H = 3.0;

    private CheckPlanner() {}

    /**
     * @param value    latest temperature (NaN if unknown)
     * @param times    forecast times, epoch ms, ascending (may be empty)
     * @param forecast forecast temperatures at those times
     */
    static long next(long now, String op, double threshold, boolean armed, double value, long[] times, double[] forecast) {
        if (Double.isNaN(value)) return now + MEDIUM;
        boolean below = "below".equals(op);
        // How far we still are from what we're waiting for: the limit, or (after an alert) 1 degree back past it.
        double target = armed ? threshold : (below ? threshold + AlertLogic.HYSTERESIS_C : threshold - AlertLogic.HYSTERESIS_C);
        boolean waitingForDrop = below == armed;
        double distance = waitingForDrop ? value - target : target - value;
        long crossing = firstCrossing(now, target, waitingForDrop, 0, times, forecast);

        if (distance <= CLOSE_C) return now + (armed ? FAST : MEDIUM);
        if (distance <= NEAR_C) return now + (armed && crossing > 0 && crossing - now <= 60 * MIN ? FAST : MEDIUM);

        long gap = Math.min(MAX, (long) (distance / FASTEST_CHANGE_C_PER_H * 60 * MIN));
        long near = firstCrossing(now, target, waitingForDrop, NEAR_C, times, forecast);
        if (near > 0) gap = Math.min(gap, near - now - 10 * MIN);
        return now + Math.max(armed ? FAST : MEDIUM, gap);
    }

    /** First forecast time (interpolated) at which the temperature is within {@code margin} of the target, or 0. */
    static long firstCrossing(long now, double target, boolean dropping, double margin, long[] t, double[] v) {
        double limit = dropping ? target + margin : target - margin;
        for (int i = 0; i + 1 < t.length; i++) {
            if (t[i + 1] < now || Double.isNaN(v[i]) || Double.isNaN(v[i + 1])) continue;
            boolean a = dropping ? v[i] <= limit : v[i] >= limit;
            boolean b = dropping ? v[i + 1] <= limit : v[i + 1] >= limit;
            if (a && t[i] >= now) return t[i];
            if (a && b) return Math.max(now, t[i]);
            if (!a && b) {
                long at = t[i] + (long) ((limit - v[i]) / (v[i + 1] - v[i]) * (t[i + 1] - t[i]));
                if (at >= now) return at;
            }
        }
        return 0;
    }

    /** Forecast temperature at a moment (interpolated), or NaN. */
    static double at(long when, long[] t, double[] v) {
        for (int i = 0; i + 1 < t.length; i++) {
            if (when >= t[i] && when <= t[i + 1]) {
                double f = (double) (when - t[i]) / Math.max(1, t[i + 1] - t[i]);
                return v[i] + (v[i + 1] - v[i]) * f;
            }
        }
        return Double.NaN;
    }
}
