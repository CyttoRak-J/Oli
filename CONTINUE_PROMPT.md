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
3. Run `npm run typecheck`, `npm run lint` and `npm test` and confirm they are green (111 tests in 17 files).
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
<write the next task here, for example: "continue the Android app from ANDROID_PLAN.md, phase 1">
```

---

## State when this file was written (2026-09-29)

- Version 1.1.0. Windows installer and macOS disk images are built by GitHub Actions when a `v*` tag is pushed
  (`.github/workflows/build.yml`) and published as a GitHub Release with `SHA256SUMS.txt`.
- The macOS build is ad-hoc signed (`scripts/adhoc-sign.cjs`) and has **not** been run on a real Mac.
- Android is **not built**. The plan and open questions live in `ANDROID_PLAN.md` once it exists.
- Open items are listed in the "Not verified / open ideas" section of `HANDOFF.md`.
