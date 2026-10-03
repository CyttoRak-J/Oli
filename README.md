<div align="center">

# Oli

**A premium desktop music player and local library manager for Windows and macOS.**

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20android-lightgrey)
![Version](https://img.shields.io/badge/version-1.1.2-purple)

</div>

Oli plays your own music collection, YouTube, and free lossless music from the Internet Archive.
Browse your library by songs, albums, and artists; search and play YouTube videos or download them
as tagged audio files; organize everything with queues, favorites, history, and playlists.
Everything is stored locally on your machine.

## Features

- **Local library player** — MP3, FLAC, AAC/M4A, WAV, OGG, Opus and more, with automatic metadata
  and embedded artwork extraction. Seeking works on every format, including 24-bit / 96 kHz FLAC.
- **YouTube in the same app** — paste any link into Search and play it, or download it as a
  tagged song or video file. Playlists and Mixes are supported.
- **Internet Archive** — search free lossless music (FLAC, WAV, ALAC) and download it. Every file is
  checked against the archive's checksum, and missing tags and cover art are filled in. No account or key.
- **Self-updating YouTube engine** — Oli installs and updates `yt-dlp` by itself (checked against the
  official SHA-256) and tells you in the app if it is missing or blocked. Can be switched off in Preferences.
- **Queue & history** — your queue, playback history, favorites, and resume state are saved
  between sessions. "Play every track in random order" shuffles your whole library.
- **Smart playlists** — manual and rule-based playlists that stay in sync with your library.
- **Deep desktop integration** — taskbar thumbnails and controls (Windows), system tray, mini player,
  floating bubble player, and media key support.
- **Themes** — dark, light and OLED themes with customizable accent color.
- **Privacy by default** — no account, no tracking; your library never leaves your computer.

## Getting started

1. Download the latest build from the [Releases](https://github.com/CyttoRak-J/Oli/releases) page:
   - **Windows:** `Oli-Setup-<version>.exe`
   - **macOS:** `Oli-<version>-arm64.dmg` (Apple silicon) or `Oli-<version>-x64.dmg` (Intel)
2. Run it and launch Oli. The builds are **not code-signed**, so the first start shows a warning:
   - **Windows:** SmartScreen → **More info** → **Run anyway**.
   - **macOS:** right-click Oli → **Open** → **Open**. If macOS says the app is damaged, run
     `xattr -cr /Applications/Oli.app` once.
3. Open **Preferences → Library**, add your music folder, and let Oli scan it.
4. Start listening — or paste a YouTube link into Search, or open **Internet Archive** in the sidebar.

`SHA256SUMS.txt` on each release lists the checksum of every file.

### Android (alpha)

The Android app lives on the Releases page as `Oli-<version>-android.apk` (pre-releases tagged `android-v*`; the latest is 0.9.21, about 104 MB because it
contains the YouTube engine). Same screens as the PC app with a phone layout, and:
- **Music player**: a native Android player that keeps playing with the screen off, notification and lock-screen controls, headset/Bluetooth buttons, and an
  honest report of what really reaches the speakers or a USB DAC (hi-res files are decoded at full bit depth; the app says when Android converts the rate).
- **Your music**: scan all the music on the phone or choose the folders to scan (like the PC's "Add folders"), reads their real format and tags, shows covers, follows changes.
- **Internet Archive** and **YouTube**: search, paste links, playlists, play in the app, download songs/videos/playlists through a resumable background
  download queue; downloaded FLAC/MP3 files get their tags and cover written in; tag editing; backup and restore; update check.
- It is signed with a public alpha key, so it is for testing (`docs/ANDROID_SIGNING.md` explains how to use your own key).

**Honest status:** every planned feature is built and the build is checked by GitHub Actions and by tests on a PC, but the app has **not been run on a real phone yet**.
See [`BUILD_FROM_SCRATCH.md`](BUILD_FROM_SCRATCH.md), Appendix B (status table) and Appendix C (phases, Phase 6 = what comes next).

## Building from source

Requirements: Node.js 20+ (22 recommended), npm.

```bash
npm install          # also downloads the yt-dlp binary for your OS (checksum-verified)
npm run dev          # run in development mode
npm run typecheck    # type check
npm run lint         # lint
npm test             # unit tests (vitest)
npm run build:win    # Windows installer  -> dist/Oli-Setup-<version>.exe
npm run build:mac    # macOS disk images  -> dist/Oli-<version>-<arch>.dmg (run on a Mac)
```

Pushing a version tag (`git tag v1.2.3 && git push origin v1.2.3`) makes GitHub Actions build the
Windows and macOS packages and publish a release (see `.github/workflows/build.yml`). A tag `android-v0.1.0`
builds the Android APK the same way (`.github/workflows/android.yml`).

Newer npm versions block install scripts by default. If `npm run dev` says Electron failed to install, run
`node node_modules/electron/install.js` (and `node scripts/fetch-yt-dlp.mjs` for the YouTube engine) once.

The installer bundles `yt-dlp`. Merging YouTube video and audio, and converting some formats
(Opus, WavPack, APE) for playback, use an `ffmpeg` found on your system
(`winget install ffmpeg` on Windows, `brew install ffmpeg` on macOS).

## For contributors and AI assistants

- [`CLAUDE.md`](CLAUDE.md) — project rules, commands and the mistakes not to repeat.
- [`BUILD_FROM_SCRATCH.md`](BUILD_FROM_SCRATCH.md) Appendix A — what changed recently, what is verified, what is still open.
- [`BUILD_FROM_SCRATCH.md`](BUILD_FROM_SCRATCH.md) — a complete guide for building this app from zero
  (it asks the user for the name and other choices first).
- Appendix B and C of the same file — the Android status, plan and per-phase notes; Appendix D — prompts to paste into a new chat (continue the work, or build and release: the release agent asks which platforms).

## Documentation

Visit the [Oli Help Center](https://cyttorak-j.github.io/Oli/) for setup help,
troubleshooting, and the FAQ.

## Data & privacy

All app data is stored in a single SQLite database (`%APPDATA%\Oli\library.sqlite` on Windows,
`~/Library/Application Support/Oli/library.sqlite` on macOS). Oli only uses the network when you
explicitly search or play online content, check for updates, or when it installs its YouTube engine.
Spotify/AcoustID API keys, if you add any, stay on your machine.

Only download what you are allowed to have. The Internet Archive page shows each item's licence link.

## Support

Found a bug or have an idea? Open an
[issue](https://github.com/CyttoRak-J/Oli/issues) and attach the newest log file
from `%APPDATA%\Oli\logs`.

## License

[MIT](LICENSE) © 2026 Cytto
