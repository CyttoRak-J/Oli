## Oli for Android (alpha)

An early build of Oli for Android phones. **Install:** download `Oli-<version>-android.apk` to your phone, open it, and allow
"Install unknown apps" for your browser or file manager when Android asks. `SHA256SUMS-android.txt` has the checksum.
Allow notifications and access to your music when asked: the lock-screen controls and the scan need them.

### What is new in 0.7.0: big libraries, updates, your own key
- **Long lists stay smooth**: the song list only keeps the rows on screen, so a library of thousands of songs scrolls as easily as a short one (tested with 3,000 and 10,000 songs; memory dropped from 123 MB to 26 MB with 3,000). "Go to playing track" still finds a song far down the list.
- **Update check**: Settings > About & updates > "Check for updates" looks for a newer Oli Android release on GitHub and opens its page (nothing is installed by itself). The app now shows its real version.
- **Faster scanning**: MP3/AAC/Opus files are not read again for details Android already gives.
- **Your own signing key** can be added later without changing the app (see docs/ANDROID_SIGNING.md); until you do, builds keep the public alpha key.

### Already in 0.6.0: YouTube
- **YouTube search** next to your library (Search page), **paste a YouTube link** (video, playlist or Mix) to see and play it, **play any result in the app** (the audio is streamed by the native player, so it keeps playing with the screen off).
- **Download as a song** (m4a with title, artist and cover embedded), **as a video** (mp4 up to the height you choose) or a **whole playlist**, all through the same download queue: pause, resume, cancel, background service.
- **The YouTube engine (yt-dlp) runs on your phone** and updates itself: Settings > YouTube engine shows its version, "Check" and "Update now". A banner tells you when it was updated.
- Search results and the Downloads screen fit a phone.
- The desktop's separate video window does not exist on the phone (no "Video" button).

### Already in 0.5.0: downloads, tags, backup
- **A real download queue**: several files at a time, **pause / resume / retry / cancel**, progress and speed, kept across restarts. Downloads run in a background service (with a progress notification), so they continue with the screen off, and an interrupted download carries on from where it stopped.
- **Every download is checked** (size and the Internet Archive's MD5) and a damaged file is deleted and reported. The finished **FLAC or MP3 gets its tags and cover art written into the file** (title, artist, album, track, year, genre, cover), so other apps show it properly too.
- **Edit a song's tags** (title, artist, album, ... in the song list's edit): the library updates at once and artists/albums regroup. For songs Oli downloaded the tags are also written into the file; for songs from your phone's music the change stays in Oli (Android owns those files), like non-MP3 files on the PC.
- **Backup and restore**: an automatic backup at most once a day (newest 8 kept), **Export** to the Android share sheet (Drive, e-mail, ...), **Restore** from the newest automatic backup or a file you pick. A file that is not a healthy Oli library is refused before anything is replaced.
- The Downloads screen now fits a phone.

### Already in 0.4.0: the music that is already on your phone
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
- Online metadata matching ("fix metadata") for YouTube songs; tags of downloaded YouTube songs come from the video's title and channel (edit them in the song list if they are off).

### Please report
Lag while scrolling, crashes, or music stopping in the background: these decide whether the app is rebuilt fully natively for Android.
Also useful: how long the first scan took and how many songs it found, and a screenshot of Settings > Audio output while a 24-bit/96 kHz file plays.

### Notes
- The APK is signed with a public **alpha** key, so it is for testing. A later, properly signed build will not install over it: uninstall first.
- Files are saved in the app's own storage (`Android/data/com.cyttos.oli/files/Oli/`), so they are removed when the app is uninstalled.
- This build was produced by GitHub Actions and has **not** been run on a real phone by the author. The native player, the phone-music scan (MediaStore), the download service, YouTube (yt-dlp on the phone) and the bit-perfect mode in particular are untested on hardware. This build is about 60 MB larger because it contains Python and ffmpeg for YouTube. Please open an issue with what you see.
