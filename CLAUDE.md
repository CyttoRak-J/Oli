# Oli: desktop music player (Electron + React + sql.js)

Local library manager and player for Windows, with YouTube search/stream/download. **Read `HANDOFF.md`
first** for what was changed recently, what is verified, and what is still open.

## Commands
- `npm run dev` runs the app (uses the user's REAL library in `%APPDATA%\Oli`, see "Data safety").
- `npm run typecheck`, `npm run lint`, `npm test` (vitest, 111 tests), `npm run build`. Keep all four green.
- Git repo (`core.autocrlf=false`, files are LF). GitHub: https://github.com/CyttoRak-J/Oli (branch `main`; the pre-2026-09-29
  history there is an older, different code lineage that this project was committed on top of). Pushing a `v*` tag runs
  `.github/workflows/build.yml` (Windows installer + macOS dmg/zip, then a GitHub Release with SHA256SUMS). The pre-git code is in
  `A:\oli-dev-tools\original-backup`. Commit before large changes; never commit `bin/` (yt-dlp is fetched by `npm install`).

- `BUILD_FROM_SCRATCH.md` is a full guide for a new agent to rebuild the app (asks the user for name etc. first).
  Regenerate it after big changes: its verbatim code blocks are copies of the source.

## Layout
- `src/main`: Electron main. `services/` (library, scanner, provider = YouTube/Spotify/yt-dlp, downloads,
  transcode, mediaServer, database...), `ipc.ts`, `windows.ts`, `index.ts`.
- `src/renderer/src`: React UI. `store/player.ts` is the playback engine (audio element, fallbacks, queue).
- `src/shared`: IPC channel names, types, default settings.

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
  (`main/util/playlistUrl.ts`). Mixes are capped at 100 entries, playlists at 200.
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

## Data safety
- Dev mode edits the real library (`%APPDATA%\Oli\library.sqlite`). Back it up before tests that write.
- The database lives in memory and is flushed on quit: **stop the app before editing the file**.
- Playing songs in tests records history and play counts, and `usePlayer.stop()` clears the saved queue.
  Clean up afterwards (see `HANDOFF.md`) and never remove entries you cannot prove are yours: the user
  often uses the app at the same time.
