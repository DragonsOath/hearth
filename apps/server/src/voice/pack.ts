import { fork, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STANDARD_VOICE, type BuiltinVoiceState } from "@dragon-control/core";
import type { Pcm } from "./wyoming";

/**
 * Standard voice: Hearth's own voice, with nothing for the owner to install. The first time it is
 * needed, Hearth downloads the voice pack into its data folder by itself (the exact, pinned
 * packages in apps/server/voice-pack, then the Kokoro and Whisper models from Hugging Face),
 * keeps only what this computer needs, checks it speaks, and from then on works offline.
 * Speaking and listening run in a helper process (runner.ts) that stops after a while idle.
 */
export interface VoicePackApi {
  state(): BuiltinVoiceState;
  /** Starts downloading the pack if it is not there yet (does nothing while it downloads). */
  install(): void;
  synthesize(text: string, voice: string): Promise<Pcm>;
  transcribe(pcm: Pcm): Promise<string>;
  close(): void;
}

/** About how much the pack downloads, once. */
export const VOICE_PACK_MB = 500;
const IDLE_MS = 10 * 60_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const first = (...candidates: string[]) => candidates.find((c) => existsSync(c));

/** npm, from the Node.js Hearth runs on (Hearth's installers bring their own). */
function npmCli(): string | undefined {
  const bin = path.dirname(process.execPath);
  return first(
    path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  );
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      // Its own cache, so it works for a service account without a home folder too.
      env: {
        ...process.env,
        npm_config_cache: path.join(cwd, ".npm-cache"),
        npm_config_update_notifier: "false",
      },
    });
    let err = "";
    child.stderr.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(err.trim().split("\n").at(-1) || `npm exited with ${code}`)),
    );
  });
}

/** Removes what this computer never uses: other systems' binaries, browser builds, maps, types. */
export async function prune(modules: string): Promise<void> {
  const napi = path.join(modules, "onnxruntime-node", "bin", "napi-v3");
  if (existsSync(napi))
    for (const os of await readdir(napi)) {
      if (os !== process.platform) {
        await rm(path.join(napi, os), { recursive: true, force: true });
        continue;
      }
      for (const arch of await readdir(path.join(napi, os)))
        if (arch !== process.arch)
          await rm(path.join(napi, os, arch), { recursive: true, force: true });
    }
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(map|wasm)$|\.d\.ts$/.test(e.name)) await rm(p, { force: true });
    }
  };
  for (const d of ["onnxruntime-web", "@huggingface/transformers/dist", "kokoro-js/dist"])
    if (existsSync(path.join(modules, d))) await walk(path.join(modules, d));
}

export class VoicePack implements VoicePackApi {
  private s: BuiltinVoiceState;
  private child?: ChildProcess;
  private nextId = 1;
  private waiting = new Map<
    number,
    {
      resolve: (m: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      progress?: (p: { file: string; loaded: number; total: number }) => void;
    }
  >();
  private idle?: NodeJS.Timeout;
  private readonly recipe: string;

  constructor(
    private readonly dir: string,
    opts: { recipe?: string; runner?: string } = {},
  ) {
    this.recipe =
      opts.recipe ??
      first(path.join(here, "..", "voice-pack"), path.join(here, "..", "..", "voice-pack")) ??
      path.join(here, "..", "voice-pack");
    this.runnerPath =
      opts.runner ?? first(path.join(here, "voice-runner.js"), path.join(here, "runner.ts"));
    this.s = { state: "missing", sizeMb: VOICE_PACK_MB };
    void this.check();
  }
  private readonly runnerPath?: string;

  /** The pack is ready when its marker matches this version of the recipe. */
  private async recipeHash(): Promise<string> {
    const h = createHash("sha256");
    h.update(await readFile(path.join(this.recipe, "package-lock.json")));
    return h.digest("hex").slice(0, 16);
  }

  private async check() {
    try {
      const marker = JSON.parse(await readFile(path.join(this.dir, "ready.json"), "utf8")) as {
        recipe?: string;
      };
      if (marker.recipe === (await this.recipeHash()) && this.s.state === "missing")
        this.s = { state: "ready", sizeMb: VOICE_PACK_MB };
    } catch {
      // Not downloaded yet.
    }
  }

  state(): BuiltinVoiceState {
    return { ...this.s, running: Boolean(this.child && this.child.exitCode === null) };
  }

  install(): void {
    if (this.s.state === "downloading" || this.s.state === "ready") return;
    void this.doInstall();
  }

  private step(step: string, percent: number) {
    this.s = { state: "downloading", step, percent: Math.round(percent), sizeMb: VOICE_PACK_MB };
  }

  private async doInstall() {
    try {
      this.step("Downloading the voice program", 1);
      this.close();
      await rm(this.dir, { recursive: true, force: true });
      await mkdir(this.dir, { recursive: true });
      for (const f of ["package.json", "package-lock.json"])
        await cp(path.join(this.recipe, f), path.join(this.dir, f));
      const cli = npmCli();
      const args = ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"];
      await (cli
        ? run(process.execPath, [cli, ...args], this.dir)
        : run(process.platform === "win32" ? "npm.cmd" : "npm", args, this.dir));
      this.step("Tidying up", 12);
      await rm(path.join(this.dir, ".npm-cache"), { recursive: true, force: true });
      await prune(path.join(this.dir, "node_modules"));
      this.step("Downloading the voices", 14);
      const files = new Map<string, { loaded: number; total: number }>();
      await this.ask({ op: "prepare" }, (p) => {
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0;
        for (const f of files.values()) loaded += f.loaded;
        // Most of the download is the two models (about 400 MB).
        this.step("Downloading the voices", 14 + Math.min(84, (loaded / (400 * 1024 * 1024)) * 84));
      });
      this.step("Checking it speaks", 99);
      await this.ask({ op: "speak", text: "Ready.", voice: STANDARD_VOICE });
      await writeFile(
        path.join(this.dir, "ready.json"),
        JSON.stringify({ recipe: await this.recipeHash(), at: new Date().toISOString() }),
      );
      this.s = { state: "ready", sizeMb: VOICE_PACK_MB };
    } catch (e) {
      this.close();
      this.s = {
        state: "failed",
        sizeMb: VOICE_PACK_MB,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private start(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child;
    if (!this.runnerPath) throw new Error("The voice helper is missing from this Hearth.");
    const child = fork(this.runnerPath, [], {
      env: { ...process.env, HEARTH_VOICE_PACK: this.dir },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    child.on("message", (raw) => {
      const m = raw as {
        id?: number;
        ok?: boolean;
        error?: string;
        progress?: { file: string; loaded: number; total: number };
      };
      const w = m.id ? this.waiting.get(m.id) : undefined;
      if (!w) return;
      if (m.progress) return w.progress?.(m.progress);
      this.waiting.delete(m.id!);
      if (m.ok) w.resolve(m as Record<string, unknown>);
      else w.reject(new Error(m.error ?? "The voice helper failed."));
    });
    child.on("exit", () => {
      for (const w of this.waiting.values()) w.reject(new Error("The voice helper stopped."));
      this.waiting.clear();
      if (this.child === child) this.child = undefined;
    });
    this.child = child;
    return child;
  }

  private ask(
    msg: Record<string, unknown>,
    progress?: (p: { file: string; loaded: number; total: number }) => void,
  ): Promise<Record<string, unknown>> {
    const child = this.start();
    clearTimeout(this.idle);
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, progress });
      child.send({ id, ...msg });
    }).finally(() => {
      clearTimeout(this.idle);
      // Idle a while: stop the helper, so its memory comes back.
      this.idle = setTimeout(() => this.close(), IDLE_MS);
      this.idle.unref();
    });
  }

  private ready() {
    if (this.s.state === "ready") return;
    this.install();
    const s = this.state();
    throw new Error(
      s.state === "downloading"
        ? `The voice is getting ready (${s.percent ?? 0}%). This happens once.`
        : `The voice is getting ready: about ${VOICE_PACK_MB} MB downloads once.`,
    );
  }

  async synthesize(text: string, voice: string): Promise<Pcm> {
    this.ready();
    const r = await this.ask({ op: "speak", text, voice });
    return {
      audio: Buffer.from(r.audio as Uint8Array),
      rate: r.rate as number,
      width: 2,
      channels: 1,
    };
  }

  async transcribe(pcm: Pcm): Promise<string> {
    this.ready();
    const r = await this.ask({ op: "hear", audio: pcm.audio, rate: pcm.rate });
    return String(r.text ?? "");
  }

  close(): void {
    clearTimeout(this.idle);
    this.child?.kill();
    this.child = undefined;
  }
}

/** A stand-in for tests and browser tests: gets ready in a moment and speaks a short tone. */
export class FakeVoicePack implements VoicePackApi {
  private s: BuiltinVoiceState = { state: "missing", sizeMb: VOICE_PACK_MB };
  private loaded = false;
  constructor(ready = false) {
    if (ready) this.s = { state: "ready", sizeMb: VOICE_PACK_MB };
  }
  state() {
    return { ...this.s, running: this.loaded };
  }
  install() {
    if (this.s.state !== "missing" && this.s.state !== "failed") return;
    this.s = {
      state: "downloading",
      step: "Downloading the voices",
      percent: 40,
      sizeMb: VOICE_PACK_MB,
    };
    setTimeout(() => (this.s = { state: "ready", sizeMb: VOICE_PACK_MB }), 600).unref();
  }
  async synthesize(_text: string, _voice: string): Promise<Pcm> {
    if (this.s.state !== "ready") {
      this.install();
      throw new Error("The voice is getting ready (40%). This happens once.");
    }
    this.loaded = true;
    const rate = 24000;
    const audio = Buffer.alloc(rate * 0.3 * 2);
    for (let i = 0; i < audio.length / 2; i++)
      audio.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), i * 2);
    return { audio, rate, width: 2, channels: 1 };
  }
  async transcribe(_pcm: Pcm): Promise<string> {
    this.loaded = true;
    return "hello from the built-in voice";
  }
  close() {
    this.loaded = false;
  }
}
