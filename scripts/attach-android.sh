#!/usr/bin/env bash
# Puts an Android APK (and its checksum file) on a DESKTOP release page, so one page has every download:
#   Windows installer, macOS disk images and the Android app.
#
#   scripts/attach-android.sh <desktop tag | latest> <android tag>
#   e.g.  scripts/attach-android.sh v1.1.1 android-v0.9.1
#
# The files are copied byte for byte from the Android pre-release (the checksum is verified first), so the APK on the
# desktop page is the same file that was signed and checked when it was built. Needs the GitHub CLI (`gh`) and a token in
# GH_TOKEN, as on a GitHub Actions runner. Older Android files on that page are replaced.
set -euo pipefail

DESK="${1:?desktop release tag (or "latest")}"
AND="${2:?android release tag, e.g. android-v0.9.1}"
MARK='<!-- android-apk -->'

if [ "$DESK" = "latest" ]; then
  DESK=$(gh release list --limit 50 --json tagName --jq '[.[] | select(.tagName | test("^v[0-9]"))][0].tagName')
  [ -n "$DESK" ] || { echo "no desktop release found"; exit 1; }
fi
echo "Attaching $AND to $DESK"

work=$(mktemp -d)
gh release download "$AND" --dir "$work" --pattern 'Oli-*-android.apk' --pattern 'SHA256SUMS-android.txt'
(cd "$work" && sha256sum -c SHA256SUMS-android.txt)
apk=$(basename "$work"/Oli-*-android.apk)
version="${AND#android-v}"

# replace the Android files of an earlier version
for name in $(gh release view "$DESK" --json assets --jq '.assets[].name' | grep -E '^Oli-.*-android\.apk$|^SHA256SUMS-android\.txt$' || true); do
  gh release delete-asset "$DESK" "$name" --yes
done
gh release upload "$DESK" "$work/$apk" "$work/SHA256SUMS-android.txt"

# one paragraph about it in the release text (replaced, not repeated)
body=$(gh release view "$DESK" --json body --jq '.body' | sed "/$MARK/,\$d")
note="$MARK
## Android (alpha)

**\`$apk\`** is attached below: the Oli app for Android phones, version $version (\`SHA256SUMS-android.txt\` has its checksum). Open it on your phone and allow *Install unknown apps* when Android asks. It is a test build signed with a public alpha key; its own notes and older versions are on the [\`$AND\` pre-release](https://github.com/${GITHUB_REPOSITORY:-CyttoRak-J/Oli}/releases/tag/$AND)."
gh release edit "$DESK" --notes "$body

$note"
echo "done"
