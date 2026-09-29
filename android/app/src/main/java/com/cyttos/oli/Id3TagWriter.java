package com.cyttos.oli;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Writes tags into an MP3 file (an ID3v2 tag at the start): the frames that are being changed are replaced, all other
 * frames (including a cover that is not being replaced) are kept as they are, and the audio is copied unchanged into a
 * temporary file that then replaces the original. New tags use ID3v2.3 with UTF-16 text (the most compatible form); a
 * file that already has ID3v2.4 keeps v2.4 (UTF-8 text) so its own frames stay valid.
 */
final class Id3TagWriter {
  private static final int PADDING = 512;
  private static final long MAX_TAG = 32L * 1024 * 1024;

  private Id3TagWriter() {}

  private static final class Frame {
    final String id;
    final byte[] data;

    Frame(String id, byte[] data) {
      this.id = id;
      this.data = data;
    }
  }

  /** Returns false when the file cannot hold ID3 tags (nothing is changed then). */
  static boolean write(File file, TagFields f) throws IOException {
    int version = 3;
    long audioStart = 0;
    List<Frame> kept = new ArrayList<>();
    try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
      byte[] h = new byte[10];
      int got = in.read(h);
      if (got == 10 && h[0] == 'I' && h[1] == 'D' && h[2] == '3' && (h[3] == 3 || h[3] == 4)) {
        version = h[3];
        int flags = h[5] & 0xff;
        long size = syncsafe(h, 6);
        if (size > MAX_TAG || 10 + size > in.length()) throw new IOException("ID3 tag looks damaged");
        audioStart = 10 + size + ((flags & 0x10) != 0 && version == 4 ? 10 : 0);
        byte[] tag = new byte[(int) size];
        in.readFully(tag);
        if ((flags & 0x80) != 0 && version == 3) tag = unsync(tag);
        readFrames(tag, version, (flags & 0x40) != 0, kept);
      } else if (got >= 3 && h[0] == 'I' && h[1] == 'D' && h[2] == '3') {
        return false; // ID3v2.2 or unknown: leave alone
      }
      // a file without a tag: ID3v2.3 from the start
      Set<String> replaced = replacedIds(f, version);
      List<Frame> out = new ArrayList<>();
      for (Frame fr : kept) if (!replaced.contains(fr.id)) out.add(fr);
      addNew(out, f, version);

      ByteArrayOutputStream frames = new ByteArrayOutputStream();
      for (Frame fr : out) {
        frames.write(fr.id.getBytes(StandardCharsets.US_ASCII));
        writeSize(frames, fr.data.length, version);
        frames.write(0);
        frames.write(0);
        frames.write(fr.data);
      }
      frames.write(new byte[PADDING]);
      byte[] body = frames.toByteArray();

      File tmp = new File(file.getParentFile(), file.getName() + ".tagging");
      try (OutputStream os = new BufferedOutputStream(new FileOutputStream(tmp), 1 << 16)) {
        os.write(new byte[] {'I', 'D', '3', (byte) version, 0, 0});
        os.write(new byte[] {
          (byte) ((body.length >> 21) & 0x7f), (byte) ((body.length >> 14) & 0x7f),
          (byte) ((body.length >> 7) & 0x7f), (byte) (body.length & 0x7f)
        });
        os.write(body);
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
      FlacTagWriter.replace(tmp, file);
    }
    return true;
  }

  private static Set<String> replacedIds(TagFields f, int version) {
    Set<String> s = new HashSet<>();
    if (f.title != null) s.add("TIT2");
    if (f.artist != null) s.add("TPE1");
    if (f.albumArtist != null) s.add("TPE2");
    if (f.album != null) s.add("TALB");
    if (f.genre != null) s.add("TCON");
    if (f.composer != null) s.add("TCOM");
    if (f.isrc != null) s.add("TSRC");
    if (f.lyrics != null) s.add("USLT");
    if (f.trackNo > 0) s.add("TRCK");
    if (f.discNo > 0) s.add("TPOS");
    if (f.year > 0) {
      s.add("TYER");
      s.add("TDRC");
      s.add("TDAT");
    }
    if (f.cover != null && f.cover.length > 0) s.add("APIC");
    return s;
  }

  private static void addNew(List<Frame> out, TagFields f, int version) throws IOException {
    text(out, "TIT2", f.title, version);
    text(out, "TPE1", f.artist, version);
    text(out, "TPE2", f.albumArtist, version);
    text(out, "TALB", f.album, version);
    text(out, "TCON", f.genre, version);
    text(out, "TCOM", f.composer, version);
    text(out, "TSRC", f.isrc, version);
    if (f.trackNo > 0) text(out, "TRCK", String.valueOf(f.trackNo), version);
    if (f.discNo > 0) text(out, "TPOS", String.valueOf(f.discNo), version);
    if (f.year > 0) text(out, version == 4 ? "TDRC" : "TYER", String.valueOf(f.year), version);
    if (f.lyrics != null && !f.lyrics.trim().isEmpty()) {
      ByteArrayOutputStream b = new ByteArrayOutputStream();
      b.write(encodingByte(version));
      b.write(new byte[] {'e', 'n', 'g'});
      b.write(encode("", version)); // empty descriptor
      b.write(terminator(version));
      b.write(encode(f.lyrics.trim(), version));
      out.add(new Frame("USLT", b.toByteArray()));
    }
    if (f.cover != null && f.cover.length > 0) {
      ByteArrayOutputStream b = new ByteArrayOutputStream();
      b.write(0); // ISO-8859-1 for the (ASCII) MIME type and the empty description
      String mime = f.coverMime == null || f.coverMime.isEmpty() ? FlacTagWriter.guessMime(f.cover) : f.coverMime;
      b.write(mime.getBytes(StandardCharsets.US_ASCII));
      b.write(0);
      b.write(3); // front cover
      b.write(0); // empty description
      b.write(f.cover);
      out.add(new Frame("APIC", b.toByteArray()));
    }
  }

  private static void text(List<Frame> out, String id, String value, int version) throws IOException {
    if (value == null || value.trim().isEmpty()) return;
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    b.write(encodingByte(version));
    b.write(encode(value.trim(), version));
    out.add(new Frame(id, b.toByteArray()));
  }

  private static int encodingByte(int version) {
    return version == 4 ? 3 : 1;
  }

  private static byte[] terminator(int version) {
    return version == 4 ? new byte[] {0} : new byte[] {0, 0};
  }

  private static byte[] encode(String s, int version) {
    if (version == 4) return s.getBytes(StandardCharsets.UTF_8);
    byte[] body = s.getBytes(StandardCharsets.UTF_16LE);
    byte[] out = new byte[body.length + 2];
    out[0] = (byte) 0xff;
    out[1] = (byte) 0xfe;
    System.arraycopy(body, 0, out, 2, body.length);
    return s.isEmpty() ? new byte[] {(byte) 0xff, (byte) 0xfe} : out;
  }

  private static void readFrames(byte[] tag, int version, boolean extHeader, List<Frame> out) {
    int o = 0;
    if (extHeader && tag.length >= 4) {
      int ext = version == 4 ? (int) syncsafe(tag, 0) : ((tag[0] & 0xff) << 24 | (tag[1] & 0xff) << 16 | (tag[2] & 0xff) << 8 | (tag[3] & 0xff)) + 4;
      if (ext > 0 && ext <= tag.length) o = ext;
    }
    while (o + 10 <= tag.length) {
      if (tag[o] == 0) break; // padding
      String id = new String(tag, o, 4, StandardCharsets.US_ASCII);
      int size = version == 4 ? (int) syncsafe(tag, o + 4)
          : ((tag[o + 4] & 0xff) << 24) | ((tag[o + 5] & 0xff) << 16) | ((tag[o + 6] & 0xff) << 8) | (tag[o + 7] & 0xff);
      int flag1 = tag[o + 8] & 0xff;
      int flag2 = tag[o + 9] & 0xff;
      o += 10;
      if (size < 0 || o + size > tag.length) break;
      // frames with compression / encryption / grouping / unsynchronisation flags are dropped (they could not be
      // copied verbatim); ordinary frames are kept exactly as they were
      boolean plain = version == 4 ? (flag2 & 0x4f) == 0 : (flag2 & 0xe0) == 0;
      if (plain && id.matches("[A-Z0-9]{4}")) out.add(new Frame(id, Arrays.copyOfRange(tag, o, o + size)));
      o += size;
    }
  }

  private static byte[] unsync(byte[] d) {
    ByteArrayOutputStream o = new ByteArrayOutputStream(d.length);
    for (int i = 0; i < d.length; i++) {
      o.write(d[i]);
      if ((d[i] & 0xff) == 0xff && i + 1 < d.length && d[i + 1] == 0) i++;
    }
    return o.toByteArray();
  }

  private static long syncsafe(byte[] b, int o) {
    return ((long) (b[o] & 0x7f) << 21) | ((long) (b[o + 1] & 0x7f) << 14) | ((long) (b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
  }

  private static void writeSize(ByteArrayOutputStream o, int n, int version) {
    if (version == 4) {
      o.write((n >> 21) & 0x7f);
      o.write((n >> 14) & 0x7f);
      o.write((n >> 7) & 0x7f);
      o.write(n & 0x7f);
    } else {
      o.write((n >> 24) & 0xff);
      o.write((n >> 16) & 0xff);
      o.write((n >> 8) & 0xff);
      o.write(n & 0xff);
    }
  }
}
