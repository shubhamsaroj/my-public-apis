package com.techbyshubhamsaroj.weatherwise;

import android.hardware.GeomagneticField;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.SystemClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Live compass heading. Needs no permission; the sensors run only between start() and stop(), app in front. */
@CapacitorPlugin(name = "Compass")
public class CompassPlugin extends Plugin implements SensorEventListener {

    private SensorManager sensors;
    private Sensor rotation, accelerometer, magnet;
    private final float[] matrix = new float[9], gravity = new float[3], field = new float[3];
    private boolean wanted, running, haveGravity, haveField;
    private float declination, strength;
    private int accuracy = -1, sentAccuracy = -2;
    private double sent = Double.NaN;
    private long sentAt;

    @Override
    public void load() {
        sensors = getContext().getSystemService(SensorManager.class);
        if (sensors == null) return;
        magnet = sensors.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD);
        rotation = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        if (rotation == null) rotation = sensors.getDefaultSensor(Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR); // phones without a gyroscope
        if (rotation == null) accelerometer = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
    }

    @PluginMethod
    public void available(PluginCall call) {
        call.resolve(new JSObject().put("available", magnet != null && (rotation != null || accelerometer != null)));
    }

    /** @param call lat, lon: where the phone is, to show true north; without them, magnetic north */
    @PluginMethod
    public void start(PluginCall call) {
        Double lat = call.getDouble("lat"), lon = call.getDouble("lon");
        boolean known = lat != null && lon != null && WeatherApi.valid(lat, lon);
        getBridge().executeOnMainThread(() -> {
            declination = known ? new GeomagneticField(lat.floatValue(), lon.floatValue(), 0, System.currentTimeMillis()).getDeclination() : 0;
            wanted = true;
            sent = Double.NaN;
            listen(true);
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            wanted = false;
            listen(false);
            call.resolve();
        });
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        listen(false);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (wanted) listen(true);
    }

    private void listen(boolean on) {
        if (sensors == null || on == running) return;
        running = on;
        if (!on) { sensors.unregisterListener(this); return; }
        if (rotation != null) sensors.registerListener(this, rotation, SensorManager.SENSOR_DELAY_UI);
        else if (accelerometer != null) sensors.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_UI);
        if (magnet != null) sensors.registerListener(this, magnet, rotation != null ? SensorManager.SENSOR_DELAY_NORMAL : SensorManager.SENSOR_DELAY_UI);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int value) {
        if (sensor == magnet) accuracy = value;
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        if (e.sensor == magnet) {
            float s = (float) Math.sqrt(e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]);
            strength = haveField ? strength + (s - strength) * 0.15f : s;
            for (int i = 0; i < 3; i++) field[i] = haveField ? field[i] + (e.values[i] - field[i]) * 0.3f : e.values[i];
            haveField = true;
            accuracy = e.accuracy;
            return;
        }
        if (e.sensor == rotation) {
            SensorManager.getRotationMatrixFromVector(matrix, e.values);
        } else {
            for (int i = 0; i < 3; i++) gravity[i] = haveGravity ? gravity[i] + (e.values[i] - gravity[i]) * 0.3f : e.values[i];
            haveGravity = true;
            if (!haveField || !SensorManager.getRotationMatrix(matrix, null, gravity, field)) return;
        }
        double h = (HeadingMath.heading(matrix, turned()) + declination + 360) % 360;
        long now = SystemClock.elapsedRealtime();
        double moved = Double.isNaN(sent) ? 360 : Math.abs((h - sent + 540) % 360 - 180);
        // Nothing to say while the phone lies still: no work, no battery.
        if (moved < 0.5 && accuracy == sentAccuracy && now - sentAt < 2000) return;
        if (now - sentAt < 45) return;
        sent = h;
        sentAt = now;
        sentAccuracy = accuracy;
        notifyListeners("heading", new JSObject().put("h", Math.round(h * 10) / 10.0).put("acc", accuracy).put("field", Math.round(strength)));
    }

    @SuppressWarnings("deprecation")
    private int turned() {
        return getActivity() == null ? 0 : getActivity().getWindowManager().getDefaultDisplay().getRotation();
    }
}
