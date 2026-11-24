package com.techbyshubhamsaroj.weatherwise;

import android.app.ActivityManager;
import android.app.AlarmManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import java.util.Locale;

/** What the phone allows in the background, and the settings pages that change it. */
final class PhoneSettings {

    private PhoneSettings() {}

    static boolean exactAllowed(Context c) {
        if (Build.VERSION.SDK_INT < 31) return true;
        AlarmManager am = c.getSystemService(AlarmManager.class);
        return am != null && am.canScheduleExactAlarms();
    }

    /** "unrestricted", "optimized" or "restricted". */
    static String battery(Context c) {
        if (Build.VERSION.SDK_INT >= 28) {
            ActivityManager am = c.getSystemService(ActivityManager.class);
            if (am != null && am.isBackgroundRestricted()) return "restricted";
        }
        PowerManager pm = c.getSystemService(PowerManager.class);
        return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName()) ? "unrestricted" : "optimized";
    }

    /** Data Saver, or background data switched off for this app: no temperature checks on mobile data. */
    static boolean backgroundDataBlocked(Context c) {
        ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
        return cm != null && cm.getRestrictBackgroundStatus() == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED;
    }

    static boolean idle(Context c) {
        PowerManager pm = c.getSystemService(PowerManager.class);
        return pm != null && pm.isDeviceIdleMode();
    }

    /** Brand whose phones are known to stop background apps, or "" when not applicable. */
    static String brand() {
        String m = (Build.MANUFACTURER + " " + Build.BRAND).toLowerCase(Locale.ROOT);
        for (String b : new String[] { "xiaomi", "redmi", "poco", "realme", "oppo", "vivo", "iqoo", "oneplus", "samsung", "huawei", "honor", "infinix", "tecno", "itel", "asus" }) {
            if (m.contains(b)) return b;
        }
        return "";
    }

    private static final String[][] AUTOSTART = {
        { "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity" },
        { "com.oplus.battery", "com.oplus.startupapp.view.StartupAppListActivity" },
        { "com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity" },
        { "com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity" },
        { "com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity" },
        { "com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity" },
        { "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager" },
        { "com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity" },
        { "com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity" },
        { "com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity" },
        { "com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity" },
        { "com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity" },
        { "com.transsion.phonemanager", "com.itel.autobootmanager.activity.AutoBootMgrActivity" },
        { "com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity" },
    };

    static void open(Context c, String which) {
        Uri pkg = Uri.parse("package:" + c.getPackageName());
        boolean ok = false;
        if ("exact".equals(which) && Build.VERSION.SDK_INT >= 31) {
            ok = start(c, new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg));
        } else if ("battery".equals(which)) {
            ok = "optimized".equals(battery(c)) && start(c, new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg));
        } else if ("notifications".equals(which) && Build.VERSION.SDK_INT >= 26) {
            ok = start(c, new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, c.getPackageName()));
        } else if ("data".equals(which)) {
            ok = start(c, new Intent(Settings.ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS, pkg));
        } else if ("autostart".equals(which)) {
            for (String[] a : AUTOSTART) {
                if (start(c, new Intent().setComponent(new ComponentName(a[0], a[1])))) { ok = true; break; }
            }
        }
        if (!ok) start(c, new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg));
    }

    private static boolean start(Context c, Intent i) {
        try {
            c.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (RuntimeException e) { // page doesn't exist on this phone, or isn't open to other apps
            return false;
        }
    }
}
