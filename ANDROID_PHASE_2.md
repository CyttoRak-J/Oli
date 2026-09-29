# Android phase 2: downloads that behave, tags, backup

> **STATUS: built and shipped as android-v0.5.0 (versionCode 5). Not yet run on a phone.**
>
> **What exists** (details: section 20.4 of `BUILD_FROM_SCRATCH.md`)
> - Pure Java, tested on the PC with the JDK (`test/androidDownload.test.ts`, `test/androidTagWriter.test.ts`): `DownloadEngine` (2 at a time, `.part` files, HTTP Range resume, pause/cancel, retries, size + MD5 check, then tags), `FlacTagWriter`, `Id3TagWriter` (audio bytes proven identical; tags and cover read back by `music-metadata` / `node-id3`, also on a real hi-res FLAC of the owner's library), `TagFields`.
> - Android glue: `OliDownloadService` (foreground service `dataSync`, progress notification), `OliDownloadPlugin` (`enqueue`, `pause`, `resume`, `cancel`, `getActive`, `getRoot`, `writeTags`).
> - JS: `platform/downloadQueue.ts` (the list + jobs in localStorage, resumes what was interrupted, `prepare` step), `songEdits.ts` (tag editing incl. file write for the app's own downloads), `phoneBackup.ts` (daily automatic backup, share-sheet export, restore with validation), wiring in `webBackend.ts`; `@capacitor/share` added.
> - Decisions: downloads stay in the app's own folder (`Android/data/com.cyttos.oli/files/Oli/`, removed on uninstall — ask the owner whether to move them to shared `Music/` through MediaStore); songs from the media library are edited inside the app only (Android owns those files); WavPack/APE transcoding was **not** built (APK size); online metadata matching ("fix metadata") moved to phase 3 and then not built.
> - Bugs found by the PC checks on the way: the `build.gradle` byte-order mark, `java.nio.file` needs Android 8 (minSdk is 24), the Downloads screen overflowed on a phone.
>
> **Owner's phone checklist for 0.5.0**
> 1. Internet Archive page: search "24bit flac", download three tracks. Progress and speed move; a notification "Downloading 3 files" stays with the screen off; the songs appear in Songs when done.
> 2. Pause one, resume it; switch on airplane mode in the middle: it fails with "Connection problem", switch off, tap retry: it continues (does not restart from 0).
> 3. Swipe Oli away in the middle of a download, open it again: it carries on by itself.
> 4. Open a finished file in another app (a music player or Files): title, artist, album, track number and the cover are there.
> 5. Edit a downloaded song's tags in Oli; check the other app shows the new tags after a rescan. Edit a song from your phone's music: the change stays in Oli.
> 6. Settings > Backup & restore: create, export (share sheet), restore. After a restore the library is as it was.
>
> **If something fails first look at**: the foreground service start (`ForegroundServiceStartNotAllowed`, notification permission), scoped storage (`writeTags` refuses files outside the app folder), the Range/`.part` handling with a real archive.org redirect, the share sheet needing a cache file URI.

---

## Original brief

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
