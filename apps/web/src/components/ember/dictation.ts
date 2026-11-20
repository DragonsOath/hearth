/**
 * Dictation: what you say appears in the message box as you say it, the way a phone keyboard's
 * microphone works, and nothing is sent until you send it. It uses the browser's own speech
 * recognition (Chrome, Edge, Safari). Where a browser has none, the caller falls back to Hearth's
 * speech to text, which fills the box once you stop.
 */

interface Alternative {
  transcript: string;
}
interface Result {
  isFinal: boolean;
  0: Alternative;
}
interface ResultEvent {
  resultIndex: number;
  results: ArrayLike<Result>;
}
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: ResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionClass = new () => Recognition;

function recognitionClass(): RecognitionClass | undefined {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionClass;
    webkitSpeechRecognition?: RecognitionClass;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const canDictate = () => Boolean(recognitionClass());

/** Puts dictated words after what is already typed, with one space between. */
export function joinDictation(before: string, said: string): string {
  const words = said.trim();
  if (!words) return before;
  const first = /[.!?]\s*$/.test(before) || !before.trim();
  const cased = first ? words[0]!.toUpperCase() + words.slice(1) : words;
  return before && !/\s$/.test(before) ? `${before} ${cased}` : before + cased;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "The browser blocked the microphone. Allow it for this page and try again.",
  "service-not-allowed":
    "The browser blocked the microphone. Allow it for this page and try again.",
  "audio-capture": "No microphone was found.",
};

export class Dictation {
  private rec: Recognition | null = null;
  private wanted = false;
  private before = "";
  private finals = "";

  get on() {
    return this.wanted;
  }

  /**
   * Starts listening. `text` gets the whole box text as it changes (what was typed, then what you
   * said so far); `ended` says why it stopped, with a message only for a real problem; `unsupported`
   * means the browser cannot do it here (fall back to Hearth's speech to text).
   */
  start(
    typed: string,
    text: (t: string) => void,
    ended: (problem?: string, unsupported?: boolean) => void,
  ) {
    const Rec = recognitionClass();
    if (!Rec) {
      ended(undefined, true);
      return;
    }
    this.before = typed;
    this.finals = "";
    this.wanted = true;
    const rec = new Rec();
    this.rec = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) this.finals = joinDictation(this.finals, r[0].transcript);
        else interim += r[0].transcript;
      }
      text(joinDictation(joinDictation(this.before, this.finals), interim));
    };
    let problem: string | undefined;
    let unsupported = false;
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "network" || e.error === "language-not-supported") unsupported = true;
      else problem = ERRORS[e.error] ?? `Dictation stopped: ${e.error}.`;
      this.wanted = false;
    };
    // Browsers stop after a pause; keep going until you press the mic again.
    rec.onend = () => {
      if (this.wanted && this.rec === rec) {
        this.before = joinDictation(this.before, this.finals);
        this.finals = "";
        try {
          rec.start();
          return;
        } catch {
          this.wanted = false;
        }
      }
      if (this.rec === rec) this.rec = null;
      ended(problem, unsupported);
    };
    try {
      rec.start();
    } catch {
      this.wanted = false;
      this.rec = null;
      ended(undefined, true);
    }
  }

  stop() {
    this.wanted = false;
    this.rec?.stop();
  }

  /** Stops at once and drops anything still on its way (the message was just sent). */
  abort() {
    this.wanted = false;
    if (!this.rec) return;
    this.rec.onresult = null;
    this.rec.abort();
  }
}

/**
 * One thing said, for talking to EMBER without a speech machine: ends when you pause. Gives what
 * was heard ("" for nothing), a message for a real problem, or `unsupported`.
 */
export function hearOnce(): {
  done: Promise<{ text: string; problem?: string; unsupported?: boolean }>;
  stop: () => void;
} {
  const Rec = recognitionClass();
  if (!Rec) return { done: Promise.resolve({ text: "", unsupported: true }), stop: () => {} };
  const rec = new Rec();
  rec.continuous = false;
  rec.interimResults = false;
  rec.lang = navigator.language || "en-US";
  let text = "";
  let problem: string | undefined;
  let unsupported = false;
  const done = new Promise<{ text: string; problem?: string; unsupported?: boolean }>((resolve) => {
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) text = joinDictation(text, r[0].transcript);
      }
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "network" || e.error === "language-not-supported") unsupported = true;
      else problem = ERRORS[e.error] ?? `Listening stopped: ${e.error}.`;
    };
    rec.onend = () => resolve({ text, problem, unsupported });
    try {
      rec.start();
    } catch {
      resolve({ text: "", unsupported: true });
    }
  });
  return { done, stop: () => rec.stop() };
}
