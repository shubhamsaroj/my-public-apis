package com.techbyshubhamsaroj.weatherwise;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AlertsPlugin.class);
        registerPlugin(CompassPlugin.class);
        super.onCreate(savedInstanceState);
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            WebSettings s = webView.getSettings();
            // The app is served from bundled assets via Capacitor's local server,
            // so the WebView never needs raw file:// or content:// access.
            s.setAllowFileAccess(false);
            s.setAllowContentAccess(false);
            s.setJavaScriptCanOpenWindowsAutomatically(false);
            s.setSupportMultipleWindows(false);
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            s.setSafeBrowsingEnabled(true);
            webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
            // Respect the system font size (accessibility), within limits the layout is designed for.
            float scale = getResources().getConfiguration().fontScale;
            s.setTextZoom(Math.round(Math.max(0.85f, Math.min(1.3f, scale)) * 100));
            webView.setBackgroundColor(0xFF0B1430);
        }
    }
}
