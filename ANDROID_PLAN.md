# Android plan and status

**Status (2026-09-29):** the owner repeated the Android request without answering the questions below, so the default was taken:
**Capacitor app reusing the React UI** (option A). Done and tested in a phone-size window (not on a phone): phone layout (bottom nav, compact
player and song list), a backend running inside the web view (`src/renderer/src/platform/webBackend.ts`: settings, Internet Archive search/listing/downloads,
songs made of downloaded files), web build config (`vite.android.config.ts`), Capacitor project (`android/`), CI (`.github/workflows/android.yml`, tag `android-v*`).
NOT verified: anything on a real phone or emulator; the first CI APK build. Not started: scanning the phone's music, background playback, playlists/queue
persistence, YouTube, real signing key (the APK uses a public alpha key in `android/keystore`). The owner can still switch to a full native rewrite (option B).

## The question that was asked
"Will a full native Android app have YouTube and Internet Archive download?"

## Answer
**Internet Archive: yes, easily.** It is plain HTTPS (search, metadata, file download), no key and no special library.
Checksum verification, tags and cover art can be done in Kotlin (or in the web layer for the Capacitor option).

**YouTube: yes, technically, but with two catches.**
1. *How:* `yt-dlp` cannot be run as a plain executable on Android the way it is on Windows. Two proven routes:
   - `youtubedl-android` (a library that bundles yt-dlp, Python and ffmpeg inside the APK and can update yt-dlp at runtime), or
   - `NewPipeExtractor` (a Java library, no Python; what the NewPipe app uses).
   Both give search, stream URLs and audio downloads. Both break from time to time when YouTube changes, so the app needs the same
   "engine updater" idea as the desktop app.
2. *Where you can publish it:* Google Play does not allow apps that download YouTube content. The APK would be published on
   **GitHub Releases** (side-loaded), not on Play Store. Also YouTube's terms forbid downloading; the desktop app already has this
   feature, so this is the owner's call.

## Options
| | Capacitor app reusing the React UI | Full native (Kotlin + Jetpack Compose) |
|---|---|---|
| UI | reuse most existing screens (touch layout needs work) | rewrite every screen |
| Playback | HTML audio plus a native media-session plugin (background play, lock-screen controls) | Media3/ExoPlayer, best background playback |
| Library scan | new plugin over MediaStore / storage access | MediaStore, Room database |
| Database | sql.js (WebAssembly) in the webview, saved to app storage | Room (SQLite) |
| Internet Archive | fetch + file plugin | OkHttp |
| YouTube | native plugin around youtubedl-android | youtubedl-android or NewPipeExtractor |
| Effort | large (weeks) | very large (months) |
| Feel | good, some webview limits | best |

## Build and release on GitHub
An extra job in `.github/workflows/build.yml` would build the APK (Temurin JDK 17, Android SDK, `./gradlew assembleRelease`),
sign it with a keystore stored as a GitHub secret (or a debug key for early testing), and attach `Oli-<version>.apk` to the same release.

## Decisions needed from the owner
1. Approach: Capacitor (reuse UI) or full native.
2. Include YouTube in the first Android version, or only local library + Internet Archive first.
3. Signing: a real keystore (recommended, needed for updates) or a debug key for now.

## Suggested phases (once decided)
0. Project skeleton + CI that produces an installable APK (empty app, proves the pipeline).
1. Local library: permissions, scan, database, browse, playback with background controls.
2. Playlists, favorites, queue, history, lyrics, settings.
3. Internet Archive search and downloads (tags, cover art, checksum).
4. YouTube (engine, search, stream, download) if chosen.
5. Polish, signing, release.
