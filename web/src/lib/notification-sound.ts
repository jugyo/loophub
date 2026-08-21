// The bell rung for new notifications (#2508). The tone is synthesized here and encoded as a WAV
// data URI so the sound ships inside the bundle: no asset request, no external host, and the
// waveform stays reviewable as code.

const SAMPLE_RATE = 22050;
const DURATION_SECONDS = 0.7;
// Partials of a small hand bell: a strike tone plus two overtones that fade faster than it does.
const PARTIALS = [
  { hertz: 880, gain: 1, decayPerSecond: 6 },
  { hertz: 1320, gain: 0.5, decayPerSecond: 9 },
  { hertz: 2640, gain: 0.25, decayPerSecond: 14 },
];
// Quiet enough to sit under whatever else is playing; a notification is not an alarm.
const PEAK_AMPLITUDE = 0.25;
// A hard start would click, so the first few milliseconds fade in.
const ATTACK_SECONDS = 0.005;
const WAV_HEADER_BYTES = 44;

function bellAmplitude(seconds: number): number {
  let value = 0;
  let totalGain = 0;
  for (const { hertz, gain, decayPerSecond } of PARTIALS) {
    value +=
      gain *
      Math.sin(2 * Math.PI * hertz * seconds) *
      Math.exp(-decayPerSecond * seconds);
    totalGain += gain;
  }
  const attack = Math.min(1, seconds / ATTACK_SECONDS);
  return (value / totalGain) * attack * PEAK_AMPLITUDE;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** The bell as a base64 `data:audio/wav` URI: 16-bit mono PCM, one RIFF chunk. */
function encodeBellWav(): string {
  const sampleCount = Math.round(SAMPLE_RATE * DURATION_SECONDS);
  const dataBytes = sampleCount * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < sampleCount; i++) {
    const amplitude = bellAmplitude(i / SAMPLE_RATE);
    view.setInt16(
      WAV_HEADER_BYTES + i * 2,
      Math.round(amplitude * 32767),
      true,
    );
  }

  let binary = "";
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

let cachedDataUri: string | null = null;

/** The encoded bell, synthesized on first use and reused afterwards. */
export function bellWavDataUri(): string {
  cachedDataUri ??= encodeBellWav();
  return cachedDataUri;
}

function reportPlaybackFailure(error: unknown): void {
  // Browsers refuse to play audio before the page has seen a user gesture. Surfacing the failure
  // is the whole response: no retry, no silent fallback (see CLAUDE.md design principles).
  console.error("Notification sound could not be played", error);
}

/** Ring the bell once. Playback failures are reported, never thrown at the caller. */
export function playNotificationBell(): void {
  try {
    new Audio(bellWavDataUri()).play().catch(reportPlaybackFailure);
  } catch (error) {
    // No audio support at all (an environment without HTMLAudioElement) lands here.
    reportPlaybackFailure(error);
  }
}
