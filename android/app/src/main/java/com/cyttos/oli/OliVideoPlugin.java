package com.cyttos.oli;

import android.content.Intent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Opens the full-screen video player (picture + sound, sharp qualities) for a YouTube video. */
@CapacitorPlugin(name = "OliVideo")
public class OliVideoPlugin extends Plugin {
  /** {title, options} - options is a JSON list of {height, label, videoUrl, audioUrl, headers}, best first. */
  @PluginMethod
  public void open(PluginCall call) {
    String options = call.getString("options", "");
    if (options == null || options.length() < 2) {
      call.reject("no video options");
      return;
    }
    Intent i = new Intent(getContext(), OliVideoActivity.class);
    i.putExtra(OliVideoActivity.EXTRA_TITLE, call.getString("title", "Video"));
    i.putExtra(OliVideoActivity.EXTRA_OPTIONS, options);
    getActivity().startActivity(i);
    call.resolve();
  }
}
