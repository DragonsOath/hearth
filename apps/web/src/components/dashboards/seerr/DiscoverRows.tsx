import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, ChevronRight, ExternalLink, Film, Plus, Tv, X } from "lucide-react";
import type { ActionKind, StepParams } from "@dragon-control/core";
import type { useApproveHere } from "../../jobs/ApproveHere";
import { Button, Sheet, Skeleton, cx } from "../../ui";
import {
  HAVE,
  posterSrc,
  useSeerrView,
  type DiscoverRowView,
  type RatingsView,
  type SearchResult,
  type TitleView,
  type UpgradeInfo,
} from "./data";
import { REQUESTABLE, SaveTo, Seasons, TrailerLink, saveParams, type SaveChoice } from "./request";
import { Rail } from "./Rail";
import { WatchLinks } from "./WatchLinks";

/**
 * Discover (checklist 46.20; redesigned 11-19 after Ember's Tasterr panel, the owner: "no sliders
 * just arrows in the gaps of the rows ... the trailer plays in panel ... a hero row showing the
 * latest recent movies ... imdb and rotten tomatoes ratings ... the details panel is front and
 * center has cast and director and a more like this row"). A hero of recent movies, then Seerr's
 * own lists as rows that move with arrows. A tap opens the title front and center: its banner,
 * trailer, ratings, cast, director, More like this, and the request, a plan you approve.
 */

type Act = ReturnType<typeof useApproveHere>;

const HIDE_KEY = "hearth.seerr.hideAvailable";
const readHide = () => {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
};

/** Status in a word or two, colored the same way everywhere (green = you have it). */
function StatusTag({ status }: { status: string }) {
  const tone = HAVE.has(status)
    ? "border-live/40 text-live"
    : status === "requested" || status === "processing" || status === "partly available"
      ? "border-amber/40 text-amber"
      : "border-line text-faint";
  return (
    <span
      className={cx("fit-pill rounded-full border px-1.5 py-px text-[0.66rem] leading-tight", tone)}
      data-testid="discover-status"
    >
      {status === "not requested" ? "Not requested" : status[0]!.toUpperCase() + status.slice(1)}
    </span>
  );
}

function Poster({
  serviceId,
  r,
  className,
}: {
  serviceId: string;
  r: Pick<SearchResult, "poster" | "mediaType">;
  className: string;
}) {
  const [broken, setBroken] = useState(false);
  const src = broken ? undefined : posterSrc(serviceId, r.poster);
  return src ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className={cx("rounded-lg object-cover", className)}
    />
  ) : (
    <div
      className={cx("flex items-center justify-center rounded-lg bg-raised text-faint", className)}
    >
      {r.mediaType === "tv" ? <Tv className="h-6 w-6" /> : <Film className="h-6 w-6" />}
    </div>
  );
}

/** One poster in a row: a button that opens its details (never a request by itself). */
function Card({
  serviceId,
  r,
  onOpen,
}: {
  serviceId: string;
  r: SearchResult;
  onOpen: () => void;
}) {
  return (
    <li className="w-[7.5rem] shrink-0 snap-start" data-testid="discover-card">
      <button
        type="button"
        onClick={onOpen}
        className="group block w-full text-left"
        aria-label={`${r.title}${r.year ? ` (${r.year})` : ""}, ${r.status}. Details`}
        data-hearth-target={`discover-card:${r.tmdbId}`}
      >
        <span className="relative block">
          <Poster
            serviceId={serviceId}
            r={r}
            className="aspect-[2/3] w-full border border-line transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-gold/70 group-focus-visible:border-gold"
          />
          {r.mediaType === "tv" && (
            <span className="absolute top-1.5 left-1.5 rounded bg-black/70 px-1.5 text-[0.6rem] font-semibold tracking-wide text-white uppercase">
              Show
            </span>
          )}
        </span>
        <p className="mt-1.5 line-clamp-2 text-[0.78rem] leading-snug text-ink group-hover:text-gold">
          {r.title}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[0.7rem] text-faint">
          {r.year ?? ""}
          <StatusTag status={r.status} />
        </p>
      </button>
    </li>
  );
}

const longDate = (d?: string) =>
  d
    ? // A plain date or a full timestamp: only the day counts.
      new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString([], {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : undefined;

/** Year, age rating, length and genres, the way a poster's back says them. */
function Facts({ t, r }: { t?: TitleView; r: SearchResult }) {
  const year = t?.year ?? r.year;
  const parts = [
    t?.runtime
      ? `${Math.floor(t.runtime / 60) ? `${Math.floor(t.runtime / 60)}h ` : ""}${t.runtime % 60}m`
      : undefined,
    t?.genres?.length ? t.genres.join(", ") : undefined,
  ].filter(Boolean);
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.82rem] text-muted">
      {year && <span>{year}</span>}
      {t?.certification && (
        <span className="rounded border border-muted/70 px-1 text-[0.7rem] leading-tight">
          {t.certification}
        </span>
      )}
      {parts.map((p) => (
        <span key={p}>· {p}</span>
      ))}
    </p>
  );
}

/** TMDB's score, IMDb's and Rotten Tomatoes', each linking to its own page when Seerr has it. */
function Ratings({ serviceId, r, t }: { serviceId: string; r: SearchResult; t?: TitleView }) {
  const q = useSeerrView<RatingsView>(
    serviceId,
    "ratings",
    { type: r.mediaType, id: r.tmdbId },
    true,
    6 * 3600_000,
  );
  const imdbUrl =
    q.data?.imdb?.url ?? (t?.imdbId ? `https://www.imdb.com/title/${t.imdbId}` : undefined);
  const rt = q.data?.rottenTomatoes;
  const chip =
    "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line bg-raised px-3 text-[0.78rem] text-muted";
  const link = (href: string | undefined, body: ReactNode, testId: string) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cx(chip, "hover:border-gold hover:text-ink")}
        data-testid={testId}
      >
        {body}
        <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    ) : (
      <span className={chip} data-testid={testId}>
        {body}
      </span>
    );
  return (
    <div className="flex flex-wrap gap-2" data-testid="discover-ratings">
      {t?.rating ? (
        <span className={chip} data-testid="rating-tmdb">
          <b className="text-[0.95rem] text-gold">{t.rating}</b> TMDB
        </span>
      ) : null}
      {(q.data?.imdb || imdbUrl) &&
        link(
          imdbUrl,
          <>
            <b className="text-[0.95rem] text-[#f5c518]">IMDb</b>
            {q.data?.imdb ? <span className="text-ink">{q.data.imdb.score}</span> : "open"}
          </>,
          "rating-imdb",
        )}
      {rt &&
        link(
          rt.url,
          <>
            <span aria-hidden>🍅</span>
            {rt.critics !== undefined && (
              <span className="text-ink" title="Critics">
                {rt.critics}%
              </span>
            )}
            {rt.audience !== undefined && (
              <span title="Audience">
                <span aria-hidden>🍿</span> {rt.audience}%
              </span>
            )}
            <span>Rotten Tomatoes</span>
          </>,
          "rating-rt",
        )}
    </div>
  );
}

/**
 * A title front and center (a modal over the panel): its banner and poster, trailer and request
 * up top, ratings, the story, director and release, the cast, and More like this, whose titles
 * open here too. Requesting is the same plan you approve as before.
 */
/**
 * Upgrade quality: pick a quality profile and Radarr (or Sonarr) looks for a better copy. One plan
 * you approve, from Hearth's own steps: the profile (and monitoring, so it keeps upgrading) set on
 * the title, then a search. Nothing is deleted; the file is replaced only if a better one is found.
 */
function Upgrade({
  up,
  title,
  type,
  act,
  onCancel,
}: {
  up: UpgradeInfo;
  title: string;
  type: "movie" | "tv";
  act: Act;
  onCancel: () => void;
}) {
  const [pick, setPick] = useState<number>(up.profileId ?? up.profiles[0]?.id ?? 0);
  const app = up.app === "sonarr" ? "Sonarr" : "Radarr";
  const changes: Record<string, unknown> = {
    ...(pick && pick !== up.profileId ? { qualityProfileId: pick } : {}),
    ...(up.monitored ? {} : { monitored: true }),
  };
  const send = () => {
    const steps: { kind: ActionKind; serviceId: string; params: StepParams }[] = [
      ...(Object.keys(changes).length
        ? [
            {
              kind: "app-arr-edit" as const,
              serviceId: up.serviceId,
              params: {
                resource: type === "tv" ? "series" : "movie",
                id: up.arrId,
                changes: JSON.stringify(changes),
              },
            },
          ]
        : []),
      type === "tv"
        ? {
            kind: "app-arr-command" as const,
            serviceId: up.serviceId,
            params: { command: "SeriesSearch", seriesId: up.arrId },
          }
        : {
            kind: "app-arr-search" as const,
            serviceId: up.serviceId,
            params: { movieId: up.arrId },
          },
    ];
    void act.proposeMany(steps, `Upgrade ${title} in ${up.service}`);
  };
  return (
    <div
      className="space-y-3 rounded-xl border border-gold/60 bg-raised/60 p-4"
      data-testid="discover-upgrade"
    >
      <h3 className="eyebrow">Upgrade quality</h3>
      <p className="text-[0.86rem] text-ink">
        In {up.service}
        {up.quality ? (
          <>
            {" "}
            as <strong>{up.quality}</strong>
          </>
        ) : null}
        . Pick a quality profile and {app} looks for a better copy. Nothing is deleted: the file is
        only replaced if a better release is found.
      </p>
      {up.profiles.length ? (
        <label className="block text-[0.8rem] text-muted">
          Quality profile
          <select
            value={pick}
            onChange={(e) => setPick(Number(e.target.value))}
            className="mt-1 block w-full rounded-lg border border-line bg-panel px-3 py-2 text-[0.9rem] text-ink"
            data-testid="discover-upgrade-profile"
          >
            {up.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === up.profileId ? " (now)" : ""}
                {p.cutoff ? ` · up to ${p.cutoff}` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {!up.monitored && (
        <p className="text-[0.8rem] text-amber">
          {app} isn&apos;t monitoring {title}, so this turns monitoring on too, or {app} would never
          grab the better copy.
        </p>
      )}
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          tone="primary"
          disabled={act.busy}
          onClick={send}
          data-testid="discover-upgrade-go"
          data-hearth-target="discover-upgrade-go"
        >
          {pick !== up.profileId ? "Upgrade" : "Search for a better copy"}
        </Button>
        <Button tone="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="text-[0.74rem] text-faint">
        A plan you approve: {pick !== up.profileId ? `the new profile in ${app}, then ` : ""}a
        search now.
      </p>
    </div>
  );
}

export function TitleSheet({
  serviceId,
  r: first,
  act,
  onClose,
  have,
  extra,
}: {
  serviceId: string;
  r: SearchResult;
  act: Act;
  onClose: () => void;
  /** Known to be in your library (Curator's In your library row): Watch, not Request. */
  have?: boolean;
  /** More for this title, beside Request or Watch (Curator's Seen it, 11-24). */
  extra?: ReactNode;
}) {
  const [r, setR] = useState(first);
  const q = useSeerrView<TitleView>(serviceId, "title", { type: r.mediaType, id: r.tmdbId });
  const like = useSeerrView<{ results: SearchResult[] }>(
    serviceId,
    "similar",
    { type: r.mediaType, id: r.tmdbId },
    true,
    30 * 60_000,
  );
  const t = q.data;
  const [save, setSave] = useState<SaveChoice>({});
  // The request's choices open under Request (like Ember's Tasterr panel), not before it's asked.
  const [asking, setAsking] = useState(false);
  // In your library (Radarr has it, Seerr forgot): Request only after "Request anyway" (11-19).
  const [anyway, setAnyway] = useState(false);
  // Upgrade quality (11-19, from Ember's Tasterr panel): opens its own box under the buttons.
  const [upgrading, setUpgrading] = useState(false);
  const upgradeBox = useRef<HTMLDivElement>(null);
  const status = t?.status ?? r.status;
  const inLibrary = status === "in your library";
  const library = t?.library ?? r.library;
  // Yours to watch: Curator says so, or Seerr and the library do (11-24).
  const owned = (have && r.tmdbId === first.tmdbId) || inLibrary || status === "available";
  const can = (REQUESTABLE.has(status) && !owned) || (owned && anyway);
  const ref = useRef<HTMLDialogElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const requestBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  // Another title from More like this: back to the top, with its own request choices.
  useEffect(() => {
    top.current?.scrollIntoView({ block: "start" });
  }, [r.tmdbId, r.mediaType]);
  const backdrop = posterSrc(serviceId, t?.backdrop ?? r.backdrop, "backdrop");
  const made = t?.director ?? t?.createdBy;
  return (
    <dialog
      ref={ref}
      aria-label={r.title}
      onClose={onClose}
      onCancel={(e) => {
        // Escape over a playing trailer closes the trailer, not the title.
        if (ref.current?.querySelector('[data-testid="trailer-player"]')) e.preventDefault();
      }}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
      className="m-auto max-h-[92vh] w-[min(56rem,calc(100vw-1.5rem))] max-w-none overflow-clip rounded-2xl border border-line-strong bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/75 backdrop:backdrop-blur-sm"
      data-testid="discover-title"
    >
      {/* The X stays in the corner however far the window scrolls (the owner, 11-24): the
          window itself never moves, only what's inside it. */}
      <button
        type="button"
        aria-label="Close"
        onClick={() => ref.current?.close()}
        className="absolute top-3 right-3 z-30 grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white shadow-lg hover:bg-gold hover:text-bg"
        data-testid="close-pinned"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="max-h-[92vh] overflow-y-auto" data-testid="window-scroll">
        <div ref={top} className="relative">
          {backdrop && (
            <img
              src={backdrop}
              alt=""
              className="absolute inset-0 h-full max-h-80 w-full object-cover opacity-45"
            />
          )}
          <div className="absolute inset-0 max-h-80 bg-gradient-to-t from-panel via-panel/70 to-transparent" />
          <div className="relative flex flex-wrap items-end gap-5 px-6 pt-16 pb-4 sm:flex-nowrap">
            <Poster
              serviceId={serviceId}
              r={t ?? r}
              className="h-52 w-36 shrink-0 border border-line shadow-xl"
            />
            <div className="min-w-0 space-y-1.5">
              <p className="eyebrow">{r.mediaType === "tv" ? "Show" : "Movie"}</p>
              <h2 className="font-display text-[1.9rem] leading-tight">{t?.title ?? r.title}</h2>
              {t?.tagline && <p className="text-[0.9rem] text-muted italic">{t.tagline}</p>}
              <Facts t={t} r={r} />
              <StatusTag status={owned && !HAVE.has(status) ? "in your library" : status} />
            </div>
          </div>
        </div>
        <div className="space-y-5 px-6 pb-6">
          <div className="flex flex-wrap gap-2">
            <TrailerLink
              serviceId={serviceId}
              type={r.mediaType}
              tmdbId={r.tmdbId}
              title={r.title}
              primary
            />
            {can && (
              <Button
                tone={asking ? "primary" : "outline"}
                onClick={() => {
                  setAsking(true);
                  window.setTimeout(
                    () =>
                      requestBox.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
                    50,
                  );
                }}
                data-testid="discover-request-open"
                data-hearth-target={`discover:${r.tmdbId}:ask`}
              >
                <Plus className="h-4 w-4" aria-hidden /> Request
              </Button>
            )}
            {/* Requested already (the Overview opens its requests here too, 11-24): said where
              Request would be. */}
            {owned && !can && (
              <WatchLinks
                type={r.mediaType}
                title={t?.title ?? r.title}
                {...((r.year ?? Number(t?.released?.slice(0, 4)))
                  ? { year: r.year ?? Number(t!.released!.slice(0, 4)) }
                  : {})}
              />
            )}
            {!can && !owned && ["requested", "processing"].includes(status) && (
              <Button tone="outline" disabled data-testid="discover-requested">
                <Check className="h-4 w-4" aria-hidden /> Requested
              </Button>
            )}
            {extra}
            {t?.upgrade && (
              <Button
                tone={upgrading ? "primary" : "outline"}
                onClick={() => {
                  setUpgrading(true);
                  window.setTimeout(
                    () =>
                      upgradeBox.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
                    50,
                  );
                }}
                data-testid="discover-upgrade-open"
                data-hearth-target={`discover:${r.tmdbId}:upgrade`}
              >
                <ArrowUp className="h-4 w-4" aria-hidden /> Upgrade quality
              </Button>
            )}
          </div>
          {upgrading && t?.upgrade && (
            <div ref={upgradeBox}>
              <Upgrade
                key={`${r.mediaType}:${r.tmdbId}`}
                up={t.upgrade}
                title={t.title ?? r.title}
                type={r.mediaType}
                act={act}
                onCancel={() => setUpgrading(false)}
              />
            </div>
          )}
          <Ratings serviceId={serviceId} r={r} t={t} />
          {q.isLoading ? (
            <Skeleton className="h-16" />
          ) : (
            <p className="text-[0.9rem] leading-relaxed text-ink/90">
              {t?.overview || r.overview || "Seerr has no description for this one."}
            </p>
          )}
          {(made || t?.released) && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1 text-[0.84rem]">
              {made && (
                <>
                  <dt className="text-muted">{t?.director ? "Director" : "Created by"}</dt>
                  <dd data-testid="discover-director">{made}</dd>
                </>
              )}
              {t?.released && (
                <>
                  <dt className="text-muted">
                    {r.mediaType === "tv" ? "First aired" : "Released"}
                  </dt>
                  <dd>{longDate(t.released)}</dd>
                </>
              )}
            </dl>
          )}
          {!!t?.cast?.length && (
            <section aria-label="Cast">
              <h3 className="eyebrow mb-2">Cast</h3>
              <Rail label="Cast" testId="discover-cast">
                {t.cast.map((c) => (
                  <li key={c.name} className="w-[5.5rem] shrink-0 snap-start text-center">
                    <Face serviceId={serviceId} photo={c.photo} name={c.name} />
                    <p className="mt-1 line-clamp-2 text-[0.72rem] leading-tight text-ink">
                      {c.name}
                    </p>
                    {c.character && (
                      <p className="line-clamp-1 text-[0.68rem] text-faint">{c.character}</p>
                    )}
                  </li>
                ))}
              </Rail>
            </section>
          )}
          {(asking || !can) && (
            <div
              ref={requestBox}
              className={cx(
                "space-y-3 rounded-xl border p-4",
                can ? "border-gold/60 bg-raised/60" : "border-line bg-raised/40",
              )}
              data-testid="discover-request"
            >
              {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
              {!can && inLibrary ? (
                <div className="space-y-3" data-testid="discover-in-library">
                  <p className="text-[0.86rem] text-ink">
                    <strong className="text-live">Already in your library.</strong>{" "}
                    {library?.service ?? "Radarr"} has {r.title} downloaded, but Seerr shows it as
                    not requested (its record was reset), so it could be requested and downloaded
                    again.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {t?.mediaId ? (
                      <Button
                        tone="primary"
                        disabled={act.busy}
                        data-testid="discover-mark-available"
                        data-hearth-target="discover-mark-available"
                        onClick={() =>
                          void act.propose(
                            "app-seerr-mark-available",
                            { mediaType: r.mediaType, tmdbId: r.tmdbId },
                            `Tell Seerr ${r.title} is in your library`,
                          )
                        }
                      >
                        Tell Seerr you have it
                      </Button>
                    ) : null}
                    <Button
                      tone="outline"
                      onClick={() => setAnyway(true)}
                      data-testid="discover-request-anyway"
                    >
                      Request anyway
                    </Button>
                  </div>
                </div>
              ) : !can ? (
                <p className="text-[0.84rem] text-muted">
                  {owned
                    ? "Already in your library."
                    : status === "blocklisted"
                      ? "Blocked in Seerr, so it can't be requested."
                      : "Already requested."}
                </p>
              ) : r.mediaType === "movie" ? (
                <>
                  <h3 className="eyebrow">{inLibrary ? "Request it again" : "Request it"}</h3>
                  <SaveTo serviceId={serviceId} type="movie" value={save} onChange={setSave} />
                  <Button
                    tone="primary"
                    disabled={act.busy}
                    data-hearth-target={`discover:${r.tmdbId}:request`}
                    onClick={() =>
                      void act.propose(
                        "app-seerr-request",
                        { mediaType: "movie", tmdbId: r.tmdbId, ...saveParams(save) },
                        `Request ${r.title}`,
                      )
                    }
                  >
                    Request
                  </Button>
                </>
              ) : (
                <>
                  <h3 className="eyebrow">Request it</h3>
                  {library && (
                    <p className="text-[0.8rem] text-amber" data-testid="discover-library-note">
                      {library.service} already has {library.files} episode
                      {library.files === 1 ? "" : "s"} of {r.title} downloaded. Ask only for what's
                      missing.
                    </p>
                  )}
                  <SaveTo serviceId={serviceId} type="tv" value={save} onChange={setSave} />
                  <Seasons serviceId={serviceId} r={r} act={act} save={save} />
                </>
              )}
              {can && (
                <p className="text-[0.74rem] text-faint">
                  A request is a plan you approve; Seerr then sends it to Radarr or Sonarr.
                </p>
              )}
            </div>
          )}
          {!!like.data?.results.length && (
            <section aria-label="More like this">
              <h3 className="eyebrow mb-2">More like this</h3>
              <Rail label="More like this" testId="discover-more-like">
                {like.data.results.slice(0, 20).map((x) => (
                  <Card
                    key={`${x.mediaType}-${x.tmdbId}`}
                    serviceId={serviceId}
                    r={x}
                    onOpen={() => {
                      setR(x);
                      setSave({});
                      setAsking(false);
                      setAnyway(false);
                      setUpgrading(false);
                    }}
                  />
                ))}
              </Rail>
            </section>
          )}
        </div>
      </div>
    </dialog>
  );
}

function Face({ serviceId, photo, name }: { serviceId: string; photo?: string; name: string }) {
  const [broken, setBroken] = useState(false);
  const src = broken ? undefined : posterSrc(serviceId, photo, "face");
  return src ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className="mx-auto h-[5.5rem] w-[5.5rem] rounded-full border border-line object-cover"
    />
  ) : (
    <div
      className="mx-auto grid h-[5.5rem] w-[5.5rem] place-items-center rounded-full border border-line bg-raised text-[1.2rem] text-faint"
      aria-hidden
    >
      {name[0]}
    </div>
  );
}

/**
 * The hero (11-19): the latest movies, one at a time over its own banner, with Watch trailer and
 * Details & request. Turns on its own every few seconds unless a pointer rests on it.
 */
function Hero({
  serviceId,
  items,
  onOpen,
}: {
  serviceId: string;
  items: SearchResult[];
  onOpen: (r: SearchResult) => void;
}) {
  const [i, setI] = useState(0);
  const [held, setHeld] = useState(false);
  const r = items[i % items.length]!;
  const q = useSeerrView<TitleView>(serviceId, "title", { type: r.mediaType, id: r.tmdbId });
  useEffect(() => {
    if (held || items.length < 2) return;
    const t = window.setTimeout(() => setI((n) => (n + 1) % items.length), 9_000);
    return () => window.clearTimeout(t);
  }, [i, held, items.length]);
  const bg = posterSrc(serviceId, r.backdrop, "backdrop");
  return (
    <section
      className="relative min-h-[15rem] overflow-hidden rounded-2xl border border-line bg-raised"
      aria-label="Latest movies"
      aria-roledescription="carousel"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      data-testid="discover-hero"
    >
      {bg && (
        <img
          key={bg}
          src={bg}
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-60"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/75 to-transparent" />
      <div className="relative max-w-[36rem] space-y-2 p-6">
        <h2
          className="font-display text-[1.75rem] leading-tight text-ink"
          data-testid="discover-hero-title"
        >
          {r.title}
        </h2>
        <Facts t={q.data} r={r} />
        <p className="line-clamp-3 text-[0.86rem] text-ink/85">{q.data?.overview || r.overview}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <TrailerLink
            serviceId={serviceId}
            type={r.mediaType}
            tmdbId={r.tmdbId}
            title={r.title}
            primary
          />
          <Button
            tone="outline"
            onClick={() => onOpen(r)}
            data-testid="discover-hero-details"
            className="bg-panel/70"
          >
            Details &amp; request
          </Button>
        </div>
      </div>
      {items.length > 1 && (
        <div
          className="absolute right-4 bottom-3 flex gap-1.5"
          role="tablist"
          aria-label="Latest movies"
        >
          {items.map((x, n) => (
            <button
              key={`${x.mediaType}-${x.tmdbId}`}
              type="button"
              role="tab"
              aria-selected={n === i % items.length}
              aria-label={x.title}
              onClick={() => setI(n)}
              className={cx(
                "h-2 rounded-full transition-all",
                n === i % items.length ? "w-5 bg-gold" : "w-2 bg-faint hover:bg-muted",
              )}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Every page of one row, in a grid, a page at a time. */
function SeeAll({
  serviceId,
  row,
  hide,
  onOpen,
  onClose,
}: {
  serviceId: string;
  row: DiscoverRowView;
  hide: boolean;
  onOpen: (r: SearchResult) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const q = useSeerrView<DiscoverRowView>(serviceId, "discover", { row: row.id, page });
  const shown = (q.data?.results ?? []).filter((r) => !(hide && HAVE.has(r.status)));
  return (
    <Sheet label={row.title} eyebrow="Discover" title={row.title} onClose={onClose} wide>
      <div data-testid="discover-see-all">
        {q.isLoading ? (
          <Skeleton className="h-64" />
        ) : q.error ? (
          <p className="text-[0.84rem] text-amber">Could not read it: {q.error.message}</p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-3">
            {shown.map((r) => (
              <Card
                key={`${r.mediaType}-${r.tmdbId}`}
                serviceId={serviceId}
                r={r}
                onOpen={() => onOpen(r)}
              />
            ))}
          </ul>
        )}
        <div className="mt-4 flex items-center gap-3 text-[0.8rem] text-muted">
          <Button tone="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span>
            Page {page}
            {q.data?.pages ? ` of ${q.data.pages}` : ""}
          </span>
          <Button
            tone="outline"
            disabled={!q.data || page >= q.data.pages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

export function DiscoverRows({
  serviceId,
  name,
  act,
}: {
  serviceId: string;
  name: string;
  act: Act;
}) {
  // Trending lists change slowly: read once, kept for 15 minutes.
  const q = useSeerrView<{ rows: DiscoverRowView[] }>(serviceId, "discover", {}, true, 15 * 60_000);
  const [hide, setHide] = useState(readHide);
  const [open, setOpen] = useState<SearchResult>();
  const [all, setAll] = useState<DiscoverRowView>();
  const toggle = (on: boolean) => {
    setHide(on);
    try {
      localStorage.setItem(HIDE_KEY, on ? "1" : "0");
    } catch {
      // Remembering is a convenience; the switch still works for now.
    }
  };
  // The hero: the latest movies with a banner (recently released, else trending).
  const rows = q.data?.rows ?? [];
  const pick = (id: DiscoverRowView["id"]) =>
    rows.find((x) => x.id === id)?.results.filter((r) => r.backdrop) ?? [];
  const hero = (
    pick("recent-movies").length ? pick("recent-movies") : pick("trending-movies")
  ).slice(0, 6);
  return (
    <div className="space-y-5" data-testid="discover-rows">
      {q.isLoading ? (
        [0, 1, 2].map((i) => <Skeleton key={i} className="h-56" />)
      ) : q.error ? (
        <p className="text-[0.84rem] text-amber">
          Could not read {name}&apos;s Discover lists: {q.error.message}. Search still works.
        </p>
      ) : (
        <>
          {hero.length > 0 && <Hero serviceId={serviceId} items={hero} onOpen={setOpen} />}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="inline-flex min-h-9 items-center gap-2 text-[0.8rem] text-ink">
              <input
                type="checkbox"
                checked={hide}
                onChange={(e) => toggle(e.target.checked)}
                data-testid="discover-hide-available"
              />
              Hide what I have
            </label>
          </div>
          {rows.map((row) => {
            const shown = row.results.filter((r) => !(hide && HAVE.has(r.status)));
            return (
              <section key={row.id} aria-label={row.title} data-testid={`discover-row-${row.id}`}>
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <h3 className="text-[0.95rem] font-semibold text-ink">{row.title}</h3>
                  {row.pages > 0 && !row.error && (
                    <button
                      type="button"
                      onClick={() => setAll(row)}
                      className="inline-flex min-h-9 items-center gap-0.5 text-[0.78rem] text-gold hover:underline"
                      data-testid="discover-see-all-button"
                    >
                      See all <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                </div>
                {row.error ? (
                  <p className="text-[0.8rem] text-amber">Could not read this list: {row.error}</p>
                ) : !shown.length ? (
                  <p className="text-[0.8rem] text-muted">
                    {hide && row.results.length
                      ? "You have everything here."
                      : "Nothing here right now."}
                  </p>
                ) : (
                  <Rail label={row.title}>
                    {shown.map((r) => (
                      <Card
                        key={`${r.mediaType}-${r.tmdbId}`}
                        serviceId={serviceId}
                        r={r}
                        onOpen={() => setOpen(r)}
                      />
                    ))}
                  </Rail>
                )}
              </section>
            );
          })}
        </>
      )}
      {all && (
        <SeeAll
          serviceId={serviceId}
          row={all}
          hide={hide}
          onOpen={(r) => setOpen(r)}
          onClose={() => setAll(undefined)}
        />
      )}
      {open && (
        <TitleSheet serviceId={serviceId} r={open} act={act} onClose={() => setOpen(undefined)} />
      )}
    </div>
  );
}
