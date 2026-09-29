package com.cyttos.oli;

import android.content.Context;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;

import java.io.FileInputStream;
import java.io.InputStream;

/**
 * Reads the real format of a local audio file (sample rate, channels, bit depth) before it is played, straight from
 * the file header. FLAC and WAV headers are parsed by hand (Android's extractor does not always report the bit depth);
 * everything else falls back to MediaExtractor for rate and channels. Streams (http/https) are not probed.
 */
final class SourceProbe {
  int sampleRate;
  int channels;
  /** Bits per sample of the stored audio; 0 when unknown (compressed lossy formats, streams). */
  int bitDepth;
  /** "flac", "wav" or "" when unknown. */
  String container = "";
  /** MIME type reported by MediaExtractor for other formats ("" when unknown). */
  String mime = "";

  /** True for formats that are lossy by nature (they never carry more than 16 useful bits). */
  boolean isLossy() {
    return mime.startsWith("audio/mpeg") || mime.startsWith("audio/mp4a") || mime.startsWith("audio/opus")
        || mime.startsWith("audio/vorbis") || mime.startsWith("audio/3gpp") || mime.startsWith("audio/amr");
  }

  static SourceProbe probe(Context ctx, Uri uri, int bitDepthHint) {
    SourceProbe p = new SourceProbe();
    String scheme = uri.getScheme();
    if ("file".equals(scheme) || "content".equals(scheme)) {
      try {
        byte[] head = readHead(ctx, uri, 8192);
        if (!parseFlac(head, p) && !parseWav(head, p)) {
          probeWithExtractor(ctx, uri, p);
        }
      } catch (Exception ignored) {
        // Unknown format: playback still works, only the diagnostics know less.
      }
    }
    if (p.bitDepth == 0 && bitDepthHint > 0) p.bitDepth = bitDepthHint;
    return p;
  }

  private static byte[] readHead(Context ctx, Uri uri, int max) throws Exception {
    InputStream in = "file".equals(uri.getScheme())
        ? new FileInputStream(uri.getPath())
        : ctx.getContentResolver().openInputStream(uri);
    if (in == null) return new byte[0];
    try {
      byte[] buf = new byte[max];
      int n = 0;
      while (n < max) {
        int r = in.read(buf, n, max - n);
        if (r < 0) break;
        n += r;
      }
      byte[] out = new byte[n];
      System.arraycopy(buf, 0, out, 0, n);
      return out;
    } finally {
      in.close();
    }
  }

  private static boolean parseFlac(byte[] b, SourceProbe p) {
    int o = 0;
    // Skip an ID3v2 tag in front of the stream.
    if (b.length > 10 && b[0] == 'I' && b[1] == 'D' && b[2] == '3') {
      int size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
      o = 10 + size + (((b[5] & 0x10) != 0) ? 10 : 0);
    }
    if (o + 26 > b.length) return false;
    if (b[o] != 'f' || b[o + 1] != 'L' || b[o + 2] != 'a' || b[o + 3] != 'C') return false;
    // o+4: block header (4 bytes), then STREAMINFO: 2+2 block sizes, 3+3 frame sizes, then rate/channels/bits.
    int i = o + 18;
    int rate = ((b[i] & 0xff) << 12) | ((b[i + 1] & 0xff) << 4) | ((b[i + 2] & 0xff) >> 4);
    int ch = ((b[i + 2] >> 1) & 0x7) + 1;
    int bps = (((b[i + 2] & 1) << 4) | ((b[i + 3] & 0xff) >> 4)) + 1;
    p.sampleRate = rate;
    p.channels = ch;
    p.bitDepth = bps;
    p.container = "flac";
    return true;
  }

  private static boolean parseWav(byte[] b, SourceProbe p) {
    if (b.length < 20 || b[0] != 'R' || b[1] != 'I' || b[2] != 'F' || b[3] != 'F' || b[8] != 'W' || b[9] != 'A'
        || b[10] != 'V' || b[11] != 'E') {
      return false;
    }
    int o = 12;
    while (o + 8 <= b.length) {
      int size = le32(b, o + 4);
      if (b[o] == 'f' && b[o + 1] == 'm' && b[o + 2] == 't' && b[o + 3] == ' ') {
        if (o + 8 + 16 > b.length) return false;
        p.channels = le16(b, o + 10);
        p.sampleRate = le32(b, o + 12);
        p.bitDepth = le16(b, o + 22);
        p.container = "wav";
        return true;
      }
      if (size < 0) return false;
      o += 8 + size + (size & 1);
    }
    return false;
  }

  private static void probeWithExtractor(Context ctx, Uri uri, SourceProbe p) throws Exception {
    MediaExtractor mx = new MediaExtractor();
    try {
      mx.setDataSource(ctx, uri, null);
      for (int i = 0; i < mx.getTrackCount(); i++) {
        MediaFormat f = mx.getTrackFormat(i);
        String mime = f.getString(MediaFormat.KEY_MIME);
        if (mime != null && mime.startsWith("audio/")) {
          p.mime = mime;
          if (f.containsKey(MediaFormat.KEY_SAMPLE_RATE)) p.sampleRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE);
          if (f.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) p.channels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
          break;
        }
      }
    } finally {
      mx.release();
    }
  }

  private static int le16(byte[] b, int o) {
    return (b[o] & 0xff) | ((b[o + 1] & 0xff) << 8);
  }

  private static int le32(byte[] b, int o) {
    return (b[o] & 0xff) | ((b[o + 1] & 0xff) << 8) | ((b[o + 2] & 0xff) << 16) | ((b[o + 3] & 0xff) << 24);
  }
}
