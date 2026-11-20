import { randomUUID } from "node:crypto";
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import xtermHeadless from "@xterm/headless";
import { hearthGuideFile, SYSTEM_NOTE } from "./runners";
import type { Term, Terminals } from "./terminal";

/**
 * Remote Control (/rc), ported from EMBER: the project's Claude Code conversation, opened as a live
 * interactive session that also shows up in the Claude app (phone) and at claude.ai/code.
 *
 * While it runs, War Room messages are typed into that same session, and everything said in it,
 * from the War Room or from the phone, is mirrored back into the War Room by following the
 * session's transcript file. Claude Code's permission prompts become cards you can answer from
 * either side. /rc again (or /rc stop) ends it; the next message continues the same conversation as before.
 */

const { Terminal: Screen } = xtermHeadless as unknown as {
  Terminal: typeof import("@xterm/headless").Terminal;
};

// Terminal escape codes, removed to read the screen as text.
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;
const URL_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/;
const OPTION = /^\s*(?:❯\s*)?(\d)\.\s+(.+?)\s*$/;
const RULE = /^\s*[─╌━-]{8,}\s*$/;
const BOX_TOP = /^\s*[─━]{8,}\s*$/;
const COLS = 120;
const ROWS = 40;

export const norm = (s: string) => s.replace(/\s+/g, " ").trim();
export const screenText = (raw: string) => raw.replace(ANSI, "");

/** Where Claude Code keeps a folder's conversation transcripts. */
export function transcriptDir(cwd: string, root = path.join(homedir(), ".claude", "projects")) {
  return path.join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

export interface Prompt {
  title: string;
  details: string[];
  question: string;
  options: { key: string; label: string }[];
  /** A menu that waits for Enter after the number (Claude Code's one-time warnings). */
  enter?: boolean;
}

/**
 * Claude Code's one-time warning the first time it runs in Bypass Permissions mode (Full access
 * on). It is an agreement, so it goes to the owner as a question; Hearth never accepts it for
 * them. Claude Code remembers the answer, so it shows once per computer (11-04).
 */
export function findBypassWarning(lines: string[]): Prompt | null {
  const flat = lines.join(" ").replace(/\s+/g, "");
  if (!/BypassPermissionsmode/i.test(flat) || !/Yes,Iaccept/i.test(flat)) return null;
  return {
    title: "Claude Code's one-time warning for Full access (Bypass Permissions mode)",
    details: [
      "With Full access on, Claude Code runs commands without asking first.",
      "Claude Code asks you to accept responsibility for what it does in this mode. It asks once on this computer.",
      "Turn Full access off instead if you'd rather approve each step.",
    ],
    question: "Accept Bypass Permissions mode?",
    options: [
      { key: "1", label: "No, exit" },
      { key: "2", label: "Yes, I accept" },
    ],
    enter: true,
  };
}

/** Which option of a menu is highlighted (its line has ❯); the first when none shows. */
export function highlighted(lines: string[], options: Prompt["options"]): number {
  const squash = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  for (const line of lines) {
    if (!line.includes("❯")) continue;
    const at = options.findIndex((o) => squash(line).includes(squash(o.label)));
    if (at >= 0) return at;
  }
  return 0;
}

/** Claude Code's "Do you want to ...?" choice box, if one is on screen. */
export function findPrompt(lines: string[]): Prompt | null {
  let q = -1;
  for (let i = lines.length - 1; i >= 0; i--)
    if (/^\s*Do you want to .+\?\s*$/.test(lines[i]!)) {
      q = i;
      break;
    }
  if (q < 0) return null;
  const options: Prompt["options"] = [];
  for (const line of lines.slice(q + 1, q + 10)) {
    const m = OPTION.exec(line);
    const t = line.trim();
    if (m) options.push({ key: m[1]!, label: norm(m[2]!).split(" · ")[0]! });
    else if (options.length && t && !t.startsWith("Esc") && !t.startsWith("Tab"))
      options[options.length - 1]!.label += " " + t;
    else if (options.length && !t) break;
  }
  if (!options.length) return null;
  let top = q - 1;
  while (top > 0 && q - top < 30 && !BOX_TOP.test(lines[top - 1]!)) top--;
  const body = lines
    .slice(top, q)
    .map((l) => l.trim())
    .filter((l) => l && !RULE.test(l) && !l.startsWith("Tip:"));
  return {
    title: body[0] ?? "Permission needed",
    details: body.slice(1, 12),
    question: lines[q]!.trim(),
    options,
  };
}

/**
 * How a Remote Control session is listed in the Claude app (11-04): Hearth, the PC, the zone,
 * then the conversation. "Hearth • Homeserver • Lair • Main", "Hearth • Homeserver • War Room • Garden".
 */
export const remoteTitle = (pc: string, zone: "Lair" | "War Room", name: string) =>
  ["Hearth", pc, zone, name].map((x) => x.replace(/\s+/g, " ").trim()).join(" • ");

/** What Remote Control needs from the engine. */
export interface RemoteHub {
  message(project: string, role: "you" | "ember" | "sys", text: string, meta: string): void;
  ask(project: string, prompt: Prompt): number;
  askClosed(id: number, answered: string): void;
  changed(): void;
  saveSession(project: string, sid: string): void;
  active(project: string, on: boolean): void;
  ended(project: string): void;
}

interface TranscriptLine {
  type?: string;
  uuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { content?: unknown; stop_reason?: string };
}

/** Hearth's guide for a Remote Control session: the same file the War Room's runs get. */
export function remoteGuideArgs(guide = hearthGuideFile()): string[] {
  return guide ? ["--append-system-prompt-file", guide] : [];
}

/** One Remote Control session for one project. */
export class Remote {
  url: string | null = null;
  askId: number | null = null;
  askChoice: string | null = null;
  readonly started = Date.now();
  private readonly sent: string[] = [];
  private readonly seen = new Set<string>();
  private readonly screen = new Screen({ cols: COLS, rows: ROWS, allowProposedApi: true });
  private readonly timers: NodeJS.Timeout[] = [];
  private file: string;
  private pos: number;

  private constructor(
    readonly slug: string,
    readonly name: string,
    /** How the session is listed in the Claude app ("Hearth • Homeserver • Lair • Main"). */
    readonly title: string,
    readonly cwd: string,
    public sid: string,
    private readonly term: Term,
    private readonly hub: RemoteHub,
    private readonly transcripts?: string,
  ) {
    term.outputListeners.push((d) => this.screen.write(d));
    term.exitListeners.push(() => this.exited());
    this.file = path.join(transcriptDir(cwd, transcripts), `${sid}.jsonl`);
    this.pos = existsSync(this.file) ? statSync(this.file).size : 0;
    this.watchScreen();
    this.timers.push(setInterval(() => this.tail(), 1000));
    this.watchPrompts();
  }

  static async start(
    o: {
      slug: string;
      name: string;
      /** How the Claude app lists it; "Hearth · <name>" when not given. */
      title?: string;
      cwd: string;
      sid: string | null;
      binary: string;
      allowedTools: string[];
      /** Instructions added to Claude Code's own (the War Room's note when not given). */
      note?: string;
      /** More of Claude Code's arguments (Hearth's tools, a system prompt file). */
      extra?: string[];
      /**
       * Hearth's guide as its own instructions file (the default). Off when `extra` brings one
       * file that already holds it: Claude Code is given one instructions file, never two.
       */
      guide?: boolean;
      /** "bypassPermissions" with Full access on; edits accepted otherwise. */
      permissionMode?: "acceptEdits" | "bypassPermissions";
      /** For tests: arguments before Claude Code's own, and where transcripts are kept. */
      launch?: string[];
      transcripts?: string;
    },
    terminals: Terminals,
    hub: RemoteHub,
  ): Promise<Remote> {
    const sid = o.sid ?? randomUUID();
    const title = o.title ?? `Hearth · ${o.name}`;
    const argv = [
      o.binary,
      ...(o.launch ?? []),
      "--remote-control",
      title,
      "--append-system-prompt",
      o.note ??
        SYSTEM_NOTE.replace("from Hearth's War Room", "from Hearth's War Room or the Claude app"),
      // Hearth's guide and where its manual is, as every War Room run gets (agent parity).
      ...(o.guide === false ? [] : remoteGuideArgs()),
      ...(o.extra ?? []),
      "--permission-mode",
      o.permissionMode ?? "acceptEdits",
      ...(o.allowedTools.length ? ["--allowedTools", o.allowedTools.join(",")] : []),
      // Resume only a conversation Claude Code actually kept. One that ended before it began
      // (at the Full access warning) has no transcript, and resuming it quits at once with "No
      // conversation found" (11-08: /rc started, then ended straight away, every time).
      ...(o.sid && existsSync(path.join(transcriptDir(o.cwd, o.transcripts), `${sid}.jsonl`))
        ? ["--resume", sid]
        : ["--session-id", sid]),
    ];
    terminals.end(`rc:${o.slug}`);
    const term = await terminals.get(`rc:${o.slug}`, argv, o.cwd, COLS, ROWS);
    return new Remote(o.slug, o.name, title, o.cwd, sid, term, hub, o.transcripts);
  }

  get closed() {
    return this.term.closed;
  }

  /** Types a War Room message into the session (pasted, so newlines don't send it early). */
  send(text: string) {
    this.sent.push(norm(text));
    this.term.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => this.term.write("\r"), 300);
  }

  /** Presses an option of the prompt on screen. */
  answer(key: string, label: string) {
    this.askChoice = label;
    const shown = this.lines();
    const menu = findBypassWarning(shown);
    if (!menu) {
      this.term.write(key);
      return;
    }
    // Claude Code's one-time warning is a menu picked with the arrow keys and Enter: a number does
    // nothing there, and Enter alone picks what is highlighted, "No, exit" (11-08: "Yes, I
    // accept" ended the session). So move to the answer from the highlight, then press Enter.
    const target = menu.options.findIndex((o) => o.key === key);
    if (target < 0) return;
    const moves = target - highlighted(shown, menu.options);
    const arrow = moves > 0 ? "\x1b[B" : "\x1b[A";
    for (let i = 0; i < Math.abs(moves); i++)
      setTimeout(() => !this.closed && this.term.write(arrow), 150 * i);
    setTimeout(() => !this.closed && this.term.write("\r"), 150 * Math.abs(moves) + 300);
  }

  stop() {
    this.term.close();
  }

  public() {
    return {
      project: this.slug,
      title: this.title,
      url: this.url ?? undefined,
      connecting: !this.url,
      started: this.started,
    };
  }

  private lines(): string[] {
    const buf = this.screen.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < ROWS; i++)
      out.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? "");
    return out;
  }

  // Trusts the folder (Hearth made it) and waits for the session's address.
  private watchScreen() {
    let trusted = false;
    let deadline = Date.now() + 60_000;
    const t = setInterval(() => {
      if (this.closed || this.url) return clearInterval(t);
      // A question waits for the owner; the minute starts again once it is answered.
      if (this.askId !== null) deadline = Date.now() + 60_000;
      const text = screenText(this.term.recent());
      if (!trusted && text.replace(/\s+/g, "").includes("Itrustthisfolder")) {
        trusted = true;
        setTimeout(() => this.term.write("\x1b[B"), 400);
        setTimeout(() => this.term.write("\r"), 700);
      }
      // The raw output alone is not enough: Claude Code redraws only the characters that
      // changed, so a resumed session's link can come out with letters missing. The rendered
      // screen has it whole; joined without breaks too, in case the link wraps a line.
      const shown = this.lines();
      const m = URL_RE.exec(text) ?? URL_RE.exec(shown.join("\n")) ?? URL_RE.exec(shown.join(""));
      if (m) {
        this.url = m[0];
        clearInterval(t);
        this.hub.message(
          this.slug,
          "ember",
          `Remote Control is on for **${this.name}**. In the Claude app, open Code and pick ` +
            `**${this.title}**, or [open it in Claude](${this.url}).\n\n` +
            "Keep typing here too; both sides see the same conversation. Type `/rc` again to turn it off.",
          "Claude Code · Remote Control",
        );
        this.hub.changed();
      } else if (Date.now() > deadline) {
        clearInterval(t);
        const tail = text.replace(/\s+/g, " ").slice(-300);
        this.hub.message(
          this.slug,
          "sys",
          `Remote Control didn't connect within a minute. Last screen: ${tail}`,
          "rc",
        );
        this.stop();
      }
    }, 500);
    this.timers.push(t);
  }

  // Permission prompts: shown in the War Room as a card; answered from either side.
  private watchPrompts() {
    let last: string | null = null;
    let steady = 0;
    let goneFor = 0;
    this.timers.push(
      setInterval(() => {
        if (this.closed) return;
        const shown = this.lines();
        const p = findPrompt(shown) ?? findBypassWarning(shown);
        const sig = p ? JSON.stringify(p) : null;
        steady = sig && sig === last ? steady + 1 : 0;
        last = sig;
        if (p && this.askId === null && steady >= 1) {
          this.askId = this.hub.ask(this.slug, p);
          this.askChoice = null;
          goneFor = 0;
        } else if (!p && this.askId !== null) {
          goneFor++;
          if (goneFor >= 2) {
            this.hub.askClosed(this.askId, this.askChoice ?? "answered in the Claude app");
            this.askId = null;
          }
        }
      }, 400),
    );
  }

  // Mirrors the conversation (both sides) from the transcript file.
  private tail() {
    if (this.closed) return;
    this.adoptCopy();
    let chunk: Buffer;
    try {
      if (!existsSync(this.file)) return;
      const size = statSync(this.file).size;
      if (size <= this.pos) return;
      const fd = openSync(this.file, "r");
      try {
        chunk = Buffer.alloc(size - this.pos);
        readSync(fd, chunk, 0, chunk.length, this.pos);
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }
    const end = chunk.lastIndexOf(0x0a) + 1; // whole lines only
    if (end <= 0) return;
    this.pos += end;
    for (const line of chunk.subarray(0, end).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        this.line(JSON.parse(line) as TranscriptLine);
      } catch {
        // A line still being written, or not ours to read.
      }
    }
  }

  // If Claude resumed into a copy under a new id, follow the copy instead.
  private adoptCopy() {
    try {
      if (existsSync(this.file) && statSync(this.file).mtimeMs >= this.started) return;
      const dir = transcriptDir(this.cwd, this.transcripts);
      if (!existsSync(dir)) return;
      const newer = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ f: path.join(dir, f), m: statSync(path.join(dir, f)).mtimeMs }))
        .filter((x) => x.m > this.started + 1000)
        .sort((a, b) => b.m - a.m);
      if (newer[0]) {
        this.file = newer[0].f;
        this.sid = path.basename(this.file, ".jsonl");
        this.pos = 0;
        this.hub.saveSession(this.slug, this.sid);
      }
    } catch {
      // Checked again next second.
    }
  }

  private line(d: TranscriptLine) {
    if (d.isSidechain || d.isMeta || (d.type !== "user" && d.type !== "assistant")) return;
    const key = d.uuid ?? "";
    if (key && this.seen.has(key)) return;
    this.seen.add(key);
    const content = d.message?.content;
    const blocks = Array.isArray(content) ? (content as { type?: string; text?: string }[]) : null;
    if (d.type === "user") {
      if (blocks?.some((b) => b.type === "tool_result")) return;
      const text = (
        blocks
          ? blocks
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("\n")
          : String(content ?? "")
      ).trim();
      // /login typed in the Claude app: Claude Code refuses it there, Hearth can do it (11-04).
      if (/<local-command-stdout>[^<]*\/login isn't available over Remote Control/i.test(text)) {
        this.hub.message(
          this.slug,
          "sys",
          "Claude Code can't sign in from the Claude app. Type /login here in Hearth to sign it in.",
          "rc",
        );
        return;
      }
      // Command wrappers and reminders are not something anyone typed.
      if (!text || text.startsWith("<")) return;
      const i = this.sent.indexOf(norm(text));
      if (i >= 0) {
        this.sent.splice(i, 1);
        return;
      }
      this.hub.message(this.slug, "you", text, "Claude app");
      return;
    }
    const text = (blocks ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n\n")
      .trim();
    if (text) this.hub.message(this.slug, "ember", text, "Claude Code · remote control");
  }

  private exited() {
    for (const t of this.timers) clearInterval(t);
    this.screen.dispose();
    this.hub.saveSession(this.slug, this.sid);
    this.hub.ended(this.slug);
  }
}

/** Every Remote Control session, at most one per project. */
export class Remotes {
  private readonly byProject = new Map<string, Remote>();
  shuttingDown = false;

  constructor(
    private readonly terminals: Terminals,
    private readonly hub: RemoteHub,
  ) {}

  get(slug: string): Remote | null {
    const r = this.byProject.get(slug);
    return r && !r.closed ? r : null;
  }

  async start(o: Parameters<typeof Remote.start>[0]): Promise<Remote> {
    const hub: RemoteHub = {
      ...this.hub,
      ended: (project) => {
        if (this.byProject.get(project)?.closed) this.byProject.delete(project);
        if (!this.shuttingDown) {
          this.hub.active(project, false);
          this.hub.ended(project);
        }
      },
    };
    const r = await Remote.start(o, this.terminals, hub);
    this.byProject.set(o.slug, r);
    this.hub.saveSession(o.slug, r.sid);
    this.hub.active(o.slug, true);
    return r;
  }

  public() {
    return [...this.byProject.values()].filter((r) => !r.closed).map((r) => r.public());
  }

  stopAll() {
    this.shuttingDown = true;
    for (const r of this.byProject.values()) r.stop();
  }
}
