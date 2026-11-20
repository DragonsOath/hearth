import {
  DEFAULT_STT_PORT,
  DEFAULT_TTS_PORT,
  DEFAULT_VOICE_PROFILES,
  currentLook,
  defaultAvatarFor,
  type LookStyle,
  defaultGenderFor,
  VOICE_MAX_SECONDS,
  STANDARD_VOICE,
  speakableText,
  type VoiceEngine,
  type VoiceConfig,
  type VoiceProfile,
  type VoiceStatus,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import { recordAudit } from "../store/audit";
import { InvalidRequestError } from "../store/errors";
import { deleteSetting, getSetting, setSetting } from "../store/settings";
import {
  describe as wyDescribe,
  synthesize as wySynthesize,
  transcribe as wyTranscribe,
  wav,
  type Pcm,
  type SpeechTarget,
} from "./wyoming";
import { withEffect, type EffectRunner } from "./effects";
import { VOICE_PACK_MB, type VoicePackApi } from "./pack";

/** The speech calls, swappable so tests and browser tests never need a real GPU machine. */
export interface SpeechClient {
  describe: typeof wyDescribe;
  transcribe: typeof wyTranscribe;
  synthesize: typeof wySynthesize;
}
export const wyomingClient: SpeechClient = {
  describe: wyDescribe,
  transcribe: wyTranscribe,
  synthesize: wySynthesize,
};

/** Longest text spoken at once (characters, after cleaning). */
const SPEAK_MAX = 2000;

/**
 * Voice for Ember: speech to text and text to speech through the
 * speech services Home Assistant also uses. Owner only (the routes check);
 * the speech services never see tools, records, or credentials, only the
 * audio or text of one request.
 */
/**
 * The built-in personas as they were first written, each naming its character ("Warden, Guardian
 * of Ember: ..."). A saved profile still holding one exactly gets today's wording, which
 * describes the style only, so the AI's only name is Ember or the one the owner saved. A persona
 * the owner edited is never touched.
 */
const NAMED_PERSONAS: Record<string, string> = {
  warden:
    "Warden, Guardian of Ember: an ancient dragon's calm, intelligent, deliberate presence. Confident and authoritative, warm enough for long troubleshooting, with an occasional dry humor. Measured sentences; no theatrical monologues, no growling.",
  operator:
    "The Operator: a composed, highly intelligent operations commander. Clear and strategic, every word deliberate, quietly confident and occasionally wry. Leads with the situation and the recommended move, then the detail. Professional and reassuring; never rushed, never chatty.",
  enchantress:
    "The Enchantress: warm, lilting, and quietly bewitching, with a soft Irish turn of phrase. Makes troubleshooting feel like a shared puzzle; gentle encouragement, a little playful charm, never saccharine. Clear about what is wrong and what she will do about it.",
  scholar:
    "The Scholar: a discreet, trusted British advisor of advanced years. Cultured, measured, and exact, with calm authority and understated humor. Explains the why behind a problem in plain words, notes interesting discrepancies, and recommends the careful next step.",
  companion:
    "The Companion: a friendly, witty robot companion unit. Even, precise, and upbeat, with a dry machine humor and the occasional self-aware robot joke. Short, clear status lines; cheerful about good news, plain and helpful about bad.",
};

/**
 * A saved profile brought up to date: a built-in persona in its first wording gets today's (see
 * NAMED_PERSONAS), and a built-in voice saved before voices had a gender or a picture gets its own.
 */
export function currentPersona(p: VoiceProfile, style: LookStyle = "ember"): VoiceProfile {
  const gender = p.gender ?? defaultGenderFor(p.id);
  if (gender && !p.gender) p = { ...p, gender };
  // A built-in voice saved before characters had pictures gets its own default look.
  const look = p.avatar ? undefined : defaultAvatarFor(p.id, style);
  if (look) p = { ...p, avatar: look };
  // A retired picture shows as Classic Ember (read only: what is saved is left alone).
  else if (p.avatar && currentLook(p.avatar) !== p.avatar)
    p = { ...p, avatar: currentLook(p.avatar) };
  if (NAMED_PERSONAS[p.id] === undefined || p.persona !== NAMED_PERSONAS[p.id]) return p;
  const today = DEFAULT_VOICE_PROFILES.find((d) => d.id === p.id);
  return today ? { ...p, persona: today.persona } : p;
}

export class Voice {
  constructor(
    private readonly handle: DbHandle,
    private readonly opts: {
      defaultHost?: string;
      client?: SpeechClient;
      /** Runs a voice effect (ffmpeg); tests pass a stand-in. */
      effect?: EffectRunner;
      /** Told when an effect could not run, so the plain voice was used. */
      onEffectError?: (error: unknown) => void;
      /** Standard voice: built in, downloaded by Hearth itself the first time it is needed. */
      pack?: VoicePackApi;
    } = {},
  ) {}

  private get client() {
    return this.opts.client ?? wyomingClient;
  }

  async config(): Promise<VoiceConfig> {
    const saved = await getSetting(this.handle.db, "voice_config");
    const style = (await getSetting(this.handle.db, "ai_look_style")) ?? "ember";
    // Built-in profiles start on the style's default picture: Ember's flame, or their character.
    const builtIns = DEFAULT_VOICE_PROFILES.map((p) => ({
      ...p,
      avatar: defaultAvatarFor(p.id, style) ?? p.avatar,
    }));
    // Built-in profiles added since the settings were saved (Saoirse) appear too, unless removed.
    const have = new Set(saved?.profiles.map((p) => p.id));
    const added = builtIns.filter(
      (p) => !have.has(p.id) && !saved?.removedBuiltIns?.includes(p.id),
    );
    const host = saved?.host ?? this.opts.defaultHost ?? "";
    return {
      // A speech machine already set up keeps being used (Advanced); otherwise Standard.
      engine: saved?.engine ?? (host ? "machine" : "builtin"),
      host,
      sttPort: saved?.sttPort ?? DEFAULT_STT_PORT,
      ttsPort: saved?.ttsPort ?? DEFAULT_TTS_PORT,
      profiles: saved
        ? [...saved.profiles.map((p) => currentPersona(p, style)), ...added]
        : builtIns,
      active: saved ? saved.active : undefined,
    };
  }

  /** The active profile, if one is chosen (its persona goes into the AI's instructions). */
  async activeProfile(): Promise<VoiceProfile | undefined> {
    const c = await this.config();
    return c.profiles.find((p) => p.id === c.active);
  }

  /** Which voice this installation uses (Standard needs nothing set up). */
  private engineOf(c: VoiceConfig): VoiceEngine {
    return c.engine === "machine" || !this.opts.pack ? "machine" : "builtin";
  }

  async status(): Promise<VoiceStatus> {
    const c = await this.config();
    const engine = this.engineOf(c);
    const builtin = this.opts.pack?.state() ?? { state: "missing" as const, sizeMb: VOICE_PACK_MB };
    if (engine === "builtin") {
      const ready = builtin.state === "ready";
      const why = builtin.state === "failed" ? builtin.error : "Getting ready";
      return {
        configured: true,
        engine,
        builtin,
        host: c.host,
        sttPort: c.sttPort,
        ttsPort: c.ttsPort,
        profiles: c.profiles,
        active: c.active,
        stt: ready ? { ok: true, model: "Whisper (built in)" } : { ok: false, error: why },
        // Standard has one voice; every profile is spoken with it, so previews all play.
        tts: ready
          ? { ok: true, voices: c.profiles.map((p) => p.voice) }
          : { ok: false, voices: [], error: why },
      };
    }
    const base = {
      configured: Boolean(c.host),
      engine,
      builtin,
      host: c.host,
      sttPort: c.sttPort,
      ttsPort: c.ttsPort,
      profiles: c.profiles,
      active: c.active,
    };
    if (!c.host)
      return {
        ...base,
        stt: { ok: false, error: "Not set up" },
        tts: { ok: false, voices: [], error: "Not set up" },
      };
    const [stt, tts] = await Promise.all([
      this.client
        .describe({ host: c.host, port: c.sttPort })
        .then((d) => ({
          ok: true,
          model: d.asr[0]?.models.find((m) => m.installed !== false)?.name,
        }))
        .catch((e: Error) => ({ ok: false, error: e.message })),
      this.client
        .describe({ host: c.host, port: c.ttsPort })
        .then((d) => ({
          ok: true,
          // Custom voices (no attribution: Belle, Warden, ...) first, then Piper's English stock voices.
          voices: [
            ...(d.tts[0]?.voices ?? []).filter((v) => !v.attribution?.name).map((v) => v.name),
            ...(d.tts[0]?.voices ?? [])
              .filter((v) => v.attribution?.name && v.name.startsWith("en_"))
              .map((v) => v.name),
          ],
        }))
        .catch((e: Error) => ({ ok: false, voices: [] as string[], error: e.message })),
    ]);
    return { ...base, stt, tts };
  }

  async save(next: VoiceConfig): Promise<void> {
    const before = await this.config();
    const ids = new Set<string>();
    for (const p of next.profiles) {
      if (ids.has(p.id))
        throw new InvalidRequestError(`Two voice profiles share the id "${p.id}".`);
      ids.add(p.id);
    }
    if (next.active && !ids.has(next.active))
      throw new InvalidRequestError("The chosen profile is not in the list.");
    const kept = new Set(next.profiles.map((p) => p.id));
    const removedBuiltIns = DEFAULT_VOICE_PROFILES.map((p) => p.id).filter((id) => !kept.has(id));
    await setSetting(this.handle.db, "voice_config", {
      // A save that doesn't mention the engine keeps the one in use.
      engine: next.engine ?? before.engine,
      host: next.host,
      sttPort: next.sttPort,
      ttsPort: next.ttsPort,
      profiles: next.profiles,
      active: next.active,
      ...(removedBuiltIns.length ? { removedBuiltIns } : {}),
    });
    // Choosing a profile never changes the AI's name: a saved name stays, and without one the AI
    // is called Ember (DEFAULT_AI_NAME), whichever voice is in use.
    const changes: string[] = [];
    if (this.engineOf(before) !== this.engineOf({ ...before, ...next }))
      changes.push(
        this.engineOf(next) === "builtin"
          ? "Standard voice (built into Hearth)"
          : "Advanced voice (your speech machine)",
      );
    if (
      before.host !== next.host ||
      before.sttPort !== next.sttPort ||
      before.ttsPort !== next.ttsPort
    )
      changes.push(next.host ? `speech services at ${next.host}` : "voice switched off");
    const names = (l: VoiceProfile[]) => l.map((p) => `${p.name} (${p.voice})`).join(", ");
    if (
      names(before.profiles) !== names(next.profiles) ||
      JSON.stringify(before.profiles) !== JSON.stringify(next.profiles)
    )
      changes.push("voice profiles");
    if (before.active !== next.active) {
      const name = next.profiles.find((p) => p.id === next.active)?.name;
      changes.push(name ? `voice profile ${name}` : "no voice profile");
    }
    if (changes.length)
      await recordAudit(this.handle.db, {
        actor: "you",
        action: `Changed Ember voice: ${changes.join(", ")}`,
        target: "voice",
        detail: {
          host: next.host,
          active: next.active ?? null,
          profiles: next.profiles.map((p) => ({ id: p.id, name: p.name, voice: p.voice })),
        },
      });
  }

  /**
   * A picture went away (the owner removed their AI's own picture): profiles that showed it go
   * back to their archetype's default, or to none for a profile of the owner's own.
   */
  async dropAvatar(path: string): Promise<void> {
    const saved = await getSetting(this.handle.db, "voice_config");
    if (!saved?.profiles.some((p) => p.avatar === path)) return;
    const style = (await getSetting(this.handle.db, "ai_look_style")) ?? "ember";
    await setSetting(this.handle.db, "voice_config", {
      ...saved,
      profiles: saved.profiles.map((p) => {
        if (p.avatar !== path) return p;
        const { avatar: _gone, ...rest } = p;
        const fallback = defaultAvatarFor(p.id, style);
        return fallback ? { ...rest, avatar: fallback } : rest;
      }),
    });
  }

  async reset(): Promise<void> {
    await deleteSetting(this.handle.db, "voice_config");
  }

  private async target(kind: "stt" | "tts"): Promise<SpeechTarget> {
    const c = await this.config();
    if (!c.host)
      throw new InvalidRequestError("Voice is not set up yet: Settings > Ember > Voice.");
    return {
      host: c.host,
      port: kind === "stt" ? c.sttPort : c.ttsPort,
      timeoutMs: kind === "stt" ? 60_000 : 45_000,
    };
  }

  /** 16-bit mono PCM from the browser to text. */
  async transcribe(audio: Buffer, rate: number): Promise<string> {
    if (!audio.length) throw new InvalidRequestError("No audio was recorded.");
    if (audio.length / 2 / rate > VOICE_MAX_SECONDS)
      throw new InvalidRequestError(`Speak for up to ${VOICE_MAX_SECONDS / 60} minutes at a time.`);
    const pcm: Pcm = { audio, rate, width: 2, channels: 1 };
    const c = await this.config();
    if (this.engineOf(c) === "builtin") return this.builtin((pack) => pack.transcribe(pcm));
    return this.client.transcribe(await this.target("stt"), pcm);
  }

  /** Starts getting the built-in voice ready (it downloads once, by itself). */
  voiceLoaded(): boolean {
    return this.opts.pack?.state().running ?? false;
  }

  /** Stops the built-in voice's helper now, so its memory comes back (it starts again when used). */
  releaseBuiltin() {
    this.opts.pack?.close();
    return this.opts.pack?.state();
  }

  prepareBuiltin() {
    this.opts.pack?.install();
    return this.opts.pack?.state();
  }

  /** The built-in voice's errors (still downloading, say) are the owner's to read, not a crash. */
  private async builtin<T>(f: (pack: VoicePackApi) => Promise<T>): Promise<T> {
    try {
      return await f(this.opts.pack!);
    } catch (e) {
      throw new InvalidRequestError(e instanceof Error ? e.message : String(e));
    }
  }

  /** The Standard voice as raw audio, for Home Assistant (voice/share.ts). */
  async standardPcm(text: string): Promise<Pcm> {
    if (!this.opts.pack) throw new InvalidRequestError("The Standard voice is not available here.");
    const words = speakableText(text).slice(0, SPEAK_MAX);
    if (!words) throw new InvalidRequestError("There is nothing to say.");
    return this.builtin((pack) => pack.synthesize(words, STANDARD_VOICE));
  }

  /** Text to a WAV file in the chosen profile's voice (or the active one). */
  async speak(text: string, profileId?: string): Promise<Buffer> {
    const c = await this.config();
    const id = profileId ?? c.active;
    const profile = c.profiles.find((p) => p.id === id) ?? c.profiles[0];
    if (!profile) throw new InvalidRequestError("Add a voice profile first.");
    const words = speakableText(text).slice(0, SPEAK_MAX);
    if (!words) throw new InvalidRequestError("There is nothing to say.");
    const pcm =
      this.engineOf(c) === "builtin"
        ? await this.builtin((pack) => pack.synthesize(words, STANDARD_VOICE))
        : await this.client.synthesize(await this.target("tts"), words, profile.voice);
    if (!pcm.audio.length)
      throw new InvalidRequestError(
        `The voice "${profile.voice}" is not on the speech machine yet, so ${profile.name} cannot speak.`,
      );
    // Standard is one plain voice; a character's effect (the Companion's voice box) is Advanced.
    const effect = this.engineOf(c) === "builtin" ? undefined : profile.effect;
    return withEffect(wav(pcm), effect, this.opts.effect, this.opts.onEffectError);
  }
}
