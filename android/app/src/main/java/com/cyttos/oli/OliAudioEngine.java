package com.cyttos.oli;

import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioMixerAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DecoderReuseEvaluation;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.audio.ForwardingAudioSink;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.extractor.DefaultExtractorsFactory;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The native player behind the app's audio. One ExoPlayer (Media3) that decodes with the phone's own decoders, keeps
 * the full bit depth (float output for hi-res files), and remembers what really happened to the audio so the app can
 * tell the owner honestly: decoder, output encoding, output rate, device, bit-perfect yes/no.
 *
 * Everything here runs on the main thread (the ExoPlayer's home thread).
 */
final class OliAudioEngine {
  interface Sink {
    void emit(String event, JSObject data);
  }

  private final Context ctx;
  private final Sink sink;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final AudioManager am;
  private final DefaultHttpDataSource.Factory http;
  private final ExoPlayer player;
  final Player sessionPlayer;
  private final android.media.AudioAttributes platformAttrs;

  /** Float output is only asked from the decoder for hi-res (or unknown) sources, so 16-bit files stay 16-bit. */
  private volatile boolean allowFloat = true;
  private boolean bitPerfectRequested = false;
  private String bitPerfectNote = "off";
  private AudioDeviceInfo preferredDeviceSet = null;

  /** Echoed in every event so the app can ignore events that belong to a source it has already replaced. */
  private String token = "";
  private String currentUrl = "";
  private SourceProbe probe = new SourceProbe();
  private boolean released = false;

  // What Media3 reported about the current source (diagnostics).
  private String decoderName = "";
  private String inputMime = "";
  private int inputRate = 0;
  private int inputChannels = 0;
  private int inputPcmEncoding = Format.NO_VALUE;
  private int inputBitrate = 0;
  private boolean trackReady = false;
  private int trackEncoding = 0;
  private int trackRate = 0;
  private int trackChannels = 0;
  private boolean trackOffload = false;
  private String lastSinkError = "";

  private final Runnable ticker = new Runnable() {
    @Override
    public void run() {
      if (released) return;
      emitTime();
      if (player.isPlaying()) main.postDelayed(this, 250);
    }
  };

  OliAudioEngine(Context context, Sink sink) {
    this.ctx = context.getApplicationContext();
    this.sink = sink;
    this.am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
    this.platformAttrs = new android.media.AudioAttributes.Builder()
        .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
        .build();

    http = new DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true).setUserAgent("Oli-Android");
    DefaultExtractorsFactory extractors = new DefaultExtractorsFactory().setConstantBitrateSeekingEnabled(true);

    DefaultRenderersFactory renderers = new DefaultRenderersFactory(ctx) {
      @Override
      protected AudioSink buildAudioSink(Context c, boolean enableFloatOutput, boolean enablePlaybackParams) {
        AudioSink real = new DefaultAudioSink.Builder(c)
            .setEnableFloatOutput(true)
            .setEnableAudioTrackPlaybackParams(enablePlaybackParams)
            .build();
        return new ForwardingAudioSink(real) {
          @Override
          public int getFormatSupport(Format format) {
            // The decoder asks for float output only when the sink accepts it: refusing keeps 16-bit sources 16-bit.
            if (format.pcmEncoding == C.ENCODING_PCM_FLOAT && !allowFloat) return AudioSink.SINK_FORMAT_UNSUPPORTED;
            return super.getFormatSupport(format);
          }
        };
      }
    };
    renderers.setEnableAudioTrackPlaybackParams(true);

    AudioAttributes attrs = new AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
        .build();
    player = new ExoPlayer.Builder(ctx, renderers)
        .setMediaSourceFactory(new DefaultMediaSourceFactory(new DefaultDataSource.Factory(ctx, http), extractors))
        .setAudioAttributes(attrs, true)
        .setHandleAudioBecomingNoisy(true)
        .setWakeMode(C.WAKE_MODE_LOCAL)
        .build();

    player.addListener(new Player.Listener() {
      @Override
      public void onPlaybackStateChanged(int state) {
        emitState("");
        if (state == Player.STATE_READY) emitTime();
      }

      @Override
      public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
        emitState(reasonName(reason));
      }

      @Override
      public void onIsPlayingChanged(boolean isPlaying) {
        emitState("");
        main.removeCallbacks(ticker);
        if (isPlaying) main.post(ticker);
      }

      @Override
      public void onPlayerError(PlaybackException error) {
        JSObject o = base();
        o.put("code", mediaErrorCode(error));
        o.put("codeName", error.getErrorCodeName());
        o.put("message", String.valueOf(error.getMessage()));
        Throwable cause = error.getCause();
        if (cause != null) o.put("cause", String.valueOf(cause));
        sink.emit("error", o);
      }

      @Override
      public void onPositionDiscontinuity(Player.PositionInfo oldPos, Player.PositionInfo newPos, int reason) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK) {
          JSObject o = base();
          o.put("positionMs", newPos.positionMs);
          sink.emit("seeked", o);
        }
      }
    });

    player.addAnalyticsListener(new AnalyticsListener() {
      @Override
      public void onAudioDecoderInitialized(EventTime t, String name, long ts, long dur) {
        decoderName = name;
      }

      @Override
      public void onAudioInputFormatChanged(EventTime t, Format f, DecoderReuseEvaluation reuse) {
        inputMime = String.valueOf(f.sampleMimeType);
        inputRate = f.sampleRate;
        inputChannels = f.channelCount;
        inputPcmEncoding = f.pcmEncoding;
        inputBitrate = f.bitrate;
      }

      @Override
      public void onAudioTrackInitialized(EventTime t, AudioSink.AudioTrackConfig cfg) {
        trackReady = true;
        trackEncoding = cfg.encoding;
        trackRate = cfg.sampleRate;
        trackChannels = Integer.bitCount(cfg.channelConfig);
        trackOffload = cfg.offload;
        emitOutputChanged();
      }

      @Override
      public void onAudioTrackReleased(EventTime t, AudioSink.AudioTrackConfig cfg) {
        trackReady = false;
      }

      @Override
      public void onAudioSinkError(EventTime t, Exception e) {
        lastSinkError = String.valueOf(e);
      }
    });

    // The lock screen / notification / Bluetooth buttons ask for the next or previous song; the queue lives in the app.
    sessionPlayer = new ForwardingPlayer(player) {
      @Override
      public Commands getAvailableCommands() {
        return super.getAvailableCommands().buildUpon()
            .add(COMMAND_SEEK_TO_NEXT)
            .add(COMMAND_SEEK_TO_PREVIOUS)
            .add(COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
            .add(COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
            .build();
      }

      @Override
      public boolean isCommandAvailable(int command) {
        if (command == COMMAND_SEEK_TO_NEXT || command == COMMAND_SEEK_TO_PREVIOUS
            || command == COMMAND_SEEK_TO_NEXT_MEDIA_ITEM || command == COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM) {
          return true;
        }
        return super.isCommandAvailable(command);
      }

      @Override
      public boolean hasNextMediaItem() {
        return true;
      }

      @Override
      public boolean hasPreviousMediaItem() {
        return true;
      }

      @Override
      public void seekToNext() {
        command("next");
      }

      @Override
      public void seekToNextMediaItem() {
        command("next");
      }

      @Override
      public void seekToPrevious() {
        command("previous");
      }

      @Override
      public void seekToPreviousMediaItem() {
        command("previous");
      }
    };

    if (am != null) {
      am.registerAudioDeviceCallback(new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
          emitOutputChanged();
        }

        @Override
        public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
          emitOutputChanged();
        }
      }, main);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Commands from the app

  void load(String url, Map<String, String> headers, long startMs, boolean autoplay, int bitDepthHint, String newToken) {
    Uri uri = Uri.parse(url);
    token = newToken == null ? "" : newToken;
    currentUrl = url;
    http.setDefaultRequestProperties(headers);
    boolean local = "file".equals(uri.getScheme()) || "content".equals(uri.getScheme());
    player.setWakeMode(local ? C.WAKE_MODE_LOCAL : C.WAKE_MODE_NETWORK);

    probe = SourceProbe.probe(ctx, uri, bitDepthHint);
    // Float only where it can matter: hi-res (or unknown) sources. Lossy and 16-bit files stay 16-bit.
    allowFloat = !probe.isLossy() && (probe.bitDepth == 0 || probe.bitDepth > 16);
    decoderName = "";
    inputMime = "";
    trackReady = false;
    lastSinkError = "";
    applyBitPerfect();

    MediaItem item = new MediaItem.Builder().setUri(uri).setMediaId(url).build();
    player.setMediaItem(item, startMs > 0 ? startMs : C.TIME_UNSET);
    player.prepare();
    player.setPlayWhenReady(autoplay);
  }

  void play() {
    if (player.getPlaybackState() == Player.STATE_ENDED) player.seekTo(0);
    player.play();
  }

  void pause() {
    player.pause();
  }

  void stop() {
    main.removeCallbacks(ticker);
    player.stop();
    player.clearMediaItems();
    currentUrl = "";
    trackReady = false;
    emitState("");
  }

  void seekTo(long positionMs) {
    player.seekTo(Math.max(0, positionMs));
  }

  void setVolume(float volume) {
    player.setVolume(Math.max(0f, Math.min(1f, volume)));
  }

  void setPlaybackParams(float speed, boolean preservePitch) {
    float s = Math.max(0.25f, Math.min(4f, speed));
    player.setPlaybackParameters(new PlaybackParameters(s, preservePitch ? 1f : s));
  }

  void setMetadata(String title, String artist, String album, String artworkUri) {
    if (player.getMediaItemCount() == 0) return;
    MediaMetadata.Builder md = new MediaMetadata.Builder().setTitle(title).setArtist(artist).setAlbumTitle(album);
    if (artworkUri != null && !artworkUri.isEmpty()) md.setArtworkUri(Uri.parse(artworkUri));
    MediaItem cur = player.getCurrentMediaItem();
    if (cur == null) return;
    // Same source, new labels: Media3 updates the item in place without reloading the audio.
    player.replaceMediaItem(player.getCurrentMediaItemIndex(), cur.buildUpon().setMediaMetadata(md.build()).build());
  }

  void setBitPerfect(boolean enabled) {
    bitPerfectRequested = enabled;
    applyBitPerfect();
    emitOutputChanged();
  }

  boolean isPlaying() {
    return player.isPlaying();
  }

  void release() {
    released = true;
    main.removeCallbacks(ticker);
    clearBitPerfect();
    player.release();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Events to the app

  private JSObject base() {
    JSObject o = new JSObject();
    o.put("token", token);
    return o;
  }

  private void command(String name) {
    JSObject o = base();
    o.put("command", name);
    sink.emit("command", o);
  }

  private static String stateName(int s) {
    switch (s) {
      case Player.STATE_BUFFERING:
        return "buffering";
      case Player.STATE_READY:
        return "ready";
      case Player.STATE_ENDED:
        return "ended";
      default:
        return "idle";
    }
  }

  private static String reasonName(int r) {
    switch (r) {
      case Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS:
        return "audioFocusLoss";
      case Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY:
        return "audioBecomingNoisy";
      case Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE:
        return "remote";
      case Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM:
        return "endOfItem";
      default:
        return "user";
    }
  }

  /** Numbers of the browser's MediaError (the player logic reads them): 2 network, 3 decode, 4 not supported. */
  private static int mediaErrorCode(PlaybackException e) {
    int c = e.errorCode;
    if (c >= 2000 && c < 3000) {
      if (c == PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND || c == PlaybackException.ERROR_CODE_IO_NO_PERMISSION) {
        return 4;
      }
      return 2;
    }
    if (c >= 3000 && c < 4000) return 4;
    if (c >= 4000 && c < 5000) return 3;
    return 3;
  }

  private void emitState(String reason) {
    JSObject o = base();
    o.put("state", stateName(player.getPlaybackState()));
    o.put("playWhenReady", player.getPlayWhenReady());
    o.put("isPlaying", player.isPlaying());
    o.put("suppressed", player.getPlaybackSuppressionReason() != Player.PLAYBACK_SUPPRESSION_REASON_NONE);
    o.put("reason", reason);
    long dur = player.getDuration();
    o.put("durationMs", dur == C.TIME_UNSET ? -1 : dur);
    o.put("positionMs", player.getCurrentPosition());
    sink.emit("state", o);
  }

  private void emitTime() {
    JSObject o = base();
    long dur = player.getDuration();
    o.put("positionMs", player.getCurrentPosition());
    o.put("durationMs", dur == C.TIME_UNSET ? -1 : dur);
    o.put("bufferedMs", player.getBufferedPosition());
    sink.emit("time", o);
  }

  private void emitOutputChanged() {
    if (released) return;
    sink.emit("outputChanged", outputInfo());
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Honest diagnostics

  private static String encodingName(int e) {
    switch (e) {
      case C.ENCODING_PCM_8BIT:
        return "PCM 8-bit";
      case C.ENCODING_PCM_16BIT:
        return "PCM 16-bit";
      case C.ENCODING_PCM_24BIT:
        return "PCM 24-bit";
      case C.ENCODING_PCM_32BIT:
        return "PCM 32-bit";
      case C.ENCODING_PCM_FLOAT:
        return "PCM float (32-bit)";
      default:
        return e == 0 || e == Format.NO_VALUE ? "unknown" : "encoding " + e;
    }
  }

  private static int androidEncoding(int e) {
    switch (e) {
      case C.ENCODING_PCM_8BIT:
        return AudioFormat.ENCODING_PCM_8BIT;
      case C.ENCODING_PCM_16BIT:
        return AudioFormat.ENCODING_PCM_16BIT;
      case C.ENCODING_PCM_24BIT:
        return AudioFormat.ENCODING_PCM_24BIT_PACKED;
      case C.ENCODING_PCM_32BIT:
        return AudioFormat.ENCODING_PCM_32BIT;
      case C.ENCODING_PCM_FLOAT:
        return AudioFormat.ENCODING_PCM_FLOAT;
      default:
        return AudioFormat.ENCODING_INVALID;
    }
  }

  private static String androidEncodingName(int e) {
    switch (e) {
      case AudioFormat.ENCODING_PCM_8BIT:
        return "PCM 8-bit";
      case AudioFormat.ENCODING_PCM_16BIT:
        return "PCM 16-bit";
      case AudioFormat.ENCODING_PCM_24BIT_PACKED:
        return "PCM 24-bit";
      case AudioFormat.ENCODING_PCM_32BIT:
        return "PCM 32-bit";
      case AudioFormat.ENCODING_PCM_FLOAT:
        return "PCM float";
      default:
        return "encoding " + e;
    }
  }

  private static String deviceTypeName(int type) {
    switch (type) {
      case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
        return "Phone speaker";
      case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
        return "Earpiece";
      case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
        return "Wired headphones";
      case AudioDeviceInfo.TYPE_WIRED_HEADSET:
        return "Wired headset";
      case AudioDeviceInfo.TYPE_USB_DEVICE:
      case AudioDeviceInfo.TYPE_USB_HEADSET:
        return "USB audio";
      case AudioDeviceInfo.TYPE_USB_ACCESSORY:
        return "USB accessory";
      case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
        return "Bluetooth (A2DP)";
      case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
        return "Bluetooth (call audio)";
      case AudioDeviceInfo.TYPE_HDMI:
        return "HDMI";
      case AudioDeviceInfo.TYPE_LINE_ANALOG:
        return "Line out";
      case AudioDeviceInfo.TYPE_DOCK:
        return "Dock";
      default:
        if (Build.VERSION.SDK_INT >= 31 && (type == AudioDeviceInfo.TYPE_BLE_HEADSET
            || type == AudioDeviceInfo.TYPE_BLE_SPEAKER || type == AudioDeviceInfo.TYPE_BLE_BROADCAST)) {
          return "Bluetooth LE";
        }
        return "Other output (type " + type + ")";
    }
  }

  private static boolean isBluetooth(int type) {
    if (type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) return true;
    return Build.VERSION.SDK_INT >= 31 && (type == AudioDeviceInfo.TYPE_BLE_HEADSET
        || type == AudioDeviceInfo.TYPE_BLE_SPEAKER || type == AudioDeviceInfo.TYPE_BLE_BROADCAST);
  }

  private static boolean isUsb(int type) {
    return type == AudioDeviceInfo.TYPE_USB_DEVICE || type == AudioDeviceInfo.TYPE_USB_HEADSET;
  }

  private static int devicePriority(int type) {
    if (isUsb(type)) return 0;
    if (type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || type == AudioDeviceInfo.TYPE_WIRED_HEADSET
        || type == AudioDeviceInfo.TYPE_LINE_ANALOG) return 1;
    if (isBluetooth(type)) return 2;
    if (type == AudioDeviceInfo.TYPE_HDMI) return 3;
    if (type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) return 4;
    return 5;
  }

  /** The output the sound goes to. Android 13+ answers exactly; older versions can only be guessed from what is plugged in. */
  private AudioDeviceInfo pickDevice(boolean[] exact) {
    exact[0] = false;
    if (am == null) return null;
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        List<AudioDeviceInfo> routed = am.getAudioDevicesForAttributes(platformAttrs);
        if (routed != null && !routed.isEmpty()) {
          exact[0] = true;
          return routed.get(0);
        }
      }
    } catch (Exception ignored) {
      // fall through to the guess
    }
    AudioDeviceInfo best = null;
    for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
      if (!d.isSink()) continue;
      if (best == null || devicePriority(d.getType()) < devicePriority(best.getType())) best = d;
    }
    return best;
  }

  private static JSArray intArray(int[] values) {
    JSArray a = new JSArray();
    if (values != null) for (int v : values) a.put(v);
    return a;
  }

  JSObject outputInfo() {
    JSObject o = new JSObject();
    o.put("available", true);
    o.put("androidApi", Build.VERSION.SDK_INT);
    o.put("hasSource", !currentUrl.isEmpty());

    JSObject src = new JSObject();
    src.put("container", probe.container);
    src.put("mime", !inputMime.isEmpty() && !"null".equals(inputMime) ? inputMime : probe.mime);
    src.put("sampleRate", probe.sampleRate > 0 ? probe.sampleRate : inputRate);
    src.put("channels", probe.channels > 0 ? probe.channels : inputChannels);
    src.put("bitDepth", probe.bitDepth);
    src.put("bitrate", inputBitrate > 0 ? inputBitrate : 0);
    o.put("source", src);

    o.put("decoder", decoderName);
    o.put("decoderIsSoftware", decoderName.startsWith("c2.android.") || decoderName.startsWith("OMX.google."));
    o.put("floatAllowed", allowFloat);

    int mixerRate = 0;
    try {
      String p = am == null ? null : am.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE);
      if (p != null) mixerRate = Integer.parseInt(p);
    } catch (Exception ignored) {
      // leave 0 = unknown
    }
    o.put("mixerRate", mixerRate);

    JSObject track = new JSObject();
    track.put("ready", trackReady);
    track.put("encoding", trackReady ? encodingName(trackEncoding) : "");
    track.put("sampleRate", trackReady ? trackRate : 0);
    track.put("channels", trackReady ? trackChannels : 0);
    track.put("offload", trackOffload);
    o.put("track", track);

    boolean[] exact = new boolean[1];
    AudioDeviceInfo dev = pickDevice(exact);
    JSObject device = new JSObject();
    boolean bluetooth = false;
    if (dev != null) {
      bluetooth = isBluetooth(dev.getType());
      device.put("type", deviceTypeName(dev.getType()));
      device.put("name", String.valueOf(dev.getProductName()));
      device.put("exact", exact[0]);
      device.put("bluetooth", bluetooth);
      device.put("usb", isUsb(dev.getType()));
      device.put("sampleRates", intArray(dev.getSampleRates()));
    }
    o.put("device", device);

    // Bit-perfect state: only "active" if Android really holds a bit-perfect mixer setting that matches the track.
    JSObject bp = new JSObject();
    bp.put("supported", Build.VERSION.SDK_INT >= 34);
    bp.put("requested", bitPerfectRequested);
    boolean active = false;
    if (Build.VERSION.SDK_INT >= 34 && dev != null && trackReady) {
      try {
        AudioMixerAttributes cur = am.getPreferredMixerAttributes(platformAttrs, dev);
        if (cur != null && cur.getMixerBehavior() == AudioMixerAttributes.MIXER_BEHAVIOR_BIT_PERFECT) {
          AudioFormat f = cur.getFormat();
          active = f.getSampleRate() == trackRate && f.getEncoding() == androidEncoding(trackEncoding);
        }
      } catch (Exception ignored) {
        // not active
      }
    }
    bp.put("active", active);
    bp.put("note", bitPerfectNote);
    o.put("bitPerfect", bp);

    // The plain-language truth about the path from file to speaker.
    boolean resampled = false;
    String verdict;
    if (!trackReady) {
      verdict = "Nothing is playing yet.";
    } else if (active) {
      verdict = "Bit-perfect: the " + (dev != null ? deviceTypeName(dev.getType()) : "output") + " receives the file's own "
          + trackRate + " Hz " + androidEncodingName(androidEncoding(trackEncoding)) + ".";
    } else if (bluetooth) {
      resampled = mixerRate > 0 && trackRate != mixerRate;
      verdict = "Bluetooth: the audio is compressed by the Bluetooth codec, so it is not lossless hi-res.";
    } else if (mixerRate > 0 && trackRate != mixerRate) {
      resampled = true;
      verdict = "Android's mixer converts " + trackRate + " Hz to " + mixerRate + " Hz before the sound goes out.";
    } else {
      verdict = "Sent to Android's mixer at " + trackRate + " Hz (" + encodingName(trackEncoding) + "); no rate conversion.";
    }
    o.put("resampled", resampled);
    o.put("verdict", verdict);
    if (!lastSinkError.isEmpty()) o.put("sinkError", lastSinkError);
    return o;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Bit-perfect mode (Android 14+, USB DACs and similar)

  private void clearBitPerfect() {
    if (Build.VERSION.SDK_INT < 34 || am == null || preferredDeviceSet == null) return;
    try {
      am.clearPreferredMixerAttributes(platformAttrs, preferredDeviceSet);
    } catch (Exception ignored) {
      // best effort
    }
    preferredDeviceSet = null;
  }

  /** Asks Android to hand the file's own format to the output unchanged, if the device offers exactly that. */
  private void applyBitPerfect() {
    if (!bitPerfectRequested) {
      clearBitPerfect();
      bitPerfectNote = "off";
      return;
    }
    if (Build.VERSION.SDK_INT < 34 || am == null) {
      bitPerfectNote = "Needs Android 14 or newer";
      return;
    }
    if (probe.sampleRate <= 0) {
      bitPerfectNote = currentUrl.isEmpty() ? "Applies when a local FLAC/WAV file plays" : "Unknown file format (streams are not bit-perfect)";
      return;
    }
    try {
      boolean[] exact = new boolean[1];
      AudioDeviceInfo dev = pickDevice(exact);
      if (dev == null) {
        bitPerfectNote = "No output device found";
        return;
      }
      // What the player will hand to Android: float for hi-res files, 16-bit otherwise.
      int wantEncoding = allowFloat ? AudioFormat.ENCODING_PCM_FLOAT : AudioFormat.ENCODING_PCM_16BIT;
      List<AudioMixerAttributes> supported = am.getSupportedMixerAttributes(dev);
      AudioMixerAttributes match = null;
      List<String> offered = new ArrayList<>();
      for (AudioMixerAttributes a : supported) {
        if (a.getMixerBehavior() != AudioMixerAttributes.MIXER_BEHAVIOR_BIT_PERFECT) continue;
        AudioFormat f = a.getFormat();
        offered.add(f.getSampleRate() + " Hz " + androidEncodingName(f.getEncoding()));
        if (f.getSampleRate() == probe.sampleRate && f.getEncoding() == wantEncoding && match == null) match = a;
      }
      if (match == null) {
        clearBitPerfect();
        bitPerfectNote = offered.isEmpty()
            ? deviceTypeName(dev.getType()) + " offers no bit-perfect mode"
            : "Device offers " + offered + " but the file needs " + probe.sampleRate + " Hz "
                + androidEncodingName(wantEncoding);
        return;
      }
      if (preferredDeviceSet != null && preferredDeviceSet.getId() != dev.getId()) clearBitPerfect();
      boolean ok = am.setPreferredMixerAttributes(platformAttrs, dev, match);
      if (ok) {
        preferredDeviceSet = dev;
        bitPerfectNote = "Requested on " + deviceTypeName(dev.getType());
      } else {
        bitPerfectNote = "Android refused the bit-perfect request";
      }
    } catch (Exception e) {
      bitPerfectNote = "Bit-perfect failed: " + e.getMessage();
    }
  }

  /** Headers for a stream, from the app (string values only). */
  static Map<String, String> toHeaders(org.json.JSONObject obj) {
    Map<String, String> m = new HashMap<>();
    if (obj == null) return m;
    java.util.Iterator<String> it = obj.keys();
    while (it.hasNext()) {
      String k = it.next();
      m.put(k, obj.optString(k));
    }
    return m;
  }
}
