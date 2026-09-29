## Oli for Android (alpha)

An early build of Oli for Android phones. **Install:** download `Oli-<version>-android.apk` to your phone, open it, and allow
"Install unknown apps" for your browser or file manager when Android asks. `SHA256SUMS-android.txt` has the checksum.
Allow notifications and access to your music when asked: the lock-screen controls and the scan need them.

### What is new in 0.4.0: the music that is already on your phone
- **Oli finds the music on your phone** (Android's media library): the first start asks once for permission to read your music, then scans by itself. Songs, albums, artists, genres, stats and search work on them like on the PC. Settings > Library has "Scan phone music", "Rescan phone music" and removal.
- It **keeps up with the phone**: new files appear, deleted files are marked missing (playlists keep them, like on the PC), changed files are re-read. Favorites, play counts and playlists stay.
- **Real format details are read from the files** (sample rate, bit depth, channels, codec; for FLAC also ReplayGain, ISRC, lyrics), so the Hi-Res badge and the output report are true for your own music too. This runs in the background and shows progress in Settings.
- **Cover art**: embedded covers and folder covers are extracted once per album and cached.
- Song ids follow the same scheme as the PC app.

### Already in 0.3.0: native audio
- **Playback runs in a native Android player (Media3 / ExoPlayer) inside a foreground service.** Music keeps playing with the screen off and while other apps are in front.
- Notification and **lock-screen controls** (play/pause, previous, next, seek bar), headset and Bluetooth buttons, audio focus (pauses for calls and other players), and **pause when headphones are unplugged**.
- **Hi-res files are decoded losslessly at full bit depth** (24-bit and up goes out as 32-bit float, 16-bit and lossy files stay 16-bit).
- **Honest output report** (Settings > Audio output, and a short note in the player): decoder, the format handed to Android, Android's mixer rate, the output device and whether the path is **bit-perfect**. On a phone speaker or Bluetooth a 96 kHz file is converted by Android, and the app says so (for example `→ 48 kHz out`).
- **Bit-perfect switch** (Settings > Audio output): on Android 14+ with a USB DAC it asks Android to send the file's own sample rate and bit depth to the DAC, only if the DAC offers exactly that. The report says yes/no.

### Also in this alpha
- The same screens as the desktop app, with a phone layout (bottom navigation, compact player, compact song list).
- The **same database and logic as the PC app** run inside the app: settings, playlists (manual and smart), favorites, queue, history, play counts, local search and lyrics lookup.
- **Internet Archive:** search free lossless music, open an item, pick a format and tracks, download to the phone. Downloaded files become songs in your library.

### What is not there yet (planned, see ANDROID_PLAN.md)
- A folder picker for music outside Android's media library (music on the phone or SD card is normally in it already); ReplayGain / lyrics from MP3 and M4A tags (FLAC is read).
- YouTube search, playback and downloads; tag editing and metadata fixing; backup and restore.
- Checksum verification, tags and cover art for downloaded files (only the file size is checked).

### Please report
Lag while scrolling, crashes, or music stopping in the background: these decide whether the app is rebuilt fully natively for Android.
Also useful: how long the first scan took and how many songs it found, and a screenshot of Settings > Audio output while a 24-bit/96 kHz file plays.

### Notes
- The APK is signed with a public **alpha** key, so it is for testing. A later, properly signed build will not install over it: uninstall first.
- Files are saved in the app's own storage (`Android/data/com.cyttos.oli/files/Oli/`), so they are removed when the app is uninstalled.
- This build was produced by GitHub Actions and has **not** been run on a real phone by the author. The native player, the phone-music scan (MediaStore) and the bit-perfect mode in particular are untested on hardware. Please open an issue with what you see.
