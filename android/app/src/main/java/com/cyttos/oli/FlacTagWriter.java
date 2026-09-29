package com.cyttos.oli;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.io.BufferedOutputStream;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Writes tags (Vorbis comments and the front cover) into a FLAC file without touching the audio: the metadata blocks
 * are rebuilt, everything else in the file is copied unchanged into a temporary file that then replaces the original,
 * so an interrupted write never damages the song. Tags and the cover that are not being changed are kept.
 */
final class FlacTagWriter {
  private static final int TYPE_STREAMINFO = 0;
  private static final int TYPE_PADDING = 1;
  private static final int TYPE_VORBIS = 4;
  private static final int TYPE_PICTURE = 6;
  private static final int PADDING = 2048;
  private static final long MAX_BLOCK = 64L * 1024 * 1024;

  private FlacTagWriter() {}

  private static final class Block {
    final int type;
    final byte[] data;

    Block(int type, byte[] data) {
      this.type = type;
      this.data = data;
    }
  }

  /** Returns false when the file is not a FLAC file (nothing is changed then). */
  static boolean write(File file, TagFields f) throws IOException {
    List<Block> keep = new ArrayList<>();
    List<byte[]> pictures = new ArrayList<>();
    List<String> comments = new ArrayList<>();
    String vendor = "Oli";
    long audioStart;
    long skipId3;

    try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
      byte[] head = new byte[10];
      in.readFully(head, 0, 4);
      skipId3 = 0;
      if (head[0] == 'I' && head[1] == 'D' && head[2] == '3') {
        in.readFully(head, 4, 6);
        int size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
        skipId3 = 10L + size;
        in.seek(skipId3);
        in.readFully(head, 0, 4);
      }
      if (head[0] != 'f' || head[1] != 'L' || head[2] != 'a' || head[3] != 'C') return false;
      boolean last = false;
      while (!last) {
        int b0 = in.read();
        int b1 = in.read();
        int b2 = in.read();
        int b3 = in.read();
        if (b3 < 0) throw new IOException("Truncated FLAC metadata");
        last = (b0 & 0x80) != 0;
        int type = b0 & 0x7f;
        long len = ((long) b1 << 16) | (b2 << 8) | b3;
        if (len > MAX_BLOCK) throw new IOException("Metadata block too large");
        byte[] data = new byte[(int) len];
        in.readFully(data);
        if (type == TYPE_VORBIS) {
          vendor = parseVorbis(data, comments);
        } else if (type == TYPE_PICTURE) {
          pictures.add(data);
        } else if (type != TYPE_PADDING) {
          keep.add(new Block(type, data));
        }
      }
      audioStart = in.getFilePointer();
      if (keep.isEmpty() || keep.get(0).type != TYPE_STREAMINFO) throw new IOException("STREAMINFO missing");

      // merged comments
      applyComments(comments, f);
      byte[] vorbis = buildVorbis(vendor, comments);

      // pictures: a new front cover replaces the old front cover(s); other pictures stay
      List<byte[]> outPics = new ArrayList<>();
      if (f.cover != null && f.cover.length > 0) {
        for (byte[] p : pictures) if (pictureType(p) != 3) outPics.add(p);
        outPics.add(buildPicture(f.cover, f.coverMime));
      } else {
        outPics.addAll(pictures);
      }

      List<Block> out = new ArrayList<>(keep);
      out.add(new Block(TYPE_VORBIS, vorbis));
      for (byte[] p : outPics) out.add(new Block(TYPE_PICTURE, p));
      out.add(new Block(TYPE_PADDING, new byte[PADDING]));

      File tmp = new File(file.getParentFile(), file.getName() + ".tagging");
      try (OutputStream os = new BufferedOutputStream(new FileOutputStream(tmp), 1 << 16)) {
        os.write(new byte[] {'f', 'L', 'a', 'C'});
        for (int i = 0; i < out.size(); i++) {
          Block b = out.get(i);
          int flag = i == out.size() - 1 ? 0x80 : 0;
          os.write(flag | b.type);
          os.write((b.data.length >> 16) & 0xff);
          os.write((b.data.length >> 8) & 0xff);
          os.write(b.data.length & 0xff);
          os.write(b.data);
        }
        in.seek(audioStart);
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
      } catch (IOException | RuntimeException e) {
        //noinspection ResultOfMethodCallIgnored
        tmp.delete();
        throw e;
      }
      in.close();
      replace(tmp, file);
    }
    return true;
  }

  static void replace(File tmp, File target) throws IOException {
    try {
      Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    } catch (IOException e) {
      Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }
  }

  private static String parseVorbis(byte[] b, List<String> out) {
    String vendor = "Oli";
    int o = 0;
    if (b.length < 8) return vendor;
    int vlen = le32(b, o);
    o += 4;
    if (vlen < 0 || o + vlen + 4 > b.length) return vendor;
    vendor = new String(b, o, vlen, StandardCharsets.UTF_8);
    o += vlen;
    int count = le32(b, o);
    o += 4;
    for (int i = 0; i < count && o + 4 <= b.length; i++) {
      int len = le32(b, o);
      o += 4;
      if (len < 0 || o + len > b.length) break;
      out.add(new String(b, o, len, StandardCharsets.UTF_8));
      o += len;
    }
    return vendor;
  }

  private static void removeKey(List<String> comments, String key) {
    String prefix = key.toUpperCase(Locale.ROOT) + "=";
    comments.removeIf((c) -> c.toUpperCase(Locale.ROOT).startsWith(prefix));
  }

  private static void put(List<String> comments, String key, String value) {
    if (value == null) return;
    removeKey(comments, key);
    String v = value.trim();
    if (!v.isEmpty()) comments.add(key + "=" + v);
  }

  private static void applyComments(List<String> c, TagFields f) {
    put(c, "TITLE", f.title);
    put(c, "ARTIST", f.artist);
    put(c, "ALBUMARTIST", f.albumArtist);
    if (f.albumArtist != null) removeKey(c, "ALBUM ARTIST");
    put(c, "ALBUM", f.album);
    put(c, "GENRE", f.genre);
    put(c, "COMPOSER", f.composer);
    put(c, "ISRC", f.isrc);
    if (f.lyrics != null) {
      removeKey(c, "UNSYNCEDLYRICS");
      put(c, "LYRICS", f.lyrics);
    }
    if (f.trackNo > 0) put(c, "TRACKNUMBER", String.valueOf(f.trackNo));
    if (f.discNo > 0) put(c, "DISCNUMBER", String.valueOf(f.discNo));
    if (f.year > 0) {
      removeKey(c, "YEAR");
      put(c, "DATE", String.valueOf(f.year));
    }
  }

  private static byte[] buildVorbis(String vendor, List<String> comments) throws IOException {
    ByteArrayOutputStream bo = new ByteArrayOutputStream();
    byte[] v = vendor.getBytes(StandardCharsets.UTF_8);
    writeLe32(bo, v.length);
    bo.write(v);
    writeLe32(bo, comments.size());
    for (String c : comments) {
      byte[] cb = c.getBytes(StandardCharsets.UTF_8);
      writeLe32(bo, cb.length);
      bo.write(cb);
    }
    return bo.toByteArray();
  }

  private static int pictureType(byte[] p) {
    return p.length >= 4 ? ((p[0] & 0xff) << 24) | ((p[1] & 0xff) << 16) | ((p[2] & 0xff) << 8) | (p[3] & 0xff) : -1;
  }

  private static byte[] buildPicture(byte[] data, String mime) throws IOException {
    String m = mime == null || mime.isEmpty() ? guessMime(data) : mime;
    int[] wh = dimensions(data);
    ByteArrayOutputStream bo = new ByteArrayOutputStream();
    writeBe32(bo, 3); // front cover
    byte[] mb = m.getBytes(StandardCharsets.US_ASCII);
    writeBe32(bo, mb.length);
    bo.write(mb);
    writeBe32(bo, 0); // description
    writeBe32(bo, wh[0]);
    writeBe32(bo, wh[1]);
    writeBe32(bo, 24); // colour depth
    writeBe32(bo, 0); // indexed colours
    writeBe32(bo, data.length);
    bo.write(data);
    return bo.toByteArray();
  }

  static String guessMime(byte[] d) {
    if (d.length > 8 && (d[0] & 0xff) == 0x89 && d[1] == 'P' && d[2] == 'N' && d[3] == 'G') return "image/png";
    return "image/jpeg";
  }

  /** Width and height of a PNG or JPEG (0, 0 when unknown; the FLAC spec allows that). */
  static int[] dimensions(byte[] d) {
    try {
      if (d.length > 24 && (d[0] & 0xff) == 0x89 && d[1] == 'P') {
        int w = ((d[16] & 0xff) << 24) | ((d[17] & 0xff) << 16) | ((d[18] & 0xff) << 8) | (d[19] & 0xff);
        int h = ((d[20] & 0xff) << 24) | ((d[21] & 0xff) << 16) | ((d[22] & 0xff) << 8) | (d[23] & 0xff);
        return new int[] {w, h};
      }
      if (d.length > 4 && (d[0] & 0xff) == 0xff && (d[1] & 0xff) == 0xd8) {
        int i = 2;
        while (i + 9 < d.length) {
          if ((d[i] & 0xff) != 0xff) {
            i++;
            continue;
          }
          int marker = d[i + 1] & 0xff;
          if (marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc) {
            int h = ((d[i + 5] & 0xff) << 8) | (d[i + 6] & 0xff);
            int w = ((d[i + 7] & 0xff) << 8) | (d[i + 8] & 0xff);
            return new int[] {w, h};
          }
          int len = ((d[i + 2] & 0xff) << 8) | (d[i + 3] & 0xff);
          i += 2 + len;
        }
      }
    } catch (RuntimeException ignored) {
      // unknown size
    }
    return new int[] {0, 0};
  }

  private static int le32(byte[] b, int o) {
    return (b[o] & 0xff) | ((b[o + 1] & 0xff) << 8) | ((b[o + 2] & 0xff) << 16) | ((b[o + 3] & 0xff) << 24);
  }

  private static void writeLe32(ByteArrayOutputStream o, int v) {
    o.write(v & 0xff);
    o.write((v >> 8) & 0xff);
    o.write((v >> 16) & 0xff);
    o.write((v >> 24) & 0xff);
  }

  private static void writeBe32(ByteArrayOutputStream o, int v) {
    o.write((v >> 24) & 0xff);
    o.write((v >> 16) & 0xff);
    o.write((v >> 8) & 0xff);
    o.write(v & 0xff);
  }
}
