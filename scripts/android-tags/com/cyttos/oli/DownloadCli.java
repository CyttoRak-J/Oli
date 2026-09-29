package com.cyttos.oli;

import java.io.File;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Test helper (not part of the app): runs one download through the app's DownloadEngine and prints what happens.
 * usage: DownloadCli <url> <dest> [size=N] [md5=hex] [retries=N] [pauseAfterMs=N] [resumeAfterMs=N] [cancelAfterMs=N]
 *        [title=..] [coverFile=path]
 */
public class DownloadCli {
  public static void main(String[] args) throws Exception {
    DownloadEngine.Spec spec = new DownloadEngine.Spec();
    spec.id = "t1";
    spec.url = args[0];
    spec.dest = new File(args[1]);
    int retries = 0;
    long pauseAfter = -1;
    long resumeAfter = -1;
    long cancelAfter = -1;
    for (int i = 2; i < args.length; i++) {
      int eq = args[i].indexOf('=');
      String k = args[i].substring(0, eq);
      String v = args[i].substring(eq + 1);
      switch (k) {
        case "size": spec.size = Long.parseLong(v); break;
        case "md5": spec.md5 = v; break;
        case "retries": retries = Integer.parseInt(v); break;
        case "pauseAfterMs": pauseAfter = Long.parseLong(v); break;
        case "resumeAfterMs": resumeAfter = Long.parseLong(v); break;
        case "cancelAfterMs": cancelAfter = Long.parseLong(v); break;
        case "title": if (spec.tags == null) spec.tags = new TagFields(); spec.tags.title = v; break;
        case "artist": if (spec.tags == null) spec.tags = new TagFields(); spec.tags.artist = v; break;
        case "coverUrl": spec.coverUrl = v; break;
        default: throw new IllegalArgumentException(k);
      }
    }
    final CountDownLatch done = new CountDownLatch(1);
    DownloadEngine engine = new DownloadEngine(2, retries);
    final long[] lastProgress = {0};
    engine.addListener(new DownloadEngine.Listener() {
      @Override
      public void onProgress(String id, long bytes, long total, long speed) {
        lastProgress[0] = bytes;
      }

      @Override
      public void onState(String id, DownloadEngine.Result r) {
        System.out.println("state=" + r.state + " bytes=" + r.bytes + " size=" + r.size + " md5=" + r.md5 + " tagged=" + r.tagged
            + " error=" + r.error + " tagNote=" + r.tagNote);
        if (!DownloadEngine.QUEUED.equals(r.state) && !DownloadEngine.DOWNLOADING.equals(r.state)) {
          if (DownloadEngine.PAUSED.equals(r.state) && resumeLater[0]) return;
          done.countDown();
        }
      }
    });
    engine.enqueue(spec);
    if (pauseAfter >= 0) {
      Thread.sleep(pauseAfter);
      engine.pause("t1");
      if (resumeAfter >= 0) {
        resumeLater[0] = true;
        Thread.sleep(resumeAfter);
        resumeLater[0] = false;
        engine.resume("t1");
      }
    }
    if (cancelAfter >= 0) {
      Thread.sleep(cancelAfter);
      engine.cancel("t1");
    }
    if (!done.await(60, TimeUnit.SECONDS)) System.out.println("state=timeout");
    System.out.println("partExists=" + new File(spec.dest.getPath() + ".part").exists() + " destExists=" + spec.dest.exists()
        + " destLen=" + (spec.dest.exists() ? spec.dest.length() : -1));
    engine.shutdown();
    System.exit(0);
  }

  private static final boolean[] resumeLater = {false};
}
