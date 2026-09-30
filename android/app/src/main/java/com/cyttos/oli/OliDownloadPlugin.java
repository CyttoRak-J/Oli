package com.cyttos.oli;

import android.content.Context;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.util.Iterator;

/**
 * The download queue for the app: files go to the app's own storage ("Android/data/com.cyttos.oli/files/Oli/..."), a
 * few at a time, resumable, with an MD5 / size check and tags + cover written into the finished file. The screen keeps
 * the list of downloads (so it survives restarts); this plugin does the transfers and reports progress.
 */
@CapacitorPlugin(name = "OliDownload")
public class OliDownloadPlugin extends Plugin {
  private static boolean listening = false;

  @Override
  public void load() {
    synchronized (OliDownloadPlugin.class) {
      if (listening) return;
      listening = true;
    }
    OliDownloadService.engine().addListener(new DownloadEngine.Listener() {
      @Override
      public void onProgress(String id, long bytes, long total, long bytesPerSecond) {
        JSObject o = new JSObject();
        o.put("id", id);
        o.put("bytes", bytes);
        o.put("total", total);
        o.put("speed", bytesPerSecond);
        notifyListeners("dlProgress", o);
      }

      @Override
      public void onState(String id, DownloadEngine.Result r) {
        JSObject o = new JSObject();
        o.put("id", id);
        o.put("state", r.state);
        o.put("error", r.error);
        o.put("path", r.path.isEmpty() ? "" : "file://" + r.path);
        o.put("size", r.size);
        o.put("md5", r.md5);
        o.put("tagged", r.tagged);
        o.put("tagNote", r.tagNote);
        o.put("bytes", r.bytes);
        notifyListeners("dlState", o);
      }
    });
  }

  private File root() {
    return DownloadRoot.resolve(getContext());
  }

  private JSObject rootInfo() {
    JSObject o = new JSObject();
    o.put("root", root().getAbsolutePath());
    String custom = DownloadRoot.custom(getContext());
    o.put("custom", custom == null ? "" : custom);
    o.put("allFiles", DownloadRoot.allFilesAllowed());
    return o;
  }

  /** {volume, path} or {reset:true}: the folder downloads are saved in (the picker result of OliMedia.pickFolder). */
  @PluginMethod
  public void setRoot(PluginCall call) {
    if (Boolean.TRUE.equals(call.getBoolean("reset", false))) {
      DownloadRoot.set(getContext(), null);
    } else {
      DownloadRoot.set(getContext(), DownloadRoot.absolute(call.getString("volume", "primary"), call.getString("path", "")));
    }
    call.resolve(rootInfo());
  }

  /** Opens Android's "allow access to all files" page for Oli (needed to save into a folder of your choice). */
  @PluginMethod
  public void requestAllFiles(PluginCall call) {
    try {
      android.content.Intent i = new android.content.Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
          android.net.Uri.parse("package:" + getContext().getPackageName()));
      i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(i);
    } catch (Exception e) {
      try {
        android.content.Intent i = new android.content.Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
      } catch (Exception e2) {
        call.reject("This phone has no settings page for that");
        return;
      }
    }
    call.resolve(rootInfo());
  }

  /** The folder downloads go to. */
  @PluginMethod
  public void getRoot(PluginCall call) {
    call.resolve(rootInfo());
  }

  /**
   * {id, url, relPath, size?, md5?, headers?, coverUrl?, tags?: {title, artist, albumArtist, album, genre, composer,
   * isrc, lyrics, trackNo, discNo, year}}
   */
  @PluginMethod
  public void enqueue(PluginCall call) {
    String id = call.getString("id");
    String url = call.getString("url");
    String rel = call.getString("relPath");
    if (id == null || url == null || rel == null || rel.contains("..")) {
      call.reject("id, url and relPath are required");
      return;
    }
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
      call.reject("only http(s) downloads are supported");
      return;
    }
    DownloadEngine.Spec s = new DownloadEngine.Spec();
    s.id = id;
    s.url = url;
    s.dest = new File(root(), rel);
    s.size = call.getLong("size", 0L);
    s.md5 = call.getString("md5", "");
    s.coverUrl = call.getString("coverUrl");
    JSObject headers = call.getObject("headers");
    if (headers != null) {
      Iterator<String> it = headers.keys();
      while (it.hasNext()) {
        String k = it.next();
        s.headers.put(k, headers.optString(k));
      }
    }
    JSObject tags = call.getObject("tags");
    if (tags != null) s.tags = tagsOf(tags);
    OliDownloadService.ensureRunning(getContext());
    OliDownloadService.engine().enqueue(s);
    call.resolve();
  }

  static TagFields tagsOf(JSONObject t) {
    TagFields f = new TagFields();
    f.title = str(t, "title");
    f.artist = str(t, "artist");
    f.albumArtist = str(t, "albumArtist");
    f.album = str(t, "album");
    f.genre = str(t, "genre");
    f.composer = str(t, "composer");
    f.isrc = str(t, "isrc");
    f.lyrics = str(t, "lyrics");
    f.trackNo = t.optInt("trackNo", 0);
    f.discNo = t.optInt("discNo", 0);
    f.year = t.optInt("year", 0);
    return f;
  }

  /** null when the key is missing; "" clears the tag. */
  static String str(JSONObject o, String key) {
    return o.has(key) && !o.isNull(key) ? o.optString(key) : null;
  }

  @PluginMethod
  public void pause(PluginCall call) {
    String id = call.getString("id");
    if (id != null) OliDownloadService.engine().pause(id);
    call.resolve();
  }

  @PluginMethod
  public void resume(PluginCall call) {
    String id = call.getString("id");
    if (id != null) {
      OliDownloadService.ensureRunning(getContext());
      OliDownloadService.engine().resume(id);
    }
    call.resolve();
  }

  @PluginMethod
  public void cancel(PluginCall call) {
    String id = call.getString("id");
    String rel = call.getString("relPath");
    if (id != null) OliDownloadService.engine().cancel(id);
    // a paused / failed download has no running task: remove its partial file here
    if (rel != null && !rel.contains("..")) {
      //noinspection ResultOfMethodCallIgnored
      new File(root(), rel + ".part").delete();
    }
    call.resolve();
  }

  /** Ids the engine is working on right now (the screen uses it after the web view was reloaded). */
  @PluginMethod
  public void getActive(PluginCall call) {
    JSArray ids = new JSArray();
    for (String id : OliDownloadService.engine().activeIds()) ids.put(id);
    JSObject o = new JSObject();
    o.put("ids", ids);
    call.resolve(o);
  }

  /**
   * {path, tags} -> {written, note}. Writes tags into a FLAC / MP3 file that lives in the app's own folder (the songs
   * downloaded by Oli). Files anywhere else are refused: the page must not be able to rewrite arbitrary files.
   */
  @PluginMethod
  public void writeTags(PluginCall call) {
    String path = call.getString("path");
    JSObject tags = call.getObject("tags");
    JSObject out = new JSObject();
    if (path == null || tags == null) {
      call.reject("path and tags are required");
      return;
    }
    try {
      File f = new File(path.startsWith("file://") ? android.net.Uri.parse(path).getPath() : path);
      String canonical = f.getCanonicalPath();
      String rootPath = root().getCanonicalPath() + File.separator;
      if (!canonical.startsWith(rootPath)) {
        out.put("written", false);
        out.put("note", "this file is not in Oli's own folder");
        call.resolve(out);
        return;
      }
      String name = f.getName().toLowerCase(java.util.Locale.ROOT);
      TagFields t = tagsOf(tags);
      boolean ok;
      if (name.endsWith(".flac")) ok = FlacTagWriter.write(f, t);
      else if (name.endsWith(".mp3")) ok = Id3TagWriter.write(f, t);
      else {
        out.put("written", false);
        out.put("note", "tags can be written to FLAC and MP3 files only");
        call.resolve(out);
        return;
      }
      out.put("written", ok);
      out.put("note", ok ? "" : "file format not recognised");
      call.resolve(out);
    } catch (Exception e) {
      out.put("written", false);
      out.put("note", String.valueOf(e.getMessage()));
      call.resolve(out);
    }
  }
}
