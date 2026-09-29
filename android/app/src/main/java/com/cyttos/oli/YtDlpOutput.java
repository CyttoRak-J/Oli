package com.cyttos.oli;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads yt-dlp's progress lines ("[download]  12.3% of ~ 3.45MiB at 1.20MiB/s ETA 00:02"). Plain Java so it is
 * tested on a PC.
 */
final class YtDlpOutput {
  static final class Progress {
    double percent;
    long totalBytes;
    long downloadedBytes;
    long bytesPerSecond;
    long etaSeconds = -1;
  }

  private static final Pattern LINE = Pattern.compile(
      "\\[download\\]\\s+([\\d.]+)%\\s+of\\s+~?\\s*([\\d.]+)\\s*([KMGT]?i?B)"
          + "(?:\\s+at\\s+(?:([\\d.]+)\\s*([KMGT]?i?B)/s|Unknown B/s|N/A))?(?:\\s+ETA\\s+([\\d:]+|Unknown))?");

  private YtDlpOutput() {}

  /** null when the line is not a progress line. */
  static Progress parse(String line) {
    if (line == null) return null;
    Matcher m = LINE.matcher(line);
    if (!m.find()) return null;
    try {
      Progress p = new Progress();
      p.percent = Double.parseDouble(m.group(1));
      p.totalBytes = toBytes(Double.parseDouble(m.group(2)), m.group(3));
      p.downloadedBytes = Math.round(p.totalBytes * p.percent / 100.0);
      if (m.group(4) != null) p.bytesPerSecond = toBytes(Double.parseDouble(m.group(4)), m.group(5));
      if (m.group(6) != null && !"Unknown".equals(m.group(6))) p.etaSeconds = parseEta(m.group(6));
      return p;
    } catch (NumberFormatException e) {
      return null;
    }
  }

  private static long toBytes(double value, String unit) {
    String u = unit.toUpperCase(Locale.ROOT);
    double mul = 1;
    if (u.startsWith("K")) mul = 1024;
    else if (u.startsWith("M")) mul = 1024.0 * 1024;
    else if (u.startsWith("G")) mul = 1024.0 * 1024 * 1024;
    else if (u.startsWith("T")) mul = 1024.0 * 1024 * 1024 * 1024;
    return Math.round(value * mul);
  }

  private static long parseEta(String s) {
    long total = 0;
    for (String part : s.split(":")) total = total * 60 + Long.parseLong(part);
    return total;
  }

  /**
   * Text for yt-dlp's --parse-metadata "FROM:TO": FROM is an output template, so "%" is doubled and ":" escaped, or a
   * title like "50% : Live" would be read as a field or cut in two.
   */
  static String metadataLiteral(String value) {
    return value.replace("\\", "\\\\").replace("%", "%%").replace(":", "\\:");
  }
}
