/**
 * Sample rate the audio output actually runs at. Chromium mixes everything
 * at the rate of the Windows output device (its "Default Format"), so a
 * 96 kHz file is converted to that rate before it reaches the sound card.
 */
export function readOutputSampleRate(): number {
  try {
    const ctx = new AudioContext()
    const rate = ctx.sampleRate
    void ctx.close()
    return rate
  } catch {
    return 0
  }
}
