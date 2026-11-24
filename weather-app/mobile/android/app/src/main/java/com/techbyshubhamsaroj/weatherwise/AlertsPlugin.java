package com.techbyshubhamsaroj.weatherwise;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Bridge between the app's screens and the alert engine. */
@CapacitorPlugin(name = "Alerts", permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }))
public class AlertsPlugin extends Plugin {

    private final ExecutorService exec = Executors.newSingleThreadExecutor();

    private interface Job {
        void run(Context c) throws Exception;
    }

    private void run(PluginCall call, Job job) {
        final Context c = getContext().getApplicationContext();
        exec.execute(() -> {
            try {
                job.run(c);
            } catch (Exception e) {
                call.reject("Alerts: " + e.getClass().getSimpleName());
            }
        });
    }

    @Override
    public void load() {
        final Context c = getContext().getApplicationContext();
        exec.execute(() -> {
            try {
                AlertEngine.opened(c);
                AlertEngine.cleanUpOldVersions(c);
                AlertEngine.sync(c, true); // also brings alarms back after a "Force stop"
                RefreshWorker.schedule(c);
            } catch (RuntimeException e) {
                Log.w("Weatherwise", "start-up sync failed", e);
            }
        });
        emitTap(getActivity().getIntent());
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        final Context c = getContext().getApplicationContext();
        exec.execute(() -> {
            try {
                AlertEngine.opened(c);
            } catch (RuntimeException e) { /* usage note only */ }
        });
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        emitTap(intent);
    }

    private void emitTap(Intent intent) {
        String place = intent == null ? null : intent.getStringExtra(Notifier.EXTRA_PLACE);
        if (place == null || place.isEmpty()) return;
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return; // reopened from Recents
        intent.removeExtra(Notifier.EXTRA_PLACE);
        notifyListeners("alertTapped", new JSObject().put("placeId", place), true);
    }

    /** Alerts or settings changed, or the app was opened. Cheap, no network. */
    @PluginMethod
    public void sync(PluginCall call) {
        run(call, (c) -> {
            AlertEngine.sync(c, true);
            call.resolve();
        });
    }

    /** Check temperatures now. */
    @PluginMethod
    public void check(PluginCall call) {
        boolean debuggable = (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        Double t = debuggable ? call.getDouble("debugTemp") : null; // test hooks do nothing in release builds
        boolean skip = debuggable && Boolean.TRUE.equals(call.getBoolean("ignoreCooldown", false));
        run(call, (c) -> {
            AlertEngine.check(c, true, t == null ? Double.NaN : t, skip);
            call.resolve();
        });
    }

    @PluginMethod
    public void status(PluginCall call) {
        run(call, (c) -> call.resolve(JSObject.fromJSONObject(AlertEngine.status(c))));
    }

    /** A forecast fetched in the background for this place, if newer than `since`. */
    @PluginMethod
    public void background(PluginCall call) {
        String id = call.getString("id", "");
        Double since = call.getDouble("since", 0.0);
        run(call, (c) -> call.resolve(new JSObject().put("data", AlertEngine.backgroundForecast(c, id, since == null ? 0L : since.longValue()))));
    }

    @PluginMethod
    public void preview(PluginCall call) {
        run(call, (c) -> {
            AlertEngine.previewSun(c);
            call.resolve();
        });
    }

    /** Deliver a test alert through the real background path. */
    @PluginMethod
    public void test(PluginCall call) {
        int seconds = Math.max(10, Math.min(600, call.getInt("seconds", 60)));
        run(call, (c) -> {
            AlertEngine.startTest(c, seconds);
            call.resolve();
        });
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        String which = call.getString("which", "app");
        if ("autostart".equals(which) || "app".equals(which)) AlertEngine.forgetHeldBack(getContext()); // it warns again if it happens again
        PhoneSettings.open(getActivity() != null ? getActivity() : getContext(), which);
        call.resolve();
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsResult");
        } else {
            call.resolve(new JSObject().put("granted", Notifier.allowed(getContext())));
        }
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        call.resolve(new JSObject().put("granted", Notifier.allowed(getContext())));
    }
}
