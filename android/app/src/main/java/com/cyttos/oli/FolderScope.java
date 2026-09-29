package com.cyttos.oli;

/**
 * A folder the owner picked to be scanned, turned into what MediaStore can filter on. Plain Java (no Android classes) so
 * the PC's JDK can test it.
 *
 * The picker returns a document id like "primary:Music/Flac" (internal storage) or "1A2B-3C4D:Music" (a memory card).
 * MediaStore lists every audio file with its volume and its folder ("Music/Flac/Album/"), so choosing a folder means:
 * same volume, folder starts with the chosen path.
 */
public final class FolderScope {
  public final String volume; // "primary" or the card's id, as the picker names it
  public final String path; // "Music/Flac" (no slashes at the ends), "" = the whole volume

  private FolderScope(String volume, String path) {
    this.volume = volume;
    this.path = path;
  }

  /** "primary:Music/Flac" -> (primary, Music/Flac); null when the id is not a folder on a storage volume. */
  public static FolderScope fromDocumentId(String docId) {
    if (docId == null) return null;
    int colon = docId.indexOf(':');
    if (colon <= 0) return null;
    String volume = docId.substring(0, colon);
    // storage volumes are "primary" or a card id such as 1A2B-3C4D; anything else is another kind of provider
    if (!"primary".equals(volume) && !volume.matches("[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}")) return null;
    String path = clean(docId.substring(colon + 1));
    return new FolderScope(volume, path);
  }

  /** Slashes at both ends and doubled slashes removed. */
  public static String clean(String path) {
    if (path == null) return "";
    String p = path.replace('\\', '/');
    while (p.contains("//")) p = p.replace("//", "/");
    while (p.startsWith("/")) p = p.substring(1);
    while (p.endsWith("/")) p = p.substring(0, p.length() - 1);
    return p;
  }

  /** The volume name MediaStore uses in its VOLUME_NAME column. */
  public static String mediaVolume(String volume) {
    return "primary".equals(volume) ? "external_primary" : volume.toLowerCase(java.util.Locale.ROOT);
  }

  /** SQL LIKE pattern for the RELATIVE_PATH column (Android 10+): everything inside the folder. Use with ESCAPE '\'. */
  public static String relativeLike(String path) {
    String p = clean(path);
    return p.isEmpty() ? "%" : escapeLike(p) + "/%";
  }

  /** SQL LIKE pattern for the DATA column (Android 9 and older) given the volume's root folder, e.g. /storage/emulated/0. */
  public static String dataLike(String root, String path) {
    String base = root.endsWith("/") ? root.substring(0, root.length() - 1) : root;
    String p = clean(path);
    return p.isEmpty() ? escapeLike(base) + "/%" : escapeLike(base + "/" + p) + "/%";
  }

  /** Makes % and _ in a folder name literal (the query says ESCAPE '\'). */
  public static String escapeLike(String s) {
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
  }

  /** A short name for the screen: "Music/Flac", "Phone storage", "Card 1A2B-3C4D: Music". */
  public String label() {
    String where = "primary".equals(volume) ? "" : "Card " + volume + ": ";
    if (path.isEmpty()) return "primary".equals(volume) ? "Phone storage" : "Card " + volume;
    return where + path;
  }
}
