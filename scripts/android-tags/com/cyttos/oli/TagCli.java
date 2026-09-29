package com.cyttos.oli;

import java.io.File;
import java.nio.file.Files;

/** Test helper (not part of the app): writes tags with the app's own writers. usage: TagCli <file> key=value ... */
public class TagCli {
  public static void main(String[] args) throws Exception {
    File file = new File(args[0]);
    TagFields f = new TagFields();
    // Text with non-ASCII letters cannot travel on a Windows command line: the pairs come from a UTF-8 file (@file).
    java.util.List<String> pairs = new java.util.ArrayList<>();
    for (int i = 1; i < args.length; i++) {
      if (args[i].startsWith("@")) {
        pairs.addAll(Files.readAllLines(new File(args[i].substring(1)).toPath(), java.nio.charset.StandardCharsets.UTF_8));
      } else {
        pairs.add(args[i]);
      }
    }
    for (String pair : pairs) {
      int eq = pair.indexOf('=');
      String k = pair.substring(0, eq);
      String v = pair.substring(eq + 1);
      switch (k) {
        case "title": f.title = v; break;
        case "artist": f.artist = v; break;
        case "albumArtist": f.albumArtist = v; break;
        case "album": f.album = v; break;
        case "genre": f.genre = v; break;
        case "composer": f.composer = v; break;
        case "isrc": f.isrc = v; break;
        case "lyrics": f.lyrics = v; break;
        case "track": f.trackNo = Integer.parseInt(v); break;
        case "disc": f.discNo = Integer.parseInt(v); break;
        case "year": f.year = Integer.parseInt(v); break;
        case "cover": f.cover = Files.readAllBytes(new File(v).toPath()); break;
        default: throw new IllegalArgumentException(k);
      }
    }
    String name = file.getName().toLowerCase();
    boolean ok = name.endsWith(".flac") ? FlacTagWriter.write(file, f) : Id3TagWriter.write(file, f);
    System.out.println(ok ? "written" : "unsupported");
  }
}
