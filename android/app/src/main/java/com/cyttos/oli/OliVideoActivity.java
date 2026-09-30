package com.cyttos.oli;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.MergingMediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * Full-screen YouTube video player. The sharp pictures (720p and up) come without sound, so the picture and the audio
 * stream are played together as one merged source; a "Quality" button switches between the heights that exist.
 */
public class OliVideoActivity extends Activity {
  static final String EXTRA_TITLE = "title";
  static final String EXTRA_OPTIONS = "options";

  private static class Option {
    String label;
    String videoUrl;
    String audioUrl;
    Map<String, String> headers = new HashMap<>();
  }

  private final List<Option> options = new ArrayList<>();
  private ExoPlayer player;
  private PlayerView view;
  private TextView quality;
  private int current = 0;
  private int failures = 0;

  @Override
  protected void onCreate(Bundle b) {
    super.onCreate(b);
    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    try {
      JSONArray arr = new JSONArray(getIntent().getStringExtra(EXTRA_OPTIONS));
      for (int i = 0; i < arr.length(); i++) {
        JSONObject o = arr.getJSONObject(i);
        Option op = new Option();
        op.label = o.optString("label", "");
        op.videoUrl = o.getString("videoUrl");
        op.audioUrl = o.optString("audioUrl", "");
        JSONObject h = o.optJSONObject("headers");
        if (h != null) {
          Iterator<String> keys = h.keys();
          while (keys.hasNext()) {
            String k = keys.next();
            op.headers.put(k, h.optString(k));
          }
        }
        options.add(op);
      }
    } catch (Exception e) {
      options.clear();
    }
    if (options.isEmpty()) {
      Toast.makeText(this, "This video could not be opened.", Toast.LENGTH_LONG).show();
      finish();
      return;
    }

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);
    view = new PlayerView(this);
    root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    TextView title = new TextView(this);
    title.setText(getIntent().getStringExtra(EXTRA_TITLE));
    title.setTextColor(Color.WHITE);
    title.setTextSize(15);
    title.setSingleLine(true);
    title.setPadding(dp(16), dp(14), dp(110), dp(8));
    root.addView(title, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));

    quality = new TextView(this);
    quality.setTextColor(Color.WHITE);
    quality.setTextSize(14);
    quality.setPadding(dp(14), dp(8), dp(14), dp(8));
    quality.setBackgroundColor(0x99000000);
    quality.setOnClickListener(v -> chooseQuality());
    FrameLayout.LayoutParams qp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
    qp.setMargins(0, dp(10), dp(12), 0);
    root.addView(quality, qp);
    // the title and the quality button follow the playback controls: shown together, hidden together
    view.setControllerVisibilityListener((PlayerView.ControllerVisibilityListener) vis -> {
      title.setVisibility(vis);
      quality.setVisibility(options.size() > 1 ? vis : View.GONE);
    });
    setContentView(root);

    player = new ExoPlayer.Builder(this).build();
    player.setAudioAttributes(
        new AudioAttributes.Builder().setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).setUsage(C.USAGE_MEDIA).build(), true);
    player.addListener(new Player.Listener() {
      @Override
      public void onPlayerError(PlaybackException error) {
        // a stream that will not play: try the next lower quality, then give up
        if (current + 1 < options.size() && failures < 3) {
          failures++;
          Toast.makeText(OliVideoActivity.this, "Trying " + options.get(current + 1).label + "…", Toast.LENGTH_SHORT).show();
          play(current + 1, player.getCurrentPosition());
        } else {
          Toast.makeText(OliVideoActivity.this, "This video could not be played.", Toast.LENGTH_LONG).show();
        }
      }
    });
    view.setPlayer(player);
    play(0, 0);
  }

  private int dp(int v) {
    return Math.round(v * getResources().getDisplayMetrics().density);
  }

  private MediaSource source(String url, Map<String, String> headers) {
    DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true);
    if (!headers.isEmpty()) http.setDefaultRequestProperties(headers);
    return new ProgressiveMediaSource.Factory(new DefaultDataSource.Factory(this, http)).createMediaSource(MediaItem.fromUri(url));
  }

  private void play(int index, long positionMs) {
    current = index;
    Option o = options.get(index);
    quality.setText(o.label + "  ▾");
    MediaSource video = source(o.videoUrl, o.headers);
    if (o.audioUrl != null && !o.audioUrl.isEmpty()) {
      player.setMediaSource(new MergingMediaSource(video, source(o.audioUrl, o.headers)), positionMs);
    } else {
      player.setMediaSource(video, positionMs);
    }
    player.prepare();
    player.setPlayWhenReady(true);
  }

  private void chooseQuality() {
    String[] labels = new String[options.size()];
    for (int i = 0; i < labels.length; i++) labels[i] = options.get(i).label + (i == current ? "  ✓" : "");
    new AlertDialog.Builder(this)
        .setTitle("Quality")
        .setItems(labels, (d, which) -> {
          failures = 0;
          if (which != current) play(which, player.getCurrentPosition());
        })
        .show();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (!hasFocus) return;
    WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
    c.hide(WindowInsetsCompat.Type.systemBars());
    c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
  }

  @Override
  protected void onStop() {
    super.onStop();
    if (player != null) player.pause();
  }

  @Override
  protected void onDestroy() {
    super.onDestroy();
    if (player != null) {
      player.release();
      player = null;
    }
  }
}
