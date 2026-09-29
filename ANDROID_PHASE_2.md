# Android phase 2 brief: downloads that behave, tags, backup

Read `ANDROID_PLAN.md`, `HANDOFF.md` ("Start here") and the top of `ANDROID_PHASE_1B.md` / `ANDROID_PHASE_1C.md` first. Phases 1b and 1c were built without a phone: **start by asking for the owner's phone results of android-v0.3.0 / 0.4.0 and fix what they report before adding features.**

## Goal
Everything the PC app does after a song exists: a real download queue, correct tags and covers for downloaded files, editing tags / fixing metadata, backup and restore.

## Work items
1. **Downloads queue** (`webBackend.ts` runs a simple sequential queue over `Filesystem.downloadFile`): make it the PC behaviour: pause / resume / retry / cancel, persisted across restarts, several at once (limit 2-3), progress + speed, survives the app going to the background (a foreground service for downloads; Android kills web-view timers). Native plugin `OliDownload` (Java, `DownloadManager` or OkHttp with Range resume) is the likely shape; the JS side keeps the `downloads` table logic from `src/main/services/downloads.ts` (port the state machine, not the Node calls).
2. **Checksum + tags for Archive downloads**: verify md5 from the item's file list (`src/shared/archiveCore.ts` already parses it), embed title/artist/album/track/year and the cover into FLAC/MP3 like `src/main/services/audioTags.ts` (port to Java: a small Vorbis-comment/ID3 writer that rewrites through a temp file, never touching the original until complete). Downloaded songs then have real tags for the phone scan (1c) too. Optionally register the file with MediaStore (`MediaScannerConnection.scanFile`) so other apps see it.
3. **Tag editing / "fix metadata"** for phone songs: the metadata matching (Spotify/iTunes/Deezer/JioSaavn/MusicBrainz fetch logic in `provider.ts`) moved to a shared module used by both apps; writing tags to files needs the tag writer above plus scoped-storage write access (`MediaStore.createWriteRequest` for files owned by other apps).
4. **Backup / restore / export / import** of the library database: export `db.exportBytes()` with the share sheet / a file picker (Capacitor Share + Filesystem), restore with validation like `src/main/services/database.ts` (damaged file preserved, restore validated before swapping). Auto-backup rotation like the PC.
5. **Transcode fallback** (Opus/WavPack/APE): ExoPlayer plays Opus/Vorbis/FLAC/ALAC/WAV/MP3/AAC natively; WavPack/APE would need the ffmpeg extension of Media3 or a converter: decide whether it is worth the APK size (measure).
6. Update `ANDROID_PLAN.md`, `HANDOFF.md`, `NEXT_CHAT_PROMPT.md`, `CONTINUE_PROMPT.md`; ship `android-v0.5.0` (versionCode 5).

## How to prove it
- Unit tests for the queue state machine and the tag writer's byte output (compare with `audioTags.ts` results on the same input).
- The PC test window (`scripts/android-harness`) with stand-ins for `OliDownload`; Java compile-check with the `android-dev` branch. State plainly what only a phone can show (real background downloads, scoped-storage writes).

## Traps
- `HANDOFF.md` "Traps to remember". Downloads live in `Android/data/com.cyttos.oli/files/Oli/` (removed on uninstall): decide with the owner whether to move them to shared `Music/` via MediaStore.
