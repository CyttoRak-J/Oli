package com.cyttos.oli;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.database.ContentObserver;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Environment;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.util.Size;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * The music that is already on the phone. Lists the audio files Android's MediaStore knows (page by page, so a library
 * of thousands never travels in one message), reads the details MediaStore lacks (real sample rate / bit depth,
 * ReplayGain, ...), extracts and caches cover art, and tells the app when the collection changes.
 */
@CapacitorPlugin(
    name = "OliMedia",
    permissions = {
      @Permission(alias = "audio", strings = {Manifest.permission.READ_MEDIA_AUDIO}),
      @Permission(alias = "storage", strings = {Manifest.permission.READ_EXTERNAL_STORAGE})
    })
public class OliMediaPlugin extends Plugin {
  private final Handler main = new Handler(Looper.getMainLooper());
  private Runnable pendingNotify = null;
  private ContentObserver observer = null;

  @Override
  public void load() {
    observer = new ContentObserver(main) {
      @Override
      public void onChange(boolean selfChange) {
        // Many small changes arrive together (a whole album copied): tell the app once.
        if (pendingNotify != null) main.removeCallbacks(pendingNotify);
        pendingNotify = () -> notifyListeners("mediaChanged", new JSObject());
        main.postDelayed(pendingNotify, 3000);
      }
    };
    try {
      getContext().getContentResolver().registerContentObserver(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true, observer);
    } catch (Exception ignored) {
      // Without it the app just rescans when opened or on request.
    }
  }

  @Override
  protected void handleOnDestroy() {
    if (observer != null) getContext().getContentResolver().unregisterContentObserver(observer);
  }

  private String alias() {
    return Build.VERSION.SDK_INT >= 33 ? "audio" : "storage";
  }

  private boolean granted() {
    return getPermissionState(alias()) == PermissionState.GRANTED;
  }

  @PluginMethod
  public void getPermission(PluginCall call) {
    JSObject o = new JSObject();
    o.put("granted", granted());
    call.resolve(o);
  }

  @PluginMethod
  public void requestPermission(PluginCall call) {
    if (granted()) {
      getPermission(call);
      return;
    }
    requestPermissionForAlias(alias(), call, "permissionResult");
  }

  @PermissionCallback
  private void permissionResult(PluginCall call) {
    getPermission(call);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Listing

  private static String str(Cursor c, int i) {
    if (i < 0 || c.isNull(i)) return "";
    String s = c.getString(i);
    return s == null ? "" : s;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Choosing a folder to scan (like "Add folders" on the PC)

  /** Opens Android's folder picker. Resolves {volume, path, label}, or {cancelled:true}. Nothing is granted or stored: the
   *  folder is only used to filter the music list (the music permission already allows reading the files). */
  @PluginMethod
  public void pickFolder(PluginCall call) {
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
    try {
      startActivityForResult(call, intent, "pickFolderResult");
    } catch (Exception e) {
      call.reject("No folder picker on this phone");
    }
  }

  @ActivityCallback
  private void pickFolderResult(PluginCall call, ActivityResult result) {
    JSObject o = new JSObject();
    Intent data = result.getData();
    Uri tree = data == null ? null : data.getData();
    if (result.getResultCode() != android.app.Activity.RESULT_OK || tree == null) {
      o.put("cancelled", true);
      call.resolve(o);
      return;
    }
    if (!"com.android.externalstorage.documents".equals(tree.getAuthority())) {
      call.reject("That folder is not on the phone's storage or memory card");
      return;
    }
    FolderScope scope = FolderScope.fromDocumentId(DocumentsContract.getTreeDocumentId(tree));
    if (scope == null) {
      call.reject("That folder is not on the phone's storage or memory card");
      return;
    }
    o.put("volume", scope.volume);
    o.put("path", scope.path);
    o.put("label", scope.label());
    call.resolve(o);
  }

  /** {offset, limit, volume?, path?} -> {rows, total?}. Rows are sorted by MediaStore id, so paging is stable. With a
   *  volume (and path) only the music inside that folder is listed. */
  @PluginMethod
  public void queryAudio(PluginCall call) {
    if (!granted()) {
      call.reject("permission");
      return;
    }
    final int offset = call.getInt("offset", 0);
    final int limit = Math.max(1, Math.min(1000, call.getInt("limit", 500)));
    final ContentResolver cr = getContext().getContentResolver();
    final Uri base = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
    final String volume = call.getString("volume");
    final String folder = call.getString("path", "");
    String selection = MediaStore.Audio.Media.IS_MUSIC + " != 0";
    String[] selectionArgs = null;
    if (volume != null && !volume.isEmpty()) {
      if (Build.VERSION.SDK_INT >= 29) {
        String like = FolderScope.relativeLike(folder);
        selection += " AND " + MediaStore.Audio.Media.VOLUME_NAME + " = ? AND " + MediaStore.Audio.Media.RELATIVE_PATH + " LIKE ? ESCAPE '\\'";
        selectionArgs = new String[] {FolderScope.mediaVolume(volume), like};
      } else {
        String root = "primary".equals(volume) ? Environment.getExternalStorageDirectory().getPath() : "/storage/" + volume;
        selection += " AND " + MediaStore.Audio.Media.DATA + " LIKE ? ESCAPE '\\'";
        selectionArgs = new String[] {FolderScope.dataLike(root, folder)};
      }
    }
    final String where = selection;
    final String[] whereArgs = selectionArgs;
    try {
      List<String> cols = new ArrayList<>();
      cols.add(MediaStore.Audio.Media._ID);
      cols.add(MediaStore.Audio.Media.TITLE);
      cols.add(MediaStore.Audio.Media.ARTIST);
      cols.add(MediaStore.Audio.Media.ALBUM);
      cols.add(MediaStore.Audio.Media.COMPOSER);
      cols.add(MediaStore.Audio.Media.YEAR);
      cols.add(MediaStore.Audio.Media.TRACK);
      cols.add(MediaStore.Audio.Media.DURATION);
      cols.add(MediaStore.Audio.Media.SIZE);
      cols.add(MediaStore.Audio.Media.DATE_MODIFIED);
      cols.add(MediaStore.Audio.Media.DATE_ADDED);
      cols.add(MediaStore.Audio.Media.DISPLAY_NAME);
      cols.add(MediaStore.Audio.Media.MIME_TYPE);
      if (Build.VERSION.SDK_INT >= 29) {
        cols.add(MediaStore.Audio.Media.RELATIVE_PATH);
      } else {
        cols.add(MediaStore.Audio.Media.DATA);
      }
      if (Build.VERSION.SDK_INT >= 30) {
        cols.add(MediaStore.Audio.Media.ALBUM_ARTIST);
        cols.add(MediaStore.Audio.Media.GENRE);
        cols.add(MediaStore.Audio.Media.BITRATE);
      }
      Bundle args = new Bundle();
      args.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, where);
      if (whereArgs != null) args.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, whereArgs);
      args.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, MediaStore.Audio.Media._ID + " ASC");
      args.putInt(ContentResolver.QUERY_ARG_LIMIT, limit);
      args.putInt(ContentResolver.QUERY_ARG_OFFSET, offset);

      JSObject result = new JSObject();
      JSArray rows = new JSArray();
      try (Cursor c = cr.query(base, cols.toArray(new String[0]), args, null)) {
        if (c != null) {
          int iId = c.getColumnIndex(MediaStore.Audio.Media._ID);
          int iTitle = c.getColumnIndex(MediaStore.Audio.Media.TITLE);
          int iArtist = c.getColumnIndex(MediaStore.Audio.Media.ARTIST);
          int iAlbum = c.getColumnIndex(MediaStore.Audio.Media.ALBUM);
          int iComposer = c.getColumnIndex(MediaStore.Audio.Media.COMPOSER);
          int iYear = c.getColumnIndex(MediaStore.Audio.Media.YEAR);
          int iTrack = c.getColumnIndex(MediaStore.Audio.Media.TRACK);
          int iDur = c.getColumnIndex(MediaStore.Audio.Media.DURATION);
          int iSize = c.getColumnIndex(MediaStore.Audio.Media.SIZE);
          int iMod = c.getColumnIndex(MediaStore.Audio.Media.DATE_MODIFIED);
          int iAdd = c.getColumnIndex(MediaStore.Audio.Media.DATE_ADDED);
          int iName = c.getColumnIndex(MediaStore.Audio.Media.DISPLAY_NAME);
          int iMime = c.getColumnIndex(MediaStore.Audio.Media.MIME_TYPE);
          int iRel = c.getColumnIndex(MediaStore.Audio.Media.RELATIVE_PATH);
          int iData = c.getColumnIndex(MediaStore.Audio.Media.DATA);
          int iAA = c.getColumnIndex(MediaStore.Audio.Media.ALBUM_ARTIST);
          int iGenre = c.getColumnIndex(MediaStore.Audio.Media.GENRE);
          int iBit = c.getColumnIndex(MediaStore.Audio.Media.BITRATE);
          while (c.moveToNext()) {
            long id = c.getLong(iId);
            JSObject r = new JSObject();
            r.put("id", id);
            r.put("uri", ContentUris.withAppendedId(base, id).toString());
            r.put("title", str(c, iTitle));
            r.put("artist", str(c, iArtist));
            r.put("album", str(c, iAlbum));
            r.put("albumArtist", str(c, iAA));
            r.put("composer", str(c, iComposer));
            r.put("genre", str(c, iGenre));
            r.put("year", iYear >= 0 ? c.getInt(iYear) : 0);
            int t = iTrack >= 0 ? c.getInt(iTrack) : 0;
            r.put("trackNo", t % 1000);
            r.put("discNo", t / 1000);
            r.put("durationMs", iDur >= 0 ? c.getLong(iDur) : 0);
            r.put("size", iSize >= 0 ? c.getLong(iSize) : 0);
            r.put("modifiedSec", iMod >= 0 ? c.getLong(iMod) : 0);
            r.put("addedSec", iAdd >= 0 ? c.getLong(iAdd) : 0);
            String name = str(c, iName);
            r.put("displayName", name);
            r.put("mime", str(c, iMime));
            r.put("bitrate", iBit >= 0 ? c.getInt(iBit) : 0);
            // A stable name for the song (its folder and file name), used to make the same id after a reinstall.
            String rel = str(c, iRel);
            r.put("key", iRel >= 0 ? rel + name : str(c, iData));
            rows.put(r);
          }
        }
      }
      result.put("rows", rows);
      if (offset == 0) {
        try (Cursor cnt = cr.query(base, new String[] {MediaStore.Audio.Media._ID}, where, whereArgs, null)) {
          result.put("total", cnt == null ? 0 : cnt.getCount());
        }
      }
      call.resolve(result);
    } catch (SecurityException e) {
      call.reject("permission");
    } catch (Exception e) {
      call.reject(String.valueOf(e.getMessage()));
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Details MediaStore does not have

  /** {uris:[...]} -> {results:[{uri, sampleRate, channels, bitDepth, container, trackGain, ...}]} */
  @PluginMethod
  public void probeFiles(PluginCall call) {
    JSONArray uris = call.getArray("uris");
    if (uris == null) {
      call.reject("uris is required");
      return;
    }
    Context ctx = getContext();
    JSArray results = new JSArray();
    for (int i = 0; i < uris.length(); i++) {
      String s = uris.optString(i);
      JSObject r = new JSObject();
      r.put("uri", s);
      try {
        Uri u = Uri.parse(s);
        SourceProbe p = SourceProbe.probe(ctx, u, 0);
        r.put("sampleRate", p.sampleRate);
        r.put("channels", p.channels);
        r.put("bitDepth", p.bitDepth);
        r.put("container", p.container);
        r.put("mime", p.mime);
        if ("flac".equals(p.container)) {
          FlacTags t = FlacTags.read(ctx, u);
          r.put("trackGain", t.trackGain);
          r.put("albumGain", t.albumGain);
          r.put("isrc", t.isrc);
          r.put("lyrics", t.lyrics);
          r.put("albumArtist", t.albumArtist);
          r.put("composer", t.composer);
          r.put("genre", t.genre);
          r.put("discNumber", t.discNumber);
        }
      } catch (Exception e) {
        r.put("error", String.valueOf(e.getMessage()));
      }
      results.put(r);
    }
    JSObject out = new JSObject();
    out.put("results", results);
    call.resolve(out);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Cover art

  private static String safeName(String key) {
    return key.replaceAll("[^A-Za-z0-9._-]", "_");
  }

  /** {uri, key, size?} -> {path} of a cached JPEG (the same file for every song with the same key), or {} when none. */
  @PluginMethod
  public void getArtwork(PluginCall call) {
    final String uriStr = call.getString("uri");
    final String key = call.getString("key");
    final int size = Math.max(64, Math.min(1200, call.getInt("size", 600)));
    if (uriStr == null || key == null) {
      call.reject("uri and key are required");
      return;
    }
    Context ctx = getContext();
    File dir = new File(ctx.getCacheDir(), "art");
    if (!dir.exists() && !dir.mkdirs()) {
      call.reject("cache folder unavailable");
      return;
    }
    File out = new File(dir, safeName(key) + ".jpg");
    File none = new File(dir, safeName(key) + ".none");
    JSObject res = new JSObject();
    if (out.length() > 0) {
      res.put("path", out.getAbsolutePath());
      call.resolve(res);
      return;
    }
    if (none.exists()) {
      call.resolve(res);
      return;
    }
    Uri uri = Uri.parse(uriStr);
    Bitmap bmp = null;
    MediaMetadataRetriever mmr = new MediaMetadataRetriever();
    try {
      mmr.setDataSource(ctx, uri);
      byte[] pic = mmr.getEmbeddedPicture();
      if (pic != null && pic.length > 0) bmp = decodeScaled(pic, size);
    } catch (Exception ignored) {
      // fall through to the folder / thumbnail lookup
    } finally {
      try {
        mmr.release();
      } catch (Exception ignored) {
        // nothing to do
      }
    }
    if (bmp == null && Build.VERSION.SDK_INT >= 29) {
      try {
        // Android's own album art: also finds a cover.jpg / folder.jpg next to the song.
        bmp = ctx.getContentResolver().loadThumbnail(uri, new Size(size, size), null);
      } catch (Exception ignored) {
        // no cover
      }
    }
    try {
      if (bmp == null) {
        //noinspection ResultOfMethodCallIgnored
        none.createNewFile();
        call.resolve(res);
        return;
      }
      try (FileOutputStream fos = new FileOutputStream(out)) {
        bmp.compress(Bitmap.CompressFormat.JPEG, 88, fos);
      }
      res.put("path", out.getAbsolutePath());
      call.resolve(res);
    } catch (Exception e) {
      call.reject(String.valueOf(e.getMessage()));
    }
  }

  private static Bitmap decodeScaled(byte[] data, int target) {
    BitmapFactory.Options bounds = new BitmapFactory.Options();
    bounds.inJustDecodeBounds = true;
    BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
    int longest = Math.max(bounds.outWidth, bounds.outHeight);
    int sample = 1;
    while (longest / (sample * 2) >= target) sample *= 2;
    BitmapFactory.Options opts = new BitmapFactory.Options();
    opts.inSampleSize = sample;
    return BitmapFactory.decodeByteArray(data, 0, data.length, opts);
  }

  /** Forget cached covers (after a rescan that changed a lot). */
  @PluginMethod
  public void clearArtworkCache(PluginCall call) {
    File dir = new File(getContext().getCacheDir(), "art");
    File[] files = dir.listFiles();
    if (files != null) {
      for (File f : files) {
        //noinspection ResultOfMethodCallIgnored
        f.delete();
      }
    }
    call.resolve();
  }
}
