import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { ARCHETYPES, type LookPersonaSetting } from "@dragon-control/core";
import type {
  SpeechFound,
  VoiceConfig,
  VoiceSetupState,
  VoiceStatus,
} from "@dragon-control/core";
import { ApiError, api } from "./api";

/** Voice: whether the speech services answer, the voice profiles, and which one is active. */
export function useVoice(enabled = true) {
  return useQuery({
    queryKey: ["voice"],
    queryFn: () => api<VoiceStatus>("GET", "/api/voice"),
    enabled,
    // Each read asks the speech machine; it rarely changes.
    staleTime: 5 * 60_000,
    retry: false,
    // While the built-in voice downloads, its progress shows as it goes.
    refetchInterval: (q) => (q.state.data?.builtin?.state === "downloading" ? 1500 : false),
  });
}

/** Standard voice: start getting it ready (it downloads once, by itself). */
export function usePrepareBuiltinVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<unknown>("POST", "/api/voice/builtin/prepare", {}),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["voice"] }),
  });
}

export function useSaveVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: VoiceConfig) => api<void>("PUT", "/api/voice", config),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["voice"] });
      void qc.invalidateQueries({ queryKey: ["workspace"] });
    },
  });
}

/** The saved voice settings, in the shape PUT /api/voice takes. */
export const voiceConfigOf = (s: VoiceStatus): VoiceConfig => ({
  engine: s.engine,
  host: s.host,
  sttPort: s.sttPort,
  ttsPort: s.ttsPort,
  profiles: s.profiles,
  active: s.active,
});

/**
 * Choosing the AI's picture. The picture belongs to the voice in use (one picture at a time);
 * with no voice chosen yet it goes on the picture's own archetype's voice, else the first one.
 */
export function useChooseAiLook() {
  const voice = useVoice();
  const save = useSaveVoice();
  const s = voice.data;
  const active = s?.profiles.find((p) => p.id === s.active);
  const choose = async (look: string) => {
    if (!s) throw new Error("Hearth could not read its voice settings, so the picture was not saved.");
    const config = voiceConfigOf(s);
    const target =
      active?.id ?? ARCHETYPES.find((a) => a.looks.includes(look))?.profileId ?? "warden";
    if (!config.profiles.some((p) => p.id === target)) return;
    await save.mutateAsync({
      ...config,
      active: target,
      profiles: config.profiles.map((p) => (p.id === target ? { ...p, avatar: look } : p)),
    });
  };
  return {
    choose,
    current: active?.avatar,
    ready: Boolean(s),
    loading: voice.isPending,
    pending: save.isPending,
    error: save.error ?? voice.error,
  };
}

/** Setting voice up from here: this computer's level, and an install's progress (polled while running). */
export function useVoiceSetup(enabled = true) {
  return useQuery({
    queryKey: ["voice-setup"],
    queryFn: () => api<VoiceSetupState>("GET", "/api/voice/setup"),
    enabled,
    refetchInterval: (q) => (q.state.data?.install.status === "running" ? 2000 : false),
  });
}

/** Looks for speech services on this computer and the home network. */
export function useFindSpeech() {
  return useMutation({
    mutationFn: () => api<{ found: SpeechFound[] }>("POST", "/api/voice/setup/find", {}),
  });
}

export function useUseSpeech() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (host: string) => api<void>("POST", "/api/voice/setup/use", { host }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["voice"] }),
  });
}

export function useInstallVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<VoiceSetupState["install"]>("POST", "/api/voice/setup/install", {}),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["voice-setup"] }),
  });
}

async function failure(res: Response): Promise<never> {
  const payload = (await res.json().catch(() => null)) as { message?: string } | null;
  throw new ApiError(payload?.message ?? `The server responded ${res.status}.`, res.status);
}

/** 16-bit mono PCM to text, through the speech machine. */
export async function transcribe(pcm: Int16Array, rate: number): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/api/voice/transcribe?rate=${rate}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Blob([pcm.buffer as ArrayBuffer]),
    });
  } catch {
    throw new ApiError("Hearth did not respond.", 0);
  }
  if (!res.ok) return failure(res);
  return ((await res.json()) as { text: string }).text;
}

/* ---------- The speaker: one answer at a time, stoppable from anywhere ---------- */

/** `key`: which message is being read (its play button shows it), when one was named. */
type SpeakerState = { status: "idle" | "loading" | "playing"; error?: string; key?: string };
let state: SpeakerState = { status: "idle" };
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | undefined;
let url: string | undefined;
let run = 0;
/** Lines waiting their turn (speaker.queue); stopping clears them. */
let line: Promise<void> = Promise.resolve();
let flushes = 0;

function set(next: SpeakerState) {
  state = next;
  for (const l of listeners) l();
}

export const speaker = {
  async say(text: string, profile?: string, key?: string) {
    const mine = ++run;
    speaker.stop(false);
    set({ status: "loading", key });
    try {
      const res = await fetch("/api/voice/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, ...(profile ? { profile } : {}) }),
      });
      if (!res.ok) await failure(res);
      const blob = await res.blob();
      if (mine !== run) return;
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      // A line that ends is not a Stop: lines waiting their turn still play.
      audio.onended = () => mine === run && speaker.stop(false);
      set({ status: "playing", key });
      await audio.play();
    } catch (e) {
      if (mine !== run) return;
      speaker.stop(false);
      set({
        status: "idle",
        key,
        error:
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "The browser blocked playback; tap the speaker once to allow it."
            : e instanceof Error
              ? e.message
              : "Could not speak.",
      });
    }
  },
  /** Reads a line and resolves once it has been read all the way (or failed, or was stopped). */
  async through(text: string, cap = 60_000) {
    await speaker.say(text);
    await speaker.finished(cap, cap);
  },
  /**
   * Reads a line after the one being read, never over it (11-13, the owner: Show & Tell "never
   * finishes" a line because the next one cut in). Resolves once this line has been read.
   */
  queue(text: string): Promise<void> {
    const mine = flushes;
    const next = line
      .then(() => speaker.finished(60_000, 60_000))
      .then(() => (mine === flushes ? speaker.through(text) : undefined));
    line = next.catch(() => undefined);
    return next;
  },
  stop(reset = true) {
    if (reset) {
      run++;
      flushes++;
    }
    audio?.pause();
    audio = undefined;
    if (url) URL.revokeObjectURL(url);
    url = undefined;
    if (reset || state.status !== "idle") set({ status: "idle" });
  },
  /**
   * Resolves once the line being read has finished, so the next one doesn't cut in. A line still
   * being made (loading) is waited for a few seconds; once it plays, until it ends (at most `cap`).
   */
  finished(cap = 30_000, making = 6_000): Promise<void> {
    if (state.status === "idle") return Promise.resolve();
    return new Promise((resolve) => {
      let timer = window.setTimeout(done, state.status === "loading" ? making : cap);
      let playing = state.status === "playing";
      function done() {
        window.clearTimeout(timer);
        listeners.delete(check);
        resolve();
      }
      function check() {
        if (state.status === "idle") return done();
        if (state.status === "playing" && !playing) {
          playing = true;
          window.clearTimeout(timer);
          timer = window.setTimeout(done, cap);
        }
      }
      listeners.add(check);
    });
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get state() {
    return state;
  },
};

export function useSpeaker(): SpeakerState {
  return useSyncExternalStore(speaker.subscribe, () => speaker.state);
}

/**
 * Conversations whose next answer is read aloud (the question was spoken).
 * Kept outside the chat box: sending the first message opens the new
 * conversation's page, which builds a fresh chat box.
 */
export const answerAloud = new Set<string>();

/** "Speak every answer aloud" on this device (typed questions too). Spoken questions are always answered aloud. */
const SPEAK_KEY = "dc-speak-answers";
const speakListeners = new Set<() => void>();
function readSpeak(): boolean {
  try {
    return localStorage.getItem(SPEAK_KEY) === "1";
  } catch {
    return false;
  }
}
export function setSpeakAnswers(on: boolean) {
  try {
    if (on) localStorage.setItem(SPEAK_KEY, "1");
    else localStorage.removeItem(SPEAK_KEY);
  } catch {
    // Storage can be unavailable; the choice then lasts until reload.
  }
  speakMemory = on;
  for (const l of speakListeners) l();
}
let speakMemory: boolean | undefined;
export function useSpeakAnswers(): boolean {
  return useSyncExternalStore(
    (l) => {
      speakListeners.add(l);
      return () => speakListeners.delete(l);
    },
    () => speakMemory ?? readSpeak(),
  );
}


/** "Turn on persona" (Ember Personas design): Ember talks as her chosen picture. Off by default. */
export function useLookPersona() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["look-persona"],
    queryFn: () => api<LookPersonaSetting>("GET", "/api/agent/look-persona"),
  });
  const save = useMutation({
    mutationFn: (next: LookPersonaSetting) =>
      api<LookPersonaSetting>("PUT", "/api/agent/look-persona", next),
    onSuccess: (saved) => qc.setQueryData(["look-persona"], saved),
  });
  return { data: q.data, save };
}
