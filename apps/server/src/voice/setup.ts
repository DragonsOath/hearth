import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { voiceLevel, VOICE_LEVELS, type VoiceMachine } from "@dragon-control/core";
import { machineFacts } from "./machine";

/**
 * Setting up the five voices on this machine, for `pnpm voices` (the installing AI agent runs
 * it, after the person approved each piece): check what the machine can do, download the voice
 * files from the GitHub release and check each one, and start the speech programs in Docker.
 * Every step has a dry run that changes nothing, and none of it touches Hearth's own
 * install: a failure here only means no voice yet.
 */

export interface VoiceFile {
  name: string;
  bytes: number;
  sha256: string;
}
export interface VoiceManifest {
  repo: string;
  release: string;
  voices: { id: string; label: string; voice: string }[];
  files: VoiceFile[];
}

/** Runs a program and says how it went; tests pass a stand-in. */
export type Runner = (
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; cwd?: string },
) => Promise<{ code: number; out: string }>;

export const runProgram: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (e) => resolve({ code: 127, out: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });

export interface SetupDeps {
  run: Runner;
  fetch: typeof fetch;
  /** Where deploy/speech lives (the repository's own folder). */
  speechDir: string;
}

export function loadManifest(speechDir: string): VoiceManifest {
  return JSON.parse(readFileSync(path.join(speechDir, "voices.json"), "utf8")) as VoiceManifest;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Whether a voice file is there and exactly the one in the manifest. */
export async function fileReady(dir: string, f: VoiceFile): Promise<boolean> {
  const p = path.join(dir, f.name);
  try {
    if ((await stat(p)).size !== f.bytes) return false;
  } catch {
    return false;
  }
  return (await sha256(p)) === f.sha256;
}

export interface CheckReport {
  machine: VoiceMachine;
  tools: { docker: boolean; compose: boolean; ffmpeg: boolean; gh: boolean };
  voicesReady: boolean;
}

/** What this machine can do for voice, and what it already has. Changes nothing. */
export async function checkVoice(
  deps: SetupDeps,
  dir: string,
  dataDir: string,
): Promise<CheckReport> {
  const ok = async (cmd: string, args: string[]) => (await deps.run(cmd, args)).code === 0;
  const [docker, compose, ffmpeg, gh] = await Promise.all([
    ok("docker", ["version", "--format", "{{.Server.Version}}"]),
    ok("docker", ["compose", "version"]),
    ok("ffmpeg", ["-version"]),
    ok("gh", ["--version"]),
  ]);
  const manifest = loadManifest(deps.speechDir);
  const ready = await Promise.all(manifest.files.map((f) => fileReady(dir, f)));
  return {
    machine: voiceLevel(await machineFacts(dataDir)),
    tools: { docker, compose, ffmpeg, gh },
    voicesReady: ready.every(Boolean),
  };
}

/** The check in plain words, for the person (the AI agent reads it out). */
export function checkText(r: CheckReport): string[] {
  const level = VOICE_LEVELS.find((l) => l.level === r.machine.level)!;
  const lines = [
    r.machine.summary,
    `Found: ${r.machine.found.join(", ")}.`,
    ...(r.machine.short.length ? [`Not higher because ${r.machine.short.join("; ")}.`] : []),
    `This level needs ${level.needs}.`,
    "",
    "What voice needs on this machine:",
    `- Docker (runs the speech programs in their own containers): ${r.tools.docker ? "installed" : "not installed"}${r.tools.docker && !r.tools.compose ? ", but Docker Compose is missing" : ""}`,
    `- The five voices (about 320 MB): ${r.voicesReady ? "downloaded and checked" : "not downloaded yet"}`,
    `- ffmpeg (only for the Companion's voice box): ${r.tools.ffmpeg ? "installed" : "not installed; the Companion speaks plainly without it"}`,
  ];
  return lines;
}

/**
 * Downloads the voice files into `dir` and checks each against the manifest. A file already
 * there and correct is kept. A public release is fetched directly; while the repository is
 * private, the GitHub CLI (signed in) fetches it instead.
 */
export async function downloadVoices(
  deps: SetupDeps,
  dir: string,
  opts: { dryRun?: boolean; say: (line: string) => void },
): Promise<boolean> {
  const m = loadManifest(deps.speechDir);
  const total = m.files.reduce((n, f) => n + f.bytes, 0);
  if (opts.dryRun) {
    opts.say(`Would download ${m.files.length} files (${Math.round(total / 1e6)} MB) into ${dir}:`);
    for (const f of m.files)
      opts.say(`  https://github.com/${m.repo}/releases/download/${m.release}/${f.name}`);
    opts.say("Each file is checked against its SHA-256 in deploy/speech/voices.json.");
    return true;
  }
  await mkdir(dir, { recursive: true });
  let ok = true;
  for (const f of m.files) {
    if (await fileReady(dir, f)) {
      opts.say(`${f.name}: already there and checked`);
      continue;
    }
    const target = path.join(dir, f.name);
    const partial = `${target}.part`;
    await rm(partial, { force: true });
    let got = false;
    const url = `https://github.com/${m.repo}/releases/download/${m.release}/${f.name}`;
    try {
      const res = await deps.fetch(url, { redirect: "follow" });
      if (res.ok) {
        await writeFile(partial, Buffer.from(await res.arrayBuffer()));
        got = true;
      }
    } catch {
      // Offline or blocked: the GitHub CLI below may still get it.
    }
    if (!got) {
      const r = await deps.run("gh", [
        "release",
        "download",
        m.release,
        "-R",
        m.repo,
        "-p",
        f.name,
        "-O",
        partial,
        "--clobber",
      ]);
      got = r.code === 0 && existsSync(partial);
    }
    if (!got) {
      opts.say(
        `${f.name}: could not be downloaded. Check this machine can reach github.com and try again.`,
      );
      ok = false;
      continue;
    }
    if ((await sha256(partial)) !== f.sha256) {
      await rm(partial, { force: true });
      opts.say(`${f.name}: downloaded, but its checksum does not match, so it was deleted.`);
      ok = false;
      continue;
    }
    await rename(partial, target);
    opts.say(`${f.name}: downloaded and checked`);
  }
  return ok;
}

/** The Docker command that starts the speech programs (shown first in a dry run). */
export function startCommand(speechDir: string, gpu: boolean): string[] {
  return [
    "compose",
    "-p",
    "dragon-control-speech",
    "-f",
    path.join(speechDir, "compose.yml"),
    ...(gpu ? ["-f", path.join(speechDir, "compose.gpu.yml")] : []),
    "up",
    "-d",
  ];
}

/** Starts Piper (with the five voices) and Whisper in Docker on this machine. */
export async function startSpeech(
  deps: SetupDeps,
  dir: string,
  opts: { gpu?: boolean; dryRun?: boolean; say: (line: string) => void },
): Promise<boolean> {
  const args = startCommand(deps.speechDir, Boolean(opts.gpu));
  if (opts.dryRun) {
    opts.say(`Would run: DC_VOICES_DIR="${dir}" docker ${args.join(" ")}`);
    opts.say("Then point Hearth's voice at this machine (ports 10200 and 10300).");
    return true;
  }
  const m = loadManifest(deps.speechDir);
  const ready = await Promise.all(m.files.map((f) => fileReady(dir, f)));
  if (!ready.every(Boolean)) {
    opts.say("The voices are not all downloaded and checked yet: run pnpm voices download first.");
    return false;
  }
  const r = await deps.run("docker", args, { env: { DC_VOICES_DIR: dir } });
  if (r.code !== 0) {
    opts.say(`Docker could not start the speech programs: ${r.out.trim().slice(-400)}`);
    return false;
  }
  opts.say("The speech programs are running: Piper on port 10200, Whisper on port 10300.");
  return true;
}
