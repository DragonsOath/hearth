import net from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import {
  DEFAULT_STT_PORT,
  DEFAULT_TTS_PORT,
  voiceLevel,
  type SpeechFound,
  type VoiceSetupState,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { recordAudit } from "../store/audit";
import { InvalidRequestError } from "../store/errors";
import { machineFacts } from "./machine";
import type { SpeechClient, Voice } from "./service";
import { downloadVoices, loadManifest, runProgram, startSpeech, type SetupDeps } from "./setup";

/**
 * Voice set up from Hearth's own pages, for someone who has never heard of Piper or Whisper:
 *
 * - find: Hearth looks for speech services itself (this computer, the machines it knows, and the
 *   home network around it), and confirms each with the speech protocol's own "describe", so only
 *   real speech services are offered. One click uses one.
 * - install: when there is none, one click sets voice up on this computer: the five voices are
 *   downloaded and checked, the speech programs start in Docker, Hearth waits until they answer,
 *   then points voice at them. Progress is shown step by step; a failure says what to do.
 */

export interface AssistDeps {
  /** Addresses to try (this machine, known machines, the home network). Tests pass a fixed list. */
  candidates?: () => Promise<{ host: string; name?: string }[]>;
  /** Installs on this machine; tests pass a stand-in. */
  install?: (say: (step: string, detail: string) => void) => Promise<{ host: string }>;
  setup?: SetupDeps;
  dataDir: string;
}

/** Whether something listens on host:port (a short TCP connect). */
function open(host: string, port: number, ms = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** The home networks this machine is on (private IPv4, not Docker's own bridges), as /24 ranges. */
export function homeRanges(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const out = new Set<string>();
  for (const [name, list] of Object.entries(ifaces)) {
    if (/^(docker|br-|veth|virbr|tailscale|zt|lo)/i.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      out.add(a.address.split(".").slice(0, 3).join("."));
    }
  }
  return [...out];
}

export class VoiceAssist {
  private task: VoiceSetupState["install"] = { status: "idle" };

  constructor(
    private readonly handle: DbHandle,
    private readonly voice: Voice,
    private readonly client: SpeechClient,
    private readonly deps: AssistDeps,
  ) {}

  /** This machine, every machine Hearth knows, and the home network around this machine. */
  private async candidates(): Promise<{ host: string; name?: string }[]> {
    if (this.deps.candidates) return this.deps.candidates();
    const hosts = await this.handle.db
      .select({ name: t.hosts.name, address: t.hosts.address, connection: t.hosts.connection })
      .from(t.hosts);
    const named = new Map<string, string>();
    for (const h of hosts)
      if (h.connection !== "this-machine" && /^[\d.]+$/.test(h.address))
        named.set(h.address, h.name);
    const list: { host: string; name?: string }[] = [{ host: "127.0.0.1", name: "This computer" }];
    for (const [address, name] of named) list.push({ host: address, name });
    for (const range of homeRanges())
      for (let i = 1; i < 255; i++) {
        const host = `${range}.${i}`;
        if (!named.has(host)) list.push({ host });
      }
    return list;
  }

  /**
   * Speech services Hearth can use, each confirmed by the protocol itself. Ports are checked
   * quickly first (a few seconds for a whole home network), then each open one is asked to
   * describe itself.
   */
  async find(): Promise<SpeechFound[]> {
    const all = await this.candidates();
    const manifest = this.deps.setup ? loadManifest(this.deps.setup.speechDir) : undefined;
    const ours = new Set(manifest?.voices.map((v) => v.voice) ?? []);
    const found: SpeechFound[] = [];
    // Limited parallelism: a home network is at most a few hundred quick connections.
    const queue = [...all];
    const work = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const [stt, tts] = await Promise.all([
          this.deps.candidates ? Promise.resolve(true) : open(c.host, DEFAULT_STT_PORT),
          this.deps.candidates ? Promise.resolve(true) : open(c.host, DEFAULT_TTS_PORT),
        ]);
        if (!stt && !tts) continue;
        const ask = (port: number) =>
          this.client.describe({ host: c.host, port, timeoutMs: 3000 }).catch(() => undefined);
        const [s, v] = await Promise.all([
          stt ? ask(DEFAULT_STT_PORT) : undefined,
          tts ? ask(DEFAULT_TTS_PORT) : undefined,
        ]);
        const listening = s?.asr[0];
        const speaking = v?.tts[0];
        if (!listening && !speaking) continue;
        const voices = (speaking?.voices ?? []).map((x) => x.name);
        found.push({
          host: c.host,
          ...(c.name ? { name: c.name } : {}),
          ...(listening
            ? {
                stt: {
                  port: DEFAULT_STT_PORT,
                  model: listening.models.find((m) => m.installed !== false)?.name,
                },
              }
            : {}),
          ...(speaking
            ? {
                tts: {
                  port: DEFAULT_TTS_PORT,
                  voices: voices.length,
                  hearthVoices: voices.filter((n) => ours.has(n)).length,
                },
              }
            : {}),
        });
      }
    };
    await Promise.all(Array.from({ length: 48 }, work));
    // Best first: both halves, then the most of Hearth's voices, then this computer.
    return found.sort(
      (a, b) =>
        Number(Boolean(b.stt && b.tts)) - Number(Boolean(a.stt && a.tts)) ||
        (b.tts?.hearthVoices ?? 0) - (a.tts?.hearthVoices ?? 0) ||
        Number(b.host === "127.0.0.1") - Number(a.host === "127.0.0.1"),
    );
  }

  /** Uses a speech service Hearth found (checked again first), keeping the voice profiles. */
  async use(host: string): Promise<void> {
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host))
      throw new InvalidRequestError("Not a usable address.");
    const ok = await this.client
      .describe({ host, port: DEFAULT_TTS_PORT, timeoutMs: 4000 })
      .then(() => true)
      .catch(() =>
        this.client
          .describe({ host, port: DEFAULT_STT_PORT, timeoutMs: 4000 })
          .then(() => true)
          .catch(() => false),
      );
    if (!ok) throw new InvalidRequestError(`No speech service answers at ${host} any more.`);
    const c = await this.voice.config();
    await this.voice.save({ ...c, host, sttPort: DEFAULT_STT_PORT, ttsPort: DEFAULT_TTS_PORT });
  }

  /** What setup can say right now: this computer's level, and an install in progress. */
  async state(): Promise<VoiceSetupState> {
    const machine = voiceLevel(await machineFacts(this.deps.dataDir));
    const docker = this.deps.install
      ? true
      : this.deps.setup
        ? (await this.deps.setup.run("docker", ["compose", "version"])).code === 0
        : false;
    return { machine, docker, install: this.task };
  }

  /**
   * Sets voice up on this computer, in the background (the page follows its progress). The
   * owner pressed the button after seeing what it downloads and starts.
   */
  async install(): Promise<VoiceSetupState["install"]> {
    if (this.task.status === "running") return this.task;
    const s = await this.state();
    if (s.machine.level === "none")
      throw new InvalidRequestError(
        `This computer can't run voice: ${s.machine.short.join("; ") || s.machine.summary}`,
      );
    if (!s.docker)
      throw new InvalidRequestError(
        "Voice runs its speech programs in Docker, which isn't on this computer. Choose a speech service on another computer instead.",
      );
    this.task = {
      status: "running",
      step: "Starting",
      detail: "",
      startedAt: new Date().toISOString(),
    };
    await recordAudit(this.handle.db, {
      actor: "you",
      action: "Started setting up voice on this computer",
      target: "voice",
    });
    const say = (step: string, detail: string) => {
      if (this.task.status === "running") this.task = { ...this.task, step, detail };
    };
    void (this.deps.install ?? ((s2) => this.installHere(s2)))(say).then(
      async ({ host }) => {
        await this.use(host);
        this.task = {
          status: "done",
          step: "Voice is ready",
          detail: `Speech runs on ${host === "127.0.0.1" ? "this computer" : host}.`,
        };
        await recordAudit(this.handle.db, {
          actor: "you",
          action: "Set up voice on this computer",
          target: "voice",
        });
      },
      (error: unknown) => {
        this.task = {
          status: "failed",
          step: this.task.status === "running" ? this.task.step : "Setting up voice",
          detail: error instanceof Error ? error.message : String(error),
        };
      },
    );
    return this.task;
  }

  /** The real install: the existing voices download and Docker start, then waiting for answers. */
  private async installHere(
    say: (step: string, detail: string) => void,
  ): Promise<{ host: string }> {
    const setup = this.deps.setup!;
    const dir = path.join(this.deps.dataDir, "voices");
    const lines: string[] = [];
    say("Downloading the voices", "About 320 MB, each file checked against its fingerprint.");
    const got = await downloadVoices(setup, dir, {
      say: (l) => {
        lines.push(l);
        say("Downloading the voices", l);
      },
    });
    if (!got)
      throw new Error(
        `The voices could not all be downloaded: ${lines.filter((l) => /could not|does not match/.test(l)).join(" ") || "no details"}. Check this computer's internet connection, then try again.`,
      );
    say("Starting the speech programs", "Piper (speaking) and Whisper (listening), in Docker.");
    const started = await startSpeech(setup, dir, { say: (l) => lines.push(l) });
    if (!started)
      throw new Error(
        `Docker could not start the speech programs. ${lines.at(-1) ?? ""} If something else already uses ports 10200 or 10300, stop it or use that speech service instead.`,
      );
    // Whisper downloads its listening model on first start; that can take a few minutes.
    const until = Date.now() + 12 * 60_000;
    for (;;) {
      const [tts, stt] = await Promise.all([
        this.client.describe({ host: "127.0.0.1", port: DEFAULT_TTS_PORT, timeoutMs: 3000 }).then(
          () => true,
          () => false,
        ),
        this.client.describe({ host: "127.0.0.1", port: DEFAULT_STT_PORT, timeoutMs: 3000 }).then(
          () => true,
          () => false,
        ),
      ]);
      if (tts && stt) return { host: "127.0.0.1" };
      if (Date.now() > until)
        throw new Error(
          `The speech programs started but ${tts ? "listening" : "speaking"} did not answer within 12 minutes. Try again; the downloads are kept.`,
        );
      say(
        "Waiting for the speech programs",
        tts
          ? "Speaking is ready. Listening is getting its speech model ready (first time only, a few minutes)."
          : "They are starting.",
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function realSetupDeps(serverRoot: string): SetupDeps {
  return {
    run: runProgram,
    fetch: globalThis.fetch,
    speechDir: path.join(serverRoot, "../../deploy/speech"),
  };
}
