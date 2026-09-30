## Oli for Android (alpha)

An early build of Oli for Android phones. **Install:** download `Oli-<version>-android.apk` to your phone, open it, and allow
"Install unknown apps" for your browser or file manager when Android asks. `SHA256SUMS-android.txt` has the checksum.
Allow notifications and access to your music when asked: the lock-screen controls and the scan need them.

### What is new in 0.9.18: seek diagnosis
- Now Playing shows a small grey "Last seek: ..." line under the time after every seek (what the player was asked, whether the file is seekable, where it landed, where it was 1.5 s later, any error). Temporary, to find why seeking restarts the song on the phone.

### Already in 0.9.17: seek bar, second try
- The seek bar now also reacts to the browser's own "value committed" event, which arrives for every kind of touch (taps on the bar, drags, releases outside the bar).
- **Settings > Audio output > Last seek** shows what the player was asked and where it landed (for example "asked 120.0 s, seekable=true -> landed 120.0 s"). If seeking still fails, please send me that line.

### Already in 0.9.16: seek bar and Up Next on the Now Playing screen
- **Seek bar**: a finger drag now always counts as a seek (before, Android could end the drag without the app noticing, so the song restarted from 0:00), and the bar has a proper length even while a stream is still loading.
- **Up Next**: tapping a song's title now plays it (before it opened the song info); the small (i) button at the right opens the info.

### Already in 0.9.15: background play and downloads
- **Next song, notification Next / Previous and the lock-screen buttons keep working when the app is minimized or the screen is off** (the app's queue runs in its web page, which Android slowed down almost to a stop in the background; it is now kept running).
- **Seeking / "previous" to the start**: a position report sent just before the seek no longer drags the bar (and the song) back to where it was.
- **Downloads continue when the app is minimized**: the download service stays up between songs (also while the next song is still being prepared) and holds the CPU and Wi-Fi awake until the list is done.

### Already in 0.9.14: ffmpeg starts
- **Oli now unpacks the phone's ffmpeg** (the library only does that when asked, so ffmpeg could never start). Video + sound are joined into one file, and song covers and tags are embedded; a `.webp` cover is converted to `.jpg` first.
- Test video access shows ffmpeg's last problem, if any.

### Already in 0.9.13: joined video + sound, covers, titles, the video player
- **Video downloads now have sound**: Oli downloads picture and sound and joins them with the phone's ffmpeg itself (if ffmpeg cannot run it falls back to a lower-quality file that already has sound, never a silent picture).
- **Song downloads embed the cover and tags** (title, artist, album) with the same ffmpeg.
- **File names**: videos are named after the video title (before: "YouTube video [id]"); no more [id] in names.
- **Watch video plays**: the video page's script was blocked by the app's security policy; it now runs.
- Test video access also says whether ffmpeg runs.

### Already in 0.9.12: download folder, ffmpeg
- **Settings > Downloads > Download folder**: choose where downloads are saved (like the library folder). Android asks once to allow access to all files; "Use default" goes back to the app folder.
- Song and video downloads no longer fail with "ffmpeg not found" (the new yt-dlp needs ffmpeg under its plain name; Oli now provides it).

### Already in 0.9.11: the real cause of the video / seek / download failures
- **The phone was running a 9-month-old yt-dlp (2025.11.12)**; its update button did not really update it, and YouTube serves that old release only the first few MB of a file (videos would not play, downloads stopped at ~20%, seeking went back to 0:00). Oli now downloads the **official newest yt-dlp** from GitHub itself (SHA-256 checked) on first start and when you press update, and shows its real version in Settings > YouTube engine.

### Already in 0.9.10: more detail in Test video access
- Test video access now also prints what yt-dlp itself reports (its real version, the YouTube client it used, warnings).

### Already in 0.9.9: seeking and song downloads
- **Seeking online songs**: the player now asks YouTube for short pieces with the range inside the address (the way yt-dlp does) instead of one open-ended request, which YouTube refused after a seek.
- **Song downloads**: if yt-dlp crashes in its tag / cover step ('NoneType' object has no attribute 'lower') Oli saves the plain audio instead of failing; it retries once more with the simplest format choice.
- Test video access also lists the public address of 6 new connections.

### Already in 0.9.8: version label, resume, YouTube test
- The app now shows its real version (it said 0.9.2 since that release).
- A download cut off by YouTube (HTTP 403) is retried with a fresh address that carries on from the part already saved.
- **Settings > YouTube engine > Test video access** reports which parts of a video YouTube serves to this phone with each method (send me that text if videos still fail).

### Already in 0.9.7: seeking online songs
- **Seeking in an online song no longer jumps back to 0:00.** Oli now uses the PC's YouTube method for songs and tests that a later part of the file can be fetched (that is what a seek asks for) before it plays; a method whose addresses refuse that is skipped.

### Already in 0.9.6: song downloads use the PC's YouTube method too
- Audio (song) downloads now try the same YouTube method as the PC first, and a failed download lists what **every** method answered (the list wraps over four lines, long-press to select) instead of only the last one ("'NoneType' object has no attribute 'lower'").

### Already in 0.9.5: the YouTube method the PC uses for videos
- The phone's default YouTube method served only the first ~12 MB of a video and then refused (HTTP 403): downloads stopped at ~19% and videos would not play. Oli now tries the **same method the PC uses (visionos) first** for videos, then the others, each tested with a real request (start and middle) before use.

### What is new in 0.9.4: videos that YouTube refuses
- Before playing or downloading a video, Oli now **tests each YouTube method with a real request** (start and middle of the picture stream) and uses the first one that YouTube really serves. This is the fix for "HTTP Error 403: Forbidden" on video downloads and for a video that would not play.
- If YouTube refuses every method on this phone, the message says which method was refused and how (for example "default: 1080p refused in the middle (HTTP 403)"), for both the video button and Downloads.

### What is new in 0.9.3: the PC's video player on the phone
- **Watch video** now opens the same player page as the PC: quality list (up to 1080p and more), Repeat, speed, volume, and a Download button (video or tagged song). Close it with the X or the back gesture. The song that was playing stops.
- **Video downloads** ask YouTube in 10 MB pieces (a long request was cut off mid-way on big files), prefer MP4 pictures and try a third YouTube client before giving up.

### Already in 0.9.2 (replaced): a first, native video player that did not play; the page above took its place.

### Already in 0.9.1: Now Playing and the tabs
- **The tabs below now work while Now Playing, Queue, History or Lyrics is open**: tapping Home, Songs, Archive, Downloads or Settings closes the panel and shows that page (before, the page changed behind the panel).
- **Swipe down** on Now Playing (or Queue, History, Lyrics) to slide it away and return to the page you were on. The Now Playing screen itself is unchanged. Dragging the seek bar or scrolling a list does not close it.

### Already in 0.9.0: fixes from the first phone test
- **A tap plays the song** (Songs, search results, playlists, history, Up next). Song info is in the row's ... menu.
- **The back button / gesture goes back** a page (closes Now Playing first) and only leaves the app from the home page.
- **Covers**: the cover inside FLAC files is now read by Oli itself (Android's reader misses many), on separate threads so the player is never held up. The notification and lock screen show the cover too.
- **The player appears in the notification shade** and on the lock screen (the playback service was not registered before). Allow notifications when Android asks.
- **After a call or other audio**, pressing play carries on from the same place instead of doing nothing; if Android ended the audio service, Oli loads the song again by itself.
- **Now Playing fills the screen** and has shuffle, repeat, queue, history and lyrics.
- **Downloads**: a red number on the Downloads tab shows how many files are waiting or downloading; the notification shows it too ("3 files left"), including YouTube downloads (before, the download notification could vanish while only YouTube songs downloaded).
- **Reveal** opens your Files app at the song's folder when Android allows it; otherwise it tells you where the file is (files Oli downloads live in a folder Android hides from file managers).
- **Bigger limits (PC and phone)**: playlists up to 2,000 songs, a Mix up to 500 (a Mix ends near 380 anyway); "Songs prepared ahead" 1-10 (PC), "Simultaneous YouTube downloads" 1-6 (PC and phone; the phone uses 2 until you change it). A queued playlist is never dropped from the Downloads list.
- **YouTube starts faster**: looking up the song you tapped no longer waits behind running downloads, a failing lookup gives up after 30 s instead of 60 s, the next 3 songs are prepared two at a time, and the lookup method that worked last time is tried first.
- **Your queue is remembered**: close the app with a 200-song YouTube queue and open it later: the queue is back and the song you were on resumes at the same place (only that one song is looked up again).

### Already in 0.8.0: choose which folders to scan
- **Settings > Library > "Choose folder"** opens Android's folder picker, like "Add folders" on the PC. Oli then scans only that folder (and the folders inside it). Add as many folders as you like, on the phone or on a memory card; each shows its song count and has its own remove button.
- A folder inside one you already added is not added twice; a folder that contains folders you added takes them over (favorites, play counts and playlists stay).
- **"All phone music"** is still there to scan everything Android knows about. Choosing a folder while it is on asks first, because songs outside the folder then leave the library (your files are never touched).
- Note: Oli reads Android's media library, so a folder with a `.nomedia` file, or files Android has not indexed yet, will not show up.

### Already in 0.7.0: big libraries, updates, your own key
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
- **Oli finds the music on your phone** (Android's media library): the first start asks once for permission to read your music, then scans by itself. Songs, albums, artists, genres, stats and search work on them like on the PC. Settings > Library has "All phone music", "Rescan phone music" and removal (0.8.0 added "Choose folder").
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

### What is not there yet (planned, see the project's BUILD_FROM_SCRATCH.md, Appendix B)
- A folder picker for music outside Android's media library (music on the phone or SD card is normally in it already); ReplayGain / lyrics from MP3 and M4A tags (FLAC is read).
- Online metadata matching ("fix metadata") for YouTube songs; tags of downloaded YouTube songs come from the video's title and channel (edit them in the song list if they are off).

### Please report
Lag while scrolling, crashes, or music stopping in the background: these decide whether the app is rebuilt fully natively for Android.
Also useful: how long the first scan took and how many songs it found, and a screenshot of Settings > Audio output while a 24-bit/96 kHz file plays.

### Notes
- The APK is signed with a public **alpha** key, so it is for testing. A later, properly signed build will not install over it: uninstall first.
- Files are saved in the app's own storage (`Android/data/com.cyttos.oli/files/Oli/`), so they are removed when the app is uninstalled.
- This build was produced by GitHub Actions and has **not** been run on a real phone by the author. The native player, the phone-music scan (MediaStore), the download service, YouTube (yt-dlp on the phone) and the bit-perfect mode in particular are untested on hardware. This build is about 60 MB larger because it contains Python and ffmpeg for YouTube. Please open an issue with what you see.
