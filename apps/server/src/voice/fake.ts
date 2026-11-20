import type { SpeechClient } from "./service";

/**
 * Stand-in speech services for the browser tests (DC_FAKE_VOICE=1): no GPU
 * machine needed. Whatever is recorded is heard as one fixed sentence, and
 * every installed voice answers with a short tone.
 */
export const FAKE_VOICES = ["en_US-warden-medium", "en_US-belle-medium", "en_US-lessac-high"];
export const FAKE_HEARD = "What is happening with my servers?";

export const fakeSpeechClient: SpeechClient = {
  describe: async () => ({
    asr: [{ name: "faster-whisper", models: [{ name: "fake-small.en", installed: true }] }],
    tts: [
      {
        name: "piper",
        voices: FAKE_VOICES.map((name) => ({
          name,
          installed: true,
          attribution: { name: name.includes("lessac") ? "rhasspy" : "" },
        })),
      },
    ],
  }),
  transcribe: async (_target, pcm) => (pcm.audio.length ? FAKE_HEARD : ""),
  synthesize: async (_target, text, voice) => {
    const rate = 22050;
    if (!FAKE_VOICES.includes(voice))
      return { audio: Buffer.alloc(0), rate, width: 2, channels: 1 };
    const samples = Math.min(rate * 2, Math.max(rate / 5, text.length * 200));
    const audio = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++)
      audio.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 3000), i * 2);
    return { audio, rate, width: 2, channels: 1 };
  },
};
