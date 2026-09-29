package com.cyttos.oli;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import com.getcapacitor.JSObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Foreground service that keeps the music playing with the screen off and shows the notification / lock-screen
 * controls (Media3 builds both from the media session). The player itself lives in {@link OliAudioEngine}.
 */
public class OliAudioService extends MediaSessionService {
  interface EngineTask {
    void run(OliAudioEngine engine);
  }

  private static final Handler MAIN = new Handler(Looper.getMainLooper());
  private static final List<EngineTask> PENDING = new ArrayList<>();
  private static volatile OliAudioService instance;
  private static volatile OliAudioEngine.Sink eventSink = null;
  private static boolean starting = false;

  private OliAudioEngine engine;
  private MediaSession session;

  static void setEventSink(OliAudioEngine.Sink sink) {
    eventSink = sink;
  }

  /** Runs the task on the main thread with the engine, starting the service first if needed. */
  static void withEngine(Context context, EngineTask task, Runnable onFailure) {
    MAIN.post(() -> {
      OliAudioService s = instance;
      if (s != null && s.engine != null) {
        task.run(s.engine);
        return;
      }
      PENDING.add(task);
      if (starting) return;
      starting = true;
      try {
        Context app = context.getApplicationContext();
        app.startService(new Intent(app, OliAudioService.class));
      } catch (Exception e) {
        starting = false;
        PENDING.clear();
        if (onFailure != null) onFailure.run();
      }
    });
  }

  @Override
  public void onCreate() {
    super.onCreate();
    engine = new OliAudioEngine(this, (name, data) -> {
      OliAudioEngine.Sink sink = eventSink;
      if (sink != null) sink.emit(name, data == null ? new JSObject() : data);
    });
    Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
    session = new MediaSession.Builder(this, engine.sessionPlayer)
        .setSessionActivity(PendingIntent.getActivity(this, 0, open, flags))
        .build();
    instance = this;
    starting = false;
    List<EngineTask> todo = new ArrayList<>(PENDING);
    PENDING.clear();
    for (EngineTask t : todo) t.run(engine);
  }

  @Nullable
  @Override
  public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
    return session;
  }

  @Override
  public void onDestroy() {
    instance = null;
    starting = false;
    if (session != null) {
      session.release();
      session = null;
    }
    if (engine != null) {
      engine.release();
      engine = null;
    }
    super.onDestroy();
  }
}
