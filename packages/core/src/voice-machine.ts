/**
 * Can this machine run the five voices itself? Speaking (Piper) runs on any recent 64-bit
 * processor; listening (Whisper) needs more cores and memory, and is quicker with an NVIDIA
 * graphics card. A GPU is only needed to train new voices, never to use them.
 *
 * The same rules are used by `pnpm voices check` (what the installing AI agent tells the person)
 * and by the app (Settings > Voice and the welcome), so both always say the same thing. The
 * numbers are working targets from the owner's machines (2026-10-15), not lab measurements.
 */

export type VoiceLevel = "none" | "speak" | "full" | "best";

/** What the check reads from the machine. Unknown values count against nothing. */
export interface VoiceMachineFacts {
  /** "x64", "arm64", ... (Node's os.arch()). */
  arch: string;
  cores: number;
  /** Total memory, in bytes. */
  memoryBytes: number;
  /** Free space where the voices and speech programs would go, in bytes, if known. */
  freeDiskBytes?: number;
  /** NVIDIA graphics memory, in bytes, if an NVIDIA card was found. */
  nvidiaMemoryBytes?: number;
}

export interface VoiceMachine {
  level: VoiceLevel;
  /** One line for the person ("Full voice: Ember can talk and listen."). */
  summary: string;
  /** What was found, in plain words ("8 processor cores", "16 GB of memory"). */
  found: string[];
  /** Why it is not a level higher, in plain words; empty at "best". */
  short: string[];
}

const GB = 1024 ** 3;

/** The levels, lowest first, with what each one needs and gives. */
export const VOICE_LEVELS: { level: VoiceLevel; label: string; needs: string; gives: string }[] = [
  {
    level: "none",
    label: "No voice",
    needs: "under 4 GB of memory, or a 32-bit processor",
    gives: "Typing only.",
  },
  {
    level: "speak",
    label: "Speaking only",
    needs: "a 64-bit processor and 4 GB of memory",
    gives: "Your AI speaks; you type to it.",
  },
  {
    level: "full",
    label: "Full voice",
    needs: "4 or more processor cores, 8 GB of memory, and about 3 GB of free disk",
    gives: "Talk and listen, with a short pause while it listens.",
  },
  {
    level: "best",
    label: "Best",
    needs: "full voice plus an NVIDIA graphics card with 4 GB or more",
    gives: "Talk and listen, and listening feels instant.",
  },
];

const gb = (bytes: number) => `${Math.round(bytes / GB)} GB`;

/** Which level this machine reaches, what was found, and what holds it back. */
export function voiceLevel(m: VoiceMachineFacts, aiName = "Ember"): VoiceMachine {
  const found = [
    `${m.cores} processor ${m.cores === 1 ? "core" : "cores"}`,
    `${gb(m.memoryBytes)} of memory`,
  ];
  if (m.freeDiskBytes !== undefined) found.push(`${gb(m.freeDiskBytes)} of free disk`);
  if (m.nvidiaMemoryBytes) found.push(`an NVIDIA graphics card with ${gb(m.nvidiaMemoryBytes)}`);
  const is64 = m.arch === "x64" || m.arch === "arm64" || m.arch === "ppc64" || m.arch === "s390x";
  const short: string[] = [];

  // Memory is compared a little under the round number: "8 GB" machines report about 7.6.
  if (!is64 || m.memoryBytes < 3.5 * GB) {
    if (!is64) short.push("the processor is not 64-bit");
    if (m.memoryBytes < 3.5 * GB) short.push(`it has ${gb(m.memoryBytes)} of memory (needs 4 GB)`);
    return {
      level: "none",
      summary: `No voice on this machine: ${aiName} is typing only.`,
      found,
      short,
    };
  }
  if (m.cores < 4) short.push(`it has ${m.cores} processor cores (listening needs 4)`);
  if (m.memoryBytes < 7.5 * GB)
    short.push(`it has ${gb(m.memoryBytes)} of memory (listening needs 8 GB)`);
  if (m.freeDiskBytes !== undefined && m.freeDiskBytes < 3 * GB)
    short.push(`it has ${gb(m.freeDiskBytes)} of free disk (needs about 3 GB)`);
  if (short.length)
    return {
      level: "speak",
      summary: `Speaking only: ${aiName} can speak, and you type to it.`,
      found,
      short,
    };
  if (!m.nvidiaMemoryBytes || m.nvidiaMemoryBytes < 3.5 * GB) {
    short.push(
      m.nvidiaMemoryBytes
        ? `its NVIDIA card has ${gb(m.nvidiaMemoryBytes)} (instant listening needs 4 GB)`
        : "no NVIDIA graphics card (it would make listening instant)",
    );
    return {
      level: "full",
      summary: `Full voice: ${aiName} can talk and listen, with a short pause while it listens.`,
      found,
      short,
    };
  }
  return {
    level: "best",
    summary: `Best: ${aiName} can talk and listen, and listening feels instant.`,
    found,
    short,
  };
}

/** A speech service Hearth found by itself, confirmed by the speech protocol. */
export interface SpeechFound {
  host: string;
  /** The machine's name, when Hearth knows it. */
  name?: string;
  /** Listening (speech to text). */
  stt?: { port: number; model?: string };
  /** Speaking: how many voices it has, and how many of them are Hearth's own five. */
  tts?: { port: number; voices: number; hearthVoices: number };
}

/** Setting voice up from Hearth's own page: what this computer can do, and an install's progress. */
export interface VoiceSetupState {
  machine: VoiceMachine;
  /** Docker is available here, so Hearth can set voice up on this computer. */
  docker: boolean;
  install:
    | { status: "idle" }
    | { status: "running"; step: string; detail: string; startedAt: string }
    | { status: "done"; step: string; detail: string }
    | { status: "failed"; step: string; detail: string };
}
