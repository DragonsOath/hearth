import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { HostSpeaker, soundOutput, toS16 } from "./host-speaker";

// This computer as a speaker (11-05): Hearth joins Music Assistant with its key, plays what it
// is sent through the computer's own sound player, and starts that player afresh on a skip.

/** A stand-in browser-style socket: answers the sign-in, records what was sent. */
function fakeSocket(answer: "auth_ok" | "refused") {
  const sent: string[] = [];
  const listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  const ws = {
    readyState: 0,
    binaryType: "blob",
    send: (d: string) => {
      sent.push(d);
      if (d.includes('"auth"'))
        queueMicrotask(() =>
          fire("message", { data: answer === "auth_ok" ? '{"type": "auth_ok"}' : "nope" }),
        );
    },
    close: () => fire("close", {}),
    addEventListener: (t: string, fn: (ev: { data?: unknown }) => void) =>
      listeners.set(t, [...(listeners.get(t) ?? []), fn]),
  };
  const fire = (t: string, ev: { data?: unknown }) => {
    const fns = listeners.get(t) ?? [];
    listeners.set(t, []);
    for (const f of fns) f(ev);
  };
  queueMicrotask(() => {
    ws.readyState = 1;
    fire("open", {});
  });
  return { ws: ws as unknown as WebSocket, sent };
}

function fakePlayers() {
  const started: { cmd: string; args: string[]; bytes: Buffer[]; killed: boolean }[] = [];
  const spawnImpl = ((cmd: string, args: string[]) => {
    const rec = { cmd, args, bytes: [] as Buffer[], killed: false };
    started.push(rec);
    const p = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    Object.assign(p, {
      stdin: Object.assign(new EventEmitter(), {
        writable: true,
        write: (b: Buffer) => rec.bytes.push(b),
        end: () => undefined,
      }),
      kill: () => {
        rec.killed = true;
        return true;
      },
    });
    return p;
  }) as unknown as typeof import("node:child_process").spawn;
  return { started, spawnImpl };
}

const dataDir = () => mkdtempSync(path.join(tmpdir(), "hearth-spk-"));

describe("this computer as a speaker", () => {
  it("turns float sound into 16-bit, channels interleaved, at the volume", () => {
    const b = toS16([new Float32Array([1, -1]), new Float32Array([0.5, 0])], 1);
    expect([b.readInt16LE(0), b.readInt16LE(2), b.readInt16LE(4), b.readInt16LE(6)]).toEqual([
      32767, 16384, -32767, 0,
    ]);
    expect(toS16([new Float32Array([1])], 0.5).readInt16LE(0)).toBe(16384);
  });

  it("uses the computer's own sound player, and says when there is none", () => {
    const only = (name: string) => (cmd: string) => cmd === name;
    expect(soundOutput(48000, 2, "linux", only("pw-cat"))).toMatchObject({ cmd: "pw-cat" });
    expect(soundOutput(44100, 2, "linux", only("pacat"))).toMatchObject({
      cmd: "pacat",
      args: expect.arrayContaining(["--rate=44100", "--channels=2"]),
    });
    expect(soundOutput(48000, 1, "linux", only("aplay"))).toMatchObject({ cmd: "aplay" });
    expect(soundOutput(48000, 2, "linux", () => false)).toEqual({
      none: expect.stringMatching(/no sound player/),
    });
    expect(soundOutput(48000, 2, "win32")).toMatchObject({ cmd: "powershell.exe" });
  });

  it("signs in with the key, plays what it is sent, and starts the player afresh on a skip", async () => {
    let sock!: ReturnType<typeof fakeSocket>;
    const players = fakePlayers();
    let core!: {
      onAudioData?: (c: { samples: Float32Array[]; sampleRate: number }) => void;
      onStreamStart?: (f: { sample_rate?: number; channels?: number }) => void;
      onStreamClear?: () => void;
      volume: number;
    };
    const speaker = new HostSpeaker(
      {
        dataDir: dataDir(),
        upstream: async () => ({
          url: "ws://ma.test/sendspin",
          signIn: async (send) => send("ma-key"),
        }),
        open: () => (sock = fakeSocket("auth_ok")).ws,
        output: (rate, ch) => ({ cmd: "player", args: [String(rate), String(ch)] }),
        spawnImpl: players.spawnImpl,
        prebufferMs: 0,
        core: async (opts) => {
          expect(opts.clientName).toBe("Den speakers");
          core = {
            volume: 100,
            connect: async () => undefined,
            disconnect: () => undefined,
          } as never;
          return core as never;
        },
      },
      "Den speakers",
    );
    const st = await speaker.set(true);
    expect(st).toMatchObject({ on: true, state: "ready", name: "Den speakers" });
    expect(JSON.parse(sock.sent[0]!)).toEqual({ type: "auth", token: "ma-key" });

    core.onStreamStart!({ sample_rate: 48000, channels: 2 });
    core.onAudioData!({
      samples: [new Float32Array([0.5]), new Float32Array([-0.5])],
      sampleRate: 48000,
    });
    expect(players.started).toHaveLength(1);
    expect(players.started[0]!.args).toEqual(["48000", "2"]);
    expect(Buffer.concat(players.started[0]!.bytes)).toHaveLength(4);
    // A skip: what was buffered goes, a new player starts with the next sound.
    core.onStreamClear!();
    expect(players.started[0]!.killed).toBe(true);
    core.volume = 50;
    core.onAudioData!({
      samples: [new Float32Array([1]), new Float32Array([1])],
      sampleRate: 48000,
    });
    expect(players.started).toHaveLength(2);
    expect(players.started[1]!.bytes[0]!.readInt16LE(0)).toBe(16384);

    expect((await speaker.set(false)).state).toBe("off");
  });

  it("waits for Music Assistant to be linked, and says when its key is refused", async () => {
    const notLinked = new HostSpeaker({ dataDir: dataDir(), upstream: async () => null });
    expect((await notLinked.set(true)).state).toBe("not-linked");
    notLinked.stop();

    const refused = new HostSpeaker({
      dataDir: dataDir(),
      upstream: async () => ({ url: "ws://ma.test/sendspin", signIn: async (send) => send("bad") }),
      open: () => fakeSocket("refused").ws,
      output: () => ({ cmd: "player", args: [] }),
    });
    expect(await refused.set(true)).toMatchObject({ state: "error", detail: /refused/ });
    refused.stop();

    const silent = new HostSpeaker({
      dataDir: dataDir(),
      upstream: async () => ({ url: "ws://ma.test/sendspin", signIn: async () => undefined }),
      output: () => ({ none: "This computer has no sound player Hearth can use." }),
    });
    expect((await silent.set(true)).state).toBe("no-sound");
  });

  it("never hangs on Connecting: a Music Assistant that doesn't answer is reported", async () => {
    vi.useFakeTimers();
    try {
      const speaker = new HostSpeaker({
        dataDir: dataDir(),
        upstream: async () => ({ url: "ws://ma.test/sendspin", signIn: async (send) => send("k") }),
        open: () => fakeSocket("auth_ok").ws,
        output: () => ({ cmd: "player", args: [] }),
        core: async () =>
          ({
            volume: 100,
            connect: () => new Promise(() => undefined),
            disconnect: () => undefined,
          }) as never,
      });
      const on = speaker.set(true);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(await on).toMatchObject({ state: "error", detail: /did not take the speaker/ });
      speaker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("smooth playback", () => {
  it("holds sound until there's enough to start, and lets the end play out", async () => {
    const players = fakePlayers();
    let core!: {
      onAudioData?: (c: { samples: Float32Array[]; sampleRate: number }) => void;
      onStreamStart?: (f: { sample_rate?: number; channels?: number }) => void;
      onStreamEnd?: () => void;
      volume: number;
    };
    const speaker = new HostSpeaker({
      dataDir: dataDir(),
      upstream: async () => ({ url: "ws://ma.test/sendspin", signIn: async (send) => send("k") }),
      open: () => fakeSocket("auth_ok").ws,
      output: (rate, ch) => ({ cmd: "player", args: [String(rate), String(ch)] }),
      spawnImpl: players.spawnImpl,
      prebufferMs: 100,
      core: async () => {
        core = {
          volume: 100,
          connect: async () => undefined,
          disconnect: () => undefined,
        } as never;
        return core as never;
      },
    });
    await speaker.set(true);
    core.onStreamStart!({ sample_rate: 1000, channels: 1 });
    const ms = (n: number) => ({ samples: [new Float32Array(n)], sampleRate: 1000 });
    core.onAudioData!(ms(60));
    expect(players.started).toHaveLength(0);
    core.onAudioData!(ms(60));
    expect(players.started).toHaveLength(1);
    expect(Buffer.concat(players.started[0]!.bytes)).toHaveLength(240);
    core.onAudioData!(ms(10));
    expect(Buffer.concat(players.started[0]!.bytes)).toHaveLength(260);
    // A short song's end: what's held plays out, nothing is killed.
    core.onStreamEnd!();
    expect(players.started[0]!.killed).toBe(false);
    core.onStreamStart!({ sample_rate: 1000, channels: 1 });
    core.onAudioData!(ms(20));
    core.onStreamEnd!();
    expect(players.started).toHaveLength(2);
    expect(Buffer.concat(players.started[1]!.bytes)).toHaveLength(40);
    speaker.stop();
  });
});
