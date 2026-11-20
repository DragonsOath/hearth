import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  Film,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Tv,
  Wand2,
} from "lucide-react";
import type { RecommendRating, RecommendWatchStep } from "@dragon-control/core";
import { api } from "../../data/api";
import { cx } from "../ui";
import { EmberMark } from "../ember/EmberMark";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import { RequestAsk, TrailerLink, saveParams, type SaveChoice } from "../dashboards/seerr/request";
import { RateIt } from "./RateIt";

/**
 * Curator For You (11-13, free since 11-14; server: recommend/for-you.ts): what to watch next, from
 * the owner's own watch history only (Tautulli, else Plex, read on your network). Other people on
 * the Plex are never read, so their viewing never reaches the AI. Your titles (hidden gems, new
 * arrivals, favourites worth revisiting), Not in your library (Seerr's own lists, no AI), and a
 * "What should I watch?" box (plain filters run here; only a vague ask goes to Ember).
 */

interface Person {
  id: string;
  name: string;
  plays: number;
  off: boolean;
}
interface Pick {
  key: string;
  kind: "gem" | "fresh" | "revisit" | "like";
  type: "movie" | "show";
  title: string;
  year?: number;
  genres: string[];
  why: string;
  voice?: string;
  image?: string;
  open?: string;
  minutes?: number;
}
interface Missing {
  key: string;
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  year?: number;
  genres: string[];
  why: string;
  image?: string;
  requested?: boolean;
}
interface Result {
  person: Person;
  source: "Tautulli" | "Plex";
  taste: string;
  topGenres: string[];
  loved: string[];
  picks: Pick[];
  missing: Missing[];
  missingNote?: string;
  seerr?: string;
  seed?: string;
  said?: string;
  at: string;
}
type Seed = { key?: string; tmdb?: string; title?: string; genres?: string[] };

const KIND: Record<Pick["kind"], string> = {
  gem: "Hidden gem",
  fresh: "New in your library",
  revisit: "Worth revisiting",
  like: "Your pick",
};

const field =
  "min-h-11 rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";
const ghost =
  "inline-flex min-h-9 items-center gap-1 rounded-lg border border-line px-3 text-[0.8rem] text-muted hover:border-gold/50 hover:text-ink disabled:opacity-50";
const gold =
  "inline-flex min-h-9 items-center gap-1 rounded-lg border border-gold/50 px-3 text-[0.8rem] text-gold hover:bg-gold/10 disabled:opacity-50";

export function ForYou({ onFindMissing }: { onFindMissing: (interest: string) => void }) {
  const qc = useQueryClient();
  const people = useQuery({
    queryKey: ["for-you-people"],
    queryFn: () =>
      api<{ people: Person[]; source: "Tautulli" | "Plex" }>("GET", "/api/recommend/for-you"),
  });
  // You: the Plex server's owner (11-13: only your own history is used).
  const person = people.data?.people[0]?.id;

  const picks = useQuery({
    queryKey: ["for-you", person],
    enabled: Boolean(person && people.data),
    queryFn: () => api<Result>("POST", "/api/recommend/for-you/list", { person: person! }),
    staleTime: 10 * 60_000,
  });
  // A list in place of yours: More like this, or What should I watch?. Back returns to yours.
  const [other, setOther] = useState<Result>();
  const [text, setText] = useState("");
  const fresh = useMutation({
    mutationFn: () =>
      api<Result>("POST", "/api/recommend/for-you/list", { person: person!, fresh: true }),
    onSuccess: (r) => {
      setOther(undefined);
      qc.setQueryData(["for-you", person], r);
    },
  });
  const like = useMutation({
    mutationFn: (seed: Seed) =>
      api<Result>("POST", "/api/recommend/for-you/list", { person: person!, seed }),
    onSuccess: (r) => setOther(r),
  });
  const search = useMutation({
    mutationFn: (t: string) =>
      api<Result>("POST", "/api/recommend/for-you/search", { person: person!, text: t }),
    onSuccess: (r) => setOther(r),
  });

  const r = other ?? picks.data;
  /** One list changed in place: the one on screen, and the kept one when it is yours. */
  const edit = (fn: (x: Result) => Result) => {
    if (other) setOther(fn(other));
    else qc.setQueryData<Result>(["for-you", person], (x) => (x ? fn(x) : x));
  };
  const hide = useMutation({
    mutationFn: (key: string) =>
      api<{ pick?: Pick; missing?: Missing }>("POST", "/api/recommend/for-you/hide", {
        person: person!,
        key,
      }),
    onMutate: (key) =>
      edit((x) => ({
        ...x,
        picks: x.picks.filter((p) => p.key !== key),
        missing: x.missing.filter((m) => m.key !== key),
      })),
    onSuccess: (got) => {
      if (!other) edit((x) => refill(x, got));
    },
  });

  // Seen it: the rating feeds the next picks; marking it watched on Plex is a plan you approve.
  const act = useApproveHere("", "From Curator For You.");
  const [toMark, setToMark] = useState<RecommendWatchStep[]>([]);
  const seen = useMutation({
    mutationFn: ({ key, rating }: { key: string; rating?: RecommendRating }) =>
      api<{ markWatched: RecommendWatchStep[]; pick?: Pick }>(
        "POST",
        "/api/recommend/for-you/seen",
        { person: person!, key, ...(rating ? { rating } : {}) },
      ),
    onMutate: ({ key }) => edit((x) => ({ ...x, picks: x.picks.filter((p) => p.key !== key) })),
    onSuccess: (got) => {
      if (!other) edit((x) => refill(x, got));
      setToMark(got.markWatched);
    },
  });

  // Request: Seerr's quality and folder first (as in Discover), then the approval.
  const [ask, setAsk] = useState<Missing>();
  const [save, setSave] = useState<SaveChoice>({});
  const [asked, setAsked] = useState<string[]>([]);
  const request = (m: Missing, where: SaveChoice) => {
    setAsked((a) => [...a, m.key]);
    // The sheet's Request was the approval (11-14): sent now, no second step.
    void act.sendNow(
      [
        {
          kind: "app-seerr-request",
          serviceId: r!.seerr!,
          params: { mediaType: m.mediaType, tmdbId: m.tmdbId, ...saveParams(where) },
        },
      ],
      `Request ${m.title}`,
    );
  };
  const done = act.sent ? asked : [];

  if (people.isPending) return <p className="text-[0.85rem] text-muted">Finding who watches…</p>;
  if (people.isError)
    return (
      <p className="text-[0.85rem] text-bad" data-testid="for-you-error">
        {(people.error as Error).message}
      </p>
    );

  const busy = picks.isFetching || fresh.isPending || like.isPending || search.isPending;
  const err = picks.error ?? like.error ?? search.error ?? hide.error ?? seen.error;
  return (
    <div className="space-y-4" data-testid="for-you">
      <FirstNote />
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim().length >= 2 && person) search.mutate(text.trim());
        }}
        data-testid="for-you-search"
      >
        <label className="min-w-[14rem] flex-1">
          <span className="mb-1 block text-[0.86rem] text-ink">What should I watch?</span>
          <input
            className={cx(field, "w-full")}
            placeholder="Something funny under 2 hours, or like Bad Boys"
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
            data-testid="for-you-search-text"
          />
        </label>
        <button
          type="submit"
          disabled={text.trim().length < 2 || !person || search.isPending}
          className="mt-auto flex min-h-11 items-center gap-2 rounded-xl bg-gold px-5 text-[0.92rem] font-bold text-[#1a0d05] disabled:opacity-50"
          data-testid="for-you-search-go"
        >
          <Search
            strokeWidth={1.8}
            className={cx("h-4 w-4", search.isPending && "animate-pulse")}
            aria-hidden
          />
          {search.isPending ? "Looking…" : "Find"}
        </button>
        <p className="w-full text-[0.76rem] text-faint">
          Genres, length, years and &ldquo;like a title&rdquo; are worked out here. Only a vaguer
          ask goes to Ember, with your titles and genres, nothing about who watched what.
        </p>
      </form>

      <p className="text-[0.8rem] text-faint" data-testid="for-you-whose">
        What to watch next, from your own watch history. Other people on your Plex aren&apos;t
        included.
      </p>
      {person && picks.isPending && !r && (
        <p className="flex items-center gap-2 text-[0.85rem] text-muted">
          <EmberMark className="h-4 w-4" /> Ember is going through what you watched…
        </p>
      )}
      {err && (
        <p className="text-[0.85rem] text-bad" role="alert" data-testid="for-you-error">
          {(err as Error).message}
        </p>
      )}
      {r && (
        <>
          {other ? (
            <div
              className="flex flex-wrap items-center gap-2 rounded-xl border border-gold/40 bg-gold/5 px-3 py-2"
              data-testid="for-you-showing"
            >
              <p className="min-w-0 flex-1 text-[0.92rem] font-semibold text-ink">
                {other.seed ? `More like ${other.seed}` : `Showing: ${other.said ?? text}`}
                {other.seed && other.said && other.said !== `like ${other.seed}` && (
                  <span className="font-normal text-muted"> ({other.said})</span>
                )}
              </p>
              <button
                type="button"
                onClick={() => setOther(undefined)}
                className={ghost}
                data-testid="for-you-back"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to your picks
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-[0.85rem] text-muted" data-testid="for-you-taste">
                {r.taste}{" "}
                <span className="text-faint">
                  Read on your network from {r.source}. Only the reasons below go to Ember, to put
                  them in her words.
                </span>
              </p>
              <button
                type="button"
                onClick={() => fresh.mutate()}
                disabled={busy}
                className={ghost}
                data-testid="for-you-refresh"
              >
                <RefreshCw className={cx("h-3.5 w-3.5", busy && "animate-spin")} aria-hidden />{" "}
                Fresh picks
              </button>
            </div>
          )}

          <section className="space-y-2" aria-label="In your library">
            <h3 className="text-[0.9rem] font-semibold text-ink">In your library</h3>
            {r.picks.length === 0 ? (
              <p className="text-[0.85rem] text-muted">
                {other
                  ? "Nothing in your library fits that. Try other words."
                  : "Nothing to suggest yet: once you've watched a few things, picks show up here."}
              </p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2" data-testid="for-you-picks">
                {r.picks.map((p) => (
                  <PickCard
                    key={p.key}
                    p={p}
                    busy={like.isPending}
                    onHide={() => hide.mutate(p.key)}
                    onLike={() => like.mutate({ key: p.key })}
                    onSeen={(rating) => seen.mutate({ key: p.key, ...(rating ? { rating } : {}) })}
                  />
                ))}
              </ul>
            )}
          </section>

          {toMark.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-3 rounded-xl border border-gold/40 bg-gold/5 p-3 text-[0.84rem] text-ink"
              data-testid="for-you-mark-watched"
            >
              <p className="min-w-0 flex-1">
                Got it. Mark {toMark[0]!.title} watched on {toMark[0]!.server}
                {toMark.some((m) => m.does === "rating") ? ", with your rating" : ""}?
              </p>
              <button
                type="button"
                disabled={act.busy}
                onClick={() => {
                  const steps = toMark;
                  setToMark([]);
                  void act.proposeMany(
                    steps.map((m) => ({
                      kind: m.step as Parameters<typeof act.propose>[0],
                      serviceId: m.serviceId,
                      params: m.params,
                    })),
                    `Mark ${steps[0]!.title} watched on ${steps[0]!.server}`,
                  );
                }}
                className="min-h-10 rounded-lg bg-gold px-3.5 text-[0.82rem] font-bold text-[#1a0d05] disabled:opacity-50"
                data-testid="for-you-mark-watched-yes"
              >
                Yes, update it
              </button>
              <button
                type="button"
                onClick={() => setToMark([])}
                className="min-h-10 rounded-lg border border-line-strong px-3.5 text-[0.82rem] text-muted hover:text-ink"
              >
                No, leave it
              </button>
            </div>
          )}

          <section
            className="space-y-2"
            aria-label="Not in your library"
            data-testid="for-you-not-owned"
          >
            <h3 className="text-[0.9rem] font-semibold text-ink">Not in your library</h3>
            <p className="text-[0.78rem] text-faint">
              From Seerr&apos;s own &ldquo;similar&rdquo; and &ldquo;recommended&rdquo; lists for
              what you finished. No AI, and nothing new leaves your network.
            </p>
            {r.missing.length === 0 ? (
              <p className="text-[0.85rem] text-muted" data-testid="for-you-not-owned-note">
                {r.missingNote ?? "Nothing new like what you finished right now."}
              </p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {r.missing.map((m) => (
                  <MissingCard
                    key={m.key}
                    m={m}
                    seerr={r.seerr}
                    requested={m.requested || done.includes(m.key)}
                    busy={act.busy || like.isPending}
                    onRequest={() => setAsk(m)}
                    onLike={() =>
                      like.mutate({ tmdb: m.key, title: m.title, genres: m.genres.slice(0, 8) })
                    }
                    onHide={() => hide.mutate(m.key)}
                  />
                ))}
              </ul>
            )}
            {!other && (r.loved.length > 0 || r.topGenres.length > 0) && (
              <button
                type="button"
                onClick={() =>
                  onFindMissing(
                    [
                      r.loved.length ? `Films like ${r.loved.slice(0, 4).join(", ")}` : "",
                      r.topGenres.length ? `(${r.topGenres.slice(0, 3).join(", ")})` : "",
                    ]
                      .filter(Boolean)
                      .join(" "),
                  )
                }
                className={gold}
                title="For vaguer ideas: Hearth sends Ember the names of up to 4 films you finished and your top genres, then checks each suggestion in Seerr and your Plex."
                data-testid="for-you-missing"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden /> What&apos;s missing: ask Ember,
                check in Seerr
              </button>
            )}
          </section>
        </>
      )}
      {act.error && (
        <p className="text-[0.82rem] text-warn" role="alert">
          {act.error}
        </p>
      )}
      {ask && r?.seerr && (
        <RequestAsk
          items={[
            {
              serviceId: r.seerr,
              type: ask.mediaType,
              tmdbId: ask.tmdbId,
              title: `${ask.title}${ask.year ? ` (${ask.year})` : ""}`,
            },
          ]}
          value={save}
          onChange={setSave}
          onClose={() => setAsk(undefined)}
          onRequest={(where) => {
            const m = ask;
            setAsk(undefined);
            setSave(where);
            request(m, where);
          }}
        />
      )}
      <ApproveDialog c={act} />
    </div>
  );
}

/** The next waiting pick takes a card's place (Seen it, Not for me). */
function refill(x: Result, got: { pick?: Pick; missing?: Missing }): Result {
  return {
    ...x,
    picks:
      got.pick && !x.picks.some((p) => p.key === got.pick!.key) ? [...x.picks, got.pick] : x.picks,
    missing:
      got.missing && !x.missing.some((m) => m.key === got.missing!.key)
        ? [...x.missing, got.missing]
        : x.missing,
  };
}

const NOTE_KEY = "hearth-for-you-note-seen";
const seenNote = () => {
  try {
    return window.localStorage.getItem(NOTE_KEY) === "1";
  } catch {
    return false;
  }
};

/** Shown once (11-13): whose history For You learns from, and what reaches Ember. */
function FirstNote() {
  const [open, setOpen] = useState(() => !seenNote());
  if (!open) return null;
  return (
    <div
      className="space-y-2 rounded-xl border border-gold/40 bg-gold/5 p-3 text-[0.82rem] text-muted"
      data-testid="for-you-note"
      role="note"
    >
      <p className="font-semibold text-ink">How For You learns</p>
      <p>
        For You learns only from your own watch history, read on your own network (Tautulli, or Plex
        itself). Other people on your Plex are never read, so what they watch never reaches Ember. A
        For You for each person, which they choose to turn on, comes later.
      </p>
      <p>
        Ember only sees the short reasons for your picks, to put them in her words. Nothing is
        downloaded or requested unless you ask.
      </p>
      <button
        type="button"
        onClick={() => {
          try {
            window.localStorage.setItem(NOTE_KEY, "1");
          } catch {
            // Private window: it shows again next time.
          }
          setOpen(false);
        }}
        className={gold}
        data-testid="for-you-note-ok"
      >
        Got it
      </button>
    </div>
  );
}

function Poster({ src, type }: { src?: string; type: "movie" | "show" }) {
  const [broken, setBroken] = useState(false);
  const Icon = type === "show" ? Tv : Film;
  return src && !broken ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className="aspect-[2/3] w-16 shrink-0 rounded-md object-cover"
    />
  ) : (
    <span
      aria-hidden
      className="flex aspect-[2/3] w-16 shrink-0 items-center justify-center rounded-md bg-raised text-faint"
    >
      <Icon strokeWidth={1.4} className="h-6 w-6" />
    </span>
  );
}

function PickCard({
  p,
  busy,
  onHide,
  onLike,
  onSeen,
}: {
  p: Pick;
  busy: boolean;
  onHide: () => void;
  onLike: () => void;
  onSeen: (rating?: RecommendRating) => void;
}) {
  const [rating, setRating] = useState<RecommendRating>();
  const KindIcon = p.kind === "revisit" ? RotateCcw : p.kind === "fresh" ? Star : Sparkles;
  return (
    <li
      className="flex gap-3 rounded-xl border border-line bg-panel/95 p-3"
      data-testid="for-you-pick"
    >
      <Poster src={p.image} type={p.type} />
      <div className="min-w-0 flex-1 space-y-1">
        <p
          className="text-[0.72rem] font-semibold tracking-wide text-gold uppercase"
          data-testid="for-you-kind"
        >
          <KindIcon className="mr-1 inline h-3 w-3" aria-hidden />
          {KIND[p.kind]}
        </p>
        <p className="text-[0.92rem] font-semibold text-ink" data-testid="for-you-title">
          {p.title}
          {p.year ? <span className="font-normal text-muted"> ({p.year})</span> : null}
        </p>
        <p className="text-[0.8rem] text-muted" data-testid="for-you-why">
          {p.voice ?? p.why}
        </p>
        {rating ? (
          <RateIt word="Seen it" value={rating} onChange={setRating} onDone={(x) => onSeen(x)} />
        ) : (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {p.open && (
              <a
                href={p.open}
                target="_blank"
                rel="noopener noreferrer"
                className={gold}
                data-testid="for-you-open"
              >
                <Play className="h-3.5 w-3.5" aria-hidden /> Open in Plex
              </a>
            )}
            <button
              type="button"
              onClick={onLike}
              disabled={busy}
              className={ghost}
              data-testid="for-you-like"
            >
              <Wand2 className="h-3.5 w-3.5" aria-hidden /> More like this
            </button>
            <button
              type="button"
              onClick={() => setRating({})}
              title="Mark it watched, and say how it was if you like: it steers your next picks"
              className={ghost}
              data-testid="for-you-seen"
            >
              <Eye className="h-3.5 w-3.5" aria-hidden /> Seen it
            </button>
            <button
              type="button"
              onClick={onHide}
              title="Never suggest this again"
              className={ghost}
              data-testid="for-you-hide"
            >
              <EyeOff className="h-3.5 w-3.5" aria-hidden /> Not for me
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function MissingCard({
  m,
  seerr,
  requested,
  busy,
  onRequest,
  onLike,
  onHide,
}: {
  m: Missing;
  seerr?: string;
  requested: boolean;
  busy: boolean;
  onRequest: () => void;
  onLike: () => void;
  onHide: () => void;
}) {
  return (
    <li
      className="flex gap-3 rounded-xl border border-line bg-panel/95 p-3"
      data-testid="for-you-not-owned-item"
    >
      <Poster src={m.image} type={m.mediaType === "tv" ? "show" : "movie"} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[0.92rem] font-semibold text-ink" data-testid="for-you-not-owned-title">
          {m.title}
          {m.year ? <span className="font-normal text-muted"> ({m.year})</span> : null}
        </p>
        <p className="text-[0.8rem] text-muted">{m.why}</p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {requested ? (
            <span
              className="inline-flex items-center gap-1 text-[0.8rem] text-ok"
              data-testid="for-you-requested"
            >
              <Check strokeWidth={2} className="h-3.5 w-3.5" aria-hidden /> Requested
            </span>
          ) : (
            seerr && (
              <button
                type="button"
                disabled={busy}
                onClick={onRequest}
                className={gold}
                data-testid="for-you-request"
              >
                Request
              </button>
            )
          )}
          {seerr && (
            <TrailerLink serviceId={seerr} type={m.mediaType} tmdbId={m.tmdbId} title={m.title} />
          )}
          <button
            type="button"
            onClick={onLike}
            disabled={busy}
            className={ghost}
            data-testid="for-you-not-owned-like"
          >
            <Wand2 className="h-3.5 w-3.5" aria-hidden /> More like this
          </button>
          <button
            type="button"
            onClick={onHide}
            title="Never suggest this again"
            className={ghost}
            data-testid="for-you-not-owned-hide"
          >
            <EyeOff className="h-3.5 w-3.5" aria-hidden /> Not for me
          </button>
        </div>
      </div>
    </li>
  );
}
