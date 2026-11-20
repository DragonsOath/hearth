import { useEffect, useState, type ReactNode } from "react";
import {
  AI_NAME_PATTERN,
  DEFAULT_STT_PORT,
  DEFAULT_TTS_PORT,
  currentLook,
  VOICE_PERSONA_MAX,
  VOICE_PROFILE_LIMIT,
  VOICE_TRAIT_LEVELS,
  VOICE_TRAITS,
  type VoiceConfig,
  type VoiceEngine,
  type VoiceProfile,
  type VoiceStatus,
  type VoiceTraitLevel,
  type VoiceGender,
  VOICE_EFFECTS,
} from "@dragon-control/core";
import { Button, Tag } from "../components/ui";
import { speaker, useSaveVoice, useSpeaker, useVoice } from "../data/voice";
import { FormError } from "./auth/AuthFrame";
import { useAiName, useWorkspace } from "../data/api";
import { VoiceSetupNote } from "../components/settings/VoiceSetupNote";
import { VoiceShareSetting } from "../components/settings/VoiceShareSetting";
import { PictureForVoice } from "../components/settings/PictureForVoice";
import { AiPictureUpload, LookPicker, avatarSrc, lookFit } from "../components/settings/LookPicker";

/**
 * Settings > Ember > Voice: where the speech services are (the same
 * Whisper and Piper Home Assistant uses), and the voice profiles. A profile
 * is a name, a voice, and a personality; choosing one changes only how the
 * AI sounds and talks, never what it may do.
 */

const field =
  "min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";

const SAMPLE =
  "I've found the disturbance. Sonarr cannot reach its indexer. I'll investigate before recommending a repair.";

function slug(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "voice";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

export function VoiceSettings() {
  const status = useVoice();
  const save = useSaveVoice();
  const speaking = useSpeaker();
  // Your unsaved edits; none means the saved settings are shown.
  const [edit, setDraft] = useState<VoiceConfig | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  // The profile whose look picker is open.
  const [looking, setLooking] = useState<string | null>(null);
  // The voice being switched to, while its picture is chosen.
  const [switching, setSwitching] = useState<VoiceProfile | null>(null);
  const ws = useWorkspace();
  const aiName = useAiName();

  if (status.isPending)
    return <p className="mb-10 text-[0.88rem] text-muted">Checking the speech services…</p>;
  if (status.error)
    return (
      <div className="mb-10">
        <FormError error={status.error} />
      </div>
    );

  const s = status.data!;
  const saved: VoiceConfig = {
    engine: s.engine,
    host: s.host,
    sttPort: s.sttPort,
    ttsPort: s.ttsPort,
    profiles: s.profiles,
    active: s.active,
  };
  const draft = edit ?? saved;
  const changed = JSON.stringify(saved) !== JSON.stringify(draft);
  const voices = s.tts.voices;
  const standard = s.engine === "builtin";
  const invalid = draft.profiles.find(
    (p) => !AI_NAME_PATTERN.test(p.name.trim()) || !p.voice.trim(),
  );
  const setProfile = (id: string, patch: Partial<VoiceProfile>) =>
    setDraft({
      ...draft,
      profiles: draft.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  const commit = (next = draft) =>
    save.mutate(
      {
        ...next,
        host: next.host.trim(),
        profiles: next.profiles.map((p) => ({
          ...p,
          name: p.name.trim(),
          persona: p.persona.trim(),
        })),
      },
      { onSuccess: () => setDraft(null) },
    );

  // The picture the AI has now: the voice in use's, or with no voice in use the default.
  const inUse = draft.profiles.find((p) => p.id === draft.active);
  const currentPicture = currentLook(inUse?.avatar);

  return (
    <div className="mb-10 max-w-3xl" data-testid="voice-settings">
      {switching && (
        <PictureForVoice
          voice={switching}
          current={currentPicture}
          busy={save.isPending}
          onCancel={() => setSwitching(null)}
          onChoose={(avatar) =>
            save.mutate(
              {
                ...draft,
                host: draft.host.trim(),
                active: switching.id,
                profiles: draft.profiles.map((p) => ({
                  ...p,
                  name: p.name.trim(),
                  persona: p.persona.trim(),
                  ...(p.id === switching.id ? { avatar } : {}),
                })),
              },
              {
                onSuccess: () => {
                  setDraft(null);
                  setSwitching(null);
                },
              },
            )
          }
        />
      )}
      <p className="mb-4 text-[0.88rem] leading-relaxed text-muted">
        Speak to {aiName} with the microphone in the chat box, and hear it answer. Your words are
        turned into text and land in the box for you to check before sending. Voice has exactly the
        permissions typing has: the same conversation, tools, and approvals.
      </p>

      <EngineChoice
        status={s}
        busy={save.isPending}
        onChoose={(engine) =>
          save.mutate({ ...saved, engine }, { onSuccess: () => setDraft(null) })
        }
      />

      {!standard && (
        <fieldset className="mb-6 grid gap-3 sm:grid-cols-[1fr_8rem_8rem]">
          <legend className="mb-2 text-[0.85rem] text-ink">Speech machine</legend>
          <div>
            <label htmlFor="voice-host" className="mb-1 block text-[0.78rem] text-muted">
              Host name or IP address
            </label>
            <input
              id="voice-host"
              value={draft.host}
              maxLength={253}
              placeholder="Host name or IP address"
              autoComplete="off"
              onChange={(e) => setDraft({ ...draft, host: e.target.value })}
              className={field}
            />
          </div>
          <div>
            <label htmlFor="voice-stt" className="mb-1 block text-[0.78rem] text-muted">
              Speech to text port
            </label>
            <input
              id="voice-stt"
              inputMode="numeric"
              value={draft.sttPort}
              onChange={(e) =>
                setDraft({ ...draft, sttPort: Number(e.target.value) || DEFAULT_STT_PORT })
              }
              className={field}
            />
          </div>
          <div>
            <label htmlFor="voice-tts" className="mb-1 block text-[0.78rem] text-muted">
              Voice port
            </label>
            <input
              id="voice-tts"
              inputMode="numeric"
              value={draft.ttsPort}
              onChange={(e) =>
                setDraft({ ...draft, ttsPort: Number(e.target.value) || DEFAULT_TTS_PORT })
              }
              className={field}
            />
          </div>
        </fieldset>
      )}
      {s.configured && !standard && (
        <ul className="mb-6 space-y-1 text-[0.82rem]" data-testid="voice-status">
          <li className="flex flex-wrap items-center gap-2">
            <Tag tone={s.stt.ok ? "gold" : "warn"}>{s.stt.ok ? "Hearing" : "Not hearing"}</Tag>
            <span className="text-muted">
              {s.stt.ok ? `Speech to text ready (${s.stt.model ?? "Whisper"})` : s.stt.error}
            </span>
          </li>
          <li className="flex flex-wrap items-center gap-2">
            <Tag tone={s.tts.ok ? "gold" : "warn"}>{s.tts.ok ? "Speaking" : "Not speaking"}</Tag>
            <span className="text-muted">
              {s.tts.ok ? `${voices.length} voices available` : s.tts.error}
            </span>
          </li>
        </ul>
      )}

      <VoiceSetupNote status={s} aiName={aiName} />
      <VoiceShareSetting ready={s.builtin.state === "ready"} />
      {standard ? (
        <StandardVoice status={s} aiName={aiName} />
      ) : (
        <>
          <h3 className="mb-2 text-[0.85rem] text-ink">Voice characters</h3>
          <p className="mb-4 text-[0.82rem] leading-relaxed text-faint">
            Choosing a profile gives the AI that voice and way of talking. A look only goes with a
            voice it suits. The personality shapes style only; the rules and approvals never change.
            New voices (Saoirse, and others) appear in the voice list once they are on the speech
            machine.
          </p>
          <div className="mb-5">
            <p className="mb-2 text-[0.82rem] text-muted">
              Your AI&apos;s own picture, to use as any profile&apos;s look:
            </p>
            <AiPictureUpload />
          </div>
          <ul className="mb-4 space-y-4" data-testid="voice-profiles">
            {draft.profiles.map((p) => {
              const missing = !standard && s.tts.ok && !voices.includes(p.voice);
              const active = draft.active === p.id;
              return (
                <li
                  key={p.id}
                  className={
                    "rounded-xl border p-4 " + (active ? "border-gold/60 bg-gold/5" : "border-line")
                  }
                  data-testid={`voice-profile-${p.id}`}
                >
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    {p.avatar && (
                      <img
                        src={avatarSrc(p.avatar, ws.data?.aiAvatarAt)}
                        alt=""
                        width={48}
                        height={48}
                        loading="lazy"
                        className={`h-12 w-12 ${lookFit(p.avatar)}`}
                      />
                    )}
                    {active ? <Tag tone="gold">In use</Tag> : null}
                    {missing ? <Tag tone="warn">Voice not on the speech machine yet</Tag> : null}
                    {/* One picture at a time: the voice in use's is Ember's picture. Another voice
                    gets its picture when you switch to it (PictureForVoice). */}
                    {active && (
                      <Button
                        tone="quiet"
                        aria-expanded={looking === p.id}
                        aria-controls={`vp-look-${p.id}`}
                        onClick={() => setLooking(looking === p.id ? null : p.id)}
                      >
                        {looking === p.id ? "Done choosing" : "Change look"}
                      </Button>
                    )}
                  </div>
                  {looking === p.id && (
                    <div id={`vp-look-${p.id}`} className="mb-4 rounded-lg border border-line p-3">
                      <LookPicker
                        label={`${p.name.trim() || "This profile"}'s look`}
                        value={p.avatar}
                        onPick={(avatar) => setProfile(p.id, { avatar })}
                      />
                      <p className="mt-3 text-[0.78rem] text-faint">Save to keep it.</p>
                    </div>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label
                        htmlFor={`vp-name-${p.id}`}
                        className="mb-1 block text-[0.78rem] text-muted"
                      >
                        Profile name
                      </label>
                      <input
                        id={`vp-name-${p.id}`}
                        value={p.name}
                        maxLength={40}
                        onChange={(e) => setProfile(p.id, { name: e.target.value })}
                        className={field}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`vp-voice-${p.id}`}
                        className="mb-1 block text-[0.78rem] text-muted"
                      >
                        Voice
                      </label>
                      <select
                        id={`vp-voice-${p.id}`}
                        value={p.voice}
                        onChange={(e) => setProfile(p.id, { voice: e.target.value })}
                        className={field}
                      >
                        {!voices.includes(p.voice) && (
                          <option value={p.voice}>{p.voice} (not there yet)</option>
                        )}
                        {voices.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label
                        htmlFor={`vp-gender-${p.id}`}
                        className="mb-1 block text-[0.78rem] text-muted"
                      >
                        Sounds like
                      </label>
                      <select
                        id={`vp-gender-${p.id}`}
                        value={p.gender ?? ""}
                        onChange={(e) =>
                          setProfile(p.id, {
                            gender: (e.target.value || undefined) as VoiceGender | undefined,
                          })
                        }
                        className={field}
                      >
                        <option value="">Not set (any look)</option>
                        <option value="masculine">A man</option>
                        <option value="feminine">A woman</option>
                        <option value="neutral">Neither (a robot, a creature)</option>
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <label
                        htmlFor={`vp-persona-${p.id}`}
                        className="mb-1 block text-[0.78rem] text-muted"
                      >
                        Personality (how it talks)
                      </label>
                      <textarea
                        id={`vp-persona-${p.id}`}
                        value={p.persona}
                        rows={3}
                        maxLength={VOICE_PERSONA_MAX}
                        onChange={(e) => setProfile(p.id, { persona: e.target.value })}
                        className={field + " py-2 leading-snug"}
                      />
                    </div>
                    <label className="flex min-h-11 items-start gap-3 sm:col-span-2">
                      <input
                        type="checkbox"
                        checked={p.effect === "voicebox"}
                        onChange={(e) =>
                          setProfile(p.id, { effect: e.target.checked ? "voicebox" : undefined })
                        }
                        className="mt-1 h-5 w-5 accent-[var(--color-gold)]"
                      />
                      <span className="text-[0.82rem] text-muted">
                        {VOICE_EFFECTS.voicebox.label} effect
                        <span className="block text-[0.75rem] text-faint">
                          Adds {VOICE_EFFECTS.voicebox.what} when it speaks. The voice itself stays
                          the same.
                        </span>
                      </span>
                    </label>
                    <fieldset className="sm:col-span-2">
                      <legend className="mb-1 text-[0.78rem] text-muted">
                        Personality dials (optional; style only)
                      </legend>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                        {VOICE_TRAITS.map((t) => (
                          <label key={t.key} className="text-[0.75rem] text-faint">
                            {t.label}
                            <select
                              value={p.traits?.[t.key] ?? ""}
                              onChange={(e) => {
                                const traits = { ...p.traits };
                                if (e.target.value === "") delete traits[t.key];
                                else traits[t.key] = Number(e.target.value) as VoiceTraitLevel;
                                setProfile(p.id, {
                                  traits: Object.keys(traits).length ? traits : undefined,
                                });
                              }}
                              className={field + " mt-1 text-[0.82rem]"}
                            >
                              <option value="">Not set</option>
                              {VOICE_TRAIT_LEVELS.map((label, n) => (
                                <option key={label} value={n}>
                                  {label[0]!.toUpperCase() + label.slice(1)}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {!active && (
                      <Button
                        tone="outline"
                        disabled={save.isPending || Boolean(invalid)}
                        onClick={() => setSwitching(p)}
                      >
                        Use {p.name.trim() || "this profile"}
                      </Button>
                    )}
                    {active && (
                      <Button
                        tone="quiet"
                        disabled={save.isPending}
                        onClick={() => commit({ ...draft, active: undefined })}
                      >
                        Stop using it
                      </Button>
                    )}
                    <Button
                      tone="quiet"
                      disabled={!s.tts.ok || missing || changed || speaking.status !== "idle"}
                      title={
                        changed
                          ? "Save first to hear the saved voice"
                          : !s.tts.ok || missing
                            ? "Set up voice at the top of this page to hear it"
                            : undefined
                      }
                      onClick={() => {
                        setTesting(p.id);
                        void speaker.say(SAMPLE, p.id);
                      }}
                    >
                      Hear {p.name.trim() || "it"}
                    </Button>
                    <Button
                      tone="quiet"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          profiles: draft.profiles.filter((x) => x.id !== p.id),
                          active: active ? undefined : draft.active,
                        })
                      }
                      aria-label={`Remove ${p.name}`}
                    >
                      Remove
                    </Button>
                  </div>
                  {testing === p.id && speaking.error && (
                    <p role="alert" className="mt-2 text-[0.8rem] text-bad">
                      {speaking.error}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            {draft.profiles.length < VOICE_PROFILE_LIMIT && (
              <Button
                tone="outline"
                onClick={() => {
                  const taken = new Set(draft.profiles.map((p) => p.id));
                  setDraft({
                    ...draft,
                    profiles: [
                      ...draft.profiles,
                      {
                        id: slug("new voice", taken),
                        name: "New voice",
                        voice: voices[0] ?? "",
                        persona: "",
                      },
                    ],
                  });
                }}
              >
                Add a profile
              </Button>
            )}
            <Button
              tone="primary"
              disabled={!changed || Boolean(invalid) || save.isPending}
              onClick={() => commit()}
            >
              Save voice settings
            </Button>
            {changed && (
              <Button tone="quiet" onClick={() => setDraft(null)}>
                Undo changes
              </Button>
            )}
          </div>
          {invalid && (
            <p className="mt-2 text-[0.78rem] text-bad">
              Every profile needs a name (letters, numbers, spaces, apostrophes, dots, or hyphens)
              and a voice.
            </p>
          )}
        </>
      )}
      <FormError error={save.error} />
    </div>
  );
}

/** Standard: Ember's one built-in voice, to hear, and where the characters are. */
export function StandardVoice({
  status,
  aiName,
  welcome = false,
}: {
  status: VoiceStatus;
  aiName: string;
  /** In the first-run welcome: no heading (the page has one), and Advanced is in Settings. */
  welcome?: boolean;
}) {
  const speaking = useSpeaker();
  const ready = status.builtin.state === "ready";
  return (
    <div className="mb-6 rounded-xl border border-line p-4" data-testid="voice-standard">
      {!welcome && <p className="mb-1 text-[0.95rem] text-ink">{aiName}&apos;s voice</p>}
      <p className="mb-3 text-[0.82rem] leading-relaxed text-muted">
        One clear voice, built into Hearth, that works on any computer. The five characters (the
        Guardian, the Operator, the Enchantress, the Scholar, and the Companion) each have their own
        voice and way of talking:{" "}
        {welcome
          ? "if you run your own speech machine, you can use them any time from Settings, Voice, Advanced."
          : "choose Advanced above to use them with your own speech machine."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={!ready || speaking.status !== "idle"}
          onClick={() => void speaker.say(SAMPLE)}
          data-testid="voice-standard-hear"
        >
          {speaking.status === "loading"
            ? "Getting it…"
            : speaking.status === "playing"
              ? "Playing…"
              : `Hear ${aiName}`}
        </Button>
        {speaking.status === "playing" && (
          <Button tone="quiet" onClick={() => speaker.stop()}>
            Stop
          </Button>
        )}
      </div>
      {speaking.error && (
        <p role="alert" className="mt-2 text-[0.8rem] text-bad">
          {speaking.error}
        </p>
      )}
    </div>
  );
}

/** A recording of the Standard voice, so it can be heard before anything is downloaded. */
const STANDARD_SAMPLE_URL = "/voice-samples/standard.mp3";

/** Plays the Standard voice's recorded sample (no download, no speech machine). */
export function StandardSampleButton({ label = "Hear a sample" }: { label?: string }) {
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => audio?.pause(), [audio]);
  const stop = () => {
    audio?.pause();
    setAudio(null);
  };
  const play = () => {
    speaker.stop();
    const a = new Audio(STANDARD_SAMPLE_URL);
    a.onended = () => setAudio(null);
    a.onerror = () => {
      setAudio(null);
      setFailed(true);
    };
    setFailed(false);
    setAudio(a);
    a.play().catch(() => {
      setAudio(null);
      setFailed(true);
    });
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        tone="quiet"
        onClick={audio ? stop : play}
        aria-pressed={Boolean(audio)}
        data-testid="voice-standard-sample"
      >
        {audio ? "Stop" : label}
      </Button>
      {failed && (
        <span role="alert" className="text-[0.78rem] text-bad">
          The sample couldn&apos;t play here.
        </span>
      )}
    </span>
  );
}

/**
 * Where voice comes from. Standard is built into Hearth: one voice that works, nothing to install
 * and no graphics card (it downloads once, by itself). Advanced is a speech machine (Piper and
 * Whisper) with the five character voices, for people who run one or have their AI set one up.
 * In the first-run welcome it says more, for people new to all of this.
 */
export function EngineChoice({
  status,
  busy,
  onChoose,
  welcome = false,
  aiName = "Ember",
}: {
  status: VoiceStatus;
  busy: boolean;
  onChoose: (engine: VoiceEngine) => void;
  welcome?: boolean;
  aiName?: string;
}) {
  const b = status.builtin;
  const card = (
    engine: VoiceEngine,
    title: string,
    badge: string | undefined,
    lines: ReactNode,
    extra?: ReactNode,
  ) => {
    const on = status.engine === engine;
    const id = `voice-engine-${engine}-${welcome ? "w" : "s"}`;
    return (
      <div
        className={
          "rounded-xl border p-4 " +
          (on ? "border-gold bg-gold/10" : "border-line-strong hover:border-gold/60")
        }
        data-testid={`voice-engine-${engine}`}
      >
        <label htmlFor={id} className="flex min-h-11 cursor-pointer gap-3">
          <input
            id={id}
            type="radio"
            name={welcome ? "voice-engine-welcome" : "voice-engine"}
            checked={on}
            disabled={busy}
            onChange={() => onChoose(engine)}
            className="mt-1 h-4 w-4 accent-[var(--color-gold)]"
          />
          <span>
            <span className="flex flex-wrap items-center gap-2 text-[0.95rem] text-ink">
              {title}
              {badge && <Tag>{badge}</Tag>}
            </span>
            <span className="block text-[0.82rem] leading-relaxed text-muted">{lines}</span>
          </span>
        </label>
        {extra && <div className="mt-2 pl-7 text-[0.78rem] text-faint">{extra}</div>}
      </div>
    );
  };
  const download =
    b.state === "ready"
      ? "Ready on this computer."
      : b.state === "downloading"
        ? `Getting ready: ${b.percent ?? 0}%`
        : `Downloads once by itself, about ${b.sizeMb} MB.`;
  return (
    <fieldset className="mb-6">
      <legend className="mb-2 text-[0.85rem] text-ink">
        {welcome ? "Choose how the voice works" : "Where the voice comes from"}
      </legend>
      <div className={welcome ? "grid gap-3" : "grid gap-3 sm:grid-cols-2"}>
        {card(
          "builtin",
          "Standard",
          welcome ? "Recommended" : undefined,
          welcome ? (
            <>
              One clear voice, built into Hearth. It works on any computer, even a basic laptop:
              nothing to install, no graphics card needed. {aiName} talks to you, and you can talk
              back.
            </>
          ) : (
            "Built into Hearth: one clear voice that just works. Nothing to install, no graphics card needed."
          ),
          <div className="flex flex-col gap-2">
            <span>{download}</span>
            <StandardSampleButton />
          </div>,
        )}
        {card(
          "machine",
          "Advanced",
          welcome ? "For experienced users" : undefined,
          welcome ? (
            <>
              The five character voices (the Guardian, the Operator, the Enchantress, the Scholar,
              and the Companion), each with its own way of talking. They need a speech machine:
              Piper (speaking) and Whisper (listening) installed and running, on this computer or
              another one at home. Best on a stronger PC, ideally with a graphics card.
            </>
          ) : (
            "Your own speech machine (Piper and Whisper), with the five character voices. For people who already run one."
          ),
          welcome ? (
            <>
              Not sure? Choose Standard. You can switch any time in Settings, Voice, and ask{" "}
              {aiName} to help you set up a speech machine when you&apos;re ready.
            </>
          ) : undefined,
        )}
      </div>
    </fieldset>
  );
}
