package com.techbyshubhamsaroj.weatherwise;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.List;
import org.junit.Test;

public class SunTest {
    static final long MIN = 60_000L, H = 60 * MIN, DAY = 24 * H;
    static final double LAT = 18.97, LON = 72.83; // Mumbai
    static final long IST = 5 * H + 30 * MIN;

    // Real Open-Meteo values for London: { date (00:00 UTC), sunrise, sunset } in epoch seconds.
    static final long[][] LONDON = {
        { 1795046400L, 1795073100L, 1795104360L },
        { 1795132800L, 1795159560L, 1795190640L },
        { 1795219200L, 1795246080L, 1795276980L },
        { 1795305600L, 1795332600L, 1795363320L },
        { 1795392000L, 1795419060L, 1795449660L },
        { 1795478400L, 1795505580L, 1795536000L },
        { 1795564800L, 1795592040L, 1795622340L },
        { 1795651200L, 1795678560L, 1795708680L },
        { 1795737600L, 1795765020L, 1795795080L },
        { 1795824000L, 1795851540L, 1795881420L },
        { 1795910400L, 1795938000L, 1795967760L }
    };

    @Test public void matchesTheForecastServiceWithinThreeMinutes() {
        for (long[] r : LONDON) {
            long[] t = SunMath.times(r[0] * 1000, 51.51147, -0.13078308);
            assertTrue(Math.abs(t[0] - r[1] * 1000) < 3 * MIN);
            assertTrue(Math.abs(t[1] - r[2] * 1000) < 3 * MIN);
        }
    }

    @Test public void polarDayAndNightHaveNoSunriseOrSunset() {
        assertNull(SunMath.times(1797811200000L, 78.2, 15.6)); // 21 Dec 2026, Svalbard
        assertNull(SunMath.times(1782000000000L, 78.2, 15.6)); // 21 Jun 2026
    }

    @Test public void nextAlertIsAlwaysInTheFutureAndChainsThroughAYear() {
        long now = 1795500000000L;
        int n = 0;
        SunPlan.Event prev = null;
        while (now < 1795500000000L + 365 * DAY) {
            SunPlan.Event e = SunPlan.next(now, LAT, LON, true, true, 15);
            assertTrue(e.fireAt > now);
            assertEquals(15 * MIN, e.at - e.fireAt);
            if (prev != null) assertTrue("alternates sunrise/sunset", prev.sunrise != e.sunrise);
            prev = e;
            now = e.fireAt;
            n++;
        }
        assertTrue("two a day for a year: " + n, n >= 729 && n <= 732);
    }

    @Test public void worksOnBothSidesOfTheDateLine() {
        for (double lon : new double[] { -179, -120, 0, 120, 179 }) {
            SunPlan.Event e = SunPlan.next(1795500000000L, 10, lon, true, false, 0);
            assertTrue(e.fireAt - 1795500000000L <= DAY + 5 * MIN);
        }
    }

    @Test public void anOverdueAlertIsDeliveredOnceAndNotLost() {
        SunPlan.Event e = SunPlan.next(1795500000000L, LAT, LON, false, true, 15);
        long opened = e.fireAt + 4 * MIN; // phone woke up late, sunset is still 11 minutes away
        List<SunPlan.Event> due = SunPlan.due(e.fireAt - H, opened, LAT, LON, false, true, 15);
        assertEquals(1, due.size());
        assertEquals("not shown twice", 0, SunPlan.due(opened, opened + MIN, LAT, LON, false, true, 15).size());
    }

    @Test public void aStaleAlertIsDroppedRatherThanShownHoursLate() {
        SunPlan.Event e = SunPlan.next(1795500000000L, LAT, LON, false, true, 15);
        assertEquals(0, SunPlan.due(e.fireAt - H, e.at + 11 * MIN, LAT, LON, false, true, 15).size());
        assertEquals(1, SunPlan.due(e.fireAt - H, e.at + 9 * MIN, LAT, LON, false, true, 15).size());
    }

    @Test public void nothingWhenBothAreOff() {
        assertNull(SunPlan.next(0, LAT, LON, false, false, 0));
        assertEquals(0, SunPlan.due(0, DAY, LAT, LON, false, false, 0).size());
    }
}
