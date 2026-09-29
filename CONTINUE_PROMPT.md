# Continue prompt (paste this into a new chat when a session ends)

Use this when a chat hits its limit or the context is full. Open the new chat with the working folder set to
the project (`A:\oli-project-source`, or a fresh clone of https://github.com/CyttoRak-J/Oli), then paste the block below.
(For the planned next Android task use the ready-made prompt in `NEXT_CHAT_PROMPT.md` instead.)

---

```
I'm continuing work on Oli, my Electron + React + TypeScript music player for Windows/macOS that is also built for Android
(repo: https://github.com/CyttoRak-J/Oli, local folder A:\oli-project-source, my songs are in A:\Flac).
A long earlier session did a lot and ran out of context.

Before touching anything:
1. Read CLAUDE.md (rules), HANDOFF.md ("START HERE": what changed, what is verified, what is open) and ANDROID_PLAN.md
   (Android status, parity table, native-rewrite triggers). BUILD_FROM_SCRATCH.md is the full specification (section 20 = Android).
2. Check my saved memory notes (Oli project, Android goals, test hygiene, verify-in-real-app).
3. Run `npm run typecheck`, `npm run lint` and `npm test` and confirm they are green (237 tests in 32 files).
4. Run `git status` and `git log --oneline -5`, and check the latest GitHub Actions run / release for the newest tag
   through the public API (gh is not installed).
5. Tell me in 5 lines or fewer what state the project is in. Don't change anything yet.

How I want you to work:
- Prove fixes by driving the real running app (Chrome DevTools Protocol on a debug port; for the phone build the PC test
  window in scripts/android-harness), give measured results, and say plainly what you could not verify (for example:
  you cannot hear audio, and nothing native on Android has been run on a phone).
- The dev app uses my real library in %APPDATA%\Oli. Back it up before tests that write, use an isolated
  --user-data-dir (pre-create the folder) for risky tests, stop the app before editing the database file, and
  clean up any test plays or downloads afterwards. I often use the app while you test; never stop or restart it
  without telling me (stop test windows by process id, not by window title).
- Never change hash64 in src/main/util/identity.ts, and don't go back to a custom protocol for local audio
  (the loopback MediaServer is required for seeking).
- Keep explanations short and in plain language. If I ask a question, answer it and don't start building.
- Commit at every working step. End each session by updating HANDOFF.md, ANDROID_PLAN.md, the prompts and
  BUILD_FROM_SCRATCH.md (`node scripts/sync-build-spec.mjs --fix`) so the next session can continue, and by pushing to GitHub.

What I want next:
<write the next task here. For the planned Android phase 6 use the ready-made prompt in NEXT_CHAT_PROMPT.md>
```

---

## State when this file was written (2026-09-30)

- Desktop version 1.1.1. Windows installer and macOS disk images are built by GitHub Actions when a `v*` tag is pushed
  (`.github/workflows/build.yml`) and published as a GitHub Release with `SHA256SUMS.txt`. The macOS build is ad-hoc signed
  (`scripts/adhoc-sign.cjs`) and has **not** been run on a real Mac.
- **Android 0.9.0** (pre-releases `android-v0.1.0` ... `android-v0.9.0`, built by `.github/workflows/android.yml` on a tag `android-v*`; a push to
  branch `android-dev` builds without releasing). It is a Capacitor app reusing the React UI with the desktop services inside the web view, plus four
  native Java plugins: `OliAudio` (Media3 player in a foreground service, honest hi-res report, bit-perfect), `OliMedia` (scan the phone's music),
  `OliDownload` (resumable downloads, FLAC/MP3 tag writers), `OliYouTube` (yt-dlp on the phone). All planned phases are built (1b, 1c, 2, 3, 5) plus the folder picker (0.8.0: Settings > Library > Choose folder); the APK is
  about 104 MB. **It has never been run on a real phone**: CI compiles and signature-checks it, the pure Java is tested on the PC with the JDK, and the
  JavaScript side runs in the PC test window (`scripts/android-harness`, `run-all.ps1`: 133 checks) against stand-ins for the plugins. The owner's phone
  reports are the next step; the checklists are at the top of the `ANDROID_PHASE_*.md` files. Open decisions (native rewrite, real signing key) are in `ANDROID_PLAN.md`.
- After adding npm packages, check `node_modules/electron/dist` still exists (newer npm skips install scripts); if not, run `node node_modules/electron/install.js`,
  then `npm run android:sync`.
- Test-window facts: the browser pane cannot open local pages (and Chromium blocks port 5060); `scripts/android-harness` (README inside) serves the phone build on
  port 8765 in a throwaway Electron window with Capacitor's real native bridge and stand-ins for the plugins. Java is compile-checked by pushing branch `android-dev`.
- Open items are listed in the "Not verified / open ideas" section of `HANDOFF.md` and in the parity table of `ANDROID_PLAN.md`.
