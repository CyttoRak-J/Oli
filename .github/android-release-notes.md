## Oli for Android (alpha)

An early build of Oli for Android phones. **Install:** download `Oli-<version>-android.apk` to your phone, open it, and allow
"Install unknown apps" for your browser or file manager when Android asks. `SHA256SUMS-android.txt` has the checksum.

### What works in this alpha
- The same screens as the desktop app, with a phone layout (bottom navigation, compact player, compact song list).
- The **same database and logic as the PC app** run inside the app: settings, playlists (manual and smart), favorites, queue, history, play counts, local search and lyrics lookup.
- **Internet Archive:** search free lossless music, open an item, pick a format and tracks, download to the phone. Downloaded files become songs in your library.

### What is not there yet (planned, see ANDROID_PLAN.md)
- Native background playback with lock-screen controls (playback may stop when the screen turns off) and playing local files through the native player.
- Scanning music that is already on your phone, cover art.
- YouTube search, playback and downloads; tag editing and metadata fixing; backup and restore.
- Checksum verification, tags and cover art for downloaded files (only the file size is checked).

### Please report
Lag while scrolling, crashes, or music stopping in the background: these decide whether the app is rebuilt fully natively for Android.

### Notes
- The APK is signed with a public **alpha** key, so it is for testing. A later, properly signed build will not install over it: uninstall first.
- Files are saved in the app's own storage (`Android/data/com.cyttos.oli/files/Oli/`), so they are removed when the app is uninstalled.
- This build was produced by GitHub Actions and has **not** been run on a real phone by the author. Please open an issue with what you see.
