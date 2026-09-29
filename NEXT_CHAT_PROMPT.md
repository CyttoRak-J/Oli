# Paste this into the NEW chat (Android phase 2: downloads, tags, backup)

Start the new chat with the working folder set to `A:\oli-project-source` (or a fresh clone of https://github.com/CyttoRak-J/Oli), then paste everything inside the block.

```
I'm continuing work on Oli (Electron + React music player for Windows/macOS, also being built for Android). Repo: https://github.com/CyttoRak-J/Oli, local folder A:\oli-project-source. My songs are in A:\Flac.
Earlier chats built the desktop app (v1.1.0) and Android up to phase 1c: native Media3 audio with an honest hi-res output report and bit-perfect switch (android-v0.3.0), and scanning the music already on the phone with MediaStore, real tags, covers (android-v0.4.0). Please continue with Android PHASE 2.

Before touching anything:
1. Read CLAUDE.md (rules), HANDOFF.md (start with "Start here"), ANDROID_PLAN.md (architecture, parity checklist, native-rewrite triggers), the top sections of ANDROID_PHASE_1B.md and ANDROID_PHASE_1C.md (what exists + my phone checklists) and ANDROID_PHASE_2.md (the task).
2. Check my saved memory notes (Oli project, Android goals, test hygiene, verify-in-real-app).
3. Run `npm run typecheck`, `npm run lint` and `npm test` (expect green, 151 tests in 20 files), then `git status` and `git log --oneline -5`, and check the latest GitHub Actions runs and releases via the public API (gh is not installed; latest tags: v1.1.0, android-v0.4.0).
4. Tell me in 5 lines or fewer what state the project is in. Don't change anything yet. Then ask me whether I have phone results for android-v0.3.0 / 0.4.0 (checklists at the top of ANDROID_PHASE_1B.md and ANDROID_PHASE_1C.md); if I do, fix what I report first.

The task (Phase 2): a real download queue (pause/resume/retry, background, persisted), md5 check + tags + cover for downloaded files, tag editing / fix metadata, backup and restore. Ship as android-v0.5.0 (versionCode 5) via GitHub Actions, verify the APK (checksum, apksigner), update the docs, push.

How I want you to work:
- My goals: the Android app must have ALL the PC app's features (YouTube and Internet Archive included). If the phone app lags, crashes or loses background playback, rewrite it natively for Android (triggers are in ANDROID_PLAN.md) and keep everything on GitHub. I cannot always test on a phone right away, so say plainly what you could not verify on a device and give me a short checklist to test.
- Prove things by running the real thing: the phone build in the throwaway Electron test window (scripts/android-harness, see its README), unit tests (also with a real sql.js database), CI for the APK (push branch android-dev to compile-check Java; no Android SDK on this PC). Give measured results.
- Desktop rules: never change hash64 in src/main/util/identity.ts; the desktop keeps the HTML audio element and the loopback MediaServer for local audio; keep the desktop build free of phone code (`__OLI_WEB__`).
- The dev app uses my real library in %APPDATA%\Oli. Back it up before tests that write; use an isolated --user-data-dir (pre-create the folder) for risky tests; clean up test data afterwards. Do not restart or stop an app I may be using without saying so (stop test windows by process id, never by window title).
- Keep explanations short and in plain language. If I ask a question, answer it and don't start building.
- Commit at every working step, push to GitHub, and at the end update HANDOFF.md, ANDROID_PLAN.md, the phase brief/next brief, NEXT_CHAT_PROMPT.md and CONTINUE_PROMPT.md so the next chat can continue.

What I want next: start Phase 2 as described above.
```

## Short version (if you only want a one-liner)
"Continue Oli Android phase 2 (download queue, tags/covers for downloads, tag editing, backup). Read CLAUDE.md, HANDOFF.md 'Start here', ANDROID_PLAN.md, the top of ANDROID_PHASE_1B/1C.md and ANDROID_PHASE_2.md first, run the checks, tell me the state in 5 lines and ask for my phone results of android-v0.3.0/0.4.0, then build it and ship android-v0.5.0."
