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
    Context ctx = getContext();
    File dir = ctx.getExternalFilesDir(null);
    return dir != null ? dir : ctx.getFilesDir();
  }

  /** The folder downloads go to. */
  @PluginMethod
  public void getRoot(PluginCall call) {
    JSObject o = new JSObject();
    o.put("root", root().getAbsolutePath());
    call.resolve(o);
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
    if (id != null) OliDownloadService.engine().cancel(id);
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
}
