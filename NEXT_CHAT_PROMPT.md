# Paste this into the NEW chat (Android phase 1c: the music on the phone)

Start the new chat with the working folder set to `A:\oli-project-source` (or a fresh clone of https://github.com/CyttoRak-J/Oli), then paste everything inside the block.

```
I'm continuing work on Oli (Electron + React music player for Windows/macOS, also being built for Android). Repo: https://github.com/CyttoRak-J/Oli, local folder A:\oli-project-source. My songs are in A:\Flac.
Earlier chats built the desktop app (v1.1.0) and Android up to phase 1b: native Media3 audio, hi-res output report, bit-perfect switch, background playback (release android-v0.3.0). Please continue with Android PHASE 1C.

Before touching anything:
1. Read CLAUDE.md (rules), HANDOFF.md (start with "Start here"), ANDROID_PLAN.md (architecture, parity checklist, native-rewrite triggers), ANDROID_PHASE_1B.md (top section: what exists + my phone checklist) and ANDROID_PHASE_1C.md (the task).
2. Check my saved memory notes (Oli project, Android goals, test hygiene, verify-in-real-app).
3. Run `npm run typecheck`, `npm run lint` and `npm test` (expect green, 138 tests in 19 files), then `git status` and `git log --oneline -5`, and check the latest GitHub Actions runs and releases via the public API (gh is not installed; latest tags: v1.1.0, android-v0.3.0).
4. Tell me in 5 lines or fewer what state the project is in. Don't change anything yet. Then ask me whether I have phone results for android-v0.3.0 (checklist at the top of ANDROID_PHASE_1B.md); if I do, fix what I report first.

The task (Phase 1C): find and play the music already on the phone: MediaStore scanner plugin, extra tags (bit depth, sample rate, ReplayGain...), cover art, folder picker, ids identical to desktop ids. Ship as android-v0.4.0 (versionCode 4) via GitHub Actions, verify the APK (checksum, apksigner), update the docs, push.

How I want you to work:
- My goals: the Android app must have ALL the PC app's features (YouTube and Internet Archive included). If the phone app lags, crashes or loses background playback, rewrite it natively for Android (triggers are in ANDROID_PLAN.md) and keep everything on GitHub. I cannot always test on a phone right away, so say plainly what you could not verify on a device and give me a short checklist to test.
- Prove things by running the real thing: the phone build in the throwaway Electron test window (scripts/android-harness, see its README), unit tests, CI for the APK (push branch android-dev to compile-check Java; no Android SDK on this PC). Give measured results.
- Desktop rules: never change hash64 in src/main/util/identity.ts; the desktop keeps the HTML audio element and the loopback MediaServer for local audio; keep the desktop build free of phone code (`__OLI_WEB__`).
- The dev app uses my real library in %APPDATA%\Oli. Back it up before tests that write; use an isolated --user-data-dir (pre-create the folder) for risky tests; clean up test data afterwards. Do not restart or stop an app I may be using without saying so.
- Keep explanations short and in plain language. If I ask a question, answer it and don't start building.
- Commit at every working step, push to GitHub, and at the end update HANDOFF.md, ANDROID_PLAN.md, ANDROID_PHASE_1C.md/next brief, NEXT_CHAT_PROMPT.md and CONTINUE_PROMPT.md so the next chat can continue.

What I want next: start Phase 1C as described above.
```

## Short version (if you only want a one-liner)
"Continue Oli Android phase 1c (scan the phone's music with MediaStore, tags, cover art, folder picker). Read CLAUDE.md, HANDOFF.md 'Start here', ANDROID_PLAN.md, ANDROID_PHASE_1B.md (top) and ANDROID_PHASE_1C.md first, run the checks, tell me the state in 5 lines and ask for my phone results of android-v0.3.0, then build it and ship android-v0.4.0."
