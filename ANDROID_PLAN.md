# Android: goal, architecture, parity checklist, status

## Goal (owner's words, 2026-09-29)
"Want YouTube and Archive... need ALL features as the PC app has. It won't bother me what it is made of. My point is: all the same as PC."
Plus a rule: **if the phone app shows lag, crashes or background-play problems, rewrite it natively for Android** and keep everything on GitHub.

## Architecture (decided by the assistant; the owner said any approach is fine)
**Hybrid: same screens + same desktop logic inside the app, native Android code only where a phone requires it.**
- **Screens:** the React UI, unchanged, with a phone layout (`MobileNav`, `MobilePlayerBar`, compact `SongTable`).
- **"Main process" inside the web view:** `src/renderer/src/platform/androidCore.ts` opens the SAME SQLite schema as desktop (sql.js in the web view, bytes saved in
  IndexedDB) and creates the SAME services (`SettingsStore`, `LibraryQueries`, `PlaylistService`, `FavoritesService`, `QueueService`, `HistoryService`,
  `PlaybackStateStore`, `AnalyticsService`, `SearchService`, `LyricsService`). `src/main/services/coreHandlers.ts` maps the app's IPC channels onto them.
  Desktop-only Node modules are replaced by browser stand-ins (`platform/shims/*`, wired in `vite.android.config.ts`). Ids match the desktop scheme (cyrb64), so data can move between the apps.
- **Native Kotlin (Capacitor plugins), only for what the web view cannot do well:** audio playback with a foreground service and lock-screen controls, scanning the phone's music
  (MediaStore), tag reading/writing, YouTube (`youtubedl-android`), ffmpeg conversions, big downloads.
- **Player engine stays shared:** `store/player.ts` uses an audio element. On Android it will get a `NativeAudio` object with the same interface (src, play, pause, currentTime,
  duration, volume, playbackRate, events) backed by Media3, so all the queue/shuffle/repeat/fallback logic is reused and background playback is native-grade.

### Native-rewrite triggers (the owner's rule made measurable)
Switch to a full native app (Kotlin + Jetpack Compose + Media3 + Room) in this repo under `android-native/` if, after the performance work in phase 5, any of these is true on a real phone:
1. Scrolling/typing lags noticeably with a 2,000+ song library (frame drops in lists, search, queue).
2. The app crashes or is killed for memory (for example the in-memory database growing past ~100 MB).
3. Background playback stops when the screen is off or another app opens, even with the native foreground service.
4. Start-up takes longer than ~3 s with a large library.
What a native rewrite would keep from this work: the SQL schema (Room with the same tables and ids), the Kotlin plugins (audio service, MediaStore scanner, yt-dlp wrapper, tag writer), the Internet Archive
client logic (`src/shared/archiveCore.ts` ported), the metadata-matching rules, and this parity checklist. Because I cannot run a phone here, **the owner's real-device reports of the alpha APKs are what trigger it.**

## Feature parity checklist (PC feature -> Android approach -> phase -> state)
| PC feature | Android approach | Phase | State |
|---|---|---|---|
| Database, migrations, settings | same code in web view (sql.js + IndexedDB) | 1a | **done, tested in phone-size window** |
| Songs / Albums / Artists / Genres / Composers pages, stats, merge | `LibraryQueries` (shared) | 1a | **done (data path tested)** |
| Playlists (manual + smart), favorites, queue, history, play counts | shared services | 1a | **done (data path tested)** |
| Local search, search history, suggestions | shared `SearchService` | 1a | **done (tested)** |
| Lyrics (embedded + LRCLIB) | shared `LyricsService` (fetch) | 1a | wired, online lookup untested on phone |
| Phone layout (bottom nav, compact player/list) | React | 0.5 | done (tested in phone-size window) |
| Internet Archive search + download | fetch + native file download; songs go into the shared database | 0.5/1a | **done (tested); no md5/tags/cover yet** |
| Background playback, lock-screen/notification controls, headset & Bluetooth keys, audio focus | Kotlin Media3 service + `NativeAudio` adapter | 1b | not started |
| Play local files (FLAC 24-bit, M4A, Opus, MP3, WAV, ...), seeking, ReplayGain, speed | Media3 (native decoders) | 1b | not started |
| Hi-res badge (bit depth / sample rate) | MediaExtractor / tag reader | 1c | not started |
| Scan the phone's music, watch for changes, missing files, duplicates | Kotlin MediaStore scanner + `ContentObserver`; folder picker via storage access framework | 1c | not started |
| Cover art (embedded + folder) | `MediaMetadataRetriever.embeddedPicture` -> cache | 1c | not started |
| Tag editing, "fix metadata", metadata matching (Spotify/iTunes/Deezer/JioSaavn/MusicBrainz) | pure-fetch parts of `provider.ts` moved to a shared module + native tag writer | 2 | not started |
| Downloads queue: pause/resume/retry/cancel, progress, persisted | shared `DownloadService` logic over a native downloader (`downloads` table) | 2 | not started |
| Archive extras: md5 check, tags, cover embedding | native tag writer (port of `audioTags.ts`) | 2 | not started |
| Transcode unsupported formats (Opus/WavPack/APE...) | ffmpeg from `youtubedl-android` | 2 | not started |
| Backup / restore / export / import library | export the database bytes with the share sheet / file picker | 2 | not started |
| YouTube: search, play streams, paste links, playlists and Mixes, downloads (audio/video), tagged songs | native plugin around `youtubedl-android` (search, resolve, download) + shared metadata code | 3 | not started |
| YouTube engine updater (yt-dlp) | `youtubedl-android` runtime updater + the same status banner | 3 | not started |
| Sleep timer, shortcuts panel, themes, accent, lyrics page, Now Playing, queue panel, history panel | same React code | 1a | works where it does not need native audio |
| Mini player / floating bubble / tray / taskbar / media keys | replaced by the media notification, lock screen and (optional) picture-in-picture | 1b/5 | not started |
| App update check | GitHub releases API (APK link) | 5 | not started |
| Real signing key | own keystore in GitHub secrets | 5 | open decision |
| Performance pass (virtual lists, DB size, start-up), decision on native rewrite | measure on a real phone | 5 | not started |

## Verified vs not verified
- Verified in a phone-size window on the PC (a throwaway Electron shell with no desktop preload, so the web backend installs as on a phone): the shared database starts (needed a CSP fix for WebAssembly, found by this test),
  data survives a restart, settings/playlists/favorites/queue/history/search work, an Archive download becomes a song with desktop-style ids and shows in albums/artists/stats.
- CI: `android-v0.1.0` built a signed APK (Android's `apksigner verify` passed).
- **Not verified on any phone or emulator:** everything native-facing (file saving to `Directory.External`, playback of downloaded files, CapacitorHttp vs CORS, IndexedDB size limits, start-up time).

## How to build
- CI: push a tag `android-vX.Y.Z` (or run the workflow by hand) -> APK artifact and a GitHub pre-release. Locally (JDK 21 + Android SDK): `npm run android:sync` then `cd android && gradlew assembleRelease`.
- Signed with the public **alpha** key `android/keystore/oli-alpha.jks` (password `oli-alpha-public`): testing only; a properly signed build later means uninstalling the alpha first.

## Answers already given
- Internet Archive on Android: yes, plain HTTPS (working). YouTube on Android: yes via `youtubedl-android` or NewPipeExtractor, but Google Play forbids YouTube downloaders, so the APK lives on GitHub Releases. YouTube's terms forbid downloading; the desktop app already has it, so it is the owner's call.

## Next steps
1. Phase 1b: `NativeAudio` + Kotlin Media3 foreground service (plugin `OliAudio`), lock-screen controls, audio focus; switch the player store to use it on Android.
2. Phase 1c: MediaStore scanner plugin and metadata/artwork, then the folder picker.
3. Ship `android-v0.2.0` after each phase; the owner tests on the phone and reports lag/crash/background issues (triggers above).
