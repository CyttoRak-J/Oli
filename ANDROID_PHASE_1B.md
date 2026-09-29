# Android phase 1b brief: native audio with real hi-res output

> **STATUS: built and shipped as android-v0.3.0 (versionCode 3). Not yet run on a phone.** Below: what was built, then the owner's phone checklist, then the original brief (kept for reference).
>
> **What exists**
> - Java, `android/app/src/main/java/com/cyttos/oli/`: `OliAudioPlugin` (Capacitor plugin `OliAudio`: `loadSource`, `play`, `pause`, `stop`, `seekTo`, `setVolume`, `setPlaybackParams`, `setMetadata`, `setBitPerfect`, `getOutputInfo`; events `state`, `time`, `seeked`, `error`, `command`, `outputChanged`), `OliAudioService` (Media3 `MediaSessionService`, foreground type mediaPlayback, tapping the notification opens the app), `OliAudioEngine` (ExoPlayer, diagnostics, bit-perfect), `SourceProbe` (reads FLAC/WAV headers for the real rate/channels/bit depth, MediaExtractor for the rest). `MainActivity` registers the plugin and asks for the notification permission (Android 13+). Media3 1.8.0 (`variables.gradle`).
> - JS: `src/renderer/src/platform/nativeAudio.ts` (`NativeAudio`, an audio-element look-alike; every event carries a token so events of an old song are ignored; plugin calls are serialised), `getAudio()` in `store/player.ts` uses it when the Android plugin exists (desktop keeps `new Audio()`), `lib/useNativeOutput.ts` + `lib/outputText.ts` (report wording), Settings > Audio output, the quality/output lines in `MobilePlayerBar`, setting `bitPerfectOutput`.
> - Hi-res policy: the sink accepts float PCM only for sources that can use it (bit depth > 16 or unknown, not lossy), so 16-bit and lossy files stay 16-bit and 24-bit FLAC is decoded to 32-bit float (`ForwardingAudioSink.getFormatSupport`). The report never says "bit-perfect" unless Android holds a bit-perfect mixer setting whose rate and encoding equal the AudioTrack's.
> - Notification/lock-screen previous/next are asked of the app (`command` event -> `nativecommand` -> store `next()` / `previous()`) because the queue lives in JS.
> - Not done on purpose: gapless/pre-buffering of the next song, a `MediaButtonReceiver` (headset buttons work while the app/service is alive; restarting a dead app from a Bluetooth button is not built), artwork in the notification for local files (phase 1c), HTTP stream headers are supported by the plugin but no JS caller yet (phase 3).
>
> **Owner's phone checklist (please try and report)**
> 1. Install `Oli-0.3.0-android.apk` (it is signed with the same alpha key as 0.1.0/0.2.0, so it should update in place). Allow notifications. Download a song from Internet Archive (Archive page) and play it.
> 2. Play a 16-bit FLAC, a 24-bit/96 kHz FLAC (Archive: search "24bit flac"), an MP3 and an M4A. Each plays, the seek bar works, pause/resume works.
> 3. Turn the screen off for 10 minutes: music continues, the next song starts by itself. Lock-screen and notification buttons (play/pause/previous/next, seek bar) work. Press the headset/Bluetooth button. Unplug headphones: music pauses.
> 4. Start a call or another music app: Oli pauses, then resumes when it is over.
> 5. Settings > Audio output while the 24/96 file plays: screenshot it. Expect on the phone speaker: `Sent to Android as PCM float (32-bit) · 96 kHz`, `Android mixer rate 48 kHz`, "Android's mixer converts 96 kHz to 48 kHz". With a USB DAC on Android 14+ switch "Bit-perfect output" on and replay: the report says yes/no honestly; the DAC's own display should show 96 kHz if yes.
> 6. Scroll the song list while music plays: any stutter? Any crash? (These feed the native-rewrite triggers in `ANDROID_PLAN.md`.)
>
> **Known risks to look at first if something fails on the phone**: `OliAudioService` not starting (logcat: ForegroundServiceStartNotAllowed / permission), `POST_NOTIFICATIONS` denied (no notification but playback continues), the file URI for a downloaded file (`file:///storage/emulated/0/Android/data/com.cyttos.oli/files/...`) not opening in ExoPlayer, the decoder not honouring the float request (the report then shows PCM 16-bit and says so).

---

Read `ANDROID_PLAN.md` (architecture, parity checklist, native-rewrite triggers) and `HANDOFF.md` first. This file is the detailed task for the next session.

## Goal
Replace the browser audio element on Android with a **native Media3 (ExoPlayer) player running in a foreground service**, so that:
1. **Hi-res files play as hi-res.** 24-bit / 96 kHz (and up to 192 kHz) FLAC, WAV, ALAC are decoded losslessly and sent to the output at full bit depth (float PCM), and the app tells the owner **honestly** what actually reaches the hardware.
2. Playback continues with the screen off and when other apps are in front; lock-screen / notification / headset / Bluetooth controls work; audio focus and "headphones unplugged" are handled.
3. The whole shared player engine (`src/renderer/src/store/player.ts`: queue, shuffle, repeat, radio, fallbacks, resume) is **reused unchanged** through an object that looks like an audio element.

The owner's words: "make sure it plays hi-res in hi-res audio."

## What "hi-res in hi-res" can and cannot mean on Android (research notes, NOT yet verified on a device)
- Android's shared audio mixer normally resamples everything to one output rate (often 48 kHz) and the built-in speaker/DAC and Bluetooth codecs cap quality. So on a phone speaker or ordinary Bluetooth the output cannot be true hi-res; the app must say so (like the PC badge `-> 48 kHz out`).
- What the app CAN do:
  - Decode natively and keep full precision: ExoPlayer `DefaultAudioSink` with float output enabled (`DefaultAudioSink.Builder.setEnableFloatOutput(true)`, so 24-bit content is not truncated to 16-bit) and no unnecessary audio processors.
  - **Android 14+ (API 34) bit-perfect mode for USB DACs:** `AudioManager.setPreferredMixerAttributes(audioAttributes, device, AudioMixerAttributes)` with `MIXER_BEHAVIOR_BIT_PERFECT` (check `getSupportedMixerAttributes(device)` first). With a USB DAC this bypasses mixing/resampling so the DAC receives the file's own rate and bit depth. Verify the exact API names against the current Android docs before coding.
  - Read what is really happening and show it: `AudioManager.getProperty(PROPERTY_OUTPUT_SAMPLE_RATE)` (mixer rate), `AudioManager.getDevices(GET_DEVICES_OUTPUTS)` with `AudioDeviceInfo.getType()/getSampleRates()/getEncodings()`, the `AudioTrack` format ExoPlayer created (`AudioSink` / `AnalyticsListener.onAudioTrackInitialized`, `AudioTrackConfig`), and the decoder in use (`onAudioDecoderInitialized`). Report: source (format, bit depth, rate), decoder, output encoding (PCM16/24/float), output rate, device type, and `bit-perfect: yes/no/unsupported`.
  - Do not fake it: if the path is resampled or truncated, the badge says so (for example `HI-RES FLAC 24-bit / 96 kHz -> 48 kHz out (Android mixer)`, or `-> USB DAC bit-perfect`).
- ReplayGain / volume: attenuation only (as on desktop); apply with `player.volume` (a gain change is unavoidable when the owner enables it; default off).

## Interface the native player must provide (from `store/player.ts`)
The store uses one audio element. Create `src/renderer/src/platform/nativeAudio.ts`: a class `NativeAudio extends EventTarget` with these members (measured by grep, 2026-09-29):
- properties: `src` (set = load + autoplay decision like an element; get), `currentSrc`, `currentTime` (get/set = seek), `duration`, `volume` (0..1), `muted`, `paused`, `readyState` (>= 2 once metadata/first data is ready), `error` (object with `code`/`message` like MediaError; the store reads it to decide transcode / fallback), `playbackRate`, `defaultPlaybackRate`, `preservesPitch`, `preload` (ignored).
- methods: `play(): Promise<void>` (reject when it cannot start, like an element), `pause()`, `removeAttribute('src')` (unload), `addEventListener/removeEventListener`.
- events to dispatch: `loadedmetadata`, `play`, `playing`, `pause`, `waiting`, `seeked`, `timeupdate` (about every 250 ms while playing), `ended`, `error`.
- `getAudio()` in `store/player.ts` returns a `NativeAudio` when `shellPlatform() === 'android'` and the plugin exists; desktop keeps `new Audio()`. Keep the stall watchdog, retries and fallbacks working (they only see the interface). `OnlineRow.tsx` preview may keep a plain `Audio`.
- `lib/audioOutput.ts` (`readOutputSampleRate`, used by `PlayerBar`) must get a native source on Android: an async `getNativeOutputInfo()` from the plugin. `MobilePlayerBar` shows a short quality line; a new "Audio output" section in Settings shows the full diagnostics (source, decoder, output encoding/rate, device, bit-perfect state) so the owner can report facts.

## Native side (Capacitor plugin `OliAudio`)
- Written in **Java** inside the existing Capacitor project (the generated Android template has no Kotlin plugin; using Java avoids adding it). Files under `android/app/src/main/java/com/cyttos/oli/`: `OliAudioPlugin.java` (`@CapacitorPlugin`), `OliAudioService.java` (`MediaSessionService` with the ExoPlayer inside), helpers. Register the plugin in `MainActivity` (`registerPlugin(OliAudioPlugin.class)` before `super.onCreate`).
- Gradle: `androidx.media3:media3-exoplayer`, `media3-session`, `media3-common` (current stable versions; check). Add to `android/app/build.gradle`. Optional later: `media3-decoder-flac` / ffmpeg extension only if platform decoders fail on some files.
- Manifest: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` (API 34), `POST_NOTIFICATIONS` (API 33, request at runtime), `WAKE_LOCK`; the service with `android:foregroundServiceType="mediaPlayback"`; `MediaButtonReceiver` handled by Media3.
- Plugin methods: `load({url, headers?, startPositionMs?, autoplay})`, `play`, `pause`, `stop`, `seekTo({positionMs})`, `setVolume`, `setPlaybackParams({speed, preservePitch})`, `getOutputInfo`, `setMetadata({title, artist, album, artworkUri, durationMs})` (for the notification/lock screen), `setBitPerfect({enabled})`. Events to JS: `state` (playing/paused/buffering/ended), `time` (position, duration), `error` (code, message), `command` (`next`, `previous`, `seek`, `playPause` from notification/headset: the queue lives in JS, so the service asks JS to change track), `outputChanged`.
- Sources: `file://` URIs of downloaded files (Capacitor `Directory.External` paths), `content://` (MediaStore, phase 1c), `http(s)://` streams with headers (YouTube, phase 3). Gapless and pre-buffering of the next track are nice-to-have after the basics.
- Audio focus (`AudioAttributes` CONTENT_TYPE_MUSIC, `handleAudioFocus = true`), `handleAudioBecomingNoisy = true` (pause when headphones are unplugged), wake mode `WAKE_MODE_LOCAL` for local files and `WAKE_MODE_NETWORK` for streams.

## Acceptance tests (the owner runs these on the phone; also add unit tests for the JS adapter with a fake plugin)
1. 16-bit/44.1 kHz FLAC, 24-bit/96 kHz FLAC (for example an archive.org 24bit Flac item), MP3, M4A/AAC, WAV, Opus: each plays, seeks (drag the bar), and resumes after pause.
2. Screen off for 10 minutes: music keeps playing; next track starts by itself; lock-screen controls (play/pause/next/previous/seek) work; Bluetooth/headset buttons work; unplugging headphones pauses.
3. Another app takes audio focus (phone call, other player): Oli pauses and resumes correctly.
4. Audio output diagnostics screen shows, for a 24/96 FLAC: decoder, output encoding (float or PCM 24 when available), the real output rate, and `bit-perfect` yes/no. With a USB DAC on Android 14+ and bit-perfect enabled: the DAC shows the file's own rate.
5. Badge honesty: on the phone speaker a 24/96 file shows the `-> 48 kHz out` style note (or whatever the truth is); never claims hi-res output that is not happening.
6. No lag: scrolling the song list while music plays stays smooth. Note any stutter (it counts toward the native-rewrite triggers).

## Definition of done for this session
- Typecheck, lint and all tests green; new JS unit tests for `NativeAudio`.
- `android-v0.3.0` (versionCode 3, versionName 0.3.0) built by CI, `apksigner verify` passed, release published, checksum verified.
- `ANDROID_PLAN.md` checklist and `HANDOFF.md` updated; what could not be verified on a device stated plainly.
- Do **not** break desktop: the desktop player keeps the HTML audio element; never change `hash64`; never reintroduce a custom protocol for desktop audio.

## Traps found so far
- Chromium blocks port 5060; the browser pane cannot open local pages: test the web build in a throwaway Electron window without the desktop preload (see `CONTINUE_PROMPT.md`).
- Adding npm packages with the current npm can skip install scripts and delete `node_modules/electron/dist`: run `node node_modules/electron/install.js` afterwards.
- The phone build's page policy needs `'wasm-unsafe-eval'` (already added in `vite.android.config.ts`); any other page-policy change must be made there, not in the desktop `index.html`.
- The Bash/PowerShell/Write tools sometimes fail with a transient "classifier" error: retry once; it recovered every time.
