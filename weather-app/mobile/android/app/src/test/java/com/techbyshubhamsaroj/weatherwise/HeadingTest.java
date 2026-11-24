package com.techbyshubhamsaroj.weatherwise;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class HeadingTest {

    /** Device-to-world matrix of a phone facing {@code heading}, tilted up by {@code tilt} (0 flat, 90 upright), screen turned. */
    private static float[] phone(double heading, double tilt, int turned) {
        double a = Math.toRadians(heading), t = Math.toRadians(tilt), q = Math.toRadians(90 * turned);
        double[] right = { Math.cos(a), -Math.sin(a), 0 };
        double[] top = { Math.sin(a) * Math.cos(t), Math.cos(a) * Math.cos(t), Math.sin(t) };
        double[] out = { -Math.sin(a) * Math.sin(t), -Math.cos(a) * Math.sin(t), Math.cos(t) };
        float[] r = new float[9];
        for (int i = 0; i < 3; i++) { // the phone's own x and y axes, when the screen is turned by q
            r[3 * i] = (float) (right[i] * Math.cos(q) + top[i] * Math.sin(q));
            r[3 * i + 1] = (float) (top[i] * Math.cos(q) - right[i] * Math.sin(q));
            r[3 * i + 2] = (float) out[i];
        }
        return r;
    }

    @Test public void rightAtEveryTiltHeadingAndScreenRotation() {
        for (int turned = 0; turned < 4; turned++) {
            for (int tilt = 0; tilt <= 90; tilt += 15) {
                for (int heading = 0; heading < 360; heading += 5) {
                    double diff = Math.abs((HeadingMath.heading(phone(heading, tilt, turned), turned) - heading + 540) % 360 - 180);
                    assertEquals("heading " + heading + " tilt " + tilt + " turned " + turned, 0, diff, 0.01);
                }
            }
        }
    }
}
