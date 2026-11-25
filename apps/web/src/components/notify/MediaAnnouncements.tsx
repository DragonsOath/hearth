import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_MEDIA_ANNOUNCE,
  kindsFor,
  type AnnounceKind,
  type AnnounceTemplate,
  type DiscordEmbed,
  type LineTone,
  type MediaAnnounceSettings,
} from "@dragon-control/core";
import { api, useAiName } from "../../data/api";
import { Button, cx } from "../ui";
import { ago } from "../../lib/format";
import { squareJpeg } from "../shell/OwnerAvatar";

/**
 * Media announcements (Notifications): design how new movies, shows, music, books, comics, games
 * and podcasts are announced, preview it
 * exactly as Discord will show it (the server renders the preview with the same function it sends
 * with), send a clearly marked test, and see what went out. Where they go is chosen above, under
 * "What goes where" (New in your library).
 */

interface Delivery {
  key: string;
  title: string;
  kind: string;
  channelId: string;
  channel: string;
  status: "pending" | "sent" | "failed" | "skipped";
  attempts: number;
  error?: string;
  dueAt: string;
  sentAt?: string;
}

interface AnnounceState {
  settings: MediaAnnounceSettings;
  servers: { serviceId: string; server: string; name: string; parts: string[] }[];
  history: Delivery[];
  destinations: { id: string; name: string; audience: string }[];
  baseline: Record<string, string>;
}

export interface Preview {
  payload: { username: string; content?: string; embeds: DiscordEmbed[] };
  images: Record<string, string>;
  /** Saved Discord channel names by id, so mentions show "#movie-chat" as Discord will. */
  channels?: Record<string, string>;
}

const ChannelNames = createContext<Record<string, string>>({});

/** One mention pill: the saved channel's name when Hearth knows it. */
function Mention({ kind, id }: { kind: string; id: string }) {
  const names = useContext(ChannelNames);
  const label = kind === "#" ? `# ${names[id] ?? "channel"}` : kind === "@&" ? "@role" : "@someone";
  return (
    <span
      title={names[id] ? undefined : "Discord shows the name here"}
      data-testid="discord-mention"
      className="rounded bg-[#5865f2]/30 px-1 font-medium text-[#c9cdfb]"
    >
      {label}
    </span>
  );
}

const VIDEO_APPS = ["plex", "jellyfin"];

/** Each kind, and the apps it comes from (only kinds this Hearth has an app for are offered). */
const KINDS: { id: AnnounceKind; label: string; from: string[] }[] = [
  { id: "movie", label: "Movies", from: VIDEO_APPS },
  { id: "series", label: "New series", from: VIDEO_APPS },
  { id: "season", label: "New seasons", from: VIDEO_APPS },
  { id: "episode", label: "Episodes", from: VIDEO_APPS },
  { id: "album", label: "Music (albums)", from: [...VIDEO_APPS, "navidrome"] },
  { id: "audiobook", label: "Audiobooks", from: ["audiobookshelf"] },
  { id: "book", label: "Ebooks", from: ["audiobookshelf", "kavita"] },
  { id: "comic", label: "Comics", from: ["kavita"] },
  { id: "game", label: "Games", from: ["romm"] },
  { id: "podcast", label: "Podcast episodes", from: ["audiobookshelf"] },
];
const VIDEO = new Set<AnnounceKind>(["movie", "series", "season", "episode"]);

const TONES: { id: LineTone; name: string; text: string }[] = [
  { id: "playful", name: "Playful", text: "A light, friendly line that fits the title." },
  { id: "gentle", name: "Gentle", text: "Warm and plain. Good for a family channel." },
  { id: "off", name: "Off", text: "Just the post." },
];

const listed = (xs: string[]) =>
  xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

const TEMPLATES: { id: AnnounceTemplate; name: string; text: string }[] = [
  {
    id: "banner",
    name: "Banner",
    text: "Title, details and poster on the backdrop, like a streaming app.",
  },
  {
    id: "cinematic",
    name: "Cinematic",
    text: "Poster beside the title, details, synopsis and trailer.",
  },
  { id: "streaming", name: "Streaming style", text: "A wide backdrop under a short description." },
  {
    id: "compact",
    name: "Compact",
    text: "Small poster, title and a line. Good for busy channels.",
  },
];

const ACCENTS = ["#ff7a1a", "#e5484d", "#30a46c", "#3e63dd", "#8e4ec6", "#d6409f", "#6f6e77"];

const SHOW: { key: keyof MediaAnnounceSettings["show"]; label: string }[] = [
  { key: "art", label: "Poster or backdrop" },
  { key: "synopsis", label: "Synopsis" },
  { key: "genre", label: "Genre" },
  { key: "runtime", label: "Length (movies, albums, audiobooks)" },
  { key: "rating", label: "Ratings" },
  { key: "trailer", label: "Trailer link (only when a verified one exists)" },
  { key: "availability", label: "Available in (which app has it)" },
];

/** Discord's <t:unix:F> and <t:unix:R>: each reader sees it in their own time. */
function discordTime(text: string): string {
  return text.replace(/<t:(\d+):([FR])>/g, (_, secs: string, style: string) => {
    const d = new Date(Number(secs) * 1000);
    if (style === "F")
      return d.toLocaleString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    const mins = Math.round((d.getTime() - Date.now()) / 60_000);
    const abs = Math.abs(mins);
    const unit =
      abs >= 1440
        ? `${Math.round(abs / 1440)} days`
        : abs >= 60
          ? `${Math.round(abs / 60)} hours`
          : `${abs} minutes`;
    return mins >= 0 ? `in ${unit}` : `${unit} ago`;
  });
}

/**
 * Discord's channel and role mentions (<#id>, <@&id>, <@id>): Discord shows the name, which Hearth
 * cannot look up without a bot, so the preview shows a mention pill like Discord's.
 */
function mentions(text: string, key: string): ReactNode[] {
  return text.split(/(<(?:#|@&|@!?)\d{5,25}>)/).map((s, j) => {
    const m = /^<(#|@&|@!?)(\d+)>$/.exec(s);
    if (!m) return s;
    return <Mention key={`${key}-${j}`} kind={m[1]!} id={m[2]!} />;
  });
}

/** Discord's own bits of markdown that announcements use: *italic*, **bold**, [link](url). */
function Md({ text: raw }: { text: string }) {
  const text = discordTime(raw);
  const parts: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(...mentions(text.slice(last, m.index), `p${i++}`));
    if (m[1]) parts.push(<strong key={i++}>{mentions(m[1], `b${i}`)}</strong>);
    else if (m[2]) parts.push(<em key={i++}>{mentions(m[2], `e${i}`)}</em>);
    else
      parts.push(
        <a
          key={i++}
          href={m[4]}
          target="_blank"
          rel="noreferrer"
          className="text-[#00a8fc] hover:underline"
        >
          {m[3]}
        </a>,
      );
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(...mentions(text.slice(last), `p${i}`));
  return <>{parts}</>;
}

/** A close copy of how Discord draws a webhook message with one embed. */
/** The sender's picture: the Discord webhook's own, else the Hearth icon (as Hearth sets it). */
export const SENDER_PICTURE = "/api/media-announce/sender-picture";
const DEFAULT_PICTURE = "/icon-192.png";

export function DiscordPreview({
  preview,
  testId = "announce-preview",
  pictureVersion = 0,
}: {
  preview: Preview;
  testId?: string;
  /** Changes after a new picture is chosen, so the preview shows it. */
  pictureVersion?: number;
}) {
  const { payload, images, channels = {} } = preview;
  const [noPicture, setNoPicture] = useState(false);
  const src = (url?: string) =>
    url?.startsWith("attachment://") ? images[url.slice(13)] : undefined;
  // Discord shows a picture the card does not use above the card (a movie night's banner).
  const used = new Set(
    payload.embeds.flatMap((e) =>
      [e.thumbnail?.url, e.image?.url]
        .filter((u): u is string => Boolean(u))
        .map((u) => u.slice(13)),
    ),
  );
  const loose = Object.entries(images).filter(([name]) => !used.has(name));
  return (
    <ChannelNames.Provider value={channels}>
      <div
        className="rounded-lg bg-[#313338] p-4 font-sans text-[0.9rem] text-[#dbdee1]"
        data-testid={testId}
      >
        <div className="flex gap-3">
          <img
            key={pictureVersion}
            src={noPicture ? DEFAULT_PICTURE : `${SENDER_PICTURE}?v=${pictureVersion}`}
            onError={() => setNoPicture(true)}
            alt=""
            data-testid={`${testId}-picture`}
            className="h-10 w-10 shrink-0 rounded-full bg-[#1e1f22] object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5">
              <span className="font-medium text-white">{payload.username}</span>
              <span className="rounded bg-[#5865f2] px-1 text-[0.62rem] font-semibold text-white">
                APP
              </span>
              <span className="text-[0.72rem] text-[#949ba4]">Today</span>
            </p>
            {payload.content && <p className="mt-1">{payload.content}</p>}
            {loose.map(([name, url]) => (
              <img
                key={name}
                src={url}
                alt=""
                className="mt-1 w-full max-w-[520px] rounded-lg"
                data-testid={`${testId}-banner`}
              />
            ))}
            {payload.embeds.map((e, i) => {
              const thumb = src(e.thumbnail?.url);
              const image = src(e.image?.url);
              const color = `#${(e.color ?? 0).toString(16).padStart(6, "0")}`;
              return (
                <div
                  key={i}
                  className="mt-1 max-w-[520px] rounded border-l-4 bg-[#2b2d31] p-3"
                  style={{ borderLeftColor: color }}
                >
                  <div className="flex gap-3">
                    <div className="min-w-0 flex-1">
                      {e.author && (
                        <p className="flex items-center gap-2 text-[0.8rem] font-medium text-white">
                          {/* Messenger Ember beside her line, as Discord shows it (the app's own
                              copy, so the preview needs nothing from the internet). */}
                          {e.author.icon_url && (
                            <img
                              src="/brand/ember-messenger.png"
                              alt=""
                              className="h-6 w-6 shrink-0 rounded-full"
                              data-testid="announce-preview-ember"
                            />
                          )}
                          <span>{e.author.name}</span>
                        </p>
                      )}
                      {e.title && (
                        <p
                          className="mt-1 font-semibold text-white"
                          data-testid="announce-preview-title"
                        >
                          {e.title}
                        </p>
                      )}
                      {e.description && (
                        <div className="mt-1 space-y-2 text-[0.85rem] whitespace-pre-line">
                          {e.description.split("\n\n").map((p, j) =>
                            // Discord's quote: a bar beside the text (a movie night's note).
                            p.startsWith(">") ? (
                              <blockquote
                                key={j}
                                className="border-l-4 border-[#4e5058] pl-3"
                                data-testid={`${testId}-quote`}
                              >
                                <Md text={p.replace(/^> ?/gm, "")} />
                              </blockquote>
                            ) : (
                              <p key={j}>
                                <Md text={p} />
                              </p>
                            ),
                          )}
                        </div>
                      )}
                    </div>
                    {thumb && (
                      <img src={thumb} alt="" className="h-28 w-20 shrink-0 rounded object-cover" />
                    )}
                  </div>
                  {e.fields && e.fields.length > 0 && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {e.fields.map((f, j) => (
                        <div key={j} className={f.inline ? "" : "sm:col-span-2"}>
                          <p className="text-[0.78rem] font-semibold text-white">{f.name}</p>
                          <p className="text-[0.85rem] whitespace-pre-line">
                            <Md text={f.value} />
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                  {image && (
                    <img
                      src={image}
                      alt=""
                      className="mt-3 max-h-60 w-full rounded object-cover"
                      data-testid={`${testId}-wide`}
                    />
                  )}
                  {e.footer && (
                    <p className="mt-2 text-[0.72rem] text-[#949ba4]">{e.footer.text}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </ChannelNames.Provider>
  );
}

/**
 * The picture beside every announcement: chosen from this device, made a small square here, and
 * set on the Discord destinations themselves (Discord keeps it, so every post shows it).
 */
function SenderPicture({ onChanged }: { onChanged: () => void }) {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const change = useMutation({
    mutationFn: async (file: File) =>
      api<{ set: string[]; failed: { name: string; error: string }[] }>(
        "PUT",
        "/api/media-announce/sender-picture",
        { data: await squareJpeg(file) },
      ),
    onSuccess: (r) => {
      onChanged();
      setNote(
        r.failed.length
          ? {
              ok: false,
              text: `${r.set.length ? `Changed on ${r.set.join(", ")}. ` : ""}Not changed on ${r.failed
                .map((f) => `${f.name} (${f.error})`)
                .join(", ")}.`,
            }
          : { ok: true, text: `Changed on ${r.set.join(", ")}.` },
      );
    },
    onError: (e) => setNote({ ok: false, text: (e as Error).message }),
  });
  return (
    <div>
      <p className="mb-1.5 text-[0.85rem] text-muted">Sender picture</p>
      <div className="flex flex-wrap items-center gap-3">
        <label
          className={cx(
            "inline-flex min-h-10 cursor-pointer items-center rounded-lg border border-line-strong px-4 text-[0.85rem] text-ink hover:border-gold/60",
            change.isPending && "pointer-events-none opacity-60",
          )}
        >
          {change.isPending ? "Changing…" : "Choose picture"}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            data-testid="announce-picture-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) change.mutate(file);
            }}
          />
        </label>
        <p className="text-[0.78rem] text-faint">
          Shown beside every post on your Discord destinations. Until you choose one, they use the
          Hearth icon.
        </p>
      </div>
      {note && (
        <p
          className={cx("mt-1.5 text-[0.8rem]", note.ok ? "text-ok" : "text-bad")}
          data-testid="announce-picture-note"
        >
          {note.text}
        </p>
      )}
    </div>
  );
}

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-[0.86rem] text-ink">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[var(--color-gold)]"
      />
      {label}
    </label>
  );
}

export function MediaAnnouncements() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["media-announce"],
    queryFn: () => api<AnnounceState>("GET", "/api/media-announce"),
  });
  const [draft, setDraft] = useState<MediaAnnounceSettings | null>(null);
  const [kind, setKind] = useState<AnnounceKind>("movie");
  const [pictureVersion, setPictureVersion] = useState(0);
  const [sample, setSample] = useState<string>("");
  const [dest, setDest] = useState<string>("");
  const aiName = useAiName();
  const samples = useQuery({
    queryKey: ["media-announce-samples", kind],
    queryFn: () =>
      api<{ key: string; title: string }[]>("GET", `/api/media-announce/samples?kind=${kind}`),
  });
  // The chosen title, or the newest one when nothing (or a title of another kind) is chosen.
  const chosen = samples.data?.some((x) => x.key === sample)
    ? sample
    : (samples.data?.[0]?.key ?? "");
  const s = draft ?? q.data?.settings ?? DEFAULT_MEDIA_ANNOUNCE;
  const previewKey = useMemo(() => JSON.stringify([chosen, s, dest]), [chosen, s, dest]);
  const preview = useQuery({
    queryKey: ["media-announce-preview", previewKey],
    queryFn: () =>
      api<Preview>("POST", "/api/media-announce/preview", {
        key: chosen,
        settings: s,
        ...(dest ? { channelId: dest } : {}),
      }),
    enabled: Boolean(chosen),
    placeholderData: (old) => old,
  });
  const save = useMutation({
    mutationFn: () => api<MediaAnnounceSettings>("PUT", "/api/media-announce", s),
    onSuccess: (saved) => {
      setDraft(saved);
      void qc.invalidateQueries({ queryKey: ["media-announce"] });
    },
  });
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; error?: string }>("POST", "/api/media-announce/test", {
        key: chosen,
        channelId: dest,
        settings: s,
      }),
  });
  const check = useMutation({
    mutationFn: () => api<Delivery[]>("POST", "/api/media-announce/check", {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["media-announce"] });
      void qc.invalidateQueries({ queryKey: ["media-announce-samples"] });
    },
  });
  const retry = useMutation({
    mutationFn: (d: Delivery) =>
      api<Delivery[]>("POST", "/api/media-announce/retry", { key: d.key, channelId: d.channelId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["media-announce"] }),
  });

  if (!q.data) return <p className="text-[0.9rem] text-muted">Loading…</p>;
  const data = q.data;
  const set = (patch: Partial<MediaAnnounceSettings>) => setDraft({ ...s, ...patch });
  const look = s.looks[kind];
  const setLook = (patch: Partial<typeof look>) =>
    set({ looks: { ...s.looks, [kind]: { ...look, ...patch } } });
  const changed = JSON.stringify(s) !== JSON.stringify(data.settings);
  const allDestinations = data.destinations;
  // Only what this Hearth has an app for: no Games switch without RomM.
  const has = (k: (typeof KINDS)[number]) =>
    VIDEO.has(k.id) || k.from.some((a) => data.servers.some((x) => x.server === a));
  const offered = KINDS.filter(has);
  const libraryKinds = offered.filter((k) => !VIDEO.has(k.id));
  const videoKinds = offered.filter((k) => VIDEO.has(k.id));
  const setFor = (
    id: string,
    patch: { types?: Partial<Record<AnnounceKind, boolean>>; tone?: LineTone | undefined },
  ) => {
    const mine = { ...(s.destinations[id] ?? {}) };
    if ("types" in patch) mine.types = { ...(mine.types ?? {}), ...patch.types };
    if ("tone" in patch) {
      if (patch.tone) mine.tone = patch.tone;
      else delete mine.tone;
    }
    set({ destinations: { ...s.destinations, [id]: mine } });
  };
  const resetFor = (id: string) => {
    const rest = { ...s.destinations };
    delete rest[id];
    set({ destinations: rest });
  };
  const posting = offered.filter((k) => s.types[k.id]);

  return (
    <div data-testid="media-announcements">
      <p className="mb-4 max-w-3xl text-[0.86rem] leading-relaxed text-muted">
        When something becomes available in your library (not just downloaded), Hearth can announce
        it with its artwork and details: movies and shows from Plex or Jellyfin, and, when you turn
        them on, music, audiobooks, ebooks, comics, games and podcasts from the apps that hold them.
        Pick where above under <span className="text-ink">New in your library</span> (a friends and
        family destination is ideal). What is already in your libraries is never announced, and
        personal media (photos, home videos) never is.
      </p>
      {data.servers.length === 0 ? (
        <p className="mb-4 text-[0.86rem] text-amber" data-testid="announce-no-servers">
          Add Plex, Jellyfin or another library app with a key first: announcements come from their
          libraries.
        </p>
      ) : (
        <p className="mb-4 text-[0.8rem] text-faint">
          Watching {listed(data.servers.map((x) => x.name))}
          {Object.keys(data.baseline).length
            ? ", checked every few minutes."
            : ". The first check notes what is there already."}{" "}
          <button
            type="button"
            className="text-gold hover:underline"
            onClick={() => check.mutate()}
            disabled={check.isPending}
            data-testid="announce-check"
          >
            {check.isPending ? "Checking…" : "Check now"}
          </button>
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          {/* What posts is one visible checklist; the tabs below only choose which look to edit. */}
          <fieldset data-testid="announce-kinds">
            <legend className="mb-1 text-[0.85rem] text-muted">What to post</legend>
            <div className="grid grid-cols-2 gap-x-4">
              {videoKinds.map((k) => (
                <Check
                  key={k.id}
                  checked={s.types[k.id]}
                  onChange={(v) => set({ types: { ...s.types, [k.id]: v } })}
                  label={k.label}
                />
              ))}
            </div>
            {libraryKinds.length > 0 && (
              <div className="mt-3" data-testid="announce-library-kinds">
                <p className="text-[0.8rem] text-muted">More from your library</p>
                <div className="grid grid-cols-2 gap-x-4">
                  {libraryKinds.map((k) => (
                    <Check
                      key={k.id}
                      checked={s.types[k.id]}
                      onChange={(v) => set({ types: { ...s.types, [k.id]: v } })}
                      label={k.label}
                    />
                  ))}
                </div>
                <p className="mt-1 text-[0.75rem] text-faint">
                  Off until you turn them on. Several at once go out as one post, like “6 new
                  albums”.
                </p>
              </div>
            )}
            <p className="mt-1 text-[0.8rem] text-muted" data-testid="announce-kinds-summary">
              {posting.length
                ? `Posting: ${posting.map((k) => k.label.toLowerCase()).join(", ")}.`
                : "Nothing is posted until you tick at least one."}
            </p>
          </fieldset>

          <div>
            <p className="mb-2 text-[0.85rem] text-muted">Design the post for</p>
            <div role="tablist" aria-label="Which post to design" className="flex flex-wrap gap-2">
              {offered.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  role="tab"
                  aria-selected={kind === k.id}
                  onClick={() => setKind(k.id)}
                  className={cx(
                    "min-h-10 rounded-full border px-4 text-[0.82rem]",
                    kind === k.id
                      ? "border-gold/60 bg-gold/10 text-gold"
                      : "border-line text-muted hover:text-ink",
                  )}
                >
                  {k.label}
                  <span className="ml-1.5 text-[0.72rem] opacity-80">
                    {s.types[k.id] ? "· on" : "· off"}
                  </span>
                </button>
              ))}
            </div>
            {!s.types[kind] && (
              <p className="mt-2 text-[0.8rem] text-muted">
                {KINDS.find((k) => k.id === kind)?.label} are not posted. Tick them under What to
                post to turn them on.
              </p>
            )}
          </div>

          <fieldset>
            <legend className="mb-2 text-[0.85rem] text-muted">Style</legend>
            <div className="grid gap-2">
              {TEMPLATES.map((tp) => (
                <label
                  key={tp.id}
                  className={cx(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3",
                    look.template === tp.id ? "border-gold/60 bg-gold/5" : "border-line",
                  )}
                >
                  <input
                    type="radio"
                    name="announce-template"
                    checked={look.template === tp.id}
                    onChange={() => setLook({ template: tp.id })}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-[0.9rem] text-ink">{tp.name}</span>
                    <span className="block text-[0.78rem] text-faint">{tp.text}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="block">
            <span className="mb-1.5 block text-[0.85rem] text-muted">Heading</span>
            <input
              value={look.heading}
              maxLength={120}
              onChange={(e) => setLook({ heading: e.target.value })}
              className="min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none"
              aria-label="Heading"
            />
          </label>

          <div>
            <p className="mb-1.5 text-[0.85rem] text-muted">Accent color</p>
            <div
              className="flex flex-wrap items-center gap-2"
              role="radiogroup"
              aria-label="Accent color"
            >
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={s.accent.toLowerCase() === c}
                  aria-label={c}
                  onClick={() => set({ accent: c })}
                  className={cx(
                    "h-8 w-8 rounded-full border-2",
                    s.accent.toLowerCase() === c ? "border-white" : "border-transparent",
                  )}
                  style={{ background: c }}
                />
              ))}
              <input
                type="color"
                value={s.accent}
                onChange={(e) => set({ accent: e.target.value })}
                aria-label="Any color"
                className="h-8 w-10 cursor-pointer rounded border border-line bg-transparent"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[0.85rem] text-muted">Sender name</span>
              <input
                value={s.botName}
                maxLength={80}
                onChange={(e) => set({ botName: e.target.value })}
                className="min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[0.85rem] text-muted">
                Branding line (optional)
              </span>
              <input
                value={s.branding}
                maxLength={120}
                placeholder="For example: Movie night picks"
                onChange={(e) => set({ branding: e.target.value })}
                className="min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none"
              />
            </label>
          </div>

          <SenderPicture onChanged={() => setPictureVersion((v) => v + 1)} />

          <fieldset>
            <legend className="mb-1 text-[0.85rem] text-muted">Include</legend>
            {SHOW.map((x) => (
              <Check
                key={x.key}
                checked={s.show[x.key]}
                onChange={(v) => set({ show: { ...s.show, [x.key]: v } })}
                label={x.label}
              />
            ))}
          </fieldset>

          <fieldset data-testid="announce-tone">
            <legend className="mb-1 text-[0.85rem] text-muted">{aiName}'s line on each post</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {TONES.map((tn) => (
                <label
                  key={tn.id}
                  className={cx(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3",
                    s.tone === tn.id ? "border-gold/60 bg-gold/5" : "border-line",
                  )}
                >
                  <input
                    type="radio"
                    name="announce-tone"
                    checked={s.tone === tn.id}
                    onChange={() => set({ tone: tn.id })}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-[0.88rem] text-ink">{tn.name}</span>
                    <span className="block text-[0.75rem] text-faint">{tn.text}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[0.75rem] text-faint">
              A short line at the top, matched to the title's kind, genre and decade, never the same
              one twice in a row. It never names who asked for something, and health, religion,
              sexuality, self-help and children's titles only get a plain one.
            </p>
            {s.tone !== "off" && (
              <div className="mt-2" data-testid="announce-ember-writes">
                <div className="flex flex-wrap items-center gap-x-3">
                  <Check
                    checked={s.emberWrites}
                    onChange={(v) => set({ emberWrites: v })}
                    label={`Let ${aiName} write it`}
                  />
                  <label className="flex items-center gap-2 text-[0.8rem] text-muted">
                    Daily cap
                    <select
                      value={s.emberWritesPerDay}
                      onChange={(e) => set({ emberWritesPerDay: Number(e.target.value) })}
                      aria-label="Daily cap"
                      className="min-h-9 rounded-md border border-line-strong bg-bg px-2 text-[0.82rem] text-ink"
                    >
                      {[5, 10, 20, 50].map((n) => (
                        <option key={n} value={n}>
                          {n} a day
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="mt-1 text-[0.75rem] text-faint">
                  {aiName} writes each line instead of picking one, using your AI (it counts toward
                  today's AI use). Never more than the cap a day: after it, the written lines are
                  used until tomorrow. Every line is checked first; one that doesn't pass is swapped
                  for a written one. The preview shows a written line; a test sends a fresh one.
                </p>
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-[0.85rem] text-muted">When</legend>
            <label className="flex items-center gap-2.5 text-[0.86rem] text-ink">
              <input
                type="radio"
                name="announce-mode"
                checked={s.mode === "immediate"}
                onChange={() => set({ mode: "immediate" })}
              />
              As each one arrives
            </label>
            <label className="flex flex-wrap items-center gap-2.5 text-[0.86rem] text-ink">
              <input
                type="radio"
                name="announce-mode"
                checked={s.mode === "digest"}
                onChange={() => set({ mode: "digest" })}
              />
              One daily roundup at
              <select
                value={s.digestHour}
                onChange={(e) => set({ digestHour: Number(e.target.value), mode: "digest" })}
                aria-label="Roundup hour"
                className="min-h-9 rounded-md border border-line-strong bg-bg px-2 text-[0.85rem] text-ink"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
            </label>
            <Check
              checked={s.quietHours}
              onChange={(v) => set({ quietHours: v })}
              label="Hold overnight (22:00 to 07:00)"
            />
            <Check
              checked={s.dedupe === "per-library"}
              onChange={(v) => set({ dedupe: v ? "per-library" : "across" })}
              label="Announce separately for each library (instead of once per title)"
            />
          </fieldset>

          {allDestinations.length > 0 && (
            <details className="rounded-lg border border-line p-3" data-testid="announce-customize">
              <summary className="cursor-pointer text-[0.86rem] text-ink">
                Customize for each destination
              </summary>
              <p className="mt-1 text-[0.75rem] text-faint">
                What each destination gets and the tone of {aiName}'s line, when they should differ
                from the settings above. A family channel can get movies and audiobooks, a friends'
                channel music only.
              </p>
              <div className="mt-3 space-y-4">
                {allDestinations.map((d) => {
                  const own = s.destinations[d.id];
                  const on = kindsFor(s, d.id);
                  return (
                    <div key={d.id} data-testid={`announce-dest-${d.id}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 text-[0.86rem] text-ink">{d.name}</span>
                        <select
                          value={own?.tone ?? ""}
                          onChange={(e) =>
                            setFor(d.id, {
                              tone: (e.target.value || undefined) as LineTone | undefined,
                            })
                          }
                          aria-label={`${d.name}: ${aiName}'s line`}
                          className="min-h-9 rounded-md border border-line-strong bg-bg px-2 text-[0.82rem] text-ink"
                        >
                          <option value="">Line: as above</option>
                          {TONES.map((tn) => (
                            <option key={tn.id} value={tn.id}>
                              Line: {tn.name}
                            </option>
                          ))}
                        </select>
                        {own && (
                          <button
                            type="button"
                            className="text-[0.78rem] text-gold hover:underline"
                            onClick={() => resetFor(d.id)}
                          >
                            Use the settings above
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-x-4">
                        {offered.map((k) => (
                          <Check
                            key={k.id}
                            checked={on[k.id]}
                            onChange={(v) => setFor(d.id, { types: { [k.id]: v } })}
                            label={k.label}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          <label className="block">
            <span className="mb-1.5 block text-[0.85rem] text-muted">
              Never announce titles containing (comma separated)
            </span>
            <input
              value={s.exclude.join(", ")}
              onChange={(e) =>
                set({
                  exclude: e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                })
              }
              className="min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none"
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              tone="primary"
              disabled={!changed || save.isPending}
              onClick={() => save.mutate()}
              data-testid="announce-save"
            >
              {save.isPending ? "Saving" : changed ? "Save" : "Saved"}
            </Button>
            {save.error && (
              <p className="text-[0.82rem] text-bad">{(save.error as Error).message}</p>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1">
              <span className="mb-1.5 block text-[0.85rem] text-muted">Preview with</span>
              <select
                value={chosen}
                onChange={(e) => setSample(e.target.value)}
                aria-label="Preview with"
                className="min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink"
              >
                {(samples.data ?? []).map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!chosen ? (
            <p className="rounded-lg border border-line p-4 text-[0.86rem] text-muted">
              No {KINDS.find((k) => k.id === kind)?.label.toLowerCase()} in Hearth's list yet. They
              appear once that kind is on and something new arrives; press Check now (above) to
              look.
            </p>
          ) : preview.data ? (
            <DiscordPreview preview={preview.data} pictureVersion={pictureVersion} />
          ) : (
            <p className="text-[0.86rem] text-muted">
              {preview.error ? (preview.error as Error).message : "Making the preview…"}
            </p>
          )}
          <p className="text-[0.75rem] text-faint">
            This is how Discord shows it
            {dest
              ? `, with ${aiName}'s line as ${allDestinations.find((d) => d.id === dest)?.name ?? "that destination"} gets it`
              : ""}
            . Other kinds of destination get the same words as plain text.
          </p>

          <div className="rounded-lg border border-line p-3">
            <p className="mb-2 text-[0.86rem] text-ink">Send a test</p>
            {allDestinations.length === 0 ? (
              <p className="text-[0.8rem] text-faint">
                Choose a destination for New in your library above first.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={dest}
                  onChange={(e) => setDest(e.target.value)}
                  aria-label="Test destination"
                  className="min-h-10 rounded-lg border border-line-strong bg-bg px-3 text-[0.86rem] text-ink"
                >
                  <option value="">Choose…</option>
                  {allDestinations.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={!dest || !chosen || test.isPending}
                  onClick={() => test.mutate()}
                  data-testid="announce-test"
                >
                  {test.isPending ? "Sending" : "Send test"}
                </Button>
              </div>
            )}
            <p className="mt-2 text-[0.75rem] text-faint">
              Tests say so in the message, so nobody mistakes them for a new arrival.
            </p>
            {test.data && (
              <p
                className={cx("mt-2 text-[0.82rem]", test.data.ok ? "text-muted" : "text-bad")}
                role="status"
                data-testid="announce-test-result"
              >
                {test.data.ok
                  ? "Test sent. Check that it arrived."
                  : `It did not go through: ${test.data.error}`}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-8">
        <p className="mb-2 text-[0.9rem] text-ink">Recent announcements</p>
        {data.history.length === 0 ? (
          <p className="text-[0.86rem] text-muted">
            None yet. New arrivals show here as they go out.
          </p>
        ) : (
          <ul className="divide-y divide-line" data-testid="announce-history">
            {data.history.map((d) => (
              <li
                key={`${d.key}|${d.channelId}`}
                className="flex flex-wrap items-baseline gap-3 py-2.5 text-[0.86rem]"
              >
                <span className="min-w-0 flex-1 text-ink">{d.title}</span>
                <span className="text-[0.78rem] text-faint">{d.channel}</span>
                <span
                  className={cx(
                    "text-[0.78rem]",
                    d.status === "failed"
                      ? "text-bad"
                      : d.status === "pending"
                        ? "text-amber"
                        : "text-faint",
                  )}
                >
                  {d.status === "sent"
                    ? `sent ${ago(d.sentAt ?? d.dueAt).toLowerCase()}`
                    : d.status === "pending"
                      ? d.error
                        ? `waiting to retry: ${d.error}`
                        : "waiting to go out"
                      : `failed: ${d.error ?? "unknown"}`}
                </span>
                {d.status === "failed" && (
                  <Button tone="quiet" onClick={() => retry.mutate(d)} disabled={retry.isPending}>
                    Try again
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
