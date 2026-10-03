## Downloads

| Platform | File |
|---|---|
| **Windows 10 / 11 (64-bit)** | `Oli-Setup-<version>.exe` |
| **macOS, Apple silicon (M1 and newer)** | `Oli-<version>-arm64.dmg` (or the `.zip`) |
| **macOS, Intel** | `Oli-<version>-x64.dmg` (or the `.zip`) |

`SHA256SUMS.txt` lists the checksum of every file.

## First start

These builds are **not code-signed**, so your system shows a warning the first time:

- **Windows:** SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS:** open the disk image, drag Oli to Applications, then **right-click Oli, choose Open**, and confirm once.
  If macOS says the app is damaged, run `xattr -cr /Applications/Oli.app` in Terminal and open it again.

Converting some formats (Opus, WavPack, APE) for playback needs `ffmpeg` on your PC.

## What is in this version

- Play your own library (FLAC, MP3, M4A, WAV, Opus and more) with seeking that works on every format.
- Playlists (manual and smart), favorites, queue, history, lyrics, mini player and floating bubble.
- "Play every track in random order" starts at the first track of the shuffled queue.

## Known limits

- macOS builds are new and have not been run on a real Mac by the author. Please open an issue if something is wrong.
- The Android app is separate: pre-releases named `android-v*` on this page (alpha, tested on one phone so far).
