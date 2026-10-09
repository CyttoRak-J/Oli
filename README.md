<div align="center">

# Oli

**A premium desktop music player and local library manager for Windows and macOS.**

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20android-lightgrey)
![Version](https://img.shields.io/badge/version-1.1.2-purple)

</div>

Oli is an offline music player for your own music collection.
Browse your library by songs, albums, and artists; organize everything with queues, favorites,
history, and playlists. Everything is stored locally on your machine.

## Features

- **Local library player** — MP3, FLAC, AAC/M4A, WAV, OGG, Opus and more, with automatic metadata
  and embedded artwork extraction. Seeking works on every format, including 24-bit / 96 kHz FLAC.
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
4. Start listening.

`SHA256SUMS.txt` on each release lists the checksum of every file.

### Android (alpha)

The Android app lives on the Releases page as `Oli-<version>-android.apk` (pre-releases tagged `android-v*`; the latest is 0.9.21). Same screens as the PC app with a phone layout, and:
- **Music player**: a native Android player that keeps playing with the screen off, notification and lock-screen controls, headset/Bluetooth buttons, and an
  honest report of what really reaches the speakers or a USB DAC (hi-res files are decoded at full bit depth; the app says when Android converts the rate).
- **Your music**: scan all the music on the phone or choose the folders to scan (like the PC's "Add folders"), reads their real format and tags, shows covers, follows changes.
- Tag editing, backup and restore, and an update check.
- It is signed with a public alpha key, so it is for testing .

**Honest status:** every planned feature is built and the build is checked by GitHub Actions and by tests on a PC, but the app has **not been run on a real phone yet**.

## Source code

Oli's source code is private. This repository hosts the releases, the help site, and the issue tracker.
Bug reports and feature requests are welcome in [Issues](https://github.com/CyttoRak-J/Oli/issues).

Converting some formats (Opus, WavPack, APE) for playback uses an `ffmpeg` found on your system
(`winget install ffmpeg` on Windows, `brew install ffmpeg` on macOS).

## Documentation

Visit the [Oli Help Center](https://cyttorak-j.github.io/Oli/) for setup help,
troubleshooting, and the FAQ.

## Data & privacy

All app data is stored in a single SQLite database (`%APPDATA%\Oli\library.sqlite` on Windows,
`~/Library/Application Support/Oli/library.sqlite` on macOS). Oli only uses the network to check for updates.
Spotify/AcoustID API keys, if you add any, stay on your machine.

## Support

Found a bug or have an idea? Open an
[issue](https://github.com/CyttoRak-J/Oli/issues) and attach the newest log file
from `%APPDATA%\Oli\logs`.

## License

[MIT](LICENSE) © 2026 Cytto
