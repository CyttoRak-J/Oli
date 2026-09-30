# Oli: music player for Windows/macOS (Electron + React + sql.js) and Android (Capacitor + Java plugins)

Local library manager and player, with YouTube search/stream/download. **Read `BUILD_FROM_SCRATCH.md` Appendix A (Handoff)
first** for what was changed recently, what is verified, and what is still open.

## Commands
- `npm run dev` runs the app (uses the user's REAL library in `%APPDATA%\Oli`, see "Data safety").
- `npm run typecheck`, `npm run lint`, `npm test` (vitest, 237 tests in 32 files), `npm run build`. Keep all four green.
- Git repo (`core.autocrlf=false`, files are LF). GitHub: https://github.com/CyttoRak-J/Oli (branch `main`; the pre-2026-09-29
  history there is an older, different code lineage that this project was committed on top of). Pushing a `v*` tag runs
  `.github/workflows/build.yml` (Windows installer + macOS dmg/zip, then a GitHub Release with SHA256SUMS). The pre-git code is in
  `A:\oli-dev-tools\original-backup`. Commit before large changes; never commit `bin/` (yt-dlp is fetched by `npm install`).

- `BUILD_FROM_SCRATCH.md` is a full guide for a new agent to rebuild the app (asks the user for name etc. first).
  Its Part II embeds EVERY file of the project (that is what lets an agent rebuild everything from this one file): after ANY change `git add` new files, run `node scripts/build-spec.mjs`, and commit the result (`--check` only verifies). Keep the prose (Part I, appendices) true too.

## Layout
- `src/main`: Electron main. `services/` (library, scanner, provider = YouTube/Spotify/yt-dlp, downloads,
  transcode, mediaServer, database...), `ipc.ts`, `windows.ts`, `index.ts`.
- `src/renderer/src`: React UI. `store/player.ts` is the playback engine (audio element, fallbacks, queue).
- `src/shared`: IPC channel names, types, default settings.
- Android (`android/`, `src/renderer/src/platform/`): the phone app runs the same React screens and the same services inside the web view (`androidCore.ts`, `webBackend.ts`), with
  four native Java plugins in `android/app/src/main/java/com/cyttos/oli/` (`OliAudio`, `OliMedia`, `OliDownload`, `OliYouTube`). **Read `BUILD_FROM_SCRATCH.md` Appendix B (Android plan) first**; the full specification is
  section 20 of `BUILD_FROM_SCRATCH.md`. Status: everything built (android-v0.9.15); the owner ran 0.8.0 on a phone and reported 11 problems, fixed in 0.9.0 and listed in Appendix B (Android plan).

## Rules learned the hard way (do not undo)
- **Never change `hash64` in `main/util/identity.ts`** (it is cyrb64, 16 hex). Every id in the user's database,
  playlists, favorites, queue and artwork cache was made with it. A SHA-256 version once made covers
  vanish and updates match nothing. `test/legacyIds.test.ts` guards it.
- **Local audio is served by `MediaServer`** (`127.0.0.1` HTTP, per-session token, real Range support).
  Do not go back to `protocol.handle` for audio: it answers "200, no length, no ranges" and seeking fails
  ("FFmpegDemuxer: data source error"). Only library songs and the app's own temp copies are served.
- **yt-dlp**: `services/ytdlpEngine.ts` picks the copy to run: the one Oli downloaded into `userData/bin` first, then
  `bin/yt-dlp.exe` (2026.08.19, checksum-verified, shipped in the installer), then one on PATH. It notices missing / broken /
  outdated engines (banner in the app + Preferences), and with "update automatically" (default on) installs the newest
  official release itself (SHA-256 checked, must run and report the release version before it replaces anything).
  A corrupt exe makes Windows *throw* `spawn UNKNOWN` from `execFile`: keep that try/catch. Old yt-dlp
  builds get HTTP 403 from YouTube on full-length songs. Settings > "YouTube engine" shows the version and
  updates it. Use the **default client** (android_vr URLs are refused for big ranges). Resolved stream URLs are
  cached under key `ytstream2:` (bump it if the engine changes) and prefetched; prefetch yields to clicks.
- **YouTube Mix (`list=RD...`)** only opens through the *watch* URL, never `/playlist?list=RD...`
  (`main/util/playlistUrl.ts`). Mixes are capped at 500 entries, playlists at 2,000 (`MIX_LIMIT`, `PLAYLIST_LIMIT`; a Mix ends near 380 songs and listing 300 takes about 14 s).
- **Kill process trees** (`killProcessTree` in provider.ts): yt-dlp.exe starts a helper, plain `child.kill()`
  leaves the download running.
- Windows quirks: paths over 240 chars are copied to a short temp path (`util/longPath.ts`); M4A files Chromium
  rejects are remuxed losslessly (`transcode.ts`); Opus and similar are transcoded to MP3.
- Hi-res: FLAC is decoded losslessly, but output runs at the Windows device rate (48 kHz on the user's
  devices). The player-bar badge shows `-> 48 kHz out`. True bit-perfect output is not possible in Electron.
- **Internet Archive** (`services/archive.ts`, `pages/Archive.tsx`, route `/archive`): keyless search + file listing;
  downloads go through `DownloadService.enqueueFile` (plain HTTP, md5 verified). The renderer only sends an item id
  and file names, never a URL; main re-checks them against the item's real file list.
- Migration 1 matches the real database schema; migration 9 repairs databases from an older inaccurate schema.

## Working conventions
- Edit files with scripts using `newline=''`; the repo is **LF**. Run `python A:\oli-dev-tools\scripts\eol.py`
  after scripted edits (prints nothing when fine, `fix` restores LF).
- Verify in the real app instead of asking the user to check: launch with
  `npm run dev -- --remoteDebuggingPort 9222` and drive it with the CDP scripts in
  `A:\oli-dev-tools\scripts` (`cdpkit.cjs`; `e2e_seek.cjs`, `yt_speed.cjs`, `dl_modes.cjs`, `mix_e2e.cjs`).
  Quirk: some awaited evaluations return "Promise was collected": fire the action, then poll a window variable.
  Remove the debug-port launch entry afterwards.
- Android: `scripts/android-harness` runs the phone build in a throwaway Electron window with Capacitor's real bridge and stand-ins for the plugins (see its README;
  `powershell -File scripts\android-harness\run-all.ps1` runs all 142 checks). There is no Android SDK on the PC: push branch `android-dev` to compile-check the Java (read the run through
  the public GitHub API; failures are published as annotations), tag `android-vX.Y.Z` to release. Pure Java classes are compiled and tested with the PC's JDK (`scripts/android-tags`).
- Never write repository files with PowerShell `Set-Content -Encoding utf8` (byte-order mark broke `build.gradle`); use the Write/Edit tools or scripts that keep LF.
- Stop test windows by process id (their electron.exe), never by window title "Oli": a desktop Oli may be running.

## Android rules learned the hard way (do not undo)
- The phone build must keep all phone code out of the desktop bundle (`__OLI_WEB__`, empty `webBackend` stand-in in `electron.vite.config.ts`); check that `grep -c "OliAudio\|OliMedia\|OliYouTube\|OliDownload" out/renderer/assets/*.js` finds nothing (the single word `nativecommand` is the shared player store's own listener and is expected).
- Song rows are windowed (`lib/useRowWindow.ts`, rows exactly 46 px): do not add a variable-height row to `SongTable` without changing the maths; keep `overflow-anchor: none` on the list.
- The player store talks to an `AudioLike`; `NativeAudio` tags every event with a token and drops events of an older source. Do not let the store touch `HTMLMediaElement` APIs other than through that interface.
- Capacitor plugin proxies are thenables: never `await` or return one from an async function.
- Media3 hi-res: float output only for hi-res/unknown sources (`ForwardingAudioSink.getFormatSupport`); the output report must never claim bit-perfect unless Android holds the mixer attribute.
- minSdk is 24: no `java.nio.file` (Android 8); tag writers replace files with `File.renameTo`.
- Background: the queue, the notification buttons and the download list run in the web page, which Chromium throttles when the app is hidden. Keep `MainActivity.keepVisible` (resumeTimers + dispatchWindowVisibilityChanged) and never use `setTimeout` on a path that must run in the background (`NativeAudio.emit` uses a microtask). Downloads need `OliDownload.keepAlive` (service alive while anything is queued) and the wake/Wi-Fi locks in `OliDownloadService`. Position reports older than a seek are dropped in `NativeAudio.staleAfterSeek`. See BUILD_FROM_SCRATCH.md Appendix D0.
- Capacitor `PluginCall.getLong()` returns the DEFAULT unless the JSON number is a `Long` (small numbers are `Integer`): read whole numbers with `OliAudioPlugin.longOf`. `getInt` accepts Integer only, `getFloat` accepts Float/Double/Integer. (This made every phone seek go to 0:00 until 0.9.20. `OliDownloadPlugin` still uses `getLong("size")`, which is therefore always 0: no size check on downloads; switching it on activates the "Wrong size" check in `DownloadEngine`, test it on a phone first.)
- yt-dlp `--parse-metadata` values: `%` doubled, `:` escaped, backslashes not doubled (`YtDlpOutput.metadataLiteral`).

- **YouTube on the phone (0.9.2 to 0.9.14; full story in BUILD_FROM_SCRATCH.md Appendix D)**: the phone runs its OWN yt-dlp, installed by Oli from the official GitHub release (never trust the library's updater); ffmpeg must be started with `FFmpeg.INSTANCE.init` and is run by Oli itself (yt-dlp only downloads); test a YouTube client with a real request before using it; the video page is the PC's shared page shown in an iframe (phone CSP allows inline script); ask the owner for Settings > Test video access before guessing.
- Releases: ONE alpha pre-release `android-alpha` holds every APK (`android-vX.Y.Z` tag adds a version), ONE latest desktop release carries Windows + macOS + the newest APK (`attach-` tag). Check `versionName` really changed after bumping.

## Data safety
- Dev mode edits the real library (`%APPDATA%\Oli\library.sqlite`). Back it up before tests that write.
- The database lives in memory and is flushed on quit: **stop the app before editing the file**.
- Playing songs in tests records history and play counts, and `usePlayer.stop()` clears the saved queue.
  Clean up afterwards (see Appendix A (Handoff)) and never remove entries you cannot prove are yours: the user
  often uses the app at the same time.
