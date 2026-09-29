package com.cyttos.oli;

import android.content.Context;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.YoutubeDLResponse;

import java.io.File;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * YouTube on the phone: runs yt-dlp (Python, packaged by the youtubedl-android library) for searching, listing
 * playlists, resolving stream addresses, and downloading songs / videos. The plugin only builds the yt-dlp command and
 * returns yt-dlp's own JSON; the screen (youtubeCore.ts) reads that JSON with the same rules as the PC app.
 *
 * Only YouTube addresses are accepted and only the options built here are used, so the page cannot make yt-dlp run
 * arbitrary commands.
 */
@CapacitorPlugin(name = "OliYouTube")
public class OliYouTubePlugin extends Plugin {
  private static final Pattern VIDEO_ID = Pattern.compile("^[\\w-]{11}$");
  private static final Pattern YT_URL = Pattern.compile("^https://(www\\.|m\\.|music\\.)?(youtube\\.com|youtu\\.be)/.+");
  private static final ExecutorService WORK = Executors.newCachedThreadPool();
  private static final ExecutorService DOWNLOADS = Executors.newFixedThreadPool(2);
  private static final ScheduledExecutorService WATCHDOG = Executors.newSingleThreadScheduledExecutor();
  /** yt-dlp is a whole Python program: never more than three at once. */
  private static final Semaphore SLOTS = new Semaphore(3);
  private static boolean ready = false;

  private final Map<String, DownloadTask> tasks = new ConcurrentHashMap<>();
  private final Map<String, DownloadTask> known = new ConcurrentHashMap<>();

  private File root() {
    Context ctx = getContext();
    File dir = ctx.getExternalFilesDir(null);
    return dir != null ? dir : ctx.getFilesDir();
  }

  private static synchronized void ensureInit(Context ctx) throws Exception {
    if (ready) return;
    YoutubeDL.INSTANCE.init(ctx);
    ready = true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Engine

  /** Starts the engine (the first start unpacks Python, a few seconds) and reports its version. */
  @PluginMethod
  public void status(PluginCall call) {
    final Context ctx = getContext();
    WORK.execute(() -> {
      JSObject o = new JSObject();
      try {
        ensureInit(ctx);
        o.put("ready", true);
        String v = YoutubeDL.INSTANCE.version(ctx);
        o.put("version", v == null ? "" : v);
        String vn = YoutubeDL.INSTANCE.versionName(ctx);
        o.put("versionName", vn == null ? "" : vn);
      } catch (Exception e) {
        o.put("ready", false);
        o.put("error", String.valueOf(e.getMessage()));
      }
      call.resolve(o);
    });
  }

  /** Installs the newest yt-dlp release (the library downloads it from GitHub and replaces its own copy). */
  @PluginMethod
  public void updateEngine(PluginCall call) {
    final Context ctx = getContext();
    final String channel = call.getString("channel", "stable");
    WORK.execute(() -> {
      JSObject o = new JSObject();
      try {
        ensureInit(ctx);
        YoutubeDL.UpdateChannel ch = "nightly".equals(channel) ? YoutubeDL.UpdateChannel._NIGHTLY : YoutubeDL.UpdateChannel._STABLE;
        YoutubeDL.UpdateStatus st = YoutubeDL.INSTANCE.updateYoutubeDL(ctx, ch);
        o.put("status", st == null ? "UNKNOWN" : st.name());
        String v = YoutubeDL.INSTANCE.version(ctx);
        o.put("version", v == null ? "" : v);
        call.resolve(o);
      } catch (Exception e) {
        call.reject(String.valueOf(e.getMessage()));
      }
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Questions (search, playlist, video info, stream addresses): yt-dlp's JSON goes back to the screen

  private static void common(YoutubeDLRequest r) {
    r.addOption("-4");
    r.addOption("--retries", "10");
    r.addOption("--file-access-retries", "10");
    r.addOption("--extractor-retries", "5");
    r.addOption("--no-warnings");
    r.addOption("--no-progress");
    r.addOption("--socket-timeout", "20");
  }

  private static void client(YoutubeDLRequest r, String which) {
    if ("embed".equals(which)) r.addOption("--extractor-args", "youtube:player_client=web_embedded");
    else if ("vr".equals(which)) r.addOption("--extractor-args", "youtube:player_client=android_vr");
  }

  private interface Builder {
    void build(YoutubeDLRequest r);
  }

  /** Runs yt-dlp once per client until one answers; returns its stdout. */
  private void ask(PluginCall call, String target, String[] clients, long timeoutMs, Builder b) {
    final Context ctx = getContext();
    WORK.execute(() -> {
      String lastError = "yt-dlp gave no answer";
      boolean acquired = false;
      try {
        ensureInit(ctx);
        SLOTS.acquire();
        acquired = true;
        for (String c : clients) {
          final String pid = "q-" + System.nanoTime();
          YoutubeDLRequest req = new YoutubeDLRequest(target);
          common(req);
          client(req, c);
          b.build(req);
          ScheduledFuture<?> dog =
              WATCHDOG.schedule(() -> YoutubeDL.INSTANCE.destroyProcessById(pid), timeoutMs, TimeUnit.MILLISECONDS);
          try {
            YoutubeDLResponse resp = YoutubeDL.INSTANCE.execute(req, pid);
            if (resp.getOut() != null && !resp.getOut().trim().isEmpty()) {
              JSObject o = new JSObject();
              o.put("json", resp.getOut());
              o.put("client", c);
              call.resolve(o);
              return;
            }
          } catch (Exception e) {
            lastError = String.valueOf(e.getMessage());
          } finally {
            dog.cancel(false);
          }
        }
        call.reject(lastError.length() > 600 ? lastError.substring(0, 600) : lastError);
      } catch (Exception e) {
        call.reject(String.valueOf(e.getMessage()));
      } finally {
        if (acquired) SLOTS.release();
      }
    });
  }

  /** {query, count?} -> {json} of `ytsearchN:query` (flat listing). */
  @PluginMethod
  public void search(PluginCall call) {
    String q = call.getString("query", "").trim();
    if (q.isEmpty() || q.length() > 200) {
      call.reject("empty or too long search text");
      return;
    }
    int count = Math.max(1, Math.min(30, call.getInt("count", 20)));
    ask(call, "ytsearch" + count + ":" + q, new String[] {"default", "embed"}, 60000, (r) -> {
      r.addOption("--flat-playlist");
      r.addOption("-J");
    });
  }

  /** {url, limit} -> {json} of a flat playlist listing. */
  @PluginMethod
  public void playlist(PluginCall call) {
    String url = call.getString("url", "");
    if (!YT_URL.matcher(url).matches()) {
      call.reject("not a YouTube address");
      return;
    }
    final int limit = Math.max(1, Math.min(300, call.getInt("limit", 200)));
    ask(call, url, new String[] {"default", "embed"}, 120000, (r) -> {
      r.addOption("--flat-playlist");
      r.addOption("--playlist-end", String.valueOf(limit + 1));
      r.addOption("-J");
    });
  }

  /** {videoId, streams?} -> {json} of one video's full description (all formats, with their addresses). */
  @PluginMethod
  public void info(PluginCall call) {
    String id = call.getString("videoId", "");
    if (!VIDEO_ID.matcher(id).matches()) {
      call.reject("invalid video id");
      return;
    }
    final boolean streams = Boolean.TRUE.equals(call.getBoolean("streams", false));
    ask(call, "https://www.youtube.com/watch?v=" + id,
        streams ? new String[] {"default", "embed", "vr"} : new String[] {"default", "embed"}, 60000, (r) -> {
          r.addOption("--no-playlist");
          r.addOption("--skip-download");
          r.addOption("-j");
        });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Downloads (same events as OliDownload: dlProgress / dlState)

  private static final class DownloadTask {
    String id;
    String videoId;
    String mode; // song | video
    String audio; // best | m4a | opus
    int height;
    String relBase; // path below the app folder, without extension
    String title = "";
    String artist = "";
    String album = "";
    volatile boolean pause;
    volatile boolean cancel;
    volatile String processId = "";
  }

  private File[] filesOf(DownloadTask t) {
    File base = new File(root(), t.relBase);
    File dir = base.getParentFile();
    final String stem = base.getName();
    if (dir == null || !dir.exists()) return new File[0];
    File[] all = dir.listFiles((d, name) -> name.startsWith(stem + "."));
    return all == null ? new File[0] : all;
  }

  private static boolean isPartial(String name) {
    return name.endsWith(".part") || name.endsWith(".ytdl") || name.endsWith(".temp") || name.contains(".part-");
  }

  private void emit(String id, String state, String error, String path, long size, long bytes) {
    JSObject o = new JSObject();
    o.put("id", id);
    o.put("state", state);
    o.put("error", error == null ? "" : error);
    o.put("path", path == null || path.isEmpty() ? "" : "file://" + path);
    o.put("size", size);
    o.put("md5", "");
    o.put("tagged", "completed".equals(state));
    o.put("tagNote", "");
    o.put("bytes", bytes);
    notifyListeners("dlState", o);
  }

  /**
   * {id, videoId, mode: song|video, audio?, height?, relBase, title?, artist?, album?}. A song is the best audio
   * stream (m4a preferred) with title / artist / album and the thumbnail as cover embedded by yt-dlp's ffmpeg; a video
   * is downloaded and merged into an mp4 of at most the given height.
   */
  @PluginMethod
  public void enqueue(PluginCall call) {
    DownloadTask t = new DownloadTask();
    t.id = call.getString("id", "");
    t.videoId = call.getString("videoId", "");
    t.mode = "video".equals(call.getString("mode", "song")) ? "video" : "song";
    t.audio = call.getString("audio", "best");
    t.height = call.getInt("height", 0);
    t.relBase = call.getString("relBase", "");
    t.title = call.getString("title", "");
    t.artist = call.getString("artist", "");
    t.album = call.getString("album", "");
    if (t.id.isEmpty() || !VIDEO_ID.matcher(t.videoId).matches() || t.relBase.isEmpty() || t.relBase.contains("..")) {
      call.reject("id, videoId and relBase are required");
      return;
    }
    if (tasks.containsKey(t.id)) {
      call.resolve();
      return;
    }
    known.put(t.id, t);
    tasks.put(t.id, t);
    OliDownloadService.ensureRunning(getContext());
    emit(t.id, "queued", "", "", 0, 0);
    DOWNLOADS.execute(() -> runDownload(t));
    call.resolve();
  }

  @PluginMethod
  public void pause(PluginCall call) {
    DownloadTask t = tasks.get(call.getString("id", ""));
    if (t != null) {
      t.pause = true;
      YoutubeDL.INSTANCE.destroyProcessById(t.processId);
    }
    call.resolve();
  }

  @PluginMethod
  public void resume(PluginCall call) {
    DownloadTask t = known.get(call.getString("id", ""));
    if (t != null && !tasks.containsKey(t.id)) {
      t.pause = false;
      t.cancel = false;
      tasks.put(t.id, t);
      OliDownloadService.ensureRunning(getContext());
      emit(t.id, "queued", "", "", 0, 0);
      DOWNLOADS.execute(() -> runDownload(t));
    }
    call.resolve();
  }

  @PluginMethod
  public void cancel(PluginCall call) {
    String id = call.getString("id", "");
    DownloadTask t = tasks.get(id);
    if (t == null) t = known.get(id);
    if (t != null) {
      t.cancel = true;
      YoutubeDL.INSTANCE.destroyProcessById(t.processId);
      if (!tasks.containsKey(t.id)) deleteLeftovers(t);
    }
    call.resolve();
  }

  @PluginMethod
  public void getActive(PluginCall call) {
    JSArray ids = new JSArray();
    for (String id : tasks.keySet()) ids.put(id);
    JSObject o = new JSObject();
    o.put("ids", ids);
    call.resolve(o);
  }

  private void deleteLeftovers(DownloadTask t) {
    for (File f : filesOf(t)) {
      if (isPartial(f.getName())) {
        //noinspection ResultOfMethodCallIgnored
        f.delete();
      }
    }
  }

  private void runDownload(DownloadTask t) {
    boolean slot = false;
    try {
      ensureInit(getContext());
      SLOTS.acquire();
      slot = true;
      if (t.cancel) {
        tasks.remove(t.id);
        deleteLeftovers(t);
        emit(t.id, "canceled", "", "", 0, 0);
        return;
      }
      if (t.pause) {
        tasks.remove(t.id);
        emit(t.id, "paused", "", "", 0, 0);
        return;
      }
      emit(t.id, "downloading", "", "", 0, 0);
      String lastError = "Download failed";
      String[] clients = {"default", "embed"};
      for (int attempt = 0; attempt < clients.length; attempt++) {
        t.processId = "dl-" + t.id + "-" + attempt;
        YoutubeDLRequest req = new YoutubeDLRequest("https://www.youtube.com/watch?v=" + t.videoId);
        buildDownload(req, t, clients[attempt]);
        final long[] lastEmit = {0};
        try {
          YoutubeDL.INSTANCE.execute(req, t.processId, false, (Float pct, Long eta, String line) -> {
            YtDlpOutput.Progress p = YtDlpOutput.parse(line);
            long now = System.currentTimeMillis();
            if (p != null && now - lastEmit[0] > 250) {
              lastEmit[0] = now;
              JSObject o = new JSObject();
              o.put("id", t.id);
              o.put("bytes", p.downloadedBytes);
              o.put("total", p.totalBytes);
              o.put("speed", p.bytesPerSecond);
              notifyListeners("dlProgress", o);
            }
            return kotlin.Unit.INSTANCE;
          });
          File done = finished(t);
          tasks.remove(t.id);
          if (done == null) {
            emit(t.id, "failed", "yt-dlp finished but the file was not found", "", 0, 0);
          } else {
            emit(t.id, "completed", "", done.getAbsolutePath(), done.length(), done.length());
          }
          return;
        } catch (YoutubeDL.CanceledException e) {
          lastError = "canceled";
          break;
        } catch (Exception e) {
          lastError = String.valueOf(e.getMessage());
          if (t.cancel || t.pause) break;
        }
      }
      tasks.remove(t.id);
      if (t.cancel) {
        deleteLeftovers(t);
        emit(t.id, "canceled", "", "", 0, 0);
      } else if (t.pause) {
        emit(t.id, "paused", "", "", 0, 0);
      } else {
        emit(t.id, "failed", lastError.length() > 500 ? lastError.substring(0, 500) : lastError, "", 0, 0);
      }
    } catch (Exception e) {
      tasks.remove(t.id);
      emit(t.id, "failed", String.valueOf(e.getMessage()), "", 0, 0);
    } finally {
      if (slot) SLOTS.release();
    }
  }

  private void buildDownload(YoutubeDLRequest r, DownloadTask t, String client) {
    common(r);
    client(r, client);
    r.addOption("--no-playlist");
    r.addOption("--newline");
    r.addOption("--progress");
    r.addOption("--no-mtime");
    r.addOption("--fragment-retries", "10");
    r.addOption("-o", new File(root(), t.relBase).getAbsolutePath() + ".%(ext)s");
    if ("video".equals(t.mode)) {
      String h = t.height > 0 ? "[height<=" + t.height + "]" : "";
      String audioSel = "opus".equals(t.audio) ? "ba[ext=webm]" : "ba[ext=m4a]";
      r.addOption("-f", "bv*" + h + "+" + audioSel + "/bv*" + h + "+ba/b" + h + "/bv*+ba/b");
      r.addOption("--merge-output-format", "mp4");
    } else {
      r.addOption("-f", "opus".equals(t.audio) ? "ba[ext=webm]/ba" : "ba[ext=m4a]/ba");
      r.addOption("--embed-metadata");
      r.addOption("--embed-thumbnail");
      r.addOption("--convert-thumbnails", "jpg");
      if (!t.title.isEmpty()) r.addOption("--parse-metadata", YtDlpOutput.metadataLiteral(t.title) + ":%(meta_title)s");
      if (!t.artist.isEmpty()) r.addOption("--parse-metadata", YtDlpOutput.metadataLiteral(t.artist) + ":%(meta_artist)s");
      if (!t.album.isEmpty()) r.addOption("--parse-metadata", YtDlpOutput.metadataLiteral(t.album) + ":%(meta_album)s");
    }
  }

  /** The finished file: the newest file with the download's name that is not a partial or picture leftover. */
  private File finished(DownloadTask t) {
    File best = null;
    for (File f : filesOf(t)) {
      String n = f.getName().toLowerCase(java.util.Locale.ROOT);
      if (isPartial(n) || n.endsWith(".jpg") || n.endsWith(".webp") || n.endsWith(".png") || n.endsWith(".json")) continue;
      if (best == null || f.lastModified() > best.lastModified()) best = f;
    }
    return best;
  }
}
