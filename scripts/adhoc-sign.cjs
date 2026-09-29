// electron-builder "afterPack" hook: ad-hoc code-sign the macOS app.
//
// The builds are not signed with an Apple Developer ID. Without any signature, macOS on Apple silicon
// refuses to open the app ("damaged"). An ad-hoc signature (`-`) is free and makes the app open after the
// usual right-click > Open. It does nothing on other platforms.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log(`  • ad-hoc signing ${app}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
