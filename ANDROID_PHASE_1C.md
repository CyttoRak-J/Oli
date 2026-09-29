# Android phase 1c brief: the music that is already on the phone

Read `ANDROID_PLAN.md`, `HANDOFF.md` ("Start here") and the top of `ANDROID_PHASE_1B.md` first. Phase 1b (native audio) is built but the owner had not yet tested it on a phone when this was written: **start by asking for or reading their phone results** and fix anything reported before adding features.

## Goal
Oli on Android finds the music on the phone (not only Internet Archive downloads), shows it with cover art, keeps it up to date, and plays it through the native player (`file://` or `content://` URIs work in ExoPlayer).

## Work items
1. **MediaStore scanner plugin** (Java, `android/app/src/main/java/com/cyttos/oli/`): query `MediaStore.Audio.Media` (title, artist, album, album artist, track no., year, duration, size, `DATE_MODIFIED`, `RELATIVE_PATH`, content URI). Permission `READ_MEDIA_AUDIO` (Android 13+) or `READ_EXTERNAL_STORAGE` (<= 12), asked at runtime with a plain-language explanation. A `ContentObserver` reports changes; the JS side re-scans incrementally by `DATE_MODIFIED`.
2. **Tags MediaStore does not give** (bit depth, sample rate, codec, ReplayGain, lyrics, disc number, composer, ISRC): read with `MediaExtractor`/`MediaMetadataRetriever` and, for FLAC/MP3/M4A, a small tag reader (port of the logic in `src/main/services/audioTags.ts` / `metadata*`). `SourceProbe.java` already parses FLAC/WAV headers (rate, channels, bit depth) and can be reused.
3. **Feed the shared library code**: the desktop `scanner.ts` + `LibraryQueries` expect file paths and `music-metadata` results. Map the MediaStore rows to the same `Track` rows with the same cyrb64 ids (`hash64` in `src/main/util/identity.ts`, never change it) so albums/artists/genres/stats pages work unchanged. Keep `path` as a URI string that `NativeAudio` accepts (`content://media/external/audio/media/<id>` works with ExoPlayer and SourceProbe).
4. **Cover art**: `MediaMetadataRetriever.getEmbeddedPicture()` (and folder art via `MediaStore` album art / `ContentResolver.loadThumbnail`) into a size-limited cache; the notification artwork (`setMetadata.artworkUri`) can then use a file URI.
5. **Folder picker / library folders** (Settings > Library): Storage Access Framework tree picker for music outside MediaStore's audio collection; missing-file handling like desktop (mark missing, return when the file reappears).
6. Update `ANDROID_PLAN.md`, `HANDOFF.md`, this file, `NEXT_CHAT_PROMPT.md` and `CONTINUE_PROMPT.md`; ship `android-v0.4.0` (versionCode 4).

## How to prove it
- Unit tests for the mapping (MediaStore row -> `Track`, id equality with desktop ids) and the incremental-scan bookkeeping with a fake plugin.
- Extend `scripts/android-harness` with a fake `OliMediaScan` plugin that lists files from `A:\Flac`, and check that the library pages show them and playing works.
- Java: compile-check with the `android-dev` branch (CI); state plainly what only a phone can show (permission dialog, real MediaStore contents, scan speed on thousands of songs: relevant for the native-rewrite triggers).

## Traps
- See `HANDOFF.md` "Traps to remember" (Capacitor plugin proxies are thenables, no heredocs with apostrophes, port 8765, stop test windows by process id).
- A 2,000+ song library must not lag: scan in batches, never hold everything in one plugin call result (Capacitor bridge messages are size-limited in practice; page the results, ~500 rows per call).
