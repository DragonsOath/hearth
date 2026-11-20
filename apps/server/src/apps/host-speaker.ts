import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { SpeakerUpstream } from "./speaker-relay";

/**
 * This computer as a speaker, by itself (11-05: users must not install anything; every
 * computer running Hearth plays music). Hearth joins Music Assistant as a Sendspin player
 * named after the computer and plays what it is sent through the computer's own sound: on
 * Linux PipeWire or PulseAudio (pw-cat, pacat) or ALSA (aplay), all part of a normal desktop;
 * on Windows the built-in sound API (winmm), driven by a short PowerShell program. Nothing to
 * install. Signed in with the Music Assistant key Hearth keeps, like the browser speaker.
 */

type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void };

/** The player's identity, kept so Music Assistant knows it as the same speaker after a restart. */
function fileStorage(file: string): Storage {
  let data: Record<string, string> = {};
  try {
    data = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    data = {};
  }
  return {
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
      } catch {
        // not kept: the speaker gets a new identity next time
      }
    },
  };
}

/** The program that plays raw 16-bit sound from stdin on this computer, or why there is none. */
export function soundOutput(
  rate: number,
  channels: number,
  platform = process.platform,
  has: (cmd: string) => boolean = (cmd) =>
    spawnSync(platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0,
): { cmd: string; args: string[] } | { none: string } {
  if (platform === "win32")
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(windowsPlayer(rate, channels), "utf16le").toString("base64"),
      ],
    };
  if (has("pw-cat"))
    return {
      cmd: "pw-cat",
      args: [
        "--playback",
        "--format=s16",
        `--rate=${rate}`,
        `--channels=${channels}`,
        "--media-role=Music",
        // A roomy device buffer: short hiccups (a busy computer, remote desktop) don't gap.
        "--latency=300ms",
        "-",
      ],
    };
  if (has("pacat"))
    return {
      cmd: "pacat",
      args: [
        "--raw",
        "--format=s16le",
        `--rate=${rate}`,
        `--channels=${channels}`,
        "--client-name=Hearth",
        "--stream-name=Music",
        "--latency-msec=300",
      ],
    };
  if (has("aplay"))
    return {
      cmd: "aplay",
      args: [
        "-q",
        "-t",
        "raw",
        "-f",
        "S16_LE",
        "-r",
        String(rate),
        "-c",
        String(channels),
        "--buffer-time=300000",
      ],
    };
  return {
    none: "This computer has no sound player Hearth can use (PipeWire, PulseAudio or ALSA).",
  };
}

/** Windows: plays stdin through winmm's waveOut, a tenth of a second at a time, eight queued. */
function windowsPlayer(rate: number, channels: number) {
  const cs = `
using System; using System.Runtime.InteropServices; using System.Threading;
public static class HearthPcm {
  [StructLayout(LayoutKind.Sequential)] struct Fmt { public ushort tag, ch; public uint rate, bps; public ushort align, bits, cb; }
  [StructLayout(LayoutKind.Sequential)] struct Hdr { public IntPtr data; public uint len, rec; public IntPtr user; public uint flags, loops; public IntPtr next, res; }
  [DllImport("winmm.dll")] static extern int waveOutOpen(out IntPtr h, int dev, ref Fmt f, IntPtr cb, IntPtr inst, int fl);
  [DllImport("winmm.dll")] static extern int waveOutPrepareHeader(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveOutUnprepareHeader(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveOutWrite(IntPtr h, IntPtr hdr, int size);
  // At the end: wait for what is queued to finish playing.
  static void Drain(IntPtr[] hdrs, int hs) { foreach (var hp in hdrs) while ((((Hdr)Marshal.PtrToStructure(hp, typeof(Hdr))).flags & 1) == 0) Thread.Sleep(10); }
  public static void Run(int rate, int ch) {
    var f = new Fmt { tag = 1, ch = (ushort)ch, rate = (uint)rate, bits = 16, align = (ushort)(ch * 2), bps = (uint)(rate * ch * 2) };
    IntPtr h; if (waveOutOpen(out h, -1, ref f, IntPtr.Zero, IntPtr.Zero, 0) != 0) Environment.Exit(3);
    var input = Console.OpenStandardInput(); int size = rate * ch * 2 / 10; const int N = 8;
    int hs = Marshal.SizeOf(typeof(Hdr)); var hdrs = new IntPtr[N]; var bufs = new IntPtr[N];
    for (int i = 0; i < N; i++) { bufs[i] = Marshal.AllocHGlobal(size); hdrs[i] = Marshal.AllocHGlobal(hs); Marshal.StructureToPtr(new Hdr { flags = 1 }, hdrs[i], false); }
    var tmp = new byte[size]; int k = 0;
    while (true) {
      int got = 0; while (got < size) { int n = input.Read(tmp, got, size - got); if (n <= 0) { if (got == 0) { Drain(hdrs, hs); return; } break; } got += n; }
      var hp = hdrs[k];
      while ((((Hdr)Marshal.PtrToStructure(hp, typeof(Hdr))).flags & 1) == 0) Thread.Sleep(5);
      waveOutUnprepareHeader(h, hp, hs);
      Marshal.Copy(tmp, 0, bufs[k], got);
      Marshal.StructureToPtr(new Hdr { data = bufs[k], len = (uint)got }, hp, false);
      waveOutPrepareHeader(h, hp, hs); waveOutWrite(h, hp, hs); k = (k + 1) % N;
    }
  }
}`;
  return `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${cs}\n'@; [HearthPcm]::Run(${Math.round(rate)}, ${Math.round(channels)})`;
}

/** Float samples per channel as interleaved 16-bit little-endian sound, at a volume. */
export function toS16(samples: Float32Array[], volume = 1): Buffer {
  const ch = samples.length;
  const n = samples[0]?.length ?? 0;
  const out = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, (samples[c]![i] ?? 0) * volume));
      out.writeInt16LE(Math.round(v * 32767), (i * ch + c) * 2);
    }
  return out;
}

export interface HostSpeakerStatus {
  on: boolean;
  name: string;
  state: "off" | "connecting" | "ready" | "playing" | "no-sound" | "not-linked" | "error";
  detail?: string;
}

type Core = {
  connect(): Promise<void>;
  disconnect(reason?: string): void;
  volume: number;
  muted?: boolean;
  onAudioData?: (c: { samples: Float32Array[]; sampleRate: number }) => void;
  onStreamStart?: (f: { sample_rate?: number; channels?: number }) => void;
  onStreamClear?: () => void;
  onStreamEnd?: () => void;
};
type CoreFactory = (opts: {
  webSocket: WebSocket;
  clientName: string;
  storage: Storage;
}) => Promise<Core>;

const defaultCore: CoreFactory = async (opts) => {
  // Loaded only when the speaker starts (a browser-first library whose core runs in Node; plain
  // PCM needs no browser decoder).
  const { SendspinCore } = (await import("@sendspin/sendspin-js")) as unknown as {
    SendspinCore: new (o: Record<string, unknown>) => Core;
  };
  // Music Assistant sends only a quarter second ahead by default; ask for two seconds, so the
  // sound is already here when a hiccup comes.
  return new SendspinCore({
    ...opts,
    productName: "Hearth",
    codecs: ["pcm"],
    requiredLeadTimeMs: 2000,
    minBufferMs: 1500,
  });
};

/**
 * Gives up after a while (11-06: stuck on "Connecting…"): a connection that never answers
 * is reported and tried again, instead of waiting forever.
 */
function within<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(why)), ms);
      t.unref?.();
    }),
  ]).finally(() => clearTimeout(t));
}

/** Node's own WebSocket (the browser's, which the library expects). */
const openSocket = (url: string) =>
  new (globalThis as unknown as { WebSocket: new (u: string) => WebSocket }).WebSocket(url);

/**
 * Keeps this computer connected as a speaker while it is on: reconnects with a growing pause
 * when Music Assistant restarts, and restarts the sound player when the stream's format changes
 * or is cleared (a skip or a seek), so what plays is never stale.
 */
export class HostSpeaker {
  private status: HostSpeakerStatus;
  private core?: Core;
  private ws?: WebSocket;
  private player?: ChildProcess;
  /** Sound held back until there is enough to start smoothly (11-06: "super choppy"). */
  private held: Buffer[] = [];
  private heldMs = 0;
  private format?: { rate: number; channels: number };
  private retry?: NodeJS.Timeout;
  private tries = 0;
  private wanted = false;

  constructor(
    private readonly deps: {
      dataDir: string;
      /** Without signIn, the connection is already signed in (Hearth's own speaker relay). */
      upstream: () => Promise<
        (Omit<SpeakerUpstream, "signIn"> & Partial<Pick<SpeakerUpstream, "signIn">>) | null
      >;
      core?: CoreFactory;
      output?: typeof soundOutput;
      spawnImpl?: typeof spawn;
      /** How much sound to hold before starting (default 800 ms). */
      prebufferMs?: number;
      open?: (url: string) => WebSocket;
    },
    name = `${hostname()} speakers`,
  ) {
    this.status = { on: false, name, state: "off" };
  }

  get(): HostSpeakerStatus {
    return { ...this.status };
  }

  /** Turns it on (or renames it) or off. */
  async set(on: boolean, name?: string) {
    if (name?.trim()) this.status.name = name.trim().slice(0, 60);
    this.stop();
    this.status.on = on;
    if (on) await this.start();
    else this.status.state = "off";
    return this.get();
  }

  private async start() {
    this.wanted = true;
    clearTimeout(this.retry);
    this.status.state = "connecting";
    const up = await within(this.deps.upstream(), 15_000, "").catch(() => null);
    if (!up) {
      this.status = {
        ...this.status,
        state: "not-linked",
        detail: "Link Music Assistant from Hearth first.",
      };
      return this.again(60_000);
    }
    const probe = (this.deps.output ?? soundOutput)(48_000, 2);
    if ("none" in probe) {
      this.status = { ...this.status, state: "no-sound", detail: probe.none };
      return;
    }
    const ws = (this.deps.open ?? openSocket)(up.url);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    const authed = new Promise<void>((resolve, reject) => {
      ws.addEventListener(
        "open",
        () => {
          if (!up.signIn) return resolve();
          up.signIn((token) => ws.send(JSON.stringify({ type: "auth", token }))).catch(reject);
        },
        { once: true },
      );
      // Music Assistant's sign-in reply comes first; the player takes over after it.
      ws.addEventListener(
        "message",
        (ev) => {
          try {
            if ((JSON.parse(String(ev.data)) as { type?: string }).type === "auth_ok")
              return resolve();
          } catch {
            // not the reply
          }
          reject(new Error("Music Assistant refused Hearth's key."));
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => reject(new Error("Music Assistant could not be reached.")),
        {
          once: true,
        },
      );
      ws.addEventListener(
        "close",
        () => reject(new Error("Music Assistant closed the connection.")),
        {
          once: true,
        },
      );
    });
    try {
      await within(authed, 15_000, "Music Assistant did not answer.");
    } catch (e) {
      this.status = {
        ...this.status,
        state: "error",
        detail: e instanceof Error ? e.message : String(e),
      };
      ws.close();
      return this.again();
    }
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.endPlayer();
      if (this.wanted) {
        this.status = {
          ...this.status,
          state: "connecting",
          detail: "Reconnecting to Music Assistant…",
        };
        this.again();
      }
    });
    const core = await (this.deps.core ?? defaultCore)({
      webSocket: ws,
      clientName: this.status.name,
      storage: fileStorage(path.join(this.deps.dataDir, "host-speaker.json")),
    });
    this.core = core;
    core.onStreamStart = (f) => {
      const rate = Number(f.sample_rate ?? 48_000);
      const channels = Number(f.channels ?? 2);
      if (!this.format || this.format.rate !== rate || this.format.channels !== channels) {
        this.endPlayer();
        this.format = { rate, channels };
      }
      this.status.state = "playing";
    };
    // A skip or a seek: what was waiting goes at once.
    core.onStreamClear = () => this.endPlayer();
    // The end of the music: what is already here still plays out.
    core.onStreamEnd = () => {
      this.flush();
      this.finishPlayer();
      this.status.state = "ready";
    };
    core.onAudioData = (chunk) => {
      const pcm = toS16(
        chunk.samples,
        core.muted ? 0 : Math.max(0, Math.min(1, core.volume / 100)),
      );
      const rate = chunk.sampleRate;
      const channels = chunk.samples.length;
      if (this.player && this.format?.rate === rate && this.format.channels === channels) {
        if (this.player.stdin?.writable) this.player.stdin.write(pcm);
        return;
      }
      // No player yet: hold the sound until there's enough to start without a gap.
      if (this.format && (this.format.rate !== rate || this.format.channels !== channels))
        this.endPlayer();
      this.format = { rate, channels };
      this.held.push(pcm);
      this.heldMs += ((chunk.samples[0]?.length ?? 0) / rate) * 1000;
      if (this.heldMs >= (this.deps.prebufferMs ?? 800)) this.flush();
    };
    try {
      await within(core.connect(), 20_000, "Music Assistant did not take the speaker.");
      this.tries = 0;
      this.status = { ...this.status, state: "ready", detail: undefined };
    } catch (e) {
      this.status = {
        ...this.status,
        state: "error",
        detail: e instanceof Error ? e.message : String(e),
      };
      // Closed as a failure, not a dropped line: the error stays shown until the next try.
      this.ws = undefined;
      this.core = undefined;
      ws.close();
      this.again();
    }
  }

  private playerFor(rate: number, channels: number) {
    if (this.player && this.format?.rate === rate && this.format.channels === channels)
      return this.player;
    this.endPlayer();
    const out = (this.deps.output ?? soundOutput)(rate, channels);
    if ("none" in out) {
      this.status = { ...this.status, state: "no-sound", detail: out.none };
      return undefined;
    }
    this.format = { rate, channels };
    const p = (this.deps.spawnImpl ?? spawn)(out.cmd, out.args, {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    p.on("error", () => {
      if (this.player === p) this.player = undefined;
    });
    p.on("exit", () => {
      if (this.player === p) this.player = undefined;
    });
    p.stdin?.on("error", () => undefined);
    this.player = p;
    return p;
  }

  /** Starts the player with everything held back. */
  private flush() {
    if (!this.held.length || !this.format) return;
    const held = Buffer.concat(this.held);
    this.held = [];
    this.heldMs = 0;
    const p = this.playerFor(this.format.rate, this.format.channels);
    if (p?.stdin?.writable) p.stdin.write(held);
  }

  /** Stops at once, dropping anything not yet heard. */
  private endPlayer() {
    this.held = [];
    this.heldMs = 0;
    const p = this.player;
    this.player = undefined;
    if (!p) return;
    p.stdin?.end();
    p.kill();
  }

  /** Lets the player finish what it has, then close by itself. */
  private finishPlayer() {
    const p = this.player;
    this.player = undefined;
    p?.stdin?.end();
  }

  private again(ms?: number) {
    if (!this.wanted) return;
    this.tries += 1;
    clearTimeout(this.retry);
    this.retry = setTimeout(
      () => void this.start().catch(() => undefined),
      ms ?? Math.min(60_000, 2000 * 2 ** Math.min(this.tries, 5)),
    );
    this.retry.unref?.();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retry);
    try {
      this.core?.disconnect("user_request");
    } catch {
      // already closed
    }
    this.core = undefined;
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    this.endPlayer();
  }
}
