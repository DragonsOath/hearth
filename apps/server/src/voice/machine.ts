import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import type { VoiceMachineFacts } from "@dragon-control/core";

/**
 * What this machine has, for the voice check (voiceLevel): processor, memory, free disk where
 * Hearth keeps its data, and an NVIDIA card's memory if one is there. Read only; a part
 * that cannot be read is left out rather than guessed.
 */
export async function machineFacts(dir: string): Promise<VoiceMachineFacts> {
  const [disk, nvidia] = await Promise.all([freeDisk(dir), nvidiaMemory()]);
  return {
    arch: os.arch(),
    cores: os.availableParallelism(),
    memoryBytes: os.totalmem(),
    ...(disk !== undefined ? { freeDiskBytes: disk } : {}),
    ...(nvidia !== undefined ? { nvidiaMemoryBytes: nvidia } : {}),
  };
}

async function freeDisk(dir: string): Promise<number | undefined> {
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}

/** The largest NVIDIA card's memory in bytes, or nothing when there is no card or no driver. */
export function nvidiaMemory(): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(undefined);
        const mib = stdout
          .split(/\r?\n/)
          .map((l) => Number(l.trim()))
          .filter((n) => n > 0);
        resolve(mib.length ? Math.max(...mib) * 1024 * 1024 : undefined);
      },
    );
  });
}
