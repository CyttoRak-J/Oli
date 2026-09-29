# Phone build test window (no phone needed)

Runs the **real phone build** (`out/renderer-android-test`) in a throwaway Electron window without the desktop preload, so the web backend installs as it does on a
phone. `preload.cjs` loads Capacitor's own `native-bridge.js` and sets `window.androidBridge`, so `Capacitor.getPlatform()` is `android` and every plugin call travels
Capacitor's real call/notify protocol. Stand-ins answer the plugins the way the Java code does:

| Stand-in | File | What it really does |
|---|---|---|
| `OliAudio` | `preload.cjs` | plays real audio (from `A:\Flac`) through an `<audio>` element; can fake headset/notification buttons |
| `OliMedia` | `preload.cjs` | lists the first 60 songs of `A:\Flac` (or `OLI_HARNESS_SONGS=N` made-up songs; `OLI_HARNESS_SUBDIRS=1` puts them in `Music/Rock` and `Music/Jazz`), filters the list by folder, answers the folder picker with `window.__fakeMedia.pick`, reads real FLAC headers, hands out generated covers |
| `OliDownload`, `Filesystem`, `Share`, a fake archive.org item | `stubs-downloads.cjs` | a Node downloader with Range/pause/cancel/MD5, backups on disk, the share sheet call recorded |
| `OliYouTube` | `stubs-youtube.cjs` | answers with REAL yt-dlp JSON from `test/fixtures/yt` (stream addresses point at a local song) and copies a local FLAC for downloads |

So the real `NativeAudio` -> bridge -> player store -> UI chain, the scanner, the download queue and the YouTube service are exercised. It does **NOT** test the Java code,
Media3, yt-dlp itself, the notification, audio focus or bit-perfect output: those need a phone (the pure Java is tested separately with the PC's JDK, see `test/android*.test.ts`).

## Everything at once
```
powershell -NoProfile -File scripts\android-harness\run-all.ps1 [dataRoot]
```
Builds the test bundle (`OLI_TEST_HOOKS=1 OLI_OUT_DIR=out/renderer-android-test npx vite build -c vite.android.config.ts`; the hook exposes `window.__oliPlayer`, normal builds do not have it),
then runs each suite on a fresh profile and prints one line each. Expected: player 20/20, phone music scan 19/19, downloads/tags/backup 23/23, YouTube 27/27, chosen folders 17/17, phone fixes 28/28, big list 8/8 (142 checks).
It only stops `electron.exe` processes of the test window, never a desktop Oli.

## One suite by hand
```
powershell -File scripts\android-harness\run-window.ps1 <freshDataDir> [deny]     # starts the window (debug port 9333); "deny" = the music permission is refused
node scripts\android-harness\e2e.cjs             # play, seek, pause/resume, unplug, lock-screen next, auto-advance, skip a missing file, volume, Audio output screen
node scripts\android-harness\e2e-library.cjs     # first-start scan, real tags/rates, albums, covers, playing a scanned song, deleted/returning files, restart, removal (DENY=1 for the refused-permission run)
node scripts\android-harness\e2e-folders.cjs     # (window started with OLI_HARNESS_SUBDIRS=1) choose folders: replace "all music", two folders, nested/parent folders, Settings buttons, restart
node scripts\android-harness\e2e-phone.cjs       # the owner's first-phone fixes: tap plays, back button, Now Playing fits, download badge, play after an error, 250-song YouTube queue after a restart, tabs and swipe-down with a panel open
node scripts\android-harness\e2e-downloads.cjs   # Archive downloads: progress, pause/resume, cancel, restart mid-download, songs from files, tag editing, backup/export/restore
node scripts\android-harness\e2e-youtube.cjs     # engine status/update, search, pasted links, playlists, playing a result with headers, song/video/playlist downloads, cancel
$env:OLI_HARNESS_SONGS='3000'; ... run-window.ps1 ...; node scripts\android-harness\e2e-list.cjs    # windowed list with 3,000 songs
node scripts\android-harness\perf.cjs            # speed numbers with made-up libraries (CPU=4 slows the page 4x; PC estimates, not phone measurements)
```
Screenshots go to `$env:SHOTS` (or this folder). Each suite needs a FRESH profile (first-start behaviour is part of what is tested).

## Notes
- The window's title is "Oli": stop it by process id (its command line contains `android-harness`), not by window title, so a running desktop app is never touched.
- Port 8765 is used by the static server (Chromium blocks 5060). Temp folders used: `%TEMP%\oli-harness-files`, `-cache`, `-art`.
- A hidden Electron window does not run `requestAnimationFrame`; the drivers call `Page.bringToFront` when they need drawing.
- The window is started with switches that stop Windows from treating it as hidden when another window covers it (a hidden page does not scroll or draw, which broke the big-list suite once).
- `window.__fakeNative.fail()` / `.sticky` imitate a player that went idle after a phone call (play and seek then do nothing until the source is loaded again).
- Results: phase 1b 20/20, 1c 19/19 + 3/3, folders 17/17, 2 23/23, 3 27/27, 5 8/8 (see `HANDOFF.md`).
