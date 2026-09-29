package com.cyttos.oli;

/**
 * Tags to write into a file. A null / 0 field means "leave as it is". Plain Java on purpose (no Android classes) so the
 * writers can be compiled and tested on a PC.
 */
final class TagFields {
  String title;
  String artist;
  String albumArtist;
  String album;
  String genre;
  String composer;
  String isrc;
  String lyrics;
  int trackNo;
  int discNo;
  int year;
  /** Front cover (JPEG or PNG bytes) and its MIME type; null = keep the cover the file has. */
  byte[] cover;
  String coverMime;

  boolean isEmpty() {
    return title == null && artist == null && albumArtist == null && album == null && genre == null && composer == null
        && isrc == null && lyrics == null && trackNo <= 0 && discNo <= 0 && year <= 0 && cover == null;
  }
}
