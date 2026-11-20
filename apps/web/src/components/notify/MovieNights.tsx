import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import {
  REMINDER_KINDS,
  SUGGESTED_PLACES,
  type MovieNightLook,
  type MovieNight,
  type ReminderKind,
  type ChannelLink,
  type WatchPlace,
} from "@dragon-control/core";
import { Link } from "react-router";
import { PLAN_MOVIE_NIGHT_EVENT, peekPlannedMovie, takePlannedMovie } from "./PlanMovieNight";
import { api, useWorkspace } from "../../data/api";
import { Button, cx } from "../ui";
import { DiscordPreview, type Preview } from "./MediaAnnouncements";

/**
 * Movie nights (Notifications, under Media announcements): pick a movie from your libraries and a
 * time, and Hearth invites your friends-and-family destinations. On Discord the invitation is one
 * message that updates itself (guests, a new time, cancelled); reminders go out a day before, an
 * hour before and at the start. Friends get a link to the movie on your server's public address.
 */

interface NightsState {
  nights: MovieNight[];
  /** `buttons`: your own bot, whose invitations carry I'm in and Can't make it. */
  destinations: { id: string; name: string; buttons?: boolean }[];
}

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** "2026-10-31T20:00" in this browser's time, for a datetime-local input. */
function localInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The coming Friday at 8 PM (or next week's, if that has passed): a sensible first choice. */
function nextFriday(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
  d.setHours(20, 0, 0, 0);
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 7);
  return localInput(d.toISOString());
}

const showTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const field =
  "min-h-10 rounded-lg border border-line-strong bg-bg px-3 text-[0.88rem] text-ink placeholder:text-faint";

/** The invitation's look on Discord: the same three styles as media announcements. */
const LOOKS: { id: MovieNightLook; name: string; text: string }[] = [
  {
    id: "banner",
    name: "Banner",
    text: "Title, time and poster on the backdrop, like a streaming app.",
  },
  { id: "cinematic", name: "Cinematic", text: "The poster beside the details." },
  { id: "streaming", name: "Streaming", text: "A wide picture under the invitation." },
  { id: "compact", name: "Compact", text: "A small poster and a shorter story line." },
];

function LookPicker({
  look,
  setLook,
  name,
}: {
  look: MovieNightLook;
  setLook: (l: MovieNightLook) => void;
  name?: string;
}) {
  return (
    <fieldset data-testid="movie-night-look">
      <legend className="mb-1.5 text-[0.85rem] text-muted">
        Style{name ? ` for ${name}` : ""}
      </legend>
      <div className="grid gap-2 @md:grid-cols-2">
        {LOOKS.map((l) => (
          <label
            key={l.id}
            className={cx(
              "flex cursor-pointer items-start gap-2 rounded-lg border p-2.5",
              look === l.id ? "border-gold/60 bg-gold/5" : "border-line",
            )}
          >
            <input
              type="radio"
              name={`movie-night-look${name ? `-${name}` : ""}`}
              checked={look === l.id}
              onChange={() => setLook(l.id)}
              className="mt-1"
            />
            <span>
              <span className="block text-[0.86rem] text-ink">{l.name}</span>
              <span className="block text-[0.75rem] text-faint">{l.text}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Discord channels saved once (pasting the channel's link), then one click puts "#name" in the
 * note; Hearth turns it into a real channel link on Discord.
 */
function ChannelChips({ add }: { add: (name: string) => void }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["movie-night-channels"],
    queryFn: () => api<{ channels: ChannelLink[] }>("GET", "/api/movie-nights/channels"),
  });
  const saved = list.data?.channels ?? [];
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const save = useMutation({
    mutationFn: (next: { name: string; link: string }[]) =>
      api<{ channels: ChannelLink[] }>("PUT", "/api/movie-nights/channels", { channels: next }),
    onSuccess: (x) => {
      qc.setQueryData(["movie-night-channels"], x);
      void qc.invalidateQueries({ queryKey: ["movie-night-preview"] });
      setAdding(false);
      setName("");
      setLink("");
    },
  });
  // Saved ones go back as mentions, which the server reads like a pasted link.
  const asInput = saved.map((c) => ({ name: c.name, link: `<#${c.id}>` }));
  return (
    <div className="space-y-2" data-testid="movie-night-channels">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.78rem] text-faint">Discord channels:</span>
        {saved.map((c) => (
          <span
            key={c.id}
            className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[0.8rem] text-ink"
          >
            <button
              type="button"
              onClick={() => add(c.name)}
              className="hover:underline"
              data-testid="movie-night-channel"
              aria-label={`Add #${c.name} to the note`}
            >
              #{c.name}
            </button>
            <button
              type="button"
              aria-label={`Forget #${c.name}`}
              onClick={() => save.mutate(asInput.filter((x) => x.name !== c.name))}
              className="text-faint hover:text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </span>
        ))}
        {!adding && (
          <button
            type="button"
            className="text-[0.8rem] text-gold hover:underline"
            onClick={() => setAdding(true)}
            data-testid="movie-night-channel-add"
          >
            {saved.length ? "Save another" : "Save a channel to link"}
          </button>
        )}
      </div>
      {adding && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate([...asInput, { name, link }]);
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder="Its name, like movie-chat"
            aria-label="Channel name"
            className={cx(field, "w-48")}
          />
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            maxLength={300}
            placeholder="Paste the channel's link"
            aria-label="Channel link"
            className={cx(field, "w-64")}
          />
          <Button type="submit" disabled={!name.trim() || !link.trim() || save.isPending}>
            Save
          </Button>
          <Button tone="quiet" onClick={() => setAdding(false)}>
            Not now
          </Button>
        </form>
      )}
      <p className="text-[0.75rem] text-faint">
        {adding
          ? "In Discord, right-click the channel and choose Copy Link, then paste it here."
          : saved.length
            ? "Click one to add it to the note, or type #name yourself: on Discord it becomes a link to the channel."
            : "Save a channel once, and #name in your note becomes a link to it on Discord."}
      </p>
      {save.isError && (
        <p role="alert" className="text-[0.82rem] text-bad">
          {(save.error as Error).message}
        </p>
      )}
    </div>
  );
}

/**
 * Where to watch, with the host's saved places one click away (Plezy Watch Together, come over...)
 * and the night's room code, which watch-party apps make fresh each time and can be added later.
 */
function WhereToWatch({
  watch,
  setWatch,
  code,
  setCode,
  name,
}: {
  watch: string;
  setWatch: (v: string) => void;
  code: string;
  setCode: (v: string) => void;
  /** Tells the fields apart when a planned night is edited beside the form. */
  name?: string;
}) {
  const qc = useQueryClient();
  const places = useQuery({
    queryKey: ["movie-night-places"],
    queryFn: () => api<{ places: WatchPlace[] }>("GET", "/api/movie-nights/places"),
  });
  const saved = places.data?.places ?? [];
  const [naming, setNaming] = useState(false);
  const [placeName, setPlaceName] = useState("");
  const save = useMutation({
    mutationFn: (list: WatchPlace[]) =>
      api<{ places: WatchPlace[] }>("PUT", "/api/movie-nights/places", { places: list }),
    onSuccess: (x) => {
      qc.setQueryData(["movie-night-places"], x);
      setNaming(false);
      setPlaceName("");
    },
  });
  const shown = saved.length ? saved : SUGGESTED_PLACES;
  const known = saved.some((p) => p.text === watch.trim());
  const of = name ? ` for ${name}` : "";
  return (
    <div className="space-y-2" data-testid="movie-night-where">
      <div>
        <span className="mb-1.5 block text-[0.85rem] text-muted">Where to watch</span>
        <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="movie-night-places">
          <span className="text-[0.78rem] text-faint">{saved.length ? "Saved:" : "Ideas:"}</span>
          {shown.map((p) => (
            <span
              key={p.name}
              className={cx(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[0.8rem]",
                p.text === watch.trim() ? "border-gold text-gold" : "border-line text-ink",
              )}
            >
              <button
                type="button"
                onClick={() => setWatch(p.text)}
                data-testid="movie-night-place"
                className="hover:underline"
              >
                {p.name}
              </button>
              {saved.length > 0 && (
                <button
                  type="button"
                  aria-label={`Forget the place ${p.name}`}
                  onClick={() => save.mutate(saved.filter((x) => x.name !== p.name))}
                  className="text-faint hover:text-ink"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </span>
          ))}
        </div>
        <textarea
          value={watch}
          maxLength={1000}
          rows={2}
          onChange={(e) => setWatch(e.target.value)}
          placeholder="Leave empty to use the links Hearth finds (shown in the preview)"
          aria-label={`Where to watch${of}`}
          data-testid="movie-night-watch"
          className={cx(field, "w-full py-2")}
        />
        <span className="mt-1 block text-[0.75rem] text-faint">
          Your own words and links, for example: come over to the house. Links work as
          [text](https://address), and {"{plex}"} or {"{jellyfin}"} becomes the link to this movie
          there.
        </span>
      </div>
      {watch.trim() && !known && (
        <div className="flex flex-wrap items-center gap-2">
          {naming ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (placeName.trim())
                  save.mutate([...saved, { name: placeName.trim(), text: watch.trim() }]);
              }}
            >
              <input
                value={placeName}
                onChange={(e) => setPlaceName(e.target.value)}
                maxLength={60}
                placeholder="Name it, for example: Watch party"
                aria-label="Name for this place"
                data-testid="movie-night-place-name"
                className={cx(field, "w-56")}
              />
              <Button type="submit" disabled={!placeName.trim() || save.isPending}>
                Save
              </Button>
              <Button tone="quiet" onClick={() => setNaming(false)}>
                Not now
              </Button>
            </form>
          ) : (
            <button
              type="button"
              className="text-[0.8rem] text-gold hover:underline"
              onClick={() => setNaming(true)}
              data-testid="movie-night-place-save"
            >
              Save this as a place for next time
            </button>
          )}
        </div>
      )}
      {save.isError && (
        <p role="alert" className="text-[0.82rem] text-bad">
          {(save.error as Error).message}
        </p>
      )}
      <label className="block">
        <span className="mb-1.5 block text-[0.85rem] text-muted">Room code (optional)</span>
        <input
          value={code}
          maxLength={60}
          onChange={(e) => setCode(e.target.value)}
          placeholder="From your watch-party app"
          aria-label={`Room code${of}`}
          data-testid="movie-night-code"
          className={cx(field, "w-56")}
        />
        <span className="mt-1 block text-[0.75rem] text-faint">
          Watch-party apps like Plezy make a new code for each room. Add it now, or later on the
          planned night, and the invitation updates.
        </span>
      </label>
    </div>
  );
}

/** The plan being filled in, kept while this page is open (cleared once posted). */
let planDraft:
  | {
      q: string;
      picked: { key: string; title: string } | null;
      when: string;
      spots: string;
      note: string;
      watch: string;
      code: string;
      look: MovieNightLook;
      reminders: ReminderKind[];
      channels: string[];
    }
  | undefined;

function PlanNight({
  destinations,
  done,
  initial,
}: {
  destinations: NightsState["destinations"];
  done: () => void;
  /** A movie handed over by Plan a movie night: searched for, and chosen when it is the one match. */
  initial?: string;
}) {
  // A plan in progress outlives the panel being rebuilt (the window resized, a tablet turned).
  const d = initial ? undefined : planDraft;
  const [q, setQ] = useState(initial ?? d?.q ?? "");
  const [picked, setPicked] = useState<{ key: string; title: string } | null>(d?.picked ?? null);
  // "Choose another" after a handed-over movie was chosen: from then on, only what they pick.
  const [ownChoice, setOwnChoice] = useState(false);
  const [when, setWhen] = useState(() => d?.when ?? nextFriday());
  const [spots, setSpots] = useState(d?.spots ?? "");
  const [note, setNote] = useState(d?.note ?? "");
  const [watch, setWatch] = useState(d?.watch ?? "");
  const [code, setCode] = useState(d?.code ?? "");
  const [look, setLook] = useState<MovieNightLook>(d?.look ?? "cinematic");
  const [reminders, setReminders] = useState<ReminderKind[]>(
    d?.reminders ?? ["day", "hour", "start"],
  );
  // With your bot set up, it is picked (its invitations have RSVP buttons); else every destination.
  const [channels, setChannels] = useState<string[]>(() => {
    if (d?.channels) return d.channels;
    const bots = destinations.filter((d) => d.buttons);
    return (bots.length ? bots : destinations).map((d) => d.id);
  });
  const titles = useQuery({
    queryKey: ["movie-night-titles", q],
    queryFn: () =>
      api<{ key: string; title: string }[]>(
        "GET",
        `/api/movie-nights/titles?q=${encodeURIComponent(q)}`,
      ),
    enabled: !picked,
  });
  // The handed-over movie: chosen when exactly one title is that name, else left in the search.
  const same =
    !picked && !ownChoice && initial
      ? (titles.data ?? []).filter((t) => t.title.toLowerCase() === initial.toLowerCase())
      : [];
  const chosen = picked ?? (same.length === 1 ? same[0]! : null);
  const setChosen = (c: { key: string; title: string } | null) => {
    setPicked(c);
    setOwnChoice(true);
  };
  const input = chosen
    ? {
        key: chosen.key,
        startsAt: new Date(when).toISOString(),
        timeZone: zone(),
        spots: spots ? Number(spots) : null,
        note,
        watch,
        code,
        look,
        reminders,
      }
    : null;
  useEffect(() => {
    planDraft = { q, picked: chosen, when, spots, note, watch, code, look, reminders, channels };
  }, [q, chosen, when, spots, note, watch, code, look, reminders, channels]);
  const preview = useQuery({
    queryKey: ["movie-night-preview", input],
    queryFn: () => api<Preview>("POST", "/api/movie-nights/preview", input),
    enabled: Boolean(input) && !Number.isNaN(new Date(when).getTime()),
  });
  const post = useMutation({
    mutationFn: () => api<MovieNight>("POST", "/api/movie-nights", { ...input, channels }),
    onSuccess: () => {
      planDraft = undefined;
      done();
    },
  });
  return (
    <div className="grid gap-6 @4xl:grid-cols-2" data-testid="movie-night-plan">
      <div className="space-y-4">
        {chosen ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-gold/50 px-3 py-2">
            <span className="text-[0.92rem] text-ink" data-testid="movie-night-chosen">
              {chosen.title}
            </span>
            <button
              type="button"
              className="text-[0.8rem] text-gold hover:underline"
              onClick={() => setChosen(null)}
            >
              Choose another
            </button>
          </div>
        ) : (
          <div>
            <label className="block">
              <span className="mb-1.5 block text-[0.85rem] text-muted">Movie</span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a movie in your libraries"
                aria-label="Find a movie"
                className={cx(field, "w-full")}
              />
            </label>
            <ul className="mt-2 max-h-56 overflow-auto rounded-lg border border-line">
              {(titles.data ?? []).map((t) => (
                <li key={t.key}>
                  <button
                    type="button"
                    onClick={() => setChosen(t)}
                    className="block w-full px-3 py-2 text-left text-[0.88rem] text-ink hover:bg-gold/10"
                    data-testid="movie-night-title"
                  >
                    {t.title}
                  </button>
                </li>
              ))}
              {titles.data?.length === 0 && (
                <li className="px-3 py-2 text-[0.84rem] text-faint">
                  Nothing matches. Hearth knows the movies in Plex and Jellyfin after its first
                  check (Media announcements, Check now).
                </li>
              )}
            </ul>
          </div>
        )}
        <div className="grid gap-3 @md:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[0.85rem] text-muted">When ({zone()})</span>
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              aria-label="When"
              className={cx(field, "w-full")}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[0.85rem] text-muted">Spots (optional)</span>
            <input
              type="number"
              min={1}
              max={500}
              value={spots}
              onChange={(e) => setSpots(e.target.value)}
              placeholder="No limit"
              aria-label="Spots"
              className={cx(field, "w-full")}
            />
          </label>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-[0.85rem] text-muted">A note for your friends</span>
          <input
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Popcorn at 7:45"
            aria-label="Note"
            className={cx(field, "w-full")}
          />
          <span className="mt-1 block text-[0.75rem] text-faint">
            Shown in bold, in a quote box, so it stands out.
          </span>
        </label>
        <ChannelChips add={(name) => setNote((x) => `${x.trimEnd()} #${name} `.trimStart())} />
        <WhereToWatch watch={watch} setWatch={setWatch} code={code} setCode={setCode} />
        <LookPicker look={look} setLook={setLook} />
        <fieldset>
          <legend className="mb-1.5 text-[0.85rem] text-muted">Reminders</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {REMINDER_KINDS.map((k) => (
              <label key={k.id} className="flex min-h-9 items-center gap-2 text-[0.86rem] text-ink">
                <input
                  type="checkbox"
                  checked={reminders.includes(k.id)}
                  onChange={(e) =>
                    setReminders((r) =>
                      e.target.checked ? [...r, k.id] : r.filter((x) => x !== k.id),
                    )
                  }
                  className="h-4 w-4 accent-[var(--color-gold)]"
                />
                {k.label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-[0.85rem] text-muted">Invite</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {destinations.map((d) => (
              <label key={d.id} className="flex min-h-9 items-center gap-2 text-[0.86rem] text-ink">
                <input
                  type="checkbox"
                  checked={channels.includes(d.id)}
                  onChange={(e) =>
                    setChannels((c) =>
                      e.target.checked ? [...c, d.id] : c.filter((x) => x !== d.id),
                    )
                  }
                  className="h-4 w-4 accent-[var(--color-gold)]"
                />
                {d.name}
                {d.buttons && <span className="text-[0.76rem] text-ok">with RSVP buttons</span>}
              </label>
            ))}
          </div>
          {!destinations.some((d) => d.buttons) && (
            <p className="mt-1 text-[0.78rem] text-muted" data-testid="movie-night-bot-hint">
              Want friends to answer with I&apos;m in and Can&apos;t make it buttons? Add a Discord
              destination above with the Hearth bot or your own bot; Hearth walks you through it.
            </p>
          )}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            tone="primary"
            disabled={!input || !channels.length || post.isPending}
            onClick={() => post.mutate()}
            data-testid="movie-night-post"
          >
            {post.isPending ? "Posting" : "Post the invitation"}
          </Button>
          <Button tone="quiet" onClick={done}>
            Not now
          </Button>
        </div>
        {post.isError && (
          <p role="alert" className="text-[0.85rem] text-bad">
            {(post.error as Error).message}
          </p>
        )}
      </div>
      <div className="space-y-2">
        {!chosen ? (
          <p className="text-[0.86rem] text-muted">Choose a movie to see the invitation.</p>
        ) : preview.data ? (
          <DiscordPreview preview={preview.data} testId="movie-night-preview" />
        ) : (
          <p className="text-[0.86rem] text-muted">
            {preview.error ? (preview.error as Error).message : "Making the preview…"}
          </p>
        )}
        <p className="text-[0.75rem] text-faint">
          Discord shows each friend the time in their own time zone, and this message updates itself
          when guests or plans change.
        </p>
      </div>
    </div>
  );
}

function NightCard({ n, refresh }: { n: MovieNight; refresh: (x: MovieNight) => void }) {
  const [guest, setGuest] = useState("");
  const [moving, setMoving] = useState(false);
  const [when, setWhen] = useState(() => localInput(n.startsAt));
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [watch, setWatch] = useState(n.watch ?? "");
  const [code, setCode] = useState(n.code ?? "");
  const [styling, setStyling] = useState(false);
  const act = useMutation({
    mutationFn: (a: { path: string; method?: "POST" | "PATCH"; body?: unknown }) =>
      api<MovieNight>(a.method ?? "POST", `/api/movie-nights/${n.id}${a.path}`, a.body ?? {}),
    onSuccess: (x) => {
      refresh(x);
      setGuest("");
      setMoving(false);
      setConfirmCancel(false);
      setPlacing(false);
      setStyling(false);
    },
  });
  const live = n.status === "scheduled";
  const failed = n.posts.filter((p) => p.error);
  return (
    <li className="py-4" data-testid="movie-night">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-[0.98rem] text-ink">{n.title}</p>
        <p className="text-[0.84rem] text-muted">{showTime(n.startsAt)}</p>
        <span
          className={cx(
            "text-[0.78rem]",
            n.status === "cancelled"
              ? "text-amber"
              : n.status === "done"
                ? "text-faint"
                : "text-live",
          )}
          data-testid="movie-night-status"
        >
          {n.status === "cancelled" ? "Cancelled" : n.status === "done" ? "Over" : "Planned"}
        </span>
      </div>
      <p className="mt-1 text-[0.8rem] text-faint">
        Invited: {n.posts.map((p) => p.channel).join(", ") || "nobody yet"}
        {n.spots !== null ? ` · ${n.spots} spots` : ""}
        {n.remindersSent.length && live ? ` · reminders sent: ${n.remindersSent.length}` : ""}
        {n.code ? ` · room code ${n.code}` : ""}
      </p>
      {failed.length > 0 && (
        <p className="mt-1 text-[0.82rem] text-bad" role="alert">
          Not delivered to {failed.map((p) => `${p.channel} (${p.error})`).join(", ")}.{" "}
          <button
            type="button"
            className="text-gold hover:underline"
            onClick={() => act.mutate({ path: "/retry" })}
          >
            Try again
          </button>
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {n.guests.map((g) => (
          <span
            key={g}
            className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[0.8rem] text-ink"
            data-testid="movie-night-guest"
          >
            {g}
            {live && (
              <button
                type="button"
                aria-label={`Remove ${g}`}
                onClick={() => act.mutate({ path: "/guests", body: { remove: g } })}
                className="text-faint hover:text-ink"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </span>
        ))}
        {live && (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (guest.trim()) act.mutate({ path: "/guests", body: { add: guest } });
            }}
          >
            <input
              value={guest}
              onChange={(e) => setGuest(e.target.value)}
              placeholder="Who's coming?"
              aria-label={`Add a guest to ${n.title}`}
              maxLength={60}
              className={cx(field, "w-40")}
            />
            <Button type="submit" disabled={!guest.trim() || act.isPending}>
              Add
            </Button>
          </form>
        )}
      </div>
      {live && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {styling ? (
            <div className="w-full max-w-xl space-y-3">
              <LookPicker
                look={n.look ?? "cinematic"}
                setLook={(l) => act.mutate({ path: "", method: "PATCH", body: { look: l } })}
                name={n.title}
              />
              <Button tone="quiet" onClick={() => setStyling(false)}>
                Done
              </Button>
            </div>
          ) : placing ? (
            <div className="w-full max-w-xl space-y-3" data-testid="movie-night-edit-where">
              <WhereToWatch
                watch={watch}
                setWatch={setWatch}
                code={code}
                setCode={setCode}
                name={n.title}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => act.mutate({ path: "", method: "PATCH", body: { watch, code } })}
                  disabled={act.isPending}
                  data-testid="movie-night-save-where"
                >
                  Update the invitation
                </Button>
                <Button
                  tone="quiet"
                  onClick={() => {
                    setWatch(n.watch ?? "");
                    setCode(n.code ?? "");
                    setPlacing(false);
                  }}
                >
                  Keep it
                </Button>
              </div>
            </div>
          ) : moving ? (
            <>
              <input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                aria-label={`New time for ${n.title}`}
                className={field}
              />
              <Button
                onClick={() =>
                  act.mutate({
                    path: "",
                    method: "PATCH",
                    body: { startsAt: new Date(when).toISOString() },
                  })
                }
                disabled={act.isPending}
              >
                Save the new time
              </Button>
              <Button tone="quiet" onClick={() => setMoving(false)}>
                Keep it
              </Button>
            </>
          ) : confirmCancel ? (
            <>
              <span className="text-[0.84rem] text-ink">Tell everyone it's off?</span>
              <Button tone="outline" onClick={() => act.mutate({ path: "/cancel" })}>
                Cancel the movie night
              </Button>
              <Button tone="quiet" onClick={() => setConfirmCancel(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <>
              <Button tone="quiet" onClick={() => setMoving(true)}>
                Change the time
              </Button>
              <Button
                tone="quiet"
                onClick={() => setPlacing(true)}
                data-testid="movie-night-edit-where-open"
              >
                {n.code ? "Where to watch, room code" : "Where to watch, add a room code"}
              </Button>
              <Button
                tone="quiet"
                onClick={() => setStyling(true)}
                data-testid="movie-night-edit-look"
              >
                Change the style
              </Button>
              <Button tone="quiet" onClick={() => setConfirmCancel(true)}>
                Cancel it
              </Button>
            </>
          )}
        </div>
      )}
      {act.isError && (
        <p role="alert" className="mt-2 text-[0.84rem] text-bad">
          {(act.error as Error).message}
        </p>
      )}
    </li>
  );
}

/**
 * Sized by its panel, not the window (the panel is often narrower than the screen).
 * The nights themselves: plan one, then each night's guests, time, style and cancel. Shown in the
 * Movie nights panel (`inPanel`); the Discord bot and destinations are set up in Notifications.
 */
export function MovieNights({ inPanel = false }: { inPanel?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["movie-nights"],
    queryFn: () => api<NightsState>("GET", "/api/movie-nights"),
  });
  // A movie handed over by Plan a movie night (from a movie in Plex or Jellyfin).
  const [wanted, setWanted] = useState(() => (inPanel ? peekPlannedMovie() : undefined));
  const [planning, setPlanning] = useState(Boolean(wanted) || Boolean(planDraft));
  useEffect(() => {
    if (!inPanel) return;
    takePlannedMovie();
    const on = (e: Event) => {
      takePlannedMovie();
      setWanted((e as CustomEvent<string>).detail);
      setPlanning(true);
    };
    window.addEventListener(PLAN_MOVIE_NIGHT_EVENT, on);
    return () => window.removeEventListener(PLAN_MOVIE_NIGHT_EVENT, on);
  }, [inPanel]);
  const data = q.data;
  if (!data) return <p className="text-[0.86rem] text-muted">Loading…</p>;
  const refresh = (x: MovieNight) =>
    qc.setQueryData<NightsState>(["movie-nights"], (s) =>
      s ? { ...s, nights: s.nights.map((n) => (n.id === x.id ? x : n)) } : s,
    );
  return (
    <div className="@container" data-testid="movie-nights">
      <p className="mb-4 max-w-3xl text-[0.86rem] leading-relaxed text-muted">
        {inPanel ? "" : "Pick a movie and a time, and "}Hearth invites the destinations you chose
        for <span className="text-ink">New in your library</span>, with reminders. Friends get a
        link to the movie on your server&apos;s public address (on Jellyfin, they join the SyncPlay
        group named in the invitation). Posted by your own Discord bot, the invitation has I&apos;m
        in and Can&apos;t make it buttons and the guest list keeps itself; elsewhere you add guests
        here as people say they are coming.
      </p>
      {data.destinations.length === 0 ? (
        inPanel ? (
          <SetUpInvites />
        ) : (
          <p className="text-[0.86rem] text-amber" data-testid="movie-night-no-destinations">
            Choose a destination for New in your library above first: that is who gets invited.
          </p>
        )
      ) : planning ? (
        <PlanNight
          key={wanted ?? ""}
          destinations={data.destinations}
          {...(wanted ? { initial: wanted } : {})}
          done={() => {
            setPlanning(false);
            setWanted(undefined);
            void qc.invalidateQueries({ queryKey: ["movie-nights"] });
          }}
        />
      ) : (
        <Button tone="primary" onClick={() => setPlanning(true)} data-testid="movie-night-new">
          Plan a movie night
        </Button>
      )}
      {data.nights.length > 0 && (
        <ul className="mt-6 divide-y divide-line" data-testid="movie-night-list">
          {data.nights.map((n) => (
            <NightCard key={n.id} n={n} refresh={refresh} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Nobody to invite yet (11-12, the owner): say so plainly and take them straight to the setting.
 * With no channel at all, that is adding one (Discord or another); with channels, it is choosing
 * which get invitations.
 */
function SetUpInvites() {
  const channels = (useWorkspace().data?.channels ?? []).filter((c) => c.status === "configured");
  const none = channels.length === 0;
  return (
    <div
      className="max-w-xl space-y-3 rounded-xl border border-gold/50 bg-gold/5 p-4"
      data-testid="movie-night-no-destinations"
    >
      <p className="text-[0.95rem] font-medium text-ink">First, where do invitations go?</p>
      <p className="text-[0.86rem] leading-relaxed text-muted">
        {none
          ? "Hearth needs somewhere to post them: your Discord server (with your own bot, friends answer I'm in or Can't make it right there) or another channel. Set one up, then come back here."
          : "Pick which of your channels get movie night invitations, then come back here."}
      </p>
      <Link
        to={none ? "/notifications#channels" : "/notifications#media-announcements"}
        className="dc-primary inline-flex min-h-11 items-center rounded-lg px-5 text-[0.85rem] font-medium tracking-wide"
        data-testid="movie-night-setup-invites"
      >
        {none ? "Set up Discord or another channel" : "Choose who gets invited"}
      </Link>
    </div>
  );
}
