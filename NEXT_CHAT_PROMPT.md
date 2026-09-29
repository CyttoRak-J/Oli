# Paste this into the NEW chat (Android phase 1b: native audio, hi-res)

Start the new chat with the working folder set to `A:\oli-project-source` (or a fresh clone of https://github.com/CyttoRak-J/Oli), then paste everything inside the block.

```
I'm continuing work on Oli (Electron + React music player for Windows/macOS, now also being built for Android). Repo: https://github.com/CyttoRak-J/Oli, local folder A:\oli-project-source.
A long earlier chat built the desktop app, released v1.1.0 (Windows + macOS), and started Android (alpha android-v0.2.0). Please continue with Android PHASE 1B.

Before touching anything:
1. Read CLAUDE.md (rules), HANDOFF.md (start with the "Start here" section), ANDROID_PLAN.md (architecture, PC-vs-Android parity checklist, native-rewrite triggers) and ANDROID_PHASE_1B.md (the detailed task for this session).
2. Check my saved memory notes (Oli project, Android goals, test hygiene, verify-in-real-app).
3. Run `npm run typecheck`, `npm run lint` and `npm test` (expect green, 111 tests in 17 files), then `git status` and `git log --oneline -5`, and check the latest GitHub Actions run and releases (latest tags: v1.1.0, android-v0.2.0).
4. Tell me in 5 lines or fewer what state the project is in. Don't change anything yet.

The task (Phase 1B): native audio on Android with REAL HI-RES output.
- Build a Capacitor plugin `OliAudio` (Java, Media3/ExoPlayer in a foreground `MediaSessionService`) and a JS class `NativeAudio` that looks like an audio element, so the shared player engine (src/renderer/src/store/player.ts) works unchanged on Android.
- Hi-res must play as hi-res: 24-bit/96 kHz FLAC decoded losslessly with float output, Android 14+ bit-perfect mode for USB DACs, and an honest badge/diagnostics screen that shows what really reaches the hardware (decoder, output encoding, output rate, device, bit-perfect yes/no). Never claim hi-res output that is not happening.
- Background playback with the screen off, lock-screen/notification/headset/Bluetooth controls, audio focus, pause when headphones are unplugged.
- Ship it as android-v0.3.0 via GitHub Actions (versionCode 3), verify the APK (checksum, apksigner), update ANDROID_PLAN.md and HANDOFF.md, push.

How I want you to work:
- My goals: the Android app must have ALL the PC app's features (YouTube and Internet Archive included). If the phone app lags, crashes or loses background playback, rewrite it natively for Android (triggers are in ANDROID_PLAN.md) and keep everything on GitHub. I cannot always test on a phone right away, so say plainly what you could not verify on a device and give me a short checklist to test.
- Prove things by running the real thing (the web build in a throwaway Electron window without the desktop preload, driven over the debug port; CI for the APK). Give measured results.
- Desktop rules: never change hash64 in src/main/util/identity.ts; the desktop keeps the HTML audio element and the loopback MediaServer for local audio; keep the desktop build free of phone code (`__OLI_WEB__`).
- The dev app uses my real library in %APPDATA%\Oli. Back it up before tests that write; use an isolated --user-data-dir (pre-create the folder) for risky tests; clean up test data afterwards. Do not restart an app I may be using without saying so.
- Keep explanations short and in plain language. If I ask a question, answer it and don't start building.
- Commit at every working step, push to GitHub, and at the end update HANDOFF.md, ANDROID_PLAN.md and CONTINUE_PROMPT.md so the next chat can continue.

What I want next: start Phase 1B as described above.
```

## Short version (if you only want a one-liner)
"Continue Oli Android phase 1B (native Media3 audio, real hi-res, background play). Read CLAUDE.md, HANDOFF.md 'Start here', ANDROID_PLAN.md and ANDROID_PHASE_1B.md first, run the checks, tell me the state in 5 lines, then build it and ship android-v0.3.0."
