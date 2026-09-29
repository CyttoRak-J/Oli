# Handoff: state at the end of the bug-fix session (2026-09-29)

Checks at the end of the bug-fix session: typecheck, lint and build clean; **76 tests pass** (95 after the Archive work); app relaunched with no log errors.

## What was done (by area)
**Playback engine (`store/player.ts`)**
- Pause/resume no longer skips or restarts: a dropped connection reopens the same source at the same
  position; the stall watchdog checks real progress; shuffle plays every song once per cycle; repeat-one and
  all-dead queues cannot loop forever; queue ids are de-duplicated; restored queue starts at track 1.
- Seeking fixed at the root: `MediaServer` (see CLAUDE.md). Verified by real seek-bar clicks on 96 kHz FLAC,
  24-bit, CD FLAC, M4A, Opus and a >260-char path.
- Settings now wired: playback speed, keep pitch, ReplayGain, reduce motion, notifications, minimize to tray,
  tray icon. Removed two controls with no backing feature (crossfade, accent-from-artwork).
  `minimizeToTray` default changed to **false**; `cacheArtworkMB` default 2048.
- Mini player: shuffle button, seek on release, buffering shows pause. Bubble spins while buffering.
- Player bar badge: `HI-RES FLAC 24-bit / 96 kHz` plus `-> 48 kHz out` when Windows converts it.

**Library and data**
- Scanner no longer marks other folders' songs missing; reappeared files return; queued scans not dropped.
- Tag edits use `NodeID3.update` (used to wipe cover art and other tags), regroup artist/album ids.
- Covers: restored cyrb64 ids; 1,135 of 1,136 songs show a cover; orphan artwork cleaned on start.
- Database safety: damaged file preserved, recovery looks in `backups/`, restore validates before swapping.
- Migration 9 schema repair; tests for migrations, scanner, database, metadata ops, legacy ids.

**YouTube**
- yt-dlp updated to 2026.08.19 in `bin/` (approved, SHA-256 verified); Settings > YouTube engine.
- Stream resolve ~3.5 s cold; 0 ms cached/prefetched; disk cache; in-flight sharing; readiness probe
  (`waitUntilPlayable`) and one retry before the slow download fallback.
- Playlist/Mix: resolves on paste (Home and Search), checklist, play or download selected as tagged audio or
  video (`downloads:enqueue-entries`), Mix works via watch URL, cached 10 min, shared lookup.
- Removing/pausing a download now kills the whole process tree.

**Lint/config**: `npm run lint` was failing before (scripts/tests lacked node globals); fixed.

## Internet Archive downloads (added 2026-09-29, after the bug-fix session)
- Sidebar > Internet Archive: search (lossless-only by default), open a result, pick a format (24-bit FLAC, FLAC,
  WAV, ALAC, AIFF, or lossy), tick tracks, Download. Files land in `<Downloads>\Oli Downloads\<item title>\`
  (or a chosen folder) and appear on the Downloads page. Each file's md5 is checked against archive.org's.
- Verified in the real app: search (112 results for "anchors aweigh"), file list, download of
  `AnchorsAweigh_769/anchors.flac` (568,272 bytes, md5 matched archive.org, real FLAC). Test row and file removed.
  Checksum-mismatch path proven by `test/downloadFile.test.ts` (local server), not by the live app.
- Tags: after the md5 check, missing title/artist/album/track/date/genre are filled from archive metadata
  (`util/audioTags.ts`; FLAC via a pure-JS Vorbis-comment writer that uses the file's padding when it fits and
  otherwise rewrites through a temp file, MP3 via NodeID3). Existing tags are never overwritten. WAV, Ogg, ALAC and
  AIFF are left untagged. Verified live on `AnchorsAweigh_769`: FLAC and MP3 got title/artist/album, the MP3's own
  track number (115) was kept, log shows "Tagged anchors.flac: TITLE, ARTIST, ALBUM".
- Cover art: `pickCover` chooses a picture named like the track, then cover/front/folder/artwork/album, then the
  largest JPEG/PNG of the item; embedded (FLAC picture block, MP3 APIC) only when the file has none. Verified live:
  `anchors.flac` and `anchors.mp3` got the item's 11,124-byte PNG.
- Not done: old recordings are often only 8-16 bit / 11-44 kHz ("hi-res" depends on the item). Add `Oli Downloads` as a library folder to get the files into the library. No preview playback. Resume after an
  app restart re-downloads from the saved byte count but loses the md5 check (kept in memory only).

## YouTube engine manager (added 2026-09-29, after the Archive work)
- `services/ytdlpEngine.ts` + `components/YtEngineBanner.tsx` + Preferences > YouTube engine. States: ok, checking, missing, broken,
  update-available, installing, failed. Copy priority: downloaded (`userData/bin`) > shipped (`resources/bin`) > PC (PATH). Checks 3 s
  after start and every 12 h (GitHub releases API). Setting `ytdlpAutoUpdate` (default true) installs missing/newer/broken engines by
  itself; off = banner with a button. A downloaded copy that the shipped one has caught up with is deleted.
- Verified in the real dev app (isolated profile, no yt-dlp anywhere): auto-install (37 s, exe SHA-256 identical to the shipped one),
  banner + real click on "Install now" (auto off, exe deleted), corrupt exe -> "Reinstall" repairs it (this found the `spawn UNKNOWN`
  crash, now fixed and tested), outdated PC copy 2025.12.08 -> "Update now" -> downloaded 2026.08.19 takes over, and a real YouTube
  stream resolve with the downloaded copy (10 URLs, 7.2 s cold).
- Not verified: the busy-retry path with a real running yt-dlp (unit-tested only), offline behaviour in the real app, macOS/Linux.

## Fix: "Play every track in random order" (Songs page)
- It shuffled the list but started at a random position, so with shuffle mode off and repeat off only the rest of the queue played. It now
  starts at the first track of the shuffled queue (`lib/shuffle.ts`, `test/shuffle.test.ts`). Verified in the real dev app (isolated profile,
  muted): 5 clicks -> queue of 1,137, playing index 0 every time; order differs per click; Next goes 0 -> 1 -> 2 -> 3.
- Clicking a row in a list still queues from that row onward (earlier rows are not queued): unchanged, by design.
- Installer rebuilt after this fix (2026-09-29 16:19, 129,391,713 bytes). Packaged smoke test (isolated profile): shuffle-all queue of 1,137 starts at index 0 three times out of three; engine `ok`, bundled 2026.08.19. (A muted, hidden window shows status `paused` because Chromium pauses muted background media: test artifact.)

## GitHub, releases and Android (2026-09-29)
- Published to https://github.com/CyttoRak-J/Oli as a new commit on top of the existing `main` (old history and tags `v1.0.1`, `v1.0.2`,
  `Music` kept). The user's own icons, README, LICENSE and docs site were kept and updated. Version is now **1.1.0**.
- `.github/workflows/build.yml`: tag `v*` builds Windows (nsis) + macOS (dmg/zip, x64 + arm64, ad-hoc signed by `scripts/adhoc-sign.cjs`) and
  publishes a release with `SHA256SUMS.txt` (notes in `.github/release-notes.md`). See the end of this section for the run result.
- Android: not built. The user asked whether a full native app can have YouTube and Internet Archive; answer given in chat (see
  `ANDROID_PLAN.md`). Waiting for the user's choice of approach before any Android code.
- To continue in a new chat, paste the block in `CONTINUE_PROMPT.md`.

## Not verified / open ideas
- Never heard audio (only "player reports playing and advancing"). The packaged installer (`npm run build:win`) builds and its
  unpacked app boots with `resources/bin/yt-dlp.exe`, but running the installer itself and upgrades are untested.
- Spotify playlists untested (no keys). A full 100-item Mix download untested (multi-GB as video).
- Ideas: repeat button on the mini player; bubble controls; exclusive-mode / bit-perfect output would need a native
  backend (for example mpv with WASAPI exclusive); more UI tests.

## User's environment (facts, not bugs)
- App volume saved at 5%. All Windows output devices are set to 48 kHz (USB DAC "CDS.KT USB Audio" is
  24-bit/48 kHz); set the DAC's Default Format higher to get 96 kHz through. Library is on `A:\Flac`
  (1,136 songs: 698 FLAC, 315 M4A, 123 Opus). WinGet yt-dlp is old (2025.12.08); Oli prefers `bin/`.
- The user uses the app while I test. Late in the session the saved queue was cleared by a test's
  `usePlayer.stop()`; the app then wrote whatever they played next.

## Backups and where things are
- `A:\oli-dev-tools\original-backup`: code before any change. `A:\oli-dev-tools\scripts`: test drivers and
  the EOL guard (`README` in CLAUDE.md).
- `%APPDATA%\Oli\library.sqlite.before-bugfix-2026-09-29` (state before any change today),
  `.before-history-tidy`, `.before-second-tidy` (later snapshots).
- Launch entries live in `A:\EA\.claude\launch.json` (`oli-dev`) and `A:\oli-project-source\.claude\launch.json`.
  A temporary `oli-debug` entry (debug port 9222) is added for tests and removed afterwards.
