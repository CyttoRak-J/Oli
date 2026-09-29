# Android: goal, architecture, parity checklist, status

## Goal (owner's words, 2026-09-29)
"Want YouTube and Archive... need ALL features as the PC app has. It won't bother me what it is made of. My point is: all the same as PC."
Plus a rule: **if the phone app shows lag, crashes or background-play problems, rewrite it natively for Android** and keep everything on GitHub.

## Status at a glance (android-v0.9.1, 2026-09-30)
Every phase of the plan is built and released as a GitHub pre-release. **Nothing native has been run on a real phone yet**: the developer PC has no Android SDK, so the Java is compiled and packaged by CI (`apksigner verify` passes), its pure parts are compiled and tested with the PC's JDK, and the JavaScript side is exercised in a PC test window against stand-ins for the plugins. The next real step is the owner's phone test (checklists at the top of each `ANDROID_PHASE_*.md`, summarised in `ANDROID_PHASE_6.md`).

| Version | Phase | What |
|---|---|---|
| 0.1.0 / 0.2.0 | 0.5, 1a | Capacitor app, phone layout, shared desktop services in the web view, Internet Archive |
| 0.3.0 | 1b | Native Media3 audio in a foreground service, lock screen, honest hi-res output report, bit-perfect switch |
| 0.4.0 | 1c | The music already on the phone (MediaStore), real tags, covers |
| 0.5.0 | 2 | Download queue (resumable, background), MD5 + tags + cover for downloads, tag editing, backup/restore |
| 0.6.0 | 3 | YouTube (yt-dlp on the phone): search, links, playlists, playback, song/video/playlist downloads, engine updates |
| 0.7.0 | 5 | Windowed song list, update check, faster scan, own-key signing hook |
| 0.8.0 | 1c+ | Choose which folders to scan (Android folder picker, several folders, phone storage or card) |
| 0.9.1 | fixes | Tabs work while a panel is open (a panel used to hide the page they opened); swipe down closes a panel |
| 0.9.0 | fixes | The owner's first phone test: tap plays, back button, covers, notification, resume after a call, Now Playing, download badge, Reveal, bigger limits, faster YouTube start, YouTube queue remembered |

## First real-phone test (owner, android-v0.8.0) and what 0.9.0 did about it
The owner installed 0.8.0 on a phone and reported 11 things. For the native-rewrite rule below: no lag and no crash were reported, and playing in the background with the screen off works ("that is fine"); what they found are bugs, so nothing here triggers a rewrite. Nothing of this was reproduced on a device by the assistant: the causes below were found by reading the code and by PC checks; **the fixes are proven in the PC test window (`e2e-phone.cjs`, 19 checks) and by unit tests, the native Java parts only compile in CI**. The owner's next report tells whether they hold.

| # | Owner's report | Cause found | Change in 0.9.0 | Proven |
|---|---|---|---|---|
| 1 | Tapping a song opens its info instead of playing | On a phone the title button opened the info (the PC plays on double-click; the play button shows on hover only) | A tap on a row or its title plays (Songs, search rows, playlists, history, Up next); info stays in the row's ... menu. `lib/rowTap.ts` | PC window |
| 2 | Back button / gesture minimizes the app | Nothing handled back | `MainActivity` asks the page (`window.__oliBack`): close the open panel, else previous page, else home; only at home the app goes to the background | JS in PC window; Java compiled in CI only |
| 3 | Most covers do not load | Android's reader (MediaMetadataRetriever) often finds no picture in FLAC files; cover reads ran on Capacitor's ONE shared plugin thread (blocking other commands); one failed call was remembered as "no cover" for the session | `FlacPicture.java` reads the FLAC picture block itself (found the cover in 40 of 40 songs of `A:\Flac`); covers and file details run on 3 own threads; a failed call is retried | JDK test + real files; not on a phone |
| 4 | Notification / lock-screen player never shows | The media session was never registered with the service (`addSession`), so Media3 never posted the notification (the app drives the player directly, no MediaController) | `addSession(session)`; the cover of a local song is sent to the notification too | **not verified** - needs the phone |
| 5 | After a call / other audio the song does not resume; play does nothing; seek does nothing; skipping works | Two likely causes: (a) after a playback error the native player sits idle and `play()` / `seekTo()` do nothing, and the JavaScript player treated the errored element as "not paused" so the play button did nothing; (b) if Android ended the audio service, a NEW EMPTY engine started and ignored play/seek | (a) engine re-prepares when idle; `NativeAudio.play()` after an error opens the same source again at the same place; the store's play/toggle no longer stop at "not paused"; (b) the engine remembers the last song (url, headers, position, labels) and loads it again when play/seek reach an empty engine | unit test + PC window (idle-after-error imitation); the real trigger was not seen |
| 6 | Now Playing does not fit; no shuffle / queue / history / lyrics buttons | On a phone the panel was a 400 px column beside the page, and those buttons live in the PC's player bar | The panel covers the page on a phone; Now Playing has shuffle, repeat, queue, history, lyrics; smaller cover | PC window (all buttons inside the screen) |
| 7 | Red number of files downloading on the Downloads icon and in the notification | (feature) | Red badge on the tab (waiting + downloading); notification shows the number ("3 files left") and now also counts YouTube downloads - before, when only YouTube downloads ran, the download service saw "0 active" and stopped itself (a real bug) | PC window (badge); notification not verified |
| 8 | Song info buttons: Reveal shows nothing | Reveal was a stub on the phone | Reveal opens the Files app at the song's folder when Android allows it, otherwise says where the file is (files in Android/data, where downloads live, are closed to file managers since Android 11). Other buttons (play, queue, play next, favorite, edit tags, refresh metadata) work through the shared code | Java not run on a phone |
| 9 | Playlist / Mix limited to 100; raise "songs prepared ahead" and "simultaneous YouTube downloads" | Constants: playlist 200, Mix 100, ahead 1-5, simultaneous 1-3 (phone: fixed 2) | Playlist 2,000, Mix 500 (a Mix ends near 380 songs; listing 300 takes ~14 s), prepared ahead 1-10 (PC feature; hidden on the phone), simultaneous YouTube downloads 1-6 on PC and phone (phone default 2, applied natively). The phone queue no longer forgets waiting items beyond 200 | unit tests + PC window |
| 10 | YouTube resolve is slow | Questions (search, stream address of the song about to play) shared the SAME slots as downloads, so a running download queue made every tap wait; a failing client cost up to 60 s; only the next 2 songs were prepared, one at a time | Questions have their own slots; 30 s per attempt; the client that worked last is asked first; next 3 songs prepared, 2 at a time. Measured on the PC only: default client 6.6 s, android_vr 3.1 s per lookup (not made the first choice: the PC code notes that android_vr addresses are refused for big range requests; ExoPlayer untested) | **phone timing not measured** |
| 11 | 200+ YouTube songs added; will the app remember them and continue where it stopped? | The queue was saved, but "resume on launch" looked the last song up in the library database only, so a YouTube song was never resumed | Resume finds the song in the restored queue, resolves only that one (plus the next 3 in the background), seeks to the saved place | PC window with a 250-song queue: queue back, song resumed at the saved place, 4 stream lookups |

**Found by the owner right after 0.9.0 and fixed in 0.9.1:** the full-screen panels covered the page, so a tab below changed the page behind the panel (any navigation now closes the panel), and the owner asked for swipe-down to return to the previous page (a downward drag from the top of a panel; sliders and scrolled lists are left alone). The look of Now Playing was kept as it was.

**Ask the owner next:** install 0.9.0; check the notification with the screen off; make a call or play other audio and press play; tell if covers appear; how long a YouTube song takes to start (first tap, and the next one in a playlist).

## Architecture (decided by the assistant; the owner said any approach is fine)
**Hybrid: same screens + same desktop logic inside the app, native Android code only where a phone requires it.**
- **Screens:** the React UI, unchanged, with a phone layout (`MobileNav`, `MobilePlayerBar`, compact `SongTable`, wrapping result/download rows).
- **"Main process" inside the web view:** `platform/androidCore.ts` + `platform/webBackend.ts` open the SAME SQLite schema as desktop (sql.js, bytes in IndexedDB) and create the SAME services; `services/coreHandlers.ts` maps the IPC channels onto them. Ids match the desktop scheme (cyrb64).
- **Native Java plugins (Capacitor):** `OliAudio` (Media3 player + foreground service), `OliMedia` (MediaStore scan, tags, covers), `OliDownload` (resumable downloads + FLAC/MP3 tag writers), `OliYouTube` (yt-dlp through `youtubedl-android`).
- **Player engine stays shared:** `store/player.ts` talks to an `AudioLike`; on Android it is `NativeAudio` (Media3), on desktop the HTML audio element.
- Full detail and every rule learned: section 20 of `BUILD_FROM_SCRATCH.md`.

## Native-rewrite triggers (the owner's rule made measurable) and what is known
Switch to a full native app (Kotlin + Jetpack Compose + Media3 + Room) in this repo under `android-native/` if, on a real phone, any of these is true:
1. Scrolling/typing lags noticeably with a 2,000+ song library.
2. The app crashes or is killed for memory (for example the in-memory database growing past ~100 MB).
3. Background playback stops when the screen is off or another app opens, even with the native foreground service.
4. Start-up takes longer than ~3 s with a large library.

**PC estimates (`scripts/android-harness/perf.cjs`, page slowed 4x to imitate a mid-range phone; NOT phone measurements):**

| | 3,000 songs | 10,000 songs |
|---|---|---|
| Database size (IndexedDB) | 2.5 MB | 7.5 MB |
| Songs visible after a full scan starts | 2 s | 50 s |
| All details read in the background | about 7 s | about 4.5 min (a phone reads real files, so expect longer) |
| Restart to a usable app | 0.7 s | 0.75 s |
| Local search | 50 ms | 125 ms |
| Scrolling the whole list, worst frame | 0.12 s (was 1.9 s before the windowed list) | 1.5 s once |
| Frames over 50 ms while flicking | 13% | 11% |
| JS memory after scrolling | 26 MB (was 123 MB) | 48 MB |

Reading: triggers 1, 2 and 4 look fine on the PC estimates after the windowed list; the remaining risks are the ones only a phone shows (real file reads during the first scan, the cost of the web view itself, yt-dlp start-up, background service survival). **The owner's real-device reports are what trigger a rewrite.**
What a native rewrite would keep: the SQL schema and ids, the Java plugins (audio service, MediaStore scanner, download engine, tag writers, yt-dlp wrapper), the Internet Archive and YouTube parsing (`archiveCore.ts`, `youtubeCore.ts`), the metadata rules, this parity checklist.

## Feature parity checklist (PC feature -> Android approach -> phase -> state)
State words: **built** = code exists, compiled in CI, proven in the PC test window; **phone-untested** = never run on a phone.

| PC feature | Android approach | Phase | State |
|---|---|---|---|
| Database, migrations, settings | same code in web view (sql.js + IndexedDB) | 1a | built, tested |
| Songs / Albums / Artists / Genres / Composers pages, stats, merge | `LibraryQueries` (shared) | 1a | built, tested |
| Playlists (manual + smart), favorites, queue, history, play counts | shared services | 1a | built, tested |
| Local search, search history, suggestions | shared `SearchService` (+ YouTube provider) | 1a/3 | built, tested |
| Lyrics (embedded + LRCLIB) | shared `LyricsService` | 1a | built; online lookup phone-untested |
| Phone layout (bottom nav, compact player/list) | React | 0.5 | built, tested in a phone-size window |
| Internet Archive search + download | fetch + native download queue | 0.5/2 | built, tested; phone-untested |
| Background playback, lock-screen/notification controls, headset & Bluetooth keys, audio focus | `OliAudio` (Media3 `MediaSessionService`) + `NativeAudio` | 1b | built; **phone-untested** |
| Play local files (FLAC 24-bit, M4A, Opus, MP3, WAV, ...), seeking, ReplayGain, speed | Media3 (native decoders), float output for hi-res | 1b | built; phone-untested |
| Honest hi-res output report + bit-perfect switch (Android 14+ USB DAC) | `OliAudioEngine.outputInfo()`, Settings > Audio output, player note | 1b | built; phone-untested |
| Hi-res badge (bit depth / sample rate) | `SourceProbe` via `OliMedia.probeFiles` | 1c | built; phone-untested |
| Scan the phone's music, watch for changes, missing files | `OliMediaPlugin` + `phoneLibrary.ts` + `phoneStore.ts` | 1c | built (real database tests); phone-untested |
| Choose which folders are scanned ("Add folders") | `OliMedia.pickFolder` (Android folder picker) + folder-filtered MediaStore list, one library location per folder | 0.8.0 | built (PC-checked, 17 checks); limited to what MediaStore indexes (no `.nomedia` folders) |
| Music outside MediaStore, duplicates | storage access framework file walk | 1c | **not built** |
| Cover art (embedded + folder) | `OliMedia.getArtwork` (embedded picture, else Android's album art), cached per album | 1c | built; phone-untested; notification artwork for local songs **not wired** |
| Downloads queue: pause/resume/retry/cancel, progress, persisted, background | `DownloadEngine` + `OliDownloadService` + `downloadQueue.ts` | 2 | built (Java tested against a misbehaving server); phone-untested |
| Archive extras: md5 check, tags, cover embedding | `DownloadEngine` + `FlacTagWriter` / `Id3TagWriter` | 2 | built (tags read back by independent libraries, audio bytes identical); phone-untested |
| Tag editing | `songEdits.ts` (+ file write for the app's own downloads) | 2 | built, tested; phone songs are edited inside the app only |
| Backup / restore / export / import library | `phoneBackup.ts` + Share + file chooser | 2 | built, tested; phone-untested |
| Transcode unsupported formats (WavPack/APE) | not built: Media3 plays Opus/Vorbis/FLAC/ALAC/WAV/MP3/AAC natively; WavPack/APE would need the ffmpeg extension | 2 | **decided not to build** (APK size) |
| YouTube: search, paste links, playlists and Mixes | `OliYouTube` + `youtubeService.ts` | 3 | built (real yt-dlp output fixtures); **phone-untested** |
| YouTube: play a video's audio | stream address from yt-dlp, played by `OliAudio` with the request headers | 3 | built; phone-untested |
| YouTube: download song / video / playlist | yt-dlp in `OliYouTubePlugin` through the same queue | 3 | built; phone-untested; tags come from the video title/channel (editable) |
| YouTube engine updater | `youtubedl-android` updater + the same status banner | 3 | built; phone-untested |
| YouTube "fix metadata" (online matching) | would need the metadata providers moved to a shared module | 3 | **not built** |
| Desktop video window | none on the phone | 3 | not applicable |
| Sleep timer, shortcuts panel, themes, accent, lyrics page, Now Playing, queue panel, history panel | same React code | 1a | built |
| Mini player / bubble / tray / taskbar / media keys | replaced by the media notification and lock screen | 1b | built (picture-in-picture not started) |
| App update check | GitHub releases API (`androidUpdate.ts`), opens the release page | 5 | built, tested |
| Real signing key | own keystore in GitHub secrets (`docs/ANDROID_SIGNING.md`) | 5 | **open decision** (workflow supports it; switching needs one uninstall) |
| Performance pass (windowed list, faster scan), decision on native rewrite | measured on the PC (above); phone reports decide | 5 | done on the PC; **phone measurement open** |

## How to build
- CI: push a tag `android-vX.Y.Z` (or run the workflow by hand) -> APK artifact and a GitHub pre-release. Pushing the branch `android-dev` builds and signature-checks the APK without publishing (the way to compile-check Java changes; there is no Android SDK on the PC). If a build fails, its Gradle/compiler messages are published as annotations you can read through the public API.
- Locally (JDK 21 + Android SDK): `npm run android:sync` then `cd android && gradlew assembleRelease`.
- Signed with the public **alpha** key `android/keystore/oli-alpha.jks` (password `oli-alpha-public`) unless the GitHub secrets for an own key exist (`docs/ANDROID_SIGNING.md`).

## Verified vs not verified
- **Proven on the PC:** the JavaScript side end to end in a PC test window with Capacitor's real bridge protocol (142 checks in seven suites, `scripts/android-harness/run-all.ps1`), 237 unit tests (real sql.js databases, real yt-dlp JSON, the Java tag writers and download engine compiled and run with the PC's JDK), CI compiles and packages every tag and verifies the signature, the desktop bundle contains no phone code, and the shared song list works on the desktop (checked on a copy of the real 1,137-song library in an isolated profile).
- **NOT verified on any phone or emulator:** everything native at run time: Media3 decoding and float output reaching the AudioTrack, the foreground services, notification/lock screen, audio focus, headset/Bluetooth buttons, bit-perfect on a USB DAC, the real values in the output report, the MediaStore queries on different Android versions, the permission dialogs, cover files served from the cache folder, downloads in the background, yt-dlp running on the phone (Python unpack, bot checks, embedded thumbnails), scan speed on thousands of songs, start-up time, memory.

## Answers already given
- Internet Archive on Android: yes, plain HTTPS. YouTube on Android: yes via `youtubedl-android`, but Google Play forbids YouTube downloaders, so the APK lives on GitHub Releases. YouTube's terms forbid downloading; the desktop app already has it, so it is the owner's call.

## Next steps
1. **Owner: install `Oli-0.9.1-android.apk` on a phone and report** (checklists in `ANDROID_PHASE_1B.md`, `ANDROID_PHASE_1C.md`, `ANDROID_PHASE_6.md`). Fix what breaks first: the Java has only ever been compiled, never run.
2. Decide the signing key (`docs/ANDROID_SIGNING.md`) and whether the numbers from the phone trigger the native rewrite.
3. Then the leftovers listed above as **not built** (folders outside MediaStore, duplicates, gapless playback, notification artwork for local songs, ReplayGain/lyrics from MP3/M4A, online metadata matching, an in-app APK installer).
