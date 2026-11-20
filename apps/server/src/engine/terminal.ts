import type { IPty } from "@lydell/node-pty";
import type { WebSocket } from "ws";
import { cleanEnv } from "./runners";

/**
 * Live terminals: the real interactive Claude Code (or Codex) program, one per project and engine,
 * running in the project's folder on a pseudo-terminal and shown in the War Room with xterm.js.
 * The program keeps running when the page closes; reopening reattaches and replays recent output.
 * It ends when the program exits (like /exit) or Hearth stops.
 */

type Pty = typeof import("@lydell/node-pty");
let pty: Pty | null | undefined;

/** The pseudo-terminal library, when this machine has its prebuilt part (null when it does not). */
export async function loadPty(): Promise<Pty | null> {
  if (pty === undefined) {
    try {
      pty = await import("@lydell/node-pty");
    } catch {
      pty = null;
    }
  }
  return pty;
}
export const ptyLoaded = () => Boolean(pty);

/** Bytes of recent output replayed to a page that reconnects. */
const KEEP = 512 * 1024;

export class Term {
  readonly clients = new Set<WebSocket>();
  /** Others following the output (Remote Control reads the screen) and the end. */
  readonly outputListeners: ((data: string) => void)[] = [];
  readonly exitListeners: ((code: number) => void)[] = [];
  private chunks: string[] = [];
  private size = 0;
  closed = false;

  constructor(
    readonly key: string,
    private readonly proc: IPty,
    onExit: (t: Term, code: number) => void,
  ) {
    proc.onData((d) => {
      this.chunks.push(d);
      this.size += d.length;
      while (this.size > KEEP && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
      for (const l of this.outputListeners) l(d);
      const data = Buffer.from(d, "utf8");
      for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(data);
    });
    proc.onExit(({ exitCode }) => {
      this.closed = true;
      onExit(this, exitCode);
      for (const l of this.exitListeners) l(exitCode);
    });
  }

  /** Recent output as text. */
  recent(chars = 20000): string {
    return this.chunks.join("").slice(-chars);
  }

  /** What was on screen before you reconnected. */
  replay(): Buffer | null {
    return this.chunks.length ? Buffer.from(this.chunks.join(""), "utf8") : null;
  }

  write(data: string) {
    if (!this.closed) this.proc.write(data);
  }

  resize(cols: number, rows: number) {
    if (this.closed) return;
    try {
      this.proc.resize(clamp(cols, 20, 500), clamp(rows, 5, 200));
    } catch {
      // The program is just exiting.
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.kill();
    } catch {
      // Already gone.
    }
  }
}

const clamp = (n: number, lo: number, hi: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo;

export class Terminals {
  private readonly terms = new Map<string, Term>();

  /** The running session for this key, or a new one. */
  async get(
    key: string,
    argv: string[],
    cwd: string,
    cols: number,
    rows: number,
    env: Record<string, string> = {},
  ): Promise<Term> {
    const existing = this.terms.get(key);
    if (existing && !existing.closed) return existing;
    const lib = await loadPty();
    if (!lib) throw new Error("The live terminal is not available on this computer.");
    let [file, ...args] = argv as [string, ...string[]];
    // A .cmd or .bat program on Windows runs through its command processor.
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
      args = ["/d", "/c", file, ...args];
      file = process.env.ComSpec ?? "cmd.exe";
    }
    const proc = lib.spawn(file, args, {
      name: "xterm-256color",
      cols: clamp(cols, 20, 500),
      rows: clamp(rows, 5, 200),
      cwd,
      env: { ...cleanEnv(), ...env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<
        string,
        string
      >,
    });
    const t = new Term(key, proc, (ended, code) => {
      for (const ws of ended.clients)
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "exit", code }));
      if (this.terms.get(key) === ended) this.terms.delete(key);
    });
    this.terms.set(key, t);
    return t;
  }

  /** Ends one session (the page's "start fresh"). */
  end(key: string) {
    this.terms.get(key)?.close();
    this.terms.delete(key);
  }

  stopAll() {
    for (const t of this.terms.values()) t.close();
    this.terms.clear();
  }
}
