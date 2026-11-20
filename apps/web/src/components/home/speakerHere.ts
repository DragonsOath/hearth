import { useSyncExternalStore } from "react";
import { loadSendspinClientIdentity, SendspinPlayer } from "@sendspin/sendspin-js";

/**
 * This page as a Music Assistant speaker (11-05). Through Hearth's relay
 * (/api/home/speaker/socket, apps/speaker-relay.ts), which signs in to Music Assistant with
 * the key Hearth keeps; the page itself never holds it. One per page, kept across Hearth's
 * pages while the tab is open. It comes back on its own after a dropped connection; after the
 * page is reloaded the browser needs one tap before it may play sound.
 */

export interface SpeakerHere {
  on: boolean;
  connecting: boolean;
  playing: boolean;
  name: string;
  error?: string;
  /** Connected, but the browser holds the sound until a tap on the page. */
  needsTap?: boolean;
}

const KEY = "hearth.speaker-here";

function guessName() {
  const ua = navigator.userAgent;
  const kind = /Android/i.test(ua)
    ? "Android phone"
    : /iPhone|iPad/i.test(ua)
      ? "iPhone"
      : /Windows/i.test(ua)
        ? "Windows PC"
        : /Mac OS/i.test(ua)
          ? "Mac"
          : /Linux/i.test(ua)
            ? "Linux PC"
            : "This device";
  return `${kind} speakers`;
}

function saved(): { name?: string; on?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as { name?: string; on?: boolean };
  } catch {
    return {};
  }
}
function save(v: { name: string; on: boolean }) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // no storage: it is forgotten when the page closes
  }
}

let state: SpeakerHere = {
  on: false,
  connecting: false,
  playing: false,
  name: saved().name ?? guessName(),
};
const listeners = new Set<() => void>();
const set = (patch: Partial<SpeakerHere>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

let player: SendspinPlayer | undefined;
let retry: number | undefined;
let tries = 0;
let wanted = false;

function socketUrl(clientId: string) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/home/speaker/socket?client=${encodeURIComponent(clientId)}`;
}

/**
 * Opens the connection. The player is made and unlocked before anything else is awaited, so a
 * tap's permission to play sound reaches it (after one tap the page keeps that permission, so
 * a reconnect may unlock again on its own).
 */
async function open() {
  window.clearTimeout(retry);
  const { clientId } = loadSendspinClientIdentity();
  const ws = new WebSocket(socketUrl(clientId));
  ws.binaryType = "arraybuffer";
  const p = new SendspinPlayer({
    webSocket: ws,
    clientName: state.name,
    productName: "Hearth",
    onStateChange: (s) => set({ playing: Boolean(s.isPlaying) }),
  });
  player = p;
  const unlocked = p.unlock().then(
    () => set({ needsTap: false }),
    () => undefined,
  );
  ws.addEventListener("close", (ev) => {
    if (player !== p) return;
    player = undefined;
    set({ playing: false });
    if (!wanted) return set({ on: false, connecting: false });
    // Refused for good: not linked, or Music Assistant turned the key down.
    if (ev.code === 4001)
      return stopWith("Music Assistant refused Hearth's key. Link Music Assistant again.");
    tries += 1;
    set({ connecting: true, error: tries > 2 ? "Reconnecting to Music Assistant…" : undefined });
    retry = window.setTimeout(
      () => void open().catch(() => undefined),
      Math.min(15_000, 1000 * 2 ** tries),
    );
  });
  // Without a tap the browser keeps the sound waiting: connect anyway, and the first tap on the
  // page lets it out.
  const late = await Promise.race([
    unlocked.then(() => false),
    new Promise<boolean>((r) => window.setTimeout(() => r(true), 1500)),
  ]);
  if (late && player === p) set({ needsTap: true });
  await p.connect();
  tries = 0;
  set({ on: true, connecting: false, error: undefined });
}

function stopWith(error?: string) {
  wanted = false;
  window.clearTimeout(retry);
  const p = player;
  player = undefined;
  try {
    p?.disconnect("user_request");
  } catch {
    // already closed
  }
  save({ name: state.name, on: false });
  set({
    on: false,
    connecting: false,
    playing: false,
    ...(error ? { error } : { error: undefined }),
  });
}

/** Starts playing here. Call it straight from a tap (the browser allows sound after one). */
export async function startSpeakerHere(name?: string) {
  const n = (name ?? state.name).trim().slice(0, 60) || guessName();
  wanted = true;
  tries = 0;
  set({ name: n, connecting: true, error: undefined });
  try {
    await open();
    save({ name: n, on: true });
  } catch {
    stopWith(
      "This page could not become a speaker. Check that Music Assistant is linked to Hearth.",
    );
  }
}

export function stopSpeakerHere() {
  stopWith();
}

/**
 * Coming back to the page (11-06: "if I come back and hit play no sound is coming out"):
 * the browser pauses a page's sound while it sits in the background, and a reconnect made
 * while away may not get to start it. Returning to the tab, or any tap or key on it, wakes the
 * sound again, so the speaker never has to be added a second time.
 */
function wake() {
  if (!wanted) return;
  if (player) void player.unlock().catch(() => undefined);
  else if (!state.connecting) void open().catch(() => undefined);
}
if (typeof document !== "undefined") {
  // Reopened (11-06: "you have to add a speaker again if you exit and come back"): a page
  // that was a speaker becomes one again by itself.
  if (saved().on) {
    wanted = true;
    set({ connecting: true });
    void open().catch(() => stopWith());
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
  window.addEventListener("pointerdown", wake, { capture: true, passive: true });
  window.addEventListener("keydown", wake, { capture: true });
}

/** Whether this page was a speaker before it was reloaded (it asks for one tap to resume). */
export const wasSpeakerHere = () => Boolean(saved().on);

export function useSpeakerHere(): SpeakerHere {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
