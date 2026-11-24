package com.techbyshubhamsaroj.weatherwise;

/**
 * Pure decision logic for temperature alerts (unit-tested in AlertLogicTest).
 *
 * An alert fires when the temperature crosses its threshold: it must be "armed"
 * (the temperature was on the other side), and after firing it re-arms only once
 * the temperature has moved back past the threshold by HYSTERESIS_C, so a value
 * hovering around 10°C can't trigger a stream of notifications.
 */
final class AlertLogic {

    static final double HYSTERESIS_C = 1.0;
    static final long COOLDOWN_MS = 3L * 60 * 60 * 1000;

    static final class Result {
        final boolean fire;
        final boolean armed;
        final boolean disable;

        Result(boolean fire, boolean armed, boolean disable) {
            this.fire = fire;
            this.armed = armed;
            this.disable = disable;
        }
    }

    private AlertLogic() {}

    /**
     * The exact temperature at which the app starts showing the alert's (rounded) value, so an alert at 23°
     * fires when the screen says 23°: "drops to 23" from just under 23.5, "rises to 23" from 22.5.
     */
    static double limit(String op, double threshold, boolean fahrenheit) {
        double half = fahrenheit ? 0.5 / 1.8 : 0.5;
        return "below".equals(op) ? threshold + half - 0.001 : threshold - half;
    }

    /**
     * @param op         "below" (drops to or below) or "above" (rises to or above)
     * @param threshold  °C
     * @param repeat     "once" or "always"
     * @param armed      null if this alert has never been checked
     * @param base       the temperature shown when the alert was created (NaN if unknown). It decides whether a
     *                   new alert starts armed, so a drop that happens before the first check is still caught.
     * @param lastFired  epoch ms of the last notification for this alert (0 if never)
     * @param value      current temperature in °C
     */
    static Result evaluate(String op, double threshold, String repeat, Boolean armed, double base, long lastFired, double value, long now, long cooldownMs) {
        boolean below = "below".equals(op);
        boolean met = below ? value <= threshold : value >= threshold;
        if (armed == null && !Double.isNaN(base)) armed = below ? base > threshold : base < threshold;
        boolean movedBack = below ? value >= threshold + HYSTERESIS_C : value <= threshold - HYSTERESIS_C;
        if (armed == null) {
            // New alert: arm only if the condition isn't already true, so it never fires instantly.
            return new Result(false, !met, false);
        }
        if (armed && met && now - lastFired >= cooldownMs) {
            return new Result(true, false, "once".equals(repeat));
        }
        if (!armed && movedBack) {
            return new Result(false, true, false);
        }
        return new Result(false, armed, false);
    }
}
