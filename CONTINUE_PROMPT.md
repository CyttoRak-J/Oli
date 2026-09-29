# Continue prompt (paste this into a new chat when a session ends)

Use this when a chat hits its limit or the context is full. Open the new chat with the working folder set to
the project (`A:\oli-project-source`, or a fresh clone of https://github.com/CyttoRak-J/Oli), then paste the block below.

---

```
I'm continuing work on Oli, my Electron + React + TypeScript music player (repo: https://github.com/CyttoRak-J/Oli,
local folder A:\oli-project-source). A long earlier session did a lot and ran out of context.

Before touching anything:
1. Read CLAUDE.md (rules), HANDOFF.md (what changed, what is verified, what is open) and, if it exists,
   ANDROID_PLAN.md (Android status and next steps). BUILD_FROM_SCRATCH.md is the full specification.
2. Check my saved memory notes (Oli project, test hygiene, verify-in-real-app).
3. Run `npm run typecheck`, `npm run lint` and `npm test` and confirm they are green (138 tests in 19 files).
4. Run `git status` and `git log --oneline -5`, and check the latest GitHub Actions run / release for the newest tag.
5. Tell me in 5 lines or fewer what state the project is in. Don't change anything yet.

How I want you to work:
- Prove fixes by driving the real running app (Chrome DevTools Protocol on a debug port), give measured results,
  and say plainly what you could not verify (for example: you cannot hear audio).
- The dev app uses my real library in %APPDATA%\Oli. Back it up before tests that write, use an isolated
  --user-data-dir (pre-create the folder) for risky tests, stop the app before editing the database file, and
  clean up any test plays or downloads afterwards. I often use the app while you test.
- Never change hash64 in src/main/util/identity.ts, and don't go back to a custom protocol for local audio
  (the loopback MediaServer is required for seeking).
- Keep explanations short and in plain language. If I ask a question, answer it and don't start building.
- Commit at every working step. End each session by updating HANDOFF.md (and ANDROID_PLAN.md) so the next
  session can continue, and by pushing to GitHub.

What I want next:
<write the next task here. For Android phase 1c use the ready-made prompt in NEXT_CHAT_PROMPT.md instead of this file>
```

---

## State when this file was written (2026-09-29)

- Version 1.1.0. Windows installer and macOS disk images are built by GitHub Actions when a `v*` tag is pushed
  (`.github/workflows/build.yml`) and published as a GitHub Release with `SHA256SUMS.txt`.
- The macOS build is ad-hoc signed (`scripts/adhoc-sign.cjs`) and has **not** been run on a real Mac.
- Android alpha (0.1.0 first, now 0.3.0): a Capacitor app reusing the UI (`android/`, `capacitor.config.ts`, `vite.android.config.ts`, backend in
  `src/renderer/src/platform/webBackend.ts`). A tag `android-v*` builds `Oli-<version>-android.apk` with `.github/workflows/android.yml` and publishes a
  pre-release (first one: `android-v0.1.0`, signature verified by apksigner in CI). It has Internet Archive search/download, the phone layout, settings; it has
  NOT been run on a real phone; no phone-music scan, background playback, playlists persistence or YouTube yet. Plan, status table and open decisions
  (native rewrite vs Capacitor, YouTube in Android, real signing key) are in `ANDROID_PLAN.md`.
- Android now runs the shared desktop services inside the phone app (see HANDOFF.md "Android phase 1a" and the parity checklist in `ANDROID_PLAN.md`). Owner's goals: all PC features incl. YouTube + Archive, and a native rewrite if the phone app lags/crashes/loses background playback.
- After adding npm packages, check `node_modules/electron/dist` still exists (newer npm skips install scripts); if not, run `node node_modules/electron/install.js`.
- Test-window trick that works here: the browser pane cannot open local pages (and Chromium blocks port 5060); `scripts/android-harness` (README inside) serves the phone build on port 8765 in a throwaway Electron window without the desktop preload (`window.cytto` is then installed by the web backend), with Capacitor's real native bridge and a stand-in for the audio plugin, driven over the debug port.
- Android phase 1b (native Media3 audio, hi-res report, bit-perfect switch, background playback) is built and shipped as `android-v0.3.0` but NOT yet run on a phone; the phone checklist is at the top of `ANDROID_PHASE_1B.md`. Java cannot be compiled on the PC: push branch `android-dev` (build-only CI) and read the run through the public GitHub API (`gh` is not installed).
- Open items are listed in the "Not verified / open ideas" section of `HANDOFF.md`.
