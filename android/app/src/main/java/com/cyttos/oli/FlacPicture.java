package com.cyttos.oli;

import java.io.IOException;
import java.io.InputStream;

/**
 * Reads the cover picture embedded in a FLAC file (the PICTURE metadata block). Android's own media reader does not
 * find it in every FLAC file, so covers of a FLAC library would be missing. Plain Java (no Android classes): tested on
 * the PC with the JDK. Only the metadata blocks at the start of the stream are read; the audio is never touched.
 */
final class FlacPicture {
  private static final int MAX_PICTURE = 12 * 1024 * 1024;

  private FlacPicture() {}

  /** The picture bytes (JPEG / PNG ...), preferring the "front cover"; null when there is none. */
  static byte[] find(InputStream in) {
    try {
      byte[] b4 = new byte[4];
      if (!readFully(in, b4, 4)) return null;
      if (b4[0] == 'I' && b4[1] == 'D' && b4[2] == '3') { // an ID3v2 tag in front of the FLAC stream
        byte[] rest = new byte[6];
        if (!readFully(in, rest, 6)) return null;
        int size = ((rest[2] & 0x7f) << 21) | ((rest[3] & 0x7f) << 14) | ((rest[4] & 0x7f) << 7) | (rest[5] & 0x7f);
        skipFully(in, size);
        if (!readFully(in, b4, 4)) return null;
      }
      if (b4[0] != 'f' || b4[1] != 'L' || b4[2] != 'a' || b4[3] != 'C') return null;
      byte[] best = null;
      for (int i = 0; i < 256; i++) {
        byte[] h = new byte[4];
        if (!readFully(in, h, 4)) break;
        boolean last = (h[0] & 0x80) != 0;
        int type = h[0] & 0x7f;
        int len = ((h[1] & 0xff) << 16) | ((h[2] & 0xff) << 8) | (h[3] & 0xff);
        if (type == 6 && len <= MAX_PICTURE) {
          byte[] block = new byte[len];
          if (!readFully(in, block, len)) break;
          int[] kind = new int[1];
          byte[] pic = parse(block, kind);
          if (pic != null) {
            if (kind[0] == 3) return pic; // front cover
            if (best == null) best = pic;
          }
        } else {
          skipFully(in, len);
        }
        if (last) break;
      }
      return best;
    } catch (IOException e) {
      return null;
    }
  }

  private static byte[] parse(byte[] b, int[] kind) {
    int o = 0;
    if (b.length < 32) return null;
    kind[0] = be32(b, o);
    o += 4;
    int mimeLen = be32(b, o);
    o += 4;
    if (mimeLen < 0 || o + mimeLen + 4 > b.length) return null;
    o += mimeLen;
    int descLen = be32(b, o);
    o += 4;
    if (descLen < 0 || o + descLen + 20 > b.length) return null;
    o += descLen + 16; // width, height, depth, colors
    int dataLen = be32(b, o);
    o += 4;
    if (dataLen <= 0 || o + dataLen > b.length) return null;
    byte[] pic = new byte[dataLen];
    System.arraycopy(b, o, pic, 0, dataLen);
    return pic;
  }

  private static int be32(byte[] b, int o) {
    return ((b[o] & 0xff) << 24) | ((b[o + 1] & 0xff) << 16) | ((b[o + 2] & 0xff) << 8) | (b[o + 3] & 0xff);
  }

  private static boolean readFully(InputStream in, byte[] buf, int len) throws IOException {
    int got = 0;
    while (got < len) {
      int n = in.read(buf, got, len - got);
      if (n < 0) return false;
      got += n;
    }
    return true;
  }

  private static void skipFully(InputStream in, long n) throws IOException {
    while (n > 0) {
      long s = in.skip(n);
      if (s <= 0) {
        if (in.read() < 0) return;
        s = 1;
      }
      n -= s;
    }
  }
}
