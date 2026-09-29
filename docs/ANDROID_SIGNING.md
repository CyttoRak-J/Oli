# Signing the Android app with your own key

Every Android app must be signed. Until you decide otherwise, the APKs from GitHub Actions are signed with a **public alpha key**
(`android/keystore/oli-alpha.jks`, password in the file `android/app/build.gradle`). Anyone can sign an app with that key, so it is
fine for testing but not for a version you want to keep safe for years.

**Changing the key has one cost:** Android refuses to install an app over an older one that has a different signature. The first build
with your own key means **uninstalling the alpha first** (your library on the phone is then gone, so export a backup first:
Settings > Backup > Export). Every build after that updates in place. That is why nothing is switched automatically: it is your decision.

## Make your key (once, on the PC)
Any JDK has `keytool`:

```bash
keytool -genkeypair -v -keystore oli-release.jks -alias oli -keyalg RSA -keysize 4096 -validity 36500
```
Keep `oli-release.jks` and its passwords **somewhere safe outside the repo** (a password manager and a backup copy). If you lose the key,
you can never update the installed app again (only uninstall and reinstall).

## Give it to GitHub Actions (once)
In the repository: Settings > Secrets and variables > Actions > New repository secret. Add:

| Secret | Value |
|---|---|
| `OLI_KEYSTORE_BASE64` | the key file as text: `base64 -w0 oli-release.jks` (on Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("oli-release.jks"))`) |
| `OLI_KEYSTORE_PASSWORD` | the keystore password |
| `OLI_KEY_ALIAS` | `oli` (the alias used above) |
| `OLI_KEY_PASSWORD` | the key password |

The workflow (`.github/workflows/android.yml`) notices `OLI_KEYSTORE_BASE64`, writes the key to a temporary file on the build machine and
signs with it; its "Verify the APK signature" step still runs. Without the secrets it keeps using the alpha key.

## Check which key an APK has
```bash
apksigner verify --print-certs Oli-x.y.z-android.apk
```
(`apksigner` is in the Android SDK build-tools). The certificate's SHA-256 should be the same for every release you sign with your key.
