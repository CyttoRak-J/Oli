## Oli for Android (alpha)

An early build of Oli for Android phones. **Install:** download `Oli-<version>-android.apk` to your phone, open it, and allow
"Install unknown apps" for your browser or file manager when Android asks. `SHA256SUMS-android.txt` has the checksum.
Allow notifications and access to your music when asked: the lock-screen controls and the scan need them.

### Features
- **Native music player** that keeps playing with the screen off, with notification and lock-screen controls, headset and Bluetooth buttons, and an honest report of what really reaches the speakers or a USB DAC. Hi-res files are decoded at full bit depth; **bit-perfect** output to a USB DAC on Android 14+.
- **Your music**: scan all the music on the phone or choose the folders to scan, reads the real format and tags, shows covers, follows changes.
- **Big libraries stay smooth**: the song list only keeps the rows on screen.
- Seek bar, Up Next, queue, history, lyrics, shuffle and repeat; swipe down to close Now Playing.
- Playlists (manual and smart), favorites, play counts and local search.
- **Edit a song's tags**, **backup and restore**, and a check for new Oli releases.

### Please report
Lag while scrolling, crashes, or music stopping in the background. Also useful: how long the first scan took and how many songs it found.

### Notes
- The APK is signed with a public **alpha** key, so it is for testing. A later, properly signed build will not install over it: uninstall first.
- This build was produced by GitHub Actions and has not been run on many phones. The native player, the phone-music scan (MediaStore) and the bit-perfect mode in particular need more testing on hardware. Please open an issue with what you see.
