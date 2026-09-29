# Android phase 5: big libraries, updates, signing

> **STATUS: built and shipped as android-v0.7.0 (versionCode 7). Measured on the PC only.** (There is no phase 4: the plan's numbering skipped it.)

## What was done
- **Measured first** (`scripts/android-harness/perf.cjs`: made-up libraries of 3,000 and 10,000 songs in the PC test window, page slowed 4x to imitate a mid-range phone). Finding: every scrolled-past row stayed in the page, so scrolling the whole list of 3,000 songs cost 123 MB and 13-20% of frames over 50 ms (one frame took 1.9 s).
- **Windowed song list** (`lib/useRowWindow.ts`, `computeWindow` tested in `test/rowWindow.test.ts`; `SongTable`): rows are exactly 46 px, only the rows on screen plus a margin exist, blocks of 6 rows come and go, `overflow-anchor: none` (the browser otherwise shifts the scroll position), "Go to playing track" works for rows that are not in the page (`oli:jump-to-track`). Result: 26 MB, worst frame 0.12 s (3,000 songs); 48 MB with 10,000. The song table is shared with the desktop app: checked there too, on a COPY of the real library (1,137 songs) in an isolated profile — scrolling to the end, the playing-track jump and the layout are right. Suite: `e2e-list.cjs` (8 checks).
- **Faster scan:** lossy files (MP3/AAC/Opus/Vorbis) are marked as read without asking the phone for details (Android already lists their length and bit rate).
- **Update check** (`platform/androidUpdate.ts`, `test/androidUpdate.test.ts`): compares the installed version (`versionName` injected at build time as `__OLI_ANDROID_VERSION__`) with the newest `android-vX.Y.Z` GitHub release and opens the release page in Custom Tabs (`@capacitor/browser`); nothing is installed automatically.
- **Signing hook** (`docs/ANDROID_SIGNING.md`): the workflow signs with the owner's key when the secrets `OLI_KEYSTORE_BASE64`, `OLI_KEYSTORE_PASSWORD`, `OLI_KEY_ALIAS`, `OLI_KEY_PASSWORD` exist, else with the public alpha key. **Not switched:** the owner has to decide (one uninstall is needed the first time).
- **Tooling:** `run-all.ps1` runs the PC suites (97 checks at 0.7.0; 114 with the folder suite added in 0.8.0, 133 at 0.9.0); `scripts/sync-build-spec.mjs` keeps the code blocks of `BUILD_FROM_SCRATCH.md` equal to the source.

## What this does NOT prove
The PC is not a phone: the numbers are estimates for the native-rewrite triggers (see `ANDROID_PLAN.md`). Real file reads during the first scan, the web view's own cost, yt-dlp start-up and whether Android keeps the foreground services alive can only be seen on the phone.

## Owner's phone checklist for 0.7.0
1. With your real music (thousands of songs if you have them): scroll the Songs list fast. Smooth? Any blank rows or jumps? Use "Go to playing track" while a far-away song plays.
2. Settings > About & updates > Check for updates: shows the installed version (0.7.0) and "up to date" (or a newer release with a link).
3. First scan of a big library: how long until songs appear, how long until "Reading song details" finishes? Does the phone get hot or the app lag meanwhile?
4. Decide about the signing key (`docs/ANDROID_SIGNING.md`).
