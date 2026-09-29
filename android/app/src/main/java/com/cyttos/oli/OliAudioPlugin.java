package com.cyttos.oli;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Map;

/**
 * Bridge between the app's JavaScript player and the native Media3 player. The JavaScript side ({@code NativeAudio})
 * looks like an audio element; this plugin does the real work in {@link OliAudioEngine}.
 */
@CapacitorPlugin(name = "OliAudio")
public class OliAudioPlugin extends Plugin {
  @Override
  public void load() {
    OliAudioService.setEventSink((name, data) -> notifyListeners(name, data));
  }

  private void run(PluginCall call, OliAudioService.EngineTask task) {
    OliAudioService.withEngine(getContext(), engine -> {
      try {
        task.run(engine);
        call.resolve();
      } catch (Exception e) {
        call.reject(String.valueOf(e.getMessage()));
      }
    }, () -> call.reject("Could not start the audio service"));
  }

  /** {url, headers?, startPositionMs?, autoplay?, bitDepth?, token} */
  @PluginMethod
  public void loadSource(PluginCall call) {
    final String url = call.getString("url");
    if (url == null || url.isEmpty()) {
      call.reject("url is required");
      return;
    }
    final Map<String, String> headers = OliAudioEngine.toHeaders(call.getObject("headers"));
    final long start = call.getLong("startPositionMs", 0L);
    final boolean autoplay = Boolean.TRUE.equals(call.getBoolean("autoplay", false));
    final int bitDepth = call.getInt("bitDepth", 0);
    final String token = call.getString("token", "");
    run(call, e -> e.load(url, headers, start, autoplay, bitDepth, token));
  }

  @PluginMethod
  public void play(PluginCall call) {
    run(call, OliAudioEngine::play);
  }

  @PluginMethod
  public void pause(PluginCall call) {
    run(call, OliAudioEngine::pause);
  }

  @PluginMethod
  public void stop(PluginCall call) {
    run(call, OliAudioEngine::stop);
  }

  @PluginMethod
  public void seekTo(PluginCall call) {
    final long ms = call.getLong("positionMs", 0L);
    run(call, e -> e.seekTo(ms));
  }

  @PluginMethod
  public void setVolume(PluginCall call) {
    final float v = call.getFloat("volume", 1f);
    run(call, e -> e.setVolume(v));
  }

  @PluginMethod
  public void setPlaybackParams(PluginCall call) {
    final float speed = call.getFloat("speed", 1f);
    final boolean pitch = Boolean.TRUE.equals(call.getBoolean("preservePitch", true));
    run(call, e -> e.setPlaybackParams(speed, pitch));
  }

  @PluginMethod
  public void setMetadata(PluginCall call) {
    final String title = call.getString("title", "");
    final String artist = call.getString("artist", "");
    final String album = call.getString("album", "");
    final String art = call.getString("artworkUri", "");
    run(call, e -> e.setMetadata(title, artist, album, art));
  }

  @PluginMethod
  public void setBitPerfect(PluginCall call) {
    final boolean on = Boolean.TRUE.equals(call.getBoolean("enabled", false));
    run(call, e -> e.setBitPerfect(on));
  }

  @PluginMethod
  public void getOutputInfo(PluginCall call) {
    OliAudioService.withEngine(getContext(), engine -> {
      try {
        call.resolve(engine.outputInfo());
      } catch (Exception e) {
        call.reject(String.valueOf(e.getMessage()));
      }
    }, () -> {
      JSObject o = new JSObject();
      o.put("available", false);
      call.resolve(o);
    });
  }
}
