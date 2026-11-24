# Weatherwise (Android)

Standalone Android app version of the weather web app. It talks directly to Open-Meteo
(forecast, air quality, search fallback), Photon (place search) and OpenStreetMap Nominatim
(reverse geocoding), so it does **not** need the Flask server. No accounts, keys, ads or trackers.

## Build

Requirements: Node 20+, JDK 21 (`brew install openjdk@21`), Android SDK (platform 36).

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
npm ci
npm run apk:release   # -> android/app/build/outputs/apk/release/app-release.apk
npm run apk:debug     # debuggable build (WebView inspectable via chrome://inspect)
```

Release signing reads `android/keystore.properties` (git-ignored):

```
storeFile=/absolute/path/to/release.jks
storePassword=...
keyAlias=weatherwise
keyPassword=...
```

**Back up the keystore and its password.** Android will refuse to install updates
signed with a different key.

## Layout

- `src/main.js` – state, screens, data flow; `src/api.js` – network; `src/sky.js` – animated sky
- `src/lib/` – pure helpers (units, forecast model, storage); `src/ui/` – screens and sheets
- `src/alerts.js` – bridge to the native alert engine, and the reliability checklist
- `src/ui/compass.js`, `CompassPlugin`, `HeadingMath` – compass around the temperature; sensors run only while it is on screen
- `android/app/src/main/java/…/weatherwise/` – native alert engine (below)
- `build.mjs` – esbuild bundle into `www/` (no CDN scripts at runtime)

## How alerts work

Alerts are fully native, so they don't depend on the app being open. Nothing runs in between:
**one exact alarm** is pending, for the next thing that is due.

| File | Job |
| --- | --- |
| `AlertEngine` | Does what is due, then sets the next alarm. Re-plans on restart, update and clock change. |
| `SunMath`, `SunPlan` | Sunrise/sunset calculated on the phone, so these alerts need no internet. |
| `CheckPlanner` | When to look at the temperature next: up to 3 hours when far from the limit, 15–30 min when close. |
| `AlertLogic` | When a temperature alert fires, re-arms (1 °C back) and cools down (3 h). |
| `RefreshWorker` | About hourly, when convenient for Android: full forecasts, so the app opens with fresh data. |
| `PhoneSettings` | What the phone allows (exact timing, battery, data saver, autostart) and how to change it. |

Design notes:

- Exact alarms ring in Doze and bring about 10 s of network; everything in one wake-up shares a 7.5 s budget.
- No internet at check time: the saved forecast (up to 12 h old) decides, only when clearly past the limit, and the alert says so.
- An alert the phone held back is delivered once when possible (until 10 min after the sunrise/sunset), never hours late.
- Some phones stop background apps in ways Android doesn't report. The engine notices overdue alarms, and
  "Make alerts reliable" explains the fix and can run a 1-minute test.

## Tests

```sh
TZ=Asia/Kolkata npm test                                        # JavaScript unit tests
(cd android && ./gradlew :app:testDebugUnitTest)                # Java unit tests, incl. simulated months of checks
node e2e/run.mjs --shots /tmp/shots                             # whole app, real touches (debug build)
node e2e/layouts.mjs                                            # phone to tablet sizes, large fonts
node e2e/alerts.mjs --apk android/app/build/outputs/apk/release/app-release.apk   # background alerts (emulator with root)
```

`e2e/alerts.mjs` puts the emulator in deep sleep with the app killed, takes it offline, restarts it and
updates the app, and checks Android's own records of what was delivered and when.

## Before Google Play

Fine for sideloading, but Google Play has rules for two permissions. Before publishing:

- `USE_EXACT_ALARM` is reserved for apps whose core function is an alarm or calendar. Either make that case
  in the Play Console, or remove it and drop `android:maxSdkVersion` from `SCHEDULE_EXACT_ALARM`
  (people then allow "Alarms & reminders" once; the reliability screen already handles that).
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is restricted too. If it isn't accepted, remove it and open
  `Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` in `PhoneSettings.open` instead.
- Also needed: a privacy policy, the Data safety form (location is sent to the weather and map services to get
  a forecast, not stored by us), an app bundle (`bundleRelease`) and Play App Signing.
- Check the API providers' terms: Open-Meteo's free tier is for non-commercial use.

## Security notes

- Strict CSP: only bundled scripts/styles; network limited to the API hosts above.
- API data is rendered with `textContent` only; `innerHTML` is used solely for static SVG icons (a unit test enforces this).
- HTTPS only (`usesCleartextTraffic=false`, network security config trusts system CAs only). Native requests
  follow no redirects and cap the response size.
- Only the launcher is open to other apps. Three library components are exported but guarded by system-only
  permissions (`BIND_JOB_SERVICE`, `DUMP`). The alert receiver is not exported.
- Backups and device-transfer of app data disabled. Removing a place deletes its saved forecasts.
- WebView: no file/content access, no mixed content, no popup windows.
- R8 minification + resource shrinking on release; debug-only test hooks do nothing in release builds.
- Dependencies pinned to exact versions; `npm audit` clean.
