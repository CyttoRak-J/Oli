import type { NativeOutputInfo } from '../platform/nativeAudio'

export type OutputKind = 'idle' | 'bitperfect' | 'lossy' | 'converted' | 'direct'

const khz = (hz: number): string => `${Number((hz / 1000).toFixed(1))} kHz`

/**
 * One honest line about what reaches the hardware, from the native player's own report
 * (the phone counterpart of the desktop badge's "-> 48 kHz out"). Never claims more than the report says.
 */
export function describeOutput(info: NativeOutputInfo | null): { text: string; kind: OutputKind } {
  if (!info || !info.available || !info.track?.ready) return { text: '', kind: 'idle' }
  const rate = info.track.sampleRate
  if (info.bitPerfect?.active) return { text: `bit-perfect ${khz(rate)}`, kind: 'bitperfect' }
  if (info.device?.bluetooth) return { text: 'Bluetooth (compressed)', kind: 'lossy' }
  if (info.resampled && info.mixerRate) return { text: `→ ${khz(info.mixerRate)} out`, kind: 'converted' }
  return { text: `${khz(rate)} out`, kind: 'direct' }
}

/** Rows for the "Audio output" diagnostics list: [label, value]. */
export function outputRows(info: NativeOutputInfo | null): Array<[string, string]> {
  if (!info || !info.available) return [['Native player', 'not running']]
  const rows: Array<[string, string]> = []
  const src = info.source
  if (src && (src.sampleRate || src.mime)) {
    const parts = [
      (src.container || src.mime || '').toUpperCase(),
      src.bitDepth ? `${src.bitDepth}-bit` : '',
      src.sampleRate ? khz(src.sampleRate) : '',
      src.channels ? `${src.channels} ch` : ''
    ].filter(Boolean)
    rows.push(['Source file', parts.join(' · ') || 'unknown'])
  }
  if (info.decoder) {
    rows.push(['Decoder', `${info.decoder}${info.decoderIsSoftware ? ' (software)' : ' (hardware)'}`])
  }
  if (info.track?.ready) {
    rows.push(['Sent to Android as', `${info.track.encoding} · ${khz(info.track.sampleRate)}`])
  } else if (info.hasSource) {
    rows.push(['Sent to Android as', 'starting…'])
  }
  if (info.mixerRate) rows.push(['Android mixer rate', khz(info.mixerRate)])
  const d = info.device
  if (d && d.type) {
    rows.push(['Output device', `${d.type}${d.name ? ` (${d.name})` : ''}${d.exact ? '' : ' — best guess'}`])
  }
  const bp = info.bitPerfect
  if (bp) {
    rows.push([
      'Bit-perfect',
      bp.active
        ? 'yes — the device gets the file\'s own format'
        : !bp.supported
          ? 'not available (needs Android 14+)'
          : bp.requested
            ? `no — ${bp.note}`
            : 'no (switch is off)'
    ])
  }
  if (info.verdict) rows.push(['What happens', info.verdict])
  if (info.sinkError) rows.push(['Audio error', info.sinkError])
  return rows
}
