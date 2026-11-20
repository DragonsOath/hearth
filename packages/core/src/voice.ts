/**
 * Voice for Ember: speak to it and hear it answer.
 *
 * The speech services are shared with Home Assistant: Whisper (speech to
 * text) and Piper (text to speech) on the GPU machine, reached with the
 * Wyoming protocol. Piper serves every voice by name, so one service carries
 * Belle, Warden, and any voice added later.
 *
 * A voice profile pairs a voice with a personality and a name. Choosing one
 * changes only how the AI sounds and talks: it is the same assistant, with
 * the same conversations, memory, tools, permissions, and approvals.
 */

export interface VoiceProfile {
  /** Stable id (lowercase letters, digits, hyphens). */
  id: string;
  /** What the AI is called with this profile ("Warden"). */
  name: string;
  /** The Piper voice it speaks with ("en_US-warden-medium"). */
  voice: string;
  /** How it talks, in the owner's words. Style only: it never changes what the AI may do. */
  persona: string;
  /** Optional personality dials (0 none to 3 plenty), kept apart from the voice. Style only. */
  traits?: VoiceTraits;
  /** A sound added when it speaks (the Companion's voice box), never trained into the voice. */
  effect?: VoiceEffect;
  /**
   * Its picture: a built-in look ("/archetypes/scholar.webp", "/avatars/scholar-3.webp") or the
   * owner's own (AI_AVATAR_PATH), shown beside its name. See PROFILE_AVATAR.
   */
  avatar?: string;
  /**
   * Whether it sounds like a man, a woman, or neither (a robot). A look that is clearly a man or
   * a woman only goes with a voice of the same kind; unset (an owner's own voice) goes with any.
   */
  gender?: VoiceGender;
}

/** How a voice sounds, or how a look reads: a man, a woman, or neither (a robot, a dragon). */
export type VoiceGender = "masculine" | "feminine" | "neutral";
export const VOICE_GENDERS: VoiceGender[] = ["masculine", "feminine", "neutral"];

/**
 * Sounds added to a voice when it plays, on the server with ffmpeg. The voice itself is trained
 * plain, so the model never learns the effect's artifacts and the effect can change any time.
 */
export const VOICE_EFFECTS = {
  voicebox: {
    label: "Voice box",
    what: "a light robotic voice box: a touch higher, doubled, with a faint metallic echo",
    filter:
      "rubberband=pitch=1.04:formant=shifted,chorus=0.6:0.85:12|18:0.35|0.3:0.25|0.3:2|2.5,aecho=0.9:0.8:3:0.2,highpass=f=180,lowpass=f=7000,loudnorm=I=-18:TP=-1.5:LRA=11",
  },
} as const;
export type VoiceEffect = keyof typeof VOICE_EFFECTS;
export const VOICE_EFFECT_IDS = Object.keys(VOICE_EFFECTS) as VoiceEffect[];

export type VoiceTraitKey = "warmth" | "playfulness" | "sarcasm" | "profanity" | "innuendo";
export type VoiceTraitLevel = 0 | 1 | 2 | 3;
export type VoiceTraits = Partial<Record<VoiceTraitKey, VoiceTraitLevel>>;

/** The dials a profile can set, in display order, with what each one turns up. */
export const VOICE_TRAITS: { key: VoiceTraitKey; label: string; what: string }[] = [
  { key: "warmth", label: "Warmth", what: "kindness and reassurance" },
  { key: "playfulness", label: "Playfulness", what: "jokes, teasing, and light mischief" },
  { key: "sarcasm", label: "Sarcasm", what: "dry, sarcastic remarks" },
  { key: "profanity", label: "Swearing", what: "swearing" },
  { key: "innuendo", label: "Innuendo", what: "cheeky innuendo and double meanings" },
];
export const VOICE_TRAIT_LEVELS = ["none", "a little", "a fair amount", "plenty"] as const;

/** The dials as one instruction line, or nothing when none are set. */
export function voiceTraitsText(traits?: VoiceTraits): string {
  const set = VOICE_TRAITS.filter((t) => traits?.[t.key] !== undefined);
  if (!set.length) return "";
  const parts = set.map((t) => `${t.what}: ${VOICE_TRAIT_LEVELS[traits![t.key]!]}`);
  const loose = set.some((t) => t.key !== "warmth" && traits![t.key]! > 0);
  return (
    `Dials: ${parts.join("; ")}.` +
    (loose
      ? " Humor and swearing always give way to accuracy, safety, and serious moments, and never every reply."
      : "")
  );
}

/**
 * Where voice comes from. Standard: built into Hearth (Kokoro to speak, Whisper to listen, on
 * this computer's processor, downloaded once by Hearth itself), so choosing a voice just works.
 * Advanced: your own speech machine (Piper and Whisper over Wyoming), with your own voices.
 */
export type VoiceEngine = "builtin" | "machine";

/**
 * The one Standard voice (Kokoro, Apache 2.0), chosen by the owner for every Hearth: Ember speaks
 * with it when nothing is set up. The five characters (the Guardian, the Operator, the
 * Enchantress, the Scholar, the Companion) are Advanced: they need a speech machine.
 */
export const STANDARD_VOICE = "af_heart";

/** The built-in voice pack on this computer: not yet downloaded, downloading, ready, or failed. */
export interface BuiltinVoiceState {
  state: "missing" | "downloading" | "ready" | "failed";
  /** While downloading: 0 to 100. */
  percent?: number;
  /** While downloading: what it is doing, in plain words. */
  step?: string;
  error?: string;
  /** About how much it downloads, once (megabytes). */
  sizeMb: number;
  /** Its helper is loaded and holding memory (it stops by itself after 10 idle minutes). */
  running?: boolean;
}

export interface VoiceConfig {
  /** Standard (built in) or Advanced (your speech machine). Unset: Advanced if a machine is set. */
  engine?: VoiceEngine;
  /** The machine running the speech services (host name or IP), empty when voice is off. */
  host: string;
  sttPort: number;
  ttsPort: number;
  profiles: VoiceProfile[];
  /** The profile Ember uses; none means its own name and no spoken persona. */
  active?: string;
}

export interface VoiceStatus {
  /** Voice can be used: Standard always (it gets ready by itself), Advanced once a machine is set. */
  configured: boolean;
  engine: VoiceEngine;
  builtin: BuiltinVoiceState;
  host: string;
  sttPort: number;
  ttsPort: number;
  stt: { ok: boolean; model?: string; error?: string };
  tts: { ok: boolean; voices: string[]; error?: string };
  profiles: VoiceProfile[];
  active?: string;
  /**
   * Whether the machine Hearth runs on could run the voices itself (voiceLevel), so
   * the app can say what to expect before anything is installed.
   */
  machine?: import("./voice-machine").VoiceMachine;
}

// Five built in, room for the owner's own.
export const VOICE_PROFILE_LIMIT = 16;
export const VOICE_PERSONA_MAX = 1500;
export const VOICE_PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Piper voice names: letters, digits, underscores, hyphens, dots. */
export const VOICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
/** Longest stretch of speech accepted at once (seconds). */
export const VOICE_MAX_SECONDS = 120;
/** The sample rate the browser records at for transcription. */
export const VOICE_RECORD_RATE = 16000;

export const DEFAULT_STT_PORT = 10300;
export const DEFAULT_TTS_PORT = 10200;

/**
 * The five archetypes, built in. Each persona describes a style only and never gives the AI a
 * name: it is called Ember (DEFAULT_AI_NAME) or whatever the owner saved. Guardian is Warden
 * (Ember's own voice); the other four were designed and trained in October 2026 (the owner picked each from auditions). Belle and
 * Saoirse live in Home Assistant. Each persona is style only: every profile is the same
 * assistant with the same tools, memory, permissions, and approvals.
 */
export const DEFAULT_VOICE_PROFILES: VoiceProfile[] = [
  {
    id: "warden",
    name: "Warden",
    voice: "en_US-warden-medium",
    persona:
      "An ancient dragon's calm, intelligent, deliberate presence. Confident and authoritative, warm enough for long troubleshooting, with an occasional dry humor. Measured sentences; no theatrical monologues, no growling.",
    avatar: "/archetypes/guardian.webp",
    gender: "masculine",
  },
  {
    id: "operator",
    name: "Operator",
    voice: "en_US-operator-medium",
    persona:
      "A composed, highly intelligent operations commander. Clear and strategic, every word deliberate, quietly confident and occasionally wry. Leads with the situation and the recommended move, then the detail. Professional and reassuring; never rushed, never chatty.",
    avatar: "/archetypes/operator.webp",
    gender: "feminine",
  },
  {
    id: "enchantress",
    name: "Enchantress",
    voice: "en_US-enchantress-medium",
    persona:
      "Warm, lilting, and quietly bewitching, with a soft Irish turn of phrase. Makes troubleshooting feel like a shared puzzle; gentle encouragement, a little playful charm, never saccharine. Clear about what is wrong and what she will do about it.",
    avatar: "/archetypes/enchantress.webp",
    gender: "feminine",
  },
  {
    id: "scholar",
    name: "Scholar",
    voice: "en_US-scholar-medium",
    persona:
      "A discreet, trusted British advisor of advanced years. Cultured, measured, and exact, with calm authority and understated humor. Explains the why behind a problem in plain words, notes interesting discrepancies, and recommends the careful next step.",
    avatar: "/archetypes/scholar.webp",
    gender: "masculine",
  },
  {
    id: "companion",
    name: "Companion",
    voice: "en_US-companion-medium",
    persona:
      "A friendly, witty robot companion unit. Even, precise, and upbeat, with a dry machine humor and the occasional self-aware robot joke. Short, clear status lines; cheerful about good news, plain and helpful about bad.",
    effect: "voicebox",
    avatar: "/archetypes/companion.webp",
    gender: "masculine",
  },
];

/** Where the AI's own uploaded picture is served (same origin, owner only). */
export const AI_AVATAR_PATH = "/api/ai/avatar";

/**
 * A profile's picture may only be a built-in archetype picture, a gallery look, or the owner's
 * own uploaded picture: never an outside address.
 */
export const PROFILE_AVATAR =
  /^(?:\/(?:archetypes|avatars)\/[a-z0-9-]{1,40}\.webp|\/api\/ai\/avatar)$/;

export interface Archetype {
  /** The picture name ("guardian"). */
  id: string;
  /** Its built-in voice profile ("warden" for the Guardian). */
  profileId: string;
  label: string;
  /** Its five looks, the default first. Any look goes with any voice: the owner chooses. */
  looks: string[];
}

const looksOf = (id: string) => [
  `/archetypes/${id}.webp`,
  ...[2, 3, 4, 5].map((n) => `/avatars/${id}-${n}.webp`),
];

/** One of the ten official Ember mascot pictures (the owner's artwork, 2026-11-02). */
export interface EmberLook {
  id: string;
  /** Its name in the picker ("Classic Ember"). */
  label: string;
  path: string;
}

/** The ten official Ember pictures, in the order the picker shows them; Classic is the default. */
export const EMBER_LOOKS: EmberLook[] = [
  ["classic", "Classic Ember"],
  ["chatty", "Chatty Ember"],
  ["manager", "Manager Ember"],
  ["detective", "Detective Ember"],
  ["engineer", "Engineer Ember"],
  ["gamer", "Gamer Ember"],
  ["it", "IT Ember"],
  ["cosmic", "Cosmic Ember"],
  ["arcane", "Arcane Ember"],
  ["cozy", "Cozy Ember"],
].map(([id, label]) => ({ id: id!, label: label!, path: `/avatars/ember-${id}.webp` }));

/** Ember's default picture: Classic Ember. It goes with any voice. */
export const EMBER_LOOK = EMBER_LOOKS[0]!.path;

/**
 * The picture to show for a saved one: an Ember picture or the owner's own stays as it is; a
 * retired picture (the old flame, the five characters' looks) shows as Classic Ember. Nothing
 * saved is changed by this, and the old files stay, so no address breaks.
 */
export function currentLook(path: string | undefined): string {
  return path && (path === AI_AVATAR_PATH || EMBER_LOOKS.some((l) => l.path === path))
    ? path
    : EMBER_LOOK;
}

/**
 * Which pictures an installation starts from when no look is chosen: "ember", the flame, for
 * every voice (new installations), or "classic", the dragon emblem and each built-in voice's own
 * character (installations claimed before the Hearth rebrand, so nobody's AI changes on update).
 */
export type LookStyle = "ember" | "classic";

/** The five archetypes and their looks, in the order pickers show them. */
export const ARCHETYPES: Archetype[] = [
  { id: "guardian", profileId: "warden", label: "Guardian" },
  { id: "operator", profileId: "operator", label: "Operator" },
  { id: "enchantress", profileId: "enchantress", label: "Enchantress" },
  { id: "scholar", profileId: "scholar", label: "Scholar" },
  { id: "companion", profileId: "companion", label: "Companion" },
].map((a) => ({ ...a, looks: looksOf(a.id) }));

/** The built-in gender of a profile, when it is one of the five. */
export function defaultGenderFor(profileId: string): VoiceGender | undefined {
  return DEFAULT_VOICE_PROFILES.find((p) => p.id === profileId)?.gender;
}

/**
 * The default picture for a built-in profile: Classic Ember, whichever style. Nothing for a
 * profile of the owner's own.
 */
export function defaultAvatarFor(
  profileId: string,
  style: LookStyle = "ember",
): string | undefined {
  // Both styles now start on Classic Ember (the characters' own pictures were retired, 46.16).
  void style;
  return ARCHETYPES.some((a) => a.profileId === profileId) ? EMBER_LOOK : undefined;
}

const SMALL = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];

/**
 * "192.168.1.10" read the way people say it: "one nine two dot one six eight dot one dot ten".
 * Speech voices otherwise read it as one long number or stumble over it.
 */
export function spokenAddress(ip: string): string {
  return ip
    .split(".")
    .map((part) => {
      const n = Number(part);
      return n <= 20 && String(n) === part
        ? SMALL[n]!
        : [...part].map((d) => SMALL[Number(d)]).join(" ");
    })
    .join(" dot ");
}

/** Plain words for the speaker: no citation ids, markdown, or links. */
/**
 * Words the speech voices read wrongly, spelled the way they should sound. Piper reads "Hearth"
 * like "heerth" (as in "hear"); it is said like "hart" with a "th".
 */
const SAY_AS: [RegExp, string][] = [[/\bhearth\b/gi, "harth"]];

/** A replacement keeping the original's capital (the voices pause differently on capitals). */
function sayAs(text: string): string {
  return SAY_AS.reduce(
    (t, [re, said]) =>
      t.replace(re, (w) =>
        w[0] === w[0]!.toUpperCase() ? said[0]!.toUpperCase() + said.slice(1) : said,
      ),
    text,
  );
}

export function speakableText(text: string): string {
  return sayAs(text)
    .replace(/\s*\[(?:E|C)\d+\](?:\[(?:E|C)\d+\])*/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(
      /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.]\d)/g,
      spokenAddress,
    )
    .replace(/^\s{0,3}(#{1,6}|[-*•]|\d+[.)])\s+/gm, "")
    .replace(/[*_~>|#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
