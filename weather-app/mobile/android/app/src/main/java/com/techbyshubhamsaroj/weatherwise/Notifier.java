package com.techbyshubhamsaroj.weatherwise;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.text.format.DateFormat;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/** Posts alert notifications. */
final class Notifier {

    static final String SUN = "sun";
    static final String TEMP = "temp_alerts";
    static final String EXTRA_PLACE = "weatherwise.place";

    private Notifier() {}

    static boolean allowed(Context c) {
        return NotificationManagerCompat.from(c).areNotificationsEnabled();
    }

    /** Can a notification of this kind be shown at all? */
    static boolean allowed(Context c, String channel) {
        return allowed(c) && !channelBlocked(c, channel);
    }

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel sun = new NotificationChannel(SUN, "Sunrise & sunset", NotificationManager.IMPORTANCE_HIGH);
        sun.setDescription("Reminders around sunrise and sunset");
        NotificationChannel temp = new NotificationChannel(TEMP, "Temperature alerts", NotificationManager.IMPORTANCE_HIGH);
        temp.setDescription("Your temperature alarms");
        nm.createNotificationChannel(sun);
        nm.createNotificationChannel(temp);
    }

    static boolean channelBlocked(Context c, String id) {
        if (Build.VERSION.SDK_INT < 26) return false;
        NotificationChannel ch = c.getSystemService(NotificationManager.class).getNotificationChannel(id);
        return ch != null && ch.getImportance() == NotificationManager.IMPORTANCE_NONE;
    }

    static boolean post(Context c, int id, String channel, int icon, int color, String title, String body, String placeId) {
        if (!allowed(c, channel)) return false;
        channels(c);
        Intent open = new Intent(c, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_PLACE, placeId);
        PendingIntent pi = PendingIntent.getActivity(c, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, channel)
            .setSmallIcon(icon)
            .setColor(color)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(pi);
        try {
            c.getSystemService(NotificationManager.class).notify(id, b.build());
            return true;
        } catch (SecurityException e) {
            return false; // permission was withdrawn in between
        }
    }

    /** "5:56 PM" or "17:56" at the place, following the app's time-format setting. */
    static String clock(Context c, long when, String tz, String pref) {
        boolean h24 = "24".equals(pref) || (!"12".equals(pref) && DateFormat.is24HourFormat(c));
        SimpleDateFormat f = new SimpleDateFormat(h24 ? "HH:mm" : "h:mm a", Locale.getDefault());
        f.setTimeZone(tz == null || tz.isEmpty() ? TimeZone.getDefault() : TimeZone.getTimeZone(tz));
        return f.format(new Date(when));
    }

    static String degrees(double celsius, boolean fahrenheit) {
        return Math.round(fahrenheit ? celsius * 9 / 5 + 32 : celsius) + (fahrenheit ? "°F" : "°C");
    }
}
