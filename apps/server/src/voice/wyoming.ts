import net from "node:net";

/**
 * A small Wyoming protocol client (the protocol Home Assistant uses for its
 * speech services). Each event is a JSON header line, then optional JSON
 * data and a binary payload whose lengths the header gives.
 */

export interface WyomingEvent {
  type: string;
  data: Record<string, unknown>;
  payload?: Buffer;
}

export interface Pcm {
  audio: Buffer;
  rate: number;
  width: number;
  channels: number;
}

export interface SpeechTarget {
  host: string;
  port: number;
  /** Gives up after this long without finishing (ms). */
  timeoutMs?: number;
}

export class SpeechServiceError extends Error {
  override name = "Speech service unavailable";
  statusCode = 502;
}

export function encodeEvent(type: string, data: Record<string, unknown> = {}, payload?: Buffer) {
  const body = Buffer.from(JSON.stringify(data));
  const header: Record<string, unknown> = { type, data_length: body.length };
  if (payload?.length) header.payload_length = payload.length;
  return Buffer.concat([
    Buffer.from(JSON.stringify(header) + "\n"),
    body,
    payload ?? Buffer.alloc(0),
  ]);
}

/** Splits a byte stream into events; feed it chunks, it returns the events completed so far. */
export function eventReader() {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer): WyomingEvent[] => {
    buf = Buffer.concat([buf, chunk]);
    const out: WyomingEvent[] = [];
    for (;;) {
      const nl = buf.indexOf(10);
      if (nl < 0) break;
      const header = JSON.parse(buf.subarray(0, nl).toString("utf8")) as {
        type: string;
        data?: Record<string, unknown>;
        data_length?: number;
        payload_length?: number;
      };
      const dataLen = header.data_length ?? 0;
      const payLen = header.payload_length ?? 0;
      if (buf.length < nl + 1 + dataLen + payLen) break;
      let data = header.data ?? {};
      if (dataLen) data = JSON.parse(buf.subarray(nl + 1, nl + 1 + dataLen).toString("utf8"));
      const payload = payLen
        ? Buffer.from(buf.subarray(nl + 1 + dataLen, nl + 1 + dataLen + payLen))
        : undefined;
      out.push({ type: header.type, data, payload });
      buf = buf.subarray(nl + 1 + dataLen + payLen);
    }
    return out;
  };
}

/**
 * Opens a connection, sends the events, and collects replies until `done`
 * says the exchange is finished.
 */
function exchange<T>(
  target: SpeechTarget,
  send: Buffer[],
  done: (e: WyomingEvent) => T | undefined,
  what: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    const read = eventReader();
    let settled = false;
    const finish = (err: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value as T);
    };
    const timer = setTimeout(
      () =>
        finish(
          new SpeechServiceError(`${what} did not answer in time (${target.host}:${target.port}).`),
        ),
      target.timeoutMs ?? 30_000,
    );
    socket.on("connect", () => {
      for (const b of send) socket.write(b);
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const e of read(chunk)) {
          if (e.type === "error")
            return finish(new SpeechServiceError(`${what}: ${String(e.data.text ?? "error")}`));
          const value = done(e);
          if (value !== undefined) return finish(null, value);
        }
      } catch {
        finish(new SpeechServiceError(`${what} sent something that is not Wyoming.`));
      }
    });
    socket.on("error", (err) =>
      finish(
        new SpeechServiceError(
          `${what} is unreachable at ${target.host}:${target.port} (${(err as NodeJS.ErrnoException).code ?? err.message}).`,
        ),
      ),
    );
    socket.on("close", () =>
      finish(new SpeechServiceError(`${what} closed the connection before finishing.`)),
    );
  });
}

export interface Described {
  asr: { name: string; models: { name: string; installed?: boolean }[] }[];
  tts: {
    name: string;
    voices: { name: string; installed?: boolean; attribution?: { name?: string } }[];
  }[];
}

export function describe(target: SpeechTarget): Promise<Described> {
  return exchange(
    { timeoutMs: 5000, ...target },
    [encodeEvent("describe")],
    (e) =>
      e.type === "info"
        ? {
            asr: (e.data.asr as Described["asr"]) ?? [],
            tts: (e.data.tts as Described["tts"]) ?? [],
          }
        : undefined,
    "The speech service",
  );
}

/** Speech to text: 16-bit mono PCM in, the transcript out. */
export function transcribe(target: SpeechTarget, pcm: Pcm, language = "en"): Promise<string> {
  const fmt = { rate: pcm.rate, width: pcm.width, channels: pcm.channels };
  const chunks: Buffer[] = [
    encodeEvent("transcribe", { language }),
    encodeEvent("audio-start", fmt),
  ];
  const step = 8192;
  for (let i = 0; i < pcm.audio.length; i += step)
    chunks.push(encodeEvent("audio-chunk", fmt, pcm.audio.subarray(i, i + step)));
  chunks.push(encodeEvent("audio-stop"));
  return exchange(
    target,
    chunks,
    (e) => (e.type === "transcript" ? String(e.data.text ?? "").trim() : undefined),
    "Speech recognition",
  );
}

/** Text to speech with a named voice. */
export function synthesize(target: SpeechTarget, text: string, voice: string): Promise<Pcm> {
  const out: Pcm = { audio: Buffer.alloc(0), rate: 22050, width: 2, channels: 1 };
  const parts: Buffer[] = [];
  return exchange(
    target,
    [encodeEvent("synthesize", { text, voice: { name: voice } })],
    (e) => {
      if (e.type === "audio-start") {
        out.rate = Number(e.data.rate) || out.rate;
        out.width = Number(e.data.width) || out.width;
        out.channels = Number(e.data.channels) || out.channels;
      } else if (e.type === "audio-chunk" && e.payload) parts.push(e.payload);
      else if (e.type === "audio-stop") return { ...out, audio: Buffer.concat(parts) };
      return undefined;
    },
    "Speech synthesis",
  );
}

/** A playable WAV file around raw PCM. */
export function wav(pcm: Pcm): Buffer {
  const h = Buffer.alloc(44);
  const byteRate = pcm.rate * pcm.channels * pcm.width;
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.audio.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(pcm.channels, 22);
  h.writeUInt32LE(pcm.rate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(pcm.channels * pcm.width, 32);
  h.writeUInt16LE(pcm.width * 8, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.audio.length, 40);
  return Buffer.concat([h, pcm.audio]);
}
