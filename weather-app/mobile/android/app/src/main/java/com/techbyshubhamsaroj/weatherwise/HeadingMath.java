package com.techbyshubhamsaroj.weatherwise;

/** Which way the phone points. Pure, unit-tested. */
final class HeadingMath {

    private HeadingMath() {}

    /**
     * @param r        3x3 rotation matrix (device to world: x east, y north, z up), as Android gives it
     * @param rotation how the screen is turned: 0, 1 (90), 2 (180) or 3 (270), as in Surface.ROTATION_*
     * @return degrees clockwise from north, 0 to 360
     */
    static double heading(float[] r, int rotation) {
        double ux = rotation == 1 ? 1 : rotation == 3 ? -1 : 0;
        double uy = rotation == 0 ? 1 : rotation == 2 ? -1 : 0;
        // Flat, the phone points where the top of its screen points; upright, where its back points.
        // The sum of the two is right for both, and for every tilt in between.
        double east = r[0] * ux + r[1] * uy - r[2];
        double north = r[3] * ux + r[4] * uy - r[5];
        return (Math.toDegrees(Math.atan2(east, north)) + 360) % 360;
    }
}
