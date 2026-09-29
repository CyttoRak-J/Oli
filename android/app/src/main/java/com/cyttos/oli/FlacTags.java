package com.cyttos.oli;

import android.content.Context;
import android.net.Uri;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Reads the Vorbis comments (the tags) of a FLAC file that Android's MediaStore does not list: ReplayGain, ISRC,
 * lyrics, album artist, disc number... Only the metadata blocks at the start of the file are read; the audio and the
 * (possibly large) cover-art block are skipped, not loaded.
 */
final class FlacTags {
  String trackGain = "";
  String albumGain = "";
  String isrc = "";
  String lyrics = "";
  String albumArtist = "";
  String composer = "";
  String genre = "";
  String discNumber = "";
  String trackNumber = "";
  String date = "";
  boolean any = false;

  private static final int MAX_COMMENT_BLOCK = 4 * 1024 * 1024;
  private static final int MAX_LYRICS_CHARS = 40000;

  static FlacTags read(Context ctx, Uri uri) {
    FlacTags t = new FlacTags();
    InputStream in = null;
    try {
      in = "file".equals(uri.getScheme()) ? new FileInputStream(uri.getPath()) : ctx.getContentResolver().openInputStream(uri);
      if (in == null) return t;
      byte[] b4 = new byte[4];
      if (!readFully(in, b4, 4)) return t;
      // Skip an ID3v2 tag in front of the stream.
      if (b4[0] == 'I' && b4[1] == 'D' && b4[2] == '3') {
        byte[] rest = new byte[6];
        if (!readFully(in, rest, 6)) return t;
        int size = ((rest[2] & 0x7f) << 21) | ((rest[3] & 0x7f) << 14) | ((rest[4] & 0x7f) << 7) | (rest[5] & 0x7f);
        skipFully(in, size);
        if (!readFully(in, b4, 4)) return t;
      }
      if (b4[0] != 'f' || b4[1] != 'L' || b4[2] != 'a' || b4[3] != 'C') return t;
      for (int i = 0; i < 128; i++) {
        byte[] h = new byte[4];
        if (!readFully(in, h, 4)) break;
        boolean last = (h[0] & 0x80) != 0;
        int type = h[0] & 0x7f;
        int len = ((h[1] & 0xff) << 16) | ((h[2] & 0xff) << 8) | (h[3] & 0xff);
        if (type == 4 && len <= MAX_COMMENT_BLOCK) {
          byte[] block = new byte[len];
          if (!readFully(in, block, len)) break;
          t.parse(block);
          break; // comments found: nothing more is needed
        }
        skipFully(in, len);
        if (last) break;
      }
    } catch (Exception ignored) {
      // Unreadable tags: the song still plays, it just has fewer details.
    } finally {
      if (in != null) {
        try {
          in.close();
        } catch (Exception ignored) {
          // nothing to do
        }
      }
    }
    return t;
  }

  private void parse(byte[] b) {
    int o = 0;
    if (b.length < 8) return;
    int vendor = le32(b, o);
    o += 4 + vendor;
    if (vendor < 0 || o + 4 > b.length) return;
    int count = le32(b, o);
    o += 4;
    for (int i = 0; i < count && o + 4 <= b.length; i++) {
      int len = le32(b, o);
      o += 4;
      if (len < 0 || o + len > b.length) break;
      String kv = new String(b, o, len, StandardCharsets.UTF_8);
      o += len;
      int eq = kv.indexOf('=');
      if (eq <= 0) continue;
      String key = kv.substring(0, eq).toUpperCase(java.util.Locale.ROOT);
      String val = kv.substring(eq + 1).trim();
      switch (key) {
        case "REPLAYGAIN_TRACK_GAIN":
          trackGain = val;
          break;
        case "REPLAYGAIN_ALBUM_GAIN":
          albumGain = val;
          break;
        case "ISRC":
          isrc = val;
          break;
        case "LYRICS":
        case "UNSYNCEDLYRICS":
          if (lyrics.isEmpty()) lyrics = val.length() > MAX_LYRICS_CHARS ? val.substring(0, MAX_LYRICS_CHARS) : val;
          break;
        case "ALBUMARTIST":
        case "ALBUM ARTIST":
          albumArtist = val;
          break;
        case "COMPOSER":
          composer = val;
          break;
        case "GENRE":
          if (genre.isEmpty()) genre = val;
          break;
        case "DISCNUMBER":
          discNumber = val;
          break;
        case "TRACKNUMBER":
          trackNumber = val;
          break;
        case "DATE":
        case "YEAR":
          if (date.isEmpty()) date = val;
          break;
        default:
          break;
      }
      any = true;
    }
  }

  private static int le32(byte[] b, int o) {
    return (b[o] & 0xff) | ((b[o + 1] & 0xff) << 8) | ((b[o + 2] & 0xff) << 16) | ((b[o + 3] & 0xff) << 24);
  }

  private static boolean readFully(InputStream in, byte[] buf, int n) throws Exception {
    int got = 0;
    while (got < n) {
      int r = in.read(buf, got, n - got);
      if (r < 0) return false;
      got += r;
    }
    return true;
  }

  private static void skipFully(InputStream in, long n) throws Exception {
    long left = n;
    while (left > 0) {
      long s = in.skip(left);
      if (s <= 0) {
        if (in.read() < 0) return;
        s = 1;
      }
      left -= s;
    }
  }
}
