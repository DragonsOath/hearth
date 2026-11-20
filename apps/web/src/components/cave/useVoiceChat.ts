import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { VOICE_RECORD_RATE } from "@dragon-control/core";
import { speaker, transcribe, useSpeaker } from "../../data/voice";
import { EmberVoice } from "../ember/voice";
import { canDictate, hearOnce } from "../ember/dictation";

/**
 * Voice chat in the Lair (10-30): talk back and forth with Ember in the same thread. It
 * listens, sends what you said when you stop talking, and speaks the reply. The microphone is only
 * open while it is your turn: never while Ember is working on an answer or speaking one, so it
 * never hears itself. The ear turns listening off without leaving voice chat (replies are still
 * spoken).
 *
 * Hearing uses the speech machine when it has speech to text, otherwise the browser's own
 * recognition (Chrome, Edge), like the War Room.
 */

export type VoiceChatPhase = "off" | "listening" | "hearing" | "waiting" | "speaking" | "paused";

/**
 * The first thing said can start a new conversation, which opens a fresh chat box: voice chat
 * carries over to it instead of ending.
 */
let carry = false;
export function carryVoiceChat() {
  carry = true;
  // Only for the chat box that opens right now, never one opened later.
  setTimeout(() => {
    carry = false;
  }, 3000);
}

/** Quiet turns in a row (about 7 seconds each) before listening pauses by itself. */
const QUIET_TURNS = 4;
/** A moment after Ember finishes speaking before the mic opens again. */
const TURN_GAP_MS = 450;

export function useVoiceChat({
  serverHearing,
  working,
  onHeard,
}: {
  /** The speech machine can turn speech into text. */
  serverHearing: boolean;
  /** An answer is being worked on: not your turn. */
  working: boolean;
  /** What you said; true when it was sent. */
  onHeard: (text: string) => boolean;
}) {
  const recorder = useMemo(() => new EmberVoice(), []);
  const [on, setOn] = useState(() => {
    const was = carry;
    carry = false;
    return was;
  });
  const [hearing, setHearingState] = useState(true);
  const [busy, setBusy] = useState<"recording" | "transcribing" | null>(null);
  const [level, setLevel] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const speaking = useSpeaker();

  // Waiting for the answer to what you said: from sending until it was worked on and finished.
  const [awaiting, setAwaiting] = useState(false);
  const [sawWork, setSawWork] = useState(false);
  if (awaiting && working && !sawWork) setSawWork(true);
  if (awaiting && sawWork && !working) {
    setAwaiting(false);
    setSawWork(false);
  }

  // Live values for the listening loop (callbacks run later than the render that made them).
  const live = useRef({ on, hearing, working, quiet: 0, waiting: false });
  useLayoutEffect(() => {
    live.current.on = on;
    live.current.hearing = hearing;
    live.current.working = working;
    live.current.waiting = awaiting;
  });
  const heardRef = useRef(onHeard);
  useEffect(() => {
    heardRef.current = onHeard;
  });
  const stopBrowser = useRef<(() => void) | null>(null);

  const ready = () => {
    const l = live.current;
    return (
      l.on &&
      l.hearing &&
      !l.working &&
      !l.waiting &&
      speaker.state.status === "idle" &&
      !recorder.recording &&
      !stopBrowser.current
    );
  };

  const quietTurn = useCallback(() => {
    const l = live.current;
    if (++l.quiet < QUIET_TURNS) return true;
    l.quiet = 0;
    setHearingState(false);
    setNote("Listening paused: I didn't hear anything for a while. Tap the ear to talk again.");
    return false;
  }, []);

  const heard = useCallback((text: string) => {
    const words = text.trim();
    if (!words) return false;
    live.current.quiet = 0;
    setNote(null);
    if (!heardRef.current(words)) return false;
    live.current.waiting = true;
    setAwaiting(true);
    setSawWork(false);
    return true;
  }, []);

  const listenRef = useRef<() => void>(() => {});
  const listen = useCallback(() => {
    if (!ready()) return;
    // No speech to text on the speech machine: the browser listens instead.
    if (!serverHearing) {
      if (!canDictate()) {
        setNote(
          "Hearing needs speech to text on your speech machine (Settings, Ember, Voice), or a browser that can listen, like Chrome or Edge.",
        );
        setHearingState(false);
        return;
      }
      const h = hearOnce();
      stopBrowser.current = h.stop;
      setBusy("recording");
      void h.done.then((got) => {
        stopBrowser.current = null;
        setBusy(null);
        if (!live.current.on || !live.current.hearing) return;
        if (got.problem || got.unsupported) {
          setNote(
            got.problem ??
              "This browser can't listen here. Set up speech to text on your speech machine (Settings, Ember, Voice), or use Chrome or Edge.",
          );
          setHearingState(false);
          return;
        }
        if (got.text && heard(got.text)) return;
        if (quietTurn()) listenRef.current();
      });
      return;
    }
    setBusy("recording");
    recorder
      .start(
        (pcm) => {
          setLevel(0);
          if (!live.current.on || !live.current.hearing) {
            setBusy(null);
            return;
          }
          if (!pcm.length) {
            setBusy(null);
            if (quietTurn()) listenRef.current();
            return;
          }
          setBusy("transcribing");
          void transcribe(pcm, VOICE_RECORD_RATE)
            .then((text) => {
              setBusy(null);
              if (!live.current.on) return;
              if (text && heard(text)) return;
              setNote("Couldn't make that out. Say it again?");
              listenRef.current();
            })
            .catch((e: unknown) => {
              setBusy(null);
              setNote(
                `Speech to text failed: ${e instanceof Error ? e.message : "no answer from the speech machine"}`,
              );
              setHearingState(false);
            });
        },
        (l) => setLevel(l),
      )
      .catch((e: unknown) => {
        setBusy(null);
        setNote(`Microphone unavailable: ${e instanceof Error ? e.message : "it could not start"}`);
        setHearingState(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverHearing, recorder, heard, quietTurn]);
  useEffect(() => {
    listenRef.current = listen;
  }, [listen]);

  // Whose turn it is: after an answer is worked on and spoken, the mic opens again.
  useEffect(() => {
    if (!on || !hearing || awaiting) return;
    // Ember started speaking (or you pressed play): the mic closes so it never hears itself.
    if (speaking.status !== "idle") {
      if (recorder.recording) recorder.abort();
      stopBrowser.current?.();
      return;
    }
    const t = window.setTimeout(() => listenRef.current(), TURN_GAP_MS);
    return () => window.clearTimeout(t);
  }, [on, hearing, working, awaiting, speaking.status, recorder]);

  const closeMic = useCallback(() => {
    recorder.abort();
    stopBrowser.current?.();
    stopBrowser.current = null;
    setBusy(null);
    setLevel(0);
  }, [recorder]);

  useEffect(() => () => closeMic(), [closeMic]);

  const start = useCallback(() => {
    recorder.unlock();
    speaker.stop();
    live.current.quiet = 0;
    setAwaiting(false);
    setNote(null);
    setHearingState(true);
    setOn(true);
  }, [recorder]);

  const stop = useCallback(() => {
    closeMic();
    speaker.stop();
    setAwaiting(false);
    setNote(null);
    setOn(false);
  }, [closeMic]);

  /** The ear: listening on or off, without leaving voice chat. */
  const setHearing = useCallback(
    (next: boolean) => {
      live.current.quiet = 0;
      setNote(null);
      if (!next) closeMic();
      setHearingState(next);
    },
    [closeMic],
  );

  const phase: VoiceChatPhase = !on
    ? "off"
    : speaking.status !== "idle"
      ? "speaking"
      : working || awaiting || busy === "transcribing"
        ? "waiting"
        : !hearing
          ? "paused"
          : busy === "recording"
            ? "hearing"
            : "listening";

  return {
    on,
    hearing,
    phase,
    level,
    note,
    start,
    stop,
    setHearing,
    clearNote: () => setNote(null),
  };
}
