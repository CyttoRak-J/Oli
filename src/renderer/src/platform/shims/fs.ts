/**
 * Stand-in for node:fs. The phone has no Node file system: files are handled by Capacitor plugins and native code.
 * These stubs make code paths that are desktop-only (M3U import/export, backup files) fail loudly instead of crashing on import.
 */
const unsupported = (name: string) => (): never => {
  throw new Error(`fs.${name} is not available in the Android app`)
}

export const existsSync = (): boolean => false
export const readFileSync = unsupported('readFileSync')
export const writeFileSync = unsupported('writeFileSync')
export const readdirSync = unsupported('readdirSync')
export const statSync = unsupported('statSync')
export const mkdirSync = unsupported('mkdirSync')
export const unlinkSync = unsupported('unlinkSync')
export const renameSync = unsupported('renameSync')
export const copyFileSync = unsupported('copyFileSync')
export const rmSync = unsupported('rmSync')

export default { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, unlinkSync, renameSync, copyFileSync, rmSync }
