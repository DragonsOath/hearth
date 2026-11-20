/**
 * The built-in voice's helper process (Standard voice): Kokoro speaks, Whisper listens, on this
 * computer's processor. It runs apart from Hearth's server, so a voice problem can't take Hearth
 * down, and Hearth stops it when it has been idle, so its memory comes back.
 *
 * It loads the voice pack Hearth downloaded into its data folder (HEARTH_VOICE_PACK), never
 * anything from the internet once the pack is ready. Messages come from Hearth over IPC:
 *   { id, op: "prepare" }                 downloads the models (progress messages as it goes)
 *   { id, op: "speak", text, voice }      replies { audio (16-bit PCM), rate }
 *   { id, op: "hear", audio, rate }       16-bit PCM in; replies { text }
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fixPhonemes, pieces } from "./pieces";

export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
export const WHISPER_MODEL = "onnx-community/whisper-base.en";
export const WHISPER_REVISION = "51eefc0af78b103839eda9e7e4f4186acc6517fe";

type Msg =
  | { id: number; op: "prepare" }
  | { id: number; op: "speak"; text: string; voice: string }
  | { id: number; op: "hear"; audio: Buffer; rate: number };

const pack = process.env.HEARTH_VOICE_PACK ?? "";
// Resolved inside the pack folder, the first time a package is loaded.
let need: NodeRequire | undefined;
// The packages resolve to either module format; their exports are wherever they landed.
const load = async <T>(name: string): Promise<T> => {
  need ??= createRequire(path.join(pack, "package.json"));
  const mod = (await import(pathToFileURL(need.resolve(name)).href)) as Record<string, unknown>;
  return { ...((mod.default as object | undefined) ?? {}), ...mod } as T;
};

interface Transformers {
  env: {
    cacheDir: string;
    localModelPath: string;
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
  };
  pipeline: (
    task: string,
    model: string,
    opts: Record<string, unknown>,
  ) => Promise<(audio: Float32Array) => Promise<{ text: string }>>;
}
interface Kokoro {
  KokoroTTS: {
    from_pretrained: (
      model: string,
      opts: Record<string, unknown>,
    ) => Promise<{
      generate: (
        text: string,
        opts: { voice: string },
      ) => Promise<{ audio: Float32Array; sampling_rate: number }>;
    }>;
  };
}

let speaker: Awaited<ReturnType<Kokoro["KokoroTTS"]["from_pretrained"]>> | undefined;
let listener: Awaited<ReturnType<Transformers["pipeline"]>> | undefined;

type Progress = (p: { file: string; loaded: number; total: number }) => void;

async function setup(online: boolean, progress?: Progress) {
  const t = await load<Transformers>("@huggingface/transformers");
  t.env.cacheDir = path.join(pack, "models");
  // The downloaded files are read straight from the pack's folder. Without this, a fresh helper
  // (after an idle stop or a Hearth restart) refused to load them with downloads turned off.
  t.env.localModelPath = path.join(pack, "models");
  t.env.allowLocalModels = true;
  // Once ready, the pack never reaches the internet: everything comes from its own folder.
  t.env.allowRemoteModels = online;
  const progress_callback = (p: {
    status?: string;
    name?: string;
    file?: string;
    loaded?: number;
    total?: number;
  }) => {
    if (p.status === "progress" && p.file)
      progress?.({ file: `${p.name}/${p.file}`, loaded: p.loaded ?? 0, total: p.total ?? 0 });
  };
  const k = await load<Kokoro>("kokoro-js");
  speaker ??= await k.KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype: "fp32",
    device: "cpu",
    revision: KOKORO_REVISION,
    progress_callback,
  });
  // Kokoro reads phonemes, not text: its own phonemizer runs first, and generate() hands the
  // result to the tokenizer. Fixed there, so every word Kokoro says wrong is fixed in one place.
  if (speaker && !(speaker as { phonemesFixed?: boolean }).phonemesFixed) {
    const s = speaker as unknown as {
      tokenizer: (p: string, o: unknown) => unknown;
      phonemesFixed?: boolean;
    };
    const tokenize = s.tokenizer;
    s.tokenizer = (p, o) => tokenize(fixPhonemes(p), o);
    s.phonemesFixed = true;
  }
  listener ??= await t.pipeline("automatic-speech-recognition", WHISPER_MODEL, {
    dtype: "q8",
    device: "cpu",
    revision: WHISPER_REVISION,
    progress_callback,
  });
}

async function speak(text: string, voice: string): Promise<{ audio: Buffer; rate: number }> {
  if (!speaker) await setup(false);
  const parts: Buffer[] = [];
  let rate = 24000;
  for (const piece of pieces(text)) {
    const out = await speaker!.generate(piece, { voice });
    rate = out.sampling_rate;
    const pcm = Buffer.alloc(out.audio.length * 2);
    for (let i = 0; i < out.audio.length; i++)
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out.audio[i]! * 32767))), i * 2);
    parts.push(pcm, Buffer.alloc(Math.round(rate * 0.12) * 2));
  }
  return { audio: Buffer.concat(parts), rate };
}

async function hear(audio: Buffer, rate: number): Promise<string> {
  if (!listener) await setup(false);
  // Whisper listens at 16 kHz.
  const n = Math.floor(audio.length / 2);
  const out = Math.floor((n * 16000) / rate);
  const f = new Float32Array(out);
  for (let i = 0; i < out; i++)
    f[i] = audio.readInt16LE(Math.min(n - 1, Math.floor((i * rate) / 16000)) * 2) / 32768;
  return (await listener!(f)).text.trim();
}

if (process.send) {
  const reply = (m: Record<string, unknown>) => process.send?.(m);
  process.on("message", (raw) => {
    const m = raw as Msg;
    const done = (p: Promise<Record<string, unknown>>) =>
      p
        .then((r) => reply({ id: m.id, ok: true, ...r }))
        .catch((e: unknown) =>
          reply({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
    if (m.op === "prepare")
      void done(setup(true, (progress) => reply({ id: m.id, progress })).then(() => ({})));
    else if (m.op === "speak") void done(speak(m.text, m.voice));
    else if (m.op === "hear")
      void done(hear(Buffer.from(m.audio), m.rate).then((text) => ({ text })));
  });
  // Hearth went away (stopped, restarted, updated): so does the helper.
  process.on("disconnect", () => process.exit(0));
  reply({ ready: true });
}
