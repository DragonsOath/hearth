import type { MaCall } from "./music-assistant-api";

/**
 * Add a music service (11-05: "What opens if you connect Spotify or Apple or Plex", users
 * must never do manual linking). Every music service Music Assistant has, set up from Hearth:
 * Music Assistant's own setup for that service, a step at a time, shown in Hearth. A step is a
 * form (its questions), a page to open (a sign-in; Music Assistant receives the answer itself
 * and the setup moves on), or progress. Spotify, Tidal, Plex and the rest sign in with Music
 * Assistant's own apps, so nobody makes a developer app. YouTube Music keeps Hearth's own setup
 * (Google refuses the sign-in page in an app's window; see music-assistant-link.ts).
 *
 * Values typed into a form go to Music Assistant only; Hearth keeps none of them, and Music
 * Assistant never sends a stored secret back into a form.
 */

export interface MusicService {
  domain: string;
  name: string;
  description?: string;
  /** Already added in Music Assistant (and, for one-per-home services, can't be added again). */
  added: boolean;
  /** Can be added more than once (a second account, another share). */
  more: boolean;
  /** Not finished in Music Assistant yet (beta). */
  beta: boolean;
  kind: "streaming" | "library" | "radio" | "podcasts" | "audiobooks" | "files";
}

export interface ServiceField {
  key: string;
  type: "text" | "secret" | "boolean" | "number" | "choice" | "note";
  label: string;
  required: boolean;
  description?: string;
  value?: string | number | boolean;
  options?: { title: string; value: string | number }[];
}

export interface ServiceStep {
  flowId?: string;
  stepId: string;
  type: "form" | "external" | "progress" | "finish" | "abort";
  fields: ServiceField[];
  errors: Record<string, string>;
  url?: string;
  text?: string;
  reason?: string;
}

/** The ones most homes use, first, in this order. */
const POPULAR = [
  "spotify",
  "ytmusic",
  "apple_music",
  "tidal",
  "deezer",
  "qobuz",
  "soundcloud",
  "plex",
  "jellyfin",
  "emby",
  "opensubsonic",
  "audiobookshelf",
  "filesystem_smb",
  "filesystem_local",
  "tunein",
  "radiobrowser",
  "siriusxm",
  "pandora",
  "bandcamp",
];
/** Music Assistant's own parts, tests and very early ones: not offered. */
const HIDDEN = new Set(["builtin", "test"]);
const KIND: Record<string, MusicService["kind"]> = {
  plex: "library",
  jellyfin: "library",
  emby: "library",
  opensubsonic: "library",
  webdav: "files",
  filesystem_smb: "files",
  filesystem_local: "files",
  filesystem_nfs: "files",
  filesystem_google_drive: "files",
  filesystem_onedrive: "files",
  audiobookshelf: "audiobooks",
  audible: "audiobooks",
  storytel: "audiobooks",
  gpodder: "podcasts",
  overcast: "podcasts",
  pocketcasts: "podcasts",
  podcastfeed: "podcasts",
  podcast_index: "podcasts",
  itunes_podcasts: "podcasts",
};
const isRadio = (domain: string, name: string) =>
  /radio|tunein|somafm|nts|sounds|radiothek|siriusxm|digitally|paradise|ambient|rain/i.test(
    `${domain} ${name}`,
  );

/** The music services this Music Assistant can add, the popular ones first. */
export async function musicServices(call: MaCall): Promise<MusicService[]> {
  const [manifests, configs] = await Promise.all([
    call<
      {
        type?: string;
        domain?: string;
        name?: string;
        description?: string;
        builtin?: boolean;
        stage?: string;
        multi_instance?: boolean;
      }[]
    >("providers/manifests"),
    call<{ domain?: string }[]>("config/providers").catch(() => []),
  ]);
  const have = new Set((Array.isArray(configs) ? configs : []).map((c) => c.domain));
  const rank = (d: string) => {
    const i = POPULAR.indexOf(d);
    return i < 0 ? POPULAR.length : i;
  };
  return (Array.isArray(manifests) ? manifests : [])
    .filter(
      (m) =>
        m.type === "music" &&
        m.domain &&
        m.name &&
        !m.builtin &&
        !HIDDEN.has(m.domain) &&
        !["alpha", "experimental"].includes(String(m.stage)),
    )
    .map((m) => ({
      domain: m.domain!,
      name: m.name!.replace(/ Media Server Library$/, "").slice(0, 80),
      ...(m.description ? { description: String(m.description).slice(0, 240) } : {}),
      added: have.has(m.domain),
      more: Boolean(m.multi_instance),
      beta: ["beta", "unmaintained"].includes(String(m.stage)),
      kind: KIND[m.domain!] ?? (isRadio(m.domain!, m.name!) ? "radio" : "streaming"),
    }))
    .sort((a, b) => rank(a.domain) - rank(b.domain) || a.name.localeCompare(b.name));
}

const words = (s: string) =>
  s
    .replace(/[_.]+/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();

type RawEntry = {
  key?: string;
  type?: string;
  label?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  default_value?: unknown;
  value?: unknown;
  options?: { title?: string; value?: unknown }[] | null;
};
type RawStep = {
  flow_id?: string;
  step_id?: string;
  type?: string;
  entries?: RawEntry[] | null;
  errors?: Record<string, unknown> | null;
  url?: string | null;
  progress_text?: string | null;
  reason?: string | null;
};

const scalar = (v: unknown): string | number | boolean | undefined =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : undefined;

/** A field as Hearth shows it (a stored secret is never sent back). */
function fieldOf(e: RawEntry): ServiceField | undefined {
  if (!e.key || e.hidden) return undefined;
  const t = String(e.type ?? "string");
  const options = (e.options ?? [])
    .map((o) => {
      const v = scalar(o.value);
      return v === undefined || typeof v === "boolean"
        ? undefined
        : { title: String(o.title ?? v).slice(0, 120), value: v };
    })
    .filter((o): o is { title: string; value: string | number } => Boolean(o));
  const type: ServiceField["type"] =
    t === "secure_string"
      ? "secret"
      : t === "boolean"
        ? "boolean"
        : t === "integer" || t === "float"
          ? "number"
          : t === "label" || t === "divider" || t === "alert"
            ? "note"
            : options.length
              ? "choice"
              : "text";
  const value = type === "secret" ? undefined : scalar(e.value ?? e.default_value);
  return {
    key: e.key.slice(0, 120),
    type,
    label: String(e.label || words(e.key)).slice(0, 200),
    required: Boolean(e.required) && type !== "note",
    ...(e.description ? { description: String(e.description).slice(0, 400) } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(options.length ? { options: options.slice(0, 100) } : {}),
  };
}

/** Music Assistant's step as Hearth shows it. */
export function stepOf(raw: RawStep | undefined): ServiceStep {
  const type = String(raw?.type ?? "abort");
  const t: ServiceStep["type"] = ["form", "external", "progress", "finish", "abort"].includes(type)
    ? (type as ServiceStep["type"])
    : "abort";
  const url = raw?.url && /^https?:\/\//.test(raw.url) ? raw.url.slice(0, 4000) : undefined;
  return {
    ...(raw?.flow_id ? { flowId: String(raw.flow_id) } : {}),
    stepId: String(raw?.step_id ?? t),
    type: t,
    fields: (raw?.entries ?? []).map(fieldOf).filter((f): f is ServiceField => Boolean(f)),
    errors: Object.fromEntries(
      Object.entries(raw?.errors ?? {}).map(([k, v]) => [k, words(String(v))]),
    ),
    ...(url ? { url } : {}),
    ...(raw?.progress_text ? { text: String(raw.progress_text).slice(0, 300) } : {}),
    ...(raw?.reason ? { reason: words(String(raw.reason)) } : {}),
  };
}

const FLOW = /^[\w-]{4,100}$/;

/** Starts adding a service: its first step (or finished at once, for one with no questions). */
export async function serviceStart(call: MaCall, domain: string) {
  if (!/^[a-z0-9_]{2,60}$/.test(domain)) throw new Error("Not a music service.");
  return stepOf(await call<RawStep>("config/providers/setup", { provider_domain: domain }));
}

/** Answers a form step. */
export async function serviceSubmit(
  call: MaCall,
  flowId: string,
  values: Record<string, string | number | boolean>,
) {
  if (!FLOW.test(flowId)) throw new Error("Not a setup Hearth started.");
  return stepOf(await call<RawStep>("config/flows/submit", { flow_id: flowId, values }));
}

/** The step a setup is on now (after a sign-in page, it moves on by itself). */
export async function serviceStep(call: MaCall, flowId: string) {
  if (!FLOW.test(flowId)) throw new Error("Not a setup Hearth started.");
  return stepOf(await call<RawStep>("config/flows/get", { flow_id: flowId }));
}

export async function serviceAbort(call: MaCall, flowId: string) {
  if (!FLOW.test(flowId)) return;
  await call("config/flows/abort", { flow_id: flowId }).catch(() => undefined);
}
