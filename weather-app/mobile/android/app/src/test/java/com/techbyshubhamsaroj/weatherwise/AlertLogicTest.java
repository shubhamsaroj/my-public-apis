package com.techbyshubhamsaroj.weatherwise;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AlertLogicTest {
    private static final long H = 3600_000L;

    @Test public void newAlertRecordsBaselineAndNeverFiresInstantly() {
        AlertLogic.Result r = AlertLogic.evaluate("below", 10, "always", null, Double.NaN, 0, 8, 100 * H, AlertLogic.COOLDOWN_MS);
        assertFalse("already below: no instant alert", r.fire);
        assertFalse("and not armed until it warms up", r.armed);
        r = AlertLogic.evaluate("below", 10, "always", null, Double.NaN, 0, 17, 100 * H, AlertLogic.COOLDOWN_MS);
        assertFalse(r.fire);
        assertTrue("17°C with a 10°C alert: armed", r.armed);
    }

    @Test public void firesWhenItDropsToTheThreshold() {
        AlertLogic.Result r = AlertLogic.evaluate("below", 10, "always", true, Double.NaN, 0, 10.0, 100 * H, AlertLogic.COOLDOWN_MS);
        assertTrue(r.fire);
        assertFalse(r.armed);
        assertFalse("'every time' alerts stay on", r.disable);
    }

    @Test public void onceAlertsSwitchOffAfterFiring() {
        AlertLogic.Result r = AlertLogic.evaluate("above", 35, "once", true, Double.NaN, 0, 36, 100 * H, AlertLogic.COOLDOWN_MS);
        assertTrue(r.fire);
        assertTrue(r.disable);
    }

    @Test public void hoveringAroundTheThresholdDoesNotSpam() {
        // Fired at 9.8°C; it wobbles to 10.4°C (not 1° back) and down again: no re-arm, no repeat.
        AlertLogic.Result r = AlertLogic.evaluate("below", 10, "always", false, Double.NaN, 100 * H, 10.4, 110 * H, AlertLogic.COOLDOWN_MS);
        assertFalse(r.armed);
        r = AlertLogic.evaluate("below", 10, "always", false, Double.NaN, 100 * H, 9.7, 111 * H, AlertLogic.COOLDOWN_MS);
        assertFalse(r.fire);
        // Warms past 11°C: re-armed; drops again later: fires again.
        r = AlertLogic.evaluate("below", 10, "always", false, Double.NaN, 100 * H, 11.2, 112 * H, AlertLogic.COOLDOWN_MS);
        assertTrue(r.armed);
        r = AlertLogic.evaluate("below", 10, "always", true, Double.NaN, 100 * H, 9.5, 120 * H, AlertLogic.COOLDOWN_MS);
        assertTrue(r.fire);
    }

    @Test public void cooldownLimitsRepeatsToEveryThreeHours() {
        AlertLogic.Result r = AlertLogic.evaluate("above", 30, "always", true, Double.NaN, 100 * H, 31, 101 * H, AlertLogic.COOLDOWN_MS);
        assertFalse("only 1 h since the last alert", r.fire);
        assertTrue("stays armed for later", r.armed);
        r = AlertLogic.evaluate("above", 30, "always", true, Double.NaN, 100 * H, 31, 104 * H, AlertLogic.COOLDOWN_MS);
        assertTrue(r.fire);
    }

    @Test public void risesAboveWorksSymmetrically() {
        AlertLogic.Result r = AlertLogic.evaluate("above", 30, "always", null, Double.NaN, 0, 25, 0, AlertLogic.COOLDOWN_MS);
        assertTrue(r.armed);
        r = AlertLogic.evaluate("above", 30, "always", true, Double.NaN, 0, 29.9, 10 * H, AlertLogic.COOLDOWN_MS);
        assertFalse(r.fire);
        r = AlertLogic.evaluate("above", 30, "always", true, Double.NaN, 0, 30, 10 * H, AlertLogic.COOLDOWN_MS);
        assertTrue(r.fire);
    }

    /** Fires exactly when the rounded temperature on screen reaches the alert's value. */
    @Test public void followsTheRoundedTemperatureOnScreen() {
        for (int tenths = -150; tenths < 450; tenths++) {
            double v = tenths / 10.0; // the weather service gives one decimal
            for (int limit = -10; limit <= 40; limit += 5) {
                assertEquals(Math.round(v) <= limit, v <= AlertLogic.limit("below", limit, false));
                assertEquals(Math.round(v) >= limit, v >= AlertLogic.limit("above", limit, false));
                double f = v * 9 / 5 + 32, limitC = (limit - 32) / 1.8; // the same in Fahrenheit: stored in Celsius, shown in °F
                if (Math.abs(f - Math.floor(f) - 0.5) < 0.01) continue; // exactly between two whole degrees
                assertEquals(Math.round(f) <= limit, v <= AlertLogic.limit("below", limitC, true));
                assertEquals(Math.round(f) >= limit, v >= AlertLogic.limit("above", limitC, true));
            }
        }
    }
}
