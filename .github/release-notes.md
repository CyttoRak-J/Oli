## Downloads

| Platform | File |
|---|---|
| **Windows 10 / 11 (64-bit)** | `Oli-Setup-<version>.exe` |
| **macOS, Apple silicon (M1 and newer)** | `Oli-<version>-arm64.dmg` (or the `.zip`) |
| **macOS, Intel** | `Oli-<version>-x64.dmg` (or the `.zip`) |

`SHA256SUMS.txt` lists the checksum of every file.

## What is new in 1.1.2

- **A single YouTube video can be played, not only downloaded**: paste a video link into Home or Search and the card now has a **Play** button next to Download (before, only playlists and Mixes had it). The Android app has the same fix.

### Already in 1.1.1

- **Bigger YouTube playlists and Mixes**: a playlist can list and download up to 2,000 songs (was 200) and a Mix up to 500 (was 100; a Mix ends near 380 anyway).
- **Settings > Downloads**: "Songs prepared ahead" now goes up to 10 (was 5) and "Simultaneous YouTube downloads" up to 6 (was 3). More at once is faster but can trigger YouTube's bot check: lower it if downloads start failing.
- **Your queue comes back after a restart, also a YouTube queue**: close Oli with hundreds of YouTube songs queued and open it later: the queue is there and the song you were on resumes at the same place (only that song is looked up again). Before, only library songs were resumed.
- **Faster start of the next YouTube songs**: the next three songs of the queue are prepared while one plays (was two).

## First start

These builds are **not code-signed**, so your system shows a warning the first time:

- **Windows:** SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS:** open the disk image, drag Oli to Applications, then **right-click Oli, choose Open**, and confirm once.
  If macOS says the app is damaged, run `xattr -cr /Applications/Oli.app` in Terminal and open it again.

Oli installs its own YouTube engine (yt-dlp) and keeps it up to date; no other software is needed for playing
your library or downloading from the Internet Archive. Merging YouTube video and audio, and converting some
formats (Opus, WavPack, APE) for playback, need `ffmpeg` on your PC.

## What is in this version

- Play your own library (FLAC, MP3, M4A, WAV, Opus and more) with seeking that works on every format.
- YouTube search, playback and downloads, with an engine that installs and updates itself.
- **Internet Archive** page: search free lossless music (FLAC, WAV) and download it, checked against the
  archive's checksums, with tags and cover art filled in.
- Playlists (manual and smart), favorites, queue, history, lyrics, mini player and floating bubble.
- "Play every track in random order" starts at the first track of the shuffled queue.

## Known limits

- macOS builds are new and have not been run on a real Mac by the author. Please open an issue if something is wrong.
- The Android app is separate: pre-releases named `android-v*` on this page (alpha, tested on one phone so far).
