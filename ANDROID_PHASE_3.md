# Android phase 3: YouTube

> **STATUS: built and shipped as android-v0.6.0 (versionCode 6). Not yet run on a phone.** This file is the result of the phase (there was no separate brief); the design is in section 20.5 of `BUILD_FROM_SCRATCH.md`.

## What exists
- **Engine:** `youtubedl-android` 0.18.1 (`library` + `ffmpeg`) runs yt-dlp (Python) on the phone. `android/app/build.gradle`: `jniLibs.useLegacyPackaging = true` (required), `abiFilters arm64-v8a, armeabi-v7a`. The APK grew from 6.6 MB to about 104 MB (Python, ffmpeg, yt-dlp for two CPU families). The first start unpacks Python (seconds); after that the engine status in Settings > YouTube engine says ok.
- **Java:** `OliYouTubePlugin` (`status`, `updateEngine`, `search`, `playlist`, `info`, and downloads `enqueue/pause/resume/cancel/getActive` with the same `dlProgress`/`dlState` events as `OliDownload`), `YtDlpOutput` (progress-line parser, metadata escaping; tested on the PC).
- **JS:** `platform/youtubeCore.ts` (pure parsers, tested on REAL yt-dlp 2026.08.19 output in `test/fixtures/yt`), `platform/youtubeService.ts` (caches, shared runs, prefetch, engine status/update), `downloadQueue.ts` (YouTube jobs, `prepare`), `webBackend.ts` (providers for search; all YouTube channels; downloads), `nativeAudio.ts` `setStreamHeaders` (stream addresses need the request headers yt-dlp saw; cookies are never passed on).
- **Features:** YouTube results in Search; paste a video / playlist / Mix link; play a result in the app (native player, background-capable); download a song (m4a with title/artist/album and the thumbnail embedded by yt-dlp's ffmpeg), a video (mp4 up to a chosen height) or a whole playlist, through the same queue (pause, resume, cancel, background service); engine version, "Check" and "Update now", automatic update at most daily when `ytdlpAutoUpdate`.
- **Changed on the way:** the Search result rows and the Downloads rows wrap on a phone (they collapsed to one-letter columns), no "Video" (window) button on the phone.

## Decisions and limits
- Tags of a downloaded song come from YouTube Music's own tags when the video has them, else the "Topic" channel, else "Artist - Title" in the title, else the channel. It is approximate by nature (e.g. "Movie - Song | Singer" is read as artist "Movie"); the owner can edit tags (phase 2).
- No online metadata matching ("fix metadata") — it would need the provider code of the PC app (`provider.ts`, 3,400 lines) moved to a shared module.
- The PC plays the audio of a stubborn video by downloading it first (`downloadYouTubeAudio`); the phone has only the stream (the handler answers null, the player then skips or reports).
- The desktop video window does not exist on the phone.
- YouTube may answer "Sign in to confirm you are not a bot" from some networks: the app then shows an empty result instead of failing. The same happens on the PC from the developer's address; the client chain (default, `web_embedded`, `android_vr`) is the PC app's.

## Owner's phone checklist for 0.6.0
1. Install (about 104 MB). Open Settings > YouTube engine: within a minute it shows a version (first start unpacks Python). Tell me how long it took.
2. Search for a song: YouTube results appear under "Online". Tap "Play in app": it starts within a few seconds (yt-dlp resolves the stream). Turn the screen off: it keeps playing.
3. Paste a playlist link in the search box: the songs are listed; queue / download some.
4. Download a song: it appears in Downloads with progress, then in Songs with a cover and tags (check them in another app too). Download a video: a file appears in `Android/data/com.cyttos.oli/files/Oli/Videos/` (not a song).
5. Settings > YouTube engine > "Check": reports the newest yt-dlp; "Update now" installs it.
6. Any "not a bot" or empty results: note the network (Wi-Fi / mobile) and the time.

## If something fails first look at
The engine start (`OliYouTubePlugin.status` returns the error text: Python unpack, missing native libraries — the ABI filter must match the phone), yt-dlp arguments in `buildDownload` (thumbnail embedding needs ffmpeg), the file lookup after a download (`finished()` scans `relBase.*`), Range/redirect handling of googlevideo addresses in ExoPlayer, and the `--parse-metadata` escaping (`YtDlpOutput.metadataLiteral`).
