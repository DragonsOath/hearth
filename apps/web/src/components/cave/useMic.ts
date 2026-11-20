import { useCallback, useEffect, useRef, useState } from "react";
import { VOICE_MAX_SECONDS, VOICE_RECORD_RATE } from "@dragon-control/core";
import { openMic } from "../../lib/micChoice";
import { transcribe } from "../../data/voice";

/**
 * The microphone on this device. While you speak the mic button moves with
 * your voice; when you stop, what you said goes to the speech machine
 * (Whisper on ai-box) once and the words land in the box. (Words as you
 * spoke were tried and dropped 10-12: on the processor they lagged too far
 * behind.) Cancel throws the recording away.
 */

export type MicState = "idle" | "starting" | "listening" | "transcribing";

/** Below this the recording is silence: Whisper would invent words ("You"), so it is never sent. */
const SILENT_PEAK = 0.004;

export function peakOf(chunks: Float32Array[]): number {
  let peak = 0;
  for (const c of chunks)
    for (let i = 0; i < c.length; i += 8) peak = Math.max(peak, Math.abs(c[i]!));
  return peak;
}

export function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access is blocked for this site. Allow it in the browser's site settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No microphone found on this device. If yours is attached to another PC (VirtualHere), connect it to this one first.";
  if (name === "NotReadableError")
    return "The microphone is in use by another app or attached elsewhere. Free it and try again.";
  if (!navigator.mediaDevices?.getUserMedia)
    return "This browser cannot use a microphone here (it needs a secure https address).";
  return e instanceof Error ? e.message : "The microphone could not start.";
}

/** Down to 16 kHz mono 16-bit, the speech machine's format. */
export function toPcm16(chunks: Float32Array[], from: number): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    input.set(c, o);
    o += c.length;
  }
  const ratio = from / VOICE_RECORD_RATE;
  const out = new Int16Array(Math.floor(total / ratio));
  for (let i = 0; i < out.length; i++) {
    // Average the source samples that fall into this output sample (a simple low-pass).
    const start = Math.floor(i * ratio);
    const end = Math.min(total, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    const v = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

export function useMic(onText: (text: string) => void) {
  const [state, setState] = useState<MicState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<{
    stream: MediaStream;
    ctx: AudioContext;
    node: ScriptProcessorNode;
    chunks: Float32Array[];
    started: number;
    timer: number;
  } | null>(null);
  const textRef = useRef(onText);
  useEffect(() => {
    textRef.current = onText;
  }, [onText]);

  const release = useCallback(() => {
    const r = rec.current;
    rec.current = null;
    if (!r) return null;
    window.clearInterval(r.timer);
    r.node.disconnect();
    r.stream.getTracks().forEach((t) => t.stop());
    void r.ctx.close().catch(() => undefined);
    setLevel(0);
    return r;
  }, []);

  const stop = useCallback(async () => {
    const r = release();
    if (!r) return;
    const pcm = toPcm16(r.chunks, r.ctx.sampleRate);
    if (pcm.length < VOICE_RECORD_RATE / 4) {
      setState("idle");
      setError("That was too short to hear anything. Hold on a moment longer next time.");
      return;
    }
    if (peakOf(r.chunks) < SILENT_PEAK) {
      setState("idle");
      setError(
        "No sound reached Hearth from this microphone. Check it is the right mic and not muted (Chrome: the icon left of the address).",
      );
      return;
    }
    setState("transcribing");
    try {
      const text = await transcribe(pcm, VOICE_RECORD_RATE);
      if (text) textRef.current(text);
      else setError("Nothing was heard. Try again a little closer to the microphone.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The words could not be worked out.");
    } finally {
      setState("idle");
    }
  }, [release]);

  const start = useCallback(async () => {
    if (rec.current) return;
    setError(null);
    setState("starting");
    try {
      const stream = await openMic();
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (ev) => {
        const data = ev.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(data));
        let sum = 0;
        for (let i = 0; i < data.length; i += 16) sum += data[i]! * data[i]!;
        setLevel(Math.min(1, Math.sqrt(sum / (data.length / 16)) * 4));
      };
      source.connect(node);
      node.connect(ctx.destination);
      const started = Date.now();
      const timer = window.setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        setSeconds(s);
        if (s >= VOICE_MAX_SECONDS) void stop();
      }, 250);
      rec.current = { stream, ctx, node, chunks, started, timer };
      setSeconds(0);
      setState("listening");
    } catch (e) {
      release();
      setState("idle");
      setError(micError(e));
    }
  }, [release, stop]);

  const cancel = useCallback(() => {
    release();
    setState("idle");
  }, [release]);

  useEffect(() => () => void release(), [release]);

  return { state, error, level, seconds, start, stop, cancel, clearError: () => setError(null) };
}
