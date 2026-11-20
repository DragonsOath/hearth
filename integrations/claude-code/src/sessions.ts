import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Companion, OfflineError, machineName } from "./client";
import { briefingText } from "./format";
import { isHomelab } from "./relevance";
import { readSession } from "./transcript";

/**
 * Claude Code hooks. Every one returns quickly and never blocks or fails
 * the session: if anything goes wrong, Claude Code simply carries on.
 *
 * - On each prompt: if it is about the homelab and this session is not in
 *   homelab mode yet, switch it on and hand Claude the briefing (live, or
 *   the cached copy clearly marked).
 * - When Claude finishes a reply, and when the session ends: save the new
 *   part of a homelab session word for word, and send queued saves.
 */

interface SessionState {
  homelab: boolean;
  transcriptPath?: string;
  transcriptId?: string;
  /** Lines of the session file already saved. */
  syncedLines: number;
  /** The session ended (remembered even if Hearth was away at the time). */
  ended?: boolean;
  /** Hearth already knows it ended. */
  endSent?: boolean;
}

function stateFile(c: Companion, sessionId: string) {
  return path.join(c.dir, "sessions", `${sessionId.replace(/[^\w-]/g, "")}.json`);
}

function readState(c: Companion, sessionId: string): SessionState {
  try {
    return JSON.parse(readFileSync(stateFile(c, sessionId), "utf8")) as SessionState;
  } catch {
    return { homelab: false, syncedLines: 0 };
  }
}

function writeState(c: Companion, sessionId: string, state: SessionState) {
  const file = stateFile(c, sessionId);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function cachedNames(c: Companion): string[] {
  try {
    return JSON.parse(readFileSync(path.join(c.dir, "cache", "names.json"), "utf8")) as string[];
  } catch {
    return [];
  }
}

export const HOMELAB_MODE = `You are in homelab mode: the owner is talking about their homelab, and Hearth is the shared memory of everything you have built together. Read the briefing below before answering and use it naturally, the way a collaborator who remembers would ("we did that yesterday", "that thread is still open"). Answer what they asked first; if the briefing's "What's up" has something that matters now, mention it in a sentence or two in your own words, like a friend who has been keeping an eye on things: real wins only, alarm in proportion to the stakes. Memories marked HISTORY are no longer how things are: use them for why and when, never as the current setup. Never present remembered or cached information as freshly verified; say how you know. Use the dragon-control tools: recall (search memories and past sessions word for word), remember (save decisions, fixes, wins, and new open threads the moment they happen), update_memory (close a thread, record a verification), read_session (read a past exchange). Never save passwords, keys, or tokens.`;

export async function onPrompt(
  c: Companion,
  input: { session_id: string; prompt?: string; transcript_path?: string },
): Promise<string | undefined> {
  if (!c.configured) return undefined;
  const state = readState(c, input.session_id);
  if (state.homelab || !input.prompt || !isHomelab(input.prompt, cachedNames(c))) return undefined;
  writeState(c, input.session_id, {
    ...state,
    homelab: true,
    transcriptPath: input.transcript_path,
  });
  const briefing = await c.briefing();
  return `${HOMELAB_MODE}\n\n${briefingText(briefing, c.url)}`;
}

/** Saves the part of a homelab session not saved yet. Throws OfflineError if Hearth is away. */
export async function syncSession(
  c: Companion,
  sessionId: string,
  transcriptPath?: string,
): Promise<void> {
  const state = readState(c, sessionId);
  const file = transcriptPath ?? state.transcriptPath;
  if (!state.homelab || !file || !existsSync(file)) return;
  const { messages, title, lines } = readSession(file);
  const fresh = messages.filter((m) => m.seq > state.syncedLines);
  if (!state.transcriptId) {
    const first = messages
      .find((m) => m.role === "you")
      ?.text.replace(/\s+/g, " ")
      .slice(0, 80);
    const started = await c.startTranscript({
      client: "claude-code",
      title: title ?? first ?? "Homelab session",
      machine: machineName(),
      sessionRef: sessionId,
    });
    state.transcriptId = started.id;
    writeState(c, sessionId, { ...state, transcriptPath: file });
  }
  for (let i = 0; i < fresh.length; i += 200) {
    await c.appendMessages(state.transcriptId, fresh.slice(i, i + 200));
  }
  writeState(c, sessionId, { ...state, transcriptPath: file, syncedLines: lines });
  if (state.ended && !state.endSent) {
    await c.endTranscript(state.transcriptId);
    writeState(c, sessionId, { ...state, transcriptPath: file, syncedLines: lines, endSent: true });
  }
}

export async function onTurnEnd(
  c: Companion,
  input: { session_id: string; transcript_path?: string },
  ended = false,
): Promise<void> {
  if (!c.configured) return;
  const state = readState(c, input.session_id);
  if (!state.homelab) return;
  if (ended) writeState(c, input.session_id, { ...state, ended: true });
  try {
    await c.flush((id) => syncSession(c, id));
    await syncSession(c, input.session_id, input.transcript_path);
  } catch (error) {
    if (error instanceof OfflineError) c.queueTranscript(input.session_id);
  }
}
