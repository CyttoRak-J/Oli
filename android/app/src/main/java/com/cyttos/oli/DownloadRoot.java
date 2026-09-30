package com.cyttos.oli;

import android.content.Context;
import android.os.Build;
import android.os.Environment;

import java.io.File;

/**
 * The folder downloads are saved in: the one chosen in Settings (needs "all files access" on Android 11+), else the
 * app's own folder. Shared by the file downloads and the YouTube downloads.
 */
final class DownloadRoot {
  private static boolean loaded;
  private static String custom;

  private DownloadRoot() {}

  private static synchronized void load(Context c) {
    if (loaded) return;
    loaded = true;
    custom = c.getApplicationContext().getSharedPreferences("oli_downloads", Context.MODE_PRIVATE).getString("root", null);
  }

  static synchronized void set(Context c, String path) {
    load(c);
    custom = path == null || path.isEmpty() ? null : path;
    android.content.SharedPreferences.Editor e = c.getApplicationContext().getSharedPreferences("oli_downloads", Context.MODE_PRIVATE).edit();
    if (custom == null) e.remove("root");
    else e.putString("root", custom);
    e.apply();
  }

  static synchronized String custom(Context c) {
    load(c);
    return custom;
  }

  static boolean allFilesAllowed() {
    return Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager();
  }

  static File defaultRoot(Context c) {
    File dir = c.getExternalFilesDir(null);
    return dir != null ? dir : c.getFilesDir();
  }

  static File resolve(Context c) {
    String path = custom(c);
    if (path != null && allFilesAllowed()) {
      File d = new File(path);
      if ((d.isDirectory() || d.mkdirs()) && d.canWrite()) return d;
    }
    return defaultRoot(c);
  }

  /** "primary" + "Music/Downloads" -> /storage/emulated/0/Music/Downloads; a memory card -> /storage/XXXX-XXXX/... */
  static String absolute(String volume, String path) {
    String rel = FolderScope.clean(path);
    File base = "primary".equals(volume) || volume == null || volume.isEmpty()
        ? Environment.getExternalStorageDirectory()
        : new File("/storage/" + volume);
    return rel.isEmpty() ? base.getAbsolutePath() : new File(base, rel).getAbsolutePath();
  }
}
