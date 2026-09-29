package com.cyttos.oli;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** Test helper (not part of the app): prints what YtDlpOutput makes of each line of a UTF-8 file. usage: YtCli <file> */
public class YtCli {
  public static void main(String[] args) throws Exception {
    for (String line : Files.readAllLines(new File(args[0]).toPath(), StandardCharsets.UTF_8)) {
      if (line.startsWith("META ")) {
        System.out.println("meta=" + YtDlpOutput.metadataLiteral(line.substring(5)));
        continue;
      }
      YtDlpOutput.Progress p = YtDlpOutput.parse(line);
      System.out.println(p == null ? "none" : "pct=" + p.percent + " total=" + p.totalBytes + " done=" + p.downloadedBytes + " speed=" + p.bytesPerSecond + " eta=" + p.etaSeconds);
    }
  }
}
