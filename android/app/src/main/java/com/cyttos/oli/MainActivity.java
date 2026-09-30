package com.cyttos.oli;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(OliAudioPlugin.class);
    registerPlugin(OliMediaPlugin.class);
    registerPlugin(OliDownloadPlugin.class);
    registerPlugin(OliYouTubePlugin.class);
    registerPlugin(OliVideoPlugin.class);
    super.onCreate(savedInstanceState);
    // Back button / back gesture: the app decides (close a panel, previous page, home); only at the home page the app is
    // sent to the background instead of being closed.
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override
      public void handleOnBackPressed() {
        WebView web = getBridge() == null ? null : getBridge().getWebView();
        if (web == null) {
          moveTaskToBack(true);
          return;
        }
        web.evaluateJavascript(
            "(function(){try{return window.__oliBack?window.__oliBack():false}catch(e){return false}})()",
            value -> {
              if (!"true".equals(value)) moveTaskToBack(true);
            });
      }
    });
    // Android 13+ needs this permission to show the playback notification (lock-screen controls).
    if (Build.VERSION.SDK_INT >= 33
        && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(this, new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
    }
  }
}
