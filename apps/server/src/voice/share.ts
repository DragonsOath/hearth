import net from "node:net";
import { STANDARD_VOICE } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import { recordAudit } from "../store/audit";
import { getSetting, setSetting } from "../store/settings";
import { encodeEvent, type Pcm } from "./wyoming";

/**
 * Hearth's Standard voice for Home Assistant (and anything else that speaks Wyoming, the protocol
 * Home Assistant uses for speech): Hearth answers "describe" with its voice and "synthesize" with
 * audio, like a Piper server. Off until the owner turns it on in Settings, Voice. It only speaks
 * the text it is sent; it never sees tools, records, or credentials.
 */

export const DEFAULT_SHARE_PORT = 10210;
/** Longest text spoken for one request (characters). */
const MAX_TEXT = 2000;
/** About a tenth of a second of 16-bit audio per chunk, as Wyoming servers usually send. */
const CHUNK_BYTES = 4800;

export interface ShareState {
  on: boolean;
  port: number;
  /** Listening right now (false while off, or when the port could not be opened). */
  listening: boolean;
  problem: string | null;
  voice: string;
}

/** One Wyoming event read from a socket: a JSON header line, then data and payload bytes. */
function reader(
  socket: net.Socket,
  onEvent: (type: string, data: Record<string, unknown>) => void,
) {
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      let header: {
        type?: string;
        data?: Record<string, unknown>;
        data_length?: number;
        payload_length?: number;
      };
      try {
        header = JSON.parse(buf.subarray(0, nl).toString("utf8"));
      } catch {
        socket.destroy();
        return;
      }
      const dl = header.data_length ?? 0;
      const pl = header.payload_length ?? 0;
      if (buf.length < nl + 1 + dl + pl) return;
      let data = header.data ?? {};
      if (dl) {
        try {
          data = { ...data, ...JSON.parse(buf.subarray(nl + 1, nl + 1 + dl).toString("utf8")) };
        } catch {
          data = header.data ?? {};
        }
      }
      buf = buf.subarray(nl + 1 + dl + pl);
      if (header.type) onEvent(header.type, data);
    }
  });
}

export function info(version: string) {
  const voice = {
    name: STANDARD_VOICE,
    description: "Hearth Standard voice",
    attribution: { name: "Kokoro", url: "https://huggingface.co/hexgrad/Kokoro-82M" },
    installed: true,
    version,
    languages: ["en-us"],
    speakers: null,
  };
  return {
    asr: [],
    tts: [
      {
        name: "hearth",
        description: "Hearth",
        attribution: { name: "Hearth", url: "https://github.com/DragonsOath" },
        installed: true,
        version,
        voices: [voice],
      },
    ],
    handle: [],
    intent: [],
    wake: [],
  };
}

/** A Wyoming text-to-speech server around `speak`. */
export function serveWyomingTts(o: {
  host: string;
  port: number;
  version: string;
  speak: (text: string) => Promise<Pcm>;
  onError?: (e: unknown) => void;
}): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.on("error", () => undefined);
    const send = (type: string, data: Record<string, unknown> = {}, payload?: Buffer) => {
      if (!socket.destroyed) socket.write(encodeEvent(type, data, payload));
    };
    reader(socket, (type, data) => {
      if (type === "describe") return send("info", info(o.version));
      if (type !== "synthesize") return;
      const text = String(data.text ?? "")
        .slice(0, MAX_TEXT)
        .trim();
      void (async () => {
        try {
          const pcm = text
            ? await o.speak(text)
            : { audio: Buffer.alloc(0), rate: 24000, width: 2, channels: 1 };
          const fmt = { rate: pcm.rate, width: pcm.width ?? 2, channels: pcm.channels ?? 1 };
          send("audio-start", fmt);
          for (let i = 0; i < pcm.audio.length; i += CHUNK_BYTES)
            send("audio-chunk", fmt, pcm.audio.subarray(i, i + CHUNK_BYTES));
          send("audio-stop");
        } catch (e) {
          o.onError?.(e);
          send("error", { text: e instanceof Error ? e.message : String(e) });
        }
      })();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/** The owner's switch, and the server it starts and stops. */
export class VoiceShare {
  private server: net.Server | null = null;
  private problem: string | null = null;

  constructor(
    private readonly handle: DbHandle,
    private readonly o: {
      port?: number;
      /** Where it listens: every address, so Home Assistant on this or another machine can reach it. */
      host?: string;
      version: string;
      speak: (text: string) => Promise<Pcm>;
    },
  ) {}

  private get port() {
    return this.o.port ?? DEFAULT_SHARE_PORT;
  }

  async state(): Promise<ShareState> {
    const saved = await getSetting(this.handle.db, "voice_share");
    const addr = this.server?.address();
    return {
      on: Boolean(saved?.on),
      // The port it really listens on (a test asks for any free one).
      port: addr && typeof addr === "object" ? addr.port : this.port,
      listening: Boolean(this.server?.listening),
      problem: this.problem,
      voice: STANDARD_VOICE,
    };
  }

  /** Starts it if the owner turned it on before (Hearth starting up). */
  async resume() {
    if ((await getSetting(this.handle.db, "voice_share"))?.on) await this.open();
  }

  async set(on: boolean): Promise<ShareState> {
    await setSetting(this.handle.db, "voice_share", { on });
    if (on) await this.open();
    else await this.close();
    await recordAudit(this.handle.db, {
      actor: "you",
      action: on ? "voice.share.on" : "voice.share.off",
      target: `Hearth's voice for Home Assistant (port ${this.port})`,
    });
    return this.state();
  }

  private async open() {
    if (this.server?.listening) return;
    try {
      this.server = await serveWyomingTts({
        host: this.o.host ?? "0.0.0.0",
        port: this.port,
        version: this.o.version,
        speak: this.o.speak,
      });
      this.problem = null;
    } catch (e) {
      this.server = null;
      this.problem =
        (e as NodeJS.ErrnoException).code === "EADDRINUSE"
          ? `Port ${this.port} is already used by another program on this computer.`
          : e instanceof Error
            ? e.message
            : String(e);
    }
  }

  async close() {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}
