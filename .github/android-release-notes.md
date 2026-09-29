## Oli for Android (alpha)

An early build of Oli for Android phones. **Install:** download `Oli-<version>-android.apk` to your phone, open it, and allow
"Install unknown apps" for your browser or file manager when Android asks. `SHA256SUMS-android.txt` has the checksum.

### What works in this alpha
- The same screens as the desktop app, with a phone layout (bottom navigation, compact player).
- **Internet Archive:** search free lossless music, open an item, pick a format and tracks, download to the phone.
  Downloaded files show up under **Songs** with their artist, album, format and length, and can be played.
- Settings (theme, accent colour and more).

### What is not there yet
- Scanning music that is already on your phone, playlists, favorites, queue and history saving, lyrics.
- YouTube search, playback and downloads.
- Background playback with lock-screen controls (playback may stop when the screen turns off).
- Checksum verification, tags and cover art for downloaded files (only the file size is checked).

### Notes
- The APK is signed with a public **alpha** key, so it is for testing. A later, properly signed build will not install over it: uninstall first.
- Files are saved in the app's own storage (`Android/data/com.cyttos.oli/files/Oli/`), so they are removed when the app is uninstalled.
- This build was produced by GitHub Actions and has **not** been run on a real phone by the author. Please open an issue with what you see.
