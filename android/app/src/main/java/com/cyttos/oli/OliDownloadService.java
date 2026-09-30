package com.cyttos.oli;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import android.net.wifi.WifiManager;
import android.os.PowerManager;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Keeps downloads running while the app is in the background (a foreground service with a progress notification).
 * The engine itself is a process-wide singleton ({@link #engine()}); the service only shows the notification and stops
 * itself when nothing is left to download.
 */
public class OliDownloadService extends Service {
  private static final String CHANNEL = "oli_downloads";
  private static final int NOTIFICATION_ID = 4711;
  private static DownloadEngine engine;
  /** How many YouTube downloads (run by yt-dlp in OliYouTubePlugin, not by the engine) are waiting or running. */
  static volatile java.util.function.IntSupplier externalCount = () -> 0;
  private static volatile OliDownloadService live;

  /** Something outside the engine changed (a YouTube download started, finished or moved on): refresh the notification. */
  static void externalState(String id, String state) {
    OliDownloadService s = live;
    if (s == null) return;
    if (!"queued".equals(state) && !"downloading".equals(state)) s.progress.remove(id);
    s.main.postDelayed(s::update, 300);
  }

  static void externalProgress(String id, long bytes, long total) {
    OliDownloadService s = live;
    if (s == null) return;
    s.progress.put(id, new long[] {bytes, total});
    long now = System.currentTimeMillis();
    if (now - s.lastNotify > 1000) {
      s.lastNotify = now;
      s.main.post(s::update);
    }
  }

  /** Downloads the app says are waiting or running, including ones still being prepared (not in the engine yet). */
  private static volatile int pending = 0;

  static void setPending(Context ctx, int count) {
    pending = Math.max(0, count);
    OliDownloadService s = live;
    if (pending > 0) {
      if (s == null) ensureRunning(ctx);
    } else if (s != null) {
      s.main.postDelayed(s::update, 1500);
    }
  }

  private static int totalActive() {
    return Math.max(pending, engine().activeCount() + Math.max(0, externalCount.getAsInt()));
  }

  static synchronized DownloadEngine engine() {
    if (engine == null) engine = new DownloadEngine(2, 2);
    return engine;
  }

  /** Starts the service (from the foreground app); a failure is not fatal: downloads then run without the notification. */
  static void ensureRunning(Context ctx) {
    try {
      Intent i = new Intent(ctx, OliDownloadService.class);
      if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
      else ctx.startService(i);
    } catch (Exception ignored) {
      // background start not allowed: the engine still works while the process lives
    }
  }

  private final Handler main = new Handler(Looper.getMainLooper());
  private final Map<String, long[]> progress = new ConcurrentHashMap<>(); // id -> {bytes, total}
  private DownloadEngine.Listener listener;
  private long lastNotify = 0;
  private PowerManager.WakeLock cpuLock;
  private WifiManager.WifiLock wifiLock;

  /** With the screen off the phone may sleep and stall the transfer: hold the CPU and Wi-Fi awake while downloads run. */
  @SuppressWarnings("deprecation")
  private void holdLocks() {
    try {
      if (cpuLock == null) {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
          cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "oli:downloads");
          cpuLock.setReferenceCounted(false);
        }
      }
      if (cpuLock != null && !cpuLock.isHeld()) cpuLock.acquire(3 * 60 * 60 * 1000L);
      if (wifiLock == null) {
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
          wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "oli:downloads");
          wifiLock.setReferenceCounted(false);
        }
      }
      if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
    } catch (Exception ignored) {
      // locks are an extra; downloads still run
    }
  }

  private void releaseLocks() {
    try {
      if (cpuLock != null && cpuLock.isHeld()) cpuLock.release();
      if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
    } catch (Exception ignored) {
      // nothing to do
    }
  }

  @Override
  public void onCreate() {
    super.onCreate();
    live = this;
    holdLocks();
    createChannel();
    listener = new DownloadEngine.Listener() {
      @Override
      public void onProgress(String id, long bytes, long total, long bytesPerSecond) {
        progress.put(id, new long[] {bytes, total});
        long now = System.currentTimeMillis();
        if (now - lastNotify > 1000) {
          lastNotify = now;
          main.post(() -> update());
        }
      }

      @Override
      public void onState(String id, DownloadEngine.Result r) {
        if (!DownloadEngine.DOWNLOADING.equals(r.state) && !DownloadEngine.QUEUED.equals(r.state)) progress.remove(id);
        main.postDelayed(() -> update(), 300);
      }
    };
    engine().addListener(listener);
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    // must call startForeground quickly after startForegroundService()
    ServiceCompat.startForeground(this, NOTIFICATION_ID, build(Math.max(1, totalActive()), 0), foregroundType());
    main.postDelayed(() -> update(), 500);
    return START_NOT_STICKY;
  }

  private static int foregroundType() {
    return Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0;
  }

  private void update() {
    int active = totalActive();
    if (active == 0) {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
      stopSelf();
      return;
    }
    long bytes = 0;
    long total = 0;
    for (long[] p : progress.values()) {
      bytes += p[0];
      total += p[1];
    }
    int percent = total > 0 ? (int) Math.min(100, bytes * 100 / total) : 0;
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm != null) {
      try {
        nm.notify(NOTIFICATION_ID, build(active, total > 0 ? percent : -1));
      } catch (SecurityException ignored) {
        // notification permission refused: downloads continue silently
      }
    }
  }

  private Notification build(int active, int percent) {
    Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
    NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(android.R.drawable.stat_sys_download)
        .setNumber(active)
        .setSubText(active + (active == 1 ? " file left" : " files left"))
        .setContentTitle(active == 1 ? "Downloading 1 file" : "Downloading " + active + " files")
        .setContentText(percent >= 0 ? percent + "%" : "Starting…")
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(PendingIntent.getActivity(this, 1, open, flags))
        .setCategory(NotificationCompat.CATEGORY_PROGRESS);
    if (percent >= 0) b.setProgress(100, percent, false);
    else b.setProgress(0, 0, true);
    return b.build();
  }

  private void createChannel() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;
    NotificationChannel ch = new NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW);
    ch.setDescription("Progress of songs being downloaded");
    nm.createNotificationChannel(ch);
  }

  @Override
  public void onDestroy() {
    if (live == this) live = null;
    releaseLocks();
    if (listener != null) {
      engine().removeListener(listener);
      listener = null;
    }
    super.onDestroy();
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
