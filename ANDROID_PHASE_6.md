# Android phase 6 brief: the phone tells us what is true

Read `ANDROID_PLAN.md` (status, parity table, PC estimates), `HANDOFF.md` ("Start here") and the top sections of `ANDROID_PHASE_1B.md`, `_1C.md`, `_2.md`, `_3.md`, `_5.md` (what exists + the owner's phone checklists). Everything in phases 1b to 5 is built and released (android-v0.3.0 to v0.7.0) but **none of the native code has ever run on a phone**. This phase is about facts from a real device.

## Order of work
1. **Get the owner's phone results first** (ask; the checklists are in the phase files; the shortest useful report: install 0.7.0, open Settings > Audio output, Library, YouTube engine, play one song with the screen off, and send what each screen says). Fix what they report before adding anything. Typical first failures to expect: a plugin method that throws on a real device (permissions, MediaStore column differences, foreground-service start rules), the YouTube engine not starting (Python unpack, ABI), ExoPlayer refusing a `content://` or googlevideo address, cover files not served from the cache folder.
2. **In-app diagnostics** (recommended first feature, makes every later report easy): Settings > "Copy diagnostics" = app + Android versions, ABI, which plugins the web view sees (`Capacitor.PluginHeaders`), permission states, foreground-service state, the YouTube engine status/error text, the last errors of each plugin (keep a small ring buffer in JavaScript around every plugin call), database size, number of songs. A text the owner can paste into the chat.
3. **Native-rewrite decision** (`ANDROID_PLAN.md`, triggers 1-4) from the owner's real measurements (scroll feel with their library, first-scan time, memory, background play with the screen off for 10 minutes, start-up time). Do not start a rewrite on PC numbers.
4. **Signing key** (`docs/ANDROID_SIGNING.md`): if the owner decides, add the four secrets, tag a build, verify it with `apksigner verify --print-certs`; the first build with the new key needs one uninstall (export a backup first).
5. **Leftovers, by likely value** (each is listed as "not built" in the parity table):
   - notification/lock-screen artwork for local songs (`OliMedia.getArtwork` already writes `cacheDir/art/<album>.jpg`: pass that file's URI as `artworkUri` in `setMetadata`; the session bitmap loader reads file URIs);
   - gapless playback / pre-buffering the next song (Media3 playlist of two items, the queue stays in JavaScript);
   - Storage Access Framework folder picker for music that MediaStore does not list; duplicate detection;
   - ReplayGain / lyrics from MP3 and M4A tags (extend `FlacTags` idea to ID3/MP4 atoms);
   - online metadata matching for YouTube songs ("fix metadata"): move the provider fetch code of `src/main/services/provider.ts` into a shared, fetch-only module used by both apps;
   - an in-app APK downloader/installer (`REQUEST_INSTALL_PACKAGES` + FileProvider) on top of `androidUpdate.ts`;
   - `BUILD_FROM_SCRATCH.md` and the prompts after each change (`node scripts/sync-build-spec.mjs --fix` keeps its code blocks exact).

## How to work here (unchanged)
- Java cannot be compiled on the PC: push branch `android-dev` and read the run (`https://api.github.com/repos/CyttoRak-J/Oli/actions/runs?branch=android-dev`; failures publish their messages as annotations: `.../check-runs/<job id>/annotations`). Pure Java classes can be compiled and run with the PC's JDK (`scripts/android-tags`).
- PC checks: `npm run typecheck && npm run lint && npm test`, then `powershell -File scripts\android-harness\run-all.ps1` (97 checks). Stop test windows by process id, never by window title (a desktop Oli may be running).
- Write repository files with the Write/Edit tools or scripts that keep LF and no byte-order mark (PowerShell `Set-Content -Encoding utf8` adds a BOM and broke `build.gradle` once). Then `python A:\oli-dev-tools\scripts\eol.py`.
- Releases: tag `android-vX.Y.Z` on a commit whose `android-dev` build was green; verify the downloaded APK against `SHA256SUMS-android.txt`, the workflow's `apksigner` step, and the manifest/dex contents.

## Definition of done for a phase-6 session
Owner's results read and answered; every reported failure fixed or explained; new checklist for what changed; `HANDOFF.md`, `ANDROID_PLAN.md`, the phase files, the prompts and `BUILD_FROM_SCRATCH.md` updated; release verified.
