# Android phase 1c brief: the music that is already on the phone

> **STATUS: built and shipped as android-v0.4.0 (versionCode 4). Not yet run on a phone.**
>
> **What exists**
> - Java: `OliMediaPlugin` (Capacitor plugin `OliMedia`: `getPermission`, `requestPermission` (READ_MEDIA_AUDIO on Android 13+, READ_EXTERNAL_STORAGE before), `queryAudio({offset,limit})` (MediaStore.Audio, `IS_MUSIC != 0`, sorted by id, 500 per page), `probeFiles({uris})`, `getArtwork({uri,key,size})`, `clearArtworkCache`; event `mediaChanged` from a ContentObserver, debounced 3 s), `FlacTags` (Vorbis comments: ReplayGain, ISRC, lyrics, composer, genre, disc), `SourceProbe` (reused from 1b).
> - JS: `platform/phoneLibrary.ts` (`PhoneLibrary`: permission, paging, diff against the database, missing/returning, background detail reading in batches of 20, per-album cover lookup; pure mapping `rowToTrack`, `probeToPatch`), `platform/phoneStore.ts` (all SQL: location, bulk upsert in a transaction, mark missing, patch details), wiring in `webBackend.ts` (`addLibraryFolder` = "Scan phone music", `rescanLibrary`, `cancelScan`, `getScanState`, `getEmbeddedArtwork`, first-start ask-once + scan on launch when `scanOnLaunch`), phone wording in Settings > Library.
> - Design decisions: one library location `phone:mediastore` ("Phone music"). Song id = `songIdForPath("<RELATIVE_PATH><file name>")` (desktop cyrb64 scheme; stable when Android renumbers its ids); the row's `path` is the `content://` URI that ExoPlayer plays. `modified_at` = file mtime, so unchanged files are skipped. A changed file resets its rate/bit depth/channels and is re-read; a moved file keeps its old row (missing) and gives up its path so playlists keep pointing at something. `sample_rate` NULL = details never read, 0 = read, nothing found. Covers are cached per album as `cacheDir/art/<albumId>.jpg` (`.none` marker when there is no cover) and shown through `Capacitor.convertFileSrc`.
> - Not done (on purpose or later): SAF file walk for folders MediaStore does not list, duplicate detection (the folder picker itself came in 0.8.0, see below), ReplayGain/lyrics from MP3/M4A tags (FLAC only), 24-bit ALAC detection (bit depth unknown for M4A), notification/lock-screen artwork for local songs (needs the cached file path passed to `setMetadata`), `hasEmbeddedArtwork` flag (covers are looked up lazily instead).
>
> **Owner's phone checklist for 0.4.0**
> 1. Install `Oli-0.4.0-android.apk`, open it: Android asks to allow access to music; allow. Settings > Library shows "Phone music" and a count; the first scan progress ("Reading song details...") appears. How many songs, how long did it take? (Tell me if it feels slow or the app lags meanwhile.)
> 2. Songs / Albums / Artists show your music with covers. Tags right? (Compare a few songs with the PC app.) Any songs missing or extra (voice notes, ringtones)?
> 3. Play a 24-bit FLAC from your phone: the badge shows `FLAC 24-bit / 96 kHz` and Settings > Audio output shows the real path.
> 4. Copy a new song to the phone (or delete one) with Oli open: within ~30 s it appears / becomes missing without touching "Rescan".
> 5. Deny the permission (Android settings) and open Oli: Settings > Library says what to do.
> 6. Scroll a big list (thousands of songs): smooth? (native-rewrite triggers 1, 2 and 4 in `ANDROID_PLAN.md`).
>
> **If something fails first look at**: the MediaStore columns (`queryAudio` rejects with the exception text; older Android has no RELATIVE_PATH/ALBUM_ARTIST), the `content://` URI opening in `SourceProbe`/ExoPlayer, `_capacitor_file_` URLs for files in the cache folder (covers stay initials if the web view refuses them), and IndexedDB size for very large libraries.

---

## Original brief

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
