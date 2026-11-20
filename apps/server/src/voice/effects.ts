import { spawn } from "node:child_process";
import { VOICE_EFFECTS, type VoiceEffect } from "@dragon-control/core";

/** Runs one ffmpeg filter over a WAV file and returns the new WAV; swappable in tests. */
export type EffectRunner = (wav: Buffer, filter: string, rate: number) => Promise<Buffer>;

const TIMEOUT_MS = 20_000;

/** ffmpeg on this machine: WAV in on stdin, WAV out on stdout, nothing written to disk. */
export const ffmpegEffect: EffectRunner = (wav, filter, rate) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      // -ar keeps the voice's own sample rate: loudnorm would otherwise raise it to 192 kHz.
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "wav",
        "-i",
        "pipe:0",
        "-af",
        filter,
        "-ar",
        String(rate),
        "-f",
        "wav",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The voice effect took too long."));
    }, TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else reject(new Error(err.trim().slice(0, 300) || `ffmpeg exited with ${code}`));
    });
    child.stdin.on("error", () => {
      // ffmpeg can close its input early on a bad filter; the close handler reports why.
    });
    child.stdin.end(wav);
  });

/** The sample rate written in a WAV header (bytes 24 to 27). */
export function wavRate(wav: Buffer): number {
  return wav.length >= 28 ? wav.readUInt32LE(24) : 22050;
}

/**
 * The voice with its effect added, or the plain voice when the effect cannot run (no ffmpeg on
 * this machine, a filter it lacks): speaking without the effect beats not speaking at all.
 */
export async function withEffect(
  wav: Buffer,
  effect: VoiceEffect | undefined,
  run: EffectRunner = ffmpegEffect,
  onError?: (error: unknown) => void,
): Promise<Buffer> {
  if (!effect) return wav;
  try {
    return await run(wav, VOICE_EFFECTS[effect].filter, wavRate(wav));
  } catch (error) {
    onError?.(error);
    return wav;
  }
}
