package com.techbyshubhamsaroj.weatherwise;

import java.util.ArrayList;
import java.util.List;

/** Which sunrise/sunset alerts are due now, and when the next one is. Pure, unit-tested. */
final class SunPlan {

    static final long MIN = 60_000L;
    /** An alert is still worth showing until this long after the sunrise/sunset itself. */
    static final long GRACE_MS = 10 * MIN;

    static final class Event {
        final boolean sunrise;
        final long at;     // the sunrise or sunset itself
        final long fireAt; // when to notify (at - lead)

        Event(boolean sunrise, long at, long fireAt) {
            this.sunrise = sunrise;
            this.at = at;
            this.fireAt = fireAt;
        }
    }

    private SunPlan() {}

    private static List<Event> around(long now, int fromDay, int toDay, double lat, double lon, boolean rise, boolean set, int leadMin) {
        List<Event> out = new ArrayList<>();
        long today = Math.floorDiv(now, 86400000L) * 86400000L;
        for (int d = fromDay; d <= toDay; d++) {
            long[] t = SunMath.times(today + d * 86400000L, lat, lon);
            if (t == null) continue;
            if (rise) out.add(new Event(true, t[0], t[0] - leadMin * MIN));
            if (set) out.add(new Event(false, t[1], t[1] - leadMin * MIN));
        }
        out.sort((a, b) -> Long.compare(a.fireAt, b.fireAt));
        return out;
    }

    /** First alert strictly after {@code after}, or null (no sunrise/sunset within a year). */
    static Event next(long after, double lat, double lon, boolean rise, boolean set, int leadMin) {
        if (!rise && !set) return null;
        for (Event e : around(after, -1, 3, lat, lon, rise, set, leadMin)) if (e.fireAt > after) return e;
        for (Event e : around(after, 4, 370, lat, lon, rise, set, leadMin)) if (e.fireAt > after) return e; // polar regions
        return null;
    }

    /** Alerts whose time came after {@code mark} (the last one handled) and that are still worth showing. */
    static List<Event> due(long mark, long now, double lat, double lon, boolean rise, boolean set, int leadMin) {
        List<Event> out = new ArrayList<>();
        if (!rise && !set) return out;
        for (Event e : around(now, -1, 1, lat, lon, rise, set, leadMin)) {
            if (e.fireAt > mark && e.fireAt <= now && now <= e.at + GRACE_MS) out.add(e);
        }
        return out;
    }
}
