package com.techbyshubhamsaroj.weatherwise;

/** Sunrise and sunset for any date and place (the standard sunrise equation, ~1 minute accuracy). */
final class SunMath {

    private static final double RAD = Math.PI / 180;

    private SunMath() {}

    /**
     * @param dayUtcMs 00:00 UTC of the local calendar date wanted
     * @return { sunrise, sunset } as epoch ms, or null when the sun doesn't rise or set that day
     */
    static long[] times(long dayUtcMs, double lat, double lon) {
        double n = Math.ceil(dayUtcMs / 86400000.0 + 2440587.5 - 2451545.0 + 0.0008);
        double jStar = n - lon / 360;
        double m = mod(357.5291 + 0.98560028 * jStar, 360) * RAD;
        double c = 1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m);
        double lambda = mod(m / RAD + c + 180 + 102.9372, 360) * RAD;
        double transit = 2451545.0 + jStar + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * lambda);
        double sinDec = Math.sin(lambda) * Math.sin(23.4397 * RAD);
        double cosDec = Math.cos(Math.asin(sinDec));
        double cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDec) / (Math.cos(lat * RAD) * cosDec);
        if (cosW > 1 || cosW < -1) return null;
        double w = Math.acos(cosW) / RAD / 360;
        return new long[] { toMs(transit - w), toMs(transit + w) };
    }

    private static long toMs(double julian) {
        return Math.round((julian - 2440587.5) * 86400000.0);
    }

    private static double mod(double a, double b) {
        return ((a % b) + b) % b;
    }
}
