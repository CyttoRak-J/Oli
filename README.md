<div align="center">

# Oli

**A premium desktop music player and local library manager for Windows.**

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![Version](https://img.shields.io/badge/version-1.0.0-purple)

</div>

Oli plays your own music collection — and YouTube. Browse your library by songs, albums,
and artists; search and play YouTube videos or download them as tagged audio files;
organize everything with queues, favorites, history, and playlists. Everything is stored
locally on your machine.

## Features

- **Local library player** — MP3, FLAC, AAC/M4A, WAV, OGG and more, with automatic metadata
  and embedded artwork extraction.
- **YouTube in the same app** — paste any link into Search and play it, or download it as a
  tagged song or video file. Playlists are fully supported.
- **Queue & history** — your queue, playback history, favorites, and resume state are saved
  between sessions.
- **Smart playlists** — manual and rule-based playlists that stay in sync with your library.
- **Deep Windows integration** — taskbar thumbnails and controls, system tray, mini player,
  and media key support.
- **Themes** — dark and OLED themes with customizable accent color.
- **Privacy by default** — no account, no tracking; your library never leaves your computer.

## Getting started

1. Download the latest installer from the
   [Releases](https://github.com/CyttosPlay/CyttosPlay/releases) page
   (`Oli-Setup-1.0.0.exe`).
2. Run it and launch Oli.
3. Open **Settings → Library**, add your music folder, and let Oli scan it.
4. Start listening — or paste a YouTube link into Search.

## Building from source

Requirements: Node.js 18+, npm.

```bash
npm install
npm run dev        # run in development mode
npm run typecheck  # type check
npm run lint       # lint
npm run build:win  # build the Windows installer (dist/Oli-Setup-1.0.0.exe)
```

The installer bundles `yt-dlp` for YouTube support. Video downloads additionally use an
`ffmpeg` found on your system (`winget install ffmpeg`).

## Documentation

Visit the [Oli Help Center](https://cyttosplay.github.io/CyttosPlay/) for setup help,
troubleshooting, and the FAQ.

## Data & privacy

All app data is stored in a single SQLite database at
`%APPDATA%\Oli\library.sqlite`. Oli only uses the network when you explicitly search or
play online content. Spotify/AcoustID API keys, if you add any, stay on your machine.

## Support

Found a bug or have an idea? Open an
[issue](https://github.com/CyttosPlay/CyttosPlay/issues) and attach the newest log file
from `%APPDATA%\Oli\logs`.

## License

[MIT](LICENSE) © 2026 Cytto
