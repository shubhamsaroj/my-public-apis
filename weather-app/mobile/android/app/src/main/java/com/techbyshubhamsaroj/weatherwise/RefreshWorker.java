package com.techbyshubhamsaroj.weatherwise;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/**
 * About once an hour, when Android finds it convenient: refresh the forecast so the app opens
 * with fresh data, and make sure the alert alarm is still set. Alerts do not depend on it.
 */
public class RefreshWorker extends Worker {

    private static final String NAME = "background-refresh";

    public RefreshWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void schedule(Context c) {
        PeriodicWorkRequest r = new PeriodicWorkRequest.Builder(RefreshWorker.class, 60, TimeUnit.MINUTES, 30, TimeUnit.MINUTES)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresBatteryNotLow(true).build())
            .build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, r);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        AlertEngine.refreshForecasts(c);
        AlertEngine.check(c, false, Double.NaN, false);
        return Result.success();
    }
}
