package com.techbyshubhamsaroj.weatherwise;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;
import android.util.Log;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Our alarm, plus the moments Android forgets alarms (restart, update, clock change). */
public class AlertReceiver extends BroadcastReceiver {

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();

    @Override
    public void onReceive(Context context, Intent intent) {
        final Context c = context.getApplicationContext();
        final String action = intent == null ? "" : String.valueOf(intent.getAction());
        final PendingResult done = goAsync();
        PowerManager pm = c.getSystemService(PowerManager.class);
        final PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "weatherwise:alert");
        wl.setReferenceCounted(false);
        wl.acquire(20_000L);
        EXEC.execute(() -> {
            try {
                if (AlertEngine.ACTION_WAKE.equals(action)) {
                    AlertEngine.onAlarm(c);
                } else {
                    AlertEngine.cleanUpOldVersions(c);
                    AlertEngine.syncFromReceiver(c, Intent.ACTION_BOOT_COMPLETED.equals(action));
                    RefreshWorker.schedule(c);
                }
            } catch (RuntimeException e) {
                // The next alarm is already set (see onAlarm); a crash here would only hurt.
                Log.w("Weatherwise", "alert run failed", e);
            } finally {
                wl.release();
                done.finish();
            }
        });
    }
}
