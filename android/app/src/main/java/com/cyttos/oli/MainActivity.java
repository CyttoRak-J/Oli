package com.cyttos.oli;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(OliAudioPlugin.class);
    registerPlugin(OliMediaPlugin.class);
    registerPlugin(OliDownloadPlugin.class);
    registerPlugin(OliYouTubePlugin.class);
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

  // ---------------------------------------------------------------------------------------------------------------
  // Keep the app's JavaScript running while the app is minimized or the screen is off. The queue (next song when one
  // ends, the notification's next / previous buttons) and the download list live in JavaScript; when Android marks the
  // web view as hidden, Chromium slows its timers to about one a second (one a minute after five minutes), so songs
  // did not advance and finished downloads were not processed. Telling the web view it is still visible avoids that.

  private final Handler awake = new Handler(Looper.getMainLooper());
  private final Runnable keepVisible = new Runnable() {
    @Override
    public void run() {
      WebView web = getBridge() == null ? null : getBridge().getWebView();
      if (web == null) return;
      try {
        web.resumeTimers();
        web.dispatchWindowVisibilityChanged(View.VISIBLE);
      } catch (Exception ignored) {
        // best effort
      }
      if (!resumedNow) awake.postDelayed(this, 4000);
    }
  };
  private boolean resumedNow = true;

  @Override
  public void onResume() {
    resumedNow = true;
    awake.removeCallbacks(keepVisible);
    super.onResume();
  }

  @Override
  public void onPause() {
    super.onPause();
    resumedNow = false;
    awake.removeCallbacks(keepVisible);
    awake.postDelayed(keepVisible, 300);
  }

  @Override
  public void onStop() {
    super.onStop();
    resumedNow = false;
    awake.removeCallbacks(keepVisible);
    awake.postDelayed(keepVisible, 300);
  }

  @Override
  public void onDestroy() {
    awake.removeCallbacks(keepVisible);
    super.onDestroy();
  }
}
