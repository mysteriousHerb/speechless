/**
 * Audio device discovery for the Settings screen. Browsers hide device labels until
 * the page has had microphone permission once, so `requestDeviceLabels()` asks for
 * it (and releases the stream straight away).
 */

export type AudioDevice = { id: string; label: string }
export type AudioDevices = { inputs: AudioDevice[]; outputs: AudioDevice[]; labelled: boolean }

export function deviceListingSupported(): boolean {
  return typeof navigator.mediaDevices?.enumerateDevices === 'function'
}

export async function listAudioDevices(): Promise<AudioDevices> {
  if (!deviceListingSupported()) return { inputs: [], outputs: [], labelled: false }
  const all = await navigator.mediaDevices.enumerateDevices()
  const name = (d: MediaDeviceInfo, kind: string, i: number) => d.label || `${kind} ${i + 1}`
  const inputs = all
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ id: d.deviceId, label: name(d, 'Microphone', i) }))
  const outputs = all
    .filter((d) => d.kind === 'audiooutput')
    .map((d, i) => ({ id: d.deviceId, label: name(d, 'Speaker', i) }))
  const labelled = all.some((d) => d.label)
  return { inputs, outputs, labelled }
}

/** Ask for microphone permission so device labels become visible. Resolves false if refused. */
export async function requestDeviceLabels(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((t) => t.stop())
    return true
  } catch {
    return false
  }
}
