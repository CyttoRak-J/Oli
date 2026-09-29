package com.cyttos.oli;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The download queue's engine: a few files at a time, each written to "name.part" first so an interrupted download
 * carries on where it stopped (HTTP Range), pause / resume / cancel, MD5 and size checks, and tags + cover written into
 * the finished file. Plain Java (no Android classes) so it is tested on a PC against a local server.
 */
final class DownloadEngine {
  static final String QUEUED = "queued";
  static final String DOWNLOADING = "downloading";
  static final String PAUSED = "paused";
  static final String COMPLETED = "completed";
  static final String FAILED = "failed";
  static final String CANCELED = "canceled";

  static final class Spec {
    String id;
    String url;
    File dest;
    /** Expected size in bytes (0 = unknown). */
    long size;
    /** Expected MD5 as hex ("" = not checked). */
    String md5 = "";
    Map<String, String> headers = new ConcurrentHashMap<>();
    /** Tags to write into the finished file (null = none). */
    TagFields tags;
    /** Cover picture to download and embed (null = none). */
    String coverUrl;
  }

  static final class Result {
    String state;
    String error = "";
    String path = "";
    long size;
    String md5 = "";
    boolean tagged;
    String tagNote = "";
    long bytes;
    long total;
  }

  interface Listener {
    void onProgress(String id, long bytes, long total, long bytesPerSecond);

    void onState(String id, Result r);
  }

  private final ExecutorService pool;
  private final Map<String, Spec> specs = new ConcurrentHashMap<>();
  private final Map<String, Task> tasks = new ConcurrentHashMap<>();
  private final List<Listener> listeners = new CopyOnWriteArrayList<>();
  private final int retries;

  DownloadEngine(int parallel, int retries) {
    this.pool = Executors.newFixedThreadPool(Math.max(1, parallel), (r) -> {
      Thread t = new Thread(r, "oli-download");
      t.setDaemon(true);
      return t;
    });
    this.retries = Math.max(0, retries);
  }

  void addListener(Listener l) {
    listeners.add(l);
  }

  void removeListener(Listener l) {
    listeners.remove(l);
  }

  /** Number of downloads that are waiting or running. */
  int activeCount() {
    return tasks.size();
  }

  private final class Task implements Runnable {
    final Spec spec;
    volatile boolean pause;
    volatile boolean cancel;
    volatile boolean running;

    Task(Spec spec) {
      this.spec = spec;
    }

    @Override
    public void run() {
      running = true;
      try {
        execute(this);
      } finally {
        running = false;
        tasks.remove(spec.id, this);
      }
    }
  }

  /** Adds a download (or resumes one that was paused / failed: the .part file is kept and continued). */
  void enqueue(Spec spec) {
    Task old = tasks.get(spec.id);
    if (old != null) return; // already waiting or running
    specs.put(spec.id, spec);
    Task t = new Task(spec);
    tasks.put(spec.id, t);
    Result r = new Result();
    r.state = QUEUED;
    emit(spec.id, r);
    pool.execute(t);
  }

  void pause(String id) {
    Task t = tasks.get(id);
    if (t != null) t.pause = true;
  }

  void resume(String id) {
    Spec s = specs.get(id);
    if (s != null) enqueue(s);
  }

  /** Stops the download and deletes what was downloaded so far. */
  void cancel(String id) {
    Task t = tasks.get(id);
    Spec s = specs.get(id);
    if (t != null) {
      t.cancel = true;
      if (!t.running) {
        // still waiting in the queue: finish it here
        if (tasks.remove(id, t) && s != null) {
          deletePart(s);
          Result r = new Result();
          r.state = CANCELED;
          emit(id, r);
        }
      }
      return;
    }
    if (s != null) {
      deletePart(s);
      Result r = new Result();
      r.state = CANCELED;
      emit(id, r);
    }
    specs.remove(id);
  }

  /** Forget a finished download's spec. */
  void forget(String id) {
    if (!tasks.containsKey(id)) specs.remove(id);
  }

  void shutdown() {
    pool.shutdownNow();
  }

  private void emit(String id, Result r) {
    for (Listener l : listeners) {
      try {
        l.onState(id, r);
      } catch (RuntimeException ignored) {
        // a broken listener must not stop the download
      }
    }
  }

  private void progress(String id, long bytes, long total, long speed) {
    for (Listener l : listeners) {
      try {
        l.onProgress(id, bytes, total, speed);
      } catch (RuntimeException ignored) {
        // ignore
      }
    }
  }

  private static File partOf(Spec s) {
    return new File(s.dest.getPath() + ".part");
  }

  private static void deletePart(Spec s) {
    //noinspection ResultOfMethodCallIgnored
    partOf(s).delete();
  }

  // ---------------------------------------------------------------------------------------------------------------

  private void execute(Task task) {
    Spec s = task.spec;
    if (task.cancel) {
      deletePart(s);
      Result r = new Result();
      r.state = CANCELED;
      emit(s.id, r);
      return;
    }
    if (task.pause) {
      Result r = new Result();
      r.state = PAUSED;
      r.bytes = partOf(s).length();
      emit(s.id, r);
      return;
    }
    Result started = new Result();
    started.state = DOWNLOADING;
    started.bytes = partOf(s).length();
    emit(s.id, started);

    String lastError = "Download failed";
    for (int attempt = 0; attempt <= retries; attempt++) {
      try {
        Outcome o = attemptOnce(task);
        if (o == Outcome.PAUSED) {
          Result r = new Result();
          r.state = PAUSED;
          r.bytes = partOf(s).length();
          emit(s.id, r);
          return;
        }
        if (o == Outcome.CANCELED) {
          deletePart(s);
          Result r = new Result();
          r.state = CANCELED;
          emit(s.id, r);
          return;
        }
        return; // completed (attemptOnce already reported it)
      } catch (HttpException e) {
        lastError = e.getMessage();
        if (!e.retryable) break;
      } catch (IOException e) {
        lastError = "Connection problem: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
      }
      if (attempt < retries) {
        try {
          Thread.sleep(1500L * (attempt + 1));
        } catch (InterruptedException ie) {
          Thread.currentThread().interrupt();
          break;
        }
        if (task.cancel || task.pause) break;
      }
    }
    if (task.cancel) {
      deletePart(s);
      Result r = new Result();
      r.state = CANCELED;
      emit(s.id, r);
      return;
    }
    if (task.pause) {
      Result r = new Result();
      r.state = PAUSED;
      r.bytes = partOf(s).length();
      emit(s.id, r);
      return;
    }
    Result r = new Result();
    r.state = FAILED;
    r.error = lastError;
    r.bytes = partOf(s).length();
    emit(s.id, r); // the .part file stays: "retry" continues from it
  }

  private enum Outcome { COMPLETED, PAUSED, CANCELED }

  private static final class HttpException extends IOException {
    final boolean retryable;

    HttpException(String msg, boolean retryable) {
      super(msg);
      this.retryable = retryable;
    }
  }

  private Outcome attemptOnce(Task task) throws IOException {
    Spec s = task.spec;
    File part = partOf(s);
    File parent = s.dest.getParentFile();
    if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("Cannot create " + parent);

    long offset = part.exists() ? part.length() : 0;
    // A part longer than the expected file is garbage.
    if (s.size > 0 && offset > s.size) {
      deletePart(s);
      offset = 0;
    }

    // The file is already complete (an earlier run stopped right before renaming it)
    if (s.size > 0 && offset == s.size) return finish(task, part, hashOf(part));

    MessageDigest md = newMd5();
    if (offset > 0) digestFile(part, md, offset);

    HttpURLConnection c = (HttpURLConnection) new URL(s.url).openConnection();
    try {
      c.setConnectTimeout(20000);
      c.setReadTimeout(30000);
      c.setInstanceFollowRedirects(true);
      c.setRequestProperty("User-Agent", "Oli-Android");
      for (Map.Entry<String, String> h : s.headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
      if (offset > 0) c.setRequestProperty("Range", "bytes=" + offset + "-");
      int code = c.getResponseCode();
      if (code == 416) {
        // the server says our offset is past the end: start again from the beginning
        deletePart(s);
        throw new HttpException("Server rejected the resume position, starting over", true);
      }
      if (code != 200 && code != 206) {
        boolean retry = code >= 500 || code == 429 || code == 408;
        throw new HttpException("Server answered HTTP " + code, retry);
      }
      if (code == 200 && offset > 0) {
        // the server ignored the Range header: it sends the whole file again
        offset = 0;
        md = newMd5();
      }
      long length = c.getContentLengthLong();
      long total = s.size > 0 ? s.size : (length > 0 ? offset + length : 0);

      long written = offset;
      long windowStart = System.currentTimeMillis();
      long windowBytes = 0;
      long speed = 0;
      long lastEmit = 0;
      try (InputStream in = c.getInputStream();
          RandomAccessFile raf = new RandomAccessFile(part, "rw")) {
        raf.setLength(offset);
        raf.seek(offset);
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) {
          if (task.cancel) return Outcome.CANCELED;
          if (task.pause) return Outcome.PAUSED;
          raf.write(buf, 0, n);
          md.update(buf, 0, n);
          written += n;
          windowBytes += n;
          long now = System.currentTimeMillis();
          if (now - windowStart >= 1000) {
            speed = windowBytes * 1000 / Math.max(1, now - windowStart);
            windowStart = now;
            windowBytes = 0;
          }
          if (now - lastEmit >= 250) {
            lastEmit = now;
            progress(s.id, written, total, speed);
          }
        }
      }
      if (task.cancel) return Outcome.CANCELED;
      if (task.pause) return Outcome.PAUSED;
      if (total > 0 && written < total) {
        throw new IOException("Incomplete download (" + written + " of " + total + " bytes)");
      }
      progress(s.id, written, total > 0 ? total : written, 0);
      return finish(task, part, hex(md.digest()));
    } finally {
      c.disconnect();
    }
  }

  private Outcome finish(Task task, File part, String md5) throws IOException {
    Spec s = task.spec;
    long size = part.length();
    if (s.size > 0 && size != s.size) {
      deletePart(s);
      throw new HttpException("Wrong size (" + size + " of " + s.size + " bytes)", false);
    }
    if (s.md5 != null && !s.md5.isEmpty() && !s.md5.equalsIgnoreCase(md5)) {
      deletePart(s);
      Result r = new Result();
      r.state = FAILED;
      r.error = "Checksum mismatch: the file is damaged, it was deleted";
      emit(s.id, r);
      return Outcome.COMPLETED; // reported as failed above; nothing more to do
    }
    FlacTagWriter.replace(part, s.dest);
    Result r = new Result();
    r.state = COMPLETED;
    r.path = s.dest.getAbsolutePath();
    r.size = s.dest.length();
    r.md5 = md5;
    r.bytes = r.size;
    r.total = r.size;
    writeTags(s, r);
    r.size = s.dest.length();
    emit(s.id, r);
    return Outcome.COMPLETED;
  }

  private void writeTags(Spec s, Result r) {
    if (s.tags == null || s.tags.isEmpty()) {
      r.tagNote = "no tags requested";
      return;
    }
    try {
      TagFields t = s.tags;
      if (s.coverUrl != null && !s.coverUrl.isEmpty() && t.cover == null) {
        try {
          t.cover = fetch(s.coverUrl, 10 * 1024 * 1024);
        } catch (IOException e) {
          r.tagNote = "cover not available: " + e.getMessage();
        }
      }
      String name = s.dest.getName().toLowerCase(Locale.ROOT);
      boolean ok;
      if (name.endsWith(".flac")) ok = FlacTagWriter.write(s.dest, t);
      else if (name.endsWith(".mp3")) ok = Id3TagWriter.write(s.dest, t);
      else {
        r.tagNote = "tags can be written to FLAC and MP3 only";
        return;
      }
      r.tagged = ok;
      if (!ok && r.tagNote.isEmpty()) r.tagNote = "file format not recognised";
    } catch (IOException | RuntimeException e) {
      r.tagged = false;
      r.tagNote = "tags not written: " + e.getMessage();
    }
  }

  private static byte[] fetch(String url, int max) throws IOException {
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    try {
      c.setConnectTimeout(15000);
      c.setReadTimeout(20000);
      c.setInstanceFollowRedirects(true);
      c.setRequestProperty("User-Agent", "Oli-Android");
      if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
      ByteArrayOutputStream bo = new ByteArrayOutputStream();
      try (InputStream in = c.getInputStream()) {
        byte[] buf = new byte[1 << 14];
        int n;
        while ((n = in.read(buf)) > 0) {
          bo.write(buf, 0, n);
          if (bo.size() > max) throw new IOException("picture too large");
        }
      }
      return bo.toByteArray();
    } finally {
      c.disconnect();
    }
  }

  private static MessageDigest newMd5() {
    try {
      return MessageDigest.getInstance("MD5");
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  private static void digestFile(File f, MessageDigest md, long limit) throws IOException {
    try (FileInputStream in = new FileInputStream(f)) {
      byte[] buf = new byte[1 << 16];
      long left = limit;
      while (left > 0) {
        int n = in.read(buf, 0, (int) Math.min(buf.length, left));
        if (n < 0) break;
        md.update(buf, 0, n);
        left -= n;
      }
    }
  }

  private static String hashOf(File f) throws IOException {
    MessageDigest md = newMd5();
    digestFile(f, md, f.length());
    return hex(md.digest());
  }

  static String hex(byte[] d) {
    StringBuilder sb = new StringBuilder(d.length * 2);
    for (byte b : d) sb.append(String.format(Locale.ROOT, "%02x", b));
    return sb.toString();
  }

  /** For tests and diagnostics. */
  List<String> activeIds() {
    return new ArrayList<>(tasks.keySet());
  }
}
