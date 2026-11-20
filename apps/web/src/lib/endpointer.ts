/**
 * Where speech starts and ends, from the microphone's loudness, chunk by chunk.
 * Used by conversation mode so you just talk: it starts when you speak and
 * finishes when you have paused, with no buttons.
 *
 * "Loud" is relative to the room: the background level is learned from the
 * quiet moments, and speech has to be clearly above it (and above a floor,
 * so a silent room does not turn breathing into words).
 */

export interface EndpointerOptions {
  /** This much loud audio in a row starts an utterance (ms). */
  startMs: number;
  /** A pause this long after speech ends it (ms). */
  endSilenceMs: number;
  /** An utterance is cut off here (ms). */
  maxMs: number;
  /** Shorter speech than this is a cough or a click, not words (ms). */
  minSpeechMs: number;
  /** Loudness (RMS) below this is never speech. */
  floor: number;
  /** The first moments after the mic opens only learn the room (ms). */
  calibrateMs: number;
}

export const ENDPOINTER_DEFAULTS: EndpointerOptions = {
  startMs: 150,
  endSilenceMs: 1700,
  maxMs: 60_000,
  minSpeechMs: 350,
  floor: 0.012,
  calibrateMs: 400,
};

/** none: nothing changed. start: speech began. end: finished, send it. discard: too short, drop it. */
export type EndpointEvent = "none" | "start" | "end" | "discard";

export class Endpointer {
  private readonly o: EndpointerOptions;
  /** The room's background loudness, learned while nobody speaks. */
  noise = 0.004;
  speaking = false;
  private loudMs = 0;
  private silenceMs = 0;
  private speechMs = 0;
  private totalMs = 0;
  private heardMs = 0;
  private samples = 0;

  constructor(options: Partial<EndpointerOptions> = {}) {
    this.o = { ...ENDPOINTER_DEFAULTS, ...options };
  }

  /** One chunk of audio: its loudness (RMS, 0 to 1) and its length in ms. */
  push(rms: number, ms: number): EndpointEvent {
    // Learning the room: the average loudness of the first moments, nothing is speech yet.
    if (this.heardMs < this.o.calibrateMs) {
      this.heardMs += ms;
      this.samples++;
      this.noise += (rms - this.noise) / this.samples;
      return "none";
    }
    const loud = rms > Math.max(this.o.floor, this.noise * 3);
    if (!this.speaking) {
      // The background follows quiet quickly and noise slowly (a fan coming on, not your voice).
      this.noise =
        rms < this.noise ? this.noise * 0.8 + rms * 0.2 : this.noise * 0.995 + rms * 0.005;
      if (!loud) {
        this.loudMs = 0;
        return "none";
      }
      this.loudMs += ms;
      if (this.loudMs < this.o.startMs) return "none";
      this.speaking = true;
      this.speechMs = this.loudMs;
      this.totalMs = this.loudMs;
      this.silenceMs = 0;
      return "start";
    }
    this.totalMs += ms;
    if (loud) {
      this.silenceMs = 0;
      this.speechMs += ms;
    } else this.silenceMs += ms;
    if (this.silenceMs < this.o.endSilenceMs && this.totalMs < this.o.maxMs) return "none";
    const enough = this.speechMs >= this.o.minSpeechMs;
    this.reset();
    return enough ? "end" : "discard";
  }

  /** Forget the utterance in progress (the room's background level is kept). */
  reset() {
    this.speaking = false;
    this.loudMs = 0;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.totalMs = 0;
  }
}

/** Loudness (RMS) of a chunk of samples, sampling every few to stay cheap. */
export function rmsOf(data: Float32Array, step = 4): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += step) {
    sum += data[i]! * data[i]!;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Whisper's usual inventions from noise or a breath, never sent as a question. */
export function isNoiseTranscript(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[^a-z' ]/g, "")
    .trim();
  return !t || /^(you|thank you|thanks|thanks for watching|bye|uh|um|hmm|so|okay)$/.test(t);
}

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * The microphone can catch the last words of the AI's own answer (the speakers ring on
 * for a moment after the audio ends). If what was heard starts with the end of what was
 * just spoken, those words are taken off; if that is all it heard, nothing is left.
 * Only a match of at least two words counts, so a real "yes" is never removed.
 */
export function stripEcho(heard: string, spoken: string | undefined): string {
  if (!spoken) return heard.trim();
  const h = words(heard);
  const s = words(spoken);
  let cut = 0;
  for (let n = Math.min(h.length, s.length, 25); n >= 2; n--) {
    const tail = s.slice(-n).join(" ");
    if (h.slice(0, n).join(" ") === tail) {
      cut = n;
      break;
    }
  }
  if (!cut) return heard.trim();
  // Remove the first `cut` words from the original text, keeping its punctuation after that.
  const re = new RegExp(`^(?:[^A-Za-z0-9']*[A-Za-z0-9']+){${cut}}[^A-Za-z0-9']*`);
  return heard.replace(re, "").trim();
}
