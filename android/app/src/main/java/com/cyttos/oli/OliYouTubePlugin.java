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
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import org.json.JSONArray;
import org.json.JSONObject;
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
  /** Six worker threads at most; how many may run yt-dlp at once is {@link #SLOTS} (the owner's setting, 1 to 6). */
  private static final ExecutorService DOWNLOADS = Executors.newFixedThreadPool(6);
  private static final ScheduledExecutorService WATCHDOG = Executors.newSingleThreadScheduledExecutor();
  /** yt-dlp is a whole Python program: the number that run at once is a setting (Settings > Downloads). */
  private static final class Slots extends Semaphore {
    Slots(int permits) {
      super(permits, true);
    }

    void shrink(int by) {
      reducePermits(by);
    }
  }

  private static final Slots SLOTS = new Slots(2);
  /**
   * Questions (search, playlist, stream address of the song about to play) have their own slots: they used to share the
   * download slots, so a running download queue made every tap on a YouTube song wait until a download finished.
   */
  private static final Semaphore ASK_SLOTS = new Semaphore(3, true);
  /** The client that answered the last stream question: asked first next time (a client that keeps failing costs seconds per song). */
  private static volatile String lastGoodStreamClient = "visionos";
  private static int slotLimit = 2;

  /** {count: 1..6} - how many YouTube downloads run at the same time. */
  @PluginMethod
  public void setConcurrency(PluginCall call) {
    int n = Math.max(1, Math.min(6, call.getInt("count", 2)));
    synchronized (SLOTS) {
      if (n > slotLimit) SLOTS.release(n - slotLimit);
      else if (n < slotLimit) SLOTS.shrink(slotLimit - n);
      slotLimit = n;
    }
    call.resolve();
  }
  private static boolean ready = false;

  private final Map<String, DownloadTask> tasks = new ConcurrentHashMap<>();
  private final Map<String, DownloadTask> known = new ConcurrentHashMap<>();

  @Override
  public void load() {
    // the download notification counts these together with the engine's downloads
    OliDownloadService.externalCount = tasks::size;
  }

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
    // the clients the PC gets its videos from: their addresses are served whole (the default web ones stop after about 12 MB)
    else if ("visionos".equals(which)) r.addOption("--extractor-args", "youtube:player_client=visionos");
    else if ("tvs".equals(which)) r.addOption("--extractor-args", "youtube:player_client=tv_simply");
  }

  private interface Builder {
    void build(YoutubeDLRequest r);
  }

  /** Runs yt-dlp once per client until one answers; returns its stdout. */
  /** Looks at a client's answer and returns null when it is good, else why it is not (the next client is then tried). */
  private interface Check {
    String problem(String out);
  }

  private void ask(PluginCall call, String target, String[] clients, long timeoutMs, Builder b) {
    ask(call, target, clients, timeoutMs, b, null);
  }

  private void ask(PluginCall call, String target, String[] clients, long timeoutMs, Builder b, Check check) {
    final Context ctx = getContext();
    WORK.execute(() -> {
      String lastError = "yt-dlp gave no answer";
      StringBuilder reasons = new StringBuilder();
      boolean acquired = false;
      try {
        ensureInit(ctx);
        ASK_SLOTS.acquire();
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
              String bad = check == null ? null : check.problem(resp.getOut());
              if (bad != null) {
                reasons.append(c).append(": ").append(bad).append("; ");
                continue;
              }
              JSObject o = new JSObject();
              o.put("json", resp.getOut());
              o.put("client", c);
              if (clients.length == 4) lastGoodStreamClient = c;
              call.resolve(o);
              return;
            }
          } catch (Exception e) {
            lastError = c + ": " + e.getMessage();
            reasons.append(lastError).append("; ");
          } finally {
            dog.cancel(false);
          }
        }
        String why = reasons.length() > 0 ? reasons.toString() : lastError;
        call.reject(why.length() > 900 ? why.substring(0, 900) : why);
      } catch (Exception e) {
        call.reject(String.valueOf(e.getMessage()));
      } finally {
        if (acquired) ASK_SLOTS.release();
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

  /** default, embed, vr - with the client that worked last time first. */
  private static String[] streamClients() {
    String first = lastGoodStreamClient;
    java.util.List<String> order = new java.util.ArrayList<>();
    order.add(first);
    // the PC's client first (its addresses can be seeked anywhere), then the rest; four entries marks a song question
    for (String c : new String[] {"visionos", "default", "embed", "vr"}) if (!c.equals(first)) order.add(c);
    return order.toArray(new String[0]);
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
    // the video page plays the addresses in the web view (like the PC window): the plain client, not the phone-only ones
    final boolean video = Boolean.TRUE.equals(call.getBoolean("video", false));
    ask(call, "https://www.youtube.com/watch?v=" + id,
        video ? VIDEO_CLIENTS : streams ? streamClients() : new String[] {"default", "embed"},
        video ? 40000 : streams ? 30000 : 60000, (r) -> {
          r.addOption("--no-playlist");
          r.addOption("--skip-download");
          r.addOption("-j");
        }, video ? (out) -> videoProblem(out, 0) : streams ? (out) -> audioProblem(out) : null);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Does this client's video really download? YouTube answers some clients with addresses that then refuse (403) once the
  // file gets big; the picture streams are the ones that fail, so one is fetched here (start and middle) before it is used.

  private static final String[] VIDEO_CLIENTS = {"visionos", "default", "vr", "tvs", "embed"};

  private static final java.util.Set<String> SAFE_HEADERS =
      new java.util.HashSet<>(java.util.Arrays.asList("user-agent", "accept", "accept-language", "referer", "origin"));

  private static void addHeaders(Map<String, String> into, JSONObject h) {
    if (h == null) return;
    java.util.Iterator<String> keys = h.keys();
    while (keys.hasNext()) {
      String k = keys.next();
      if (SAFE_HEADERS.contains(k.toLowerCase(java.util.Locale.ROOT))) into.put(k, h.optString(k));
    }
  }

  private static int fetchStatus(String url, Map<String, String> headers, long from) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(url).openConnection();
      c.setConnectTimeout(12000);
      c.setReadTimeout(12000);
      c.setInstanceFollowRedirects(true);
      for (Map.Entry<String, String> e : headers.entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
      c.setRequestProperty("Range", "bytes=" + from + "-" + (from + 4095));
      int code = c.getResponseCode();
      if (code == 200 || code == 206) {
        byte[] buf = new byte[4096];
        //noinspection ResultOfMethodCallIgnored
        c.getInputStream().read(buf);
      }
      return code;
    } catch (Exception e) {
      return -1;
    } finally {
      if (c != null) c.disconnect();
    }
  }

  /** null when the sharpest picture stream (up to 1080p, or up to maxHeight) can be fetched, else the reason. */
  private static String videoProblem(String json, int maxHeight) {
    try {
      JSONObject info = new JSONObject(json.trim());
      JSONArray formats = info.optJSONArray("formats");
      if (formats == null) return "no formats";
      int cap = maxHeight > 0 ? maxHeight : 1080;
      JSONObject best = null;
      for (int i = 0; i < formats.length(); i++) {
        JSONObject f = formats.getJSONObject(i);
        String url = f.optString("url", "");
        String vc = f.optString("vcodec", "none");
        int h = f.optInt("height", 0);
        String proto = f.optString("protocol", "");
        if (!url.startsWith("http") || "none".equals(vc) || h <= 0 || h > cap || proto.startsWith("m3u8")) continue;
        boolean noAudio = "none".equals(f.optString("acodec", "none"));
        if (best == null || h > best.optInt("height", 0) || (h == best.optInt("height", 0) && noAudio)) best = f;
      }
      if (best == null) return "no picture streams";
      Map<String, String> headers = new HashMap<>();
      addHeaders(headers, info.optJSONObject("http_headers"));
      addHeaders(headers, best.optJSONObject("http_headers"));
      String url = best.getString("url");
      int start = fetchStatus(url, headers, 0);
      if (start != 200 && start != 206) return best.optInt("height") + "p refused (HTTP " + start + ")";
      long size = best.optLong("filesize", best.optLong("filesize_approx", 0));
      if (size > 16_000_000L) {
        int mid = fetchStatus(url, headers, 12_000_000L);
        if (mid != 200 && mid != 206) return best.optInt("height") + "p refused in the middle (HTTP " + mid + ")";
      }
      return null;
    } catch (Exception e) {
      return "unreadable answer";
    }
  }

  /** null when the best audio stream can be fetched from the middle too (a seek asks for a later part of the file), else why not. */
  private static String audioProblem(String json) {
    try {
      JSONObject info = new JSONObject(json.trim());
      JSONArray formats = info.optJSONArray("formats");
      if (formats == null) return "no formats";
      JSONObject best = null;
      for (int i = 0; i < formats.length(); i++) {
        JSONObject f = formats.getJSONObject(i);
        String url = f.optString("url", "");
        if (!url.startsWith("http") || !"none".equals(f.optString("vcodec", "none")) || "none".equals(f.optString("acodec", "none"))) continue;
        if (f.optString("protocol", "").startsWith("m3u8")) continue;
        boolean m4a = "m4a".equals(f.optString("ext"));
        if (best == null || (m4a && !"m4a".equals(best.optString("ext")))) best = f;
      }
      if (best == null) return "no audio streams";
      Map<String, String> headers = new HashMap<>();
      addHeaders(headers, info.optJSONObject("http_headers"));
      addHeaders(headers, best.optJSONObject("http_headers"));
      String url = best.getString("url");
      int start = fetchStatus(url, headers, 0);
      if (start != 200 && start != 206) return "audio refused (HTTP " + start + ")";
      long size = best.optLong("filesize", best.optLong("filesize_approx", 0));
      long at = size > 3_000_000L ? size / 2 : 2_500_000L;
      int mid = fetchStatus(url, headers, at);
      if (mid != 200 && mid != 206 && mid != 416) return "audio refused when seeking (HTTP " + mid + ")";
      return null;
    } catch (Exception e) {
      return "unreadable answer";
    }
  }

  /** The first client whose picture streams download, or null (the reasons are appended to why). */
  private String pickVideoClient(DownloadTask t, StringBuilder why) {
    for (String c : VIDEO_CLIENTS) {
      String pid = "vp-" + t.id + "-" + c;
      try {
        YoutubeDLRequest req = new YoutubeDLRequest("https://www.youtube.com/watch?v=" + t.videoId);
        common(req);
        client(req, c);
        req.addOption("--no-playlist");
        req.addOption("--skip-download");
        req.addOption("-j");
        ScheduledFuture<?> dog = WATCHDOG.schedule(() -> YoutubeDL.INSTANCE.destroyProcessById(pid), 45000, TimeUnit.MILLISECONDS);
        try {
          YoutubeDLResponse resp = YoutubeDL.INSTANCE.execute(req, pid);
          String out = resp.getOut();
          if (out == null || out.trim().isEmpty()) {
            why.append(c).append(": no answer; ");
            continue;
          }
          String bad = videoProblem(out, t.height);
          if (bad == null) return c;
          why.append(c).append(": ").append(bad).append("; ");
        } finally {
          dog.cancel(false);
        }
      } catch (Exception e) {
        why.append(c).append(": ").append(e.getMessage()).append("; ");
        if (t.cancel || t.pause) return null;
      }
    }
    return null;
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
    OliDownloadService.externalState(id, state);
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
      // the PC's client first; every failure is kept so the message says what each one answered
      String[] clients = VIDEO_CLIENTS;
      StringBuilder allErrors = new StringBuilder();
      if ("video".equals(t.mode)) {
        StringBuilder why = new StringBuilder();
        String good = pickVideoClient(t, why);
        if (good == null) {
          tasks.remove(t.id);
          if (t.cancel) {
            deleteLeftovers(t);
            emit(t.id, "canceled", "", "", 0, 0);
          } else if (t.pause) {
            emit(t.id, "paused", "", "", 0, 0);
          } else {
            String m = "YouTube refuses the picture of this video on this phone (" + why + ")";
            emit(t.id, "failed", m.length() > 700 ? m.substring(0, 700) : m, "", 0, 0);
          }
          return;
        }
        clients = new String[] {good};
      }
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
              OliDownloadService.externalProgress(t.id, p.downloadedBytes, p.totalBytes);
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
          String msg = String.valueOf(e.getMessage()).replaceAll("\\s+", " ");
          allErrors.append(clients[attempt]).append(": ").append(msg.length() > 110 ? msg.substring(0, 110) : msg).append("; ");
          lastError = allErrors.toString();
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
        emit(t.id, "failed", lastError.length() > 700 ? lastError.substring(0, 700) : lastError, "", 0, 0);
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
    // YouTube throttles or cuts one long request; asking in 10 MB pieces keeps big files (videos) going to the end
    r.addOption("--http-chunk-size", "10M");
    r.addOption("-o", new File(root(), t.relBase).getAbsolutePath() + ".%(ext)s");
    if ("video".equals(t.mode)) {
      String h = t.height > 0 ? "[height<=" + t.height + "]" : "";
      String audioSel = "opus".equals(t.audio) ? "ba[ext=webm]" : "ba[ext=m4a]";
      // h264 (mp4) first: it merges into mp4 without conversion on every phone
      r.addOption("-f", "bv*[ext=mp4]" + h + "+" + audioSel + "/bv*" + h + "+" + audioSel + "/bv*" + h + "+ba/b" + h + "/bv*+ba/b");
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
