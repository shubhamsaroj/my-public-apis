package com.techbyshubhamsaroj.weatherwise;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;
import org.junit.Test;

public class CheckPlannerTest {
    static final long MIN = 60_000L, H = 60 * MIN;
    static final long[] NONE_T = {};
    static final double[] NONE_V = {};

    @Test public void farAwayMeansRareChecks() {
        assertEquals(180 * MIN, CheckPlanner.next(0, "below", 10, true, 30, NONE_T, NONE_V));
    }

    @Test public void closeMeansFrequentChecks() {
        assertEquals(15 * MIN, CheckPlanner.next(0, "below", 10, true, 10.5, NONE_T, NONE_V));
        assertEquals(15 * MIN, CheckPlanner.next(0, "above", 35, true, 34.5, NONE_T, NONE_V));
    }

    @Test public void neverSleepsPastTheEarliestPlausibleCrossing() {
        // 3 degrees away at up to 3 degrees per hour: look again within the hour, whatever the forecast says.
        assertTrue(CheckPlanner.next(0, "below", 10, true, 13, NONE_T, NONE_V) <= 60 * MIN);
    }

    @Test public void forecastPullsTheCheckEarlier() {
        long[] t = { 0, H, 2 * H, 3 * H };
        double[] v = { 20, 18, 12, 9 };
        long n = CheckPlanner.next(0, "below", 10, true, 20, t, v); // within 1.5 degrees at about 2 h 10
        assertTrue(n <= 2 * H);
    }

    @Test public void crossingIsInterpolated() {
        long[] t = { 0, H };
        double[] v = { 12, 8 };
        assertEquals(30 * MIN, CheckPlanner.firstCrossing(0, 10, true, 0, t, v));
        assertEquals(10.0, CheckPlanner.at(30 * MIN, t, v), 0.001);
        assertEquals(0, CheckPlanner.firstCrossing(0, 5, true, 0, t, v));
    }

    @Test public void newAlertUsesTheTemperatureShownWhenItWasCreated() {
        // Created at 23 degrees; the first successful check happens after it already dropped: still caught.
        assertTrue(AlertLogic.evaluate("below", 20, "always", null, 23, 0, 19.5, 100 * H, AlertLogic.COOLDOWN_MS).fire);
        // Created when it was already colder than the limit: no instant alert.
        assertTrue(!AlertLogic.evaluate("below", 20, "always", null, 18, 0, 18, 100 * H, AlertLogic.COOLDOWN_MS).fire);
    }

    /** A month of minute-by-minute weather with imperfect forecasts. */
    @Test public void simulatedMonths() {
        report("drops, reached most nights ", "below", 16);
        report("rises, reached most days   ", "above", 29);
        report("limit far away (never)     ", "below", 2);
    }

    private void report(String name, String op, double thr) {
        List<Long> late = new ArrayList<>();
        int checks = 0, crossings = 0, missed = 0, days = 0;
        for (int seed = 0; seed < 20; seed++) {
            Random r = new Random(seed);
            int n = 30 * 24 * 60;
            days += 30;
            double[] truth = new double[n];
            double slow = 0, fast = 0;
            for (int i = 0; i < n; i++) {
                slow = slow * 0.9997 + r.nextGaussian() * 0.06;
                fast = fast * 0.97 + r.nextGaussian() * 0.05;
                truth[i] = 22.5 - 7.5 * Math.cos(2 * Math.PI * ((i / 60.0 - 5) / 24)) + slow + fast;
            }
            boolean below = op.equals("below");
            Boolean armed = null;
            long last = -10000 * H;
            double err = 0;
            long next = 0;
            long openSince = -1; // minute the true temperature crossed while armed and out of cooldown
            for (int i = 0; i < n; i++) {
                boolean met = below ? truth[i] <= thr : truth[i] >= thr;
                boolean canFire = armed != null && armed && i * MIN - last >= AlertLogic.COOLDOWN_MS;
                if (canFire && met && openSince < 0) { openSince = i; crossings++; }
                if (!met && openSince >= 0) { if (i - openSince >= 30) missed++; else crossings--; openSince = -1; }
                if (i * MIN < next) continue;
                checks++;
                err = err * 0.8 + r.nextGaussian() * 0.9; // a new forecast error each time (sd about 1.5 degrees)
                double current = truth[(i / 15) * 15];      // "current" only updates every 15 minutes
                long[] t = new long[25];
                double[] v = new double[25];
                for (int k = 0; k < 25; k++) {
                    int at = Math.min(n - 1, (i / 60) * 60 + k * 60);
                    t[k] = ((i / 60) * 60L + k * 60L) * MIN;
                    v[k] = truth[at] + err * Math.min(1, k / 6.0);
                }
                AlertLogic.Result res = AlertLogic.evaluate(op, thr, "always", armed, armed == null ? truth[0] : Double.NaN, last, current, i * MIN, AlertLogic.COOLDOWN_MS);
                if (res.fire) {
                    last = i * MIN;
                    if (openSince >= 0) late.add((long) (i - openSince));
                    openSince = -1;
                }
                armed = res.armed;
                next = CheckPlanner.next(i * MIN, op, thr, armed, current, t, v);
                assertTrue("never more often than every 15 min", next - i * MIN >= 15 * MIN);
                assertTrue("never longer than 3 h", next - i * MIN <= 180 * MIN);
            }
        }
        Collections.sort(late);
        long med = late.isEmpty() ? 0 : late.get(late.size() / 2), p95 = late.isEmpty() ? 0 : late.get((int) (late.size() * 0.95));
        long max = late.isEmpty() ? 0 : late.get(late.size() - 1);
        double perDay = checks / (double) days;
        System.out.printf("SIM %s crossings %4d  missed %d  late: median %2d min, 95%% within %2d min, worst %2d min  checks/day %.1f%n", name, crossings, missed, med, p95, max, perDay);
        assertTrue(name + " missed " + missed, missed <= crossings * 0.01);
        assertTrue(name + " p95 " + p95, p95 <= 30);
        assertTrue(name + " checks/day " + perDay, perDay <= 45);
    }
}
