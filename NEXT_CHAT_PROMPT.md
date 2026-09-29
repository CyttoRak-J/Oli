# Paste this into the NEW chat (Android phase 6: the phone tells us what is true)

Start the new chat with the working folder set to `A:\oli-project-source` (or a fresh clone of https://github.com/CyttoRak-J/Oli), then paste everything inside the block.

```
I'm continuing work on Oli (Electron + React music player for Windows/macOS, also built for Android). Repo: https://github.com/CyttoRak-J/Oli, local folder A:\oli-project-source. My songs are in A:\Flac.
Earlier chats built the desktop app (v1.1.1) and ALL planned Android phases: native Media3 audio with an honest hi-res report (0.3.0), scanning the music on the phone (0.4.0), a resumable download queue with tags/backup (0.5.0), YouTube through yt-dlp on the phone (0.6.0), a windowed song list, update check and signing hook (0.7.0), choosing which folders to scan (0.8.0). The owner then tested 0.8.0 on a real phone and reported 11 problems; 0.9.0 fixes them (table in ANDROID_PLAN.md, "First real-phone test"). None of the native code has ever run on a phone. Please continue with Android PHASE 6.

Before touching anything:
1. Read CLAUDE.md (rules), HANDOFF.md (start with "START HERE"), ANDROID_PLAN.md (status, parity table, PC speed estimates, native-rewrite triggers) and ANDROID_PHASE_6.md (the task). The phone checklists are at the top of ANDROID_PHASE_1B.md, _1C.md, _2.md, _3.md and _5.md. BUILD_FROM_SCRATCH.md section 20 is the full Android specification.
2. Check my saved memory notes (Oli project, Android goals, test hygiene, verify-in-real-app).
3. Run `npm run typecheck`, `npm run lint` and `npm test` (expect green, 237 tests in 32 files), then `git status` and `git log --oneline -5`, and check the latest GitHub Actions runs and releases through the public API (gh is not installed; latest tags: v1.1.1, android-v0.9.1).
4. Tell me in 5 lines or fewer what state the project is in. Don't change anything yet. Then ask me for my phone results for android-v0.9.1 (the short version: install it, open Settings > Audio output, Library and YouTube engine, play one song with the screen off, send what the screens say). If I have results, fix what I report first.

The task (Phase 6): act on the phone results; add the in-app "Copy diagnostics" button so reports are easy; help me decide the native rewrite (from real phone numbers only) and the signing key; then the leftovers listed in ANDROID_PHASE_6.md by value. Ship each step as a new android-vX.Y.Z via GitHub Actions (push branch android-dev first to compile-check the Java), verify the APK (checksum, apksigner step, contents), update the docs and prompts, push.

How I want you to work:
- My goals: the Android app must have ALL the PC app's features. If the phone app lags, crashes or loses background playback, rewrite it natively for Android (triggers are in ANDROID_PLAN.md) and keep everything on GitHub. Say plainly what you could not verify on a device and give me a short checklist to test.
- Prove things by running the real thing: the phone build in the throwaway Electron test window (scripts/android-harness, run-all.ps1), unit tests (also with a real sql.js database and the JDK-compiled Java), CI for the APK. Give measured results.
- Desktop rules: never change hash64 in src/main/util/identity.ts; the desktop keeps the HTML audio element and the loopback MediaServer for local audio; keep the desktop build free of phone code (`__OLI_WEB__`).
- The dev app uses my real library in %APPDATA%\Oli. Back it up before tests that write; use an isolated --user-data-dir (pre-create the folder; a copy of the library is fine for read-only checks) for anything risky; clean up test data afterwards. Do not restart or stop an app I may be using without saying so (stop test windows by process id, never by window title).
- Keep explanations short and in plain language. If I ask a question, answer it and don't start building.
- Commit at every working step, push to GitHub, and at the end update HANDOFF.md, ANDROID_PLAN.md, the phase files, BUILD_FROM_SCRATCH.md (`node scripts/sync-build-spec.mjs --fix` + section 20 text), NEXT_CHAT_PROMPT.md and CONTINUE_PROMPT.md so the next chat can continue.

What I want next: start Phase 6 as described above.
```

## Short version (if you only want a one-liner)
"Continue Oli Android phase 6. Read CLAUDE.md, HANDOFF.md 'START HERE', ANDROID_PLAN.md and ANDROID_PHASE_6.md first, run the checks, tell me the state in 5 lines and ask for my phone results of android-v0.9.1, then fix what I report, add 'Copy diagnostics', and continue with the leftovers."
