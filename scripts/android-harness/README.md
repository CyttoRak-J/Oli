# Phone build test window (no phone needed)

Runs the **real phone build** (`out/renderer-android-test`) in a throwaway Electron window without the desktop preload, so the
web backend installs as it does on a phone. `preload.cjs` loads Capacitor's own `native-bridge.js` and answers the `OliAudio`
plugin calls the way the Java plugin does, playing real audio (from `A:\Flac`) through an `<audio>` element. So the real
`NativeAudio` -> Capacitor bridge -> player store -> UI chain is exercised. It does NOT test the Java code, Media3, the
notification, audio focus or bit-perfect output: those need a phone.

```
# 1. test build with the store exposed as window.__oliPlayer (only when OLI_TEST_HOOKS=1)
OLI_TEST_HOOKS=1 OLI_OUT_DIR=out/renderer-android-test npx vite build -c vite.android.config.ts
# 2. isolated user-data folder (pre-create it), then start the window (debug port 9333)
mkdir -p /tmp/oli-harness-data
node_modules/electron/dist/electron.exe scripts/android-harness/main.cjs "$(pwd)/out/renderer-android-test" /tmp/oli-harness-data 9333
# 3. drive it (prints PASS/FAIL per check; screenshots go to $SHOTS or this folder)
node scripts/android-harness/e2e.cjs
```
Result at the end of phase 1b: 20/20 checks passed (see HANDOFF.md). The window's title is "Oli": stop it by its process id, not
by window title, so a running desktop app is never touched. Port 8765 is used by the static server (Chromium blocks 5060).
